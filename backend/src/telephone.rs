//! 傳話畫畫（派對房間，房間本身見 `party.rs`）：寫一句話 → 下一個人照著畫 → 再下一個人看圖寫字…
//! 傳一圈之後再一串一串揭曉，看看題目被傳成什麼樣子。
//!
//! 流程：
//! 1. 開局時把座位隨機排成一圈（`ring`），每個人出一題，第 i 串是環上第 i 個人的題目。
//! 2. 每一步所有人同時做：第 0 步寫題目，奇數步照上一個人寫的句子畫圖，偶數步看上一個人的圖寫字。
//!    第 k 步環上第 p 個人做的是第 (p - k) 串，所以每一串每一步都換人，傳 `steps` 步（預設和人數一樣，每個人碰每一串剛好一次）。
//! 3. 每一步有時限（寫字、畫圖分開設）。大家都按「完成」就提早進下一步；時間到時每個人交出最後存的草稿，
//!    沒寫、沒畫就是空的（第 0 步沒寫的人由系統從題目庫抽一題，不然整串就沒得傳）。
//!    斷線的人一樣等時間到；不過其他人都完成、他也斷線超過 `OFFLINE_GRACE` 了，就直接交出他的草稿，不用大家乾等。
//! 4. 傳完進入揭曉：一串一串、一步一步攤開，誰按「下一步」大家都同步看到（前端只讓房主看到按鈕，
//!    房主沒有座位時所有人都有）。`next` 帶著目前的串和步數，兩個人同時按也只會前進一步。
//!    揭曉時可以給別人的作品按 👍，最後結算看誰拿到最多讚。
//!
//! 隱藏資訊：作答時每個人的 view 只有「自己這一串的上一步」和自己的草稿，其他串、其他人的東西都不會送出去；
//! 觀戰的人只看得到誰完成了。揭曉時 view 只放目前這一串已經攤開的部分，結算才把所有串放進 view。
//!
//! 草稿：用戶端寫字、畫圖時節流送 `write`／`draw`（`done: false`），按完成時送 `done: true`；完成後可以 `edit` 回去改。
//! 每個動作都帶著第幾步，換步之後才到的舊草稿直接丟掉。畫是整張筆畫一次送，格式和你畫我猜一樣（`draw.rs`），
//! 筆畫數和點數上限比較低，一則訊息的上限放寬到 128 KB。

use std::{
    sync::{Arc, LazyLock},
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::time::Instant;

use crate::{
    AppState,
    draw::{COLORS, H, MAX_FILLS, W, WIDTHS},
    party::{self, Ctx, Parties, PartyGame, To, shuffle},
};

/// 一句話最多幾個字
pub const MAX_TEXT: usize = 60;
/// 一張畫最多幾筆、總共幾個點（每個點最多 "1000," 五個字元，8000 個點大約 80 KB）
pub const MAX_STROKES: usize = 400;
pub const MAX_POINTS: usize = 8_000;
/// 其他人都完成時，斷線超過這麼久的人就直接交出草稿
const OFFLINE_GRACE: Duration = Duration::from_secs(15);

/// 題目庫，格式見 telephone_prompts.txt
pub static PROMPTS: LazyLock<Vec<&'static str>> = LazyLock::new(|| {
    include_str!("telephone_prompts.txt")
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .collect()
});

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Options {
    /// 傳幾步；0 是跟人數一樣（每個人碰每一串一次），比人數多也只會傳人數那麼多步
    pub steps: u8,
    /// 寫字（出題、看圖寫字）的秒數
    pub write_secs: u16,
    /// 畫圖的秒數
    pub draw_secs: u16,
}

impl Default for Options {
    fn default() -> Self {
        Self { steps: 0, write_secs: 45, draw_secs: 90 }
    }
}

impl Options {
    fn steps_for(&self, players: usize) -> usize {
        match self.steps {
            0 => players,
            n => usize::from(n).min(players),
        }
    }
}

/// 一筆：顏色、粗細的編號和點（x, y, x, y…），和你畫我猜一樣；`f` 是倒顏料（只有一個點）
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Stroke {
    c: u8,
    w: u8,
    p: Vec<u16>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    f: bool,
}

#[derive(Deserialize, Debug)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Action {
    /// 寫字這一步的內容；`done` 是按了完成，不然是草稿
    Write {
        step: usize,
        text: String,
        #[serde(default)]
        done: bool,
    },
    /// 畫圖這一步的整張畫
    Draw {
        step: usize,
        strokes: Vec<Stroke>,
        #[serde(default)]
        done: bool,
    },
    /// 取消完成，回去改
    Edit { step: usize },
    /// 第 0 步：從題目庫抽一題給我
    Suggest,
    /// 揭曉：目前是第 `chain` 串、攤開了 `shown` 步時，往下一步
    Next { chain: usize, shown: usize },
    /// 揭曉：給第 `chain` 串的第 `entry` 步按讚（再按一次收回）
    Like { chain: usize, entry: usize },
}

