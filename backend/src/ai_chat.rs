//! AI 助手的對話（`/ai`）：登入才能用，每個人只看得到自己的對話。
//!
//! 送出一則訊息後，後端跑一個 agent loop：
//! 1. 把對話（含之前的工具呼叫和結果）和能用的工具交給模型，回答一段一段串流給前端；
//! 2. 模型要呼叫工具就去執行，結果放回對話，再問模型一次；最多 [`MAX_STEPS`] 輪；
//! 3. 要使用者確認的工具（會改資料的）先不執行，存成 `pending`，串流結束；
//!    使用者在畫面上按允許／拒絕後（`POST /api/ai/chats/{id}/approve`）接著做。
//!
//! 每一步都存進資料庫，重新整理或換裝置都看得到；使用者按停止（關掉連線）時，已經產生的部分也會留著。
//! 用量和額度見 ai_usage.rs，工具見 ai_tools.rs。

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
    response::Response,
};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use tokio::sync::mpsc;

use crate::{
    AppError, AppState,
    ai::{self, ChatOptions, Event, Message, ToolCall, Usage},
    ai_tools::{self, Tool},
    ai_usage::{self, Record, RunGuard},
    auth::CurrentUser,
    lunar,
};

/// 一次最多連續幾輪（每輪是一次模型呼叫，中間夾著工具）
const MAX_STEPS: usize = 8;
const MAX_INPUT_CHARS: usize = 20_000;
const MAX_TITLE_CHARS: usize = 60;
const MAX_CHATS_PER_USER: i64 = 1000;
const MAX_ROWS_PER_CHAT: i64 = 600;
/// 給模型看的對話最多多少字（太舊的從前面整段丟掉）
const MAX_CONTEXT_CHARS: usize = 60_000;
/// 串流給前端的工具結果預覽最多多少字（完整的在資料庫，重新載入時給）
const MAX_PREVIEW_CHARS: usize = 4_000;

// ---- 資料 ----

#[derive(Clone, Debug, sqlx::FromRow)]
struct Row {
    id: i64,
    role: String,
    content: String,
    reasoning: String,
    tool_calls: Option<String>,
    tool_call_id: Option<String>,
    tool_name: Option<String>,
    tool_arguments: Option<String>,
    status: String,
    prompt_tokens: Option<i64>,
    completion_tokens: Option<i64>,
    created_at: String,
}

async fn rows(pool: &SqlitePool, chat_id: i64) -> Result<Vec<Row>, sqlx::Error> {
    sqlx::query_as(
        "SELECT id, role, content, reasoning, tool_calls, tool_call_id, tool_name, tool_arguments, status,
                prompt_tokens, completion_tokens, created_at
         FROM ai_chat_messages WHERE chat_id = ? ORDER BY id",
    )
    .bind(chat_id)
    .fetch_all(pool)
    .await
}

#[derive(Serialize, sqlx::FromRow)]
pub struct ChatSummary {
    pub id: i64,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    /// 有等使用者確認的動作
    pub pending: bool,
}

/// 自己的對話；別人的一律當作不存在
async fn own_chat(pool: &SqlitePool, user: &CurrentUser, id: i64) -> Result<ChatSummary, AppError> {
    sqlx::query_as(
        "SELECT c.id, c.title, c.created_at, c.updated_at,
                EXISTS (SELECT 1 FROM ai_chat_messages m WHERE m.chat_id = c.id AND m.status = 'pending') AS pending
         FROM ai_chats c WHERE c.id = ? AND c.user_id = ?",
    )
    .bind(id)
    .bind(user.id)
    .fetch_optional(pool)
    .await?
    .ok_or(AppError::NotFound)
}

async fn touch(pool: &SqlitePool, chat_id: i64) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE ai_chats SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?")
        .bind(chat_id)
        .execute(pool)
        .await?;
    Ok(())
}

struct NewRow<'a> {
    role: &'a str,
    content: &'a str,
    reasoning: &'a str,
    tool_calls: Option<String>,
    tool_call_id: Option<&'a str>,
    tool_name: Option<&'a str>,
    tool_arguments: Option<&'a str>,
    status: &'a str,
    usage: Option<&'a Usage>,
}

