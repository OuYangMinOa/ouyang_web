//! 全站的 IP 訪問紀錄：每個請求記下來源 IP、方法、路徑、狀態碼、花費時間、登入的帳號和 User-Agent，
//! 在「系統管理 › IP 訪問紀錄」查（需要 `admin.users`）。
//!
//! 前端打包出來的靜態檔（`static_dir` 最上層有的檔案和資料夾，例如 `/assets/*`）和 `/api/health`
//! 不記，否則每次開頁面都是幾十筆，Traefik 每秒的 health check 也會把表灌滿。
//! 這個頁面自己的查詢（`/api/admin/access*`）也不記，免得看紀錄時被自己洗版。
//! 沒有的路徑（例如掃描器找 `/wp-login.php`）會記下來。
//!
//! 請求本身不碰資料庫：紀錄先放在記憶體，背景每 2 秒整批寫進 `access_logs`，帳號也是那時才從 session 查。
//! 關機時會把剩下的寫完，但被強制結束的話最後幾秒會遺失。

use std::{
    collections::{HashMap, HashSet},
    path::Path as FsPath,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use axum::{
    Json,
    extract::{Query, Request, State},
    http::header,
    middleware::Next,
    response::Response,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::{
    AppError, AppState,
    auth::{AdminUsers, Require, client_key, read_session_token, token_hash},
};

const KEEP_DAYS: u32 = 30;
const FLUSH_EVERY: Duration = Duration::from_secs(2);
const CLEANUP_EVERY: Duration = Duration::from_secs(60 * 60);
/// 還沒寫進資料庫的紀錄最多幾筆，資料庫卡住時超過的直接丟掉
const MAX_PENDING: usize = 10_000;
/// 同一個 IP 在 10 分鐘內最多記 1000 筆，超過的不記（請求照常處理）
const MAX_PER_WINDOW: u32 = 1_000;
const WINDOW: Duration = Duration::from_secs(10 * 60);
const MAX_PATH_LEN: usize = 300;
const MAX_QUERY_LEN: usize = 300;
const MAX_USER_AGENT_LEN: usize = 300;
/// 管理頁一次列出幾個 IP、幾個路徑、幾筆請求
const MAX_IPS: i64 = 300;
const MAX_PATHS: i64 = 15;
const MAX_REQUESTS: i64 = 500;
/// 查詢範圍（小時），跟保留天數一樣長
const DEFAULT_HOURS: u32 = 24;
const MAX_HOURS: u32 = KEEP_DAYS * 24;

struct Entry {
    ip: String,
    method: String,
    path: String,
    query: String,
    status: u16,
    duration_ms: i64,
    /// session token 的雜湊，寫入時才換成帳號
    session: Option<String>,
    user_agent: String,
    created_at: String,
}

#[derive(Default)]
pub struct AccessLog {
    pending: Mutex<Vec<Entry>>,
    /// 只存在記憶體，重啟會歸零；用途只是擋有人狂送把資料庫灌爆
    counts: Mutex<HashMap<String, (u32, Instant)>>,
}

impl AccessLog {
    fn allow(&self, ip: &str) -> bool {
        let mut counts = self.counts.lock().unwrap();
        if counts.len() > 10_000 {
            counts.retain(|_, (_, since)| since.elapsed() < WINDOW);
        }
        let entry = counts.entry(ip.to_owned()).or_insert((0, Instant::now()));
        if entry.1.elapsed() >= WINDOW {
            *entry = (0, Instant::now());
        }
        entry.0 += 1;
        entry.0 <= MAX_PER_WINDOW
    }

    fn push(&self, entry: Entry) {
        let mut pending = self.pending.lock().unwrap();
        if pending.len() < MAX_PENDING {
            pending.push(entry);
        }
    }

    /// 把記憶體裡的紀錄寫進資料庫。背景每 2 秒呼叫一次；測試裡直接呼叫
    pub async fn flush(&self, pool: &SqlitePool) -> Result<(), sqlx::Error> {
        let entries = std::mem::take(&mut *self.pending.lock().unwrap());
        if entries.is_empty() {
            return Ok(());
        }
        let mut users: HashMap<String, Option<i64>> = HashMap::new();
        let mut tx = pool.begin().await?;
        for entry in entries {
            let user_id = match entry.session {
                None => None,
                Some(session) => match users.get(&session) {
                    Some(id) => *id,
                    None => {
                        let id = sqlx::query_scalar("SELECT user_id FROM sessions WHERE token_hash = ?")
                            .bind(&session)
                            .fetch_optional(&mut *tx)
                            .await?;
                        users.insert(session, id);
                        id
                    }
                },
            };
            sqlx::query(
                "INSERT INTO access_logs (ip, method, path, query, status, duration_ms, user_id, user_agent, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(entry.ip)
            .bind(entry.method)
            .bind(entry.path)
            .bind(entry.query)
            .bind(entry.status)
            .bind(entry.duration_ms)
            .bind(user_id)
            .bind(entry.user_agent)
            .bind(entry.created_at)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await
    }
}

/// 背景每 2 秒寫一次資料庫，每小時清掉超過 30 天的紀錄
pub fn spawn(log: Arc<AccessLog>, pool: SqlitePool) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(FLUSH_EVERY);
        let mut cleaned_at: Option<Instant> = None;
        loop {
            tick.tick().await;
            if let Err(err) = log.flush(&pool).await {
                tracing::warn!(error = %err, "failed to write access logs");
            }
            if cleaned_at.is_none_or(|at| at.elapsed() >= CLEANUP_EVERY) {
                cleaned_at = Some(Instant::now());
                let deleted =
                    sqlx::query("DELETE FROM access_logs WHERE created_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?)")
                        .bind(format!("-{KEEP_DAYS} days"))
                        .execute(&pool)
                        .await;
                if let Err(err) = deleted {
                    tracing::warn!(error = %err, "failed to clean up access logs");
                }
            }
        }
    });
}

/// 給 `middleware::from_fn_with_state` 用的狀態
#[derive(Clone)]
pub struct Recorder {
    state: AppState,
    /// `static_dir` 最上層的檔案和資料夾名稱
    static_entries: Arc<HashSet<String>>,
}

impl Recorder {
    pub fn new(state: AppState, static_dir: &FsPath) -> Self {
        let static_entries = std::fs::read_dir(static_dir)
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|entry| entry.file_name().into_string().ok())
            .collect();
        Self { state, static_entries: Arc::new(static_entries) }
    }

    fn skip(&self, path: &str) -> bool {
        if path == "/api/health" || path.starts_with("/api/admin/access") {
            return true;
        }
        let first = path.trim_start_matches('/').split('/').next().unwrap_or_default();
        !first.is_empty() && first != "api" && self.static_entries.contains(first)
    }
}

