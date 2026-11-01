//! 誰是臥底（派對房間的第一款遊戲，房間本身見 `party.rs`）。
//!
//! 大部分人拿到同一個詞（平民），一兩個人拿到相近的另一個詞（臥底），也可以多一個沒有詞的白板。
//! 每個人只看得到自己的詞，不知道自己是哪一邊。流程：
//! 1. 看詞（幾秒，或大家都按「記住了」）。
//! 2. 依序發言：每人一句描述，不能包含自己的詞（伺服器檢查），有發言時間，時間到就跳過。
//!    線下模式大家當面口頭描述，輪到的人說完按「說完了」。
//! 3. 討論（可以設 0 秒跳過，大家都按「可以投票了」也會提早結束）。
//! 4. 投票：投給一個還在場上的人（不能投自己），票數最多的出局。
//!    平手就只在平手的人之間重投一次，再平手這輪沒人出局。投完公開誰投誰。
//! 5. 白板被投出局時可以猜一次平民的詞，猜中就算臥底這邊贏。
//! 6. 勝負：臥底和白板全部出局，平民勝；臥底這邊（含白板）的人數追上平民，臥底勝。
//!
//! 電腦玩家：發言從詞庫裡那個詞的描述挑一句（白板用通用的模糊描述），
//! 投票看誰的描述和自己的詞最不像，再加上跟票。電腦只知道自己的詞，跟真人一樣。

