//! 大老二（派對房間，房間本身見 `party.rs`）。4 個座位，人不夠由電腦補。
//!
//! 台灣常見的玩法：
//! - 牌序：3 最小，接著 4、5…K、A，2 最大；同點數比花色，♠ > ♥ > ♦ > ♣。
//! - 牌型：單張、對子（可選三條），以及五張牌型：順子 < 同花 < 葫蘆 < 鐵支 < 同花順。
//!   同牌型才能壓（五張牌型之間照等級比）；可以選擇讓鐵支、同花順當「炸彈」壓單張和對子。
//! - 第一局拿到 ♣3 的人先出，第一手必須包含 ♣3；之後每局由上一局的贏家先出。
//! - 輪流出牌或 pass（pass 之後這一圈還可以再出）；其他三家都 pass，最後出牌的人重新自由出牌。
//! - 有人出完就結束：其他人照剩下的張數扣分，10 張以上加倍、一張都沒出（13 張）三倍，
//!   可以選擇「手上每剩一張 2 再加倍」；贏的人拿走全部扣分。分數在同一個房間跨局累計。
//!
//! 每個人的 view 只有自己的手牌，其他人只看得到張數；結束時才公開大家剩下的牌。
//! 電腦玩家先把手牌拆成「出最少次就能出完」的組合（`Planner`），再用代價挑要出哪一手、要不要 pass。

use std::{collections::HashMap, sync::Arc, time::Duration};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::time::Instant;

use crate::{
    AppState,
    party::{Ctx, Parties, PartyGame, Rng, To, shuffle},
};

/// 0～51：`點數 * 4 + 花色`，點數 0 是 3、11 是 A、12 是 2；花色 0 ♣、1 ♦、2 ♥、3 ♠。
/// 所以數字越大的牌越大，比單張直接比數字就好。
pub type Card = u8;

pub const CLUB_THREE: Card = 0;
const RANK_A: u8 = 11;
const RANK_2: u8 = 12;
const SEATS: usize = 4;
const HAND: usize = 13;
/// 輪到斷線的人：等這麼久就自動出手（能 pass 就 pass，自由出牌就出最小的單張）
const OFFLINE_WAIT: Duration = Duration::from_secs(5);
/// view 裡最多列出幾種能出的組合（「提示」用）
const MAX_HINTS: usize = 300;

pub fn rank(card: Card) -> u8 {
    card / 4
}

pub fn suit(card: Card) -> u8 {
    card % 4
}

const RANK_NAMES: [&str; 13] = ["3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A", "2"];
const SUIT_NAMES: [&str; 4] = ["♣", "♦", "♥", "♠"];

pub fn card_name(card: Card) -> String {
    format!("{}{}", SUIT_NAMES[usize::from(suit(card))], RANK_NAMES[usize::from(rank(card))])
}

/// 順子怎麼比大小
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub enum Straights {
    /// 2 最大：34567 最小，接著到 10JQKA，再來 A2345，23456 最大
    #[default]
    TwoHigh,
    /// A 當 1：A2345 最小，接著 23456、34567…10JQKA 最大
    Natural,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Options {
    /// 同花算一種牌型（介於順子和葫蘆之間）
    pub flush: bool,
    /// 鐵支、同花順可以壓單張、對子（和三條）
    pub bombs: bool,
    /// 可以出三條（只能壓三條）
    pub triples: bool,
    pub straights: Straights,
    /// 結算時手上每剩一張 2，扣分再加倍
    pub twos_double: bool,
    /// 每手的思考秒數，0 是不限
    pub think_secs: u16,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            flush: true,
            bombs: false,
            triples: false,
            straights: Straights::TwoHigh,
            twos_double: false,
            think_secs: 30,
        }
    }
}

pub const THINK_CHOICES: [u16; 4] = [0, 15, 30, 60];

/// 牌型；五張牌型的宣告順序就是大小順序
#[derive(Serialize, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug, Hash)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Single,
    Pair,
    Triple,
    Straight,
    Flush,
    FullHouse,
    FourKind,
    StraightFlush,
}

impl Kind {
    pub fn size(self) -> usize {
        match self {
            Kind::Single => 1,
            Kind::Pair => 2,
            Kind::Triple => 3,
            _ => 5,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Kind::Single => "單張",
            Kind::Pair => "對子",
            Kind::Triple => "三條",
            Kind::Straight => "順子",
            Kind::Flush => "同花",
            Kind::FullHouse => "葫蘆",
            Kind::FourKind => "鐵支",
            Kind::StraightFlush => "同花順",
        }
    }

    fn bomb(self) -> bool {
        matches!(self, Kind::FourKind | Kind::StraightFlush)
    }
}

/// 一手牌：牌型、牌（由小到大）、同牌型之間比大小用的 `key`（越大越大）
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Combo {
    pub kind: Kind,
    pub cards: Vec<Card>,
    key: u32,
}

impl Combo {
    fn json(&self) -> Value {
        json!({ "kind": self.kind, "cards": self.cards })
    }

    /// 排序用（提示由小到大）：張數、牌型、大小
    fn order(&self) -> (usize, Kind, u32) {
        (self.kind.size(), self.kind, self.key)
    }
}

/// 五張的點數是不是順子；是的話回傳 (等級, 決定花色的那張牌的點數)。`ranks` 要由小到大、不重複。
/// JQKA2、QKA23 這種繞過 2 的不算。
fn straight_level(ranks: &[u8; 5], order: Straights) -> Option<(u32, u8)> {
    let consecutive = ranks.windows(2).all(|w| w[1] == w[0] + 1);
    if consecutive && ranks[4] <= RANK_A {
        // 34567（ranks[0] = 0）到 10JQKA（ranks[0] = 7），決定花色的是最上面那張
        let base = u32::from(ranks[0]);
        let level = match order {
            Straights::TwoHigh => base,
            Straights::Natural => base + 2,
        };
        return Some((level, ranks[4]));
    }
    // A2345：3、4、5、A、2；23456：3、4、5、6、2
    if ranks[..3] == [0, 1, 2] && ranks[4] == RANK_2 {
        let a2345 = ranks[3] == RANK_A;
        let s23456 = ranks[3] == 3;
        return match order {
            Straights::TwoHigh if a2345 => Some((8, RANK_2)),
            Straights::TwoHigh if s23456 => Some((9, RANK_2)),
            // A 當 1：A2345 的頂是 5、23456 的頂是 6
            Straights::Natural if a2345 => Some((0, 2)),
            Straights::Natural if s23456 => Some((1, 3)),
            _ => None,
        };
    }
    None
}

