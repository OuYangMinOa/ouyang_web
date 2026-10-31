//! 俄羅斯方塊的個人設定：目前只有快捷鍵。沒登入的人存在瀏覽器（localStorage），有登入就存在這裡。
//!
//! 後端不認得有哪些動作（那是前端的事），只檢查格式和大小，避免被塞進奇怪的東西：
//! `{ 動作: [按鍵代碼, …] }`，動作是小寫英數字，按鍵代碼是 `KeyboardEvent.code`（英數字）。

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

pub async fn get_settings(State(state): State<AppState>, user: CurrentUser) -> Result<Json<Settings>, AppError> {
    let keys: Option<String> = sqlx::query_scalar("SELECT keys FROM tetris_settings WHERE user_id = ?")
        .bind(user.id)
        .fetch_optional(&state.pool)
        .await?;
    // 存進去前檢查過，讀不出來就當作沒存過
    let keys = keys.and_then(|raw| serde_json::from_str(&raw).ok());
    Ok(Json(Settings { keys }))
}

pub async fn put_settings(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(settings): Json<Settings>,
) -> Result<StatusCode, AppError> {
    match settings.keys {
        // 傳 null 是恢復預設
        None => {
            sqlx::query("DELETE FROM tetris_settings WHERE user_id = ?").bind(user.id).execute(&state.pool).await?;
        }
        Some(keys) => {
            check_keys(&keys)?;
            let raw = serde_json::to_string(&keys).map_err(|err| AppError::Internal(err.to_string()))?;
            sqlx::query(
                "INSERT INTO tetris_settings (user_id, keys) VALUES (?, ?)
                 ON CONFLICT (user_id) DO UPDATE SET keys = excluded.keys, updated_at = excluded.updated_at",
            )
            .bind(user.id)
            .bind(raw)
            .execute(&state.pool)
            .await?;
        }
    }
    Ok(StatusCode::NO_CONTENT)
}
