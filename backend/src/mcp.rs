//! MCP（Model Context Protocol）客戶端：AI 助手透過管理員接上的 MCP 伺服器拿到更多工具。
//!
//! - 只支援 Streamable HTTP（`POST` JSON-RPC，回應是 JSON 或 SSE）。容器是 distroless，跑不了 stdio 的伺服器；
//!   要用 stdio 的伺服器，可以在別台主機用 supergateway 之類的轉成 HTTP 再接進來。
//! - 每個伺服器一組 session（`Mcp-Session-Id`），第一次用到時 `initialize`，伺服器說 session 不見了（404）就重新來過。
//! - 設定存在 `ai_mcp_servers`：網址、要帶的 header（例如 `Authorization`，值只回最後 4 碼）、
//!   工具名稱的前綴（給模型的名稱是 `前綴__工具`），以及最近一次 `tools/list` 讀到的工具。
//! - `public` 沒勾的伺服器只有管理員的對話用得到：伺服器上的金鑰是管理員的，不能讓每個登入的人都拿去用。

use std::{
    collections::{BTreeMap, HashMap},
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use reqwest::{Url, header};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::SqlitePool;
use tokio::sync::Mutex;

use crate::{
    AppError, AppState,
    ai::describe_request_error,
    ai_tools::{self, ToolsView},
    auth::{AdminUsers, Require},
};

pub const PROTOCOL_VERSION: &str = "2025-06-18";
/// 列工具、呼叫工具最久等多久
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
/// 一個回應最多讀多少（工具結果太大也沒辦法整段給模型）
const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
const MAX_SERVERS: i64 = 20;
const MAX_TOOLS: usize = 200;
const MAX_HEADERS: usize = 10;
const MAX_HEADER_VALUE: usize = 4000;
/// 這些 header 由程式自己決定，不讓管理員蓋掉
const RESERVED_HEADERS: &[&str] = &[
    "accept",
    "connection",
    "content-length",
    "content-type",
    "host",
    "mcp-protocol-version",
    "mcp-session-id",
    "transfer-encoding",
];

#[derive(Clone, Debug, sqlx::FromRow)]
pub struct Server {
    pub id: i64,
    pub name: String,
    pub prefix: String,
    pub url: String,
    /// JSON 物件：header 名稱 → 值
    pub headers: String,
    pub enabled: bool,
    pub public: bool,
    /// JSON：`Vec<McpTool>`
    pub tools: String,
    pub tools_fetched_at: Option<String>,
    pub last_error: Option<String>,
}

/// 欄位，後面接上 FROM / RETURNING（用 concat! 組成靜態字串）
macro_rules! server_columns {
    () => {
        "id, name, prefix, url, headers, enabled, public, tools, tools_fetched_at, last_error"
    };
}

impl Server {
    fn header_map(&self) -> BTreeMap<String, String> {
        serde_json::from_str(&self.headers).unwrap_or_default()
    }

    pub fn tool_list(&self) -> Vec<McpTool> {
        serde_json::from_str(&self.tools).unwrap_or_default()
    }

    /// 網址加 header：設定改了就要重新 initialize
    fn session_key(&self) -> String {
        format!("{}\n{}", self.url, self.headers)
    }
}

pub async fn list_servers(pool: &SqlitePool) -> Result<Vec<Server>, sqlx::Error> {
    sqlx::query_as(concat!("SELECT ", server_columns!(), " FROM ai_mcp_servers ORDER BY id")).fetch_all(pool).await
}

async fn find_server(pool: &SqlitePool, id: i64) -> Result<Option<Server>, sqlx::Error> {
    sqlx::query_as(concat!("SELECT ", server_columns!(), " FROM ai_mcp_servers WHERE id = ?"))
        .bind(id)
        .fetch_optional(pool)
        .await
}

/// 伺服器上的一個工具（`tools/list` 整理過的樣子）
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct McpTool {
    pub name: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: String,
    /// JSON schema
    #[serde(default)]
    pub input_schema: Value,
    /// 伺服器說這個工具只會讀資料（`annotations.readOnlyHint`），預設就不用使用者確認
    #[serde(default)]
    pub read_only: bool,
}

impl McpTool {
    fn from_wire(tool: &Value) -> Option<Self> {
        let name = tool["name"].as_str()?.to_owned();
        let annotations = &tool["annotations"];
        let title = tool["title"].as_str().or(annotations["title"].as_str()).map(String::from);
        let mut input_schema = tool["inputSchema"].clone();
        if !input_schema.is_object() {
            input_schema = json!({ "type": "object", "properties": {} });
        }
        Some(Self {
            name,
            title,
            description: tool["description"].as_str().unwrap_or_default().to_owned(),
            input_schema,
            read_only: annotations["readOnlyHint"].as_bool().unwrap_or(false),
        })
    }
}

// ---- 客戶端 ----

struct Session {
    key: String,
    id: Option<String>,
    protocol: String,
}

pub struct Mcp {
    http: reqwest::Client,
    sessions: Mutex<HashMap<i64, Session>>,
    next_id: AtomicU64,
}

impl Default for Mcp {
    fn default() -> Self {
        let http = reqwest::Client::builder()
            .user_agent(concat!("ouyang_web/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(Duration::from_secs(10))
            .build()
            .expect("failed to build http client");
        Self { http, sessions: Mutex::default(), next_id: AtomicU64::new(1) }
    }
}

impl Mcp {
    /// 設定改了或刪掉：下次重新 initialize
    pub async fn forget(&self, id: i64) {
        self.sessions.lock().await.remove(&id);
    }

    fn post(&self, server: &Server, session: Option<(&Option<String>, &str)>, body: &Value) -> reqwest::RequestBuilder {
        let mut request = self
            .http
            .post(&server.url)
            .timeout(REQUEST_TIMEOUT)
            .header(header::ACCEPT, "application/json, text/event-stream")
            .json(body);
        for (name, value) in server.header_map() {
            request = request.header(name, value);
        }
        if let Some((id, protocol)) = session {
            if let Some(id) = id {
                request = request.header("mcp-session-id", id);
            }
            request = request.header("mcp-protocol-version", protocol);
        }
        request
    }

    async fn initialize(&self, server: &Server) -> Result<Session, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let body = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "initialize",
            "params": {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": { "name": "ouyang_web", "version": env!("CARGO_PKG_VERSION") },
            },
        });
        let response = self.post(server, None, &body).send().await.map_err(|err| describe_request_error(&err))?;
        let session_id = response.headers().get("mcp-session-id").and_then(|v| v.to_str().ok()).map(String::from);
        let result = read_response(response, id).await?;
        let protocol = result["protocolVersion"].as_str().unwrap_or(PROTOCOL_VERSION).to_owned();
        let session = Session { key: server.session_key(), id: session_id, protocol };
        // 告訴伺服器初始化完成（沒有回應，回 202）
        let notice = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
        let response = self
            .post(server, Some((&session.id, &session.protocol)), &notice)
            .send()
            .await
            .map_err(|err| describe_request_error(&err))?;
        if !response.status().is_success() {
            return Err(describe_status(response).await);
        }
        Ok(session)
    }

    /// 送一個 JSON-RPC 請求，回傳 `result`
    async fn request(&self, server: &Server, method: &str, params: Value) -> Result<Value, String> {
        for attempt in 0..2 {
            let (session_id, protocol) = {
                let sessions = self.sessions.lock().await;
                match sessions.get(&server.id).filter(|s| s.key == server.session_key()) {
                    Some(session) => (session.id.clone(), session.protocol.clone()),
                    None => {
                        drop(sessions);
                        let session = self.initialize(server).await?;
                        let pair = (session.id.clone(), session.protocol.clone());
                        self.sessions.lock().await.insert(server.id, session);
                        pair
                    }
                }
            };
            let id = self.next_id.fetch_add(1, Ordering::Relaxed);
            let body = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
            let response = self
                .post(server, Some((&session_id, &protocol)), &body)
                .send()
                .await
                .map_err(|err| describe_request_error(&err))?;
            // session 過期（伺服器重啟之類）：重新 initialize 再送一次
            if response.status() == StatusCode::NOT_FOUND && session_id.is_some() && attempt == 0 {
                self.forget(server.id).await;
                continue;
            }
            return read_response(response, id).await;
        }
        Err("session 一直失效".into())
    }

    pub async fn list_tools(&self, server: &Server) -> Result<Vec<McpTool>, String> {
        let mut tools = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..20 {
            let params = match &cursor {
                Some(cursor) => json!({ "cursor": cursor }),
                None => json!({}),
            };
            let result = self.request(server, "tools/list", params).await?;
            let page = result["tools"].as_array().ok_or("回應裡沒有 tools")?;
            tools.extend(page.iter().filter_map(McpTool::from_wire));
            cursor = result["nextCursor"].as_str().filter(|c| !c.is_empty()).map(String::from);
            if cursor.is_none() || tools.len() >= MAX_TOOLS {
                break;
            }
        }
        tools.truncate(MAX_TOOLS);
        Ok(tools)
    }

    /// 呼叫工具，回傳給模型看的文字；工具自己回報失敗（`isError`）也是 `Err`
    pub async fn call_tool(&self, server: &Server, name: &str, arguments: Value) -> Result<String, String> {
        let result = self.request(server, "tools/call", json!({ "name": name, "arguments": arguments })).await?;
        let text = render_result(&result);
        if result["isError"].as_bool() == Some(true) { Err(text) } else { Ok(text) }
    }
}

