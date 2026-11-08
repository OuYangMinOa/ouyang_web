//! 遊戲室：一群人先待在同一個房間，房主選要玩哪一款，伺服器替大家開好那款遊戲的房間，所有人自動跳過去。
//! 換遊戲時不用重開房間、重新邀請。
//!
//! 遊戲室不懂任何遊戲規則，只記名單、聊天、每個人要上場還是觀戰（`watch`），和「現在在玩哪一間」（`playing`）：
//! - 派對遊戲（`party.rs`）和大逃殺（`arena.rs`）：所有人一起去。開房時把遊戲室的順序交給那間房間，
//!   遊戲室的房主到了那邊也是房主（不管誰先連上）；選了觀戰的人也交過去，到了那邊不上場、在旁邊看。
//!   之後在遊戲室改選，也會轉給正在玩的那一間（下一局生效）。
//! - 棋類（`games.rs`）只有兩個座位：房主從要上場的人裡挑兩個，開房時就把座位排好，其他人連進去是觀戰。
//!
//! 用戶端整個小遊戲區都連著遊戲室（玩遊戲的時候也是），收到新的 `playing` 就跳到 `/games/<game>?room=<code>`，
//! 上場和觀戰的人都一樣。協定見 `frontend/src/games/lobby/useLobby.ts`。
//!
//! 只放在記憶體：重啟或換版時遊戲室會消失（已經開出去的遊戲房間照各自的規則）。
//! 斷線的人留在名單上一分鐘（手機切到背景、換頁時的短暫斷線不會被移出去），沒人連線 10 分鐘就收掉。

use std::{
    collections::{HashMap, HashSet, VecDeque},
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
    http::{HeaderMap, StatusCode},
    response::Response,
};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::{sync::mpsc, time::Instant};

use crate::{
    AppError, AppState,
    arena::{Arenas, Rules},
    auth::{CurrentUser, client_key},
    game_monitor::{PlayerInfo, RoomInfo},
    games::random_code,
    party::{MAX_CHAT_CHARS, MAX_NAME_CHARS, Parties, PartyGame, clean},
};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Kind {
    /// 棋類的轉送房間，兩個座位
    Duel,
    Arena,
    Party,
}

struct Game {
    /// 前端網址上的 id（`/games/<id>`）；踩地雷競速的派對遊戲 id 是 `minesrace`，但頁面是 `minesweeper`
    id: &'static str,
    name: &'static str,
    kind: Kind,
}

/// 遊戲室能開的遊戲；新增派對遊戲或大逃殺時記得加在這裡和 `room_table`
const GAMES: [Game; 23] = [
    Game { id: "undercover", name: "誰是臥底", kind: Kind::Party },
    Game { id: "bigtwo", name: "大老二", kind: Kind::Party },
    Game { id: "draw", name: "你畫我猜", kind: Kind::Party },
    Game { id: "antique", name: "古董局中局", kind: Kind::Party },
    Game { id: "uno", name: "UNO", kind: Kind::Party },
    Game { id: "justone", name: "只有一個詞", kind: Kind::Party },
    Game { id: "telephone", name: "傳話畫畫", kind: Kind::Party },
    Game { id: "poker", name: "德州撲克", kind: Kind::Party },
    Game { id: "werewolf", name: "狼人殺", kind: Kind::Party },
    Game { id: "chinesecheckers", name: "跳棋", kind: Kind::Party },
    Game { id: "contact", name: "暗號接頭", kind: Kind::Party },
    Game { id: "liarsdice", name: "吹牛骰子", kind: Kind::Party },
    Game { id: "minesweeper", name: "踩地雷競速", kind: Kind::Party },
    Game { id: "racing", name: "3D 賽車", kind: Kind::Party },
    Game { id: "tetris", name: "俄羅斯方塊 99", kind: Kind::Arena },
    Game { id: "puyo", name: "魔法氣泡", kind: Kind::Arena },
    Game { id: "gomoku", name: "五子棋", kind: Kind::Duel },
    Game { id: "xiangqi", name: "象棋", kind: Kind::Duel },
    Game { id: "chess", name: "西洋棋", kind: Kind::Duel },
    Game { id: "reversi", name: "黑白棋", kind: Kind::Duel },
    Game { id: "connect4", name: "四子棋", kind: Kind::Duel },
    Game { id: "ab", name: "1A2B", kind: Kind::Duel },
    Game { id: "battleship", name: "海戰棋", kind: Kind::Duel },
];