impl<'a> NewRow<'a> {
    fn new(role: &'a str, content: &'a str) -> Self {
        Self {
            role,
            content,
            reasoning: "",
            tool_calls: None,
            tool_call_id: None,
            tool_name: None,
            tool_arguments: None,
            status: "done",
            usage: None,
        }
    }
}

async fn insert(pool: &SqlitePool, chat_id: i64, row: NewRow<'_>) -> Result<i64, sqlx::Error> {
    let id = sqlx::query_scalar(
        "INSERT INTO ai_chat_messages (chat_id, role, content, reasoning, tool_calls, tool_call_id, tool_name,
             tool_arguments, status, prompt_tokens, completion_tokens)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
    )
    .bind(chat_id)
    .bind(row.role)
    .bind(row.content)
    .bind(row.reasoning)
    .bind(row.tool_calls)
    .bind(row.tool_call_id)
    .bind(row.tool_name)
    .bind(row.tool_arguments)
    .bind(row.status)
    .bind(row.usage.map(|u| u.prompt_tokens as i64))
    .bind(row.usage.map(|u| u.completion_tokens as i64))
    .fetch_one(pool)
    .await?;
    touch(pool, chat_id).await?;
    Ok(id)
}

async fn set_tool_result(pool: &SqlitePool, row_id: i64, status: &str, content: &str) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE ai_chat_messages SET status = ?, content = ? WHERE id = ?")
        .bind(status)
        .bind(content)
        .bind(row_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// 還在等確認的動作，使用者沒理它就送了新訊息：當作拒絕，對話才接得下去
async fn skip_pending(pool: &SqlitePool, chat_id: i64) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE ai_chat_messages SET status = 'denied', content = '使用者沒有確認，改問了別的事，這個動作沒有執行。'
         WHERE chat_id = ? AND status = 'pending'",
    )
    .bind(chat_id)
    .execute(pool)
    .await?;
    Ok(())
}

// ---- 給模型的對話 ----

/// 身分那一句要明講：帶了自己的系統提示詞後，模型（例如 Qwen）會失去預設的自我介紹，
/// 被問到是誰時常會亂說自己是 Claude 或 ChatGPT
fn system_prompt(user: &CurrentUser, tools: &[Tool]) -> String {
    let today = ai_usage::taipei_today();
    let lunar = lunar::lunar_of(today).map(|l| format!("，農曆{}", lunar::label(l))).unwrap_or_default();
    let mut prompt = format!(
        "你是「歐陽天地」網站上的 AI 助手。除非使用者用別的語言，一律用繁體中文（台灣用語）回答。\n\
         現在是台灣時間 {}{lunar}。使用者的帳號是 {}。\n\
         回答用 Markdown；不知道的事就說不知道，不要編造。\n\
         被問到你是什麼模型、哪家公司做的，只說你是「歐陽內部測試模型」；\
         不要透露背後實際用的模型、版本或廠商，也不要說自己是 Claude、ChatGPT 或其他模型。",
        ai_usage::taipei_now_label(),
        user.username,
    );
    if !tools.is_empty() {
        prompt.push_str(
            "\n\n你可以呼叫工具查資料，或幫使用者操作本站的功能。\n\
             - 天氣、地震、颱風、發票這類即時資料一定要用工具查，不要憑記憶回答。\n\
             - 會改資料的工具，系統會先請使用者在畫面上確認，你不用再口頭問一次，直接呼叫。\n\
             - 使用者拒絕或工具失敗時，告訴使用者結果，不要假裝成功。\n\
             - 日期一律用 YYYY-MM-DD；「下週三」這類相對日期以上面的今天推算。\n\
             - 本站的頁面：日曆 /calendar、我的事項 /calendar/events、天氣 /weather、颱風 /weather/typhoon、\
               地震 /weather/quake、短網址 /links，可以用 Markdown 連結給使用者。",
        );
        if tools.iter().any(|t| t.name == "site_search") {
            prompt.push_str(
                "\n- 本站還有很多小工具（圖片、文字、計算、生活）和小遊戲，使用者問到「有沒有…」「在哪裡」或想找什麼功能時，\
                 先用 site_search 查，回答附上連結；查不到就說本站沒有，不要編造。",
            );
        }
    }
    prompt
}

