//! 派對房間：伺服器握有完整的遊戲狀態，只把每個人「該看到的那一份」送給他。
//! 給「有隱藏資訊、3～10 人、回合制或計時」的遊戲用（誰是臥底、大老二、你畫我猜、踩地雷競速…）。
//!
//! 和另外兩種房間的差別：
//! - `games.rs`（棋類）只轉送、不懂規則，兩邊看得到所有訊息，做不了藏牌、藏詞。
//! - `arena.rs`（方塊大逃殺）的盤面在用戶端跑，伺服器只管攻擊和名次。
//! - 這裡規則全部在伺服器：用戶端只送「我想做什麼」（action），伺服器驗證後改狀態，
//!   再把每個座位各自的視角（view）送出去。別人的牌、別人的詞根本不會離開伺服器。
//!
//! 房間只放在記憶體：伺服器重啟或換版時，進行中的房間會消失（用戶端重連會收到 `not_found`）。
//! 協定見 `frontend/src/games/shared/useParty.ts`。
//!
//! # 房間怎麼運作
//! - 名單（members）：人照進來的順序排，電腦排在最後。房主是最早進來、還連著的人，房主離開就自動輪到下一個。
//! - 大廳（lobby）→ 對局（playing）→ 結算（results）→ 房主按「再來一局」又回到對局。
//!   結算時遊戲物件還留著（大家還看得到最後的畫面），下一局開局時交給新的一局（`previous`），可以累計分數。
//! - 開局時連著線的人加上電腦依名單順序入座（座位 0、1、2…），超過人數上限的人觀戰。
//!   對局中才進來的人也是觀戰，等下一局。
//! - 每個人可以自己選「觀戰」（`watch`）：開局時不入座，人數沒滿也一樣。記在 `watchers`（用 key 認人），
//!   不在名單上的時候（斷線、還沒連進來）也記得；遊戲室開房時會先把選了觀戰的人放進來，之後再改也會轉過來。
//! - 對局中斷線的人保留座位（其他人看得到「離線」），要怎麼處理（逾時自動行動、跳過）由遊戲決定。
//!   被房主踢掉的人不能再進這個房間；如果他在座位上，座位一樣保留到這局結束。
//! - 每個房間一個計時器（`PartyGame::TICK`）呼叫遊戲的 `tick`，推進倒數、回合逾時和電腦玩家。
//!
//! # 送出去的東西
//! - `view`：每個連線自己的視角。狀態有變（`Ctx::changed`）時，在處理完那則訊息或那個 tick 之後立刻重送；
//!   內容和上次送的一樣就不送。動作成功預設就算「有變」，只發即時事件的動作（例如筆畫）呼叫 `Ctx::quiet`。
//! - `event`：遊戲主動發的即時事件（`Ctx::emit`），不存起來；重連時靠 view 拿回完整畫面。
//! - `chat`：房間聊天。對局中（含結算）每則訊息都先交給遊戲的 `chat` 決定：照常廣播、只給部分人看，
//!   或吞掉另做處理（例如猜中答案時改發一則系統訊息）。遊戲也可以自己發系統訊息（`Ctx::system`）。
//!
//! # 新增一款遊戲
//! 1. 寫一個型別實作 [`PartyGame`]（參考 `undercover.rs`）：
//!    - `ID`、`MIN_PLAYERS`、`MAX_PLAYERS`、`MAX_BOTS`（0 表示不能加電腦），需要的話調整 `TICK`、
//!      `MSGS_PER_SEC`、`MAX_FRAME_BYTES`（例如畫畫要送很多筆畫）。
//!    - `Options`：房主可以調的選項（serde，`Default` 是預設值），`check_options` 驗證並修正，
//!      `can_start` 檢查「這些選項配這個人數能不能開」。
//!    - `Action`：玩家送來的動作（serde 的 tagged enum 最方便），格式不對的伺服器會直接回「看不懂」。
//!    - `start`、`act`、`tick`、`chat`、`presence`、`view`、`finished`。
//!      `act` 回 `Err(訊息)` 時只有送出的人會收到那則訊息（`notice`），狀態不要改。
//!    - 需要跨局累計分數就在 `start` 時把 `ctx.seats` 的 pid 記下來，下一局從 `previous` 用 pid 對回去。
//!    - 電腦玩家在 `tick` 裡照 `ctx.seats[seat].bot` 自己出手。
//! 2. `AppState` 加一個 `Arc<party::Parties<你的遊戲>>` 欄位，`PartyGame::rooms` 回傳它。
//! 3. `lib.rs` 掛兩條路由：
//!    `.route("/games/<ID>/party", post(party::create::<X>))`
//!    `.route("/games/<ID>/party/{code}/ws", get(party::connect::<X>))`
//! 4. 前端用 `useParty`（`frontend/src/games/shared/useParty.ts`）和 `Party.tsx` 的大廳、聊天元件，
//!    遊戲只要畫自己的 view、送自己的 action。
//! 5. 規則寫單元測試；房間本身的行為這個檔案的測試和 `tests/party.rs` 測過了。

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
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use tokio::{sync::mpsc, time::Instant};

pub use crate::arena::Rng;
use crate::{
    AppError, AppState,
    auth::{CurrentUser, client_key},
    game_monitor::{PlayerInfo, RoomInfo},
    games::random_code,
};

/// 每款遊戲不一樣的地方，說明見檔頭
pub trait PartyGame: Sized + Send + 'static {
    /// 網址上的遊戲 id：`/api/games/<ID>/party`
    const ID: &'static str;
    const MIN_PLAYERS: usize;
    /// 座位數上限（含電腦）；多出來的人觀戰
    const MAX_PLAYERS: usize;
    /// 最多幾個電腦玩家，0 表示這款不能加電腦
    const MAX_BOTS: usize = 0;
    /// 房間計時器的間隔（`tick` 多久呼叫一次）
    const TICK: Duration = Duration::from_millis(250);
    /// 每條連線每秒最多幾則訊息，超過就斷線
    const MSGS_PER_SEC: u32 = 20;
    /// 一則 WebSocket 訊息的上限（整個 JSON）
    const MAX_FRAME_BYTES: usize = 4 * 1024;

    /// 房主可以調的選項；`Default` 是新房間的預設值
    type Options: Serialize + DeserializeOwned + Default + Clone + Send;
    /// 玩家送來的動作
    type Action: DeserializeOwned;

    fn rooms(state: &AppState) -> &Arc<Parties<Self>>;

    /// 驗證房主送來的選項，可以順便修正（例如夾在範圍內）；`Err` 的訊息會顯示給房主
    fn check_options(options: Self::Options) -> Result<Self::Options, String> {
        Ok(options)
    }

    /// 開局前檢查：這些選項配上 `players` 個人能不能開（人數本身的上下限房間已經檢查過了）
    fn can_start(_options: &Self::Options, _players: usize) -> Result<(), String> {
        Ok(())
    }

    /// 開新的一局。`ctx.seats` 是這局的座位；`previous` 是上一局（結算完的或被中止的），可以拿來累計分數
    fn start(options: &Self::Options, previous: Option<&Self>, ctx: &mut Ctx) -> Self;

    /// 座位 `seat` 的動作；`Err` 只會告訴送出的人，狀態不要改
    fn act(&mut self, seat: usize, action: Self::Action, ctx: &mut Ctx) -> Result<(), String>;

    /// 每個 `TICK` 呼叫一次（只在對局中）：倒數、逾時、電腦玩家
    fn tick(&mut self, _ctx: &mut Ctx) {}

    /// 對局中（含結算）有人在聊天室說話。`seat` 是 None 表示觀戰的人。`text` 已經去掉控制字元、裁好長度。
    fn chat(&mut self, _seat: Option<usize>, _text: &str, _ctx: &mut Ctx) -> Chat {
        Chat::Show
    }

    /// 對局中有座位的人斷線或重新連上
    fn presence(&mut self, _seat: usize, _online: bool, _ctx: &mut Ctx) {}

    /// 座位 `seat` 看到的畫面；None 是觀戰的人。只放這個人該知道的東西。
    /// 倒數請用「還剩幾毫秒」（`now` 算），用戶端自己往下數。
    fn view(&self, seat: Option<usize>, now: Instant) -> Value;

    /// 這局結束了沒；變成 true 時房間進入結算
    fn finished(&self) -> bool;

    fn bot_name(n: usize) -> String {
        format!("電腦 {n}")
    }
}