#[derive(Clone, Debug, PartialEq)]
enum Content {
    Text(String),
    Drawing(Vec<Stroke>),
}

impl Content {
    fn empty(drawing: bool) -> Self {
        if drawing { Content::Drawing(Vec::new()) } else { Content::Text(String::new()) }
    }

    fn json(&self) -> Value {
        match self {
            Content::Text(text) => json!({ "kind": "text", "text": text }),
            Content::Drawing(strokes) => json!({ "kind": "drawing", "strokes": strokes }),
        }
    }
}

/// 一串裡的一步
struct Entry {
    author: usize,
    content: Content,
    /// 第 0 步沒寫、系統抽的題目
    auto: bool,
    /// 按讚的座位
    likes: Vec<usize>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Stage {
    /// 作答中（第 `step` 步）
    Play,
    Reveal,
    End,
}

pub struct Telephone {
    options: Options,
    names: Vec<String>,
    online: Vec<bool>,
    offline_since: Vec<Option<Instant>>,
    /// 傳下去的順序：環上第 i 個位置是座位 `ring[i]`，第 i 串是他出的題
    ring: Vec<usize>,
    /// 每個座位在環上的位置
    pos: Vec<usize>,
    steps: usize,
    step: usize,
    stage: Stage,
    deadline: Option<Instant>,
    chains: Vec<Vec<Entry>>,
    /// 這一步每個人最後存的內容
    drafts: Vec<Option<Content>>,
    done: Vec<bool>,
    /// 「給我一個題目」抽到的（流水號、題目），流水號讓用戶端知道是新抽的
    suggestions: Vec<Option<(u32, &'static str)>>,
    reveal_chain: usize,
    /// 目前這一串攤開了幾步
    shown: usize,
}

impl Telephone {
    fn players(&self) -> usize {
        self.names.len()
    }

    fn drawing_step(step: usize) -> bool {
        step % 2 == 1
    }

    /// 座位 `seat` 在第 `step` 步做的是哪一串
    fn chain_of(&self, seat: usize, step: usize) -> usize {
        let n = self.players();
        (self.pos[seat] + n - step % n) % n
    }

    fn begin_step(&mut self, step: usize, ctx: &mut Ctx) {
        let n = self.players();
        self.step = step;
        self.drafts = vec![None; n];
        self.done = vec![false; n];
        self.suggestions = vec![None; n];
        let secs = if Self::drawing_step(step) { self.options.draw_secs } else { self.options.write_secs };
        self.deadline = Some(ctx.now + Duration::from_secs(u64::from(secs)));
        let what = match step {
            0 => "每個人寫一個題目",
            s if Self::drawing_step(s) => "把拿到的句子畫出來",
            _ => "看圖寫出這張畫在畫什麼",
        };
        ctx.system(To::All, format!("第 {} / {} 步：{what}", step + 1, self.steps));
        ctx.changed();
    }

    /// 這一步收齊了：大家都完成（斷線太久的人不用等），至少要有一個人真的按了完成
    fn ready(&self, now: Instant) -> bool {
        self.done.iter().any(|&d| d)
            && (0..self.players()).all(|s| {
                self.done[s] || (!self.online[s] && self.offline_since[s].is_some_and(|t| now >= t + OFFLINE_GRACE))
            })
    }

    /// 收下每個人這一步的內容，接到各自那一串後面，再進下一步或揭曉
    fn advance(&mut self, ctx: &mut Ctx) {
        let drawing = Self::drawing_step(self.step);
        for seat in 0..self.players() {
            let mut content = self.drafts[seat].take().unwrap_or_else(|| Content::empty(drawing));
            let mut auto = false;
            if self.step == 0 && content == Content::Text(String::new()) {
                content = Content::Text(PROMPTS[ctx.rng.below(PROMPTS.len())].to_owned());
                auto = true;
            }
            let chain = self.chain_of(seat, self.step);
            self.chains[chain].push(Entry { author: seat, content, auto, likes: Vec::new() });
        }
        if self.step + 1 < self.steps {
            self.begin_step(self.step + 1, ctx);
        } else {
            self.stage = Stage::Reveal;
            self.deadline = None;
            self.reveal_chain = 0;
            self.shown = 1;
            ctx.announce(To::All, "全部傳完了！一串一串來看變成什麼樣子", "accent");
            ctx.changed();
        }
    }