/// 工具結果的 content 轉成文字：文字照放，圖片之類的只說有這個東西
fn render_result(result: &Value) -> String {
    let mut parts = Vec::new();
    for item in result["content"].as_array().into_iter().flatten() {
        let part = match item["type"].as_str() {
            Some("text") => item["text"].as_str().unwrap_or_default().to_owned(),
            Some("image") => format!("[圖片 {}]", item["mimeType"].as_str().unwrap_or_default()),
            Some("audio") => format!("[音訊 {}]", item["mimeType"].as_str().unwrap_or_default()),
            Some("resource_link") => format!(
                "[連結] {} {}",
                item["name"].as_str().unwrap_or_default(),
                item["uri"].as_str().unwrap_or_default()
            ),
            Some("resource") => {
                let resource = &item["resource"];
                match resource["text"].as_str() {
                    Some(text) => text.to_owned(),
                    None => format!("[檔案 {}]", resource["uri"].as_str().unwrap_or_default()),
                }
            }
            _ => item.to_string(),
        };
        parts.push(part);
    }
    if parts.is_empty()
        && let Some(structured) = result.get("structuredContent").filter(|v| !v.is_null())
    {
        return structured.to_string();
    }
    parts.join("\n")
}

/// 讀 JSON-RPC 的回應：可能是一般的 JSON，也可能是 SSE（中間夾著通知，要找 id 對得上的那一則）
async fn read_response(mut response: reqwest::Response, id: u64) -> Result<Value, String> {
    if !response.status().is_success() {
        return Err(describe_status(response).await);
    }
    let is_sse = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.starts_with("text/event-stream"));
    let mut buffer = Vec::new();
    let mut data = String::new();
    loop {
        let chunk = match response.chunk().await {
            Ok(Some(chunk)) => chunk,
            Ok(None) => break,
            Err(err) => return Err(describe_request_error(&err)),
        };
        buffer.extend_from_slice(&chunk);
        if buffer.len() > MAX_RESPONSE_BYTES {
            return Err("回應太大".into());
        }
        if !is_sse {
            continue;
        }
        // SSE：一行一行讀，空行是一則事件的結尾
        while let Some(end) = buffer.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = buffer.drain(..=end).collect();
            let line = String::from_utf8_lossy(&line);
            let line = line.trim_end_matches(['\n', '\r']);
            if line.is_empty() {
                if let Some(result) = match_message(&std::mem::take(&mut data), id)? {
                    return Ok(result);
                }
            } else if let Some(rest) = line.strip_prefix("data:") {
                if !data.is_empty() {
                    data.push('\n');
                }
                data.push_str(rest.strip_prefix(' ').unwrap_or(rest));
            }
        }
    }
    let rest = if is_sse { data } else { String::from_utf8_lossy(&buffer).into_owned() };
    match match_message(&rest, id)? {
        Some(result) => Ok(result),
        None => Err("伺服器沒有回應這個請求".into()),
    }
}

