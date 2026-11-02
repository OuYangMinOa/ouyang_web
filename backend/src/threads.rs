//! Threads 影片下載：給一則貼文的網址，回傳影片在 Meta CDN 上的 mp4 網址，給 iPhone 捷徑用。
//!
//! Threads 沒有公開的 API 可以查別人的貼文。一般瀏覽器拿到的頁面是空殼，資料要登入後由前端另外查；
//! 只有搜尋引擎（Googlebot）拿到的頁面會把貼文資料放在 `<script type="application/json">` 裡，
//! 所以用 Googlebot 的 User-Agent 抓頁面，再從裡面找出這則貼文的 `video_versions`。
//! 這是非公開的格式，Meta 改版時要跟著調整。沒登入看不到的內容（例如引用了限制瀏覽的貼文）抓不到。
//!
//! CDN 網址帶簽章和到期時間（幾天），拿到後要盡快下載，不用 cookie 也能直接抓。
//! 每個 IP 10 秒只能查一次。

use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};

use axum::{
    Json,
    extract::{Query, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use reqwest::{Url, redirect};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{AppError, AppState, auth::client_key};

const USER_AGENT: &str = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const HOSTS: &[&str] = &["threads.com", "www.threads.com", "threads.net", "www.threads.net"];
/// 同一個 IP 兩次查詢之間至少隔這麼久
const COOLDOWN: Duration = Duration::from_secs(10);
/// 一則貼文的頁面大約 600 KB
const MAX_PAGE_BYTES: usize = 8 * 1024 * 1024;

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
    headers: HeaderMap,
    Query(query): Query<VideoQuery>,
) -> Result<Response, AppError> {
    if let Err(wait) = state.threads.limiter.check(&client_key(&headers), Instant::now()) {
        let body = json!({ "error": format!("查詢太頻繁，請 {wait} 秒後再試"), "retry_after": wait });
        return Ok(
            (StatusCode::TOO_MANY_REQUESTS, [(header::RETRY_AFTER, wait.to_string())], Json(body)).into_response()
        );
    }
    let url = page_url(&query.url).ok_or_else(|| AppError::BadRequest("請貼上 Threads 貼文的網址".into()))?;
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
    Ok(Json(post).into_response())
}

fn is_threads_url(url: &Url) -> bool {
    url.scheme() == "https" && url.host_str().is_some_and(|host| HOSTS.contains(&host))
}

/// 使用者貼上的網址 → 要抓的頁面。只接受 Threads 的網址，查詢字串（追蹤參數）拿掉。
fn page_url(input: &str) -> Option<Url> {
    let input = input.trim();
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