    fn next(&mut self, ctx: &mut Ctx) {
        if self.shown < self.chains[self.reveal_chain].len() {
            self.shown += 1;
        } else if self.reveal_chain + 1 < self.chains.len() {
            self.reveal_chain += 1;
            self.shown = 1;
        } else {
            self.stage = Stage::End;
            let likes = self.likes_received();
            let best = likes.iter().copied().max().unwrap_or(0);
            if best > 0 {
                let names: Vec<&str> =
                    (0..self.players()).filter(|&s| likes[s] == best).map(|s| self.names[s].as_str()).collect();
                ctx.announce(To::All, format!("這局結束！最多讚的是 {}（{best} 個 👍）", names.join("、")), "ok");
            } else {
                ctx.announce(To::All, "這局結束！", "ok");
            }
        }
        ctx.changed();
    }

    /// 每個座位拿到幾個讚
    fn likes_received(&self) -> Vec<usize> {
        let mut likes = vec![0; self.players()];
        for entry in self.chains.iter().flatten() {
            likes[entry.author] += entry.likes.len();
        }
        likes
    }

    /// 揭曉時已經攤開的
    fn revealed(&self, chain: usize, entry: usize) -> bool {
        match self.stage {
            Stage::Reveal => chain < self.reveal_chain || (chain == self.reveal_chain && entry < self.shown),
            Stage::End => true,
            Stage::Play => false,
        }
    }

    fn save(&mut self, seat: usize, step: usize, content: Content, done: bool, ctx: &mut Ctx) {
        if self.stage != Stage::Play || step != self.step || (self.done[seat] && !done) {
            // 換步之後才到的舊草稿、完成之後才到的草稿：直接丟掉
            ctx.quiet();
            return;
        }
        self.drafts[seat] = Some(content);
        if done {
            self.done[seat] = true;
            if self.ready(ctx.now) {
                self.advance(ctx);
            }
        } else {
            // 草稿只有伺服器要知道，不用重送 view
            ctx.quiet();
        }
    }

    fn entry_json(&self, chain: usize, index: usize, seat: Option<usize>) -> Value {
        let entry = &self.chains[chain][index];
        let mut value = entry.content.json();
        value["author"] = json!(entry.author);
        value["auto"] = json!(entry.auto);
        value["likes"] = json!(entry.likes.len());
        value["liked"] = json!(seat.is_some_and(|s| entry.likes.contains(&s)));
        value
    }

    fn chain_json(&self, chain: usize, upto: usize, seat: Option<usize>) -> Value {
        let entries: Vec<Value> =
            (0..upto.min(self.chains[chain].len())).map(|i| self.entry_json(chain, i, seat)).collect();
        json!({ "index": chain, "owner": self.ring[chain], "entries": entries })
    }
}

/// 檢查一張畫：筆畫的格式、範圍和總量
fn check_strokes(strokes: &[Stroke]) -> Result<(), String> {
    if strokes.len() > MAX_STROKES {
        return Err("這張畫的筆畫太多了".into());
    }
    let mut points = 0;
    for s in strokes {
        if s.c >= COLORS || s.w >= WIDTHS {
            return Err("沒有這個顏色或粗細".into());
        }
        if s.p.len() < 2 || !s.p.len().is_multiple_of(2) || (s.f && s.p.len() != 2) {
            return Err("筆畫的格式不對".into());
        }
        if s.p.chunks(2).any(|xy| xy[0] > W || xy[1] > H) {
            return Err("筆畫超出畫布了".into());
        }
        points += s.p.len() / 2;
    }
    if points > MAX_POINTS {
        return Err("這張畫的筆畫太多了".into());
    }
    if strokes.iter().filter(|s| s.f).count() > MAX_FILLS {
        return Err("這張畫倒太多次顏料了".into());
    }
    Ok(())
}

impl PartyGame for Telephone {
    const ID: &'static str = "telephone";
    const MIN_PLAYERS: usize = 3;
    const MAX_PLAYERS: usize = 10;
    // 一則訊息是整張畫（最多 8000 個點），留點餘裕
    const MAX_FRAME_BYTES: usize = 128 * 1024;

    type Options = Options;
    type Action = Action;

    fn rooms(state: &AppState) -> &Arc<Parties<Self>> {
        &state.telephone
    }

    fn check_options(mut options: Options) -> Result<Options, String> {
        if options.steps != 0 {
            options.steps = options.steps.clamp(2, Self::MAX_PLAYERS as u8);
        }
        options.write_secs = options.write_secs.clamp(15, 120);
        options.draw_secs = options.draw_secs.clamp(30, 180);
        Ok(options)
    }