/// 一則 JSON-RPC 訊息（或一批）裡 id 對得上的回應；錯誤回 `Err`，別的訊息回 `None`
fn match_message(text: &str, id: u64) -> Result<Option<Value>, String> {
    let Ok(value) = serde_json::from_str::<Value>(text.trim()) else { return Ok(None) };
    let messages = match value {
        Value::Array(items) => items,
        other => vec![other],
    };
    for message in messages {
        if message["id"].as_u64() != Some(id) {
            continue;
        }
        if let Some(error) = message.get("error") {
            let text = error["message"].as_str().unwrap_or("未知的錯誤");
            return Err(match error["code"].as_i64() {
                Some(code) => format!("{text}（{code}）"),
                None => text.to_owned(),
            });
        }
        return Ok(Some(message["result"].clone()));
    }
    Ok(None)
}

async fn describe_status(response: reqwest::Response) -> String {
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    let message = serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|v| {
            v["error"]["message"].as_str().or(v["error"].as_str()).or(v["message"].as_str()).map(String::from)
        })
        .unwrap_or(body);
    let message: String = message.trim().chars().take(300).collect();
    let hint = match status {
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => "金鑰錯誤或沒有權限",
        StatusCode::NOT_FOUND => "找不到，網址對嗎？",
        StatusCode::METHOD_NOT_ALLOWED => "這個網址不收 POST，可能不是 Streamable HTTP 的 MCP 端點",
        _ => "",
    };
    let code = status.as_u16();
    match (hint.is_empty(), message.is_empty()) {
        (true, true) => format!("伺服器回應 {code}"),
        (true, false) => format!("伺服器回應 {code}：{message}"),
        (false, true) => format!("{hint}（{code}）"),
        (false, false) => format!("{hint}（{code}）：{message}"),
    }
}