const MAX_LOBBIES: usize = 200;
const MAX_MEMBERS: usize = 30;
/// 沒有人連線超過這麼久的遊戲室會被清掉
const EMPTY_TTL: Duration = Duration::from_secs(10 * 60);
/// 斷線超過這麼久就移出名單
const OFFLINE_TTL: Duration = Duration::from_secs(60);
const TICK: Duration = Duration::from_secs(5);
/// 開完一間房間後，這段時間內房主再按會被擋下（避免連點開出好幾間）
const PLAY_COOLDOWN: Duration = Duration::from_secs(2);
const CHAT_HISTORY: usize = 100;
const MSGS_PER_SEC: u32 = 10;
const MAX_FRAME_BYTES: usize = 2 * 1024;
const MAX_PLAYER_LEN: usize = 64;
const PING_INTERVAL: Duration = Duration::from_secs(25);
const IDLE_TIMEOUT: Duration = Duration::from_secs(60);

type Reject = (&'static str, &'static str);

const NOT_FOUND: Reject = ("not_found", "找不到這個遊戲室（可能已過期）");
const FULL: Reject = ("full", "遊戲室已滿");
const REPLACED: Reject = ("replaced", "你在其他分頁或裝置開啟了這個遊戲室");
const KICKED: Reject = ("kicked", "你被房主請出這個遊戲室了");

struct Conn {
    id: u64,
    tx: mpsc::UnboundedSender<Utf8Bytes>,
    /// 給系統管理看的：來源 IP 和連上的時間
    ip: String,
    since: Instant,
}

struct Member {
    pid: u32,
    /// `user:<id>` 或 `guest:<id>`，只用來認人，不能外流
    key: String,
    name: String,
    conn: Option<Conn>,
    offline_since: Option<Instant>,
    /// 選了觀戰：派對遊戲和大逃殺不上場，棋類不會被挑
    watch: bool,
}

/// 現在在玩的那一間
struct Playing {
    /// 每開一間加一，用戶端靠它分辨「新開的」
    id: u32,
    game: &'static Game,
    room: String,
    /// 棋類：上場的兩個人（照座位順序）；其他遊戲是 None（所有人）
    players: Option<Vec<u32>>,
}

/// 房主按下「開始玩」之後、房間開好之前要記住的東西
struct Plan {
    game: &'static Game,
    /// 新房間的房主順序：遊戲室的房主在最前面，其他人照名單
    hosts: Vec<String>,
    /// 選了觀戰的人（派對遊戲、大逃殺用）
    watchers: Vec<String>,
    /// 棋類：兩個座位的 `(pid, key)`
    seats: Option<[(u32, String); 2]>,
}

pub struct Lobbies {
    live: Mutex<HashMap<String, Arc<Mutex<Lobby>>>>,
    next_conn: AtomicU64,
}

impl Default for Lobbies {
    fn default() -> Self {
        Self { live: Mutex::default(), next_conn: AtomicU64::new(0) }
    }
}

struct Lobby {
    opened: Instant,
    /// 從表裡移除後設為 true，剛好拿到這個遊戲室的人要當作找不到
    closed: bool,
    members: Vec<Member>,
    next_pid: u32,
    next_line: u64,
    lines: VecDeque<Value>,
    banned: HashSet<String>,
    playing: Option<Playing>,
    next_play: u32,
    /// 正在開房間（棋類要寫資料庫），這段時間房主再按會被擋下
    opening: bool,
    last_play: Option<Instant>,
    dirty: bool,
    empty_since: Option<Instant>,
}

impl Lobby {
    fn new(now: Instant) -> Self {
        Self {
            opened: now,
            closed: false,
            members: Vec::new(),
            next_pid: 1,
            next_line: 1,
            lines: VecDeque::new(),
            banned: HashSet::new(),
            playing: None,
            next_play: 1,
            opening: false,
            last_play: None,
            dirty: true,
            empty_since: None,
        }
    }

    fn index(&self, pid: u32) -> Option<usize> {
        self.members.iter().position(|m| m.pid == pid)
    }

    /// 房主：最早進來、還連著的人
    fn host(&self) -> Option<u32> {
        self.members.iter().find(|m| m.conn.is_some()).map(|m| m.pid)
    }

    fn online(&self) -> usize {
        self.members.iter().filter(|m| m.conn.is_some()).count()
    }

    /// 同名的人後面加數字，房主挑人時才分得出誰是誰（和派對房間一樣）
    fn unique_name(&self, name: &str, except: Option<u32>) -> String {
        let taken = |candidate: &str| self.members.iter().any(|m| Some(m.pid) != except && m.name == candidate);
        if !taken(name) {
            return name.to_owned();
        }
        (2..)
            .map(|n| {
                let suffix = format!(" {n}");
                let keep = MAX_NAME_CHARS.saturating_sub(suffix.chars().count());
                format!("{}{suffix}", name.chars().take(keep).collect::<String>())
            })
            .find(|candidate| !taken(candidate))
            .expect("some suffix is free")
    }

