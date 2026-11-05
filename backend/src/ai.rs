//! AI：平台上的 AI 功能都透過這裡呼叫 OpenAI 相容的 API（vLLM、Ollama、OpenAI…）。
//! 管理員在「系統管理 › AI 設定」（`/admin/ai`）設定好幾組（名稱、網址、金鑰、模型），選一組給全站使用，
//! 也可以在同一頁挑任一組直接對話測試，確認沒問題再切換。
//!
//! - 設定存在 `ai_providers`，使用中的是 `site_settings.ai_active_provider`。每次呼叫都從資料庫讀，
//!   換版時新舊容器用的是同一組。金鑰只留在伺服器，API 只回最後 4 碼。
//! - 背景每 15 秒對每一組打一次 `GET {網址}/models`，確認連得上、金鑰對、模型還在；
//!   真的呼叫失敗時也立刻標成異常，成功就恢復。狀態只放在記憶體（每個容器各自檢查）。
//!   `GET /api/ai/status` 是使用中那一組的狀態，給前端的 AI 功能看，異常時頁面上馬上顯示。
//! - 其他功能用 [`Ai::stream`]（一段一段拿）或 [`Ai::complete`]（等整段回答）呼叫，不用管是哪一組。
//!   上游一律用串流（`stream: true`），思考內容（vLLM 的 `reasoning_content`／`reasoning`，或包在 `<think>` 裡的）和答案分開。

