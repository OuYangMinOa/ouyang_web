//! 方塊類的大逃殺（參考 Tetris 99）：最多 99 人同場，攻擊送給目標，最後存活的人獲勝。
//! 俄羅斯方塊（tetris.rs）和魔法氣泡（puyo.rs）共用，各自用 `Rules` 說明盤面大小和電腦玩家怎麼玩。
//!
//! 和棋類的房間（games.rs）不同，這裡伺服器懂一部分規則：誰還活著、攻擊要送給誰、KO 算誰的、
//! 徽章、名次，以及補位的電腦玩家。每個人自己的盤面在用戶端模擬，伺服器只收「送出多少攻擊」
//! 「盤面長怎樣」「我輸了」，再負責選目標與轉送。
//!
//! 對局是即時的，房間只放在記憶體：伺服器重啟或換版時，進行中的對局會中斷。
//! 每個房間有一個計時器（`TICK`）推進倒數、電腦玩家與目標，並把這段時間的變化合併成一則廣播，
//! 人再多也不會每個事件都廣播一次。協定見 `frontend/src/games/shared/useArena.ts`。

use std::{
    collections::{HashMap, HashSet},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use axum::{
    Json,
    extract::{
        Path, Query, State,
        ws::{Message, Utf8Bytes, WebSocket, WebSocketUpgrade},
    },
    http::StatusCode,
    response::Response,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::{sync::mpsc, time::Instant};

use crate::{AppError, AppState, auth::CurrentUser, games::random_code};

/// 每個遊戲不一樣的地方
pub trait Rules: Send + Sized + 'static {
    /// 盤面由上到下、每格一個字元 `'0'`（空）～`MAX_CELL`
    const ROWS: usize;
    const COLS: usize;
    const MAX_CELL: u8;
    /// 一次攻擊最多送多少（俄羅斯方塊是行數，魔法氣泡是干擾泡顆數）
    const MAX_ATTACK: u32;
    /// 能不能快速配對（公開房間）
    const PUBLIC: bool;
    type Bot: Bot;

    fn arenas(state: &AppState) -> &Arc<Arenas<Self>>;

    /// 用戶端送來的盤面加待落下的攻擊，換成「多危險」，給「快輸的」策略挑目標
    fn danger(board: &str, pending: u32) -> u32;

    fn empty_board() -> String {
        "0".repeat(Self::ROWS * Self::COLS)
    }
}

/// 電腦玩家：不用真的照規則玩，用機率模擬出大概的節奏，盤面是畫給別人看的
pub trait Bot: Send + Sized + 'static {
    /// `skill` 大約 0.3～1.3，越大越強；`next_move` 是第一手的時間
    fn new(skill: f64, next_move: Instant) -> Self;
    fn next_move(&self) -> Instant;
    /// 走一手：回傳要送出的攻擊（已經加上徽章、抵銷完自己待落下的）和是不是輸了
    fn step(&mut self, level: u32, badges: u32, rng: &mut Rng, now: Instant) -> (u32, bool);
    fn receive(&mut self, amount: u32, now: Instant);
    fn board(&self) -> String;
    fn danger(&self) -> u32;
}

const TICK: Duration = Duration::from_millis(250);
pub const MAX_PLAYERS: usize = 99;
const MAX_ARENAS: usize = 200;
const DEFAULT_BOTS: usize = 30;
const COUNTDOWN: Duration = Duration::from_secs(3);
/// 公開房間有兩個人以上就開始倒數，時間到自動開局
const AUTO_START: Duration = Duration::from_secs(20);
/// 對局中斷線這麼久就判定出局
const OFFLINE_KO: Duration = Duration::from_secs(10);
/// 沒有人連線超過這麼久的房間會被清掉
const EMPTY_TTL: Duration = Duration::from_secs(120);
/// 最後一次被攻擊後這麼久內出局，KO 算攻擊者的
const KO_CREDIT: Duration = Duration::from_secs(15);
/// 每這麼多個電腦玩家有一個是強的
const STRONG_BOTS_PER: usize = 7;
const MAX_NAME_CHARS: usize = 12;
const MAX_PLAYER_LEN: usize = 64;
const MAX_MSGS_PER_SEC: u32 = 30;
const MAX_FRAME_BYTES: usize = 2048;
const PING_INTERVAL: Duration = Duration::from_secs(25);
const IDLE_TIMEOUT: Duration = Duration::from_secs(60);
pub const MAX_LEVEL: u32 = 15;

