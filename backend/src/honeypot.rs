//! 假的 `.env`：掃描器常來找 `/.env`、`/.env.local`、`/api/.env` 這類設定檔，想撿資料庫密碼和金鑰。
//! 這裡故意回一份看起來像真的設定檔，記下是誰來拿的，在「系統管理 › .env 蜜罐」查（需要 `admin.users`）。
//!
//! 檔案裡的主機、帳號和密碼全是假的：IP 是連不到的內網位址，密碼由啟動時隨機產生的金鑰和來源 IP 算出來，跟真正的設定無關。
//! 每個 IP 拿到的密碼都不一樣（同一個 IP 每次拿到的一樣，看起來才像真的），發出去的密碼記在 `honeypot_secrets`，
//! 之後有人拿其中一個來登入（[`check_login`]），就知道是誰拿去用、當初是發給哪個 IP 的。
//! 有設定 canarytokens.org 的 AWS 金鑰的話也會放進去，有人拿去呼叫 AWS 時 canarytokens 會寄信通知。
//!
//! 正常使用者不會打開這些網址，所以拿過假檔案或用過假密碼的 IP 24 小時內不能登入和註冊（[`is_blocked`]），
//! 除非 30 天內有帳號在那個 IP 登入過（例如管理員自己點開來看），或管理員在頁面上解除封鎖。
//!
//! 同一個 IP 10 分鐘超過 200 筆的部分不記（照樣回假檔案），紀錄保留 180 天。

