//! 德州撲克（無限注，派對房間，房間本身見 `party.rs`）。2～9 個座位，人不夠由電腦補。只有遊戲籌碼，沒有真錢。
//!
//! 一「局」是一整場牌局：一手接一手自動打下去，直到只剩一個人有籌碼，或打滿房主設定的手數（籌碼最多的人贏），
//! 房主也可以隨時中止。輸光的人留在桌邊觀戰到這局結束。
//!
//! 規則：
//! - 每手按鈕（莊家）往左移到下一個還有籌碼的人；按鈕左邊是小盲、再左邊是大盲。
//!   兩個人（單挑）時按鈕下小盲、翻牌前先行動，翻牌後換大盲先。
//! - 翻牌前、翻牌、轉牌、河牌四輪下注：棄牌、過牌、跟注、下注／加注、全下。
//!   最小下注是一個大盲；加注至少要加「上一次完整加注的幅度」。全下不足一次完整加注時，
//!   已經行動過的人只能跟注或棄牌（除非累積起來已經是一次完整加注）。
//! - 有人全下時分成主池和邊池，每個池只有投入夠多的人能贏；沒人跟的那部分下注直接退回。
//! - 攤牌比 7 張裡最好的 5 張；平手平分，除不盡的籌碼從按鈕左邊開始一人一枚。
//! - 攤牌只公開需要亮的牌：全下沒人能再下注時大家都亮；否則河牌最後下注（被跟注）的人和贏家亮，其他人蓋牌。
//!   棄牌的牌永遠不公開，手牌結束後自己可以選擇亮牌。
//! - 時間到或斷線（等 5 秒）：能過牌就過牌，不然棄牌。
//!
//! 每個人的 view 只有自己的手牌，別人的手牌只有被公開時才會送出去。
//! 電腦玩家只看得到自己的牌和公開資訊：用蒙地卡羅模擬（隨機發剩下的牌給對手和公牌）估勝率，
//! 再照底池賠率決定跟不跟、勝率夠高就加注，偶爾詐唬。

use std::{collections::HashMap, sync::Arc, time::Duration};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::time::Instant;

use crate::{
    AppState,
    party::{Ctx, Parties, PartyGame, Rng, To, shuffle},
};

/// 0～51：`點數 * 4 + 花色`，點數 0 是 2、12 是 A；花色 0 ♣、1 ♦、2 ♥、3 ♠（花色不分大小）
pub type Card = u8;

pub fn rank(card: Card) -> u8 {
    card / 4
}

pub fn suit(card: Card) -> u8 {
    card % 4
}

const RANK_NAMES: [&str; 13] = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
const SUIT_NAMES: [&str; 4] = ["♣", "♦", "♥", "♠"];

pub fn card_name(card: Card) -> String {
    format!("{}{}", SUIT_NAMES[usize::from(suit(card))], RANK_NAMES[usize::from(rank(card))])
}

const MAX_SEATS: usize = 9;
/// 輪到斷線的人：等這麼久就自動過牌或棄牌
const OFFLINE_WAIT: Duration = Duration::from_secs(5);
/// 一手結束後停多久再發下一手（有攤牌的話久一點，讓大家看清楚）
const SHOWDOWN_PAUSE: Duration = Duration::from_secs(6);
const FOLD_PAUSE: Duration = Duration::from_secs(3);
/// 全下之後一張一張發完公牌，每條街之間停一下
const RUNOUT_PAUSE: Duration = Duration::from_millis(1400);
/// 行動紀錄最多留幾行（跨手）
const LOG_LINES: usize = 80;
/// 電腦估勝率時模擬幾次
const SIMULATIONS: usize = 300;

/// 盲注每升一級，大盲是原本的幾倍
const LEVELS: [u32; 15] = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 100, 150, 200];

pub const CHIP_CHOICES: [u32; 5] = [500, 1000, 2000, 5000, 10000];
pub const BLIND_CHOICES: [u32; 5] = [10, 20, 50, 100, 200];
pub const BLIND_UP_CHOICES: [u32; 4] = [0, 5, 10, 20];
pub const HAND_LIMIT_CHOICES: [u32; 4] = [0, 30, 50, 100];
pub const THINK_CHOICES: [u16; 4] = [0, 15, 30, 60];

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Options {
    /// 每個人開局的籌碼
    pub chips: u32,
    /// 大盲（小盲是一半）
    pub big_blind: u32,
    /// 每幾手升一次盲注，0 是不升
    pub blind_up: u32,
    /// 最多打幾手，0 是打到只剩一個人有籌碼
    pub hand_limit: u32,
    /// 每次行動的思考秒數，0 是不限
    pub think_secs: u16,
}

impl Default for Options {
    fn default() -> Self {
        Self { chips: 1000, big_blind: 20, blind_up: 10, hand_limit: 0, think_secs: 30 }
    }
}

// ---- 牌力 ----

/// 牌型；宣告順序就是大小順序（皇家同花順只是最大的同花順）
#[derive(Serialize, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
#[serde(rename_all = "camelCase")]
pub enum Category {
    HighCard,
    Pair,
    TwoPair,
    Trips,
    Straight,
    Flush,
    FullHouse,
    Quads,
    StraightFlush,
}

const CATEGORIES: [Category; 9] = [
    Category::HighCard,
    Category::Pair,
    Category::TwoPair,
    Category::Trips,
    Category::Straight,
    Category::Flush,
    Category::FullHouse,
    Category::Quads,
    Category::StraightFlush,
];

impl Category {
    pub fn label(self) -> &'static str {
        match self {
            Category::HighCard => "高牌",
            Category::Pair => "一對",
            Category::TwoPair => "兩對",
            Category::Trips => "三條",
            Category::Straight => "順子",
            Category::Flush => "同花",
            Category::FullHouse => "葫蘆",
            Category::Quads => "鐵支",
            Category::StraightFlush => "同花順",
        }
    }
}

/// 一手牌的強度，數字越大越大，相等就是平手。
/// 編碼：`牌型 << 20`，再接五個 4 位元的點數（由重要到不重要：例如兩對是大對、小對、踢腳）。
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub struct Strength(u32);

impl Strength {
    fn new(category: Category, ranks: &[u8]) -> Self {
        let mut value = (category as u32) << 20;
        for (i, &r) in ranks.iter().take(5).enumerate() {
            value |= u32::from(r) << (16 - 4 * i);
        }
        Self(value)
    }

    pub fn category(self) -> Category {
        CATEGORIES[(self.0 >> 20) as usize]
    }

    /// 給人看的名稱：「兩對」「順子」，A 開頭的同花順叫「皇家同花順」
    pub fn label(self) -> &'static str {
        if self.category() == Category::StraightFlush && (self.0 >> 16) & 0xF == 12 {
            "皇家同花順"
        } else {
            self.category().label()
        }
    }
}

/// 點數位元（bit r 是點數 r）裡最大的順子頂端；A 也可以當 1（A2345 的頂端是 5，也就是點數 3）
fn straight_top(mask: u16) -> Option<u8> {
    // 往左移一格，最低位補「有沒有 A」：bit i 代表點數 i - 1，bit 0 是當 1 用的 A
    let wide = (u32::from(mask) << 1) | u32::from((mask >> 12) & 1);
    (4..=13).rev().find(|&top| (wide >> (top - 4)) & 0b11111 == 0b11111).map(|top| top as u8 - 1)
}

/// 從高到低列出點數位元裡的點數
fn ranks_desc(mask: u16) -> impl Iterator<Item = u8> {
    (0..13u8).rev().filter(move |&r| mask & (1 << r) != 0)
}

/// 任意張（最多 7 張、不重複）牌裡最好的 5 張的強度；不滿 5 張也能算（翻牌前的提示用），只是不會有順子、同花
pub fn evaluate(cards: &[Card]) -> Strength {
    let mut counts = [0u8; 13];
    let mut suits = [0u16; 4];
    let mut all = 0u16;
    for &c in cards {
        counts[usize::from(rank(c))] += 1;
        suits[usize::from(suit(c))] |= 1 << rank(c);
        all |= 1 << rank(c);
    }
    let flush = suits.iter().copied().find(|m| m.count_ones() >= 5);
    if let Some(top) = flush.and_then(straight_top) {
        return Strength::new(Category::StraightFlush, &[top]);
    }
    // 依張數分組（由大到小），電腦每次估勝率要算上萬次，這裡不配置記憶體
    let mut quad = None;
    let mut trips = [0u8; 2];
    let mut n_trips = 0;
    let mut pairs = [0u8; 3];
    let mut n_pairs = 0;
    for r in (0..13u8).rev() {
        match counts[usize::from(r)] {
            4 => quad = quad.or(Some(r)),
            3 if n_trips < 2 => {
                trips[n_trips] = r;
                n_trips += 1;
            }
            2 if n_pairs < 3 => {
                pairs[n_pairs] = r;
                n_pairs += 1;
            }
            _ => {}
        }
    }
    // 沒用到的點數由大到小補成踢腳
    let with_kickers = |head: &[u8], total: usize| -> ([u8; 5], usize) {
        let mut ranks = [0u8; 5];
        ranks[..head.len()].copy_from_slice(head);
        let mut len = head.len();
        for r in ranks_desc(all) {
            if len >= total {
                break;
            }
            if !head.contains(&r) {
                ranks[len] = r;
                len += 1;
            }
        }
        (ranks, len)
    };
    let make = |category: Category, head: &[u8], total: usize| {
        let (ranks, len) = with_kickers(head, total);
        Strength::new(category, &ranks[..len])
    };
    if let Some(q) = quad {
        return make(Category::Quads, &[q], 2);
    }
    // 葫蘆：最大的三條，加上剩下最大的對子（另一組三條也可以當對子）
    if n_trips >= 1 {
        let second = if n_trips == 2 { Some(trips[1]) } else { None };
        let pair = second.into_iter().chain(pairs[..n_pairs].iter().copied()).max();
        if let Some(p) = pair {
            return Strength::new(Category::FullHouse, &[trips[0], p]);
        }
    }
    if let Some(mask) = flush {
        let mut ranks = [0u8; 5];
        for (slot, r) in ranks.iter_mut().zip(ranks_desc(mask)) {
            *slot = r;
        }
        return Strength::new(Category::Flush, &ranks);
    }
    if let Some(top) = straight_top(all) {
        return Strength::new(Category::Straight, &[top]);
    }
    if n_trips >= 1 {
        return make(Category::Trips, &[trips[0]], 3);
    }
    if n_pairs >= 2 {
        // 第三對的點數也可以當踢腳
        return make(Category::TwoPair, &[pairs[0], pairs[1]], 3);
    }
    if n_pairs == 1 {
        return make(Category::Pair, &[pairs[0]], 4);
    }
    make(Category::HighCard, &[], 5)
}

