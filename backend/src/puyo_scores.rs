//! 魔法氣泡單人模式的排行榜：每個帳號只留最高分那一局，看排行榜不用登入，上傳要登入。
//!
//! 做法和俄羅斯方塊（tetris_scores.rs）一樣：分數是前端算的，後端不重播整局，而是檢查「中間態」來確認真的有玩：
//!
//! - 開局時先跟伺服器拿一個 run id（`POST /runs`），伺服器記下開始時間。
//! - 玩的時候每隔幾秒（遊戲時間）回報一次目前的狀態（`POST /runs/{id}/checkpoints`），包含整個盤面。
//!   伺服器檢查：
//!   - 遊戲時間不能比實際經過的時間還長，兩次回報之間最多隔 `MAX_GAP_MS`；
//!   - 分數、放下的組數、消掉的顆數、等級、最大連鎖只能變多，增加的速度要在做得到的範圍；
//!     分數最多是「消掉的顆數 × 10 × 999」（官方公式的倍率上限）加上下落和全消的分數；
//!   - 盤面要合理：沒有懸空的氣泡、沒有還沒消掉的四連，顆數剛好等於「組數 × 2 − 消掉的 − 疊出界消失的」。
//! - 結束時（`POST /runs/{id}/finish`）最後一次回報同樣檢查，通過才寫進排行榜。
//!
//! 有一次不合理，這一局就作廢。進行中的局只放在記憶體，重啟或換版時進行中的局無法上傳。
//! 一個帳號同時只能有一局，在別的分頁開新局，舊的那局就不算了。

use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use serde::{Deserialize, Serialize};

use crate::{AppError, AppState, auth::CurrentUser, games::random_code};

/// 排行榜列出前幾名
const TOP: i64 = 20;
/// 和前端一樣：每放 30 組或每玩 1 分鐘升一級，看哪個先到
const PIECES_PER_LEVEL: i64 = 30;
const MS_PER_LEVEL: i64 = 60_000;
/// 前端每 5 秒（遊戲時間）回報一次；容許中間掉幾次
const MAX_GAP_MS: i64 = 20_000;
/// 遊戲時間最多比實際經過的時間多這麼多（網路延遲、計時誤差）
const CLOCK_SLACK_MS: i64 = 3_000;
/// 每秒最多放幾組（每組放下後還要等掉落動畫，實際上很難超過 4 組）
const MAX_PIECES_PER_SECOND: i64 = 8;
/// 一顆被消掉的氣泡最多值幾分：10 × 倍率上限 999
const MAX_POINTS_PER_POP: i64 = 9_990;
/// 一組最多額外拿幾分：下落每格 1 分（最多 13 格）加上全消 2100
const MAX_EXTRA_PER_PIECE: i64 = 13 + 2_100;
/// 6 × 12 的盤面、四種顏色，理論上最多 19 連鎖
const MAX_CHAIN: i64 = 19;
const COLS: usize = 6;
/// 盤面含上方看不到的第 13 列（那一列不會消）
const TOTAL_ROWS: usize = 13;
const HIDDEN_ROWS: usize = 1;
/// 太久沒動靜的局直接丟掉（暫停也算，所以給長一點）
const RUN_TTL: Duration = Duration::from_secs(3 * 60 * 60);

/// 依名次排好的所有分數；停用的帳號不列入
macro_rules! ranked {
    () => {
        "WITH ranked AS (
            SELECT ROW_NUMBER() OVER (ORDER BY p.score DESC, p.achieved_at, p.user_id) AS rank,
                   p.user_id, u.username, p.score, p.max_chain, p.level, p.duration_ms, p.achieved_at
            FROM puyo_scores p JOIN users u ON u.id = p.user_id
            WHERE NOT u.disabled
        )
        SELECT rank, username, score, max_chain, level, duration_ms, achieved_at FROM ranked "
    };
}