/// 判斷一組牌是什麼牌型；不是能出的牌型就是 None。`cards` 不用排序，但不能重複。
pub fn classify(cards: &[Card], options: &Options) -> Option<Combo> {
    let mut cards = cards.to_vec();
    cards.sort_unstable();
    if cards.windows(2).any(|w| w[0] == w[1]) || cards.iter().any(|&c| c >= 52) {
        return None;
    }
    let same_rank = cards.windows(2).all(|w| rank(w[0]) == rank(w[1]));
    let (kind, key) = match cards.len() {
        1 => (Kind::Single, u32::from(cards[0])),
        2 if same_rank => (Kind::Pair, u32::from(cards[1])),
        3 if same_rank && options.triples => (Kind::Triple, u32::from(rank(cards[0]))),
        5 => {
            let ranks: Vec<u8> = cards.iter().map(|&c| rank(c)).collect();
            let flush = cards.iter().all(|&c| suit(c) == suit(cards[0]));
            // 每個點數幾張
            let mut counts: Vec<(u8, usize)> = Vec::new();
            for &r in &ranks {
                match counts.iter_mut().find(|(x, _)| *x == r) {
                    Some((_, n)) => *n += 1,
                    None => counts.push((r, 1)),
                }
            }
            counts.sort_by_key(|&(r, n)| (std::cmp::Reverse(n), r));
            let straight = if counts.len() == 5 {
                let ranks: [u8; 5] = ranks.clone().try_into().expect("five cards");
                straight_level(&ranks, options.straights)
            } else {
                None
            };
            // 決定花色的那張牌（順子的頂）
            let top_suit = |top: u8| u32::from(suit(*cards.iter().find(|&&c| rank(c) == top).expect("top card")));
            match (straight, flush, counts[0].1, counts.get(1).map(|c| c.1)) {
                (Some((level, top)), true, _, _) => (Kind::StraightFlush, level * 4 + top_suit(top)),
                (_, _, 4, _) => (Kind::FourKind, u32::from(counts[0].0)),
                (_, _, 3, Some(2)) => (Kind::FullHouse, u32::from(counts[0].0)),
                // 同花比最大的那張（先比點數，再比花色）
                (None, true, _, _) if options.flush => (Kind::Flush, u32::from(cards[4])),
                (Some((level, top)), false, _, _) => (Kind::Straight, level * 4 + top_suit(top)),
                _ => return None,
            }
        }
        _ => return None,
    };
    Some(Combo { kind, cards, key })
}

/// `play` 能不能壓 `table`
pub fn beats(play: &Combo, table: &Combo, options: &Options) -> bool {
    let (a, b) = (play.kind.size(), table.kind.size());
    if a == b {
        if play.kind != table.kind {
            // 張數一樣但牌型不同只會發生在五張牌型
            return play.kind > table.kind;
        }
        return play.key > table.key;
    }
    options.bombs && play.kind.bomb() && b < 5
}

/// 從 `n` 張裡挑 `k` 張的每一種組合（索引由小到大）
fn for_each_subset(n: usize, k: usize, f: &mut impl FnMut(&[usize])) {
    fn walk(n: usize, k: usize, from: usize, picked: &mut Vec<usize>, f: &mut impl FnMut(&[usize])) {
        if picked.len() == k {
            f(picked);
            return;
        }
        for i in from..n {
            if n - i < k - picked.len() {
                break;
            }
            picked.push(i);
            walk(n, k, i + 1, picked, f);
            picked.pop();
        }
    }
    if k <= n {
        walk(n, k, 0, &mut Vec::with_capacity(k), f);
    }
}

/// 手牌裡所有能出的組合（不管桌上），附上它在手牌裡的位置（bitmask）
fn all_combos(hand: &[Card], options: &Options) -> Vec<(u16, Combo)> {
    let mut out = Vec::new();
    for k in [1, 2, 3, 5] {
        for_each_subset(hand.len(), k, &mut |idx| {
            let cards: Vec<Card> = idx.iter().map(|&i| hand[i]).collect();
            if let Some(combo) = classify(&cards, options) {
                let mask = idx.iter().fold(0u16, |m, &i| m | 1 << i);
                out.push((mask, combo));
            }
        });
    }
    out
}

/// 現在能出的牌：自由出牌時什麼都行（第一手要有 ♣3），否則要壓得過桌上；由小到大排
pub fn legal_plays(hand: &[Card], table: Option<&Combo>, first: bool, options: &Options) -> Vec<Combo> {
    let mut plays: Vec<Combo> = all_combos(hand, options)
        .into_iter()
        .map(|(_, c)| c)
        .filter(|c| !first || c.cards.contains(&CLUB_THREE))
        .filter(|c| table.is_none_or(|t| beats(c, t, options)))
        .collect();
    plays.sort_by_key(Combo::order);
    plays
}

/// 結算時一個人要扣的分數
pub fn penalty(left: &[Card], options: &Options) -> i32 {
    let n = left.len() as i32;
    let mut points = match left.len() {
        HAND => n * 3,
        10.. => n * 2,
        _ => n,
    };
    if options.twos_double {
        for _ in left.iter().filter(|&&c| rank(c) == RANK_2) {
            points *= 2;
        }
    }
    points
}

/// 電腦拆牌：每個子集合（手牌的 bitmask）最少要花多少「代價」才能出完。
/// 每出一次算 10，低的單張、對子是累贅多算一點，五張牌型一次出掉五張少算一點。
struct Planner {
    hand: Vec<Card>,
    best: Vec<i32>,
}