    fn join(&mut self, key: &str, name: String, conn: Conn) -> Result<u32, Reject> {
        if self.banned.contains(key) {
            return Err(KICKED);
        }
        let i = match self.members.iter().position(|m| m.key == key) {
            Some(i) => i,
            None => {
                if self.members.len() >= MAX_MEMBERS {
                    return Err(FULL);
                }
                let pid = self.next_pid;
                self.next_pid += 1;
                let name = self.unique_name(&name, None);
                self.system(format!("{name} 進來了"));
                self.members.push(Member {
                    pid,
                    key: key.to_owned(),
                    name,
                    conn: None,
                    offline_since: None,
                    watch: false,
                });
                self.members.len() - 1
            }
        };
        let member = &mut self.members[i];
        if let Some(old) = member.conn.replace(conn) {
            // 舊連線收到這則錯誤後就不會再自動重連，兩邊才不會一直互踢
            let _ = old.tx.send(error_text(REPLACED));
        }
        member.offline_since = None;
        let pid = member.pid;
        // 順序：welcome → lobby（名單變了，所有人都要更新）→ 聊天紀錄
        self.send(i, &text(json!({ "type": "welcome", "you": pid })));
        self.dirty = true;
        self.flush();
        let lines: Vec<&Value> = self.lines.iter().collect();
        self.send(i, &text(json!({ "type": "chats", "lines": lines })));
        Ok(pid)
    }

    fn leave(&mut self, pid: u32, conn: u64, now: Instant) {
        let Some(i) = self.index(pid) else { return };
        if self.members[i].conn.as_ref().is_none_or(|c| c.id != conn) {
            return;
        }
        // 先留在名單上（`tick` 過一陣子才移出去），換頁、切到背景的短暫斷線回來還是同一個人
        self.members[i].conn = None;
        self.members[i].offline_since = Some(now);
        self.dirty = true;
        self.flush();
    }

    fn send(&self, i: usize, message: &Utf8Bytes) {
        if let Some(conn) = &self.members[i].conn {
            // 失敗表示那條連線正在關閉，忽略即可
            let _ = conn.tx.send(message.clone());
        }
    }

    fn broadcast(&self, message: &Utf8Bytes) {
        for i in 0..self.members.len() {
            self.send(i, message);
        }
    }

    fn notice(&self, pid: u32, message: &str) {
        if let Some(i) = self.index(pid) {
            self.send(i, &text(json!({ "type": "notice", "message": message })));
        }
    }

    fn post(&mut self, pid: Option<u32>, text_: String) {
        let name = pid.and_then(|pid| self.index(pid)).map(|i| self.members[i].name.clone());
        // 欄位和派對房間的聊天一樣，前端可以共用聊天室元件
        let line =
            json!({ "id": self.next_line, "pid": pid, "name": name, "text": text_, "tone": null, "private": false });
        self.next_line += 1;
        self.broadcast(&text(json!({ "type": "chat", "line": line })));
        self.lines.push_back(line);
        if self.lines.len() > CHAT_HISTORY {
            self.lines.pop_front();
        }
    }

    fn system(&mut self, text_: String) {
        self.post(None, text_);
    }

    fn lobby_text(&self) -> Utf8Bytes {
        let players: Vec<Value> = self
            .members
            .iter()
            .map(|m| json!({ "pid": m.pid, "name": m.name, "online": m.conn.is_some(), "watch": m.watch }))
            .collect();
        let playing = self
            .playing
            .as_ref()
            .map(|p| json!({ "id": p.id, "game": p.game.id, "room": p.room, "players": p.players }));
        text(json!({ "type": "lobby", "host": self.host(), "players": players, "playing": playing }))
    }

    fn flush(&mut self) {
        if self.dirty {
            self.dirty = false;
            self.broadcast(&self.lobby_text());
        }
    }

    fn rename(&mut self, pid: u32, raw: &str) -> Result<(), String> {
        let name = clean(raw, MAX_NAME_CHARS);
        if name.is_empty() {
            return Err("名字不能是空的".into());
        }
        let name = self.unique_name(&name, Some(pid));
        if let Some(i) = self.index(pid) {
            self.members[i].name = name;
            self.dirty = true;
        }
        Ok(())
    }

    /// 改選觀戰／上場；回傳要轉給正在玩的哪一間 `(遊戲, 房間, key)`（派對遊戲和大逃殺才要轉）
    fn set_watch(&mut self, pid: u32, watch: bool) -> Option<(&'static Game, String, String)> {
        let i = self.index(pid)?;
        if self.members[i].watch == watch {
            return None;
        }
        self.members[i].watch = watch;
        self.dirty = true;
        self.flush();
        let playing = self.playing.as_ref().filter(|p| p.game.kind != Kind::Duel)?;
        Some((playing.game, playing.room.clone(), self.members[i].key.clone()))
    }