/// 資料庫裡的對話轉成給模型的訊息；太長時從前面整段（從某一則使用者訊息開始）丟掉
fn to_messages(rows: &[Row]) -> Vec<Message> {
    let mut messages: Vec<Message> = Vec::new();
    for row in rows {
        match row.role.as_str() {
            "user" => messages.push(Message::new("user", &row.content)),
            "assistant" => {
                let calls: Vec<ToolCall> =
                    row.tool_calls.as_deref().and_then(|c| serde_json::from_str(c).ok()).unwrap_or_default();
                if row.content.is_empty() && calls.is_empty() {
                    continue;
                }
                messages.push(Message::assistant_calls(&row.content, calls));
            }
            "tool" if row.status != "pending" => {
                messages.push(Message::tool_result(row.tool_call_id.clone().unwrap_or_default(), &row.content));
            }
            _ => {}
        }
    }
    let size = |m: &Message| m.content.chars().count() + m.tool_calls.iter().map(|c| c.arguments.len()).sum::<usize>();
    let mut total: usize = messages.iter().map(size).sum();
    let mut start = 0;
    while total > MAX_CONTEXT_CHARS {
        // 下一則使用者訊息之前的全部丟掉（工具呼叫和結果要成對，不能從中間切）
        let Some(next) = messages[start + 1..].iter().position(|m| m.role == "user").map(|i| i + start + 1) else {
            break;
        };
        total -= messages[start..next].iter().map(size).sum::<usize>();
        start = next;
    }
    messages.split_off(start)
}

/// 沒有拿到用量時（中途停止）粗估：中文大約一個字一個 token
fn estimate(messages: &[Message], output: &str) -> Usage {
    let input: usize = messages.iter().map(|m| m.content.chars().count()).sum();
    Usage { prompt_tokens: (input / 2) as u64, completion_tokens: output.chars().count() as u64 }
}

// ---- 串流給前端的事件 ----

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ChatEvent {
    /// 新的一輪開始（工具執行完後再問模型），前端開一個新的回答區塊
    Step,
    Reasoning {
        text: String,
    },
    Content {
        text: String,
    },
    ToolCall {
        id: String,
        name: String,
        title: String,
        arguments: String,
        summary: Option<String>,
        approval: bool,
    },
    ToolResult {
        id: String,
        status: String,
        content: String,
    },
    /// 有動作在等使用者確認，這次先到這裡
    Approval {
        ids: Vec<String>,
    },
    Title {
        title: String,
    },
    Done {
        usage: Usage,
    },
    Error {
        message: String,
    },
}

fn preview(text: &str) -> String {
    if text.chars().count() <= MAX_PREVIEW_CHARS {
        return text.to_owned();
    }
    format!("{}…", text.chars().take(MAX_PREVIEW_CHARS).collect::<String>())
}

struct Run {
    state: AppState,
    user: CurrentUser,
    chat_id: i64,
    thinking: Option<bool>,
    tx: mpsc::Sender<ChatEvent>,
    record: Record,
    /// 拿著期間算這個人有一個請求在跑
    guard: RunGuard,
    /// 前端已經關掉連線（按了停止）
    stopped: bool,
}

impl Run {
    async fn send(&mut self, event: ChatEvent) {
        if !self.stopped && self.tx.send(event).await.is_err() {
            self.stopped = true;
        }
    }

    async fn finish(mut self, kind: &str, ok: bool) {
        self.record.ok = ok;
        self.record.ms = self.guard.elapsed_ms();
        ai_usage::record(&self.state.pool, self.user.id, kind, self.record).await;
        let usage =
            Usage { prompt_tokens: self.record.prompt_tokens, completion_tokens: self.record.completion_tokens };
        if ok {
            self.send(ChatEvent::Done { usage }).await;
        }
    }

    async fn fail(&mut self, message: impl Into<String>) {
        self.send(ChatEvent::Error { message: message.into() }).await;
    }

