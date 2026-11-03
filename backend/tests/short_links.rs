mod common;

use axum::{
    body::Body,
    http::{Request, StatusCode, header},
};
use backend::auth::upsert_admin;
use common::{TestApp, app};
use serde_json::json;
use tower::ServiceExt;

async fn login(app: &TestApp, name: &str) -> String {
    upsert_admin(&app.state.pool, name, "password123".into()).await.unwrap();
    let reply =
        app.call("POST", "/api/auth/login", None, Some(json!({ "username": name, "password": "password123" }))).await;
    reply.cookie.unwrap()
}

/// 打開短網址：回傳狀態碼和 Location
async fn follow(app: &TestApp, code: &str, cookie: Option<&str>, ip: &str) -> (StatusCode, Option<String>) {
    let mut request =
        Request::get(format!("/s/{code}")).header("x-forwarded-for", ip).header(header::USER_AGENT, "test");
    if let Some(cookie) = cookie {
        request = request.header(header::COOKIE, cookie);
    }
    let response = app.router.clone().oneshot(request.body(Body::empty()).unwrap()).await.unwrap();
    let location = response.headers().get(header::LOCATION).and_then(|v| v.to_str().ok()).map(String::from);
    (response.status(), location)
}

#[tokio::test]
async fn create_follow_and_count_clicks() {
    let app = app().await;
    assert_eq!(
        app.call("POST", "/api/links", None, Some(json!({ "url": "example.com" }))).await.status,
        StatusCode::UNAUTHORIZED
    );

    let alice = login(&app, "alice").await;
    let reply = app.call("POST", "/api/links", Some(&alice), Some(json!({ "url": "example.com/a?b=1" }))).await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
    let code = reply.body["code"].as_str().unwrap().to_owned();
    assert_eq!(code.len(), 4);
    assert_eq!(reply.body["url"], "https://example.com/a?b=1");
    let id = reply.body["id"].as_i64().unwrap();

    assert_eq!(
        follow(&app, &code, None, "1.1.1.1").await,
        (StatusCode::SEE_OTHER, Some("https://example.com/a?b=1".into()))
    );
    follow(&app, &code, None, "1.1.1.1").await;
    follow(&app, &code, Some(&alice), "2.2.2.2").await;
    assert_eq!(follow(&app, "nope", None, "1.1.1.1").await.0, StatusCode::NOT_FOUND);

    let stats = app.get(&format!("/api/links/{id}/stats"), Some(&alice)).await.body;
    assert_eq!(stats["link"]["clicks"], 3);
    assert_eq!(stats["link"]["ips"], 2);
    assert_eq!(stats["ips"][0]["ip"], "2.2.2.2");
    assert_eq!(stats["ips"][0]["users"], "alice");
    assert_eq!(stats["ips"][1]["clicks"], 2);
    assert_eq!(stats["clicks"].as_array().unwrap().len(), 3);
    assert_eq!(stats["days"][0]["clicks"], 3);
}

#[tokio::test]
async fn require_login_sends_guests_to_the_login_page() {
    let app = app().await;
    let alice = login(&app, "alice").await;
    let reply = app
        .call(
            "POST",
            "/api/links",
            Some(&alice),
            Some(json!({ "url": "https://example.com", "code": "Secret_1", "require_login": true })),
        )
        .await;
    assert_eq!(reply.status, StatusCode::CREATED);
    let id = reply.body["id"].as_i64().unwrap();

    assert_eq!(
        follow(&app, "Secret_1", None, "1.1.1.1").await,
        (StatusCode::SEE_OTHER, Some("/login?next=/s/Secret_1".into()))
    );
    // 代碼大小寫有分
    assert_eq!(follow(&app, "secret_1", Some(&alice), "1.1.1.1").await.0, StatusCode::NOT_FOUND);
    assert_eq!(follow(&app, "Secret_1", Some(&alice), "1.1.1.1").await.1.as_deref(), Some("https://example.com/"));
    // 沒登入被擋下來的不算點擊
    assert_eq!(app.get(&format!("/api/links/{id}"), Some(&alice)).await.body["clicks"], 1);

    // 關掉之後訪客也能直接跳
    let reply = app
        .call(
            "PUT",
            &format!("/api/links/{id}"),
            Some(&alice),
            Some(json!({ "url": "https://example.org", "require_login": false })),
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert_eq!(follow(&app, "Secret_1", None, "1.1.1.1").await.1.as_deref(), Some("https://example.org/"));
}

#[tokio::test]
async fn codes_and_urls_are_checked() {
    let app = app().await;
    let alice = login(&app, "alice").await;
    let create = |body| app.call("POST", "/api/links", Some(&alice), Some(body));

    assert_eq!(create(json!({ "url": "https://example.com", "code": "taken" })).await.status, StatusCode::CREATED);
    assert_eq!(create(json!({ "url": "https://example.com", "code": "taken" })).await.status, StatusCode::CONFLICT);
    assert_eq!(create(json!({ "url": "https://example.com", "code": "a/b" })).await.status, StatusCode::BAD_REQUEST);
    assert_eq!(create(json!({ "url": "javascript:alert(1)" })).await.status, StatusCode::BAD_REQUEST);
    assert_eq!(create(json!({ "url": "" })).await.status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn links_are_private_to_their_owner() {
    let app = app().await;
    let alice = login(&app, "alice").await;
    let bob = login(&app, "bob").await;
    let id =
        app.call("POST", "/api/links", Some(&alice), Some(json!({ "url": "https://example.com" }))).await.body["id"]
            .as_i64()
            .unwrap();

    assert_eq!(app.get("/api/links", Some(&bob)).await.body, json!([]));
    assert_eq!(app.get(&format!("/api/links/{id}"), Some(&bob)).await.status, StatusCode::NOT_FOUND);
    assert_eq!(app.get(&format!("/api/links/{id}/stats"), Some(&bob)).await.status, StatusCode::NOT_FOUND);
    assert_eq!(app.call("DELETE", &format!("/api/links/{id}"), Some(&bob), None).await.status, StatusCode::NOT_FOUND);
    let update = json!({ "url": "https://evil.example", "require_login": false });
    assert_eq!(
        app.call("PUT", &format!("/api/links/{id}"), Some(&bob), Some(update)).await.status,
        StatusCode::NOT_FOUND
    );

    assert_eq!(
        app.call("DELETE", &format!("/api/links/{id}"), Some(&alice), None).await.status,
        StatusCode::NO_CONTENT
    );
    assert_eq!(app.get("/api/links", Some(&alice)).await.body, json!([]));
}