// ---- 管理 API ----

#[derive(Deserialize)]
pub struct HeaderInput {
    pub name: String,
    /// 修改時沒給（null）就沿用原本的值
    #[serde(default)]
    pub value: Option<String>,
}

#[derive(Deserialize)]
pub struct ServerInput {
    pub name: String,
    pub prefix: String,
    pub url: String,
    #[serde(default)]
    pub headers: Vec<HeaderInput>,
    #[serde(default = "yes")]
    pub enabled: bool,
    #[serde(default)]
    pub public: bool,
}

fn yes() -> bool {
    true
}

fn validate_prefix(prefix: &str) -> Result<(), AppError> {
    let valid = (1..=20).contains(&prefix.len())
        && prefix.starts_with(|c: char| c.is_ascii_lowercase())
        && prefix.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
        && !prefix.contains("__");
    if !valid {
        return Err(AppError::BadRequest("前綴要是 1–20 個小寫英文、數字或 _，英文開頭，不能有連續的 _".into()));
    }
    Ok(())
}

fn validate_url(input: &str) -> Result<String, AppError> {
    let url = input.trim();
    if url.is_empty() || url.len() > 500 {
        return Err(AppError::BadRequest("請填網址（500 字以內）".into()));
    }
    let parsed = Url::parse(url).map_err(|_| AppError::BadRequest("網址格式不對，例如 https://host/mcp".into()))?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err(AppError::BadRequest("網址要是 http:// 或 https:// 開頭".into()));
    }
    Ok(url.to_owned())
}

/// 整理 header：名稱轉小寫、檢查格式；沒給值的沿用 `old` 裡的
fn merge_headers(input: Vec<HeaderInput>, old: &BTreeMap<String, String>) -> Result<String, AppError> {
    if input.len() > MAX_HEADERS {
        return Err(AppError::BadRequest(format!("header 最多 {MAX_HEADERS} 個")));
    }
    let mut headers = BTreeMap::new();
    for HeaderInput { name, value } in input {
        let name = name.trim().to_ascii_lowercase();
        if name.is_empty() {
            continue;
        }
        if header::HeaderName::from_bytes(name.as_bytes()).is_err() || RESERVED_HEADERS.contains(&name.as_str()) {
            return Err(AppError::BadRequest(format!("不能用這個 header 名稱：{name}")));
        }
        let value = match value {
            Some(value) => value.trim().to_owned(),
            None => old.get(&name).cloned().ok_or_else(|| AppError::BadRequest(format!("{name} 要填值")))?,
        };
        if value.len() > MAX_HEADER_VALUE || header::HeaderValue::from_str(&value).is_err() {
            return Err(AppError::BadRequest(format!("{name} 的值格式不對")));
        }
        headers.insert(name, value);
    }
    serde_json::to_string(&headers).map_err(|err| AppError::Internal(err.to_string()))
}

