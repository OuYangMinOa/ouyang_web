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

async fn track(app: &TestApp, cookie: Option<&str>, body: Value) -> StatusCode {
    app.call("POST", "/api/visits/bcs", cookie, Some(body)).await.status
}

#[tokio::test]
async fn records_guests_and_accounts() {
    let app = app().await;
    let admin = login(&app, "alice").await;

    assert_eq!(track(&app, None, json!({ "session": "guest-1", "action": "open" })).await, StatusCode::NO_CONTENT);
    let click = json!({ "session": "guest-1", "action": "click", "detail": "複製內容" });
    assert_eq!(track(&app, None, click).await, StatusCode::NO_CONTENT);
    let open = json!({ "session": "alice-1", "action": "open" });
    assert_eq!(track(&app, Some(&admin), open).await, StatusCode::NO_CONTENT);

    let report = app.get("/api/admin/visits/bcs", Some(&admin)).await;
    assert_eq!(report.status, StatusCode::OK, "{}", report.body);
    assert_eq!(report.body["summary"], json!({ "sessions": 2, "ips": 1, "users": 1, "last_day": 2 }));
    let sessions = report.body["sessions"].as_array().unwrap();
    // 最近的在前面
    assert_eq!(sessions[0]["session"], "alice-1");
    assert_eq!(sessions[0]["users"], json!(["alice"]));
    assert_eq!(sessions[1]["users"], json!([]));
    assert_eq!(sessions[1]["ips"], json!(["local"]));
    assert_eq!((sessions[1]["opens"].clone(), sessions[1]["clicks"].clone()), (json!(1), json!(1)));

    let events = app.get("/api/admin/visits/bcs/guest-1", Some(&admin)).await.body;
    let actions: Vec<_> =
        events.as_array().unwrap().iter().map(|e| (e["action"].clone(), e["detail"].clone())).collect();
    assert_eq!(actions, [(json!("open"), json!("")), (json!("click"), json!("複製內容"))]);
}

#[tokio::test]
async fn rejects_bad_input() {
    let app = app().await;
    assert_eq!(
        app.call("POST", "/api/visits/nope", None, Some(json!({ "session": "abcd", "action": "open" }))).await.status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(track(&app, None, json!({ "session": "abcd", "action": "hack" })).await, StatusCode::BAD_REQUEST);
    assert_eq!(track(&app, None, json!({ "session": "a b;", "action": "open" })).await, StatusCode::BAD_REQUEST);

    let long = json!({ "session": "abcd", "action": "error", "detail": "x".repeat(1000) });
    assert_eq!(track(&app, None, long).await, StatusCode::NO_CONTENT);
    let detail: String = sqlx::query_scalar("SELECT detail FROM page_events").fetch_one(&app.state.pool).await.unwrap();
    assert_eq!(detail.len(), 300);
}

#[tokio::test]
async fn report_needs_admin() {
    let app = app().await;
    assert_eq!(app.get("/api/admin/visits/bcs", None).await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(app.get("/api/admin/visits/bcs/abcd", None).await.status, StatusCode::UNAUTHORIZED);

    // 有帳號但沒有 admin.users
    let admin = login(&app, "alice").await;
    let created = json!({ "username": "bob", "password": "password123", "roles": [] });
    app.call("POST", "/api/admin/users", Some(&admin), Some(created)).await;
    let bob = app
        .call("POST", "/api/auth/login", None, Some(json!({ "username": "bob", "password": "password123" })))
        .await
        .cookie
        .unwrap();
    assert_eq!(app.get("/api/admin/visits/bcs", Some(&bob)).await.status, StatusCode::FORBIDDEN);
}
