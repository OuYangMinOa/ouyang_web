//! 即時方塊遊戲（俄羅斯方塊、魔法氣泡）的個人設定：快捷鍵和操作手感。沒登入的人存在瀏覽器（localStorage），有登入就存在這裡。
//!
//! 快捷鍵每個遊戲一張表（`tetris_settings`、`puyo_settings`），格式一樣。
//! 後端不認得有哪些動作（那是前端的事），只檢查格式和大小，避免被塞進奇怪的東西：
//! `{ 動作: [按鍵代碼, …] }`，動作是小寫英數字，按鍵代碼是 `KeyboardEvent.code`（英數字）。
//!
//! 操作手感（DAS、ARR、加速下落）放在 `game_handling`，用遊戲 id 區分。

use std::collections::BTreeMap;

use axum::{Json, extract::State, http::StatusCode};
use serde::{Deserialize, Serialize};

use crate::{AppError, AppState, auth::CurrentUser};

/// 最多幾個動作、每個動作最多幾個按鍵、名稱多長
const MAX_ACTIONS: usize = 32;
const MAX_KEYS_PER_ACTION: usize = 4;
const MAX_NAME: usize = 32;

pub type Keys = BTreeMap<String, Vec<String>>;

#[derive(Serialize, Deserialize)]
pub struct Settings {
    /// 還沒存過是 null，前端就用預設值
    pub keys: Option<Keys>,
}

/// 一個遊戲的設定表要用的 SQL；表名是寫死的，不會從請求來
struct Table {
    select: &'static str,
    upsert: &'static str,
    delete: &'static str,
}

macro_rules! table {
    ($name:literal) => {
        Table {
            select: concat!("SELECT keys FROM ", $name, " WHERE user_id = ?"),
            upsert: concat!(
                "INSERT INTO ",
                $name,
                " (user_id, keys) VALUES (?, ?)
                 ON CONFLICT (user_id) DO UPDATE SET keys = excluded.keys, updated_at = excluded.updated_at"
            ),
            delete: concat!("DELETE FROM ", $name, " WHERE user_id = ?"),
        }
    };
}

const TETRIS: Table = table!("tetris_settings");
const PUYO: Table = table!("puyo_settings");

fn valid_name(name: &str, upper: bool) -> bool {
    !name.is_empty()
        && name.len() <= MAX_NAME
        && name.bytes().all(|c| c.is_ascii_digit() || c.is_ascii_lowercase() || (upper && c.is_ascii_uppercase()))
}

fn check_keys(keys: &Keys) -> Result<(), AppError> {
    let bad = |message: &str| Err(AppError::BadRequest(message.into()));
    if keys.len() > MAX_ACTIONS {
        return bad("快捷鍵的動作太多");
    }
    for (action, codes) in keys {
        if !valid_name(action, false) {
            return bad("快捷鍵的動作名稱不正確");
        }
        if codes.len() > MAX_KEYS_PER_ACTION || !codes.iter().all(|code| valid_name(code, true)) {
            return bad("快捷鍵的按鍵不正確");
        }
    }
    Ok(())
}

async fn get_settings(state: &AppState, user: &CurrentUser, table: &Table) -> Result<Json<Settings>, AppError> {
    let keys: Option<String> = sqlx::query_scalar(table.select).bind(user.id).fetch_optional(&state.pool).await?;
    // 存進去前檢查過，讀不出來就當作沒存過
    let keys = keys.and_then(|raw| serde_json::from_str(&raw).ok());
    Ok(Json(Settings { keys }))
}

async fn put_settings(
    state: &AppState,
    user: &CurrentUser,
    table: &Table,
    settings: Settings,
) -> Result<StatusCode, AppError> {
    match settings.keys {
        // 傳 null 是恢復預設
        None => {
            sqlx::query(table.delete).bind(user.id).execute(&state.pool).await?;
        }
        Some(keys) => {
            check_keys(&keys)?;
            let raw = serde_json::to_string(&keys).map_err(|err| AppError::Internal(err.to_string()))?;
            sqlx::query(table.upsert).bind(user.id).bind(raw).execute(&state.pool).await?;
        }
    }
    Ok(StatusCode::NO_CONTENT)
}