use std::{
    collections::HashMap,
    sync::{Arc, LazyLock},
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::time::Instant;

use crate::{
    AppState,
    party::{Chat, Ctx, Parties, PartyGame, To, clean, shuffle},
};

const PEEK: Duration = Duration::from_secs(8);
const VOTE: Duration = Duration::from_secs(45);
const OUT: Duration = Duration::from_secs(5);
const GUESS: Duration = Duration::from_secs(30);
/// 輪到斷線的人發言時，最多等這麼久就跳過
const OFFLINE_WAIT: Duration = Duration::from_secs(10);
pub const MAX_DESCRIPTION: usize = 40;
/// 打到這一輪還沒分出勝負，就算撐到最後的臥底贏（平手一直沒人出局時才會發生）
const MAX_ROUNDS: u32 = 12;

/// 白板電腦沒有詞，只能講些模稜兩可的話
const VAGUE: &[&str] = &[
    "這個大家應該都碰過",
    "跟生活很有關係",
    "我覺得還不錯",
    "有時候會突然想到它",
    "每個人看法不太一樣",
    "跟前面說的差不多",
    "小時候就知道了",
    "台灣滿常見的",
    "價錢要看情況",
    "朋友之間常聊到",
];

pub struct Word {
    pub text: &'static str,
    pub hints: Vec<&'static str>,
}

pub struct Pair(pub Word, pub Word);

/// 詞庫，格式見 undercover_words.txt
pub static WORDS: LazyLock<Vec<Pair>> = LazyLock::new(|| {
    fn word(part: &'static str) -> Word {
        let (text, hints) = part.split_once('=').expect("詞=描述");
        Word { text: text.trim(), hints: hints.split('、').map(str::trim).filter(|h| !h.is_empty()).collect() }
    }
    include_str!("undercover_words.txt")
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(|line| {
            let (a, b) = line.split_once('|').expect("兩個詞用 | 隔開");
            Pair(word(a), word(b))
        })
        .collect()
});

/// 比對用：只留文字和數字、英文轉小寫，空白標點不算
pub fn normalize(text: &str) -> String {
    text.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect()
}

fn contains_word(text: &str, word: &str) -> bool {
    let word = normalize(word);
    !word.is_empty() && normalize(text).contains(&word)
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Options {
    /// 臥底人數，0 是照人數自動決定
    pub undercover: u8,
    /// 多一個沒有詞的白板（算臥底這邊）
    pub blank: bool,
    /// 線下模式：大家當面口頭描述，網站只負責發詞、輪流、投票
    pub offline: bool,
    /// 出局時公開身分
    pub reveal: bool,
    /// 每人發言的秒數
    pub speak_secs: u16,
    /// 討論的秒數，0 表示跳過討論直接投票
    pub discuss_secs: u16,
}

impl Default for Options {
    fn default() -> Self {
        Self { undercover: 0, blank: false, offline: false, reveal: true, speak_secs: 45, discuss_secs: 60 }
    }
}

impl Options {
    /// (臥底人數, 白板人數)；人數太少配不出來就是 None
    fn sides(&self, players: usize) -> Option<(usize, usize)> {
        let blank = usize::from(self.blank);
        // 臥底這邊一定要比平民少，不然一開局就分出勝負
        let limit = (players.saturating_sub(1) / 2).saturating_sub(blank);
        let wanted = match self.undercover {
            // 自動：5 人以下 1 個、6～8 人 2 個、更多 3 個，白板佔掉其中一個名額
            0 => match players {
                ..=5 => 1usize,
                6..=8 => 2,
                _ => 3,
            }
            .saturating_sub(blank)
            .clamp(1, limit.max(1)),
            n => usize::from(n),
        };
        (wanted >= 1 && wanted <= limit).then_some((wanted, blank))
    }
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Civilian,
    Undercover,
    Blank,
}

impl Role {
    fn label(self) -> &'static str {
        match self {
            Role::Civilian => "平民",
            Role::Undercover => "臥底",
            Role::Blank => "白板",
        }
    }

    fn undercover_side(self) -> bool {
        self != Role::Civilian
    }
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    Civilian,
    Undercover,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Action {
    /// 看詞時「記住了」、討論時「可以投票了」
    Ready,
    Describe {
        text: String,
    },
    /// 線下模式說完了；線上模式是跳過這次發言
    Done,
    Vote {
        seat: usize,
    },
    /// 白板出局後猜平民的詞
    Guess {
        word: String,
    },
}

#[derive(Clone, PartialEq, Debug)]
enum Stage {
    Peek,
    /// `at` 是這輪發言順序（`speakers`）的第幾個
    Speak {
        at: usize,
    },
    Discuss,
    Vote {
        candidates: Vec<usize>,
        revote: bool,
    },
    /// 公布投票結果；None 表示這輪沒人出局
    Out {
        seat: Option<usize>,
    },
    Guess {
        seat: usize,
    },
    End,
}

impl Stage {
    fn name(&self) -> &'static str {
        match self {
            Stage::Peek => "peek",
            Stage::Speak { .. } => "speak",
            Stage::Discuss => "discuss",
            Stage::Vote { .. } => "vote",
            Stage::Out { .. } => "out",
            Stage::Guess { .. } => "guess",
            Stage::End => "end",
        }
    }
}

#[derive(Serialize, Clone, Debug)]
struct Speech {
    round: u32,
    seat: usize,
    /// None：線下口頭說的、跳過或時間到
    text: Option<String>,
    timeout: bool,
}

#[derive(Serialize, Clone, Debug)]
struct Tally {
    round: u32,
    revote: bool,
    /// 每個人投給誰（沒投是 null）
    ballots: Vec<Option<usize>>,
    out: Option<usize>,
}

#[derive(Serialize, Clone, Debug)]
struct Guess {
    seat: usize,
    word: Option<String>,
    correct: bool,
}

pub struct Undercover {
    options: Options,
    pids: Vec<u32>,
    names: Vec<String>,
    bots: Vec<bool>,
    online: Vec<bool>,
    roles: Vec<Role>,
    /// [平民的詞, 臥底的詞]
    words: [&'static str; 2],
    /// 詞庫裡的第幾組，`swapped` 表示平民拿的是第二個詞（電腦挑描述用）
    pair: usize,
    swapped: bool,
    alive: Vec<bool>,
    /// 發言的固定順序（座位），每輪從上一輪起頭的下一個還在場上的人開始
    order: Vec<usize>,
    /// 這輪起頭的人在 `order` 的位置
    lead: usize,
    speakers: Vec<usize>,
    round: u32,
    stage: Stage,
    deadline: Option<Instant>,
    stage_started: Instant,
    speeches: Vec<Speech>,
    votes: Vec<Option<usize>>,
    ready: Vec<bool>,
    tallies: Vec<Tally>,
    /// 出局順序 (輪, 座位)
    outs: Vec<(u32, usize)>,
    guess: Option<Guess>,
    winner: Option<Side>,
    /// 累計分數（pid → 分）
    scores: HashMap<u32, u32>,
    /// 這個房間用過的詞，下一局盡量不重複
    used: Vec<usize>,
    /// 每個電腦下一次出手的時間
    bot_at: Vec<Option<Instant>>,
}

impl Undercover {
    fn my_word(&self, seat: usize) -> Option<&'static str> {
        match self.roles[seat] {
            Role::Civilian => Some(self.words[0]),
            Role::Undercover => Some(self.words[1]),
            Role::Blank => None,
        }
    }

    /// 電腦可以用的描述：自己那個詞的描述，白板用通用的
    fn bot_hints(&self, seat: usize) -> Vec<&'static str> {
        let pair = &WORDS[self.pair];
        let (civilian, undercover) = if self.swapped { (&pair.1, &pair.0) } else { (&pair.0, &pair.1) };
        match self.roles[seat] {
            Role::Civilian => civilian.hints.clone(),
            Role::Undercover => undercover.hints.clone(),
            Role::Blank => VAGUE.to_vec(),
        }
    }

    fn alive_seats(&self) -> Vec<usize> {
        (0..self.alive.len()).filter(|&s| self.alive[s]).collect()
    }

    fn dead_seats(&self) -> Vec<usize> {
        (0..self.alive.len()).filter(|&s| !self.alive[s]).collect()
    }

    fn set_stage(&mut self, stage: Stage, length: Option<Duration>, ctx: &mut Ctx) {
        self.stage = stage;
        self.stage_started = ctx.now;
        self.deadline = length.map(|d| ctx.now + d);
        self.ready.fill(false);
        self.schedule_bots(ctx);
        ctx.changed();
    }

    /// 進到新的階段時排好每個電腦什麼時候出手
    fn schedule_bots(&mut self, ctx: &mut Ctx) {
        for seat in 0..self.bots.len() {
            self.bot_at[seat] = None;
            if !self.bots[seat] {
                continue;
            }
            let delay = match &self.stage {
                Stage::Peek | Stage::Discuss if self.alive[seat] => Some(ctx.rng.range(0.5, 2.0)),
                Stage::Speak { at } if self.speakers.get(*at) == Some(&seat) => Some(ctx.rng.range(2.5, 6.0)),
                Stage::Vote { .. } if self.alive[seat] => Some(ctx.rng.range(3.0, 12.0)),
                Stage::Guess { seat: guesser } if *guesser == seat => Some(1.5),
                _ => None,
            };
            self.bot_at[seat] = delay.map(|d| ctx.now + Duration::from_secs_f64(d));
        }
    }

    /// 開始新的一輪發言
    fn begin_round(&mut self, ctx: &mut Ctx) {
        self.round += 1;
        if self.round > MAX_ROUNDS {
            self.finish(Side::Undercover, "打了太多輪都沒分出勝負，撐到最後的臥底獲勝", ctx);
            return;
        }
        let n = self.order.len();
        if self.round > 1 {
            self.lead = (self.lead + 1) % n;
        }
        // 起頭的人要還在場上
        while !self.alive[self.order[self.lead]] {
            self.lead = (self.lead + 1) % n;
        }
        self.speakers = (0..n).map(|k| self.order[(self.lead + k) % n]).filter(|&s| self.alive[s]).collect();
        ctx.system(To::All, format!("第 {} 輪，從 {} 開始發言", self.round, self.names[self.speakers[0]]));
        let secs = Duration::from_secs(u64::from(self.options.speak_secs));
        self.set_stage(Stage::Speak { at: 0 }, Some(secs), ctx);
    }

    /// 目前的發言者講完（或時間到）：換下一個，全部講完就討論或投票
    fn next_speaker(&mut self, ctx: &mut Ctx) {
        let Stage::Speak { at } = self.stage else { return };
        if at + 1 < self.speakers.len() {
            let secs = Duration::from_secs(u64::from(self.options.speak_secs));
            self.set_stage(Stage::Speak { at: at + 1 }, Some(secs), ctx);
        } else if self.options.discuss_secs > 0 {
            let secs = Duration::from_secs(u64::from(self.options.discuss_secs));
            self.set_stage(Stage::Discuss, Some(secs), ctx);
        } else {
            self.begin_vote(self.alive_seats(), false, ctx);
        }
    }

    fn speak(&mut self, seat: usize, text: Option<String>, timeout: bool, ctx: &mut Ctx) {
        self.speeches.push(Speech { round: self.round, seat, text, timeout });
        self.next_speaker(ctx);
    }

    fn begin_vote(&mut self, candidates: Vec<usize>, revote: bool, ctx: &mut Ctx) {
        self.votes.fill(None);
        self.set_stage(Stage::Vote { candidates, revote }, Some(VOTE), ctx);
    }

    /// 還在場上、連著線的人都投了就提早開票（斷線的人不等）
    fn all_voted(&self) -> bool {
        self.alive_seats().into_iter().all(|s| self.votes[s].is_some() || !self.online[s])
    }

    fn all_ready(&self) -> bool {
        self.alive_seats().into_iter().all(|s| self.ready[s] || !self.online[s])
    }

    fn tally(&mut self, ctx: &mut Ctx) {
        let Stage::Vote { candidates, revote } = self.stage.clone() else { return };
        let mut counts = vec![0usize; self.alive.len()];
        for s in self.alive_seats() {
            if let Some(t) = self.votes[s].filter(|t| candidates.contains(t)) {
                counts[t] += 1;
            }
        }
        let top = candidates.iter().map(|&c| counts[c]).max().unwrap_or(0);
        let tied: Vec<usize> = candidates.iter().copied().filter(|&c| counts[c] == top).collect();
        let ballots: Vec<Option<usize>> =
            (0..self.alive.len()).map(|s| if self.alive[s] { self.votes[s] } else { None }).collect();
        let out = (top > 0 && tied.len() == 1).then(|| tied[0]);
        self.tallies.push(Tally { round: self.round, revote, ballots, out });

        if let Some(seat) = out {
            self.alive[seat] = false;
            self.outs.push((self.round, seat));
            let who = &self.names[seat];
            let text = if self.options.reveal {
                format!("{who} 被投出局，身分是{}", self.roles[seat].label())
            } else {
                format!("{who} 被投出局")
            };
            ctx.announce(To::All, text, "accent");
            self.set_stage(Stage::Out { seat: Some(seat) }, Some(OUT), ctx);
        } else if top > 0 && !revote {
            let names: Vec<&str> = tied.iter().map(|&s| self.names[s].as_str()).collect();
            ctx.system(To::All, format!("{} 平手，重新投票（只能投給平手的人）", names.join("、")));
            self.begin_vote(tied, true, ctx);
        } else {
            let text = if top == 0 {
                "沒有人投票，這輪沒有人出局"
            } else {
                "又平手了，這輪沒有人出局"
            };
            ctx.system(To::All, text);
            self.set_stage(Stage::Out { seat: None }, Some(OUT), ctx);
        }
    }

    /// 公布完出局的人：白板可以猜詞，否則看分出勝負沒，沒有就下一輪
    fn after_out(&mut self, ctx: &mut Ctx) {
        let Stage::Out { seat } = self.stage else { return };
        if let Some(seat) = seat
            && self.roles[seat] == Role::Blank
            && self.guess.is_none()
        {
            ctx.system(To::All, format!("{} 是白板，可以猜一次平民的詞", self.names[seat]));
            self.set_stage(Stage::Guess { seat }, Some(GUESS), ctx);
            return;
        }
        self.check_winner(ctx);
    }

    fn check_winner(&mut self, ctx: &mut Ctx) {
        let alive = self.alive_seats();
        let bad = alive.iter().filter(|&&s| self.roles[s].undercover_side()).count();
        let good = alive.len() - bad;
        if bad == 0 {
            self.finish(Side::Civilian, "臥底全部出局，平民獲勝", ctx);
        } else if bad >= good {
            self.finish(Side::Undercover, "臥底撐到人數追上平民，臥底獲勝", ctx);
        } else {
            self.begin_round(ctx);
        }
    }

    fn resolve_guess(&mut self, seat: usize, word: Option<String>, ctx: &mut Ctx) {
        let correct = word.as_deref().is_some_and(|w| normalize(w) == normalize(self.words[0]));
        let who = &self.names[seat];
        match &word {
            Some(w) => ctx.system(To::All, format!("{who} 猜「{w}」")),
            None => ctx.system(To::All, format!("{who} 沒有猜")),
        }
        self.guess = Some(Guess { seat, word, correct });
        if correct {
            self.finish(Side::Undercover, "白板猜中了平民的詞，臥底這邊獲勝", ctx);
        } else {
            self.check_winner(ctx);
        }
    }

    fn finish(&mut self, side: Side, reason: &str, ctx: &mut Ctx) {
        self.winner = Some(side);
        // 平民人多比較好贏，臥底這邊贏的分數多一點
        for seat in 0..self.roles.len() {
            let won = (side == Side::Undercover) == self.roles[seat].undercover_side();
            if won {
                let points = if side == Side::Undercover { 2 } else { 1 };
                *self.scores.entry(self.pids[seat]).or_default() += points;
            }
        }
        ctx.announce(
            To::All,
            format!("{reason}！平民的詞是「{}」，臥底的詞是「{}」", self.words[0], self.words[1]),
            "ok",
        );
        self.set_stage(Stage::End, None, ctx);
    }

    fn bot_act(&mut self, seat: usize, ctx: &mut Ctx) {
        match self.stage.clone() {
            Stage::Peek | Stage::Discuss => self.ready[seat] = true,
            Stage::Speak { at } if self.speakers.get(at) == Some(&seat) => {
                let said: Vec<&str> = self.speeches.iter().filter_map(|s| s.text.as_deref()).collect();
                let mut options: Vec<&'static str> =
                    self.bot_hints(seat).into_iter().filter(|h| !said.contains(h)).collect();
                if options.is_empty() {
                    options = VAGUE.iter().copied().filter(|h| !said.contains(h)).collect();
                }
                let text = (!options.is_empty()).then(|| options[ctx.rng.below(options.len())].to_owned());
                self.speak(seat, text, false, ctx);
                return;
            }
            Stage::Vote { candidates, .. } => {
                let pick = self.bot_vote(seat, &candidates, ctx);
                self.votes[seat] = pick;
            }
            Stage::Guess { seat: guesser } if guesser == seat => {
                self.resolve_guess(seat, None, ctx);
                return;
            }
            _ => return,
        }
        ctx.changed();
    }

    /// 電腦投票：誰的描述跟自己的詞最不像就投誰，再加上一點跟票和隨機
    fn bot_vote(&self, seat: usize, candidates: &[usize], ctx: &mut Ctx) -> Option<usize> {
        let mine: Vec<char> = self.bot_hints(seat).concat().chars().collect();
        let bigrams: Vec<(char, char)> = mine.windows(2).map(|w| (w[0], w[1])).collect();
        let has_word = self.roles[seat] != Role::Blank;
        let mut best: Option<(f64, usize)> = None;
        for &c in candidates {
            if c == seat {
                continue;
            }
            let mut score = ctx.rng.range(0.0, 1.0);
            if has_word {
                for speech in self.speeches.iter().filter(|s| s.seat == c) {
                    let similar = speech.text.as_deref().is_some_and(|t| {
                        let chars: Vec<char> = t.chars().collect();
                        chars.windows(2).any(|w| bigrams.contains(&(w[0], w[1])))
                    });
                    if !similar {
                        score += 0.6;
                    }
                }
            }
            let votes = self.votes.iter().filter(|v| **v == Some(c)).count();
            score += 0.8 * votes as f64;
            if best.is_none_or(|(b, _)| score > b) {
                best = Some((score, c));
            }
        }
        best.map(|(_, c)| c)
    }

    fn deadline_passed(&mut self, ctx: &mut Ctx) {
        match self.stage.clone() {
            Stage::Peek => self.begin_round(ctx),
            Stage::Speak { at } => {
                let seat = self.speakers[at];
                self.speak(seat, None, true, ctx);
            }
            Stage::Discuss => self.begin_vote(self.alive_seats(), false, ctx),
            Stage::Vote { .. } => self.tally(ctx),
            Stage::Out { .. } => self.after_out(ctx),
            Stage::Guess { seat } => self.resolve_guess(seat, None, ctx),
            Stage::End => {}
        }
    }
}