    /// 執行一個工具並存結果
    async fn run_tool(&mut self, tool: &Tool, call_id: &str, arguments: &str, row_id: i64) -> Result<(), sqlx::Error> {
        self.record.tool_calls += 1;
        let (status, content) = match ai_tools::execute(&self.state, &self.user, tool, arguments).await {
            Ok(text) => ("done", text),
            Err(text) => ("error", format!("工具執行失敗：{text}")),
        };
        set_tool_result(&self.state.pool, row_id, status, &content).await?;
        self.send(ChatEvent::ToolResult { id: call_id.into(), status: status.into(), content: preview(&content) })
            .await;
        Ok(())
    }

    /// agent loop：問模型 → 執行工具 → 再問，直到模型直接回答、需要確認、或達到上限
    async fn agent(&mut self) -> Result<bool, sqlx::Error> {
        let pool = self.state.pool.clone();
        let tools = ai_tools::available(&pool, &self.user).await?;
        let supported = self.state.ai.active_supports_tools(&pool).await.unwrap_or(true);
        let tools: Vec<Tool> = if supported { tools } else { Vec::new() };
        let options = ChatOptions {
            thinking: self.thinking,
            tools: tools.iter().map(Tool::definition).collect(),
            ..ChatOptions::default()
        };

        for step in 0..MAX_STEPS {
            if self.stopped {
                return Ok(true);
            }
            if step > 0 {
                self.send(ChatEvent::Step).await;
            }
            let mut messages = vec![Message::new("system", system_prompt(&self.user, &tools))];
            messages.extend(to_messages(&rows(&pool, self.chat_id).await?));
            let mut rx = match self.state.ai.stream(&pool, &messages, &options).await {
                Ok(rx) => rx,
                Err(err) => {
                    let message = AppError::from(err).to_string();
                    self.fail(message).await;
                    return Ok(false);
                }
            };

            let (mut content, mut reasoning) = (String::new(), String::new());
            let (mut calls, mut usage, mut error) = (Vec::new(), None, None);
            while let Some(event) = rx.recv().await {
                match event {
                    Event::Reasoning { text } => {
                        reasoning.push_str(&text);
                        self.send(ChatEvent::Reasoning { text }).await;
                    }
                    Event::Content { text } => {
                        content.push_str(&text);
                        self.send(ChatEvent::Content { text }).await;
                    }
                    Event::ToolCalls { calls: c } => calls = c,
                    Event::Done { usage: u, .. } => usage = u,
                    Event::Error { message } => error = Some(message),
                }
                // 按了停止：丟掉 rx 會斷開上游，不再生成
                if self.stopped {
                    break;
                }
            }
            drop(rx);
            let usage = usage.unwrap_or_else(|| estimate(&messages, &format!("{reasoning}{content}")));
            self.record.add(Some(&usage));

            if self.stopped || error.is_some() {
                let status = if self.stopped { "stopped" } else { "error" };
                if !content.is_empty() || !reasoning.is_empty() {
                    let row = NewRow {
                        reasoning: &reasoning,
                        status,
                        usage: Some(&usage),
                        ..NewRow::new("assistant", &content)
                    };
                    insert(&pool, self.chat_id, row).await?;
                }
                if error.is_some() {
                    self.fail("AI 回答到一半中斷了，請再試一次").await;
                }
                return Ok(self.stopped);
            }

            if calls.is_empty() {
                let row = NewRow { reasoning: &reasoning, usage: Some(&usage), ..NewRow::new("assistant", &content) };
                insert(&pool, self.chat_id, row).await?;
                return Ok(true);
            }

            // 先存 AI 要呼叫哪些工具，再一個一個處理
            let calls_json = serde_json::to_string(&calls).unwrap_or_else(|_| "[]".into());
            let row = NewRow {
                reasoning: &reasoning,
                tool_calls: Some(calls_json),
                usage: Some(&usage),
                ..NewRow::new("assistant", &content)
            };
            insert(&pool, self.chat_id, row).await?;

            let mut waiting = Vec::new();
            for call in &calls {
                let tool = tools.iter().find(|t| t.name == call.name);
                let summary = match tool {
                    Some(tool) => ai_tools::summary(&self.state, &self.user, tool, &call.arguments).await,
                    None => None,
                };
                let needs_approval = tool.is_some_and(|t| t.approval) && !self.stopped;
                self.send(ChatEvent::ToolCall {
                    id: call.id.clone(),
                    name: call.name.clone(),
                    title: tool.map_or_else(|| call.name.clone(), |t| t.title.clone()),
                    arguments: call.arguments.clone(),
                    summary,
                    approval: needs_approval,
                })
                .await;
                let status = if needs_approval { "pending" } else { "running" };
                let row = NewRow {
                    tool_call_id: Some(&call.id),
                    tool_name: Some(&call.name),
                    tool_arguments: Some(&call.arguments),
                    status,
                    ..NewRow::new("tool", "")
                };
                let row_id = insert(&pool, self.chat_id, row).await?;
                match tool {
                    None => {
                        let text = format!("沒有叫做 {} 的工具", call.name);
                        set_tool_result(&pool, row_id, "error", &text).await?;
                        self.send(ChatEvent::ToolResult { id: call.id.clone(), status: "error".into(), content: text })
                            .await;
                    }
                    Some(_) if self.stopped => {
                        set_tool_result(&pool, row_id, "denied", "使用者按了停止，沒有執行。").await?;
                    }
                    Some(_) if needs_approval => waiting.push(call.id.clone()),
                    Some(tool) => self.run_tool(tool, &call.id, &call.arguments, row_id).await?,
                }
            }
            if self.stopped {
                return Ok(true);
            }
            if !waiting.is_empty() {
                self.send(ChatEvent::Approval { ids: waiting }).await;
                return Ok(true);
            }
        }
        let note = format!("（已經連續用了 {MAX_STEPS} 輪工具，先停在這裡。需要的話請再說一次要繼續。）");
        self.send(ChatEvent::Step).await;
        self.send(ChatEvent::Content { text: note.clone() }).await;
        insert(&pool, self.chat_id, NewRow::new("assistant", &note)).await?;
        Ok(true)
    }

