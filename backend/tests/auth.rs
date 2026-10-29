mod common;

use axum::http::StatusCode;
use backend::auth::upsert_admin;
use common::{TestApp, app};
use serde_json::{Value, json};

const ADMIN_PASSWORD: &str = "correct horse battery";

/// 建好管理員並登入，回傳 (app, admin 的 cookie)
async fn app_with_admin() -> (TestApp, String) {
    let app = app().await;
    upsert_admin(&app.state.pool, "admin", ADMIN_PASSWORD.into()).await.unwrap();
    let cookie = login(&app, "admin", ADMIN_PASSWORD).await;
    (app, cookie)
}

fn credentials(username: &str, password: &str) -> Option<Value> {
    Some(json!({ "username": username, "password": password }))
}

async fn login(app: &TestApp, username: &str, password: &str) -> String {
    let reply = app.call("POST", "/api/auth/login", None, credentials(username, password)).await;
    assert_eq!(reply.status, StatusCode::OK, "login {username}: {}", reply.body);
    reply.cookie.expect("login sets a session cookie")
}

fn new_user(username: &str, password: &str, roles: Value) -> Option<Value> {
    Some(json!({ "username": username, "password": password, "roles": roles }))
}

async fn create_user(app: &TestApp, admin: &str, username: &str, roles: Value) -> Value {
    let reply = app.call("POST", "/api/admin/users", Some(admin), new_user(username, "password123", roles)).await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
    reply.body
}