impl PartyGame for Undercover {
    const ID: &'static str = "undercover";
    const MIN_PLAYERS: usize = 3;
    const MAX_PLAYERS: usize = 10;
    const MAX_BOTS: usize = 9;

    type Options = Options;
    type Action = Action;

    fn rooms(state: &AppState) -> &Arc<Parties<Self>> {
        &state.undercover
    }

    fn check_options(mut options: Options) -> Result<Options, String> {
        if options.undercover > 3 {
            return Err("臥底最多 3 人".into());
        }
        options.speak_secs = options.speak_secs.clamp(15, 180);
        options.discuss_secs = options.discuss_secs.min(300);
        Ok(options)
    }

    fn can_start(options: &Options, players: usize) -> Result<(), String> {
        match options.sides(players) {
            Some(_) => Ok(()),
            None if options.blank && players < 5 => Err("5 人以上才能加白板".into()),
            None => Err(format!("{players} 人最多 {} 個臥底（含白板）", players.saturating_sub(1) / 2)),
        }
    }

    fn start(options: &Options, previous: Option<&Self>, ctx: &mut Ctx) -> Self {
        let n = ctx.seats.len();
        let (undercover, blank) = options.sides(n).expect("can_start checked the sides");
        // 盡量不出現這個房間用過的詞，全部用過就重來
        let mut used = previous.map(|p| p.used.clone()).unwrap_or_default();
        if used.len() >= WORDS.len() {
            used.clear();
        }
        let fresh: Vec<usize> = (0..WORDS.len()).filter(|i| !used.contains(i)).collect();
        let pair = fresh[ctx.rng.below(fresh.len())];
        used.push(pair);
        let swapped = ctx.rng.chance(0.5);
        let (a, b) = (&WORDS[pair].0, &WORDS[pair].1);
        let words = if swapped { [b.text, a.text] } else { [a.text, b.text] };

        let mut roles = vec![Role::Civilian; n];
        for role in roles.iter_mut().take(undercover) {
            *role = Role::Undercover;
        }
        if blank > 0 {
            roles[undercover] = Role::Blank;
        }
        shuffle(ctx.rng, &mut roles);
        let mut order: Vec<usize> = (0..n).collect();
        shuffle(ctx.rng, &mut order);
        // 白板沒有任何資訊，第一輪不要讓他第一個講
        let mut lead = 0;
        while roles[order[lead]] == Role::Blank {
            lead += 1;
        }

        let mut game = Self {
            options: options.clone(),
            pids: ctx.seats.iter().map(|s| s.pid).collect(),
            names: ctx.seats.iter().map(|s| s.name.clone()).collect(),
            bots: ctx.seats.iter().map(|s| s.bot).collect(),
            online: ctx.seats.iter().map(|s| s.online).collect(),
            roles,
            words,
            pair,
            swapped,
            alive: vec![true; n],
            order,
            lead,
            speakers: Vec::new(),
            round: 0,
            stage: Stage::Peek,
            deadline: None,
            stage_started: ctx.now,
            speeches: Vec::new(),
            votes: vec![None; n],
            ready: vec![false; n],
            tallies: Vec::new(),
            outs: Vec::new(),
            guess: None,
            winner: None,
            scores: previous.map(|p| p.scores.clone()).unwrap_or_default(),
            used,
            bot_at: vec![None; n],
        };
        let mut lineup = format!("{} 位平民、{} 位臥底", n - undercover - blank, undercover);
        if blank > 0 {
            lineup.push_str("、1 位白板");
        }
        ctx.system(To::All, format!("新的一局：{lineup}。記住你的詞！"));
        game.set_stage(Stage::Peek, Some(PEEK), ctx);
        game
    }

