//! 暗號接頭（派對房間，房間本身見 `party.rs`）：分兩隊的猜詞遊戲，規則、名稱和介面都是原創的。
//!
//! 4～10 人分成「翡翠」「紫晶」兩隊，每隊一位聯絡人。桌上 5×5 共 25 個詞，只有聯絡人拿得到密碼表：
//! 先手隊 9 張、後手隊 8 張、路人 7 張、叛徒 1 張。先翻完自己隊所有詞的隊伍獲勝（被對方翻到也算），翻到叛徒立刻輸。
//!
//! 流程：
//! 1. 選隊：每個人自己點要加入哪一隊、要不要當聯絡人；房主可以「隨機分隊」，再按「開始」發牌。
//!    還沒選隊的人補進人少的那隊，沒有聯絡人的隊照輪替挑一位（當過最少次、最久沒當的優先，在線的優先）。
//!    每隊至少 2 人（聯絡人加至少一位組員）。下一局沿用上一局的分隊，新來的人補進人少的那隊，聯絡人自動輪替。
//! 2. 給提示：輪到的隊伍，聯絡人給「一個詞＋一個數字（1～9）」。提示詞不能是盤面上的詞（翻開的也算），
//!    也不能包含盤面上的詞或被盤面上的詞包含；比對前先正規化（同只有一個詞：去掉空白標點、全形轉半形、小寫、臺→台），
//!    送出時就擋下來。線下模式聯絡人當面說出提示詞，網頁上只選數字。
//! 3. 猜：輪到的隊伍的組員在格子上標記想翻的（只有同隊的人看得到標記），由任一組員按「翻開」。
//!    這輪最多翻「數字＋1」張：翻到自己隊的可以繼續；翻到路人或對方的就換隊；翻到叛徒立刻輸。
//!    翻過一張之後可以按「結束這輪」。翻開時帶著「已經翻開幾張」，兩個人同時按只會翻到一張。
//!
//! 時限和斷線（遊戲不會卡住）：
//! - 給提示和猜各有時限（房主選，可以不限）。給提示時間到就跳過這輪；猜的時間到就換隊。
//! - 輪到給提示時聯絡人斷線：同隊還有看過密碼表的人在線就直接由他給；沒有就等 20 秒，
//!   隨機請一位在線的組員接手（他看到密碼表，這局就不能再標記、翻牌），重新計時；整隊都不在就跳過這輪。
//! - 猜的時候這隊的組員都斷線 15 秒就換隊。
//!
//! 隱藏資訊：
//! - 密碼表只在看過密碼表的人（兩隊的聯絡人和中途接手的人）的 view 裡，結束後才公開給所有人。
//!   觀戰的人也看不到：猜的人只要開個新分頁就能觀戰，給觀戰的人看等於給猜的人看。
//! - 對局中看過密碼表的人在聊天室說的話只有看過密碼表的人看得到（不能偷偷提示隊友）；結束後照常。
//! - 組員的標記只送給同一隊。
//!
//! 「隨機分隊」「開始」伺服器不檢查是不是房主（遊戲不知道誰是房主），按鈕只在房主的畫面上出現，
//! 房主沒有座位時所有人都看得到（同傳話畫畫的「下一步」）。沒有電腦玩家。
//! 詞庫在 `contact_words.txt`，同一個房間下一局盡量不出現用過的詞，同一個盤面不會有互相包含的詞。

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
    justone::normalize,
    party::{Chat, Ctx, Parties, PartyGame, Rng, To, clean, shuffle},
};

/// 盤面 5×5
pub const SIZE: usize = 25;
/// 先手隊、後手隊、路人的張數，剩下 1 張是叛徒
pub const FIRST_CARDS: usize = 9;
pub const SECOND_CARDS: usize = 8;
pub const BYSTANDERS: usize = 7;
pub const MAX_CLUE: usize = 12;
pub const MAX_COUNT: u8 = 9;
/// 輪到給提示時聯絡人斷線，等多久請組員接手（接手的人這局就不能翻牌，所以等久一點）
const LEAD_WAIT: Duration = Duration::from_secs(20);
/// 猜的時候這隊的組員都斷線，等多久就換隊
const GUESSER_WAIT: Duration = Duration::from_secs(15);
pub const TEAM_NAMES: [&str; 2] = ["翡翠", "紫晶"];

/// 詞庫：`#` 開頭的行和空行略過，每行用「、」隔開
pub static WORDS: LazyLock<Vec<&'static str>> = LazyLock::new(|| {
    include_str!("contact_words.txt")
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .flat_map(|line| line.split('、'))
        .map(str::trim)
        .filter(|word| !word.is_empty())
        .collect()
});

/// 密碼表上的一格
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Card {
    /// 翡翠隊（隊伍 0）
    Jade,
    /// 紫晶隊（隊伍 1）
    Amethyst,
    Bystander,
    Traitor,
}

impl Card {
    fn of(team: usize) -> Self {
        if team == 0 { Self::Jade } else { Self::Amethyst }
    }

    fn owner(self) -> Option<usize> {
        match self {
            Self::Jade => Some(0),
            Self::Amethyst => Some(1),
            Self::Bystander | Self::Traitor => None,
        }
    }
}

/// 發密碼表：先手隊 9、後手隊 8、路人 7、叛徒 1，洗勻
pub fn deal(rng: &mut Rng, first: usize) -> Vec<Card> {
    let mut key = Vec::with_capacity(SIZE);
    key.extend([Card::of(first); FIRST_CARDS]);
    key.extend([Card::of(1 - first); SECOND_CARDS]);
    key.extend([Card::Bystander; BYSTANDERS]);
    key.push(Card::Traitor);
    shuffle(rng, &mut key);
    key
}

/// 兩個詞重疊：正規化之後一樣、包含或被包含
fn overlaps(a: &str, b: &str) -> bool {
    let (a, b) = (normalize(a), normalize(b));
    !a.is_empty() && !b.is_empty() && (a.contains(&b) || b.contains(&a))
}

/// 提示詞撞到盤面上的哪個詞（一樣、包含盤面上的詞，或被盤面上的詞包含）；沒撞到是 None
pub fn clash<'a>(clue: &str, board: &[&'a str]) -> Option<&'a str> {
    board.iter().copied().find(|word| overlaps(clue, word))
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Options {
    /// 給提示的秒數，0 表示不限
    pub clue_secs: u16,
    /// 猜的秒數，0 表示不限
    pub guess_secs: u16,
    /// 線下模式：聯絡人當面說出提示，網頁上只選數字
    pub offline: bool,
}

impl Default for Options {
    fn default() -> Self {
        Self { clue_secs: 120, guess_secs: 120, offline: false }
    }
}

