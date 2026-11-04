//! 你畫我猜（派對房間，房間本身見 `party.rs`）。
//!
//! 每一圈每個人輪流畫一次（圈數是房主的選項）。流程：
//! 1. 選題：輪到的人從三個詞（簡單、普通、困難各一）挑一個，15 秒內沒挑就隨機。
//! 2. 作畫：在時限內畫出來，其他人在聊天室猜。不會自動揭露字，畫的人覺得大家猜不出來時可以按「給提示」揭露一個
//!    （兩個字的詞最多一個、三個字以上最多兩個，至少留一個字）。所有（連著線的）人都猜中或時間到就結束。
//! 3. 公布答案和這一棒的得分，幾秒後換下一個人。畫的人斷線就跳過他。
//!
//! 隱藏資訊：
//! - 答案只在畫的人和已經猜中的人的 view 裡；還沒猜中的人和觀戰的人只拿到提示（字數、揭露的字、可選的分類）。
//! - 猜題走聊天（`chat` hook）：猜中的那句只有自己看得到，其他人看到「某某猜對了！」；
//!   很接近只私下提示「差一點」（聊天室一則訊息，另外送一個 `close` 即時事件，畫面上會跳出提示）；
//!   包含答案但多打了其他字的整句不送出（不然答案就公開了）。
//!   已經猜中的人和畫的人之間的對話，還沒猜中的人看不到；畫的人不能在聊天室打出答案。
//!
//! 筆畫：
//! - 畫布座標固定是 0～`W`、0～`H`（4:3）的整數，不同大小的螢幕才畫得一樣。
//! - 畫的人按下時送 `begin`（開新的一筆），之後每 50ms 左右把累積的點用 `more` 接在最後一筆後面；
//!   `fill` 是倒顏料：從一個點把相連的同色區域塗滿（範圍由各用戶端自己算，見 frontend/src/games/draw/paper.ts），也算一筆。
//!   另外有 `undo`（拿掉最後一筆）和 `clear`。伺服器驗證後存進這一棒的畫布，用即時事件轉給其他人（`quiet`，不重送 view）。
//! - 每個動作讓畫布的版本 `v` 加一，事件和 view 都帶著畫布 id 和版本：view 是「到這個版本為止的整張畫布」，
//!   事件是「下一個版本」，用戶端靠版本把兩者接起來（見 frontend/src/games/draw/board.ts）。
//!   重連、中途進來觀戰的人從 view 拿回整張畫布。
//! - 筆畫數、點數、倒顏料的次數有上限，避免被灌爆；畫布只在這一棒有效，換人就清空。
//!
//! 計分：猜中的人越早分數越高（20～100 分），畫的人每有一個人猜中得 25 分，普通的詞乘 1.2、困難的乘 1.5。
//! 分數在同一個房間跨局累計。

use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, LazyLock},
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::time::Instant;

use crate::{
    AppState,
    party::{Chat, Ctx, Parties, PartyGame, To, shuffle},
};

/// 畫布的座標範圍：x 是 0～W、y 是 0～H
pub const W: u16 = 1000;
pub const H: u16 = 750;
/// 顏色和粗細都是編號（前端的調色盤），伺服器只檢查範圍
pub const COLORS: u8 = 12;
pub const WIDTHS: u8 = 3;
/// 一棒最多幾筆、總共幾個點、倒幾次顏料（每次倒顏料用戶端都要算一次，重連時要從頭算）
pub const MAX_STROKES: usize = 1000;
pub const MAX_POINTS: usize = 30_000;
pub const MAX_FILLS: usize = 60;
/// 一則 `begin`／`more` 最多幾個點
pub const MAX_BATCH: usize = 200;
const CHOOSE: Duration = Duration::from_secs(15);
const REVEAL: Duration = Duration::from_secs(6);
/// 畫的人斷線這麼久就跳過這一棒（手機切到背景一下下不算）
const OFFLINE_SKIP: Duration = Duration::from_secs(8);
/// 畫的人每有一個人猜中得幾分（再乘難度加成）
const DRAWER_POINTS: f64 = 25.0;

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Easy,
    Medium,
    Hard,
}

impl Level {
    fn bonus(self) -> f64 {
        match self {
            Level::Easy => 1.0,
            Level::Medium => 1.2,
            Level::Hard => 1.5,
        }
    }
}

pub struct Entry {
    pub word: &'static str,
    pub category: &'static str,
    pub level: Level,
}

/// 詞庫，格式見 draw_words.txt
pub static WORDS: LazyLock<Vec<Entry>> = LazyLock::new(|| {
    include_str!("draw_words.txt")
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .flat_map(|line| {
            let mut parts = line.splitn(3, '|');
            let level = match parts.next().expect("難度") {
                "1" => Level::Easy,
                "2" => Level::Medium,
                "3" => Level::Hard,
                other => panic!("難度只能是 1～3：{other}"),
            };
            let category = parts.next().expect("分類").trim();
            parts.next().expect("詞").split('、').map(str::trim).filter(|w| !w.is_empty()).map(move |word| Entry {
                word,
                category,
                level,
            })
        })
        .collect()
});

