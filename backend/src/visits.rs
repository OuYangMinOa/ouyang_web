//! 隱藏頁面的瀏覽紀錄：頁面不在任何選單裡，只有知道網址的人進得來，所以記下誰來過。
//!
//! 前端送事件（open / click / scan / error），後端補上來源 IP、登入的帳號和 User-Agent。
//! 寫入不需要登入；查詢在系統管理裡，需要 `admin.users`。

use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};

use axum::{
    Json,
    extract::{Path, State},
    http::{HeaderMap, StatusCode, header},
};
use serde::{Deserialize, Serialize};

use crate::{
    AppError, AppState,
    auth::{AdminUsers, CurrentUser, Require, client_key},
};

/// 有在記錄的頁面；前端的網址是 `/<page>`
const PAGES: &[&str] = &["bcs"];
const ACTIONS: &[&str] = &["open", "click", "scan", "error"];
const MAX_DETAIL_LEN: usize = 300;
const MAX_USER_AGENT_LEN: usize = 300;
const KEEP_DAYS: u32 = 180;
/// 同一個 IP 在 10 分鐘內最多記 200 筆，超過的直接丟掉（不回錯誤，頁面照常用）
const MAX_EVENTS_PER_WINDOW: u32 = 200;
const WINDOW: Duration = Duration::from_secs(10 * 60);
/// 管理頁一次列出最近的幾次瀏覽、一次瀏覽最多列出幾筆事件
const MAX_SESSIONS: i64 = 300;
const MAX_EVENTS: i64 = 500;

/// 只存在記憶體，重啟會歸零；用途只是擋有人狂送把資料庫灌爆
#[derive(Default)]
pub struct VisitLimiter {
    counts: Mutex<HashMap<String, (u32, Instant)>>,
}

impl VisitLimiter {
    fn allow(&self, key: &str) -> bool {
        let mut counts = self.counts.lock().unwrap();
        if counts.len() > 10_000 {
            counts.retain(|_, (_, since)| since.elapsed() < WINDOW);
        }
        let entry = counts.entry(key.to_owned()).or_insert((0, Instant::now()));
        if entry.1.elapsed() >= WINDOW {
            *entry = (0, Instant::now());
        }
        entry.0 += 1;
        entry.0 <= MAX_EVENTS_PER_WINDOW
    }
}

fn known_page(page: &str) -> Result<(), AppError> {
    if PAGES.contains(&page) { Ok(()) } else { Err(AppError::NotFound) }
}

fn truncate(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

#[derive(Deserialize)]
pub struct NewEvent {
    pub session: String,
    pub action: String,
    #[serde(default)]
    pub detail: String,
}

pub async fn track(
    State(state): State<AppState>,
    Path(page): Path<String>,
    user: Option<CurrentUser>,
    headers: HeaderMap,
    Json(input): Json<NewEvent>,
) -> Result<StatusCode, AppError> {
    known_page(&page)?;
    if !ACTIONS.contains(&input.action.as_str()) {
        return Err(AppError::BadRequest("action 不正確".into()));
    }
    let session = input.session.as_str();
    if !(4..=40).contains(&session.len()) || !session.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err(AppError::BadRequest("session 不正確".into()));
    }
    let ip = client_key(&headers);
    if !state.visit_limiter.allow(&ip) {
        return Ok(StatusCode::NO_CONTENT);
    }
    let user_agent = headers.get(header::USER_AGENT).and_then(|v| v.to_str().ok()).unwrap_or_default();

    // 每次有人打開頁面時順便清掉太舊的紀錄
    if input.action == "open" {
        sqlx::query("DELETE FROM page_events WHERE created_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?)")
            .bind(format!("-{KEEP_DAYS} days"))
            .execute(&state.pool)
            .await?;
    }
    sqlx::query(
        "INSERT INTO page_events (page, session, action, detail, ip, user_id, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&page)
    .bind(session)
    .bind(&input.action)
    .bind(truncate(input.detail.trim(), MAX_DETAIL_LEN))
    .bind(&ip)
    .bind(user.map(|u| u.id))
    .bind(truncate(user_agent, MAX_USER_AGENT_LEN))
    .execute(&state.pool)
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize, sqlx::FromRow)]
pub struct VisitSummary {
    /// 全部的瀏覽次數（分頁數）
    pub sessions: i64,
    pub ips: i64,
    /// 登入過的不同帳號數
    pub users: i64,
    /// 最近 24 小時的瀏覽次數
    pub last_day: i64,
}