    fn act(&mut self, seat: usize, action: Action, ctx: &mut Ctx) -> Result<(), String> {
        match (action, self.stage.clone()) {
            (Action::Ready, Stage::Peek | Stage::Discuss) if self.alive[seat] => {
                self.ready[seat] = true;
                if self.all_ready() {
                    self.deadline_passed(ctx);
                }
                Ok(())
            }
            (Action::Describe { text }, Stage::Speak { at }) if self.speakers[at] == seat => {
                if self.options.offline {
                    return Err("線下模式請直接說出來，說完按「說完了」".into());
                }
                let text = clean(&text, MAX_DESCRIPTION);
                if text.is_empty() {
                    return Err("請輸入一句描述".into());
                }
                if self.my_word(seat).is_some_and(|w| contains_word(&text, w)) {
                    return Err("描述不能包含你的詞".into());
                }
                self.speak(seat, Some(text), false, ctx);
                Ok(())
            }
            (Action::Done, Stage::Speak { at }) if self.speakers[at] == seat => {
                self.speak(seat, None, false, ctx);
                Ok(())
            }
            (Action::Vote { seat: target }, Stage::Vote { candidates, .. }) if self.alive[seat] => {
                if target == seat {
                    return Err("不能投給自己".into());
                }
                if !candidates.contains(&target) {
                    return Err("只能投給還在場上（重投時是平手）的人".into());
                }
                self.votes[seat] = Some(target);
                if self.all_voted() {
                    self.tally(ctx);
                }
                Ok(())
            }
            (Action::Guess { word }, Stage::Guess { seat: guesser }) if guesser == seat => {
                let word = clean(&word, MAX_DESCRIPTION);
                if word.is_empty() {
                    return Err("請輸入你猜的詞".into());
                }
                self.resolve_guess(seat, Some(word), ctx);
                Ok(())
            }
            (_, Stage::Speak { .. }) => Err("還沒輪到你發言".into()),
            _ if !self.alive[seat] => Err("你已經出局了，可以在旁邊看".into()),
            _ => Err("現在不能這樣做".into()),
        }
    }

