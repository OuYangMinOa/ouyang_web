use std::path::Path;

use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode, header},
};
use backend::{AppState, healthcheck, router};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sqlx::sqlite::SqlitePoolOptions;
use tower::ServiceExt;

async fn app() -> Router {
    // 記憶體資料庫每條連線都是獨立的一份，所以只開一條
    let pool = SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
    sqlx::migrate!().run(&pool).await.unwrap();
    let state = AppState { pool, app_env: "test".into(), commit: "test-sha".into() };
    router(state, Path::new("does-not-exist"))
}

async fn send(app: &Router, request: Request<Body>) -> (StatusCode, Value) {
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

fn post_message(content: &str) -> Request<Body> {
    Request::post("/api/messages")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(json!({ "content": content }).to_string()))
        .unwrap()
}

#[tokio::test]
async fn health_reports_ok() {
    let app = app().await;
    let (status, body) = send(&app, Request::get("/api/health").body(Body::empty()).unwrap()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["status"], "ok");
    assert_eq!(body["env"], "test");
    assert_eq!(body["commit"], "test-sha");
}

#[tokio::test]
async fn healthcheck_command_hits_running_server() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(axum::serve(listener, app().await).into_future());

    let healthy = tokio::task::spawn_blocking(move || healthcheck(port)).await.unwrap();
    assert!(healthy);

    // 沒有服務在聽的 port 要回報失敗
    let unused = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    assert!(!tokio::task::spawn_blocking(move || healthcheck(unused)).await.unwrap());
}

#[tokio::test]
async fn created_messages_are_listed_newest_first() {
    let app = app().await;
    let (status, created) = send(&app, post_message("  hello  ")).await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(created["content"], "hello");
    send(&app, post_message("world")).await;

    let (status, list) = send(&app, Request::get("/api/messages").body(Body::empty()).unwrap()).await;
    assert_eq!(status, StatusCode::OK);
    let contents: Vec<_> = list.as_array().unwrap().iter().map(|m| m["content"].clone()).collect();
    assert_eq!(contents, [json!("world"), json!("hello")]);
}

#[tokio::test]
async fn blank_message_is_rejected() {
    let app = app().await;
    let (status, body) = send(&app, post_message("   ")).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body["error"].is_string());
}

#[tokio::test]
async fn unknown_api_route_is_json_404() {
    let app = app().await;
    let (status, body) = send(&app, Request::get("/api/nope").body(Body::empty()).unwrap()).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["error"], "not found");
}
