//! 本站的 MCP 伺服器（mcp_server.rs）：金鑰只有自己看得到、舊版先 initialize、新版每個請求自己帶 `_meta`、
//! MCP 頁面上的測試用登入的身分（只收本站送來的）、瀏覽器打開 /mcp 是前端的頁面。

use std::path::Path;

use axum::{
    body::Body,
    http::{HeaderMap, Request, StatusCode, header},
};
use backend::{auth::upsert_admin, router};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;

use crate::common::{TestApp, app};

const MODERN: &str = "2026-07-28";

async fn login(app: &TestApp, name: &str) -> String {
    upsert_admin(&app.state.pool, name, "password123".into()).await.unwrap();
    let reply =
        app.call("POST", "/api/auth/login", None, Some(json!({ "username": name, "password": "password123" }))).await;
    reply.cookie.unwrap()
}

/// 一般使用者：拿掉 admin 角色（MCP 只要登入，不用特別的權限）
async fn login_user(app: &TestApp, name: &str) -> String {
    let cookie = login(app, name).await;
    sqlx::query("DELETE FROM user_roles WHERE user_id = (SELECT id FROM users WHERE username = ?)")
        .bind(name)
        .execute(&app.state.pool)
        .await
        .unwrap();
    cookie
}

async fn new_key(app: &TestApp, cookie: &str, name: &str) -> String {
    let reply = app.call("POST", "/api/mcp/keys", Some(cookie), Some(json!({ "name": name }))).await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
    reply.body["token"].as_str().unwrap().to_owned()
}

struct Sent {
    status: StatusCode,
    headers: HeaderMap,
    body: Value,
}

async fn send(app: &TestApp, method: &str, path: &str, headers: &[(&str, &str)], body: &str) -> Sent {
    let mut request = Request::builder().method(method).uri(path);
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    let response = app.router.clone().oneshot(request.body(Body::from(body.to_owned())).unwrap()).await.unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    Sent { status, headers, body: serde_json::from_slice(&bytes).unwrap_or(Value::Null) }
}

/// MCP 客戶端送的 POST：JSON，Accept 兩種都要
async fn rpc(app: &TestApp, path: &str, headers: &[(&str, &str)], message: &Value) -> Sent {
    let mut all = vec![("content-type", "application/json"), ("accept", "application/json, text/event-stream")];
    all.extend_from_slice(headers);
    send(app, "POST", path, &all, &message.to_string()).await
}

fn request(id: i64, method: &str, params: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
}

/// 2026-07-28 的請求：params._meta 帶版本和客戶端能力
fn modern(id: i64, method: &str, mut params: Value) -> Value {
    params["_meta"] = json!({
        "io.modelcontextprotocol/protocolVersion": MODERN,
        "io.modelcontextprotocol/clientInfo": { "name": "test", "version": "1.0.0" },
        "io.modelcontextprotocol/clientCapabilities": {},
    });
    request(id, method, params)
}

/// 2026-07-28 的請求還要帶的 header
async fn modern_rpc(app: &TestApp, bearer: &str, message: &Value, extra: &[(&str, &str)]) -> Sent {
    let method = message["method"].as_str().unwrap().to_owned();
    let name = message["params"]["name"].as_str().map(str::to_owned);
    let mut headers = vec![("authorization", bearer), ("mcp-protocol-version", MODERN), ("mcp-method", &method)];
    if let Some(name) = name.as_deref() {
        headers.push(("mcp-name", name));
    }
    headers.extend_from_slice(extra);
    rpc(app, "/mcp", &headers, message).await
}

/// 爬蟲上傳一次：頤宮明天晚上 18:30 有位（router 建好後 state 就不能改了，另外開一個收上傳的）
async fn upload_tomorrow(app: &TestApp) -> (TestApp, String) {
    let mut state = app.state.clone();
    state.michelin_upload_key = Some("upload-key".into());
    let app = TestApp { router: router(state.clone(), Path::new("does-not-exist")), state };
    let tomorrow = (chrono::Utc::now() + chrono::TimeDelta::hours(32)).format("%Y-%m-%d").to_string();
    let mut body = json!({
        "checked_at": chrono::Utc::now().to_rfc3339(),
        "days": [tomorrow],
        "restaurants": [{ "name": "頤宮", "url": "https://inline.app/booking/le-palais",
                          "parties": { "2": { "source": "inline", "days": {} } } }]
    });
    body["restaurants"][0]["parties"]["2"]["days"][&tomorrow] = json!({ "status": "open", "times": ["18:30"] });
    let request = Request::put("/api/michelin/availability")
        .header(header::CONTENT_TYPE, "application/json")
        .header("x-michelin-key", "upload-key")
        .body(Body::from(body.to_string()))
        .unwrap();
    assert_eq!(app.router.clone().oneshot(request).await.unwrap().status(), StatusCode::NO_CONTENT);
    (app, tomorrow)
}