#[derive(Serialize, sqlx::FromRow)]
pub struct Entry {
    pub rank: i64,
    pub username: String,
    pub score: i64,
    pub max_chain: i64,
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

/// 前端回報的一個中間態
#[derive(Deserialize, Clone, Copy, Default)]
pub struct Progress {
    pub score: i64,
    pub level: i64,
    /// 放下了幾組
    pub pieces: i64,
    /// 消掉了幾顆
    pub popped: i64,
    /// 疊到第 13 列上面消失了幾顆
    pub lost: i64,
    pub max_chain: i64,
    /// 遊戲時間（不含暫停）
    pub duration_ms: i64,
}

#[derive(Deserialize)]
pub struct Checkpoint {
    #[serde(flatten)]
    pub progress: Progress,
    /// 整個盤面（含第 13 列），由上到下每格一個字元：0 是空的，1～4 是四種顏色（單人模式沒有干擾泡）
    pub board: String,
}

struct Run {
    id: String,
    started: Instant,
    touched: Instant,
    last: Progress,
}

/// 進行中的局，一個帳號一局
#[derive(Default)]
pub struct Runs {
    runs: Mutex<HashMap<i64, Run>>,
}

#[derive(Serialize)]
pub struct Started {
    pub id: String,
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

/// 開新的一局（同一個帳號原本的那局作廢）
pub async fn start_run(
    State(state): State<AppState>,
    user: CurrentUser,
) -> Result<(StatusCode, Json<Started>), AppError> {
    let id = random_code()?;
    let now = Instant::now();
    let mut runs = state.puyo_runs.runs.lock().unwrap();
    runs.retain(|_, run| now.duration_since(run.touched) < RUN_TTL);
    runs.insert(
        user.id,
        Run { id: id.clone(), started: now, touched: now, last: Progress { level: 1, ..Default::default() } },
    );
    Ok((StatusCode::CREATED, Json(Started { id })))
}

/// 可見區（第 1～12 列）裡同色相連最多幾顆
fn largest_group(cells: &[u8]) -> usize {
    let mut seen = vec![false; cells.len()];
    let mut largest = 0;
    for start in HIDDEN_ROWS * COLS..cells.len() {
        if seen[start] || cells[start] == b'0' {
            continue;
        }
        seen[start] = true;
        let mut stack = vec![start];
        let mut size = 0;
        while let Some(i) = stack.pop() {
            size += 1;
            let (x, y) = (i % COLS, i / COLS);
            let mut visit = |j: usize| {
                if !seen[j] && cells[j] == cells[start] {
                    seen[j] = true;
                    stack.push(j);
                }
            };
            if x > 0 {
                visit(i - 1);
            }
            if x + 1 < COLS {
                visit(i + 1);
            }
            if y > HIDDEN_ROWS {
                visit(i - COLS);
            }
            if y + 1 < TOTAL_ROWS {
                visit(i + COLS);
            }
        }
        largest = largest.max(size);
    }
    largest
}

/// 盤面合理：長度和字元正確、沒有懸空、沒有該消沒消的、顆數對得上
fn check_board(board: &str, progress: &Progress) -> Result<(), &'static str> {
    let cells = board.as_bytes();
    if cells.len() != COLS * TOTAL_ROWS || !cells.iter().all(|c| (b'0'..=b'4').contains(c)) {
        return Err("盤面格式不正確");
    }
    for x in 0..COLS {
        let column: Vec<u8> = (0..TOTAL_ROWS).map(|y| cells[y * COLS + x]).collect();
        // 由上往下：碰到第一顆之後就不能再有空格
        if column.iter().skip_while(|&&c| c == b'0').any(|&c| c == b'0') {
            return Err("盤面不可能有懸空的氣泡");
        }
    }
    if largest_group(cells) >= 4 {
        return Err("盤面不可能有沒消掉的四連");
    }
    let filled = cells.iter().filter(|&&c| c != b'0').count() as i64;
    if filled != progress.pieces * 2 - progress.popped - progress.lost {
        return Err("盤面和放下的氣泡數對不上");
    }
    Ok(())
}

/// 和上一次回報比，這段時間的進展做得到嗎
fn check_progress(last: &Progress, next: &Progress, elapsed_ms: i64) -> Result<(), &'static str> {
    if next.duration_ms < last.duration_ms
        || next.score < last.score
        || next.pieces < last.pieces
        || next.popped < last.popped
        || next.lost < last.lost
        || next.level < last.level
        || next.max_chain < last.max_chain
    {
        return Err("數字不能變少");
    }
    if next.duration_ms > elapsed_ms + CLOCK_SLACK_MS {
        return Err("遊戲時間比實際經過的時間還長");
    }
    let gap = next.duration_ms - last.duration_ms;
    if gap > MAX_GAP_MS {
        return Err("太久沒有回報進度");
    }
    let pieces = next.pieces - last.pieces;
    if pieces > gap * MAX_PIECES_PER_SECOND / 1000 + 2 {
        return Err("放氣泡的速度太快");
    }
    if next.level > 1 + (next.pieces / PIECES_PER_LEVEL).max(next.duration_ms / MS_PER_LEVEL) {
        return Err("等級不正確");
    }
    if next.max_chain > MAX_CHAIN || next.max_chain * 4 > next.popped {
        return Err("連鎖數不正確");
    }
    let limit = (next.popped - last.popped) * MAX_POINTS_PER_POP + pieces * MAX_EXTRA_PER_PIECE;
    if next.score - last.score > limit {
        return Err("分數增加得太快");
    }
    Ok(())
}