    fn start(options: &Options, _previous: Option<&Self>, ctx: &mut Ctx) -> Self {
        let n = ctx.seats.len();
        let mut ring: Vec<usize> = (0..n).collect();
        shuffle(ctx.rng, &mut ring);
        let mut pos = vec![0; n];
        for (i, &seat) in ring.iter().enumerate() {
            pos[seat] = i;
        }
        let steps = options.steps_for(n);
        let mut game = Self {
            options: options.clone(),
            names: ctx.seats.iter().map(|s| s.name.clone()).collect(),
            online: ctx.seats.iter().map(|s| s.online).collect(),
            offline_since: vec![None; n],
            ring,
            pos,
            steps,
            step: 0,
            stage: Stage::Play,
            deadline: None,
            chains: (0..n).map(|_| Vec::new()).collect(),
            drafts: vec![None; n],
            done: vec![false; n],
            suggestions: vec![None; n],
            reveal_chain: 0,
            shown: 0,
        };
        ctx.system(To::All, format!("新的一局：{n} 個人、{n} 串，每串傳 {steps} 步"));
        game.begin_step(0, ctx);
        game
    }

    fn act(&mut self, seat: usize, action: Action, ctx: &mut Ctx) -> Result<(), String> {
        match action {
            Action::Write { step, text, done } => {
                if self.stage == Stage::Play && step == self.step && Self::drawing_step(step) {
                    return Err("這一步要畫圖".into());
                }
                self.save(seat, step, Content::Text(party::clean(text.trim(), MAX_TEXT)), done, ctx);
                Ok(())
            }
            Action::Draw { step, strokes, done } => {
                if self.stage == Stage::Play && step == self.step && !Self::drawing_step(step) {
                    return Err("這一步要寫字".into());
                }
                check_strokes(&strokes)?;
                self.save(seat, step, Content::Drawing(strokes), done, ctx);
                Ok(())
            }
            Action::Edit { step } => {
                if self.stage == Stage::Play && step == self.step && self.done[seat] {
                    self.done[seat] = false;
                } else {
                    ctx.quiet();
                }
                Ok(())
            }
            Action::Suggest => {
                if self.stage != Stage::Play || self.step != 0 {
                    return Err("只有出題時可以抽題目".into());
                }
                let previous = self.suggestions[seat];
                let mut prompt = PROMPTS[ctx.rng.below(PROMPTS.len())];
                // 盡量不要連續抽到同一題
                if previous.is_some_and(|(_, p)| p == prompt) {
                    prompt = PROMPTS[ctx.rng.below(PROMPTS.len())];
                }
                let id = previous.map_or(1, |(id, _)| id + 1);
                self.suggestions[seat] = Some((id, prompt));
                Ok(())
            }
            Action::Next { chain, shown } => {
                if self.stage == Stage::Reveal && chain == self.reveal_chain && shown == self.shown {
                    self.next(ctx);
                } else {
                    // 別人已經先按了
                    ctx.quiet();
                }
                Ok(())
            }
            Action::Like { chain, entry } => {
                if self.stage != Stage::Reveal
                    || chain >= self.chains.len()
                    || entry >= self.chains[chain].len()
                    || !self.revealed(chain, entry)
                {
                    return Err("現在不能按讚".into());
                }
                let target = &mut self.chains[chain][entry];
                if target.author == seat {
                    return Err("不能給自己按讚".into());
                }
                match target.likes.iter().position(|&s| s == seat) {
                    Some(i) => {
                        target.likes.remove(i);
                    }
                    None => target.likes.push(seat),
                }
                Ok(())
            }
        }
    }

    fn tick(&mut self, ctx: &mut Ctx) {
        if self.stage == Stage::Play && (self.deadline.is_some_and(|d| ctx.now >= d) || self.ready(ctx.now)) {
            self.advance(ctx);
        }
    }

    fn presence(&mut self, seat: usize, online: bool, ctx: &mut Ctx) {
        self.online[seat] = online;
        self.offline_since[seat] = (!online).then_some(ctx.now);
        ctx.changed();
    }

