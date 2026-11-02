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

const PINS: &str = "/api/nav/pins";

#[tokio::test]
async fn pins_are_saved_per_account_and_app() {
    let app = app().await;
    let alice = login(&app, "alice").await;
    let bob = login(&app, "bob").await;

    assert_eq!(app.get(PINS, None).await.status, StatusCode::UNAUTHORIZED);
    let put = app.call("PUT", "/api/nav/pins/tools", None, Some(json!({ "paths": ["/tools/json"] }))).await;
    assert_eq!(put.status, StatusCode::UNAUTHORIZED);

    assert_eq!(app.get(PINS, Some(&alice)).await.body, json!({ "pins": {} }));

    let tools = json!(["/tools/qrcode", "/tools/json"]);
    let put = app.call("PUT", "/api/nav/pins/tools", Some(&alice), Some(json!({ "paths": tools }))).await;
    assert_eq!(put.status, StatusCode::NO_CONTENT, "{}", put.body);
    app.call("PUT", "/api/nav/pins/games", Some(&alice), Some(json!({ "paths": ["/games/tetris"] }))).await;
    assert_eq!(
        app.get(PINS, Some(&alice)).await.body,
        json!({ "pins": { "tools": tools, "games": ["/games/tetris"] } })
    );
    // 別人的不受影響
    assert_eq!(app.get(PINS, Some(&bob)).await.body, json!({ "pins": {} }));

    // 全部取消還是留著空陣列，跟沒存過分得出來
    let clear = app.call("PUT", "/api/nav/pins/tools", Some(&alice), Some(json!({ "paths": [] }))).await;
    assert_eq!(clear.status, StatusCode::NO_CONTENT);
    assert_eq!(app.get(PINS, Some(&alice)).await.body["pins"]["tools"], json!([]));
}

#[tokio::test]
async fn rejects_strange_pins() {
    let app = app().await;
    let alice = login(&app, "alice").await;
    let too_many: Vec<String> = (0..51).map(|i| format!("/tools/t{i}")).collect();
    for (url, paths) in [
        ("/api/nav/pins/Tools", json!(["/tools/json"])),
        ("/api/nav/pins/tools", json!(["tools/json"])),
        ("/api/nav/pins/tools", json!(["/tools/<script>"])),
        ("/api/nav/pins/tools", json!(["/tools/json", "/tools/json"])),
        ("/api/nav/pins/tools", json!([format!("/{}", "a".repeat(200))])),
        ("/api/nav/pins/tools", json!(too_many)),
        ("/api/nav/pins/tools", json!("/tools/json")),
    ] {
        let reply = app.call("PUT", url, Some(&alice), Some(json!({ "paths": paths }))).await;
        assert!(reply.status.is_client_error(), "{url} {paths} → {}", reply.status);
    }
}