/// 比對用：全形轉半形、只留文字和數字（空白標點不算）、英文轉小寫
pub fn normalize(text: &str) -> Vec<char> {
    text.chars()
        .map(|c| match c {
            '\u{FF01}'..='\u{FF5E}' => char::from_u32(c as u32 - 0xFEE0).unwrap_or(c),
            _ => c,
        })
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn contains(haystack: &[char], needle: &[char]) -> bool {
    !needle.is_empty() && haystack.windows(needle.len()).any(|w| w == needle)
}

/// 兩個字串是不是只差一個字（多一個、少一個或換一個）
fn one_edit(a: &[char], b: &[char]) -> bool {
    let (short, long) = if a.len() <= b.len() { (a, b) } else { (b, a) };
    match long.len() - short.len() {
        0 => short.iter().zip(long).filter(|(x, y)| x != y).count() == 1,
        1 => {
            let skip = short.iter().zip(long).position(|(x, y)| x != y).unwrap_or(short.len());
            short[skip..] == long[skip + 1..]
        }
        _ => false,
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Judge {
    Correct,
    /// 整句裡有答案，但多打了其他字：不能公開
    Contains,
    /// 只差一個字，或打中了答案的一大半
    Close,
    Miss,
}

pub fn judge(guess: &str, answer: &str) -> Judge {
    let (g, a) = (normalize(guess), normalize(answer));
    if g.is_empty() || a.is_empty() {
        Judge::Miss
    } else if g == a {
        Judge::Correct
    } else if contains(&g, &a) {
        Judge::Contains
    } else if (a.len() >= 2 && one_edit(&g, &a)) || (g.len() * 2 >= a.len() && contains(&a, &g)) {
        Judge::Close
    } else {
        Judge::Miss
    }
}

fn says(text: &str, word: &str) -> bool {
    contains(&normalize(text), &normalize(word))
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Options {
    /// 每個人畫幾次
    pub cycles: u8,
    /// 每一棒的作畫秒數
    pub draw_secs: u16,
    /// 提示裡顯示詞的分類
    pub category: bool,
}

impl Default for Options {
    fn default() -> Self {
        Self { cycles: 2, draw_secs: 80, category: true }
    }
}

#[derive(Deserialize, Debug)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Action {
    /// 選第幾個詞
    Choose {
        index: usize,
    },
    /// 開新的一筆：顏色、粗細的編號和第一批點（x, y, x, y…）
    Begin {
        c: u8,
        w: u8,
        p: Vec<u16>,
    },
    /// 接在最後一筆後面的點
    More {
        p: Vec<u16>,
    },
    /// 倒顏料：顏色的編號和一個點（x, y）
    Fill {
        c: u8,
        p: Vec<u16>,
    },
    Undo,
    Clear,
    /// 畫的人揭露一個字
    Hint,
}

#[derive(Serialize, Clone, Debug)]
struct Stroke {
    c: u8,
    w: u8,
    p: Vec<u16>,
    /// 倒顏料（`p` 只有一個點）
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    f: bool,
}

#[derive(Default)]
struct Canvas {
    id: u32,
    v: u32,
    strokes: Vec<Stroke>,
    points: usize,
    fills: usize,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Stage {
    Choose,
    Draw,
    Reveal,
    End,
}

impl Stage {
    fn name(self) -> &'static str {
        match self {
            Stage::Choose => "choose",
            Stage::Draw => "draw",
            Stage::Reveal => "reveal",
            Stage::End => "end",
        }
    }
}

/// 這一棒為什麼結束
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Ending {
    AllGuessed,
    Timeout,
    DrawerLeft,
}

/// 畫完的一棒，公開給所有人（答案已經公布了）
#[derive(Serialize, Clone, Debug)]
struct Done {
    drawer: usize,
    word: &'static str,
    /// 猜中幾個人
    guessed: usize,
}

pub struct Draw {
    options: Options,
    pids: Vec<u32>,
    names: Vec<String>,
    online: Vec<bool>,
    offline_since: Vec<Option<Instant>>,
    /// 畫畫的順序（座位），每一圈都一樣
    order: Vec<usize>,
    /// 第幾棒（從 0 起算），總共 `order.len() * cycles` 棒
    turn: usize,
    drawer: usize,
    stage: Stage,
    deadline: Option<Instant>,
    stage_started: Instant,
    /// 這一棒給畫的人選的詞（`WORDS` 的索引）
    choices: Vec<usize>,
    word: Option<usize>,
    /// 揭露了第幾個字
    revealed: Vec<usize>,
    /// 這一棒每個人猜中的得分（None 是還沒猜中；畫的人永遠是 None）
    guessed: Vec<Option<u32>>,
    /// 這一棒每個人得的分（含畫的人），公布答案時顯示
    turn_points: Vec<u32>,
    ending: Option<Ending>,
    /// 這一局的分數
    scores: Vec<u32>,
    /// 之前幾局累計的分數（pid → 分）
    carried: HashMap<u32, u32>,
    canvas: Canvas,
    done: Vec<Done>,
    /// 這個房間出過的詞，盡量不重複
    used: HashSet<usize>,
}

impl Draw {
    fn total_turns(&self) -> usize {
        self.order.len() * usize::from(self.options.cycles)
    }

    fn answer(&self) -> Option<&'static str> {
        self.word.map(|i| WORDS[i].word)
    }

    /// 看得到答案的人：畫的人和已經猜中的人
    fn insiders(&self) -> Vec<usize> {
        (0..self.names.len()).filter(|&s| s == self.drawer || self.guessed[s].is_some()).collect()
    }

    fn set_stage(&mut self, stage: Stage, length: Option<Duration>, ctx: &mut Ctx) {
        self.stage = stage;
        self.stage_started = ctx.now;
        self.deadline = length.map(|d| ctx.now + d);
        ctx.changed();
    }

    /// 換下一個人畫；斷線的人跳過，全部畫完就結束
    fn begin_turn(&mut self, ctx: &mut Ctx) {
        let n = self.order.len();
        loop {
            if self.turn >= self.total_turns() {
                self.finish(ctx);
                return;
            }
            let drawer = self.order[self.turn % n];
            if self.online[drawer] {
                self.drawer = drawer;
                break;
            }
            ctx.system(To::All, format!("{} 離線，跳過這一棒", self.names[drawer]));
            self.turn += 1;
        }
        self.word = None;
        self.revealed.clear();
        self.guessed = vec![None; n];
        self.turn_points = vec![0; n];
        self.ending = None;
        let previous = self.canvas.id;
        let mut id = previous;
        while id == previous {
            id = ctx.rng.below(1 << 30) as u32 + 1;
        }
        self.canvas = Canvas { id, ..Canvas::default() };
        self.choices = self.pick_choices(ctx);
        ctx.system(To::All, format!("第 {} 棒：輪到 {} 畫", self.turn + 1, self.names[self.drawer]));
        self.set_stage(Stage::Choose, Some(CHOOSE), ctx);
    }

    /// 簡單、普通、困難各挑一個這個房間還沒出過的詞（某個難度用完了就從其他的補）
    fn pick_choices(&mut self, ctx: &mut Ctx) -> Vec<usize> {
        if self.used.len() + 3 > WORDS.len() {
            self.used.clear();
        }
        let mut picked = Vec::new();
        for level in [Level::Easy, Level::Medium, Level::Hard] {
            let pool: Vec<usize> =
                (0..WORDS.len()).filter(|i| WORDS[*i].level == level && !self.used.contains(i)).collect();
            if !pool.is_empty() {
                picked.push(pool[ctx.rng.below(pool.len())]);
            }
        }
        while picked.len() < 3 {
            let pool: Vec<usize> = (0..WORDS.len()).filter(|i| !self.used.contains(i) && !picked.contains(i)).collect();
            picked.push(pool[ctx.rng.below(pool.len())]);
        }
        picked
    }

    fn choose(&mut self, index: usize, ctx: &mut Ctx) {
        let word = self.choices[index];
        self.word = Some(word);
        self.used.insert(word);
        let length = Duration::from_secs(u64::from(self.options.draw_secs));
        ctx.system(To::All, format!("{} 選好題目了，開始畫！", self.names[self.drawer]));
        self.set_stage(Stage::Draw, Some(length), ctx);
    }

    /// 還能給幾次提示：兩個字的詞一次、三個字以上兩次（至少留一個字不揭露）
    fn hints_left(&self) -> usize {
        let chars = self.answer().map_or(0, |w| w.chars().count());
        chars.saturating_sub(1).min(2).saturating_sub(self.revealed.len())
    }

    /// 畫的人給提示：還沒揭露的字隨機挑一個
    fn hint(&mut self, ctx: &mut Ctx) -> Result<(), String> {
        let Some(word) = self.answer().filter(|_| self.hints_left() > 0) else {
            return Err("不能再給提示了".into());
        };
        let hidden: Vec<usize> = (0..word.chars().count()).filter(|i| !self.revealed.contains(i)).collect();
        self.revealed.push(hidden[ctx.rng.below(hidden.len())]);
        ctx.system(To::All, format!("{} 給了一個提示", self.names[self.drawer]));
        ctx.changed();
        Ok(())
    }

    fn correct(&mut self, seat: usize, ctx: &mut Ctx) {
        let level = self.word.map_or(Level::Easy, |i| WORDS[i].level);
        let total = f64::from(self.options.draw_secs.max(1));
        let left = self.deadline.map_or(0.0, |d| d.saturating_duration_since(ctx.now).as_secs_f64());
        let points = ((20.0 + 80.0 * (left / total).clamp(0.0, 1.0)) * level.bonus()).round() as u32;
        self.guessed[seat] = Some(points);
        self.turn_points[seat] = points;
        self.scores[seat] += points;
        ctx.announce(To::All, format!("{} 猜對了！", self.names[seat]), "ok");
        ctx.changed();
        if self.everyone_guessed() {
            self.end_turn(Ending::AllGuessed, ctx);
        }
    }

    /// 連著線、還沒猜中的人都猜中了（至少要有一個人猜中，大家都斷線時不算）
    fn everyone_guessed(&self) -> bool {
        let others = (0..self.names.len()).filter(|&s| s != self.drawer);
        let mut any = false;
        for s in others {
            match self.guessed[s] {
                Some(_) => any = true,
                None if self.online[s] => return false,
                None => {}
            }
        }
        any
    }

    fn end_turn(&mut self, ending: Ending, ctx: &mut Ctx) {
        let Some(word) = self.word else {
            // 還沒選題就斷線：直接換人，沒有答案可以公布
            ctx.system(To::All, format!("{} 離線，跳過這一棒", self.names[self.drawer]));
            self.turn += 1;
            self.begin_turn(ctx);
            return;
        };
        let entry = &WORDS[word];
        let guessed = self.guessed.iter().filter(|g| g.is_some()).count();
        let points = (DRAWER_POINTS * guessed as f64 * entry.level.bonus()).round() as u32;
        self.turn_points[self.drawer] = points;
        self.scores[self.drawer] += points;
        self.done.push(Done { drawer: self.drawer, word: entry.word, guessed });
        self.ending = Some(ending);
        let why = match ending {
            Ending::AllGuessed => "大家都猜中了！".to_owned(),
            Ending::Timeout => "時間到！".to_owned(),
            Ending::DrawerLeft => format!("{} 離線了。", self.names[self.drawer]),
        };
        ctx.announce(To::All, format!("{why}答案是「{}」", entry.word), "accent");
        self.set_stage(Stage::Reveal, Some(REVEAL), ctx);
    }

    fn finish(&mut self, ctx: &mut Ctx) {
        let best = self.scores.iter().copied().max().unwrap_or(0);
        let winners: Vec<&str> =
            (0..self.scores.len()).filter(|&s| self.scores[s] == best).map(|s| self.names[s].as_str()).collect();
        if best > 0 {
            ctx.announce(To::All, format!("這局結束！最高分是 {}（{best} 分）", winners.join("、")), "ok");
        } else {
            ctx.announce(To::All, "這局結束！", "ok");
        }
        self.word = None;
        self.set_stage(Stage::End, None, ctx);
    }

    fn total(&self, seat: usize) -> u32 {
        self.carried.get(&self.pids[seat]).copied().unwrap_or(0) + self.scores[seat]
    }

    /// 畫布的動作；成功時回傳要轉給其他人的事件內容
    fn paint(&mut self, action: Action) -> Result<Value, String> {
        fn check(p: &[u16]) -> Result<(), String> {
            if p.len() < 2 || !p.len().is_multiple_of(2) || p.len() > MAX_BATCH * 2 {
                return Err("筆畫的格式不對".into());
            }
            if p.chunks(2).any(|xy| xy[0] > W || xy[1] > H) {
                return Err("筆畫超出畫布了".into());
            }
            Ok(())
        }
        const FULL: &str = "這張畫的筆畫太多了，清除一些再畫";
        let canvas = &mut self.canvas;
        let op = match action {
            Action::Begin { c, w, p } => {
                if c >= COLORS || w >= WIDTHS {
                    return Err("沒有這個顏色或粗細".into());
                }
                check(&p)?;
                if canvas.strokes.len() >= MAX_STROKES || canvas.points + p.len() / 2 > MAX_POINTS {
                    return Err(FULL.into());
                }
                canvas.points += p.len() / 2;
                let op = json!({ "kind": "begin", "c": c, "w": w, "p": p });
                canvas.strokes.push(Stroke { c, w, p, f: false });
                op
            }
            Action::More { p } => {
                check(&p)?;
                if canvas.points + p.len() / 2 > MAX_POINTS {
                    return Err(FULL.into());
                }
                let Some(last) = canvas.strokes.last_mut().filter(|s| !s.f) else {
                    return Err("還沒開始畫".into());
                };
                canvas.points += p.len() / 2;
                last.p.extend_from_slice(&p);
                json!({ "kind": "more", "p": p })
            }
            Action::Fill { c, p } => {
                if c >= COLORS {
                    return Err("沒有這個顏色".into());
                }
                check(&p)?;
                if p.len() != 2 {
                    return Err("筆畫的格式不對".into());
                }
                if canvas.strokes.len() >= MAX_STROKES || canvas.points + 1 > MAX_POINTS {
                    return Err(FULL.into());
                }
                if canvas.fills >= MAX_FILLS {
                    return Err("這張畫倒太多次顏料了，清除或復原一些再倒".into());
                }
                canvas.points += 1;
                canvas.fills += 1;
                let op = json!({ "kind": "fill", "c": c, "p": p });
                canvas.strokes.push(Stroke { c, w: 0, p, f: true });
                op
            }
            Action::Undo => {
                if let Some(stroke) = canvas.strokes.pop() {
                    canvas.points -= stroke.p.len() / 2;
                    canvas.fills -= usize::from(stroke.f);
                }
                json!({ "kind": "undo" })
            }
            Action::Clear => {
                canvas.strokes.clear();
                canvas.points = 0;
                canvas.fills = 0;
                json!({ "kind": "clear" })
            }
            Action::Choose { .. } | Action::Hint => unreachable!("not a paint action"),
        };
        canvas.v += 1;
        Ok(json!({ "type": "op", "id": canvas.id, "v": canvas.v, "op": op }))
    }
}

impl PartyGame for Draw {
    const ID: &'static str = "draw";
    const MIN_PLAYERS: usize = 2;
    const MAX_PLAYERS: usize = 10;
    // 畫畫時每 50ms 送一批點，加上聊天，留點餘裕
    const MSGS_PER_SEC: u32 = 50;
    const MAX_FRAME_BYTES: usize = 8 * 1024;

    type Options = Options;
    type Action = Action;

    fn rooms(state: &AppState) -> &Arc<Parties<Self>> {
        &state.draw
    }

    fn check_options(mut options: Options) -> Result<Options, String> {
        options.cycles = options.cycles.clamp(1, 3);
        options.draw_secs = options.draw_secs.clamp(30, 180);
        Ok(options)
    }

    fn start(options: &Options, previous: Option<&Self>, ctx: &mut Ctx) -> Self {
        let n = ctx.seats.len();
        let mut order: Vec<usize> = (0..n).collect();
        shuffle(ctx.rng, &mut order);
        // 上一局有座位的人換成新的累計（後面的蓋過前面的），沒來這局的人的分數也留著
        let carried = previous
            .map(|p| p.carried.clone().into_iter().chain((0..p.pids.len()).map(|s| (p.pids[s], p.total(s)))).collect())
            .unwrap_or_default();
        let mut game = Self {
            options: options.clone(),
            pids: ctx.seats.iter().map(|s| s.pid).collect(),
            names: ctx.seats.iter().map(|s| s.name.clone()).collect(),
            online: ctx.seats.iter().map(|s| s.online).collect(),
            offline_since: vec![None; n],
            order,
            turn: 0,
            drawer: 0,
            stage: Stage::Choose,
            deadline: None,
            stage_started: ctx.now,
            choices: Vec::new(),
            word: None,
            revealed: Vec::new(),
            guessed: vec![None; n],
            turn_points: vec![0; n],
            ending: None,
            scores: vec![0; n],
            carried,
            canvas: Canvas::default(),
            done: Vec::new(),
            used: previous.map(|p| p.used.clone()).unwrap_or_default(),
        };
        ctx.system(To::All, format!("新的一局：{n} 個人，每人畫 {} 次", options.cycles));
        game.begin_turn(ctx);
        game
    }

    fn act(&mut self, seat: usize, action: Action, ctx: &mut Ctx) -> Result<(), String> {
        match (action, self.stage) {
            (Action::Choose { index }, Stage::Choose) if seat == self.drawer => {
                if index >= self.choices.len() {
                    return Err("沒有這個選項".into());
                }
                self.choose(index, ctx);
                Ok(())
            }
            (Action::Choose { .. }, _) => Err("現在不是你選題".into()),
            (Action::Hint, Stage::Draw) if seat == self.drawer => self.hint(ctx),
            (Action::Hint, _) => Err("只有畫的人在作畫時能給提示".into()),
            (paint, Stage::Draw) if seat == self.drawer => {
                ctx.quiet();
                let event = self.paint(paint)?;
                ctx.emit(To::Except(self.drawer), event);
                Ok(())
            }
            // 這一棒剛結束時晚到的筆畫（或不是畫的人送的）直接丟掉，不用提示
            _ => {
                ctx.quiet();
                Ok(())
            }
        }
    }

    fn tick(&mut self, ctx: &mut Ctx) {
        let drawer_gone =
            !self.online[self.drawer] && self.offline_since[self.drawer].is_some_and(|t| ctx.now >= t + OFFLINE_SKIP);
        let due = self.deadline.is_some_and(|d| ctx.now >= d);
        match self.stage {
            Stage::Choose if drawer_gone => self.end_turn(Ending::DrawerLeft, ctx),
            Stage::Choose if due => {
                let index = ctx.rng.below(self.choices.len());
                self.choose(index, ctx);
            }
            Stage::Draw => {
                if drawer_gone {
                    self.end_turn(Ending::DrawerLeft, ctx);
                } else if due {
                    self.end_turn(Ending::Timeout, ctx);
                } else if self.everyone_guessed() {
                    // 還沒猜中的人斷線了，剩下的都猜中了
                    self.end_turn(Ending::AllGuessed, ctx);
                }
            }
            Stage::Reveal if due => {
                self.turn += 1;
                self.begin_turn(ctx);
            }
            _ => {}
        }
    }

    fn chat(&mut self, seat: Option<usize>, text: &str, ctx: &mut Ctx) -> Chat {
        match self.stage {
            Stage::Reveal | Stage::End => Chat::Show,
            Stage::Choose => {
                // 畫的人看得到三個候選詞，不能先講出來
                if seat == Some(self.drawer) && self.choices.iter().any(|&i| says(text, WORDS[i].word)) {
                    ctx.system(To::Seat(self.drawer), "不能說出題目，這句沒有送出");
                    Chat::Drop
                } else {
                    Chat::Show
                }
            }
            Stage::Draw => {
                let Some(answer) = self.answer() else { return Chat::Show };
                match seat {
                    // 觀戰的人看不到答案，但碰巧猜中也不能公開
                    None if says(text, answer) => {
                        ctx.system(To::SeatsAndSpectators(Vec::new()), "觀戰時說出答案不會送出");
                        Chat::Drop
                    }
                    None => Chat::Show,
                    Some(s) if s == self.drawer && says(text, answer) => {
                        ctx.system(To::Seat(s), "不能說出答案，這句沒有送出");
                        Chat::Drop
                    }
                    // 畫的人和猜中的人之間的對話，還沒猜中的人看不到
                    Some(s) if s == self.drawer || self.guessed[s].is_some() => Chat::Only(To::Seats(self.insiders())),
                    Some(s) => match judge(text, answer) {
                        Judge::Correct => {
                            self.correct(s, ctx);
                            Chat::Only(To::Seat(s))
                        }
                        // 只有自己看得到的系統訊息很容易漏看，另外送一個事件讓畫面上跳出提示（和音效）
                        Judge::Contains => {
                            ctx.announce(To::Seat(s), "很接近了！只要打答案本身就好（這句沒有送出）", "accent");
                            ctx.emit(To::Seat(s), json!({ "type": "close", "guess": null }));
                            Chat::Drop
                        }
                        Judge::Close => {
                            ctx.announce(To::Seat(s), format!("「{text}」差一點！"), "accent");
                            ctx.emit(To::Seat(s), json!({ "type": "close", "guess": text }));
                            Chat::Show
                        }
                        Judge::Miss => Chat::Show,
                    },
                }
            }
        }
    }

    fn presence(&mut self, seat: usize, online: bool, ctx: &mut Ctx) {
        self.online[seat] = online;
        self.offline_since[seat] = (!online).then_some(ctx.now);
        ctx.changed();
    }

    fn view(&self, seat: Option<usize>, now: Instant) -> Value {
        let public = matches!(self.stage, Stage::Reveal | Stage::End);
        let insider = seat.is_some_and(|s| s == self.drawer || self.guessed[s].is_some());
        let entry = self.word.map(|i| &WORDS[i]);
        let hint = entry.filter(|_| self.stage == Stage::Draw).map(|e| {
            let chars: Vec<Option<String>> =
                e.word.chars().enumerate().map(|(i, c)| self.revealed.contains(&i).then(|| c.to_string())).collect();
            json!({ "chars": chars, "category": self.options.category.then_some(e.category) })
        });
        let choices = (self.stage == Stage::Choose && seat == Some(self.drawer)).then(|| {
            self.choices
                .iter()
                .map(|&i| json!({ "word": WORDS[i].word, "category": WORDS[i].category, "level": WORDS[i].level }))
                .collect::<Vec<_>>()
        });
        let seats: Vec<Value> = (0..self.names.len())
            .map(|s| {
                json!({
                    "online": self.online[s],
                    "guessed": self.guessed[s].is_some(),
                    "score": self.scores[s],
                    "total": self.total(s),
                    "turnPoints": self.turn_points[s],
                })
            })
            .collect();
        json!({
            "stage": self.stage.name(),
            "endsIn": self.deadline.map(|d| d.saturating_duration_since(now).as_millis() as u64),
            "turn": (self.turn + 1).min(self.total_turns()),
            "turns": self.total_turns(),
            "drawer": self.drawer,
            "you": seat,
            "options": self.options,
            "choices": choices,
            "word": entry.filter(|_| insider || public).map(|e| e.word),
            "level": entry.map(|e| e.level),
            "hint": hint,
            "hintsLeft": if self.stage == Stage::Draw { self.hints_left() } else { 0 },
            "ending": self.ending.map(|e| match e {
                Ending::AllGuessed => "all",
                Ending::Timeout => "timeout",
                Ending::DrawerLeft => "left",
            }),
            "canvas": { "id": self.canvas.id, "v": self.canvas.v, "strokes": self.canvas.strokes },
            "seats": seats,
            "done": self.done,
        })
    }

    fn finished(&self) -> bool {
        self.stage == Stage::End
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::party::{Rng, SeatInfo, test_ctx};

    fn seats(n: usize) -> Vec<SeatInfo> {
        (0..n).map(|i| SeatInfo { pid: i as u32 + 1, name: format!("玩家{i}"), bot: false, online: true }).collect()
    }

    fn start(n: usize, options: Options) -> (Draw, Vec<SeatInfo>, Rng) {
        let seats = seats(n);
        let mut rng = Rng::new();
        let mut out = Default::default();
        let mut ctx = test_ctx(Instant::now(), &mut rng, &seats, &mut out);
        let game = Draw::start(&options, None, &mut ctx);
        (game, seats, rng)
    }

    fn with_ctx<T>(seats: &[SeatInfo], rng: &mut Rng, now: Instant, f: impl FnOnce(&mut Ctx) -> T) -> T {
        let mut out = Default::default();
        let mut ctx = test_ctx(now, rng, seats, &mut out);
        f(&mut ctx)
    }

    fn act(g: &mut Draw, seats: &[SeatInfo], rng: &mut Rng, seat: usize, action: Action) -> Result<(), String> {
        with_ctx(seats, rng, Instant::now(), |ctx| g.act(seat, action, ctx))
    }

    fn say(g: &mut Draw, seats: &[SeatInfo], rng: &mut Rng, seat: Option<usize>, text: &str) -> Chat {
        with_ctx(seats, rng, Instant::now(), |ctx| g.chat(seat, text, ctx))
    }

    fn tick_at(g: &mut Draw, seats: &[SeatInfo], rng: &mut Rng, now: Instant) {
        with_ctx(seats, rng, now, |ctx| g.tick(ctx));
    }

    /// 選第一個詞，回傳答案
    fn choose(g: &mut Draw, seats: &[SeatInfo], rng: &mut Rng) -> &'static str {
        let drawer = g.drawer;
        act(g, seats, rng, drawer, Action::Choose { index: 0 }).unwrap();
        assert_eq!(g.stage, Stage::Draw);
        g.answer().unwrap()
    }

    fn guesser(g: &Draw) -> usize {
        (0..g.names.len()).find(|&s| s != g.drawer && g.guessed[s].is_none()).unwrap()
    }

    #[test]
    fn word_bank_is_big_and_clean() {
        assert!(WORDS.len() >= 400, "只有 {} 個詞", WORDS.len());
        let mut seen = HashSet::new();
        for entry in WORDS.iter() {
            let len = entry.word.chars().count();
            assert!((2..=8).contains(&len), "{} 的長度不對", entry.word);
            assert!(seen.insert(entry.word), "重複的詞：{}", entry.word);
            assert!(!entry.category.is_empty());
        }
        for level in [Level::Easy, Level::Medium, Level::Hard] {
            assert!(WORDS.iter().filter(|e| e.level == level).count() >= 60, "{level:?} 的詞太少");
        }
    }

    #[test]
    fn judging_guesses() {
        assert_eq!(judge("長頸鹿", "長頸鹿"), Judge::Correct);
        assert_eq!(judge(" 長 頸 鹿！", "長頸鹿"), Judge::Correct);
        assert_eq!(judge("台北１０１", "台北101"), Judge::Correct);
        assert_eq!(judge("卡拉ok", "卡拉OK"), Judge::Correct);
        assert_eq!(judge("卡拉ＯＫ", "卡拉OK"), Judge::Correct);
        assert_eq!(judge("是長頸鹿嗎", "長頸鹿"), Judge::Contains);
        assert_eq!(judge("長頸", "長頸鹿"), Judge::Close);
        assert_eq!(judge("長勁鹿", "長頸鹿"), Judge::Close);
        assert_eq!(judge("長頸鹿鹿", "長頸鹿"), Judge::Contains);
        assert_eq!(judge("大像", "大象"), Judge::Close);
        assert_eq!(judge("象", "大象"), Judge::Close);
        assert_eq!(judge("鹿", "長頸鹿"), Judge::Miss);
        assert_eq!(judge("斑馬", "長頸鹿"), Judge::Miss);
        assert_eq!(judge("！？", "長頸鹿"), Judge::Miss);
    }

    #[test]
    fn choices_cover_the_levels_and_the_drawer_order_covers_everyone() {
        let (g, _, _) = start(4, Options { cycles: 3, ..Options::default() });
        let levels: Vec<Level> = g.choices.iter().map(|&i| WORDS[i].level).collect();
        assert_eq!(levels, [Level::Easy, Level::Medium, Level::Hard]);
        assert_eq!(g.total_turns(), 12);
        let mut order = g.order.clone();
        order.sort();
        assert_eq!(order, [0, 1, 2, 3]);
        assert_eq!(g.drawer, g.order[0]);
    }

    #[test]
    fn only_the_drawer_chooses_and_paints() {
        let (mut g, seats, mut rng) = start(3, Options::default());
        let d = g.drawer;
        let other = (d + 1) % 3;
        assert!(act(&mut g, &seats, &mut rng, other, Action::Choose { index: 0 }).is_err());
        assert!(act(&mut g, &seats, &mut rng, d, Action::Choose { index: 3 }).is_err());
        // 選題時畫不了
        act(&mut g, &seats, &mut rng, d, Action::Begin { c: 1, w: 0, p: vec![1, 1] }).unwrap();
        assert!(g.canvas.strokes.is_empty());
        choose(&mut g, &seats, &mut rng);
        // 不是畫的人：直接忽略
        act(&mut g, &seats, &mut rng, other, Action::Begin { c: 1, w: 0, p: vec![1, 1] }).unwrap();
        assert!(g.canvas.strokes.is_empty());
        act(&mut g, &seats, &mut rng, d, Action::Begin { c: 1, w: 0, p: vec![10, 20, 30, 40] }).unwrap();
        act(&mut g, &seats, &mut rng, d, Action::More { p: vec![50, 60] }).unwrap();
        act(&mut g, &seats, &mut rng, d, Action::Begin { c: 3, w: 2, p: vec![0, 0] }).unwrap();
        assert_eq!(g.canvas.strokes.len(), 2);
        assert_eq!(g.canvas.strokes[0].p, [10, 20, 30, 40, 50, 60]);
        assert_eq!(g.canvas.points, 4);
        act(&mut g, &seats, &mut rng, d, Action::Undo).unwrap();
        assert_eq!(g.canvas.strokes.len(), 1);
        assert_eq!(g.canvas.points, 3);
        act(&mut g, &seats, &mut rng, d, Action::Clear).unwrap();
        assert!(g.canvas.strokes.is_empty());
        assert_eq!(g.canvas.v, 5);
    }

    #[test]
    fn filling_counts_as_a_stroke() {
        let (mut g, seats, mut rng) = start(2, Options::default());
        choose(&mut g, &seats, &mut rng);
        let d = g.drawer;
        assert!(act(&mut g, &seats, &mut rng, d, Action::Fill { c: COLORS, p: vec![1, 1] }).is_err());
        assert!(act(&mut g, &seats, &mut rng, d, Action::Fill { c: 3, p: vec![1, 1, 2, 2] }).is_err());
        assert!(act(&mut g, &seats, &mut rng, d, Action::Fill { c: 3, p: vec![W + 1, 1] }).is_err());
        act(&mut g, &seats, &mut rng, d, Action::Fill { c: 3, p: vec![500, 300] }).unwrap();
        assert_eq!(g.canvas.strokes.len(), 1);
        assert_eq!((g.canvas.points, g.canvas.fills), (1, 1));
        let view = g.view(Some(d), Instant::now());
        assert_eq!(view["canvas"]["strokes"][0]["f"], true);
        // 不能接在倒顏料後面畫
        assert!(act(&mut g, &seats, &mut rng, d, Action::More { p: vec![1, 1] }).is_err());
        act(&mut g, &seats, &mut rng, d, Action::Begin { c: 1, w: 0, p: vec![1, 1] }).unwrap();
        assert!(g.view(Some(d), Instant::now())["canvas"]["strokes"][1].get("f").is_none());
        act(&mut g, &seats, &mut rng, d, Action::Undo).unwrap();
        act(&mut g, &seats, &mut rng, d, Action::Undo).unwrap();
        assert_eq!((g.canvas.points, g.canvas.fills), (0, 0));
        // 次數上限
        for _ in 0..MAX_FILLS {
            act(&mut g, &seats, &mut rng, d, Action::Fill { c: 3, p: vec![500, 300] }).unwrap();
        }
        assert!(act(&mut g, &seats, &mut rng, d, Action::Fill { c: 3, p: vec![500, 300] }).is_err());
        act(&mut g, &seats, &mut rng, d, Action::Clear).unwrap();
        act(&mut g, &seats, &mut rng, d, Action::Fill { c: 3, p: vec![500, 300] }).unwrap();
    }

    #[test]
    fn close_guesses_get_a_private_event() {
        let (mut g, seats, mut rng) = start(3, Options::default());
        let three = WORDS.iter().position(|e| e.word == "長頸鹿").unwrap();
        g.choices = vec![three, three, three];
        with_ctx(&seats, &mut rng, Instant::now(), |ctx| g.choose(0, ctx));
        let a = guesser(&g);
        let mut out = Default::default();
        let mut ctx = test_ctx(Instant::now(), &mut rng, &seats, &mut out);
        assert!(matches!(g.chat(Some(a), "長勁鹿", &mut ctx), Chat::Show));
        assert!(matches!(g.chat(Some(a), "是長頸鹿嗎", &mut ctx), Chat::Drop));
        assert!(matches!(g.chat(Some(a), "斑馬", &mut ctx), Chat::Show));
        let events = out.events();
        assert_eq!(events.len(), 2);
        assert!(events.iter().all(|(to, e)| matches!(to, To::Seat(s) if *s == a) && e["type"] == "close"));
        assert_eq!(events[0].1["guess"], "長勁鹿");
        assert!(events[1].1["guess"].is_null());
    }

    #[test]
    fn bad_strokes_are_rejected_without_bumping_the_version() {
        let (mut g, seats, mut rng) = start(2, Options::default());
        choose(&mut g, &seats, &mut rng);
        let d = g.drawer;
        let bad = [
            Action::Begin { c: COLORS, w: 0, p: vec![1, 1] },
            Action::Begin { c: 0, w: WIDTHS, p: vec![1, 1] },
            Action::Begin { c: 0, w: 0, p: vec![] },
            Action::Begin { c: 0, w: 0, p: vec![1, 1, 1] },
            Action::Begin { c: 0, w: 0, p: vec![W + 1, 0] },
            Action::Begin { c: 0, w: 0, p: vec![0, H + 1] },
            Action::Begin { c: 0, w: 0, p: vec![5; MAX_BATCH * 2 + 2] },
            Action::More { p: vec![1, 1] },
        ];
        for action in bad {
            assert!(act(&mut g, &seats, &mut rng, d, action).is_err());
        }
        assert_eq!(g.canvas.v, 0);
        // 點數上限
        act(&mut g, &seats, &mut rng, d, Action::Begin { c: 0, w: 0, p: vec![5; MAX_BATCH * 2] }).unwrap();
        while g.canvas.points + MAX_BATCH <= MAX_POINTS {
            act(&mut g, &seats, &mut rng, d, Action::More { p: vec![5; MAX_BATCH * 2] }).unwrap();
        }
        assert!(act(&mut g, &seats, &mut rng, d, Action::More { p: vec![5; MAX_BATCH * 2] }).is_err());
    }

    #[test]
    fn the_answer_only_shows_to_the_drawer_and_those_who_guessed() {
        let (mut g, seats, mut rng) = start(4, Options::default());
        let d = g.drawer;
        // 選題時只有畫的人看得到三個候選詞
        let now = Instant::now();
        for s in 0..4 {
            let view = g.view(Some(s), now);
            assert_eq!(view["choices"].is_null(), s != d);
        }
        assert!(g.view(None, now)["choices"].is_null());

        let answer = choose(&mut g, &seats, &mut rng);
        let a = guesser(&g);
        let b = (0..4).find(|&s| s != d && s != a).unwrap();
        let leaks = |g: &Draw, seat: Option<usize>| g.view(seat, Instant::now()).to_string().contains(answer);
        assert!(!leaks(&g, Some(a)) && !leaks(&g, Some(b)) && !leaks(&g, None));
        assert_eq!(g.view(Some(d), now)["word"], answer);
        assert_eq!(g.view(Some(a), now)["hint"]["chars"].as_array().unwrap().len(), answer.chars().count());

        // a 猜中：自己的那句只有自己看得到，之後 view 裡有答案
        assert!(matches!(say(&mut g, &seats, &mut rng, Some(a), answer), Chat::Only(To::Seat(s)) if s == a));
        assert!(g.guessed[a].is_some());
        assert!(leaks(&g, Some(a)));
        assert!(!leaks(&g, Some(b)) && !leaks(&g, None));
        assert_eq!(g.stage, Stage::Draw, "還有人沒猜中");

        // 猜中的人和畫的人說話，只有他們看得到
        match say(&mut g, &seats, &mut rng, Some(a), "畫得真好") {
            Chat::Only(To::Seats(list)) => {
                assert!(list.contains(&a) && list.contains(&d) && !list.contains(&b));
            }
            _ => panic!("猜中的人說話應該只給畫的人和猜中的人看"),
        }
        // 畫的人不能說出答案，整句裡有答案也不行
        assert!(matches!(say(&mut g, &seats, &mut rng, Some(d), &format!("就是{answer}啦")), Chat::Drop));
        // 還沒猜中的人：多打了字的整句不公開、差一點照常顯示
        assert!(matches!(say(&mut g, &seats, &mut rng, Some(b), &format!("{answer}嗎")), Chat::Drop));
        assert!(matches!(say(&mut g, &seats, &mut rng, Some(b), "隨便猜猜"), Chat::Show));
        // 觀戰的人碰巧說中也不公開
        assert!(matches!(say(&mut g, &seats, &mut rng, None, answer), Chat::Drop));
        assert!(g.guessed.iter().filter(|x| x.is_some()).count() == 1);
    }

    #[test]
    fn scoring_and_the_turn_ends_when_everyone_guessed() {
        let (mut g, seats, mut rng) = start(3, Options::default());
        let d = g.drawer;
        let answer = choose(&mut g, &seats, &mut rng);
        let level = WORDS[g.word.unwrap()].level;
        let a = guesser(&g);
        say(&mut g, &seats, &mut rng, Some(a), answer);
        let early = g.guessed[a].unwrap();
        // 剛開始就猜中，接近滿分
        assert!(early >= (99.0 * level.bonus()) as u32, "{early}");
        let b = guesser(&g);
        say(&mut g, &seats, &mut rng, Some(b), answer);
        assert_eq!(g.stage, Stage::Reveal);
        assert_eq!(g.ending, Some(Ending::AllGuessed));
        assert_eq!(g.turn_points[d], (50.0 * level.bonus()).round() as u32);
        assert_eq!(g.scores[d], g.turn_points[d]);
        // 公布答案時大家都看得到
        assert_eq!(g.view(None, Instant::now())["word"], answer);
        assert_eq!(g.done.len(), 1);
    }

    #[test]
    fn hints_are_given_by_the_drawer_but_never_all() {
        let (mut g, seats, mut rng) = start(2, Options { draw_secs: 100, ..Options::default() });
        // 換成固定的三個字的詞
        let three = WORDS.iter().position(|e| e.word == "長頸鹿").unwrap();
        g.choices = vec![three, three, three];
        let start = Instant::now();
        with_ctx(&seats, &mut rng, start, |ctx| g.choose(0, ctx));
        let d = g.drawer;
        let hidden = |g: &Draw| {
            g.view(Some(1 - g.drawer), Instant::now())["hint"]["chars"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|c| c.is_null())
                .count()
        };
        assert_eq!(hidden(&g), 3);
        assert_eq!(g.view(Some(d), start)["hintsLeft"], 2);
        // 時間過了也不會自動揭露
        tick_at(&mut g, &seats, &mut rng, start + Duration::from_secs(90));
        assert_eq!(hidden(&g), 3);
        // 猜的人不能給提示
        assert!(act(&mut g, &seats, &mut rng, 1 - d, Action::Hint).is_err());
        act(&mut g, &seats, &mut rng, d, Action::Hint).unwrap();
        assert_eq!(hidden(&g), 2);
        act(&mut g, &seats, &mut rng, d, Action::Hint).unwrap();
        assert_eq!(hidden(&g), 1);
        assert_eq!(g.view(Some(d), start)["hintsLeft"], 0);
        assert!(act(&mut g, &seats, &mut rng, d, Action::Hint).is_err());
        assert_eq!(hidden(&g), 1);
        tick_at(&mut g, &seats, &mut rng, start + Duration::from_secs(101));
        assert_eq!(g.stage, Stage::Reveal);
        assert_eq!(g.ending, Some(Ending::Timeout));
        assert_eq!(g.scores, [0, 0], "沒人猜中，畫的人也沒分");
    }

    #[test]
    fn choosing_times_out_and_offline_drawers_are_skipped() {
        let (mut g, seats, mut rng) = start(3, Options { cycles: 1, ..Options::default() });
        let first = g.drawer;
        let now = Instant::now();
        tick_at(&mut g, &seats, &mut rng, now + CHOOSE + Duration::from_millis(1));
        assert_eq!(g.stage, Stage::Draw, "逾時自動選");
        assert!(g.word.is_some());

        // 畫到一半斷線：等一下下才跳過
        with_ctx(&seats, &mut rng, now, |ctx| g.presence(first, false, ctx));
        tick_at(&mut g, &seats, &mut rng, now + Duration::from_secs(3));
        assert_eq!(g.stage, Stage::Draw);
        tick_at(&mut g, &seats, &mut rng, now + OFFLINE_SKIP + Duration::from_secs(1));
        assert_eq!(g.stage, Stage::Reveal);
        assert_eq!(g.ending, Some(Ending::DrawerLeft));

        // 下一個人也斷線了：輪到他時直接跳過
        let second = g.order[1];
        let third = g.order[2];
        with_ctx(&seats, &mut rng, now, |ctx| g.presence(second, false, ctx));
        tick_at(&mut g, &seats, &mut rng, now + Duration::from_secs(60));
        assert_eq!(g.drawer, third);
        assert_eq!(g.turn, 2);
        assert_eq!(g.stage, Stage::Choose);
    }

    #[test]
    fn the_game_ends_after_every_turn_and_scores_carry_over() {
        let (mut g, seats, mut rng) = start(2, Options { cycles: 1, ..Options::default() });
        for _ in 0..2 {
            let answer = choose(&mut g, &seats, &mut rng);
            let a = guesser(&g);
            say(&mut g, &seats, &mut rng, Some(a), answer);
            assert_eq!(g.stage, Stage::Reveal);
            tick_at(&mut g, &seats, &mut rng, Instant::now() + REVEAL + Duration::from_millis(1));
        }
        assert!(g.finished());
        assert_eq!(g.done.len(), 2);
        let totals: Vec<u32> = (0..2).map(|s| g.total(s)).collect();
        assert!(totals.iter().all(|&t| t > 0));

        let mut out = Default::default();
        let mut ctx = test_ctx(Instant::now(), &mut rng, &seats, &mut out);
        let next = Draw::start(&Options::default(), Some(&g), &mut ctx);
        assert_eq!((0..2).map(|s| next.total(s)).collect::<Vec<_>>(), totals);
        assert_eq!(next.scores, [0, 0]);
        // 出過的詞記下來，下一局不會再出
        for word in g.done.iter().map(|d| d.word) {
            let i = WORDS.iter().position(|e| e.word == word).unwrap();
            assert!(next.used.contains(&i));
            assert!(!next.choices.contains(&i));
        }
    }

    #[test]
    fn a_guesser_leaving_can_end_the_turn() {
        let (mut g, seats, mut rng) = start(3, Options::default());
        let answer = choose(&mut g, &seats, &mut rng);
        let a = guesser(&g);
        say(&mut g, &seats, &mut rng, Some(a), answer);
        let b = guesser(&g);
        let now = Instant::now();
        with_ctx(&seats, &mut rng, now, |ctx| g.presence(b, false, ctx));
        tick_at(&mut g, &seats, &mut rng, now);
        assert_eq!(g.stage, Stage::Reveal);
    }
}