/// 組成最好那手的 5 張牌（攤牌時標出來用）；不滿 5 張就全部
pub fn best_five(cards: &[Card]) -> Vec<Card> {
    let n = cards.len();
    if n <= 5 {
        return cards.to_vec();
    }
    // 最多 7 張，所有 5 張的組合只有 21 種
    (0u32..1 << n)
        .filter(|m| m.count_ones() == 5)
        .map(|m| (0..n).filter(|&i| m & (1 << i) != 0).map(|i| cards[i]).collect::<Vec<Card>>())
        .max_by_key(|five| evaluate(five))
        .unwrap_or_default()
}

// ---- 底池 ----

/// 每個人這手投入的總額（`committed`）和誰還沒棄牌（`live`），分成主池和邊池：
/// 每一層是「還沒棄牌的人投入的額度」，那一層的錢只有投入到那一層的人能贏。
/// 棄牌的人投入的錢照額度併進各層。回傳 (金額, 能贏的座位)，從主池開始。
pub fn side_pots(committed: &[u32], live: &[bool]) -> Vec<(u32, Vec<usize>)> {
    let mut levels: Vec<u32> =
        (0..committed.len()).filter(|&s| live[s] && committed[s] > 0).map(|s| committed[s]).collect();
    levels.sort_unstable();
    levels.dedup();
    let mut pots: Vec<(u32, Vec<usize>)> = Vec::new();
    let mut prev = 0;
    for &level in &levels {
        let amount: u32 = committed.iter().map(|&c| c.min(level) - c.min(prev)).sum();
        let eligible: Vec<usize> = (0..committed.len()).filter(|&s| live[s] && committed[s] >= level).collect();
        // 能贏的人一樣（例如棄牌的人投入比較多造成的層）就併成同一個池
        match pots.last_mut() {
            Some((a, e)) if *e == eligible => *a += amount,
            _ => pots.push((amount, eligible)),
        }
        prev = level;
    }
    // 棄牌的人投入得比所有沒棄牌的人都多（退回未跟注的部分之後不會發生）：併進最後一個池
    let rest: u32 = committed.iter().map(|&c| c.saturating_sub(prev)).sum();
    if rest > 0
        && let Some((a, _)) = pots.last_mut()
    {
        *a += rest;
    }
    pots
}

/// 把 `amount` 平分給 `winners`（已經照「從按鈕左邊開始」排好），除不盡的一人一枚從前面開始給
pub fn split(amount: u32, winners: &[usize]) -> Vec<(usize, u32)> {
    let n = winners.len() as u32;
    let share = amount / n;
    let odd = amount % n;
    winners.iter().enumerate().map(|(i, &s)| (s, share + u32::from((i as u32) < odd))).collect()
}

// ---- 電腦 ----

/// 蒙地卡羅估勝率：`hole` 是自己的兩張、`board` 是公牌、`opponents` 是還沒棄牌的對手數。
/// 每次把沒看到的牌洗一洗，發給對手和補滿公牌，平手照人數分。只用到自己知道的牌。
pub fn equity(hole: [Card; 2], board: &[Card], opponents: usize, iterations: usize, rng: &mut Rng) -> f64 {
    if opponents == 0 {
        return 1.0;
    }
    let mut unseen: Vec<Card> = (0..52).filter(|c| !hole.contains(c) && !board.contains(c)).collect();
    let need = 5 - board.len();
    let mut total = 0.0;
    let mut cards: Vec<Card> = Vec::with_capacity(7);
    for _ in 0..iterations {
        // 只洗需要的那幾張（部分 Fisher–Yates）
        let draw = need + 2 * opponents;
        for i in 0..draw {
            let j = i + rng.below(unseen.len() - i);
            unseen.swap(i, j);
        }
        let (extra, rest) = unseen.split_at(need);
        cards.clear();
        cards.extend_from_slice(board);
        cards.extend_from_slice(extra);
        let full_board = cards.clone();
        cards.extend_from_slice(&hole);
        let mine = evaluate(&cards);
        let mut ties = 1usize;
        let mut lost = false;
        for k in 0..opponents {
            cards.clear();
            cards.extend_from_slice(&full_board);
            cards.extend_from_slice(&rest[2 * k..2 * k + 2]);
            let theirs = evaluate(&cards);
            if theirs > mine {
                lost = true;
                break;
            }
            if theirs == mine {
                ties += 1;
            }
        }
        if !lost {
            total += 1.0 / ties as f64;
        }
    }
    total / iterations as f64
}

/// 翻牌前起手牌的分數（Chen 公式，-1～20）：大牌、對子、同花、連張加分
pub fn chen(hole: [Card; 2]) -> f64 {
    let (hi, lo) = if rank(hole[0]) >= rank(hole[1]) { (hole[0], hole[1]) } else { (hole[1], hole[0]) };
    let base = |r: u8| -> f64 {
        match r {
            12 => 10.0,
            11 => 8.0,
            10 => 7.0,
            9 => 6.0,
            r => f64::from(r + 2) / 2.0,
        }
    };
    let (h, l) = (rank(hi), rank(lo));
    if h == l {
        return (base(h) * 2.0).max(5.0);
    }
    let mut score = base(h);
    if suit(hi) == suit(lo) {
        score += 2.0;
    }
    let gap = h - l - 1;
    score -= match gap {
        0 => 0.0,
        1 => 1.0,
        2 => 2.0,
        3 => 4.0,
        _ => 5.0,
    };
    if gap <= 1 && h < 10 {
        score += 1.0;
    }
    score.ceil()
}

/// 電腦的決定
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Decision {
    Fold,
    Check,
    Call,
    /// 加注（或下注）到這一輪總共這麼多
    Raise(u32),
}

// ---- 牌局 ----

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
enum Street {
    Preflop,
    Flop,
    Turn,
    River,
    Showdown,
}

impl Street {
    fn label(self) -> &'static str {
        match self {
            Street::Preflop => "翻牌前",
            Street::Flop => "翻牌",
            Street::Turn => "轉牌",
            Street::River => "河牌",
            Street::Showdown => "攤牌",
        }
    }
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Action {
    Fold,
    Check,
    Call,
    /// 下注或加注到這一輪總共 `to`
    Raise {
        to: u32,
    },
    AllIn,
    /// 手牌結束後自願亮牌
    Show,
}

/// 計時器到了要做的事
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Pending {
    /// 全下之後發下一條街
    NextStreet,
    NextHand,
}

/// 一手結束時每個池的結果
#[derive(Clone, Debug)]
struct PotResult {
    amount: u32,
    winners: Vec<usize>,
    /// 贏的牌型；沒攤牌（其他人都棄牌）是 None
    hand: Option<&'static str>,
}

#[derive(Clone, Debug)]
struct Outcome {
    /// 名次，第一個是冠軍
    ranking: Vec<usize>,
}

pub struct Poker {
    options: Options,
    pids: Vec<u32>,
    names: Vec<String>,
    bots: Vec<bool>,
    online: Vec<bool>,
    /// 桌上的籌碼（不含這一輪已經推出去的）
    stacks: Vec<u32>,
    /// 第幾手（從 1 開始）
    hand_no: u32,
    small_blind: u32,
    big_blind: u32,
    button: usize,
    blinds: (Option<usize>, Option<usize>),
    /// 這手有發牌的人（開始時還有籌碼）
    dealt: Vec<bool>,
    holes: Vec<[Card; 2]>,
    folded: Vec<bool>,
    /// 這一輪推出去的籌碼
    bets: Vec<u32>,
    /// 這手總共投入的籌碼（含這一輪）
    committed: Vec<u32>,
    /// 這一輪最後一次行動時的跟注額度；None 是這一輪還沒行動過（盲注不算行動）
    acted: Vec<Option<u32>>,
    /// 這一輪要跟到多少
    current_bet: u32,
    /// 最小加注幅度（上一次完整加注的幅度，至少一個大盲）
    min_raise: u32,
    /// 這一輪最後下注／加注的人（河牌時就是攤牌要先亮的人）
    aggressor: Option<usize>,
    street: Street,
    board: Vec<Card>,
    deck: Vec<Card>,
    turn: Option<usize>,
    turn_started: Instant,
    deadline: Option<Instant>,
    bot_at: Option<Instant>,
    /// 公開的手牌
    shown: Vec<bool>,
    /// 座位旁邊顯示的最後一個動作
    last: Vec<Option<String>>,
    pending: Option<(Instant, Pending)>,
    /// 上一手（或剛結束這一手）的結果，到下一手開始前都顯示
    results: Vec<PotResult>,
    /// 這手每個人贏回多少（含退回的籌碼不算）
    won: Vec<u32>,
    log: Vec<String>,
    /// 出局的順序（先出局的在前）
    busted: Vec<usize>,
    outcome: Option<Outcome>,
    /// 累計贏了幾局（pid → 局數）
    wins: HashMap<u32, u32>,
    /// 這個房間的第幾局
    game: u32,
}

impl Poker {
    fn n(&self) -> usize {
        self.stacks.len()
    }

    fn name(&self, seat: usize) -> &str {
        &self.names[seat]
    }

