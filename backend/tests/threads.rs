mod common;

use axum::http::StatusCode;
use common::app;

#[tokio::test]
async fn one_lookup_per_ip_every_ten_seconds() {
    let app = app().await;
    // 網址不對也算一次，不會打到 Threads
    let first = app.get("/api/threads/video?url=https%3A%2F%2Fexample.com%2Ft%2Fabc", None).await;
    assert_eq!(first.status, StatusCode::BAD_REQUEST, "{}", first.body);
    assert_eq!(first.body["error"], "請貼上 Threads 貼文的網址");

    let second = app.get("/api/threads/video?url=https%3A%2F%2Fwww.threads.com%2Ft%2Fabc", None).await;
    assert_eq!(second.status, StatusCode::TOO_MANY_REQUESTS, "{}", second.body);
    assert_eq!(second.body["retry_after"], 10);
}
