use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};

use crate::common::{TestApp, app};
use axum::{
    Json, Router,
    body::Body,
    extract::State,
    http::{HeaderMap, Request, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use backend::{
    ai::{AiError, ChatOptions, Message},
    auth::upsert_admin,
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;

const ADMIN_PASSWORD: &str = "correct horse battery";
const KEY: &str = "sk-test-secret-1234";

/// 假的 OpenAI 相容伺服器（像 vLLM）：金鑰要對，只有一個模型 Qwen，對話回固定的串流
#[derive(Default)]
struct Fake {
    requests: Mutex<Vec<Value>>,
    chat_fails: AtomicBool,
}

fn authorized(headers: &HeaderMap) -> bool {
    headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()) == Some(&format!("Bearer {KEY}"))
}

fn unauthorized() -> Response {
    (StatusCode::UNAUTHORIZED, Json(json!({ "error": { "message": "invalid api key" } }))).into_response()
}

async fn fake_models(headers: HeaderMap) -> Response {
    if !authorized(&headers) {
        return unauthorized();
    }
    Json(json!({ "object": "list", "data": [{ "id": "Qwen", "object": "model", "max_model_len": 1_000_000 }] }))
        .into_response()
}

async fn fake_chat(State(fake): State<Arc<Fake>>, headers: HeaderMap, Json(body): Json<Value>) -> Response {
    if !authorized(&headers) {
        return unauthorized();
    }
    fake.requests.lock().unwrap().push(body);
    if fake.chat_fails.load(Ordering::SeqCst) {
        let error = json!({ "error": { "message": "CUDA out of memory" } });
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(error)).into_response();
    }
    let chunk = |delta: Value, finish: Value| {
        format!("data: {}\n\n", json!({ "choices": [{ "index": 0, "delta": delta, "finish_reason": finish }] }))
    };
    let stream = [
        chunk(json!({ "role": "assistant", "content": "" }), Value::Null),
        chunk(json!({ "reasoning_content": "使用者打招呼" }), Value::Null),
        chunk(json!({ "content": "你好" }), Value::Null),
        chunk(json!({ "content": "！" }), Value::Null),
        chunk(json!({}), json!("stop")),
        format!("data: {}\n\n", json!({ "choices": [], "usage": { "prompt_tokens": 12, "completion_tokens": 4 } })),
        "data: [DONE]\n\n".to_owned(),
    ]
    .concat();
    ([(header::CONTENT_TYPE, "text/event-stream")], stream).into_response()
}

/// 啟動假伺服器，回傳它的網址（含 /v1）
async fn fake_server() -> (String, Arc<Fake>) {
    let fake = Arc::new(Fake::default());
    let router = Router::new()
        .route("/v1/models", get(fake_models))
        .route("/v1/chat/completions", post(fake_chat))
        .with_state(fake.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    (format!("http://{addr}/v1"), fake)
}

/// 一個沒有人在聽的網址
async fn dead_url() -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    drop(listener);
    format!("http://{addr}/v1")
}

async fn app_with_admin() -> (TestApp, String) {
    let app = app().await;
    upsert_admin(&app.state.pool, "admin", ADMIN_PASSWORD.into()).await.unwrap();
    let body = json!({ "username": "admin", "password": ADMIN_PASSWORD });
    let reply = app.call("POST", "/api/auth/login", None, Some(body)).await;
    (app, reply.cookie.expect("admin logs in"))
}

async fn create(app: &TestApp, admin: &str, name: &str, base_url: &str, key: &str, model: &str) -> Value {
    let body = json!({ "name": name, "base_url": base_url, "api_key": key, "model": model });
    let reply = app.call("POST", "/api/admin/ai/providers", Some(admin), Some(body)).await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
    reply.body
}

fn provider<'a>(view: &'a Value, name: &str) -> &'a Value {
    view["providers"].as_array().unwrap().iter().find(|p| p["name"] == name).unwrap()
}

async fn public_status(app: &TestApp) -> Value {
    app.get("/api/ai/status", None).await.body
}

/// 測試對話：回傳狀態碼和每一行的 JSON
async fn chat(app: &TestApp, admin: &str, body: Value) -> (StatusCode, Vec<Value>) {
    let request = Request::post("/api/admin/ai/chat")
        .header(header::COOKIE, admin)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let response = app.router.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let text = String::from_utf8(bytes.to_vec()).unwrap();
    (status, text.lines().map(|line| serde_json::from_str(line).unwrap()).collect())
}

#[tokio::test]
async fn nothing_is_available_until_a_provider_is_set() {
    let (app, _) = app_with_admin().await;
    let status = public_status(&app).await;
    assert_eq!(status["configured"], false);
    assert_eq!(status["available"], false);
    assert_eq!(app.get("/api/admin/ai", None).await.status, StatusCode::UNAUTHORIZED);

    let error = app.state.ai.complete(&app.state.pool, &[Message::new("user", "嗨")], &ChatOptions::default()).await;
    assert!(matches!(error, Err(AiError::NotConfigured)));
}

