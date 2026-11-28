//! 本站的 MCP 伺服器（`/mcp`）：讓別人的 AI（Claude、ChatGPT、Cursor…）透過 MCP 查本站的資料，目前只有米其林空位。
//! 反方向（AI 助手去連別人的 MCP 伺服器）見 mcp.rs。
//!
//! - Streamable HTTP，只收 POST：一個請求回一個 JSON，不開 SSE、不發 session（`Mcp-Session-Id`）。
//!   瀏覽器打開 /mcp 是 GET，給前端的 MCP 頁面（index.html）；要 SSE 的 GET 和 DELETE 回 405。
//! - 新舊兩代的客戶端都接：2026-07-28 起沒有 initialize，每個請求在 `params._meta` 帶協定版本，
//!   而且 `MCP-Protocol-Version`、`Mcp-Method`、`Mcp-Name` 這幾個 header 要跟 body 一致；更早的版本先 initialize。
//!   `_meta` 有沒有 `io.modelcontextprotocol/protocolVersion` 就是分辨的方法。
//! - 誰在查：`Authorization: Bearer <金鑰>`；不能加 header 的客戶端（claude.ai、ChatGPT 的自訂連接器）把金鑰放在
//!   網址的 `?key=`（IP 訪問紀錄不記它的值，見 access_log.rs）。MCP 頁面上的測試沒有金鑰，用登入的 session，
//!   但只收本站頁面送來的（Origin 是自己），別的網站沒辦法借用使用者的身分。
//! - 金鑰是每個人在 MCP 頁面自己建立的，只存雜湊，原文只在建立時顯示一次。
//! - 工具就是 AI 助手的內建工具（ai_builtin.rs），以金鑰主人的身分執行；只開放不會改資料的。

use std::{
    collections::HashMap,
    fmt::Write as _,
    sync::Mutex,
    time::{Duration, Instant},
};