    fn tick(&mut self, ctx: &mut Ctx) {
        for seat in 0..self.bot_at.len() {
            if self.bot_at[seat].is_some_and(|t| ctx.now >= t) {
                self.bot_at[seat] = None;
                self.bot_act(seat, ctx);
            }
        }
        match &self.stage {
            Stage::Peek | Stage::Discuss if self.all_ready() => self.deadline_passed(ctx),
            Stage::Vote { .. } if self.all_voted() => self.tally(ctx),
            // 輪到斷線的人：不等滿整個發言時間
            Stage::Speak { at }
                if !self.online[self.speakers[*at]] && ctx.now.duration_since(self.stage_started) >= OFFLINE_WAIT =>
            {
                self.deadline_passed(ctx)
            }
            _ if self.deadline.is_some_and(|d| ctx.now >= d) => self.deadline_passed(ctx),
            _ => {}
        }
    }

    fn chat(&mut self, seat: Option<usize>, text: &str, ctx: &mut Ctx) -> Chat {
        if self.stage == Stage::End {
            return Chat::Show;
        }
        match seat {
            // 出局和觀戰的人只能在旁邊聊，不影響場上
            None => Chat::Only(To::SeatsAndSpectators(self.dead_seats())),
            Some(s) if !self.alive[s] => Chat::Only(To::SeatsAndSpectators(self.dead_seats())),
            Some(s) => {
                if self.my_word(s).is_some_and(|w| contains_word(text, w)) {
                    ctx.system(To::Seat(s), "不能直接說出你的詞，這句沒有送出");
                    Chat::Drop
                } else {
                    Chat::Show
                }
            }
        }
    }

