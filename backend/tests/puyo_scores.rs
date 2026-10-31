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

/// 13 列 × 6 欄的盤面，從最下面一列開始放 `filled` 顆；兩種顏色交錯，不會有相連的同色
fn board(filled: usize) -> String {
    let mut cells = vec![b'0'; 78];
    for i in 0..filled {
        let (x, y) = (i % 6, 12 - i / 6);
        cells[y * 6 + x] = if (x + y) % 2 == 0 { b'1' } else { b'2' };
    }
    String::from_utf8(cells).unwrap()
}

/// 一個中間態；盤面顆數照「組數 × 2 − 消掉的」自動算
fn state(score: i64, pieces: i64, popped: i64, duration_ms: i64) -> Value {
    let filled = (pieces * 2 - popped) as usize;
    json!({
        "score": score, "level": 1, "pieces": pieces, "popped": popped, "lost": 0,
        "max_chain": popped / 4, "duration_ms": duration_ms, "board": board(filled),
    })
}

async fn start(app: &TestApp, cookie: &str) -> String {
    let reply = app.call("POST", "/api/games/puyo/runs", Some(cookie), None).await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
    reply.body["id"].as_str().unwrap().to_string()
}

async fn checkpoint(app: &TestApp, cookie: &str, id: &str, body: Value) -> Reply {
    app.call("POST", &format!("/api/games/puyo/runs/{id}/checkpoints"), Some(cookie), Some(body)).await
}

async fn finish(app: &TestApp, cookie: &str, id: &str, body: Value) -> Reply {
    app.call("POST", &format!("/api/games/puyo/runs/{id}/finish"), Some(cookie), Some(body)).await
}

/// 開一局、回報一次、結束，回傳結束時的排行榜
async fn play(app: &TestApp, cookie: &str, score: i64) -> Value {
    let id = start(app, cookie).await;
    assert_eq!(checkpoint(app, cookie, &id, state(score / 2, 4, 4, 1000)).await.status, StatusCode::NO_CONTENT);
    let reply = finish(app, cookie, &id, state(score, 8, 8, 2000)).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    reply.body
}

#[tokio::test]
async fn anyone_can_read_but_playing_needs_login() {
    let app = app().await;
    let board = app.get("/api/games/puyo/scores", None).await;
    assert_eq!(board.status, StatusCode::OK);
    assert_eq!(board.body, json!({ "top": [], "me": null }));
    assert_eq!(app.call("POST", "/api/games/puyo/runs", None, None).await.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn keeps_each_players_best_and_ranks_them() {
    let app = app().await;
    let alice = login(&app, "alice").await;
    let bob = login(&app, "bob").await;

    let first = play(&app, &alice, 500).await;
    assert_eq!(first["best"], true);
    assert_eq!(first["me"]["rank"], 1);
    assert_eq!(first["me"]["max_chain"], 2);
    // 比較低的分數不會蓋掉紀錄
    let lower = play(&app, &alice, 300).await;
    assert_eq!(lower["best"], false);
    assert_eq!(lower["me"]["score"], 500);

    let bob_board = play(&app, &bob, 800).await;
    assert_eq!(bob_board["me"]["rank"], 1);
    let names: Vec<_> = bob_board["top"].as_array().unwrap().iter().map(|e| e["username"].clone()).collect();
    assert_eq!(names, [json!("bob"), json!("alice")]);

    // 和俄羅斯方塊的排行榜分開
    assert_eq!(app.get("/api/games/tetris/scores", None).await.body["top"], json!([]));

    // 停用的帳號不列入
    sqlx::query("UPDATE users SET disabled = 1 WHERE username = 'bob'").execute(&app.state.pool).await.unwrap();
    let after = app.get("/api/games/puyo/scores", Some(&alice)).await.body;
    assert_eq!(after["top"].as_array().unwrap().len(), 1);
    assert_eq!(after["me"]["rank"], 1);
}

#[tokio::test]
async fn rejects_impossible_progress_and_voids_the_run() {
    let app = app().await;
    let alice = login(&app, "alice").await;
    let mut bad_count = state(100, 3, 0, 1000);
    // 3 組應該是 6 顆，少一顆
    bad_count["board"] = json!(board(5));
    let mut floating = state(100, 3, 0, 1000);
    // 6 顆剛好，但第 1 欄最下面是空的
    floating["board"] = json!(format!("{}{}{}", "0".repeat(66), "100000", "021212"));
    let mut unpopped = state(100, 2, 0, 1000);
    // 4 顆同色排成一列卻沒消掉
    unpopped["board"] = json!(format!("{}{}", "0".repeat(72), "111100"));
    let mut too_high_level = state(100, 3, 0, 1000);
    too_high_level["level"] = json!(3);
    let mut too_long_chain = state(100, 4, 8, 1000);
    // 消掉 8 顆最多 2 連鎖
    too_long_chain["max_chain"] = json!(5);
    for body in [
        // 遊戲時間比真的經過的時間長很多
        state(100, 3, 0, 60_000),
        // 1 秒放 30 組
        state(100, 30, 60, 1000),
        // 沒消掉任何氣泡卻拿了 10 萬分
        state(100_000, 3, 0, 1000),
        bad_count,
        floating,
        unpopped,
        too_high_level,
        too_long_chain,
    ] {
        let id = start(&app, &alice).await;
        let reply = checkpoint(&app, &alice, &id, body.clone()).await;
        assert!(reply.status.is_client_error(), "{body}");
        // 作廢之後這局就不能再上傳
        assert_eq!(finish(&app, &alice, &id, state(100, 3, 0, 2000)).await.status, StatusCode::CONFLICT);
    }

    // 欄位不齊的請求直接擋掉
    let id = start(&app, &alice).await;
    assert!(checkpoint(&app, &alice, &id, json!({ "score": 0 })).await.status.is_client_error());

    // 數字變少
    let id = start(&app, &alice).await;
    assert_eq!(checkpoint(&app, &alice, &id, state(200, 4, 4, 1000)).await.status, StatusCode::NO_CONTENT);
    assert_eq!(checkpoint(&app, &alice, &id, state(100, 4, 4, 1500)).await.status, StatusCode::BAD_REQUEST);

    assert_eq!(app.get("/api/games/puyo/scores", None).await.body["top"], json!([]));
}

#[tokio::test]
async fn a_new_run_replaces_the_old_one() {
    let app = app().await;
    let alice = login(&app, "alice").await;
    let old = start(&app, &alice).await;
    let new = start(&app, &alice).await;
    assert_eq!(checkpoint(&app, &alice, &old, state(10, 1, 0, 500)).await.status, StatusCode::CONFLICT);
    assert_eq!(finish(&app, &alice, &new, state(10, 1, 0, 500)).await.status, StatusCode::OK);
    // 結束過就不能再交一次
    assert_eq!(finish(&app, &alice, &new, state(20, 2, 0, 600)).await.status, StatusCode::CONFLICT);
}