use axum::{
    Json,
    body::Bytes,
    extract::{Path, RawQuery, Request, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tower::ServiceExt;
use tower_http::services::ServeFile;

use crate::{
    AppError, AppState,
    ai_builtin::{self, Builtin},
    auth::{self, CurrentUser, token_hash},
};

/// 2026-07-28 起：每個請求自己帶版本，沒有 initialize
const MODERN_VERSIONS: &[&str] = &["2026-07-28"];
/// 先 initialize 的版本，新的在前；客戶端要的版本不在這裡就回第一個
const LEGACY_VERSIONS: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

/// 開放給 MCP 的工具：都是只讀的（MCP 這邊沒有 AI 助手那種「按允許才做」的確認）
const TOOLS: &[Builtin] = &[Builtin::MichelinAvailability];

/// 給 AI 的使用說明：舊版在 initialize、新版在 server/discover 的結果裡
const INSTRUCTIONS: &str = "ouyang.app 的米其林空位：使用者問台灣米其林星級餐廳哪天、幾點還能訂位時，用 michelin_availability 查\
                            （只有星級餐廳；人數查了 2、4、6 位；時間都是台灣時間）。回答時說資料是幾點查的（checked_at）、\
                            附上訂位連結（booking），提醒以訂位頁為準；這裡只能查，不能幫忙訂位。";

/// tools/list、server/discover 的結果可以快取多久：工具只會隨著換版改變
const LIST_TTL_MS: u64 = 60 * 60 * 1000;

/// 一把金鑰（沒有金鑰的是每個人）一分鐘最多呼叫幾次工具
const CALLS_PER_MINUTE: u32 = 30;
const MINUTE: Duration = Duration::from_secs(60);

const MAX_KEYS: i64 = 20;
const MAX_NAME_CHARS: usize = 40;
const KEY_PREFIX: &str = "oym_";
/// 列表上顯示金鑰的前幾個字（oym_ 加 8 個字）
const SHOWN_PREFIX: usize = 12;

const META_VERSION: &str = "io.modelcontextprotocol/protocolVersion";
const META_CAPABILITIES: &str = "io.modelcontextprotocol/clientCapabilities";
const META_SERVER_INFO: &str = "io.modelcontextprotocol/serverInfo";

// JSON-RPC 和 MCP 的錯誤碼
const PARSE_ERROR: i64 = -32700;
const INVALID_REQUEST: i64 = -32600;
const METHOD_NOT_FOUND: i64 = -32601;
const INVALID_PARAMS: i64 = -32602;
const HEADER_MISMATCH: i64 = -32020;
const UNSUPPORTED_VERSION: i64 = -32022;

/// 每把金鑰一分鐘內呼叫了幾次工具；只在記憶體裡，重啟會歸零
#[derive(Default)]
pub struct McpServer {
    calls: Mutex<HashMap<String, (u32, Instant)>>,
}

impl McpServer {
    fn allow_call(&self, caller: &str) -> bool {
        let mut calls = self.calls.lock().unwrap();
        if calls.len() > 10_000 {
            calls.retain(|_, (_, since)| since.elapsed() < MINUTE);
        }
        let entry = calls.entry(caller.to_owned()).or_insert((0, Instant::now()));
        if entry.1.elapsed() >= MINUTE {
            *entry = (0, Instant::now());
        }
        entry.0 += 1;
        entry.0 <= CALLS_PER_MINUTE
    }
}

/// 誰在呼叫：金鑰的主人，或是在 MCP 頁面上測試的人
struct Caller {
    user: CurrentUser,
    /// 用哪把金鑰；MCP 頁面上的測試是登入的 session，沒有金鑰
    key: Option<i64>,
}

impl Caller {
    /// 限制次數用：每把金鑰各算各的，頁面上的測試算在那個人身上
    fn limit_key(&self) -> String {
        match self.key {
            Some(id) => format!("key{id}"),
            None => format!("user{}", self.user.id),
        }
    }
}

// ---- /mcp ----

/// POST /mcp：一個 JSON-RPC 請求或通知
pub async fn post(
    State(state): State<AppState>,
    RawQuery(query): RawQuery,
    session: Option<CurrentUser>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let origin = site_origin(&headers, state.cookie_secure);
    if !is_json(&headers) {
        return error(StatusCode::UNSUPPORTED_MEDIA_TYPE, None, INVALID_REQUEST, "Content-Type 要是 application/json")
            .into_response();
    }
    let caller = match authenticate(&state, &headers, query.as_deref(), session, origin.as_deref()).await {
        Ok(caller) => caller,
        Err(response) => return response,
    };
    let Ok(message) = serde_json::from_slice::<Value>(&body) else {
        return error(StatusCode::BAD_REQUEST, None, PARSE_ERROR, "Parse error：body 不是 JSON").into_response();
    };
    let Some(object) = message.as_object() else {
        let text = if message.is_array() {
            "不支援批次（JSON-RPC batch），一次送一個請求"
        } else {
            "要是 JSON-RPC 物件"
        };
        return error(StatusCode::BAD_REQUEST, None, INVALID_REQUEST, text).into_response();
    };
    let Some(method) = object.get("method").and_then(Value::as_str) else {
        // 客戶端的回應：這裡不會發請求給客戶端，收下就好
        return with_cors(StatusCode::ACCEPTED.into_response());
    };
    let id = match object.get("id") {
        // 通知（notifications/initialized、notifications/cancelled…）：沒有要做的事
        None => return with_cors(StatusCode::ACCEPTED.into_response()),
        Some(id) if id.is_string() || id.is_number() => id,
        Some(_) => return error(StatusCode::BAD_REQUEST, None, INVALID_REQUEST, "id 要是字串或數字").into_response(),
    };
    let params = object.get("params").cloned().unwrap_or_else(|| json!({}));
    if !params.is_object() {
        return error(StatusCode::BAD_REQUEST, Some(id), INVALID_REQUEST, "params 要是物件").into_response();
    }
    let request = Rpc { state: &state, caller: &caller, headers: &headers, origin: origin.as_deref(), id, method };
    let reply = match params["_meta"][META_VERSION].as_str() {
        Some(version) if method != "initialize" => request.modern(&params, version).await,
        _ => request.legacy(&params).await,
    };
    reply.into_response()
}

/// GET /mcp：瀏覽器打開的是前端的 MCP 頁面；MCP 客戶端要的 SSE 這裡沒有（沒有伺服器主動送的訊息），回 405
pub async fn get(index: ServeFile, request: Request) -> Response {
    let wants_stream = request
        .headers()
        .get(header::ACCEPT)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|accept| accept.contains("text/event-stream"));
    if wants_stream {
        return not_allowed().await;
    }
    match index.oneshot(request).await {
        Ok(response) => response.into_response(),
        Err(never) => match never {},
    }
}

/// DELETE（舊版結束 session 用）：這裡沒有 session
pub async fn not_allowed() -> Response {
    with_cors((StatusCode::METHOD_NOT_ALLOWED, [(header::ALLOW, "POST, OPTIONS")]).into_response())
}

/// 瀏覽器跨網站呼叫前的 preflight：要帶金鑰才查得到，不收 cookie，所以誰都可以來
pub async fn preflight(headers: HeaderMap) -> Response {
    let allow_headers = headers.get(header::ACCESS_CONTROL_REQUEST_HEADERS).cloned().unwrap_or_else(|| {
        HeaderValue::from_static("authorization, content-type, accept, mcp-protocol-version, mcp-method, mcp-name")
    });
    let mut response = with_cors(StatusCode::NO_CONTENT.into_response());
    let response_headers = response.headers_mut();
    response_headers.insert(header::ACCESS_CONTROL_ALLOW_METHODS, HeaderValue::from_static("POST, OPTIONS"));
    response_headers.insert(header::ACCESS_CONTROL_ALLOW_HEADERS, allow_headers);
    response_headers.insert(header::ACCESS_CONTROL_MAX_AGE, HeaderValue::from_static("86400"));
    response
}

/// 一個請求：誰、從哪個網址來、id 和方法
struct Rpc<'a> {
    state: &'a AppState,
    caller: &'a Caller,
    headers: &'a HeaderMap,
    /// 本站的網址（https://ouyang.app），把工具結果裡的站內連結改成完整網址
    origin: Option<&'a str>,
    id: &'a Value,
    method: &'a str,
}