    fn presence(&mut self, seat: usize, online: bool, ctx: &mut Ctx) {
        self.online[seat] = online;
        ctx.changed();
    }

    fn view(&self, seat: Option<usize>, now: Instant) -> Value {
        let ended = self.stage == Stage::End;
        let n = self.roles.len();
        let undercover = self.roles.iter().filter(|&&r| r == Role::Undercover).count();
        let blank = self.roles.iter().filter(|&&r| r == Role::Blank).count();
        let seats: Vec<Value> = (0..n)
            .map(|s| {
                let revealed = ended || (self.options.reveal && !self.alive[s]);
                json!({
                    "alive": self.alive[s],
                    "online": self.online[s],
                    "role": revealed.then_some(self.roles[s]),
                    "ready": self.ready[s],
                    "voted": matches!(self.stage, Stage::Vote { .. }) && self.votes[s].is_some(),
                    "points": self.scores.get(&self.pids[s]).copied().unwrap_or(0),
                })
            })
            .collect();
        let speaker = match self.stage {
            Stage::Speak { at } => self.speakers.get(at).copied(),
            _ => None,
        };
        let vote = match &self.stage {
            Stage::Vote { candidates, revote } => Some(json!({
                "candidates": candidates,
                "revote": revote,
                "mine": seat.and_then(|s| self.votes[s]),
            })),
            _ => None,
        };
        let guessing = match self.stage {
            Stage::Guess { seat } => Some(seat),
            _ => None,
        };
        json!({
            "stage": self.stage.name(),
            "endsIn": self.deadline.map(|d| d.saturating_duration_since(now).as_millis() as u64),
            "round": self.round,
            "options": self.options,
            "counts": { "civilian": n - undercover - blank, "undercover": undercover, "blank": blank },
            "you": seat,
            "word": seat.and_then(|s| self.my_word(s)),
            "blank": seat.is_some_and(|s| self.roles[s] == Role::Blank),
            "seats": seats,
            "speaker": speaker,
            "speakers": if self.round > 0 { self.speakers.clone() } else { Vec::new() },
            "speeches": self.speeches,
            "vote": vote,
            "tallies": self.tallies,
            "outs": self.outs.iter().map(|&(round, seat)| json!({ "round": round, "seat": seat })).collect::<Vec<_>>(),
            "guessing": guessing,
            "guess": self.guess,
            "result": self.winner.map(|winner| json!({
                "winner": winner,
                "words": { "civilian": self.words[0], "undercover": self.words[1] },
            })),
        })
    }

