//! UNO（派對房間，房間本身見 `party.rs`）。2～10 人，人不夠可以加電腦。
//!
//! 標準 108 張牌：紅黃綠藍四色各有 0 一張、1～9 各兩張、跳過／迴轉／+2 各兩張，加上萬用、萬用+4 各四張。
//! - 每人發 7 張，翻一張數字牌當起始牌（翻到功能牌就塞回牌堆底再翻）。
//! - 輪到的人出一張「同顏色」或「同數字／同符號」的牌，萬用牌隨時能出、出的人指定顏色。
//!   萬用+4 不檢查手上有沒有同色的牌（沒有質疑規則），休閒玩法比較單純。
//! - 不出（或沒得出）就抽一張，抽到能出的可以馬上出，否則換下一位；房主可以改成「抽到能出為止」。
//! - 跳過：下一位跳過。迴轉：換方向，兩個人玩時等於跳過。+2／+4：下一位抽牌而且跳過；
//!   開了「疊加」的話下一位可以再出 +2（或 +4）把罰抽疊上去、丟給再下一位，+4 上面只能疊 +4。
//! - UNO：出到剩一張時要喊 UNO（出牌時一起送，或出完馬上按）。沒喊的話，在下一個人出手之前，
//!   其他人都可以按「抓」，被抓到的人罰抽 2 張。誰先送到伺服器誰算，網路慢一點也公平。
//! - 計分：單局（贏的人 +1 分，在同一個房間累計），或累計點數：贏的人拿其他人手上牌的點數
//!   （數字照面額、功能牌 20、萬用牌 50），先到目標分數（預設 500）的人拿下整場，下一局重新算。
//! - 每手有時限（可以不限），時間到就自動抽牌、不出；斷線的人等一下就由電腦代打。
//!
//! 每個人的 view 只有自己的手牌，其他人只看得到張數；結束時才公開大家剩下的牌。
//! 電腦玩家出自己最多的顏色、萬用牌留到後面、下一家快出完時用功能牌卡他，喊 UNO 偶爾會忘記。

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
    party::{Ctx, Parties, PartyGame, Rng, To, shuffle},
};

/// 0～107。0～99 是有顏色的牌：`顏色 * 25 + k`，k 是 0（0 一張）、1～18（1～9 各兩張）、
/// 19～20 跳過、21～22 迴轉、23～24 +2；100～103 是萬用、104～107 是萬用+4。
pub type Card = u8;

pub const DECK: usize = 108;
/// 顏色：0 紅、1 黃、2 綠、3 藍
pub const COLORS: u8 = 4;
const HAND: usize = 7;
const PER_COLOR: u8 = 25;
const WILD_FIRST: Card = 100;
const WILD_FOUR_FIRST: Card = 104;
/// 輪到斷線的人：等這麼久就由電腦代打
const OFFLINE_WAIT: Duration = Duration::from_secs(5);
/// 沒喊 UNO 被抓到要抽幾張
const UNO_PENALTY: usize = 2;
/// view 裡留最近幾筆動作
const LOG_LEN: usize = 8;

pub const THINK_CHOICES: [u16; 5] = [0, 10, 20, 30, 60];
pub const TARGET_CHOICES: [u16; 3] = [200, 300, 500];

const COLOR_NAMES: [&str; 4] = ["紅", "黃", "綠", "藍"];

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Face {
    Number(u8),
    Skip,
    Reverse,
    DrawTwo,
    Wild,
    WildFour,
}

pub fn face(card: Card) -> Face {
    if card >= WILD_FOUR_FIRST {
        return Face::WildFour;
    }
    if card >= WILD_FIRST {
        return Face::Wild;
    }
    match card % PER_COLOR {
        0 => Face::Number(0),
        k @ 1..=18 => Face::Number(k.div_ceil(2)),
        19 | 20 => Face::Skip,
        21 | 22 => Face::Reverse,
        _ => Face::DrawTwo,
    }
}

/// 牌的顏色；萬用牌是 None
pub fn color(card: Card) -> Option<u8> {
    (card < WILD_FIRST).then_some(card / PER_COLOR)
}

fn is_wild(card: Card) -> bool {
    color(card).is_none()
}

/// 結算時的點數：數字照面額、功能牌 20、萬用牌 50
pub fn points(card: Card) -> u32 {
    match face(card) {
        Face::Number(n) => u32::from(n),
        Face::Skip | Face::Reverse | Face::DrawTwo => 20,
        Face::Wild | Face::WildFour => 50,
    }
}

pub fn card_name(card: Card) -> String {
    let face = match face(card) {
        Face::Number(n) => n.to_string(),
        Face::Skip => "跳過".into(),
        Face::Reverse => "迴轉".into(),
        Face::DrawTwo => "+2".into(),
        Face::Wild => return "萬用".into(),
        Face::WildFour => return "萬用+4".into(),
    };
    format!("{}{face}", COLOR_NAMES[usize::from(color(card).expect("colored"))])
}

/// 不管疊加和抽牌的狀態，`card` 能不能出在 `top`（現在的顏色是 `current`）上面
pub fn matches(card: Card, top: Card, current: u8) -> bool {
    is_wild(card) || color(card) == Some(current) || face(card) == face(top)
}

