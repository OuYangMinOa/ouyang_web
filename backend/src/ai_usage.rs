//! AI 的用量與額度：每個人每天能問幾次、用多少 token，同時間全站最多跑幾個。
//!
//! - 每一次呼叫 AI 都記一筆 `ai_usage`（使用者、種類、token、呼叫了幾次工具、成功與否、花多久）。
//! - 每天的額度以台灣時間的日期算。`chat`（送出一則訊息）和 `calendar`（一句話新增事項）算一次，
//!   確認工具後接著做（`chat_continue`）和取標題（`title`）不算次數，但 token 照算。
//! - 全站預設在 `site_settings`（`ai_daily_requests`、`ai_daily_tokens`，空的是不限），
//!   個別使用者可以另外設定或停用（`ai_user_limits`）。有 `admin.users` 權限的人不受限。
//! - 同一個人同時只能有一個 AI 請求在跑；全站同時最多 `ai_max_running` 個（自架的 GPU 撐不了太多），
//!   滿了就請使用者等一下，不排隊。這只記在記憶體，每個容器各自算。

use std::{
    collections::HashSet,
    sync::{Arc, Mutex},
    time::Instant,
};

use axum::{
    Json,
    extract::{Path, Query, State},
};
use chrono::{Duration as ChronoDuration, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::{
    AppError, AppState,
    ai::Usage,
    auth::{AdminUsers, CurrentUser, Permission as _, Require},
};

const DAILY_REQUESTS_KEY: &str = "ai_daily_requests";
const DAILY_TOKENS_KEY: &str = "ai_daily_tokens";
const MAX_RUNNING_KEY: &str = "ai_max_running";

const DEFAULT_DAILY_REQUESTS: i64 = 50;
const DEFAULT_DAILY_TOKENS: i64 = 300_000;
const DEFAULT_MAX_RUNNING: i64 = 4;
const MAX_LIMIT: i64 = 1_000_000_000;
/// 管理頁最多看幾天
const MAX_REPORT_DAYS: i64 = 90;
/// 用量紀錄留多久
const KEEP_DAYS: i64 = 400;

/// 台灣時間（UTC+8，沒有夏令時間）
fn taipei_now() -> chrono::NaiveDateTime {
    Utc::now().naive_utc() + ChronoDuration::hours(8)
}

pub fn taipei_today() -> NaiveDate {
    taipei_now().date()
}

/// 台灣時間某一天 0 點，換成資料庫裡用的 UTC 字串
fn day_start_utc(date: NaiveDate) -> String {
    let utc = date.and_hms_opt(0, 0, 0).expect("midnight") - ChronoDuration::hours(8);
    utc.format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

/// 給 AI 看的現在時間，例如「2026-11-05（星期四）14:30」
pub fn taipei_now_label() -> String {
    let now = taipei_now();
    format!("{}（星期{}）{}", now.format("%Y-%m-%d"), crate::lunar::weekday_name(now.date()), now.format("%H:%M"))
}

// ---- 設定 ----

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Defaults {
    /// 每人每天幾次，null 是不限
    pub daily_requests: Option<i64>,
    /// 每人每天幾個 token（輸入加輸出），null 是不限
    pub daily_tokens: Option<i64>,
    /// 全站同時最多幾個 AI 請求
    pub max_running: i64,
}

async fn setting(pool: &SqlitePool, key: &str) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar("SELECT value FROM site_settings WHERE key = ?").bind(key).fetch_optional(pool).await
}

async fn put_setting(pool: &SqlitePool, key: &str, value: &str) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO site_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    )
    .bind(key)
    .bind(value)
    .execute(pool)
    .await?;
    Ok(())
}

/// 沒設定過用預設值，存的是空字串表示不限
async fn limit_setting(pool: &SqlitePool, key: &str, default: i64) -> Result<Option<i64>, sqlx::Error> {
    Ok(match setting(pool, key).await? {
        None => Some(default),
        Some(value) => value.trim().parse().ok(),
    })
}

pub async fn defaults(pool: &SqlitePool) -> Result<Defaults, sqlx::Error> {
    let max_running = setting(pool, MAX_RUNNING_KEY)
        .await?
        .and_then(|v| v.parse().ok())
        .filter(|&n: &i64| n >= 1)
        .unwrap_or(DEFAULT_MAX_RUNNING);
    Ok(Defaults {
        daily_requests: limit_setting(pool, DAILY_REQUESTS_KEY, DEFAULT_DAILY_REQUESTS).await?,
        daily_tokens: limit_setting(pool, DAILY_TOKENS_KEY, DEFAULT_DAILY_TOKENS).await?,
        max_running,
    })
}

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, sqlx::FromRow)]
pub struct UserLimit {
    /// null 是用全站預設
    pub daily_requests: Option<i64>,
    pub daily_tokens: Option<i64>,
    pub blocked: bool,
}

