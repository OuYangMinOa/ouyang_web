//! Threads 影片下載：給一則貼文的網址，回傳影片在 Meta CDN 上的 mp4 網址，給 iPhone 捷徑用。
//!
//! Threads 沒有公開的 API 可以查別人的貼文。一般瀏覽器拿到的頁面是空殼，資料要登入後由前端另外查；
//! 只有搜尋引擎（Googlebot）拿到的頁面會把貼文資料放在 `<script type="application/json">` 裡，
//! 所以用 Googlebot 的 User-Agent 抓頁面，再從裡面找出這則貼文的 `video_versions`。
//! 這是非公開的格式，Meta 改版時要跟著調整。沒登入看不到的內容（例如引用了限制瀏覽的貼文）抓不到。
//!
//! CDN 網址帶簽章和到期時間（幾天），拿到後要盡快下載，不用 cookie 也能直接抓。
//!
//! 只給登入的人用：每個帳號在 `/threads` 頁面拿一把下載金鑰，大家共用同一個捷徑（iCloud 連結由管理員設定），
//! 捷徑第一次執行時要求貼上金鑰，之後放在 `X-Threads-Key` 標頭送來（不放網址，才不會進到 IP 訪問紀錄）。
//! 網頁版（`/threads/paste`）不用金鑰，直接用登入的帳號。
//! 查到影片就記一筆在那個帳號的下載紀錄。每個 IP 10 秒只能查一次。
//!
//! 貼的是 YouTube 網址時改由伺服器下載（見 youtube.rs），金鑰、冷卻時間和下載紀錄都共用。

use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};

use axum::{
    Json,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use reqwest::{Url, redirect};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::SqlitePool;

use crate::{
    AppError, AppState,
    auth::{AdminUsers, CurrentUser, Require, client_key, random_token},
    youtube,
};

const USER_AGENT: &str = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const HOSTS: &[&str] = &["threads.com", "www.threads.com", "threads.net", "www.threads.net"];
/// 同一個 IP 兩次查詢之間至少隔這麼久
const COOLDOWN: Duration = Duration::from_secs(10);
/// 一則貼文的頁面大約 600 KB
const MAX_PAGE_BYTES: usize = 8 * 1024 * 1024;
const KEY_HEADER: &str = "x-threads-key";
const SHORTCUT_SETTING: &str = "threads_shortcut_url";
const SHORTCUT_PREFIX: &str = "https://www.icloud.com/shortcuts/";
/// 每個帳號留最近幾筆下載紀錄；說明文字只存前面一段
const MAX_DOWNLOADS: i64 = 500;
const MAX_CAPTION_CHARS: usize = 300;

pub struct Threads {
    http: reqwest::Client,
    limiter: Limiter,
}

impl Default for Threads {
    fn default() -> Self {
        // 分享連結（/share/xxx）會轉址到貼文，只跟著轉到 Threads 自己的網址
        let policy = redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 {
                attempt.error("too many redirects")
            } else if is_threads_url(attempt.url()) {
                attempt.follow()
            } else {
                attempt.stop()
            }
        });
        let http = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .redirect(policy)
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(20))
            .build()
            .expect("failed to build http client");
        Self { http, limiter: Limiter::default() }
    }
}

#[derive(Default)]
struct Limiter {
    last: Mutex<HashMap<String, Instant>>,
}

impl Limiter {
    /// 可以查就記下這次的時間；不行就回傳還要等幾秒
    fn check(&self, key: &str, now: Instant) -> Result<(), u64> {
        let mut last = self.last.lock().unwrap();
        if last.len() > 10_000 {
            last.retain(|_, at| now.duration_since(*at) < COOLDOWN);
        }
        if let Some(at) = last.get(key) {
            let elapsed = now.duration_since(*at);
            if elapsed < COOLDOWN {
                return Err((COOLDOWN - elapsed).as_secs_f64().ceil() as u64);
            }
        }
        last.insert(key.to_owned(), now);
        Ok(())
    }
}