/// 計分方式
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub enum Scoring {
    /// 每局贏的人 +1 分
    #[default]
    Single,
    /// 贏的人拿其他人手上牌的點數，先到目標分數的人拿下整場
    Points,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Options {
    /// +2 上可以疊 +2 或 +4、+4 上可以疊 +4，罰抽累加給下一位
    pub stacking: bool,
    /// 沒得出時一直抽到能出為止（否則只抽一張）
    pub draw_until: bool,
    /// 每手的思考秒數，0 是不限
    pub think_secs: u16,
    pub scoring: Scoring,
    /// 累計點數模式的目標分數
    pub target: u16,
}

impl Default for Options {
    fn default() -> Self {
        Self { stacking: false, draw_until: false, think_secs: 20, scoring: Scoring::Single, target: 500 }
    }
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Action {
    /// 出牌；萬用牌要帶 `color`。`uno` 是出完剩一張時順便喊 UNO
    Play {
        card: Card,
        #[serde(default)]
        color: Option<u8>,
        #[serde(default)]
        uno: bool,
    },
    /// 抽牌（有罰抽時就是接下罰抽）
    Draw,
    /// 抽到能出的牌但不想出
    Pass,
    /// 剩一張、還沒被抓之前補喊 UNO
    Uno,
    /// 抓沒喊 UNO 的人
    Catch { seat: usize },
}

/// 最近的動作（畫在桌子旁邊）；抽到什麼牌不會公開
#[derive(Clone, Debug, PartialEq)]
enum Entry {
    Play { seat: usize, card: Card, color: u8 },
    Draw { seat: usize, count: usize },
    Pass { seat: usize },
    Caught { seat: usize, by: usize },
}

impl Entry {
    fn json(&self) -> Value {
        match *self {
            Entry::Play { seat, card, color } => json!({ "type": "play", "seat": seat, "card": card, "color": color }),
            Entry::Draw { seat, count } => json!({ "type": "draw", "seat": seat, "count": count }),
            Entry::Pass { seat } => json!({ "type": "pass", "seat": seat }),
            Entry::Caught { seat, by } => json!({ "type": "caught", "seat": seat, "by": by }),
        }
    }
}

#[derive(Clone, Debug)]
struct Outcome {
    winner: usize,
    /// 贏的人這局拿到的分數
    gained: i32,
    /// 累計點數模式：有人到達目標分數，整場結束（下一局重新算）
    champion: bool,
}

pub struct Uno {
    options: Options,
    pids: Vec<u32>,
    names: Vec<String>,
    bots: Vec<bool>,
    online: Vec<bool>,
    hands: Vec<Vec<Card>>,
    /// 抽牌堆，從最後面抽
    pile: Vec<Card>,
    /// 棄牌堆，最後一張是桌上的牌
    discard: Vec<Card>,
    /// 現在的顏色（萬用牌由出的人指定）
    color: u8,
    turn: usize,
    clockwise: bool,
    /// 疊加中的罰抽張數；0 是沒有
    pending: usize,
    /// 疊到最上面的是 +4（上面只能再疊 +4）
    pending_four: bool,
    /// 這手抽到、可以馬上出的牌（只能出這張或不出）
    drawn: Option<Card>,
    /// 喊過 UNO、現在剩一張的人
    called: Vec<bool>,
    /// 剩一張沒喊 UNO、現在可以被抓的人
    exposed: Option<usize>,
    /// 電腦什麼時候去抓
    catch_at: Option<Instant>,
    turn_started: Instant,
    deadline: Option<Instant>,
    bot_at: Option<Instant>,
    log: VecDeque<Entry>,
    outcome: Option<Outcome>,
    /// 累計分數（pid → 分）
    scores: HashMap<u32, i32>,
    /// 這個房間的第幾局
    game: u32,
}

impl Uno {
    fn players(&self) -> usize {
        self.hands.len()
    }

    /// 照現在的方向往後數 `steps` 個座位
    fn next(&self, seat: usize, steps: usize) -> usize {
        let n = self.players();
        if self.clockwise { (seat + steps) % n } else { (seat + n - steps % n) % n }
    }

    fn top(&self) -> Card {
        *self.discard.last().expect("there is always a top card")
    }

    fn total(&self, seat: usize) -> i32 {
        self.scores.get(&self.pids[seat]).copied().unwrap_or(0)
    }

    /// 現在 `card` 能不能出（不管是不是輪到、手上有沒有）
    fn can_play(&self, card: Card) -> bool {
        if self.drawn.is_some_and(|d| d != card) {
            return false;
        }
        if self.pending > 0 {
            return match face(card) {
                Face::DrawTwo => !self.pending_four,
                Face::WildFour => true,
                _ => false,
            };
        }
        matches(card, self.top(), self.color)
    }

    fn playable(&self, seat: usize) -> Vec<Card> {
        let mut cards: Vec<Card> = self.hands[seat].iter().copied().filter(|&c| self.can_play(c)).collect();
        cards.dedup();
        cards
    }

    fn push_log(&mut self, entry: Entry) {
        if self.log.len() >= LOG_LEN {
            self.log.pop_front();
        }
        self.log.push_back(entry);
    }

    /// 從抽牌堆抽 `n` 張；抽完了就把棄牌堆（桌上那張以外）洗一洗當新的抽牌堆。回傳抽到的牌。
    fn draw_cards(&mut self, seat: usize, n: usize, rng: &mut Rng) -> Vec<Card> {
        let mut got = Vec::with_capacity(n);
        for _ in 0..n {
            if self.pile.is_empty() && self.discard.len() > 1 {
                let top = self.discard.pop().expect("top");
                self.pile = std::mem::replace(&mut self.discard, vec![top]);
                shuffle(rng, &mut self.pile);
            }
            let Some(card) = self.pile.pop() else { break };
            got.push(card);
        }
        if !got.is_empty() {
            self.hands[seat].extend(&got);
            self.hands[seat].sort_unstable();
            self.called[seat] = false;
        }
        got
    }

    fn set_turn(&mut self, seat: usize, ctx: &mut Ctx) {
        self.turn = seat;
        self.drawn = None;
        self.restart_clock(ctx);
    }

    /// 這手重新計時（換人，或抽到能出的牌要再想一下）
    fn restart_clock(&mut self, ctx: &mut Ctx) {
        self.turn_started = ctx.now;
        self.deadline =
            (self.options.think_secs > 0).then(|| ctx.now + Duration::from_secs(u64::from(self.options.think_secs)));
        // 電腦想一下再出，看起來比較自然
        self.bot_at = self.bots[self.turn].then(|| ctx.now + Duration::from_secs_f64(ctx.rng.range(0.9, 1.6)));
        ctx.changed();
    }

    /// 輪到的人開始動作：上一個沒喊 UNO 的人就不能再被抓了
    fn close_window(&mut self) {
        self.exposed = None;
        self.catch_at = None;
    }

    fn play(&mut self, seat: usize, card: Card, chosen: u8, uno: bool, ctx: &mut Ctx) {
        self.close_window();
        let i = self.hands[seat].iter().position(|&c| c == card).expect("card in hand");
        self.hands[seat].remove(i);
        self.discard.push(card);
        self.color = color(card).unwrap_or(chosen);
        self.drawn = None;
        self.push_log(Entry::Play { seat, card, color: self.color });

        if self.hands[seat].len() == 1 {
            if uno {
                self.called[seat] = true;
                ctx.announce(To::All, format!("{}：UNO！", self.names[seat]), "accent");
            } else {
                self.exposed = Some(seat);
                // 有電腦在桌上就可能被抓（電腦不是每次都注意到）
                let watchers = (0..self.players()).any(|s| s != seat && self.bots[s]);
                if watchers && ctx.rng.chance(0.6) {
                    self.catch_at = Some(ctx.now + Duration::from_secs_f64(ctx.rng.range(1.2, 3.0)));
                }
            }
        }

        let after = match face(card) {
            Face::Skip => self.next(seat, 2),
            Face::Reverse => {
                self.clockwise = !self.clockwise;
                // 兩個人玩時迴轉等於跳過
                if self.players() == 2 { seat } else { self.next(seat, 1) }
            }
            Face::DrawTwo | Face::WildFour => {
                let amount = if face(card) == Face::WildFour { 4 } else { 2 };
                if self.options.stacking {
                    self.pending += amount;
                    self.pending_four = face(card) == Face::WildFour;
                    self.next(seat, 1)
                } else {
                    let victim = self.next(seat, 1);
                    self.penalize(victim, amount, ctx);
                    self.next(seat, 2)
                }
            }
            _ => self.next(seat, 1),
        };

        if self.hands[seat].is_empty() {
            // 最後一張是 +2／+4 的話，疊著的罰抽一樣要抽（算進點數）
            if self.pending > 0 {
                let victim = self.next(seat, 1);
                let amount = std::mem::take(&mut self.pending);
                self.penalize(victim, amount, ctx);
            }
            self.finish(seat, ctx);
        } else {
            self.set_turn(after, ctx);
        }
    }

    fn penalize(&mut self, seat: usize, amount: usize, ctx: &mut Ctx) {
        let got = self.draw_cards(seat, amount, ctx.rng);
        self.push_log(Entry::Draw { seat, count: got.len() });
    }

    /// 抽牌：有罰抽就接下來、換下一位；否則抽一張（或抽到能出為止），抽到能出的就留著讓他決定
    fn draw(&mut self, seat: usize, ctx: &mut Ctx) {
        self.close_window();
        if self.pending > 0 {
            let amount = std::mem::take(&mut self.pending);
            self.pending_four = false;
            self.penalize(seat, amount, ctx);
            self.set_turn(self.next(seat, 1), ctx);
            return;
        }
        let mut count = 0;
        let mut playable = None;
        loop {
            let got = self.draw_cards(seat, 1, ctx.rng);
            let Some(&card) = got.first() else { break };
            count += 1;
            if self.can_play(card) {
                playable = Some(card);
                break;
            }
            if !self.options.draw_until {
                break;
            }
        }
        self.push_log(Entry::Draw { seat, count });
        if playable.is_some() {
            self.drawn = playable;
            self.restart_clock(ctx);
        } else {
            self.set_turn(self.next(seat, 1), ctx);
        }
    }

    fn pass(&mut self, seat: usize, ctx: &mut Ctx) {
        self.close_window();
        self.push_log(Entry::Pass { seat });
        self.set_turn(self.next(seat, 1), ctx);
    }

    fn finish(&mut self, winner: usize, ctx: &mut Ctx) {
        let gained = match self.options.scoring {
            Scoring::Single => 1,
            Scoring::Points => self.hands.iter().flatten().map(|&c| points(c) as i32).sum(),
        };
        *self.scores.entry(self.pids[winner]).or_default() += gained;
        let champion = self.options.scoring == Scoring::Points && self.total(winner) >= i32::from(self.options.target);
        let who = &self.names[winner];
        let text = match self.options.scoring {
            Scoring::Single => format!("{who} 出完了！拿下第 {} 局", self.game),
            Scoring::Points if champion => {
                format!("{who} 出完了，拿到 {gained} 分，累計 {} 分，拿下整場！", self.total(winner))
            }
            Scoring::Points => format!("{who} 出完了，拿到 {gained} 分"),
        };
        ctx.announce(To::All, text, "ok");
        self.outcome = Some(Outcome { winner, gained, champion });
        self.close_window();
        self.deadline = None;
        self.bot_at = None;
        self.drawn = None;
        ctx.changed();
    }

    /// 時間到：有罰抽就接下、抽到能出的就不出、否則抽一張不出
    fn auto(&mut self, ctx: &mut Ctx) {
        let seat = self.turn;
        ctx.system(To::All, format!("{} 沒有出手，自動抽牌", self.names[seat]));
        if self.drawn.is_none() {
            self.draw(seat, ctx);
        }
        if self.turn == seat && self.drawn.is_some() && self.outcome.is_none() {
            self.pass(seat, ctx);
        }
    }

    /// 電腦（或斷線的人由電腦代打）出一手：能出就出，不然抽牌，抽到能出的就出
    fn bot_move(&mut self, ctx: &mut Ctx) {
        let seat = self.turn;
        // 真人斷線由電腦代打時一定會喊 UNO；電腦自己偶爾會忘記
        let uno = !self.bots[seat] || ctx.rng.chance(0.85);
        if let Some(card) = self.bot_choice(seat, ctx.rng) {
            let chosen = self.bot_color(seat, ctx.rng);
            self.play(seat, card, chosen, uno, ctx);
            return;
        }
        if self.drawn.is_none() {
            self.draw(seat, ctx);
        }
        if self.turn == seat
            && let Some(card) = self.drawn
        {
            let chosen = self.bot_color(seat, ctx.rng);
            self.play(seat, card, chosen, uno, ctx);
        }
    }

    /// 電腦要出哪張；None 是抽牌。只用到公開資訊（張數、桌上的牌）和自己的手牌。
    fn bot_choice(&self, seat: usize, rng: &mut Rng) -> Option<Card> {
        let hand = &self.hands[seat];
        let options = self.playable(seat);
        if options.is_empty() {
            return None;
        }
        if self.pending > 0 {
            // 能疊就疊，+2 比 +4 便宜
            return options.iter().copied().min_by_key(|&c| face(c) == Face::WildFour);
        }
        let counts = color_counts(hand);
        let next_left = self.hands[self.next(seat, 1)].len();
        let mut best: Option<(f64, Card)> = None;
        for &card in &options {
            let mut score = match (face(card), color(card)) {
                (Face::Wild, _) => -6.0,
                (Face::WildFour, _) if next_left <= 2 => 18.0,
                (Face::WildFour, _) => -9.0,
                (f, Some(c)) => {
                    // 出自己最多的顏色，順便把點數高的先丟掉
                    let mut s = 10.0 + 2.0 * f64::from(counts[usize::from(c)]) + f64::from(points(card)) / 10.0;
                    if counts[usize::from(c)] == 1 {
                        // 出掉這個顏色的最後一張，下一手可能就沒得接
                        s -= 3.0;
                    }
                    if next_left <= 2 && matches!(f, Face::Skip | Face::DrawTwo) {
                        s += 15.0;
                    }
                    if next_left <= 2 && f == Face::Reverse && self.players() > 2 {
                        s += 8.0;
                    }
                    s
                }
                (_, None) => unreachable!("only wilds have no color"),
            };
            if hand.len() <= 2 && is_wild(card) {
                // 快出完了，萬用牌一定接得上，留著沒意義
                score += 20.0;
            }
            score += rng.range(0.0, 2.0);
            if best.is_none_or(|(b, _)| score > b) {
                best = Some((score, card));
            }
        }
        best.map(|(_, card)| card)
    }

    /// 出萬用牌時指定手上最多的顏色（同樣多就隨機）
    fn bot_color(&self, seat: usize, rng: &mut Rng) -> u8 {
        let counts = color_counts(&self.hands[seat]);
        let most = *counts.iter().max().expect("four colors");
        let tied: Vec<u8> = (0..COLORS).filter(|&c| counts[usize::from(c)] == most).collect();
        tied[rng.below(tied.len())]
    }

    /// 電腦抓沒喊 UNO 的人
    fn bot_catch(&mut self, ctx: &mut Ctx) {
        let Some(target) = self.exposed else { return };
        let bots: Vec<usize> = (0..self.players()).filter(|&s| s != target && self.bots[s]).collect();
        if !bots.is_empty() {
            let by = bots[ctx.rng.below(bots.len())];
            self.catch(by, target, ctx);
        }
    }

    fn catch(&mut self, by: usize, target: usize, ctx: &mut Ctx) {
        self.close_window();
        let got = self.draw_cards(target, UNO_PENALTY, ctx.rng);
        self.push_log(Entry::Caught { seat: target, by });
        ctx.announce(
            To::All,
            format!("{} 抓到 {} 沒喊 UNO，罰抽 {} 張", self.names[by], self.names[target], got.len()),
            "danger",
        );
        ctx.changed();
    }
}

/// 手上每個顏色有幾張（萬用牌不算）
fn color_counts(hand: &[Card]) -> [u32; 4] {
    let mut counts = [0u32; 4];
    for c in hand.iter().filter_map(|&c| color(c)) {
        counts[usize::from(c)] += 1;
    }
    counts
}

impl PartyGame for Uno {
    const ID: &'static str = "uno";
    const MIN_PLAYERS: usize = 2;
    const MAX_PLAYERS: usize = 10;
    const MAX_BOTS: usize = 9;

    type Options = Options;
    type Action = Action;

    fn rooms(state: &AppState) -> &Arc<Parties<Self>> {
        &state.uno
    }

    fn check_options(options: Options) -> Result<Options, String> {
        if !THINK_CHOICES.contains(&options.think_secs) {
            return Err("思考時間只能選不限、10、20、30 或 60 秒".into());
        }
        if !TARGET_CHOICES.contains(&options.target) {
            return Err("目標分數只能選 200、300 或 500".into());
        }
        Ok(options)
    }

    fn start(options: &Options, previous: Option<&Self>, ctx: &mut Ctx) -> Self {
        let n = ctx.seats.len();
        let mut pile: Vec<Card> = (0..DECK as Card).collect();
        shuffle(ctx.rng, &mut pile);
        let mut hands: Vec<Vec<Card>> = (0..n)
            .map(|_| {
                let mut hand = pile.split_off(pile.len() - HAND);
                hand.sort_unstable();
                hand
            })
            .collect();
        hands.shrink_to_fit();
        // 起始牌要是數字牌，翻到功能牌就塞回牌堆底
        let first = loop {
            let card = pile.pop().expect("enough cards");
            if matches!(face(card), Face::Number(_)) {
                break card;
            }
            pile.insert(0, card);
        };
        let pids: Vec<u32> = ctx.seats.iter().map(|s| s.pid).collect();
        // 上一局的贏家還在桌上就由他的下一位先出，否則隨機
        let winner = previous
            .and_then(|p| p.outcome.as_ref().map(|o| p.pids[o.winner]))
            .and_then(|pid| pids.iter().position(|&p| p == pid));
        let leader = winner.map_or_else(|| ctx.rng.below(n), |w| (w + 1) % n);
        // 整場結束了、或換了計分方式就重新算分
        let scores = match previous {
            Some(p) if p.options.scoring == options.scoring && !p.outcome.as_ref().is_some_and(|o| o.champion) => {
                p.scores.clone()
            }
            _ => HashMap::new(),
        };

        let mut game = Self {
            options: options.clone(),
            names: ctx.seats.iter().map(|s| s.name.clone()).collect(),
            bots: ctx.seats.iter().map(|s| s.bot).collect(),
            online: ctx.seats.iter().map(|s| s.online).collect(),
            pids,
            hands,
            pile,
            discard: vec![first],
            color: color(first).expect("number cards have a color"),
            turn: leader,
            clockwise: true,
            pending: 0,
            pending_four: false,
            drawn: None,
            called: vec![false; n],
            exposed: None,
            catch_at: None,
            turn_started: ctx.now,
            deadline: None,
            bot_at: None,
            log: VecDeque::new(),
            outcome: None,
            scores,
            game: previous.map_or(1, |p| p.game + 1),
        };
        ctx.system(
            To::All,
            format!("第 {} 局：起始牌是{}，由 {} 先出", game.game, card_name(first), game.names[leader]),
        );
        game.set_turn(leader, ctx);
        game
    }

    fn act(&mut self, seat: usize, action: Action, ctx: &mut Ctx) -> Result<(), String> {
        if self.outcome.is_some() {
            return Err("這局已經結束了".into());
        }
        match action {
            Action::Uno => {
                if self.exposed == Some(seat) {
                    self.close_window();
                    self.called[seat] = true;
                    ctx.announce(To::All, format!("{}：UNO！", self.names[seat]), "accent");
                } else if self.called[seat] {
                    return Err("你已經喊過 UNO 了".into());
                } else if self.hands[seat].len() == 1 {
                    return Err("來不及了，已經可以被抓了".into());
                } else {
                    return Err("出到剩一張時再喊 UNO（出牌前先按「UNO!」）".into());
                }
            }
            Action::Catch { seat: target } => {
                if target == seat {
                    return Err("不能抓自己，按「UNO!」補喊".into());
                }
                if self.exposed != Some(target) {
                    return Err("來不及了（他已經喊了，或下一位已經出手）".into());
                }
                self.catch(seat, target, ctx);
            }
            Action::Draw => {
                if seat != self.turn {
                    return Err("還沒輪到你".into());
                }
                if self.drawn.is_some() {
                    return Err("你已經抽過了：出剛抽到的牌，或按「不出」".into());
                }
                self.draw(seat, ctx);
            }
            Action::Pass => {
                if seat != self.turn {
                    return Err("還沒輪到你".into());
                }
                if self.drawn.is_none() {
                    return Err("要先抽牌才能不出".into());
                }
                self.pass(seat, ctx);
            }
            Action::Play { card, color: chosen, uno } => {
                if seat != self.turn {
                    return Err("還沒輪到你".into());
                }
                if !self.hands[seat].contains(&card) {
                    return Err("你手上沒有這張牌".into());
                }
                if !self.can_play(card) {
                    return Err(if self.drawn.is_some() {
                        "抽牌之後只能出剛抽到的那張".into()
                    } else if self.pending > 0 {
                        format!("要疊{}，或抽 {} 張", if self.pending_four { " +4" } else { " +2 或 +4" }, self.pending)
                    } else {
                        "要出同顏色或同數字／符號的牌".into()
                    });
                }
                let chosen = match (is_wild(card), chosen) {
                    (true, Some(c)) if c < COLORS => c,
                    (true, _) => return Err("請選一個顏色".into()),
                    (false, _) => 0,
                };
                self.play(seat, card, chosen, uno, ctx);
            }
        }
        Ok(())
    }

    fn tick(&mut self, ctx: &mut Ctx) {
        if self.outcome.is_some() {
            return;
        }
        if self.catch_at.is_some_and(|t| ctx.now >= t) {
            self.catch_at = None;
            self.bot_catch(ctx);
        }
        let seat = self.turn;
        if self.bot_at.is_some_and(|t| ctx.now >= t) {
            self.bot_at = None;
            self.bot_move(ctx);
        } else if !self.bots[seat] && !self.online[seat] && ctx.now.duration_since(self.turn_started) >= OFFLINE_WAIT {
            ctx.system(To::All, format!("{} 離線了，由電腦代打", self.names[seat]));
            self.bot_move(ctx);
        } else if self.deadline.is_some_and(|d| ctx.now >= d) {
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
        let seats: Vec<Value> = (0..self.players())
            .map(|s| {
                json!({
                    "count": self.hands[s].len(),
                    "online": self.online[s],
                    "uno": self.called[s],
                    "total": self.total(s),
                })
            })
            .collect();
        let result = self.outcome.as_ref().map(|o| {
            json!({
                "winner": o.winner,
                "gained": o.gained,
                "champion": o.champion,
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
            "clockwise": self.clockwise,
            "endsIn": self.deadline.filter(|_| !ended).map(|d| d.saturating_duration_since(now).as_millis() as u64),
            "top": self.top(),
            "color": self.color,
            "pending": self.pending,
            "pendingFour": self.pending_four,
            "pile": self.pile.len(),
            "drawn": mine.and(self.drawn),
            "playable": mine.map(|s| self.playable(s)).unwrap_or_default(),
            "exposed": self.exposed,
            "log": self.log.iter().map(Entry::json).collect::<Vec<_>>(),
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

    /// 用「顏色字母 + 牌面」寫有顏色的牌，例如 `r7`、`gS`（跳過）、`bR`（迴轉）、`y+2`；萬用是 `W`、`W4`。
    /// 同一種牌有兩張時 `'` 結尾的是第二張（`r7'`）。
    fn c(name: &str) -> Card {
        match name {
            "W" => return WILD_FIRST,
            "W'" => return WILD_FIRST + 1,
            "W4" => return WILD_FOUR_FIRST,
            "W4'" => return WILD_FOUR_FIRST + 1,
            _ => {}
        }
        let (name, second) = match name.strip_suffix('\'') {
            Some(n) => (n, 1),
            None => (name, 0),
        };
        let (col, f) = name.split_at(1);
        let col = "rygb".find(col).expect("color") as u8;
        let k = match f {
            "0" => 0,
            "S" => 19,
            "R" => 21,
            "+2" => 23,
            n => n.parse::<u8>().expect("number") * 2 - 1,
        };
        col * PER_COLOR + k + second
    }

    fn cards(names: &str) -> Vec<Card> {
        names.split_whitespace().map(c).collect()
    }

    fn seats(n: usize, bots: usize) -> Vec<SeatInfo> {
        (0..n)
            .map(|i| SeatInfo { pid: i as u32 + 1, name: format!("P{i}"), bot: i >= n - bots, online: true })
            .collect()
    }

    fn start(options: &Options, previous: Option<&Uno>, seats: &[SeatInfo], rng: &mut Rng) -> Uno {
        let mut out = Outbox::default();
        let mut ctx = crate::party::test_ctx(Instant::now(), rng, seats, &mut out);
        Uno::start(options, previous, &mut ctx)
    }

    fn act(g: &mut Uno, seats: &[SeatInfo], rng: &mut Rng, seat: usize, action: Action) -> Result<(), String> {
        let mut out = Outbox::default();
        let mut ctx = crate::party::test_ctx(Instant::now(), rng, seats, &mut out);
        g.act(seat, action, &mut ctx)
    }

    fn play(card: &str) -> Action {
        Action::Play { card: c(card), color: None, uno: false }
    }

    /// 指定手牌、桌上的牌和抽牌堆（最後一張先被抽），從 `turn` 開始、順時針
    fn rig(g: &mut Uno, hands: &[&str], top: &str, pile: &str, turn: usize, seats: &[SeatInfo], rng: &mut Rng) {
        g.hands = hands
            .iter()
            .map(|h| {
                let mut h = cards(h);
                h.sort_unstable();
                h
            })
            .collect();
        g.discard = vec![c(top)];
        g.color = color(c(top)).unwrap_or(0);
        g.pile = cards(pile);
        g.clockwise = true;
        g.pending = 0;
        g.called.fill(false);
        let mut out = Outbox::default();
        let mut ctx = crate::party::test_ctx(Instant::now(), rng, seats, &mut out);
        g.set_turn(turn, &mut ctx);
    }

    /// 牌不會多也不會少
    fn assert_conserved(g: &Uno) {
        let mut all: Vec<Card> = g.hands.iter().flatten().chain(&g.pile).chain(&g.discard).copied().collect();
        all.sort_unstable();
        assert_eq!(all, (0..DECK as Card).collect::<Vec<_>>());
    }

    #[test]
    fn the_deck_has_108_cards() {
        let faces: Vec<Face> = (0..DECK as Card).map(face).collect();
        let count = |f: Face| faces.iter().filter(|&&x| x == f).count();
        assert_eq!(count(Face::Number(0)), 4);
        for n in 1..=9 {
            assert_eq!(count(Face::Number(n)), 8, "{n}");
        }
        assert_eq!(count(Face::Skip), 8);
        assert_eq!(count(Face::Reverse), 8);
        assert_eq!(count(Face::DrawTwo), 8);
        assert_eq!(count(Face::Wild), 4);
        assert_eq!(count(Face::WildFour), 4);
        for col in 0..COLORS {
            assert_eq!((0..DECK as Card).filter(|&x| color(x) == Some(col)).count(), 25);
        }
        assert_eq!(card_name(c("r7")), "紅7");
        assert_eq!(card_name(c("b+2'")), "藍+2");
        assert_eq!(card_name(c("W4")), "萬用+4");
        assert_eq!(face(c("g9'")), Face::Number(9));
        assert_eq!((0..DECK as Card).map(points).sum::<u32>(), 4 * (2 * 45 + 6 * 20) + 8 * 50);
    }

    #[test]
    fn matching_color_number_or_symbol() {
        assert!(matches(c("r3"), c("r7"), 0), "同顏色");
        assert!(matches(c("b7"), c("r7"), 0), "同數字");
        assert!(matches(c("gS"), c("rS"), 0), "同符號");
        assert!(!matches(c("g3"), c("r7"), 0));
        assert!(matches(c("W"), c("r7"), 0) && matches(c("W4"), c("r7"), 0), "萬用牌隨時能出");
        // 萬用牌之後看指定的顏色
        assert!(matches(c("y5"), c("W"), 1));
        assert!(!matches(c("r5"), c("W"), 1));
    }

    #[test]
    fn deals_seven_and_starts_on_a_number() {
        let mut rng = Rng::new();
        for n in [2, 5, 10] {
            let seats = seats(n, 0);
            for _ in 0..20 {
                let g = start(&Options::default(), None, &seats, &mut rng);
                assert!(g.hands.iter().all(|h| h.len() == HAND));
                assert!(matches!(face(g.top()), Face::Number(_)));
                assert_eq!(Some(g.color), color(g.top()));
                assert_conserved(&g);
            }
        }
    }

    #[test]
    fn plays_must_match_and_turns_rotate() {
        let seats = seats(3, 0);
        let mut rng = Rng::new();
        let mut g = start(&Options::default(), None, &seats, &mut rng);
        rig(&mut g, &["r3 g5 b1", "r4 y1 y2", "r5 y3 y4"], "r7", "g1 g2 g3", 0, &seats, &mut rng);
        assert_eq!(act(&mut g, &seats, &mut rng, 1, play("r4")), Err("還沒輪到你".into()));
        assert_eq!(act(&mut g, &seats, &mut rng, 0, play("g5")), Err("要出同顏色或同數字／符號的牌".into()));
        assert_eq!(act(&mut g, &seats, &mut rng, 0, play("y1")), Err("你手上沒有這張牌".into()));
        act(&mut g, &seats, &mut rng, 0, play("r3")).unwrap();
        assert_eq!(g.turn, 1);
        assert_eq!(g.top(), c("r3"));
        assert_eq!(g.playable(1), cards("r4"));
    }

    #[test]
    fn wilds_need_a_color() {
        let seats = seats(2, 0);
        let mut rng = Rng::new();
        let mut g = start(&Options::default(), None, &seats, &mut rng);
        rig(&mut g, &["W g5 b1", "y4 r1"], "r7", "", 0, &seats, &mut rng);
        assert_eq!(act(&mut g, &seats, &mut rng, 0, play("W")), Err("請選一個顏色".into()));
        let bad = Action::Play { card: c("W"), color: Some(4), uno: false };
        assert_eq!(act(&mut g, &seats, &mut rng, 0, bad), Err("請選一個顏色".into()));
        act(&mut g, &seats, &mut rng, 0, Action::Play { card: c("W"), color: Some(1), uno: false }).unwrap();
        assert_eq!(g.color, 1);
        assert_eq!(g.playable(1), cards("y4"));
    }

    #[test]
    fn skip_and_reverse() {
        let seats = seats(4, 0);
        let mut rng = Rng::new();
        let mut g = start(&Options::default(), None, &seats, &mut rng);
        rig(&mut g, &["rS r1 r2", "r3 r4", "rR r5", "r6 r8"], "r7", "", 0, &seats, &mut rng);
        act(&mut g, &seats, &mut rng, 0, play("rS")).unwrap();
        assert_eq!(g.turn, 2, "跳過座位 1");
        act(&mut g, &seats, &mut rng, 2, play("rR")).unwrap();
        assert!(!g.clockwise);
        assert_eq!(g.turn, 1, "迴轉之後往回走");
        act(&mut g, &seats, &mut rng, 1, play("r3")).unwrap();
        assert_eq!(g.turn, 0);
        act(&mut g, &seats, &mut rng, 0, play("r1")).unwrap();
        assert_eq!(g.turn, 3, "逆時針從 0 走到 3");
    }

    #[test]
    fn reverse_with_two_players_is_a_skip() {
        let seats = seats(2, 0);
        let mut rng = Rng::new();
        let mut g = start(&Options::default(), None, &seats, &mut rng);
        rig(&mut g, &["rR r1 r2", "g3 g4"], "r7", "", 0, &seats, &mut rng);
        act(&mut g, &seats, &mut rng, 0, play("rR")).unwrap();
        assert_eq!(g.turn, 0, "兩個人玩時迴轉等於跳過");
        rig(&mut g, &["rS r1 r2", "g3 g4"], "r7", "", 0, &seats, &mut rng);
        act(&mut g, &seats, &mut rng, 0, play("rS")).unwrap();
        assert_eq!(g.turn, 0);
    }

    #[test]
    fn draw_two_without_stacking_skips_the_victim() {
        let seats = seats(3, 0);
        let mut rng = Rng::new();
        let mut g = start(&Options::default(), None, &seats, &mut rng);
        rig(&mut g, &["r+2 r1 r2", "r+2' g4", "b5 b6"], "r7", "y1 y2 y3", 0, &seats, &mut rng);
        act(&mut g, &seats, &mut rng, 0, play("r+2")).unwrap();
        assert_eq!(g.hands[1].len(), 4, "下一位抽 2 張");
        assert_eq!(g.turn, 2, "而且被跳過");
        assert_eq!(g.pending, 0);
    }

    #[test]
    fn stacking_passes_the_penalty_along() {
        let seats = seats(3, 0);
        let mut rng = Rng::new();
        let o = Options { stacking: true, ..Options::default() };
        let mut g = start(&o, None, &seats, &mut rng);
        rig(&mut g, &["r+2 r1 r2", "g+2 W4 g4", "b+2 b5 b6"], "r7", "y1 y2 y3 y4 y5 y6 y7 y8 y9", 0, &seats, &mut rng);
        act(&mut g, &seats, &mut rng, 0, play("r+2")).unwrap();
        assert_eq!((g.turn, g.pending), (1, 2));
        assert_eq!(g.playable(1), cards("g+2 W4"));
        assert_eq!(act(&mut g, &seats, &mut rng, 1, play("g4")), Err("要疊 +2 或 +4，或抽 2 張".into()));
        act(&mut g, &seats, &mut rng, 1, Action::Play { card: c("W4"), color: Some(3), uno: false }).unwrap();
        assert_eq!((g.turn, g.pending), (2, 6));
        assert!(g.playable(2).is_empty(), "+4 上面不能疊 +2");
        act(&mut g, &seats, &mut rng, 2, Action::Draw).unwrap();
        assert_eq!(g.hands[2].len(), 9);
        assert_eq!((g.turn, g.pending), (0, 0), "接下罰抽就換人");
        assert_eq!(g.color, 3);
    }

    #[test]
    fn draw_then_play_or_pass() {
        let seats = seats(2, 0);
        let mut rng = Rng::new();
        let mut g = start(&Options::default(), None, &seats, &mut rng);
        rig(&mut g, &["g1 g2", "b5 b6"], "r7", "y1 r9", 0, &seats, &mut rng);
        assert_eq!(act(&mut g, &seats, &mut rng, 0, Action::Pass), Err("要先抽牌才能不出".into()));
        act(&mut g, &seats, &mut rng, 0, Action::Draw).unwrap();
        assert_eq!(g.drawn, Some(c("r9")), "抽到能出的就留著讓他決定");
        assert_eq!(g.turn, 0);
        assert_eq!(
            act(&mut g, &seats, &mut rng, 0, Action::Draw),
            Err("你已經抽過了：出剛抽到的牌，或按「不出」".into())
        );
        let view = g.view(Some(0), Instant::now());
        assert_eq!(view["drawn"], c("r9"));
        assert!(g.view(Some(1), Instant::now())["drawn"].is_null(), "別人看不到抽到什麼");
        act(&mut g, &seats, &mut rng, 0, Action::Pass).unwrap();
        assert_eq!(g.turn, 1);
        let mut kept = cards("g1 g2 r9");
        kept.sort_unstable();
        assert_eq!(g.hands[0], kept);
        // 抽到不能出的直接換人
        act(&mut g, &seats, &mut rng, 1, Action::Draw).unwrap();
        assert_eq!(g.turn, 0);
        assert_eq!(g.hands[1].len(), 3);
    }

    #[test]
    fn draw_until_playable() {
        let seats = seats(2, 0);
        let mut rng = Rng::new();
        let o = Options { draw_until: true, ..Options::default() };
        let mut g = start(&o, None, &seats, &mut rng);
        rig(&mut g, &["g1 g2", "b5 b6"], "r7", "r1 b7 y2 g3", 0, &seats, &mut rng);
        act(&mut g, &seats, &mut rng, 0, Action::Draw).unwrap();
        // 從最後面抽：g3、y2 不能出，b7 能出（同數字）
        assert_eq!(g.drawn, Some(c("b7")));
        assert_eq!(g.hands[0].len(), 5);
        assert_eq!(g.log.back(), Some(&Entry::Draw { seat: 0, count: 3 }));
        assert_eq!(act(&mut g, &seats, &mut rng, 0, play("g1")), Err("抽牌之後只能出剛抽到的那張".into()));
        act(&mut g, &seats, &mut rng, 0, play("b7")).unwrap();
        assert_eq!(g.turn, 1);
    }

    #[test]
    fn the_discard_pile_is_reshuffled() {
        let seats = seats(2, 0);
        let mut rng = Rng::new();
        let mut g = start(&Options::default(), None, &seats, &mut rng);
        rig(&mut g, &["g1 g2", "b5 b6"], "r7", "", 0, &seats, &mut rng);
        g.discard = cards("y3 y4 r7");
        act(&mut g, &seats, &mut rng, 0, Action::Draw).unwrap();
        assert_eq!(g.discard, cards("r7"), "桌上那張留著");
        assert_eq!(g.hands[0].len() + g.pile.len(), 4);
    }

    #[test]
    fn uno_must_be_called() {
        let seats = seats(3, 0);
        let mut rng = Rng::new();
        let mut g = start(&Options::default(), None, &seats, &mut rng);
        let pile = "y1 y2 y3 y4 y5 y6";
        rig(&mut g, &["r1 r2", "r3 r4 g1", "r5 r6"], "r7", pile, 0, &seats, &mut rng);
        act(&mut g, &seats, &mut rng, 0, play("r1")).unwrap();
        assert_eq!(g.exposed, Some(0));
        assert_eq!(g.view(Some(2), Instant::now())["exposed"], 0, "大家都看得到誰沒喊");
        assert_eq!(
            act(&mut g, &seats, &mut rng, 0, Action::Catch { seat: 0 }),
            Err("不能抓自己，按「UNO!」補喊".into())
        );
        act(&mut g, &seats, &mut rng, 2, Action::Catch { seat: 0 }).unwrap();
        assert_eq!(g.hands[0].len(), 3, "罰抽 2 張");
        assert_eq!(g.exposed, None);
        assert_eq!(
            act(&mut g, &seats, &mut rng, 1, Action::Catch { seat: 0 }),
            Err("來不及了（他已經喊了，或下一位已經出手）".into()),
            "只能抓一次"
        );

        // 出牌時一起喊就不會被抓
        rig(&mut g, &["r1 r2", "r3 r4 g1", "r5 r6"], "r7", pile, 0, &seats, &mut rng);
        act(&mut g, &seats, &mut rng, 0, Action::Play { card: c("r1"), color: None, uno: true }).unwrap();
        assert_eq!(g.exposed, None);
        assert!(g.called[0]);
        assert_eq!(g.view(Some(1), Instant::now())["seats"][0]["uno"], true);

        // 出完馬上補喊也可以
        rig(&mut g, &["r1 r2", "r3 r4 g1", "r5 r6"], "r7", pile, 0, &seats, &mut rng);
        act(&mut g, &seats, &mut rng, 0, play("r1")).unwrap();
        act(&mut g, &seats, &mut rng, 0, Action::Uno).unwrap();
        assert!(g.called[0] && g.exposed.is_none());
        assert_eq!(act(&mut g, &seats, &mut rng, 0, Action::Uno), Err("你已經喊過 UNO 了".into()));

        // 下一位出手之後就來不及了
        rig(&mut g, &["r1 r2", "r3 r4 g1", "r5 r6"], "r7", pile, 0, &seats, &mut rng);
        act(&mut g, &seats, &mut rng, 0, play("r1")).unwrap();
        act(&mut g, &seats, &mut rng, 1, play("r3")).unwrap();
        assert_eq!(g.exposed, None);
        assert!(act(&mut g, &seats, &mut rng, 2, Action::Catch { seat: 0 }).is_err());
        assert_eq!(act(&mut g, &seats, &mut rng, 0, Action::Uno), Err("來不及了，已經可以被抓了".into()));
        assert_eq!(
            act(&mut g, &seats, &mut rng, 1, Action::Uno),
            Err("出到剩一張時再喊 UNO（出牌前先按「UNO!」）".into())
        );
        // 抽了牌就不算喊過了
        rig(&mut g, &["r1 r2", "g3 g4 g1", "r5 r6"], "r7", pile, 0, &seats, &mut rng);
        act(&mut g, &seats, &mut rng, 0, Action::Play { card: c("r1"), color: None, uno: true }).unwrap();
        act(&mut g, &seats, &mut rng, 1, Action::Draw).unwrap();
        act(&mut g, &seats, &mut rng, 2, play("r5")).unwrap();
        assert!(g.called[0]);
        act(&mut g, &seats, &mut rng, 0, Action::Draw).unwrap();
        assert!(!g.called[0]);
    }

    #[test]
    fn single_round_scoring_counts_wins() {
        let seats = seats(3, 0);
        let mut rng = Rng::new();
        let o = Options::default();
        let mut g = start(&o, None, &seats, &mut rng);
        rig(&mut g, &["r1", "r3 W", "b+2 b5"], "r7", "", 0, &seats, &mut rng);
        act(&mut g, &seats, &mut rng, 0, play("r1")).unwrap();
        assert!(g.finished());
        assert_eq!(g.total(0), 1);
        assert!(g.view(Some(1), Instant::now())["result"]["hands"][2].as_array().unwrap().len() == 2, "結束才公開手牌");
        let next = start(&o, Some(&g), &seats, &mut rng);
        assert_eq!(next.turn, 1, "上一局贏家的下一位先出");
        assert_eq!(next.total(0), 1);
        assert_eq!(next.game, 2);
    }

    #[test]
    fn points_scoring_to_the_target() {
        let seats = seats(3, 0);
        let mut rng = Rng::new();
        let o = Options { scoring: Scoring::Points, target: 200, ..Options::default() };
        let mut g = start(&o, None, &seats, &mut rng);
        // 最後一張出 +2：下一位還是要抽，抽到的牌也算點數
        rig(&mut g, &["r+2", "r3 W", "bS b5"], "r7", "y9 y8", 0, &seats, &mut rng);
        act(&mut g, &seats, &mut rng, 0, play("r+2")).unwrap();
        let o1 = g.outcome.clone().unwrap();
        assert_eq!(o1.gained, 3 + 50 + 9 + 8 + 20 + 5);
        assert!(!o1.champion);
        let mut g2 = start(&o, Some(&g), &seats, &mut rng);
        assert_eq!(g2.total(0), 95);
        rig(&mut g2, &["r1", "W W' W4", "b5"], "r7", "", 0, &seats, &mut rng);
        act(&mut g2, &seats, &mut rng, 0, play("r1")).unwrap();
        assert_eq!(g2.total(0), 95 + 155);
        assert!(g2.outcome.as_ref().unwrap().champion, "到 200 分拿下整場");
        let g3 = start(&o, Some(&g2), &seats, &mut rng);
        assert_eq!(g3.total(0), 0, "下一局重新算");
        // 換計分方式也重新算
        let g4 = start(&Options::default(), Some(&g), &seats, &mut rng);
        assert_eq!(g4.total(0), 0);
    }

    #[test]
    fn timeouts_draw_and_pass() {
        let seats = seats(2, 0);
        let mut rng = Rng::new();
        let o = Options { think_secs: 10, ..Options::default() };
        let mut g = start(&o, None, &seats, &mut rng);
        rig(&mut g, &["r1 g2", "b5 b6"], "r7", "r9 y1", 0, &seats, &mut rng);
        let later = Instant::now() + Duration::from_secs(11);
        let mut out = Outbox::default();
        g.tick(&mut crate::party::test_ctx(later, &mut rng, &seats, &mut out));
        assert_eq!(g.turn, 1, "時間到就抽牌、不出");
        assert_eq!(g.hands[0].len(), 3);
        assert_eq!(g.top(), c("r7"));
        // 斷線的人由電腦代打（不用等滿思考時間）
        g.online[1] = false;
        g.hands[1] = cards("b5 r6");
        let later = later + OFFLINE_WAIT;
        g.tick(&mut crate::party::test_ctx(later, &mut rng, &seats, &mut out));
        assert_eq!(g.top(), c("r6"));
        assert!(g.called[1], "代打一定會喊 UNO");
    }

    #[test]
    fn bot_heuristics() {
        let seats = seats(3, 3);
        let mut rng = Rng::new();
        let mut g = start(&Options::default(), None, &seats, &mut rng);
        for _ in 0..30 {
            // 紅色最多，出紅色；萬用牌留著
            rig(&mut g, &["r1 r2 r3 b7 W", "g1 g2 g3 g4", "y1 y2 y3 y4"], "b1", "", 0, &seats, &mut rng);
            assert_eq!(g.bot_choice(0, &mut rng), Some(c("r1")), "有其他牌能出就不出萬用牌");
            // 只剩萬用牌能出才出
            rig(&mut g, &["W g2 g3", "y1 y2 y3", "b1 b2 b3"], "r7", "", 0, &seats, &mut rng);
            assert_eq!(g.bot_choice(0, &mut rng), Some(c("W")));
            assert_eq!(g.bot_color(0, &mut rng), 2, "指定手上最多的顏色");
            // 下一家剩一張：用功能牌卡他
            rig(&mut g, &["r5 rS g2", "y1", "b1 b2 b3"], "r7", "", 0, &seats, &mut rng);
            assert_eq!(g.bot_choice(0, &mut rng), Some(c("rS")));
            // 被 +2 時能疊就疊
            g.options.stacking = true;
            rig(&mut g, &["g+2 W4 r1", "y1", "b1 b2 b3"], "r+2", "", 0, &seats, &mut rng);
            g.pending = 2;
            assert_eq!(g.bot_choice(0, &mut rng), Some(c("g+2")));
            g.options.stacking = false;
        }
    }

    /// 跑一局到結束；`smart` 的座位用電腦的策略，其他座位出第一張能出的（沒得出就抽）
    fn play_out(g: &mut Uno, seats: &[SeatInfo], rng: &mut Rng, smart: &[bool]) {
        for _ in 0..5000 {
            if g.finished() {
                break;
            }
            assert_conserved(g);
            let seat = g.turn;
            let choice = if smart[seat] { g.bot_choice(seat, rng) } else { g.playable(seat).first().copied() };
            let action = match choice {
                Some(card) => {
                    assert!(g.playable(seat).contains(&card), "電腦只會出合法的牌");
                    let color = is_wild(card).then(|| g.bot_color(seat, rng));
                    Action::Play { card, color, uno: true }
                }
                None if g.drawn.is_some() => Action::Pass,
                None => Action::Draw,
            };
            act(g, seats, rng, seat, action).unwrap_or_else(|e| panic!("座位 {seat}：{e}"));
        }
        assert!(g.finished(), "一局一定打得完");
        assert!(g.hands[g.outcome.as_ref().unwrap().winner].is_empty());
        assert_conserved(g);
    }

    #[test]
    fn bots_finish_many_games_under_every_rule_set() {
        let mut rng = Rng::new();
        let rule_sets = [
            Options::default(),
            Options { stacking: true, draw_until: true, think_secs: 0, scoring: Scoring::Points, target: 500 },
        ];
        for o in &rule_sets {
            for n in [2, 3, 4, 7, 10] {
                let seats = seats(n, n);
                let mut previous: Option<Uno> = None;
                for _ in 0..10 {
                    let mut g = start(o, previous.as_ref(), &seats, &mut rng);
                    play_out(&mut g, &seats, &mut rng, &vec![true; n]);
                    previous = Some(g);
                }
            }
        }
    }

    #[test]
    fn bots_also_run_through_the_tick() {
        let mut rng = Rng::new();
        for n in [2, 6, 10] {
            let seats = seats(n, n);
            let mut g = start(&Options { stacking: true, ..Options::default() }, None, &seats, &mut rng);
            let mut now = Instant::now();
            for _ in 0..20000 {
                if g.finished() {
                    break;
                }
                now += Duration::from_millis(500);
                let mut out = Outbox::default();
                g.tick(&mut crate::party::test_ctx(now, &mut rng, &seats, &mut out));
                assert_conserved(&g);
            }
            assert!(g.finished());
        }
    }

    #[test]
    fn views_only_show_your_own_hand() {
        let seats = seats(4, 0);
        let mut rng = Rng::new();
        let g = start(&Options::default(), None, &seats, &mut rng);
        let now = Instant::now();
        for s in 0..4 {
            let view = g.view(Some(s), now);
            let hand: Vec<Card> = serde_json::from_value(view["hand"].clone()).unwrap();
            assert_eq!(hand, g.hands[s]);
            assert!(view["result"].is_null());
            for seat in view["seats"].as_array().unwrap() {
                assert_eq!(seat["count"], 7);
                assert!(seat.get("hand").is_none());
            }
            let playable = view["playable"].as_array().unwrap();
            assert_eq!(playable.is_empty() && s == g.turn, g.playable(s).is_empty() && s == g.turn);
            if s != g.turn {
                assert!(playable.is_empty(), "提示只給輪到的人");
            }
        }
        let spectator = g.view(None, now);
        assert!(spectator["hand"].is_null());
        assert!(spectator["playable"].as_array().unwrap().is_empty());
    }
}
