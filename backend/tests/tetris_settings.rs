mod common;

use axum::http::StatusCode;
use backend::auth::upsert_admin;
use common::{TestApp, app};
use serde_json::json;

async fn login(app: &TestApp, name: &str) -> String {
    upsert_admin(&app.state.pool, name, "password123".into()).await.unwrap();
    let reply =
        app.call("POST", "/api/auth/login", None, Some(json!({ "username": name, "password": "password123" }))).await;
    reply.cookie.unwrap()
}

#[tokio::test]
async fn keys_are_saved_per_account() {
    let app = app().await;
    assert_eq!(app.get("/api/games/tetris/settings", None).await.status, StatusCode::UNAUTHORIZED);
    let alice = login(&app, "alice").await;
    let bob = login(&app, "bob").await;

    let empty = app.get("/api/games/tetris/settings", Some(&alice)).await;
    assert_eq!(empty.body, json!({ "keys": null }));

    let keys = json!({ "left": ["KeyA"], "right": ["KeyD"], "hard": ["Space", "KeyW"] });
    let put = app.call("PUT", "/api/games/tetris/settings", Some(&alice), Some(json!({ "keys": keys }))).await;
    assert_eq!(put.status, StatusCode::NO_CONTENT, "{}", put.body);
    assert_eq!(app.get("/api/games/tetris/settings", Some(&alice)).await.body["keys"], keys);
    // 別人的不受影響
    assert_eq!(app.get("/api/games/tetris/settings", Some(&bob)).await.body["keys"], json!(null));

    // 傳 null 恢復預設
    let reset = app.call("PUT", "/api/games/tetris/settings", Some(&alice), Some(json!({ "keys": null }))).await;
    assert_eq!(reset.status, StatusCode::NO_CONTENT);
    assert_eq!(app.get("/api/games/tetris/settings", Some(&alice)).await.body["keys"], json!(null));
}

#[tokio::test]
async fn rejects_strange_keys() {
    let app = app().await;
    let alice = login(&app, "alice").await;
    for keys in [
        json!({ "Left": ["KeyA"] }),
        json!({ "left": ["<script>"] }),
        json!({ "left": ["KeyA", "KeyB", "KeyC", "KeyD", "KeyE"] }),
        json!({ "left": "KeyA" }),
    ] {
        let reply = app.call("PUT", "/api/games/tetris/settings", Some(&alice), Some(json!({ "keys": keys }))).await;
        assert!(reply.status.is_client_error(), "{keys} → {}", reply.status);
    }
}