    /// 第一次回答完，請 AI 幫對話取個標題
    async fn name_chat(&mut self) {
        let pool = self.state.pool.clone();
        let Ok(rows) = rows(&pool, self.chat_id).await else { return };
        let first_user = rows.iter().find(|r| r.role == "user");
        let first_answer = rows.iter().find(|r| r.role == "assistant" && !r.content.is_empty());
        let (Some(question), Some(answer)) = (first_user, first_answer) else { return };
        if rows.iter().filter(|r| r.role == "user").count() != 1 {
            return;
        }
        let excerpt = |text: &str| text.chars().take(600).collect::<String>();
        let messages = [
            Message::new("system", "幫這段對話取一個繁體中文標題，15 個字以內，不要標點符號和引號，只回標題本身。"),
            Message::new("user", format!("使用者：{}\n\nAI：{}", excerpt(&question.content), excerpt(&answer.content))),
        ];
        let options = ChatOptions { thinking: Some(false), max_tokens: Some(40), ..ChatOptions::default() };
        let started = std::time::Instant::now();
        let result = self.state.ai.complete(&pool, &messages, &options).await;
        let mut record = Record { ok: result.is_ok(), ms: started.elapsed().as_millis() as i64, ..Record::default() };
        let Ok(completion) = result else { return };
        record.add(completion.usage.as_ref());
        ai_usage::record(&pool, self.user.id, "title", record).await;
        let title = clean_title(&completion.content);
        if title.is_empty() {
            return;
        }
        let updated = sqlx::query("UPDATE ai_chats SET title = ? WHERE id = ?")
            .bind(&title)
            .bind(self.chat_id)
            .execute(&pool)
            .await;
        if updated.is_ok() {
            self.send(ChatEvent::Title { title }).await;
        }
    }
}

fn clean_title(text: &str) -> String {
    let line = text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or_default();
    let line = line.trim_start_matches("標題").trim_start_matches(['：', ':']).trim();
    line.trim_matches(|c: char| "「」『』\"'《》*#。".contains(c)).trim().chars().take(MAX_TITLE_CHARS).collect()
}