/// 聊天訊息怎麼處理
pub enum Chat {
    /// 照常給所有人看
    Show,
    /// 只給這些人看（例如出局的人只能跟出局的人聊）
    Only(To),
    /// 不顯示（遊戲可以改用 `Ctx::system` 發別的訊息）
    Drop,
}

/// 事件和聊天訊息要給誰；「觀戰的人」是連著線、這局沒有座位的人
#[derive(Clone, Debug)]
pub enum To {
    /// 所有人（含觀戰）
    All,
    Seat(usize),
    /// 除了這個座位以外的所有人（含觀戰）
    Except(usize),
    Seats(Vec<usize>),
    /// 這些座位加上所有觀戰的人
    SeatsAndSpectators(Vec<usize>),
}

/// 座位上的人；`online` 是現在連著線（電腦永遠是 true）
#[derive(Clone, Debug)]
pub struct SeatInfo {
    /// 房間內公開的編號，跨局不變（同一個人重連也一樣）
    pub pid: u32,
    pub name: String,
    pub bot: bool,
    pub online: bool,
}

/// 遊戲在 `start`／`act`／`tick`／`chat`／`presence` 裡用來發訊息、標記狀態有變
pub struct Ctx<'a> {
    pub now: Instant,
    pub rng: &'a mut Rng,
    /// 這局的座位，索引就是 seat
    pub seats: &'a [SeatInfo],
    out: &'a mut Outbox,
}

impl Ctx<'_> {
    /// 狀態有變：處理完之後重送每個人的 view
    pub fn changed(&mut self) {
        self.out.changed = true;
    }

    /// 這次動作不用重送 view（只靠 `emit` 的即時事件，例如筆畫）；只對 `act` 有意義
    pub fn quiet(&mut self) {
        self.out.quiet = true;
    }

    /// 即時事件：`{ type: 'event', event }`，不存起來
    pub fn emit(&mut self, to: To, event: Value) {
        self.out.events.push((to, event));
    }

    /// 系統訊息（聊天室裡沒有發言人的那種）
    pub fn system(&mut self, to: To, text: impl Into<String>) {
        self.out.lines.push((to, Line { seat: None, text: text.into(), tone: None }));
    }

    /// 醒目的系統訊息，`tone` 是 `ok`／`danger`／`accent`，用戶端照這個上色
    pub fn announce(&mut self, to: To, text: impl Into<String>, tone: &'static str) {
        self.out.lines.push((to, Line { seat: None, text: text.into(), tone: Some(tone) }));
    }

    /// 用某個座位的名義發一則聊天訊息（例如電腦玩家在討論時說話，或把改寫過的話發出去）
    pub fn say(&mut self, to: To, seat: usize, text: impl Into<String>) {
        self.out.lines.push((to, Line { seat: Some(seat), text: text.into(), tone: None }));
    }
}

/// 給各遊戲的單元測試自己建 `Ctx`（不用開房間），發出去的東西留在 `out` 裡不會送
#[cfg(test)]
pub fn test_ctx<'a>(now: Instant, rng: &'a mut Rng, seats: &'a [SeatInfo], out: &'a mut Outbox) -> Ctx<'a> {
    Ctx { now, rng, seats, out }
}

#[cfg(test)]
impl Outbox {
    /// 給單元測試看遊戲發了哪些即時事件
    pub fn events(&self) -> &[(To, Value)] {
        &self.events
    }
}

/// 洗牌（Fisher–Yates）
pub fn shuffle<T>(rng: &mut Rng, items: &mut [T]) {
    for i in (1..items.len()).rev() {
        items.swap(i, rng.below(i + 1));
    }
}

const MAX_ROOMS: usize = 200;
/// 座位數之外還能進來觀戰的人
const MAX_SPECTATORS: usize = 10;
/// 沒有人連線超過這麼久的房間會被清掉（手機切到背景會斷線，留久一點讓大家回得來）
const EMPTY_TTL: Duration = Duration::from_secs(5 * 60);
pub const MAX_NAME_CHARS: usize = 12;
const MAX_PLAYER_LEN: usize = 64;
pub const MAX_CHAT_CHARS: usize = 200;
/// 聊天室保留最近幾則，重連時重送
const CHAT_HISTORY: usize = 100;
const PING_INTERVAL: Duration = Duration::from_secs(25);
const IDLE_TIMEOUT: Duration = Duration::from_secs(60);

type Reject = (&'static str, &'static str);

const NOT_FOUND: Reject = ("not_found", "找不到這個房間（可能已過期）");
const FULL: Reject = ("full", "房間已滿");
const REPLACED: Reject = ("replaced", "你在其他分頁或裝置開啟了這個房間");
const KICKED: Reject = ("kicked", "你被房主請出這個房間了");

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
enum Phase {
    Lobby,
    Playing,
    Results,
}

/// 遊戲在一次呼叫裡發出的東西，呼叫完由房間送出去
#[derive(Default)]
pub struct Outbox {
    events: Vec<(To, Value)>,
    lines: Vec<(To, Line)>,
    changed: bool,
    quiet: bool,
}

struct Line {
    seat: Option<usize>,
    text: String,
    tone: Option<&'static str>,
}

/// 存起來的聊天訊息；`audience` 是看得到的 pid，None 表示所有人（包含之後才進來的人）
struct StoredLine {
    json: Value,
    audience: Option<Vec<u32>>,
}

struct Conn {
    id: u64,
    tx: mpsc::UnboundedSender<Utf8Bytes>,
    /// 給系統管理看的：來源 IP 和連上的時間
    ip: String,
    since: Instant,
}

struct Member {
    pid: u32,
    /// `user:<id>` 或 `guest:<id>`；電腦是 None。只用來認人，不能外流
    key: Option<String>,
    name: String,
    conn: Option<Conn>,
    /// 上次送給這個連線的 view，一樣就不再送
    last_view: Option<Utf8Bytes>,
}

pub struct Parties<G: PartyGame> {
    live: Mutex<HashMap<String, Arc<Mutex<Room<G>>>>>,
    next_conn: AtomicU64,
}

impl<G: PartyGame> Default for Parties<G> {
    fn default() -> Self {
        Self { live: Mutex::default(), next_conn: AtomicU64::new(0) }
    }
}