fn truncate(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

pub async fn record(State(recorder): State<Recorder>, request: Request, next: Next) -> Response {
    let path = request.uri().path().to_owned();
    if recorder.skip(&path) {
        return next.run(request).await;
    }
    let headers = request.headers();
    let ip = client_key(headers);
    let method = request.method().to_string();
    let query = request.uri().query().unwrap_or_default().to_owned();
    let session = read_session_token(headers, &recorder.state.session_cookie_name()).map(|t| token_hash(&t));
    let user_agent = headers.get(header::USER_AGENT).and_then(|v| v.to_str().ok()).unwrap_or_default();
    let user_agent = truncate(user_agent, MAX_USER_AGENT_LEN);
    let created_at = Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
    let started = Instant::now();

    let response = next.run(request).await;

    let log = &recorder.state.access_log;
    if log.allow(&ip) {
        log.push(Entry {
            ip,
            method,
            path: truncate(&path, MAX_PATH_LEN),
            query: truncate(&query, MAX_QUERY_LEN),
            status: response.status().as_u16(),
            duration_ms: started.elapsed().as_millis() as i64,
            session,
            user_agent,
            created_at,
        });
    }
    response
}

// ---- 查詢 ----

fn since(hours: Option<u32>) -> String {
    format!("-{} hours", hours.unwrap_or(DEFAULT_HOURS).clamp(1, MAX_HOURS))
}

#[derive(Deserialize)]
pub struct ReportQuery {
    pub hours: Option<u32>,
    /// `recent`（最後活動，預設）或 `requests`（請求數）
    #[serde(default)]
    pub sort: String,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct AccessSummary {
    pub requests: i64,
    pub ips: i64,
    /// 登入過的不同帳號數
    pub users: i64,
    /// 狀態碼 400 以上的請求數
    pub errors: i64,
}

#[derive(sqlx::FromRow)]
struct IpRow {
    ip: String,
    requests: i64,
    errors: i64,
    first_at: String,
    last_at: String,
    users: String,
    last_method: String,
    last_path: String,
    user_agent: String,
}

/// 一個 IP 在查詢範圍內的請求；最後一筆的路徑和 User-Agent 另外列出來
#[derive(Serialize)]
pub struct IpSummary {
    pub ip: String,
    pub requests: i64,
    pub errors: i64,
    pub first_at: String,
    pub last_at: String,
    pub users: Vec<String>,
    pub last_method: String,
    pub last_path: String,
    pub user_agent: String,
}

impl From<IpRow> for IpSummary {
    fn from(row: IpRow) -> Self {
        Self {
            ip: row.ip,
            requests: row.requests,
            errors: row.errors,
            first_at: row.first_at,
            last_at: row.last_at,
            users: row.users.split(',').filter(|s| !s.is_empty()).map(Into::into).collect(),
            last_method: row.last_method,
            last_path: row.last_path,
            user_agent: row.user_agent,
        }
    }
}

#[derive(Serialize, sqlx::FromRow)]
pub struct PathSummary {
    pub path: String,
    pub requests: i64,
    pub ips: i64,
    pub errors: i64,
}

#[derive(Serialize)]
pub struct AccessReport {
    pub summary: AccessSummary,
    pub ips: Vec<IpSummary>,
    /// 請求最多的路徑（不分 query）
    pub paths: Vec<PathSummary>,
}

pub async fn report(
    State(state): State<AppState>,
    _: Require<AdminUsers>,
    Query(query): Query<ReportQuery>,
) -> Result<Json<AccessReport>, AppError> {
    let since = since(query.hours);
    let summary = sqlx::query_as::<_, AccessSummary>(
        "SELECT COUNT(*) AS requests, COUNT(DISTINCT ip) AS ips, COUNT(DISTINCT user_id) AS users,
            COALESCE(SUM(status >= 400), 0) AS errors
         FROM access_logs WHERE created_at >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?)",
    )
    .bind(&since)
    .fetch_one(&state.pool)
    .await?;

    // 帳號名稱只有英數字和 _ . -，所以可以用 group_concat 的預設逗號分隔
    let ips = sqlx::query_as::<_, IpRow>(
        "SELECT g.ip, g.requests, g.errors, g.first_at, g.last_at, g.users,
            a.method AS last_method, a.path AS last_path, a.user_agent
         FROM (
            SELECT l.ip, COUNT(*) AS requests, SUM(l.status >= 400) AS errors,
                MIN(l.created_at) AS first_at, MAX(l.created_at) AS last_at, MAX(l.id) AS last_id,
                COALESCE(group_concat(DISTINCT u.username), '') AS users
            FROM access_logs l LEFT JOIN users u ON u.id = l.user_id
            WHERE l.created_at >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?)
            GROUP BY l.ip
         ) g JOIN access_logs a ON a.id = g.last_id
         ORDER BY CASE WHEN ? = 'requests' THEN g.requests ELSE 0 END DESC, g.last_id DESC LIMIT ?",
    )
    .bind(&since)
    .bind(&query.sort)
    .bind(MAX_IPS)
    .fetch_all(&state.pool)
    .await?;

    let paths = sqlx::query_as::<_, PathSummary>(
        "SELECT path, COUNT(*) AS requests, COUNT(DISTINCT ip) AS ips, SUM(status >= 400) AS errors
         FROM access_logs WHERE created_at >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?)
         GROUP BY path ORDER BY requests DESC, path LIMIT ?",
    )
    .bind(&since)
    .bind(MAX_PATHS)
    .fetch_all(&state.pool)
    .await?;

    Ok(Json(AccessReport { summary, ips: ips.into_iter().map(Into::into).collect(), paths }))
}