/// 重新讀一次工具清單存起來；失敗時保留上次的清單，記下原因
pub async fn refresh(state: &AppState, server: &Server) -> Result<(), sqlx::Error> {
    match state.mcp.list_tools(server).await {
        Ok(tools) => {
            let tools = serde_json::to_string(&tools).unwrap_or_else(|_| "[]".into());
            sqlx::query(
                "UPDATE ai_mcp_servers SET tools = ?, tools_fetched_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
                     last_error = NULL WHERE id = ?",
            )
            .bind(tools)
            .bind(server.id)
            .execute(&state.pool)
            .await?;
        }
        Err(error) => {
            tracing::warn!(server = server.id, error, "failed to list MCP tools");
            sqlx::query("UPDATE ai_mcp_servers SET last_error = ? WHERE id = ?")
                .bind(error)
                .bind(server.id)
                .execute(&state.pool)
                .await?;
        }
    }
    Ok(())
}

pub async fn admin_create(
    _: Require<AdminUsers>,
    State(state): State<AppState>,
    Json(input): Json<ServerInput>,
) -> Result<(StatusCode, Json<ToolsView>), AppError> {
    let name = input.name.trim();
    if name.is_empty() || name.chars().count() > 50 {
        return Err(AppError::BadRequest("名稱要 1 到 50 字".into()));
    }
    let prefix = input.prefix.trim();
    validate_prefix(prefix)?;
    let url = validate_url(&input.url)?;
    let headers = merge_headers(input.headers, &BTreeMap::new())?;
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ai_mcp_servers").fetch_one(&state.pool).await?;
    if count >= MAX_SERVERS {
        return Err(AppError::BadRequest(format!("最多 {MAX_SERVERS} 個 MCP 伺服器")));
    }
    let server: Server = sqlx::query_as(concat!(
        "INSERT INTO ai_mcp_servers (name, prefix, url, headers, enabled, public) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (prefix) DO NOTHING RETURNING ",
        server_columns!()
    ))
    .bind(name)
    .bind(prefix)
    .bind(url)
    .bind(headers)
    .bind(input.enabled)
    .bind(input.public)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| AppError::Conflict("這個前綴已經有別的伺服器在用".into()))?;
    refresh(&state, &server).await?;
    Ok((StatusCode::CREATED, Json(ai_tools::admin_view(&state).await?)))
}

pub async fn admin_update(
    _: Require<AdminUsers>,
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(input): Json<ServerInput>,
) -> Result<Json<ToolsView>, AppError> {
    let old = find_server(&state.pool, id).await?.ok_or(AppError::NotFound)?;
    let name = input.name.trim();
    if name.is_empty() || name.chars().count() > 50 {
        return Err(AppError::BadRequest("名稱要 1 到 50 字".into()));
    }
    let prefix = input.prefix.trim();
    validate_prefix(prefix)?;
    let url = validate_url(&input.url)?;
    // 改了網址就不沿用舊的 header 值，免得把金鑰送到新的地方
    let old_headers = if url == old.url { old.header_map() } else { BTreeMap::new() };
    let headers = merge_headers(input.headers, &old_headers)?;
    let server: Server = sqlx::query_as(concat!(
        "UPDATE ai_mcp_servers SET name = ?, prefix = ?, url = ?, headers = ?, enabled = ?, public = ? WHERE id = ?
         RETURNING ",
        server_columns!()
    ))
    .bind(name)
    .bind(prefix)
    .bind(url)
    .bind(headers)
    .bind(input.enabled)
    .bind(input.public)
    .bind(id)
    .fetch_one(&state.pool)
    .await
    .map_err(|err| match &err {
        sqlx::Error::Database(db) if db.is_unique_violation() => {
            AppError::Conflict("這個前綴已經有別的伺服器在用".into())
        }
        _ => err.into(),
    })?;
    state.mcp.forget(id).await;
    // 前綴換了，舊的工具設定對不上新名稱，一起搬過去
    if old.prefix != server.prefix {
        sqlx::query("UPDATE OR REPLACE ai_tool_settings SET tool = ? || substr(tool, ?) WHERE tool LIKE ? ESCAPE '\\'")
            .bind(format!("{}__", server.prefix))
            .bind(old.prefix.len() as i64 + 3)
            .bind(format!("{}\\_\\_%", old.prefix.replace('_', "\\_")))
            .execute(&state.pool)
            .await?;
    }
    if server.enabled {
        refresh(&state, &server).await?;
    }
    Ok(Json(ai_tools::admin_view(&state).await?))
}