#[tokio::test]
async fn first_provider_becomes_active_and_is_checked_right_away() {
    let (app, admin) = app_with_admin().await;
    let (url, _) = fake_server().await;
    let view = create(&app, &admin, "實驗室", &format!("{url}/"), KEY, "Qwen").await;

    let lab = provider(&view, "實驗室");
    assert_eq!(view["active_id"], lab["id"]);
    assert_eq!(lab["base_url"], url, "結尾的 / 會拿掉");
    assert_eq!(lab["status"]["health"], "ok", "{lab}");
    assert!(lab["status"]["latency_ms"].is_u64());
    assert_eq!(lab["key_hint"], "…1234");
    // 完整的金鑰不會傳出去
    assert!(!view.to_string().contains(KEY));
    assert!(!app.get("/api/admin/ai", Some(&admin)).await.body.to_string().contains(KEY));

    let status = public_status(&app).await;
    assert_eq!(status["configured"], true);
    assert_eq!(status["available"], true);
    assert!(status.get("error").is_none());
}

#[tokio::test]
async fn wrong_key_and_missing_model_are_reported() {
    let (app, admin) = app_with_admin().await;
    let (url, _) = fake_server().await;
    let view = create(&app, &admin, "實驗室", &url, "wrong", "Qwen").await;
    let lab = provider(&view, "實驗室");
    let id = lab["id"].as_i64().unwrap();
    assert_eq!(lab["status"]["health"], "down");
    assert!(lab["status"]["error"].as_str().unwrap().contains("401"), "{lab}");
    // 使用中的那一組掛了，使用者那邊馬上看得到
    assert_eq!(public_status(&app).await["available"], false);

    let body = json!({ "name": "實驗室", "base_url": url, "api_key": KEY, "model": "Nope" });
    let view = app.call("PUT", &format!("/api/admin/ai/providers/{id}"), Some(&admin), Some(body)).await.body;
    let error = provider(&view, "實驗室")["status"]["error"].as_str().unwrap().to_owned();
    assert!(error.contains("Nope") && error.contains("Qwen"), "{error}");

    // 沒給金鑰就沿用剛剛存的
    let body = json!({ "name": "實驗室", "base_url": url, "model": "Qwen" });
    let view = app.call("PUT", &format!("/api/admin/ai/providers/{id}"), Some(&admin), Some(body)).await.body;
    let lab = provider(&view, "實驗室");
    assert_eq!(lab["status"]["health"], "ok", "{lab}");
    assert_eq!(public_status(&app).await["available"], true);
    let events: Vec<&str> = lab["events"].as_array().unwrap().iter().map(|e| e["health"].as_str().unwrap()).collect();
    assert_eq!(events, ["ok", "down", "down"]);
}

#[tokio::test]
async fn unreachable_server_is_down() {
    let (app, admin) = app_with_admin().await;
    let view = create(&app, &admin, "關機了", &dead_url().await, KEY, "Qwen").await;
    let dead = provider(&view, "關機了");
    assert_eq!(dead["status"]["health"], "down");
    assert!(dead["status"]["error"].as_str().unwrap().contains("連不上"), "{dead}");
}