    /// 這手還沒棄牌
    fn live(&self, seat: usize) -> bool {
        self.dealt[seat] && !self.folded[seat]
    }

    /// 這手還能行動（沒棄牌、沒全下）
    fn can_act(&self, seat: usize) -> bool {
        self.live(seat) && self.stacks[seat] > 0
    }

    /// 從 `from` 往左（座位號增加）找第一個符合的人，不含 `from` 自己，繞一圈最後才是自己
    fn next_where(&self, from: usize, pred: impl Fn(usize) -> bool) -> Option<usize> {
        (1..=self.n()).map(|k| (from + k) % self.n()).find(|&s| pred(s))
    }

    fn alive(&self) -> Vec<usize> {
        (0..self.n()).filter(|&s| self.stacks[s] > 0).collect()
    }

    fn pot_total(&self) -> u32 {
        self.committed.iter().sum()
    }

    /// 這手打完了（不是在等人行動，也不是全下之後在發公牌）
    fn hand_over(&self) -> bool {
        self.turn.is_none() && !self.pending.is_some_and(|(_, p)| p == Pending::NextStreet)
    }

    fn needs_to_act(&self, seat: usize) -> bool {
        self.can_act(seat) && (self.acted[seat].is_none() || self.bets[seat] < self.current_bet)
    }

    /// 這個人現在能不能加注：這一輪還沒行動過，或之後別人加的總額已經是一次完整加注
    fn can_raise(&self, seat: usize) -> bool {
        let reopened = match self.acted[seat] {
            None => true,
            Some(level) => self.current_bet - level >= self.min_raise,
        };
        // 加注之後至少還要有一個人能回應
        let others = (0..self.n()).any(|s| s != seat && self.can_act(s));
        reopened && others && self.stacks[seat] + self.bets[seat] > self.current_bet
    }

    /// 最少要加注到多少（籌碼不夠就是全下）
    fn min_raise_to(&self, seat: usize) -> u32 {
        (self.current_bet + self.min_raise.max(self.big_blind)).min(self.bets[seat] + self.stacks[seat])
    }

    fn push_log(&mut self, line: impl Into<String>) {
        self.log.push(line.into());
        if self.log.len() > LOG_LINES {
            let extra = self.log.len() - LOG_LINES;
            self.log.drain(..extra);
        }
    }

    /// 推籌碼出去（不夠就全推），回傳實際推了多少
    fn put(&mut self, seat: usize, amount: u32) -> u32 {
        let amount = amount.min(self.stacks[seat]);
        self.stacks[seat] -= amount;
        self.bets[seat] += amount;
        self.committed[seat] += amount;
        amount
    }

    fn set_turn(&mut self, seat: Option<usize>, ctx: &mut Ctx) {
        self.turn = seat;
        self.turn_started = ctx.now;
        self.deadline = seat
            .filter(|_| self.options.think_secs > 0)
            .map(|_| ctx.now + Duration::from_secs(u64::from(self.options.think_secs)));
        // 電腦想一下再出手，看起來比較自然
        self.bot_at =
            seat.filter(|&s| self.bots[s]).map(|_| ctx.now + Duration::from_secs_f64(ctx.rng.range(0.8, 1.8)));
        ctx.changed();
    }

    fn start_hand(&mut self, ctx: &mut Ctx) {
        let alive = self.alive();
        let limit = self.options.hand_limit;
        if alive.len() <= 1 || (limit > 0 && self.hand_no >= limit) {
            self.finish(ctx);
            return;
        }
        self.hand_no += 1;
        let level = (self.hand_no - 1).checked_div(self.options.blind_up).unwrap_or(0) as usize;
        let big = self.options.big_blind * LEVELS[level.min(LEVELS.len() - 1)];
        if big != self.big_blind && self.hand_no > 1 {
            ctx.system(To::All, format!("盲注升到 {}／{}", big / 2, big));
        }
        self.big_blind = big;
        self.small_blind = big / 2;
        if self.hand_no > 1 {
            self.button = self.next_where(self.button, |s| self.stacks[s] > 0).expect("someone has chips");
        }
        let n = self.n();
        self.dealt = (0..n).map(|s| self.stacks[s] > 0).collect();
        self.folded = vec![false; n];
        self.bets = vec![0; n];
        self.committed = vec![0; n];
        self.acted = vec![None; n];
        self.shown = vec![false; n];
        self.last = vec![None; n];
        self.won = vec![0; n];
        self.results.clear();
        self.board.clear();
        self.street = Street::Preflop;
        self.aggressor = None;
        self.pending = None;

        let mut deck: Vec<Card> = (0..52).collect();
        shuffle(ctx.rng, &mut deck);
        for s in 0..n {
            if self.dealt[s] {
                let a = deck.pop().expect("enough cards");
                let b = deck.pop().expect("enough cards");
                self.holes[s] = [a, b];
            }
        }
        self.deck = deck;

        // 單挑時按鈕下小盲；否則按鈕左邊小盲、再左邊大盲
        let sb =
            if alive.len() == 2 { self.button } else { self.next_where(self.button, |s| self.dealt[s]).expect("sb") };
        let bb = self.next_where(sb, |s| self.dealt[s]).expect("bb");
        self.blinds = (Some(sb), Some(bb));
        self.push_log(format!(
            "── 第 {} 手 · 盲注 {}／{} · 按鈕 {} ──",
            self.hand_no,
            self.small_blind,
            self.big_blind,
            self.name(self.button)
        ));
        let posted = self.put(sb, self.small_blind);
        self.last[sb] = Some(format!("小盲 {posted}"));
        self.push_log(format!(
            "{} 下小盲 {posted}{}",
            self.name(sb),
            if self.stacks[sb] == 0 { "（全下）" } else { "" }
        ));
        let posted = self.put(bb, self.big_blind);
        self.last[bb] = Some(format!("大盲 {posted}"));
        self.push_log(format!(
            "{} 下大盲 {posted}{}",
            self.name(bb),
            if self.stacks[bb] == 0 { "（全下）" } else { "" }
        ));
        // 大盲沒下滿也照一個大盲算要跟的額度
        self.current_bet = self.big_blind;
        self.min_raise = self.big_blind;
        self.proceed(bb, ctx);
    }

    /// 這一輪下注結束了沒
    fn round_closed(&self) -> bool {
        let actors: Vec<usize> = (0..self.n()).filter(|&s| self.can_act(s)).collect();
        if actors.len() <= 1 {
            // 只剩一個人能動（其他人全下）：他跟到別人投入的最高額就不用再動
            return actors.iter().all(|&a| {
                let top = (0..self.n()).filter(|&s| s != a && self.live(s)).map(|s| self.bets[s]).max().unwrap_or(0);
                self.bets[a] >= top
            });
        }
        actors.iter().all(|&s| !self.needs_to_act(s))
    }

    /// 有人行動完（或剛發完盲注）之後：換下一個人、進下一條街、攤牌或結束這手
    fn proceed(&mut self, from: usize, ctx: &mut Ctx) {
        let live: Vec<usize> = (0..self.n()).filter(|&s| self.live(s)).collect();
        if live.len() == 1 {
            self.win_uncontested(live[0], ctx);
            return;
        }
        if !self.round_closed() {
            let next = self.next_where(from, |s| self.needs_to_act(s));
            self.set_turn(next, ctx);
            return;
        }
        self.end_street();
        if self.street == Street::River {
            self.showdown(ctx);
            return;
        }
        let actors = (0..self.n()).filter(|&s| self.can_act(s)).count();
        if actors <= 1 {
            // 沒人能再下注：大家亮牌，公牌一張一張發完
            if live.iter().any(|&s| !self.shown[s]) {
                for &s in &live {
                    self.shown[s] = true;
                }
                let hands: Vec<String> = live
                    .iter()
                    .map(|&s| {
                        format!("{} {} {}", self.name(s), card_name(self.holes[s][0]), card_name(self.holes[s][1]))
                    })
                    .collect();
                self.push_log(format!("全下，亮牌：{}", hands.join("、")));
            }
            self.set_turn(None, ctx);
            self.pending = Some((ctx.now + RUNOUT_PAUSE, Pending::NextStreet));
            return;
        }
        self.deal_street();
        let first = self.next_where(self.button, |s| self.needs_to_act(s));
        self.set_turn(first, ctx);
    }

    /// 這一輪結束：退回沒人跟的下注、籌碼收進底池、重設下注狀態
    fn end_street(&mut self) {
        self.return_uncalled();
        if self.street == Street::River {
            return;
        }
        self.bets.fill(0);
        self.acted.fill(None);
        self.current_bet = 0;
        self.min_raise = self.big_blind;
        self.aggressor = None;
    }

    fn deal_street(&mut self) {
        let (street, count) = match self.street {
            Street::Preflop => (Street::Flop, 3),
            Street::Flop => (Street::Turn, 1),
            _ => (Street::River, 1),
        };
        // 燒一張再發
        self.deck.pop();
        for _ in 0..count {
            let c = self.deck.pop().expect("enough cards");
            self.board.push(c);
        }
        self.street = street;
        for s in 0..self.n() {
            if self.can_act(s) {
                self.last[s] = None;
            }
        }
        let board: Vec<String> = self.board.iter().map(|&c| card_name(c)).collect();
        self.push_log(format!("{}：{}", street.label(), board.join(" ")));
    }

    /// 投入最多的人如果比第二多的人多，多出來的沒人跟，退回給他
    fn return_uncalled(&mut self) {
        let Some(top) = (0..self.n()).max_by_key(|&s| self.committed[s]) else { return };
        let second = (0..self.n()).filter(|&s| s != top).map(|s| self.committed[s]).max().unwrap_or(0);
        let extra = self.committed[top].saturating_sub(second);
        if extra > 0 {
            self.committed[top] -= extra;
            self.bets[top] = self.bets[top].saturating_sub(extra);
            self.stacks[top] += extra;
            self.push_log(format!("退回沒人跟的 {extra} 給 {}", self.name(top)));
        }
    }