impl Rpc<'_> {
    /// 2026-07-28 起的請求：不看之前的請求，版本和客戶端能力都在這個請求的 `_meta` 裡
    async fn modern(&self, params: &Value, version: &str) -> Reply {
        let id = self.id;
        if !MODERN_VERSIONS.contains(&version) {
            return unsupported_version(id, version);
        }
        if let Err(message) = check_headers(self.headers, self.method, params, version) {
            return error(StatusCode::BAD_REQUEST, Some(id), HEADER_MISMATCH, message);
        }
        if !params["_meta"][META_CAPABILITIES].is_object() {
            let message = format!("params._meta 少了 {META_CAPABILITIES}");
            return error(StatusCode::BAD_REQUEST, Some(id), INVALID_PARAMS, message);
        }
        let mut out = match self.method {
            "server/discover" => json!({
                "supportedVersions": supported_versions(),
                "capabilities": { "tools": {} },
                "instructions": INSTRUCTIONS,
                "ttlMs": LIST_TTL_MS,
                "cacheScope": "public",
            }),
            "tools/list" => json!({ "tools": tool_definitions(), "ttlMs": LIST_TTL_MS, "cacheScope": "public" }),
            "tools/call" => match self.call_tool(params).await {
                Ok(out) => out,
                Err((code, message)) => return error(StatusCode::OK, Some(id), code, message),
            },
            method => {
                return error(StatusCode::NOT_FOUND, Some(id), METHOD_NOT_FOUND, format!("Method not found: {method}"));
            }
        };
        out["resultType"] = json!("complete");
        out["_meta"] = json!({ META_SERVER_INFO: server_info(self.state) });
        result(id, out)
    }

    /// 先 initialize 的版本（2025-11-25 以前）。這裡不記 session，initialize 之前就呼叫工具也照樣回（例如用 curl）
    async fn legacy(&self, params: &Value) -> Reply {
        let id = self.id;
        if self.method != "initialize" {
            // 2025-06-18 起 initialize 之後的請求都帶 MCP-Protocol-Version；沒帶是更早的版本
            match self.headers.get("mcp-protocol-version").and_then(|v| v.to_str().ok()) {
                None => {}
                Some(version) if LEGACY_VERSIONS.contains(&version) => {}
                Some(version) if MODERN_VERSIONS.contains(&version) => {
                    let message = format!("{version} 的請求要在 params._meta 帶 {META_VERSION}");
                    return error(StatusCode::BAD_REQUEST, Some(id), INVALID_PARAMS, message);
                }
                Some(version) => return unsupported_version(id, version),
            }
        }
        let out = match self.method {
            "initialize" => {
                let asked = params["protocolVersion"].as_str().unwrap_or_default();
                let version = LEGACY_VERSIONS.iter().find(|v| **v == asked).unwrap_or(&LEGACY_VERSIONS[0]);
                json!({
                    "protocolVersion": version,
                    "capabilities": { "tools": { "listChanged": false } },
                    "serverInfo": server_info(self.state),
                    "instructions": INSTRUCTIONS,
                })
            }
            "ping" => json!({}),
            "tools/list" => json!({ "tools": tool_definitions() }),
            "tools/call" => match self.call_tool(params).await {
                Ok(out) => out,
                Err((code, message)) => return error(StatusCode::OK, Some(id), code, message),
            },
            "server/discover" => {
                let message = format!("server/discover 要在 params._meta 帶 {META_VERSION}");
                return error(StatusCode::BAD_REQUEST, Some(id), INVALID_PARAMS, message);
            }
            method => return error(StatusCode::OK, Some(id), METHOD_NOT_FOUND, format!("Method not found: {method}")),
        };
        result(id, out)
    }

    /// tools/call。找不到工具、參數不是物件是協定錯誤；工具自己說的錯（參數不對、查不到）放在結果裡（isError），
    /// 模型看得到，可以改了再試
    async fn call_tool(&self, params: &Value) -> Result<Value, (i64, String)> {
        let name = params["name"].as_str().ok_or((INVALID_PARAMS, "params.name 要是工具名稱".to_owned()))?;
        let kind = TOOLS
            .iter()
            .copied()
            .find(|&kind| ai_builtin::spec(kind).name == name)
            .ok_or_else(|| (INVALID_PARAMS, format!("Unknown tool: {name}")))?;
        let args = match &params["arguments"] {
            Value::Null => json!({}),
            args @ Value::Object(_) => args.clone(),
            _ => return Err((INVALID_PARAMS, "params.arguments 要是物件".to_owned())),
        };
        if !self.state.mcp_server.allow_call(&self.caller.limit_key()) {
            return Ok(tool_result(format!("查太多次了：每分鐘最多 {CALLS_PER_MINUTE} 次，等一下再試"), true));
        }
        Ok(match ai_builtin::run(self.state, &self.caller.user, kind, &args).await {
            Ok(text) => tool_result(absolute_links(text, self.origin), false),
            Err(text) => tool_result(text, true),
        })
    }
}