fn secs(n: u16) -> Option<Duration> {
    (n > 0).then(|| Duration::from_secs(u64::from(n)))
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Action {
    /// 選隊：加入 0（翡翠）或 1（紫晶）
    Join { team: usize },
    /// 選隊：當自己這隊的聯絡人，再按一次就不當
    Lead,
    /// 選隊：隨機分隊並照輪替挑聯絡人（畫面上只有房主有這個按鈕）
    Shuffle,
    /// 選隊結束，發牌（畫面上只有房主有這個按鈕）
    Go,
    /// 聯絡人給提示；線下模式不用填 `word`
    Clue {
        #[serde(default)]
        word: String,
        count: u8,
    },
    /// 組員標記想翻的格子，再按一次取消
    Mark { index: usize },
    /// 組員翻開一格；`seq` 是送出時已經翻開幾張，盤面變了（別人剛翻過）就擋下來
    Reveal { index: usize, seq: usize },
    /// 組員結束這一輪（至少要翻過一張）
    Stop,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Stage {
    Teams,
    Clue,
    Guess,
    End,
}

impl Stage {
    fn name(self) -> &'static str {
        match self {
            Stage::Teams => "teams",
            Stage::Clue => "clue",
            Stage::Guess => "guess",
            Stage::End => "end",
        }
    }
}

/// 一輪怎麼結束的
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum TurnEnd {
    /// 翻到路人或對方的
    Miss,
    /// 翻滿「數字＋1」張
    Limit,
    /// 組員自己按結束
    Stop,
    /// 猜的時間到
    Timeout,
    /// 組員都斷線
    Away,
    /// 沒有給提示（時間到或整隊都不在）
    NoClue,
    /// 這輪分出勝負
    Over,
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Reason {
    /// 翻完了自己隊的詞
    Cards,
    /// 對方翻到叛徒
    Traitor,
}

#[derive(Serialize, Clone, Debug)]
struct Flip {
    index: usize,
    card: Card,
    by: usize,
}

/// 一輪的紀錄，大家都看得到（翻開的格子本來就公開）
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct Turn {
    team: usize,
    /// 給提示的人；沒給提示是 None
    by: Option<usize>,
    /// 提示詞；線下模式（當面說）和沒給提示是 None
    word: Option<String>,
    count: Option<u8>,
    reveals: Vec<Flip>,
    end: Option<TurnEnd>,
}

pub struct Contact {
    options: Options,
    pids: Vec<u32>,
    names: Vec<String>,
    online: Vec<bool>,
    /// 什麼時候斷線的（連著線是 None）
    offline_at: Vec<Option<Instant>>,
    /// 每個座位在哪一隊（選隊時還沒選是 None）
    team: Vec<Option<usize>>,
    /// 每隊現在的聯絡人
    leads: [Option<usize>; 2],
    /// 看過密碼表的人（聯絡人和中途接手的人）：這局不能再標記、翻牌，聊天只給看過的人看
    insider: Vec<bool>,
    stage: Stage,
    deadline: Option<Instant>,
    stage_started: Instant,
    /// 盤面 25 個詞（`WORDS` 的索引）；選隊時是空的
    board: Vec<usize>,
    key: Vec<Card>,
    revealed: Vec<bool>,
    /// 每一格有哪些組員標記了（只有輪到的那隊在猜時有）
    marks: Vec<Vec<usize>>,
    first: usize,
    turn: usize,
    log: Vec<Turn>,
    winner: Option<usize>,
    reason: Option<Reason>,
    /// 這個房間的第幾局（從 1 開始）
    game_no: u32,
    // ---- 跨局累計（用 pid 認人）----
    /// 用過的詞（`WORDS` 的索引），下一局盡量不重複
    used: Vec<usize>,
    /// 每個人贏過幾局
    wins: HashMap<u32, u32>,
    /// 每個人當過幾次聯絡人、最後一次是第幾局，用來輪流
    led: HashMap<u32, (u32, u32)>,
}

impl Contact {
    fn seats(&self) -> usize {
        self.names.len()
    }

    fn members(&self, team: usize) -> Vec<usize> {
        (0..self.seats()).filter(|&s| self.team[s] == Some(team)).collect()
    }

    /// 能標記、翻牌的人：這隊沒看過密碼表的人
    fn guessers(&self, team: usize) -> Vec<usize> {
        self.members(team).into_iter().filter(|&s| !self.insider[s]).collect()
    }

    fn insiders(&self) -> Vec<usize> {
        (0..self.seats()).filter(|&s| self.insider[s]).collect()
    }

    fn word(&self, index: usize) -> &'static str {
        WORDS[self.board[index]]
    }

    fn words(&self) -> Vec<&'static str> {
        self.board.iter().map(|&i| WORDS[i]).collect()
    }

    /// 這隊還有幾張沒翻開
    fn left(&self, team: usize) -> usize {
        (0..self.key.len()).filter(|&i| !self.revealed[i] && self.key[i] == Card::of(team)).count()
    }

    fn flipped(&self) -> usize {
        self.revealed.iter().filter(|&&r| r).count()
    }

    fn set_stage(&mut self, stage: Stage, length: Option<Duration>, ctx: &mut Ctx) {
        self.stage = stage;
        self.stage_started = ctx.now;
        self.deadline = length.map(|d| ctx.now + d);
        ctx.changed();
    }

    /// 照輪替挑聯絡人：在線的優先，再來是當過最少次、最久沒當的，最後照座位
    fn pick_lead(&self, team: usize) -> Option<usize> {
        self.members(team).into_iter().min_by_key(|&s| {
            let (times, last) = self.led.get(&self.pids[s]).copied().unwrap_or((0, 0));
            (!self.online[s], times, last, s)
        })
    }

    /// 還沒選隊的人補進人少的那隊（一樣多就隨機）
    fn fill_free(team: &mut [Option<usize>], rng: &mut Rng) {
        let mut free: Vec<usize> = (0..team.len()).filter(|&s| team[s].is_none()).collect();
        shuffle(rng, &mut free);
        for s in free {
            let count = |t: usize| team.iter().filter(|x| **x == Some(t)).count();
            let t = match count(0).cmp(&count(1)) {
                std::cmp::Ordering::Less => 0,
                std::cmp::Ordering::Greater => 1,
                std::cmp::Ordering::Equal => rng.below(2),
            };
            team[s] = Some(t);
        }
    }

    /// 選隊：隨機分成兩隊（單數時隨機哪隊多一人），聯絡人照輪替
    fn shuffle_teams(&mut self, ctx: &mut Ctx) {
        let n = self.seats();
        let mut order: Vec<usize> = (0..n).collect();
        shuffle(ctx.rng, &mut order);
        let half = n / 2 + if n % 2 == 1 { ctx.rng.below(2) } else { 0 };
        for (k, &s) in order.iter().enumerate() {
            self.team[s] = Some(if k < half { 0 } else { 1 });
        }
        self.leads = [self.pick_lead(0), self.pick_lead(1)];
        ctx.system(To::All, "隨機分好隊了，聯絡人照輪替挑好了");
    }

    /// 抽 25 個詞：先從沒用過的抽，不夠就重新開始；同一盤不放互相包含的詞
    fn pick_words(&mut self, rng: &mut Rng) -> Vec<usize> {
        let mut fresh: Vec<usize> = (0..WORDS.len()).filter(|i| !self.used.contains(i)).collect();
        if fresh.len() < SIZE * 2 {
            self.used.clear();
            fresh = (0..WORDS.len()).collect();
        }
        shuffle(rng, &mut fresh);
        let mut picked: Vec<usize> = Vec::with_capacity(SIZE);
        for &i in &fresh {
            if picked.len() == SIZE {
                break;
            }
            if !picked.iter().any(|&p| overlaps(WORDS[p], WORDS[i])) {
                picked.push(i);
            }
        }
        // 詞庫很小時才會發生：湊不滿就不管重疊
        for &i in &fresh {
            if picked.len() == SIZE {
                break;
            }
            if !picked.contains(&i) {
                picked.push(i);
            }
        }
        self.used.extend(&picked);
        picked
    }

    /// 選隊結束、發牌。失敗時狀態不變
    fn go(&mut self, ctx: &mut Ctx) -> Result<(), String> {
        let mut team = self.team.clone();
        Self::fill_free(&mut team, ctx.rng);
        if (0..2).any(|t| team.iter().filter(|x| **x == Some(t)).count() < 2) {
            return Err("每隊至少要 2 人：1 位聯絡人加至少 1 位組員".into());
        }
        self.team = team;
        for t in 0..2 {
            if !self.leads[t].is_some_and(|s| self.team[s] == Some(t)) {
                self.leads[t] = self.pick_lead(t);
            }
        }
        self.first = ctx.rng.below(2);
        self.turn = self.first;
        self.board = self.pick_words(ctx.rng);
        self.key = deal(ctx.rng, self.first);
        self.revealed = vec![false; SIZE];
        self.marks = vec![Vec::new(); SIZE];
        for lead in self.leads.into_iter().flatten() {
            self.become_insider(lead);
        }
        let lead_name = |t: usize| self.leads[t].map_or("（沒有）", |s| self.names[s].as_str());
        let (first, second) = (self.first, 1 - self.first);
        ctx.announce(
            To::All,
            format!(
                "發牌了！{}隊先手（{FIRST_CARDS} 張），聯絡人是 {}；{}隊 {SECOND_CARDS} 張，聯絡人是 {}",
                TEAM_NAMES[first],
                lead_name(first),
                TEAM_NAMES[second],
                lead_name(second),
            ),
            "accent",
        );
        self.begin_clue(ctx);
        Ok(())
    }

    /// 看到密碼表了：這局不能再翻牌，也記一次「當過聯絡人」
    fn become_insider(&mut self, seat: usize) {
        if !self.insider[seat] {
            self.insider[seat] = true;
            let entry = self.led.entry(self.pids[seat]).or_insert((0, 0));
            *entry = (entry.0 + 1, self.game_no);
        }
    }

    fn begin_clue(&mut self, ctx: &mut Ctx) {
        self.marks.iter_mut().for_each(Vec::clear);
        let t = self.turn;
        let who = self.leads[t].map_or("聯絡人", |s| self.names[s].as_str());
        let how = if self.options.offline { "當面說出提示、選數字" } else { "給提示" };
        ctx.system(To::All, format!("輪到{}隊：等 {who} {how}", TEAM_NAMES[t]));
        self.set_stage(Stage::Clue, secs(self.options.clue_secs), ctx);
    }

    fn give_clue(&mut self, seat: usize, word: &str, count: u8, ctx: &mut Ctx) -> Result<(), String> {
        let t = self.turn;
        if self.team[seat] != Some(t) {
            return Err("還沒輪到你們".into());
        }
        if !self.insider[seat] {
            return Err("只有聯絡人能給提示".into());
        }
        if !(1..=MAX_COUNT).contains(&count) {
            return Err(format!("數字要在 1～{MAX_COUNT} 之間"));
        }
        let word = if self.options.offline {
            None
        } else {
            let word = clean(word, MAX_CLUE);
            if word.is_empty() {
                return Err("請輸入提示詞".into());
            }
            if word.contains(char::is_whitespace) {
                return Err("提示只能是一個詞，不要有空白".into());
            }
            if normalize(&word).is_empty() {
                return Err("提示要有文字或數字".into());
            }
            if let Some(hit) = clash(&word, &self.words()) {
                return Err(format!("提示不能是盤面上的詞，也不能包含或被包含在盤面上的詞裡（撞到「{hit}」）"));
            }
            Some(word)
        };
        self.leads[t] = Some(seat);
        let who = &self.names[seat];
        let text = match &word {
            Some(w) => format!("{who}（{}隊聯絡人）的提示：「{w}」{count}", TEAM_NAMES[t]),
            None => format!("{who}（{}隊聯絡人）說了提示，數字是 {count}", TEAM_NAMES[t]),
        };
        ctx.announce(To::All, text, "accent");
        self.log.push(Turn { team: t, by: Some(seat), word, count: Some(count), reveals: Vec::new(), end: None });
        self.set_stage(Stage::Guess, secs(self.options.guess_secs), ctx);
        Ok(())
    }

    /// 這輪最多能翻幾張、已經翻了幾張
    fn guesses(&self) -> (usize, usize) {
        match self.log.last() {
            Some(turn) if self.stage == Stage::Guess => (usize::from(turn.count.unwrap_or(0)) + 1, turn.reveals.len()),
            _ => (0, 0),
        }
    }

    /// 能不能標記、翻牌：輪到的隊伍、沒看過密碼表
    fn check_guesser(&self, seat: usize) -> Result<(), String> {
        if self.team[seat] != Some(self.turn) {
            return Err("還沒輪到你們".into());
        }
        if self.insider[seat] {
            return Err("你看過密碼表，這局不能標記或翻牌，交給組員".into());
        }
        Ok(())
    }

    fn mark(&mut self, seat: usize, index: usize) -> Result<(), String> {
        self.check_guesser(seat)?;
        if index >= SIZE {
            return Err("沒有這一格".into());
        }
        if self.revealed[index] {
            return Err("這張已經翻開了".into());
        }
        let marks = &mut self.marks[index];
        match marks.iter().position(|&s| s == seat) {
            Some(i) => {
                marks.remove(i);
            }
            None => marks.push(seat),
        }
        Ok(())
    }

    fn reveal(&mut self, seat: usize, index: usize, seq: usize, ctx: &mut Ctx) -> Result<(), String> {
        self.check_guesser(seat)?;
        if index >= SIZE {
            return Err("沒有這一格".into());
        }
        if self.revealed[index] {
            return Err("這張已經翻開了".into());
        }
        if seq != self.flipped() {
            return Err("盤面剛剛變了，再確認一次要翻哪張".into());
        }
        self.revealed[index] = true;
        self.marks[index].clear();
        let card = self.key[index];
        if let Some(turn) = self.log.last_mut() {
            turn.reveals.push(Flip { index, card, by: seat });
        }
        let (t, other) = (self.turn, 1 - self.turn);
        let who = &self.names[seat];
        let word = self.word(index);
        if card == Card::Traitor {
            ctx.announce(To::All, format!("{who} 翻開「{word}」：是叛徒！{}隊出局", TEAM_NAMES[t]), "danger");
            self.finish(other, Reason::Traitor, ctx);
            return Ok(());
        }
        match card.owner() {
            Some(owner) if owner == t => {
                ctx.announce(To::All, format!("{who} 翻開「{word}」：是自己人！"), "ok");
                let (limit, made) = self.guesses();
                if self.left(t) == 0 {
                    self.finish(t, Reason::Cards, ctx);
                } else if made >= limit {
                    ctx.system(To::All, format!("這輪的 {limit} 張都翻完了，換{}隊", TEAM_NAMES[other]));
                    self.end_turn(TurnEnd::Limit, ctx);
                }
            }
            Some(_) => {
                ctx.announce(To::All, format!("{who} 翻開「{word}」：是{}隊的人", TEAM_NAMES[other]), "danger");
                if self.left(other) == 0 {
                    self.finish(other, Reason::Cards, ctx);
                } else {
                    self.end_turn(TurnEnd::Miss, ctx);
                }
            }
            None => {
                ctx.system(To::All, format!("{who} 翻開「{word}」：是路人，換{}隊", TEAM_NAMES[other]));
                self.end_turn(TurnEnd::Miss, ctx);
            }
        }
        Ok(())
    }

    fn stop(&mut self, seat: usize, ctx: &mut Ctx) -> Result<(), String> {
        self.check_guesser(seat)?;
        if self.guesses().1 == 0 {
            return Err("至少要翻一張才能結束這輪".into());
        }
        ctx.system(To::All, format!("{} 結束了這輪，換{}隊", self.names[seat], TEAM_NAMES[1 - self.turn]));
        self.end_turn(TurnEnd::Stop, ctx);
        Ok(())
    }

    fn end_turn(&mut self, end: TurnEnd, ctx: &mut Ctx) {
        if let Some(turn) = self.log.last_mut()
            && turn.end.is_none()
        {
            turn.end = Some(end);
        }
        self.turn = 1 - self.turn;
        self.begin_clue(ctx);
    }

    /// 沒有給提示就跳過這輪
    fn skip_turn(&mut self, text: String, ctx: &mut Ctx) {
        self.log.push(Turn {
            team: self.turn,
            by: None,
            word: None,
            count: None,
            reveals: Vec::new(),
            end: Some(TurnEnd::NoClue),
        });
        ctx.system(To::All, text);
        self.turn = 1 - self.turn;
        self.begin_clue(ctx);
    }

    fn finish(&mut self, winner: usize, reason: Reason, ctx: &mut Ctx) {
        if let Some(turn) = self.log.last_mut()
            && turn.end.is_none()
        {
            turn.end = Some(TurnEnd::Over);
        }
        self.winner = Some(winner);
        self.reason = Some(reason);
        for s in self.members(winner) {
            *self.wins.entry(self.pids[s]).or_default() += 1;
        }
        self.marks.iter_mut().for_each(Vec::clear);
        let why = match reason {
            Reason::Cards => "所有暗號都接上頭了",
            Reason::Traitor => "對方翻到了叛徒",
        };
        ctx.announce(To::All, format!("{}隊獲勝！{why}", TEAM_NAMES[winner]), "ok");
        self.set_stage(Stage::End, None, ctx);
    }

    /// 給提示時聯絡人不在：同隊看過密碼表的人在線就換他；不然等一下，請一位在線的組員接手；整隊都不在就跳過
    fn cover_lead(&mut self, ctx: &mut Ctx) {
        let t = self.turn;
        let lead = self.leads[t];
        if lead.is_some_and(|s| self.online[s]) {
            return;
        }
        let gone = lead.map_or("聯絡人", |s| self.names[s].as_str()).to_owned();
        if let Some(s) = self.members(t).into_iter().find(|&s| self.insider[s] && self.online[s]) {
            self.leads[t] = Some(s);
            ctx.system(To::All, format!("{gone} 斷線了，由 {} 給提示", self.names[s]));
            ctx.changed();
            return;
        }
        let since = lead.and_then(|s| self.offline_at[s]).map_or(self.stage_started, |at| at.max(self.stage_started));
        if ctx.now.duration_since(since) < LEAD_WAIT {
            return;
        }
        let online: Vec<usize> = self.members(t).into_iter().filter(|&s| self.online[s]).collect();
        if online.is_empty() {
            self.skip_turn(format!("{}隊都不在，跳過這輪", TEAM_NAMES[t]), ctx);
            return;
        }
        let s = online[ctx.rng.below(online.len())];
        self.become_insider(s);
        self.leads[t] = Some(s);
        ctx.announce(
            To::All,
            format!(
                "{gone} 斷線了，由 {} 接手當{}隊的聯絡人（看過密碼表，這局就不能翻牌了）",
                self.names[s], TEAM_NAMES[t]
            ),
            "accent",
        );
        // 接手的人重新計時
        self.set_stage(Stage::Clue, secs(self.options.clue_secs), ctx);
    }

    /// 輪到的隊伍能翻牌的人都斷線夠久了
    fn guessers_away(&self, now: Instant) -> bool {
        let guessers = self.guessers(self.turn);
        if guessers.iter().any(|&s| self.online[s]) {
            return false;
        }
        let since = guessers
            .iter()
            .filter_map(|&s| self.offline_at[s])
            .max()
            .map_or(self.stage_started, |at| at.max(self.stage_started));
        now.duration_since(since) >= GUESSER_WAIT
    }
}