    fn win_uncontested(&mut self, seat: usize, ctx: &mut Ctx) {
        self.return_uncalled();
        let pot = self.pot_total();
        self.stacks[seat] += pot;
        self.won[seat] = pot;
        self.results = vec![PotResult { amount: pot, winners: vec![seat], hand: None }];
        self.push_log(format!("{} 贏得 {pot}（其他人都棄牌）", self.name(seat)));
        self.end_hand(FOLD_PAUSE, ctx);
    }

    fn showdown(&mut self, ctx: &mut Ctx) {
        self.street = Street::Showdown;
        self.return_uncalled();
        let n = self.n();
        let live: Vec<bool> = (0..n).map(|s| self.live(s)).collect();
        let strengths: Vec<Option<Strength>> = (0..n)
            .map(|s| {
                live[s].then(|| {
                    let mut cards = self.board.clone();
                    cards.extend_from_slice(&self.holes[s]);
                    evaluate(&cards)
                })
            })
            .collect();
        // 除不盡的籌碼從按鈕左邊開始給
        let order: Vec<usize> = (1..=n).map(|k| (self.button + k) % n).collect();
        let pots = side_pots(&self.committed, &live);
        let mut results = Vec::new();
        for (i, (amount, eligible)) in pots.iter().enumerate() {
            let best = eligible.iter().filter_map(|&s| strengths[s]).max().expect("someone is eligible");
            let winners: Vec<usize> =
                order.iter().copied().filter(|s| eligible.contains(s) && strengths[*s] == Some(best)).collect();
            for (s, share) in split(*amount, &winners) {
                self.stacks[s] += share;
                self.won[s] += share;
            }
            let pot_name = if pots.len() == 1 {
                "底池".to_string()
            } else if i == 0 {
                "主池".to_string()
            } else {
                format!("邊池 {i}")
            };
            let who: Vec<&str> = winners.iter().map(|&s| self.name(s)).collect();
            self.push_log(format!(
                "{} 以{}贏得{pot_name} {amount}{}",
                who.join("、"),
                best.label(),
                if winners.len() > 1 { "（平分）" } else { "" }
            ));
            results.push(PotResult { amount: *amount, winners, hand: Some(best.label()) });
        }
        // 要亮的牌：贏家、河牌被跟注的人；全下跑完的早就都亮了
        let mut must: Vec<usize> = results.iter().flat_map(|r| r.winners.iter().copied()).collect();
        if let Some(a) = self.aggressor.filter(|&a| live[a]) {
            must.push(a);
        }
        for s in must {
            if !self.shown[s] {
                self.shown[s] = true;
                self.push_log(format!(
                    "{} 亮牌 {} {}",
                    self.name(s),
                    card_name(self.holes[s][0]),
                    card_name(self.holes[s][1])
                ));
            }
        }
        self.results = results;
        self.end_hand(SHOWDOWN_PAUSE, ctx);
    }

    fn end_hand(&mut self, pause: Duration, ctx: &mut Ctx) {
        self.set_turn(None, ctx);
        // 這手輸光的人：開始時籌碼比較少的先出局
        let mut out: Vec<usize> =
            (0..self.n()).filter(|&s| self.dealt[s] && self.stacks[s] == 0 && !self.busted.contains(&s)).collect();
        out.sort_by_key(|&s| self.committed[s]);
        for &s in &out {
            self.push_log(format!("{} 輸光了籌碼，出局", self.name(s)));
            ctx.system(To::All, format!("{} 出局了", self.name(s)));
        }
        self.busted.extend(out);
        // 底池都分完了
        self.committed.fill(0);
        self.bets.fill(0);
        let limit = self.options.hand_limit;
        if self.alive().len() <= 1 || (limit > 0 && self.hand_no >= limit) {
            self.finish(ctx);
        } else {
            self.pending = Some((ctx.now + pause, Pending::NextHand));
        }
    }

    fn finish(&mut self, ctx: &mut Ctx) {
        self.pending = None;
        self.set_turn(None, ctx);
        // 還有籌碼的照籌碼排，出局的照出局順序倒過來排在後面
        let mut ranking: Vec<usize> = self.alive();
        ranking.sort_by_key(|&s| std::cmp::Reverse(self.stacks[s]));
        ranking.extend(self.busted.iter().rev());
        let champion = ranking[0];
        *self.wins.entry(self.pids[champion]).or_default() += 1;
        let text = if self.alive().len() <= 1 {
            format!("{} 贏走了所有籌碼，拿下這局！", self.name(champion))
        } else {
            format!("打滿 {} 手，{} 以 {} 籌碼拿下這局！", self.hand_no, self.name(champion), self.stacks[champion])
        };
        self.push_log(text.clone());
        ctx.announce(To::All, text, "ok");
        self.outcome = Some(Outcome { ranking });
    }

    /// 執行一個下注動作（已經確定輪到 `seat`）
    fn apply(&mut self, seat: usize, action: &Action, timeout: bool, ctx: &mut Ctx) -> Result<(), String> {
        let to_call = self.current_bet.saturating_sub(self.bets[seat]);
        let all_in_to = self.bets[seat] + self.stacks[seat];
        let suffix = if timeout { "（逾時）" } else { "" };
        let (label, line) = match *action {
            Action::Fold => {
                self.folded[seat] = true;
                ("棄牌".to_string(), format!("{} 棄牌{suffix}", self.name(seat)))
            }
            Action::Check => {
                if to_call > 0 {
                    return Err(format!("要跟注 {to_call} 才能繼續，不能過牌"));
                }
                ("過牌".to_string(), format!("{} 過牌{suffix}", self.name(seat)))
            }
            Action::Call => {
                if to_call == 0 {
                    return Err("不用跟注，可以直接過牌".into());
                }
                let paid = self.put(seat, to_call);
                if self.stacks[seat] == 0 {
                    (format!("全下 {}", self.bets[seat]), format!("{} 跟注 {paid}（全下）", self.name(seat)))
                } else {
                    (format!("跟注 {paid}"), format!("{} 跟注 {paid}", self.name(seat)))
                }
            }
            Action::Raise { .. } | Action::AllIn => {
                // 加注到超過自己的籌碼就當全下
                let to = match *action {
                    Action::Raise { to } => to.min(all_in_to),
                    _ => all_in_to,
                };
                if to == all_in_to && all_in_to <= self.current_bet {
                    // 籌碼不夠跟：全下就是跟注
                    return self.apply(seat, &Action::Call, timeout, ctx);
                }
                if !self.can_raise(seat) {
                    return Err(if to_call > 0 {
                        "現在只能跟注或棄牌".into()
                    } else {
                        "現在只能過牌".into()
                    });
                }
                let min = self.min_raise_to(seat);
                if to < min {
                    return Err(format!("最少要{}到 {min}", if self.current_bet == 0 { "下注" } else { "加注" }));
                }
                self.raise_to(seat, to)
            }
            Action::Show => return Err("手牌結束後才能亮牌".into()),
        };
        self.acted[seat] = Some(self.current_bet);
        self.last[seat] = Some(label);
        self.push_log(line);
        self.proceed(seat, ctx);
        Ok(())
    }

    /// 下注或加注到 `to`（已經檢查過合法），回傳 (座位旁的字, 紀錄)
    fn raise_to(&mut self, seat: usize, to: u32) -> (String, String) {
        let opening = self.current_bet == 0;
        let increase = to - self.current_bet;
        self.put(seat, to - self.bets[seat]);
        // 完整加注才更新最小加注幅度；不足的全下只提高要跟的額度
        if increase >= self.min_raise {
            self.min_raise = increase;
        }
        self.current_bet = to;
        self.aggressor = Some(seat);
        let all_in = self.stacks[seat] == 0;
        let verb = if opening { "下注" } else { "加注到" };
        let label = if all_in { format!("全下 {to}") } else { format!("{verb} {to}") };
        let line = format!("{} {verb} {to}{}", self.name(seat), if all_in { "（全下）" } else { "" });
        (label, line)
    }

    /// 時間到或斷線：能過牌就過牌，不然棄牌
    fn auto(&mut self, ctx: &mut Ctx) {
        let Some(seat) = self.turn else { return };
        let action = if self.bets[seat] >= self.current_bet { Action::Check } else { Action::Fold };
        let _ = self.apply(seat, &action, !self.bots[seat], ctx);
    }

    fn bot_move(&mut self, ctx: &mut Ctx) {
        let Some(seat) = self.turn else { return };
        let action = match self.bot_decision(seat, ctx.rng) {
            Decision::Fold if self.bets[seat] >= self.current_bet => Action::Check,
            Decision::Fold => Action::Fold,
            Decision::Check if self.bets[seat] < self.current_bet => Action::Fold,
            Decision::Check => Action::Check,
            Decision::Call if self.bets[seat] >= self.current_bet => Action::Check,
            Decision::Call => Action::Call,
            Decision::Raise(to) => Action::Raise { to },
        };
        if self.apply(seat, &action, false, ctx).is_err() {
            // 不該發生；保險起見照逾時處理，牌局不會卡住
            self.auto(ctx);
        }
    }