    fn finished(&self) -> bool {
        self.stage == Stage::End
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::party::{Rng, SeatInfo};

    fn seats(n: usize, bots: usize) -> Vec<SeatInfo> {
        (0..n)
            .map(|i| SeatInfo { pid: i as u32 + 1, name: format!("P{i}"), bot: i >= n - bots, online: true })
            .collect()
    }

    /// 用固定的角色、詞和發言順序開一局，方便測規則
    fn game(n: usize, roles: &[Role], options: Options) -> (Undercover, Vec<SeatInfo>, Rng) {
        let seats = seats(n, 0);
        let mut rng = Rng::new();
        let mut game = {
            let mut out = Default::default();
            let mut ctx = test_ctx(&mut rng, &seats, &mut out);
            Undercover::start(&options, None, &mut ctx)
        };
        game.roles = roles.to_vec();
        game.words = ["蘋果", "水梨"];
        game.order = (0..n).collect();
        game.lead = 0;
        (game, seats, rng)
    }

    fn test_ctx<'a>(rng: &'a mut Rng, seats: &'a [SeatInfo], out: &'a mut crate::party::Outbox) -> Ctx<'a> {
        crate::party::test_ctx(Instant::now(), rng, seats, out)
    }

    /// 跑一個動作；回傳錯誤訊息
    fn act(g: &mut Undercover, seats: &[SeatInfo], rng: &mut Rng, seat: usize, action: Action) -> Result<(), String> {
        let mut out = Default::default();
        let mut ctx = test_ctx(rng, seats, &mut out);
        g.act(seat, action, &mut ctx)
    }

    fn skip_to_speaking(g: &mut Undercover, seats: &[SeatInfo], rng: &mut Rng) {
        for s in 0..seats.len() {
            act(g, seats, rng, s, Action::Ready).unwrap();
        }
        assert_eq!(g.stage, Stage::Speak { at: 0 });
    }

    fn everyone_speaks(g: &mut Undercover, seats: &[SeatInfo], rng: &mut Rng) {
        while let Stage::Speak { at } = g.stage {
            let s = g.speakers[at];
            act(g, seats, rng, s, Action::Describe { text: format!("我是{s}號") }).unwrap();
        }
    }

    fn vote(g: &mut Undercover, seats: &[SeatInfo], rng: &mut Rng, ballots: &[(usize, usize)]) {
        for &(from, to) in ballots {
            act(g, seats, rng, from, Action::Vote { seat: to }).unwrap();
        }
    }

    use Role::{Blank as B, Civilian as C, Undercover as U};

    #[test]
    fn word_bank_is_big_and_hints_never_say_the_words() {
        assert!(WORDS.len() >= 120, "只有 {} 組", WORDS.len());
        let mut seen = std::collections::HashSet::new();
        for Pair(a, b) in WORDS.iter() {
            assert_ne!(a.text, b.text);
            assert!(seen.insert(a.text), "重複的詞：{}", a.text);
            assert!(seen.insert(b.text), "重複的詞：{}", b.text);
            for word in [a, b] {
                assert!(word.hints.len() >= 3, "{} 的描述太少", word.text);
                for hint in &word.hints {
                    assert!(!contains_word(hint, a.text) && !contains_word(hint, b.text), "{}：{hint}", word.text);
                    assert!(hint.chars().count() <= MAX_DESCRIPTION);
                }
            }
        }
    }

    #[test]
    fn sides_fit_the_player_count() {
        let auto = Options::default();
        assert_eq!(auto.sides(3), Some((1, 0)));
        assert_eq!(auto.sides(6), Some((2, 0)));
        assert_eq!(auto.sides(10), Some((3, 0)));
        let blank = Options { blank: true, ..Options::default() };
        assert_eq!(blank.sides(4), None);
        assert_eq!(blank.sides(5), Some((1, 1)));
        assert_eq!(blank.sides(6), Some((1, 1)));
        assert_eq!(blank.sides(9), Some((2, 1)));
        let three = Options { undercover: 3, ..Options::default() };
        assert_eq!(three.sides(6), None);
        assert_eq!(three.sides(7), Some((3, 0)));
        assert!(Undercover::can_start(&blank, 4).is_err());
        assert!(Undercover::check_options(Options { undercover: 4, ..Options::default() }).is_err());
    }

    #[test]
    fn start_deals_the_roles_and_hides_other_words() {
        for _ in 0..20 {
            let seats = seats(7, 0);
            let mut rng = Rng::new();
            let mut out = Default::default();
            let mut ctx = test_ctx(&mut rng, &seats, &mut out);
            let options = Options { blank: true, ..Options::default() };
            let g = Undercover::start(&options, None, &mut ctx);
            // 7 人自動是 2 個臥底名額，白板佔掉一個
            assert_eq!(g.roles.iter().filter(|&&r| r == U).count(), 1);
            assert_eq!(g.roles.iter().filter(|&&r| r == B).count(), 1);
            assert_ne!(g.roles[g.order[g.lead]], B, "白板不第一個講");
            for s in 0..7 {
                let view = g.view(Some(s), Instant::now()).to_string();
                let (mine, other) = match g.roles[s] {
                    C => (Some(g.words[0]), g.words[1]),
                    U => (Some(g.words[1]), g.words[0]),
                    B => (None, g.words[0]),
                };
                if let Some(mine) = mine {
                    assert!(view.contains(mine));
                }
                // 有些詞是另一個的一部分（眼鏡／隱形眼鏡），那種只能比對 word 欄位
                if !mine.is_some_and(|m| m.contains(other)) {
                    assert!(!view.contains(other), "座位 {s} 看到了別人的詞");
                }
                assert!(!view.contains("\"undercover\",") && !view.contains("\"role\":\"civilian\""), "身分不能外流");
            }
            let spectator = g.view(None, Instant::now()).to_string();
            assert!(!spectator.contains(g.words[0]) && !spectator.contains(g.words[1]));
        }
    }

    #[test]
    fn descriptions_cannot_contain_your_word() {
        let (mut g, seats, mut rng) = game(4, &[C, C, C, U], Options::default());
        skip_to_speaking(&mut g, &seats, &mut rng);
        assert_eq!(
            act(&mut g, &seats, &mut rng, 1, Action::Describe { text: "嗨".into() }),
            Err("還沒輪到你發言".into())
        );
        let err = act(&mut g, &seats, &mut rng, 0, Action::Describe { text: "紅 蘋 果".into() });
        assert_eq!(err, Err("描述不能包含你的詞".into()));
        act(&mut g, &seats, &mut rng, 0, Action::Describe { text: "紅紅的水果".into() }).unwrap();
        assert_eq!(g.stage, Stage::Speak { at: 1 });
        // 臥底講平民的詞不算犯規（他不知道）
        act(&mut g, &seats, &mut rng, 1, Action::Describe { text: "很甜".into() }).unwrap();
        act(&mut g, &seats, &mut rng, 2, Action::Done).unwrap();
        act(&mut g, &seats, &mut rng, 3, Action::Describe { text: "不是蘋果".into() }).unwrap();
        assert_eq!(g.stage, Stage::Discuss);
        assert_eq!(g.speeches[2].text, None);
    }

    #[test]
    fn civilians_win_when_the_undercover_is_voted_out() {
        let (mut g, seats, mut rng) = game(4, &[C, C, C, U], Options { discuss_secs: 0, ..Options::default() });
        skip_to_speaking(&mut g, &seats, &mut rng);
        everyone_speaks(&mut g, &seats, &mut rng);
        assert!(matches!(g.stage, Stage::Vote { revote: false, .. }));
        assert_eq!(act(&mut g, &seats, &mut rng, 0, Action::Vote { seat: 0 }), Err("不能投給自己".into()));
        vote(&mut g, &seats, &mut rng, &[(0, 3), (1, 3), (2, 3), (3, 0)]);
        assert_eq!(g.stage, Stage::Out { seat: Some(3) });
        // 出局了而且公開身分
        let view = g.view(Some(0), Instant::now());
        assert_eq!(view["seats"][3]["role"], "undercover");
        g.deadline = Some(Instant::now());
        let mut out = Default::default();
        g.tick(&mut test_ctx(&mut rng, &seats, &mut out));
        assert_eq!(g.winner, Some(Side::Civilian));
        assert!(g.finished());
        assert_eq!(g.scores.get(&1), Some(&1));
        assert_eq!(g.scores.get(&4), None);
    }

    #[test]
    fn ties_revote_then_nobody_goes_out() {
        let (mut g, seats, mut rng) = game(5, &[C, C, C, C, U], Options { discuss_secs: 0, ..Options::default() });
        skip_to_speaking(&mut g, &seats, &mut rng);
        everyone_speaks(&mut g, &seats, &mut rng);
        vote(&mut g, &seats, &mut rng, &[(0, 1), (1, 0), (2, 1), (3, 0), (4, 2)]);
        assert_eq!(g.stage, Stage::Vote { candidates: vec![0, 1], revote: true });
        assert!(act(&mut g, &seats, &mut rng, 2, Action::Vote { seat: 4 }).is_err());
        vote(&mut g, &seats, &mut rng, &[(0, 1), (1, 0), (2, 1), (3, 0), (4, 0)]);
        assert_eq!(g.stage, Stage::Out { seat: Some(0) });

        // 下一輪又平手兩次：沒人出局，繼續下一輪
        g.deadline = Some(Instant::now());
        let mut out = Default::default();
        g.tick(&mut test_ctx(&mut rng, &seats, &mut out));
        assert_eq!(g.round, 2);
        assert_eq!(g.speakers, [1, 2, 3, 4], "從上一輪起頭的下一個還在場上的人開始");
        everyone_speaks(&mut g, &seats, &mut rng);
        vote(&mut g, &seats, &mut rng, &[(1, 2), (2, 1), (3, 4), (4, 3)]);
        vote(&mut g, &seats, &mut rng, &[(1, 2), (2, 1), (3, 4), (4, 3)]);
        assert_eq!(g.stage, Stage::Out { seat: None });
        assert_eq!(g.alive, [false, true, true, true, true]);
    }

    #[test]
    fn undercover_wins_when_they_catch_up() {
        let (mut g, seats, mut rng) = game(3, &[C, C, U], Options { discuss_secs: 0, ..Options::default() });
        skip_to_speaking(&mut g, &seats, &mut rng);
        everyone_speaks(&mut g, &seats, &mut rng);
        vote(&mut g, &seats, &mut rng, &[(0, 1), (1, 2), (2, 1)]);
        g.deadline = Some(Instant::now());
        let mut out = Default::default();
        g.tick(&mut test_ctx(&mut rng, &seats, &mut out));
        assert_eq!(g.winner, Some(Side::Undercover));
        assert_eq!(g.scores.get(&3), Some(&2));
    }

    #[test]
    fn a_blank_can_guess_the_civilian_word() {
        let (mut g, seats, mut rng) = game(5, &[C, C, C, U, B], Options { discuss_secs: 0, ..Options::default() });
        skip_to_speaking(&mut g, &seats, &mut rng);
        everyone_speaks(&mut g, &seats, &mut rng);
        vote(&mut g, &seats, &mut rng, &[(0, 4), (1, 4), (2, 4), (3, 4), (4, 0)]);
        g.deadline = Some(Instant::now());
        let mut out = Default::default();
        g.tick(&mut test_ctx(&mut rng, &seats, &mut out));
        assert_eq!(g.stage, Stage::Guess { seat: 4 });
        assert!(act(&mut g, &seats, &mut rng, 0, Action::Guess { word: "蘋果".into() }).is_err());
        act(&mut g, &seats, &mut rng, 4, Action::Guess { word: " 蘋果 ".into() }).unwrap();
        assert_eq!(g.winner, Some(Side::Undercover));
        assert!(g.guess.as_ref().unwrap().correct);
    }

    #[test]
    fn chat_rules() {
        let (mut g, seats, mut rng) = game(4, &[C, C, C, U], Options::default());
        let mut out = Default::default();
        let mut ctx = test_ctx(&mut rng, &seats, &mut out);
        assert!(matches!(g.chat(Some(0), "我覺得是蘋果", &mut ctx), Chat::Drop));
        assert!(matches!(g.chat(Some(3), "我覺得是蘋果", &mut ctx), Chat::Show));
        g.alive[2] = false;
        assert!(matches!(g.chat(Some(2), "好無聊", &mut ctx), Chat::Only(To::SeatsAndSpectators(ref s)) if s == &[2]));
        assert!(matches!(g.chat(None, "加油", &mut ctx), Chat::Only(_)));
    }

    #[test]
    fn bots_can_play_a_whole_game() {
        for _ in 0..30 {
            let seats = seats(6, 5);
            let mut rng = Rng::new();
            let options = Options { blank: true, discuss_secs: 0, ..Options::default() };
            let mut g = {
                let mut out = Default::default();
                Undercover::start(&options, None, &mut test_ctx(&mut rng, &seats, &mut out))
            };
            let mut now = Instant::now();
            for _ in 0..2000 {
                if g.finished() {
                    break;
                }
                now += Duration::from_millis(500);
                let mut out = Default::default();
                let mut ctx = crate::party::test_ctx(now, &mut rng, &seats, &mut out);
                // 人一直沒動作：時間到就跳過、不投票
                g.tick(&mut ctx);
            }
            assert!(g.finished(), "卡在 {:?}", g.stage);
            for s in g.speeches.iter().filter(|s| g.bots[s.seat]) {
                if let (Some(text), Some(word)) = (&s.text, g.my_word(s.seat)) {
                    assert!(!contains_word(text, word));
                }
            }
        }
    }
}