impl PartyGame for Contact {
    const ID: &'static str = "contact";
    const MIN_PLAYERS: usize = 4;
    const MAX_PLAYERS: usize = 10;
    const MAX_BOTS: usize = 0;

    type Options = Options;
    type Action = Action;

    fn rooms(state: &AppState) -> &Arc<Parties<Self>> {
        &state.contact
    }

    fn check_options(mut options: Options) -> Result<Options, String> {
        if options.clue_secs > 0 {
            options.clue_secs = options.clue_secs.clamp(30, 600);
        }
        if options.guess_secs > 0 {
            options.guess_secs = options.guess_secs.clamp(30, 600);
        }
        Ok(options)
    }

    fn start(options: &Options, previous: Option<&Self>, ctx: &mut Ctx) -> Self {
        let n = ctx.seats.len();
        let mut game = Self {
            options: options.clone(),
            pids: ctx.seats.iter().map(|s| s.pid).collect(),
            names: ctx.seats.iter().map(|s| s.name.clone()).collect(),
            online: ctx.seats.iter().map(|s| s.online).collect(),
            offline_at: ctx.seats.iter().map(|s| (!s.online).then_some(ctx.now)).collect(),
            team: vec![None; n],
            leads: [None, None],
            insider: vec![false; n],
            stage: Stage::Teams,
            deadline: None,
            stage_started: ctx.now,
            board: Vec::new(),
            key: Vec::new(),
            revealed: Vec::new(),
            marks: Vec::new(),
            first: 0,
            turn: 0,
            log: Vec::new(),
            winner: None,
            reason: None,
            game_no: previous.map_or(1, |p| p.game_no + 1),
            used: previous.map(|p| p.used.clone()).unwrap_or_default(),
            wins: previous.map(|p| p.wins.clone()).unwrap_or_default(),
            led: previous.map(|p| p.led.clone()).unwrap_or_default(),
        };
        // 沿用上一局的分隊，新來的人補進人少的那隊，聯絡人照輪替換人
        if let Some(p) = previous {
            for s in 0..n {
                if let Some(i) = p.pids.iter().position(|&pid| pid == game.pids[s]) {
                    game.team[s] = p.team[i];
                }
            }
            if game.team.iter().any(Option::is_some) {
                Self::fill_free(&mut game.team, ctx.rng);
                game.leads = [game.pick_lead(0), game.pick_lead(1)];
            }
        }
        let hint = if previous.is_some() {
            "（沿用上一局的分隊，聯絡人換人了，想換隊可以自己點）"
        } else {
            ""
        };
        ctx.system(
            To::All,
            format!("選隊：點「加入翡翠」或「加入紫晶」，想當聯絡人的按「我當聯絡人」，房主按「開始」發牌{hint}"),
        );
        game.set_stage(Stage::Teams, None, ctx);
        game
    }