    /// 電腦要怎麼做。只用到自己的手牌、公牌、籌碼和下注（公開資訊）。
    fn bot_decision(&self, seat: usize, rng: &mut Rng) -> Decision {
        let opponents = (0..self.n()).filter(|&s| s != seat && self.live(s)).count();
        let to_call = self.current_bet.saturating_sub(self.bets[seat]).min(self.stacks[seat]);
        let pot = self.pot_total();
        let stack = self.stacks[seat];
        let can_raise = self.can_raise(seat);
        let hole = self.holes[seat];
        // 公平分到的勝率：一對一是 50%，越多人越低
        let fair = 1.0 / (opponents as f64 + 1.0);

        let eq = if self.street == Street::Preflop {
            // 翻牌前用起手牌分數換算成「大概的勝率」，再跟模擬的結果平均，省一點又比較穩
            let score = chen(hole);
            let sim = equity(hole, &self.board, opponents.min(4), SIMULATIONS / 2, rng);
            let guess = fair + (score - 7.0) / 20.0 * (1.0 - fair);
            (sim + guess.clamp(0.0, 1.0)) / 2.0
        } else {
            equity(hole, &self.board, opponents, SIMULATIONS, rng)
        };
        let eq = (eq + rng.range(-0.04, 0.04)).clamp(0.0, 1.0);
        let strong = fair + (1.0 - fair) * 0.35;
        let monster = fair + (1.0 - fair) * 0.6;

        let raise = |fraction: f64, rng: &mut Rng| -> Decision {
            let min = self.min_raise_to(seat);
            let max = self.bets[seat] + stack;
            let size = (f64::from(pot + to_call) * fraction * rng.range(0.85, 1.15)) as u32;
            let mut to = (self.current_bet + size).max(min);
            // 下注超過籌碼的六成就乾脆全下
            if to - self.bets[seat] > stack * 6 / 10 {
                to = max;
            }
            Decision::Raise(to.min(max))
        };

        // 已經加注很多次：只拿真正的好牌繼續加
        let pressure = f64::from(self.current_bet) / f64::from(self.big_blind.max(1));
        if can_raise && eq > monster && (pressure < 30.0 || eq > 0.85) {
            return raise(if rng.chance(0.3) { 1.0 } else { 0.7 }, rng);
        }
        if can_raise && eq > strong && pressure < 10.0 && rng.chance(0.65) {
            return raise(0.55, rng);
        }
        if to_call == 0 {
            // 沒人下注：偶爾詐唬（對手少、翻牌後）
            if can_raise && self.street != Street::Preflop && opponents <= 2 && rng.chance(0.1) {
                return raise(0.5, rng);
            }
            return Decision::Check;
        }
        // 底池賠率：跟注這麼多，要贏到整個底池的機率至少要多少；要跟的佔籌碼越多越謹慎
        let odds = f64::from(to_call) / f64::from(pot + to_call);
        let caution = 0.04 + 0.12 * f64::from(to_call) / f64::from(stack.max(1) + self.bets[seat]);
        if eq >= odds + caution {
            return Decision::Call;
        }
        // 很便宜的跟注（例如補小盲）偶爾湊熱鬧
        if odds < 0.2 && rng.chance(0.25) {
            return Decision::Call;
        }
        Decision::Fold
    }

    fn turn_json(&self, seat: usize) -> Value {
        let to_call = self.current_bet.saturating_sub(self.bets[seat]).min(self.stacks[seat]);
        json!({
            "toCall": to_call,
            "canCheck": self.bets[seat] >= self.current_bet,
            "canRaise": self.can_raise(seat),
            "minRaiseTo": self.min_raise_to(seat),
            "maxRaiseTo": self.bets[seat] + self.stacks[seat],
            "currentBet": self.current_bet,
        })
    }
}

impl PartyGame for Poker {
    const ID: &'static str = "poker";
    const MIN_PLAYERS: usize = 2;
    const MAX_PLAYERS: usize = MAX_SEATS;
    const MAX_BOTS: usize = MAX_SEATS - 1;

    type Options = Options;
    type Action = Action;

    fn rooms(state: &AppState) -> &Arc<Parties<Self>> {
        &state.poker
    }

    fn check_options(options: Options) -> Result<Options, String> {
        if !CHIP_CHOICES.contains(&options.chips) {
            return Err("起始籌碼只能選 500、1000、2000、5000 或 10000".into());
        }
        if !BLIND_CHOICES.contains(&options.big_blind) {
            return Err("大盲只能選 10、20、50、100 或 200".into());
        }
        if options.chips < options.big_blind * 10 {
            return Err("起始籌碼至少要 10 個大盲".into());
        }
        if !BLIND_UP_CHOICES.contains(&options.blind_up) {
            return Err("升盲只能選不升、每 5、10 或 20 手".into());
        }
        if !HAND_LIMIT_CHOICES.contains(&options.hand_limit) {
            return Err("手數上限只能選不限、30、50 或 100 手".into());
        }
        if !THINK_CHOICES.contains(&options.think_secs) {
            return Err("思考時間只能選不限、15、30 或 60 秒".into());
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
            stacks: vec![options.chips; n],
            hand_no: 0,
            small_blind: options.big_blind / 2,
            big_blind: options.big_blind,
            button: ctx.rng.below(n),
            blinds: (None, None),
            dealt: vec![false; n],
            holes: vec![[0, 0]; n],
            folded: vec![false; n],
            bets: vec![0; n],
            committed: vec![0; n],
            acted: vec![None; n],
            current_bet: 0,
            min_raise: options.big_blind,
            aggressor: None,
            street: Street::Preflop,
            board: Vec::new(),
            deck: Vec::new(),
            turn: None,
            turn_started: ctx.now,
            deadline: None,
            bot_at: None,
            shown: vec![false; n],
            last: vec![None; n],
            pending: None,
            results: Vec::new(),
            won: vec![0; n],
            log: Vec::new(),
            busted: Vec::new(),
            outcome: None,
            wins: previous.map(|p| p.wins.clone()).unwrap_or_default(),
            game: previous.map_or(1, |p| p.game + 1),
        };
        ctx.system(
            To::All,
            format!(
                "第 {} 局開始：每人 {} 籌碼，盲注 {}／{}",
                game.game,
                options.chips,
                options.big_blind / 2,
                options.big_blind
            ),
        );
        game.start_hand(ctx);
        game
    }

    fn act(&mut self, seat: usize, action: Action, ctx: &mut Ctx) -> Result<(), String> {
        if self.outcome.is_some() && !matches!(action, Action::Show) {
            return Err("這局已經結束了".into());
        }
        if let Action::Show = action {
            if !self.hand_over() {
                return Err("手牌結束後才能亮牌".into());
            }
            if !self.dealt[seat] {
                return Err("你這手沒有牌".into());
            }
            if self.shown[seat] {
                return Err("已經亮過了".into());
            }
            self.shown[seat] = true;
            let line = format!(
                "{} 亮牌 {} {}",
                self.name(seat),
                card_name(self.holes[seat][0]),
                card_name(self.holes[seat][1])
            );
            self.push_log(line);
            return Ok(());
        }
        if self.turn != Some(seat) {
            return Err("還沒輪到你".into());
        }
        self.apply(seat, &action, false, ctx)
    }

