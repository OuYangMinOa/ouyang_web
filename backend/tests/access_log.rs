mod common;

use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode, header},
};
use backend::{auth::upsert_admin, router};
use common::{TestApp, app};
use serde_json::{Value, json};
use tower::ServiceExt;

async fn login(app: &TestApp, name: &str) -> String {
    upsert_admin(&app.state.pool, name, "password123".into()).await.unwrap();
    let reply =
        app.call("POST", "/api/auth/login", None, Some(json!({ "username": name, "password": "password123" }))).await;
    reply.cookie.unwrap()
}

/// 從 `ip` 送一個 GET（Traefik 會把來源 IP 放在 X-Forwarded-For）
async fn visit(router: &Router, ip: &str, path: &str, cookie: Option<&str>) -> StatusCode {
    let mut request = Request::get(path).header("x-forwarded-for", ip).header(header::USER_AGENT, "test-agent");
    if let Some(cookie) = cookie {
        request = request.header(header::COOKIE, cookie);
    }
    router.clone().oneshot(request.body(Body::empty()).unwrap()).await.unwrap().status()
}

async fn report(app: &TestApp, cookie: &str, query: &str) -> Value {
    app.state.access_log.flush(&app.state.pool).await.unwrap();
    let reply = app.get(&format!("/api/admin/access{query}"), Some(cookie)).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    reply.body
}

#[tokio::test]
async fn records_requests_by_ip() {
    let app = app().await;
    let admin = login(&app, "alice").await;

    // 測試沒有前端的靜態檔，所以不是 API 的路徑也是 404
    assert_eq!(visit(&app.router, "203.0.113.5", "/wp-login.php?x=1", None).await, StatusCode::NOT_FOUND);
    assert_eq!(visit(&app.router, "203.0.113.5", "/api/nope", None).await, StatusCode::NOT_FOUND);
    assert_eq!(visit(&app.router, "198.51.100.7", "/api/auth/me", Some(&admin)).await, StatusCode::OK);
    // health check 不記
    assert_eq!(visit(&app.router, "198.51.100.7", "/api/health", None).await, StatusCode::OK);

    let body = report(&app, &admin, "").await;
    // 登入那一次（ip 是 local）也算
    assert_eq!(body["summary"], json!({ "requests": 4, "ips": 3, "users": 1, "errors": 2 }));
    let ips = body["ips"].as_array().unwrap();
    // 最近的在前面
    assert_eq!(ips[0]["ip"], "198.51.100.7");
    assert_eq!(ips[0]["users"], json!(["alice"]));
    assert_eq!(ips[0]["last_path"], "/api/auth/me");
    assert_eq!(ips[1]["ip"], "203.0.113.5");
    assert_eq!((ips[1]["requests"].clone(), ips[1]["errors"].clone()), (json!(2), json!(2)));
    assert_eq!(ips[1]["users"], json!([]));
    assert_eq!(ips[1]["user_agent"], "test-agent");

    let requests = app.get("/api/admin/access/requests?ip=203.0.113.5", Some(&admin)).await.body;
    let rows: Vec<_> = requests
        .as_array()
        .unwrap()
        .iter()
        .map(|r| (r["path"].clone(), r["query"].clone(), r["status"].clone()))
        .collect();
    assert_eq!(rows, [(json!("/api/nope"), json!(""), json!(404)), (json!("/wp-login.php"), json!("x=1"), json!(404))]);

    let errors = app.get("/api/admin/access/requests?errors=true", Some(&admin)).await.body;
    assert_eq!(errors.as_array().unwrap().len(), 2);

    // 依請求數排：198.51.100.7 最後才來，但 203.0.113.5 有 7 筆
    for _ in 0..5 {
        visit(&app.router, "203.0.113.5", "/", None).await;
    }
    visit(&app.router, "198.51.100.7", "/", None).await;
    let recent = report(&app, &admin, "").await;
    assert_eq!(recent["ips"][0]["ip"], "198.51.100.7");
    let sorted = report(&app, &admin, "?sort=requests").await;
    assert_eq!(
        (sorted["ips"][0]["ip"].clone(), sorted["ips"][0]["requests"].clone()),
        (json!("203.0.113.5"), json!(7))
    );
    // 查紀錄本身不記
    let paths = sorted["paths"].as_array().unwrap();
    assert!(paths.iter().all(|p| !p["path"].as_str().unwrap().starts_with("/api/admin/access")), "{sorted}");
}

#[tokio::test]
async fn skips_bundled_static_files() {
    let dir = std::env::temp_dir().join(format!("access-log-static-{}", std::process::id()));
    std::fs::create_dir_all(dir.join("assets")).unwrap();
    std::fs::write(dir.join("assets/app.js"), "console.log(1)").unwrap();
    std::fs::write(dir.join("index.html"), "<!doctype html>").unwrap();

    let app = app().await;
    let admin = login(&app, "alice").await;
    let router = router(app.state.clone(), &dir);
    assert_eq!(visit(&router, "203.0.113.5", "/assets/app.js", None).await, StatusCode::OK);
    assert_eq!(visit(&router, "203.0.113.5", "/games/tetris", None).await, StatusCode::OK);
    std::fs::remove_dir_all(&dir).unwrap();

    let requests = report(&app, &admin, "").await;
    assert_eq!(
        requests["paths"].as_array().unwrap().iter().map(|p| p["path"].clone()).collect::<Vec<_>>(),
        [json!("/api/auth/login"), json!("/games/tetris")]
    );
}

#[tokio::test]
async fn requires_admin() {
    let app = app().await;
    assert_eq!(app.get("/api/admin/access", None).await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(app.get("/api/admin/access/requests", None).await.status, StatusCode::UNAUTHORIZED);
}