use std::{
    collections::{HashMap, VecDeque},
    error::Error as _,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use axum::{
    Json,
    body::{Body, Bytes},
    extract::{Path, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use chrono::Utc;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::SqlitePool;
use tokio::sync::mpsc;

use crate::{
    AppError, AppState,
    auth::{AdminUsers, Require},
};

const ACTIVE_SETTING: &str = "ai_active_provider";

/// 背景多久確認一次服務還活著
const CHECK_EVERY: Duration = Duration::from_secs(15);
/// 確認用的 `GET /models` 等多久算失敗
const CHECK_TIMEOUT: Duration = Duration::from_secs(10);
/// 串流中兩段資料之間最久等多久（很長的輸入光是讀完就要一陣子）
const READ_TIMEOUT: Duration = Duration::from_secs(120);
/// 每一組留最近幾次狀態變化
const MAX_EVENTS: usize = 30;
/// 錯誤訊息裡最多帶多少上游回應的內容
const MAX_ERROR_BODY: usize = 300;

const MAX_PROVIDERS: i64 = 20;
const MAX_NAME_LEN: usize = 50;
const MAX_URL_LEN: usize = 500;
const MAX_MODEL_LEN: usize = 200;
const MAX_KEY_LEN: usize = 1000;
const MAX_MESSAGES: usize = 200;
const MAX_CHAT_CHARS: usize = 500_000;

/// 一組設定
#[derive(Clone, Debug, sqlx::FromRow)]
pub struct Provider {
    pub id: i64,
    pub name: String,
    /// 不含結尾的 `/`，例如 `http://host:15002/v1`
    pub base_url: String,
    /// 沒有金鑰的伺服器留空，就不送 Authorization
    pub api_key: String,
    pub model: String,
}

impl Provider {
    fn request(&self, http: &reqwest::Client, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        let request = http.request(method, format!("{}/{path}", self.base_url));
        if self.api_key.is_empty() { request } else { request.bearer_auth(&self.api_key) }
    }

    /// 金鑰的最後 4 碼（`…abcd`），太短的只說有設定
    fn key_hint(&self) -> Option<String> {
        match self.api_key.chars().count() {
            0 => None,
            n if n >= 8 => Some(format!("…{}", self.api_key.chars().skip(n - 4).collect::<String>())),
            _ => Some("已設定".into()),
        }
    }
}

async fn list_providers(pool: &SqlitePool) -> Result<Vec<Provider>, sqlx::Error> {
    sqlx::query_as("SELECT id, name, base_url, api_key, model FROM ai_providers ORDER BY id").fetch_all(pool).await
}

async fn find_provider(pool: &SqlitePool, id: i64) -> Result<Option<Provider>, sqlx::Error> {
    sqlx::query_as("SELECT id, name, base_url, api_key, model FROM ai_providers WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await
}

async fn active_id(pool: &SqlitePool) -> Result<Option<i64>, sqlx::Error> {
    let value: Option<String> = sqlx::query_scalar("SELECT value FROM site_settings WHERE key = ?")
        .bind(ACTIVE_SETTING)
        .fetch_optional(pool)
        .await?;
    Ok(value.and_then(|v| v.parse().ok()))
}

/// 全站目前使用的那一組；沒選就是不開放 AI 功能
pub async fn active_provider(pool: &SqlitePool) -> Result<Option<Provider>, sqlx::Error> {
    match active_id(pool).await? {
        Some(id) => find_provider(pool, id).await,
        None => Ok(None),
    }
}

async fn set_active(pool: &SqlitePool, id: Option<i64>) -> Result<(), sqlx::Error> {
    let query = match id {
        Some(id) => sqlx::query(
            "INSERT INTO site_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        )
        .bind(ACTIVE_SETTING)
        .bind(id.to_string()),
        None => sqlx::query("DELETE FROM site_settings WHERE key = ?").bind(ACTIVE_SETTING),
    };
    query.execute(pool).await?;
    Ok(())
}

fn now() -> String {
    Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

// ---- 狀態 ----

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Health {
    /// 剛啟動或剛改設定，還沒檢查完
    #[default]
    Unknown,
    Ok,
    Down,
}

impl Health {
    /// 能不能用：還沒檢查完的當作可以，真的失敗了會馬上改掉
    pub fn usable(self) -> bool {
        matches!(self, Self::Ok | Self::Unknown)
    }
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct Status {
    pub health: Health,
    /// 進入目前狀態的時間
    pub since: Option<String>,
    pub checked_at: Option<String>,
    /// 最後一次成功的回應時間（毫秒）
    pub latency_ms: Option<u64>,
    /// 異常的原因（只給管理員看）
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct StatusEvent {
    pub at: String,
    pub health: Health,
    pub error: Option<String>,
}

#[derive(Default)]
struct Entry {
    status: Status,
    /// 最近的狀態變化，新的在前面
    events: VecDeque<StatusEvent>,
    /// 每次改設定就加一：用舊設定做的檢查或呼叫，結果不能蓋掉新設定的狀態
    epoch: u64,
}

pub struct Ai {
    http: reqwest::Client,
    /// 每一組的狀態，key 是 `ai_providers.id`
    entries: Mutex<HashMap<i64, Entry>>,
}

impl Default for Ai {
    fn default() -> Self {
        let http = reqwest::Client::builder()
            .user_agent(concat!("ouyang_web/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(Duration::from_secs(10))
            .read_timeout(READ_TIMEOUT)
            .build()
            .expect("failed to build http client");
        Self { http, entries: Mutex::default() }
    }
}

impl Ai {
    pub fn status(&self, id: i64) -> Status {
        self.entries.lock().unwrap().get(&id).map(|e| e.status.clone()).unwrap_or_default()
    }

    fn events(&self, id: i64) -> Vec<StatusEvent> {
        self.entries.lock().unwrap().get(&id).map(|e| e.events.iter().cloned().collect()).unwrap_or_default()
    }

    fn epoch(&self, id: i64) -> u64 {
        self.entries.lock().unwrap().get(&id).map_or(0, |e| e.epoch)
    }

    fn record(&self, id: i64, epoch: u64, health: Health, error: Option<String>, latency: Option<Duration>) {
        let mut entries = self.entries.lock().unwrap();
        let entry = entries.entry(id).or_default();
        if entry.epoch != epoch {
            return;
        }
        let at = now();
        let status = &mut entry.status;
        let changed = status.health != health;
        if changed {
            status.since = Some(at.clone());
            match health {
                Health::Down => tracing::warn!(id, error = error.as_deref().unwrap_or_default(), "AI service is down"),
                Health::Ok if status.health == Health::Down => tracing::info!(id, "AI service recovered"),
                _ => {}
            }
        }
        status.health = health;
        status.checked_at = Some(at.clone());
        if let Some(latency) = latency {
            status.latency_ms = Some(latency.as_millis() as u64);
        }
        // 異常時原因可能會變（例如從連不上變成金鑰錯誤），也記一筆
        let reason_changed = health == Health::Down && status.error != error;
        status.error = error.clone();
        if changed || reason_changed {
            entry.events.push_front(StatusEvent { at, health, error });
            entry.events.truncate(MAX_EVENTS);
        }
    }

    /// 設定改了：之前的結果作廢，等重新檢查
    fn reconfigured(&self, id: i64) {
        let mut entries = self.entries.lock().unwrap();
        let entry = entries.entry(id).or_default();
        entry.epoch += 1;
        entry.status = Status::default();
    }

    fn forget(&self, id: i64) {
        self.entries.lock().unwrap().remove(&id);
    }

    /// 打一次 `GET /models`，更新這一組的狀態
    pub async fn check(&self, provider: &Provider) {
        let epoch = self.epoch(provider.id);
        let started = Instant::now();
        let (health, error, latency) = match self.list_models(provider).await {
            Ok(models) if models.iter().any(|m| m.id == provider.model) => (Health::Ok, None, Some(started.elapsed())),
            Ok(models) => {
                let names = models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>().join("、");
                let names = if names.is_empty() { "無".to_owned() } else { names };
                (Health::Down, Some(format!("伺服器上沒有模型 {}（現有：{names}）", provider.model)), None)
            }
            Err(error) => (Health::Down, Some(error), None),
        };
        self.record(provider.id, epoch, health, error, latency);
    }

    /// 每一組都檢查一次（同時進行），刪掉的就不再記
    pub async fn check_all(&self, pool: &SqlitePool) {
        let providers = match list_providers(pool).await {
            Ok(providers) => providers,
            Err(err) => return tracing::warn!(error = %err, "failed to load AI providers"),
        };
        self.entries.lock().unwrap().retain(|id, _| providers.iter().any(|p| p.id == *id));
        futures_util::future::join_all(providers.iter().map(|p| self.check(p))).await;
    }

    async fn list_models(&self, provider: &Provider) -> Result<Vec<ModelInfo>, String> {
        let response = provider
            .request(&self.http, reqwest::Method::GET, "models")
            .timeout(CHECK_TIMEOUT)
            .send()
            .await
            .map_err(|err| describe_request_error(&err))?;
        if !response.status().is_success() {
            return Err(describe_status(response).await);
        }
        let body: Value =
            response.json().await.map_err(|err| format!("回應不是模型清單：{}", describe_request_error(&err)))?;
        let models = body["data"]
            .as_array()
            .ok_or("回應不是模型清單（沒有 data）")?
            .iter()
            .filter_map(|m| {
                Some(ModelInfo { id: m["id"].as_str()?.to_owned(), max_model_len: m["max_model_len"].as_u64() })
            })
            .collect();
        Ok(models)
    }

    /// 用全站使用中的那一組開始一次對話，回傳一段一段的結果；最後一定是 [`Event::Done`] 或 [`Event::Error`]。
    /// 連不上、金鑰錯或上游回錯誤時直接回 `Err`，同時把狀態標成異常，前端的 AI 功能會馬上顯示。
    /// 收的那一端關掉（例如使用者離開頁面）時，會一起斷開和上游的連線，上游就不會繼續生成。
    pub async fn stream(
        self: &Arc<Self>,
        pool: &SqlitePool,
        messages: &[Message],
        options: &ChatOptions,
    ) -> Result<mpsc::Receiver<Event>, AiError> {
        let provider = active_provider(pool).await?.ok_or(AiError::NotConfigured)?;
        self.stream_on(&provider, messages, options).await
    }

    /// 用指定的那一組對話（管理頁測試用）
    pub async fn stream_on(
        self: &Arc<Self>,
        provider: &Provider,
        messages: &[Message],
        options: &ChatOptions,
    ) -> Result<mpsc::Receiver<Event>, AiError> {
        let id = provider.id;
        let epoch = self.epoch(id);
        let mut body = json!({
            "model": provider.model,
            "messages": messages,
            "stream": true,
            "stream_options": { "include_usage": true },
        });
        if let Some(thinking) = options.thinking {
            // vLLM 的 Qwen3 等模型用這個開關思考模式；其他伺服器不一定認得，所以只有指定時才送
            body["chat_template_kwargs"] = json!({ "enable_thinking": thinking });
        }
        if let Some(temperature) = options.temperature {
            body["temperature"] = json!(temperature);
        }
        if let Some(max_tokens) = options.max_tokens {
            body["max_tokens"] = json!(max_tokens);
        }

        let started = Instant::now();
        let request = provider.request(&self.http, reqwest::Method::POST, "chat/completions").json(&body);
        let response = match request.send().await {
            Ok(response) => response,
            Err(err) => {
                let error = describe_request_error(&err);
                self.record(id, epoch, Health::Down, Some(error.clone()), None);
                return Err(AiError::Unavailable(error));
            }
        };
        let status = response.status();
        if !status.is_success() {
            let error = describe_status(response).await;
            // 4xx 多半是這次的請求有問題（例如太長），服務本身還是好的；金鑰錯、找不到網址或伺服器錯誤才算掛掉
            let broken = status.is_server_error()
                || matches!(status, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN | StatusCode::NOT_FOUND);
            if broken {
                self.record(id, epoch, Health::Down, Some(error.clone()), None);
                return Err(AiError::Unavailable(error));
            }
            return Err(AiError::Rejected(error));
        }
        self.record(id, epoch, Health::Ok, None, Some(started.elapsed()));

        let (tx, rx) = mpsc::channel(64);
        let ai = self.clone();
        tokio::spawn(async move {
            if let Err(error) = relay(response, &tx).await {
                // 中途斷掉：上游卡住或掛了，也算異常
                ai.record(id, epoch, Health::Down, Some(error.clone()), None);
                let _ = tx.send(Event::Error { message: error }).await;
            }
        });
        Ok(rx)
    }

    /// 等整段回答完成。答案不含思考內容，思考另外放在 `reasoning`。
    pub async fn complete(
        self: &Arc<Self>,
        pool: &SqlitePool,
        messages: &[Message],
        options: &ChatOptions,
    ) -> Result<Completion, AiError> {
        let mut rx = self.stream(pool, messages, options).await?;
        let mut completion = Completion::default();
        while let Some(event) = rx.recv().await {
            match event {
                Event::Reasoning { text } => completion.reasoning.push_str(&text),
                Event::Content { text } => completion.content.push_str(&text),
                Event::Done { finish_reason, usage } => {
                    completion.finish_reason = finish_reason;
                    completion.usage = usage;
                    return Ok(completion);
                }
                Event::Error { message } => return Err(AiError::Unavailable(message)),
            }
        }
        Err(AiError::Unavailable("回應中斷".into()))
    }
}

/// 背景定時檢查每一組（改設定時 API 自己會馬上檢查那一組）
pub fn spawn(ai: Arc<Ai>, pool: SqlitePool) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(CHECK_EVERY);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tick.tick().await;
            ai.check_all(&pool).await;
        }
    });
}

// ---- 對話 ----

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Message {
    /// `system`、`user` 或 `assistant`
    pub role: String,
    pub content: String,
}

impl Message {
    pub fn new(role: &str, content: impl Into<String>) -> Self {
        Self { role: role.into(), content: content.into() }
    }
}

#[derive(Clone, Debug, Default)]
pub struct ChatOptions {
    /// `None` 用伺服器預設；`Some(false)` 關掉 Qwen3 這類模型的思考模式
    pub thinking: Option<bool>,
    pub temperature: Option<f32>,
    pub max_tokens: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Usage {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
}

/// 串流的每一段，也是 `/api/admin/ai/chat` 回給前端的每一行（NDJSON）
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Event {
    Reasoning { text: String },
    Content { text: String },
    Done { finish_reason: Option<String>, usage: Option<Usage> },
    Error { message: String },
}

#[derive(Clone, Debug, Default)]
pub struct Completion {
    pub content: String,
    pub reasoning: String,
    pub finish_reason: Option<String>,
    pub usage: Option<Usage>,
}

#[derive(Debug)]
pub enum AiError {
    NotConfigured,
    /// 連不上、金鑰錯、伺服器錯誤：服務本身有問題
    Unavailable(String),
    /// 服務正常，但不接受這次的請求（例如輸入太長）
    Rejected(String),
    Database(sqlx::Error),
}

impl From<sqlx::Error> for AiError {
    fn from(err: sqlx::Error) -> Self {
        Self::Database(err)
    }
}

impl AiError {
    /// 給管理員看的完整原因
    pub fn detail(&self) -> String {
        match self {
            Self::NotConfigured => "還沒選擇全站使用哪一組 AI 設定".into(),
            Self::Unavailable(error) => format!("AI 服務無法使用：{error}"),
            Self::Rejected(error) => format!("AI 服務拒絕這次的請求：{error}"),
            Self::Database(err) => format!("database error: {err}"),
        }
    }
}

/// 給一般使用者的 AI 功能用：不透露上游的網址和錯誤細節（細節在管理頁看得到）
impl From<AiError> for AppError {
    fn from(err: AiError) -> Self {
        match err {
            AiError::NotConfigured => AppError::ServiceUnavailable("AI 功能尚未開放"),
            AiError::Unavailable(_) => AppError::ServiceUnavailable("AI 服務暫時無法使用，請稍後再試"),
            AiError::Rejected(_) => AppError::BadRequest("AI 無法處理這個請求，內容可能太長".into()),
            AiError::Database(err) => AppError::Database(err),
        }
    }
}

/// 讀上游的 SSE（`data: {...}` 一行一則，`data: [DONE]` 結束），轉成 [`Event`] 送出去。
/// 收的那一端關掉就回 `Ok` 結束，回應被丟掉時連線也跟著斷。
async fn relay(mut response: reqwest::Response, tx: &mpsc::Sender<Event>) -> Result<(), String> {
    let mut parser = SseParser::default();
    loop {
        let chunk = match response.chunk().await {
            Ok(Some(chunk)) => chunk,
            Ok(None) => break,
            Err(err) => return Err(format!("回應中斷：{}", describe_request_error(&err))),
        };
        for event in parser.push(&chunk)? {
            if tx.send(event).await.is_err() {
                return Ok(());
            }
        }
        if parser.done {
            break;
        }
    }
    for event in parser.finish() {
        if tx.send(event).await.is_err() {
            break;
        }
    }
    Ok(())
}

#[derive(Default)]
struct SseParser {
    /// 還沒收到換行的部分（UTF-8 字元可能被切在兩段中間，所以先存位元組）
    line: Vec<u8>,
    think: ThinkSplitter,
    finish_reason: Option<String>,
    usage: Option<Usage>,
    done: bool,
}

impl SseParser {
    fn push(&mut self, bytes: &[u8]) -> Result<Vec<Event>, String> {
        let mut events = Vec::new();
        for &byte in bytes {
            if byte != b'\n' {
                self.line.push(byte);
                continue;
            }
            let line = String::from_utf8_lossy(&self.line).trim_end_matches('\r').to_owned();
            self.line.clear();
            let Some(data) = line.strip_prefix("data:") else { continue };
            let data = data.trim();
            if data == "[DONE]" {
                self.done = true;
                break;
            }
            let Ok(chunk) = serde_json::from_str::<Value>(data) else { continue };
            if let Some(message) = chunk["error"]["message"].as_str().or(chunk["error"].as_str()) {
                return Err(message.to_owned());
            }
            if let Some(usage) = chunk.get("usage").and_then(|u| serde_json::from_value::<Usage>(u.clone()).ok()) {
                self.usage = Some(usage);
            }
            let Some(choice) = chunk["choices"].get(0) else { continue };
            if let Some(reason) = choice["finish_reason"].as_str() {
                self.finish_reason = Some(reason.to_owned());
            }
            let delta = &choice["delta"];
            // vLLM 舊版叫 reasoning_content，新版叫 reasoning
            let reasoning = delta["reasoning_content"].as_str().or(delta["reasoning"].as_str());
            if let Some(text) = reasoning.filter(|t| !t.is_empty()) {
                events.push(Event::Reasoning { text: text.to_owned() });
            }
            if let Some(text) = delta["content"].as_str() {
                let (reasoning, content) = self.think.push(text);
                push_text(&mut events, reasoning, content);
            }
        }
        Ok(events)
    }

    fn finish(&mut self) -> Vec<Event> {
        let mut events = Vec::new();
        let (reasoning, content) = self.think.finish();
        push_text(&mut events, reasoning, content);
        events.push(Event::Done { finish_reason: self.finish_reason.take(), usage: self.usage.take() });
        events
    }
}

fn push_text(events: &mut Vec<Event>, reasoning: String, content: String) {
    if !reasoning.is_empty() {
        events.push(Event::Reasoning { text: reasoning });
    }
    if !content.is_empty() {
        events.push(Event::Content { text: content });
    }
}

const THINK_OPEN: &str = "<think>";
const THINK_CLOSE: &str = "</think>";

#[derive(Default, Clone, Copy, PartialEq, Eq)]
enum ThinkMode {
    /// 還不知道開頭是不是 `<think>`
    #[default]
    Start,
    Think,
    /// 剛結束思考，跳過接下來的空白
    AfterThink,
    Answer,
}

/// 伺服器沒有開 reasoning parser 時，思考會以 `<think>…</think>` 放在答案最前面，這裡把它拆出來。
/// 標籤可能被切在兩段中間，所以結尾可能是標籤一部分的字先留著。
#[derive(Default)]
struct ThinkSplitter {
    mode: ThinkMode,
    pending: String,
}

impl ThinkSplitter {
    /// 回傳（思考, 答案）
    fn push(&mut self, text: &str) -> (String, String) {
        self.pending.push_str(text);
        let mut reasoning = String::new();
        let mut answer = String::new();
        loop {
            match self.mode {
                ThinkMode::Start => {
                    let trimmed = self.pending.trim_start();
                    if let Some(rest) = trimmed.strip_prefix(THINK_OPEN) {
                        self.pending = rest.to_owned();
                        self.mode = ThinkMode::Think;
                    } else if THINK_OPEN.starts_with(trimmed) {
                        break;
                    } else {
                        self.mode = ThinkMode::Answer;
                    }
                }
                ThinkMode::Think => {
                    if let Some(end) = self.pending.find(THINK_CLOSE) {
                        reasoning.push_str(&self.pending[..end]);
                        self.pending.drain(..end + THINK_CLOSE.len());
                        self.mode = ThinkMode::AfterThink;
                    } else {
                        let cut = self.pending.len() - partial_suffix(&self.pending, THINK_CLOSE);
                        reasoning.push_str(&self.pending[..cut]);
                        self.pending.drain(..cut);
                        break;
                    }
                }
                ThinkMode::AfterThink => {
                    let trimmed = self.pending.trim_start();
                    if trimmed.is_empty() {
                        self.pending.clear();
                        break;
                    }
                    self.pending = trimmed.to_owned();
                    self.mode = ThinkMode::Answer;
                }
                ThinkMode::Answer => {
                    answer.push_str(&self.pending);
                    self.pending.clear();
                    break;
                }
            }
        }
        (reasoning, answer)
    }

    fn finish(&mut self) -> (String, String) {
        let rest = std::mem::take(&mut self.pending);
        if self.mode == ThinkMode::Think { (rest, String::new()) } else { (String::new(), rest) }
    }
}

/// `text` 結尾有幾個字元可能是 `tag` 的開頭（`tag` 是 ASCII，切在這裡不會切壞中文字）
fn partial_suffix(text: &str, tag: &str) -> usize {
    (1..tag.len()).rev().find(|&n| text.ends_with(&tag[..n])).unwrap_or(0)
}

fn describe_request_error(err: &reqwest::Error) -> String {
    let kind = if err.is_timeout() {
        "連線逾時"
    } else if err.is_connect() {
        "連不上伺服器"
    } else if err.is_decode() {
        "回應格式不對"
    } else {
        "請求失敗"
    };
    // 最底層的原因最有用（例如 Connection refused），reqwest 自己的訊息裡有網址，不重複
    let mut source = err.source();
    let mut cause = None;
    while let Some(err) = source {
        cause = Some(err.to_string());
        source = err.source();
    }
    match cause {
        Some(cause) => format!("{kind}（{cause}）"),
        None => kind.to_owned(),
    }
}

async fn describe_status(response: reqwest::Response) -> String {
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    // OpenAI 相容的錯誤格式是 {"error":{"message":…}}，vLLM 有時是 {"message":…}
    let message = serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|v| {
            v["error"]["message"]
                .as_str()
                .or(v["error"].as_str())
                .or(v["message"].as_str())
                .or(v["detail"].as_str())
                .map(String::from)
        })
        .unwrap_or(body);
    let message: String = message.trim().chars().take(MAX_ERROR_BODY).collect();
    let hint = match status {
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => "金鑰錯誤",
        StatusCode::NOT_FOUND => "找不到，網址是否少了 /v1？",
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

// ---- API ----

#[derive(Serialize)]
pub struct PublicStatus {
    /// 管理員有沒有選一組給全站用；沒有的話 AI 功能整個不開放
    pub configured: bool,
    pub available: bool,
    pub since: Option<String>,
    pub checked_at: Option<String>,
}

/// 給前端的 AI 功能看現在能不能用，不用登入，不含錯誤細節
pub async fn public_status(State(state): State<AppState>) -> Result<Json<PublicStatus>, AppError> {
    let Some(provider) = active_provider(&state.pool).await? else {
        return Ok(Json(PublicStatus { configured: false, available: false, since: None, checked_at: None }));
    };
    let status = state.ai.status(provider.id);
    Ok(Json(PublicStatus {
        configured: true,
        available: status.health.usable(),
        since: status.since,
        checked_at: status.checked_at,
    }))
}

#[derive(Serialize)]
pub struct ProviderView {
    pub id: i64,
    pub name: String,
    pub base_url: String,
    pub model: String,
    /// 金鑰的最後 4 碼（`…abcd`），沒設定是 null；完整的金鑰不會傳出去
    pub key_hint: Option<String>,
    pub status: Status,
    pub events: Vec<StatusEvent>,
}

#[derive(Serialize)]
pub struct AdminView {
    /// 全站使用中的是哪一組，null 是不開放 AI 功能
    pub active_id: Option<i64>,
    pub providers: Vec<ProviderView>,
}

async fn admin_view(state: &AppState) -> Result<AdminView, AppError> {
    let providers = list_providers(&state.pool).await?;
    let active_id = active_id(&state.pool).await?.filter(|id| providers.iter().any(|p| p.id == *id));
    let providers = providers
        .into_iter()
        .map(|p| ProviderView {
            key_hint: p.key_hint(),
            status: state.ai.status(p.id),
            events: state.ai.events(p.id),
            id: p.id,
            name: p.name,
            base_url: p.base_url,
            model: p.model,
        })
        .collect();
    Ok(AdminView { active_id, providers })
}

pub async fn admin_get(_: Require<AdminUsers>, State(state): State<AppState>) -> Result<Json<AdminView>, AppError> {
    Ok(Json(admin_view(&state).await?))
}

/// 網址統一成不含結尾 `/` 的樣子
fn normalize_base_url(input: &str) -> Result<String, AppError> {
    let url = input.trim().trim_end_matches('/');
    if url.is_empty() {
        return Err(AppError::BadRequest("請填網址".into()));
    }
    if url.len() > MAX_URL_LEN {
        return Err(AppError::BadRequest("網址太長".into()));
    }
    let parsed = Url::parse(url).map_err(|_| AppError::BadRequest("網址格式不對，例如 http://host:port/v1".into()))?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err(AppError::BadRequest("網址要是 http:// 或 https:// 開頭".into()));
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err(AppError::BadRequest("網址不能有 ? 或 #".into()));
    }
    Ok(url.to_owned())
}

#[derive(Deserialize)]
pub struct ProviderInput {
    pub name: String,
    pub base_url: String,
    pub model: String,
    /// 修改時沒給（null）就沿用原本的金鑰，空字串是清掉
    #[serde(default)]
    pub api_key: Option<String>,
}

struct ValidInput {
    name: String,
    base_url: String,
    model: String,
    api_key: Option<String>,
}

fn validate(input: ProviderInput) -> Result<ValidInput, AppError> {
    let name = input.name.trim();
    if name.is_empty() || name.chars().count() > MAX_NAME_LEN {
        return Err(AppError::BadRequest(format!("名稱要 1 到 {MAX_NAME_LEN} 字")));
    }
    let model = input.model.trim();
    if model.is_empty() {
        return Err(AppError::BadRequest("請選擇模型".into()));
    }
    if model.chars().count() > MAX_MODEL_LEN {
        return Err(AppError::BadRequest("模型名稱太長".into()));
    }
    let api_key = input.api_key.map(|key| key.trim().to_owned());
    if api_key.as_ref().is_some_and(|key| key.len() > MAX_KEY_LEN) {
        return Err(AppError::BadRequest("金鑰太長".into()));
    }
    Ok(ValidInput { name: name.into(), base_url: normalize_base_url(&input.base_url)?, model: model.into(), api_key })
}

/// 新增一組並馬上檢查；還沒有使用中的話，第一組直接設成使用中
pub async fn admin_create(
    _: Require<AdminUsers>,
    State(state): State<AppState>,
    Json(input): Json<ProviderInput>,
) -> Result<(StatusCode, Json<AdminView>), AppError> {
    let input = validate(input)?;
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ai_providers").fetch_one(&state.pool).await?;
    if count >= MAX_PROVIDERS {
        return Err(AppError::BadRequest(format!("最多 {MAX_PROVIDERS} 組")));
    }
    let provider: Provider = sqlx::query_as(
        "INSERT INTO ai_providers (name, base_url, api_key, model) VALUES (?, ?, ?, ?)
         RETURNING id, name, base_url, api_key, model",
    )
    .bind(&input.name)
    .bind(&input.base_url)
    .bind(input.api_key.unwrap_or_default())
    .bind(&input.model)
    .fetch_one(&state.pool)
    .await?;
    if active_provider(&state.pool).await?.is_none() {
        set_active(&state.pool, Some(provider.id)).await?;
    }
    state.ai.reconfigured(provider.id);
    state.ai.check(&provider).await;
    Ok((StatusCode::CREATED, Json(admin_view(&state).await?)))
}

/// 修改並馬上檢查，回傳的狀態就是新設定的結果
pub async fn admin_update(
    _: Require<AdminUsers>,
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(input): Json<ProviderInput>,
) -> Result<Json<AdminView>, AppError> {
    let input = validate(input)?;
    let mut provider = find_provider(&state.pool, id).await?.ok_or(AppError::NotFound)?;
    provider.name = input.name;
    provider.base_url = input.base_url;
    provider.model = input.model;
    if let Some(key) = input.api_key {
        provider.api_key = key;
    }
    sqlx::query("UPDATE ai_providers SET name = ?, base_url = ?, api_key = ?, model = ? WHERE id = ?")
        .bind(&provider.name)
        .bind(&provider.base_url)
        .bind(&provider.api_key)
        .bind(&provider.model)
        .bind(id)
        .execute(&state.pool)
        .await?;
    state.ai.reconfigured(id);
    state.ai.check(&provider).await;
    Ok(Json(admin_view(&state).await?))
}

/// 使用中的那一組不能刪，要先切到別組或停用
pub async fn admin_delete(
    _: Require<AdminUsers>,
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<StatusCode, AppError> {
    if active_id(&state.pool).await? == Some(id) {
        return Err(AppError::Conflict("這一組正在使用中，先切換到別組或停用 AI 再刪除".into()));
    }
    let result = sqlx::query("DELETE FROM ai_providers WHERE id = ?").bind(id).execute(&state.pool).await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    state.ai.forget(id);
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct ActiveInput {
    /// null 是停用全站的 AI 功能
    pub id: Option<i64>,
}

/// 切換全站使用哪一組
pub async fn admin_set_active(
    _: Require<AdminUsers>,
    State(state): State<AppState>,
    Json(input): Json<ActiveInput>,
) -> Result<Json<AdminView>, AppError> {
    if let Some(id) = input.id {
        find_provider(&state.pool, id).await?.ok_or(AppError::NotFound)?;
    }
    set_active(&state.pool, input.id).await?;
    Ok(Json(admin_view(&state).await?))
}

/// 每一組立刻重新檢查一次
pub async fn admin_check(_: Require<AdminUsers>, State(state): State<AppState>) -> Result<Json<AdminView>, AppError> {
    state.ai.check_all(&state.pool).await;
    Ok(Json(admin_view(&state).await?))
}

#[derive(Deserialize)]
pub struct ModelsInput {
    pub base_url: String,
    /// 沒給就用 `provider_id` 那一組存著的金鑰
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub provider_id: Option<i64>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ModelInfo {
    pub id: String,
    pub max_model_len: Option<u64>,
}

/// 用還沒存的網址和金鑰列出模型，讓管理員存之前先選。上游的錯誤原因整段回給管理員，用 502 跟一般的錯誤分開。
pub async fn admin_models(
    _: Require<AdminUsers>,
    State(state): State<AppState>,
    Json(input): Json<ModelsInput>,
) -> Result<Response, AppError> {
    let base_url = normalize_base_url(&input.base_url)?;
    let api_key = match (input.api_key, input.provider_id) {
        (Some(key), _) => key.trim().to_owned(),
        // 存著的金鑰只送到原本的網址，免得改了網址還沒填新金鑰時把舊的送到別的地方
        (None, Some(id)) => find_provider(&state.pool, id)
            .await?
            .filter(|p| p.base_url == base_url)
            .map(|p| p.api_key)
            .unwrap_or_default(),
        (None, None) => String::new(),
    };
    let provider = Provider { id: 0, name: String::new(), base_url, api_key, model: String::new() };
    Ok(match state.ai.list_models(&provider).await {
        Ok(models) => Json(json!({ "models": models })).into_response(),
        Err(error) => (StatusCode::BAD_GATEWAY, Json(json!({ "error": error }))).into_response(),
    })
}

#[derive(Deserialize)]
pub struct ChatInput {
    /// 用哪一組，沒給就是使用中的那一組
    #[serde(default)]
    pub provider_id: Option<i64>,
    pub messages: Vec<Message>,
    #[serde(default)]
    pub thinking: Option<bool>,
}

/// 管理頁的測試對話：結果一行一個 JSON（[`Event`]）串流回去，出錯時回完整的原因
pub async fn admin_chat(
    _: Require<AdminUsers>,
    State(state): State<AppState>,
    Json(input): Json<ChatInput>,
) -> Result<Response, AppError> {
    if input.messages.is_empty() || input.messages.len() > MAX_MESSAGES {
        return Err(AppError::BadRequest(format!("對話要有 1 到 {MAX_MESSAGES} 則")));
    }
    if input.messages.iter().any(|m| !matches!(m.role.as_str(), "system" | "user" | "assistant")) {
        return Err(AppError::BadRequest("role 只能是 system、user、assistant".into()));
    }
    if input.messages.last().is_some_and(|m| m.role != "user") {
        return Err(AppError::BadRequest("最後一則要是使用者的訊息".into()));
    }
    if input.messages.iter().map(|m| m.content.chars().count()).sum::<usize>() > MAX_CHAT_CHARS {
        return Err(AppError::BadRequest("對話太長".into()));
    }

    let provider = match input.provider_id {
        Some(id) => find_provider(&state.pool, id).await?.ok_or(AppError::NotFound)?,
        None => {
            active_provider(&state.pool).await?.ok_or_else(|| AppError::BadRequest(AiError::NotConfigured.detail()))?
        }
    };
    let options = ChatOptions { thinking: input.thinking, ..ChatOptions::default() };
    match state.ai.stream_on(&provider, &input.messages, &options).await {
        Ok(rx) => Ok(ndjson(rx)),
        Err(AiError::Database(err)) => Err(err.into()),
        Err(err) => {
            let status = if matches!(err, AiError::Rejected(_)) {
                StatusCode::BAD_GATEWAY
            } else {
                StatusCode::SERVICE_UNAVAILABLE
            };
            Ok((status, Json(json!({ "error": err.detail() }))).into_response())
        }
    }
}

/// 把 [`Event`] 一行一個 JSON 串流給前端（`frontend/src/ai/api.ts` 的 `streamChat`）
pub fn ndjson(rx: mpsc::Receiver<Event>) -> Response {
    let lines = futures_util::stream::unfold(rx, |mut rx| async move {
        let event = rx.recv().await?;
        let mut line = serde_json::to_string(&event).unwrap_or_default();
        line.push('\n');
        Some((Ok::<_, std::convert::Infallible>(Bytes::from(line)), rx))
    });
    (
        [
            (header::CONTENT_TYPE, "application/x-ndjson; charset=utf-8"),
            (header::CACHE_CONTROL, "no-cache"),
            // 反向代理不要攢著，一段一段馬上送
            (header::HeaderName::from_static("x-accel-buffering"), "no"),
        ],
        Body::from_stream(lines),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn split_all(chunks: &[&str]) -> (String, String) {
        let mut splitter = ThinkSplitter::default();
        let (mut reasoning, mut answer) = (String::new(), String::new());
        for chunk in chunks {
            let (r, a) = splitter.push(chunk);
            reasoning += &r;
            answer += &a;
        }
        let (r, a) = splitter.finish();
        (reasoning + &r, answer + &a)
    }

    #[test]
    fn plain_answer_passes_through() {
        assert_eq!(split_all(&["你好", "，世界"]), (String::new(), "你好，世界".into()));
        assert_eq!(split_all(&["<b>粗體</b>"]), (String::new(), "<b>粗體</b>".into()));
    }

    #[test]
    fn think_tags_are_split_even_across_chunks() {
        let expected = ("先想一下".to_owned(), "答案".to_owned());
        assert_eq!(split_all(&["<think>先想一下</think>\n\n答案"]), expected);
        assert_eq!(split_all(&["\n<th", "ink>先想", "一下</th", "ink>", "\n", "\n答", "案"]), expected);
    }

    #[test]
    fn unfinished_think_counts_as_reasoning() {
        assert_eq!(split_all(&["<think>想到一半"]), ("想到一半".into(), String::new()));
        assert_eq!(split_all(&["<thi"]), (String::new(), "<thi".into()));
    }

    #[test]
    fn sse_lines_become_events() {
        let mut parser = SseParser::default();
        let chunk = |delta: Value| format!("data: {}\n\n", json!({ "choices": [{ "delta": delta }] }));
        let stream = [
            chunk(json!({ "role": "assistant", "content": "" })),
            chunk(json!({ "reasoning_content": "想" })),
            chunk(json!({ "reasoning": "想想" })),
            chunk(json!({ "content": "你好" })),
            format!("data: {}\n\n", json!({ "choices": [{ "delta": {}, "finish_reason": "stop" }] })),
            format!("data: {}\n\n", json!({ "choices": [], "usage": { "prompt_tokens": 5, "completion_tokens": 3 } })),
            "data: [DONE]\n\n".to_owned(),
        ]
        .concat();
        // 一個位元組一個位元組餵，確認中文字被切開也沒事
        let mut events = Vec::new();
        for byte in stream.as_bytes() {
            events.extend(parser.push(&[*byte]).unwrap());
        }
        assert!(parser.done);
        events.extend(parser.finish());
        assert_eq!(
            events,
            vec![
                Event::Reasoning { text: "想".into() },
                Event::Reasoning { text: "想想".into() },
                Event::Content { text: "你好".into() },
                Event::Done {
                    finish_reason: Some("stop".into()),
                    usage: Some(Usage { prompt_tokens: 5, completion_tokens: 3 })
                },
            ]
        );
    }

    #[test]
    fn sse_error_stops_the_stream() {
        let mut parser = SseParser::default();
        let error = parser.push(b"data: {\"error\":{\"message\":\"out of memory\"}}\n\n").unwrap_err();
        assert_eq!(error, "out of memory");
    }

    #[test]
    fn base_url_is_normalized() {
        assert_eq!(normalize_base_url(" http://1.2.3.4:15002/v1/ ").unwrap(), "http://1.2.3.4:15002/v1");
        assert!(normalize_base_url(" ").is_err());
        assert!(normalize_base_url("ftp://host/v1").is_err());
        assert!(normalize_base_url("host:15002/v1").is_err());
        assert!(normalize_base_url("http://host/v1?x=1").is_err());
    }
}