/// 檢查一次回報；不合理就把這局作廢。回傳通過的進度
fn advance(state: &AppState, user: &CurrentUser, id: &str, checkpoint: &Checkpoint) -> Result<Progress, AppError> {
    let mut runs = state.puyo_runs.runs.lock().unwrap();
    let run = runs.get_mut(&user.id).filter(|run| run.id == id).ok_or_else(|| {
        AppError::Conflict("這一局已經失效（在別的分頁開了新局，或伺服器重新啟動過），不列入排行榜".into())
    })?;
    let now = Instant::now();
    let elapsed_ms = i64::try_from(now.duration_since(run.started).as_millis()).unwrap_or(i64::MAX);
    let next = checkpoint.progress;
    if let Err(reason) =
        check_progress(&run.last, &next, elapsed_ms).and_then(|()| check_board(&checkpoint.board, &next))
    {
        runs.remove(&user.id);
        return Err(AppError::BadRequest(format!("{reason}，這一局不列入排行榜")));
    }
    run.last = next;
    run.touched = now;
    Ok(next)
}

pub async fn checkpoint(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    Json(checkpoint): Json<Checkpoint>,
) -> Result<StatusCode, AppError> {
    advance(&state, &user, &id, &checkpoint)?;
    Ok(StatusCode::NO_CONTENT)
}

/// 結束這一局：最後的狀態檢查過後寫進排行榜（比自己的紀錄高才會更新），回傳更新後的排行榜
pub async fn finish_run(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    Json(checkpoint): Json<Checkpoint>,
) -> Result<Json<Board>, AppError> {
    let result = advance(&state, &user, &id, &checkpoint)?;
    state.puyo_runs.runs.lock().unwrap().remove(&user.id);
    let written = sqlx::query(
        "INSERT INTO puyo_scores (user_id, score, max_chain, level, duration_ms) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (user_id) DO UPDATE SET
             score = excluded.score, max_chain = excluded.max_chain, level = excluded.level,
             duration_ms = excluded.duration_ms, achieved_at = excluded.achieved_at
         WHERE excluded.score > puyo_scores.score",
    )
    .bind(user.id)
    .bind(result.score)
    .bind(result.max_chain)
    .bind(result.level)
    .bind(result.duration_ms)
    .execute(&state.pool)
    .await?;
    let mut board = board(&state, Some(&user)).await?;
    board.best = Some(written.rows_affected() > 0);
    Ok(Json(board))
}