#[tokio::test]
async fn keys_belong_to_their_owner() {
    let app = app().await;
    assert_eq!(app.get("/api/mcp/keys", None).await.status, StatusCode::UNAUTHORIZED);
    let alice = login_user(&app, "alice").await;
    let bob = login_user(&app, "bob").await;

    let reply = app.call("POST", "/api/mcp/keys", Some(&alice), Some(json!({ "name": "  小明的 Claude " }))).await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
    let token = reply.body["token"].as_str().unwrap().to_owned();
    assert!(token.starts_with("oym_") && token.len() == 52, "{token}");
    assert_eq!(
        (reply.body["name"].clone(), reply.body["prefix"].clone()),
        (json!("小明的 Claude"), json!(&token[..12]))
    );
    let id = reply.body["id"].as_i64().unwrap();

    // 列表上沒有金鑰本身，只有開頭
    let keys = app.get("/api/mcp/keys", Some(&alice)).await.body;
    assert_eq!(keys.as_array().unwrap().len(), 1, "{keys}");
    assert!(keys[0].get("token").is_none() && keys[0].get("token_hash").is_none(), "{keys}");
    assert_eq!(keys[0]["last_used_at"], Value::Null);
    assert_eq!(app.get("/api/mcp/keys", Some(&bob)).await.body, json!([]));

    for name in ["", "   ", &"字".repeat(41)] {
        let reply = app.call("POST", "/api/mcp/keys", Some(&alice), Some(json!({ "name": name }))).await;
        assert_eq!(reply.status, StatusCode::BAD_REQUEST, "{name}: {}", reply.body);
    }

    // 用過之後記下時間
    let bearer = format!("Bearer {token}");
    let sent = rpc(&app, "/mcp", &[("authorization", &bearer)], &request(1, "ping", json!({}))).await;
    assert_eq!(sent.status, StatusCode::OK, "{}", sent.body);
    assert!(app.get("/api/mcp/keys", Some(&alice)).await.body[0]["last_used_at"].is_string());

    // 別人刪不掉；自己刪掉之後馬上不能用
    assert_eq!(
        app.call("DELETE", &format!("/api/mcp/keys/{id}"), Some(&bob), None).await.status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        app.call("DELETE", &format!("/api/mcp/keys/{id}"), Some(&alice), None).await.status,
        StatusCode::NO_CONTENT
    );
    let sent = rpc(&app, "/mcp", &[("authorization", &bearer)], &request(2, "ping", json!({}))).await;
    assert_eq!(sent.status, StatusCode::UNAUTHORIZED, "{}", sent.body);

    // 帳號停用：金鑰跟著失效
    let token = new_key(&app, &alice, "Cursor").await;
    sqlx::query("UPDATE users SET disabled = 1 WHERE username = 'alice'").execute(&app.state.pool).await.unwrap();
    let sent =
        rpc(&app, "/mcp", &[("authorization", &format!("Bearer {token}"))], &request(3, "ping", json!({}))).await;
    assert_eq!(sent.status, StatusCode::UNAUTHORIZED, "{}", sent.body);
}