    fn kick(&mut self, target: u32) {
        let Some(i) = self.index(target) else { return };
        let member = self.members.remove(i);
        self.banned.insert(member.key);
        // 連線拿掉（佇列關閉）之前先送出錯誤，用戶端收到後就不會再重連
        if let Some(conn) = member.conn {
            let _ = conn.tx.send(error_text(KICKED));
        }
        self.system(format!("{} 被請出遊戲室", member.name));
        self.dirty = true;
    }

    /// 房主選了遊戲：檢查完記下「正在開」，真的開房間（可能要等資料庫）在鎖外面做，開好再交給 `opened`
    fn prepare(&mut self, pid: u32, game: &str, players: Option<Vec<u32>>, now: Instant) -> Result<Plan, String> {
        if self.host() != Some(pid) {
            return Err("只有房主能選遊戲".into());
        }
        let game = GAMES.iter().find(|g| g.id == game).ok_or("遊戲室不能開這個遊戲")?;
        let seats = match game.kind {
            Kind::Duel => {
                let picked = players.unwrap_or_default();
                let [a, b] = picked[..] else { return Err("這是兩個人的遊戲，請挑兩個人上場".into()) };
                if a == b {
                    return Err("請挑兩個不同的人".into());
                }
                let key = |pid: u32| match self.members.iter().find(|m| m.pid == pid && m.conn.is_some()) {
                    None => Err("挑的人不在線上".to_owned()),
                    Some(m) if m.watch => Err(format!("{} 選了觀戰", m.name)),
                    Some(m) => Ok((pid, m.key.clone())),
                };
                Some([key(a)?, key(b)?])
            }
            Kind::Arena | Kind::Party => None,
        };
        if self.opening || self.last_play.is_some_and(|t| now.duration_since(t) < PLAY_COOLDOWN) {
            return Err("正在開房間，請稍等".into());
        }
        // 房主就是名單上第一個連著的人，照名單排房主自然在最前面
        let hosts = self.members.iter().filter(|m| m.conn.is_some()).map(|m| m.key.clone()).collect();
        // 斷線的人也算：一分鐘內回來，到了那邊一樣是觀戰
        let watchers = self.members.iter().filter(|m| m.watch).map(|m| m.key.clone()).collect();
        self.opening = true;
        Ok(Plan { game, hosts, watchers, seats })
    }

    /// 房間開好了（或失敗）：記下現在在玩哪一間，大家收到新的 `playing` 就會跳過去
    fn opened(&mut self, pid: u32, plan: Plan, result: Result<String, String>, now: Instant) {
        self.opening = false;
        let room = match result {
            Ok(room) => room,
            Err(message) => return self.notice(pid, &message),
        };
        self.last_play = Some(now);
        let host = self.index(pid).map(|i| self.members[i].name.clone()).unwrap_or_default();
        let players = plan.seats.map(|seats| seats.map(|(pid, _)| pid).to_vec());
        let announce = match &players {
            Some(pids) => {
                let names: Vec<String> = pids
                    .iter()
                    .map(|&p| self.index(p).map(|i| self.members[i].name.clone()).unwrap_or_default())
                    .collect();
                format!("{host} 開了「{}」：{}", plan.game.name, names.join(" 對 "))
            }
            None => format!("{host} 開了「{}」", plan.game.name),
        };
        self.playing = Some(Playing { id: self.next_play, game: plan.game, room, players });
        self.next_play += 1;
        self.system(announce);
        self.dirty = true;
        self.flush();
    }

    fn handle(&mut self, pid: u32, message: ClientMessage) {
        if self.index(pid).is_none() {
            return;
        }
        let host = self.host() == Some(pid);
        let result = match message {
            ClientMessage::Chat { text } => {
                let text = clean(&text, MAX_CHAT_CHARS);
                if !text.is_empty() {
                    self.post(Some(pid), text);
                }
                Ok(())
            }
            ClientMessage::Name { name } => self.rename(pid, &name),
            ClientMessage::Kick { pid: target } if host && target != pid => {
                self.kick(target);
                Ok(())
            }
            // 開房間要等資料庫，在 session 裡處理
            _ => Ok(()),
        };
        if let Err(message) = result {
            self.notice(pid, &message);
        }
        self.flush();
    }

    fn tick(&mut self, now: Instant) {
        let gone: Vec<usize> = (0..self.members.len())
            .filter(|&i| self.members[i].offline_since.is_some_and(|t| now.duration_since(t) >= OFFLINE_TTL))
            .collect();
        for &i in gone.iter().rev() {
            let member = self.members.remove(i);
            self.system(format!("{} 離開了", member.name));
            self.dirty = true;
        }
        if self.online() == 0 {
            self.empty_since.get_or_insert(now);
        } else {
            self.empty_since = None;
        }
        self.flush();
    }

    fn should_close(&self, now: Instant) -> bool {
        self.empty_since.is_some_and(|t| now.duration_since(t) >= EMPTY_TTL)
    }