    fn view(&self, seat: Option<usize>, now: Instant) -> Value {
        let stage = match self.stage {
            Stage::Play if Self::drawing_step(self.step) => "draw",
            Stage::Play => "write",
            Stage::Reveal => "reveal",
            Stage::End => "end",
        };
        let likes = self.likes_received();
        let seats: Vec<Value> = (0..self.players())
            .map(|s| {
                // 讚數到結算才公開
                let likes = if self.stage == Stage::End { likes[s] } else { 0 };
                json!({ "online": self.online[s], "done": self.stage == Stage::Play && self.done[s], "likes": likes })
            })
            .collect();
        // 作答中：自己這一串的上一步、自己的草稿
        let task = match (self.stage, seat) {
            (Stage::Play, Some(s)) => {
                let chain = self.chain_of(s, self.step);
                let previous = self.step.checked_sub(1).map(|i| {
                    let entry = &self.chains[chain][i];
                    let mut value = entry.content.json();
                    value["author"] = json!(entry.author);
                    value["auto"] = json!(entry.auto);
                    value
                });
                json!({
                    "previous": previous,
                    "draft": self.drafts[s].as_ref().map(Content::json),
                    "suggestion": self.suggestions[s].map(|(id, text)| json!({ "id": id, "text": text })),
                })
            }
            _ => Value::Null,
        };
        let reveal = (self.stage == Stage::Reveal).then(|| {
            json!({ "chain": self.reveal_chain, "shown": self.shown, "current": self.chain_json(self.reveal_chain, self.shown, seat) })
        });
        let chains = (self.stage == Stage::End)
            .then(|| (0..self.chains.len()).map(|c| self.chain_json(c, usize::MAX, seat)).collect::<Vec<_>>());
        json!({
            "stage": stage,
            "step": self.step,
            "steps": self.steps,
            "endsIn": self.deadline.map(|d| d.saturating_duration_since(now).as_millis() as u64),
            "you": seat,
            "options": self.options,
            "ring": self.ring,
            "seats": seats,
            "task": task,
            "reveal": reveal,
            "chains": chains,
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
    use crate::party::{Rng, SeatInfo, test_ctx};

    fn seats(n: usize) -> Vec<SeatInfo> {
        (0..n).map(|i| SeatInfo { pid: i as u32 + 1, name: format!("玩家{i}"), bot: false, online: true }).collect()
    }

    struct T {
        g: Telephone,
        seats: Vec<SeatInfo>,
        rng: Rng,
        now: Instant,
    }

    impl T {
        fn new(n: usize, options: Options) -> Self {
            let seats = seats(n);
            let mut rng = Rng::new();
            let now = Instant::now();
            let mut out = Default::default();
            let mut ctx = test_ctx(now, &mut rng, &seats, &mut out);
            let g = Telephone::start(&options, None, &mut ctx);
            Self { g, seats, rng, now }
        }

        fn act(&mut self, seat: usize, action: Action) -> Result<(), String> {
            let mut out = Default::default();
            let mut ctx = test_ctx(self.now, &mut self.rng, &self.seats, &mut out);
            self.g.act(seat, action, &mut ctx)
        }

        fn tick_after(&mut self, wait: Duration) {
            self.now += wait;
            let mut out = Default::default();
            let mut ctx = test_ctx(self.now, &mut self.rng, &self.seats, &mut out);
            self.g.tick(&mut ctx);
        }

        fn presence(&mut self, seat: usize, online: bool) {
            let mut out = Default::default();
            let mut ctx = test_ctx(self.now, &mut self.rng, &self.seats, &mut out);
            self.g.presence(seat, online, &mut ctx);
        }

        fn write(&mut self, seat: usize, text: &str, done: bool) -> Result<(), String> {
            let step = self.g.step;
            self.act(seat, Action::Write { step, text: text.into(), done })
        }

        fn draw(&mut self, seat: usize, strokes: Vec<Stroke>, done: bool) -> Result<(), String> {
            let step = self.g.step;
            self.act(seat, Action::Draw { step, strokes, done })
        }

        /// 每個人都完成這一步（寫「座位-步」或畫一筆）
        fn finish_step(&mut self) {
            let step = self.g.step;
            for s in 0..self.g.players() {
                if Telephone::drawing_step(step) {
                    self.draw(s, vec![dot()], true).unwrap();
                } else {
                    self.write(s, &format!("句子{s}-{step}"), true).unwrap();
                }
            }
        }

        fn view(&self, seat: Option<usize>) -> Value {
            self.g.view(seat, self.now)
        }
    }

    fn dot() -> Stroke {
        Stroke { c: 1, w: 1, p: vec![10, 20], f: false }
    }

    #[test]
    fn prompt_bank_is_big_and_clean() {
        assert!(PROMPTS.len() >= 150, "只有 {} 題", PROMPTS.len());
        let mut seen = HashSet::new();
        for prompt in PROMPTS.iter() {
            assert!(prompt.chars().count() <= MAX_TEXT, "{prompt} 太長");
            assert_eq!(party::clean(prompt, MAX_TEXT), *prompt, "{prompt} 有多餘的空白");
            assert!(seen.insert(prompt), "重複的題目：{prompt}");
        }
    }

    #[test]
    fn options_are_clamped_and_steps_follow_the_players() {
        let o = Telephone::check_options(Options { steps: 1, write_secs: 1, draw_secs: 999 }).unwrap();
        assert_eq!((o.steps, o.write_secs, o.draw_secs), (2, 15, 180));
        assert_eq!(Telephone::check_options(Options::default()).unwrap(), Options::default());
        assert_eq!(Options::default().steps_for(5), 5);
        assert_eq!(Options { steps: 4, ..Options::default() }.steps_for(3), 3);
        assert_eq!(Options { steps: 4, ..Options::default() }.steps_for(8), 4);
        let t = T::new(6, Options { steps: 4, ..Options::default() });
        assert_eq!(t.g.steps, 4);
    }

    #[test]
    fn every_chain_moves_to_a_new_person_each_step() {
        let n = 5;
        let mut t = T::new(n, Options::default());
        for _ in 0..n {
            t.finish_step();
        }
        assert_eq!(t.g.stage, Stage::Reveal);
        for (c, chain) in t.g.chains.iter().enumerate() {
            assert_eq!(chain.len(), n);
            // 第 c 串是環上第 c 個人出的題，之後沿著環往下傳
            let authors: Vec<usize> = chain.iter().map(|e| e.author).collect();
            let expected: Vec<usize> = (0..n).map(|k| t.g.ring[(c + k) % n]).collect();
            assert_eq!(authors, expected);
            assert_eq!(authors.iter().collect::<HashSet<_>>().len(), n, "每個人只碰一次");
            // 寫字、畫圖交替
            for (k, entry) in chain.iter().enumerate() {
                assert_eq!(matches!(entry.content, Content::Drawing(_)), k % 2 == 1);
            }
        }
    }

    #[test]
    fn players_only_see_the_previous_step_of_their_own_chain() {
        let n = 4;
        let mut t = T::new(n, Options::default());
        for s in 0..n {
            t.write(s, &format!("祕密題目{s}"), true).unwrap();
        }
        assert_eq!(t.g.step, 1);
        for s in 0..n {
            let view = t.view(Some(s)).to_string();
            let chain = t.g.chain_of(s, 1);
            let owner = t.g.ring[chain];
            assert_ne!(owner, s, "不會拿到自己的題目");
            for other in 0..n {
                assert_eq!(
                    view.contains(&format!("祕密題目{other}")),
                    other == owner,
                    "座位 {s} 看到了 {other} 的題目"
                );
            }
        }
        // 觀戰的人什麼都看不到
        let spectator = t.view(None).to_string();
        assert!(!spectator.contains("祕密題目"));

        // 第 2 步：看得到上一個人的畫，但看不到最早的題目
        for s in 0..n {
            t.draw(s, vec![Stroke { c: 2, w: 0, p: vec![s as u16 * 100 + 7, 33], f: false }], true).unwrap();
        }
        assert_eq!(t.g.step, 2);
        for s in 0..n {
            let view = t.view(Some(s));
            assert!(!view.to_string().contains("祕密題目"));
            let previous = &view["task"]["previous"];
            assert_eq!(previous["kind"], "drawing");
            let author = previous["author"].as_u64().unwrap() as usize;
            assert_eq!(previous["strokes"][0]["p"][0], author * 100 + 7);
            assert_eq!(author, t.g.ring[(t.g.pos[s] + n - 1) % n], "上一步是環上前一個人");
        }
    }

    #[test]
    fn timeout_submits_drafts_and_fills_empty_prompts() {
        let mut t = T::new(3, Options::default());
        t.write(0, "草稿而已", false).unwrap();
        t.write(1, "寫好了", true).unwrap();
        t.tick_after(Duration::from_secs(44));
        assert_eq!(t.g.step, 0, "還沒到時間，座位 2 也還沒完成");
        t.tick_after(Duration::from_secs(2));
        assert_eq!(t.g.step, 1);
        fn first(t: &T, seat: usize) -> &Entry {
            &t.g.chains[t.g.chain_of(seat, 0)][0]
        }
        assert_eq!(first(&t, 0).content, Content::Text("草稿而已".into()));
        assert_eq!(first(&t, 1).content, Content::Text("寫好了".into()));
        // 座位 2 什麼都沒寫：系統抽一題
        let auto = first(&t, 2);
        assert!(auto.auto);
        assert!(matches!(&auto.content, Content::Text(text) if PROMPTS.contains(&text.as_str())));

        // 畫圖這一步時間到，沒畫的人交出空白的畫；寫字這一步沒寫就是空的
        t.draw(0, vec![dot()], false).unwrap();
        t.tick_after(Duration::from_secs(91));
        assert_eq!(t.g.step, 2);
        assert_eq!(t.g.chains[t.g.chain_of(0, 1)][1].content, Content::Drawing(vec![dot()]));
        assert_eq!(t.g.chains[t.g.chain_of(1, 1)][1].content, Content::Drawing(Vec::new()));
        t.tick_after(Duration::from_secs(46));
        assert_eq!(t.g.stage, Stage::Reveal);
        assert_eq!(t.g.chains[t.g.chain_of(1, 2)][2].content, Content::Text(String::new()));
        assert!(!t.g.chains[t.g.chain_of(1, 2)][2].auto, "只有第一步會補題目");
    }

    #[test]
    fn everyone_done_advances_early_and_edit_takes_it_back() {
        let mut t = T::new(3, Options::default());
        t.write(0, "一", true).unwrap();
        t.write(1, "二", true).unwrap();
        t.act(1, Action::Edit { step: 0 }).unwrap();
        assert!(!t.g.done[1]);
        // 取消完成後還是草稿，可以繼續改
        t.write(1, "二改", false).unwrap();
        t.write(2, "三", true).unwrap();
        assert_eq!(t.g.step, 0, "座位 1 還在改");
        t.write(1, "二改好", true).unwrap();
        assert_eq!(t.g.step, 1);
        assert_eq!(t.g.chains[t.g.chain_of(1, 0)][0].content, Content::Text("二改好".into()));
        assert_eq!(t.view(Some(0))["seats"][1]["done"], false, "新的一步大家都還沒完成");
    }

    #[test]
    fn stale_or_wrong_kind_submissions() {
        let mut t = T::new(3, Options::default());
        assert!(t.draw(0, vec![dot()], true).is_err(), "第 0 步要寫字");
        t.finish_step();
        assert_eq!(t.g.step, 1);
        assert!(t.write(0, "這步要畫", true).is_err());
        // 上一步晚到的草稿直接丟掉，不會報錯也不會蓋掉
        t.act(0, Action::Write { step: 0, text: "晚到的".into(), done: false }).unwrap();
        assert!(t.g.drafts[0].is_none());
        // 完成之後才到的草稿不算
        t.draw(1, vec![dot()], true).unwrap();
        t.draw(1, Vec::new(), false).unwrap();
        assert_eq!(t.g.drafts[1], Some(Content::Drawing(vec![dot()])));
        // 抽題目只有第 0 步可以
        assert!(t.act(0, Action::Suggest).is_err());
    }

    #[test]
    fn text_is_cleaned_and_capped() {
        let mut t = T::new(3, Options::default());
        let long = "長".repeat(MAX_TEXT + 20);
        t.write(0, &format!("  {long}\n"), false).unwrap();
        assert_eq!(t.g.drafts[0], Some(Content::Text("長".repeat(MAX_TEXT))));
    }

    #[test]
    fn bad_drawings_are_rejected() {
        let mut t = T::new(3, Options::default());
        t.finish_step();
        let stroke = |c, w, p: Vec<u16>| Stroke { c, w, p, f: false };
        let fill = |p: Vec<u16>| Stroke { c: 2, w: 0, p, f: true };
        let bad = [
            vec![stroke(COLORS, 0, vec![1, 1])],
            vec![stroke(0, WIDTHS, vec![1, 1])],
            vec![stroke(0, 0, vec![])],
            vec![stroke(0, 0, vec![1, 1, 1])],
            vec![stroke(0, 0, vec![W + 1, 0])],
            vec![stroke(0, 0, vec![0, H + 1])],
            vec![dot(); MAX_STROKES + 1],
            vec![stroke(0, 0, vec![5; (MAX_POINTS + 1) * 2])],
            vec![fill(vec![1, 1, 2, 2])],
            vec![fill(vec![1, 1]); MAX_FILLS + 1],
        ];
        for strokes in bad {
            assert!(t.draw(0, strokes, false).is_err());
        }
        assert!(t.g.drafts[0].is_none());
        t.draw(0, vec![stroke(0, 0, vec![5; MAX_POINTS * 2])], false).unwrap();
        assert!(t.g.drafts[0].is_some());
        // 倒顏料也收，送出去時帶著 f
        t.draw(0, vec![dot(), fill(vec![500, 300])], false).unwrap();
        assert_eq!(serde_json::to_value(fill(vec![1, 1])).unwrap()["f"], true);
        assert!(serde_json::to_value(dot()).unwrap().get("f").is_none());
    }

    #[test]
    fn offline_players_do_not_hold_everyone_up_for_long() {
        let mut t = T::new(4, Options::default());
        t.presence(3, false);
        for s in 0..3 {
            t.write(s, "好了", true).unwrap();
        }
        assert_eq!(t.g.step, 0, "剛斷線，先等一下");
        t.tick_after(OFFLINE_GRACE - Duration::from_secs(1));
        assert_eq!(t.g.step, 0);
        t.tick_after(Duration::from_secs(2));
        assert_eq!(t.g.step, 1, "斷線夠久了，直接交出他的（空的）草稿");
        assert!(t.g.chains[t.g.chain_of(3, 0)][0].auto);

        // 回來了就照常等他
        t.presence(3, true);
        for s in 0..3 {
            t.draw(s, vec![dot()], true).unwrap();
        }
        t.tick_after(Duration::from_secs(30));
        assert_eq!(t.g.step, 1);

        // 大家都斷線、沒人完成：等到時間到
        let mut t = T::new(3, Options::default());
        for s in 0..3 {
            t.presence(s, false);
        }
        t.tick_after(Duration::from_secs(30));
        assert_eq!(t.g.step, 0);
        t.tick_after(Duration::from_secs(16));
        assert_eq!(t.g.step, 1);
    }

    #[test]
    fn suggestions_are_private_and_numbered() {
        let mut t = T::new(3, Options::default());
        t.act(0, Action::Suggest).unwrap();
        t.act(0, Action::Suggest).unwrap();
        let view = t.view(Some(0));
        assert_eq!(view["task"]["suggestion"]["id"], 2);
        assert!(PROMPTS.contains(&view["task"]["suggestion"]["text"].as_str().unwrap()));
        assert!(t.view(Some(1))["task"]["suggestion"].is_null());
    }

    #[test]
    fn reveal_walks_every_chain_and_likes_count() {
        let n = 3;
        let mut t = T::new(n, Options::default());
        for _ in 0..n {
            t.finish_step();
        }
        assert_eq!(t.g.stage, Stage::Reveal);
        assert_eq!(t.view(None)["endsIn"], Value::Null);
        // 揭曉時 view 只有目前這一串攤開的部分
        let view = t.view(Some(0));
        assert_eq!(view["reveal"]["current"]["entries"].as_array().unwrap().len(), 1);
        assert!(view["chains"].is_null());
        let owner = t.g.ring[0];
        assert_eq!(view["reveal"]["current"]["owner"], owner);
        assert!(view.to_string().contains(&format!("句子{owner}-0")));
        assert!(!view.to_string().contains(&format!("句子{}-0", t.g.ring[1])), "下一串還沒攤開");

        // 按讚：不能按自己的、不能按還沒攤開的，再按一次收回
        let other = (owner + 1) % n;
        assert!(t.act(owner, Action::Like { chain: 0, entry: 0 }).is_err());
        assert!(t.act(other, Action::Like { chain: 0, entry: 1 }).is_err());
        t.act(other, Action::Like { chain: 0, entry: 0 }).unwrap();
        assert_eq!(t.view(Some(other))["reveal"]["current"]["entries"][0]["liked"], true);
        assert_eq!(t.view(Some(owner))["reveal"]["current"]["entries"][0]["likes"], 1);
        t.act(other, Action::Like { chain: 0, entry: 0 }).unwrap();
        assert_eq!(t.view(Some(owner))["reveal"]["current"]["entries"][0]["likes"], 0);
        t.act(other, Action::Like { chain: 0, entry: 0 }).unwrap();

        // 兩個人同時按下一步只會前進一步
        t.act(0, Action::Next { chain: 0, shown: 1 }).unwrap();
        t.act(1, Action::Next { chain: 0, shown: 1 }).unwrap();
        assert_eq!((t.g.reveal_chain, t.g.shown), (0, 2));
        let mut presses = 0;
        while t.g.stage == Stage::Reveal {
            let (chain, shown) = (t.g.reveal_chain, t.g.shown);
            t.act(2, Action::Next { chain, shown }).unwrap();
            presses += 1;
        }
        assert_eq!(presses, n * n - 1);
        assert!(t.g.finished());
        // 結算時所有串都放進 view，讚數也公開
        let view = t.view(None);
        assert_eq!(view["chains"].as_array().unwrap().len(), n);
        assert_eq!(view["chains"][1]["entries"].as_array().unwrap().len(), n);
        assert_eq!(view["seats"][owner]["likes"], 1);
        assert!(t.act(other, Action::Like { chain: 0, entry: 0 }).is_err(), "結算後不能再按");
    }

    #[test]
    fn short_games_end_after_the_chosen_steps() {
        let mut t = T::new(5, Options { steps: 2, ..Options::default() });
        t.finish_step();
        t.finish_step();
        assert_eq!(t.g.stage, Stage::Reveal);
        assert!(t.g.chains.iter().all(|c| c.len() == 2));
    }
}