type Reject = (&'static str, &'static str);

const NOT_FOUND: Reject = ("not_found", "找不到這個房間（可能已過期）");
const FULL: Reject = ("full", "房間已滿");
const REPLACED: Reject = ("replaced", "你在其他分頁或裝置開啟了這個房間");

pub struct Arenas<R: Rules> {
    live: Mutex<HashMap<String, Arc<Mutex<Arena<R>>>>>,
    next_conn: AtomicU64,
}

impl<R: Rules> Default for Arenas<R> {
    fn default() -> Self {
        Self { live: Mutex::default(), next_conn: AtomicU64::new(0) }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum Phase {
    Lobby,
    Countdown,
    Playing,
    Results,
}

/// 自動選目標的方式，和 Tetris 99 的四種一樣
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Strategy {
    /// 隨機，每隔幾秒換一個
    Random,
    /// 快輸的人（盤面最高、待升垃圾最多）
    Ko,
    /// 徽章最多的人
    Badges,
    /// 反擊正在攻擊自己的人，攻擊會同時送給每一個
    Attackers,
}

struct Player<B> {
    /// 每局房間內的編號，公開給其他人；`key` 才是認人的身分，不能外流
    pid: u32,
    /// `user:<id>` 或 `guest:<id>`；電腦玩家是 None
    key: Option<String>,
    name: String,
    conn: Option<Conn>,
    offline_since: Option<Instant>,
    /// 參加這一局（中途進來的人要等下一局）
    in_round: bool,
    alive: bool,
    place: Option<usize>,
    /// 徽章點數：KO 一個人得到 1 + 對方的點數
    badges: u32,
    kos: u32,
    strategy: Strategy,
    manual: Option<u32>,
    target: Option<u32>,
    retarget_at: Instant,
    last_hit: Option<(u32, Instant)>,
    /// 盤面，格式見 `Rules`
    board: String,
    /// 盤面高度加待升垃圾，給「KO」策略挑目標
    danger: u32,
    bot: Option<B>,
}

struct Conn {
    id: u64,
    tx: mpsc::UnboundedSender<Utf8Bytes>,
}

struct Arena<R: Rules> {
    public: bool,
    /// 從表裡移除後設為 true，剛好拿到這個房間的人要當作找不到
    closed: bool,
    phase: Phase,
    /// 倒數結束，或公開房間自動開局的時間
    deadline: Option<Instant>,
    started: Instant,
    round: u32,
    level: u32,
    bots: usize,
    players: Vec<Player<R::Bot>>,
    next_pid: u32,
    /// 狀態有變，下一個 tick 要廣播
    dirty: bool,
    /// 盤面有變的 pid
    changed: HashSet<u32>,
    empty_since: Option<Instant>,
    rng: Rng,
}

/// 徽章點數換成徽章數（0～4）：2、6、14、30 點各多一個，每個讓攻擊多 25%
pub fn badge_count(points: u32) -> u32 {
    [2, 6, 14, 30].iter().filter(|&&step| points >= step).count() as u32
}

pub fn with_badges(amount: u32, points: u32) -> u32 {
    amount * (4 + badge_count(points)) / 4
}

/// 打出攻擊時先抵銷自己待落下的（`(數量, 落下時間)`，先來的先抵），回傳剩下要送出去的
pub fn offset(pending: &mut Vec<(u32, Instant)>, mut amount: u32) -> u32 {
    while amount > 0 && !pending.is_empty() {
        let cancel = amount.min(pending[0].0);
        amount -= cancel;
        pending[0].0 -= cancel;
        if pending[0].0 == 0 {
            pending.remove(0);
        }
    }
    amount
}

impl<R: Rules> Arena<R> {
    fn new(public: bool, now: Instant) -> Self {
        Self {
            public,
            closed: false,
            phase: Phase::Lobby,
            deadline: None,
            started: now,
            round: 0,
            level: 1,
            bots: DEFAULT_BOTS,
            players: Vec::new(),
            next_pid: 1,
            dirty: true,
            changed: HashSet::new(),
            empty_since: None,
            rng: Rng::new(),
        }
    }

    fn index(&self, pid: u32) -> Option<usize> {
        self.players.iter().position(|p| p.pid == pid)
    }

    fn online_humans(&self) -> usize {
        self.players.iter().filter(|p| p.conn.is_some()).count()
    }

    /// 房主：最早進來、還連著的人
    fn host(&self) -> Option<u32> {
        self.players.iter().find(|p| p.conn.is_some()).map(|p| p.pid)
    }

    fn alive(&self) -> Vec<usize> {
        (0..self.players.len()).filter(|&i| self.players[i].alive).collect()
    }

    fn new_player(&mut self, key: Option<String>, name: String, now: Instant) -> Player<R::Bot> {
        let pid = self.next_pid;
        self.next_pid += 1;
        Player {
            pid,
            key,
            name,
            conn: None,
            offline_since: None,
            in_round: false,
            alive: false,
            place: None,
            badges: 0,
            kos: 0,
            strategy: Strategy::Random,
            manual: None,
            target: None,
            retarget_at: now,
            last_hit: None,
            board: R::empty_board(),
            danger: 0,
            bot: None,
        }
    }

    fn join(&mut self, key: &str, name: String, conn: Conn, now: Instant) -> Result<u32, Reject> {
        let i = match self.players.iter().position(|p| p.key.as_deref() == Some(key)) {
            Some(i) => i,
            None => {
                if self.players.iter().filter(|p| p.key.is_some()).count() >= MAX_PLAYERS {
                    return Err(FULL);
                }
                let player = self.new_player(Some(key.to_owned()), name, now);
                // 人排在電腦前面，房主和列表順序才會以人為主
                let at = self.players.iter().position(|p| p.key.is_none()).unwrap_or(self.players.len());
                self.players.insert(at, player);
                at
            }
        };
        let player = &mut self.players[i];
        if let Some(old) = player.conn.replace(conn) {
            let _ = old.tx.send(error_text(REPLACED));
        }
        player.offline_since = None;
        let pid = player.pid;
        let boards: HashMap<String, &str> =
            self.players.iter().map(|p| (p.pid.to_string(), p.board.as_str())).collect();
        self.send(i, &text(json!({ "type": "welcome", "you": pid, "round": self.round })));
        self.send(i, &self.state_text(now));
        self.send(i, &text(json!({ "type": "boards", "boards": boards })));
        self.dirty = true;
        Ok(pid)
    }

    fn leave(&mut self, pid: u32, conn: u64, now: Instant) {
        let Some(i) = self.index(pid) else { return };
        if self.players[i].conn.as_ref().is_none_or(|c| c.id != conn) {
            return;
        }
        let player = &mut self.players[i];
        player.conn = None;
        player.offline_since = Some(now);
        // 不在對局裡的人直接移出名單；對局中的人保留，斷線太久才判出局
        let playing = matches!(self.phase, Phase::Countdown | Phase::Playing);
        if !(playing && player.in_round) {
            self.players.remove(i);
        }
        self.dirty = true;
    }

    fn send(&self, i: usize, message: &Utf8Bytes) {
        if let Some(conn) = &self.players[i].conn {
            let _ = conn.tx.send(message.clone());
        }
    }

    fn broadcast(&self, message: &Utf8Bytes) {
        for i in 0..self.players.len() {
            self.send(i, message);
        }
    }

    fn state_text(&self, now: Instant) -> Utf8Bytes {
        let players: Vec<Value> = self
            .players
            .iter()
            .map(|p| {
                json!({
                    "pid": p.pid,
                    "name": p.name,
                    "bot": p.key.is_none(),
                    "online": p.key.is_none() || p.conn.is_some(),
                    "inRound": p.in_round,
                    "alive": p.alive,
                    "place": p.place,
                    "badges": p.badges,
                    "kos": p.kos,
                    "target": p.target,
                    "strategy": p.strategy,
                    "manual": p.manual.is_some(),
                })
            })
            .collect();
        text(json!({
            "type": "state",
            "phase": self.phase,
            "round": self.round,
            "level": self.level,
            "host": self.host(),
            "public": self.public,
            "bots": self.bots,
            "endsIn": self.deadline.map(|d| d.saturating_duration_since(now).as_millis() as u64),
            "players": players,
        }))
    }

    fn can_start(&self) -> bool {
        matches!(self.phase, Phase::Lobby | Phase::Results) && self.online_humans() + self.bots >= 2
    }

    fn start(&mut self, now: Instant) {
        if !self.can_start() {
            return;
        }
        self.players.retain(|p| p.conn.is_some());
        let count = self.bots.min(MAX_PLAYERS - self.players.len());
        // 大部分是弱的，前期就會陸續出局；強的只有幾個（至少一個），撐到後面
        let mut strong = count.div_ceil(STRONG_BOTS_PER);
        for n in 1..=count {
            let mut bot = self.new_player(None, format!("電腦 {n}"), now);
            // 隨機挑哪幾個是強的，不然強的永遠是前幾號
            let is_strong = self.rng.below(count + 1 - n) < strong;
            strong -= usize::from(is_strong);
            let skill = if is_strong { self.rng.range(1.0, 1.3) } else { self.rng.range(0.3, 0.65) };
            bot.strategy = match self.rng.below(10) {
                0..=6 => Strategy::Random,
                7 => Strategy::Ko,
                8 => Strategy::Badges,
                _ => Strategy::Attackers,
            };
            let next_move = now + COUNTDOWN + Duration::from_secs_f64(self.rng.range(0.3, 1.5));
            bot.bot = Some(R::Bot::new(skill, next_move));
            self.players.push(bot);
        }
        for p in &mut self.players {
            p.in_round = true;
            p.alive = true;
            p.place = None;
            p.badges = 0;
            p.kos = 0;
            p.manual = None;
            p.target = None;
            p.retarget_at = now;
            p.last_hit = None;
            p.board = R::empty_board();
            p.danger = 0;
            self.changed.insert(p.pid);
        }
        self.round += 1;
        self.level = 1;
        self.phase = Phase::Countdown;
        self.deadline = Some(now + COUNTDOWN);
        self.dirty = true;
    }

    fn tick(&mut self, now: Instant) {
        if self.online_humans() == 0 {
            self.empty_since.get_or_insert(now);
        } else {
            self.empty_since = None;
        }
        match self.phase {
            // 公開房間打完一局也一樣，人夠就自動開下一局
            Phase::Lobby | Phase::Results if self.public => {
                if self.online_humans() >= 2 {
                    match self.deadline {
                        None => {
                            self.deadline = Some(now + AUTO_START);
                            self.dirty = true;
                        }
                        Some(deadline) if now >= deadline => {
                            self.deadline = None;
                            self.start(now);
                        }
                        Some(_) => {}
                    }
                } else if self.deadline.take().is_some() {
                    self.dirty = true;
                }
            }
            Phase::Countdown if self.deadline.is_some_and(|d| now >= d) => {
                self.phase = Phase::Playing;
                self.deadline = None;
                self.started = now;
                self.dirty = true;
            }
            Phase::Playing => self.play(now),
            _ => {}
        }
        self.flush(now);
    }

    fn play(&mut self, now: Instant) {
        for i in 0..self.players.len() {
            let p = &self.players[i];
            if p.alive && p.key.is_some() && p.offline_since.is_some_and(|t| now.duration_since(t) >= OFFLINE_KO) {
                self.topout(i, now);
            }
        }
        for i in 0..self.players.len() {
            if self.phase != Phase::Playing {
                return;
            }
            if self.players[i].alive && self.players[i].bot.as_ref().is_some_and(|b| now >= b.next_move()) {
                self.bot_move(i, now);
            }
        }
        // 越後面越快：時間每 20 秒升一級，淘汰越多人再往上加
        let total = self.players.iter().filter(|p| p.in_round).count().max(1) as u32;
        let out = total - self.alive().len() as u32;
        let level = (1 + now.duration_since(self.started).as_secs() as u32 / 20 + out * 8 / total).min(MAX_LEVEL);
        if level != self.level {
            self.level = level;
            self.dirty = true;
        }
        self.retarget(now);
    }

    fn flush(&mut self, now: Instant) {
        if self.dirty {
            self.dirty = false;
            self.broadcast(&self.state_text(now));
        }
        if !self.changed.is_empty() {
            let boards: HashMap<String, &str> = self
                .players
                .iter()
                .filter(|p| self.changed.contains(&p.pid))
                .map(|p| (p.pid.to_string(), p.board.as_str()))
                .collect();
            self.broadcast(&text(json!({ "type": "boards", "boards": boards })));
            self.changed.clear();
        }
    }

    fn retarget(&mut self, now: Instant) {
        let alive = self.alive();
        for &i in &alive {
            let me = self.players[i].pid;
            let others: Vec<usize> = alive.iter().copied().filter(|&j| j != i).collect();
            if others.is_empty() {
                return;
            }
            let current = self.players[i].target.filter(|&t| others.iter().any(|&j| self.players[j].pid == t));
            let manual = self.players[i].manual.filter(|&t| others.iter().any(|&j| self.players[j].pid == t));
            let pick = if manual.is_some() {
                manual
            } else if current.is_some() && now < self.players[i].retarget_at {
                current
            } else {
                let (pick, wait) = match self.players[i].strategy {
                    Strategy::Random => (None, self.rng.range(3.0, 6.0)),
                    Strategy::Ko => (self.pick_top(i, &others, |p| p.danger), 1.0),
                    Strategy::Badges => (self.pick_top(i, &others, |p| p.badges), 1.0),
                    Strategy::Attackers => (others.iter().find(|&&j| self.players[j].target == Some(me)).copied(), 0.5),
                };
                self.players[i].retarget_at = now + Duration::from_secs_f64(wait);
                // 沒有符合條件的人（還沒人有徽章、沒人在打我）：留著原本的目標，沒有就隨機
                pick.map(|j| self.players[j].pid).or(current).or_else(|| {
                    let j = others[self.rng.below(others.len())];
                    Some(self.players[j].pid)
                })
            };
            if pick != self.players[i].target {
                self.players[i].target = pick;
                self.dirty = true;
            }
        }
    }

    /// 照分數挑目標（0 分的不算）。人挑最高的；電腦從前五名裡隨機挑，
    /// 不然開局時盤面最高的往往是人，會被所有電腦同時瞄準
    fn pick_top(&mut self, i: usize, others: &[usize], score: impl Fn(&Player<R::Bot>) -> u32) -> Option<usize> {
        let mut ranked: Vec<usize> = others.iter().copied().filter(|&j| score(&self.players[j]) > 0).collect();
        ranked.sort_by_key(|&j| std::cmp::Reverse(score(&self.players[j])));
        if self.players[i].bot.is_some() && !ranked.is_empty() {
            ranked.truncate(5);
            return Some(ranked[self.rng.below(ranked.len())]);
        }
        ranked.first().copied()
    }

    /// 送出攻擊：「反擊」策略打所有正在打自己的人，其他打目前的目標
    fn attack(&mut self, from: usize, amount: u32, now: Instant) {
        let me = self.players[from].pid;
        let alive = self.alive();
        let mut victims: Vec<usize> = Vec::new();
        if self.players[from].strategy == Strategy::Attackers && self.players[from].manual.is_none() {
            victims = alive.iter().copied().filter(|&j| j != from && self.players[j].target == Some(me)).collect();
        }
        if victims.is_empty() {
            let target = self.players[from].target.and_then(|t| self.index(t)).filter(|&j| self.players[j].alive);
            match target {
                Some(j) => victims.push(j),
                None => {
                    let others: Vec<usize> = alive.into_iter().filter(|&j| j != from).collect();
                    if others.is_empty() {
                        return;
                    }
                    victims.push(others[self.rng.below(others.len())]);
                }
            }
        }
        for v in victims {
            let victim = &mut self.players[v];
            victim.last_hit = Some((me, now));
            match &mut victim.bot {
                Some(bot) => {
                    bot.receive(amount, now);
                    victim.danger = bot.danger();
                }
                None => {
                    let _ = victim
                        .conn
                        .as_ref()
                        .map(|c| c.tx.send(text(json!({ "type": "garbage", "lines": amount, "from": me }))));
                }
            }
        }
    }

    fn topout(&mut self, i: usize, now: Instant) {
        if !self.players[i].alive {
            return;
        }
        let place = self.alive().len();
        let victim = &mut self.players[i];
        victim.alive = false;
        victim.place = Some(place);
        victim.target = None;
        let (pid, points, last_hit) = (victim.pid, victim.badges, victim.last_hit);
        let killer = last_hit
            .filter(|&(_, at)| now.duration_since(at) <= KO_CREDIT)
            .and_then(|(k, _)| self.index(k))
            .filter(|&k| self.players[k].alive);
        if let Some(k) = killer {
            self.players[k].kos += 1;
            self.players[k].badges += 1 + points;
        }
        let killer = killer.map(|k| self.players[k].pid);
        self.broadcast(&text(json!({ "type": "ko", "victim": pid, "killer": killer, "place": place })));
        self.dirty = true;

        let alive = self.alive();
        let human_alive = alive.iter().any(|&j| self.players[j].key.is_some());
        if alive.len() <= 1 || !human_alive {
            // 人都出局了就不等電腦打完：剩下的照危險程度排名
            let mut rest = alive;
            rest.sort_by_key(|&j| self.players[j].danger);
            for (n, j) in rest.into_iter().enumerate() {
                let p = &mut self.players[j];
                p.alive = false;
                p.place = Some(n + 1);
                p.target = None;
            }
            self.phase = Phase::Results;
            self.deadline = None;
        }
    }

    fn bot_move(&mut self, i: usize, now: Instant) {
        let Some(mut bot) = self.players[i].bot.take() else { return };
        let (sent, dead) = bot.step(self.level, self.players[i].badges, &mut self.rng, now);
        let player = &mut self.players[i];
        player.board = bot.board();
        player.danger = bot.danger();
        player.bot = Some(bot);
        self.changed.insert(player.pid);
        if sent > 0 {
            self.attack(i, sent.min(R::MAX_ATTACK), now);
        }
        if dead {
            self.topout(i, now);
        }
    }

    fn should_close(&self, now: Instant) -> bool {
        self.empty_since.is_some_and(|t| now.duration_since(t) >= EMPTY_TTL)
    }

    /// 處理用戶端的一則訊息；非 JSON、未知的 type 或現在不能做的事直接忽略
    fn handle(&mut self, pid: u32, message: ClientMessage, now: Instant) {
        let Some(i) = self.index(pid) else { return };
        let playing = self.phase == Phase::Playing && self.players[i].alive;
        match message {
            // 房主只能在沒有對局時調整電腦人數
            ClientMessage::Bots { count }
                if self.host() == Some(pid) && matches!(self.phase, Phase::Lobby | Phase::Results) =>
            {
                self.bots = count.min(MAX_PLAYERS - 1);
                self.dirty = true;
            }
            ClientMessage::Start if self.host() == Some(pid) => self.start(now),
            ClientMessage::Strategy { strategy } => {
                let p = &mut self.players[i];
                p.strategy = strategy;
                p.manual = None;
                p.retarget_at = now;
                self.dirty = true;
            }
            ClientMessage::Target { pid: target } if playing && target != pid => {
                if self.index(target).is_some_and(|j| self.players[j].alive) {
                    let p = &mut self.players[i];
                    p.manual = Some(target);
                    p.target = Some(target);
                    self.dirty = true;
                }
            }
            ClientMessage::Attack { lines } if playing && lines > 0 => self.attack(i, lines.min(R::MAX_ATTACK), now),
            ClientMessage::Board { rows, pending }
                if playing
                    && rows.len() == R::ROWS * R::COLS
                    && rows.bytes().all(|b| (b'0'..=R::MAX_CELL).contains(&b)) =>
            {
                let p = &mut self.players[i];
                p.danger = R::danger(&rows, pending);
                p.board = rows;
                self.changed.insert(pid);
            }
            ClientMessage::Topout if playing => self.topout(i, now),
            _ => {}
        }
    }
}

/// xorshift64*：電腦玩家和選目標用，不需要密碼學等級
pub struct Rng(u64);

impl Rng {
    pub(crate) fn new() -> Self {
        let mut bytes = [0u8; 8];
        let _ = getrandom::fill(&mut bytes);
        Self(u64::from_le_bytes(bytes) | 1)
    }

    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    pub fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }

    pub fn range(&mut self, lo: f64, hi: f64) -> f64 {
        lo + (self.next() >> 11) as f64 / (1u64 << 53) as f64 * (hi - lo)
    }

    pub fn chance(&mut self, p: f64) -> bool {
        self.range(0.0, 1.0) < p
    }
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum ClientMessage {
    Bots {
        count: usize,
    },
    Start,
    Strategy {
        strategy: Strategy,
    },
    Target {
        pid: u32,
    },
    /// 俄羅斯方塊是行數，魔法氣泡是干擾泡顆數
    Attack {
        lines: u32,
    },
    Board {
        rows: String,
        #[serde(default)]
        pending: u32,
    },
    Topout,
}

impl<R: Rules> Arenas<R> {
    /// 建立房間；`public` 是快速配對：有還沒開局的公開房間就加入人最多的那間
    fn open(self: &Arc<Self>, public: bool) -> Result<String, AppError> {
        let mut live = self.live.lock().unwrap();
        if public && R::PUBLIC {
            let best = live
                .iter()
                .filter_map(|(code, arena)| {
                    let arena = arena.lock().unwrap();
                    let humans = arena.players.iter().filter(|p| p.key.is_some()).count();
                    (arena.public && arena.phase == Phase::Lobby && humans < MAX_PLAYERS).then_some((code, humans))
                })
                .max_by_key(|&(_, humans)| humans);
            if let Some((code, _)) = best {
                return Ok(code.clone());
            }
        }
        if live.len() >= MAX_ARENAS {
            return Err(AppError::ServiceUnavailable("目前房間太多，請稍後再試"));
        }
        let code = loop {
            let code = random_code()?;
            if !live.contains_key(&code) {
                break code;
            }
        };
        let arena = Arc::new(Mutex::new(Arena::<R>::new(public && R::PUBLIC, Instant::now())));
        live.insert(code.clone(), arena.clone());
        tokio::spawn(run(self.clone(), code.clone(), arena));
        Ok(code)
    }

    fn get(&self, code: &str) -> Option<Arc<Mutex<Arena<R>>>> {
        self.live.lock().unwrap().get(code).cloned()
    }
}

/// 房間的計時器：推進遊戲，沒人太久就把房間收掉
async fn run<R: Rules>(arenas: Arc<Arenas<R>>, code: String, arena: Arc<Mutex<Arena<R>>>) {
    let mut ticks = tokio::time::interval(TICK);
    loop {
        ticks.tick().await;
        let now = Instant::now();
        arena.lock().unwrap().tick(now);
        let mut live = arenas.live.lock().unwrap();
        let mut guard = arena.lock().unwrap();
        if guard.should_close(now) {
            guard.closed = true;
            live.remove(&code);
            return;
        }
    }
}

#[derive(Deserialize)]
pub struct NewArena {
    #[serde(default)]
    public: bool,
}

pub async fn create_arena<R: Rules>(
    State(state): State<AppState>,
    Json(input): Json<NewArena>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    let code = R::arenas(&state).open(input.public)?;
    Ok((StatusCode::CREATED, Json(json!({ "code": code }))))
}

#[derive(Deserialize)]
pub struct JoinQuery {
    player: Option<String>,
    name: Option<String>,
}

/// 登入的人用帳號認人、用帳號名稱當暱稱；訪客用用戶端產生的 id 和自己取的暱稱（見 games.rs 的 connect）
pub async fn connect<R: Rules>(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Path(code): Path<String>,
    Query(query): Query<JoinQuery>,
    user: Option<CurrentUser>,
) -> Response {
    let code = code.to_ascii_uppercase();
    let identity = match (user, query.player) {
        (Some(user), _) => Some((format!("user:{}", user.id), user.username)),
        (None, Some(player)) if !player.is_empty() && player.chars().count() <= MAX_PLAYER_LEN => {
            let name: String = query
                .name
                .unwrap_or_default()
                .chars()
                .filter(|c| !c.is_control())
                .take(MAX_NAME_CHARS)
                .collect::<String>()
                .trim()
                .to_owned();
            let name = if name.is_empty() { "訪客".to_owned() } else { name };
            Some((format!("guest:{player}"), name))
        }
        _ => None,
    };
    ws.max_message_size(MAX_FRAME_BYTES).on_upgrade(move |socket| session::<R>(socket, state, code, identity))
}

async fn session<R: Rules>(mut socket: WebSocket, state: AppState, code: String, identity: Option<(String, String)>) {
    let Some((key, name)) = identity else {
        return close_with(socket, ("bad_request", "缺少 player，或 player 太長")).await;
    };
    let (tx, mut rx) = mpsc::unbounded_channel();
    let arenas = R::arenas(&state);
    let id = arenas.next_conn.fetch_add(1, Ordering::Relaxed) + 1;
    let Some(arena) = arenas.get(&code) else { return close_with(socket, NOT_FOUND).await };
    let joined = {
        let mut guard = arena.lock().unwrap();
        if guard.closed { Err(NOT_FOUND) } else { guard.join(&key, name, Conn { id, tx }, Instant::now()) }
    };
    let pid = match joined {
        Ok(pid) => pid,
        Err(reject) => return close_with(socket, reject).await,
    };

    let mut ping = tokio::time::interval_at(Instant::now() + PING_INTERVAL, PING_INTERVAL);
    let mut last_seen = Instant::now();
    let mut window = (Instant::now(), 0);
    let error = loop {
        tokio::select! {
            outgoing = rx.recv() => match outgoing {
                Some(text) => {
                    if socket.send(Message::Text(text)).await.is_err() {
                        break None;
                    }
                }
                None => break None,
            },
            incoming = socket.recv() => {
                let Some(Ok(message)) = incoming else { break None };
                last_seen = Instant::now();
                let Message::Text(text) = message else { continue };
                let now = Instant::now();
                if now.duration_since(window.0) >= Duration::from_secs(1) {
                    window = (now, 0);
                }
                window.1 += 1;
                if window.1 > MAX_MSGS_PER_SEC {
                    break Some(("rate_limited", "訊息送得太快了"));
                }
                if let Ok(message) = serde_json::from_str::<ClientMessage>(&text) {
                    arena.lock().unwrap().handle(pid, message, now);
                }
            }
            _ = ping.tick() => {
                if socket.send(Message::Ping(Default::default())).await.is_err() {
                    break None;
                }
            }
            _ = tokio::time::sleep_until(last_seen + IDLE_TIMEOUT) => break None,
        }
    };
    arena.lock().unwrap().leave(pid, id, Instant::now());
    match error {
        Some(reject) => close_with(socket, reject).await,
        None => {
            let _ = socket.send(Message::Close(None)).await;
        }
    }
}

fn text(value: Value) -> Utf8Bytes {
    value.to_string().into()
}

fn error_text((code, message): Reject) -> Utf8Bytes {
    text(json!({ "type": "error", "code": code, "message": message }))
}

async fn close_with(mut socket: WebSocket, reject: Reject) {
    if socket.send(Message::Text(error_text(reject))).await.is_err() || socket.send(Message::Close(None)).await.is_err()
    {
        return;
    }
    let _ =
        tokio::time::timeout(Duration::from_secs(2), async { while let Some(Ok(_)) = socket.recv().await {} }).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{puyo::Puyo, tetris::Tetris};

    /// 只有電腦的一局（加一個不會動的人，不然沒人活著就直接結算）：回傳每個電腦出局的秒數，打到剩一個為止
    fn bots_only<R: Rules>(bots: usize) -> Vec<f64> {
        let t0 = Instant::now();
        let mut arena = Arena::<R>::new(false, t0);
        arena.bots = bots;
        // 那個人要「連著線」才算得進開局人數，也不會因為斷線被判出局；送給他的訊息沒人收
        let (tx, _) = mpsc::unbounded_channel();
        arena.join("dummy", "dummy".to_owned(), Conn { id: 1, tx }, t0).unwrap();
        arena.start(t0);
        let mut now = t0;
        while arena.phase != Phase::Playing {
            now += TICK;
            arena.tick(now);
        }
        let started = now;
        let mut out = Vec::new();
        // 只有一個電腦時看它自己撐多久
        let left = if bots == 1 { 1 } else { 2 };
        while arena.alive().len() > left && now.duration_since(started) < Duration::from_secs(1200) {
            now += TICK;
            arena.tick(now);
            let dead = arena.players.iter().filter(|p| !p.alive).count();
            out.resize(dead, now.duration_since(started).as_secs_f64());
        }
        out
    }

    fn report<R: Rules>(game: &str) {
        for bots in [1, 8, 30, 98] {
            let runs: Vec<Vec<f64>> = (0..20).map(|_| bots_only::<R>(bots)).collect();
            let median = |mut v: Vec<f64>| {
                v.sort_by(f64::total_cmp);
                v[v.len() / 2]
            };
            let out_by = |t: f64| median(runs.iter().map(|r| r.iter().filter(|&&d| d <= t).count() as f64).collect());
            let end = median(
                runs.iter().map(|r| if r.len() + 1 >= bots { *r.last().unwrap_or(&1200.0) } else { 1200.0 }).collect(),
            );
            println!(
                "{game} {bots} bots: out by 60s {}, 120s {}, 180s {}; down to one {end:.0}s",
                out_by(60.0),
                out_by(120.0),
                out_by(180.0)
            );
        }
    }

    /// 調電腦玩家強弱用：`cargo test pacing -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn pacing() {
        report::<Tetris>("tetris");
        report::<Puyo>("puyo");
    }

    #[test]
    fn badges_boost_attack() {
        assert_eq!(badge_count(0), 0);
        assert_eq!(badge_count(1), 0);
        assert_eq!(badge_count(2), 1);
        assert_eq!(badge_count(6), 2);
        assert_eq!(badge_count(14), 3);
        assert_eq!(badge_count(100), 4);
        assert_eq!(with_badges(4, 0), 4);
        assert_eq!(with_badges(4, 2), 5);
        assert_eq!(with_badges(4, 30), 8);
    }
}
