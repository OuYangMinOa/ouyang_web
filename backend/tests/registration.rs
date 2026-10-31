mod common;

use axum::http::StatusCode;
use backend::auth::upsert_admin;
use common::{TestApp, app};
use serde_json::{Value, json};

const ADMIN_PASSWORD: &str = "correct horse battery";

async fn app_with_admin() -> (TestApp, String) {
    let app = app().await;
    upsert_admin(&app.state.pool, "admin", ADMIN_PASSWORD.into()).await.unwrap();
    let reply = app.call("POST", "/api/auth/login", None, credentials("admin", ADMIN_PASSWORD)).await;
    (app, reply.cookie.expect("admin logs in"))
}

fn credentials(username: &str, password: &str) -> Option<Value> {
    Some(json!({ "username": username, "password": password }))
}

async fn set_open(app: &TestApp, admin: &str, open: bool) {
    let reply = app.call("PUT", "/api/admin/registrations/open", Some(admin), Some(json!({ "open": open }))).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert_eq!(reply.body["open"], open);
}

async fn register(app: &TestApp, username: &str) -> StatusCode {
    let body = json!({ "username": username, "password": "password123", "note": "我是朋友" });
    app.call("POST", "/api/auth/register", None, Some(body)).await.status
}

async fn pending_id(app: &TestApp, admin: &str, username: &str) -> i64 {
    let report = app.get("/api/admin/registrations", Some(admin)).await.body;
    report["pending"].as_array().unwrap().iter().find(|r| r["username"] == username).unwrap()["id"].as_i64().unwrap()
}

#[tokio::test]
async fn registration_is_closed_by_default() {
    let app = app().await;
    assert_eq!(app.get("/api/auth/register", None).await.body, json!({ "open": false }));
    assert_eq!(register(&app, "alice").await, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn approved_registration_can_log_in() {
    let (app, admin) = app_with_admin().await;
    set_open(&app, &admin, true).await;
    assert_eq!(app.get("/api/auth/register", None).await.body, json!({ "open": true }));

    assert_eq!(register(&app, "alice").await, StatusCode::CREATED);
    // 還沒審核不能登入
    let early = app.call("POST", "/api/auth/login", None, credentials("alice", "password123")).await;
    assert_eq!(early.status, StatusCode::UNAUTHORIZED);

    let report = app.get("/api/admin/registrations", Some(&admin)).await.body;
    assert_eq!(report["pending"][0]["username"], "alice");
    assert_eq!(report["pending"][0]["note"], "我是朋友");
    assert_eq!(report["pending"][0]["ip"], "local");

    let id = pending_id(&app, &admin, "alice").await;
    let approved = app.call("POST", &format!("/api/admin/registrations/{id}/approve"), Some(&admin), None).await;
    assert_eq!(approved.status, StatusCode::OK, "{}", approved.body);
    assert_eq!(approved.body["status"], "approved");
    assert_eq!(approved.body["reviewer"], "admin");

    let login = app.call("POST", "/api/auth/login", None, credentials("alice", "password123")).await;
    assert_eq!(login.status, StatusCode::OK);
    assert_eq!(login.body["roles"], json!([]));

    // 審核過的不能再審一次，也不能用同一個帳號再申請
    let again = app.call("POST", &format!("/api/admin/registrations/{id}/reject"), Some(&admin), None).await;
    assert_eq!(again.status, StatusCode::NOT_FOUND);
    assert_eq!(register(&app, "ALICE").await, StatusCode::CONFLICT);
}

#[tokio::test]
async fn rejected_registration_cannot_log_in_and_may_apply_again() {
    let (app, admin) = app_with_admin().await;
    set_open(&app, &admin, true).await;
    assert_eq!(register(&app, "bob").await, StatusCode::CREATED);
    assert_eq!(register(&app, "Bob").await, StatusCode::CONFLICT, "same name is already pending");

    let id = pending_id(&app, &admin, "bob").await;
    let rejected = app.call("POST", &format!("/api/admin/registrations/{id}/reject"), Some(&admin), None).await;
    assert_eq!(rejected.body["status"], "rejected");
    let login = app.call("POST", "/api/auth/login", None, credentials("bob", "password123")).await;
    assert_eq!(login.status, StatusCode::UNAUTHORIZED);

    let report = app.get("/api/admin/registrations", Some(&admin)).await.body;
    assert_eq!(report["pending"], json!([]));
    assert_eq!(report["reviewed"][0]["username"], "bob");

    assert_eq!(register(&app, "bob").await, StatusCode::CREATED);
}

#[tokio::test]
async fn closing_registration_stops_new_applications() {
    let (app, admin) = app_with_admin().await;
    set_open(&app, &admin, true).await;
    assert_eq!(register(&app, "carol").await, StatusCode::CREATED);
    set_open(&app, &admin, false).await;
    assert_eq!(register(&app, "dave").await, StatusCode::BAD_REQUEST);

    // 關閉前送出的申請還是可以審核
    let id = pending_id(&app, &admin, "carol").await;
    let approved = app.call("POST", &format!("/api/admin/registrations/{id}/approve"), Some(&admin), None).await;
    assert_eq!(approved.status, StatusCode::OK);
}

#[tokio::test]
async fn validates_input_and_limits_per_ip() {
    let (app, admin) = app_with_admin().await;
    set_open(&app, &admin, true).await;
    assert_eq!(register(&app, "admin").await, StatusCode::CONFLICT);
    assert_eq!(register(&app, "no spaces").await, StatusCode::BAD_REQUEST);
    let short = app.call("POST", "/api/auth/register", None, credentials("erin", "short")).await;
    assert_eq!(short.status, StatusCode::BAD_REQUEST);

    for name in ["user1", "user2", "user3"] {
        assert_eq!(register(&app, name).await, StatusCode::CREATED);
    }
    assert_eq!(register(&app, "user4").await, StatusCode::TOO_MANY_REQUESTS);
}

#[tokio::test]
async fn managing_registrations_needs_admin() {
    let (app, admin) = app_with_admin().await;
    assert_eq!(app.get("/api/admin/registrations", None).await.status, StatusCode::UNAUTHORIZED);

    app.call("POST", "/api/admin/users", Some(&admin), credentials("frank", "password123")).await;
    let frank = app.call("POST", "/api/auth/login", None, credentials("frank", "password123")).await.cookie.unwrap();
    assert_eq!(app.get("/api/admin/registrations", Some(&frank)).await.status, StatusCode::FORBIDDEN);
    let toggle = app.call("PUT", "/api/admin/registrations/open", Some(&frank), Some(json!({ "open": true }))).await;
    assert_eq!(toggle.status, StatusCode::FORBIDDEN);
}