    fn act(&mut self, seat: usize, action: Action, ctx: &mut Ctx) -> Result<(), String> {
        match (action, self.stage) {
            (Action::Join { team }, Stage::Teams) => {
                if team > 1 {
                    return Err("沒有這一隊".into());
                }
                if let Some(old) = self.team[seat]
                    && old != team
                    && self.leads[old] == Some(seat)
                {
                    self.leads[old] = None;
                }
                self.team[seat] = Some(team);
                Ok(())
            }
            (Action::Lead, Stage::Teams) => {
                let Some(t) = self.team[seat] else { return Err("先選一隊".into()) };
                self.leads[t] = if self.leads[t] == Some(seat) { None } else { Some(seat) };
                Ok(())
            }
            (Action::Shuffle, Stage::Teams) => {
                self.shuffle_teams(ctx);
                Ok(())
            }
            (Action::Go, Stage::Teams) => self.go(ctx),
            (Action::Clue { word, count }, Stage::Clue) => self.give_clue(seat, &word, count, ctx),
            (Action::Mark { index }, Stage::Guess) => self.mark(seat, index),
            (Action::Reveal { index, seq }, Stage::Guess) => self.reveal(seat, index, seq, ctx),
            (Action::Stop, Stage::Guess) => self.stop(seat, ctx),
            (_, Stage::End) => Err("這局已經結束了".into()),
            (_, Stage::Teams) => Err("還在選隊，等房主按開始".into()),
            (Action::Join { .. } | Action::Lead | Action::Shuffle | Action::Go, _) => {
                Err("已經發牌了，下一局才能換隊".into())
            }
            (Action::Clue { .. }, _) => Err("提示已經給了，等組員猜".into()),
            // 剩下的是給提示時就想標記、翻牌
            _ => Err("等聯絡人給提示".into()),
        }
    }