    fn tick(&mut self, ctx: &mut Ctx) {
        if self.outcome.is_some() {
            return;
        }
        if let Some((at, what)) = self.pending
            && ctx.now >= at
        {
            self.pending = None;
            match what {
                Pending::NextHand => self.start_hand(ctx),
                Pending::NextStreet => {
                    if self.street == Street::River {
                        self.showdown(ctx);
                    } else {
                        self.deal_street();
                        ctx.changed();
                        self.pending = Some((ctx.now + RUNOUT_PAUSE, Pending::NextStreet));
                    }
                }
            }
            return;
        }
        let Some(seat) = self.turn else { return };
        if self.bot_at.is_some_and(|t| ctx.now >= t) {
            self.bot_at = None;
            self.bot_move(ctx);
        } else if self.deadline.is_some_and(|d| ctx.now >= d)
            || (!self.bots[seat] && !self.online[seat] && ctx.now.duration_since(self.turn_started) >= OFFLINE_WAIT)
        {
            self.auto(ctx);
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
        let ended = self.outcome.is_some();
        let seats: Vec<Value> = (0..self.n())
            .map(|s| {
                let visible = self.dealt[s] && (self.shown[s] || seat == Some(s));
                json!({
                    "stack": self.stacks[s],
                    "bet": self.bets[s],
                    "dealt": self.dealt[s],
                    "folded": self.folded[s],
                    "allIn": self.live(s) && self.stacks[s] == 0,
                    "out": self.busted.contains(&s),
                    "online": self.online[s],
                    "last": self.last[s],
                    "cards": visible.then_some(self.holes[s]),
                    "shown": self.dealt[s] && self.shown[s],
                    // 公開的牌才算牌型（自己的另外放在 me）
                    "rank": (self.shown[s] && self.dealt[s]).then(|| {
                        let mut cards = self.board.clone();
                        cards.extend_from_slice(&self.holes[s]);
                        evaluate(&cards).label()
                    }),
                    "won": self.won[s],
                    "wins": self.wins.get(&self.pids[s]).copied().unwrap_or(0),
                })
            })
            .collect();
        let me = seat.filter(|&s| self.dealt[s]).map(|s| {
            let mut cards = self.board.clone();
            cards.extend_from_slice(&self.holes[s]);
            let strength = evaluate(&cards);
            let best = if self.board.is_empty() { Vec::new() } else { best_five(&cards) };
            json!({
                "rank": strength.label(),
                "best": best,
                "turn": (self.turn == Some(s)).then(|| self.turn_json(s)),
                // 手牌結束後可以自願亮牌
                "canShow": self.hand_over() && !self.shown[s],
            })
        });
        // 攤牌時贏家最好的 5 張，桌上標出來
        let results: Vec<Value> = self
            .results
            .iter()
            .map(|r| {
                json!({
                    "amount": r.amount,
                    "winners": r.winners,
                    "hand": r.hand,
                    "best": r.hand.and(r.winners.first()).filter(|&&w| self.shown[w]).map(|&w| {
                        let mut cards = self.board.clone();
                        cards.extend_from_slice(&self.holes[w]);
                        best_five(&cards)
                    }),
                })
            })
            .collect();
        // 再幾手升盲（這一手也算在內）
        let next_level = (self.options.blind_up > 0 && !ended)
            .then(|| self.options.blind_up - self.hand_no.saturating_sub(1) % self.options.blind_up);
        json!({
            "stage": if ended { "end" } else { "play" },
            "game": self.game,
            "options": self.options,
            "you": seat,
            "hand": self.hand_no,
            "street": self.street,
            "board": self.board,
            "button": self.button,
            "smallBlind": self.small_blind,
            "bigBlind": self.big_blind,
            "sb": self.blinds.0,
            "bb": self.blinds.1,
            "blindUpIn": next_level,
            "pot": self.pot_total(),
            "seats": seats,
            "turn": self.turn,
            "endsIn": self.deadline.filter(|_| self.turn.is_some()).map(|d| d.saturating_duration_since(now).as_millis() as u64),
            "me": me,
            "results": results,
            "nextHandIn": self.pending
                .filter(|(_, p)| *p == Pending::NextHand)
                .map(|(at, _)| at.saturating_duration_since(now).as_millis() as u64),
            "log": self.log,
            "ranking": self.outcome.as_ref().map(|o| &o.ranking),
        })
    }

    fn finished(&self) -> bool {
        self.outcome.is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::party::{Outbox, SeatInfo};

    /// 用「花色字母 + 點數」寫牌，例如 `sA`、`h10`、`d2`、`cK`
    fn c(name: &str) -> Card {
        let (s, r) = name.split_at(1);
        let suit = "cdhs".find(s).expect("suit") as u8;
        let rank = RANK_NAMES.iter().position(|&x| x == r).expect("rank") as u8;
        rank * 4 + suit
    }

    fn cards(names: &str) -> Vec<Card> {
        names.split_whitespace().map(c).collect()
    }

    fn eval(names: &str) -> Strength {
        evaluate(&cards(names))
    }

    fn seats(n: usize, bots: usize) -> Vec<SeatInfo> {
        (0..n)
            .map(|i| SeatInfo { pid: i as u32 + 1, name: format!("P{i}"), bot: i >= n - bots, online: true })
            .collect()
    }

    struct Table {
        g: Poker,
        seats: Vec<SeatInfo>,
        rng: Rng,
        now: Instant,
    }

    impl Table {
        /// 開一局；`stacks` 指定每個人的籌碼，`button` 指定按鈕，第一手重新發（照指定的按鈕和盲注）
        fn new(stacks: &[u32], button: usize, options: Options) -> Self {
            let seats = seats(stacks.len(), 0);
            let mut rng = Rng::new();
            let now = Instant::now();
            let mut out = Outbox::default();
            let mut g = {
                let mut ctx = crate::party::test_ctx(now, &mut rng, &seats, &mut out);
                Poker::start(&options, None, &mut ctx)
            };
            g.stacks = stacks.to_vec();
            g.hand_no = 0;
            g.log.clear();
            // start_hand 會在 hand_no > 1 時移動按鈕，第一手就用這個
            g.button = button;
            let mut t = Self { g, seats, rng, now };
            t.with(|g, ctx| g.start_hand(ctx));
            t
        }

        fn with<R>(&mut self, f: impl FnOnce(&mut Poker, &mut Ctx) -> R) -> R {
            let mut out = Outbox::default();
            let mut ctx = crate::party::test_ctx(self.now, &mut self.rng, &self.seats, &mut out);
            f(&mut self.g, &mut ctx)
        }

        fn act(&mut self, seat: usize, action: Action) -> Result<(), String> {
            self.with(|g, ctx| g.act(seat, action, ctx))
        }

        fn ok(&mut self, seat: usize, action: Action) {
            assert_eq!(self.g.turn, Some(seat), "應該輪到 {seat}；紀錄：{:?}", self.g.log);
            self.act(seat, action).unwrap_or_else(|e| panic!("座位 {seat}：{e}"));
        }

        /// 讓時間往前走、跑 tick（全下發牌、下一手）
        fn wait(&mut self, d: Duration) {
            self.now += d;
            self.with(|g, ctx| g.tick(ctx));
        }

        /// 指定手牌和接下來的公牌（照發牌順序：翻牌三張、轉牌、河牌）
        fn rig(&mut self, holes: &[&str], board: &str) {
            for (s, h) in holes.iter().enumerate() {
                if !h.is_empty() {
                    let v = cards(h);
                    self.g.holes[s] = [v[0], v[1]];
                }
            }
            // deck 從後面 pop：燒、翻 3、燒、轉、燒、河
            let b = cards(board);
            let used: Vec<Card> = self.g.holes.iter().flatten().copied().chain(b.iter().copied()).collect();
            let mut filler: Vec<Card> = (0..52).filter(|x| !used.contains(x)).collect();
            let mut seq: Vec<Card> = Vec::new();
            let mut burn = || filler.pop().unwrap();
            seq.push(burn());
            seq.extend(&b[..3]);
            seq.push(burn());
            seq.push(b[3]);
            seq.push(burn());
            seq.push(b[4]);
            seq.reverse();
            self.g.deck = seq;
        }

        fn total(&self) -> u32 {
            self.g.stacks.iter().sum::<u32>() + self.g.pot_total()
        }
    }

    fn opts() -> Options {
        Options { blind_up: 0, think_secs: 0, ..Options::default() }
    }

    // ---- 牌力 ----

    #[test]
    fn categories() {
        assert_eq!(eval("s2 d5 h9 cJ sK d3 h7").category(), Category::HighCard);
        assert_eq!(eval("s2 d2 h9 cJ sK d3 h7").category(), Category::Pair);
        assert_eq!(eval("s2 d2 h9 c9 sK d3 h7").category(), Category::TwoPair);
        assert_eq!(eval("s2 d2 h2 c9 sK d3 h7").category(), Category::Trips);
        assert_eq!(eval("s2 d3 h4 c5 s6 dK hK").category(), Category::Straight);
        assert_eq!(eval("s2 s7 s9 sJ sK d3 h3").category(), Category::Flush);
        assert_eq!(eval("s2 d2 h2 c9 s9 d3 h7").category(), Category::FullHouse);
        assert_eq!(eval("s2 d2 h2 c2 s9 d3 h7").category(), Category::Quads);
        assert_eq!(eval("s5 s6 s7 s8 s9 d3 h7").category(), Category::StraightFlush);
        assert_eq!(eval("s10 sJ sQ sK sA d3 h7").label(), "皇家同花順");
        assert_eq!(eval("s9 sJ sQ sK s10 d3 h7").label(), "同花順");
    }

    #[test]
    fn category_order() {
        let ladder = [
            "s2 d5 h9 cJ sK d3 h7",
            "s2 d2 h9 cJ sK d3 h7",
            "s2 d2 h9 c9 sK d3 h7",
            "s2 d2 h2 c9 sK d3 h7",
            "sA d2 h3 c4 s5 dK hQ",
            "s2 s7 s9 sJ sK d3 h3",
            "s2 d2 h2 c9 s9 d3 h7",
            "s2 d2 h2 c2 s9 d3 h7",
            "sA s2 s3 s4 s5 d3 h7",
        ];
        for w in ladder.windows(2) {
            assert!(eval(w[0]) < eval(w[1]), "{} 應該比 {} 小", w[0], w[1]);
        }
    }

    #[test]
    fn wheel_is_the_smallest_straight() {
        let wheel = eval("sA d2 h3 c4 s5 dK hQ");
        assert_eq!(wheel.category(), Category::Straight);
        assert!(wheel < eval("s2 d3 h4 c5 s6 dK hQ"));
        assert!(eval("s10 dJ hQ cK sA d2 h3") > eval("s9 d10 hJ cQ sK"));
        // 繞過 A 的不算：Q K A 2 3
        assert_eq!(eval("sQ dK hA c2 s3 d7 h8").category(), Category::HighCard);
        // 同花的 A2345 是最小的同花順
        let steel = eval("hA h2 h3 h4 h5 d9 c9");
        assert_eq!(steel.category(), Category::StraightFlush);
        assert!(steel < eval("h2 h3 h4 h5 h6"));
        // 六張連張取最大的
        assert_eq!(eval("s4 d5 h6 c7 s8 d9 cK"), eval("h5 c6 d7 s8 h9"));
    }

    #[test]
    fn kickers_break_ties() {
        // 一對：比踢腳
        assert!(eval("sA dA hK c9 s7 d3 h2") > eval("cA hA dQ sJ s10 d3 h2"));
        assert!(eval("sA dA hK c9 s7") > eval("cA hA hK s9 d6"));
        // 兩對：先比大對、再比小對、再比踢腳；第三對可以當踢腳
        assert!(eval("sK dK h2 c2 sA") > eval("cQ hQ dJ sJ sA"));
        assert!(eval("sK dK h5 c5 s3") > eval("cK hK d4 s4 sA"));
        assert!(eval("sK dK h5 c5 sQ") > eval("cK hK d5 s5 sJ"));
        assert_eq!(eval("sK dK h5 c5 s4 d4 hA"), eval("cK hK d5 s5 cA"));
        assert_eq!(eval("sK dK h5 c5 s4 d4 h3"), eval("cK hK d5 s5 c4"));
        // 三條、鐵支的踢腳
        assert!(eval("s7 d7 h7 cA s2") > eval("c7 h7 d7 sK sQ"));
        assert!(eval("s7 d7 h7 c7 sA") > eval("s7 d7 h7 c7 sK"));
        // 葫蘆：先比三條；兩組三條時小的那組當對子
        assert!(eval("s3 d3 h3 c2 s2") > eval("s2 d2 h2 cA sA"));
        assert_eq!(eval("s9 d9 h9 c4 s4 d4 hK").category(), Category::FullHouse);
        assert_eq!(eval("s9 d9 h9 c4 s4 d4 hK"), eval("s9 d9 h9 c4 s4"));
        assert!(eval("s9 d9 h9 c4 s4 d4 hK") < eval("s9 d9 h9 c5 s5"));
        // 同花比五張
        assert!(eval("s2 s7 s9 sJ sK") > eval("h3 h7 h9 hJ hQ"));
        assert!(eval("s2 s7 s9 sJ sK") > eval("h2 h6 h9 hJ hK"));
        // 同花取最大的五張
        assert_eq!(eval("s2 s7 s9 sJ sK s3 d4"), eval("h3 h7 h9 hJ hK"));
        // 高牌只比最大的五張
        assert_eq!(eval("sA dK hQ c9 s7 d3 h2"), eval("cA hK dQ s9 c7 h4 d2"));
        // 同花比順子大、順子在公牌上大家平手
        assert_eq!(eval("s5 d6 h7 c8 s9 cA dA"), eval("s5 d6 h7 c8 s9 hK h2"));
    }

    #[test]
    fn short_hands_for_the_hint() {
        assert_eq!(eval("sA dA").label(), "一對");
        assert_eq!(eval("sA dK").label(), "高牌");
        assert_eq!(eval("sA dA hA cK").label(), "三條");
    }

    #[test]
    fn best_five_picks_the_winning_cards() {
        let seven = cards("s10 sJ sQ sK sA d3 h7");
        let mut best = best_five(&seven);
        best.sort_unstable();
        let mut want = cards("s10 sJ sQ sK sA");
        want.sort_unstable();
        assert_eq!(best, want);
        assert_eq!(evaluate(&best), evaluate(&seven));
        let six = cards("s2 d2 h2 c9 s9 d3");
        assert_eq!(evaluate(&best_five(&six)), evaluate(&six));
    }

    // ---- 底池 ----

    #[test]
    fn side_pots_for_multiple_all_ins() {
        // A 全下 100、B 全下 300、C 和 D 各 500
        let pots = side_pots(&[100, 300, 500, 500], &[true; 4]);
        assert_eq!(pots, vec![(400, vec![0, 1, 2, 3]), (600, vec![1, 2, 3]), (400, vec![2, 3])]);
        // 棄牌的人的錢併進去，但不能贏
        let pots = side_pots(&[100, 300, 200, 300], &[true, true, false, true]);
        assert_eq!(pots, vec![(400, vec![0, 1, 3]), (500, vec![1, 3])]);
        // 一樣的額度只有一個池
        assert_eq!(side_pots(&[50, 50, 50], &[true; 3]), vec![(150, vec![0, 1, 2])]);
        // 棄牌的人投入的錢照額度分進各層：超過 0 全下額度的部分只有 2 能贏
        assert_eq!(side_pots(&[40, 100, 100], &[true, false, true]), vec![(120, vec![0, 2]), (120, vec![2])]);
        // 能贏的人一樣的層合併：棄牌的 1 投入 60，介於 0 和 2 之間
        assert_eq!(side_pots(&[100, 60, 100], &[true, false, true]), vec![(260, vec![0, 2])]);
    }

    #[test]
    fn odd_chips_go_left_of_the_button() {
        assert_eq!(split(101, &[3, 1]), vec![(3, 51), (1, 50)]);
        assert_eq!(split(100, &[0, 1, 2]), vec![(0, 34), (1, 33), (2, 33)]);
        assert_eq!(split(90, &[2]), vec![(2, 90)]);
    }

    // ---- 下注流程 ----

    #[test]
    fn heads_up_button_posts_small_blind_and_acts_first() {
        let mut t = Table::new(&[1000, 1000], 0, opts());
        assert_eq!(t.g.blinds, (Some(0), Some(1)));
        assert_eq!(t.g.bets, vec![10, 20]);
        assert_eq!(t.g.turn, Some(0), "單挑翻牌前按鈕（小盲）先");
        t.ok(0, Action::Call);
        // 大盲還有選擇權
        assert_eq!(t.g.turn, Some(1));
        t.ok(1, Action::Check);
        assert_eq!(t.g.street, Street::Flop);
        assert_eq!(t.g.turn, Some(1), "翻牌後大盲先");
        t.ok(1, Action::Check);
        t.ok(0, Action::Check);
        assert_eq!(t.g.street, Street::Turn);
        assert_eq!(t.g.turn, Some(1));
        // 下一手按鈕換到 1
        t.ok(1, Action::Raise { to: 40 });
        t.ok(0, Action::Fold);
        assert_eq!(t.g.stacks, vec![980, 1020]);
        t.wait(FOLD_PAUSE);
        assert_eq!(t.g.button, 1);
        assert_eq!(t.g.blinds, (Some(1), Some(0)));
        assert_eq!(t.g.turn, Some(1));
    }

    #[test]
    fn three_handed_blinds_and_order() {
        let mut t = Table::new(&[1000, 1000, 1000], 0, opts());
        assert_eq!(t.g.blinds, (Some(1), Some(2)));
        assert_eq!(t.g.turn, Some(0), "翻牌前大盲左邊（槍口）先");
        t.ok(0, Action::Call);
        t.ok(1, Action::Call);
        t.ok(2, Action::Check);
        assert_eq!(t.g.street, Street::Flop);
        assert_eq!(t.g.turn, Some(1), "翻牌後按鈕左邊第一個先");
        assert_eq!(t.g.pot_total(), 60);
    }

    #[test]
    fn min_raise_rules() {
        let mut t = Table::new(&[1000, 1000, 1000], 0, opts());
        // 大盲 20：最少加到 40
        assert_eq!(t.g.min_raise_to(0), 40);
        assert!(t.act(0, Action::Raise { to: 39 }).is_err());
        t.ok(0, Action::Raise { to: 70 });
        // 加了 50：下一個至少要加到 120
        assert_eq!(t.g.min_raise_to(1), 120);
        assert!(t.act(1, Action::Raise { to: 119 }).is_err());
        t.ok(1, Action::Raise { to: 120 });
        assert_eq!(t.g.min_raise_to(2), 170);
        t.ok(2, Action::Fold);
        t.ok(0, Action::Call);
        // 翻牌：最小下注一個大盲
        assert_eq!(t.g.street, Street::Flop);
        assert_eq!(t.g.turn, Some(1));
        assert!(t.act(1, Action::Raise { to: 10 }).is_err());
        assert_eq!(t.g.min_raise_to(1), 20);
        t.ok(1, Action::Raise { to: 20 });
        assert_eq!(t.g.min_raise_to(0), 40);
        assert!(t.act(0, Action::Check).is_err());
    }

    #[test]
    fn short_all_in_does_not_reopen_betting() {
        // 座位 2 只有 130：A 下注 100，B 跟，C 全下 130（只多 30，不到一次完整加注）
        let mut t = Table::new(&[1000, 1000, 1000, 150], 3, opts());
        // 按鈕 3：小盲 0、大盲 1、2 先
        assert_eq!(t.g.blinds, (Some(0), Some(1)));
        t.ok(2, Action::Call);
        t.ok(3, Action::Call);
        t.ok(0, Action::Call);
        t.ok(1, Action::Check);
        assert_eq!(t.g.street, Street::Flop);
        assert_eq!(t.g.stacks, vec![980, 980, 980, 130]);
        t.ok(0, Action::Raise { to: 100 });
        t.ok(1, Action::Call);
        t.ok(2, Action::Call);
        t.ok(3, Action::AllIn);
        assert_eq!(t.g.current_bet, 130);
        // 已經行動過的 A、B、C 只能跟或棄
        assert_eq!(t.g.turn, Some(0));
        assert!(!t.g.can_raise(0));
        assert!(t.act(0, Action::Raise { to: 300 }).is_err());
        assert!(t.act(0, Action::AllIn).is_err());
        t.ok(0, Action::Call);
        t.ok(1, Action::Call);
        t.ok(2, Action::Call);
        assert_eq!(t.g.street, Street::Turn);
    }

    #[test]
    fn full_all_in_raise_reopens_betting() {
        let mut t = Table::new(&[1000, 1000, 300], 2, opts());
        // 按鈕 2：小盲 0、大盲 1、按鈕先
        t.ok(2, Action::Call);
        t.ok(0, Action::Call);
        t.ok(1, Action::Check);
        // 翻牌：0 下注 100，1 跟，2 全下 280（多 180，是完整加注）
        t.ok(0, Action::Raise { to: 100 });
        t.ok(1, Action::Call);
        t.ok(2, Action::AllIn);
        assert_eq!(t.g.current_bet, 280);
        assert!(t.g.can_raise(0));
        assert_eq!(t.g.min_raise_to(0), 460);
    }

    #[test]
    fn uncalled_bet_is_returned() {
        let mut t = Table::new(&[1000, 500], 0, opts());
        t.ok(0, Action::AllIn);
        t.ok(1, Action::Call);
        // 1 只有 500：0 多推的 500 退回
        assert_eq!(t.g.stacks[0], 500);
        assert_eq!(t.g.committed, vec![500, 500]);
        assert!(t.g.shown.iter().all(|&s| s), "全下跑完大家都亮牌");
        let total = 1500;
        for _ in 0..10 {
            if t.g.pending.is_some_and(|(_, p)| p == Pending::NextHand) || t.g.finished() {
                break;
            }
            t.wait(RUNOUT_PAUSE);
        }
        assert_eq!(t.g.street, Street::Showdown);
        assert_eq!(t.total(), total);
    }

    #[test]
    fn everyone_folds_to_the_big_blind() {
        let mut t = Table::new(&[1000, 1000, 1000], 0, opts());
        t.ok(0, Action::Fold);
        t.ok(1, Action::Fold);
        assert_eq!(t.g.stacks, vec![1000, 990, 1010]);
        assert!(t.g.shown.iter().all(|&s| !s), "沒攤牌就不亮牌");
        assert!(t.g.pending.is_some());
    }

    #[test]
    fn side_pots_pay_the_right_people() {
        // 0 有 100、1 有 300、2 和 3 各 1000；按鈕 3，小盲 0、大盲 1，2 先
        let mut t = Table::new(&[100, 300, 1000, 1000], 3, opts());
        // 0 拿最大（鐵支）、1 第二（葫蘆）、2 第三（同花）、3 最小
        t.rig(&["s9 d9", "sK dK", "h2 h3", "c4 d5"], "c9 h9 hK cA h7");
        t.ok(2, Action::Raise { to: 1000 });
        t.ok(3, Action::Call);
        t.ok(0, Action::AllIn);
        t.ok(1, Action::AllIn);
        for _ in 0..10 {
            if t.g.street == Street::Showdown {
                break;
            }
            t.wait(RUNOUT_PAUSE);
        }
        assert_eq!(t.g.street, Street::Showdown);
        // 主池 400 給 0；邊池 600 給 1；剩下 2、3 的 1400 給 2（同花）
        assert_eq!(t.g.stacks, vec![400, 600, 1400, 0]);
        assert_eq!(t.g.results.len(), 3);
        assert_eq!(t.g.busted, vec![3]);
    }

    #[test]
    fn split_pot_with_odd_chip() {
        // 按鈕 2：小盲 0、大盲 1。公牌是順子，大家平手
        let mut t = Table::new(&[1000, 1000, 1000], 2, Options { big_blind: 10, ..opts() });
        t.rig(&["c2 d3", "c3 d2", "h2 s3"], "s10 dJ hQ cK sA");
        t.ok(2, Action::Fold);
        t.ok(0, Action::Call);
        t.ok(1, Action::Check);
        t.ok(0, Action::Check);
        t.ok(1, Action::Check);
        t.ok(0, Action::Check);
        t.ok(1, Action::Check);
        t.ok(0, Action::Check);
        t.ok(1, Action::Check);
        assert_eq!(t.g.street, Street::Showdown);
        assert_eq!(t.g.stacks, vec![1000, 1000, 1000]);
        assert_eq!(t.g.results[0].winners, vec![0, 1]);
        // 直接測奇數：一個 21 的池平分給按鈕左邊兩個人
        assert_eq!(split(21, &t.g.results[0].winners), vec![(0, 11), (1, 10)]);
    }

    #[test]
    fn showdown_only_reveals_required_hands() {
        let mut t = Table::new(&[1000, 1000, 1000], 2, opts());
        // 0 最大、1 第二、2 棄牌
        t.rig(&["sA dA", "sK dK", "c7 d2"], "h3 c8 s9 hJ d4");
        t.ok(2, Action::Fold);
        t.ok(0, Action::Call);
        t.ok(1, Action::Check);
        for _ in 0..2 {
            t.ok(0, Action::Check);
            t.ok(1, Action::Check);
        }
        // 河牌：1 下注、0 跟注 → 1 是被跟注的人要亮，0 是贏家也亮
        t.ok(0, Action::Check);
        t.ok(1, Action::Raise { to: 50 });
        t.ok(0, Action::Call);
        assert_eq!(t.g.street, Street::Showdown);
        assert_eq!(t.g.shown, vec![true, true, false]);
        let spectator = t.g.view(None, t.now);
        assert!(spectator["seats"][2]["cards"].is_null(), "棄牌的牌不公開");
        assert_eq!(spectator["seats"][0]["rank"], "一對");

        // 輸家沒下注就蓋牌
        let mut t = Table::new(&[1000, 1000], 0, opts());
        t.rig(&["sA dA", "sK dK"], "h3 c8 s9 hJ d4");
        t.ok(0, Action::Call);
        t.ok(1, Action::Check);
        for _ in 0..3 {
            t.ok(1, Action::Check);
            t.ok(0, Action::Check);
        }
        assert_eq!(t.g.shown, vec![true, false]);
        assert!(t.g.view(Some(0), t.now)["seats"][1]["cards"].is_null());
        // 輸家可以自己選擇亮牌
        t.act(1, Action::Show).unwrap();
        assert!(t.g.shown[1]);
    }

    #[test]
    fn views_hide_other_hole_cards() {
        let t = Table::new(&[1000, 1000, 1000], 0, opts());
        for s in 0..3 {
            let v = t.g.view(Some(s), t.now);
            for other in 0..3 {
                let cards = &v["seats"][other]["cards"];
                assert_eq!(cards.is_null(), other != s, "座位 {s} 看座位 {other}");
            }
            assert!(v["me"]["rank"].is_string());
        }
        let v = t.g.view(None, t.now);
        assert!((0..3).all(|s| v["seats"][s]["cards"].is_null()));
        assert!(v["me"].is_null());
    }

    #[test]
    fn short_big_blind_all_in() {
        // 大盲只有 15：還是照 20 跟
        let mut t = Table::new(&[1000, 1000, 15], 0, opts());
        assert_eq!(t.g.bets, vec![0, 10, 15]);
        assert_eq!(t.g.current_bet, 20);
        t.ok(0, Action::Call);
        t.ok(1, Action::Call);
        // 大盲全下了，0 和 1 繼續
        assert_eq!(t.g.street, Street::Flop);
        assert_eq!(t.g.pot_total(), 55);
    }

    #[test]
    fn timeout_checks_or_folds() {
        let mut t = Table::new(&[1000, 1000], 0, Options { think_secs: 15, ..opts() });
        // 小盲要補 10：逾時棄牌
        t.wait(Duration::from_secs(16));
        assert!(t.g.folded[0]);
        t.wait(FOLD_PAUSE);
        // 下一手：按鈕 1 先；跟注之後 0（大盲）逾時就過牌
        t.ok(1, Action::Call);
        t.wait(Duration::from_secs(16));
        assert!(!t.g.folded[0]);
        assert_eq!(t.g.street, Street::Flop);
    }

    #[test]
    fn hand_limit_ends_the_game() {
        let mut t = Table::new(&[1000, 1000], 0, Options { hand_limit: 2, ..opts() });
        t.ok(0, Action::Fold);
        t.wait(FOLD_PAUSE);
        assert_eq!(t.g.hand_no, 2);
        t.ok(1, Action::Fold);
        assert!(t.g.finished());
        let ranking = t.g.outcome.as_ref().unwrap().ranking.clone();
        assert_eq!(ranking.len(), 2);
    }

    #[test]
    fn blinds_go_up() {
        let mut t = Table::new(&[1000, 1000], 0, Options { blind_up: 5, ..opts() });
        for _ in 0..5 {
            assert_eq!(t.g.big_blind, 20);
            let s = t.g.turn.unwrap();
            t.ok(s, Action::Fold);
            t.wait(FOLD_PAUSE);
        }
        assert_eq!(t.g.hand_no, 6);
        assert_eq!(t.g.big_blind, 40);
    }

    #[test]
    fn bots_play_whole_sessions() {
        let mut rng = Rng::new();
        for n in [2, 3, 6, 9] {
            let seats = seats(n, n);
            let options = Options { chips: 500, big_blind: 20, blind_up: 5, hand_limit: 0, think_secs: 0 };
            let mut now = Instant::now();
            let mut out = Outbox::default();
            let mut g = {
                let mut ctx = crate::party::test_ctx(now, &mut rng, &seats, &mut out);
                Poker::start(&options, None, &mut ctx)
            };
            let total = 500 * n as u32;
            for _ in 0..200_000 {
                if g.finished() {
                    break;
                }
                now += Duration::from_millis(500);
                let mut out = Outbox::default();
                g.tick(&mut crate::party::test_ctx(now, &mut rng, &seats, &mut out));
                assert_eq!(g.stacks.iter().sum::<u32>() + g.pot_total(), total, "籌碼不會多也不會少");
            }
            assert!(g.finished(), "{n} 個電腦打得完一局（打了 {} 手）", g.hand_no);
            let ranking = &g.outcome.as_ref().unwrap().ranking;
            assert_eq!(ranking.len(), n);
            assert_eq!(g.stacks[ranking[0]], total);
        }
    }

    #[test]
    fn equity_is_sane() {
        let mut rng = Rng::new();
        let aces = equity([c("sA"), c("hA")], &[], 1, 2000, &mut rng);
        assert!(aces > 0.8 && aces < 0.9, "AA 對一個人約 85%：{aces}");
        let junk = equity([c("s2"), c("h7")], &[], 1, 2000, &mut rng);
        assert!(junk < 0.4, "72 不同花：{junk}");
        // 已經是堅果：河牌皇家同花順
        let nuts = equity([c("sA"), c("sK")], &cards("sQ sJ s10 d2 h3"), 3, 200, &mut rng);
        assert_eq!(nuts, 1.0);
        assert!(chen([c("sA"), c("hA")]) >= chen([c("sK"), c("hK")]));
        assert!(chen([c("sA"), c("sK")]) > chen([c("s2"), c("h7")]));
    }

    /// 電腦對上「永遠跟注」的對手要贏多輸少
    #[test]
    fn bots_beat_a_calling_station() {
        let mut rng = Rng::new();
        let mut bot_wins = 0;
        let sessions = 30;
        for i in 0..sessions {
            let seats = seats(2, 2);
            let options = Options { chips: 1000, big_blind: 20, blind_up: 10, hand_limit: 0, think_secs: 0 };
            let now = Instant::now();
            let mut out = Outbox::default();
            let mut g = {
                let mut ctx = crate::party::test_ctx(now, &mut rng, &seats, &mut out);
                Poker::start(&options, None, &mut ctx)
            };
            let station = i % 2;
            let mut now = now;
            for _ in 0..100_000 {
                if g.finished() {
                    break;
                }
                let mut out = Outbox::default();
                let mut ctx = crate::party::test_ctx(now, &mut rng, &seats, &mut out);
                match g.turn {
                    Some(s) if s == station => {
                        let a = if g.bets[s] >= g.current_bet { Action::Check } else { Action::Call };
                        g.act(s, a, &mut ctx).unwrap();
                    }
                    Some(_) => {
                        g.bot_at = None;
                        g.bot_move(&mut ctx);
                    }
                    None => {
                        now += Duration::from_secs(10);
                        let mut out = Outbox::default();
                        g.tick(&mut crate::party::test_ctx(now, &mut rng, &seats, &mut out));
                    }
                }
            }
            assert!(g.finished());
            if g.outcome.as_ref().unwrap().ranking[0] != station {
                bot_wins += 1;
            }
        }
        eprintln!("電腦對永遠跟注的對手：{bot_wins}/{sessions}");
        assert!(bot_wins * 10 >= sessions * 6, "只贏了 {bot_wins}/{sessions}");
    }
}
