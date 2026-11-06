//! 只有一個詞（改編自合作桌遊 Just One，房間本身見 `party.rs`）。
//!
//! 3～10 人一起合作，每一題輪一個人猜，其他人是出題的人：看得到題目，各自偷偷寫一個提示詞（3 人時每人寫兩個）。
//! 流程：
//! 1. 寫提示（有時限）：大家同時寫，全部寫完之前看不到別人的提示。斷線或時間到還沒寫的人就是沒有提示。
//!    提示不能包含題目、也不能是題目的一部分（伺服器檢查，送出時就擋下來）。
//! 2. 檢查：伺服器把提示正規化（去掉空白標點、全形轉半形、英文轉小寫、臺→台）後比對，一模一樣的全部作廢。
//!    接著出題的人可以再手動標「太像了」（同義、同字根…）刪掉，有時限，大家都按「檢查好了」就提早結束。
//! 3. 猜：猜的人只看得到留下來的提示，猜一次或跳過；時間到或斷線 10 秒就算跳過。
//!    線下模式猜的人直接說出答案，由出題的人按「猜對了」或「猜錯了」。
//! 4. 公布：所有人看到題目、所有提示和答案。線上模式猜錯時，出題的人可以投「算對」（意思一樣、只是寫法不同），
//!    連著線的出題的人過半數投了就算猜對。
//!
//! 計分：猜對 +1 張；跳過只丟掉這張；猜錯丟掉這張和牌堆最上面一張（已經沒牌了就從猜對的裡面扣一張）。
//! 牌堆用完就結束，分數是 0～總張數，附上一句照桌遊分級的評語。
//!
//! 隱藏資訊：猜的人和觀戰的人在公布前拿不到題目和被刪掉的提示。桌遊規則本來就不能交談，
//! 所以公布前出題的人在聊天室說的話只有出題的人看得到，猜的人和觀戰的人都看不到（題目、提示不會從聊天室漏出去）。
//! 題目用你畫我猜的內建詞庫（`draw_words.txt`）裡簡單和普通的詞，不含主題詞庫（例如英雄聯盟）。沒有電腦玩家。

use std::{sync::Arc, time::Duration};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::time::Instant;

use crate::{
    AppState,
    draw::{self, Level, WORDS},
    party::{Chat, Ctx, Parties, PartyGame, To, clean},
};

/// 手動檢查提示的時間
const REVIEW: Duration = Duration::from_secs(30);
/// 公布答案停多久（大家都按「下一題」會提早）
const REVEAL: Duration = Duration::from_secs(15);
/// 猜的人斷線時最多等這麼久就算跳過
const OFFLINE_WAIT: Duration = Duration::from_secs(10);
pub const MAX_CLUE: usize = 12;
pub const MAX_GUESS: usize = 20;

/// 比對用：全形轉半形、只留文字和數字（空白標點不算）、英文轉小寫，再把常見的異體字統一
pub fn normalize(text: &str) -> String {
    draw::normalize(text)
        .into_iter()
        .map(|c| match c {
            '臺' => '台',
            c => c,
        })
        .collect()
}

/// 提示和題目同字根：包含題目，或是題目的一部分（例如題目「長頸鹿」寫「鹿」）
fn same_root(clue: &str, word: &str) -> bool {
    let (clue, word) = (normalize(clue), normalize(word));
    !clue.is_empty() && !word.is_empty() && (clue.contains(&word) || word.contains(&clue))
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    /// 留下來，猜的人看得到
    Ok,
    /// 和別人的提示一樣，全部作廢
    Duplicate,
    /// 空的或和題目同字根
    Invalid,
    /// 出題的人手動標了「太像了」
    Similar,
}

/// 自動檢查：空的、和題目同字根的無效；正規化之後一樣的提示全部作廢
pub fn check_clues(word: &str, clues: &[&str]) -> Vec<Status> {
    let norms: Vec<String> = clues.iter().map(|c| normalize(c)).collect();
    norms
        .iter()
        .zip(clues)
        .map(|(norm, clue)| {
            if norm.is_empty() || same_root(clue, word) {
                Status::Invalid
            } else if norms.iter().filter(|other| *other == norm).count() > 1 {
                Status::Duplicate
            } else {
                Status::Ok
            }
        })
        .collect()
}

