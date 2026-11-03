//! 假的 `.env`：掃描器常來找 `/.env`、`/.env.local`、`/api/.env` 這類設定檔，想撿資料庫密碼和金鑰。
//! 這裡故意回一份看起來像真的設定檔，記下是誰來拿的，在「系統管理 › .env 蜜罐」查（需要 `admin.users`）。
//!
//! 檔案裡的主機、帳號和密碼全是假的：IP 是連不到的內網位址，密碼是每次啟動時隨機產生的，跟真正的設定無關。
//! 正常使用者不會打開這些網址，所以來過的幾乎都是掃描器。
//! 同一個 IP 10 分鐘超過 200 筆的部分不記（照樣回假檔案），紀錄保留 180 天。

use std::sync::OnceLock;

use axum::{
    Json,
    extract::{Query, Request, State},
    http::header,
    middleware::Next,
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};

use crate::{
    AppError, AppState,
    auth::{AdminUsers, Require, client_key, read_session_token, token_hash},
};

const KEEP_DAYS: u32 = 180;
const MAX_PATH_LEN: usize = 300;
const MAX_QUERY_LEN: usize = 300;
const MAX_USER_AGENT_LEN: usize = 300;
/// 管理頁一次列出幾個 IP、幾個路徑、幾筆紀錄
const MAX_IPS: i64 = 300;
const MAX_PATHS: i64 = 30;
const MAX_HITS: i64 = 500;

/// 路徑最後一段是 `.env` 或 `.env.<什麼都可以>`（`.env.local`、`.env.production`、`.env.bak`…），在哪一層底下都算
pub fn is_bait(path: &str) -> bool {
    let last = path.trim_end_matches('/').rsplit('/').next().unwrap_or_default();
    last == ".env" || last.starts_with(".env.")
}

fn random_text(len: usize) -> String {
    const CHARS: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
    let mut bytes = vec![0u8; len];
    // 只是假資料，萬一拿不到亂數也沒關係
    let _ = getrandom::fill(&mut bytes);
    bytes.iter().map(|b| CHARS[*b as usize % CHARS.len()] as char).collect()
}

fn random_hex(bytes: usize) -> String {
    const HEX: &[u8] = b"0123456789abcdef";
    let mut buf = vec![0u8; bytes];
    let _ = getrandom::fill(&mut buf);
    buf.iter().flat_map(|b| [HEX[(b >> 4) as usize] as char, HEX[(b & 15) as usize] as char]).collect()
}

/// 假的設定檔。同一個程序裡每次拿到的都一樣，看起來才像真的檔案
fn bait() -> &'static str {
    static BAIT: OnceLock<String> = OnceLock::new();
    BAIT.get_or_init(|| {
        let db = random_text(24);
        let redis = random_text(20);
        format!(
            "NODE_ENV=production
PORT=3000
LOG_LEVEL=info

DB_HOST=10.0.1.24
DB_PORT=5432
DB_NAME=ouyang_prod
DB_USER=ouyang_app
DB_PASSWORD={db}
DATABASE_URL=postgresql://ouyang_app:{db}@10.0.1.24:5432/ouyang_prod

REDIS_HOST=10.0.1.31
REDIS_PORT=6379
REDIS_PASSWORD={redis}

JWT_SECRET={jwt}
JWT_EXPIRES_IN=7d
SESSION_SECRET={session}
ENCRYPTION_KEY={encryption}

SMTP_HOST=10.0.1.40
SMTP_PORT=587
SMTP_USER=noreply
SMTP_PASSWORD={smtp}
",
            jwt = random_hex(32),
            session = random_hex(32),
            encryption = random_hex(16),
            smtp = random_text(16),
        )
    })
}

