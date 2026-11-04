//! YouTube 影片下載：跟 Threads 共用 `/api/threads/video`（同一把金鑰、同一份下載紀錄、同一個冷卻時間），
//! 貼的是 YouTube 網址就走這裡。
//!
//! YouTube 的串流網址綁下載者的 IP，而且影音分開，沒辦法像 Threads 一樣把 CDN 網址丟給捷徑。
//! 所以由伺服器用 yt-dlp 下載、ffmpeg 合併成 mp4（yt-dlp 還要 Deno 解 YouTube 的簽章，三個都裝在 Docker image 裡），
//! 放在暫存資料夾，回傳 `/api/threads/files/<代碼>` 讓捷徑或網頁來拿。代碼是隨機的，拿檔案不用金鑰；
//! 檔案留 [`KEEP`] 就刪掉，重開伺服器也會清空。
//!
//! 只抓公開影片，最長 [`MAX_DURATION_SECS`]、最高 1080p，同時只跑一個下載。
//! YouTube 常擋資料中心的 IP（要求登入確認不是機器人），擋下時只能等一陣子再試。

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use axum::{
    body::Body,
    extract::{self, State},
    http::{HeaderMap, HeaderValue, header},
    response::{IntoResponse, Response},
};
use reqwest::Url;
use serde::Deserialize;
use tokio::{process::Command, sync::Semaphore};
use tower::ServiceExt;
use tower_http::services::ServeFile;

use crate::{
    AppError, AppState,
    auth::random_token,
    threads::{Post, Video},
};

const HOSTS: &[&str] = &["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"];
const MAX_DURATION_SECS: u64 = 20 * 60;
/// 下載好的檔案留多久
const KEEP: Duration = Duration::from_secs(60 * 60);
/// yt-dlp 跑超過這麼久就砍掉
const TIMEOUT: Duration = Duration::from_secs(5 * 60);

pub struct YouTube {
    /// yt-dlp 的執行檔
    bin: String,
    dir: PathBuf,
    /// 同時只跑一個下載，下載很吃頻寬和記憶體
    slot: Semaphore,
    files: Mutex<HashMap<String, File>>,
}

struct File {
    path: PathBuf,
    /// 下載時的檔名
    name: String,
    at: Instant,
}

/// yt-dlp 下載完印出來的欄位（見 [`YouTube::download`] 的 `-O`）
#[derive(Deserialize)]
struct Info {
    id: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    uploader: String,
    width: Option<u64>,
    height: Option<u64>,
    thumbnail: Option<String>,
    filepath: PathBuf,
}

impl Default for YouTube {
    /// 從 PATH 找 yt-dlp
    fn default() -> Self {
        Self::new("yt-dlp")
    }
}

impl YouTube {
    pub fn new(bin: impl Into<String>) -> Self {
        Self {
            bin: bin.into(),
            dir: std::env::temp_dir().join("ouyang-youtube"),
            slot: Semaphore::new(1),
            files: Mutex::default(),
        }
    }

    /// 下載一部影片，回傳跟 Threads 一樣格式的貼文；影片網址指向自己的 `/api/threads/files/…`
    pub async fn fetch(&self, id: &str, origin: &str) -> Result<Post, AppError> {
        let _permit =
            self.slot.try_acquire().map_err(|_| AppError::ServiceUnavailable("伺服器正在下載別的影片，請稍後再試"))?;
        self.sweep().await;

        let token = random_token()?;
        let dir = self.dir.join(&token);
        tokio::fs::create_dir_all(&dir).await.map_err(|e| AppError::Internal(format!("youtube dir: {e}")))?;
        let info = match self.download(id, &dir).await {
            Ok(info) if info.filepath.starts_with(&dir) => info,
            Ok(info) => {
                let _ = tokio::fs::remove_dir_all(&dir).await;
                return Err(AppError::Internal(format!("yt-dlp wrote outside its dir: {}", info.filepath.display())));
            }
            Err(error) => {
                let _ = tokio::fs::remove_dir_all(&dir).await;
                return Err(error);
            }
        };

        let name = format!("youtube_{}.mp4", info.id);
        self.files.lock().unwrap().insert(token.clone(), File { path: info.filepath, name, at: Instant::now() });
        Ok(Post {
            source: "youtube",
            code: info.id,
            author: info.uploader,
            caption: info.title,
            videos: vec![Video {
                url: format!("{origin}/api/threads/files/{token}"),
                thumbnail: info.thumbnail.unwrap_or_default(),
                width: info.width.unwrap_or(0),
                height: info.height.unwrap_or(0),
            }],
        })
    }