    fn tick(&mut self, ctx: &mut Ctx) {
        let expired = self.deadline.is_some_and(|d| ctx.now >= d);
        match self.stage {
            Stage::Clue if expired => {
                let (t, other) = (self.turn, 1 - self.turn);
                let text = format!("時間到，{}隊沒有給提示，換{}隊", TEAM_NAMES[t], TEAM_NAMES[other]);
                self.skip_turn(text, ctx);
            }
            Stage::Clue => self.cover_lead(ctx),
            Stage::Guess if expired => {
                ctx.system(To::All, format!("時間到，換{}隊", TEAM_NAMES[1 - self.turn]));
                self.end_turn(TurnEnd::Timeout, ctx);
            }
            Stage::Guess if self.guessers_away(ctx.now) => {
                let (t, other) = (self.turn, 1 - self.turn);
                ctx.system(To::All, format!("{}隊的組員都不在，換{}隊", TEAM_NAMES[t], TEAM_NAMES[other]));
                self.end_turn(TurnEnd::Away, ctx);
            }
            _ => {}
        }
    }

    fn chat(&mut self, seat: Option<usize>, _text: &str, _ctx: &mut Ctx) -> Chat {
        match (self.stage, seat) {
            // 看過密碼表的人之間的話，組員和觀戰的人都看不到（不能偷偷提示）
            (Stage::Clue | Stage::Guess, Some(s)) if self.insider[s] => Chat::Only(To::Seats(self.insiders())),
            _ => Chat::Show,
        }
    }

    fn presence(&mut self, seat: usize, online: bool, ctx: &mut Ctx) {
        self.online[seat] = online;
        self.offline_at[seat] = (!online).then_some(ctx.now);
        ctx.changed();
    }

    fn view(&self, seat: Option<usize>, now: Instant) -> Value {
        let dealt = self.stage != Stage::Teams;
        let over = self.stage == Stage::End;
        let knows = dealt && (over || seat.is_some_and(|s| self.insider[s]));
        let mine = seat.and_then(|s| self.team[s]);
        // 標記只給輪到的那隊看
        let marks = (self.stage == Stage::Guess && mine == Some(self.turn)).then_some(&self.marks);
        let revealed: Vec<Option<Card>> =
            (0..self.key.len()).map(|i| self.revealed[i].then_some(self.key[i])).collect();
        let clue = self.log.last().filter(|_| self.stage == Stage::Guess).map(|t| {
            let (limit, made) = self.guesses();
            json!({ "word": t.word, "count": t.count, "by": t.by, "limit": limit, "made": made })
        });
        let pids = &self.pids;
        json!({
            "stage": self.stage.name(),
            "endsIn": self.deadline.map(|d| d.saturating_duration_since(now).as_millis() as u64),
            "options": self.options,
            "you": seat,
            "teams": self.team,
            "leads": self.leads,
            "insiders": self.insider,
            "online": self.online,
            "led": pids.iter().map(|p| self.led.get(p).map_or(0, |l| l.0)).collect::<Vec<_>>(),
            "wins": pids.iter().map(|p| self.wins.get(p).copied().unwrap_or(0)).collect::<Vec<_>>(),
            "game": self.game_no,
            "first": dealt.then_some(self.first),
            "turn": self.turn,
            "words": dealt.then(|| self.words()),
            "revealed": dealt.then_some(revealed),
            "key": knows.then_some(&self.key),
            "marks": marks,
            "left": [self.left(0), self.left(1)],
            "seq": self.flipped(),
            "clue": clue,
            "log": self.log,
            "winner": self.winner,
            "reason": self.reason,
        })
    }

