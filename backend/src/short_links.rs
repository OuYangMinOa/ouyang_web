//! 短網址：登入的人建立 `/s/<code>`，打開就 302 跳到原本的網址，並記下每一次是誰（IP、帳號、User-Agent、Referer）點的。
//!
//! - 代碼沒指定時隨機產生 4 碼（小寫英文加數字，去掉 0 o 1 l i 這些容易看錯的），撞到就重抽，一直撞就多一碼。
//!   也可以自訂 2～32 個英數字、`-`、`_`，大小寫有分。
//! - `require_login` 的短網址沒登入時先導到登入頁，登入後再回來跳轉。
//! - 只有建立的人看得到、改得到自己的短網址和統計（別人的回 404）。代碼建立後不能改，QR Code 才不會失效。
//! - 同一個 IP 10 分鐘超過 200 次的部分照樣跳轉，但不記；點擊紀錄保留 180 天。

use axum::{
    Json,
    extract::{Path, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Redirect, Response},
};
use reqwest::Url;
use serde::{Deserialize, Serialize};

use crate::{
    AppError, AppState,
    auth::{CurrentUser, client_key},
};

const CODE_CHARS: &[u8] = b"abcdefghjkmnpqrstuvwxyz23456789";
const CODE_LEN: usize = 4;
const MAX_CODE_LEN: usize = 32;
const MAX_URL_LEN: usize = 2000;
const MAX_TITLE_LEN: usize = 100;
const MAX_USER_AGENT_LEN: usize = 300;
const MAX_REFERER_LEN: usize = 300;
const MAX_LINKS_PER_USER: i64 = 500;
const KEEP_DAYS: u32 = 180;
/// 統計頁一次列出幾個 IP、幾筆點擊、最近幾天的每日次數
const MAX_IPS: i64 = 300;
const MAX_CLICKS: i64 = 300;
const DAYS: u32 = 30;