impl Planner {
    fn new(hand: &[Card], options: &Options) -> Self {
        let n = hand.len();
        let mut by_low: Vec<Vec<(u16, i32)>> = vec![Vec::new(); n];
        for (mask, combo) in all_combos(hand, options) {
            let cost = match combo.kind {
                Kind::Single if rank(combo.cards[0]) < 9 => 13,
                Kind::Single => 10,
                Kind::Pair if rank(combo.cards[0]) < 6 => 11,
                Kind::Pair | Kind::Triple => 10,
                _ => 9,
            };
            by_low[mask.trailing_zeros() as usize].push((mask, cost));
        }
        let mut best = vec![0i32; 1 << n];
        for mask in 1..(1usize << n) {
            let low = mask.trailing_zeros() as usize;
            let mask16 = mask as u16;
            best[mask] = by_low[low]
                .iter()
                .filter(|(unit, _)| unit & !mask16 == 0)
                .map(|&(unit, cost)| cost + best[usize::from(mask16 ^ unit)])
                .min()
                .expect("every card is a single");
        }
        Self { hand: hand.to_vec(), best }
    }

    /// 出掉 `cards` 之後，剩下的牌還要花多少代價
    fn cost_without(&self, cards: &[Card]) -> i32 {
        let mask =
            self.hand.iter().enumerate().filter(|(_, c)| !cards.contains(c)).fold(0usize, |m, (i, _)| m | 1 << i);
        self.best[mask]
    }
}