    fn finished(&self) -> bool {
        self.stage == Stage::End
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;
    use crate::party::{Outbox, SeatInfo};

    fn seats(n: usize) -> Vec<SeatInfo> {
        (0..n).map(|i| SeatInfo { pid: i as u32 + 1, name: format!("P{i}"), bot: false, online: true }).collect()
    }

    fn ctx<'a>(rng: &'a mut Rng, seats: &'a [SeatInfo], out: &'a mut Outbox) -> Ctx<'a> {
        crate::party::test_ctx(Instant::now(), rng, seats, out)
    }

    fn act(g: &mut Contact, seats: &[SeatInfo], rng: &mut Rng, seat: usize, action: Action) -> Result<(), String> {
        let mut out = Outbox::default();
        g.act(seat, action, &mut ctx(rng, seats, &mut out))
    }

    fn tick_at(g: &mut Contact, seats: &[SeatInfo], rng: &mut Rng, now: Instant) {
        let mut out = Outbox::default();
        g.tick(&mut crate::party::test_ctx(now, rng, seats, &mut out));
    }

    /// 選隊階段的一局
    fn lobby(n: usize, options: Options) -> (Contact, Vec<SeatInfo>, Rng) {
        let seats = seats(n);
        let mut rng = Rng::new();
        let g = {
            let mut out = Outbox::default();
            Contact::start(&options, None, &mut ctx(&mut rng, &seats, &mut out))
        };
        (g, seats, rng)
    }

    /// 發好牌的一局：前一半座位是翡翠（聯絡人是座位 0）、後一半是紫晶（聯絡人是第一個），翡翠先手。
    /// 密碼表固定：0～8 翡翠、9～16 紫晶、17～23 路人、24 叛徒
    fn dealt(n: usize, options: Options) -> (Contact, Vec<SeatInfo>, Rng) {
        let (mut g, seats, mut rng) = lobby(n, options);
        let half = n / 2;
        for s in 0..n {
            act(&mut g, &seats, &mut rng, s, Action::Join { team: usize::from(s >= half) }).unwrap();
        }
        act(&mut g, &seats, &mut rng, 0, Action::Lead).unwrap();
        act(&mut g, &seats, &mut rng, half, Action::Lead).unwrap();
        act(&mut g, &seats, &mut rng, 0, Action::Go).unwrap();
        g.first = 0;
        g.turn = 0;
        g.key = [vec![Card::Jade; 9], vec![Card::Amethyst; 8], vec![Card::Bystander; 7], vec![Card::Traitor]].concat();
        // 盤面固定是詞庫最前面、互不重疊的 25 個詞
        g.board.clear();
        for i in 0..WORDS.len() {
            if g.board.len() < SIZE && !g.board.iter().any(|&p| overlaps(WORDS[p], WORDS[i])) {
                g.board.push(i);
            }
        }
        g.used = g.board.clone();
        (g, seats, rng)
    }

    fn clue(
        g: &mut Contact,
        seats: &[SeatInfo],
        rng: &mut Rng,
        seat: usize,
        word: &str,
        count: u8,
    ) -> Result<(), String> {
        act(g, seats, rng, seat, Action::Clue { word: word.into(), count })
    }

    fn reveal(g: &mut Contact, seats: &[SeatInfo], rng: &mut Rng, seat: usize, index: usize) -> Result<(), String> {
        let seq = g.flipped();
        act(g, seats, rng, seat, Action::Reveal { index, seq })
    }

    /// 盤面上沒有、也不會撞到盤面的提示詞
    const SAFE: &str = "暗語九號";

    #[test]
    fn the_word_list_is_big_and_clean() {
        assert!(WORDS.len() >= 400, "只有 {} 個詞", WORDS.len());
        let mut seen = HashSet::new();
        for word in WORDS.iter() {
            assert!(seen.insert(*word), "重複的詞：{word}");
            let len = word.chars().count();
            assert!((2..=4).contains(&len), "「{word}」要 2～4 個字");
            assert_eq!(normalize(word).chars().count(), len, "「{word}」有空白或標點");
            assert!(!TEAM_NAMES.contains(word), "「{word}」是隊名");
        }
        assert!(clash(SAFE, &WORDS).is_none(), "測試用的提示詞撞到詞庫了");
    }

    #[test]
    fn the_key_has_the_right_counts() {
        let mut rng = Rng::new();
        for first in 0..2 {
            let key = deal(&mut rng, first);
            assert_eq!(key.len(), SIZE);
            let count = |c: Card| key.iter().filter(|&&k| k == c).count();
            assert_eq!(count(Card::of(first)), 9);
            assert_eq!(count(Card::of(1 - first)), 8);
            assert_eq!(count(Card::Bystander), 7);
            assert_eq!(count(Card::Traitor), 1);
        }
    }

    #[test]
    fn clues_cannot_overlap_board_words() {
        let board = ["蘋果", "海洋", "臺北", "Apple派", "長頸鹿"];
        assert_eq!(clash("蘋果", &board), Some("蘋果"));
        assert_eq!(clash("青蘋果", &board), Some("蘋果"), "包含盤面上的詞");
        assert_eq!(clash("海", &board), Some("海洋"), "被盤面上的詞包含");
        assert_eq!(clash("台北", &board), Some("臺北"), "臺和台一樣");
        assert_eq!(clash("ＡＰＰＬＥ", &board), Some("Apple派"), "全形、大小寫不算差別");
        assert_eq!(clash("長 頸鹿！", &board), Some("長頸鹿"), "空白標點不算");
        assert_eq!(clash("水果", &board), None);
        assert_eq!(clash("！！", &board), None);
    }

    #[test]
    fn players_pick_teams_and_leads_before_dealing() {
        let (mut g, seats, mut rng) = lobby(5, Options::default());
        assert_eq!(g.stage, Stage::Teams);
        assert_eq!(g.view(Some(0), Instant::now())["words"], Value::Null, "選隊時還沒有盤面");
        assert_eq!(act(&mut g, &seats, &mut rng, 0, Action::Lead), Err("先選一隊".into()));
        assert_eq!(act(&mut g, &seats, &mut rng, 0, Action::Join { team: 2 }), Err("沒有這一隊".into()));
        act(&mut g, &seats, &mut rng, 0, Action::Join { team: 0 }).unwrap();
        act(&mut g, &seats, &mut rng, 0, Action::Lead).unwrap();
        assert_eq!(g.leads, [Some(0), None]);
        // 換隊就不是原來那隊的聯絡人了
        act(&mut g, &seats, &mut rng, 0, Action::Join { team: 1 }).unwrap();
        assert_eq!(g.leads, [None, None]);
        act(&mut g, &seats, &mut rng, 1, Action::Join { team: 1 }).unwrap();
        act(&mut g, &seats, &mut rng, 2, Action::Join { team: 1 }).unwrap();
        act(&mut g, &seats, &mut rng, 3, Action::Join { team: 1 }).unwrap();
        act(&mut g, &seats, &mut rng, 4, Action::Join { team: 1 }).unwrap();
        assert_eq!(
            act(&mut g, &seats, &mut rng, 0, Action::Go),
            Err("每隊至少要 2 人：1 位聯絡人加至少 1 位組員".into())
        );
        assert_eq!(g.stage, Stage::Teams, "失敗時不變");
        act(&mut g, &seats, &mut rng, 1, Action::Join { team: 0 }).unwrap();
        assert!(act(&mut g, &seats, &mut rng, 0, Action::Go).is_err(), "翡翠只有 1 人");
        act(&mut g, &seats, &mut rng, 2, Action::Join { team: 0 }).unwrap();
        act(&mut g, &seats, &mut rng, 1, Action::Lead).unwrap();
        act(&mut g, &seats, &mut rng, 3, Action::Lead).unwrap();
        act(&mut g, &seats, &mut rng, 3, Action::Lead).unwrap();
        assert_eq!(g.leads, [Some(1), None], "再按一次就不當");
        act(&mut g, &seats, &mut rng, 4, Action::Go).unwrap();
        assert_eq!(g.stage, Stage::Clue);
        assert_eq!(g.leads[0], Some(1));
        let lead = g.leads[1].unwrap();
        assert_eq!(g.team[lead], Some(1), "沒有聯絡人的隊自動挑一位");
        assert_eq!(g.insiders(), {
            let mut v = vec![1, lead];
            v.sort();
            v
        });
        assert_eq!(g.board.len(), SIZE);
        assert_eq!(g.turn, g.first);
        assert_eq!(g.left(g.first), 9);
        assert_eq!(g.left(1 - g.first), 8);
        assert_eq!(
            act(&mut g, &seats, &mut rng, 0, Action::Join { team: 0 }),
            Err("已經發牌了，下一局才能換隊".into())
        );
    }

    #[test]
    fn free_players_fill_the_smaller_team_and_shuffle_splits_evenly() {
        let (mut g, seats, mut rng) = lobby(7, Options::default());
        act(&mut g, &seats, &mut rng, 0, Action::Join { team: 0 }).unwrap();
        act(&mut g, &seats, &mut rng, 1, Action::Join { team: 0 }).unwrap();
        act(&mut g, &seats, &mut rng, 2, Action::Join { team: 0 }).unwrap();
        assert_eq!(
            act(&mut g, &seats, &mut rng, 0, Action::Clue { word: SAFE.into(), count: 1 }),
            Err("還在選隊，等房主按開始".into())
        );
        act(&mut g, &seats, &mut rng, 0, Action::Go).unwrap();
        let (a, b) = (g.members(0).len(), g.members(1).len());
        assert_eq!(a + b, 7, "沒選隊的人都補進去了");
        assert!(a >= 3 && a.abs_diff(b) == 1, "{a} 對 {b}");

        for _ in 0..20 {
            let (mut g, seats, mut rng) = lobby(7, Options::default());
            act(&mut g, &seats, &mut rng, 3, Action::Shuffle).unwrap();
            let (a, b) = (g.members(0).len(), g.members(1).len());
            assert_eq!(a + b, 7);
            assert!(a.abs_diff(b) == 1, "{a} 對 {b}");
            for t in 0..2 {
                assert_eq!(g.team[g.leads[t].unwrap()], Some(t));
            }
        }
    }

    #[test]
    fn only_insiders_see_the_key_and_marks_stay_in_the_team() {
        let (mut g, seats, mut rng) = dealt(6, Options::default());
        // 座位 0、3 是聯絡人；1、2 翡翠組員；4、5 紫晶組員
        for viewer in [Some(1), Some(4), None] {
            let view = g.view(viewer, Instant::now());
            assert_eq!(view["key"], Value::Null, "{viewer:?} 不能看到密碼表");
            let text = view.to_string();
            for kind in ["jade", "amethyst", "bystander", "traitor"] {
                assert!(!text.contains(kind), "{viewer:?} 的 view 漏了 {kind}：{text}");
            }
        }
        for lead in [0, 3] {
            assert_eq!(g.view(Some(lead), Instant::now())["key"].as_array().unwrap().len(), SIZE);
        }

        clue(&mut g, &seats, &mut rng, 0, SAFE, 2).unwrap();
        act(&mut g, &seats, &mut rng, 1, Action::Mark { index: 3 }).unwrap();
        act(&mut g, &seats, &mut rng, 2, Action::Mark { index: 3 }).unwrap();
        assert_eq!(g.marks[3], [1, 2]);
        assert_eq!(g.view(Some(0), Instant::now())["marks"][3], json!([1, 2]), "同隊的聯絡人看得到");
        assert_eq!(g.view(Some(4), Instant::now())["marks"], Value::Null, "對方看不到");
        assert_eq!(g.view(None, Instant::now())["marks"], Value::Null, "觀戰的人看不到");
        act(&mut g, &seats, &mut rng, 2, Action::Mark { index: 3 }).unwrap();
        assert_eq!(g.marks[3], [1], "再按一次取消");
        assert_eq!(act(&mut g, &seats, &mut rng, 4, Action::Mark { index: 3 }), Err("還沒輪到你們".into()));
        assert!(act(&mut g, &seats, &mut rng, 0, Action::Mark { index: 3 }).is_err(), "聯絡人不能標記");

        // 翻開的格子大家都看得到
        reveal(&mut g, &seats, &mut rng, 1, 3).unwrap();
        let view = g.view(Some(4), Instant::now());
        assert_eq!(view["revealed"][3], "jade");
        assert_eq!(view["revealed"][4], Value::Null);
        assert_eq!(view["key"], Value::Null);
        assert!(g.marks[3].is_empty());
    }

    #[test]
    fn clue_rules() {
        let (mut g, seats, mut rng) = dealt(4, Options::default());
        // 座位 0、2 是聯絡人，翡翠先
        assert_eq!(clue(&mut g, &seats, &mut rng, 2, SAFE, 1), Err("還沒輪到你們".into()));
        assert_eq!(clue(&mut g, &seats, &mut rng, 1, SAFE, 1), Err("只有聯絡人能給提示".into()));
        assert_eq!(clue(&mut g, &seats, &mut rng, 0, SAFE, 0), Err("數字要在 1～9 之間".into()));
        assert_eq!(clue(&mut g, &seats, &mut rng, 0, SAFE, 10), Err("數字要在 1～9 之間".into()));
        assert_eq!(clue(&mut g, &seats, &mut rng, 0, " ", 1), Err("請輸入提示詞".into()));
        assert_eq!(clue(&mut g, &seats, &mut rng, 0, "暗語 九號", 1), Err("提示只能是一個詞，不要有空白".into()));
        assert_eq!(clue(&mut g, &seats, &mut rng, 0, "！？", 1), Err("提示要有文字或數字".into()));
        let word = g.word(7);
        let longer = format!("大{word}");
        let err = clue(&mut g, &seats, &mut rng, 0, &longer, 1).unwrap_err();
        assert!(err.contains(word), "{err}");
        assert_eq!(g.stage, Stage::Clue);
        clue(&mut g, &seats, &mut rng, 0, SAFE, 2).unwrap();
        assert_eq!(g.stage, Stage::Guess);
        let view = g.view(Some(3), Instant::now());
        assert_eq!(view["clue"], json!({ "word": SAFE, "count": 2, "by": 0, "limit": 3, "made": 0 }));
        assert_eq!(clue(&mut g, &seats, &mut rng, 0, SAFE, 2), Err("提示已經給了，等組員猜".into()));
    }

    #[test]
    fn offline_mode_only_needs_a_number() {
        let (mut g, seats, mut rng) = dealt(4, Options { offline: true, ..Options::default() });
        let word = g.word(0);
        clue(&mut g, &seats, &mut rng, 0, word, 3).unwrap();
        assert_eq!(g.log[0].word, None, "線下模式不存提示詞");
        assert_eq!(g.guesses(), (4, 0));
    }

    #[test]
    fn guessing_follows_the_count_and_switches_on_a_miss() {
        let (mut g, seats, mut rng) = dealt(6, Options::default());
        clue(&mut g, &seats, &mut rng, 0, SAFE, 1).unwrap();
        // 聯絡人不能翻；盤面變了的要擋下來
        assert!(reveal(&mut g, &seats, &mut rng, 0, 0).is_err());
        assert_eq!(
            act(&mut g, &seats, &mut rng, 1, Action::Reveal { index: 0, seq: 3 }),
            Err("盤面剛剛變了，再確認一次要翻哪張".into())
        );
        assert_eq!(act(&mut g, &seats, &mut rng, 1, Action::Stop), Err("至少要翻一張才能結束這輪".into()));
        reveal(&mut g, &seats, &mut rng, 1, 0).unwrap();
        assert_eq!(g.turn, 0, "翻對了可以繼續");
        assert_eq!(reveal(&mut g, &seats, &mut rng, 2, 0), Err("這張已經翻開了".into()));
        // 數字 1：最多翻 2 張，翻滿就換隊
        reveal(&mut g, &seats, &mut rng, 2, 1).unwrap();
        assert_eq!((g.turn, g.stage), (1, Stage::Clue));
        assert_eq!(g.log[0].end, Some(TurnEnd::Limit));
        assert_eq!(g.left(0), 7);

        // 紫晶：翻到路人就換隊
        clue(&mut g, &seats, &mut rng, 3, SAFE, 3).unwrap();
        reveal(&mut g, &seats, &mut rng, 4, 9).unwrap();
        reveal(&mut g, &seats, &mut rng, 5, 17).unwrap();
        assert_eq!(g.turn, 0);
        assert_eq!(g.log[1].end, Some(TurnEnd::Miss));
        assert_eq!(g.log[1].reveals.len(), 2);

        // 翡翠：翻到對方的也換隊；自己按結束
        clue(&mut g, &seats, &mut rng, 0, SAFE, 2).unwrap();
        reveal(&mut g, &seats, &mut rng, 1, 10).unwrap();
        assert_eq!((g.turn, g.left(1)), (1, 6));
        clue(&mut g, &seats, &mut rng, 3, SAFE, 2).unwrap();
        reveal(&mut g, &seats, &mut rng, 4, 11).unwrap();
        act(&mut g, &seats, &mut rng, 5, Action::Stop).unwrap();
        assert_eq!(g.turn, 0);
        assert_eq!(g.log[3].end, Some(TurnEnd::Stop));
    }

    #[test]
    fn the_traitor_loses_immediately() {
        let (mut g, seats, mut rng) = dealt(4, Options::default());
        clue(&mut g, &seats, &mut rng, 0, SAFE, 2).unwrap();
        reveal(&mut g, &seats, &mut rng, 1, 24).unwrap();
        assert!(g.finished());
        assert_eq!((g.winner, g.reason), (Some(1), Some(Reason::Traitor)));
        assert_eq!(g.log[0].end, Some(TurnEnd::Over));
        // 結束後所有人都看得到密碼表
        assert_eq!(g.view(Some(1), Instant::now())["key"].as_array().unwrap().len(), SIZE);
        assert_eq!(g.view(None, Instant::now())["key"].as_array().unwrap().len(), SIZE);
        assert_eq!(g.wins.get(&3), Some(&1), "紫晶的人各贏一局");
        assert_eq!(act(&mut g, &seats, &mut rng, 3, Action::Stop), Err("這局已經結束了".into()));
    }

    #[test]
    fn finding_every_card_wins_even_on_the_other_teams_turn() {
        let (mut g, seats, mut rng) = dealt(4, Options::default());
        clue(&mut g, &seats, &mut rng, 0, SAFE, 9).unwrap();
        for i in 0..8 {
            reveal(&mut g, &seats, &mut rng, 1, i).unwrap();
        }
        assert_eq!(g.left(0), 1);
        reveal(&mut g, &seats, &mut rng, 1, 8).unwrap();
        assert_eq!((g.winner, g.reason), (Some(0), Some(Reason::Cards)));

        // 紫晶只剩一張時，翡翠翻到它：紫晶贏
        let (mut g, seats, mut rng) = dealt(4, Options::default());
        for i in 9..16 {
            g.revealed[i] = true;
        }
        clue(&mut g, &seats, &mut rng, 0, SAFE, 2).unwrap();
        reveal(&mut g, &seats, &mut rng, 1, 16).unwrap();
        assert_eq!((g.winner, g.reason), (Some(1), Some(Reason::Cards)));
    }

    #[test]
    fn timeouts_skip_or_switch_turns() {
        let (mut g, seats, mut rng) = dealt(4, Options::default());
        let now = Instant::now();
        tick_at(&mut g, &seats, &mut rng, now + Duration::from_secs(121));
        assert_eq!((g.turn, g.stage), (1, Stage::Clue), "沒給提示就跳過");
        assert_eq!(g.log[0].end, Some(TurnEnd::NoClue));
        clue(&mut g, &seats, &mut rng, 2, SAFE, 1).unwrap();
        tick_at(&mut g, &seats, &mut rng, Instant::now() + Duration::from_secs(121));
        assert_eq!((g.turn, g.stage), (0, Stage::Clue), "猜的時間到就換隊");
        assert_eq!(g.log[1].end, Some(TurnEnd::Timeout));

        // 不限時間：不會自己跳過
        let (mut g, seats, mut rng) = dealt(4, Options { clue_secs: 0, guess_secs: 0, offline: false });
        tick_at(&mut g, &seats, &mut rng, Instant::now() + Duration::from_secs(3600));
        assert_eq!((g.turn, g.stage), (0, Stage::Clue));
    }

    #[test]
    fn a_teammate_takes_over_when_the_lead_drops() {
        let (mut g, seats, mut rng) = dealt(6, Options::default());
        let start = Instant::now();
        {
            let mut out = Outbox::default();
            g.presence(0, false, &mut crate::party::test_ctx(start, &mut rng, &seats, &mut out));
        }
        tick_at(&mut g, &seats, &mut rng, start + Duration::from_secs(5));
        assert_eq!(g.leads[0], Some(0), "還在等");
        tick_at(&mut g, &seats, &mut rng, start + LEAD_WAIT + Duration::from_secs(1));
        let lead = g.leads[0].unwrap();
        assert!(lead == 1 || lead == 2, "由在線的組員接手：{lead}");
        assert!(g.insider[lead]);
        assert_eq!(g.view(Some(lead), Instant::now())["key"].as_array().unwrap().len(), SIZE);
        assert_eq!(g.guessers(0), [3 - lead], "接手的人不能再翻牌");
        assert_eq!(g.led.get(&g.pids[lead]).map(|l| l.0), Some(1));

        // 原來的聯絡人回來了：還是看得到密碼表、不能翻牌，也可以給提示
        {
            let mut out = Outbox::default();
            g.presence(0, true, &mut crate::party::test_ctx(start, &mut rng, &seats, &mut out));
        }
        assert!(g.check_guesser(0).is_err());
        clue(&mut g, &seats, &mut rng, 0, SAFE, 1).unwrap();
        assert_eq!(g.leads[0], Some(0));
    }

    #[test]
    fn another_insider_covers_at_once_and_an_empty_team_is_skipped() {
        let (mut g, seats, mut rng) = dealt(6, Options::default());
        g.insider[1] = true;
        let now = Instant::now();
        {
            let mut out = Outbox::default();
            g.presence(0, false, &mut crate::party::test_ctx(now, &mut rng, &seats, &mut out));
        }
        tick_at(&mut g, &seats, &mut rng, now);
        assert_eq!(g.leads[0], Some(1), "看過密碼表的人直接接手");

        // 整隊都斷線：等一下就跳過
        for s in 0..3 {
            let mut out = Outbox::default();
            g.presence(s, false, &mut crate::party::test_ctx(now, &mut rng, &seats, &mut out));
        }
        tick_at(&mut g, &seats, &mut rng, now + LEAD_WAIT + Duration::from_secs(1));
        assert_eq!((g.turn, g.stage), (1, Stage::Clue));
        assert_eq!(g.log[0].end, Some(TurnEnd::NoClue));
    }

    #[test]
    fn guessing_moves_on_when_every_guesser_is_gone() {
        let (mut g, seats, mut rng) = dealt(4, Options { guess_secs: 0, ..Options::default() });
        clue(&mut g, &seats, &mut rng, 0, SAFE, 1).unwrap();
        let now = Instant::now();
        {
            let mut out = Outbox::default();
            g.presence(1, false, &mut crate::party::test_ctx(now, &mut rng, &seats, &mut out));
        }
        tick_at(&mut g, &seats, &mut rng, now + Duration::from_secs(5));
        assert_eq!(g.stage, Stage::Guess);
        tick_at(&mut g, &seats, &mut rng, now + GUESSER_WAIT + Duration::from_secs(1));
        assert_eq!((g.turn, g.stage), (1, Stage::Clue));
        assert_eq!(g.log[0].end, Some(TurnEnd::Away));
    }

    #[test]
    fn insiders_chat_only_with_insiders_during_play() {
        let (mut g, seats, mut rng) = dealt(6, Options::default());
        let mut out = Outbox::default();
        let mut c = ctx(&mut rng, &seats, &mut out);
        assert!(matches!(g.chat(Some(0), "第三排", &mut c), Chat::Only(To::Seats(ref s)) if s == &[0, 3]));
        assert!(matches!(g.chat(Some(1), "我覺得是海", &mut c), Chat::Show));
        assert!(matches!(g.chat(None, "加油", &mut c), Chat::Show));
        g.stage = Stage::Teams;
        assert!(matches!(g.chat(Some(0), "我當聯絡人", &mut c), Chat::Show));
        g.stage = Stage::End;
        assert!(matches!(g.chat(Some(3), "好險", &mut c), Chat::Show));
    }

    #[test]
    fn next_game_keeps_teams_rotates_leads_and_avoids_used_words() {
        let (mut g, seats, mut rng) = dealt(6, Options::default());
        clue(&mut g, &seats, &mut rng, 0, SAFE, 1).unwrap();
        reveal(&mut g, &seats, &mut rng, 1, 24).unwrap();
        assert!(g.finished());
        let first_board: HashSet<usize> = g.board.iter().copied().collect();

        let mut out = Outbox::default();
        let mut next = Contact::start(&Options::default(), Some(&g), &mut ctx(&mut rng, &seats, &mut out));
        assert_eq!(next.stage, Stage::Teams);
        assert_eq!(next.team, g.team, "沿用上一局的分隊");
        assert_eq!(next.game_no, 2);
        for t in 0..2 {
            let lead = next.leads[t].unwrap();
            assert_eq!(next.team[lead], Some(t));
            assert_ne!(Some(lead), g.leads[t], "聯絡人換人");
        }
        act(&mut next, &seats, &mut rng, 0, Action::Go).unwrap();
        assert!(next.board.iter().all(|i| !first_board.contains(i)), "不出現上一局的詞");
        assert_eq!(next.view(Some(3), Instant::now())["wins"], json!([0, 0, 0, 1, 1, 1]));
    }

    #[test]
    fn a_board_never_has_overlapping_words() {
        let mut rng = Rng::new();
        let (mut g, _, _) = lobby(4, Options::default());
        for _ in 0..30 {
            let board = g.pick_words(&mut rng);
            assert_eq!(board.len(), SIZE);
            assert_eq!(board.iter().collect::<HashSet<_>>().len(), SIZE);
            for (k, &a) in board.iter().enumerate() {
                for &b in &board[k + 1..] {
                    assert!(!overlaps(WORDS[a], WORDS[b]), "{} 和 {}", WORDS[a], WORDS[b]);
                }
            }
        }
    }

    #[test]
    fn options_are_clamped() {
        let o = Contact::check_options(Options { clue_secs: 5, guess_secs: 0, offline: true }).unwrap();
        assert_eq!((o.clue_secs, o.guess_secs), (30, 0));
        let o = Contact::check_options(Options { clue_secs: 9999, guess_secs: 9999, offline: false }).unwrap();
        assert_eq!((o.clue_secs, o.guess_secs), (600, 600));
    }

    #[test]
    fn a_whole_game_always_finishes() {
        // 每輪隨便翻：一定會在有限步內分出勝負，不會卡住
        for _ in 0..20 {
            let (mut g, seats, mut rng) = lobby(5, Options::default());
            act(&mut g, &seats, &mut rng, 0, Action::Shuffle).unwrap();
            act(&mut g, &seats, &mut rng, 0, Action::Go).unwrap();
            for _ in 0..200 {
                if g.finished() {
                    break;
                }
                let t = g.turn;
                match g.stage {
                    Stage::Clue => {
                        let lead = g.leads[t].unwrap();
                        clue(&mut g, &seats, &mut rng, lead, SAFE, 2).unwrap();
                    }
                    Stage::Guess => {
                        let guesser = g.guessers(t)[0];
                        let open: Vec<usize> = (0..SIZE).filter(|&i| !g.revealed[i]).collect();
                        let index = open[rng.below(open.len())];
                        reveal(&mut g, &seats, &mut rng, guesser, index).unwrap();
                    }
                    _ => unreachable!(),
                }
            }
            assert!(g.finished(), "卡在 {:?}", g.stage);
            assert!(g.winner.is_some());
        }
    }
}