async fn user_limit(pool: &SqlitePool, user_id: i64) -> Result<UserLimit, sqlx::Error> {
    Ok(sqlx::query_as("SELECT daily_requests, daily_tokens, blocked FROM ai_user_limits WHERE user_id = ?")
        .bind(user_id)
        .fetch_optional(pool)
        .await?
        .unwrap_or_default())
}

#[derive(Clone, Copy, Debug, Default, Serialize, sqlx::FromRow)]
pub struct Totals {
    pub requests: i64,
    pub tokens: i64,
}

async fn totals_since(pool: &SqlitePool, user_id: i64, since: &str) -> Result<Totals, sqlx::Error> {
    sqlx::query_as(
        "SELECT COALESCE(SUM(kind IN ('chat', 'calendar')), 0) AS requests,
                COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS tokens
         FROM ai_usage WHERE user_id = ? AND created_at >= ?",
    )
    .bind(user_id)
    .bind(since)
    .fetch_one(pool)
    .await
}

// ---- 額度 ----

/// 這個人今天的用量和上限
#[derive(Clone, Debug, Serialize)]
pub struct Quota {
    pub today: Totals,
    /// null 是不限
    pub daily_requests: Option<i64>,
    pub daily_tokens: Option<i64>,
    /// 管理員不受限
    pub unlimited: bool,
    pub blocked: bool,
}

impl Quota {
    /// 還能不能再問；不行的話是給使用者看的原因
    fn refusal(&self) -> Option<String> {
        if self.blocked {
            return Some("管理員停用了你的 AI 功能".into());
        }
        if self.unlimited {
            return None;
        }
        if let Some(limit) = self.daily_requests.filter(|&limit| self.today.requests >= limit) {
            return Some(format!("今天的 AI 額度（{limit} 次）用完了，明天再來"));
        }
        if let Some(limit) = self.daily_tokens.filter(|&limit| self.today.tokens >= limit) {
            return Some(format!("今天的 AI 額度（{limit} tokens）用完了，明天再來"));
        }
        None
    }
}

pub async fn quota(pool: &SqlitePool, user: &CurrentUser) -> Result<Quota, sqlx::Error> {
    let defaults = defaults(pool).await?;
    let limit = user_limit(pool, user.id).await?;
    let today = totals_since(pool, user.id, &day_start_utc(taipei_today())).await?;
    Ok(Quota {
        today,
        daily_requests: limit.daily_requests.or(defaults.daily_requests),
        daily_tokens: limit.daily_tokens.or(defaults.daily_tokens),
        unlimited: user.has(AdminUsers::NAME),
        blocked: limit.blocked,
    })
}

// ---- 同時在跑的請求 ----

#[derive(Default)]
pub struct Running {
    users: Mutex<HashSet<i64>>,
}

impl Running {
    pub fn count(&self) -> usize {
        self.users.lock().unwrap().len()
    }
}

/// 拿著的期間算這個人「有一個請求在跑」，丟掉就釋放
pub struct RunGuard {
    running: Arc<Running>,
    user_id: i64,
    started: Instant,
}

impl RunGuard {
    pub fn elapsed_ms(&self) -> i64 {
        self.started.elapsed().as_millis() as i64
    }
}

impl Drop for RunGuard {
    fn drop(&mut self) {
        self.running.users.lock().unwrap().remove(&self.user_id);
    }
}

/// 開始一個 AI 請求前呼叫：檢查額度、同一個人沒有別的請求在跑、全站沒有滿
pub async fn begin(state: &AppState, user: &CurrentUser, counts_request: bool) -> Result<RunGuard, AppError> {
    let quota = quota(&state.pool, user).await?;
    // 接著做（確認工具後）不算新的一次，只要沒被停用、token 還有就可以
    let quota = if counts_request { quota } else { Quota { daily_requests: None, ..quota } };
    if let Some(reason) = quota.refusal() {
        return Err(if quota.blocked { AppError::Denied(reason) } else { AppError::QuotaExceeded(reason) });
    }
    let max = defaults(&state.pool).await?.max_running.max(1) as usize;
    let mut users = state.ai_running.users.lock().unwrap();
    if users.contains(&user.id) {
        return Err(AppError::TooManyRequests("你還有一個 AI 回答在進行中，等它完成或按停止"));
    }
    if users.len() >= max {
        return Err(AppError::TooManyRequests("現在使用 AI 的人太多，請稍後再試"));
    }
    users.insert(user.id);
    Ok(RunGuard { running: state.ai_running.clone(), user_id: user.id, started: Instant::now() })
}