fn truncate(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

fn random_code(len: usize) -> String {
    let mut bytes = vec![0u8; len];
    getrandom::fill(&mut bytes).expect("random code");
    bytes.iter().map(|b| CODE_CHARS[*b as usize % CODE_CHARS.len()] as char).collect()
}

fn validate_code(code: &str) -> Result<(), AppError> {
    let ok = (2..=MAX_CODE_LEN).contains(&code.len())
        && code.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok {
        Ok(())
    } else {
        Err(AppError::BadRequest(format!("代碼只能是 2～{MAX_CODE_LEN} 個英數字、- 或 _")))
    }
}

/// 只接受 http／https 的完整網址；沒寫 scheme 就當 https
fn normalize_url(input: &str) -> Result<String, AppError> {
    let input = input.trim();
    if input.is_empty() {
        return Err(AppError::BadRequest("請輸入網址".into()));
    }
    if input.len() > MAX_URL_LEN {
        return Err(AppError::BadRequest(format!("網址不可超過 {MAX_URL_LEN} 字")));
    }
    let with_scheme = if input.contains("://") { input.to_owned() } else { format!("https://{input}") };
    let url = Url::parse(&with_scheme).map_err(|_| AppError::BadRequest("網址格式不正確".into()))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none_or(|h| !h.contains('.') && h != "localhost")
    {
        return Err(AppError::BadRequest("網址格式不正確".into()));
    }
    Ok(url.to_string())
}

#[derive(Serialize, sqlx::FromRow)]
pub struct ShortLink {
    pub id: i64,
    pub code: String,
    pub url: String,
    pub title: String,
    pub require_login: bool,
    pub created_at: String,
    pub clicks: i64,
    pub ips: i64,
    pub last_click_at: Option<String>,
}

/// 自己的短網址，新的在前面；`id` 有給就只取那一筆
const SELECT_LINKS: &str = "SELECT l.id, l.code, l.url, l.title, l.require_login, l.created_at,
        (SELECT COUNT(*) FROM short_link_clicks c WHERE c.link_id = l.id) AS clicks,
        (SELECT COUNT(DISTINCT ip) FROM short_link_clicks c WHERE c.link_id = l.id) AS ips,
        (SELECT MAX(created_at) FROM short_link_clicks c WHERE c.link_id = l.id) AS last_click_at
    FROM short_links l WHERE l.user_id = ?1 AND (?2 IS NULL OR l.id = ?2) ORDER BY l.id DESC";

async fn load(state: &AppState, user: &CurrentUser, id: i64) -> Result<ShortLink, AppError> {
    sqlx::query_as::<_, ShortLink>(SELECT_LINKS)
        .bind(user.id)
        .bind(id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or(AppError::NotFound)
}

pub async fn list(State(state): State<AppState>, user: CurrentUser) -> Result<Json<Vec<ShortLink>>, AppError> {
    let links =
        sqlx::query_as::<_, ShortLink>(SELECT_LINKS).bind(user.id).bind(None::<i64>).fetch_all(&state.pool).await?;
    Ok(Json(links))
}

pub async fn get(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<i64>,
) -> Result<Json<ShortLink>, AppError> {
    Ok(Json(load(&state, &user, id).await?))
}

#[derive(Deserialize)]
pub struct NewLink {
    pub url: String,
    /// 空的就隨機產生
    #[serde(default)]
    pub code: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub require_login: bool,
}

pub async fn create(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(input): Json<NewLink>,
) -> Result<(StatusCode, Json<ShortLink>), AppError> {
    let url = normalize_url(&input.url)?;
    let title = truncate(input.title.trim(), MAX_TITLE_LEN);
    let custom = input.code.trim();
    if !custom.is_empty() {
        validate_code(custom)?;
    }
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM short_links WHERE user_id = ?")
        .bind(user.id)
        .fetch_one(&state.pool)
        .await?;
    if count >= MAX_LINKS_PER_USER {
        return Err(AppError::BadRequest(format!("每個帳號最多 {MAX_LINKS_PER_USER} 個短網址")));
    }

    // 隨機的撞到就重抽，連續撞好幾次表示快用完了，多一碼
    for attempt in 0..20 {
        let code = if custom.is_empty() { random_code(CODE_LEN + attempt / 5) } else { custom.to_owned() };
        let inserted = sqlx::query_scalar::<_, i64>(
            "INSERT INTO short_links (user_id, code, url, title, require_login) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (code) DO NOTHING RETURNING id",
        )
        .bind(user.id)
        .bind(&code)
        .bind(&url)
        .bind(&title)
        .bind(input.require_login)
        .fetch_optional(&state.pool)
        .await?;
        match inserted {
            Some(id) => return Ok((StatusCode::CREATED, Json(load(&state, &user, id).await?))),
            None if !custom.is_empty() => return Err(AppError::Conflict("這個代碼已經有人用了".into())),
            None => {}
        }
    }
    Err(AppError::Internal("could not allocate a short link code".into()))
}

#[derive(Deserialize)]
pub struct LinkUpdate {
    pub url: String,
    #[serde(default)]
    pub title: String,
    pub require_login: bool,
}

/// 改目的網址、標題和要不要登入；代碼不能改
pub async fn update(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<i64>,
    Json(input): Json<LinkUpdate>,
) -> Result<Json<ShortLink>, AppError> {
    let url = normalize_url(&input.url)?;
    let result =
        sqlx::query("UPDATE short_links SET url = ?, title = ?, require_login = ? WHERE id = ? AND user_id = ?")
            .bind(&url)
            .bind(truncate(input.title.trim(), MAX_TITLE_LEN))
            .bind(input.require_login)
            .bind(id)
            .bind(user.id)
            .execute(&state.pool)
            .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    Ok(Json(load(&state, &user, id).await?))
}

pub async fn delete(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<i64>,
) -> Result<StatusCode, AppError> {
    let result = sqlx::query("DELETE FROM short_links WHERE id = ? AND user_id = ?")
        .bind(id)
        .bind(user.id)
        .execute(&state.pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    Ok(StatusCode::NO_CONTENT)
}

// ---- 跳轉 ----

/// `GET /s/{code}`：不在 /api 底下，網址才短
pub async fn follow(
    State(state): State<AppState>,
    Path(code): Path<String>,
    user: Option<CurrentUser>,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    let link =
        sqlx::query_as::<_, (i64, String, bool)>("SELECT id, url, require_login FROM short_links WHERE code = ?")
            .bind(&code)
            .fetch_optional(&state.pool)
            .await?;
    let Some((id, url, require_login)) = link else {
        let body = "找不到這個短網址，可能打錯了或已經被刪除。";
        return Ok((StatusCode::NOT_FOUND, [(header::CONTENT_TYPE, "text/plain; charset=utf-8")], body).into_response());
    };
    let no_store = [(header::CACHE_CONTROL, "no-store")];
    if require_login && user.is_none() {
        // code 只有英數字、- 和 _（validate_code），可以直接放進網址
        return Ok((no_store, Redirect::to(&format!("/login?next=/s/{code}"))).into_response());
    }

    let ip = client_key(&headers);
    if state.short_link_limiter.allow(&ip) {
        let text = |name| headers.get(name).and_then(|v| v.to_str().ok()).unwrap_or_default();
        sqlx::query("DELETE FROM short_link_clicks WHERE created_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?)")
            .bind(format!("-{KEEP_DAYS} days"))
            .execute(&state.pool)
            .await?;
        sqlx::query("INSERT INTO short_link_clicks (link_id, ip, user_id, user_agent, referer) VALUES (?, ?, ?, ?, ?)")
            .bind(id)
            .bind(&ip)
            .bind(user.map(|u| u.id))
            .bind(truncate(text(header::USER_AGENT), MAX_USER_AGENT_LEN))
            .bind(truncate(text(header::REFERER), MAX_REFERER_LEN))
            .execute(&state.pool)
            .await?;
    }
    // 不讓瀏覽器快取跳轉，每一次才都會經過這裡被算到
    Ok((no_store, Redirect::to(&url)).into_response())
}

// ---- 統計 ----

#[derive(Serialize, sqlx::FromRow)]
pub struct ClickIp {
    pub ip: String,
    pub clicks: i64,
    pub first_at: String,
    pub last_at: String,
    /// 有登入點過的帳號，逗號分隔
    pub users: String,
    /// 最後一次的 User-Agent
    pub user_agent: String,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct Click {
    pub id: i64,
    pub ip: String,
    pub username: Option<String>,
    pub user_agent: String,
    pub referer: String,
    pub created_at: String,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct DayCount {
    /// YYYY-MM-DD（UTC）
    pub day: String,
    pub clicks: i64,
}

#[derive(Serialize)]
pub struct Stats {
    pub link: ShortLink,
    /// 最近點過的 IP 在前面
    pub ips: Vec<ClickIp>,
    /// 最近的點擊，新的在前面
    pub clicks: Vec<Click>,
    /// 最近 30 天有點擊的日子
    pub days: Vec<DayCount>,
}

pub async fn stats(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<i64>,
) -> Result<Json<Stats>, AppError> {
    let link = load(&state, &user, id).await?;

    // 帳號名稱只有英數字和 _ . -，所以可以用 group_concat 的預設逗號分隔
    let ips = sqlx::query_as::<_, ClickIp>(
        "SELECT g.ip, g.clicks, g.first_at, g.last_at, g.users, c.user_agent
         FROM (
            SELECT x.ip, COUNT(*) AS clicks, MIN(x.created_at) AS first_at, MAX(x.created_at) AS last_at,
                MAX(x.id) AS last_id, COALESCE(group_concat(DISTINCT u.username), '') AS users
            FROM short_link_clicks x LEFT JOIN users u ON u.id = x.user_id
            WHERE x.link_id = ?
            GROUP BY x.ip
         ) g JOIN short_link_clicks c ON c.id = g.last_id
         ORDER BY g.last_id DESC LIMIT ?",
    )
    .bind(id)
    .bind(MAX_IPS)
    .fetch_all(&state.pool)
    .await?;

    let clicks = sqlx::query_as::<_, Click>(
        "SELECT c.id, c.ip, u.username, c.user_agent, c.referer, c.created_at
         FROM short_link_clicks c LEFT JOIN users u ON u.id = c.user_id
         WHERE c.link_id = ? ORDER BY c.id DESC LIMIT ?",
    )
    .bind(id)
    .bind(MAX_CLICKS)
    .fetch_all(&state.pool)
    .await?;

    let days = sqlx::query_as::<_, DayCount>(
        "SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS clicks FROM short_link_clicks
         WHERE link_id = ? AND created_at >= strftime('%Y-%m-%dT00:00:00Z', 'now', ?)
         GROUP BY day ORDER BY day",
    )
    .bind(id)
    .bind(format!("-{} days", DAYS - 1))
    .fetch_all(&state.pool)
    .await?;

    Ok(Json(Stats { link, ips, clicks, days }))
}

#[cfg(test)]
mod tests {
    use super::{normalize_url, random_code, validate_code};

    #[test]
    fn urls() {
        assert_eq!(normalize_url("example.com/a?b=1").unwrap(), "https://example.com/a?b=1");
        assert_eq!(normalize_url(" http://example.com ").unwrap(), "http://example.com/");
        for bad in ["", "javascript:alert(1)", "ftp://example.com", "https://", "hello"] {
            assert!(normalize_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn codes() {
        assert!(validate_code("Abc_1-2").is_ok());
        for bad in ["a", "有中文", "a/b", "a b", &"x".repeat(33)] {
            assert!(validate_code(bad).is_err(), "{bad}");
        }
        let code = random_code(4);
        assert_eq!(code.len(), 4);
        assert!(validate_code(&code).is_ok());
    }
}