#[tokio::test]
async fn admin_switches_between_providers() {
    let (app, admin) = app_with_admin().await;
    let (url, _) = fake_server().await;
    create(&app, &admin, "好的", &url, KEY, "Qwen").await;
    let view = create(&app, &admin, "壞的", &url, "wrong", "Qwen").await;
    let good = provider(&view, "好的")["id"].as_i64().unwrap();
    let bad = provider(&view, "壞的")["id"].as_i64().unwrap();
    assert_eq!(view["active_id"], good, "第二組不會搶走使用中");

    // 使用中的不能刪
    let reply = app.call("DELETE", &format!("/api/admin/ai/providers/{good}"), Some(&admin), None).await;
    assert_eq!(reply.status, StatusCode::CONFLICT);

    let reply = app.call("PUT", "/api/admin/ai/active", Some(&admin), Some(json!({ "id": bad }))).await;
    assert_eq!(reply.body["active_id"], bad);
    assert_eq!(public_status(&app).await["available"], false);

    // 停用 AI
    let reply = app.call("PUT", "/api/admin/ai/active", Some(&admin), Some(json!({ "id": null }))).await;
    assert_eq!(reply.body["active_id"], Value::Null);
    assert_eq!(public_status(&app).await["configured"], false);

    let reply = app.call("DELETE", &format!("/api/admin/ai/providers/{good}"), Some(&admin), None).await;
    assert_eq!(reply.status, StatusCode::NO_CONTENT);
    let reply = app.call("PUT", "/api/admin/ai/active", Some(&admin), Some(json!({ "id": good }))).await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);
    assert_eq!(app.get("/api/admin/ai", Some(&admin)).await.body["providers"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn models_are_listed_before_saving() {
    let (app, admin) = app_with_admin().await;
    let (url, _) = fake_server().await;
    let list = |body: Value| app.call("POST", "/api/admin/ai/models", Some(&admin), Some(body));

    let reply = list(json!({ "base_url": url, "api_key": KEY })).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert_eq!(reply.body["models"], json!([{ "id": "Qwen", "max_model_len": 1_000_000 }]));

    let reply = list(json!({ "base_url": url, "api_key": "wrong" })).await;
    assert_eq!(reply.status, StatusCode::BAD_GATEWAY);
    assert!(reply.body["error"].as_str().unwrap().contains("金鑰錯誤"), "{}", reply.body);

    // 修改時沒重填金鑰，就用存著的；但網址改了就不送出去
    let id = create(&app, &admin, "實驗室", &url, KEY, "Qwen").await["active_id"].clone();
    assert_eq!(list(json!({ "base_url": url, "provider_id": id })).await.status, StatusCode::OK);
    let other = url.replace("127.0.0.1", "localhost");
    assert_eq!(list(json!({ "base_url": other, "provider_id": id })).await.status, StatusCode::BAD_GATEWAY);
}

#[tokio::test]
async fn test_chat_streams_reasoning_and_answer() {
    let (app, admin) = app_with_admin().await;
    let (url, fake) = fake_server().await;
    create(&app, &admin, "實驗室", &url, KEY, "Qwen").await;

    let body = json!({
        "messages": [{ "role": "system", "content": "用繁體中文" }, { "role": "user", "content": "嗨" }],
        "thinking": false,
    });
    let (status, events) = chat(&app, &admin, body).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        events,
        [
            json!({ "type": "reasoning", "text": "使用者打招呼" }),
            json!({ "type": "content", "text": "你好" }),
            json!({ "type": "content", "text": "！" }),
            json!({ "type": "done", "finish_reason": "stop", "usage": { "prompt_tokens": 12, "completion_tokens": 4 } }),
        ]
    );

    let sent = fake.requests.lock().unwrap().last().unwrap().clone();
    assert_eq!(sent["model"], "Qwen");
    assert_eq!(sent["stream"], true);
    assert_eq!(sent["messages"].as_array().unwrap().len(), 2);
    assert_eq!(sent["chat_template_kwargs"], json!({ "enable_thinking": false }));

    // 其他功能用的 complete：答案和思考分開
    let reply = app.state.ai.complete(&app.state.pool, &[Message::new("user", "嗨")], &ChatOptions::default()).await;
    let reply = reply.unwrap();
    assert_eq!(reply.content, "你好！");
    assert_eq!(reply.reasoning, "使用者打招呼");
    // 沒指定思考模式就不送這個欄位，別的伺服器才不會不認得
    assert!(fake.requests.lock().unwrap().last().unwrap().get("chat_template_kwargs").is_none());
}

#[tokio::test]
async fn failed_chat_marks_the_provider_down_immediately() {
    let (app, admin) = app_with_admin().await;
    let (url, fake) = fake_server().await;
    create(&app, &admin, "實驗室", &url, KEY, "Qwen").await;
    fake.chat_fails.store(true, Ordering::SeqCst);

    let request = Request::post("/api/admin/ai/chat")
        .header(header::COOKIE, &admin)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(json!({ "messages": [{ "role": "user", "content": "嗨" }] }).to_string()))
        .unwrap();
    let response = app.router.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    let body: Value = serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert!(body["error"].as_str().unwrap().contains("CUDA out of memory"), "{body}");

    assert_eq!(public_status(&app).await["available"], false);
    let view = app.get("/api/admin/ai", Some(&admin)).await.body;
    assert_eq!(provider(&view, "實驗室")["status"]["health"], "down");

    // 一般功能拿到的錯誤不含細節
    let error = app.state.ai.complete(&app.state.pool, &[Message::new("user", "嗨")], &ChatOptions::default()).await;
    let error = backend::AppError::from(error.unwrap_err());
    assert_eq!(error.to_string(), "AI 服務暫時無法使用，請稍後再試");

    // 背景再檢查一次（/models 還正常）就恢復
    fake.chat_fails.store(false, Ordering::SeqCst);
    app.call("POST", "/api/admin/ai/check", Some(&admin), None).await;
    assert_eq!(public_status(&app).await["available"], true);
}

#[tokio::test]
async fn chat_input_is_validated() {
    let (app, admin) = app_with_admin().await;
    let (url, _) = fake_server().await;
    create(&app, &admin, "實驗室", &url, KEY, "Qwen").await;
    for body in [
        json!({ "messages": [] }),
        json!({ "messages": [{ "role": "tool", "content": "x" }] }),
        json!({ "messages": [{ "role": "user", "content": "x" }, { "role": "assistant", "content": "y" }] }),
        json!({ "provider_id": 999, "messages": [{ "role": "user", "content": "x" }] }),
    ] {
        let reply = app.call("POST", "/api/admin/ai/chat", Some(&admin), Some(body.clone())).await;
        assert!(reply.status.is_client_error(), "{body} → {}", reply.status);
    }
}