struct Room<G: PartyGame> {
    /// 開房間的時間
    opened: Instant,
    /// 從表裡移除後設為 true，剛好拿到這個房間的人要當作找不到
    closed: bool,
    phase: Phase,
    /// 開過幾局
    round: u32,
    options: G::Options,
    members: Vec<Member>,
    /// 這局每個座位的 pid（只在對局和結算時有意義）
    seats: Vec<u32>,
    /// 對局中和結算時的這一局
    game: Option<G>,
    /// 被中止的那一局，下一局開局時交給遊戲
    previous: Option<G>,
    next_pid: u32,
    /// 電腦玩家的流水號，用來取名字
    next_bot: usize,
    next_line: u64,
    lines: VecDeque<StoredLine>,
    /// 被踢掉的人
    banned: HashSet<String>,
    /// 遊戲室開的房間：照遊戲室的順序決定房主（見 `host`），其他房間是空的
    hosts: Vec<String>,
    /// 選了觀戰的人（key），開局時不入座
    watchers: HashSet<String>,
    dirty_room: bool,
    dirty_views: bool,
    empty_since: Option<Instant>,
    rng: Rng,
}

impl<G: PartyGame> Room<G> {
    fn new() -> Self {
        Self {
            opened: Instant::now(),
            closed: false,
            phase: Phase::Lobby,
            round: 0,
            options: G::Options::default(),
            members: Vec::new(),
            seats: Vec::new(),
            game: None,
            previous: None,
            next_pid: 1,
            next_bot: 1,
            next_line: 1,
            lines: VecDeque::new(),
            banned: HashSet::new(),
            hosts: Vec::new(),
            watchers: HashSet::new(),
            dirty_room: true,
            dirty_views: false,
            empty_since: None,
            rng: Rng::new(),
        }
    }

    fn index(&self, pid: u32) -> Option<usize> {
        self.members.iter().position(|m| m.pid == pid)
    }

    /// 房主：還連著的人裡，排在 `hosts`（遊戲室的順序）最前面的；都不在裡面就是最早進來的
    fn host(&self) -> Option<u32> {
        let rank = |m: &Member| m.key.as_ref().and_then(|k| self.hosts.iter().position(|h| h == k));
        self.members.iter().filter(|m| m.conn.is_some()).min_by_key(|m| rank(m).unwrap_or(usize::MAX)).map(|m| m.pid)
    }

    fn online_humans(&self) -> usize {
        self.members.iter().filter(|m| m.conn.is_some()).count()
    }

    /// 這個人選了觀戰
    fn watching(&self, m: &Member) -> bool {
        m.key.as_ref().is_some_and(|k| self.watchers.contains(k))
    }

    /// 開局時會入座的人：電腦，和連著線、沒選觀戰的人
    fn ready(&self, m: &Member) -> bool {
        m.key.is_none() || (m.conn.is_some() && !self.watching(m))
    }

    fn humans(&self) -> usize {
        self.members.iter().filter(|m| m.key.is_some()).count()
    }

    fn bots(&self) -> usize {
        self.members.iter().filter(|m| m.key.is_none()).count()
    }

    /// 這局的座位；沒有在對局（大廳）時誰都沒有座位
    fn seat_of(&self, pid: u32) -> Option<usize> {
        self.game.as_ref()?;
        self.seats.iter().position(|&p| p == pid)
    }

    fn seat_infos(&self) -> Vec<SeatInfo> {
        self.seats
            .iter()
            .map(|&pid| match self.index(pid) {
                Some(i) => {
                    let m = &self.members[i];
                    SeatInfo {
                        pid,
                        name: m.name.clone(),
                        bot: m.key.is_none(),
                        online: m.key.is_none() || m.conn.is_some(),
                    }
                }
                // 座位上的人會留在名單裡到這局結束，照理不會走到這裡
                None => SeatInfo { pid, name: "（已離開）".into(), bot: false, online: false },
            })
            .collect()
    }

    /// 同名的人後面加數字，投票、發言時才分得出誰是誰
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

    fn join(&mut self, key: &str, name: String, conn: Conn, now: Instant) -> Result<u32, Reject> {
        if self.banned.contains(key) {
            return Err(KICKED);
        }
        let i = match self.members.iter().position(|m| m.key.as_deref() == Some(key)) {
            Some(i) => i,
            None => {
                if self.humans() >= G::MAX_PLAYERS + MAX_SPECTATORS {
                    return Err(FULL);
                }
                let pid = self.next_pid;
                self.next_pid += 1;
                let name = self.unique_name(&name, None);
                let member = Member { pid, key: Some(key.to_owned()), name, conn: None, last_view: None };
                // 人排在電腦前面，房主和入座順序才會以人為主
                let at = self.members.iter().position(|m| m.key.is_none()).unwrap_or(self.members.len());
                self.members.insert(at, member);
                at
            }
        };
        let member = &mut self.members[i];
        let was_online = member.conn.is_some();
        if let Some(old) = member.conn.replace(conn) {
            // 舊連線收到這則錯誤後就不會再自動重連，兩邊才不會一直互踢
            let _ = old.tx.send(error_text(REPLACED));
        }
        member.last_view = None;
        let pid = member.pid;
        // 順序：welcome → room（名單變了，所有人都要更新）→ 看得到的聊天紀錄 → 自己的 view
        self.send(i, &text(json!({ "type": "welcome", "you": pid })));
        self.dirty_room = false;
        self.broadcast(&self.room_text());
        let lines: Vec<&Value> = self
            .lines
            .iter()
            .filter(|l| l.audience.as_ref().is_none_or(|a| a.contains(&pid)))
            .map(|l| &l.json)
            .collect();
        self.send(i, &text(json!({ "type": "chats", "lines": lines })));
        self.send_view(i, now);
        if !was_online && let Some(seat) = self.seat_of(pid) {
            self.presence(seat, true, now);
        }
        self.flush(now);
        Ok(pid)
    }

    fn leave(&mut self, pid: u32, conn: u64, now: Instant) {
        let Some(i) = self.index(pid) else { return };
        if self.members[i].conn.as_ref().is_none_or(|c| c.id != conn) {
            return;
        }
        self.members[i].conn = None;
        self.dirty_room = true;
        match self.seat_of(pid) {
            // 這局有座位的人留著，其他人（大廳裡的、觀戰的）直接移出名單
            Some(seat) => self.presence(seat, false, now),
            None => {
                self.members.remove(i);
            }
        }
        self.flush(now);
    }