/// 猜的答案對不對：正規化之後完全一樣
pub fn is_correct(guess: &str, word: &str) -> bool {
    let guess = normalize(guess);
    !guess.is_empty() && guess == normalize(word)
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Outcome {
    Correct,
    Wrong,
    Pass,
}

/// 牌堆和分數：`score + lost + left`（加上正在猜的那張）永遠等於 `total`
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
pub struct Deck {
    pub total: u32,
    /// 還沒翻的牌
    pub left: u32,
    /// 猜對的牌
    pub score: u32,
    /// 丟掉的牌
    pub lost: u32,
}

impl Deck {
    pub fn new(total: u32) -> Self {
        Self { total, left: total, score: 0, lost: 0 }
    }

    /// 翻下一張；沒牌了回 false
    fn draw(&mut self) -> bool {
        let more = self.left > 0;
        self.left = self.left.saturating_sub(1);
        more
    }

    /// 這張牌的結果：猜對收下；跳過丟掉；猜錯再多丟牌堆最上面一張，沒牌了就從猜對的裡面扣一張
    pub fn settle(&mut self, outcome: Outcome) {
        match outcome {
            Outcome::Correct => self.score += 1,
            Outcome::Pass => self.lost += 1,
            Outcome::Wrong => {
                self.lost += 1;
                if self.left > 0 {
                    self.left -= 1;
                    self.lost += 1;
                } else if self.score > 0 {
                    self.score -= 1;
                    self.lost += 1;
                }
            }
        }
    }
}

/// 結束時的評語：照桌遊 13 張的分級，張數不同時換算成 13 張
pub fn rating(score: u32, total: u32) -> &'static str {
    if total > 0 && score >= total {
        return "滿分！完美的默契，還能再來一次嗎？";
    }
    match score * 13 / total.max(1) {
        12.. => "太厲害了！朋友一定很佩服你們",
        11 => "超棒！這個分數值得慶祝一下",
        9 | 10 => "哇，很不錯喔！",
        7 | 8 => "中等水準，再玩一次會更好！",
        4..=6 => "好的開始，再試一次吧！",
        _ => "再試一次，再一次，再一次……",
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Options {
    /// 一局幾張牌（桌遊是 13 張）
    pub cards: u8,
    /// 寫提示的秒數，0 表示不限
    pub clue_secs: u16,
    /// 猜的秒數，0 表示不限
    pub guess_secs: u16,
    /// 線下模式：猜的人直接說出答案，出題的人按對或錯
    pub offline: bool,
}

impl Default for Options {
    fn default() -> Self {
        Self { cards: 13, clue_secs: 90, guess_secs: 60, offline: false }
    }
}

fn secs(n: u16) -> Option<Duration> {
    (n > 0).then(|| Duration::from_secs(u64::from(n)))
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Action {
    /// 寫提示（3 人時要兩個）；全部寫完之前可以改
    Clue {
        words: Vec<String>,
    },
    /// 檢查時標或取消「太像了」
    Mark {
        index: usize,
    },
    /// 檢查時「檢查好了」、公布時「下一題」
    Ready,
    Guess {
        word: String,
    },
    /// 猜的人跳過這題
    Pass,
    /// 線下模式：出題的人判斷猜的人說的答案
    Judge {
        correct: bool,
    },
    /// 公布時投「算對」，再按一次取消
    Accept,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Stage {
    Clue,
    Review,
    Guess,
    Reveal,
    End,
}

impl Stage {
    fn name(self) -> &'static str {
        match self {
            Stage::Clue => "clue",
            Stage::Review => "review",
            Stage::Guess => "guess",
            Stage::Reveal => "reveal",
            Stage::End => "end",
        }
    }
}

#[derive(Clone, Debug)]
struct Clue {
    seat: usize,
    text: String,
    /// 自動檢查的結果（Ok、Duplicate、Invalid）
    auto: Status,
    /// 誰標了「太像了」
    marked_by: Option<usize>,
}

impl Clue {
    fn status(&self) -> Status {
        match (self.auto, self.marked_by) {
            (Status::Ok, Some(_)) => Status::Similar,
            (status, _) => status,
        }
    }

    fn json(&self) -> Value {
        json!({ "seat": self.seat, "text": self.text, "status": self.status(), "markedBy": self.marked_by })
    }
}

/// 猜完的一題，公布後大家都看得到
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct Record {
    round: u32,
    guesser: usize,
    word: &'static str,
    clues: Vec<Value>,
    guess: Option<String>,
    outcome: Outcome,
    /// 猜錯但出題的人投票算對
    accepted: bool,
}

pub struct JustOne {
    options: Options,
    names: Vec<String>,
    online: Vec<bool>,
    deck: Deck,
    /// 第幾題（從 1 開始）
    round: u32,
    /// 下一題從這個座位開始找猜的人
    next: usize,
    guesser: usize,
    word: &'static str,
    /// 每個座位這題寫的提示（還沒送出是 None）
    drafts: Vec<Option<Vec<String>>>,
    /// 寫完之後整理好的提示（照座位排）
    clues: Vec<Clue>,
    guess: Option<String>,
    outcome: Option<Outcome>,
    accepts: Vec<bool>,
    ready: Vec<bool>,
    stage: Stage,
    deadline: Option<Instant>,
    stage_started: Instant,
    history: Vec<Record>,
    /// 這個房間用過的題目（`WORDS` 的索引），下一局盡量不重複
    used: Vec<usize>,
    /// 這個房間最好的成績 (分數, 張數)
    best: Option<(u32, u32)>,
}

impl JustOne {
    /// 每個出題的人寫幾個提示：3 人時兩個（桌遊規則），其他一個
    fn per_giver(&self) -> usize {
        if self.names.len() == 3 { 2 } else { 1 }
    }

    fn givers(&self) -> Vec<usize> {
        (0..self.names.len()).filter(|&s| s != self.guesser).collect()
    }

    fn is_giver(&self, seat: usize) -> bool {
        seat != self.guesser
    }

    fn set_stage(&mut self, stage: Stage, length: Option<Duration>, ctx: &mut Ctx) {
        self.stage = stage;
        self.stage_started = ctx.now;
        self.deadline = length.map(|d| ctx.now + d);
        self.ready.fill(false);
        ctx.changed();
    }

    fn pick_word(&mut self, ctx: &mut Ctx) -> &'static str {
        let pool = |used: &[usize]| -> Vec<usize> {
            (0..WORDS.len())
                .filter(|&i| WORDS[i].level != Level::Hard && !draw::is_theme(&WORDS[i].category) && !used.contains(&i))
                .collect()
        };
        let mut fresh = pool(&self.used);
        if fresh.is_empty() {
            self.used.clear();
            fresh = pool(&self.used);
        }
        let i = fresh[ctx.rng.below(fresh.len())];
        self.used.push(i);
        WORDS[i].word.as_str()
    }

    /// 翻下一張牌；沒牌了就結束
    fn begin_round(&mut self, ctx: &mut Ctx) {
        if !self.deck.draw() {
            self.finish(ctx);
            return;
        }
        self.round += 1;
        // 輪流猜，跳過斷線的人（全部都斷線就照順序）
        let n = self.names.len();
        let guesser = (0..n).map(|k| (self.next + k) % n).find(|&s| self.online[s]).unwrap_or(self.next % n);
        self.guesser = guesser;
        self.next = (guesser + 1) % n;
        self.word = self.pick_word(ctx);
        self.drafts.fill(None);
        self.clues.clear();
        self.guess = None;
        self.outcome = None;
        self.accepts.fill(false);
        ctx.system(
            To::All,
            format!("第 {} 題（還有 {} 張）：{} 猜，其他人寫提示", self.round, self.deck.left, self.names[guesser]),
        );
        self.set_stage(Stage::Clue, secs(self.options.clue_secs), ctx);
    }

    /// 連著線的出題的人都寫好了（斷線的不等）
    fn all_submitted(&self) -> bool {
        self.givers().into_iter().all(|s| self.drafts[s].is_some() || !self.online[s])
    }

    fn givers_ready(&self) -> bool {
        self.givers().into_iter().all(|s| self.ready[s] || !self.online[s])
    }

    fn everyone_ready(&self) -> bool {
        (0..self.names.len()).all(|s| self.ready[s] || !self.online[s])
    }

    /// 收提示、自動刪掉一樣的，進入手動檢查（沒有提示就直接猜）
    fn end_clues(&mut self, ctx: &mut Ctx) {
        let mut clues: Vec<Clue> = Vec::new();
        for seat in self.givers() {
            for text in self.drafts[seat].iter().flatten() {
                clues.push(Clue { seat, text: text.clone(), auto: Status::Ok, marked_by: None });
            }
        }
        let texts: Vec<&str> = clues.iter().map(|c| c.text.as_str()).collect();
        let statuses = check_clues(self.word, &texts);
        for (clue, status) in clues.iter_mut().zip(statuses) {
            clue.auto = status;
        }
        let removed = clues.iter().filter(|c| c.auto != Status::Ok).count();
        self.clues = clues;
        if self.clues.is_empty() {
            ctx.system(To::All, "沒有人寫提示");
            self.begin_guess(ctx);
            return;
        }
        let text = if removed > 0 {
            format!("提示都收到了，一樣的自動刪掉 {removed} 個。還有意思太像的可以標「太像了」")
        } else {
            "提示都收到了，沒有一樣的。還有意思太像的可以標「太像了」".to_owned()
        };
        ctx.system(To::Seats(self.givers()), text);
        self.set_stage(Stage::Review, Some(REVIEW), ctx);
    }

    fn surviving(&self) -> usize {
        self.clues.iter().filter(|c| c.status() == Status::Ok).count()
    }

    fn begin_guess(&mut self, ctx: &mut Ctx) {
        let left = self.surviving();
        let how = if self.options.offline { "說出答案" } else { "猜" };
        ctx.system(To::All, format!("輪到 {} {how}，留下 {left} 個提示", self.names[self.guesser]));
        self.set_stage(Stage::Guess, secs(self.options.guess_secs), ctx);
    }

    fn resolve(&mut self, outcome: Outcome, guess: Option<String>, ctx: &mut Ctx) {
        let who = &self.names[self.guesser];
        let word = self.word;
        let (text, tone) = match (outcome, &guess) {
            (Outcome::Correct, _) => (format!("答案是「{word}」，{who} 猜對了！"), "ok"),
            (Outcome::Wrong, Some(g)) if !self.options.offline => {
                (format!("答案是「{word}」，{who} 猜「{g}」，猜錯了（意思一樣的話，出題的人可以按「算對」）"), "danger")
            }
            (Outcome::Wrong, Some(g)) => (format!("答案是「{word}」，{who} 猜「{g}」，猜錯了"), "danger"),
            (Outcome::Wrong, None) => (format!("答案是「{word}」，{who} 猜錯了"), "danger"),
            (Outcome::Pass, _) => (format!("答案是「{word}」，{who} 跳過了"), "accent"),
        };
        ctx.announce(To::All, text, tone);
        self.guess = guess;
        self.outcome = Some(outcome);
        self.accepts.fill(false);
        self.set_stage(Stage::Reveal, Some(REVEAL), ctx);
    }

    /// 猜錯時能不能投「算對」：線上模式、真的有猜一個詞
    fn can_accept(&self) -> bool {
        !self.options.offline && self.outcome == Some(Outcome::Wrong) && self.guess.is_some()
    }

    /// 要幾票才算對：連著線的出題的人過半數
    fn accepts_needed(&self) -> usize {
        let online = self.givers().into_iter().filter(|&s| self.online[s]).count();
        online / 2 + 1
    }

    fn accepted(&self) -> bool {
        let votes = self.givers().into_iter().filter(|&s| self.accepts[s]).count();
        self.can_accept() && votes >= self.accepts_needed()
    }

    /// 公布完：結算這張牌，翻下一張
    fn finish_round(&mut self, ctx: &mut Ctx) {
        let Some(outcome) = self.outcome else { return };
        let accepted = self.accepted();
        let outcome = if accepted { Outcome::Correct } else { outcome };
        if accepted {
            ctx.announce(
                To::All,
                format!("出題的人投票：「{}」算對！", self.guess.as_deref().unwrap_or_default()),
                "ok",
            );
        }
        let before = self.deck;
        self.deck.settle(outcome);
        if outcome == Outcome::Wrong {
            if before.left > 0 {
                ctx.system(To::All, "猜錯了，牌堆最上面那張也一起丟掉");
            } else if before.score > 0 {
                ctx.system(To::All, "最後一張猜錯，從猜對的裡面扣掉一張");
            }
        }
        self.history.push(Record {
            round: self.round,
            guesser: self.guesser,
            word: self.word,
            clues: self.clues.iter().map(Clue::json).collect(),
            guess: self.guess.clone(),
            outcome: self.outcome.unwrap_or(outcome),
            accepted,
        });
        self.begin_round(ctx);
    }

    fn finish(&mut self, ctx: &mut Ctx) {
        let Deck { score, total, .. } = self.deck;
        if self.best.is_none_or(|(s, t)| score * t.max(1) > s * total.max(1)) {
            self.best = Some((score, total));
        }
        ctx.announce(To::All, format!("結束！猜對 {score} / {total} 張：{}", rating(score, total)), "ok");
        self.set_stage(Stage::End, None, ctx);
    }

    fn deadline_passed(&mut self, ctx: &mut Ctx) {
        match self.stage {
            Stage::Clue => self.end_clues(ctx),
            Stage::Review => self.begin_guess(ctx),
            Stage::Guess => {
                ctx.system(To::All, "時間到，算跳過");
                self.resolve(Outcome::Pass, None, ctx);
            }
            Stage::Reveal => self.finish_round(ctx),
            Stage::End => {}
        }
    }

    fn submit(&mut self, seat: usize, words: Vec<String>) -> Result<(), String> {
        let per = self.per_giver();
        if words.len() != per {
            return Err(if per == 2 {
                "3 人玩時每人要寫兩個提示".into()
            } else {
                "只能寫一個提示".into()
            });
        }
        let words: Vec<String> = words.iter().map(|w| clean(w, MAX_CLUE)).collect();
        for word in &words {
            if word.is_empty() {
                return Err("請輸入提示".into());
            }
            if word.contains(char::is_whitespace) {
                return Err("提示只能是一個詞，不要有空白".into());
            }
            if normalize(word).is_empty() {
                return Err("提示要有文字或數字".into());
            }
            if same_root(word, self.word) {
                return Err("提示不能包含題目，也不能是題目的一部分".into());
            }
        }
        if per == 2 && normalize(&words[0]) == normalize(&words[1]) {
            return Err("兩個提示不能一樣".into());
        }
        self.drafts[seat] = Some(words);
        Ok(())
    }
}

impl PartyGame for JustOne {
    const ID: &'static str = "justone";
    const MIN_PLAYERS: usize = 3;
    const MAX_PLAYERS: usize = 10;

    type Options = Options;
    type Action = Action;

    fn rooms(state: &AppState) -> &Arc<Parties<Self>> {
        &state.justone
    }

    fn check_options(mut options: Options) -> Result<Options, String> {
        options.cards = options.cards.clamp(5, 20);
        if options.clue_secs > 0 {
            options.clue_secs = options.clue_secs.clamp(30, 300);
        }
        if options.guess_secs > 0 {
            options.guess_secs = options.guess_secs.clamp(20, 300);
        }
        Ok(options)
    }

    fn start(options: &Options, previous: Option<&Self>, ctx: &mut Ctx) -> Self {
        let n = ctx.seats.len();
        let mut game = Self {
            options: options.clone(),
            names: ctx.seats.iter().map(|s| s.name.clone()).collect(),
            online: ctx.seats.iter().map(|s| s.online).collect(),
            deck: Deck::new(u32::from(options.cards)),
            round: 0,
            next: ctx.rng.below(n),
            guesser: 0,
            word: "",
            drafts: vec![None; n],
            clues: Vec::new(),
            guess: None,
            outcome: None,
            accepts: vec![false; n],
            ready: vec![false; n],
            stage: Stage::Clue,
            deadline: None,
            stage_started: ctx.now,
            history: Vec::new(),
            used: previous.map(|p| p.used.clone()).unwrap_or_default(),
            best: previous.and_then(|p| p.best),
        };
        let per = if game.per_giver() == 2 { "（3 人玩每人寫兩個提示）" } else { "" };
        ctx.system(To::All, format!("新的一局：{} 張牌，大家合作猜對越多越好{per}", options.cards));
        game.begin_round(ctx);
        game
    }

    fn act(&mut self, seat: usize, action: Action, ctx: &mut Ctx) -> Result<(), String> {
        let giver = self.is_giver(seat);
        match (action, self.stage) {
            (Action::Clue { words }, Stage::Clue) if giver => {
                self.submit(seat, words)?;
                if self.all_submitted() {
                    self.end_clues(ctx);
                }
                Ok(())
            }
            (Action::Mark { index }, Stage::Review) if giver => {
                let clue = self.clues.get_mut(index).ok_or("沒有這個提示")?;
                if clue.auto != Status::Ok {
                    return Err("這個提示已經被刪掉了".into());
                }
                clue.marked_by = match clue.marked_by {
                    Some(_) => None,
                    None => Some(seat),
                };
                Ok(())
            }
            (Action::Ready, Stage::Review) if giver => {
                self.ready[seat] = true;
                if self.givers_ready() {
                    self.begin_guess(ctx);
                }
                Ok(())
            }
            (Action::Ready, Stage::Reveal) => {
                self.ready[seat] = true;
                if self.everyone_ready() {
                    self.finish_round(ctx);
                }
                Ok(())
            }
            (Action::Guess { word }, Stage::Guess) if !giver => {
                if self.options.offline {
                    return Err("線下模式請直接說出答案，由出題的人按對或錯".into());
                }
                let word = clean(&word, MAX_GUESS);
                if normalize(&word).is_empty() {
                    return Err("請輸入你猜的詞".into());
                }
                let outcome = if is_correct(&word, self.word) { Outcome::Correct } else { Outcome::Wrong };
                self.resolve(outcome, Some(word), ctx);
                Ok(())
            }
            (Action::Pass, Stage::Guess) if !giver => {
                self.resolve(Outcome::Pass, None, ctx);
                Ok(())
            }
            (Action::Judge { correct }, Stage::Guess) if giver && self.options.offline => {
                let outcome = if correct { Outcome::Correct } else { Outcome::Wrong };
                self.resolve(outcome, None, ctx);
                Ok(())
            }
            (Action::Accept, Stage::Reveal) if giver && self.can_accept() => {
                self.accepts[seat] = !self.accepts[seat];
                Ok(())
            }
            (_, Stage::Clue | Stage::Review) if !giver => Err("這題是你猜，等大家寫好提示".into()),
            (_, Stage::Guess) if giver => Err("等猜的人作答".into()),
            _ => Err("現在不能這樣做".into()),
        }
    }

    fn tick(&mut self, ctx: &mut Ctx) {
        match self.stage {
            Stage::Clue if self.all_submitted() => self.end_clues(ctx),
            Stage::Review if self.givers_ready() => self.begin_guess(ctx),
            Stage::Guess
                if !self.online[self.guesser] && ctx.now.duration_since(self.stage_started) >= OFFLINE_WAIT =>
            {
                ctx.system(To::All, format!("{} 斷線了，算跳過", self.names[self.guesser]));
                self.resolve(Outcome::Pass, None, ctx);
            }
            Stage::Reveal if self.everyone_ready() => self.finish_round(ctx),
            _ if self.deadline.is_some_and(|d| ctx.now >= d) => self.deadline_passed(ctx),
            _ => {}
        }
    }

    fn chat(&mut self, seat: Option<usize>, _text: &str, _ctx: &mut Ctx) -> Chat {
        match (self.stage, seat) {
            (Stage::Reveal | Stage::End, _) => Chat::Show,
            // 公布前出題的人之間的話，猜的人和觀戰的人都看不到（不會漏出題目或被刪掉的提示）
            (_, Some(s)) if self.is_giver(s) => Chat::Only(To::Seats(self.givers())),
            _ => Chat::Show,
        }
    }

    fn presence(&mut self, seat: usize, online: bool, ctx: &mut Ctx) {
        self.online[seat] = online;
        ctx.changed();
    }

    fn view(&self, seat: Option<usize>, now: Instant) -> Value {
        let giver = seat.is_some_and(|s| self.is_giver(s));
        let open = matches!(self.stage, Stage::Reveal | Stage::End);
        let insider = giver || open;
        let clues: Option<Vec<Value>> = match self.stage {
            Stage::Clue => None,
            Stage::Review | Stage::Guess if insider => Some(self.clues.iter().map(Clue::json).collect()),
            // 猜的人（和觀戰的人）只看得到留下來的提示
            Stage::Guess => Some(
                self.clues
                    .iter()
                    .filter(|c| c.status() == Status::Ok)
                    .map(|c| json!({ "seat": c.seat, "text": c.text, "status": Status::Ok, "markedBy": null }))
                    .collect(),
            ),
            Stage::Review => None,
            Stage::Reveal | Stage::End => Some(self.clues.iter().map(Clue::json).collect()),
        };
        let removed = matches!(self.stage, Stage::Guess | Stage::Reveal | Stage::End)
            .then(|| self.clues.len() - self.surviving());
        let accept = (self.stage == Stage::Reveal && self.can_accept()).then(|| {
            json!({
                "votes": self.givers().into_iter().filter(|&s| self.accepts[s]).count(),
                "needed": self.accepts_needed(),
                "mine": seat.is_some_and(|s| self.accepts[s]),
                "accepted": self.accepted(),
            })
        });
        let seats: Vec<Value> = (0..self.names.len())
            .map(|s| {
                json!({
                    "online": self.online[s],
                    "ready": self.ready[s],
                    "submitted": self.stage == Stage::Clue && self.drafts[s].is_some(),
                })
            })
            .collect();
        let Deck { score, total, .. } = self.deck;
        json!({
            "stage": self.stage.name(),
            "endsIn": self.deadline.map(|d| d.saturating_duration_since(now).as_millis() as u64),
            "options": self.options,
            "you": seat,
            "guesser": self.guesser,
            "round": self.round,
            "perGiver": self.per_giver(),
            "deck": self.deck,
            "word": insider.then_some(self.word),
            "mine": seat.and_then(|s| self.drafts[s].clone()).filter(|_| giver && self.stage == Stage::Clue),
            "seats": seats,
            "clues": clues,
            "removed": removed,
            "guess": if open { self.guess.clone() } else { None },
            "outcome": if open { self.outcome } else { None },
            "accept": accept,
            "history": self.history,
            "result": (self.stage == Stage::End).then(|| json!({
                "score": score,
                "total": total,
                "rating": rating(score, total),
            })),
            "best": self.best.map(|(score, total)| json!({ "score": score, "total": total })),
        })
    }

    fn finished(&self) -> bool {
        self.stage == Stage::End
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::party::{Outbox, Rng, SeatInfo};

    fn seats(n: usize) -> Vec<SeatInfo> {
        (0..n).map(|i| SeatInfo { pid: i as u32 + 1, name: format!("P{i}"), bot: false, online: true }).collect()
    }

    fn ctx<'a>(rng: &'a mut Rng, seats: &'a [SeatInfo], out: &'a mut Outbox) -> Ctx<'a> {
        crate::party::test_ctx(Instant::now(), rng, seats, out)
    }

    /// 開一局，固定第一題是座位 0 猜「蘋果」
    fn game(n: usize, options: Options) -> (JustOne, Vec<SeatInfo>, Rng) {
        let seats = seats(n);
        let mut rng = Rng::new();
        let mut g = {
            let mut out = Outbox::default();
            JustOne::start(&options, None, &mut ctx(&mut rng, &seats, &mut out))
        };
        g.guesser = 0;
        g.next = 1;
        g.word = "蘋果";
        (g, seats, rng)
    }

    fn act(g: &mut JustOne, seats: &[SeatInfo], rng: &mut Rng, seat: usize, action: Action) -> Result<(), String> {
        let mut out = Outbox::default();
        g.act(seat, action, &mut ctx(rng, seats, &mut out))
    }

    fn clue(g: &mut JustOne, seats: &[SeatInfo], rng: &mut Rng, seat: usize, word: &str) -> Result<(), String> {
        act(g, seats, rng, seat, Action::Clue { words: vec![word.into()] })
    }

    /// 過了這個階段的時限
    fn expire(g: &mut JustOne, seats: &[SeatInfo], rng: &mut Rng) {
        g.deadline = Some(Instant::now());
        let mut out = Outbox::default();
        g.tick(&mut ctx(rng, seats, &mut out));
    }

    #[test]
    fn normalize_ignores_width_case_spacing_and_variants() {
        assert_eq!(normalize(" ＡＰＰＬＥ！"), "apple");
        assert_eq!(normalize("Apple"), normalize("ａｐｐｌｅ"));
        assert_eq!(normalize("臺 北"), "台北");
        assert_eq!(normalize("１０１"), "101");
        assert_eq!(normalize("…！？"), "");
    }

    #[test]
    fn identical_clues_cancel_and_same_root_is_invalid() {
        let statuses = check_clues("長頸鹿", &["動物", "Tall", "ｔａｌｌ", "動物", "斑點", "鹿", "長頸鹿寶寶", "！！"]);
        use Status::*;
        assert_eq!(statuses, [Duplicate, Duplicate, Duplicate, Duplicate, Ok, Invalid, Invalid, Invalid]);
        assert_eq!(check_clues("台北", &["臺北101", "城市"]), [Invalid, Ok]);
        assert_eq!(check_clues("蘋果", &["紅色", "水果", "牛頓"]), [Ok, Ok, Ok]);
    }

    #[test]
    fn guesses_match_after_normalizing() {
        assert!(is_correct(" 蘋果 ", "蘋果"));
        assert!(is_correct("臺北101", "台北101"));
        assert!(is_correct("ＰＩＺＺＡ", "pizza"));
        assert!(!is_correct("青蘋果", "蘋果"));
        assert!(!is_correct("！", "！"));
    }

    #[test]
    fn deck_scoring_follows_the_box_rules() {
        let mut deck = Deck::new(13);
        assert!(deck.draw());
        deck.settle(Outcome::Correct);
        assert_eq!((deck.left, deck.score, deck.lost), (12, 1, 0));
        assert!(deck.draw());
        deck.settle(Outcome::Pass);
        assert_eq!((deck.left, deck.score, deck.lost), (11, 1, 1));
        assert!(deck.draw());
        deck.settle(Outcome::Wrong);
        assert_eq!((deck.left, deck.score, deck.lost), (9, 1, 3), "猜錯多丟一張");

        // 最後一張猜錯：從猜對的扣一張；一張都沒猜對就不扣
        let mut last = Deck { total: 3, left: 0, score: 2, lost: 0 };
        last.settle(Outcome::Wrong);
        assert_eq!((last.score, last.lost), (1, 2));
        let mut empty = Deck { total: 1, left: 0, score: 0, lost: 0 };
        empty.settle(Outcome::Wrong);
        assert_eq!((empty.score, empty.lost), (0, 1));
        assert!(!empty.draw());
    }

    #[test]
    fn ratings_follow_the_tiers() {
        assert_eq!(rating(13, 13), "滿分！完美的默契，還能再來一次嗎？");
        assert_eq!(rating(12, 13), "太厲害了！朋友一定很佩服你們");
        assert_eq!(rating(11, 13), "超棒！這個分數值得慶祝一下");
        assert_eq!(rating(9, 13), "哇，很不錯喔！");
        assert_eq!(rating(7, 13), "中等水準，再玩一次會更好！");
        assert_eq!(rating(4, 13), "好的開始，再試一次吧！");
        assert_eq!(rating(0, 13), "再試一次，再一次，再一次……");
        // 張數不同時換算：20 張猜對 19 張不是滿分
        assert_eq!(rating(19, 20), "太厲害了！朋友一定很佩服你們");
        assert_eq!(rating(5, 5), "滿分！完美的默契，還能再來一次嗎？");
    }

    #[test]
    fn options_are_clamped() {
        let o = JustOne::check_options(Options { cards: 99, clue_secs: 5, guess_secs: 0, offline: true }).unwrap();
        assert_eq!((o.cards, o.clue_secs, o.guess_secs), (20, 30, 0));
    }

    #[test]
    fn the_guesser_never_sees_the_word_or_removed_clues() {
        let (mut g, seats, mut rng) = game(5, Options::default());
        assert_eq!(g.stage, Stage::Clue);
        assert_eq!(
            act(&mut g, &seats, &mut rng, 0, Action::Clue { words: vec!["紅色".into()] }),
            Err("這題是你猜，等大家寫好提示".into())
        );
        assert_eq!(clue(&mut g, &seats, &mut rng, 1, "青蘋果"), Err("提示不能包含題目，也不能是題目的一部分".into()));
        assert_eq!(clue(&mut g, &seats, &mut rng, 1, "紅 色"), Err("提示只能是一個詞，不要有空白".into()));
        clue(&mut g, &seats, &mut rng, 1, "牛頓").unwrap();
        // 寫提示的時候看不到別人的提示
        let other = g.view(Some(2), Instant::now()).to_string();
        assert!(!other.contains("牛頓"), "{other}");
        assert!(g.view(Some(1), Instant::now()).to_string().contains("牛頓"));
        clue(&mut g, &seats, &mut rng, 2, "水果").unwrap();
        clue(&mut g, &seats, &mut rng, 3, "ＴＡＩＷＡＮ").unwrap();
        clue(&mut g, &seats, &mut rng, 4, "taiwan").unwrap();
        assert_eq!(g.stage, Stage::Review);
        assert_eq!(
            g.clues.iter().map(Clue::status).collect::<Vec<_>>(),
            [Status::Ok, Status::Ok, Status::Duplicate, Status::Duplicate]
        );

        // 手動標「太像了」：猜的人不能標，標兩次是取消
        assert!(act(&mut g, &seats, &mut rng, 0, Action::Mark { index: 1 }).is_err());
        assert_eq!(act(&mut g, &seats, &mut rng, 1, Action::Mark { index: 2 }), Err("這個提示已經被刪掉了".into()));
        act(&mut g, &seats, &mut rng, 1, Action::Mark { index: 1 }).unwrap();
        act(&mut g, &seats, &mut rng, 2, Action::Mark { index: 1 }).unwrap();
        assert_eq!(g.clues[1].status(), Status::Ok);
        act(&mut g, &seats, &mut rng, 3, Action::Mark { index: 1 }).unwrap();
        assert_eq!(g.clues[1].status(), Status::Similar);

        for viewer in [Some(0), None] {
            let view = g.view(viewer, Instant::now()).to_string();
            assert!(!view.contains("蘋果") && !view.contains("牛頓") && !view.contains("水果"), "{view}");
        }
        for s in 1..5 {
            act(&mut g, &seats, &mut rng, s, Action::Ready).unwrap();
        }
        assert_eq!(g.stage, Stage::Guess);
        let view = g.view(Some(0), Instant::now());
        assert_eq!(view["word"], Value::Null);
        assert_eq!(view["clues"], json!([{ "seat": 1, "text": "牛頓", "status": "ok", "markedBy": null }]));
        assert_eq!(view["removed"], 3);
        let text = view.to_string();
        assert!(!text.contains("水果") && !text.contains("taiwan") && !text.contains("蘋果"), "{text}");

        act(&mut g, &seats, &mut rng, 0, Action::Guess { word: " 蘋果！".into() }).unwrap();
        assert_eq!(g.stage, Stage::Reveal);
        let view = g.view(Some(0), Instant::now());
        assert_eq!(view["word"], "蘋果");
        assert_eq!(view["outcome"], "correct");
        assert_eq!(view["clues"].as_array().unwrap().len(), 4);
        for s in 0..5 {
            act(&mut g, &seats, &mut rng, s, Action::Ready).unwrap();
        }
        assert_eq!(g.deck.score, 1);
        assert_eq!(g.round, 2);
        assert_eq!(g.guesser, 1, "換下一個人猜");
        assert_eq!(g.history[0].word, "蘋果");
    }

    #[test]
    fn missing_clues_and_guesser_timeouts() {
        let (mut g, seats, mut rng) = game(4, Options::default());
        clue(&mut g, &seats, &mut rng, 1, "紅色").unwrap();
        // 座位 2 斷線不等；座位 3 時間到還沒寫：沒有提示
        g.online[2] = false;
        assert_eq!(g.stage, Stage::Clue);
        expire(&mut g, &seats, &mut rng);
        assert_eq!(g.stage, Stage::Review);
        assert_eq!(g.clues.len(), 1);
        expire(&mut g, &seats, &mut rng);
        assert_eq!(g.stage, Stage::Guess);
        assert_eq!(act(&mut g, &seats, &mut rng, 1, Action::Pass), Err("等猜的人作答".into()));
        expire(&mut g, &seats, &mut rng);
        assert_eq!(g.outcome, Some(Outcome::Pass));
        expire(&mut g, &seats, &mut rng);
        assert_eq!((g.deck.left, g.deck.score, g.deck.lost), (11, 0, 1));
        assert_eq!(g.guesser, 1);

        // 猜的人斷線 10 秒算跳過
        g.online[1] = false;
        g.stage = Stage::Guess;
        g.stage_started = Instant::now() - OFFLINE_WAIT;
        g.deadline = None;
        let mut out = Outbox::default();
        g.tick(&mut ctx(&mut rng, &seats, &mut out));
        assert_eq!(g.outcome, Some(Outcome::Pass));
    }

    #[test]
    fn nobody_writes_a_clue_goes_straight_to_guessing() {
        let (mut g, seats, mut rng) = game(3, Options::default());
        expire(&mut g, &seats, &mut rng);
        assert_eq!(g.stage, Stage::Guess);
        assert_eq!(g.view(Some(0), Instant::now())["clues"], json!([]));
    }

    #[test]
    fn three_players_write_two_clues_each() {
        let (mut g, seats, mut rng) = game(3, Options::default());
        assert_eq!(clue(&mut g, &seats, &mut rng, 1, "紅色"), Err("3 人玩時每人要寫兩個提示".into()));
        let two = |a: &str, b: &str| Action::Clue { words: vec![a.into(), b.into()] };
        assert_eq!(act(&mut g, &seats, &mut rng, 1, two("紅色", "紅色")), Err("兩個提示不能一樣".into()));
        act(&mut g, &seats, &mut rng, 1, two("紅色", "牛頓")).unwrap();
        act(&mut g, &seats, &mut rng, 2, two("水果", "牛頓")).unwrap();
        let statuses: Vec<Status> = g.clues.iter().map(Clue::status).collect();
        assert_eq!(statuses, [Status::Ok, Status::Duplicate, Status::Ok, Status::Duplicate]);
    }

    #[test]
    fn wrong_guess_costs_two_cards_unless_givers_accept_it() {
        let (mut g, seats, mut rng) = game(4, Options::default());
        for (s, w) in [(1, "紅色"), (2, "水果"), (3, "牛頓")] {
            clue(&mut g, &seats, &mut rng, s, w).unwrap();
        }
        expire(&mut g, &seats, &mut rng);
        act(&mut g, &seats, &mut rng, 0, Action::Guess { word: "林檎".into() }).unwrap();
        assert_eq!(g.outcome, Some(Outcome::Wrong));
        assert!(act(&mut g, &seats, &mut rng, 0, Action::Accept).is_err(), "猜的人不能自己投");
        // 3 個出題的人要 2 票
        act(&mut g, &seats, &mut rng, 1, Action::Accept).unwrap();
        assert!(!g.accepted());
        act(&mut g, &seats, &mut rng, 2, Action::Accept).unwrap();
        assert!(g.accepted());
        assert_eq!(g.view(Some(3), Instant::now())["accept"]["accepted"], true);
        expire(&mut g, &seats, &mut rng);
        assert_eq!((g.deck.score, g.deck.lost), (1, 0));
        assert!(g.history[0].accepted);
        g.word = "蘋果";

        // 這次沒人投：丟兩張
        for (s, w) in [(0, "紅色"), (2, "水果"), (3, "牛頓")] {
            clue(&mut g, &seats, &mut rng, s, w).unwrap();
        }
        expire(&mut g, &seats, &mut rng);
        act(&mut g, &seats, &mut rng, 1, Action::Guess { word: "香蕉".into() }).unwrap();
        expire(&mut g, &seats, &mut rng);
        assert_eq!((g.deck.left, g.deck.score, g.deck.lost), (9, 1, 2));
    }

    #[test]
    fn offline_mode_lets_givers_judge() {
        let (mut g, seats, mut rng) = game(4, Options { offline: true, ..Options::default() });
        expire(&mut g, &seats, &mut rng);
        assert_eq!(g.stage, Stage::Guess);
        assert!(act(&mut g, &seats, &mut rng, 0, Action::Guess { word: "蘋果".into() }).is_err());
        assert!(act(&mut g, &seats, &mut rng, 0, Action::Judge { correct: true }).is_err());
        act(&mut g, &seats, &mut rng, 2, Action::Judge { correct: true }).unwrap();
        assert_eq!(g.outcome, Some(Outcome::Correct));
        assert!(!g.can_accept());
    }

    #[test]
    fn givers_chat_is_hidden_from_the_guesser_until_the_reveal() {
        let (mut g, seats, mut rng) = game(4, Options::default());
        let mut out = Outbox::default();
        let mut c = ctx(&mut rng, &seats, &mut out);
        assert!(matches!(g.chat(Some(1), "答案是蘋果", &mut c), Chat::Only(To::Seats(ref s)) if s == &[1, 2, 3]));
        assert!(matches!(g.chat(Some(0), "是水果嗎", &mut c), Chat::Show));
        assert!(matches!(g.chat(None, "加油", &mut c), Chat::Show));
        g.stage = Stage::Guess;
        assert!(matches!(g.chat(Some(2), "快猜", &mut c), Chat::Only(_)));
        g.stage = Stage::Reveal;
        assert!(matches!(g.chat(Some(1), "差一點", &mut c), Chat::Show));
    }

    #[test]
    fn a_whole_game_ends_and_keeps_the_best_score() {
        let seats = seats(5);
        let mut rng = Rng::new();
        let options = Options { cards: 5, ..Options::default() };
        let mut g = {
            let mut out = Outbox::default();
            JustOne::start(&options, None, &mut ctx(&mut rng, &seats, &mut out))
        };
        let mut now = Instant::now();
        for _ in 0..4000 {
            if g.finished() {
                break;
            }
            now += Duration::from_millis(500);
            let mut out = Outbox::default();
            g.tick(&mut crate::party::test_ctx(now, &mut rng, &seats, &mut out));
        }
        assert!(g.finished(), "卡在 {:?}", g.stage);
        // 沒有人動作：每題都時間到跳過
        assert_eq!(g.history.len(), 5);
        assert_eq!((g.deck.score, g.deck.lost), (0, 5));
        assert_eq!(g.best, Some((0, 5)));
        let words: std::collections::HashSet<&str> = g.history.iter().map(|r| r.word).collect();
        assert_eq!(words.len(), 5, "同一局題目不重複");
        let guessers: Vec<usize> = g.history.iter().map(|r| r.guesser).collect();
        assert!(guessers.windows(2).all(|w| w[1] == (w[0] + 1) % 5), "輪流猜：{guessers:?}");

        // 下一局記得用過的題目和最好成績
        let mut out = Outbox::default();
        let next = JustOne::start(&options, Some(&g), &mut ctx(&mut rng, &seats, &mut out));
        assert_eq!(next.best, Some((0, 5)));
        assert_eq!(next.used.len(), 6);
    }
}
