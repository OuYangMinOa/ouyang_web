mod common;

use std::sync::atomic::Ordering;

use axum::http::StatusCode;
use backend::healthcheck;
use common::app;
use serde_json::json;

#[tokio::test]
async fn health_reports_ok() {
    let app = app().await;
    let reply = app.get("/api/health", None).await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.body["status"], "ok");
    assert_eq!(reply.body["env"], "test");
    assert_eq!(reply.body["commit"], "test-sha");
}

#[tokio::test]
async fn draining_fails_health_but_keeps_serving() {
    let app = app().await;
    app.state.draining.store(true, Ordering::Relaxed);

    let reply = app.get("/api/health", None).await;
    assert_eq!(reply.status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(reply.body["status"], "draining");

    assert_eq!(app.get("/api/messages", None).await.status, StatusCode::OK);
}

#[tokio::test]
async fn healthcheck_command_hits_running_server() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(axum::serve(listener, app().await.router).into_future());

    let healthy = tokio::task::spawn_blocking(move || healthcheck(port)).await.unwrap();
    assert!(healthy);

    // 沒有服務在聽的 port 要回報失敗
    let unused = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    assert!(!tokio::task::spawn_blocking(move || healthcheck(unused)).await.unwrap());
}

#[tokio::test]
async fn created_messages_are_listed_newest_first() {
    let app = app().await;
    let created = app.call("POST", "/api/messages", None, Some(json!({ "content": "  hello  " }))).await;
    assert_eq!(created.status, StatusCode::CREATED);
    assert_eq!(created.body["content"], "hello");
    app.call("POST", "/api/messages", None, Some(json!({ "content": "world" }))).await;

    let list = app.get("/api/messages", None).await;
    assert_eq!(list.status, StatusCode::OK);
    let contents: Vec<_> = list.body.as_array().unwrap().iter().map(|m| m["content"].clone()).collect();
    assert_eq!(contents, [json!("world"), json!("hello")]);
}

#[tokio::test]
async fn blank_message_is_rejected() {
    let app = app().await;
    let reply = app.call("POST", "/api/messages", None, Some(json!({ "content": "   " }))).await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST);
    assert!(reply.body["error"].is_string());
}

#[tokio::test]
async fn unknown_api_route_is_json_404() {
    let app = app().await;
    let reply = app.get("/api/nope", None).await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);
    assert_eq!(reply.body["error"], "not found");
}