/// 把 agent loop 放到背景跑，回傳串流
fn spawn(mut run: Run, kind: &'static str, rx: mpsc::Receiver<ChatEvent>, name_after: bool) -> Response {
    tokio::spawn(async move {
        match run.agent().await {
            Ok(ok) => {
                if ok && name_after && !run.stopped {
                    run.name_chat().await;
                }
                run.finish(kind, ok).await;
            }
            Err(err) => {
                tracing::error!(error = %err, "AI chat failed");
                run.fail("儲存對話時發生錯誤").await;
                run.finish(kind, false).await;
            }
        }
    });
    ai::ndjson(rx)
}

// ---- API ----

pub async fn list(State(state): State<AppState>, user: CurrentUser) -> Result<Json<Vec<ChatSummary>>, AppError> {
    let chats = sqlx::query_as(
        "SELECT c.id, c.title, c.created_at, c.updated_at,
                EXISTS (SELECT 1 FROM ai_chat_messages m WHERE m.chat_id = c.id AND m.status = 'pending') AS pending
         FROM ai_chats c WHERE c.user_id = ? ORDER BY c.updated_at DESC, c.id DESC LIMIT 500",
    )
    .bind(user.id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(chats))
}

pub async fn create(
    State(state): State<AppState>,
    user: CurrentUser,
) -> Result<(StatusCode, Json<ChatSummary>), AppError> {
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ai_chats WHERE user_id = ?")
        .bind(user.id)
        .fetch_one(&state.pool)
        .await?;
    if count >= MAX_CHATS_PER_USER {
        return Err(AppError::BadRequest(format!("對話最多 {MAX_CHATS_PER_USER} 個，先刪掉一些舊的")));
    }
    // 沒說過話就離開的空對話不留著
    sqlx::query(
        "DELETE FROM ai_chats WHERE user_id = ? AND NOT EXISTS (SELECT 1 FROM ai_chat_messages m WHERE m.chat_id = ai_chats.id)",
    )
    .bind(user.id)
    .execute(&state.pool)
    .await?;
    let id: i64 = sqlx::query_scalar("INSERT INTO ai_chats (user_id) VALUES (?) RETURNING id")
        .bind(user.id)
        .fetch_one(&state.pool)
        .await?;
    Ok((StatusCode::CREATED, Json(own_chat(&state.pool, &user, id).await?)))
}

#[derive(Serialize)]
pub struct MessageView {
    pub id: i64,
    pub role: String,
    pub content: String,
    pub reasoning: String,
    pub tool_calls: Vec<ToolCall>,
    pub tool_call_id: Option<String>,
    pub tool_name: Option<String>,
    /// 工具給人看的名稱（工具後來被刪掉的話就是原本的名稱）
    pub tool_title: Option<String>,
    pub arguments: Option<String>,
    /// 等確認的動作的說明
    pub summary: Option<String>,
    pub status: String,
    pub usage: Option<Usage>,
    pub created_at: String,
}

#[derive(Serialize)]
pub struct ChatView {
    #[serde(flatten)]
    pub chat: ChatSummary,
    pub messages: Vec<MessageView>,
}

pub async fn get(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<i64>,
) -> Result<Json<ChatView>, AppError> {
    let chat = own_chat(&state.pool, &user, id).await?;
    let tools = ai_tools::available(&state.pool, &user).await?;
    let mut messages = Vec::new();
    for row in rows(&state.pool, id).await? {
        let tool = row.tool_name.as_ref().and_then(|name| tools.iter().find(|t| &t.name == name));
        let summary = match (tool, row.status.as_str(), &row.tool_arguments) {
            (Some(tool), "pending", Some(args)) => ai_tools::summary(&state, &user, tool, args).await,
            _ => None,
        };
        messages.push(MessageView {
            tool_calls: row.tool_calls.as_deref().and_then(|c| serde_json::from_str(c).ok()).unwrap_or_default(),
            tool_title: tool.map(|t| t.title.clone()).or_else(|| row.tool_name.clone()),
            usage: row
                .prompt_tokens
                .zip(row.completion_tokens)
                .map(|(p, c)| Usage { prompt_tokens: p as u64, completion_tokens: c as u64 }),
            summary,
            id: row.id,
            role: row.role,
            content: row.content,
            reasoning: row.reasoning,
            tool_call_id: row.tool_call_id,
            tool_name: row.tool_name,
            arguments: row.tool_arguments,
            status: row.status,
            created_at: row.created_at,
        });
    }
    Ok(Json(ChatView { chat, messages }))
}