pub async fn get_tetris(State(state): State<AppState>, user: CurrentUser) -> Result<Json<Settings>, AppError> {
    get_settings(&state, &user, &TETRIS).await
}

pub async fn put_tetris(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(settings): Json<Settings>,
) -> Result<StatusCode, AppError> {
    put_settings(&state, &user, &TETRIS, settings).await
}

/// 左右鍵按住多久開始連續移動、之後每格的間隔、加速下落每格的間隔（毫秒）；ARR 0 是直接滑到底，soft 0 是直接落到底
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Handling {
    pub das: u32,
    pub arr: u32,
    /// 後來才加的，舊的資料沒有這欄
    #[serde(default = "default_soft")]
    pub soft: u32,
}

fn default_soft() -> u32 {
    30
}

/// 範圍跟前端的滑桿一樣
const DAS_RANGE: std::ops::RangeInclusive<u32> = 50..=400;
const ARR_RANGE: std::ops::RangeInclusive<u32> = 0..=200;
const SOFT_RANGE: std::ops::RangeInclusive<u32> = 0..=100;

#[derive(Serialize, Deserialize)]
pub struct HandlingSettings {
    /// 還沒存過是 null，前端就用預設值
    pub handling: Option<Handling>,
}

async fn get_handling(state: &AppState, user: &CurrentUser, game: &str) -> Result<Json<HandlingSettings>, AppError> {
    let raw: Option<String> = sqlx::query_scalar("SELECT handling FROM game_handling WHERE user_id = ? AND game = ?")
        .bind(user.id)
        .bind(game)
        .fetch_optional(&state.pool)
        .await?;
    let handling = raw.and_then(|raw| serde_json::from_str(&raw).ok());
    Ok(Json(HandlingSettings { handling }))
}

async fn put_handling(
    state: &AppState,
    user: &CurrentUser,
    game: &str,
    settings: HandlingSettings,
) -> Result<StatusCode, AppError> {
    match settings.handling {
        // 傳 null 是恢復預設
        None => {
            sqlx::query("DELETE FROM game_handling WHERE user_id = ? AND game = ?")
                .bind(user.id)
                .bind(game)
                .execute(&state.pool)
                .await?;
        }
        Some(handling) => {
            if !DAS_RANGE.contains(&handling.das)
                || !ARR_RANGE.contains(&handling.arr)
                || !SOFT_RANGE.contains(&handling.soft)
            {
                return Err(AppError::BadRequest("DAS、ARR 或加速下落超出範圍".into()));
            }
            let raw = serde_json::to_string(&handling).map_err(|err| AppError::Internal(err.to_string()))?;
            sqlx::query(
                "INSERT INTO game_handling (user_id, game, handling) VALUES (?, ?, ?)
                 ON CONFLICT (user_id, game) DO UPDATE SET handling = excluded.handling, updated_at = excluded.updated_at",
            )
            .bind(user.id)
            .bind(game)
            .bind(raw)
            .execute(&state.pool)
            .await?;
        }
    }
    Ok(StatusCode::NO_CONTENT)
}

pub async fn get_tetris_handling(
    State(state): State<AppState>,
    user: CurrentUser,
) -> Result<Json<HandlingSettings>, AppError> {
    get_handling(&state, &user, "tetris").await
}

pub async fn put_tetris_handling(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(settings): Json<HandlingSettings>,
) -> Result<StatusCode, AppError> {
    put_handling(&state, &user, "tetris", settings).await
}

pub async fn get_puyo(State(state): State<AppState>, user: CurrentUser) -> Result<Json<Settings>, AppError> {
    get_settings(&state, &user, &PUYO).await
}

pub async fn put_puyo(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(settings): Json<Settings>,
) -> Result<StatusCode, AppError> {
    put_settings(&state, &user, &PUYO, settings).await
}