/// 打出好牌的代價：2、A、K 留到關鍵時刻；炸彈拿去壓單張、對子很浪費
fn spend(play: &Combo, table: Option<&Combo>) -> f64 {
    let mut cost: f64 = play
        .cards
        .iter()
        .map(|&c| match rank(c) {
            RANK_2 => 14.0,
            RANK_A => 6.0,
            10 => 2.0,
            _ => 0.0,
        })
        .sum();
    if play.kind.size() == 5 {
        // 五張牌型本來就是一次出掉，裡面夾著大牌沒那麼可惜
        cost *= 0.4;
    }
    if table.is_some_and(|t| t.kind.size() < 5) && play.kind.size() == 5 {
        cost += 15.0;
    }
    cost
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Action {
    Play { cards: Vec<Card> },
    Pass,
}

/// 這一圈每個人最後做了什麼（畫在座位旁邊）
#[derive(Clone, Debug)]
enum Last {
    Play(Combo),
    Pass,
}

#[derive(Clone, Debug)]
struct Outcome {
    winner: usize,
    /// 每個座位這局的分數變化（贏的人是正的）
    deltas: Vec<i32>,
}

pub struct BigTwo {
    options: Options,
    pids: Vec<u32>,
    names: Vec<String>,
    bots: Vec<bool>,
    online: Vec<bool>,
    hands: Vec<Vec<Card>>,
    turn: usize,
    /// 這一圈桌上最大的那手和出牌的人；None 是自由出牌
    table: Option<(usize, Combo)>,
    /// 桌上那手之後連續 pass 了幾個人，三個就換那個人重新出
    passes: usize,
    last: Vec<Option<Last>>,
    /// 第一手：必須包含 ♣3
    first: bool,
    /// 這局出過的牌（公開資訊，電腦算「還有沒有更大的」用）
    played: Vec<Card>,
    /// 輪到的人現在能出的牌（換人時算一次）
    plays: Vec<Combo>,
    turn_started: Instant,
    deadline: Option<Instant>,
    bot_at: Option<Instant>,
    outcome: Option<Outcome>,
    /// 累計分數（pid → 分）
    scores: HashMap<u32, i32>,
    /// 這個房間的第幾局
    game: u32,
}

impl BigTwo {
    fn next(seat: usize) -> usize {
        (seat + 1) % SEATS
    }

    fn total(&self, seat: usize) -> i32 {
        self.scores.get(&self.pids[seat]).copied().unwrap_or(0)
    }

    fn set_turn(&mut self, seat: usize, ctx: &mut Ctx) {
        self.turn = seat;
        self.turn_started = ctx.now;
        self.deadline =
            (self.options.think_secs > 0).then(|| ctx.now + Duration::from_secs(u64::from(self.options.think_secs)));
        self.plays = legal_plays(&self.hands[seat], self.table.as_ref().map(|(_, c)| c), self.first, &self.options);
        // 電腦想一下再出，看起來比較自然
        self.bot_at = self.bots[seat].then(|| ctx.now + Duration::from_secs_f64(ctx.rng.range(0.8, 1.5)));
        ctx.changed();
    }

    fn play(&mut self, seat: usize, combo: Combo, ctx: &mut Ctx) {
        self.hands[seat].retain(|c| !combo.cards.contains(c));
        self.played.extend(&combo.cards);
        self.first = false;
        self.passes = 0;
        self.last[seat] = Some(Last::Play(combo.clone()));
        self.table = Some((seat, combo));
        if self.hands[seat].is_empty() {
            self.finish(seat, ctx);
        } else {
            self.set_turn(Self::next(seat), ctx);
        }
    }

    fn pass(&mut self, seat: usize, ctx: &mut Ctx) {
        self.last[seat] = Some(Last::Pass);
        self.passes += 1;
        if self.passes >= SEATS - 1
            && let Some((owner, _)) = self.table.take()
        {
            // 其他三家都 pass：最後出牌的人重新自由出牌
            self.passes = 0;
            self.last.fill(None);
            self.set_turn(owner, ctx);
        } else {
            self.set_turn(Self::next(seat), ctx);
        }
    }

    fn finish(&mut self, winner: usize, ctx: &mut Ctx) {
        let mut deltas = vec![0i32; SEATS];
        for seat in 0..SEATS {
            if seat != winner {
                let lost = penalty(&self.hands[seat], &self.options);
                deltas[seat] = -lost;
                deltas[winner] += lost;
            }
        }
        for (pid, delta) in self.pids.iter().zip(&deltas) {
            *self.scores.entry(*pid).or_default() += delta;
        }
        ctx.announce(To::All, format!("{} 出完了！這局拿下 {} 分", self.names[winner], deltas[winner]), "ok");
        self.outcome = Some(Outcome { winner, deltas });
        self.deadline = None;
        self.bot_at = None;
        self.plays.clear();
        ctx.changed();
    }

    /// 時間到或斷線：能 pass 就 pass，自由出牌就出最小的單張（第一手就是 ♣3）
    fn auto(&mut self, ctx: &mut Ctx) {
        let seat = self.turn;
        if !self.bots[seat] {
            ctx.system(
                To::All,
                format!(
                    "{} 沒有出手，自動{}",
                    self.names[seat],
                    if self.table.is_some() { " pass" } else { "出最小的牌" }
                ),
            );
        }
        if self.table.is_some() {
            self.pass(seat, ctx);
        } else {
            let single = self
                .plays
                .iter()
                .find(|p| p.kind == Kind::Single)
                .cloned()
                .expect("a single is always legal when leading");
            self.play(seat, single, ctx);
        }
    }

    fn bot_move(&mut self, ctx: &mut Ctx) {
        let seat = self.turn;
        match self.bot_choice(seat, ctx.rng) {
            Some(combo) => self.play(seat, combo, ctx),
            None if self.table.is_some() => self.pass(seat, ctx),
            None => self.auto(ctx),
        }
    }

    /// 電腦要出什麼；None 是 pass。只用到公開資訊（張數、出過的牌）和自己的手牌。
    fn bot_choice(&self, seat: usize, rng: &mut Rng) -> Option<Combo> {
        let hand = &self.hands[seat];
        if self.plays.is_empty() {
            return None;
        }
        if let Some(all) = self.plays.iter().find(|p| p.cards.len() == hand.len()) {
            return Some(all.clone());
        }
        let table = self.table.as_ref().map(|(_, c)| c);
        let planner = Planner::new(hand, &self.options);
        let others: Vec<usize> = (1..SEATS).map(|k| (seat + k) % SEATS).collect();
        let danger = others.iter().map(|&s| self.hands[s].len()).min().unwrap_or(HAND);
        // 還沒出現、也不在自己手上的牌：別人可能拿著
        let unseen: Vec<Card> = (0..52).filter(|c| !hand.contains(c) && !self.played.contains(c)).collect();
        let scale = if danger <= 2 {
            0.2
        } else if hand.len() <= 5 {
            0.5
        } else {
            1.0
        };

        let mut best: Option<(f64, &Combo)> = None;
        for play in &self.plays {
            let mut score = f64::from(planner.cost_without(&play.cards)) + spend(play, table) * scale;
            match table {
                None => {
                    // 自由出牌：能一次出多張就多出，手上的大牌留著拿回出牌權
                    score -= 2.0 * (play.cards.len() - 1) as f64;
                    let top = *play.cards.last().expect("non-empty");
                    let unbeatable = !unseen.iter().any(|&c| c > top);
                    if danger == 1 && play.kind == Kind::Single && !unbeatable {
                        score += 25.0;
                    }
                    if danger == 2 && play.kind == Kind::Pair && !unbeatable {
                        score += 8.0;
                    }
                }
                Some(t) => {
                    // 有人只剩一張還在比單張：出越大越好，不讓他過
                    if danger == 1 && t.kind == Kind::Single {
                        score -= f64::from(play.cards[0]) * 0.4;
                    }
                }
            }
            score += rng.range(0.0, 1.5);
            if best.is_none_or(|(b, _)| score < b) {
                best = Some((score, play));
            }
        }
        let (best_score, best_play) = best?;
        if let Some((owner, _)) = &self.table {
            let mut pass = f64::from(planner.cost_without(&[])) + 3.0 + rng.range(0.0, 1.5);
            if self.hands[*owner].len() <= 2 {
                pass += 30.0;
            } else if danger <= 2 {
                pass += 12.0;
            }
            if pass < best_score {
                return None;
            }
        }
        Some(best_play.clone())
    }

    fn last_json(last: &Option<Last>) -> Value {
        match last {
            None => Value::Null,
            Some(Last::Pass) => json!({ "pass": true }),
            Some(Last::Play(combo)) => combo.json(),
        }
    }
}

impl PartyGame for BigTwo {
    const ID: &'static str = "bigtwo";
    const MIN_PLAYERS: usize = SEATS;
    const MAX_PLAYERS: usize = SEATS;
    const MAX_BOTS: usize = SEATS - 1;

    type Options = Options;
    type Action = Action;

    fn rooms(state: &AppState) -> &Arc<Parties<Self>> {
        &state.bigtwo
    }

    fn check_options(options: Options) -> Result<Options, String> {
        if !THINK_CHOICES.contains(&options.think_secs) {
            return Err("思考時間只能選不限、15、30 或 60 秒".into());
        }
        Ok(options)
    }

    fn start(options: &Options, previous: Option<&Self>, ctx: &mut Ctx) -> Self {
        let mut deck: Vec<Card> = (0..52).collect();
        shuffle(ctx.rng, &mut deck);
        let hands: Vec<Vec<Card>> = deck
            .chunks(HAND)
            .map(|chunk| {
                let mut hand = chunk.to_vec();
                hand.sort_unstable();
                hand
            })
            .collect();
        let pids: Vec<u32> = ctx.seats.iter().map(|s| s.pid).collect();
        // 上一局有人出完，而且他還在桌上：由他先出；否則（第一局、上一局被中止）拿到 ♣3 的人先出
        let winner = previous
            .and_then(|p| p.outcome.as_ref().map(|o| p.pids[o.winner]))
            .and_then(|pid| pids.iter().position(|&p| p == pid));
        let club = hands.iter().position(|h| h.contains(&CLUB_THREE)).expect("someone has ♣3");
        let (leader, first) = match winner {
            Some(seat) => (seat, false),
            None => (club, true),
        };

        let mut game = Self {
            options: options.clone(),
            names: ctx.seats.iter().map(|s| s.name.clone()).collect(),
            bots: ctx.seats.iter().map(|s| s.bot).collect(),
            online: ctx.seats.iter().map(|s| s.online).collect(),
            pids,
            hands,
            turn: leader,
            table: None,
            passes: 0,
            last: vec![None; SEATS],
            first,
            played: Vec::new(),
            plays: Vec::new(),
            turn_started: ctx.now,
            deadline: None,
            bot_at: None,
            outcome: None,
            scores: previous.map(|p| p.scores.clone()).unwrap_or_default(),
            game: previous.map_or(1, |p| p.game + 1),
        };
        let who = &game.names[leader];
        if first {
            ctx.system(To::All, format!("第 {} 局：{who} 拿到 ♣3，由他先出（第一手要包含 ♣3）", game.game));
        } else {
            ctx.system(To::All, format!("第 {} 局：上一局的贏家 {who} 先出", game.game));
        }
        game.set_turn(leader, ctx);
        game
    }

    fn act(&mut self, seat: usize, action: Action, ctx: &mut Ctx) -> Result<(), String> {
        if self.outcome.is_some() {
            return Err("這局已經結束了".into());
        }
        if seat != self.turn {
            return Err("還沒輪到你".into());
        }
        match action {
            Action::Pass => {
                if self.table.is_none() {
                    return Err("自由出牌時不能 pass".into());
                }
                self.pass(seat, ctx);
            }
            Action::Play { cards } => {
                if cards.is_empty() {
                    return Err("請先選牌".into());
                }
                if cards.iter().any(|c| !self.hands[seat].contains(c)) {
                    return Err("你手上沒有這些牌".into());
                }
                let Some(combo) = classify(&cards, &self.options) else {
                    return Err("這組牌不是能出的牌型".into());
                };
                if self.first && !combo.cards.contains(&CLUB_THREE) {
                    return Err("第一手必須包含 ♣3".into());
                }
                if let Some((_, table)) = &self.table
                    && !beats(&combo, table, &self.options)
                {
                    return Err(
                        if combo.kind.size() != table.kind.size() && !(self.options.bombs && combo.kind.bomb()) {
                            format!("要出 {} 張的牌型", table.kind.size())
                        } else {
                            "壓不過桌上的牌".into()
                        },
                    );
                }
                self.play(seat, combo, ctx);
            }
        }
        Ok(())
    }

    fn tick(&mut self, ctx: &mut Ctx) {
        if self.outcome.is_some() {
            return;
        }
        let seat = self.turn;
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
        if seat == self.turn {
            // 斷線的人從現在開始算等待時間
            self.turn_started = ctx.now;
        }
        ctx.changed();
    }

    fn view(&self, seat: Option<usize>, now: Instant) -> Value {
        let ended = self.outcome.is_some();
        let mine = seat.filter(|&s| s == self.turn && !ended);
        let plays: Vec<Value> = match mine {
            Some(_) => self.plays.iter().take(MAX_HINTS).map(Combo::json).collect(),
            None => Vec::new(),
        };
        let seats: Vec<Value> = (0..SEATS)
            .map(|s| {
                json!({
                    "count": self.hands[s].len(),
                    "online": self.online[s],
                    "last": Self::last_json(&self.last[s]),
                    "total": self.total(s),
                })
            })
            .collect();
        let result = self.outcome.as_ref().map(|o| {
            json!({
                "winner": o.winner,
                "deltas": o.deltas,
                // 結束了才公開大家剩下的牌
                "hands": self.hands,
            })
        });
        json!({
            "stage": if ended { "end" } else { "play" },
            "game": self.game,
            "options": self.options,
            "you": seat,
            "hand": seat.map(|s| &self.hands[s]),
            "seats": seats,
            "turn": (!ended).then_some(self.turn),
            "endsIn": self.deadline.filter(|_| !ended).map(|d| d.saturating_duration_since(now).as_millis() as u64),
            "table": self.table.as_ref().map(|(s, c)| json!({ "seat": s, "kind": c.kind, "cards": c.cards })),
            "first": self.first,
            "plays": plays,
            "result": result,
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

    /// 用「點數字串 + 花色字母」寫牌，例如 `c3`、`sA`、`h10`、`d2`
    fn c(name: &str) -> Card {
        let (s, r) = name.split_at(1);
        let suit = "cdhs".find(s).expect("suit") as u8;
        let rank = RANK_NAMES.iter().position(|&x| x == r).expect("rank") as u8;
        rank * 4 + suit
    }

    fn cards(names: &str) -> Vec<Card> {
        names.split_whitespace().map(c).collect()
    }

    fn combo(names: &str, options: &Options) -> Combo {
        classify(&cards(names), options).unwrap_or_else(|| panic!("{names} 應該是合法牌型"))
    }

    fn kind(names: &str, options: &Options) -> Option<Kind> {
        classify(&cards(names), options).map(|c| c.kind)
    }

    fn seats(bots: usize) -> Vec<SeatInfo> {
        (0..SEATS)
            .map(|i| SeatInfo { pid: i as u32 + 1, name: format!("P{i}"), bot: i >= SEATS - bots, online: true })
            .collect()
    }

    fn start(options: &Options, previous: Option<&BigTwo>, seats: &[SeatInfo], rng: &mut Rng) -> BigTwo {
        let mut out = Outbox::default();
        let mut ctx = crate::party::test_ctx(Instant::now(), rng, seats, &mut out);
        BigTwo::start(options, previous, &mut ctx)
    }

    fn act(g: &mut BigTwo, seats: &[SeatInfo], rng: &mut Rng, seat: usize, action: Action) -> Result<(), String> {
        let mut out = Outbox::default();
        let mut ctx = crate::party::test_ctx(Instant::now(), rng, seats, &mut out);
        g.act(seat, action, &mut ctx)
    }

    /// 指定每個人的手牌，從 `turn` 開始、自由出牌
    fn deal(g: &mut BigTwo, hands: [&str; 4], turn: usize, first: bool, seats: &[SeatInfo], rng: &mut Rng) {
        g.hands = hands
            .iter()
            .map(|h| {
                let mut h = cards(h);
                h.sort_unstable();
                h
            })
            .collect();
        g.first = first;
        g.table = None;
        g.passes = 0;
        let mut out = Outbox::default();
        let mut ctx = crate::party::test_ctx(Instant::now(), rng, seats, &mut out);
        g.set_turn(turn, &mut ctx);
    }

    #[test]
    fn card_order_is_rank_then_suit() {
        assert_eq!(c("c3"), CLUB_THREE);
        assert!(c("s3") < c("c4"));
        assert!(c("sA") < c("c2"));
        assert!(c("h2") < c("s2"));
        assert!(c("c2") > c("sK"));
        assert_eq!(card_name(c("s10")), "♠10");
    }

    #[test]
    fn classifies_hands() {
        let o = Options::default();
        assert_eq!(kind("h7", &o), Some(Kind::Single));
        assert_eq!(kind("h7 s7", &o), Some(Kind::Pair));
        assert_eq!(kind("h7 s8", &o), None);
        assert_eq!(kind("h7 s7 d7", &o), None, "預設沒有三條");
        assert_eq!(kind("h7 s7 d7", &Options { triples: true, ..o.clone() }), Some(Kind::Triple));
        assert_eq!(kind("c3 d4 h5 s6 c7", &o), Some(Kind::Straight));
        assert_eq!(kind("c10 dJ hQ sK cA", &o), Some(Kind::Straight));
        assert_eq!(kind("cA d2 h3 s4 c5", &o), Some(Kind::Straight));
        assert_eq!(kind("c2 d3 h4 s5 c6", &o), Some(Kind::Straight));
        assert_eq!(kind("cJ dQ hK sA c2", &o), None, "JQKA2 不算順子");
        assert_eq!(kind("cQ dK hA s2 c3", &o), None);
        assert_eq!(kind("h3 h7 h9 hJ h2", &o), Some(Kind::Flush));
        assert_eq!(kind("h3 h7 h9 hJ h2", &Options { flush: false, ..o.clone() }), None);
        assert_eq!(kind("c9 d9 h9 sK hK", &o), Some(Kind::FullHouse));
        assert_eq!(kind("c9 d9 h9 s9 h3", &o), Some(Kind::FourKind));
        assert_eq!(kind("s3 s4 s5 s6 s7", &o), Some(Kind::StraightFlush));
        assert_eq!(kind("s3 s4 s5 s6 s7", &Options { flush: false, ..o.clone() }), Some(Kind::StraightFlush));
        assert_eq!(kind("c3 d4", &o), None);
        assert_eq!(kind("c3 d3 h3 s3", &o), None, "四張不能出");
        assert_eq!(kind("c3 c3", &o), None, "重複的牌");
    }

    #[test]
    fn singles_and_pairs_compare_by_the_biggest_card() {
        let o = Options::default();
        assert!(beats(&combo("c2", &o), &combo("sA", &o), &o));
        assert!(beats(&combo("s5", &o), &combo("h5", &o), &o));
        assert!(!beats(&combo("h5", &o), &combo("s5", &o), &o));
        // 對子比大的那張：♠5♣5 > ♥5♦5
        assert!(beats(&combo("c5 s5", &o), &combo("d5 h5", &o), &o));
        assert!(!beats(&combo("c6 d6", &o), &combo("c2", &o), &o), "張數不同不能壓");
    }

    #[test]
    fn five_card_hands_rank_by_kind_then_strength() {
        let o = Options::default();
        let straight = combo("c10 dJ hQ sK cA", &o);
        let flush = combo("d3 d5 d7 d9 dJ", &o);
        let full = combo("c3 d3 h3 s4 h4", &o);
        let quads = combo("c4 d4 h4 s4 h9", &o);
        let sf = combo("c3 c4 c5 c6 c7", &o);
        for (low, high) in [(&straight, &flush), (&flush, &full), (&full, &quads), (&quads, &sf)] {
            assert!(beats(high, low, &o) && !beats(low, high, &o));
        }
        assert!(beats(&combo("cK dK hK s3 h3", &o), &combo("cQ dQ hQ sA hA", &o), &o), "葫蘆比三張的點數");
        assert!(beats(&combo("h3 h7 h9 hJ h2", &o), &combo("s3 s5 s7 s9 sA", &o), &o), "同花比最大的那張");
        assert!(beats(&combo("d3 d4 d5 d6 d7", &o), &combo("c3 c4 c5 c6 c7", &o), &o), "同花順同點數比花色");
    }

    #[test]
    fn straight_order_options() {
        let two_high = Options::default();
        let natural = Options { straights: Straights::Natural, ..Options::default() };
        let low = "c3 d4 h5 s6 c7";
        let top = "c10 dJ hQ sK dA";
        let a2345 = "cA d2 h3 s4 c5";
        let s23456 = "c2 d3 h4 s5 c6";
        let b = |a: &str, b: &str, o: &Options| beats(&combo(a, o), &combo(b, o), o);
        // 2 最大：23456 > A2345 > 10JQKA > … > 34567
        assert!(b(s23456, a2345, &two_high));
        assert!(b(a2345, top, &two_high));
        assert!(b(top, low, &two_high));
        // A 當 1：10JQKA > … > 34567 > 23456 > A2345
        assert!(b(top, low, &natural));
        assert!(b(low, s23456, &natural));
        assert!(b(s23456, a2345, &natural));
        // 一樣的點數比決定大小那張的花色：2 最大時看 2，否則看順子的頂
        assert!(b("cA d2 h3 s4 c5", "sA c2 h3 s4 c5", &two_high));
        assert!(b("c3 d4 h5 s6 s7", "c3 d4 h5 s6 h7", &two_high));
        assert!(b("cA c2 h3 s4 s5", "sA s2 h3 s4 h5", &natural));
    }

    #[test]
    fn bombs_only_with_the_option() {
        let o = Options::default();
        let bombs = Options { bombs: true, triples: true, ..Options::default() };
        let quads = "c4 d4 h4 s4 h9";
        assert!(!beats(&combo(quads, &o), &combo("s2", &o), &o));
        assert!(beats(&combo(quads, &bombs), &combo("s2", &bombs), &bombs));
        assert!(beats(&combo(quads, &bombs), &combo("h2 s2", &bombs), &bombs));
        assert!(beats(&combo("s3 s4 s5 s6 s7", &bombs), &combo("c2 d2 h2", &bombs), &bombs));
        assert!(!beats(&combo("c3 d4 h5 s6 c7", &bombs), &combo("s2", &bombs), &bombs), "順子不是炸彈");
    }

    #[test]
    fn legal_plays_follow_the_table() {
        let o = Options::default();
        let hand = cards("c3 d3 h5 s5 c7 d8 h9 s10 cJ s2");
        let first = legal_plays(&hand, None, true, &o);
        assert!(!first.is_empty() && first.iter().all(|p| p.cards.contains(&CLUB_THREE)));
        assert_eq!(first[0].cards, [CLUB_THREE], "提示由小到大");
        let table = combo("c4 d4", &o);
        let pairs = legal_plays(&hand, Some(&table), false, &o);
        assert_eq!(pairs.len(), 1);
        assert_eq!(pairs[0].cards, cards("h5 s5"));
        let straight = combo("c3 d4 h5 s6 c7", &o);
        let fives = legal_plays(&hand, Some(&straight), false, &o);
        assert!(fives.iter().all(|p| p.kind.size() == 5 && beats(p, &straight, &o)));
        assert!(fives.iter().any(|p| p.cards == cards("c7 d8 h9 s10 cJ")));
    }

    #[test]
    fn penalties() {
        let o = Options::default();
        assert_eq!(penalty(&cards("c3 d4 h5"), &o), 3);
        assert_eq!(penalty(&cards("c3 d3 h3 s3 c4 d4 h4 s4 c5 d5"), &o), 20);
        assert_eq!(penalty(&cards("c3 d3 h3 s3 c4 d4 h4 s4 c5 d5 h5 s5 c6"), &o), 39);
        let twos = Options { twos_double: true, ..Options::default() };
        assert_eq!(penalty(&cards("c3 d2 h2"), &twos), 12);
        assert_eq!(penalty(&cards("c3 d2 h2"), &o), 3);
    }

    #[test]
    fn club_three_leads_the_first_game() {
        let seats = seats(0);
        let mut rng = Rng::new();
        let o = Options::default();
        for _ in 0..10 {
            let g = start(&o, None, &seats, &mut rng);
            assert!(g.hands.iter().all(|h| h.len() == HAND));
            assert!(g.hands[g.turn].contains(&CLUB_THREE));
            assert!(g.first);
            assert!(g.plays.iter().all(|p| p.cards.contains(&CLUB_THREE)));
        }
        let mut g = start(&o, None, &seats, &mut rng);
        let leader = g.turn;
        let other = g.hands[leader].iter().copied().find(|&c| c != CLUB_THREE).unwrap();
        assert_eq!(
            act(&mut g, &seats, &mut rng, leader, Action::Play { cards: vec![other] }),
            Err("第一手必須包含 ♣3".into())
        );
        assert_eq!(act(&mut g, &seats, &mut rng, leader, Action::Pass), Err("自由出牌時不能 pass".into()));
        assert_eq!(act(&mut g, &seats, &mut rng, (leader + 1) % 4, Action::Pass), Err("還沒輪到你".into()));
        act(&mut g, &seats, &mut rng, leader, Action::Play { cards: vec![CLUB_THREE] }).unwrap();
        assert!(!g.first);
        assert_eq!(g.turn, (leader + 1) % 4);
    }

    #[test]
    fn three_passes_give_the_lead_back() {
        let seats = seats(0);
        let mut rng = Rng::new();
        let o = Options::default();
        let mut g = start(&o, None, &seats, &mut rng);
        deal(&mut g, ["c3 d5 h9", "c4 d4 d6", "c5 d7", "c6 d8"], 0, true, &seats, &mut rng);
        act(&mut g, &seats, &mut rng, 0, Action::Play { cards: cards("c3") }).unwrap();
        assert_eq!(
            act(&mut g, &seats, &mut rng, 1, Action::Play { cards: cards("c4 d4") }),
            Err("要出 1 張的牌型".into())
        );
        act(&mut g, &seats, &mut rng, 1, Action::Play { cards: cards("d6") }).unwrap();
        assert_eq!(act(&mut g, &seats, &mut rng, 2, Action::Play { cards: cards("c5") }), Err("壓不過桌上的牌".into()));
        act(&mut g, &seats, &mut rng, 2, Action::Pass).unwrap();
        act(&mut g, &seats, &mut rng, 3, Action::Pass).unwrap();
        // pass 過還可以再出
        act(&mut g, &seats, &mut rng, 0, Action::Play { cards: cards("h9") }).unwrap();
        act(&mut g, &seats, &mut rng, 1, Action::Pass).unwrap();
        act(&mut g, &seats, &mut rng, 2, Action::Pass).unwrap();
        assert!(g.table.is_some());
        act(&mut g, &seats, &mut rng, 3, Action::Pass).unwrap();
        assert_eq!(g.turn, 0, "其他三家都 pass，最後出牌的人重新出");
        assert!(g.table.is_none());
        assert!(g.last.iter().all(Option::is_none));
        act(&mut g, &seats, &mut rng, 0, Action::Play { cards: cards("d5") }).unwrap();
        assert!(g.finished());
        let o = g.outcome.as_ref().unwrap();
        assert_eq!(o.winner, 0);
        assert_eq!(o.deltas, [6, -2, -2, -2]);
        assert_eq!(g.total(0), 6);
    }

    #[test]
    fn scores_carry_over_and_the_winner_leads_next() {
        let seats = seats(0);
        let mut rng = Rng::new();
        let o = Options::default();
        let mut g = start(&o, None, &seats, &mut rng);
        deal(&mut g, ["c3", "c4 d4 h4 s4 c5 d5 h5 s5 c6 d6 h6", "c7 d7", "c8 d8 h8"], 0, true, &seats, &mut rng);
        act(&mut g, &seats, &mut rng, 0, Action::Play { cards: cards("c3") }).unwrap();
        assert_eq!(g.outcome.as_ref().unwrap().deltas, [27, -22, -2, -3]);
        let next = start(&o, Some(&g), &seats, &mut rng);
        assert_eq!(next.turn, 0, "上一局的贏家先出");
        assert!(!next.first);
        assert_eq!(next.total(0), 27);
        assert_eq!(next.total(1), -22);
        assert_eq!(next.game, 2);
    }

    #[test]
    fn timeouts_pass_or_play_the_smallest_single() {
        let seats = seats(0);
        let mut rng = Rng::new();
        let o = Options { think_secs: 15, ..Options::default() };
        let mut g = start(&o, None, &seats, &mut rng);
        deal(&mut g, ["c3 d5 h9", "c4 d6", "c5 d7", "c6 d8"], 0, true, &seats, &mut rng);
        let later = Instant::now() + Duration::from_secs(16);
        let mut out = Outbox::default();
        g.tick(&mut crate::party::test_ctx(later, &mut rng, &seats, &mut out));
        assert_eq!(g.table.as_ref().unwrap().1.cards, cards("c3"), "自由出牌時出最小的單張");
        assert_eq!(g.turn, 1);
        let later = later + Duration::from_secs(16);
        g.tick(&mut crate::party::test_ctx(later, &mut rng, &seats, &mut out));
        assert!(matches!(g.last[1], Some(Last::Pass)));
        // 斷線的人不用等滿思考時間
        g.online[2] = false;
        let later = later + OFFLINE_WAIT;
        g.tick(&mut crate::party::test_ctx(later, &mut rng, &seats, &mut out));
        assert!(matches!(g.last[2], Some(Last::Pass)));
    }

    #[test]
    fn views_only_show_your_own_hand() {
        let seats = seats(0);
        let mut rng = Rng::new();
        let g = start(&Options::default(), None, &seats, &mut rng);
        let now = Instant::now();
        for s in 0..SEATS {
            let view = g.view(Some(s), now);
            let hand: Vec<Card> = serde_json::from_value(view["hand"].clone()).unwrap();
            assert_eq!(hand, g.hands[s]);
            assert!(view["result"].is_null());
            for seat in view["seats"].as_array().unwrap() {
                assert_eq!(seat["count"], 13);
                assert!(seat.get("hand").is_none() && seat.get("cards").is_none());
            }
            // 提示只給輪到的人，而且都是自己的牌
            let plays = view["plays"].as_array().unwrap();
            assert_eq!(plays.is_empty(), s != g.turn);
            for p in plays {
                let cards: Vec<Card> = serde_json::from_value(p["cards"].clone()).unwrap();
                assert!(cards.iter().all(|c| g.hands[s].contains(c)));
            }
            // 除了自己的手牌和提示，view 裡不會出現任何一張牌（桌上還沒出牌）
            let mut stripped = view.clone();
            stripped["hand"] = Value::Null;
            stripped["plays"] = Value::Null;
            assert!(!stripped.to_string().contains("cards"), "{stripped}");
        }
        let spectator = g.view(None, now);
        assert!(spectator["hand"].is_null());
        assert!(spectator["plays"].as_array().unwrap().is_empty());
    }

    /// 跑一局到結束；`smart` 的座位用電腦的策略，其他座位永遠出最小的牌（沒得出才 pass）
    fn play_out(g: &mut BigTwo, seats: &[SeatInfo], rng: &mut Rng, smart: &[bool]) {
        for _ in 0..1000 {
            if g.finished() {
                break;
            }
            let seat = g.turn;
            let before: usize = g.hands.iter().map(Vec::len).sum::<usize>() + g.played.len();
            assert_eq!(before, 52, "牌不會多也不會少");
            let choice = if smart[seat] { g.bot_choice(seat, rng) } else { g.plays.first().cloned() };
            let action = match choice {
                Some(combo) => {
                    assert!(g.plays.contains(&combo), "電腦只會出合法的牌");
                    Action::Play { cards: combo.cards }
                }
                None => Action::Pass,
            };
            act(g, seats, rng, seat, action).unwrap_or_else(|e| panic!("座位 {seat}：{e}"));
        }
        assert!(g.finished(), "一局一定打得完");
        let o = g.outcome.as_ref().unwrap();
        assert!(g.hands[o.winner].is_empty());
        assert_eq!(o.deltas.iter().sum::<i32>(), 0);
    }

    #[test]
    fn bots_finish_many_games_under_every_rule_set() {
        let seats = seats(4);
        let mut rng = Rng::new();
        let rule_sets = [
            Options::default(),
            Options {
                flush: false,
                bombs: true,
                triples: true,
                straights: Straights::Natural,
                twos_double: true,
                think_secs: 0,
            },
        ];
        for o in &rule_sets {
            let mut previous: Option<BigTwo> = None;
            for _ in 0..20 {
                let mut g = start(o, previous.as_ref(), &seats, &mut rng);
                play_out(&mut g, &seats, &mut rng, &[true; 4]);
                previous = Some(g);
            }
            let p = previous.unwrap();
            assert_eq!((0..SEATS).map(|s| p.total(s)).sum::<i32>(), 0);
        }
    }

    #[test]
    fn bots_also_run_through_the_tick() {
        let seats = seats(4);
        let mut rng = Rng::new();
        let mut g = start(&Options::default(), None, &seats, &mut rng);
        let mut now = Instant::now();
        for _ in 0..2000 {
            if g.finished() {
                break;
            }
            now += Duration::from_millis(500);
            let mut out = Outbox::default();
            g.tick(&mut crate::party::test_ctx(now, &mut rng, &seats, &mut out));
        }
        assert!(g.finished());
    }

    /// 電腦對上三個「永遠出最小的牌」的對手，贏的局數要明顯多於四分之一（實測約 47%）
    #[test]
    fn bots_beat_a_naive_player() {
        let seats = seats(4);
        let mut rng = Rng::new();
        let o = Options::default();
        let games = 200;
        let mut wins = 0;
        for i in 0..games {
            let smart_seat = i % SEATS;
            let mut smart = [false; 4];
            smart[smart_seat] = true;
            let mut g = start(&o, None, &seats, &mut rng);
            play_out(&mut g, &seats, &mut rng, &smart);
            if g.outcome.as_ref().unwrap().winner == smart_seat {
                wins += 1;
            }
        }
        let rate = f64::from(wins) / f64::from(games as u32);
        eprintln!("電腦對三個出最小牌的對手：{wins}/{games} 勝（{:.0}%）", rate * 100.0);
        assert!(rate > 0.33, "勝率只有 {rate}");
    }
}