    /// 給系統管理看的遊戲室狀態（game_monitor.rs）；`game` 是現在在玩的那款
    fn info(&self, code: String, now: Instant) -> RoomInfo {
        let host = self.host();
        let players = self
            .members
            .iter()
            .map(|m| {
                let conn = m.conn.as_ref().map(|c| (c.ip.as_str(), c.since));
                PlayerInfo::new(&m.key, m.name.clone(), conn, now).host(host == Some(m.pid))
            })
            .collect();
        RoomInfo {
            kind: "lobby",
            game: self.playing.as_ref().map_or("", |p| p.game.id),
            code,
            phase: if self.playing.is_some() { "playing" } else { "lobby" },
            round: self.next_play - 1,
            age_secs: now.duration_since(self.opened).as_secs(),
            bots: 0,
            public: false,
            events: None,
            alive: None,
            players,
        }
    }
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum ClientMessage {
    Chat {
        text: String,
    },
    Name {
        name: String,
    },
    Play {
        game: String,
        #[serde(default)]
        players: Option<Vec<u32>>,
    },
    Kick {
        pid: u32,
    },
    /// 選觀戰（true）或上場（false）
    Watch {
        watch: bool,
    },
}

impl Lobbies {
    fn open(self: &Arc<Self>) -> Result<String, AppError> {
        let mut live = self.live.lock().unwrap();
        if live.len() >= MAX_LOBBIES {
            return Err(AppError::ServiceUnavailable("目前遊戲室太多，請稍後再試"));
        }
        let code = loop {
            let code = random_code()?;
            if !live.contains_key(&code) {
                break code;
            }
        };
        let lobby = Arc::new(Mutex::new(Lobby::new(Instant::now())));
        live.insert(code.clone(), lobby.clone());
        tokio::spawn(run(self.clone(), code.clone(), lobby));
        Ok(code)
    }

    fn get(&self, code: &str) -> Option<Arc<Mutex<Lobby>>> {
        self.live.lock().unwrap().get(code).cloned()
    }

    /// 給系統管理看：所有開著的遊戲室
    pub(crate) fn snapshot(&self, now: Instant) -> Vec<RoomInfo> {
        let live: Vec<_> = self.live.lock().unwrap().iter().map(|(code, l)| (code.clone(), l.clone())).collect();
        live.into_iter()
            .filter_map(|(code, lobby)| {
                let lobby = lobby.lock().unwrap();
                (!lobby.closed).then(|| lobby.info(code, now))
            })
            .collect()
    }
}

/// 遊戲室的計時器：把斷線太久的人移出名單，沒人太久就收掉
async fn run(lobbies: Arc<Lobbies>, code: String, lobby: Arc<Mutex<Lobby>>) {
    let mut ticks = tokio::time::interval(TICK);
    ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        ticks.tick().await;
        let now = Instant::now();
        lobby.lock().unwrap().tick(now);
        let mut live = lobbies.live.lock().unwrap();
        let mut guard = lobby.lock().unwrap();
        if guard.should_close(now) {
            guard.closed = true;
            live.remove(&code);
            return;
        }
    }
}

/// 派對遊戲和大逃殺的房間表，遊戲室用同一套方法開房間、轉觀戰
trait RoomTable {
    fn open_for_lobby(&self, hosts: Vec<String>, watchers: Vec<String>) -> Result<String, AppError>;
    fn set_watch(&self, room: &str, key: &str, watch: bool);
}

impl<G: PartyGame> RoomTable for Arc<Parties<G>> {
    fn open_for_lobby(&self, hosts: Vec<String>, watchers: Vec<String>) -> Result<String, AppError> {
        self.open(hosts, watchers)
    }

    fn set_watch(&self, room: &str, key: &str, watch: bool) {
        Parties::set_watch(self, room, key, watch);
    }
}

impl<R: Rules> RoomTable for Arc<Arenas<R>> {
    fn open_for_lobby(&self, hosts: Vec<String>, watchers: Vec<String>) -> Result<String, AppError> {
        self.open(false, hosts, watchers)
    }

    fn set_watch(&self, room: &str, key: &str, watch: bool) {
        Arenas::set_watch(self, room, key, watch);
    }
}

/// `GAMES` 裡的派對遊戲和大逃殺對到 `AppState` 的哪一張房間表；棋類是 None
fn room_table<'a>(state: &'a AppState, game: &Game) -> Option<&'a dyn RoomTable> {
    Some(match game.id {
        "undercover" => &state.undercover,
        "bigtwo" => &state.bigtwo,
        "draw" => &state.draw,
        "antique" => &state.antique,
        "uno" => &state.uno,
        "justone" => &state.justone,
        "telephone" => &state.telephone,
        "poker" => &state.poker,
        "werewolf" => &state.werewolf,
        "chinesecheckers" => &state.chinesecheckers,
        "contact" => &state.contact,
        "liarsdice" => &state.liarsdice,
        "minesweeper" => &state.minesrace,
        "racing" => &state.racing,
        "tetris" => &state.tetris,
        "puyo" => &state.puyo,
        _ => return None,
    })
}