#[derive(Deserialize)]
pub struct VideoQuery {
    pub url: String,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Post {
    /// `threads` 或 `youtube`
    pub source: &'static str,
    /// Threads 貼文的代碼，或 YouTube 影片的 id
    pub code: String,
    pub author: String,
    pub caption: String,
    pub videos: Vec<Video>,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Video {
    pub url: String,
    /// 封面圖，沒有就是空的
    pub thumbnail: String,
    pub width: u64,
    pub height: u64,
}

pub async fn video(
    State(state): State<AppState>,
    user: Option<CurrentUser>,
    headers: HeaderMap,
    Query(query): Query<VideoQuery>,
) -> Result<Response, AppError> {
    let user_id = video_user(&state.pool, &headers, user).await?;

    if let Err(wait) = state.threads.limiter.check(&client_key(&headers), Instant::now()) {
        let body = json!({ "error": format!("查詢太頻繁，請 {wait} 秒後再試"), "retry_after": wait });
        return Ok(
            (StatusCode::TOO_MANY_REQUESTS, [(header::RETRY_AFTER, wait.to_string())], Json(body)).into_response()
        );
    }
    if let Some(id) = youtube::video_id(&query.url) {
        let post = state.youtube.fetch(&id, &youtube::origin(&headers)).await?;
        record_download(&state.pool, user_id, &post).await?;
        return Ok(Json(post).into_response());
    }
    let url =
        page_url(&query.url).ok_or_else(|| AppError::BadRequest("請貼上 Threads 貼文或 YouTube 影片的網址".into()))?;
    let (final_url, html) = fetch_page(&state.threads.http, url).await.map_err(|error| {
        tracing::warn!(%error, "threads fetch failed");
        AppError::ServiceUnavailable("Threads 暫時連不上，請稍後再試")
    })?;
    let code = post_code(&final_url).ok_or_else(|| AppError::BadRequest("這個網址不是一則貼文".into()))?;
    let post =
        find_post(&html, &code).ok_or_else(|| AppError::BadRequest("找不到這則貼文，可能已刪除或不公開".into()))?;
    if post.videos.is_empty() {
        return Err(AppError::BadRequest("這則貼文沒有影片，或要登入才看得到".into()));
    }
    record_download(&state.pool, user_id, &post).await?;
    Ok(Json(post).into_response())
}

/// 誰在查：捷徑帶 `X-Threads-Key`，網頁（`/threads/paste`）沒帶金鑰就用登入的帳號。
/// 有帶金鑰就只看金鑰，錯了不會改用登入的帳號。
async fn video_user(pool: &SqlitePool, headers: &HeaderMap, user: Option<CurrentUser>) -> Result<i64, AppError> {
    // 錯誤訊息都要有「金鑰」兩個字：捷徑看到就刪掉存著的金鑰，下次執行重新詢問
    let key = headers.get(KEY_HEADER).and_then(|v| v.to_str().ok()).map(str::trim).unwrap_or_default();
    if key.is_empty() {
        return user.map(|u| u.id).ok_or(AppError::Unauthorized("缺少下載金鑰，請到 ouyang.app/threads 登入後複製"));
    }
    sqlx::query_scalar(
        "SELECT k.user_id FROM threads_keys k JOIN users u ON u.id = k.user_id WHERE k.key = ? AND NOT u.disabled",
    )
    .bind(key)
    .fetch_optional(pool)
    .await?
    .ok_or(AppError::Unauthorized("下載金鑰無效，請到 ouyang.app/threads 複製新的金鑰"))
}

async fn record_download(pool: &SqlitePool, user_id: i64, post: &Post) -> Result<(), AppError> {
    let url = if post.source == "youtube" {
        format!("https://www.youtube.com/watch?v={}", post.code)
    } else if post.author.is_empty() {
        format!("https://www.threads.com/t/{}", post.code)
    } else {
        format!("https://www.threads.com/@{}/post/{}", post.author, post.code)
    };
    let caption: String = post.caption.chars().take(MAX_CAPTION_CHARS).collect();
    sqlx::query("INSERT INTO threads_downloads (user_id, url, author, caption, video_count) VALUES (?, ?, ?, ?, ?)")
        .bind(user_id)
        .bind(url)
        .bind(&post.author)
        .bind(caption)
        .bind(post.videos.len() as i64)
        .execute(pool)
        .await?;
    sqlx::query(
        "DELETE FROM threads_downloads WHERE user_id = ? AND id NOT IN
           (SELECT id FROM threads_downloads WHERE user_id = ? ORDER BY id DESC LIMIT ?)",
    )
    .bind(user_id)
    .bind(user_id)
    .bind(MAX_DOWNLOADS)
    .execute(pool)
    .await?;
    Ok(())
}

// ---- /threads 頁面 ----

#[derive(Serialize)]
pub struct Setup {
    pub key: String,
    /// 共用捷徑的 iCloud 連結，管理員還沒設定就是 null
    pub shortcut_url: Option<String>,
}

/// 自己的金鑰（第一次來就產生一把）和捷徑連結
pub async fn setup(State(state): State<AppState>, user: CurrentUser) -> Result<Json<Setup>, AppError> {
    sqlx::query("INSERT INTO threads_keys (user_id, key) VALUES (?, ?) ON CONFLICT (user_id) DO NOTHING")
        .bind(user.id)
        .bind(random_token()?)
        .execute(&state.pool)
        .await?;
    let key = sqlx::query_scalar("SELECT key FROM threads_keys WHERE user_id = ?")
        .bind(user.id)
        .fetch_one(&state.pool)
        .await?;
    Ok(Json(Setup { key, shortcut_url: shortcut_url(&state.pool).await? }))
}

/// 換一把新的金鑰，舊的馬上失效（金鑰外流時用）
pub async fn reset_key(State(state): State<AppState>, user: CurrentUser) -> Result<Json<Setup>, AppError> {
    sqlx::query(
        "INSERT INTO threads_keys (user_id, key) VALUES (?, ?)
         ON CONFLICT (user_id) DO UPDATE SET key = excluded.key, created_at = excluded.created_at",
    )
    .bind(user.id)
    .bind(random_token()?)
    .execute(&state.pool)
    .await?;
    setup(State(state), user).await
}

async fn shortcut_url(pool: &SqlitePool) -> Result<Option<String>, AppError> {
    let url: Option<String> = sqlx::query_scalar("SELECT value FROM site_settings WHERE key = ?")
        .bind(SHORTCUT_SETTING)
        .fetch_optional(pool)
        .await?;
    Ok(url.filter(|url| !url.is_empty()))
}

#[derive(Deserialize)]
pub struct ShortcutUpdate {
    pub url: String,
}

/// 管理員設定共用捷徑的 iCloud 連結；空字串是清掉
pub async fn set_shortcut(
    State(state): State<AppState>,
    _: Require<AdminUsers>,
    Json(input): Json<ShortcutUpdate>,
) -> Result<StatusCode, AppError> {
    let url = input.url.trim();
    let id = url.strip_prefix(SHORTCUT_PREFIX).unwrap_or_default();
    if !url.is_empty() && (id.is_empty() || !id.bytes().all(|b| b.is_ascii_alphanumeric())) {
        return Err(AppError::BadRequest(format!("請貼上 {SHORTCUT_PREFIX}… 的捷徑連結")));
    }
    sqlx::query(
        "INSERT INTO site_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    )
    .bind(SHORTCUT_SETTING)
    .bind(url)
    .execute(&state.pool)
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize, sqlx::FromRow)]
pub struct Download {
    pub id: i64,
    pub url: String,
    pub author: String,
    pub caption: String,
    pub video_count: i64,
    pub created_at: String,
}

/// 自己的下載紀錄，新的在前
pub async fn downloads(State(state): State<AppState>, user: CurrentUser) -> Result<Json<Vec<Download>>, AppError> {
    let rows = sqlx::query_as::<_, Download>(
        "SELECT id, url, author, caption, video_count, created_at FROM threads_downloads
         WHERE user_id = ? ORDER BY id DESC",
    )
    .bind(user.id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(rows))
}

/// 刪掉自己的一筆紀錄（別人的回 404）
pub async fn delete_download(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<i64>,
) -> Result<StatusCode, AppError> {
    let result = sqlx::query("DELETE FROM threads_downloads WHERE id = ? AND user_id = ?")
        .bind(id)
        .bind(user.id)
        .execute(&state.pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    Ok(StatusCode::NO_CONTENT)
}

// ---- 解析 ----

fn is_threads_url(url: &Url) -> bool {
    url.scheme() == "https" && url.host_str().is_some_and(|host| HOSTS.contains(&host))
}

/// 使用者貼上的網址 → 要抓的頁面。只接受 Threads 的網址，查詢字串（追蹤參數）拿掉。
/// 分享時可能連貼文內容一起送來，所以從整段文字裡找第一個像 Threads 網址的部分。
fn page_url(input: &str) -> Option<Url> {
    input.split_whitespace().find_map(parse_page_url)
}

fn parse_page_url(input: &str) -> Option<Url> {
    let input = if input.contains("://") { input.to_owned() } else { format!("https://{input}") };
    let mut url = Url::parse(&input).ok()?;
    if url.scheme() == "http" {
        url.set_scheme("https").ok()?;
    }
    if !is_threads_url(&url) || url.path().len() <= 1 {
        return None;
    }
    url.set_host(Some("www.threads.com")).ok()?;
    url.set_query(None);
    url.set_fragment(None);
    Some(url)
}

/// `/@user/post/CODE`、`/t/CODE` → `CODE`
fn post_code(url: &Url) -> Option<String> {
    let segments: Vec<&str> = url.path_segments()?.filter(|s| !s.is_empty()).collect();
    let code = match segments.as_slice() {
        [user, "post", code, ..] if user.starts_with('@') => code,
        ["t", code, ..] => code,
        _ => return None,
    };
    code.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-').then(|| code.to_string())
}

async fn fetch_page(http: &reqwest::Client, url: Url) -> Result<(Url, String), String> {
    let mut response = http.get(url.clone()).send().await.map_err(|e| format!("{url}: {e}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("{url}: HTTP {status}"));
    }
    let final_url = response.url().clone();
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| format!("{url}: {e}"))? {
        body.extend_from_slice(&chunk);
        if body.len() > MAX_PAGE_BYTES {
            return Err(format!("{url}: page too large"));
        }
    }
    Ok((final_url, String::from_utf8_lossy(&body).into_owned()))
}

/// 在頁面的 JSON 裡找 `code` 是這則貼文的物件。同一則貼文可能出現好幾次，優先用有影片的那份。
fn find_post(html: &str, code: &str) -> Option<Post> {
    let mut found: Option<Post> = None;
    for script in json_scripts(html) {
        let Ok(value) = serde_json::from_str::<Value>(script) else { continue };
        let mut stack = vec![&value];
        while let Some(value) = stack.pop() {
            match value {
                Value::Object(map) => {
                    if map.get("code").and_then(Value::as_str) == Some(code) && map.contains_key("media_type") {
                        let post = to_post(value, code);
                        if !post.videos.is_empty() {
                            return Some(post);
                        }
                        found.get_or_insert(post);
                    }
                    stack.extend(map.values());
                }
                Value::Array(items) => stack.extend(items),
                _ => {}
            }
        }
    }
    found
}

fn json_scripts(html: &str) -> impl Iterator<Item = &str> {
    html.split("<script type=\"application/json\"").skip(1).filter_map(|rest| {
        let (_, body) = rest.split_once('>')?;
        Some(body.split_once("</script>")?.0)
    })
}

fn to_post(media: &Value, code: &str) -> Post {
    Post {
        source: "threads",
        code: code.to_owned(),
        author: media["user"]["username"].as_str().unwrap_or_default().to_owned(),
        caption: media["caption"]["text"].as_str().unwrap_or_default().to_owned(),
        videos: videos(media),
    }
}

/// 單一影片、輪播裡的影片；自己沒有影片時看引用或轉發的貼文
fn videos(media: &Value) -> Vec<Video> {
    let own: Vec<Video> = match media["carousel_media"].as_array() {
        Some(items) if !items.is_empty() => items.iter().filter_map(video_of).collect(),
        _ => video_of(media).into_iter().collect(),
    };
    if !own.is_empty() {
        return own;
    }
    let info = &media["text_post_app_info"];
    [&info["share_info"]["quoted_post"], &info["share_info"]["reposted_post"], &info["linked_inline_media"]]
        .into_iter()
        .filter(|inner| inner.is_object())
        .map(videos)
        .find(|found| !found.is_empty())
        .unwrap_or_default()
}

fn video_of(media: &Value) -> Option<Video> {
    // 第一個是畫質最好的
    let url = media["video_versions"].as_array()?.iter().find_map(|v| v["url"].as_str())?;
    let thumbnail = media["image_versions2"]["candidates"][0]["url"].as_str().unwrap_or_default();
    Some(Video {
        url: url.to_owned(),
        thumbnail: thumbnail.to_owned(),
        width: media["original_width"].as_u64().unwrap_or(0),
        height: media["original_height"].as_u64().unwrap_or(0),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_threads_urls() {
        let page = |input: &str| page_url(input).map(|url| url.to_string());
        assert_eq!(
            page("https://www.threads.com/share/E08ccdDOM/").as_deref(),
            Some("https://www.threads.com/share/E08ccdDOM/")
        );
        assert_eq!(
            page(" threads.net/@someone/post/DfO0iKfiWfz?xmt=abc#x ").as_deref(),
            Some("https://www.threads.com/@someone/post/DfO0iKfiWfz")
        );
        assert_eq!(page("http://threads.com/t/ABC").as_deref(), Some("https://www.threads.com/t/ABC"));
        assert_eq!(
            page(
                "笑死 https://www.threads.com/@a/post/X?xmt=1
來自 Threads"
            )
            .as_deref(),
            Some("https://www.threads.com/@a/post/X")
        );
        for bad in [
            "https://evil.com/@a/post/X",
            "https://threads.com.evil.com/t/X",
            "https://www.threads.com/",
            "ftp://threads.com/t/X",
            "",
        ] {
            assert_eq!(page(bad), None, "{bad}");
        }
    }

    #[test]
    fn reads_post_code() {
        let code = |url: &str| post_code(&Url::parse(url).unwrap());
        assert_eq!(code("https://www.threads.com/@k020913/post/DfOWoSHiUpO").as_deref(), Some("DfOWoSHiUpO"));
        assert_eq!(code("https://www.threads.com/@a.b/post/Df-_9/media").as_deref(), Some("Df-_9"));
        assert_eq!(code("https://www.threads.com/t/CuZ3x").as_deref(), Some("CuZ3x"));
        assert_eq!(code("https://www.threads.com/@k020913"), None);
        assert_eq!(code("https://www.threads.com/share/E08ccdDOM/"), None);
    }

    fn page(media: Value) -> String {
        let other = json!({ "code": "OTHER", "media_type": 2, "video_versions": [{ "type": 101, "url": "https://cdn/other.mp4" }] });
        let data = json!({ "require": [["RelayPrefetchedStreamCache", "next", [], [{ "data": { "media": media, "replies": [other] } }]]] });
        format!(
            "<html><script type=\"application/json\" nonce=\"x\" data-sjs>{{\"broken\":</script>\
             <script type=\"application/json\" nonce=\"x\" data-sjs>{data}</script></html>"
        )
    }

    #[test]
    fn finds_single_video() {
        let media = json!({
            "code": "ABC", "media_type": 2, "original_width": 960, "original_height": 720,
            "user": { "username": "someone" }, "caption": { "text": "影片" },
            "image_versions2": { "candidates": [{ "url": "https://cdn/thumb.jpg" }] },
            "video_versions": [{ "type": 101, "url": "https://cdn/best.mp4?a=1&b=%3D" }, { "type": 102, "url": "https://cdn/low.mp4" }],
        });
        let post = find_post(&page(media), "ABC").unwrap();
        assert_eq!(
            post,
            Post {
                source: "threads",
                code: "ABC".into(),
                author: "someone".into(),
                caption: "影片".into(),
                videos: vec![Video {
                    url: "https://cdn/best.mp4?a=1&b=%3D".into(),
                    thumbnail: "https://cdn/thumb.jpg".into(),
                    width: 960,
                    height: 720,
                }],
            }
        );
    }

    #[test]
    fn finds_carousel_and_quoted_videos() {
        let clip =
            |name: &str| json!({ "media_type": 2, "video_versions": [{ "url": format!("https://cdn/{name}.mp4") }] });
        let carousel = json!({
            "code": "CAR", "media_type": 8,
            "carousel_media": [clip("a"), { "media_type": 1, "video_versions": null }, clip("b")],
        });
        let urls = |post: Post| post.videos.into_iter().map(|v| v.url).collect::<Vec<_>>();
        assert_eq!(urls(find_post(&page(carousel), "CAR").unwrap()), ["https://cdn/a.mp4", "https://cdn/b.mp4"]);

        let quote = json!({
            "code": "QUO", "media_type": 19, "video_versions": null,
            "text_post_app_info": { "share_info": { "quoted_post": clip("quoted"), "reposted_post": null } },
        });
        assert_eq!(urls(find_post(&page(quote), "QUO").unwrap()), ["https://cdn/quoted.mp4"]);
    }

    #[test]
    fn text_post_has_no_videos() {
        let text =
            json!({ "code": "TXT", "media_type": 19, "video_versions": null, "image_versions2": { "candidates": [] } });
        assert_eq!(find_post(&page(text), "TXT").unwrap().videos, []);
        assert_eq!(find_post(&page(json!({})), "TXT"), None);
    }

    #[test]
    fn limits_each_ip() {
        let limiter = Limiter::default();
        let start = Instant::now();
        assert_eq!(limiter.check("1.2.3.4", start), Ok(()));
        assert_eq!(limiter.check("1.2.3.4", start + Duration::from_millis(500)), Err(10));
        assert_eq!(limiter.check("5.6.7.8", start + Duration::from_secs(1)), Ok(()));
        assert_eq!(limiter.check("1.2.3.4", start + Duration::from_millis(9_100)), Err(1));
        assert_eq!(limiter.check("1.2.3.4", start + COOLDOWN), Ok(()));
        // 被擋下的那幾次不會重新計時
        assert_eq!(limiter.check("1.2.3.4", start + COOLDOWN + Duration::from_secs(9)), Err(1));
    }
}
