//! 吹牛骰子（派對房間，房間本身見 `party.rs`）。2～10 人，人不夠可以加電腦。
//!
//! 每個人一個骰盅、5 顆骰子，只看得到自己的。一「輪」是大家一起搖、輪流喊、到有人「開」為止；一「局」是一整場。
//! - 從起叫的人開始輪流喊「N 個 F」（場上至少有 N 顆 F 點），下一個人要喊得更大（個數更多，或個數一樣、點數更大），或者「開」。
//! - 開了就全部掀開來數：符合的骰子有 N 個以上就是喊的成立、開的人輸；不夠就是喊的人輸。
//! - 一點萬用（預設開）：數的時候一點也算（喊的就是一點時只數一點）。一點萬用時一點最大（2 < 3 < 4 < 5 < 6 < 1），
//!   不萬用時照數字（1 < 2 < … < 6）。「喊過一點就不萬用」（預設開）：這輪有人喊了一點，之後一點只算一點。
//! - 起叫最少個數：人數 + 1（預設）、人數、或不限（1 個）；不會超過場上骰子總數的一半（無條件進位），骰子少的時候起叫的人才不會一開口就輸。
//!   個數最多喊到場上骰子總數。
//! - 散骰（預設開）：五顆點數全不同，還沒喊、沒開之前可以重搖（可以連續搖到不是散骰），會公開說他重搖了。
//! - 勝負：淘汰制（預設）輸的人少一顆骰子，沒骰子就出局，剩最後一個人贏；計分制固定輪數（預設 10 輪），
//!   每個人一直都是 5 顆，輸一次喝一杯，最後喝最少的贏（同杯數一起贏）。兩種都記杯數，房間跨局累計勝場和杯數。
//! - 第一輪隨機一個人先喊，之後由上一輪輸的人先喊（他出局了就換下一位）。
//! - 每手有時限（預設 30 秒，可以不限），時間到或斷線（等 5 秒）由電腦代為出手。
//! - 開了之後揭曉 9 秒（場上的真人都按「下一輪」就提早），所有人的骰子攤開、標出符合的和萬用的骰子。
//!
//! 隱藏資訊：每個人的 view 只有自己的骰子，揭曉時才放所有人的骰子。觀戰和出局的人一樣看不到
//! （不然開第二個分頁當觀戰就能偷看），所以聊天不用另外擋。
//! 電腦玩家只知道自己的骰子和每個人剩幾顆：用二項分布估「這個喊價成立的機率」，再參考別人這輪喊過的點數；
//! 太不可能就開，偶爾故意喊自己沒有的點數虛張聲勢。有四種個性（穩健、愛唬爛、精算、老實），差在信不信別人、多常唬人、多容易開。

use std::{
    collections::{HashMap, VecDeque},
    sync::Arc,
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::time::Instant;

use crate::{
    AppState,
    party::{Ctx, Parties, PartyGame, Rng, To},
};

/// 每個人開局的骰子數
pub const START_DICE: usize = 5;
/// 搖骰的動畫時間，這段時間還不能喊
const ROLL_TIME: Duration = Duration::from_millis(1600);
/// 開了之後揭曉多久（場上的真人都按「下一輪」會提早）
const REVEAL_TIME: Duration = Duration::from_secs(9);
/// 輪到斷線的人：等這麼久就由電腦代為出手
const OFFLINE_WAIT: Duration = Duration::from_secs(5);
/// 紀錄最多留幾行（跨輪）
const LOG_LINES: usize = 120;
/// 電腦重搖散骰最多搖幾次（照理一兩次就不是散骰了）
const MAX_REROLLS: usize = 20;

pub const THINK_CHOICES: [u16; 4] = [0, 15, 30, 60];
pub const ROUND_CHOICES: [u16; 4] = [5, 10, 15, 20];

/// 勝負模式
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    /// 輸的人少一顆骰子，沒骰子出局，剩最後一個人贏
    #[default]
    Elimination,
    /// 固定輪數，輸一次喝一杯，喝最少的贏
    Points,
}

/// 起叫（每輪第一個喊的）最少要喊幾個
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub enum Opening {
    /// 不限（1 個）
    One,
    /// 場上人數
    Players,
    /// 場上人數 + 1
    #[default]
    PlayersPlusOne,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Options {
    pub mode: Mode,
    /// 一點萬用
    pub wild_ones: bool,
    /// 這輪有人喊過一點之後，一點就不再萬用
    pub ones_lock: bool,
    pub opening: Opening,
    /// 五顆全不同的散骰可以重搖
    pub scatter: bool,
    /// 計分制打幾輪
    pub rounds: u16,
    /// 每手的思考秒數，0 是不限
    pub think_secs: u16,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            mode: Mode::Elimination,
            wild_ones: true,
            ones_lock: true,
            opening: Opening::PlayersPlusOne,
            scatter: true,
            rounds: 10,
            think_secs: 30,
        }
    }
}

/// 喊價：場上至少有 `count` 顆 `face` 點
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub struct Bid {
    pub count: u8,
    pub face: u8,
}

/// 個數一樣時比點數用的大小；`ones_high`（一點萬用）時一點最大
pub fn face_rank(face: u8, ones_high: bool) -> u8 {
    if ones_high && face == 1 { 7 } else { face }
}

impl Bid {
    /// 比 `other` 大：個數更多，或個數一樣、點數更大
    pub fn beats(self, other: Bid, ones_high: bool) -> bool {
        self.count > other.count
            || (self.count == other.count && face_rank(self.face, ones_high) > face_rank(other.face, ones_high))
    }

    fn text(self) -> String {
        format!("{} 個 {}", self.count, self.face)
    }
}

/// 數 `hands` 裡有幾顆算 `face`；`wild` 是一點也算（喊的不是一點、而且現在一點萬用）
pub fn count_matching(hands: &[Vec<u8>], face: u8, wild: bool) -> usize {
    hands.iter().flatten().filter(|&&d| d == face || (wild && d == 1)).count()
}

/// 散骰：五顆點數全不同
pub fn is_scatter(dice: &[u8]) -> bool {
    dice.len() == START_DICE && (1..=6u8).filter(|f| dice.contains(f)).count() == START_DICE
}

fn roll(n: usize, rng: &mut Rng) -> Vec<u8> {
    let mut dice: Vec<u8> = (0..n).map(|_| rng.below(6) as u8 + 1).collect();
    dice.sort_unstable();
    dice
}

/// `n` 顆、每顆機率 `p` 的骰子裡至少有 `k` 顆的機率（二項分布的右尾）
pub fn at_least(n: usize, p: f64, k: i64) -> f64 {
    if k <= 0 {
        return 1.0;
    }
    if k as usize > n {
        return 0.0;
    }
    let q = 1.0 - p;
    let mut term = q.powi(n as i32);
    let mut below = 0.0;
    for i in 0..k as usize {
        below += term;
        term *= (n - i) as f64 / (i + 1) as f64 * p / q;
    }
    (1.0 - below).clamp(0.0, 1.0)
}

/// 同上，但 `k` 可以有小數（參考別人喊過的點數時用），在兩個整數之間線性內插
fn chance(n: usize, p: f64, k: f64) -> f64 {
    let lo = k.floor();
    let frac = k - lo;
    let a = at_least(n, p, lo as i64);
    if frac == 0.0 { a } else { a * (1.0 - frac) + at_least(n, p, lo as i64 + 1) * frac }
}

/// 電腦的個性
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Persona {
    /// 穩健：幾乎不唬人，覺得不太可能就開
    Steady,
    /// 愛唬爛：常常喊自己沒有的點數，也不太相信別人喊的
    Bluffer,
    /// 精算：照機率走，偶爾唬一下
    Counter,
    /// 老實：很相信別人喊的點數，不太開
    Trusting,
    /// 真人逾時或斷線時代打用：照機率走、不唬人
    StandIn,
}