/// 一個 JSON-RPC 回應和它的 HTTP 狀態
struct Reply {
    status: StatusCode,
    body: Value,
}

impl IntoResponse for Reply {
    fn into_response(self) -> Response {
        with_cors((self.status, Json(self.body)).into_response())
    }
}

fn result(id: &Value, result: Value) -> Reply {
    Reply { status: StatusCode::OK, body: json!({ "jsonrpc": "2.0", "id": id, "result": result }) }
}

/// 錯誤回應；id 讀不到（body 壞掉、還沒解析）就不帶
fn error(status: StatusCode, id: Option<&Value>, code: i64, message: impl Into<String>) -> Reply {
    let mut body = json!({ "jsonrpc": "2.0", "error": { "code": code, "message": message.into() } });
    if let Some(id) = id {
        body["id"] = id.clone();
    }
    Reply { status, body }
}

/// 不支援的版本：列出支援的，客戶端可以換一個再試
fn unsupported_version(id: &Value, requested: &str) -> Reply {
    let mut reply = error(StatusCode::BAD_REQUEST, Some(id), UNSUPPORTED_VERSION, "Unsupported protocol version");
    reply.body["error"]["data"] = json!({ "supported": supported_versions(), "requested": requested });
    reply
}

fn supported_versions() -> Vec<&'static str> {
    MODERN_VERSIONS.iter().chain(LEGACY_VERSIONS).copied().collect()
}

