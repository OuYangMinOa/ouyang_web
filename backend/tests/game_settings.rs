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

const TETRIS: &str = "/api/games/tetris/settings";
const PUYO: &str = "/api/games/puyo/settings";

#[tokio::test]
async fn keys_are_saved_per_account() {
    let app = app().await;
    let alice = login(&app, "alice").await;
    let bob = login(&app, "bob").await;
    for url in [TETRIS, PUYO] {
        assert_eq!(app.get(url, None).await.status, StatusCode::UNAUTHORIZED);

        let empty = app.get(url, Some(&alice)).await;
        assert_eq!(empty.body, json!({ "keys": null }));

        let keys = json!({ "left": ["KeyA"], "right": ["KeyD"], "hard": ["Space", "KeyW"] });
        let put = app.call("PUT", url, Some(&alice), Some(json!({ "keys": keys }))).await;
        assert_eq!(put.status, StatusCode::NO_CONTENT, "{}", put.body);
        assert_eq!(app.get(url, Some(&alice)).await.body["keys"], keys);
        // 別人的不受影響
        assert_eq!(app.get(url, Some(&bob)).await.body["keys"], json!(null));

        // 傳 null 恢復預設
        let reset = app.call("PUT", url, Some(&alice), Some(json!({ "keys": null }))).await;
        assert_eq!(reset.status, StatusCode::NO_CONTENT);
        assert_eq!(app.get(url, Some(&alice)).await.body["keys"], json!(null));
    }
}

#[tokio::test]
async fn each_game_keeps_its_own_keys() {
    let app = app().await;
    let alice = login(&app, "alice").await;
    let keys = json!({ "hold": ["KeyC"] });
    app.call("PUT", TETRIS, Some(&alice), Some(json!({ "keys": keys }))).await;
    assert_eq!(app.get(TETRIS, Some(&alice)).await.body["keys"], keys);
    assert_eq!(app.get(PUYO, Some(&alice)).await.body["keys"], json!(null));
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
        for url in [TETRIS, PUYO] {
            let reply = app.call("PUT", url, Some(&alice), Some(json!({ "keys": keys }))).await;
            assert!(reply.status.is_client_error(), "{url} {keys} → {}", reply.status);
        }
    }
}

const HANDLING: &str = "/api/games/tetris/handling";

#[tokio::test]
async fn handling_is_saved_per_account() {
    let app = app().await;
    let alice = login(&app, "alice").await;
    let bob = login(&app, "bob").await;
    assert_eq!(app.get(HANDLING, None).await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(app.get(HANDLING, Some(&alice)).await.body, json!({ "handling": null }));

    let handling = json!({ "das": 200, "arr": 0, "soft": 0 });
    let put = app.call("PUT", HANDLING, Some(&alice), Some(json!({ "handling": handling }))).await;
    assert_eq!(put.status, StatusCode::NO_CONTENT, "{}", put.body);
    assert_eq!(app.get(HANDLING, Some(&alice)).await.body["handling"], handling);
    assert_eq!(app.get(HANDLING, Some(&bob)).await.body["handling"], json!(null));
    // 跟快捷鍵分開存，改其中一個不影響另一個
    app.call("PUT", TETRIS, Some(&alice), Some(json!({ "keys": null }))).await;
    assert_eq!(app.get(HANDLING, Some(&alice)).await.body["handling"], handling);

    let reset = app.call("PUT", HANDLING, Some(&alice), Some(json!({ "handling": null }))).await;
    assert_eq!(reset.status, StatusCode::NO_CONTENT);
    assert_eq!(app.get(HANDLING, Some(&alice)).await.body["handling"], json!(null));
}

#[tokio::test]
async fn handling_without_soft_uses_default() {
    // 加速下落是後來才加的，舊版前端送來的沒有這欄
    let app = app().await;
    let alice = login(&app, "alice").await;
    let put = app.call("PUT", HANDLING, Some(&alice), Some(json!({ "handling": { "das": 200, "arr": 0 } }))).await;
    assert_eq!(put.status, StatusCode::NO_CONTENT, "{}", put.body);
    assert_eq!(app.get(HANDLING, Some(&alice)).await.body["handling"], json!({ "das": 200, "arr": 0, "soft": 30 }));
}

#[tokio::test]
async fn rejects_strange_handling() {
    let app = app().await;
    let alice = login(&app, "alice").await;
    for handling in [
        json!({ "das": 10, "arr": 40 }),
        json!({ "das": 170, "arr": 1000 }),
        json!({ "das": -1, "arr": 40 }),
        json!({ "das": 170 }),
        json!({ "das": 170, "arr": 40, "soft": 101 }),
        json!({ "das": 170, "arr": 40, "soft": -1 }),
        json!({ "das": 170, "arr": 40, "extra": 1 }),
        json!("fast"),
    ] {
        let reply = app.call("PUT", HANDLING, Some(&alice), Some(json!({ "handling": handling }))).await;
        assert!(reply.status.is_client_error(), "{handling} → {}", reply.status);
    }
}
