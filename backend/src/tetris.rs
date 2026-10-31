//! 俄羅斯方塊大逃殺（參考 Tetris 99）：最多 99 人同場，消行變成垃圾行送給目標，最後存活的人獲勝。
//!
//! 和棋類的房間（games.rs）不同，這裡伺服器懂一部分規則：誰還活著、攻擊要送給誰、KO 算誰的、
//! 徽章、名次，以及補位的電腦玩家。每個人自己的盤面在用戶端模擬，伺服器只收「送出幾行攻擊」
//! 「盤面長怎樣」「我輸了」，再負責選目標與轉送。
//!
//! 對局是即時的，房間只放在記憶體：伺服器重啟或換版時，進行中的對局會中斷。
//! 每個房間有一個計時器（`TICK`）推進倒數、電腦玩家與目標，並把這段時間的變化合併成一則廣播，
//! 人再多也不會每個事件都廣播一次。協定見 `frontend/src/games/tetris/useArena.ts`。

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
/// 送給電腦玩家的垃圾行要等這麼久才會升上來（用戶端自己管自己的）
const BOT_GARBAGE_DELAY: Duration = Duration::from_secs(2);
const MAX_ATTACK: u32 = 30;
const ROWS: usize = 20;
const COLS: usize = 10;
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

#[derive(Default)]
pub struct Arenas {
    live: Mutex<HashMap<String, Arc<Mutex<Arena>>>>,
    next_conn: AtomicU64,
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

struct Player {
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
    /// 20 × 10 的盤面，由上到下，每格 `0`（空）～`8`（垃圾）
    board: String,
    /// 盤面高度加待升垃圾，給「KO」策略挑目標
    danger: u32,
    bot: Option<Bot>,
}

struct Conn {
    id: u64,
    tx: mpsc::UnboundedSender<Utf8Bytes>,
}

/// 電腦玩家沒有真的在下方塊：用機率模擬放塊、消行和被垃圾行推高，盤面是畫給別人看的
struct Bot {
    skill: f64,
    /// 由下往上
    rows: Vec<[u8; COLS]>,
    fill: f64,
    pending: Vec<(u32, Instant)>,
    next_move: Instant,
}

struct Arena {
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
    players: Vec<Player>,
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

fn with_badges(lines: u32, points: u32) -> u32 {
    lines * (4 + badge_count(points)) / 4
}

impl Arena {
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