/// 照計畫開那款遊戲的房間
async fn open_room(state: &AppState, plan: &Plan) -> Result<String, AppError> {
    if plan.game.kind == Kind::Duel {
        let seats = plan.seats.clone().map(|[(_, a), (_, b)]| [Some(a), Some(b)]).unwrap_or_default();
        return state.rooms.create(&state.pool, plan.game.id, seats).await;
    }
    match room_table(state, plan.game) {
        Some(table) => table.open_for_lobby(plan.hosts.clone(), plan.watchers.clone()),
        None => Err(AppError::Internal(format!("lobby cannot open {}", plan.game.id))),
    }
}

/// 改選觀戰／上場，正在玩派對遊戲或大逃殺的話也轉過去（在遊戲室的鎖外面做）
fn watch(state: &AppState, lobby: &Mutex<Lobby>, pid: u32, watch: bool) {
    let forward = lobby.lock().unwrap().set_watch(pid, watch);
    if let Some((game, room, key)) = forward
        && let Some(table) = room_table(state, game)
    {
        table.set_watch(&room, &key, watch);
    }
}

async fn play(state: &AppState, lobby: &Mutex<Lobby>, pid: u32, game: &str, players: Option<Vec<u32>>) {
    let plan = {
        let mut guard = lobby.lock().unwrap();
        match guard.prepare(pid, game, players, Instant::now()) {
            Ok(plan) => plan,
            Err(message) => return guard.notice(pid, &message),
        }
    };
    let result = open_room(state, &plan).await.map_err(|err| match err {
        AppError::ServiceUnavailable(message) => message.to_owned(),
        err => {
            tracing::error!(game = plan.game.id, error = %err, "open room from lobby");
            "開房間失敗，請稍後再試".to_owned()
        }
    });
    lobby.lock().unwrap().opened(pid, plan, result, Instant::now());
}

pub async fn create(State(state): State<AppState>) -> Result<(StatusCode, Json<Value>), AppError> {
    let code = state.lobbies.open()?;
    Ok((StatusCode::CREATED, Json(json!({ "code": code }))))
}

#[derive(Deserialize)]
pub struct JoinQuery {
    player: Option<String>,
    name: Option<String>,
}

/// 認人的方式和派對房間一樣：登入的人用帳號（名字沒填就用帳號名稱），訪客用用戶端產生的 id。
/// 一律先升級再用 `{type:"error"}` 回報問題：瀏覽器的 WebSocket 讀不到升級失敗時的 HTTP 狀態。
pub async fn connect(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Path(code): Path<String>,
    Query(query): Query<JoinQuery>,
    headers: HeaderMap,
    user: Option<CurrentUser>,
) -> Response {
    let code = code.to_ascii_uppercase();
    let ip = client_key(&headers);
    let name = clean(query.name.as_deref().unwrap_or_default(), MAX_NAME_CHARS);
    let identity = match (user, query.player) {
        (Some(user), _) => {
            let name = if name.is_empty() { clean(&user.username, MAX_NAME_CHARS) } else { name };
            Some((format!("user:{}", user.id), name))
        }
        (None, Some(player)) if !player.is_empty() && player.chars().count() <= MAX_PLAYER_LEN => {
            let name = if name.is_empty() { "訪客".to_owned() } else { name };
            Some((format!("guest:{player}"), name))
        }
        _ => None,
    };
    ws.max_message_size(MAX_FRAME_BYTES).on_upgrade(move |socket| session(socket, state, code, identity, ip))
}