    async fn download(&self, id: &str, dir: &Path) -> Result<Info, AppError> {
        let mut command = Command::new(&self.bin);
        command
            .args(["--ignore-config", "--no-playlist", "--no-progress", "--no-warnings", "--no-mtime"])
            // iPhone 相簿要 H.264 + AAC 的 mp4
            .args(["-S", "res:1080,vcodec:h264,acodec:m4a", "--merge-output-format", "mp4", "--remux-video", "mp4"])
            .args(["--match-filters", &format!("duration<={MAX_DURATION_SECS} & !is_live"), "--max-filesize", "1G"])
            .arg("-o")
            .arg(dir.join("video.%(ext)s"))
            .args(["-O", "after_move:%(.{id,title,uploader,width,height,thumbnail,filepath})j"])
            // 網址是自己組的，不直接傳使用者貼的字
            .arg(format!("https://www.youtube.com/watch?v={id}"))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let output = match tokio::time::timeout(TIMEOUT, command.output()).await {
            Err(_) => return Err(AppError::ServiceUnavailable("影片下載太久，請稍後再試")),
            Ok(Err(error)) => {
                tracing::error!(%error, bin = %self.bin, "failed to run yt-dlp");
                return Err(AppError::ServiceUnavailable("伺服器還沒裝好 YouTube 下載工具"));
            }
            Ok(Ok(output)) => output,
        };
        let stderr = String::from_utf8_lossy(&output.stderr);
        if !output.status.success() {
            tracing::warn!(%id, %stderr, "yt-dlp failed");
            return Err(failure(&stderr));
        }
        // 被 --match-filters 或 --max-filesize 擋下時還是成功結束，只是什麼都沒印
        let stdout = String::from_utf8_lossy(&output.stdout);
        let Some(line) = stdout.lines().rev().find(|line| line.starts_with('{')) else {
            return Err(AppError::BadRequest(format!(
                "只能下載 {} 分鐘以內、1 GB 以下的影片，直播也不行",
                MAX_DURATION_SECS / 60
            )));
        };
        serde_json::from_str(line).map_err(|e| AppError::Internal(format!("yt-dlp output: {e}: {line}")))
    }

    /// 刪掉放太久的檔案
    async fn sweep(&self) {
        let expired: Vec<PathBuf> = {
            let mut files = self.files.lock().unwrap();
            let (old, keep) = files.drain().partition::<Vec<_>, _>(|(_, file)| file.at.elapsed() >= KEEP);
            files.extend(keep);
            old.into_iter().filter_map(|(_, file)| file.path.parent().map(Path::to_owned)).collect()
        };
        for dir in expired {
            let _ = tokio::fs::remove_dir_all(dir).await;
        }
    }

    fn file(&self, token: &str) -> Option<(PathBuf, String)> {
        let files = self.files.lock().unwrap();
        files.get(token).filter(|file| file.at.elapsed() < KEEP).map(|file| (file.path.clone(), file.name.clone()))
    }
}

/// 開機時清掉上次留下的檔案，之後每 10 分鐘刪一次過期的
pub fn spawn_cleanup(youtube: Arc<YouTube>) {
    tokio::spawn(async move {
        let _ = tokio::fs::remove_dir_all(&youtube.dir).await;
        let mut tick = tokio::time::interval(Duration::from_secs(10 * 60));
        loop {
            tick.tick().await;
            youtube.sweep().await;
        }
    });
}

/// yt-dlp 的錯誤訊息 → 給使用者看的
fn failure(stderr: &str) -> AppError {
    let has = |words: &[&str]| words.iter().any(|w| stderr.contains(w));
    if has(&["confirm your age", "age-restricted", "inappropriate for some users"]) {
        return AppError::BadRequest("這部影片有年齡限制，沒辦法下載".into());
    }
    if has(&["not a bot", "HTTP Error 429"]) {
        return AppError::ServiceUnavailable("YouTube 暫時擋下了伺服器，請過一陣子再試");
    }
    if has(&["Private video", "members-only", "Join this channel", "Video unavailable", "This video is unavailable"]) {
        return AppError::BadRequest("找不到這部影片，可能是私人、會員限定或已刪除".into());
    }
    if has(&["live event will begin", "Premieres in"]) {
        return AppError::BadRequest("直播或首播還沒開始，沒辦法下載".into());
    }
    AppError::ServiceUnavailable("YouTube 暫時下載不了，請稍後再試")
}

