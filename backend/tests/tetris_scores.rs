mod common;

use axum::http::StatusCode;
use backend::auth::upsert_admin;
use common::{Reply, TestApp, app};
use serde_json::{Value, json};

async fn login(app: &TestApp, name: &str) -> String {
    upsert_admin(&app.state.pool, name, "password123".into()).await.unwrap();
    let reply =
        app.call("POST", "/api/auth/login", None, Some(json!({ "username": name, "password": "password123" }))).await;
    reply.cookie.unwrap()
}

/// 24 列 × 10 格的盤面，最下面放 `filled` 格（不會湊滿一行）
fn board(filled: usize) -> String {
    let mut cells = vec![b'0'; 240];
    for i in 0..filled {
        let row = 23 - i / 9;
        cells[row * 10 + i % 9] = b'1';
    }
    String::from_utf8(cells).unwrap()
}

/// 一個中間態；盤面格數照「方塊 × 4 − 行 × 10」自動算
fn state(score: i64, lines: i64, pieces: i64, duration_ms: i64) -> Value {
    let filled = (pieces * 4 - lines * 10) as usize;
    json!({ "score": score, "lines": lines, "level": 1, "pieces": pieces, "duration_ms": duration_ms, "board": board(filled) })
}

async fn start(app: &TestApp, cookie: &str) -> String {
    let reply = app.call("POST", "/api/games/tetris/runs", Some(cookie), None).await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
    reply.body["id"].as_str().unwrap().to_string()
}

async fn checkpoint(app: &TestApp, cookie: &str, id: &str, body: Value) -> Reply {
    app.call("POST", &format!("/api/games/tetris/runs/{id}/checkpoints"), Some(cookie), Some(body)).await
}

async fn finish(app: &TestApp, cookie: &str, id: &str, body: Value) -> Reply {
    app.call("POST", &format!("/api/games/tetris/runs/{id}/finish"), Some(cookie), Some(body)).await
}

/// 開一局、回報一次、結束，回傳結束時的排行榜
async fn play(app: &TestApp, cookie: &str, score: i64) -> Value {
    let id = start(app, cookie).await;
    assert_eq!(checkpoint(app, cookie, &id, state(score / 2, 0, 5, 1000)).await.status, StatusCode::NO_CONTENT);
    let reply = finish(app, cookie, &id, state(score, 2, 10, 2000)).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    reply.body
}

#[tokio::test]
async fn anyone_can_read_but_playing_needs_login() {
    let app = app().await;
    let board = app.get("/api/games/tetris/scores", None).await;
    assert_eq!(board.status, StatusCode::OK);
    assert_eq!(board.body, json!({ "top": [], "me": null }));
    assert_eq!(app.call("POST", "/api/games/tetris/runs", None, None).await.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn keeps_each_players_best_and_ranks_them() {
    let app = app().await;
    let alice = login(&app, "alice").await;
    let bob = login(&app, "bob").await;

    let first = play(&app, &alice, 500).await;
    assert_eq!(first["best"], true);
    assert_eq!(first["me"]["rank"], 1);
    assert_eq!(first["me"]["lines"], 2);
    // 比較低的分數不會蓋掉紀錄
    let lower = play(&app, &alice, 300).await;
    assert_eq!(lower["best"], false);
    assert_eq!(lower["me"]["score"], 500);

    let bob_board = play(&app, &bob, 800).await;
    assert_eq!(bob_board["me"]["rank"], 1);
    let names: Vec<_> = bob_board["top"].as_array().unwrap().iter().map(|e| e["username"].clone()).collect();
    assert_eq!(names, [json!("bob"), json!("alice")]);

    // 沒登入看得到排行榜，但沒有自己的名次
    let public = app.get("/api/games/tetris/scores", None).await.body;
    assert_eq!(public["top"].as_array().unwrap().len(), 2);
    assert_eq!(public["me"], Value::Null);
    assert!(public.get("best").is_none());

    // 停用的帳號不列入
    sqlx::query("UPDATE users SET disabled = 1 WHERE username = 'bob'").execute(&app.state.pool).await.unwrap();
    let after = app.get("/api/games/tetris/scores", Some(&alice)).await.body;
    assert_eq!(after["top"].as_array().unwrap().len(), 1);
    assert_eq!(after["me"]["rank"], 1);
}

#[tokio::test]
async fn rejects_impossible_progress_and_voids_the_run() {
    let app = app().await;
    let alice = login(&app, "alice").await;
    let mut bad_board = state(100, 0, 3, 1000);
    // 3 塊應該是 12 格，少一格
    bad_board["board"] = json!(board(11));
    let mut full_row = state(100, 0, 5, 1000);
    // 20 格剛好，但最下面一整行是滿的
    full_row["board"] = json!(format!("{}{}", "0".repeat(220), "1".repeat(10) + &"1".repeat(10)));
    let mut too_high_level = state(100, 0, 3, 1000);
    too_high_level["level"] = json!(3);
    for body in [
        // 遊戲時間比真的經過的時間長很多
        state(100, 0, 3, 60_000),
        // 1 秒放 50 塊
        state(100, 10, 50, 1000),
        // 3 塊拿 100 萬分
        state(1_000_000, 0, 3, 1000),
        bad_board,
        full_row,
        too_high_level,
    ] {
        let id = start(&app, &alice).await;
        let reply = checkpoint(&app, &alice, &id, body.clone()).await;
        assert!(reply.status.is_client_error(), "{body}");
        // 作廢之後這局就不能再上傳
        assert_eq!(finish(&app, &alice, &id, state(100, 0, 3, 2000)).await.status, StatusCode::CONFLICT);
    }

    // 欄位不齊的請求直接擋掉
    let id = start(&app, &alice).await;
    assert!(checkpoint(&app, &alice, &id, json!({ "score": 0 })).await.status.is_client_error());

    // 數字變少
    let id = start(&app, &alice).await;
    assert_eq!(checkpoint(&app, &alice, &id, state(200, 0, 4, 1000)).await.status, StatusCode::NO_CONTENT);
    assert_eq!(checkpoint(&app, &alice, &id, state(100, 0, 4, 1500)).await.status, StatusCode::BAD_REQUEST);

    assert_eq!(app.get("/api/games/tetris/scores", None).await.body["top"], json!([]));
}

#[tokio::test]
async fn a_new_run_replaces_the_old_one() {
    let app = app().await;
    let alice = login(&app, "alice").await;
    let old = start(&app, &alice).await;
    let new = start(&app, &alice).await;
    assert_eq!(checkpoint(&app, &alice, &old, state(10, 0, 1, 500)).await.status, StatusCode::CONFLICT);
    assert_eq!(finish(&app, &alice, &new, state(10, 0, 1, 500)).await.status, StatusCode::OK);
    // 結束過就不能再交一次
    assert_eq!(finish(&app, &alice, &new, state(20, 0, 2, 600)).await.status, StatusCode::CONFLICT);
}
