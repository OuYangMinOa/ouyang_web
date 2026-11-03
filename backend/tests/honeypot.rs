mod common;

use axum::{
    body::Body,
    http::{Request, StatusCode, header},
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

/// 從 `ip` 送一個請求，回傳狀態碼、Content-Type 和內容
async fn fetch(
    app: &TestApp,
    method: &str,
    ip: &str,
    path: &str,
    cookie: Option<&str>,
) -> (StatusCode, String, String) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("x-forwarded-for", ip)
        .header(header::USER_AGENT, "zgrab/0.x");
    if let Some(cookie) = cookie {
        request = request.header(header::COOKIE, cookie);
    }
    let response = app.router.clone().oneshot(request.body(Body::empty()).unwrap()).await.unwrap();
    let status = response.status();
    let content_type =
        response.headers().get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or_default().to_owned();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    (status, content_type, String::from_utf8(body.to_vec()).unwrap())
}

#[tokio::test]
async fn serves_fake_env_and_records_who_took_it() {
    let app = app().await;
    let admin = login(&app, "alice").await;

    let (status, content_type, first) = fetch(&app, "GET", "203.0.113.5", "/.env", None).await;
    assert_eq!(status, StatusCode::OK);
    assert!(content_type.starts_with("text/plain"), "{content_type}");
    assert!(first.contains("DB_PASSWORD="), "{first}");
    // 同一個程序裡內容不變，看起來才像真的檔案
    let (_, _, again) = fetch(&app, "GET", "203.0.113.5", "/.env.production?x=1", None).await;
    assert_eq!(again, first);
    // 在 /api 底下、其他資料夾底下也一樣
    assert_eq!(fetch(&app, "POST", "198.51.100.7", "/api/.env", None).await.0, StatusCode::OK);
    assert_eq!(fetch(&app, "GET", "192.0.2.9", "/laravel/.env", Some(&admin)).await.0, StatusCode::OK);
    // 不是 .env 的照舊
    assert_eq!(fetch(&app, "GET", "203.0.113.5", "/.git/config", None).await.0, StatusCode::NOT_FOUND);
    assert_eq!(fetch(&app, "GET", "203.0.113.5", "/api/nope", None).await.0, StatusCode::NOT_FOUND);

    let reply = app.get("/api/admin/honeypot", Some(&admin)).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    let body = reply.body;
    assert_eq!(body["summary"], json!({ "hits": 4, "ips": 3, "last_day": 4, "last_day_ips": 3 }));
    let ips = body["ips"].as_array().unwrap();
    let rows: Vec<_> = ips.iter().map(|r| (r["ip"].clone(), r["hits"].clone(), r["users"].clone())).collect();
    // 最近來過的在前面；登入的人會記下帳號
    assert_eq!(
        rows,
        [
            (json!("192.0.2.9"), json!(1), json!(["alice"])),
            (json!("198.51.100.7"), json!(1), json!([])),
            (json!("203.0.113.5"), json!(2), json!([])),
        ]
    );
    assert_eq!(ips[2]["paths"], json!(["/.env", "/.env.production"]));
    assert_eq!(ips[2]["user_agent"], "zgrab/0.x");
    assert_eq!(body["paths"].as_array().unwrap().len(), 4);

    let hits = app.get("/api/admin/honeypot/hits?ip=203.0.113.5", Some(&admin)).await.body;
    let rows: Vec<_> =
        hits.as_array().unwrap().iter().map(|h| (h["method"].clone(), h["path"].clone(), h["query"].clone())).collect();
    assert_eq!(
        rows,
        [(json!("GET"), json!("/.env.production"), json!("x=1")), (json!("GET"), json!("/.env"), json!(""))]
    );
    assert_eq!(app.get("/api/admin/honeypot/hits", Some(&admin)).await.body.as_array().unwrap().len(), 4);

    // IP 訪問紀錄也記得到，狀態碼是 200
    app.state.access_log.flush(&app.state.pool).await.unwrap();
    let access = app.get("/api/admin/access/requests?ip=198.51.100.7", Some(&admin)).await.body;
    assert_eq!((access[0]["path"].clone(), access[0]["status"].clone()), (json!("/api/.env"), json!(200)));
}

#[tokio::test]
async fn limits_records_per_ip() {
    let app = app().await;
    let admin = login(&app, "alice").await;
    for _ in 0..205 {
        assert_eq!(fetch(&app, "GET", "203.0.113.5", "/.env", None).await.0, StatusCode::OK);
    }
    let body: Value = app.get("/api/admin/honeypot", Some(&admin)).await.body;
    assert_eq!(body["summary"]["hits"], 200);
}

#[tokio::test]
async fn requires_admin() {
    let app = app().await;
    assert_eq!(app.get("/api/admin/honeypot", None).await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(app.get("/api/admin/honeypot/hits", None).await.status, StatusCode::UNAUTHORIZED);
}