struct Style {
    /// 別人這輪喊過某個點數，就當他手上大概多幾顆
    trust: f64,
    /// 這次想唬人的機率（優先喊自己沒有的點數）
    bluff: f64,
    /// 判斷時加的隨機量
    noise: f64,
    /// 往上喊之後，下一個人不開（風險傳下去）的期待
    hope: f64,
    /// 正的比較容易開，負的比較喜歡往上喊
    open_bias: f64,
    /// 現在的喊價成立的機率低於這個就一定開
    doubt: f64,
}

/// 電腦的名字和個性一一對應，加電腦時照順序輪
const BOT_PERSONAS: [(Persona, &str); 4] = [
    (Persona::Steady, "穩健阿伯"),
    (Persona::Bluffer, "唬爛王"),
    (Persona::Counter, "算盤阿姨"),
    (Persona::Trusting, "老實阿弟"),
];

impl Persona {
    fn style(self) -> Style {
        match self {
            Persona::Steady => {
                Style { trust: 0.7, bluff: 0.03, noise: 0.04, hope: 0.25, open_bias: -0.05, doubt: 0.22 }
            }
            Persona::Bluffer => Style { trust: 0.4, bluff: 0.3, noise: 0.1, hope: 0.35, open_bias: -0.1, doubt: 0.15 },
            Persona::Counter => Style { trust: 0.8, bluff: 0.1, noise: 0.02, hope: 0.25, open_bias: 0.0, doubt: 0.2 },
            Persona::Trusting => {
                Style { trust: 1.1, bluff: 0.02, noise: 0.06, hope: 0.25, open_bias: -0.05, doubt: 0.15 }
            }
            Persona::StandIn => Style { trust: 0.8, bluff: 0.0, noise: 0.02, hope: 0.25, open_bias: 0.0, doubt: 0.2 },
        }
    }

    /// 電腦的個性看名字（`bot_name` 取的），對不上就照編號輪
    fn of_bot(name: &str, pid: u32) -> Self {
        BOT_PERSONAS
            .iter()
            .find(|(_, n)| name.starts_with(*n))
            .map_or(BOT_PERSONAS[pid as usize % BOT_PERSONAS.len()].0, |(p, _)| *p)
    }