fn server_info(state: &AppState) -> Value {
    json!({ "name": "ouyang.app", "title": "ouyang.app 米其林空位", "version": state.commit })
}

/// 工具的說明和參數跟 AI 助手的內建工具同一份
fn tool_definitions() -> Vec<Value> {
    TOOLS
        .iter()
        .map(|&kind| {
            let spec = ai_builtin::spec(kind);
            json!({
                "name": spec.name,
                "title": spec.title,
                "description": spec.description,
                "inputSchema": (spec.parameters)(),
                "annotations": {
                    "readOnlyHint": true,
                    "destructiveHint": false,
                    "idempotentHint": true,
                    "openWorldHint": false,
                },
            })
        })
        .collect()
}

fn tool_result(text: String, is_error: bool) -> Value {
    json!({ "content": [{ "type": "text", "text": text }], "isError": is_error })
}

/// 2026-07-28 的請求：header 要跟 body 一致。header 是給中間的 proxy 看的，不一致的話兩邊以為的請求不一樣
fn check_headers(headers: &HeaderMap, method: &str, params: &Value, version: &str) -> Result<(), String> {
    let get = |name: &str| headers.get(name).and_then(|v| v.to_str().ok());
    if get("mcp-protocol-version") != Some(version) {
        return Err(format!("MCP-Protocol-Version 要跟 params._meta 的版本一樣（{version}）"));
    }
    if get("mcp-method") != Some(method) {
        return Err(format!("Mcp-Method 要跟 method 一樣（{method}）"));
    }
    if method == "tools/call" {
        let name = params["name"].as_str().unwrap_or_default();
        if get("mcp-name").and_then(decode_header).as_deref() != Some(name) {
            return Err(format!("Mcp-Name 要跟 params.name 一樣（{name}）"));
        }
    }
    Ok(())
}

/// header 放不下的值（非 ASCII、前後有空白）用 `=?base64?…?=` 包起來
fn decode_header(value: &str) -> Option<String> {
    match value.strip_prefix("=?base64?").and_then(|v| v.strip_suffix("?=")) {
        Some(encoded) => String::from_utf8(base64::engine::general_purpose::STANDARD.decode(encoded).ok()?).ok(),
        None => Some(value.to_owned()),
    }
}

fn is_json(headers: &HeaderMap) -> bool {
    headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(';').next())
        .is_some_and(|v| v.trim().eq_ignore_ascii_case("application/json"))
}

