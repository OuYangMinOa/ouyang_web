//! 俄羅斯方塊單人模式的排行榜：每個帳號只留最高分那一局，看排行榜不用登入，上傳要登入。
//!
//! 分數是前端算的，後端沒辦法重播驗證，只擋掉明顯不可能的數字（消行太快、分數超過理論上限）。

use axum::{Json, extract::State};
use serde::{Deserialize, Serialize};

use crate::{AppError, AppState, auth::CurrentUser};

/// 排行榜列出前幾名
const TOP: i64 = 20;
const MAX_DURATION_MS: i64 = 24 * 60 * 60 * 1000;
/// 平均每消一行至少要這麼久
const MIN_MS_PER_LINE: i64 = 100;
/// 平均每一塊、每一級最多拿幾分（實際上連 T-Spin Triple 接 B2B 都只有 2400，而且不可能每塊都消行）
const MAX_POINTS_PER_PIECE: i64 = 4000;
/// 和前端一樣：每消 10 行或每玩 1 分鐘升一級，看哪個先到
const LINES_PER_LEVEL: i64 = 10;
const MS_PER_LEVEL: i64 = 60_000;

/// 依名次排好的所有分數；停用的帳號不列入
macro_rules! ranked {
    () => {
        "WITH ranked AS (
            SELECT ROW_NUMBER() OVER (ORDER BY t.score DESC, t.achieved_at, t.user_id) AS rank,
                   t.user_id, u.username, t.score, t.lines, t.level, t.duration_ms, t.achieved_at
            FROM tetris_scores t JOIN users u ON u.id = t.user_id
            WHERE NOT u.disabled
        )
        SELECT rank, username, score, lines, level, duration_ms, achieved_at FROM ranked "
    };
}

#[derive(Serialize, sqlx::FromRow)]
pub struct Entry {
    pub rank: i64,
    pub username: String,
    pub score: i64,
    pub lines: i64,
    pub level: i64,
    pub duration_ms: i64,
    pub achieved_at: String,
}

#[derive(Serialize)]
pub struct Board {
    pub top: Vec<Entry>,
    /// 自己的最佳成績和名次；沒登入或還沒上傳過是 null
    pub me: Option<Entry>,
    /// 只有上傳時才有：這次是不是刷新了自己的紀錄
    #[serde(skip_serializing_if = "Option::is_none")]
    pub best: Option<bool>,
}

#[derive(Deserialize)]
pub struct ScoreInput {
    pub score: i64,
    pub lines: i64,
    pub level: i64,
    pub duration_ms: i64,
}

async fn board(state: &AppState, user: Option<&CurrentUser>) -> Result<Board, AppError> {
    let top = sqlx::query_as::<_, Entry>(concat!(ranked!(), "ORDER BY rank LIMIT ?"))
        .bind(TOP)
        .fetch_all(&state.pool)
        .await?;
    let me = match user {
        Some(user) => {
            sqlx::query_as::<_, Entry>(concat!(ranked!(), "WHERE user_id = ?"))
                .bind(user.id)
                .fetch_optional(&state.pool)
                .await?
        }
        None => None,
    };
    Ok(Board { top, me, best: None })
}

pub async fn list_scores(State(state): State<AppState>, user: Option<CurrentUser>) -> Result<Json<Board>, AppError> {
    Ok(Json(board(&state, user.as_ref()).await?))
}

fn validate(input: &ScoreInput) -> Result<(), AppError> {
    let bad = |message: &str| Err(AppError::BadRequest(message.into()));
    if !(1..=MAX_DURATION_MS).contains(&input.duration_ms) {
        return bad("遊戲時間不正確");
    }
    if input.lines < 0 || input.lines > input.duration_ms / MIN_MS_PER_LINE {
        return bad("消行數不正確");
    }
    let max_level = 1 + (input.lines / LINES_PER_LEVEL).max(input.duration_ms / MS_PER_LEVEL);
    if !(1..=max_level).contains(&input.level) {
        return bad("等級不正確");
    }
    // 消掉的格子加上最後留在盤面上的（最多 22 列），每塊 4 格
    let max_pieces = (input.lines * 10 + 220) / 4 + 1;
    if input.score < 0 || input.score > max_pieces * input.level * MAX_POINTS_PER_PIECE {
        return bad("分數不正確");
    }
    Ok(())
}

/// 上傳一局的成績：比自己的紀錄高才會更新，回傳更新後的排行榜
pub async fn submit_score(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(input): Json<ScoreInput>,
) -> Result<Json<Board>, AppError> {
    validate(&input)?;
    let result = sqlx::query(
        "INSERT INTO tetris_scores (user_id, score, lines, level, duration_ms) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (user_id) DO UPDATE SET
             score = excluded.score, lines = excluded.lines, level = excluded.level,
             duration_ms = excluded.duration_ms, achieved_at = excluded.achieved_at
         WHERE excluded.score > tetris_scores.score",
    )
    .bind(user.id)
    .bind(input.score)
    .bind(input.lines)
    .bind(input.level)
    .bind(input.duration_ms)
    .execute(&state.pool)
    .await?;
    let mut board = board(&state, Some(&user)).await?;
    board.best = Some(result.rows_affected() > 0);
    Ok(Json(board))
}