async fn session(mut socket: WebSocket, state: AppState, code: String, identity: Option<(String, String)>, ip: String) {
    let Some((key, name)) = identity else {
        return close_with(socket, ("bad_request", "缺少 player，或 player 太長")).await;
    };
    let (tx, mut rx) = mpsc::unbounded_channel();
    let lobbies = &state.lobbies;
    let id = lobbies.next_conn.fetch_add(1, Ordering::Relaxed) + 1;
    let Some(lobby) = lobbies.get(&code) else { return close_with(socket, NOT_FOUND).await };
    let joined = {
        let mut guard = lobby.lock().unwrap();
        let now = Instant::now();
        if guard.closed { Err(NOT_FOUND) } else { guard.join(&key, name, Conn { id, tx, ip, since: now }) }
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
                // 同一個人從別處連進來、被踢掉，或遊戲室被關掉
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
                if window.1 > MSGS_PER_SEC {
                    break Some(("rate_limited", "訊息送得太快了"));
                }
                match serde_json::from_str::<ClientMessage>(&text) {
                    Ok(ClientMessage::Play { game, players }) => play(&state, &lobby, pid, &game, players).await,
                    Ok(ClientMessage::Watch { watch: on }) => watch(&state, &lobby, pid, on),
                    Ok(message) => lobby.lock().unwrap().handle(pid, message),
                    Err(_) => {}
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
    lobby.lock().unwrap().leave(pid, id, Instant::now());
    match error {
        Some(reject) => close_with(socket, reject).await,
        None => {
            // 被取代、被踢時的錯誤已經從佇列送出了，這裡只要關閉
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
    // 等用戶端回應關閉，避免還沒讀完就被斷線而漏掉錯誤訊息
    let _ =
        tokio::time::timeout(Duration::from_secs(2), async { while let Some(Ok(_)) = socket.recv().await {} }).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Client {
        pid: u32,
        id: u64,
        rx: mpsc::UnboundedReceiver<Utf8Bytes>,
    }

    impl Client {
        fn drain(&mut self) -> Vec<Value> {
            let mut out = Vec::new();
            while let Ok(message) = self.rx.try_recv() {
                out.push(serde_json::from_str(&message).unwrap());
            }
            out
        }

        fn last(&mut self, kind: &str) -> Option<Value> {
            self.drain().into_iter().rev().find(|m| m["type"] == kind)
        }
    }

    fn join(lobby: &mut Lobby, key: &str, name: &str, id: u64) -> Client {
        let (tx, rx) = mpsc::unbounded_channel();
        let now = Instant::now();
        let pid = lobby.join(key, name.into(), Conn { id, tx, ip: "test".into(), since: now }).unwrap();
        Client { pid, id, rx }
    }

    fn play(lobby: &mut Lobby, pid: u32, game: &str, players: Option<Vec<u32>>) -> Result<Plan, String> {
        lobby.prepare(pid, game, players, Instant::now())
    }

    #[test]
    fn duel_games_are_relay_rooms() {
        for game in GAMES.iter().filter(|g| g.kind == Kind::Duel) {
            assert!(crate::games::GAMES.contains(&game.id), "{} is not a relay game", game.id);
        }
    }

    #[test]
    fn host_picks_a_game_and_everyone_hears_about_it() {
        let mut lobby = Lobby::new(Instant::now());
        let a = join(&mut lobby, "guest:a", "阿明", 1);
        let mut b = join(&mut lobby, "guest:b", "阿明", 2);
        let state = b.last("lobby").unwrap();
        assert_eq!(state["host"], a.pid);
        // 同名的人自動加數字
        assert_eq!(state["players"][1]["name"], "阿明 2");

        assert_eq!(play(&mut lobby, b.pid, "draw", None).err().unwrap(), "只有房主能選遊戲");
        assert!(play(&mut lobby, a.pid, "sudoku", None).is_err());

        let plan = play(&mut lobby, a.pid, "draw", None).unwrap();
        assert_eq!(plan.hosts, ["guest:a", "guest:b"]);
        // 還在開的時候再按會被擋下
        assert!(play(&mut lobby, a.pid, "bigtwo", None).is_err());
        lobby.opened(a.pid, plan, Ok("ROOM1".into()), Instant::now());

        let messages = b.drain();
        let state = messages.iter().rev().find(|m| m["type"] == "lobby").unwrap();
        assert_eq!(state["playing"], json!({ "id": 1, "game": "draw", "room": "ROOM1", "players": null }));
        let line = messages.iter().find(|m| m["type"] == "chat").unwrap();
        assert_eq!(line["line"]["text"], "阿明 開了「你畫我猜」");
        assert!(line["line"]["pid"].is_null());
    }

    #[test]
    fn duel_games_need_two_online_players() {
        let mut lobby = Lobby::new(Instant::now());
        let a = join(&mut lobby, "guest:a", "A", 1);
        let b = join(&mut lobby, "guest:b", "B", 2);
        let c = join(&mut lobby, "guest:c", "C", 3);

        assert!(play(&mut lobby, a.pid, "chess", None).is_err());
        assert!(play(&mut lobby, a.pid, "chess", Some(vec![a.pid])).is_err());
        assert!(play(&mut lobby, a.pid, "chess", Some(vec![b.pid, b.pid])).is_err());
        lobby.leave(c.pid, c.id, Instant::now());
        assert_eq!(play(&mut lobby, a.pid, "chess", Some(vec![b.pid, c.pid])).err().unwrap(), "挑的人不在線上");

        // 房主自己可以不上場；座位照挑的順序
        let plan = play(&mut lobby, a.pid, "chess", Some(vec![b.pid, a.pid])).unwrap();
        let keys = plan.seats.clone().unwrap().map(|(_, key)| key);
        assert_eq!(keys, ["guest:b".to_owned(), "guest:a".to_owned()]);
        lobby.opened(a.pid, plan, Ok("ROOM2".into()), Instant::now());
        assert_eq!(lobby.playing.as_ref().unwrap().players, Some(vec![b.pid, a.pid]));
        assert_eq!(lobby.lines.back().unwrap()["text"], "A 開了「西洋棋」：B 對 A");
    }

    #[test]
    fn watchers_go_along_without_playing() {
        let mut lobby = Lobby::new(Instant::now());
        let a = join(&mut lobby, "guest:a", "A", 1);
        let mut b = join(&mut lobby, "guest:b", "B", 2);
        let c = join(&mut lobby, "guest:c", "C", 3);

        // 房主自己選觀戰；大家看得到
        assert!(lobby.set_watch(a.pid, true).is_none(), "還沒在玩，不用轉");
        let state = b.last("lobby").unwrap();
        assert_eq!(state["players"][0]["watch"], true);
        assert_eq!(state["players"][1]["watch"], false);

        // 派對遊戲：選了觀戰的人交給新房間
        let plan = play(&mut lobby, a.pid, "uno", None).unwrap();
        assert_eq!(plan.watchers, ["guest:a"]);
        lobby.opened(a.pid, plan, Ok("ROOM1".into()), Instant::now());
        // 在玩的時候改選：要轉給那一間
        let (game, room, key) = lobby.set_watch(c.pid, true).unwrap();
        assert_eq!((game.id, room.as_str(), key.as_str()), ("uno", "ROOM1", "guest:c"));
        assert!(lobby.set_watch(c.pid, true).is_none(), "沒變就不轉");

        // 棋類：選了觀戰的人不能被挑上場，也不用轉
        assert_eq!(play(&mut lobby, a.pid, "chess", Some(vec![a.pid, b.pid])).err().unwrap(), "A 選了觀戰");
        lobby.last_play = None;
        let plan = play(&mut lobby, a.pid, "chess", Some(vec![b.pid, b.pid]));
        assert!(plan.is_err());
        lobby.set_watch(c.pid, false);
        let plan = play(&mut lobby, a.pid, "chess", Some(vec![b.pid, c.pid])).unwrap();
        lobby.opened(a.pid, plan, Ok("ROOM2".into()), Instant::now());
        assert!(lobby.set_watch(b.pid, true).is_none());
    }

    #[test]
    fn failed_open_only_tells_the_host() {
        let mut lobby = Lobby::new(Instant::now());
        let mut a = join(&mut lobby, "guest:a", "A", 1);
        let mut b = join(&mut lobby, "guest:b", "B", 2);
        a.drain();
        b.drain();
        let plan = play(&mut lobby, a.pid, "tetris", None).unwrap();
        lobby.opened(a.pid, plan, Err("目前房間太多".into()), Instant::now());
        assert_eq!(a.last("notice").unwrap()["message"], "目前房間太多");
        assert!(b.drain().is_empty());
        assert!(lobby.playing.is_none());
        assert!(!lobby.opening);
    }

    #[test]
    fn offline_members_stay_for_a_while() {
        let start = Instant::now();
        let mut lobby = Lobby::new(start);
        let a = join(&mut lobby, "guest:a", "A", 1);
        let mut b = join(&mut lobby, "guest:b", "B", 2);
        lobby.leave(a.pid, a.id, start);
        // 房主換成下一個人，A 還在名單上（離線）
        let state = b.last("lobby").unwrap();
        assert_eq!(state["host"], b.pid);
        assert_eq!(state["players"][0]["online"], false);

        // 回來還是同一個 pid，也拿回房主
        let a = join(&mut lobby, "guest:a", "A", 3);
        assert_eq!(lobby.host(), Some(a.pid));

        lobby.leave(a.pid, a.id, start);
        lobby.tick(start + OFFLINE_TTL);
        assert_eq!(lobby.members.len(), 1);
        assert_eq!(lobby.lines.back().unwrap()["text"], "A 離開了");

        lobby.leave(b.pid, b.id, start);
        lobby.tick(start + OFFLINE_TTL);
        assert!(!lobby.should_close(start + OFFLINE_TTL));
        assert!(lobby.should_close(start + OFFLINE_TTL + EMPTY_TTL));
    }

    #[test]
    fn host_can_kick() {
        let mut lobby = Lobby::new(Instant::now());
        let a = join(&mut lobby, "guest:a", "A", 1);
        let mut b = join(&mut lobby, "guest:b", "B", 2);
        lobby.handle(b.pid, ClientMessage::Kick { pid: a.pid });
        assert_eq!(lobby.members.len(), 2);
        lobby.handle(a.pid, ClientMessage::Kick { pid: b.pid });
        assert_eq!(lobby.members.len(), 1);
        assert_eq!(b.last("error").unwrap()["code"], "kicked");
        let (tx, _rx) = mpsc::unbounded_channel();
        let now = Instant::now();
        assert!(lobby.join("guest:b", "B".into(), Conn { id: 3, tx, ip: String::new(), since: now }).is_err());
    }
}
