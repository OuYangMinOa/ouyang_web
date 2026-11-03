mod common;

use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use backend::auth::upsert_admin;
use common::{TestApp, app};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;

async fn login(app: &TestApp, name: &str) -> String {
    upsert_admin(&app.state.pool, name, "password123".into()).await.unwrap();
    let reply =
        app.call("POST", "/api/auth/login", None, Some(json!({ "username": name, "password": "password123" }))).await;
    reply.cookie.unwrap()
}

/// 一般使用者：拿掉 admin 角色
async fn login_user(app: &TestApp, name: &str) -> String {
    let cookie = login(app, name).await;
    sqlx::query("DELETE FROM user_roles WHERE user_id = (SELECT id FROM users WHERE username = ?)")
        .bind(name)
        .execute(&app.state.pool)
        .await
        .unwrap();
    cookie
}

/// 捷徑的呼叫方式：金鑰放在 X-Threads-Key 標頭
async fn lookup(app: &TestApp, key: Option<&str>, url: &str) -> (StatusCode, Value) {
    let mut request = Request::get(format!("/api/threads/video?url={url}"));
    if let Some(key) = key {
        request = request.header("x-threads-key", key);
    }
    let response = app.router.clone().oneshot(request.body(Body::empty()).unwrap()).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

#[tokio::test]
async fn needs_a_key_and_one_lookup_per_ip_every_ten_seconds() {
    let app = app().await;
    let (status, body) = lookup(&app, None, "https%3A%2F%2Fwww.threads.com%2Ft%2Fabc").await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert!(body["error"].as_str().unwrap().contains("金鑰"), "{body}");
    let (status, body) = lookup(&app, Some("nope"), "https%3A%2F%2Fwww.threads.com%2Ft%2Fabc").await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert!(body["error"].as_str().unwrap().contains("金鑰"), "{body}");

    let alice = login_user(&app, "alice").await;
    let key = app.get("/api/threads/setup", Some(&alice)).await.body["key"].as_str().unwrap().to_owned();

    // 網址不對也算一次，不會打到 Threads
    let (status, body) = lookup(&app, Some(&key), "https%3A%2F%2Fexample.com%2Ft%2Fabc").await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(body["error"], "請貼上 Threads 貼文的網址");
    let (status, body) = lookup(&app, Some(&key), "https%3A%2F%2Fwww.threads.com%2Ft%2Fabc").await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{body}");
    assert_eq!(body["retry_after"], 10);
}

#[tokio::test]
async fn each_account_has_its_own_key() {
    let app = app().await;
    assert_eq!(app.get("/api/threads/setup", None).await.status, StatusCode::UNAUTHORIZED);

    let alice = login_user(&app, "alice").await;
    let bob = login_user(&app, "bob").await;
    let first = app.get("/api/threads/setup", Some(&alice)).await.body;
    assert_eq!(first["shortcut_url"], Value::Null);
    let key = first["key"].as_str().unwrap();
    assert_eq!(key.len(), 64);
    // 再來一次還是同一把
    assert_eq!(app.get("/api/threads/setup", Some(&alice)).await.body["key"], key);
    assert_ne!(app.get("/api/threads/setup", Some(&bob)).await.body["key"], key);

    // 換新的之後舊的失效
    let reset = app.call("POST", "/api/threads/setup/key", Some(&alice), None).await;
    assert_eq!(reset.status, StatusCode::OK);
    assert_ne!(reset.body["key"], key);
    let (status, _) = lookup(&app, Some(key), "https%3A%2F%2Fwww.threads.com%2Ft%2Fabc").await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // 停用的帳號，金鑰也不能用
    let new_key = reset.body["key"].as_str().unwrap();
    sqlx::query("UPDATE users SET disabled = 1 WHERE username = 'alice'").execute(&app.state.pool).await.unwrap();
    let (status, _) = lookup(&app, Some(new_key), "https%3A%2F%2Fwww.threads.com%2Ft%2Fabc").await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn admin_sets_the_shared_shortcut() {
    let app = app().await;
    let admin = login(&app, "admin").await;
    let alice = login_user(&app, "alice").await;
    let link = "https://www.icloud.com/shortcuts/15288f744743420f91b7eea0d039e739";

    let set = |cookie: String, url: &'static str| {
        let app = &app;
        async move { app.call("PUT", "/api/threads/setup/shortcut", Some(&cookie), Some(json!({ "url": url }))).await }
    };
    assert_eq!(set(alice.clone(), link).await.status, StatusCode::FORBIDDEN);
    assert_eq!(set(admin.clone(), "https://evil.com/shortcuts/abc").await.status, StatusCode::BAD_REQUEST);
    assert_eq!(set(admin.clone(), "https://www.icloud.com/shortcuts/").await.status, StatusCode::BAD_REQUEST);
    assert_eq!(set(admin.clone(), link).await.status, StatusCode::NO_CONTENT);
    assert_eq!(app.get("/api/threads/setup", Some(&alice)).await.body["shortcut_url"], link);

    assert_eq!(set(admin, "").await.status, StatusCode::NO_CONTENT);
    assert_eq!(app.get("/api/threads/setup", Some(&alice)).await.body["shortcut_url"], Value::Null);
}

#[tokio::test]
async fn downloads_are_private() {
    let app = app().await;
    let alice = login_user(&app, "alice").await;
    let bob = login_user(&app, "bob").await;
    for (user, url) in [
        ("alice", "https://www.threads.com/@a/post/A1"),
        ("alice", "https://www.threads.com/@a/post/A2"),
        ("bob", "https://www.threads.com/@b/post/B1"),
    ] {
        sqlx::query(
            "INSERT INTO threads_downloads (user_id, url, author, caption, video_count)
             SELECT id, ?, 'a', '說明', 1 FROM users WHERE username = ?",
        )
        .bind(url)
        .bind(user)
        .execute(&app.state.pool)
        .await
        .unwrap();
    }

    assert_eq!(app.get("/api/threads/downloads", None).await.status, StatusCode::UNAUTHORIZED);
    let mine = app.get("/api/threads/downloads", Some(&alice)).await.body;
    let urls: Vec<_> = mine.as_array().unwrap().iter().map(|d| d["url"].as_str().unwrap()).collect();
    // 新的在前，看不到別人的
    assert_eq!(urls, ["https://www.threads.com/@a/post/A2", "https://www.threads.com/@a/post/A1"]);

    let id = mine[0]["id"].as_i64().unwrap();
    let path = format!("/api/threads/downloads/{id}");
    assert_eq!(app.call("DELETE", &path, Some(&bob), None).await.status, StatusCode::NOT_FOUND);
    assert_eq!(app.call("DELETE", &path, Some(&alice), None).await.status, StatusCode::NO_CONTENT);
    assert_eq!(app.get("/api/threads/downloads", Some(&alice)).await.body.as_array().unwrap().len(), 1);
    assert_eq!(app.get("/api/threads/downloads", Some(&bob)).await.body.as_array().unwrap().len(), 1);
}