    fn presence(&mut self, seat: usize, online: bool, now: Instant) {
        if self.phase != Phase::Playing {
            return;
        }
        let seats = self.seat_infos();
        let mut out = Outbox::default();
        if let Some(game) = self.game.as_mut() {
            let mut ctx = Ctx { now, rng: &mut self.rng, seats: &seats, out: &mut out };
            game.presence(seat, online, &mut ctx);
        }
        self.deliver(out);
        self.check_finished();
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

    /// 名單裡符合 `to` 的人（索引）
    fn audience(&self, to: &To) -> Vec<usize> {
        (0..self.members.len())
            .filter(|&i| {
                let seat = self.seat_of(self.members[i].pid);
                match to {
                    To::All => true,
                    To::Seat(s) => seat == Some(*s),
                    To::Except(s) => seat != Some(*s),
                    To::Seats(list) => seat.is_some_and(|s| list.contains(&s)),
                    To::SeatsAndSpectators(list) => seat.is_none_or(|s| list.contains(&s)),
                }
            })
            .collect()
    }

    fn room_text(&self) -> Utf8Bytes {
        let host = self.host();
        let players: Vec<Value> = self
            .members
            .iter()
            .map(|m| {
                json!({
                    "pid": m.pid,
                    "name": m.name,
                    "bot": m.key.is_none(),
                    "online": m.key.is_none() || m.conn.is_some(),
                    "seat": self.seat_of(m.pid),
                    "watching": self.watching(m),
                })
            })
            .collect();
        text(json!({
            "type": "room",
            "phase": self.phase,
            "round": self.round,
            "host": host,
            "options": self.options,
            "min": G::MIN_PLAYERS,
            "max": G::MAX_PLAYERS,
            "maxBots": G::MAX_BOTS,
            "players": players,
        }))
    }

    fn view_text(&self, i: usize, now: Instant) -> Utf8Bytes {
        let seat = self.seat_of(self.members[i].pid);
        let view = self.game.as_ref().map(|g| g.view(seat, now));
        text(json!({ "type": "view", "view": view }))
    }

    fn send_view(&mut self, i: usize, now: Instant) {
        if self.members[i].conn.is_none() {
            return;
        }
        let message = self.view_text(i, now);
        if self.members[i].last_view.as_ref() != Some(&message) {
            self.send(i, &message);
            self.members[i].last_view = Some(message);
        }
    }

    /// 把累積的變化送出去：名單或狀態有變就重送 room，view 有變就重送每個人的 view
    fn flush(&mut self, now: Instant) {
        if self.dirty_room {
            self.dirty_room = false;
            self.broadcast(&self.room_text());
        }
        if self.dirty_views {
            self.dirty_views = false;
            for i in 0..self.members.len() {
                self.send_view(i, now);
            }
        }
    }

    /// 送出遊戲在這次呼叫裡發的事件和聊天訊息
    fn deliver(&mut self, out: Outbox) {
        if out.changed {
            self.dirty_views = true;
        }
        for (to, event) in out.events {
            let message = text(json!({ "type": "event", "event": event }));
            for i in self.audience(&to) {
                self.send(i, &message);
            }
        }
        for (to, line) in out.lines {
            let pid = line.seat.and_then(|s| self.seats.get(s).copied());
            self.post(to, pid, line.text, line.tone);
        }
    }

    /// 存一則聊天訊息並送給看得到的人
    fn post(&mut self, to: To, pid: Option<u32>, text_: String, tone: Option<&'static str>) {
        let name = pid.and_then(|p| self.index(p)).map(|i| self.members[i].name.clone());
        let audience = match to {
            To::All => None,
            _ => Some(self.audience(&to).into_iter().map(|i| self.members[i].pid).collect::<Vec<u32>>()),
        };
        let id = self.next_line;
        self.next_line += 1;
        let json = json!({
            "id": id,
            "pid": pid,
            "name": name,
            "text": text_,
            "tone": tone,
            "private": audience.is_some(),
        });
        let message = text(json!({ "type": "chat", "line": json }));
        for i in 0..self.members.len() {
            if audience.as_ref().is_none_or(|a| a.contains(&self.members[i].pid)) {
                self.send(i, &message);
            }
        }
        self.lines.push_back(StoredLine { json, audience });
        if self.lines.len() > CHAT_HISTORY {
            self.lines.pop_front();
        }
    }

    fn check_finished(&mut self) {
        if self.phase == Phase::Playing && self.game.as_ref().is_some_and(|g| g.finished()) {
            self.phase = Phase::Results;
            self.dirty_room = true;
            self.dirty_views = true;
        }
    }

    /// 不在座位上又斷線的人移出名單（開局、中止時用：上一局保留的座位不用再留）
    fn drop_offline(&mut self) {
        let seated: Vec<u32> = if self.game.is_some() { self.seats.clone() } else { Vec::new() };
        self.members.retain(|m| m.key.is_none() || m.conn.is_some() || seated.contains(&m.pid));
    }

    fn start(&mut self, now: Instant) -> Result<(), String> {
        if self.phase == Phase::Playing {
            return Err("對局進行中".into());
        }
        // 斷線的人（上一局留著座位的）和選了觀戰的人不算；先檢查完再動名單，沒開成時結算畫面還在
        let ready = self.members.iter().filter(|m| self.ready(m)).count();
        let count = ready.min(G::MAX_PLAYERS);
        if count < G::MIN_PLAYERS {
            return Err(if G::MAX_BOTS > 0 {
                format!("至少要 {} 人才能開始，可以加電腦玩家", G::MIN_PLAYERS)
            } else {
                format!("至少要 {} 人才能開始", G::MIN_PLAYERS)
            });
        }
        G::can_start(&self.options, count)?;
        let previous = self.game.take().or_else(|| self.previous.take());
        self.drop_offline();
        // 名單是人在前、電腦在後，超過座位數的人觀戰
        self.seats = self.members.iter().filter(|m| self.ready(m)).take(count).map(|m| m.pid).collect();
        let seats = self.seat_infos();
        let mut out = Outbox::default();
        let game = {
            let mut ctx = Ctx { now, rng: &mut self.rng, seats: &seats, out: &mut out };
            G::start(&self.options, previous.as_ref(), &mut ctx)
        };
        self.game = Some(game);
        self.phase = Phase::Playing;
        self.round += 1;
        self.dirty_room = true;
        self.dirty_views = true;
        self.deliver(out);
        self.check_finished();
        Ok(())
    }

    fn abort(&mut self) {
        self.previous = self.game.take();
        self.phase = Phase::Lobby;
        self.seats.clear();
        self.drop_offline();
        self.dirty_room = true;
        self.dirty_views = true;
    }

    fn act(&mut self, pid: u32, action: Value, now: Instant) -> Result<(), String> {
        if self.phase != Phase::Playing {
            return Err("現在沒有在對局".into());
        }
        let Some(seat) = self.seat_of(pid) else { return Err("你在觀戰，下一局才能參加".into()) };
        let action: G::Action = serde_json::from_value(action).map_err(|_| "看不懂這個動作".to_string())?;
        let seats = self.seat_infos();
        let mut out = Outbox::default();
        let result = match self.game.as_mut() {
            Some(game) => {
                let mut ctx = Ctx { now, rng: &mut self.rng, seats: &seats, out: &mut out };
                game.act(seat, action, &mut ctx)
            }
            None => Ok(()),
        };
        if result.is_ok() && !out.quiet {
            out.changed = true;
        }
        self.deliver(out);
        self.check_finished();
        result
    }

    fn chat(&mut self, pid: u32, raw: &str, now: Instant) {
        let text_ = clean(raw, MAX_CHAT_CHARS);
        if text_.is_empty() {
            return;
        }
        let seat = self.seat_of(pid);
        let seats = self.seat_infos();
        let mut out = Outbox::default();
        let outcome = match self.game.as_mut() {
            Some(game) => {
                let mut ctx = Ctx { now, rng: &mut self.rng, seats: &seats, out: &mut out };
                game.chat(seat, &text_, &mut ctx)
            }
            None => Chat::Show,
        };
        // 先放玩家自己的話，再放遊戲因為這句話發的訊息（例如「某某猜對了」）
        match outcome {
            Chat::Show => self.post(To::All, Some(pid), text_, None),
            Chat::Only(to) => self.post(to, Some(pid), text_, None),
            Chat::Drop => {}
        }
        self.deliver(out);
        self.check_finished();
    }

    fn rename(&mut self, pid: u32, raw: &str) -> Result<(), String> {
        if self.phase == Phase::Playing && self.seat_of(pid).is_some() {
            return Err("對局中不能改名字".into());
        }
        let name = clean(raw, MAX_NAME_CHARS);
        if name.is_empty() {
            return Err("名字不能是空的".into());
        }
        let name = self.unique_name(&name, Some(pid));
        if let Some(i) = self.index(pid) {
            self.members[i].name = name;
            self.dirty_room = true;
        }
        Ok(())
    }

    fn add_bot(&mut self) -> Result<(), String> {
        if G::MAX_BOTS == 0 {
            return Err("這個遊戲不能加電腦玩家".into());
        }
        if self.bots() >= G::MAX_BOTS {
            return Err(format!("最多 {} 個電腦玩家", G::MAX_BOTS));
        }
        if self.members.iter().filter(|m| self.ready(m)).count() >= G::MAX_PLAYERS {
            return Err("座位已經滿了".into());
        }
        let pid = self.next_pid;
        self.next_pid += 1;
        let name = self.unique_name(&G::bot_name(self.next_bot), None);
        self.next_bot += 1;
        self.members.push(Member { pid, key: None, name, conn: None, last_view: None });
        self.dirty_room = true;
        Ok(())
    }

    fn kick(&mut self, target: u32, now: Instant) -> Result<(), String> {
        let Some(i) = self.index(target) else { return Ok(()) };
        let seated = self.seat_of(target);
        if self.members[i].key.is_none() {
            if self.phase == Phase::Playing && seated.is_some() {
                return Err("對局中不能移除座位上的電腦".into());
            }
            self.members.remove(i);
            self.dirty_room = true;
            return Ok(());
        }
        let member = &mut self.members[i];
        if let Some(key) = &member.key {
            self.banned.insert(key.clone());
        }
        // 連線拿掉（佇列關閉）之前先送出錯誤，用戶端收到後就不會再重連
        if let Some(conn) = member.conn.take() {
            let _ = conn.tx.send(error_text(KICKED));
        }
        self.dirty_room = true;
        match seated {
            // 座位保留到這局結束（遊戲當他斷線處理）；結算時就不用留了
            Some(seat) if self.phase == Phase::Playing => self.presence(seat, false, now),
            Some(_) => {}
            None => {
                self.members.remove(i);
            }
        }
        Ok(())
    }

    /// 處理用戶端的一則訊息；不是房主卻送房主的操作、或格式不對的直接忽略
    fn handle(&mut self, pid: u32, message: ClientMessage, now: Instant) {
        if self.index(pid).is_none() {
            return;
        }
        let host = self.host() == Some(pid);
        let idle = self.phase != Phase::Playing;
        let result = match message {
            ClientMessage::Action { action } => self.act(pid, action, now),
            ClientMessage::Chat { text } => {
                self.chat(pid, &text, now);
                Ok(())
            }
            ClientMessage::Name { name } => self.rename(pid, &name),
            ClientMessage::Watch { watch } => {
                if let Some(key) = self.index(pid).and_then(|i| self.members[i].key.clone()) {
                    self.set_watch(key, watch);
                }
                Ok(())
            }
            ClientMessage::Start if host => self.start(now),
            ClientMessage::Options { options } if host && idle => serde_json::from_value(options)
                .map_err(|_| "選項格式不對".to_string())
                .and_then(G::check_options)
                .map(|options| {
                    self.options = options;
                    self.dirty_room = true;
                }),
            ClientMessage::AddBot { count } if host && idle => {
                // 一次加好幾台（大房間「補滿電腦」）：加到滿或加不了為止，第一台就加不了才回錯誤
                let result = self.add_bot();
                if result.is_ok() {
                    for _ in 1..count.unwrap_or(1).min(G::MAX_BOTS) {
                        if self.add_bot().is_err() {
                            break;
                        }
                    }
                }
                result
            }
            ClientMessage::Kick { pid: target } if host && target != pid => self.kick(target, now),
            ClientMessage::Abort if host && self.phase == Phase::Playing => {
                self.abort();
                Ok(())
            }
            _ => Ok(()),
        };
        if let Err(message) = result
            && let Some(i) = self.index(pid)
        {
            self.send(i, &text(json!({ "type": "notice", "message": message })));
        }
        self.flush(now);
    }

    /// 選觀戰或上場：下一局開局時才生效，這局有座位的人照樣打完
    fn set_watch(&mut self, key: String, watch: bool) {
        let changed = if watch { self.watchers.insert(key) } else { self.watchers.remove(&key) };
        if changed {
            self.dirty_room = true;
        }
    }

    fn tick(&mut self, now: Instant) {
        if self.online_humans() == 0 {
            self.empty_since.get_or_insert(now);
        } else {
            self.empty_since = None;
        }
        if self.phase == Phase::Playing {
            let seats = self.seat_infos();
            let mut out = Outbox::default();
            if let Some(game) = self.game.as_mut() {
                let mut ctx = Ctx { now, rng: &mut self.rng, seats: &seats, out: &mut out };
                game.tick(&mut ctx);
            }
            self.deliver(out);
            self.check_finished();
        }
        self.flush(now);
    }

    fn should_close(&self, now: Instant) -> bool {
        self.empty_since.is_some_and(|t| now.duration_since(t) >= EMPTY_TTL)
    }

    /// 給系統管理看的房間狀態（game_monitor.rs）
    fn info(&self, code: String, now: Instant) -> RoomInfo {
        let host = self.host();
        let players = self
            .members
            .iter()
            .filter_map(|m| {
                let conn = m.conn.as_ref().map(|c| (c.ip.as_str(), c.since));
                let status = match self.seat_of(m.pid) {
                    Some(seat) => format!("座位 {}", seat + 1),
                    None if self.phase != Phase::Lobby || self.watching(m) => "觀戰".to_owned(),
                    None => String::new(),
                };
                Some(
                    PlayerInfo::new(m.key.as_ref()?, m.name.clone(), conn, now)
                        .host(host == Some(m.pid))
                        .status(status),
                )
            })
            .collect();
        RoomInfo {
            kind: "party",
            game: G::ID,
            code,
            phase: match self.phase {
                Phase::Lobby => "lobby",
                Phase::Playing => "playing",
                Phase::Results => "results",
            },
            round: self.round,
            age_secs: now.duration_since(self.opened).as_secs(),
            bots: self.bots(),
            public: false,
            events: None,
            alive: None,
            players,
        }
    }
}

/// 去掉控制字元（換行也算）和頭尾空白，最多 `max` 個字
pub fn clean(raw: &str, max: usize) -> String {
    raw.chars().map(|c| if c.is_control() { ' ' } else { c }).take(max).collect::<String>().trim().to_owned()
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum ClientMessage {
    Action {
        #[serde(default)]
        action: Value,
    },
    Chat {
        text: String,
    },
    Name {
        name: String,
    },
    /// 選觀戰（true）或上場（false）
    Watch {
        watch: bool,
    },
    Start,
    Options {
        options: Value,
    },
    /// 加電腦玩家：`count` 台（沒填是 1 台），座位或電腦數滿了就停
    AddBot {
        #[serde(default)]
        count: Option<usize>,
    },
    Kick {
        pid: u32,
    },
    Abort,
}

impl<G: PartyGame> Parties<G> {
    /// 開一間新房間；`hosts` 是遊戲室替大家開房時的房主順序（`user:<id>`／`guest:<id>`），
    /// `watchers` 是遊戲室裡選了觀戰的人，自己開的房間兩個都是空的
    pub(crate) fn open(self: &Arc<Self>, hosts: Vec<String>, watchers: Vec<String>) -> Result<String, AppError> {
        let mut live = self.live.lock().unwrap();
        if live.len() >= MAX_ROOMS {
            return Err(AppError::ServiceUnavailable("目前房間太多，請稍後再試"));
        }
        let code = loop {
            let code = random_code()?;
            if !live.contains_key(&code) {
                break code;
            }
        };
        let mut room = Room::<G>::new();
        room.hosts = hosts;
        room.watchers = watchers.into_iter().collect();
        let room = Arc::new(Mutex::new(room));
        live.insert(code.clone(), room.clone());
        tokio::spawn(run(self.clone(), code.clone(), room));
        Ok(code)
    }

    fn get(&self, code: &str) -> Option<Arc<Mutex<Room<G>>>> {
        self.live.lock().unwrap().get(code).cloned()
    }

    /// 遊戲室裡有人改選觀戰／上場：轉給遊戲室開的這間房間（`key` 不一定已經連進來）
    pub(crate) fn set_watch(&self, code: &str, key: &str, watch: bool) {
        let Some(room) = self.get(code) else { return };
        let mut room = room.lock().unwrap();
        if !room.closed {
            room.set_watch(key.to_owned(), watch);
            room.flush(Instant::now());
        }
    }

    /// 給系統管理看：所有開著的房間
    pub(crate) fn snapshot(&self, now: Instant) -> Vec<RoomInfo> {
        let live: Vec<_> = self.live.lock().unwrap().iter().map(|(code, r)| (code.clone(), r.clone())).collect();
        live.into_iter()
            .filter_map(|(code, room)| {
                let room = room.lock().unwrap();
                (!room.closed).then(|| room.info(code, now))
            })
            .collect()
    }
}

/// 房間的計時器：推進遊戲，沒人太久就把房間收掉
async fn run<G: PartyGame>(parties: Arc<Parties<G>>, code: String, room: Arc<Mutex<Room<G>>>) {
    let mut ticks = tokio::time::interval(G::TICK);
    ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        ticks.tick().await;
        let now = Instant::now();
        room.lock().unwrap().tick(now);
        let mut live = parties.live.lock().unwrap();
        let mut guard = room.lock().unwrap();
        if guard.should_close(now) {
            guard.closed = true;
            live.remove(&code);
            return;
        }
    }
}

pub async fn create<G: PartyGame>(State(state): State<AppState>) -> Result<(StatusCode, Json<Value>), AppError> {
    let code = G::rooms(&state).open(Vec::new(), Vec::new())?;
    Ok((StatusCode::CREATED, Json(json!({ "code": code }))))
}

#[derive(Deserialize)]
pub struct JoinQuery {
    player: Option<String>,
    name: Option<String>,
}

/// 登入的人用帳號認人（換分頁、換裝置也回得到座位），名字沒填就用帳號名稱；
/// 訪客用用戶端產生的 id。兩者加上不同前綴，訪客不能冒用帳號的座位（見 games.rs 的 connect）。
/// 一律先升級再用 `{type:"error"}` 回報問題：瀏覽器的 WebSocket 讀不到升級失敗時的 HTTP 狀態。
pub async fn connect<G: PartyGame>(
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
    ws.max_message_size(G::MAX_FRAME_BYTES).on_upgrade(move |socket| session::<G>(socket, state, code, identity, ip))
}

async fn session<G: PartyGame>(
    mut socket: WebSocket,
    state: AppState,
    code: String,
    identity: Option<(String, String)>,
    ip: String,
) {
    let Some((key, name)) = identity else {
        return close_with(socket, ("bad_request", "缺少 player，或 player 太長")).await;
    };
    let (tx, mut rx) = mpsc::unbounded_channel();
    let parties = G::rooms(&state);
    let id = parties.next_conn.fetch_add(1, Ordering::Relaxed) + 1;
    let Some(room) = parties.get(&code) else { return close_with(socket, NOT_FOUND).await };
    let joined = {
        let mut guard = room.lock().unwrap();
        let now = Instant::now();
        if guard.closed { Err(NOT_FOUND) } else { guard.join(&key, name, Conn { id, tx, ip, since: now }, now) }
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
                // 同一個人從別處連進來、被踢掉，或房間被關掉
                None => break None,
            },
            incoming = socket.recv() => {
                // 超過 MAX_FRAME_BYTES 的訊息在這裡就會是錯誤，直接斷線
                let Some(Ok(message)) = incoming else { break None };
                last_seen = Instant::now();
                let Message::Text(text) = message else { continue };
                let now = Instant::now();
                if now.duration_since(window.0) >= Duration::from_secs(1) {
                    window = (now, 0);
                }
                window.1 += 1;
                if window.1 > G::MSGS_PER_SEC {
                    break Some(("rate_limited", "訊息送得太快了"));
                }
                if let Ok(message) = serde_json::from_str::<ClientMessage>(&text) {
                    room.lock().unwrap().handle(pid, message, now);
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
    room.lock().unwrap().leave(pid, id, Instant::now());
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

    /// 測試用的小遊戲：每個人拿到一個祕密數字（只有自己看得到），輪流「猜」，
    /// 有人送 `win` 就結束。聊天裡說 `secret` 的話只給自己看，說 `hide` 的話不顯示並改發系統訊息。
    struct Secret {
        secrets: Vec<u32>,
        pids: Vec<u32>,
        turn: usize,
        done: bool,
        online: Vec<bool>,
        wins: HashMap<u32, u32>,
    }

    #[derive(Serialize, Deserialize, Default, Clone)]
    struct SecretOptions {
        #[serde(default)]
        limit: u32,
    }

    #[derive(Deserialize)]
    #[serde(tag = "type", rename_all = "lowercase")]
    enum SecretAction {
        Pass,
        Win,
        Ping,
    }

    impl PartyGame for Secret {
        const ID: &'static str = "secret";
        const MIN_PLAYERS: usize = 2;
        const MAX_PLAYERS: usize = 3;
        const MAX_BOTS: usize = 2;
        type Options = SecretOptions;
        type Action = SecretAction;

        fn rooms(_state: &AppState) -> &Arc<Parties<Self>> {
            unimplemented!("unit tests drive Room directly")
        }

        fn check_options(options: SecretOptions) -> Result<SecretOptions, String> {
            if options.limit > 9 { Err("太大了".into()) } else { Ok(options) }
        }

        fn can_start(options: &SecretOptions, players: usize) -> Result<(), String> {
            if options.limit == 1 && players > 2 { Err("限制 1 只能兩個人".into()) } else { Ok(()) }
        }

        fn start(_options: &SecretOptions, previous: Option<&Self>, ctx: &mut Ctx) -> Self {
            ctx.system(To::All, "開始了");
            Self {
                secrets: (0..ctx.seats.len() as u32).map(|s| 100 + s).collect(),
                pids: ctx.seats.iter().map(|s| s.pid).collect(),
                turn: 0,
                done: false,
                online: ctx.seats.iter().map(|s| s.online).collect(),
                wins: previous.map(|p| p.wins.clone()).unwrap_or_default(),
            }
        }

        fn act(&mut self, seat: usize, action: SecretAction, ctx: &mut Ctx) -> Result<(), String> {
            match action {
                SecretAction::Ping => {
                    ctx.quiet();
                    ctx.emit(To::Except(seat), json!({ "ping": seat }));
                    Ok(())
                }
                _ if seat != self.turn => Err("還沒輪到你".into()),
                SecretAction::Pass => {
                    self.turn = (self.turn + 1) % self.secrets.len();
                    Ok(())
                }
                SecretAction::Win => {
                    self.done = true;
                    *self.wins.entry(self.pids[seat]).or_default() += 1;
                    Ok(())
                }
            }
        }

        fn chat(&mut self, seat: Option<usize>, text: &str, ctx: &mut Ctx) -> Chat {
            match (text, seat) {
                ("secret", Some(s)) => Chat::Only(To::Seat(s)),
                ("hide", _) => {
                    ctx.announce(To::All, "有人說了祕密", "ok");
                    Chat::Drop
                }
                _ => Chat::Show,
            }
        }

        fn presence(&mut self, seat: usize, online: bool, ctx: &mut Ctx) {
            self.online[seat] = online;
            ctx.changed();
        }

        fn view(&self, seat: Option<usize>, _now: Instant) -> Value {
            json!({
                "turn": self.turn,
                "mine": seat.map(|s| self.secrets[s]),
                "online": self.online,
                "wins": self.pids.iter().map(|p| self.wins.get(p).copied().unwrap_or(0)).collect::<Vec<_>>(),
            })
        }

        fn finished(&self) -> bool {
            self.done
        }
    }

    fn conn_for_test(id: u64, tx: mpsc::UnboundedSender<Utf8Bytes>) -> Conn {
        Conn { id, tx, ip: "local".into(), since: Instant::now() }
    }

    struct Peer {
        rx: mpsc::UnboundedReceiver<Utf8Bytes>,
        id: u64,
        pid: u32,
    }

    impl Peer {
        /// 目前佇列裡所有訊息
        fn drain(&mut self) -> Vec<Value> {
            let mut out = Vec::new();
            while let Ok(m) = self.rx.try_recv() {
                out.push(serde_json::from_str(&m).unwrap());
            }
            out
        }

        fn last(&mut self, kind: &str) -> Option<Value> {
            self.drain().into_iter().rev().find(|m| m["type"] == kind)
        }
    }

    fn join(room: &mut Room<Secret>, key: &str, name: &str, conn: u64) -> Peer {
        let (tx, rx) = mpsc::unbounded_channel();
        let pid = room.join(key, name.into(), conn_for_test(conn, tx), Instant::now()).unwrap();
        Peer { rx, id: conn, pid }
    }

    fn send(room: &mut Room<Secret>, peer: &Peer, message: Value) {
        room.handle(peer.pid, serde_json::from_value(message).unwrap(), Instant::now());
    }

    #[test]
    fn host_moves_to_the_next_person() {
        let mut room = Room::<Secret>::new();
        let a = join(&mut room, "guest:a", "阿明", 1);
        let mut b = join(&mut room, "guest:b", "小華", 2);
        assert_eq!(room.host(), Some(a.pid));
        room.leave(a.pid, a.id, Instant::now());
        assert_eq!(room.host(), Some(b.pid));
        // 大廳裡離開的人直接移出名單
        let state = b.last("room").unwrap();
        assert_eq!(state["host"], b.pid);
        assert_eq!(state["players"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn lobby_order_decides_the_host() {
        // 遊戲室開的房間：不管誰先連上，房主都照遊戲室的順序
        let mut room = Room::<Secret>::new();
        room.hosts = vec!["guest:a".into(), "guest:b".into()];
        let b = join(&mut room, "guest:b", "小華", 1);
        let c = join(&mut room, "guest:c", "阿強", 2);
        assert_eq!(room.host(), Some(b.pid));
        let a = join(&mut room, "guest:a", "阿明", 3);
        assert_eq!(room.host(), Some(a.pid));
        room.leave(a.pid, a.id, Instant::now());
        assert_eq!(room.host(), Some(b.pid));
        room.leave(b.pid, b.id, Instant::now());
        assert_eq!(room.host(), Some(c.pid));
    }

    #[test]
    fn same_names_get_a_number() {
        let mut room = Room::<Secret>::new();
        join(&mut room, "guest:a", "阿明", 1);
        let mut b = join(&mut room, "guest:b", "阿明", 2);
        let state = b.last("room").unwrap();
        assert_eq!(state["players"][1]["name"], "阿明 2");
    }

    #[test]
    fn views_are_private_and_spectators_see_none() {
        let mut room = Room::<Secret>::new();
        let mut a = join(&mut room, "guest:a", "A", 1);
        let mut b = join(&mut room, "guest:b", "B", 2);
        send(&mut room, &a, json!({ "type": "start" }));
        let va = a.last("view").unwrap();
        let vb = b.last("view").unwrap();
        assert_eq!(va["view"]["mine"], 100);
        assert_eq!(vb["view"]["mine"], 101);
        assert!(!vb.to_string().contains("100"), "B 不能看到 A 的數字：{vb}");

        // 對局中才進來的人觀戰
        let mut c = join(&mut room, "guest:c", "C", 3);
        let welcome = c.drain();
        let view = welcome.iter().find(|m| m["type"] == "view").unwrap();
        assert_eq!(view["view"]["mine"], Value::Null);
        let state = welcome.iter().find(|m| m["type"] == "room").unwrap();
        assert_eq!(state["players"][2]["seat"], Value::Null);
    }

    #[test]
    fn rejected_actions_only_reach_the_sender() {
        let mut room = Room::<Secret>::new();
        let mut a = join(&mut room, "guest:a", "A", 1);
        let mut b = join(&mut room, "guest:b", "B", 2);
        send(&mut room, &a, json!({ "type": "start" }));
        a.drain();
        b.drain();
        send(&mut room, &b, json!({ "type": "action", "action": { "type": "pass" } }));
        assert_eq!(b.last("notice").unwrap()["message"], "還沒輪到你");
        assert!(a.drain().is_empty());
        send(&mut room, &b, json!({ "type": "action", "action": { "type": "nope" } }));
        assert_eq!(b.last("notice").unwrap()["message"], "看不懂這個動作");

        // 成功的動作會重送 view；quiet 的只送事件
        send(&mut room, &a, json!({ "type": "action", "action": { "type": "pass" } }));
        assert_eq!(b.last("view").unwrap()["view"]["turn"], 1);
        a.drain();
        send(&mut room, &a, json!({ "type": "action", "action": { "type": "ping" } }));
        let got = b.drain();
        assert_eq!(got.len(), 1, "{got:?}");
        assert_eq!(got[0]["event"]["ping"], 0);
        assert!(a.drain().is_empty(), "Except 不送給自己");
    }

    #[test]
    fn chat_goes_through_the_game() {
        let mut room = Room::<Secret>::new();
        let mut a = join(&mut room, "guest:a", "A", 1);
        let mut b = join(&mut room, "guest:b", "B", 2);
        // 大廳裡照常廣播
        send(&mut room, &a, json!({ "type": "chat", "text": "  嗨\n大家 " }));
        assert_eq!(b.last("chat").unwrap()["line"]["text"], "嗨 大家");
        send(&mut room, &a, json!({ "type": "start" }));
        a.drain();
        b.drain();

        send(&mut room, &a, json!({ "type": "chat", "text": "secret" }));
        assert!(b.drain().is_empty());
        let mine = a.last("chat").unwrap();
        assert_eq!(mine["line"]["private"], true);

        send(&mut room, &b, json!({ "type": "chat", "text": "hide" }));
        let line = a.last("chat").unwrap()["line"].clone();
        assert_eq!(line["text"], "有人說了祕密");
        assert_eq!(line["pid"], Value::Null);
        assert_eq!(line["tone"], "ok");

        // 重連時只拿回自己看得到的
        let mut b2 = join(&mut room, "guest:b", "B", 3);
        let history = b2.drain().into_iter().find(|m| m["type"] == "chats").unwrap();
        let texts: Vec<&str> =
            history["lines"].as_array().unwrap().iter().map(|l| l["text"].as_str().unwrap()).collect();
        assert_eq!(texts, ["嗨 大家", "開始了", "有人說了祕密"]);
    }

    #[test]
    fn reconnecting_keeps_the_seat_and_replaces_the_old_tab() {
        let mut room = Room::<Secret>::new();
        let a = join(&mut room, "guest:a", "A", 1);
        let b = join(&mut room, "guest:b", "B", 2);
        send(&mut room, &a, json!({ "type": "start" }));
        room.leave(b.pid, b.id, Instant::now());
        // 對局中斷線的人留著座位，遊戲收到 presence
        let state = room.room_text();
        let state: Value = serde_json::from_str(&state).unwrap();
        assert_eq!(state["players"][1]["online"], false);
        assert_eq!(state["players"][1]["seat"], 1);
        assert_eq!(room.game.as_ref().unwrap().online, [true, false]);

        let mut b2 = join(&mut room, "guest:b", "B", 3);
        assert_eq!(b2.pid, b.pid);
        let view = b2.drain().into_iter().find(|m| m["type"] == "view").unwrap();
        assert_eq!(view["view"]["mine"], 101);
        assert_eq!(room.game.as_ref().unwrap().online, [true, true]);

        // 同一個人又從別處連進來：舊的收到 replaced
        let _b3 = join(&mut room, "guest:b", "B", 4);
        assert_eq!(b2.last("error").unwrap()["code"], "replaced");
        drop(b);
    }

    #[test]
    fn host_controls_bots_options_and_kicks() {
        let mut room = Room::<Secret>::new();
        let mut a = join(&mut room, "guest:a", "A", 1);
        let mut b = join(&mut room, "guest:b", "B", 2);

        // 不是房主：忽略
        send(&mut room, &b, json!({ "type": "addBot" }));
        assert_eq!(room.bots(), 0);
        send(&mut room, &a, json!({ "type": "addBot" }));
        assert_eq!(room.bots(), 1);
        send(&mut room, &a, json!({ "type": "addBot" }));
        assert_eq!(a.last("notice").unwrap()["message"], "座位已經滿了");

        send(&mut room, &a, json!({ "type": "options", "options": { "limit": 12 } }));
        assert_eq!(a.last("notice").unwrap()["message"], "太大了");
        send(&mut room, &a, json!({ "type": "options", "options": { "limit": 1 } }));
        assert_eq!(b.last("room").unwrap()["options"]["limit"], 1);
        send(&mut room, &a, json!({ "type": "start" }));
        assert_eq!(a.last("notice").unwrap()["message"], "限制 1 只能兩個人");

        let bot = room.members.iter().find(|m| m.key.is_none()).unwrap().pid;
        send(&mut room, &a, json!({ "type": "kick", "pid": bot }));
        assert_eq!(room.bots(), 0);
        // 一次加好幾台：加到座位滿就停，不算錯
        send(&mut room, &a, json!({ "type": "addBot", "count": 5 }));
        assert_eq!(room.bots(), 1);
        let bot = room.members.iter().find(|m| m.key.is_none()).unwrap().pid;
        send(&mut room, &a, json!({ "type": "kick", "pid": bot }));
        assert_eq!(room.bots(), 0);
        send(&mut room, &a, json!({ "type": "kick", "pid": b.pid }));
        assert_eq!(b.last("error").unwrap()["code"], "kicked");
        assert_eq!(room.members.len(), 1);
        // 被踢的人進不來
        let (tx, _rx) = mpsc::unbounded_channel();
        assert_eq!(room.join("guest:b", "B".into(), conn_for_test(9, tx), Instant::now()), Err(KICKED));
    }

    #[test]
    fn results_then_rematch_carries_the_previous_round() {
        let mut room = Room::<Secret>::new();
        let mut a = join(&mut room, "guest:a", "A", 1);
        let b = join(&mut room, "guest:b", "B", 2);
        send(&mut room, &a, json!({ "type": "start" }));
        send(&mut room, &a, json!({ "type": "action", "action": { "type": "win" } }));
        assert_eq!(room.phase, Phase::Results);
        assert_eq!(a.last("room").unwrap()["phase"], "results");

        // 結算時有座位的人斷線先留著，下一局開局時才移出
        room.leave(b.pid, b.id, Instant::now());
        assert_eq!(room.members.len(), 2);
        let c = join(&mut room, "guest:c", "C", 3);
        send(&mut room, &a, json!({ "type": "start" }));
        assert_eq!(room.phase, Phase::Playing);
        assert_eq!(room.seats, [a.pid, c.pid]);
        assert_eq!(a.last("room").unwrap()["round"], 2);
        let view: Value = serde_json::from_str(&room.view_text(0, Instant::now())).unwrap();
        assert_eq!(view["view"]["wins"], json!([1, 0]));

        // 中止：回到大廳，view 變成 null
        send(&mut room, &a, json!({ "type": "abort" }));
        assert_eq!(room.phase, Phase::Lobby);
        assert_eq!(a.last("view").unwrap()["view"], Value::Null);
    }

    #[test]
    fn needs_enough_players() {
        let mut room = Room::<Secret>::new();
        let mut a = join(&mut room, "guest:a", "A", 1);
        send(&mut room, &a, json!({ "type": "start" }));
        assert_eq!(a.last("notice").unwrap()["message"], "至少要 2 人才能開始，可以加電腦玩家");
        send(&mut room, &a, json!({ "type": "addBot" }));
        send(&mut room, &a, json!({ "type": "start" }));
        assert_eq!(room.phase, Phase::Playing);
        assert_eq!(a.last("room").unwrap()["players"][1]["name"], "電腦 1");
    }

    #[test]
    fn watchers_are_not_seated() {
        let mut room = Room::<Secret>::new();
        // 遊戲室開房時就選了觀戰的人（還沒連進來）
        room.watchers = HashSet::from(["guest:c".to_owned()]);
        let mut a = join(&mut room, "guest:a", "A", 1);
        let mut b = join(&mut room, "guest:b", "B", 2);
        let c = join(&mut room, "guest:c", "C", 3);
        let state = a.last("room").unwrap();
        assert_eq!(state["players"][2]["watching"], true);

        // 房主自己也可以觀戰；人數不夠就不能開
        send(&mut room, &a, json!({ "type": "watch", "watch": true }));
        send(&mut room, &a, json!({ "type": "start" }));
        assert_eq!(a.last("notice").unwrap()["message"], "至少要 2 人才能開始，可以加電腦玩家");
        // 觀戰的人不佔座位：加得了電腦
        send(&mut room, &a, json!({ "type": "addBot" }));
        send(&mut room, &a, json!({ "type": "start" }));
        assert_eq!(room.phase, Phase::Playing);
        let bot = room.members.iter().find(|m| m.key.is_none()).unwrap().pid;
        assert_eq!(room.seats, [b.pid, bot]);
        assert_eq!(b.last("view").unwrap()["view"]["mine"], 100);
        assert_eq!(a.last("view").unwrap()["view"]["mine"], Value::Null);

        // 對局中改回上場：這局照樣觀戰，下一局才入座
        send(&mut room, &c, json!({ "type": "watch", "watch": false }));
        assert_eq!(room.seats, [b.pid, bot]);
        send(&mut room, &b, json!({ "type": "action", "action": { "type": "win" } }));
        send(&mut room, &a, json!({ "type": "start" }));
        assert_eq!(room.seats, [b.pid, c.pid, bot]);
    }

    #[test]
    fn shuffle_keeps_every_item() {
        let mut rng = Rng::new();
        let mut items: Vec<u32> = (0..20).collect();
        shuffle(&mut rng, &mut items);
        items.sort();
        assert_eq!(items, (0..20).collect::<Vec<_>>());
    }
}