    /// 電腦開的時候偶爾說一句
    fn quips(self) -> &'static [&'static str] {
        match self {
            Persona::Steady => &["這也太多了吧，開。", "年輕人，別衝那麼快。開！"],
            Persona::Bluffer => &["騙誰啊？開！", "這我熟，開來看看！"],
            Persona::Counter => &["算過了，機率太低。開。", "照期望值不可能，開。"],
            Persona::Trusting => &["呃……這次我不信了，開！", "你應該在唬我吧？開！"],
            Persona::StandIn => &[],
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
enum Stage {
    /// 搖骰動畫，還不能喊
    Rolling,
    Bidding,
    /// 開了，所有人的骰子攤開
    Reveal,
    End,
}

/// 開了之後的結果，揭曉時（和結束時）放進 view
#[derive(Clone, Debug)]
struct Reveal {
    bid: Bid,
    bidder: usize,
    opener: usize,
    /// 這次一點有沒有算萬用
    wild: bool,
    /// 開的那一刻所有人的骰子
    hands: Vec<Vec<u8>>,
    matched: usize,
    loser: usize,
    /// 輸的人因此出局
    out: bool,
    /// 開的人是逾時或斷線由電腦代開的
    auto: bool,
}

#[derive(Clone, Copy, Default, Debug)]
struct Totals {
    wins: u32,
    cups: u32,
}

#[derive(Clone, Debug)]
struct Outcome {
    /// 名次，第一個是冠軍
    ranking: Vec<usize>,
    /// 這局贏的人（計分制同杯數可能好幾個）
    winners: Vec<usize>,
}

enum Move {
    Bid(Bid),
    Open,
}

pub struct LiarsDice {
    options: Options,
    pids: Vec<u32>,
    names: Vec<String>,
    bots: Vec<bool>,
    online: Vec<bool>,
    personas: Vec<Persona>,
    /// 每個人現在有幾顆骰子（淘汰制會越來越少，0 是出局）
    sizes: Vec<usize>,
    /// 這輪搖出來的骰子（排好）
    dice: Vec<Vec<u8>>,
    /// 每個座位搖過幾次（含散骰重搖），用戶端看到變了就播搖骰動畫
    rolls: Vec<u32>,
    /// 這輪散骰重搖過
    rerolled: Vec<bool>,
    stage: Stage,
    /// 第幾輪
    round: u32,
    /// 這輪（或下一輪）誰先喊
    starter: usize,
    turn: Option<usize>,
    /// 這輪喊過的（照順序），最後一個是現在的喊價
    bids: Vec<(usize, Bid)>,
    /// 這輪有人喊過一點
    ones_called: bool,
    /// 這輪已經喊過或開過（就不能散骰重搖了）
    acted: Vec<bool>,
    /// 搖骰、揭曉什麼時候結束
    stage_until: Option<Instant>,
    turn_started: Instant,
    deadline: Option<Instant>,
    bot_at: Option<Instant>,
    reveal: Option<Reveal>,
    /// 揭曉時按了「下一輪」的人
    ready: Vec<bool>,
    /// 這局每個人喝了幾杯（輸了幾次）
    cups: Vec<u32>,
    /// 淘汰制出局的順序
    busted: Vec<usize>,
    log: VecDeque<String>,
    outcome: Option<Outcome>,
    /// 房間累計的勝場和杯數（pid → …）
    totals: HashMap<u32, Totals>,
    /// 這個房間的第幾局
    game: u32,
}

impl LiarsDice {
    fn n(&self) -> usize {
        self.pids.len()
    }

    fn alive(&self, seat: usize) -> bool {
        self.sizes[seat] > 0
    }

    fn alive_count(&self) -> usize {
        (0..self.n()).filter(|&s| self.alive(s)).count()
    }

    fn total_dice(&self) -> usize {
        self.sizes.iter().sum()
    }

    /// 現在一點算不算萬用（喊的不是一點時）
    fn wild_now(&self) -> bool {
        self.options.wild_ones && !self.ones_called
    }

    fn current(&self) -> Option<(usize, Bid)> {
        self.bids.last().copied()
    }

    /// `from` 之後下一個還有骰子的人
    fn next_alive(&self, from: usize) -> usize {
        let n = self.n();
        (1..=n).map(|k| (from + k) % n).find(|&s| self.alive(s)).unwrap_or(from)
    }

    fn push_log(&mut self, line: impl Into<String>) {
        if self.log.len() >= LOG_LINES {
            self.log.pop_front();
        }
        self.log.push_back(line.into());
    }

    /// 起叫最少要喊幾個
    fn min_open(&self) -> usize {
        let players = self.alive_count();
        let rule = match self.options.opening {
            Opening::One => 1,
            Opening::Players => players,
            Opening::PlayersPlusOne => players + 1,
        };
        rule.min(self.total_dice().div_ceil(2)).max(1)
    }

    /// 每個點數（索引 0 是一點）現在最少要喊幾個；None 是這個點數已經喊不上去了（超過場上的骰子數）
    fn min_counts(&self) -> [Option<usize>; 6] {
        let total = self.total_dice();
        let high = self.options.wild_ones;
        std::array::from_fn(|i| {
            let face = i as u8 + 1;
            let need = match self.current() {
                None => self.min_open(),
                Some((_, b)) if face_rank(face, high) > face_rank(b.face, high) => usize::from(b.count),
                Some((_, b)) => usize::from(b.count) + 1,
            };
            (need <= total).then_some(need)
        })
    }

    fn check_bid(&self, bid: Bid) -> Result<(), String> {
        if !(1..=6).contains(&bid.face) {
            return Err("點數只能是 1～6".into());
        }
        let total = self.total_dice();
        if usize::from(bid.count) > total {
            return Err(format!("場上只有 {total} 顆骰子"));
        }
        match (self.min_counts()[usize::from(bid.face) - 1], self.current()) {
            (Some(min), _) if usize::from(bid.count) >= min => Ok(()),
            (_, None) => Err(format!("起叫最少要喊 {} 個", self.min_open())),
            (_, Some((_, cur))) => Err(format!("要喊得比 {} 大", cur.text())),
        }
    }

    fn can_reroll(&self, seat: usize) -> bool {
        self.options.scatter
            && matches!(self.stage, Stage::Rolling | Stage::Bidding)
            && !self.acted[seat]
            && is_scatter(&self.dice[seat])
    }

    /// 這局打完了沒（揭曉完之後看）
    fn over(&self) -> bool {
        match self.options.mode {
            Mode::Elimination => self.alive_count() <= 1,
            Mode::Points => self.round >= u32::from(self.options.rounds),
        }
    }

    /// 新的一輪：大家一起搖
    fn start_round(&mut self, ctx: &mut Ctx) {
        self.round += 1;
        for s in 0..self.n() {
            self.dice[s] = roll(self.sizes[s], ctx.rng);
            if self.alive(s) {
                self.rolls[s] += 1;
            }
        }
        self.rerolled.fill(false);
        self.bids.clear();
        self.ones_called = false;
        self.acted.fill(false);
        self.ready.fill(false);
        self.reveal = None;
        self.turn = None;
        self.deadline = None;
        self.bot_at = None;
        self.stage = Stage::Rolling;
        self.stage_until = Some(ctx.now + ROLL_TIME);
        let header = match self.options.mode {
            Mode::Points => {
                format!("── 第 {}／{} 輪，{} 先喊 ──", self.round, self.options.rounds, self.names[self.starter])
            }
            Mode::Elimination => format!("── 第 {} 輪，{} 先喊 ──", self.round, self.names[self.starter]),
        };
        self.push_log(header);
        ctx.changed();
    }

    /// 搖完了，開始喊
    fn begin_bidding(&mut self, ctx: &mut Ctx) {
        self.stage = Stage::Bidding;
        self.stage_until = None;
        if self.options.scatter {
            for s in 0..self.n() {
                // 電腦拿到散骰：手上有萬用的一點就留著（每個點數都有兩顆），沒有才重搖
                let mut tries = 0;
                while self.bots[s] && is_scatter(&self.dice[s]) && self.bot_rerolls(s) && tries < MAX_REROLLS {
                    self.reroll(s, ctx);
                    tries += 1;
                }
            }
        }
        self.set_turn(self.starter, ctx);
    }

    fn bot_rerolls(&self, seat: usize) -> bool {
        self.options.wild_ones && !self.dice[seat].contains(&1)
    }

    fn reroll(&mut self, seat: usize, ctx: &mut Ctx) {
        self.dice[seat] = roll(self.sizes[seat], ctx.rng);
        self.rolls[seat] += 1;
        if !self.rerolled[seat] {
            self.rerolled[seat] = true;
            let line = format!("{} 拿到散骰，重搖", self.names[seat]);
            self.push_log(line);
        }
        ctx.changed();
    }

    fn set_turn(&mut self, seat: usize, ctx: &mut Ctx) {
        self.turn = Some(seat);
        self.turn_started = ctx.now;
        self.deadline =
            (self.options.think_secs > 0).then(|| ctx.now + Duration::from_secs(u64::from(self.options.think_secs)));
        // 電腦想一下再喊，看起來比較自然
        self.bot_at = self.bots[seat].then(|| ctx.now + Duration::from_secs_f64(ctx.rng.range(1.0, 2.2)));
        ctx.changed();
    }

    /// 喊價（已經檢查過合法、輪到 `seat`）
    fn place_bid(&mut self, seat: usize, bid: Bid, auto: bool, ctx: &mut Ctx) {
        self.bids.push((seat, bid));
        self.acted[seat] = true;
        let mut line = format!("{} 喊 {}", self.names[seat], bid.text());
        if auto {
            line.push_str("（電腦代喊）");
        }
        if bid.face == 1 && self.options.wild_ones && self.options.ones_lock && !self.ones_called {
            self.ones_called = true;
            line.push_str("，這輪一點不再萬用");
        }
        self.push_log(line);
        self.set_turn(self.next_alive(seat), ctx);
    }

    /// 開：全部掀開來數（已經確定輪到 `seat`、有人喊過）
    fn open(&mut self, seat: usize, auto: bool, ctx: &mut Ctx) {
        let Some((bidder, bid)) = self.current() else { return };
        self.acted[seat] = true;
        let wild = self.wild_now() && bid.face != 1;
        let matched = count_matching(&self.dice, bid.face, wild);
        let holds = matched >= usize::from(bid.count);
        let loser = if holds { seat } else { bidder };
        self.cups[loser] += 1;
        self.totals.entry(self.pids[loser]).or_default().cups += 1;
        let mut out = false;
        if self.options.mode == Mode::Elimination {
            self.sizes[loser] -= 1;
            if self.sizes[loser] == 0 {
                out = true;
                self.busted.push(loser);
            }
        }
        // 下一輪由輸的人先喊，他出局了就換下一位
        self.starter = if self.alive(loser) { loser } else { self.next_alive(loser) };

        let (opener_name, bidder_name, loser_name) = (&self.names[seat], &self.names[bidder], &self.names[loser]);
        let verdict = if holds {
            format!("實際有 {matched} 個，喊的成立，{opener_name} 輸")
        } else {
            format!("實際只有 {matched} 個，{bidder_name} 喊太大了，{bidder_name} 輸")
        };
        let after = match self.options.mode {
            Mode::Elimination if out => format!("{loser_name} 的骰子輸光了，出局！"),
            Mode::Elimination => format!("{loser_name} 少一顆骰子（剩 {} 顆）", self.sizes[loser]),
            Mode::Points => format!("{loser_name} 喝一杯（這局第 {} 杯）", self.cups[loser]),
        };
        let text = format!(
            "{opener_name}{} 開 {bidder_name} 的 {}：{verdict}。{after}",
            if auto { "（電腦代開）" } else { "" },
            bid.text()
        );
        self.push_log(text.clone());
        ctx.announce(To::All, text, if out { "danger" } else { "accent" });

        self.reveal =
            Some(Reveal { bid, bidder, opener: seat, wild, hands: self.dice.clone(), matched, loser, out, auto });
        self.stage = Stage::Reveal;
        self.stage_until = Some(ctx.now + REVEAL_TIME);
        self.ready.fill(false);
        self.turn = None;
        self.deadline = None;
        self.bot_at = None;
        ctx.changed();
    }

    /// 揭曉時連著線的真人都按了「下一輪」（沒有真人就等時間到）
    fn everyone_ready(&self) -> bool {
        let humans: Vec<usize> = (0..self.n()).filter(|&s| !self.bots[s] && self.online[s]).collect();
        !humans.is_empty() && humans.iter().all(|&s| self.ready[s])
    }

    fn after_reveal(&mut self, ctx: &mut Ctx) {
        if self.over() { self.finish(ctx) } else { self.start_round(ctx) }
    }

    fn finish(&mut self, ctx: &mut Ctx) {
        self.stage = Stage::End;
        self.stage_until = None;
        self.turn = None;
        self.deadline = None;
        self.bot_at = None;
        let (ranking, winners) = match self.options.mode {
            Mode::Elimination => {
                let mut ranking: Vec<usize> = (0..self.n()).filter(|&s| self.alive(s)).collect();
                ranking.extend(self.busted.iter().rev());
                (ranking.clone(), ranking.into_iter().take(1).collect::<Vec<_>>())
            }
            Mode::Points => {
                let mut ranking: Vec<usize> = (0..self.n()).collect();
                ranking.sort_by_key(|&s| self.cups[s]);
                let least = self.cups[ranking[0]];
                let winners = ranking.iter().copied().filter(|&s| self.cups[s] == least).collect();
                (ranking, winners)
            }
        };
        for &w in &winners {
            self.totals.entry(self.pids[w]).or_default().wins += 1;
        }
        let who = winners.iter().map(|&w| self.names[w].as_str()).collect::<Vec<_>>().join("、");
        let text = match self.options.mode {
            Mode::Elimination => format!("{who} 撐到最後，拿下第 {} 局！", self.game),
            Mode::Points => {
                format!("{} 輪打完，{who} 只喝了 {} 杯，拿下第 {} 局！", self.round, self.cups[winners[0]], self.game)
            }
        };
        self.push_log(text.clone());
        ctx.announce(To::All, text, "ok");
        self.outcome = Some(Outcome { ranking, winners });
        ctx.changed();
    }

    /// 電腦（或代打）出手
    fn bot_play(&mut self, seat: usize, stand_in: bool, ctx: &mut Ctx) {
        let persona = if stand_in { Persona::StandIn } else { self.personas[seat] };
        match self.bot_decide(seat, persona, ctx.rng) {
            Move::Bid(bid) => self.place_bid(seat, bid, stand_in, ctx),
            Move::Open => {
                let quips = persona.quips();
                if !quips.is_empty() && ctx.rng.chance(0.4) {
                    let quip = quips[ctx.rng.below(quips.len())];
                    ctx.say(To::All, seat, quip);
                }
                self.open(seat, stand_in, ctx);
            }
        }
    }

    /// `seat` 估計 `bid` 成立的機率：自己的骰子是確定的，其他人的照機率算；
    /// 別人這輪喊過這個點數，就當他手上大概多 `trust` 顆
    fn belief(&self, seat: usize, bid: Bid, trust: f64) -> f64 {
        let wild = self.wild_now() && bid.face != 1;
        let mine = &self.dice[seat];
        let known = mine.iter().filter(|&&d| d == bid.face || (wild && d == 1)).count();
        let unknown = self.total_dice().saturating_sub(mine.len());
        let p = if wild { 1.0 / 3.0 } else { 1.0 / 6.0 };
        let mut hint = 0.0;
        let mut counted = vec![false; self.n()];
        for &(s, b) in &self.bids {
            if s != seat && b.face == bid.face && !counted[s] {
                counted[s] = true;
                hint += trust.min(self.sizes[s] as f64);
            }
        }
        chance(unknown, p, f64::from(bid.count) - known as f64 - hint)
    }

    /// 電腦要喊什麼或開。只用到自己的骰子、每個人剩幾顆和這輪喊過的（公開資訊）。
    fn bot_decide(&self, seat: usize, persona: Persona, rng: &mut Rng) -> Move {
        let style = persona.style();
        let total = self.total_dice();
        let mins = self.min_counts();
        let bluffing = rng.chance(style.bluff);
        // 每個點數從最少能喊的個數往上看兩格，挑「成立機率高、加得少」的
        let mut best: Option<(f64, f64, Bid)> = None;
        for face in 1..=6u8 {
            let Some(min) = mins[usize::from(face) - 1] else { continue };
            let wild = self.wild_now() && face != 1;
            let have = self.dice[seat].iter().filter(|&&d| d == face || (wild && d == 1)).count();
            for count in min..=(min + 2).min(total) {
                let bid = Bid { count: count as u8, face };
                let b = self.belief(seat, bid, style.trust);
                let mut score = b - 0.05 * (count - min) as f64 + rng.range(-style.noise, style.noise);
                // 虛張聲勢：故意喊自己沒有的點數，讓下一個人以為我很多
                if bluffing && have == 0 {
                    score += 0.3;
                }
                if best.is_none_or(|(s, _, _)| score > s) {
                    best = Some((score, b, bid));
                }
            }
        }
        let Some((_, current)) = self.current() else {
            // 起叫一定喊得出來（最少個數不超過場上骰子的一半）
            return best.map_or(Move::Open, |(_, _, bid)| Move::Bid(bid));
        };
        let Some((_, raise_belief, bid)) = best else { return Move::Open };
        let holds = self.belief(seat, current, style.trust);
        if holds < style.doubt {
            return Move::Open;
        }
        // 開：現在的喊價不成立就贏。往上喊：自己喊的成立就安全，不成立也可能下一個人沒開、風險傳下去
        let raise = raise_belief + (1.0 - raise_belief) * style.hope;
        if (1.0 - holds) + style.open_bias + rng.range(-style.noise, style.noise) > raise {
            Move::Open
        } else {
            Move::Bid(bid)
        }
    }
}

impl PartyGame for LiarsDice {
    const ID: &'static str = "liarsdice";
    const MIN_PLAYERS: usize = 2;
    const MAX_PLAYERS: usize = 10;
    const MAX_BOTS: usize = 9;

    type Options = Options;
    type Action = Action;

    fn rooms(state: &AppState) -> &Arc<Parties<Self>> {
        &state.liarsdice
    }

    fn check_options(options: Options) -> Result<Options, String> {
        if !THINK_CHOICES.contains(&options.think_secs) {
            return Err("思考時間只能選不限、15、30 或 60 秒".into());
        }
        if !ROUND_CHOICES.contains(&options.rounds) {
            return Err("輪數只能選 5、10、15 或 20 輪".into());
        }
        Ok(options)
    }

    fn start(options: &Options, previous: Option<&Self>, ctx: &mut Ctx) -> Self {
        let n = ctx.seats.len();
        let mut game = Self {
            options: options.clone(),
            pids: ctx.seats.iter().map(|s| s.pid).collect(),
            names: ctx.seats.iter().map(|s| s.name.clone()).collect(),
            bots: ctx.seats.iter().map(|s| s.bot).collect(),
            online: ctx.seats.iter().map(|s| s.online).collect(),
            personas: ctx.seats.iter().map(|s| Persona::of_bot(&s.name, s.pid)).collect(),
            sizes: vec![START_DICE; n],
            dice: vec![Vec::new(); n],
            rolls: vec![0; n],
            rerolled: vec![false; n],
            stage: Stage::Rolling,
            round: 0,
            starter: ctx.rng.below(n),
            turn: None,
            bids: Vec::new(),
            ones_called: false,
            acted: vec![false; n],
            stage_until: None,
            turn_started: ctx.now,
            deadline: None,
            bot_at: None,
            reveal: None,
            ready: vec![false; n],
            cups: vec![0; n],
            busted: Vec::new(),
            log: VecDeque::new(),
            outcome: None,
            totals: previous.map(|p| p.totals.clone()).unwrap_or_default(),
            game: previous.map_or(1, |p| p.game + 1),
        };
        let mode = match options.mode {
            Mode::Elimination => "淘汰制，輸的人少一顆骰子".to_string(),
            Mode::Points => format!("計分制，打 {} 輪，輸一次喝一杯", options.rounds),
        };
        ctx.system(To::All, format!("第 {} 局開始：{mode}", game.game));
        game.start_round(ctx);
        game
    }

    fn act(&mut self, seat: usize, action: Action, ctx: &mut Ctx) -> Result<(), String> {
        if self.stage == Stage::End {
            return Err("這局已經結束了".into());
        }
        match action {
            Action::Ready => {
                if self.stage != Stage::Reveal {
                    return Err("現在不是揭曉的時候".into());
                }
                self.ready[seat] = true;
                if self.everyone_ready() {
                    self.after_reveal(ctx);
                }
            }
            Action::Reroll => {
                if !self.options.scatter {
                    return Err("這局沒有開放散骰重搖".into());
                }
                if !self.alive(seat) {
                    return Err("你已經出局了".into());
                }
                if !matches!(self.stage, Stage::Rolling | Stage::Bidding) {
                    return Err("現在不能重搖".into());
                }
                if self.acted[seat] {
                    return Err("這輪喊過之後就不能重搖了".into());
                }
                if !is_scatter(&self.dice[seat]) {
                    return Err("五顆骰子點數全不同（散骰）才能重搖".into());
                }
                self.reroll(seat, ctx);
            }
            Action::Bid { count, face } => {
                if self.stage != Stage::Bidding || self.turn != Some(seat) {
                    return Err("還沒輪到你".into());
                }
                let bid = Bid { count, face };
                self.check_bid(bid)?;
                self.place_bid(seat, bid, false, ctx);
            }
            Action::Open => {
                if self.stage != Stage::Bidding || self.turn != Some(seat) {
                    return Err("還沒輪到你".into());
                }
                if self.current().is_none() {
                    return Err("還沒有人喊，你要先喊".into());
                }
                self.open(seat, false, ctx);
            }
        }
        Ok(())
    }

    fn tick(&mut self, ctx: &mut Ctx) {
        match self.stage {
            Stage::End => {}
            Stage::Rolling => {
                if self.stage_until.is_some_and(|t| ctx.now >= t) {
                    self.begin_bidding(ctx);
                }
            }
            Stage::Reveal => {
                if self.stage_until.is_some_and(|t| ctx.now >= t) || self.everyone_ready() {
                    self.after_reveal(ctx);
                }
            }
            Stage::Bidding => {
                let Some(seat) = self.turn else { return };
                if self.bot_at.is_some_and(|t| ctx.now >= t) {
                    self.bot_at = None;
                    self.bot_play(seat, false, ctx);
                } else if !self.bots[seat]
                    && !self.online[seat]
                    && ctx.now.duration_since(self.turn_started) >= OFFLINE_WAIT
                {
                    ctx.system(To::All, format!("{} 離線了，由電腦代為出手", self.names[seat]));
                    self.bot_play(seat, true, ctx);
                } else if self.deadline.is_some_and(|d| ctx.now >= d) {
                    ctx.system(To::All, format!("{} 時間到，由電腦代為出手", self.names[seat]));
                    self.bot_play(seat, true, ctx);
                }
            }
        }
    }

    fn presence(&mut self, seat: usize, online: bool, ctx: &mut Ctx) {
        self.online[seat] = online;
        if self.turn == Some(seat) {
            // 斷線的人從現在開始算等待時間
            self.turn_started = ctx.now;
        }
        ctx.changed();
    }

    fn view(&self, seat: Option<usize>, now: Instant) -> Value {
        let revealed = matches!(self.stage, Stage::Reveal | Stage::End);
        let ms = |t: Instant| t.saturating_duration_since(now).as_millis() as u64;
        let seats: Vec<Value> = (0..self.n())
            .map(|s| {
                let totals = self.totals.get(&self.pids[s]).copied().unwrap_or_default();
                json!({
                    "dice": self.sizes[s],
                    "online": self.online[s],
                    "cups": self.cups[s],
                    "wins": totals.wins,
                    "totalCups": totals.cups,
                    // 這輪最後喊的
                    "bid": self.bids.iter().rev().find(|(b, _)| *b == s).map(|(_, bid)| bid),
                    "rolls": self.rolls[s],
                    "rerolled": self.rerolled[s],
                    "ready": self.ready[s],
                })
            })
            .collect();
        let bid_json = |&(s, b): &(usize, Bid)| json!({ "seat": s, "count": b.count, "face": b.face });
        // 別人的骰子只有揭曉時才放進來（開的那一刻的骰子）
        let reveal = self.reveal.as_ref().filter(|_| revealed).map(|r| {
            json!({
                "bid": r.bid,
                "bidder": r.bidder,
                "opener": r.opener,
                "wild": r.wild,
                "hands": r.hands,
                "matched": r.matched,
                "loser": r.loser,
                "out": r.out,
                "auto": r.auto,
            })
        });
        let bidding = self.stage == Stage::Bidding;
        json!({
            "stage": self.stage,
            "game": self.game,
            "round": self.round,
            "options": self.options,
            "you": seat,
            // 自己的骰子（觀戰是 null）
            "mine": seat.map(|s| &self.dice[s]),
            "seats": seats,
            "turn": self.turn,
            "endsIn": self.deadline.filter(|_| bidding).map(ms),
            // 搖骰、揭曉還剩多久
            "nextIn": self.stage_until.map(ms),
            "bid": self.current().as_ref().map(bid_json),
            "history": self.bids.iter().map(bid_json).collect::<Vec<_>>(),
            "minCounts": if bidding { self.min_counts() } else { [None; 6] },
            "minOpen": self.min_open(),
            "total": self.total_dice(),
            "wild": self.wild_now(),
            "onesCalled": self.ones_called,
            "canReroll": seat.is_some_and(|s| self.can_reroll(s)),
            "reveal": reveal,
            "final": revealed && self.over(),
            "log": self.log,
            "result": self.outcome.as_ref().map(|o| json!({ "ranking": o.ranking, "winners": o.winners })),
        })
    }

    fn finished(&self) -> bool {
        self.stage == Stage::End
    }

    fn bot_name(n: usize) -> String {
        BOT_PERSONAS[(n - 1) % BOT_PERSONAS.len()].1.to_owned()
    }
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Action {
    /// 喊「`count` 個 `face`」
    Bid { count: u8, face: u8 },
    /// 開：掀開來數
    Open,
    /// 散骰重搖
    Reroll,
    /// 揭曉看完了
    Ready,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::party::{Outbox, SeatInfo, test_ctx};

    fn seats(n: usize, bots: usize) -> Vec<SeatInfo> {
        (0..n)
            .map(|i| {
                let bot = i >= n - bots;
                let name = if bot { LiarsDice::bot_name(i + 1) } else { format!("P{i}") };
                SeatInfo { pid: i as u32 + 1, name, bot, online: true }
            })
            .collect()
    }

    fn dice(text: &str) -> Vec<u8> {
        let mut d: Vec<u8> = text.chars().map(|c| c.to_digit(10).expect("digit") as u8).collect();
        d.sort_unstable();
        d
    }

    fn bid(count: u8, face: u8) -> Action {
        Action::Bid { count, face }
    }

    struct Table {
        g: LiarsDice,
        seats: Vec<SeatInfo>,
        rng: Rng,
        now: Instant,
    }

    impl Table {
        /// 開一局（沒有電腦），從 `starter` 開始喊，搖完骰子直接進到喊價
        fn new(n: usize, starter: usize, options: Options) -> Self {
            Self::with_seats(seats(n, 0), starter, options)
        }

        fn with_seats(seats: Vec<SeatInfo>, starter: usize, options: Options) -> Self {
            let mut rng = Rng::new();
            let now = Instant::now();
            let mut out = Outbox::default();
            let g = LiarsDice::start(&options, None, &mut test_ctx(now, &mut rng, &seats, &mut out));
            let mut t = Self { g, seats, rng, now };
            t.g.starter = starter;
            t.g.round = 0;
            t.with(|g, ctx| g.start_round(ctx));
            t.wait(ROLL_TIME);
            assert_eq!(t.g.stage, Stage::Bidding);
            t
        }

        fn with<R>(&mut self, f: impl FnOnce(&mut LiarsDice, &mut Ctx) -> R) -> R {
            let mut out = Outbox::default();
            let mut ctx = test_ctx(self.now, &mut self.rng, &self.seats, &mut out);
            f(&mut self.g, &mut ctx)
        }

        fn act(&mut self, seat: usize, action: Action) -> Result<(), String> {
            self.with(|g, ctx| g.act(seat, action, ctx))
        }

        fn ok(&mut self, seat: usize, action: Action) {
            assert_eq!(self.g.turn, Some(seat), "應該輪到 {seat}；紀錄：{:?}", self.g.log);
            self.act(seat, action).unwrap_or_else(|e| panic!("座位 {seat}：{e}"));
        }

        fn wait(&mut self, d: Duration) {
            self.now += d;
            self.with(|g, ctx| g.tick(ctx));
        }

        /// 指定這輪每個人的骰子（也決定每個人有幾顆）
        fn rig(&mut self, hands: &[&str]) {
            self.g.dice = hands.iter().map(|h| dice(h)).collect();
            self.g.sizes = self.g.dice.iter().map(Vec::len).collect();
        }
    }

    fn opts() -> Options {
        Options { think_secs: 0, ..Options::default() }
    }

    #[test]
    fn bid_order() {
        let b = |count, face| Bid { count, face };
        // 一點萬用：一點最大
        assert!(b(3, 6).beats(b(3, 5), true));
        assert!(b(3, 1).beats(b(3, 6), true));
        assert!(!b(3, 2).beats(b(3, 1), true));
        assert!(b(4, 2).beats(b(3, 1), true));
        assert!(!b(3, 5).beats(b(3, 5), true));
        // 不萬用：照數字
        assert!(!b(3, 1).beats(b(3, 6), false));
        assert!(b(3, 2).beats(b(3, 1), false));
        assert!(!b(2, 6).beats(b(3, 1), false));
    }

    #[test]
    fn opening_minimum() {
        let mut t = Table::new(3, 0, opts());
        assert_eq!(t.g.min_open(), 4, "3 人：人數 + 1");
        t.g.options.opening = Opening::Players;
        assert_eq!(t.g.min_open(), 3);
        t.g.options.opening = Opening::One;
        assert_eq!(t.g.min_open(), 1);
        t.g.options.opening = Opening::PlayersPlusOne;
        // 骰子少的時候不超過一半（無條件進位）
        t.rig(&["2", "3", "4"]);
        assert_eq!(t.g.min_open(), 2);
        t.rig(&["2", "3", ""]);
        assert_eq!(t.g.min_open(), 1, "剩 2 人各 1 顆");
        assert_eq!(t.g.min_counts(), [Some(1); 6]);

        let mut t = Table::new(3, 0, opts());
        assert_eq!(t.act(0, bid(3, 5)).unwrap_err(), "起叫最少要喊 4 個");
        t.ok(0, bid(4, 5));
        // 一點最大：一點和六點同個數還能喊，其他要多一個
        assert_eq!(t.g.min_counts(), [Some(4), Some(5), Some(5), Some(5), Some(5), Some(4)]);
        assert_eq!(t.act(1, bid(4, 4)).unwrap_err(), "要喊得比 4 個 5 大");
        assert_eq!(t.act(1, bid(16, 4)).unwrap_err(), "場上只有 15 顆骰子");
        assert_eq!(t.act(1, bid(5, 7)).unwrap_err(), "點數只能是 1～6");
        t.ok(1, bid(15, 1));
        assert_eq!(t.g.min_counts(), [None; 6], "喊到頂了只能開");
    }

    #[test]
    fn wild_ones_count_for_other_faces() {
        let mut t = Table::new(3, 0, opts());
        t.rig(&["11234", "24456", "13366"]);
        // 四點：本身 3 顆 + 萬用的一點 3 顆 = 6
        t.ok(0, bid(6, 4));
        t.ok(1, Action::Open);
        let r = t.g.reveal.clone().unwrap();
        assert!(r.wild);
        assert_eq!(r.matched, 6);
        assert_eq!(r.loser, 1, "剛好 6 個，喊的成立，開的人輸");
        assert_eq!(t.g.sizes, vec![5, 4, 5]);
        assert_eq!(t.g.starter, 1, "輸的人下一輪先喊");
        assert_eq!(t.g.stage, Stage::Reveal);
    }

    #[test]
    fn bidding_too_high_loses() {
        let mut t = Table::new(3, 2, opts());
        t.rig(&["11234", "24456", "13366"]);
        // 六點：本身 3 顆 + 一點 3 顆 = 6，喊 7 個不成立
        t.ok(2, bid(7, 6));
        t.ok(0, Action::Open);
        let r = t.g.reveal.clone().unwrap();
        assert_eq!((r.matched, r.loser, r.bidder, r.opener), (6, 2, 2, 0));
        assert_eq!(t.g.cups, vec![0, 0, 1]);
        assert_eq!(t.g.starter, 2);
    }

    #[test]
    fn calling_ones_turns_off_wild() {
        let mut t = Table::new(3, 0, opts());
        t.rig(&["11234", "24456", "13366"]);
        t.ok(0, bid(4, 1));
        assert!(t.g.ones_called && !t.g.wild_now());
        // 喊過一點之後，四點只數四點：3 顆
        t.ok(1, bid(5, 4));
        t.ok(2, Action::Open);
        let r = t.g.reveal.clone().unwrap();
        assert!(!r.wild);
        assert_eq!((r.matched, r.loser), (3, 1));

        // 關掉「喊過一點就不萬用」：一點一直萬用
        let mut t = Table::new(3, 0, Options { ones_lock: false, ..opts() });
        t.rig(&["11234", "24456", "13366"]);
        t.ok(0, bid(4, 1));
        assert!(t.g.wild_now());
        t.ok(1, bid(5, 4));
        t.ok(2, Action::Open);
        let r = t.g.reveal.clone().unwrap();
        assert_eq!((r.matched, r.loser), (6, 2));

        // 喊一點的時候只數一點
        let mut t = Table::new(3, 0, opts());
        t.rig(&["11234", "24456", "13366"]);
        t.ok(0, bid(4, 1));
        t.ok(1, Action::Open);
        let r = t.g.reveal.clone().unwrap();
        assert_eq!((r.matched, r.loser), (3, 0));

        // 一點不萬用：一點最小，只數本身
        let mut t = Table::new(3, 0, Options { wild_ones: false, ..opts() });
        t.rig(&["11234", "24456", "13366"]);
        t.ok(0, bid(4, 6));
        assert_eq!(t.act(1, bid(4, 1)).unwrap_err(), "要喊得比 4 個 6 大");
        t.ok(1, Action::Open);
        let r = t.g.reveal.clone().unwrap();
        assert_eq!((r.wild, r.matched, r.loser), (false, 3, 0));
    }

    #[test]
    fn rejects_out_of_turn_and_early_open() {
        let mut t = Table::new(3, 1, opts());
        assert_eq!(t.act(0, bid(4, 2)).unwrap_err(), "還沒輪到你");
        assert_eq!(t.act(1, Action::Open).unwrap_err(), "還沒有人喊，你要先喊");
        assert_eq!(t.act(1, Action::Ready).unwrap_err(), "現在不是揭曉的時候");
        t.ok(1, bid(4, 2));
        assert_eq!(t.act(1, bid(5, 2)).unwrap_err(), "還沒輪到你");
        assert_eq!(t.g.turn, Some(2));
    }

    #[test]
    fn elimination_until_one_is_left() {
        let mut t = Table::new(3, 0, opts());
        t.rig(&["11234", "6", ""]);
        t.g.busted = vec![2];
        assert_eq!(t.g.next_alive(1), 0, "出局的人跳過");
        t.ok(0, bid(3, 6));
        // 六點 1 顆 + 一點 2 顆 = 3，成立
        t.ok(1, Action::Open);
        let r = t.g.reveal.clone().unwrap();
        assert!(r.out);
        assert_eq!(t.g.sizes, vec![5, 0, 0]);
        assert_eq!(t.g.starter, 0, "輸的人出局了，換下一位");
        assert!(!t.g.finished(), "揭曉完才結算");
        assert!(t.g.view(None, t.now)["final"].as_bool().unwrap());
        t.wait(REVEAL_TIME);
        assert!(t.g.finished());
        let o = t.g.outcome.clone().unwrap();
        assert_eq!(o.ranking, vec![0, 1, 2]);
        assert_eq!(o.winners, vec![0]);
        assert_eq!(t.g.totals[&1].wins, 1);
        assert_eq!(t.g.totals[&2].cups, 1);
        assert_eq!(t.act(0, bid(1, 2)).unwrap_err(), "這局已經結束了");
    }

    #[test]
    fn points_mode_plays_a_fixed_number_of_rounds() {
        let options = Options { mode: Mode::Points, rounds: 5, ..opts() };
        let mut t = Table::new(2, 0, options);
        for round in 1..=5 {
            assert_eq!(t.g.round, round);
            let opener = t.g.turn.unwrap();
            let other = 1 - opener;
            // 喊到最大（10 個一點）一定不成立（除非 10 顆全是一點）
            t.rig(&["23456", "23456"]);
            t.ok(opener, bid(10, 1));
            t.ok(other, Action::Open);
            assert_eq!(t.g.reveal.as_ref().unwrap().loser, opener);
            assert_eq!(t.g.sizes, vec![5, 5], "計分制不會少骰子");
            t.wait(REVEAL_TIME);
            if round < 5 {
                assert_eq!(t.g.stage, Stage::Rolling);
                t.wait(ROLL_TIME);
                assert_eq!(t.g.turn, Some(opener), "輸的人先喊");
            }
        }
        assert!(t.g.finished());
        assert_eq!(t.g.cups.iter().sum::<u32>(), 5);
        let o = t.g.outcome.clone().unwrap();
        // 座位 0 一直輸
        assert_eq!(t.g.cups, vec![5, 0]);
        assert_eq!(o.winners, vec![1]);
        assert_eq!(o.ranking, vec![1, 0]);

        // 同杯數一起贏
        let mut t = Table::new(3, 0, Options { mode: Mode::Points, rounds: 5, ..opts() });
        t.g.cups = vec![2, 1, 1];
        t.g.round = 5;
        t.with(|g, ctx| g.finish(ctx));
        assert_eq!(t.g.outcome.clone().unwrap().winners, vec![1, 2]);
    }

    #[test]
    fn scatter_can_be_rerolled_before_acting() {
        let mut t = Table::new(2, 0, opts());
        t.rig(&["12346", "11234"]);
        assert!(t.g.can_reroll(0));
        assert_eq!(t.act(1, Action::Reroll).unwrap_err(), "五顆骰子點數全不同（散骰）才能重搖");
        let rolls = t.g.rolls[0];
        t.act(0, Action::Reroll).unwrap();
        assert_eq!(t.g.rolls[0], rolls + 1);
        assert_eq!(t.g.dice[0].len(), 5);
        assert!(t.g.rerolled[0]);

        t.rig(&["12346", "11234"]);
        t.ok(0, bid(3, 2));
        assert_eq!(t.act(0, Action::Reroll).unwrap_err(), "這輪喊過之後就不能重搖了");

        // 不滿五顆不算散骰
        assert!(!is_scatter(&dice("1234")));
        assert!(is_scatter(&dice("23456")));
        assert!(!is_scatter(&dice("22345")));

        let mut t = Table::new(2, 0, Options { scatter: false, ..opts() });
        t.rig(&["12346", "11234"]);
        assert_eq!(t.act(0, Action::Reroll).unwrap_err(), "這局沒有開放散骰重搖");
    }

    #[test]
    fn views_hide_other_dice_until_the_reveal() {
        let mut t = Table::new(3, 0, opts());
        t.rig(&["11234", "24456", "13366"]);
        t.ok(0, bid(4, 4));
        for seat in [Some(0), Some(1), Some(2), None] {
            let v = t.g.view(seat, t.now);
            assert!(v["reveal"].is_null());
            let mine: Option<Vec<u8>> = serde_json::from_value(v["mine"].clone()).unwrap();
            assert_eq!(mine, seat.map(|s| t.g.dice[s].clone()));
            // 座位資訊只有骰子數，沒有點數
            for s in v["seats"].as_array().unwrap() {
                assert!(s["dice"].is_u64());
                assert!(s.get("hand").is_none());
            }
            let text = v.to_string();
            assert!(!text.contains("hands"), "{text}");
        }
        t.ok(1, Action::Open);
        let v = t.g.view(None, t.now);
        let hands: Vec<Vec<u8>> = serde_json::from_value(v["reveal"]["hands"].clone()).unwrap();
        assert_eq!(hands, vec![dice("11234"), dice("24456"), dice("13366")]);
        // 下一輪重搖之後揭曉的內容就拿掉了
        t.wait(REVEAL_TIME);
        assert_eq!(t.g.stage, Stage::Rolling);
        assert!(t.g.view(Some(0), t.now)["reveal"].is_null());
    }

    #[test]
    fn everyone_ready_skips_the_reveal() {
        let mut t = Table::new(2, 0, opts());
        t.ok(0, bid(3, 2));
        t.ok(1, Action::Open);
        t.act(0, Action::Ready).unwrap();
        assert_eq!(t.g.stage, Stage::Reveal);
        t.act(1, Action::Ready).unwrap();
        assert_eq!(t.g.stage, Stage::Rolling);
    }

    #[test]
    fn timeout_and_disconnect_play_for_you() {
        let mut t = Table::new(3, 0, Options { think_secs: 15, ..opts() });
        t.wait(Duration::from_secs(14));
        assert!(t.g.bids.is_empty());
        t.wait(Duration::from_secs(1));
        assert_eq!(t.g.bids.len(), 1, "時間到由電腦代喊（第一手不能開）");
        assert!(t.g.log.back().unwrap().contains("電腦代喊"));
        assert_eq!(t.g.turn, Some(1));

        t.with(|g, ctx| g.presence(1, false, ctx));
        t.wait(Duration::from_secs(4));
        assert_eq!(t.g.turn, Some(1));
        t.wait(Duration::from_secs(1));
        assert!(t.g.turn != Some(1), "斷線 5 秒由電腦代為出手");
    }

    #[test]
    fn belief_is_sane() {
        let mut t = Table::new(2, 0, opts());
        t.rig(&["11666", "23456"]);
        let b = |count, face| Bid { count, face };
        assert_eq!(t.g.belief(0, b(5, 6), 0.0), 1.0, "自己就有 5 顆（含萬用）");
        assert_eq!(t.g.belief(0, b(11, 6), 0.0), 0.0, "超過場上的骰子");
        let low = t.g.belief(0, b(9, 2), 0.0);
        let high = t.g.belief(0, b(3, 2), 0.0);
        assert!(low < 0.01 && high > 0.6, "{low} {high}");
        // 別人喊過，比較相信
        t.ok(0, bid(3, 2));
        t.ok(1, bid(4, 5));
        assert!(t.g.belief(0, b(5, 5), 0.7) > t.g.belief(0, b(5, 5), 0.0));
        assert!((at_least(10, 0.5, 5) - 0.623).abs() < 0.001);
    }

    #[test]
    fn bots_get_their_names_and_personas() {
        let seats = seats(5, 4);
        assert_eq!(seats[1].name, "唬爛王");
        let mut rng = Rng::new();
        let mut out = Outbox::default();
        let g = LiarsDice::start(&opts(), None, &mut test_ctx(Instant::now(), &mut rng, &seats, &mut out));
        assert_eq!(g.personas[1..], [Persona::Bluffer, Persona::Counter, Persona::Trusting, Persona::Steady]);
        assert_eq!(Persona::of_bot("穩健阿伯 2", 9), Persona::Steady);
    }

    #[test]
    fn totals_carry_over_to_the_next_game() {
        let mut t = Table::new(2, 0, opts());
        t.rig(&["6", "5"]);
        t.ok(0, bid(1, 3));
        t.ok(1, Action::Open);
        t.wait(REVEAL_TIME);
        assert!(t.g.finished());
        let mut out = Outbox::default();
        let next = LiarsDice::start(&opts(), Some(&t.g), &mut test_ctx(t.now, &mut t.rng, &t.seats, &mut out));
        assert_eq!(next.game, 2);
        assert_eq!(next.totals[&2].wins, 1);
        assert_eq!(next.totals[&1].cups, 1);
        assert_eq!(next.sizes, vec![5, 5]);
        let v = next.view(Some(0), t.now);
        assert_eq!(v["seats"][1]["wins"], 1);
        assert_eq!(v["seats"][0]["totalCups"], 1);
        assert_eq!(v["seats"][0]["cups"], 0);
    }

    /// 跑到結束：電腦自己出手，時間一直往前走
    fn run_bots(g: &mut LiarsDice, seats: &[SeatInfo], rng: &mut Rng, mut now: Instant) -> Instant {
        for _ in 0..100_000 {
            if g.finished() {
                break;
            }
            now += Duration::from_millis(500);
            let before = g.total_dice();
            let mut out = Outbox::default();
            g.tick(&mut test_ctx(now, rng, seats, &mut out));
            assert!(g.total_dice() <= before, "骰子只會變少");
            if matches!(g.stage, Stage::Rolling | Stage::Bidding) {
                for (s, d) in g.dice.iter().enumerate() {
                    assert_eq!(d.len(), g.sizes[s]);
                }
            }
        }
        now
    }

    #[test]
    fn bots_play_whole_games() {
        let mut rng = Rng::new();
        for mode in [Mode::Elimination, Mode::Points] {
            for n in [2, 3, 6, 10] {
                let seats = seats(n, n);
                let options = Options { mode, ..Options::default() };
                let now = Instant::now();
                let mut out = Outbox::default();
                let mut g = LiarsDice::start(&options, None, &mut test_ctx(now, &mut rng, &seats, &mut out));
                run_bots(&mut g, &seats, &mut rng, now);
                assert!(g.finished(), "{mode:?} {n} 個電腦打得完（第 {} 輪）", g.round);
                let o = g.outcome.as_ref().unwrap();
                assert_eq!(o.ranking.len(), n);
                match mode {
                    Mode::Elimination => {
                        assert_eq!(g.alive_count(), 1);
                        assert!(g.alive(o.winners[0]));
                        assert_eq!(g.cups.iter().sum::<u32>() as usize, n * START_DICE - g.total_dice());
                    }
                    Mode::Points => {
                        assert_eq!(g.round, 10);
                        assert_eq!(g.cups.iter().sum::<u32>(), 10);
                        assert_eq!(g.total_dice(), n * START_DICE);
                    }
                }
            }
        }
    }

    /// 一局一對一：`name` 的電腦對上「只會往上喊、從來不開」的人（挑手上最多的點數，喊最少能喊的個數）。電腦贏了回傳 true
    fn versus_raiser(name: &str, raiser: usize, rng: &mut Rng) -> bool {
        let seats: Vec<SeatInfo> = (0..2)
            .map(|s| {
                let bot = s != raiser;
                let name = if bot { name.to_owned() } else { "莽夫".to_owned() };
                SeatInfo { pid: s as u32 + 1, name, bot, online: true }
            })
            .collect();
        let mut now = Instant::now();
        let mut out = Outbox::default();
        let mut g = LiarsDice::start(&opts(), None, &mut test_ctx(now, rng, &seats, &mut out));
        for _ in 0..100_000 {
            if g.finished() {
                break;
            }
            now += Duration::from_millis(500);
            let mut out = Outbox::default();
            let mut ctx = test_ctx(now, rng, &seats, &mut out);
            if g.stage == Stage::Bidding && g.turn == Some(raiser) {
                let mins = g.min_counts();
                let have = |f: u8| count_matching(&[g.dice[raiser].clone()], f, g.wild_now() && f != 1);
                let choice = (1..=6u8)
                    .filter_map(|f| mins[usize::from(f) - 1].map(|m| (f, m)))
                    .max_by_key(|&(f, m)| (have(f), std::cmp::Reverse(m)));
                match choice {
                    Some((face, count)) => g.act(raiser, bid(count as u8, face), &mut ctx).unwrap(),
                    None => g.act(raiser, Action::Open, &mut ctx).unwrap(),
                }
            } else {
                g.tick(&mut ctx);
            }
        }
        assert!(g.finished());
        g.outcome.as_ref().unwrap().winners[0] != raiser
    }

    /// 電腦對上只會往上喊的人要贏多輸少（四種個性輪流上）
    #[test]
    fn bots_beat_a_reckless_raiser() {
        let mut rng = Rng::new();
        let games = 80;
        let wins = (0..games).filter(|&i| versus_raiser(&LiarsDice::bot_name(i + 1), i % 2, &mut rng)).count();
        eprintln!("電腦對只會往上喊的人：{wins}/{games}");
        assert!(wins * 100 >= games * 80, "只贏了 {wins}/{games}");
    }

    /// 調整電腦用：`cargo test --lib liarsdice::tests::bot_stats -- --ignored --nocapture`
    /// 印出每種個性對只會往上喊的人的勝率，以及四種個性同桌時的勝場、開的次數和開對的比例
    #[test]
    #[ignore]
    fn bot_stats() {
        let mut rng = Rng::new();
        for (k, (persona, name)) in BOT_PERSONAS.iter().enumerate() {
            let games = 400;
            let wins = (0..games).filter(|&i| versus_raiser(name, (i + k) % 2, &mut rng)).count();
            eprintln!("{persona:?} 對只會往上喊的人：{wins}/{games}");
        }
        let (mut wins, mut opens, mut right) = ([0; 4], [0; 4], [0; 4]);
        let (mut rounds, mut bids) = (0, 0);
        // 照個性統計（每局換座位，不受坐在誰後面影響）
        let kind = |g: &LiarsDice, s: usize| BOT_PERSONAS.iter().position(|(p, _)| *p == g.personas[s]).unwrap();
        for game in 0..400 {
            let mut seats = seats(4, 4);
            seats.rotate_left(game % 4);
            if game % 8 >= 4 {
                seats.swap(1, 2);
            }
            let mut now = Instant::now();
            let mut out = Outbox::default();
            let mut g = LiarsDice::start(&opts(), None, &mut test_ctx(now, &mut rng, &seats, &mut out));
            for _ in 0..100_000 {
                if g.finished() {
                    break;
                }
                now += Duration::from_millis(500);
                let before = g.stage;
                let mut out = Outbox::default();
                g.tick(&mut test_ctx(now, &mut rng, &seats, &mut out));
                if before == Stage::Bidding && g.stage == Stage::Reveal {
                    let r = g.reveal.as_ref().unwrap();
                    opens[kind(&g, r.opener)] += 1;
                    if r.loser != r.opener {
                        right[kind(&g, r.opener)] += 1;
                    }
                    rounds += 1;
                    bids += g.bids.len();
                }
            }
            for &w in &g.outcome.as_ref().unwrap().winners {
                wins[kind(&g, w)] += 1;
            }
        }
        for (s, (persona, _)) in BOT_PERSONAS.iter().enumerate() {
            eprintln!(
                "{persona:?}：贏 {} 局，開 {} 次，開對 {:.0}%",
                wins[s],
                opens[s],
                100.0 * right[s] as f64 / opens[s] as f64
            );
        }
        eprintln!("平均每輪喊 {:.1} 次", bids as f64 / rounds as f64);
    }
}