use axum::{
    Json,
    extract::{Path, Query, Request, State},
    http::{HeaderMap, StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;

use crate::{
    AppError, AppState,
    auth::{AdminUsers, Require, client_key, read_session_token, token_hash},
    visits::VisitLimiter,
};

const KEEP_DAYS: u32 = 180;
/// 拿過假檔案或用過假密碼之後，多久不能登入和註冊
const BLOCK_HOURS: u32 = 24;
/// 這麼多天內有帳號在這個 IP 登入過的話不擋（自己人）
const TRUST_DAYS: u32 = 30;
const MAX_PATH_LEN: usize = 300;
const MAX_QUERY_LEN: usize = 300;
const MAX_USER_AGENT_LEN: usize = 300;
const MAX_USERNAME_LEN: usize = 100;
/// 假密碼最長 24 字，比這長的密碼不用查
const MAX_SECRET_LEN: usize = 64;
/// 管理頁一次列出幾個 IP、幾個路徑、幾筆紀錄
const MAX_IPS: i64 = 300;
const MAX_PATHS: i64 = 30;
const MAX_HITS: i64 = 500;
const MAX_USES: i64 = 100;

/// 產生假密碼的金鑰、每個 IP 的紀錄上限、要放進假檔案的 AWS 金鑰
pub struct Honeypot {
    key: [u8; 32],
    /// 每個 IP 最多記幾次來拿假檔案
    hits: VisitLimiter,
    /// 每個 IP 最多記幾次用假密碼登入
    uses: VisitLimiter,
    aws: Option<AwsKey>,
}

/// canarytokens.org 產生的 AWS 金鑰：有人拿去呼叫 AWS，canarytokens 會寄信通知，信裡有對方的 IP
struct AwsKey {
    id: String,
    secret: String,
}

impl Default for Honeypot {
    fn default() -> Self {
        let mut key = [0u8; 32];
        // 只是假資料，萬一拿不到亂數也沒關係
        let _ = getrandom::fill(&mut key);
        Self { key, hits: VisitLimiter::default(), uses: VisitLimiter::default(), aws: None }
    }
}

impl Honeypot {
    /// `HONEYPOT_AWS_ACCESS_KEY_ID` 和 `HONEYPOT_AWS_SECRET_ACCESS_KEY` 都有設定才放 AWS 金鑰
    pub fn from_env() -> Self {
        let var = |name| std::env::var(name).ok().map(|v| v.trim().to_owned()).filter(|v| !v.is_empty());
        match (var("HONEYPOT_AWS_ACCESS_KEY_ID"), var("HONEYPOT_AWS_SECRET_ACCESS_KEY")) {
            (Some(id), Some(secret)) => Self::default().with_aws_key(id, secret),
            _ => Self::default(),
        }
    }

    pub fn with_aws_key(mut self, id: impl Into<String>, secret: impl Into<String>) -> Self {
        self.aws = Some(AwsKey { id: id.into(), secret: secret.into() });
        self
    }

    /// 由金鑰、欄位名稱和 IP 算出來：同一個 IP 每次一樣，不同 IP 不一樣，沒有金鑰的人猜不到
    fn derive(&self, ip: &str, field: &str) -> Vec<u8> {
        let mut hasher = Sha256::new();
        hasher.update(self.key);
        hasher.update(field.as_bytes());
        hasher.update([0]);
        hasher.update(ip.as_bytes());
        hasher.finalize().to_vec()
    }

    fn text(&self, ip: &str, field: &str, len: usize) -> String {
        const CHARS: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
        self.derive(ip, field).iter().take(len).map(|b| CHARS[*b as usize % CHARS.len()] as char).collect()
    }

    fn hex(&self, ip: &str, field: &str, bytes: usize) -> String {
        self.derive(ip, field).iter().take(bytes).map(|b| format!("{b:02x}")).collect()
    }

    /// 發給 `ip` 的假設定檔
    fn bait(&self, ip: &str) -> Bait {
        let secrets = [("DB_PASSWORD", 24), ("REDIS_PASSWORD", 20), ("SMTP_PASSWORD", 16), ("ADMIN_PASSWORD", 20)]
            .map(|(field, len)| (field, self.text(ip, field, len)));
        let [(_, db), (_, redis), (_, smtp), (_, admin)] = &secrets;
        let aws = self.aws.as_ref().map_or_else(String::new, |key| {
            format!(
                "
AWS_ACCESS_KEY_ID={}
AWS_SECRET_ACCESS_KEY={}
AWS_DEFAULT_REGION=ap-northeast-1
AWS_S3_BUCKET=ouyang-prod-uploads
",
                key.id, key.secret
            )
        });
        let text = format!(
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

ADMIN_USER=sysadmin
ADMIN_PASSWORD={admin}
{aws}",
            jwt = self.hex(ip, "JWT_SECRET", 32),
            session = self.hex(ip, "SESSION_SECRET", 32),
            encryption = self.hex(ip, "ENCRYPTION_KEY", 16),
        );
        Bait { text, secrets }
    }
}

struct Bait {
    text: String,
    /// 會記在 `honeypot_secrets` 的密碼：(哪一行, 值)
    secrets: [(&'static str, String); 4],
}

/// 路徑最後一段是 `.env` 或 `.env.<什麼都可以>`（`.env.local`、`.env.production`、`.env.bak`…），在哪一層底下都算
pub fn is_bait(path: &str) -> bool {
    let last = path.trim_end_matches('/').rsplit('/').next().unwrap_or_default();
    last == ".env" || last.starts_with(".env.")
}

fn truncate(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

fn user_agent(headers: &HeaderMap) -> String {
    let value = headers.get(header::USER_AGENT).and_then(|v| v.to_str().ok()).unwrap_or_default();
    truncate(value, MAX_USER_AGENT_LEN)
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
    let user_agent = user_agent(headers);
    let method = request.method().to_string();
    let path = truncate(request.uri().path(), MAX_PATH_LEN);
    let query = truncate(request.uri().query().unwrap_or_default(), MAX_QUERY_LEN);
    drop(request);

    let bait = state.honeypot.bait(&ip);
    if state.honeypot.hits.allow(&ip) {
        let saved = save(&state.pool, Hit { ip, method, path, query, session, user_agent }, &bait.secrets).await;
        if let Err(err) = saved {
            tracing::warn!(error = %err, "failed to record honeypot hit");
        }
    }
    ([(header::CONTENT_TYPE, "text/plain; charset=utf-8"), (header::CACHE_CONTROL, "no-store")], bait.text)
        .into_response()
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

async fn save(pool: &SqlitePool, hit: Hit, secrets: &[(&str, String)]) -> Result<(), sqlx::Error> {
    // 很少有人來，每次順便清掉太舊的
    let cutoff = format!("-{KEEP_DAYS} days");
    for sql in [
        "DELETE FROM honeypot_hits WHERE created_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?)",
        "DELETE FROM honeypot_secrets WHERE created_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?)",
        "DELETE FROM honeypot_uses WHERE created_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?)",
    ] {
        sqlx::query(sql).bind(&cutoff).execute(pool).await?;
    }
    for (field, value) in secrets {
        sqlx::query("INSERT OR IGNORE INTO honeypot_secrets (value, ip, field) VALUES (?, ?, ?)")
            .bind(value)
            .bind(&hit.ip)
            .bind(field)
            .execute(pool)
            .await?;
    }
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
    .execute(pool)
    .await?;
    Ok(())
}

// ---- 假密碼被拿去用、封鎖 ----

/// 登入時先呼叫：密碼是發出去的假密碼就記一筆。查詢或寫入失敗只記 log，不影響登入本身
pub async fn check_login(state: &AppState, headers: &HeaderMap, username: &str, password: &str) {
    if password.is_empty() || password.len() > MAX_SECRET_LEN {
        return;
    }
    let ip = client_key(headers);
    let result = async {
        let issued = sqlx::query_as::<_, (String, String, String)>(
            "SELECT field, ip, created_at FROM honeypot_secrets WHERE value = ?",
        )
        .bind(password)
        .fetch_optional(&state.pool)
        .await?;
        let Some((field, issued_ip, issued_at)) = issued else { return Ok(()) };
        tracing::warn!(%ip, %field, %issued_ip, "honeypot password used to log in");
        if !state.honeypot.uses.allow(&ip) {
            return Ok(());
        }
        sqlx::query(
            "INSERT INTO honeypot_uses (ip, field, issued_ip, issued_at, username, user_agent) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(&ip)
        .bind(field)
        .bind(issued_ip)
        .bind(issued_at)
        .bind(truncate(username.trim(), MAX_USERNAME_LEN))
        .bind(user_agent(headers))
        .execute(&state.pool)
        .await
        .map(|_| ())
    }
    .await;
    if let Err(err) = result {
        tracing::warn!(error = %err, "failed to check honeypot password");
    }
}

/// 現在被擋的 IP 和擋到什麼時候
#[derive(Serialize, sqlx::FromRow)]
pub struct Block {
    pub ip: String,
    pub until: String,
}

/// `ip` 是空字串就列出全部。最近 24 小時拿過假檔案（不算有登入的時候）或用過假密碼、
/// 而且那之後沒有被管理員解除、30 天內沒有帳號在這個 IP 登入過的，就是被擋
async fn blocks(pool: &SqlitePool, ip: &str) -> Result<Vec<Block>, sqlx::Error> {
    sqlx::query_as::<_, Block>(
        "WITH recent AS (
            SELECT ip, created_at FROM honeypot_hits
            WHERE user_id IS NULL AND created_at >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?1) AND (?2 = '' OR ip = ?2)
            UNION ALL
            SELECT ip, created_at FROM honeypot_uses
            WHERE created_at >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?1) AND (?2 = '' OR ip = ?2)
         )
         SELECT r.ip, strftime('%Y-%m-%dT%H:%M:%SZ', MAX(r.created_at), ?3) AS until
         FROM recent r LEFT JOIN honeypot_pardons p ON p.ip = r.ip
         WHERE r.created_at > COALESCE(p.created_at, '')
           AND NOT EXISTS (SELECT 1 FROM access_logs a WHERE a.ip = r.ip AND a.user_id IS NOT NULL
                           AND a.created_at >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?4))
         GROUP BY r.ip
         ORDER BY until DESC",
    )
    .bind(format!("-{BLOCK_HOURS} hours"))
    .bind(ip)
    .bind(format!("+{BLOCK_HOURS} hours"))
    .bind(format!("-{TRUST_DAYS} days"))
    .fetch_all(pool)
    .await
}

/// 登入和註冊前檢查
pub async fn is_blocked(pool: &SqlitePool, ip: &str) -> Result<bool, sqlx::Error> {
    // 空字串在 blocks 裡代表全部
    if ip.is_empty() {
        return Ok(false);
    }
    Ok(!blocks(pool, ip).await?.is_empty())
}

/// 管理員解除封鎖：這之前的紀錄不再算，之後再來拿還是會被擋
pub async fn unblock(
    State(state): State<AppState>,
    Require(user, _): Require<AdminUsers>,
    Path(ip): Path<String>,
) -> Result<StatusCode, AppError> {
    if ip.is_empty() || ip.len() > 100 {
        return Err(AppError::BadRequest("IP 格式不正確".into()));
    }
    sqlx::query(
        "INSERT INTO honeypot_pardons (ip, user_id) VALUES (?, ?)
         ON CONFLICT (ip) DO UPDATE SET user_id = excluded.user_id, created_at = excluded.created_at",
    )
    .bind(&ip)
    .bind(user.id)
    .execute(&state.pool)
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

// ---- 查詢 ----

#[derive(Serialize)]
pub struct HoneypotSummary {
    pub hits: i64,
    pub ips: i64,
    /// 最近 24 小時的次數和不同 IP 數
    pub last_day: i64,
    pub last_day_ips: i64,
    /// 假密碼被拿去登入的次數
    pub uses: i64,
    /// 現在被擋的 IP 數
    pub blocked: usize,
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

/// 有人拿假密碼來登入
#[derive(Serialize, sqlx::FromRow)]
pub struct HoneypotUse {
    pub id: i64,
    pub ip: String,
    pub field: String,
    pub issued_ip: String,
    pub issued_at: String,
    pub username: String,
    pub user_agent: String,
    pub created_at: String,
}

#[derive(Serialize)]
pub struct HoneypotReport {
    pub summary: HoneypotSummary,
    /// 最近來過的在前面
    pub ips: Vec<HoneypotIp>,
    /// 被找最多次的路徑
    pub paths: Vec<HoneypotPath>,
    /// 最近 100 次用假密碼登入，新的在前面
    pub uses: Vec<HoneypotUse>,
    /// 現在被擋的 IP（包含只用過假密碼、沒拿過假檔案的）
    pub blocks: Vec<Block>,
}

pub async fn report(State(state): State<AppState>, _: Require<AdminUsers>) -> Result<Json<HoneypotReport>, AppError> {
    let (hits, ips, last_day, last_day_ips, uses) = sqlx::query_as::<_, (i64, i64, i64, i64, i64)>(
        "SELECT COUNT(*), COUNT(DISTINCT ip),
            COALESCE(SUM(created_at >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 day')), 0),
            COUNT(DISTINCT CASE WHEN created_at >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 day') THEN ip END),
            (SELECT COUNT(*) FROM honeypot_uses)
         FROM honeypot_hits",
    )
    .fetch_one(&state.pool)
    .await?;
    let blocks = blocks(&state.pool, "").await?;
    let summary = HoneypotSummary { hits, ips, last_day, last_day_ips, uses, blocked: blocks.len() };

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

    let uses = sqlx::query_as::<_, HoneypotUse>(
        "SELECT id, ip, field, issued_ip, issued_at, username, user_agent, created_at
         FROM honeypot_uses ORDER BY id DESC LIMIT ?",
    )
    .bind(MAX_USES)
    .fetch_all(&state.pool)
    .await?;

    Ok(Json(HoneypotReport { summary, ips: ips.into_iter().map(Into::into).collect(), paths, uses, blocks }))
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
    use super::{Honeypot, is_bait};

    #[test]
    fn bait_paths() {
        for path in ["/.env", "/.env/", "/.env.local", "/.env.production", "/api/.env", "/app/config/.env.bak"] {
            assert!(is_bait(path), "{path}");
        }
        for path in ["/", "/env", "/.envrc", "/.git/config", "/foo.env", "/.env/config", "/api/health"] {
            assert!(!is_bait(path), "{path}");
        }
    }

    #[test]
    fn each_ip_gets_its_own_passwords() {
        let honeypot = Honeypot::default();
        let a = honeypot.bait("203.0.113.5");
        assert_eq!(honeypot.bait("203.0.113.5").text, a.text);
        let b = honeypot.bait("198.51.100.7");
        for ((field, mine), (_, theirs)) in a.secrets.iter().zip(&b.secrets) {
            assert_ne!(mine, theirs, "{field}");
            assert!(a.text.contains(&format!("{field}={mine}\n")), "{field}");
        }
        // 另一個程序（金鑰不同）發給同一個 IP 的也不一樣
        assert_ne!(Honeypot::default().bait("203.0.113.5").text, a.text);
        // 沒設定 AWS 金鑰就不放
        assert!(!a.text.contains("AWS_"));
        let with_aws = Honeypot::default().with_aws_key("AKIAEXAMPLE", "secret/example");
        let text = with_aws.bait("203.0.113.5").text;
        assert!(text.contains("AWS_ACCESS_KEY_ID=AKIAEXAMPLE\nAWS_SECRET_ACCESS_KEY=secret/example\n"), "{text}");
    }
}