    fn new_player(&mut self, key: Option<String>, name: String, now: Instant) -> Player {
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
            board: empty_board(),
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
        let room = MAX_PLAYERS - self.players.len();
        for n in 1..=self.bots.min(room) {
            let mut bot = self.new_player(None, format!("電腦 {n}"), now);
            let skill = self.rng.range(0.6, 1.25);
            bot.strategy = match self.rng.below(10) {
                0..=6 => Strategy::Random,
                7 => Strategy::Ko,
                8 => Strategy::Badges,
                _ => Strategy::Attackers,
            };
            let next_move = now + COUNTDOWN + Duration::from_secs_f64(self.rng.range(0.3, 1.5));
            bot.bot = Some(Bot { skill, rows: Vec::new(), fill: 0.0, pending: Vec::new(), next_move });
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
            p.board = empty_board();
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
            if self.players[i].alive && self.players[i].bot.as_ref().is_some_and(|b| now >= b.next_move) {
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
    fn pick_top(&mut self, i: usize, others: &[usize], score: impl Fn(&Player) -> u32) -> Option<usize> {
        let mut ranked: Vec<usize> = others.iter().copied().filter(|&j| score(&self.players[j]) > 0).collect();
        ranked.sort_by_key(|&j| std::cmp::Reverse(score(&self.players[j])));
        if self.players[i].bot.is_some() && !ranked.is_empty() {
            ranked.truncate(5);
            return Some(ranked[self.rng.below(ranked.len())]);
        }
        ranked.first().copied()
    }

    /// 送出攻擊：「反擊」策略打所有正在打自己的人，其他打目前的目標
    fn attack(&mut self, from: usize, lines: u32, now: Instant) {
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
                    bot.pending.push((lines, now + BOT_GARBAGE_DELAY));
                    victim.danger = bot.danger();
                }
                None => {
                    let _ = victim
                        .conn
                        .as_ref()
                        .map(|c| c.tx.send(text(json!({ "type": "garbage", "lines": lines, "from": me }))));
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
        let level = f64::from(self.level);
        let rng = &mut self.rng;
        let pace = (1.0 - level * 0.035).max(0.45);
        bot.next_move = now + Duration::from_secs_f64(rng.range(0.7, 1.3) * pace / bot.skill);

        // 放一塊大約是 0.4 行；等級越高越容易失誤留下洞
        bot.fill += 0.4;
        if rng.chance(0.012 * level / bot.skill) {
            bot.fill += 1.0;
        }
        while bot.fill >= 1.0 {
            bot.fill -= 1.0;
            let mut row = [0u8; COLS];
            for cell in &mut row {
                *cell = 1 + rng.below(7) as u8;
            }
            row[rng.below(COLS)] = 0;
            bot.rows.push(row);
        }

        let height = bot.rows.len();
        let mut sent = 0;
        let clear = (0.08 + height as f64 / ROWS as f64 * 0.9 * bot.skill).min(0.85);
        if height > 0 && rng.chance(clear) {
            let roll = rng.range(0.0, 1.0);
            let lines = if height >= 4 && roll < 0.12 * bot.skill {
                4
            } else if roll < 0.22 {
                3
            } else if roll < 0.5 {
                2
            } else {
                1
            }
            .min(height);
            // 偶爾當成 T-Spin 雙消
            let tspin = lines == 2 && rng.chance(0.1 * bot.skill);
            sent = if tspin { 4 } else { [0, 0, 1, 2, 4][lines] };
            bot.rows.truncate(height - lines);
            sent = with_badges(sent, self.players[i].badges);
            // 先抵銷自己待升的垃圾，剩下的才送出去
            while sent > 0 && !bot.pending.is_empty() {
                let cancel = sent.min(bot.pending[0].0);
                sent -= cancel;
                bot.pending[0].0 -= cancel;
                if bot.pending[0].0 == 0 {
                    bot.pending.remove(0);
                }
            }
        } else {
            let mut budget = 8;
            while budget > 0 && bot.pending.first().is_some_and(|&(_, at)| now >= at) {
                let lines = bot.pending[0].0.min(budget);
                budget -= lines;
                bot.pending[0].0 -= lines;
                if bot.pending[0].0 == 0 {
                    bot.pending.remove(0);
                }
                let hole = rng.below(COLS);
                for _ in 0..lines {
                    let mut row = [8u8; COLS];
                    row[hole] = 0;
                    bot.rows.insert(0, row);
                }
            }
        }

        let dead = bot.rows.len() > ROWS;
        let player = &mut self.players[i];
        player.board = bot.board();
        player.danger = bot.danger();
        player.bot = Some(bot);
        self.changed.insert(player.pid);
        if sent > 0 {
            self.attack(i, sent.min(MAX_ATTACK), now);
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
            ClientMessage::Attack { lines } if playing && lines > 0 => self.attack(i, lines.min(MAX_ATTACK), now),
            ClientMessage::Board { rows, pending }
                if playing && rows.len() == ROWS * COLS && rows.bytes().all(|b| (b'0'..=b'8').contains(&b)) =>
            {
                let height = rows.bytes().position(|b| b != b'0').map_or(0, |at| ROWS - at / COLS) as u32;
                let p = &mut self.players[i];
                p.danger = height + pending.min(40);
                p.board = rows;
                self.changed.insert(pid);
            }
            ClientMessage::Topout if playing => self.topout(i, now),
            _ => {}
        }
    }
}

impl Bot {
    fn board(&self) -> String {
        let mut out = String::with_capacity(ROWS * COLS);
        for r in (0..ROWS).rev() {
            match self.rows.get(r) {
                Some(row) => out.extend(row.iter().map(|&c| char::from(b'0' + c))),
                None => out.push_str("0000000000"),
            }
        }
        out
    }

    fn danger(&self) -> u32 {
        self.rows.len() as u32 + self.pending.iter().map(|&(lines, _)| lines).sum::<u32>()
    }
}

fn empty_board() -> String {
    "0".repeat(ROWS * COLS)
}

/// xorshift64*：電腦玩家和選目標用，不需要密碼學等級
struct Rng(u64);

impl Rng {
    fn new() -> Self {
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

    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }

    fn range(&mut self, lo: f64, hi: f64) -> f64 {
        lo + (self.next() >> 11) as f64 / (1u64 << 53) as f64 * (hi - lo)
    }

    fn chance(&mut self, p: f64) -> bool {
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

impl Arenas {
    /// 建立房間；`public` 是快速配對：有還沒開局的公開房間就加入人最多的那間
    fn open(self: &Arc<Self>, public: bool) -> Result<String, AppError> {
        let mut live = self.live.lock().unwrap();
        if public {
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
        let arena = Arc::new(Mutex::new(Arena::new(public, Instant::now())));
        live.insert(code.clone(), arena.clone());
        tokio::spawn(run(self.clone(), code.clone(), arena));
        Ok(code)
    }

    fn get(&self, code: &str) -> Option<Arc<Mutex<Arena>>> {
        self.live.lock().unwrap().get(code).cloned()
    }
}

/// 房間的計時器：推進遊戲，沒人太久就把房間收掉
async fn run(arenas: Arc<Arenas>, code: String, arena: Arc<Mutex<Arena>>) {
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

pub async fn create_arena(
    State(state): State<AppState>,
    Json(input): Json<NewArena>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    let code = state.tetris.open(input.public)?;
    Ok((StatusCode::CREATED, Json(json!({ "code": code }))))
}

#[derive(Deserialize)]
pub struct JoinQuery {
    player: Option<String>,
    name: Option<String>,
}

/// 登入的人用帳號認人、用帳號名稱當暱稱；訪客用用戶端產生的 id 和自己取的暱稱（見 games.rs 的 connect）
pub async fn connect(
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
    ws.max_message_size(MAX_FRAME_BYTES).on_upgrade(move |socket| session(socket, state, code, identity))
}

async fn session(mut socket: WebSocket, state: AppState, code: String, identity: Option<(String, String)>) {
    let Some((key, name)) = identity else {
        return close_with(socket, ("bad_request", "缺少 player，或 player 太長")).await;
    };
    let (tx, mut rx) = mpsc::unbounded_channel();
    let id = state.tetris.next_conn.fetch_add(1, Ordering::Relaxed) + 1;
    let Some(arena) = state.tetris.get(&code) else { return close_with(socket, NOT_FOUND).await };
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

    #[test]
    fn bot_board_is_drawn_bottom_up() {
        let bot = Bot {
            skill: 1.0,
            rows: vec![[8, 8, 8, 8, 8, 8, 8, 8, 8, 0]],
            fill: 0.0,
            pending: vec![(3, Instant::now())],
            next_move: Instant::now(),
        };
        let board = bot.board();
        assert_eq!(board.len(), ROWS * COLS);
        assert!(board.ends_with("8888888880"));
        assert!(board[..190].bytes().all(|b| b == b'0'));
        assert_eq!(bot.danger(), 4);
    }
}
