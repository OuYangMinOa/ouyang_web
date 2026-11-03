//! 系統管理的「遊戲狀態」（`/admin/games`）：現在開著的房間、誰在裡面，以及單人排行榜模式誰正在玩。
//!
//! 三種房間和遊戲室各自提供快照（`games.rs`、`arena.rs`、`party.rs`、`lobby.rs` 的 `snapshot`），這裡合併起來，再把帳號 id 換成帳號名稱。
//! 只看得到這個容器記憶體裡的東西：換版的那幾秒新舊容器各有一部分。
//! 對電腦、同一台輪流下和單人模式（排行榜以外）都只在瀏覽器裡跑，伺服器不知道，所以不在這裡。

use std::{collections::HashMap, time::Duration};

use axum::{Json, extract::State};
use serde::Serialize;
use serde_json::json;
use tokio::time::Instant;

use crate::{
    AppError, AppState,
    auth::{AdminUsers, Require, token_hash},
};

/// 單人排行榜的局這麼久沒回報中間態就不列出來（暫停、關掉分頁都不會通知伺服器）
pub const SOLO_IDLE: Duration = Duration::from_secs(5 * 60);

#[derive(Serialize)]
pub struct Report {
    pub rooms: Vec<RoomInfo>,
    pub solo: Vec<SoloRun>,
}

#[derive(Serialize)]
pub struct RoomInfo {
    /// `duel`（棋類的轉送房間）、`arena`（大逃殺）、`party`（派對）、`lobby`（遊戲室）
    pub kind: &'static str,
    /// 遊戲 id，例如 `gomoku`、`tetris`、`undercover`；遊戲室是現在在玩的那款（還沒開過是空字串）
    pub game: &'static str,
    pub code: String,
    /// duel：`waiting`／`playing`／`idle`（沒人連著）；arena：`lobby`／`countdown`／`playing`／`results`；
    /// party：`lobby`／`playing`／`results`；lobby：`lobby`（還沒開過遊戲）／`playing`
    pub phase: &'static str,
    /// 開過幾局（duel 沒有局的概念，是 0）
    pub round: u32,
    pub age_secs: u64,
    pub bots: usize,
    /// 大逃殺的快速配對房間
    pub public: bool,
    /// duel：存了幾筆歷史（大致是走了幾步）
    pub events: Option<usize>,
    /// arena 對局中：還活著幾個（含電腦）
    pub alive: Option<usize>,
    /// 只有真人，電腦只算在 `bots`
    pub players: Vec<PlayerInfo>,
}

#[derive(Serialize)]
pub struct PlayerInfo {
    /// 認人用，同一個人在不同房間是同一個值：帳號是 `u<id>`；訪客是 id 雜湊的前幾碼
    /// （訪客的 id 拿來連線就能坐回他的座位，原文不外流）
    pub who: String,
    /// 遊戲裡的暱稱；棋類沒有暱稱，帳號用帳號名稱、訪客是「訪客」
    pub name: String,
    /// 登入的帳號名稱，訪客是 null
    pub username: Option<String>,
    #[serde(skip)]
    pub user_id: Option<i64>,
    pub online: bool,
    pub host: bool,
    /// 在房間裡的狀態，例如「座位 1」「觀戰」「第 3 名」；沒什麼好說的時候是空字串
    pub status: String,
    /// 連著線才有
    pub ip: Option<String>,
    /// 這條連線連了多久
    pub online_secs: Option<u64>,
}

impl PlayerInfo {
    /// `key` 是房間用來認人的 `user:<id>` 或 `guest:<id>`；`conn` 是連著線時的 `(IP, 連上的時間)`
    pub(crate) fn new(key: &str, name: String, conn: Option<(&str, Instant)>, now: Instant) -> Self {
        let user_id = key.strip_prefix("user:").and_then(|id| id.parse().ok());
        let who = match user_id {
            Some(id) => format!("u{id}"),
            None => format!("g{}", &token_hash(key)[..8]),
        };
        Self {
            who,
            name,
            username: None,
            user_id,
            online: conn.is_some(),
            host: false,
            status: String::new(),
            ip: conn.map(|(ip, _)| ip.to_owned()),
            online_secs: conn.map(|(_, since)| now.duration_since(since).as_secs()),
        }
    }

    pub(crate) fn host(mut self, host: bool) -> Self {
        self.host = host;
        self
    }

    pub(crate) fn status(mut self, status: impl Into<String>) -> Self {
        self.status = status.into();
        self
    }
}

#[derive(Serialize)]
pub struct SoloRun {
    /// `tetris`／`puyo`
    pub game: &'static str,
    pub username: String,
    #[serde(skip)]
    pub user_id: i64,
    pub score: i64,
    pub level: i64,
    /// 遊戲時間（不含暫停）
    pub duration_ms: i64,
    /// 開局多久了
    pub age_secs: u64,
    /// 最後一次回報中間態是多久以前
    pub idle_secs: u64,
}

pub async fn report(State(state): State<AppState>, _: Require<AdminUsers>) -> Result<Json<Report>, AppError> {
    let now = Instant::now();
    let mut rooms = state.rooms.snapshot(&state.pool, now).await?;
    rooms.extend(state.tetris.snapshot(now));
    rooms.extend(state.puyo.snapshot(now));
    rooms.extend(state.undercover.snapshot(now));
    rooms.extend(state.bigtwo.snapshot(now));
    rooms.extend(state.minesrace.snapshot(now));
    rooms.extend(state.draw.snapshot(now));
    rooms.extend(state.lobbies.snapshot(now));
    // 有人連著的在前面，再來是新開的
    rooms.sort_by_key(|r| (!r.players.iter().any(|p| p.online), r.age_secs));

    // 單人排行榜的局用的是 std 的 Instant
    let mut solo = state.tetris_runs.snapshot(now.into_std());
    solo.extend(state.puyo_runs.snapshot(now.into_std()));
    solo.sort_by_key(|r| r.idle_secs);

    let ids: Vec<i64> = rooms
        .iter()
        .flat_map(|r| r.players.iter().filter_map(|p| p.user_id))
        .chain(solo.iter().map(|r| r.user_id))
        .collect();
    let names: HashMap<i64, String> = if ids.is_empty() {
        HashMap::new()
    } else {
        sqlx::query_as::<_, (i64, String)>(
            "SELECT id, username FROM users WHERE id IN (SELECT value FROM json_each(?))",
        )
        .bind(json!(ids).to_string())
        .fetch_all(&state.pool)
        .await?
        .into_iter()
        .collect()
    };
    for player in rooms.iter_mut().flat_map(|r| r.players.iter_mut()) {
        player.username = player.user_id.and_then(|id| names.get(&id).cloned());
        if player.name.is_empty() {
            player.name = player.username.clone().unwrap_or_else(|| "訪客".into());
        }
    }
    for run in &mut solo {
        run.username = names.get(&run.user_id).cloned().unwrap_or_else(|| format!("#{}", run.user_id));
    }
    Ok(Json(Report { rooms, solo }))
}