#[tokio::test]
async fn needs_a_key() {
    let app = app().await;
    let ping = request(1, "ping", json!({}));
    let sent = rpc(&app, "/mcp", &[], &ping).await;
    assert_eq!(sent.status, StatusCode::UNAUTHORIZED);
    assert_eq!(sent.headers["www-authenticate"], r#"Bearer realm="ouyang.app""#);
    assert!(sent.body["error_description"].as_str().unwrap().contains("/mcp 建立"), "{}", sent.body);

    for headers in [[("authorization", "Bearer oym_nope")], [("authorization", "Basic dXNlcjpwYXNz")]] {
        let sent = rpc(&app, "/mcp", &headers, &ping).await;
        assert_eq!(sent.status, StatusCode::UNAUTHORIZED, "{}", sent.body);
        assert_eq!(sent.headers["www-authenticate"], r#"Bearer realm="ouyang.app", error="invalid_token""#);
        assert_eq!(sent.body["error"], "invalid_token");
    }
    assert_eq!(rpc(&app, "/mcp?key=oym_nope", &[], &ping).await.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn legacy_clients_initialize_first() {
    let app = app().await;
    let alice = login_user(&app, "alice").await;
    let token = new_key(&app, &alice, "Claude Desktop").await;
    let bearer = format!("Bearer {token}");
    let auth = [("authorization", bearer.as_str())];

    let init = |version: &str| {
        request(
            1,
            "initialize",
            json!({ "protocolVersion": version, "capabilities": {}, "clientInfo": { "name": "test", "version": "1" } }),
        )
    };
    let sent = rpc(&app, "/mcp", &auth, &init("2025-06-18")).await;
    assert_eq!(sent.status, StatusCode::OK, "{}", sent.body);
    let result = &sent.body["result"];
    assert_eq!(result["protocolVersion"], "2025-06-18");
    assert_eq!(result["serverInfo"]["name"], "ouyang.app");
    assert_eq!(result["capabilities"]["tools"], json!({ "listChanged": false }));
    assert!(result["instructions"].as_str().unwrap().contains("michelin_availability"), "{result}");
    // 沒有 session
    assert!(sent.headers.get("mcp-session-id").is_none());
    // 不認得的版本：回這裡最新的舊版
    let sent = rpc(&app, "/mcp", &auth, &init("2024-01-01")).await;
    assert_eq!(sent.body["result"]["protocolVersion"], "2025-11-25");

    // 通知沒有回應
    let initialized = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
    let sent = rpc(&app, "/mcp", &auth, &initialized).await;
    assert_eq!((sent.status, sent.body.clone()), (StatusCode::ACCEPTED, Value::Null));

    let headers = [auth[0], ("mcp-protocol-version", "2025-06-18")];
    let sent = rpc(&app, "/mcp", &headers, &request(2, "tools/list", json!({}))).await;
    let tools = sent.body["result"]["tools"].as_array().unwrap().clone();
    let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["michelin_availability"]);
    assert_eq!(tools[0]["inputSchema"]["type"], "object");
    assert_eq!(tools[0]["inputSchema"]["properties"]["date"]["format"], "date");
    assert_eq!(tools[0]["annotations"]["readOnlyHint"], true);
    // 舊版的結果沒有新版才有的欄位
    assert!(sent.body["result"].get("resultType").is_none(), "{}", sent.body);

    assert_eq!(rpc(&app, "/mcp", &headers, &request(3, "ping", json!({}))).await.body["result"], json!({}));

    // 還沒上傳過空位：工具自己說，不算錯
    let call = request(4, "tools/call", json!({ "name": "michelin_availability", "arguments": { "meal": "dinner" } }));
    let result = rpc(&app, "/mcp", &headers, &call).await.body["result"].clone();
    assert_eq!(result["isError"], false, "{result}");
    assert!(result["content"][0]["text"].as_str().unwrap().contains("還沒有空位資料"), "{result}");

    // 參數不對：放在結果裡讓模型改；找不到工具、沒有這個方法是協定錯誤
    let call = request(5, "tools/call", json!({ "name": "michelin_availability", "arguments": { "date": "明天" } }));
    let result = rpc(&app, "/mcp", &headers, &call).await.body["result"].clone();
    assert_eq!(result["isError"], true, "{result}");
    assert!(result["content"][0]["text"].as_str().unwrap().contains("YYYY-MM-DD"), "{result}");
    let call = request(6, "tools/call", json!({ "name": "calendar_create", "arguments": {} }));
    let sent = rpc(&app, "/mcp", &headers, &call).await;
    assert_eq!((sent.status, sent.body["error"]["code"].clone()), (StatusCode::OK, json!(-32602)), "{}", sent.body);
    assert_eq!(sent.body["id"], 6);
    let sent = rpc(&app, "/mcp", &headers, &request(7, "resources/list", json!({}))).await;
    assert_eq!((sent.status, sent.body["error"]["code"].clone()), (StatusCode::OK, json!(-32601)), "{}", sent.body);

    // 不支援的版本：列出支援的
    let headers = [auth[0], ("mcp-protocol-version", "2099-01-01")];
    let sent = rpc(&app, "/mcp", &headers, &request(8, "tools/list", json!({}))).await;
    assert_eq!(sent.status, StatusCode::BAD_REQUEST, "{}", sent.body);
    assert_eq!(sent.body["error"]["code"], -32022);
    assert_eq!(sent.body["error"]["data"]["supported"][0], MODERN);

    // 沒帶版本、也沒 initialize（例如用 curl）：照樣回；金鑰也可以放在網址
    let sent = rpc(&app, &format!("/mcp?key={token}"), &[], &request(9, "tools/list", json!({}))).await;
    assert_eq!(sent.status, StatusCode::OK, "{}", sent.body);
    assert_eq!(sent.body["result"]["tools"][0]["name"], "michelin_availability");
}

#[tokio::test]
async fn modern_clients_send_meta_on_every_request() {
    let app = app().await;
    let alice = login_user(&app, "alice").await;
    let token = new_key(&app, &alice, "Claude Code").await;
    let bearer = format!("Bearer {token}");

    let sent = modern_rpc(&app, &bearer, &modern(1, "server/discover", json!({})), &[]).await;
    assert_eq!(sent.status, StatusCode::OK, "{}", sent.body);
    let result = &sent.body["result"];
    assert_eq!(result["resultType"], "complete");
    assert_eq!(result["supportedVersions"][0], MODERN);
    assert!(result["supportedVersions"].as_array().unwrap().contains(&json!("2025-11-25")));
    assert_eq!(result["capabilities"], json!({ "tools": {} }));
    assert_eq!((result["ttlMs"].clone(), result["cacheScope"].clone()), (json!(3_600_000), json!("public")));
    assert_eq!(result["_meta"]["io.modelcontextprotocol/serverInfo"]["name"], "ouyang.app");

    let sent = modern_rpc(&app, &bearer, &modern(2, "tools/list", json!({})), &[]).await;
    let result = &sent.body["result"];
    assert_eq!(result["tools"][0]["name"], "michelin_availability", "{result}");
    assert_eq!((result["resultType"].clone(), result["cacheScope"].clone()), (json!("complete"), json!("public")));

    // 工具結果裡的站內連結改成完整網址
    let (app, tomorrow) = upload_tomorrow(&app).await;
    let call =
        modern(3, "tools/call", json!({ "name": "michelin_availability", "arguments": { "restaurant": "頤宮" } }));
    let proxied = [("host", "ouyang.app"), ("x-forwarded-proto", "https")];
    let sent = modern_rpc(&app, &bearer, &call, &proxied).await;
    assert_eq!(sent.status, StatusCode::OK, "{}", sent.body);
    let result = &sent.body["result"];
    assert_eq!((result["resultType"].clone(), result["isError"].clone()), (json!("complete"), json!(false)));
    let out: Value = serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(out["page"], "https://ouyang.app/michelin/availability");
    let palais = &out["restaurants"][0];
    assert_eq!(palais["times"][&tomorrow], "18:30", "{out}");
    assert_eq!(palais["booking"], "https://inline.app/booking/le-palais");
    assert!(palais["map_link"].as_str().unwrap().starts_with("https://ouyang.app/michelin?r="), "{out}");

    // 不是 ASCII 的工具名稱用 base64 放在 Mcp-Name（找不到這個工具，但 header 對得上）
    let call = modern(4, "tools/call", json!({ "name": "查空位", "arguments": {} }));
    let encoded = format!("=?base64?{}?=", base64_of("查空位"));
    let headers = [("authorization", bearer.as_str()), ("mcp-protocol-version", MODERN), ("mcp-method", "tools/call")];
    let sent = rpc(&app, "/mcp", &[headers[0], headers[1], headers[2], ("mcp-name", &encoded)], &call).await;
    assert_eq!(sent.body["error"]["code"], -32602, "{}", sent.body);
    assert!(sent.body["error"]["message"].as_str().unwrap().contains("Unknown tool"), "{}", sent.body);

    // header 要跟 body 一致
    let list = modern(5, "tools/list", json!({}));
    let call = modern(6, "tools/call", json!({ "name": "michelin_availability", "arguments": {} }));
    for (message, headers) in [
        (&list, vec![headers[0], headers[1], ("mcp-method", "tools/call")]),
        (&list, vec![headers[0], ("mcp-protocol-version", "2025-11-25"), ("mcp-method", "tools/list")]),
        (&list, vec![headers[0], ("mcp-method", "tools/list")]),
        (&call, vec![headers[0], headers[1], headers[2]]),
        (&call, vec![headers[0], headers[1], headers[2], ("mcp-name", "other_tool")]),
    ] {
        let sent = rpc(&app, "/mcp", &headers, message).await;
        assert_eq!(sent.status, StatusCode::BAD_REQUEST, "{headers:?}: {}", sent.body);
        assert_eq!(sent.body["error"]["code"], -32020, "{headers:?}: {}", sent.body);
    }

    // 少了客戶端能力、不支援的版本、沒有這個方法
    let mut missing = modern(7, "tools/list", json!({}));
    missing["params"]["_meta"].as_object_mut().unwrap().remove("io.modelcontextprotocol/clientCapabilities");
    let sent = modern_rpc(&app, &bearer, &missing, &[]).await;
    assert_eq!((sent.status, sent.body["error"]["code"].clone()), (StatusCode::BAD_REQUEST, json!(-32602)));

    let mut future = modern(8, "tools/list", json!({}));
    future["params"]["_meta"]["io.modelcontextprotocol/protocolVersion"] = json!("2027-01-01");
    let headers =
        [("authorization", bearer.as_str()), ("mcp-protocol-version", "2027-01-01"), ("mcp-method", "tools/list")];
    let sent = rpc(&app, "/mcp", &headers, &future).await;
    assert_eq!(sent.status, StatusCode::BAD_REQUEST, "{}", sent.body);
    assert_eq!(sent.body["error"]["code"], -32022);
    assert_eq!(sent.body["error"]["data"]["requested"], "2027-01-01");
    assert_eq!(sent.body["error"]["data"]["supported"][0], MODERN);

    let sent = modern_rpc(&app, &bearer, &modern(9, "prompts/list", json!({})), &[]).await;
    assert_eq!((sent.status, sent.body["error"]["code"].clone()), (StatusCode::NOT_FOUND, json!(-32601)));

    // 新版的 header 卻沒有 _meta：不完整的請求
    let headers = [("authorization", bearer.as_str()), ("mcp-protocol-version", MODERN), ("mcp-method", "tools/list")];
    let sent = rpc(&app, "/mcp", &headers, &request(10, "tools/list", json!({}))).await;
    assert_eq!((sent.status, sent.body["error"]["code"].clone()), (StatusCode::BAD_REQUEST, json!(-32602)));
}

fn base64_of(text: &str) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(text)
}

#[tokio::test]
async fn the_page_tests_with_the_login_session() {
    let app = app().await;
    let alice = login_user(&app, "alice").await;
    let cookie = [("cookie", alice.as_str()), ("host", "ouyang.app")];
    let list = request(1, "tools/list", json!({}));

    // 本站頁面送來的（Origin 是自己）、沒帶 Origin 的：用登入的身分
    let same = [cookie[0], cookie[1], ("origin", "https://ouyang.app")];
    assert_eq!(rpc(&app, "/mcp", &same, &list).await.status, StatusCode::OK);
    assert_eq!(rpc(&app, "/mcp", &cookie, &list).await.status, StatusCode::OK);
    // 別的網站：不能借用登入的身分
    let other = [cookie[0], cookie[1], ("origin", "https://evil.example")];
    let sent = rpc(&app, "/mcp", &other, &list).await;
    assert_eq!(sent.status, StatusCode::FORBIDDEN, "{}", sent.body);
    // 有帶金鑰就只看金鑰，錯了不改用登入的身分
    let wrong = [cookie[0], cookie[1], ("authorization", "Bearer oym_nope")];
    assert_eq!(rpc(&app, "/mcp", &wrong, &list).await.status, StatusCode::UNAUTHORIZED);

    // 一分鐘最多 30 次工具呼叫
    let call = request(2, "tools/call", json!({ "name": "michelin_availability", "arguments": {} }));
    for _ in 0..30 {
        assert_eq!(rpc(&app, "/mcp", &cookie, &call).await.body["result"]["isError"], false);
    }
    let result = rpc(&app, "/mcp", &cookie, &call).await.body["result"].clone();
    assert_eq!(result["isError"], true, "{result}");
    assert!(result["content"][0]["text"].as_str().unwrap().contains("每分鐘最多 30 次"), "{result}");
    // 金鑰各算各的
    let token = new_key(&app, &alice, "Cursor").await;
    let sent = rpc(&app, "/mcp", &[("authorization", &format!("Bearer {token}"))], &call).await;
    assert_eq!(sent.body["result"]["isError"], false, "{}", sent.body);
}

#[tokio::test]
async fn http_details() {
    // 前端的 index.html：瀏覽器打開 /mcp 看到的是 MCP 頁面
    let dir = std::env::temp_dir().join(format!("mcp-static-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("index.html"), "<!doctype html><title>ouyang.app</title>").unwrap();
    let state = app().await.state;
    let app = TestApp { router: router(state.clone(), &dir), state };

    let page = send(&app, "GET", "/mcp", &[("accept", "text/html,application/xhtml+xml")], "").await;
    assert_eq!(page.status, StatusCode::OK);
    assert_eq!(page.headers[header::CONTENT_TYPE], "text/html");
    // MCP 客戶端要 SSE、結束 session：都沒有
    for (method, accept) in [("GET", "text/event-stream"), ("DELETE", "application/json")] {
        let sent = send(&app, method, "/mcp", &[("accept", accept)], "").await;
        assert_eq!(sent.status, StatusCode::METHOD_NOT_ALLOWED, "{method}");
        assert_eq!(sent.headers[header::ALLOW], "POST, OPTIONS");
    }

    // 瀏覽器跨網站呼叫（帶金鑰）先問 preflight
    let preflight = [
        ("origin", "https://inspector.example"),
        ("access-control-request-method", "POST"),
        ("access-control-request-headers", "authorization, content-type, mcp-protocol-version"),
    ];
    let sent = send(&app, "OPTIONS", "/mcp", &preflight, "").await;
    assert_eq!(sent.status, StatusCode::NO_CONTENT);
    assert_eq!(sent.headers[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*");
    assert_eq!(sent.headers[header::ACCESS_CONTROL_ALLOW_HEADERS], "authorization, content-type, mcp-protocol-version");

    let alice = login(&app, "alice").await;
    let token = new_key(&app, &alice, "Inspector").await;
    let bearer = format!("Bearer {token}");
    let auth = [("authorization", bearer.as_str())];
    // 不是 JSON、壞掉的 JSON、一次送一整批
    let sent = send(&app, "POST", "/mcp", &[auth[0], ("content-type", "text/plain")], "{}").await;
    assert_eq!(sent.status, StatusCode::UNSUPPORTED_MEDIA_TYPE);
    let sent = send(&app, "POST", "/mcp", &[auth[0], ("content-type", "application/json")], "{").await;
    assert_eq!((sent.status, sent.body["error"]["code"].clone()), (StatusCode::BAD_REQUEST, json!(-32700)));
    assert!(sent.body.get("id").is_none(), "{}", sent.body);
    let batch = json!([request(1, "ping", json!({})), request(2, "ping", json!({}))]);
    let sent = rpc(&app, "/mcp", &auth, &batch).await;
    assert_eq!((sent.status, sent.body["error"]["code"].clone()), (StatusCode::BAD_REQUEST, json!(-32600)));
    // 網址最後多一個斜線也是 MCP
    let sent =
        rpc(&app, "/mcp/", &[auth[0], ("origin", "https://inspector.example")], &request(3, "ping", json!({}))).await;
    assert_eq!(sent.status, StatusCode::OK, "{}", sent.body);
    assert_eq!(sent.headers[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*");

    // IP 訪問紀錄不記網址裡的金鑰
    let ping = request(4, "ping", json!({}));
    rpc(&app, &format!("/mcp?x=1&key={token}"), &[("x-forwarded-for", "203.0.113.9")], &ping).await;
    app.state.access_log.flush(&app.state.pool).await.unwrap();
    let requests = app.get("/api/admin/access/requests?ip=203.0.113.9", Some(&alice)).await.body;
    assert_eq!(requests[0]["path"], "/mcp", "{requests}");
    assert_eq!(requests[0]["query"], "x=1&key=…", "{requests}");
    std::fs::remove_dir_all(&dir).ok();
}