/// 下載好的影片。ServeFile 處理 Range，網頁的 `<video>` 才能拖曳進度。
pub async fn file(
    State(state): State<AppState>,
    extract::Path(token): extract::Path<String>,
    request: extract::Request,
) -> Response {
    let Some((path, name)) = state.youtube.file(&token) else {
        return AppError::NotFound.into_response();
    };
    let Ok(response) = ServeFile::new(path).oneshot(request).await;
    let mut response = response.map(Body::new);
    if response.status().is_success()
        && let Ok(value) = HeaderValue::from_str(&format!("inline; filename=\"{name}\""))
    {
        response.headers_mut().insert(header::CONTENT_DISPOSITION, value);
    }
    response
}

/// 捷徑要完整的網址才下載得到。Traefik 會帶 `X-Forwarded-Proto`，本機開發沒有就當 http。
pub fn origin(headers: &HeaderMap) -> String {
    let header = |name: &str| headers.get(name).and_then(|v| v.to_str().ok()).filter(|v| !v.is_empty());
    let proto = header("x-forwarded-proto").unwrap_or("http");
    let host = header(header::HOST.as_str()).unwrap_or("localhost");
    format!("{proto}://{host}")
}

/// 從貼上的文字裡找出 YouTube 影片的 id；不是 YouTube 的網址就是 None
pub fn video_id(input: &str) -> Option<String> {
    input.split_whitespace().find_map(parse_video_id)
}

fn parse_video_id(input: &str) -> Option<String> {
    let input = if input.contains("://") { input.to_owned() } else { format!("https://{input}") };
    let url = Url::parse(&input).ok()?;
    if !matches!(url.scheme(), "http" | "https") || !url.host_str().is_some_and(|host| HOSTS.contains(&host)) {
        return None;
    }
    let segments: Vec<&str> = url.path_segments()?.filter(|s| !s.is_empty()).collect();
    let id = match (url.host_str()?, segments.as_slice()) {
        ("youtu.be", [id, ..]) => id.to_string(),
        (_, ["watch"]) => url.query_pairs().find(|(k, _)| k == "v")?.1.into_owned(),
        (_, ["shorts" | "live" | "embed" | "v", id, ..]) => id.to_string(),
        _ => return None,
    };
    (id.len() == 11 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')).then_some(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_video_id() {
        for (input, id) in [
            ("https://www.youtube.com/watch?v=jNQXAC9IVRw", "jNQXAC9IVRw"),
            ("https://youtube.com/watch?feature=share&v=jNQXAC9IVRw&t=10", "jNQXAC9IVRw"),
            ("m.youtube.com/watch?v=jNQXAC9IVRw", "jNQXAC9IVRw"),
            ("https://music.youtube.com/watch?v=jNQXAC9IVRw&list=RD", "jNQXAC9IVRw"),
            ("https://youtu.be/jNQXAC9IVRw?si=abc", "jNQXAC9IVRw"),
            ("https://www.youtube.com/shorts/aBc-_12345x", "aBc-_12345x"),
            ("https://www.youtube.com/live/aBc-_12345x?feature=share", "aBc-_12345x"),
            ("看這個 https://youtu.be/jNQXAC9IVRw 笑死", "jNQXAC9IVRw"),
        ] {
            assert_eq!(video_id(input).as_deref(), Some(id), "{input}");
        }
        for bad in [
            "https://www.threads.com/@a/post/X",
            "https://evil.com/watch?v=jNQXAC9IVRw",
            "https://youtube.com.evil.com/watch?v=jNQXAC9IVRw",
            "https://www.youtube.com/@channel",
            "https://www.youtube.com/watch?v=short",
            "https://www.youtube.com/watch?v=--rm-rf-xx;",
            "https://youtu.be/",
            "ftp://youtu.be/jNQXAC9IVRw",
            "",
        ] {
            assert_eq!(video_id(bad), None, "{bad}");
        }
    }

    #[test]
    fn explains_failures() {
        let message = |stderr: &str| failure(stderr).to_string();
        assert!(message("ERROR: [youtube] x: Sign in to confirm you’re not a bot.").contains("擋下"));
        assert!(message("ERROR: [youtube] x: Sign in to confirm your age.").contains("年齡"));
        assert!(message("ERROR: [youtube] x: Private video. Sign in if you've been granted access").contains("私人"));
        assert!(message("ERROR: [youtube] x: Video unavailable").contains("找不到"));
        assert!(message("ERROR: something else").contains("暫時"));
    }

    #[test]
    fn origin_follows_proxy() {
        let mut headers = HeaderMap::new();
        assert_eq!(origin(&headers), "http://localhost");
        headers.insert(header::HOST, HeaderValue::from_static("ouyang.app"));
        headers.insert("x-forwarded-proto", HeaderValue::from_static("https"));
        assert_eq!(origin(&headers), "https://ouyang.app");
    }
}