fn truncate(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

/// 放在最外層的 middleware：是誘餌路徑就記一筆並回假檔案，不是就照常處理
pub async fn intercept(State(state): State<AppState>, request: Request, next: Next) -> Response {
    if !is_bait(request.uri().path()) {
        return next.run(request).await;
    }
    // Request 不能跨 await 借用（body 不是 Sync），先把要記的東西取出來
    let headers = request.headers();
    let ip = client_key(headers);
    let session = read_session_token(headers, &state.session_cookie_name()).map(|t| token_hash(&t));
    let user_agent = headers.get(header::USER_AGENT).and_then(|v| v.to_str().ok()).unwrap_or_default();
    let user_agent = truncate(user_agent, MAX_USER_AGENT_LEN);
    let method = request.method().to_string();
    let path = truncate(request.uri().path(), MAX_PATH_LEN);
    let query = truncate(request.uri().query().unwrap_or_default(), MAX_QUERY_LEN);
    drop(request);

    if state.honeypot_limiter.allow(&ip) {
        let saved = save(&state, Hit { ip, method, path, query, session, user_agent }).await;
        if let Err(err) = saved {
            tracing::warn!(error = %err, "failed to record honeypot hit");
        }
    }
    ([(header::CONTENT_TYPE, "text/plain; charset=utf-8"), (header::CACHE_CONTROL, "no-store")], bait()).into_response()
}

struct Hit {
    ip: String,
    method: String,
    path: String,
    query: String,
    /// session token 的雜湊，寫入時換成帳號
    session: Option<String>,
    user_agent: String,
}

async fn save(state: &AppState, hit: Hit) -> Result<(), sqlx::Error> {
    // 很少有人來，每次順便清掉太舊的
    sqlx::query("DELETE FROM honeypot_hits WHERE created_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?)")
        .bind(format!("-{KEEP_DAYS} days"))
        .execute(&state.pool)
        .await?;
    sqlx::query(
        "INSERT INTO honeypot_hits (ip, method, path, query, user_id, user_agent)
         VALUES (?, ?, ?, ?, (SELECT user_id FROM sessions WHERE token_hash = ?
                                AND expires_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now')), ?)",
    )
    .bind(hit.ip)
    .bind(hit.method)
    .bind(hit.path)
    .bind(hit.query)
    .bind(hit.session)
    .bind(hit.user_agent)
    .execute(&state.pool)
    .await?;
    Ok(())
}

// ---- 查詢 ----

#[derive(Serialize, sqlx::FromRow)]
pub struct HoneypotSummary {
    pub hits: i64,
    pub ips: i64,
    /// 最近 24 小時的次數和不同 IP 數
    pub last_day: i64,
    pub last_day_ips: i64,
}

#[derive(sqlx::FromRow)]
struct IpRow {
    ip: String,
    hits: i64,
    first_at: String,
    last_at: String,
    /// JSON 陣列（路徑可能有逗號，不能用 group_concat）
    paths: String,
    users: String,
    user_agent: String,
}

/// 一個 IP 找過哪些路徑；User-Agent 是最後一次的
#[derive(Serialize)]
pub struct HoneypotIp {
    pub ip: String,
    pub hits: i64,
    pub first_at: String,
    pub last_at: String,
    pub paths: Vec<String>,
    pub users: Vec<String>,
    pub user_agent: String,
}

impl From<IpRow> for HoneypotIp {
    fn from(row: IpRow) -> Self {
        let mut paths: Vec<String> = serde_json::from_str(&row.paths).unwrap_or_default();
        paths.sort();
        Self {
            ip: row.ip,
            hits: row.hits,
            first_at: row.first_at,
            last_at: row.last_at,
            paths,
            users: row.users.split(',').filter(|s| !s.is_empty()).map(Into::into).collect(),
            user_agent: row.user_agent,
        }
    }
}

#[derive(Serialize, sqlx::FromRow)]
pub struct HoneypotPath {
    pub path: String,
    pub hits: i64,
    pub ips: i64,
}

#[derive(Serialize)]
pub struct HoneypotReport {
    pub summary: HoneypotSummary,
    /// 最近來過的在前面
    pub ips: Vec<HoneypotIp>,
    /// 被找最多次的路徑
    pub paths: Vec<HoneypotPath>,
}

pub async fn report(State(state): State<AppState>, _: Require<AdminUsers>) -> Result<Json<HoneypotReport>, AppError> {
    let summary = sqlx::query_as::<_, HoneypotSummary>(
        "SELECT COUNT(*) AS hits, COUNT(DISTINCT ip) AS ips,
            COALESCE(SUM(created_at >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 day')), 0) AS last_day,
            COUNT(DISTINCT CASE WHEN created_at >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 day') THEN ip END)
                AS last_day_ips
         FROM honeypot_hits",
    )
    .fetch_one(&state.pool)
    .await?;

    // 帳號名稱只有英數字和 _ . -，所以可以用 group_concat 的預設逗號分隔
    let ips = sqlx::query_as::<_, IpRow>(
        "SELECT g.ip, g.hits, g.first_at, g.last_at, g.paths, g.users, h.user_agent
         FROM (
            SELECT x.ip, COUNT(*) AS hits, MIN(x.created_at) AS first_at, MAX(x.created_at) AS last_at,
                MAX(x.id) AS last_id, json_group_array(DISTINCT x.path) AS paths,
                COALESCE(group_concat(DISTINCT u.username), '') AS users
            FROM honeypot_hits x LEFT JOIN users u ON u.id = x.user_id
            GROUP BY x.ip
         ) g JOIN honeypot_hits h ON h.id = g.last_id
         ORDER BY g.last_id DESC LIMIT ?",
    )
    .bind(MAX_IPS)
    .fetch_all(&state.pool)
    .await?;

    let paths = sqlx::query_as::<_, HoneypotPath>(
        "SELECT path, COUNT(*) AS hits, COUNT(DISTINCT ip) AS ips
         FROM honeypot_hits GROUP BY path ORDER BY hits DESC, path LIMIT ?",
    )
    .bind(MAX_PATHS)
    .fetch_all(&state.pool)
    .await?;

    Ok(Json(HoneypotReport { summary, ips: ips.into_iter().map(Into::into).collect(), paths }))
}

#[derive(Deserialize)]
pub struct HitsQuery {
    /// 只看這個 IP；沒給就是全部
    #[serde(default)]
    pub ip: String,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct HoneypotHit {
    pub id: i64,
    pub ip: String,
    pub method: String,
    pub path: String,
    pub query: String,
    pub username: Option<String>,
    pub user_agent: String,
    pub created_at: String,
}

/// 最近的 500 筆，新的在前面
pub async fn hits(
    State(state): State<AppState>,
    _: Require<AdminUsers>,
    Query(query): Query<HitsQuery>,
) -> Result<Json<Vec<HoneypotHit>>, AppError> {
    let hits = sqlx::query_as::<_, HoneypotHit>(
        "SELECT h.id, h.ip, h.method, h.path, h.query, u.username, h.user_agent, h.created_at
         FROM honeypot_hits h LEFT JOIN users u ON u.id = h.user_id
         WHERE ? = '' OR h.ip = ?
         ORDER BY h.id DESC LIMIT ?",
    )
    .bind(&query.ip)
    .bind(&query.ip)
    .bind(MAX_HITS)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(hits))
}

#[cfg(test)]
mod tests {
    use super::is_bait;

    #[test]
    fn bait_paths() {
        for path in ["/.env", "/.env/", "/.env.local", "/.env.production", "/api/.env", "/app/config/.env.bak"] {
            assert!(is_bait(path), "{path}");
        }
        for path in ["/", "/env", "/.envrc", "/.git/config", "/foo.env", "/.env/config", "/api/health"] {
            assert!(!is_bait(path), "{path}");
        }
    }
}
