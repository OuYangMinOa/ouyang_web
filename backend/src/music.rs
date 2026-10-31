//! 音樂：直接讀伺服器上的一個資料夾（容器裡唯讀掛在 `MUSIC_DIR`），不存資料庫。
//!
//! 資料夾由別的程式（Discord bot）放檔案進來，所以每次列表都重新讀一次，新增的檔案馬上看得到。

use std::{io::ErrorKind, path::Path, time::UNIX_EPOCH};

use axum::{
    Json,
    body::Body,
    extract::{self, State},
    http::{HeaderValue, header},
    response::{IntoResponse, Response},
};
use serde::Serialize;
use tower::ServiceExt;
use tower_http::services::ServeFile;

use crate::{AppError, AppState};

/// 只列出、只送這些副檔名，資料夾裡的其他檔案一律當作不存在
const EXTENSIONS: &[&str] = &["mp3", "m4a", "aac", "ogg", "oga", "opus", "wav", "flac", "webm"];

#[derive(Serialize)]
pub struct Track {
    /// 檔名（含副檔名），也是播放網址的最後一段
    pub name: String,
    pub size: u64,
    /// 最後修改時間，Unix 毫秒
    pub modified: i64,
}

pub async fn list_tracks(State(state): State<AppState>) -> Result<Json<Vec<Track>>, AppError> {
    let dir = state.music_dir.clone();
    let tracks = tokio::task::spawn_blocking(move || read_tracks(&dir))
        .await
        .map_err(|err| AppError::Internal(err.to_string()))?;
    Ok(Json(tracks))
}

/// 交給 ServeFile 送檔：Range（拖曳進度）、Last-Modified 和 Content-Type 都由它處理
pub async fn track_file(
    State(state): State<AppState>,
    extract::Path(name): extract::Path<String>,
    request: extract::Request,
) -> Response {
    if !is_track(&name) {
        return AppError::NotFound.into_response();
    }
    let Ok(response) = ServeFile::new(state.music_dir.join(&name)).oneshot(request).await;
    response.map(Body::new)
}

/// 分享用的網址：檔名（不含副檔名）的 UTF-8 寫成十六進位，例如 `三蛋一體.mp3` → `E4B889E89B8BE4B880E9AB94.mp3`。
/// Telegram 遇到路徑裡有中文的網址不產生預覽，全英數字的才會顯示播放條。
pub async fn shared_file(
    state: State<AppState>,
    extract::Path(alias): extract::Path<String>,
    request: extract::Request,
) -> Response {
    let Some(name) = decode_alias(&alias) else {
        return AppError::NotFound.into_response();
    };
    let disposition = format!("inline; filename*=UTF-8''{}", percent_encode(&name));
    let mut response = track_file(state, extract::Path(name), request).await;
    // 讓下載和聊天軟體顯示原本的檔名，而不是一串十六進位
    if response.status().is_success()
        && let Ok(value) = HeaderValue::from_str(&disposition)
    {
        response.headers_mut().insert(header::CONTENT_DISPOSITION, value);
    }
    response
}

fn decode_alias(alias: &str) -> Option<String> {
    let (stem, ext) = alias.rsplit_once('.')?;
    if stem.is_empty() || stem.len() % 2 != 0 || !stem.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let bytes = (0..stem.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&stem[i..i + 2], 16).ok())
        .collect::<Option<Vec<u8>>>()?;
    Some(format!("{}.{ext}", String::from_utf8(bytes).ok()?))
}

/// RFC 5987 的 `filename*`：英數字和 `-._~` 以外的位元組都寫成 %XX
fn percent_encode(text: &str) -> String {
    text.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
                char::from(b).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

fn read_tracks(dir: &Path) -> Vec<Track> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        // 本機開發沒有這個資料夾就當作沒有音樂
        Err(err) if err.kind() == ErrorKind::NotFound => return Vec::new(),
        Err(err) => {
            tracing::warn!(dir = %dir.display(), error = %err, "cannot read music dir");
            return Vec::new();
        }
    };
    let mut tracks: Vec<Track> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            if !is_track(&name) {
                return None;
            }
            let meta = std::fs::metadata(entry.path()).ok().filter(|m| m.is_file())?;
            let modified = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_millis() as i64);
            Some(Track { name, size: meta.len(), modified })
        })
        .collect();
    tracks.sort_by(|a, b| a.name.cmp(&b.name));
    tracks
}

/// 單一層的檔名、不是隱藏檔、副檔名是音訊；網址裡的 `%2F` 解碼後是 `/`，所以這裡要擋
fn is_track(name: &str) -> bool {
    if name.starts_with('.') || name.contains(['/', '\\', '\0']) {
        return false;
    }
    name.rsplit_once('.').is_some_and(|(_, ext)| EXTENSIONS.iter().any(|e| ext.eq_ignore_ascii_case(e)))
}