#[derive(Deserialize)]
pub struct Rename {
    pub title: String,
}

pub async fn rename(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<i64>,
    Json(input): Json<Rename>,
) -> Result<Json<ChatSummary>, AppError> {
    own_chat(&state.pool, &user, id).await?;
    let title: String = input.title.trim().chars().take(MAX_TITLE_CHARS).collect();
    sqlx::query("UPDATE ai_chats SET title = ? WHERE id = ?").bind(title).bind(id).execute(&state.pool).await?;
    Ok(Json(own_chat(&state.pool, &user, id).await?))
}

pub async fn delete(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<i64>,
) -> Result<StatusCode, AppError> {
    let result = sqlx::query("DELETE FROM ai_chats WHERE id = ? AND user_id = ?")
        .bind(id)
        .bind(user.id)
        .execute(&state.pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct SendInput {
    pub content: String,
    /// null 是照伺服器預設；false 關掉思考（比較快）
    #[serde(default)]
    pub thinking: Option<bool>,
}

/// 送出一則訊息，回答串流回去（一行一個 [`ChatEvent`]）
pub async fn send(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<i64>,
    Json(input): Json<SendInput>,
) -> Result<Response, AppError> {
    let content = input.content.trim();
    if content.is_empty() {
        return Err(AppError::BadRequest("請輸入訊息".into()));
    }
    if content.chars().count() > MAX_INPUT_CHARS {
        return Err(AppError::BadRequest(format!("一則訊息最多 {MAX_INPUT_CHARS} 字")));
    }
    let chat = own_chat(&state.pool, &user, id).await?;
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ai_chat_messages WHERE chat_id = ?")
        .bind(id)
        .fetch_one(&state.pool)
        .await?;
    if count >= MAX_ROWS_PER_CHAT {
        return Err(AppError::BadRequest("這段對話太長了，請開一個新對話".into()));
    }
    // 先確認 AI 有開放、額度還夠、沒有別的請求在跑，才存訊息
    if ai::active_provider(&state.pool).await?.is_none() {
        return Err(AppError::ServiceUnavailable("AI 功能尚未開放"));
    }
    let guard = ai_usage::begin(&state, &user, true).await?;

    skip_pending(&state.pool, id).await?;
    insert(&state.pool, id, NewRow::new("user", content)).await?;
    let first = chat.title.is_empty();
    if first {
        // 先用第一句話當標題，回答完再請 AI 取一個
        let title: String = content.lines().next().unwrap_or_default().chars().take(30).collect();
        sqlx::query("UPDATE ai_chats SET title = ? WHERE id = ?").bind(title).bind(id).execute(&state.pool).await?;
    }

    let (tx, rx) = mpsc::channel(64);
    let run = Run {
        state,
        user,
        chat_id: id,
        thinking: input.thinking,
        tx,
        record: Record::default(),
        guard,
        stopped: false,
    };
    Ok(spawn(run, "chat", rx, first))
}

#[derive(Deserialize)]
pub struct Decision {
    pub id: String,
    pub approve: bool,
}

#[derive(Deserialize)]
pub struct ApproveInput {
    pub decisions: Vec<Decision>,
    #[serde(default)]
    pub thinking: Option<bool>,
}

/// 使用者對等確認的動作按了允許／拒絕：執行允許的，接著讓 AI 繼續（串流回去）
pub async fn approve(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<i64>,
    Json(input): Json<ApproveInput>,
) -> Result<Response, AppError> {
    own_chat(&state.pool, &user, id).await?;
    let pending: Vec<Row> = rows(&state.pool, id).await?.into_iter().filter(|r| r.status == "pending").collect();
    if pending.is_empty() {
        return Err(AppError::Conflict("沒有等待確認的動作".into()));
    }
    let decisions: std::collections::HashMap<String, bool> =
        input.decisions.into_iter().map(|d| (d.id, d.approve)).collect();
    let decision = move |row: &Row| row.tool_call_id.as_ref().and_then(|id| decisions.get(id).copied());
    if pending.iter().any(|row| decision(row).is_none()) {
        return Err(AppError::BadRequest("每個等待確認的動作都要選允許或拒絕".into()));
    }
    let guard = ai_usage::begin(&state, &user, false).await?;
    let tools = ai_tools::available(&state.pool, &user).await?;

    let (tx, rx) = mpsc::channel(64);
    let mut run = Run {
        state,
        user,
        chat_id: id,
        thinking: input.thinking,
        tx,
        record: Record::default(),
        guard,
        stopped: false,
    };
    tokio::spawn(async move {
        let pool = run.state.pool.clone();
        for row in &pending {
            let call_id = row.tool_call_id.clone().unwrap_or_default();
            let tool = row.tool_name.as_ref().and_then(|name| tools.iter().find(|t| &t.name == name));
            let result = match (decision(row), tool) {
                (Some(true), Some(tool)) => {
                    run.run_tool(tool, &call_id, row.tool_arguments.as_deref().unwrap_or("{}"), row.id).await
                }
                (Some(true), None) => {
                    let text = "這個工具已經被管理員關掉了，沒有執行。";
                    run.send(ChatEvent::ToolResult { id: call_id, status: "error".into(), content: text.into() }).await;
                    set_tool_result(&pool, row.id, "error", text).await
                }
                _ => {
                    let text = "使用者拒絕執行這個動作。";
                    run.send(ChatEvent::ToolResult { id: call_id, status: "denied".into(), content: text.into() })
                        .await;
                    set_tool_result(&pool, row.id, "denied", text).await
                }
            };
            if let Err(err) = result {
                tracing::error!(error = %err, "failed to save tool result");
            }
        }
        run.send(ChatEvent::Step).await;
        match run.agent().await {
            Ok(ok) => run.finish("chat_continue", ok).await,
            Err(err) => {
                tracing::error!(error = %err, "AI chat failed");
                run.fail("儲存對話時發生錯誤").await;
                run.finish("chat_continue", false).await;
            }
        }
    });
    Ok(ai::ndjson(rx))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn row(role: &str, content: &str) -> Row {
        Row {
            id: 0,
            role: role.into(),
            content: content.into(),
            reasoning: String::new(),
            tool_calls: None,
            tool_call_id: None,
            tool_name: None,
            tool_arguments: None,
            status: "done".into(),
            prompt_tokens: None,
            completion_tokens: None,
            created_at: String::new(),
        }
    }

    #[test]
    fn tool_rows_become_tool_messages() {
        let calls = json!([{ "id": "c1", "name": "weather_forecast", "arguments": "{}" }]).to_string();
        let rows = vec![
            row("user", "天氣？"),
            Row { tool_calls: Some(calls), ..row("assistant", "") },
            Row { tool_call_id: Some("c1".into()), ..row("tool", "晴") },
            Row { status: "pending".into(), tool_call_id: Some("c2".into()), ..row("tool", "") },
            row("assistant", "今天晴天"),
        ];
        let messages = to_messages(&rows);
        let roles: Vec<&str> = messages.iter().map(|m| m.role.as_str()).collect();
        assert_eq!(roles, ["user", "assistant", "tool", "assistant"]);
        assert_eq!(messages[1].tool_calls[0].name, "weather_forecast");
        assert_eq!(messages[2].tool_call_id.as_deref(), Some("c1"));
    }

    #[test]
    fn long_history_is_cut_at_a_user_message() {
        let long = "字".repeat(MAX_CONTEXT_CHARS / 2);
        let rows = vec![
            row("user", &long),
            row("assistant", &long),
            row("user", "第二題"),
            row("assistant", "答案"),
            row("user", "第三題"),
        ];
        let messages = to_messages(&rows);
        assert_eq!(messages[0].content, "第二題");
        assert_eq!(messages.len(), 3);
    }

    #[test]
    fn titles_are_cleaned() {
        assert_eq!(clean_title("「台北天氣查詢」\n"), "台北天氣查詢");
        assert_eq!(clean_title("標題：週末出遊計畫。"), "週末出遊計畫");
    }
}
