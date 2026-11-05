mod common;

use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};

use axum::{
    Json, Router,
    body::Body,
    extract::State,
    http::{HeaderMap, Request, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use backend::auth::upsert_admin;
use common::{TestApp, app};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;

const PASSWORD: &str = "correct horse battery";

// ---- 假的 vLLM：看最後一則訊息決定要直接回答還是呼叫工具 ----

#[derive(Default)]
struct FakeModel {
    requests: Mutex<Vec<Value>>,
    /// 模擬 vLLM 沒開 --enable-auto-tool-choice：帶 tools 就回 400
    reject_tools: AtomicBool,
}

enum Reply {
    Text(String),
    Call(&'static str, &'static str),
}

fn sse(chunks: Vec<Value>) -> Response {
    let mut body: String = chunks.iter().map(|c| format!("data: {c}\n\n")).collect();
    body.push_str(&format!(
        "data: {}\n\ndata: [DONE]\n\n",
        json!({ "choices": [], "usage": { "prompt_tokens": 100, "completion_tokens": 10 } })
    ));
    ([(header::CONTENT_TYPE, "text/event-stream")], body).into_response()
}

async fn fake_models() -> Json<Value> {
    Json(json!({ "object": "list", "data": [{ "id": "Qwen", "object": "model" }] }))
}

async fn fake_chat(State(fake): State<Arc<FakeModel>>, Json(body): Json<Value>) -> Response {
    fake.requests.lock().unwrap().push(body.clone());
    if fake.reject_tools.load(Ordering::SeqCst) && body.get("tools").is_some() {
        let message = "\"auto\" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set";
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": { "message": message } }))).into_response();
    }
    let last = body["messages"].as_array().unwrap().last().unwrap().clone();
    let text = last["content"].as_str().unwrap_or_default().to_owned();
    let has_tools = body.get("tools").is_some();
    let reply = if body["max_tokens"] == 40 {
        Reply::Text("「測試標題」".into())
    } else if body.get("response_format").is_some() {
        Reply::Text(
            json!({ "title": "跟阿明吃飯", "start_date": "2026-11-11", "end_date": "2026-11-11", "note": "19:00",
                    "repeat": "none", "interval": 1, "weekdays": [], "until": null,
                    "lunar_month": null, "lunar_day": null })
            .to_string(),
        )
    } else if last["role"] == "tool" {
        Reply::Text(format!("工具說：{text}"))
    } else if has_tools && text.contains("農曆") {
        Reply::Call("lunar_convert", r#"{"lunar_year": 2026, "lunar_month": 8, "lunar_day": 15}"#)
    } else if has_tools && text.contains("記下") {
        Reply::Call("calendar_create_event", r#"{"title": "看牙醫", "start_date": "2026-12-01"}"#)
    } else if has_tools && text.contains("有沒有") {
        Reply::Call("site_search", r#"{"query": "證件照"}"#)
    } else if has_tools && text.contains("回聲") {
        Reply::Call("demo__echo", r#"{"text": "哈囉"}"#)
    } else {
        Reply::Text("你好！".into())
    };
    let choice =
        |delta: Value, finish: Value| json!({ "choices": [{ "index": 0, "delta": delta, "finish_reason": finish }] });
    match reply {
        Reply::Text(text) => {
            let (a, b) = text.split_at(text.char_indices().nth(1).map_or(text.len(), |(i, _)| i));
            sse(vec![
                choice(json!({ "role": "assistant", "reasoning_content": "想一下" }), Value::Null),
                choice(json!({ "content": a }), Value::Null),
                choice(json!({ "content": b }), Value::Null),
                choice(json!({}), json!("stop")),
            ])
        }
        Reply::Call(name, arguments) => {
            // 參數切成兩段送，確認有接起來
            let (a, b) = arguments.split_at(arguments.len() / 2);
            sse(vec![
                choice(
                    json!({ "role": "assistant", "content": null, "tool_calls": [{ "index": 0, "id": "call_1",
                            "type": "function", "function": { "name": name, "arguments": "" } }] }),
                    Value::Null,
                ),
                choice(json!({ "tool_calls": [{ "index": 0, "function": { "arguments": a } }] }), Value::Null),
                choice(json!({ "tool_calls": [{ "index": 0, "function": { "arguments": b } }] }), Value::Null),
                choice(json!({}), json!("tool_calls")),
            ])
        }
    }
}

async fn fake_model() -> (String, Arc<FakeModel>) {
    let fake = Arc::new(FakeModel::default());
    let router = Router::new()
        .route("/v1/models", get(fake_models))
        .route("/v1/chat/completions", post(fake_chat))
        .with_state(fake.clone());
    (serve(router).await, fake)
}

async fn serve(router: Router) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    format!("http://{addr}")
}

// ---- 假的 MCP 伺服器（Streamable HTTP） ----

#[derive(Default)]
struct FakeMcp {
    calls: AtomicUsize,
    initializes: AtomicUsize,
    /// 下一個請求回 404，模擬 session 過期
    expire: AtomicBool,
}

const MCP_TOKEN: &str = "Bearer mcp-secret-token";

async fn fake_mcp(State(fake): State<Arc<FakeMcp>>, headers: HeaderMap, Json(body): Json<Value>) -> Response {
    if headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()) != Some(MCP_TOKEN) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let id = body["id"].clone();
    let method = body["method"].as_str().unwrap_or_default();
    if method == "initialize" {
        fake.initializes.fetch_add(1, Ordering::SeqCst);
        let result = json!({ "protocolVersion": "2025-06-18", "capabilities": { "tools": {} },
                             "serverInfo": { "name": "demo", "version": "1" } });
        return ([("mcp-session-id", "s1")], Json(json!({ "jsonrpc": "2.0", "id": id, "result": result })))
            .into_response();
    }
    if headers.get("mcp-session-id").and_then(|v| v.to_str().ok()) != Some("s1") {
        return StatusCode::BAD_REQUEST.into_response();
    }
    if method.starts_with("notifications/") {
        return StatusCode::ACCEPTED.into_response();
    }
    if fake.expire.swap(false, Ordering::SeqCst) {
        return StatusCode::NOT_FOUND.into_response();
    }
    match method {
        "tools/list" => {
            let tools = json!([
                { "name": "echo", "description": "把文字原樣回傳",
                  "inputSchema": { "type": "object", "properties": { "text": { "type": "string" } } },
                  "annotations": { "readOnlyHint": true } },
                { "name": "delete_all", "description": "刪掉全部",
                  "inputSchema": { "type": "object", "properties": {} } },
            ]);
            Json(json!({ "jsonrpc": "2.0", "id": id, "result": { "tools": tools } })).into_response()
        }
        "tools/call" => {
            fake.calls.fetch_add(1, Ordering::SeqCst);
            let text = body["params"]["arguments"]["text"].as_str().unwrap_or_default();
            // 用 SSE 回，前面先夾一則進度通知
            let progress = json!({ "jsonrpc": "2.0", "method": "notifications/progress", "params": { "progress": 1 } });
            let result = json!({ "jsonrpc": "2.0", "id": id,
                                 "result": { "content": [{ "type": "text", "text": format!("echo: {text}") }] } });
            let stream = format!("event: message\ndata: {progress}\n\nevent: message\ndata: {result}\n\n");
            ([(header::CONTENT_TYPE, "text/event-stream")], stream).into_response()
        }
        _ => Json(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": "no such method" } }))
            .into_response(),
    }
}

async fn fake_mcp_server() -> (String, Arc<FakeMcp>) {
    let fake = Arc::new(FakeMcp::default());
    let router = Router::new().route("/mcp", post(fake_mcp)).with_state(fake.clone());
    (format!("{}/mcp", serve(router).await), fake)
}

// ---- 共用 ----

struct Setup {
    app: TestApp,
    admin: String,
    alice: String,
    fake: Arc<FakeModel>,
}

async fn setup() -> Setup {
    let app = app().await;
    upsert_admin(&app.state.pool, "admin", PASSWORD.into()).await.unwrap();
    let login = |name: &'static str| {
        let app = &app;
        async move {
            let body = json!({ "username": name, "password": PASSWORD });
            app.call("POST", "/api/auth/login", None, Some(body)).await.cookie.expect("logs in")
        }
    };
    let admin = login("admin").await;
    let body = json!({ "username": "alice", "password": PASSWORD, "roles": [] });
    assert_eq!(app.call("POST", "/api/admin/users", Some(&admin), Some(body)).await.status, StatusCode::CREATED);
    let alice = login("alice").await;

    let (url, fake) = fake_model().await;
    let body = json!({ "name": "實驗室", "base_url": format!("{url}/v1"), "api_key": "", "model": "Qwen" });
    let reply = app.call("POST", "/api/admin/ai/providers", Some(&admin), Some(body)).await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
    Setup { app, admin, alice, fake }
}

/// POST 一個回傳 NDJSON 串流的 API：回傳狀態碼和每一行
async fn stream(app: &TestApp, path: &str, cookie: &str, body: Value) -> (StatusCode, Vec<Value>) {
    let request = Request::post(path)
        .header(header::COOKIE, cookie)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let response = app.router.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let text = String::from_utf8(bytes.to_vec()).unwrap();
    if !status.is_success() {
        return (status, vec![serde_json::from_str(&text).unwrap_or(Value::Null)]);
    }
    (status, text.lines().map(|line| serde_json::from_str(line).unwrap()).collect())
}

async fn new_chat(app: &TestApp, cookie: &str) -> i64 {
    let reply = app.call("POST", "/api/ai/chats", Some(cookie), None).await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
    reply.body["id"].as_i64().unwrap()
}

async fn say(app: &TestApp, cookie: &str, chat: i64, text: &str) -> (StatusCode, Vec<Value>) {
    stream(app, &format!("/api/ai/chats/{chat}/messages"), cookie, json!({ "content": text })).await
}

fn types(events: &[Value]) -> Vec<&str> {
    events.iter().map(|e| e["type"].as_str().unwrap()).collect()
}

fn find<'a>(events: &'a [Value], kind: &str) -> &'a Value {
    events.iter().find(|e| e["type"] == kind).unwrap_or_else(|| panic!("no {kind} in {events:?}"))
}

fn content(events: &[Value]) -> String {
    events.iter().filter(|e| e["type"] == "content").map(|e| e["text"].as_str().unwrap()).collect()
}

async fn chat_view(app: &TestApp, cookie: &str, chat: i64) -> Value {
    let reply = app.get(&format!("/api/ai/chats/{chat}"), Some(cookie)).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    reply.body
}

// ---- 測試 ----

#[tokio::test]
async fn only_logged_in_users_can_chat() {
    let s = setup().await;
    assert_eq!(s.app.get("/api/ai/chats", None).await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(s.app.call("POST", "/api/ai/chats", None, None).await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(s.app.get("/api/ai/usage", None).await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(s.app.get("/api/ai/tools", None).await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(s.app.get("/api/admin/ai/tools", Some(&s.alice)).await.status, StatusCode::FORBIDDEN);
    assert_eq!(s.app.get("/api/admin/ai/usage", Some(&s.alice)).await.status, StatusCode::FORBIDDEN);

    // 別人的對話看不到
    let chat = new_chat(&s.app, &s.admin).await;
    assert_eq!(s.app.get(&format!("/api/ai/chats/{chat}"), Some(&s.alice)).await.status, StatusCode::NOT_FOUND);
    assert_eq!(say(&s.app, &s.alice, chat, "嗨").await.0, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn plain_answer_is_streamed_saved_and_titled() {
    let s = setup().await;
    let chat = new_chat(&s.app, &s.alice).await;
    let (status, events) = say(&s.app, &s.alice, chat, "嗨").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(content(&events), "你好！");
    assert_eq!(find(&events, "reasoning")["text"], "想一下");
    assert_eq!(find(&events, "title")["title"], "測試標題");
    assert_eq!(events.last().unwrap()["type"], "done");

    // 給模型的第一則是系統提示，有今天的日期和工具
    let first = s.fake.requests.lock().unwrap()[0].clone();
    assert_eq!(first["messages"][0]["role"], "system");
    assert!(first["messages"][0]["content"].as_str().unwrap().contains("台灣時間"));
    let tools: Vec<&str> =
        first["tools"].as_array().unwrap().iter().map(|t| t["function"]["name"].as_str().unwrap()).collect();
    assert!(tools.contains(&"calendar_create_event") && tools.contains(&"lunar_convert"), "{tools:?}");

    let view = chat_view(&s.app, &s.alice, chat).await;
    assert_eq!(view["title"], "測試標題");
    let roles: Vec<&str> = view["messages"].as_array().unwrap().iter().map(|m| m["role"].as_str().unwrap()).collect();
    assert_eq!(roles, ["user", "assistant"]);
    assert_eq!(view["messages"][1]["reasoning"], "想一下");

    let list = s.app.get("/api/ai/chats", Some(&s.alice)).await.body;
    assert_eq!(list[0]["id"], chat);
    // 用量：一次對話加一次取標題，只有對話算次數
    let usage = s.app.get("/api/ai/usage", Some(&s.alice)).await.body;
    assert_eq!(usage["today"]["requests"], 1);
    assert_eq!(usage["today"]["tokens"], 220);
}

#[tokio::test]
async fn read_only_tools_run_right_away() {
    let s = setup().await;
    let chat = new_chat(&s.app, &s.alice).await;
    let (_, events) = say(&s.app, &s.alice, chat, "農曆八月十五是哪天").await;
    assert_eq!(types(&events)[..2], ["tool_call", "tool_result"]);
    let call = find(&events, "tool_call");
    assert_eq!(call["name"], "lunar_convert");
    assert_eq!(call["title"], "國曆農曆換算");
    assert_eq!(call["approval"], false);
    // 分兩段送的參數有接起來
    assert_eq!(call["arguments"], r#"{"lunar_year": 2026, "lunar_month": 8, "lunar_day": 15}"#);
    let result = find(&events, "tool_result");
    assert_eq!(result["status"], "done");
    assert!(result["content"].as_str().unwrap().contains("2026-09-25"), "{result}");
    assert!(types(&events).contains(&"step"));
    assert!(content(&events).starts_with("工具說："));

    // 第二次問模型時帶著工具呼叫和結果
    let requests = s.fake.requests.lock().unwrap().clone();
    let second = &requests[1]["messages"];
    let n = second.as_array().unwrap().len();
    assert_eq!(second[n - 2]["tool_calls"][0]["function"]["name"], "lunar_convert");
    assert_eq!(second[n - 1]["role"], "tool");
    assert_eq!(second[n - 1]["tool_call_id"], "call_1");

    let view = chat_view(&s.app, &s.alice, chat).await;
    let rows: Vec<(String, String)> = view["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| (m["role"].as_str().unwrap().into(), m["status"].as_str().unwrap().into()))
        .collect();
    let expected = [("user", "done"), ("assistant", "done"), ("tool", "done"), ("assistant", "done")];
    assert_eq!(rows, expected.map(|(a, b)| (a.to_owned(), b.to_owned())));
    assert_eq!(view["messages"][2]["tool_title"], "國曆農曆換算");
}

async fn my_events(app: &TestApp, cookie: &str) -> Vec<Value> {
    app.get("/api/calendar/events", Some(cookie)).await.body.as_array().unwrap().clone()
}

#[tokio::test]
async fn writing_tools_wait_for_approval() {
    let s = setup().await;
    let chat = new_chat(&s.app, &s.alice).await;
    let (_, events) = say(&s.app, &s.alice, chat, "幫我記下 12/1 看牙醫").await;
    let call = find(&events, "tool_call");
    assert_eq!(call["approval"], true);
    assert_eq!(call["summary"], "新增事項「看牙醫」2026-12-01");
    assert_eq!(find(&events, "approval")["ids"], json!(["call_1"]));
    assert!(!types(&events).contains(&"tool_result"));
    // 還沒確認就不會新增
    assert!(my_events(&s.app, &s.alice).await.is_empty());
    let view = chat_view(&s.app, &s.alice, chat).await;
    assert_eq!(view["pending"], true);
    let pending = view["messages"].as_array().unwrap().iter().find(|m| m["status"] == "pending").unwrap();
    assert_eq!(pending["summary"], "新增事項「看牙醫」2026-12-01");

    // 每個都要決定
    let path = format!("/api/ai/chats/{chat}/approve");
    let (status, _) = stream(&s.app, &path, &s.alice, json!({ "decisions": [] })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    // 別人不能幫忙按
    let (status, _) =
        stream(&s.app, &path, &s.admin, json!({ "decisions": [{ "id": "call_1", "approve": true }] })).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let (status, events) =
        stream(&s.app, &path, &s.alice, json!({ "decisions": [{ "id": "call_1", "approve": true }] })).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(find(&events, "tool_result")["status"], "done");
    assert!(content(&events).contains("已新增"));
    let saved = my_events(&s.app, &s.alice).await;
    assert_eq!(saved.len(), 1);
    assert_eq!(saved[0]["title"], "看牙醫");
    assert_eq!(saved[0]["end_date"], "2026-12-01");
    assert_eq!(chat_view(&s.app, &s.alice, chat).await["pending"], false);

    // 沒有在等的就不能再按
    let (status, _) =
        stream(&s.app, &path, &s.alice, json!({ "decisions": [{ "id": "call_1", "approve": true }] })).await;
    assert_eq!(status, StatusCode::CONFLICT);
    // 確認後接著做不算新的一次
    assert_eq!(s.app.get("/api/ai/usage", Some(&s.alice)).await.body["today"]["requests"], 1);
}

#[tokio::test]
async fn denied_or_ignored_actions_do_not_run() {
    let s = setup().await;
    let chat = new_chat(&s.app, &s.alice).await;
    say(&s.app, &s.alice, chat, "幫我記下 12/1 看牙醫").await;
    let path = format!("/api/ai/chats/{chat}/approve");
    let (_, events) =
        stream(&s.app, &path, &s.alice, json!({ "decisions": [{ "id": "call_1", "approve": false }] })).await;
    assert_eq!(find(&events, "tool_result")["status"], "denied");
    assert!(content(&events).contains("拒絕"));
    assert!(my_events(&s.app, &s.alice).await.is_empty());

    // 有在等的動作卻問了別的事：當作拒絕，對話照樣接得下去
    say(&s.app, &s.alice, chat, "幫我記下 12/1 看牙醫").await;
    let (status, events) = say(&s.app, &s.alice, chat, "算了").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(content(&events), "你好！");
    let view = chat_view(&s.app, &s.alice, chat).await;
    assert_eq!(view["pending"], false);
    assert!(my_events(&s.app, &s.alice).await.is_empty());
    // 給模型的對話裡，每個工具呼叫後面都有結果
    let last = s.fake.requests.lock().unwrap().last().unwrap()["messages"].clone();
    let messages = last.as_array().unwrap();
    for (i, m) in messages.iter().enumerate() {
        if let Some(calls) = m["tool_calls"].as_array() {
            assert_eq!(messages[i + 1]["tool_call_id"], calls[0]["id"], "{last}");
        }
    }
}

#[tokio::test]
async fn daily_limits_and_blocking() {
    let s = setup().await;
    let defaults = json!({ "daily_requests": 1, "daily_tokens": null, "max_running": 4 });
    let reply = s.app.call("PUT", "/api/admin/ai/usage/defaults", Some(&s.admin), Some(defaults)).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);

    let chat = new_chat(&s.app, &s.alice).await;
    assert_eq!(say(&s.app, &s.alice, chat, "嗨").await.0, StatusCode::OK);
    let (status, body) = say(&s.app, &s.alice, chat, "再一次").await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert!(body[0]["error"].as_str().unwrap().contains("1 次"), "{body:?}");
    // 被擋的那次沒有留下訊息
    assert_eq!(chat_view(&s.app, &s.alice, chat).await["messages"].as_array().unwrap().len(), 2);

    // 管理員不受限
    let admin_chat = new_chat(&s.app, &s.admin).await;
    assert_eq!(say(&s.app, &s.admin, admin_chat, "嗨").await.0, StatusCode::OK);
    assert_eq!(say(&s.app, &s.admin, admin_chat, "再一次").await.0, StatusCode::OK);

    // 個別放寬
    let report = s.app.get("/api/admin/ai/usage", Some(&s.admin)).await.body;
    let alice = report["users"].as_array().unwrap().iter().find(|u| u["username"] == "alice").unwrap().clone();
    assert_eq!(alice["today_requests"], 1);
    let id = alice["user_id"].as_i64().unwrap();
    let path = format!("/api/admin/ai/usage/users/{id}");
    let limit = json!({ "daily_requests": 5, "daily_tokens": null, "blocked": false });
    assert_eq!(s.app.call("PUT", &path, Some(&s.admin), Some(limit)).await.status, StatusCode::OK);
    assert_eq!(say(&s.app, &s.alice, chat, "再一次").await.0, StatusCode::OK);

    // 停用
    let limit = json!({ "daily_requests": null, "daily_tokens": null, "blocked": true });
    assert_eq!(s.app.call("PUT", &path, Some(&s.admin), Some(limit)).await.status, StatusCode::OK);
    let (status, body) = say(&s.app, &s.alice, chat, "還可以嗎").await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(body[0]["error"].as_str().unwrap().contains("停用"));
    let usage = s.app.get("/api/ai/usage", Some(&s.alice)).await.body;
    assert_eq!(usage["blocked"], true);

    let report = s.app.get("/api/admin/ai/usage", Some(&s.admin)).await.body;
    assert!(report["daily"][0]["requests"].as_i64().unwrap() >= 3);
    assert!(!report["recent"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn servers_without_tool_calling_still_answer() {
    let s = setup().await;
    s.fake.reject_tools.store(true, Ordering::SeqCst);
    let chat = new_chat(&s.app, &s.alice).await;
    let (status, events) = say(&s.app, &s.alice, chat, "農曆八月十五是哪天").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(content(&events), "你好！");
    // 記下來，之後不再帶 tools，管理頁看得到
    let view = s.app.get("/api/admin/ai/tools", Some(&s.admin)).await.body;
    assert_eq!(view["provider_tools"], false);
    let before = s.fake.requests.lock().unwrap().len();
    say(&s.app, &s.alice, chat, "嗨").await;
    let requests = s.fake.requests.lock().unwrap().clone();
    assert!(requests[before..].iter().all(|r| r.get("tools").is_none()));
    assert_eq!(s.app.get("/api/ai/tools", Some(&s.alice)).await.body["supported"], false);
}

#[tokio::test]
async fn mcp_tools_are_listed_called_and_gated() {
    let s = setup().await;
    let (url, mcp) = fake_mcp_server().await;
    let body = json!({ "name": "示範", "prefix": "demo", "url": url,
                       "headers": [{ "name": "Authorization", "value": MCP_TOKEN }] });
    let reply = s.app.call("POST", "/api/admin/ai/mcp", Some(&s.admin), Some(body)).await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
    let server = &reply.body["servers"][0];
    assert_eq!(server["tool_count"], 2, "{server}");
    assert_eq!(server["last_error"], Value::Null);
    // 金鑰不會傳出去
    assert!(!reply.body.to_string().contains("mcp-secret-token"));
    assert_eq!(server["headers"][0]["hint"], "…oken");
    let tool = |view: &Value, name: &str| {
        view["tools"].as_array().unwrap().iter().find(|t| t["name"] == name).cloned().unwrap()
    };
    // 只讀的預設不用確認，其他的要
    assert_eq!(tool(&reply.body, "demo__echo")["approval"], false);
    assert_eq!(tool(&reply.body, "demo__delete_all")["approval"], true);

    // 沒開放給所有人：一般使用者沒有這些工具，管理員有
    let alice_tools = s.app.get("/api/ai/tools", Some(&s.alice)).await.body.to_string();
    assert!(!alice_tools.contains("demo__echo"));
    let admin_tools = s.app.get("/api/ai/tools", Some(&s.admin)).await.body.to_string();
    assert!(admin_tools.contains("demo__echo"));

    // session 過期也會自己重新連
    mcp.expire.store(true, Ordering::SeqCst);
    let chat = new_chat(&s.app, &s.admin).await;
    let (_, events) = say(&s.app, &s.admin, chat, "回聲測試").await;
    let result = find(&events, "tool_result");
    assert_eq!(result["status"], "done", "{events:?}");
    assert_eq!(result["content"], "echo: 哈囉");
    assert_eq!(mcp.calls.load(Ordering::SeqCst), 1);
    assert_eq!(mcp.initializes.load(Ordering::SeqCst), 2);

    // 開放後一般使用者也有；管理員關掉某個工具後就沒有
    let id = server["id"].as_i64().unwrap();
    let body = json!({ "name": "示範", "prefix": "demo", "url": url, "public": true,
                       "headers": [{ "name": "authorization" }] });
    let reply = s.app.call("PUT", &format!("/api/admin/ai/mcp/{id}"), Some(&s.admin), Some(body)).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert_eq!(reply.body["servers"][0]["last_error"], Value::Null, "沒填值就沿用原本的金鑰");
    assert!(s.app.get("/api/ai/tools", Some(&s.alice)).await.body.to_string().contains("demo__echo"));
    let setting = json!({ "enabled": false, "approval": false });
    let reply = s.app.call("PUT", "/api/admin/ai/tools/demo__echo", Some(&s.admin), Some(setting)).await;
    assert_eq!(tool(&reply.body, "demo__echo")["enabled"], false);
    assert!(!s.app.get("/api/ai/tools", Some(&s.alice)).await.body.to_string().contains("demo__echo"));

    // 刪掉伺服器，工具和設定一起不見
    let reply = s.app.call("DELETE", &format!("/api/admin/ai/mcp/{id}"), Some(&s.admin), None).await;
    assert_eq!(reply.status, StatusCode::OK);
    assert!(!reply.body.to_string().contains("demo__"));
}

#[tokio::test]
async fn wrong_mcp_key_is_reported() {
    let s = setup().await;
    let (url, _) = fake_mcp_server().await;
    let body = json!({ "name": "示範", "prefix": "demo", "url": url, "headers": [] });
    let reply = s.app.call("POST", "/api/admin/ai/mcp", Some(&s.admin), Some(body)).await;
    assert_eq!(reply.status, StatusCode::CREATED);
    let error = reply.body["servers"][0]["last_error"].as_str().unwrap();
    assert!(error.contains("401"), "{error}");
    // 前綴不能重複
    let body = json!({ "name": "又一個", "prefix": "demo", "url": url });
    assert_eq!(s.app.call("POST", "/api/admin/ai/mcp", Some(&s.admin), Some(body)).await.status, StatusCode::CONFLICT);
}

#[tokio::test]
async fn site_features_can_be_searched() {
    let s = setup().await;
    let catalog = json!({ "items": [
        { "kind": "tool", "name": "證件照產生器", "description": "自動去背換底色。", "url": "/tools/id-photo",
          "tags": ["AI"], "category": "圖片" },
        { "kind": "game", "name": "五子棋", "description": "雙人對戰。", "url": "/games/gomoku", "tags": [] },
    ] });
    let path = std::env::temp_dir().join(format!("site-catalog-{}.json", std::process::id()));
    std::fs::write(&path, catalog.to_string()).unwrap();
    // 用同一個資料庫開一個讀這份清單的 app（router 建好後 state 就不能改了）
    let mut state = s.app.state.clone();
    state.site_catalog = path.clone();
    let app = TestApp { router: backend::router(state.clone(), std::path::Path::new("does-not-exist")), state };

    let chat = new_chat(&app, &s.alice).await;
    let (_, events) = say(&app, &s.alice, chat, "有沒有可以做證件照的工具").await;
    assert_eq!(find(&events, "tool_call")["name"], "site_search");
    let result = find(&events, "tool_result");
    assert_eq!(result["status"], "done");
    let content = result["content"].as_str().unwrap();
    assert!(content.contains("/tools/id-photo") && !content.contains("五子棋"), "{content}");
    // 系統提示詞有提到這個工具
    let requests = s.fake.requests.lock().unwrap().clone();
    let request = requests.iter().rev().find(|r| r.get("tools").is_some()).unwrap();
    assert!(request["messages"][0]["content"].as_str().unwrap().contains("site_search"));
    std::fs::remove_file(path).ok();

    // 清單不存在（前端還沒 build）時告訴模型，不會整個失敗
    let mut state = s.app.state.clone();
    state.site_catalog = std::env::temp_dir().join("no-such-site-catalog.json");
    let app = TestApp { router: backend::router(state.clone(), std::path::Path::new("does-not-exist")), state };
    let (_, events) = say(&app, &s.alice, chat, "有沒有可以做證件照的工具").await;
    assert_eq!(find(&events, "tool_result")["status"], "error");
}

#[tokio::test]
async fn calendar_sentence_becomes_a_draft() {
    let s = setup().await;
    let body = json!({ "text": "下週三晚上七點跟阿明吃飯" });
    assert_eq!(
        s.app.call("POST", "/api/ai/calendar/parse", None, Some(body.clone())).await.status,
        StatusCode::UNAUTHORIZED
    );
    let reply = s.app.call("POST", "/api/ai/calendar/parse", Some(&s.alice), Some(body)).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert_eq!(reply.body["title"], "跟阿明吃飯");
    assert_eq!(reply.body["start_date"], "2026-11-11");
    assert_eq!(reply.body["note"], "19:00");
    // 只是草稿，沒有存
    assert!(my_events(&s.app, &s.alice).await.is_empty());
    let request = s.fake.requests.lock().unwrap().last().unwrap().clone();
    assert_eq!(request["response_format"]["type"], "json_schema");
    assert_eq!(request["chat_template_kwargs"]["enable_thinking"], false);
    assert_eq!(s.app.get("/api/ai/usage", Some(&s.alice)).await.body["today"]["requests"], 1);
}

#[tokio::test]
async fn nothing_works_until_ai_is_configured() {
    let app = app().await;
    upsert_admin(&app.state.pool, "admin", PASSWORD.into()).await.unwrap();
    let body = json!({ "username": "admin", "password": PASSWORD });
    let admin = app.call("POST", "/api/auth/login", None, Some(body)).await.cookie.unwrap();
    let chat = new_chat(&app, &admin).await;
    let (status, body) = say(&app, &admin, chat, "嗨").await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body[0]["error"], "AI 功能尚未開放");
    assert!(chat_view(&app, &admin, chat).await["messages"].as_array().unwrap().is_empty());
}