/// 一次呼叫的用量
#[derive(Clone, Copy, Debug, Default)]
pub struct Record {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub tool_calls: u32,
    pub ok: bool,
    pub ms: i64,
}

impl Record {
    pub fn add(&mut self, usage: Option<&Usage>) {
        if let Some(usage) = usage {
            self.prompt_tokens += usage.prompt_tokens;
            self.completion_tokens += usage.completion_tokens;
        }
    }
}

pub async fn record(pool: &SqlitePool, user_id: i64, kind: &str, record: Record) {
    let result = sqlx::query(
        "INSERT INTO ai_usage (user_id, kind, prompt_tokens, completion_tokens, tool_calls, ok, ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(user_id)
    .bind(kind)
    .bind(record.prompt_tokens as i64)
    .bind(record.completion_tokens as i64)
    .bind(record.tool_calls)
    .bind(record.ok)
    .bind(record.ms)
    .execute(pool)
    .await;
    if let Err(err) = result {
        tracing::warn!(error = %err, "failed to record AI usage");
    }
}

/// 刪掉太舊的用量紀錄（每天一次就夠，跟著背景工作跑）
pub async fn prune(pool: &SqlitePool) {
    let before = day_start_utc(taipei_today() - ChronoDuration::days(KEEP_DAYS));
    if let Err(err) = sqlx::query("DELETE FROM ai_usage WHERE created_at < ?").bind(before).execute(pool).await {
        tracing::warn!(error = %err, "failed to prune AI usage");
    }
}

// ---- API ----

/// 自己今天用了多少、上限多少
pub async fn mine(State(state): State<AppState>, user: CurrentUser) -> Result<Json<Quota>, AppError> {
    Ok(Json(quota(&state.pool, &user).await?))
}

#[derive(Deserialize)]
pub struct ReportQuery {
    #[serde(default)]
    pub days: Option<i64>,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct UserRow {
    pub user_id: i64,
    pub username: String,
    pub today_requests: i64,
    pub today_tokens: i64,
    pub requests: i64,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub tool_calls: i64,
    pub errors: i64,
    pub last_used_at: Option<String>,
    pub daily_requests: Option<i64>,
    pub daily_tokens: Option<i64>,
    pub blocked: bool,
    pub is_admin: bool,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct DayRow {
    /// 台灣時間的日期
    pub day: String,
    pub requests: i64,
    pub tokens: i64,
    pub users: i64,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct RecentRow {
    pub id: i64,
    pub username: String,
    pub kind: String,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub tool_calls: i64,
    pub ok: bool,
    pub ms: i64,
    pub created_at: String,
}

#[derive(Serialize)]
pub struct Report {
    pub defaults: Defaults,
    pub days: i64,
    pub running: usize,
    pub users: Vec<UserRow>,
    pub daily: Vec<DayRow>,
    pub recent: Vec<RecentRow>,
}

async fn report(state: &AppState, days: i64) -> Result<Report, AppError> {
    let days = days.clamp(1, MAX_REPORT_DAYS);
    let today = taipei_today();
    let since = day_start_utc(today - ChronoDuration::days(days - 1));
    let today_start = day_start_utc(today);
    // 所有登入過的人都列出來（就算還沒用過 AI，也要能先設定額度），有用過的排前面
    let users = sqlx::query_as::<_, UserRow>(
        "SELECT u.id AS user_id, u.username,
                COALESCE(SUM(a.created_at >= ?1 AND a.kind IN ('chat', 'calendar')), 0) AS today_requests,
                COALESCE(SUM(CASE WHEN a.created_at >= ?1 THEN a.prompt_tokens + a.completion_tokens END), 0)
                    AS today_tokens,
                COALESCE(SUM(a.kind IN ('chat', 'calendar')), 0) AS requests,
                COALESCE(SUM(a.prompt_tokens), 0) AS prompt_tokens,
                COALESCE(SUM(a.completion_tokens), 0) AS completion_tokens,
                COALESCE(SUM(a.tool_calls), 0) AS tool_calls,
                COALESCE(SUM(NOT a.ok), 0) AS errors,
                MAX(a.created_at) AS last_used_at,
                l.daily_requests, l.daily_tokens, COALESCE(l.blocked, 0) AS blocked,
                EXISTS (SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id
                        WHERE ur.user_id = u.id AND rp.permission = 'admin.users') AS is_admin
         FROM users u
         LEFT JOIN ai_usage a ON a.user_id = u.id AND a.created_at >= ?2
         LEFT JOIN ai_user_limits l ON l.user_id = u.id
         WHERE NOT u.disabled
         GROUP BY u.id
         ORDER BY requests DESC, last_used_at DESC, u.username",
    )
    .bind(&today_start)
    .bind(&since)
    .fetch_all(&state.pool)
    .await?;
    let daily = sqlx::query_as::<_, DayRow>(
        "SELECT date(created_at, '+8 hours') AS day,
                SUM(kind IN ('chat', 'calendar')) AS requests,
                SUM(prompt_tokens + completion_tokens) AS tokens,
                COUNT(DISTINCT user_id) AS users
         FROM ai_usage WHERE created_at >= ? GROUP BY day ORDER BY day",
    )
    .bind(&since)
    .fetch_all(&state.pool)
    .await?;
    let recent = sqlx::query_as::<_, RecentRow>(
        "SELECT a.id, u.username, a.kind, a.prompt_tokens, a.completion_tokens, a.tool_calls, a.ok, a.ms, a.created_at
         FROM ai_usage a JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 50",
    )
    .fetch_all(&state.pool)
    .await?;
    Ok(Report { defaults: defaults(&state.pool).await?, days, running: state.ai_running.count(), users, daily, recent })
}

pub async fn admin_report(
    _: Require<AdminUsers>,
    State(state): State<AppState>,
    Query(query): Query<ReportQuery>,
) -> Result<Json<Report>, AppError> {
    Ok(Json(report(&state, query.days.unwrap_or(7)).await?))
}

fn check_limit(value: Option<i64>, what: &str) -> Result<(), AppError> {
    match value {
        Some(n) if !(0..=MAX_LIMIT).contains(&n) => Err(AppError::BadRequest(format!("{what}要是 0 到 {MAX_LIMIT}"))),
        _ => Ok(()),
    }
}

/// 全站預設的額度
pub async fn admin_set_defaults(
    _: Require<AdminUsers>,
    State(state): State<AppState>,
    Json(input): Json<Defaults>,
) -> Result<Json<Report>, AppError> {
    check_limit(input.daily_requests, "每天次數")?;
    check_limit(input.daily_tokens, "每天 token")?;
    if !(1..=100).contains(&input.max_running) {
        return Err(AppError::BadRequest("同時最多幾個要是 1 到 100".into()));
    }
    let text = |value: Option<i64>| value.map(|n| n.to_string()).unwrap_or_default();
    put_setting(&state.pool, DAILY_REQUESTS_KEY, &text(input.daily_requests)).await?;
    put_setting(&state.pool, DAILY_TOKENS_KEY, &text(input.daily_tokens)).await?;
    put_setting(&state.pool, MAX_RUNNING_KEY, &input.max_running.to_string()).await?;
    Ok(Json(report(&state, 7).await?))
}

/// 個別使用者的額度；三個都是預設（null、null、false）就刪掉那一筆
pub async fn admin_set_user(
    _: Require<AdminUsers>,
    State(state): State<AppState>,
    Path(user_id): Path<i64>,
    Json(input): Json<UserLimit>,
) -> Result<Json<UserLimit>, AppError> {
    check_limit(input.daily_requests, "每天次數")?;
    check_limit(input.daily_tokens, "每天 token")?;
    let exists: Option<i64> =
        sqlx::query_scalar("SELECT id FROM users WHERE id = ?").bind(user_id).fetch_optional(&state.pool).await?;
    exists.ok_or(AppError::NotFound)?;
    if input.daily_requests.is_none() && input.daily_tokens.is_none() && !input.blocked {
        sqlx::query("DELETE FROM ai_user_limits WHERE user_id = ?").bind(user_id).execute(&state.pool).await?;
    } else {
        sqlx::query(
            "INSERT INTO ai_user_limits (user_id, daily_requests, daily_tokens, blocked) VALUES (?, ?, ?, ?)
             ON CONFLICT (user_id) DO UPDATE SET daily_requests = excluded.daily_requests,
                 daily_tokens = excluded.daily_tokens, blocked = excluded.blocked",
        )
        .bind(user_id)
        .bind(input.daily_requests)
        .bind(input.daily_tokens)
        .bind(input.blocked)
        .execute(&state.pool)
        .await?;
    }
    Ok(Json(user_limit(&state.pool, user_id).await?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn taipei_midnight_is_previous_day_in_utc() {
        let day = NaiveDate::from_ymd_opt(2026, 11, 5).unwrap();
        assert_eq!(day_start_utc(day), "2026-11-04T16:00:00Z");
    }
}