/// 別的網站的頁面（例如瀏覽器裡的 MCP Inspector）也可以拿金鑰呼叫；
/// 允許的是 `*`，瀏覽器就不會帶 cookie 過來，借不到使用者登入的身分
fn with_cors(mut response: Response) -> Response {
    let headers = response.headers_mut();
    headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

/// 本站的網址（https://ouyang.app），從請求的 Host 看；經過 Traefik 的會帶 X-Forwarded-Proto
fn site_origin(headers: &HeaderMap, secure: bool) -> Option<String> {
    let host = headers.get(header::HOST)?.to_str().ok()?;
    let scheme =
        headers.get("x-forwarded-proto").and_then(|v| v.to_str().ok()).unwrap_or(if secure { "https" } else { "http" });
    Some(format!("{scheme}://{host}"))
}

/// 工具結果裡的站內連結（`/michelin/...`）改成完整網址：別人的 AI 不知道是哪個網站
fn absolute_links(text: String, origin: Option<&str>) -> String {
    fn walk(value: &mut Value, origin: &str) {
        match value {
            Value::Object(map) => {
                for (key, item) in map.iter_mut() {
                    match item {
                        Value::String(link) if (key == "page" || key == "map_link") && link.starts_with('/') => {
                            *link = format!("{origin}{link}");
                        }
                        _ => walk(item, origin),
                    }
                }
            }
            Value::Array(items) => items.iter_mut().for_each(|item| walk(item, origin)),
            _ => {}
        }
    }
    let Some(origin) = origin else { return text };
    let Ok(mut value) = serde_json::from_str::<Value>(&text) else { return text };
    walk(&mut value, origin);
    value.to_string()
}

/// 金鑰（header 或 `?key=`）優先；有帶金鑰就只看金鑰，錯了不會改用登入的身分
async fn authenticate(
    state: &AppState,
    headers: &HeaderMap,
    query: Option<&str>,
    session: Option<CurrentUser>,
    origin: Option<&str>,
) -> Result<Caller, Response> {
    let page = format!("{}/mcp", origin.unwrap_or("https://ouyang.app"));
    let bearer = match headers.get(header::AUTHORIZATION) {
        None => None,
        Some(value) => {
            let parts = value.to_str().ok().and_then(|v| v.trim().split_once(' '));
            match parts.filter(|(scheme, _)| scheme.eq_ignore_ascii_case("bearer")) {
                Some((_, token)) => Some(token.trim().to_owned()),
                None => {
                    return Err(unauthorized(format!("Authorization 要是 Bearer <金鑰>，金鑰在 {page} 建立"), true));
                }
            }
        }
    };
    if let Some(token) = bearer.or_else(|| query_key(query)) {
        return match key_owner(state, &token).await {
            Ok(Some(caller)) => Ok(caller),
            Ok(None) => Err(unauthorized(format!("金鑰不對，或已經刪掉了：到 {page} 建立新的金鑰"), true)),
            Err(err) => Err(err.into_response()),
        };
    }
    match session {
        // MCP 頁面上的測試：只收本站頁面送來的
        Some(user) if same_origin(headers) => Ok(Caller { user, key: None }),
        Some(_) => {
            let message = "別的網站送來的請求要帶金鑰";
            Err(error(StatusCode::FORBIDDEN, None, INVALID_REQUEST, message).into_response())
        }
        None => Err(unauthorized(format!("缺少金鑰：到 {page} 建立一把，放在 Authorization: Bearer <金鑰>"), false)),
    }
}

/// 401：用 OAuth 的格式（RFC 6750），客戶端看得出是金鑰的問題
fn unauthorized(message: String, invalid: bool) -> Response {
    let (challenge, code) = if invalid {
        (r#"Bearer realm="ouyang.app", error="invalid_token""#, "invalid_token")
    } else {
        (r#"Bearer realm="ouyang.app""#, "unauthorized")
    };
    let body = json!({ "error": code, "error_description": message });
    with_cors((StatusCode::UNAUTHORIZED, [(header::WWW_AUTHENTICATE, challenge)], Json(body)).into_response())
}

/// `?key=<金鑰>`：給不能自己加 header 的客戶端；金鑰只有英數字和底線，不用解碼
fn query_key(query: Option<&str>) -> Option<String> {
    query?
        .split('&')
        .find_map(|pair| pair.strip_prefix("key="))
        .map(str::trim)
        .filter(|key| !key.is_empty())
        .map(str::to_owned)
}

/// 瀏覽器送 POST 一定帶 Origin，要跟 Host 一樣才是本站的頁面。沒帶 Origin 的不是瀏覽器，照收
fn same_origin(headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get(header::ORIGIN) else { return true };
    let authority = origin.to_str().ok().and_then(|o| o.split_once("://")).map(|(_, rest)| rest);
    let host = headers.get(header::HOST).and_then(|v| v.to_str().ok());
    matches!((authority, host), (Some(authority), Some(host)) if authority.eq_ignore_ascii_case(host))
}

/// 金鑰的主人；帳號停用了就是 None
async fn key_owner(state: &AppState, token: &str) -> Result<Option<Caller>, AppError> {
    let row: Option<(i64, i64)> = sqlx::query_as("SELECT id, user_id FROM mcp_keys WHERE token_hash = ?")
        .bind(token_hash(token))
        .fetch_optional(&state.pool)
        .await?;
    let Some((key, user_id)) = row else { return Ok(None) };
    let Some(user) = auth::user_by_id(&state.pool, user_id).await? else { return Ok(None) };
    // 最多一分鐘寫一次：AI 連續呼叫時不用每次都寫資料庫
    sqlx::query(
        "UPDATE mcp_keys SET last_used_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
         WHERE id = ? AND (last_used_at IS NULL OR last_used_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 minute'))",
    )
    .bind(key)
    .execute(&state.pool)
    .await?;
    Ok(Some(Caller { user, key: Some(key) }))
}

// ---- /api/mcp/keys：MCP 頁面管理自己的金鑰 ----

#[derive(Serialize, sqlx::FromRow)]
pub struct Key {
    pub id: i64,
    pub name: String,
    /// 金鑰的開頭（oym_1a2b3c4d），認得出是哪一把
    pub prefix: String,
    pub created_at: String,
    pub last_used_at: Option<String>,
}

#[derive(Serialize)]
pub struct CreatedKey {
    #[serde(flatten)]
    pub key: Key,
    /// 金鑰本身：只有這一次看得到
    pub token: String,
}

#[derive(Deserialize)]
pub struct NewKey {
    pub name: String,
}

/// 自己的金鑰，新的在前
pub async fn list_keys(State(state): State<AppState>, user: CurrentUser) -> Result<Json<Vec<Key>>, AppError> {
    let keys = sqlx::query_as::<_, Key>(
        "SELECT id, name, prefix, created_at, last_used_at FROM mcp_keys WHERE user_id = ? ORDER BY id DESC",
    )
    .bind(user.id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(keys))
}

pub async fn create_key(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(input): Json<NewKey>,
) -> Result<(StatusCode, Json<CreatedKey>), AppError> {
    let name = input.name.trim();
    if name.is_empty() {
        return Err(AppError::BadRequest("幫金鑰取個名字，例如「小明的 Claude」".into()));
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(AppError::BadRequest(format!("名字最多 {MAX_NAME_CHARS} 個字")));
    }
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM mcp_keys WHERE user_id = ?")
        .bind(user.id)
        .fetch_one(&state.pool)
        .await?;
    if count >= MAX_KEYS {
        return Err(AppError::Conflict(format!("最多 {MAX_KEYS} 把金鑰，先刪掉用不到的")));
    }
    let token = new_token()?;
    let key = sqlx::query_as::<_, Key>(
        "INSERT INTO mcp_keys (user_id, name, token_hash, prefix) VALUES (?, ?, ?, ?)
         RETURNING id, name, prefix, created_at, last_used_at",
    )
    .bind(user.id)
    .bind(name)
    .bind(token_hash(&token))
    .bind(&token[..SHOWN_PREFIX])
    .fetch_one(&state.pool)
    .await?;
    Ok((StatusCode::CREATED, Json(CreatedKey { key, token })))
}

/// 刪掉馬上失效
pub async fn delete_key(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<i64>,
) -> Result<StatusCode, AppError> {
    let deleted = sqlx::query("DELETE FROM mcp_keys WHERE id = ? AND user_id = ?")
        .bind(id)
        .bind(user.id)
        .execute(&state.pool)
        .await?;
    if deleted.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    Ok(StatusCode::NO_CONTENT)
}

/// oym_ 加 48 個十六進位字（192 bits）
fn new_token() -> Result<String, AppError> {
    let mut bytes = [0u8; 24];
    getrandom::fill(&mut bytes).map_err(|err| AppError::Internal(format!("getrandom: {err}")))?;
    let mut token = KEY_PREFIX.to_owned();
    for byte in bytes {
        let _ = write!(token, "{byte:02x}");
    }
    Ok(token)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.insert(*name, HeaderValue::from_str(value).unwrap());
        }
        map
    }

    #[test]
    fn only_read_only_tools() {
        for &kind in TOOLS {
            assert!(!ai_builtin::spec(kind).writes, "{} 會改資料，MCP 沒有確認的步驟", ai_builtin::spec(kind).name);
        }
    }

    #[test]
    fn header_values_and_query_keys() {
        assert_eq!(decode_header("michelin_availability").as_deref(), Some("michelin_availability"));
        // 「Hello, 世界」
        assert_eq!(decode_header("=?base64?SGVsbG8sIOS4lueVjA==?=").as_deref(), Some("Hello, 世界"));
        assert_eq!(decode_header("=?base64?不是 base64?="), None);

        assert_eq!(query_key(Some("key=oym_abc")).as_deref(), Some("oym_abc"));
        assert_eq!(query_key(Some("x=1&key=oym_abc&y=2")).as_deref(), Some("oym_abc"));
        assert_eq!(query_key(Some("monkey=1&key=")), None);
        assert_eq!(query_key(None), None);

        let token = new_token().unwrap();
        assert!(token.starts_with(KEY_PREFIX) && token.len() == 52, "{token}");
        assert_ne!(token, new_token().unwrap());
    }

    #[test]
    fn origins() {
        assert!(same_origin(&headers(&[("host", "ouyang.app")])));
        assert!(same_origin(&headers(&[("host", "ouyang.app"), ("origin", "https://ouyang.app")])));
        assert!(same_origin(&headers(&[("host", "localhost:5173"), ("origin", "http://localhost:5173")])));
        assert!(!same_origin(&headers(&[("host", "ouyang.app"), ("origin", "https://evil.example")])));
        assert!(!same_origin(&headers(&[("host", "ouyang.app"), ("origin", "null")])));

        let proxied = headers(&[("host", "ouyang.app"), ("x-forwarded-proto", "https")]);
        assert_eq!(site_origin(&proxied, false).as_deref(), Some("https://ouyang.app"));
        assert_eq!(
            site_origin(&headers(&[("host", "localhost:8080")]), false).as_deref(),
            Some("http://localhost:8080")
        );
        assert_eq!(site_origin(&HeaderMap::new(), true), None);
    }

    #[test]
    fn links_become_absolute() {
        let text = json!({
            "page": "/michelin/availability",
            "restaurants": [{ "name": "頤宮", "map_link": "/michelin?r=le-palais", "booking": "https://inline.app/x" }],
            "note": "/不是連結",
        })
        .to_string();
        let out: Value = serde_json::from_str(&absolute_links(text.clone(), Some("https://ouyang.app"))).unwrap();
        assert_eq!(out["page"], "https://ouyang.app/michelin/availability");
        assert_eq!(out["restaurants"][0]["map_link"], "https://ouyang.app/michelin?r=le-palais");
        assert_eq!(out["restaurants"][0]["booking"], "https://inline.app/x");
        assert_eq!(out["note"], "/不是連結");
        // 不是 JSON（一句話的結果）、不知道網址：原樣
        assert_eq!(absolute_links("還沒有空位資料".into(), Some("https://ouyang.app")), "還沒有空位資料");
        assert_eq!(absolute_links(text.clone(), None), text);
    }
}
