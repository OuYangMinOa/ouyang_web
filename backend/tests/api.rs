use std::path::Path;

use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode, header},
};
use backend::{AppState, router};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sqlx::sqlite::SqlitePoolOptions;
use tower::ServiceExt;

async fn app() -> Router {
    // 記憶體資料庫每條連線都是獨立的一份，所以只開一條
    let pool = SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
    sqlx::migrate!().run(&pool).await.unwrap();
    router(AppState { pool, app_env: "test".into() }, Path::new("does-not-exist"))
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
