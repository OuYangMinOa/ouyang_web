mod common;

use axum::http::StatusCode;
use backend::auth::upsert_admin;
use common::{TestApp, app};
use serde_json::{Value, json};

async fn login(app: &TestApp, name: &str) -> String {
    upsert_admin(&app.state.pool, name, "password123".into()).await.unwrap();
    let reply =
        app.call("POST", "/api/auth/login", None, Some(json!({ "username": name, "password": "password123" }))).await;
    reply.cookie.unwrap()
}

fn run(score: i64, lines: i64, level: i64) -> Value {
    json!({ "score": score, "lines": lines, "level": level, "duration_ms": 600_000 })
}

async fn submit(app: &TestApp, cookie: &str, body: Value) -> Value {
    let reply = app.call("POST", "/api/games/tetris/scores", Some(cookie), Some(body)).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    reply.body
}

#[tokio::test]
async fn anyone_can_read_but_submitting_needs_login() {
    let app = app().await;
    let board = app.get("/api/games/tetris/scores", None).await;
    assert_eq!(board.status, StatusCode::OK);
    assert_eq!(board.body, json!({ "top": [], "me": null }));
    let reply = app.call("POST", "/api/games/tetris/scores", None, Some(run(1000, 10, 2))).await;
    assert_eq!(reply.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn keeps_each_players_best_and_ranks_them() {
    let app = app().await;
    let alice = login(&app, "alice").await;
    let bob = login(&app, "bob").await;

    let first = submit(&app, &alice, run(5000, 30, 4)).await;
    assert_eq!(first["best"], true);
    assert_eq!(first["me"]["rank"], 1);
    // 比較低的分數不會蓋掉紀錄
    let lower = submit(&app, &alice, run(3000, 20, 3)).await;
    assert_eq!(lower["best"], false);
    assert_eq!(lower["me"]["score"], 5000);

    let bob_board = submit(&app, &bob, run(8000, 40, 5)).await;
    assert_eq!(bob_board["me"]["rank"], 1);
    let names: Vec<_> = bob_board["top"].as_array().unwrap().iter().map(|e| e["username"].clone()).collect();
    assert_eq!(names, [json!("bob"), json!("alice")]);

    let higher = submit(&app, &alice, run(9000, 45, 5)).await;
    assert_eq!(higher["best"], true);
    assert_eq!(higher["me"]["rank"], 1);
    assert_eq!(higher["me"]["lines"], 45);

    // 沒登入看得到排行榜，但沒有自己的名次
    let public = app.get("/api/games/tetris/scores", None).await.body;
    assert_eq!(public["top"].as_array().unwrap().len(), 2);
    assert_eq!(public["me"], Value::Null);
    assert!(public.get("best").is_none());

    // 停用的帳號不列入
    sqlx::query("UPDATE users SET disabled = 1 WHERE username = 'alice'").execute(&app.state.pool).await.unwrap();
    let after = app.get("/api/games/tetris/scores", Some(&bob)).await.body;
    assert_eq!(after["top"].as_array().unwrap().len(), 1);
    assert_eq!(after["me"]["rank"], 1);
}

#[tokio::test]
async fn rejects_impossible_scores() {
    let app = app().await;
    let alice = login(&app, "alice").await;
    for body in [
        // 10 分鐘消 1 萬行
        run(1000, 10_000, 5),
        // 等級比消行和時間能到的還高
        json!({ "score": 100, "lines": 10, "level": 9, "duration_ms": 60_000 }),
        // 分數遠超過理論上限
        run(1_000_000_000, 10, 2),
        run(-1, 0, 1),
        json!({ "score": 0, "lines": 0, "level": 1, "duration_ms": 0 }),
    ] {
        let reply = app.call("POST", "/api/games/tetris/scores", Some(&alice), Some(body.clone())).await;
        assert_eq!(reply.status, StatusCode::BAD_REQUEST, "{body}");
    }
    assert_eq!(app.get("/api/games/tetris/scores", None).await.body["top"], json!([]));
}
