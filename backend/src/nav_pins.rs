//! 側邊欄的釘選：沒登入的人存在瀏覽器（localStorage），有登入就存在這裡，換裝置也一樣。
//!
//! 後端不認得各 APP 有哪些頁面（那是前端的事），只檢查格式和大小，避免被塞進奇怪的東西：
//! APP id 是小寫英數字和 `-`，頁面是 `/` 開頭、只有英數字和 `/_-` 的網址。

use std::collections::{BTreeMap, HashSet};

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use serde::{Deserialize, Serialize};

use crate::{AppError, AppState, auth::CurrentUser};

/// 每個 APP 最多釘幾頁、網址多長、APP id 多長
const MAX_PINS: usize = 50;
const MAX_PATH: usize = 128;
const MAX_APP: usize = 32;

#[derive(Serialize)]
pub struct Pins {
    /// 只有存過的 APP 會出現，沒出現的前端就沿用瀏覽器裡的
    pub pins: BTreeMap<String, Vec<String>>,
}

#[derive(Deserialize)]
pub struct SetPins {
    pub paths: Vec<String>,
}

fn valid_app(app: &str) -> bool {
    !app.is_empty()
        && app.len() <= MAX_APP
        && app.bytes().all(|c| c.is_ascii_digit() || c.is_ascii_lowercase() || c == b'-')
}

fn valid_path(path: &str) -> bool {
    path.len() <= MAX_PATH
        && path.starts_with('/')
        && path.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'/' | b'_' | b'-'))
}

fn check_paths(paths: &[String]) -> Result<(), AppError> {
    let bad = |message: &str| Err(AppError::BadRequest(message.into()));
    if paths.len() > MAX_PINS {
        return bad("釘選的頁面太多");
    }
    if !paths.iter().all(|path| valid_path(path)) {
        return bad("釘選的頁面網址不正確");
    }
    let mut seen = HashSet::new();
    if !paths.iter().all(|path| seen.insert(path)) {
        return bad("釘選的頁面重複了");
    }
    Ok(())
}

pub async fn list(State(state): State<AppState>, user: CurrentUser) -> Result<Json<Pins>, AppError> {
    let rows: Vec<(String, String)> = sqlx::query_as("SELECT app, paths FROM nav_pins WHERE user_id = ?")
        .bind(user.id)
        .fetch_all(&state.pool)
        .await?;
    // 存進去前檢查過，讀不出來就當作沒存過
    let pins = rows.into_iter().filter_map(|(app, raw)| Some((app, serde_json::from_str(&raw).ok()?))).collect();
    Ok(Json(Pins { pins }))
}

/// 整個 APP 的釘選換成這份（依順序）；傳空陣列是全部取消
pub async fn set(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(app): Path<String>,
    Json(body): Json<SetPins>,
) -> Result<StatusCode, AppError> {
    if !valid_app(&app) {
        return Err(AppError::BadRequest("APP 名稱不正確".into()));
    }
    check_paths(&body.paths)?;
    let raw = serde_json::to_string(&body.paths).map_err(|err| AppError::Internal(err.to_string()))?;
    sqlx::query(
        "INSERT INTO nav_pins (user_id, app, paths) VALUES (?, ?, ?)
         ON CONFLICT (user_id, app) DO UPDATE SET paths = excluded.paths, updated_at = excluded.updated_at",
    )
    .bind(user.id)
    .bind(app)
    .bind(raw)
    .execute(&state.pool)
    .await?;
    Ok(StatusCode::NO_CONTENT)
}