#[derive(Deserialize)]
pub struct RequestsQuery {
    pub hours: Option<u32>,
    /// 只看這個 IP
    #[serde(default)]
    pub ip: String,
    /// 只看狀態碼 400 以上的
    #[serde(default)]
    pub errors: bool,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct AccessRequest {
    pub id: i64,
    pub ip: String,
    pub method: String,
    pub path: String,
    pub query: String,
    pub status: i64,
    pub duration_ms: i64,
    pub username: Option<String>,
    pub user_agent: String,
    pub created_at: String,
}

/// 最近的 500 筆請求，新的在前面
pub async fn requests(
    State(state): State<AppState>,
    _: Require<AdminUsers>,
    Query(query): Query<RequestsQuery>,
) -> Result<Json<Vec<AccessRequest>>, AppError> {
    let requests = sqlx::query_as::<_, AccessRequest>(
        "SELECT l.id, l.ip, l.method, l.path, l.query, l.status, l.duration_ms, u.username, l.user_agent, l.created_at
         FROM access_logs l LEFT JOIN users u ON u.id = l.user_id
         WHERE l.created_at >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?)
            AND (? = '' OR l.ip = ?) AND (NOT ? OR l.status >= 400)
         ORDER BY l.id DESC LIMIT ?",
    )
    .bind(since(query.hours))
    .bind(&query.ip)
    .bind(&query.ip)
    .bind(query.errors)
    .bind(MAX_REQUESTS)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(requests))
}