#[derive(sqlx::FromRow)]
struct SessionRow {
    session: String,
    first_at: String,
    last_at: String,
    ips: String,
    users: String,
    user_agent: String,
    opens: i64,
    clicks: i64,
    scans: i64,
    errors: i64,
}

/// 一次瀏覽（一個分頁）。換網路或中途登入時 IP、帳號可能不只一個
#[derive(Serialize)]
pub struct VisitSession {
    pub session: String,
    pub first_at: String,
    pub last_at: String,
    pub ips: Vec<String>,
    pub users: Vec<String>,
    pub user_agent: String,
    pub opens: i64,
    pub clicks: i64,
    pub scans: i64,
    pub errors: i64,
}

fn split_list(value: &str) -> Vec<String> {
    value.split(',').filter(|s| !s.is_empty()).map(Into::into).collect()
}

impl From<SessionRow> for VisitSession {
    fn from(row: SessionRow) -> Self {
        Self {
            session: row.session,
            first_at: row.first_at,
            last_at: row.last_at,
            ips: split_list(&row.ips),
            users: split_list(&row.users),
            user_agent: row.user_agent,
            opens: row.opens,
            clicks: row.clicks,
            scans: row.scans,
            errors: row.errors,
        }
    }
}

#[derive(Serialize)]
pub struct VisitReport {
    pub summary: VisitSummary,
    pub sessions: Vec<VisitSession>,
}

pub async fn list_sessions(
    State(state): State<AppState>,
    _: Require<AdminUsers>,
    Path(page): Path<String>,
) -> Result<Json<VisitReport>, AppError> {
    known_page(&page)?;
    let summary = sqlx::query_as::<_, VisitSummary>(
        "SELECT COUNT(DISTINCT session) AS sessions, COUNT(DISTINCT ip) AS ips, COUNT(DISTINCT user_id) AS users,
            COUNT(DISTINCT CASE WHEN created_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 day') THEN session END)
                AS last_day
         FROM page_events WHERE page = ?",
    )
    .bind(&page)
    .fetch_one(&state.pool)
    .await?;
    // IP 不含逗號、帳號名稱只有英數字和 _ . -，所以可以用 group_concat 的預設逗號分隔
    let rows = sqlx::query_as::<_, SessionRow>(
        "SELECT e.session, MIN(e.created_at) AS first_at, MAX(e.created_at) AS last_at,
            group_concat(DISTINCT e.ip) AS ips, COALESCE(group_concat(DISTINCT u.username), '') AS users,
            MAX(e.user_agent) AS user_agent,
            SUM(e.action = 'open') AS opens, SUM(e.action = 'click') AS clicks,
            SUM(e.action = 'scan') AS scans, SUM(e.action = 'error') AS errors
         FROM page_events e LEFT JOIN users u ON u.id = e.user_id
         WHERE e.page = ? GROUP BY e.session ORDER BY last_at DESC, MAX(e.id) DESC LIMIT ?",
    )
    .bind(&page)
    .bind(MAX_SESSIONS)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(VisitReport { summary, sessions: rows.into_iter().map(Into::into).collect() }))
}

#[derive(Serialize, sqlx::FromRow)]
pub struct PageEvent {
    pub id: i64,
    pub action: String,
    pub detail: String,
    pub ip: String,
    pub username: Option<String>,
    pub created_at: String,
}

pub async fn session_events(
    State(state): State<AppState>,
    _: Require<AdminUsers>,
    Path((page, session)): Path<(String, String)>,
) -> Result<Json<Vec<PageEvent>>, AppError> {
    known_page(&page)?;
    let events = sqlx::query_as::<_, PageEvent>(
        "SELECT e.id, e.action, e.detail, e.ip, u.username, e.created_at
         FROM page_events e LEFT JOIN users u ON u.id = e.user_id
         WHERE e.page = ? AND e.session = ? ORDER BY e.id LIMIT ?",
    )
    .bind(&page)
    .bind(&session)
    .bind(MAX_EVENTS)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(events))
}