pub async fn admin_delete(
    _: Require<AdminUsers>,
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<Json<ToolsView>, AppError> {
    let server = find_server(&state.pool, id).await?.ok_or(AppError::NotFound)?;
    sqlx::query("DELETE FROM ai_mcp_servers WHERE id = ?").bind(id).execute(&state.pool).await?;
    sqlx::query("DELETE FROM ai_tool_settings WHERE tool LIKE ? ESCAPE '\\'")
        .bind(format!("{}\\_\\_%", server.prefix.replace('_', "\\_")))
        .execute(&state.pool)
        .await?;
    state.mcp.forget(id).await;
    Ok(Json(ai_tools::admin_view(&state).await?))
}

/// 重新連線、重新讀工具清單
pub async fn admin_refresh(
    _: Require<AdminUsers>,
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<Json<ToolsView>, AppError> {
    let server = find_server(&state.pool, id).await?.ok_or(AppError::NotFound)?;
    state.mcp.forget(id).await;
    refresh(&state, &server).await?;
    Ok(Json(ai_tools::admin_view(&state).await?))
}

/// 給管理頁看的 header：只有名稱和值的最後 4 碼
#[derive(Serialize)]
pub struct HeaderView {
    pub name: String,
    pub hint: String,
}

#[derive(Serialize)]
pub struct ServerView {
    pub id: i64,
    pub name: String,
    pub prefix: String,
    pub url: String,
    pub headers: Vec<HeaderView>,
    pub enabled: bool,
    pub public: bool,
    pub tool_count: usize,
    pub tools_fetched_at: Option<String>,
    pub last_error: Option<String>,
}

impl From<&Server> for ServerView {
    fn from(server: &Server) -> Self {
        let headers = server
            .header_map()
            .into_iter()
            .map(|(name, value)| {
                let n = value.chars().count();
                let hint = if n >= 12 {
                    format!("…{}", value.chars().skip(n - 4).collect::<String>())
                } else {
                    "已設定".into()
                };
                HeaderView { name, hint }
            })
            .collect();
        Self {
            id: server.id,
            name: server.name.clone(),
            prefix: server.prefix.clone(),
            url: server.url.clone(),
            headers,
            enabled: server.enabled,
            public: server.public,
            tool_count: server.tool_list().len(),
            tools_fetched_at: server.tools_fetched_at.clone(),
            last_error: server.last_error.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_rpc_messages_are_matched_by_id() {
        let notification = r#"{"jsonrpc":"2.0","method":"notifications/progress","params":{}}"#;
        assert_eq!(match_message(notification, 3).unwrap(), None);
        let reply = r#"{"jsonrpc":"2.0","id":3,"result":{"ok":true}}"#;
        assert_eq!(match_message(reply, 3).unwrap(), Some(json!({ "ok": true })));
        assert_eq!(match_message(reply, 4).unwrap(), None);
        let error = r#"[{"jsonrpc":"2.0","id":5,"error":{"code":-32602,"message":"Unknown tool"}}]"#;
        assert_eq!(match_message(error, 5).unwrap_err(), "Unknown tool（-32602）");
    }

    #[test]
    fn results_become_text() {
        let result = json!({ "content": [
            { "type": "text", "text": "第一段" },
            { "type": "image", "data": "...", "mimeType": "image/png" },
            { "type": "resource", "resource": { "uri": "file:///a.txt", "text": "檔案內容" } },
        ] });
        assert_eq!(render_result(&result), "第一段\n[圖片 image/png]\n檔案內容");
        assert_eq!(render_result(&json!({ "content": [], "structuredContent": { "n": 1 } })), r#"{"n":1}"#);
    }

    #[test]
    fn prefixes_and_headers_are_checked() {
        assert!(validate_prefix("notion").is_ok());
        assert!(validate_prefix("gh_2").is_ok());
        for bad in ["", "Notion", "2fa", "a__b", "has-dash", "abcdefghijklmnopqrstu"] {
            assert!(validate_prefix(bad).is_err(), "{bad}");
        }
        let old = BTreeMap::from([("authorization".to_owned(), "Bearer old".to_owned())]);
        let kept = merge_headers(vec![HeaderInput { name: "Authorization".into(), value: None }], &old).unwrap();
        assert_eq!(kept, r#"{"authorization":"Bearer old"}"#);
        assert!(merge_headers(vec![HeaderInput { name: "Host".into(), value: Some("x".into()) }], &old).is_err());
        assert!(merge_headers(vec![HeaderInput { name: "x-new".into(), value: None }], &old).is_err());
    }
}