#[tokio::test]
async fn login_me_and_logout() {
    let (app, cookie) = app_with_admin().await;
    assert!(cookie.starts_with("session_test="));

    let me = app.get("/api/auth/me", Some(&cookie)).await;
    assert_eq!(me.status, StatusCode::OK);
    assert_eq!(me.body["username"], "admin");
    assert_eq!(me.body["roles"], json!(["admin"]));
    assert_eq!(me.body["permissions"], json!(["admin.users"]));

    let logout = app.call("POST", "/api/auth/logout", Some(&cookie), None).await;
    assert_eq!(logout.status, StatusCode::NO_CONTENT);
    assert_eq!(app.get("/api/auth/me", Some(&cookie)).await.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn wrong_password_and_unknown_user_look_the_same() {
    let (app, _) = app_with_admin().await;
    let wrong = app.call("POST", "/api/auth/login", None, credentials("admin", "nope-nope")).await;
    let unknown = app.call("POST", "/api/auth/login", None, credentials("ghost", "nope-nope")).await;
    assert_eq!(wrong.status, StatusCode::UNAUTHORIZED);
    assert_eq!(wrong.body, unknown.body);
    assert!(wrong.cookie.is_none());
}

#[tokio::test]
async fn requests_without_session_are_unauthorized() {
    let app = app().await;
    assert_eq!(app.get("/api/auth/me", None).await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(app.get("/api/admin/users", None).await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(app.get("/api/auth/me", Some("session_test=forged")).await.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn admin_pages_need_admin_permission() {
    let (app, admin) = app_with_admin().await;
    create_user(&app, &admin, "alice", json!([])).await;
    let alice = login(&app, "alice", "password123").await;

    assert_eq!(app.get("/api/admin/users", Some(&alice)).await.status, StatusCode::FORBIDDEN);
    assert_eq!(app.get("/api/admin/roles", Some(&alice)).await.status, StatusCode::FORBIDDEN);

    let users = app.get("/api/admin/users", Some(&admin)).await;
    assert_eq!(users.status, StatusCode::OK);
    let names: Vec<_> = users.body.as_array().unwrap().iter().map(|u| u["username"].clone()).collect();
    assert_eq!(names, [json!("admin"), json!("alice")]);

    let roles = app.get("/api/admin/roles", Some(&admin)).await;
    assert_eq!(roles.body[0]["name"], "admin");
    assert_eq!(roles.body[0]["permissions"][0]["name"], "admin.users");
}

#[tokio::test]
async fn granting_admin_role_gives_access() {
    let (app, admin) = app_with_admin().await;
    let bob = create_user(&app, &admin, "bob", json!([])).await;
    let bob_cookie = login(&app, "bob", "password123").await;

    let path = format!("/api/admin/users/{}", bob["id"]);
    let updated = app.call("PATCH", &path, Some(&admin), Some(json!({ "roles": ["admin"] }))).await;
    assert_eq!(updated.body["roles"], json!(["admin"]));
    // 權限每次請求都重新讀，不用重新登入
    assert_eq!(app.get("/api/admin/users", Some(&bob_cookie)).await.status, StatusCode::OK);
}

#[tokio::test]
async fn invalid_new_users_are_rejected() {
    let (app, admin) = app_with_admin().await;
    let create = |body| app.call("POST", "/api/admin/users", Some(&admin), body);

    assert_eq!(create(new_user("ADMIN", "password123", json!([]))).await.status, StatusCode::CONFLICT);
    assert_eq!(create(new_user("carol", "short", json!([]))).await.status, StatusCode::BAD_REQUEST);
    assert_eq!(create(new_user("a b", "password123", json!([]))).await.status, StatusCode::BAD_REQUEST);
    assert_eq!(create(new_user("carol", "password123", json!(["root"]))).await.status, StatusCode::BAD_REQUEST);
    // 角色不存在時整筆不建立
    assert_eq!(app.get("/api/admin/users", Some(&admin)).await.body.as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn disabling_a_user_signs_them_out() {
    let (app, admin) = app_with_admin().await;
    let dave = create_user(&app, &admin, "dave", json!([])).await;
    let dave_cookie = login(&app, "dave", "password123").await;

    let path = format!("/api/admin/users/{}", dave["id"]);
    let reply = app.call("PATCH", &path, Some(&admin), Some(json!({ "disabled": true }))).await;
    assert_eq!(reply.body["disabled"], true);
    assert_eq!(app.get("/api/auth/me", Some(&dave_cookie)).await.status, StatusCode::UNAUTHORIZED);
    let relogin = app.call("POST", "/api/auth/login", None, credentials("dave", "password123")).await;
    assert_eq!(relogin.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn resetting_a_password_signs_the_user_out() {
    let (app, admin) = app_with_admin().await;
    let erin = create_user(&app, &admin, "erin", json!([])).await;
    let erin_cookie = login(&app, "erin", "password123").await;

    let path = format!("/api/admin/users/{}", erin["id"]);
    app.call("PATCH", &path, Some(&admin), Some(json!({ "password": "brand-new-pass" }))).await;
    assert_eq!(app.get("/api/auth/me", Some(&erin_cookie)).await.status, StatusCode::UNAUTHORIZED);
    login(&app, "erin", "brand-new-pass").await;
}

#[tokio::test]
async fn admin_cannot_lock_themselves_out() {
    let (app, admin) = app_with_admin().await;
    let me = app.get("/api/auth/me", Some(&admin)).await;
    let path = format!("/api/admin/users/{}", me.body["id"]);

    let disable = app.call("PATCH", &path, Some(&admin), Some(json!({ "disabled": true }))).await;
    assert_eq!(disable.status, StatusCode::BAD_REQUEST);
    let demote = app.call("PATCH", &path, Some(&admin), Some(json!({ "roles": [] }))).await;
    assert_eq!(demote.status, StatusCode::BAD_REQUEST);
    assert_eq!(app.get("/api/admin/users", Some(&admin)).await.status, StatusCode::OK);
}

#[tokio::test]
async fn change_password_keeps_current_session_only() {
    let (app, cookie) = app_with_admin().await;
    let other_device = login(&app, "admin", ADMIN_PASSWORD).await;
    let change = |current: &str, new: &str| {
        let body = json!({ "current_password": current, "new_password": new });
        app.call("POST", "/api/auth/password", Some(&cookie), Some(body))
    };

    assert_eq!(change("not-it-at-all", "another-password").await.status, StatusCode::BAD_REQUEST);
    assert_eq!(change(ADMIN_PASSWORD, "another-password").await.status, StatusCode::NO_CONTENT);

    assert_eq!(app.get("/api/auth/me", Some(&cookie)).await.status, StatusCode::OK);
    assert_eq!(app.get("/api/auth/me", Some(&other_device)).await.status, StatusCode::UNAUTHORIZED);
    login(&app, "admin", "another-password").await;
}

#[tokio::test]
async fn repeated_failures_are_rate_limited() {
    let (app, _) = app_with_admin().await;
    for _ in 0..10 {
        let reply = app.call("POST", "/api/auth/login", None, credentials("admin", "wrong-password")).await;
        assert_eq!(reply.status, StatusCode::UNAUTHORIZED);
    }
    // 達到上限後連正確密碼也先擋下
    let reply = app.call("POST", "/api/auth/login", None, credentials("admin", ADMIN_PASSWORD)).await;
    assert_eq!(reply.status, StatusCode::TOO_MANY_REQUESTS);
}

#[tokio::test]
async fn create_admin_resets_an_existing_account() {
    let (app, cookie) = app_with_admin().await;
    upsert_admin(&app.state.pool, "admin", "recovered-password".into()).await.unwrap();

    assert_eq!(app.get("/api/auth/me", Some(&cookie)).await.status, StatusCode::UNAUTHORIZED);
    login(&app, "admin", "recovered-password").await;
}
