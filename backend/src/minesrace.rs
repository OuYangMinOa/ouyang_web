//! 踩地雷競速（派對房間的遊戲，房間本身見 `party.rs`）。
//!
//! 所有人同一個盤面，比誰先把安全格全部打開。地雷只在伺服器上：用戶端只送「翻開／插旗／雙擊數字」，
//! 伺服器算出結果後只把「你自己的盤面」送回去，所以從瀏覽器挖不出雷在哪。
//!
//! - 公平開局：埋好雷後找一塊最大的「0」區域，替每個人先打開同一塊，大家從同一個起點出發，不靠第一下的運氣。
//!   倒數 3 秒時大家已經看得到這塊起點，但還不能動。
//! - 踩到地雷：預設凍結幾秒（那顆雷標出來，之後照常玩），房主也可以改成直接出局。
//! - 名次照完成的時間；全部人完成或出局、或到了時間上限就結算，沒完成的照完成度排在後面。
//!   真人都結束了（完成、出局或斷線），剩下的電腦最多再等 `GRACE`。
//! - 對手的進度：只送「每 3×3 一塊打開了多少」的熱度圖。大家同一個盤面，
//!   如果送出別人「哪幾格打開了」，等於告訴你哪些格子是安全的；自己結束了（或整局結束）才看得到完整的縮圖。
//! - 流量：自己的動作只用 `emit` 把自己的盤面送回給自己（`quiet`，不重送所有人的 view）；
//!   別人的進度在 `tick` 裡最多每 `PROGRESS_EVERY` 重送一次 view。有人完成或出局時立刻重送。
//!
//! 電腦玩家真的在解這個盤面：只看自己翻開的數字，用單格和兩格的子集推理找安全格和地雷，
//! 推不出來就挑機率最低的格子猜；偶爾手滑亂點。速度和手滑的機率看房主選的強度，每個電腦再各自有一點差異。

use std::{collections::HashMap, sync::Arc, time::Duration};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::time::Instant;

use crate::{
    AppState,
    party::{Ctx, Parties, PartyGame, Rng, To},
};

/// 開局倒數：大家看得到起點，但還不能動
const COUNTDOWN: Duration = Duration::from_secs(3);
/// 罰時模式踩到雷凍結多久
pub const FREEZE: Duration = Duration::from_secs(5);
/// 別人的進度最多多久更新一次
const PROGRESS_EVERY: Duration = Duration::from_millis(500);
/// 真人都結束後，最多再等電腦多久
const GRACE: Duration = Duration::from_secs(30);
/// 熱度圖每一塊的邊長（格）
const BLOCK: usize = 3;

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    #[default]
    Beginner,
    Intermediate,
    Expert,
}

impl Level {
    /// (欄, 列, 雷數)，和單人版 `logic.ts` 的 LEVELS 一樣
    pub fn size(self) -> (usize, usize, usize) {
        match self {
            Level::Beginner => (9, 9, 10),
            Level::Intermediate => (16, 16, 40),
            Level::Expert => (30, 16, 99),
        }
    }

    /// 時間上限
    fn limit(self) -> Duration {
        Duration::from_secs(match self {
            Level::Beginner => 5 * 60,
            Level::Intermediate => 10 * 60,
            Level::Expert => 20 * 60,
        })
    }
}

/// 踩到地雷怎麼辦
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum OnMine {
    /// 凍結 `FREEZE`，那顆雷標出來，然後繼續
    #[default]
    Freeze,
    /// 直接出局
    Out,
}

/// 電腦的強度
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum BotLevel {
    Easy,
    #[default]
    Normal,
    Hard,
}

impl BotLevel {
    /// (每一步平均幾秒, 每一步手滑亂點的機率)
    fn pace(self) -> (f64, f64) {
        match self {
            BotLevel::Easy => (1.5, 0.03),
            BotLevel::Normal => (0.9, 0.012),
            BotLevel::Hard => (0.5, 0.004),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Options {
    pub level: Level,
    pub on_mine: OnMine,
    pub bots: BotLevel,
}

#[derive(Deserialize, Debug)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Action {
    /// 翻開；已經打開的數字格就當作雙擊（chord）
    Open { i: usize },
    /// 插旗／拔旗
    Flag { i: usize },
    /// 雙擊數字：周圍的旗（含踩到的雷）等於數字時，打開其餘的鄰格
    Chord { i: usize },
}

/// 這局的盤面（所有人共用）
struct Field {
    cols: usize,
    rows: usize,
    mines: Vec<bool>,
    /// 周圍八格的雷數
    adj: Vec<u8>,
    /// 安全格的總數
    safe: usize,
    /// 替每個人先打開的起點
    start: usize,
}

impl Field {
    fn len(&self) -> usize {
        self.cols * self.rows
    }

    fn neighbors(&self, i: usize) -> impl Iterator<Item = usize> + use<> {
        neighbors(self.cols, self.rows, i)
    }

    /// 照雷的位置算出數字（測試也用這個自己擺雷）
    fn from_mines(cols: usize, rows: usize, mines: Vec<bool>) -> Self {
        let adj = (0..cols * rows).map(|i| neighbors(cols, rows, i).filter(|&j| mines[j]).count() as u8).collect();
        let safe = mines.iter().filter(|&&m| !m).count();
        let mut field = Self { cols, rows, mines, adj, safe, start: 0 };
        field.start = field.best_start().unwrap_or_else(|| field.mines.iter().position(|&m| !m).unwrap_or(0));
        field
    }

    /// 埋雷，找不到任何「0」就重埋（這幾種密度幾乎不會發生）
    fn random(level: Level, rng: &mut Rng) -> Self {
        let (cols, rows, count) = level.size();
        let n = cols * rows;
        let mut last = None;
        for _ in 0..50 {
            let mut cells: Vec<usize> = (0..n).collect();
            // 部分 Fisher–Yates：只洗前 count 個
            for k in 0..count {
                let j = k + rng.below(n - k);
                cells.swap(k, j);
            }
            let mut mines = vec![false; n];
            for &i in &cells[..count] {
                mines[i] = true;
            }
            let field = Self::from_mines(cols, rows, mines);
            if field.adj[field.start] == 0 && !field.mines[field.start] {
                return field;
            }
            last = Some(field);
        }
        last.expect("tried at least once")
    }

    /// 「0」最多的那一塊連在一起的空白區，回傳其中一格
    fn best_start(&self) -> Option<usize> {
        let mut seen = vec![false; self.len()];
        let mut best: Option<(usize, usize)> = None;
        for i in 0..self.len() {
            if seen[i] || self.mines[i] || self.adj[i] != 0 {
                continue;
            }
            let mut size = 0;
            let mut stack = vec![i];
            seen[i] = true;
            while let Some(c) = stack.pop() {
                size += 1;
                for j in self.neighbors(c) {
                    if !seen[j] && !self.mines[j] && self.adj[j] == 0 {
                        seen[j] = true;
                        stack.push(j);
                    }
                }
            }
            if best.is_none_or(|(_, s)| size > s) {
                best = Some((i, size));
            }
        }
        best.map(|(i, _)| i)
    }
}

pub fn neighbors(cols: usize, rows: usize, i: usize) -> impl Iterator<Item = usize> {
    let (r, c) = ((i / cols) as isize, (i % cols) as isize);
    (-1..=1isize)
        .flat_map(move |dr| (-1..=1isize).map(move |dc| (r + dr, c + dc)))
        .filter(move |&(nr, nc)| {
            (nr, nc) != (r, c) && nr >= 0 && nc >= 0 && (nr as usize) < rows && (nc as usize) < cols
        })
        .map(move |(nr, nc)| nr as usize * cols + nc as usize)
}

/// 一個人的盤面和成績
struct Runner {
    open: Vec<bool>,
    flag: Vec<bool>,
    /// 踩到的雷（標出來，之後當作已知的雷）
    boom: Vec<bool>,
    opened: usize,
    hits: u32,
    frozen_until: Option<Instant>,
    /// 完成的時間（從開始算）
    finished: Option<Duration>,
    out: bool,
    /// 完成的名次（對局中），結算時改成最後的名次
    place: Option<usize>,
    /// 盤面每變一次加一，用戶端拿來判斷 view 和即時事件哪個比較新
    version: u32,
    brain: Option<Brain>,
}

impl Runner {
    fn new(n: usize) -> Self {
        Self {
            open: vec![false; n],
            flag: vec![false; n],
            boom: vec![false; n],
            opened: 0,
            hits: 0,
            frozen_until: None,
            finished: None,
            out: false,
            place: None,
            version: 0,
            brain: None,
        }
    }

    fn done(&self) -> bool {
        self.finished.is_some() || self.out
    }

    /// 已知的雷：自己插的旗或踩過的雷
    fn marked(&self, i: usize) -> bool {
        self.flag[i] || self.boom[i]
    }

    fn unknown(&self, i: usize) -> bool {
        !self.open[i] && !self.marked(i)
    }
}

/// 電腦玩家
struct Brain {
    /// 每一步平均幾秒
    step: f64,
    /// 每一步手滑亂點的機率
    slip: f64,
    next_at: Instant,
}

/// 電腦下一步要做什麼
#[derive(Debug, PartialEq)]
enum Plan {
    /// 推理出來一定安全的格子
    Safe(usize),
    /// 推不出來，猜這格
    Guess(usize),
    Nothing,
}

pub struct MinesRace {
    /// 這個房間的第幾局：用戶端用 (game, version) 判斷自己的盤面哪一份比較新，換局時不會拿到上一局的
    game: u32,
    options: Options,
    field: Field,
    runners: Vec<Runner>,
    pids: Vec<u32>,
    /// 倒數結束、開始計時的時間
    go: Instant,
    /// 時間上限
    limit_at: Instant,
    /// 真人都結束後提早結算的時間；有人回來繼續玩就取消
    grace_at: Option<Instant>,
    /// 結算時的經過時間；None 表示還在進行
    ended: Option<Duration>,
    /// 別人的進度有變，下次 `PROGRESS_EVERY` 到了要重送 view
    progress_dirty: bool,
    last_progress: Instant,
    /// 這個房間累計的分數（pid → 分）
    scores: HashMap<u32, u32>,
}

impl MinesRace {
    fn now_elapsed(&self, now: Instant) -> Duration {
        self.ended.unwrap_or_else(|| now.saturating_duration_since(self.go))
    }

    fn deadline(&self) -> Instant {
        self.grace_at.map_or(self.limit_at, |g| g.min(self.limit_at))
    }

    /// 從 `starts` 開始打開，空白格往外擴散；回傳踩到的雷
    fn flood(&mut self, seat: usize, starts: &[usize]) -> Vec<usize> {
        let field = &self.field;
        let r = &mut self.runners[seat];
        let mut stack = starts.to_vec();
        let mut mines = Vec::new();
        while let Some(i) = stack.pop() {
            if r.open[i] || r.marked(i) {
                continue;
            }
            if field.mines[i] {
                r.boom[i] = true;
                mines.push(i);
                continue;
            }
            r.open[i] = true;
            r.opened += 1;
            if field.adj[i] == 0 {
                stack.extend(field.neighbors(i).filter(|&j| !r.open[j] && !r.marked(j)));
            }
        }
        mines
    }

    /// 打開這些格子，處理踩雷和完成；回傳是不是剛好結束（完成或出局）
    fn reveal(&mut self, seat: usize, starts: &[usize], ctx: &mut Ctx) -> bool {
        let mines = self.flood(seat, starts);
        let now = ctx.now;
        let safe = self.field.safe;
        let on_mine = self.options.on_mine;
        let r = &mut self.runners[seat];
        r.version += 1;
        if !mines.is_empty() {
            r.hits += mines.len() as u32;
            match on_mine {
                OnMine::Out => r.out = true,
                OnMine::Freeze => r.frozen_until = Some(now + FREEZE),
            }
        }
        if !r.out && r.opened == safe {
            r.finished = Some(now.saturating_duration_since(self.go));
            r.frozen_until = None;
        }
        self.progress_dirty = true;
        if !self.runners[seat].done() {
            return false;
        }
        let seats = ctx.seats;
        let name = &seats[seat].name;
        if let Some(time) = self.runners[seat].finished {
            let place = self.runners.iter().filter(|r| r.finished.is_some()).count();
            self.runners[seat].place = Some(place);
            ctx.announce(To::All, format!("🏁 {name} 完成了！第 {place} 名，{}", seconds(time)), "ok");
        } else {
            ctx.announce(To::All, format!("💥 {name} 踩到地雷，出局"), "danger");
        }
        true
    }

    /// 雙擊數字：周圍已知的雷數等於數字，就打開其餘的鄰格；沒有可以開的回傳 None
    fn chord_targets(&self, seat: usize, i: usize) -> Option<Vec<usize>> {
        let r = &self.runners[seat];
        if !r.open[i] || self.field.adj[i] == 0 {
            return None;
        }
        let marked = self.field.neighbors(i).filter(|&j| r.marked(j)).count();
        if marked != usize::from(self.field.adj[i]) {
            return None;
        }
        let targets: Vec<usize> = self.field.neighbors(i).filter(|&j| r.unknown(j)).collect();
        (!targets.is_empty()).then_some(targets)
    }

    /// 自己的盤面：`.` 未開、`F` 旗、`X` 踩到的雷、`0`～`8` 打開的數字
    fn board(&self, seat: usize) -> String {
        let r = &self.runners[seat];
        (0..self.field.len())
            .map(|i| {
                if r.boom[i] {
                    'X'
                } else if r.open[i] {
                    char::from(b'0' + self.field.adj[i])
                } else if r.flag[i] {
                    'F'
                } else {
                    '.'
                }
            })
            .collect()
    }

    fn me_json(&self, seat: usize, now: Instant) -> Value {
        let r = &self.runners[seat];
        json!({
            "game": self.game,
            "v": r.version,
            "board": self.board(seat),
            "opened": r.opened,
            "hits": r.hits,
            "frozen": r.frozen_until.map_or(0, |t| t.saturating_duration_since(now).as_millis() as u64),
            "finished": r.finished.map(|d| d.as_millis() as u64),
            "out": r.out,
            "place": r.place,
        })
    }

    /// 熱度圖：每 `BLOCK`×`BLOCK` 一塊，0 沒開、1 開了不到一半、2 一半以上、3 全開（只算安全格）
    fn heat(&self, seat: usize) -> String {
        let (cols, rows) = (self.field.cols, self.field.rows);
        let r = &self.runners[seat];
        let mut out = String::new();
        for br in (0..rows).step_by(BLOCK) {
            for bc in (0..cols).step_by(BLOCK) {
                let (mut safe, mut opened) = (0, 0);
                for row in br..(br + BLOCK).min(rows) {
                    for col in bc..(bc + BLOCK).min(cols) {
                        let i = row * cols + col;
                        if !self.field.mines[i] {
                            safe += 1;
                            opened += usize::from(r.open[i]);
                        }
                    }
                }
                out.push(match opened {
                    0 => '0',
                    _ if opened == safe => '3',
                    _ if opened * 2 >= safe => '2',
                    _ => '1',
                });
            }
        }
        out
    }

    /// 打開的格子，每 4 格一個十六進位字（第 4k 格是最低位）
    fn mini(&self, seat: usize) -> String {
        let open = &self.runners[seat].open;
        open.chunks(4)
            .map(|chunk| {
                let bits = chunk.iter().enumerate().fold(0u32, |acc, (k, &o)| acc | (u32::from(o) << k));
                char::from_digit(bits, 16).expect("4 bits")
            })
            .collect()
    }

    fn mines_hex(&self) -> String {
        self.field
            .mines
            .chunks(4)
            .map(|chunk| {
                let bits = chunk.iter().enumerate().fold(0u32, |acc, (k, &m)| acc | (u32::from(m) << k));
                char::from_digit(bits, 16).expect("4 bits")
            })
            .collect()
    }

    /// 結算：排名次、加分、公布
    fn end(&mut self, ctx: &mut Ctx) {
        let elapsed = ctx.now.saturating_duration_since(self.go).min(self.options.level.limit());
        self.ended = Some(elapsed);
        let n = self.runners.len();
        let mut order: Vec<usize> = (0..n).collect();
        // 完成的照時間；沒完成的照打開的格數、踩雷少的在前
        order.sort_by_key(|&s| {
            let r = &self.runners[s];
            match r.finished {
                Some(time) => (0, time, 0, 0, s),
                None => (1, Duration::ZERO, usize::MAX - r.opened, r.hits, s),
            }
        });
        let mut lines = Vec::new();
        for (k, &s) in order.iter().enumerate() {
            let place = k + 1;
            let r = &mut self.runners[s];
            r.place = Some(place);
            r.frozen_until = None;
            // 第 1 名 n 分，每差一名少 1 分；沒完成的少 1 分
            let points = (n - k) as u32 - u32::from(r.finished.is_none());
            *self.scores.entry(self.pids[s]).or_default() += points;
            let result = match r.finished {
                Some(time) => seconds(time),
                None => format!("完成 {}%", r.opened * 100 / self.field.safe.max(1)),
            };
            if place <= 3 {
                lines.push(format!("{place}. {} {result}", ctx.seats[s].name));
            }
        }
        ctx.announce(To::All, format!("結算：{}", lines.join("、")), "accent");
        ctx.changed();
    }

    /// 電腦走一步，排好下一步的時間
    fn bot_step(&mut self, seat: usize, ctx: &mut Ctx) {
        let Some(brain) = self.runners[seat].brain.as_ref() else { return };
        let (step, slip) = (brain.step, brain.slip);
        let r = &self.runners[seat];
        if r.done() {
            return;
        }
        if let Some(until) = r.frozen_until.filter(|&t| t > ctx.now) {
            let next = until + Duration::from_secs_f64(step * ctx.rng.range(0.8, 1.5));
            self.runners[seat].brain.as_mut().expect("checked").next_at = next;
            return;
        }
        // 插旗不花時間：推出雷就插上，再推一次，直到找到要點的格子或推不下去
        let plan = loop {
            let (plan, mines) = plan(&self.field, &self.runners[seat]);
            if mines.is_empty() || plan != Plan::Nothing {
                for i in mines {
                    self.runners[seat].flag[i] = true;
                }
                break plan;
            }
            for i in mines {
                self.runners[seat].flag[i] = true;
            }
        };
        let unknown: Vec<usize> = (0..self.field.len()).filter(|&i| self.runners[seat].unknown(i)).collect();
        // 手滑：不看推理亂點一格
        let (target, think) = if ctx.rng.chance(slip) && !unknown.is_empty() {
            (Some(unknown[ctx.rng.below(unknown.len())]), ctx.rng.range(1.0, 2.0))
        } else {
            match plan {
                Plan::Safe(i) => (Some(i), ctx.rng.range(0.6, 1.4)),
                Plan::Guess(i) => (Some(i), ctx.rng.range(1.5, 3.0)),
                Plan::Nothing => (None, 1.0),
            }
        };
        // 電腦完成或出局時，大家的畫面立刻更新
        if let Some(i) = target
            && self.reveal(seat, &[i], ctx)
        {
            ctx.changed();
        }
        let next = ctx.now + Duration::from_secs_f64(step * think);
        if let Some(brain) = self.runners[seat].brain.as_mut() {
            brain.next_at = next;
        }
    }
}

/// 電腦的推理：只用自己看得到的東西（打開的數字、自己的旗和踩過的雷）。
/// 回傳下一步，以及順便推理出來、要插旗的雷。
fn plan(field: &Field, r: &Runner) -> (Plan, Vec<usize>) {
    // 每個「有未知鄰格的數字」是一條限制：這些未知格裡剛好有 rest 顆雷
    struct Rule {
        at: usize,
        cells: Vec<usize>,
        rest: usize,
    }
    let mut rules = Vec::new();
    for i in 0..field.len() {
        if !r.open[i] || field.adj[i] == 0 {
            continue;
        }
        let cells: Vec<usize> = field.neighbors(i).filter(|&j| r.unknown(j)).collect();
        if cells.is_empty() {
            continue;
        }
        let marked = field.neighbors(i).filter(|&j| r.marked(j)).count();
        rules.push(Rule { at: i, cells, rest: usize::from(field.adj[i]).saturating_sub(marked) });
    }

    let mut mines = Vec::new();
    // 單格：剩 0 顆就全部安全，剩下的數量等於未知格數就全部是雷
    for rule in &rules {
        if rule.rest == 0 {
            return (Plan::Safe(rule.cells[0]), mines);
        }
        if rule.rest == rule.cells.len() {
            for &c in &rule.cells {
                if !mines.contains(&c) {
                    mines.push(c);
                }
            }
        }
    }
    if !mines.is_empty() {
        // 先插旗（呼叫的人插完會再推一次：新的旗可能讓旁邊的數字變成「剩 0 顆」）
        return (Plan::Nothing, mines);
    }
    // 兩格的子集：A 的未知格都在 B 裡，B 多出來的格子裡有 B.rest - A.rest 顆雷
    for a in &rules {
        for b in &rules {
            if a.at == b.at || a.cells.len() >= b.cells.len() {
                continue;
            }
            let (ar, ac) = (a.at / field.cols, a.at % field.cols);
            let (br, bc) = (b.at / field.cols, b.at % field.cols);
            if ar.abs_diff(br) > 2 || ac.abs_diff(bc) > 2 {
                continue;
            }
            if !a.cells.iter().all(|c| b.cells.contains(c)) {
                continue;
            }
            let extra: Vec<usize> = b.cells.iter().copied().filter(|c| !a.cells.contains(c)).collect();
            let rest = b.rest.saturating_sub(a.rest);
            if rest == 0 {
                return (Plan::Safe(extra[0]), mines);
            }
            if rest == extra.len() {
                return (Plan::Nothing, extra);
            }
        }
    }
    // 猜：邊界上的格子用「最危險的那條限制」估機率，其他格子用剩下的雷平均分
    let unknown: Vec<usize> = (0..field.len()).filter(|&i| r.unknown(i)).collect();
    if unknown.is_empty() {
        return (Plan::Nothing, mines);
    }
    let marked = (0..field.len()).filter(|&i| r.marked(i)).count();
    let total_mines = field.mines.iter().filter(|&&m| m).count();
    let density = total_mines.saturating_sub(marked) as f64 / unknown.len() as f64;
    let mut risk: HashMap<usize, f64> = HashMap::new();
    for rule in &rules {
        let p = rule.rest as f64 / rule.cells.len() as f64;
        for &c in &rule.cells {
            let e = risk.entry(c).or_insert(0.0);
            *e = e.max(p);
        }
    }
    let best = unknown
        .iter()
        .copied()
        .min_by(|&x, &y| {
            let px = risk.get(&x).copied().unwrap_or(density);
            let py = risk.get(&y).copied().unwrap_or(density);
            px.total_cmp(&py)
        })
        .expect("unknown is not empty");
    (Plan::Guess(best), mines)
}

fn seconds(d: Duration) -> String {
    format!("{:.1} 秒", d.as_secs_f64())
}

impl PartyGame for MinesRace {
    const ID: &'static str = "minesrace";
    const MIN_PLAYERS: usize = 1;
    const MAX_PLAYERS: usize = 8;
    const MAX_BOTS: usize = 7;
    /// 手快的人一秒可以點好幾下（插旗、雙擊），放寬一點
    const MSGS_PER_SEC: u32 = 30;

    type Options = Options;
    type Action = Action;

    fn rooms(state: &AppState) -> &Arc<Parties<Self>> {
        &state.minesrace
    }

    fn start(options: &Options, previous: Option<&Self>, ctx: &mut Ctx) -> Self {
        let field = Field::random(options.level, ctx.rng);
        let n = ctx.seats.len();
        let go = ctx.now + COUNTDOWN;
        let mut game = Self {
            game: previous.map_or(1, |p| p.game + 1),
            options: options.clone(),
            runners: (0..n).map(|_| Runner::new(field.len())).collect(),
            field,
            pids: ctx.seats.iter().map(|s| s.pid).collect(),
            go,
            limit_at: go + options.level.limit(),
            grace_at: None,
            ended: None,
            progress_dirty: false,
            last_progress: ctx.now,
            scores: previous.map(|p| p.scores.clone()).unwrap_or_default(),
        };
        let start = game.field.start;
        let (step, slip) = options.bots.pace();
        for seat in 0..n {
            game.flood(seat, &[start]);
            if ctx.seats[seat].bot {
                // 每個電腦各自快一點或慢一點，第一步有反應時間
                let step = step * ctx.rng.range(0.8, 1.25);
                let next_at = go + Duration::from_secs_f64(step * ctx.rng.range(1.0, 2.0));
                game.runners[seat].brain = Some(Brain { step, slip, next_at });
            }
        }
        let (cols, rows, mines) = options.level.size();
        ctx.system(To::All, format!("新的一局：{cols}×{rows}、{mines} 顆雷。3 秒後開始，起點已經替大家打開了！"));
        ctx.changed();
        game
    }

    fn act(&mut self, seat: usize, action: Action, ctx: &mut Ctx) -> Result<(), String> {
        if self.ended.is_some() {
            return Err("這局已經結束了".into());
        }
        if ctx.now < self.go {
            return Err("還在倒數，等一下".into());
        }
        let r = &self.runners[seat];
        if r.done() {
            return Err("你已經結束了，看看別人吧".into());
        }
        if r.frozen_until.is_some_and(|t| t > ctx.now) {
            return Err("踩到地雷了，凍結中…".into());
        }
        let i = match action {
            Action::Open { i } | Action::Flag { i } | Action::Chord { i } => i,
        };
        if i >= self.field.len() {
            return Err("沒有這一格".into());
        }
        let finished = match action {
            Action::Flag { i } => {
                let r = &mut self.runners[seat];
                if r.open[i] || r.boom[i] {
                    ctx.quiet();
                    return Ok(());
                }
                r.flag[i] = !r.flag[i];
                r.version += 1;
                false
            }
            Action::Open { i } if !self.runners[seat].open[i] => {
                if self.runners[seat].marked(i) {
                    ctx.quiet();
                    return Ok(());
                }
                self.reveal(seat, &[i], ctx)
            }
            Action::Open { i } | Action::Chord { i } => match self.chord_targets(seat, i) {
                Some(targets) => self.reveal(seat, &targets, ctx),
                None => {
                    ctx.quiet();
                    return Ok(());
                }
            },
        };
        if finished {
            // 有人完成或出局：所有人的 view 立刻更新（act 成功預設就會重送）
            if self.runners.iter().all(Runner::done) {
                self.end(ctx);
            }
        } else {
            ctx.quiet();
            ctx.emit(To::Seat(seat), json!({ "type": "me", "me": self.me_json(seat, ctx.now) }));
        }
        Ok(())
    }

    fn tick(&mut self, ctx: &mut Ctx) {
        if self.ended.is_some() {
            return;
        }
        let now = ctx.now;
        if now < self.go {
            return;
        }
        for seat in 0..self.runners.len() {
            // 一個 tick 最多走幾步，太快的電腦也不會一次跑完
            for _ in 0..3 {
                let due = self.runners[seat].brain.as_ref().is_some_and(|b| b.next_at <= now);
                if !due || self.runners[seat].done() {
                    break;
                }
                self.bot_step(seat, ctx);
            }
        }
        if self.runners.iter().all(Runner::done) {
            self.end(ctx);
            return;
        }
        // 真人都結束了（完成、出局或斷線）：電腦最多再等 GRACE；有人回來繼續玩就取消
        let humans_playing =
            (0..self.runners.len()).any(|s| !ctx.seats[s].bot && ctx.seats[s].online && !self.runners[s].done());
        match (humans_playing, self.grace_at) {
            (false, None) => {
                let at = now + GRACE;
                if at < self.limit_at {
                    self.grace_at = Some(at);
                    ctx.system(To::All, "真人都結束了，電腦再 30 秒就結算");
                    ctx.changed();
                }
            }
            (true, Some(_)) => {
                self.grace_at = None;
                ctx.changed();
            }
            _ => {}
        }
        if now >= self.deadline() {
            self.end(ctx);
            return;
        }
        if self.progress_dirty && now.duration_since(self.last_progress) >= PROGRESS_EVERY {
            self.progress_dirty = false;
            self.last_progress = now;
            ctx.changed();
        }
    }

    fn view(&self, seat: Option<usize>, now: Instant) -> Value {
        let ended = self.ended.is_some();
        // 自己結束了（或整局結束）才看得到別人完整的縮圖，不然等於告訴你哪些格子安全
        let full_minis = ended || seat.is_some_and(|s| self.runners[s].done());
        let players: Vec<Value> = (0..self.runners.len())
            .map(|s| {
                let r = &self.runners[s];
                json!({
                    "opened": r.opened,
                    "hits": r.hits,
                    "frozen": r.frozen_until.is_some_and(|t| t > now),
                    "finished": r.finished.map(|d| d.as_millis() as u64),
                    "out": r.out,
                    "place": r.place,
                    "points": self.scores.get(&self.pids[s]).copied().unwrap_or(0),
                    "heat": self.heat(s),
                    "mini": full_minis.then(|| self.mini(s)),
                })
            })
            .collect();
        let (cols, rows, mines) = self.options.level.size();
        json!({
            "options": self.options,
            "cols": cols,
            "rows": rows,
            "mines": mines,
            "safe": self.field.safe,
            "block": BLOCK,
            "startsIn": self.go.saturating_duration_since(now).as_millis() as u64,
            "elapsed": self.now_elapsed(now).as_millis() as u64,
            "endsIn": (!ended).then(|| self.deadline().saturating_duration_since(now).as_millis() as u64),
            "ended": ended,
            "you": seat,
            "me": seat.map(|s| self.me_json(s, now)),
            "players": players,
            // 結束後才公開整個盤面
            "reveal": ended.then(|| self.mines_hex()),
        })
    }

    fn finished(&self) -> bool {
        self.ended.is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::party::{Outbox, SeatInfo, test_ctx};

    fn seats(humans: usize, bots: usize) -> Vec<SeatInfo> {
        (0..humans + bots)
            .map(|i| SeatInfo { pid: i as u32 + 1, name: format!("P{i}"), bot: i >= humans, online: true })
            .collect()
    }

    /// 用指定的雷開一局（`map` 一列一個字串，`*` 是雷），倒數直接跳過
    fn game(map: &[&str], options: Options, seats: &[SeatInfo]) -> (MinesRace, Rng) {
        let rows = map.len();
        let cols = map[0].len();
        let mines: Vec<bool> = map.iter().flat_map(|row| row.chars().map(|c| c == '*')).collect();
        let mut rng = Rng::new();
        let mut game = {
            let mut out = Outbox::default();
            let mut ctx = test_ctx(Instant::now(), &mut rng, seats, &mut out);
            MinesRace::start(&options, None, &mut ctx)
        };
        game.field = Field::from_mines(cols, rows, mines);
        game.runners = (0..seats.len()).map(|_| Runner::new(cols * rows)).collect();
        game.go = Instant::now();
        game.limit_at = game.go + Duration::from_secs(600);
        (game, rng)
    }

    fn act(g: &mut MinesRace, seats: &[SeatInfo], rng: &mut Rng, seat: usize, action: Action) -> Result<(), String> {
        let mut out = Outbox::default();
        let mut ctx = test_ctx(Instant::now(), rng, seats, &mut out);
        g.act(seat, action, &mut ctx)
    }

    const MAP: &[&str] = &[
        "*....", //
        ".....", //
        "..*..", //
        ".....", //
        "....*",
    ];

    #[test]
    fn flood_opens_zeros_and_stops_at_numbers() {
        let s = seats(1, 0);
        let (mut g, mut rng) = game(&["....", "....", "...*"], Options::default(), &s);
        act(&mut g, &s, &mut rng, 0, Action::Open { i: 0 }).unwrap();
        // 一顆雷在角落：除了雷以外全部打開，直接完成
        assert_eq!(g.runners[0].opened, 11);
        assert!(g.runners[0].finished.is_some());
        assert_eq!(g.runners[0].place, Some(1));
        assert!(g.finished(), "only player finished, so the round ends");
    }

    #[test]
    fn chord_needs_the_right_number_of_flags() {
        let s = seats(1, 0);
        let (mut g, mut rng) = game(MAP, Options::default(), &s);
        // (1,1) 是 2：周圍有 (0,0) 和 (2,2) 兩顆雷
        let at = 6;
        act(&mut g, &s, &mut rng, 0, Action::Open { i: at }).unwrap();
        assert_eq!(g.field.adj[at], 2);
        assert_eq!(g.runners[0].opened, 1);
        // 旗不夠：什麼都不做
        act(&mut g, &s, &mut rng, 0, Action::Flag { i: 0 }).unwrap();
        act(&mut g, &s, &mut rng, 0, Action::Chord { i: at }).unwrap();
        assert_eq!(g.runners[0].opened, 1);
        // 旗夠了：打開其餘六格（其中的 0 會再往外擴散）
        act(&mut g, &s, &mut rng, 0, Action::Flag { i: 12 }).unwrap();
        act(&mut g, &s, &mut rng, 0, Action::Open { i: at }).unwrap();
        for i in [1, 2, 5, 7, 10, 11] {
            assert!(g.runners[0].open[i], "cell {i} should be open");
        }
        assert!(g.runners[0].opened > 7);
        assert_eq!(g.runners[0].hits, 0);
    }

    #[test]
    fn a_wrong_flag_makes_the_chord_hit_a_mine() {
        let s = seats(1, 0);
        let (mut g, mut rng) = game(MAP, Options::default(), &s);
        act(&mut g, &s, &mut rng, 0, Action::Open { i: 6 }).unwrap();
        act(&mut g, &s, &mut rng, 0, Action::Flag { i: 0 }).unwrap();
        act(&mut g, &s, &mut rng, 0, Action::Flag { i: 1 }).unwrap(); // 插錯
        act(&mut g, &s, &mut rng, 0, Action::Chord { i: 6 }).unwrap();
        let r = &g.runners[0];
        assert_eq!(r.hits, 1);
        assert!(r.boom[12]);
        assert!(r.frozen_until.is_some());
        assert!(!r.out);
    }

    #[test]
    fn freeze_mode_blocks_moves_for_a_while() {
        let s = seats(2, 0);
        let (mut g, mut rng) = game(MAP, Options::default(), &s);
        act(&mut g, &s, &mut rng, 0, Action::Open { i: 0 }).unwrap();
        assert_eq!(g.runners[0].hits, 1);
        let err = act(&mut g, &s, &mut rng, 0, Action::Open { i: 4 }).unwrap_err();
        assert!(err.contains("凍結"));
        // 時間到就能繼續；踩過的雷當作已知的雷，不能再點
        g.runners[0].frozen_until = Some(Instant::now() - Duration::from_millis(1));
        act(&mut g, &s, &mut rng, 0, Action::Open { i: 0 }).unwrap();
        assert_eq!(g.runners[0].hits, 1);
        act(&mut g, &s, &mut rng, 0, Action::Open { i: 4 }).unwrap();
        assert!(g.runners[0].open[4]);
        // 別人不受影響
        assert_eq!(g.runners[1].hits, 0);
        assert!(!g.finished());
    }

    #[test]
    fn out_mode_eliminates_and_ends_when_everyone_is_done() {
        let s = seats(2, 0);
        let options = Options { on_mine: OnMine::Out, ..Options::default() };
        let (mut g, mut rng) = game(&["*..", "...", "..."], options, &s);
        act(&mut g, &s, &mut rng, 0, Action::Open { i: 0 }).unwrap();
        assert!(g.runners[0].out);
        assert!(act(&mut g, &s, &mut rng, 0, Action::Open { i: 8 }).is_err());
        assert!(!g.finished());
        act(&mut g, &s, &mut rng, 1, Action::Open { i: 8 }).unwrap();
        assert!(g.finished());
        // 完成的人第 1 名，出局的第 2 名
        assert_eq!(g.runners[1].place, Some(1));
        assert_eq!(g.runners[0].place, Some(2));
        assert_eq!(g.scores[&2], 2);
        assert_eq!(g.scores[&1], 0);
    }

    #[test]
    fn places_follow_finish_time_and_scores_carry_over() {
        let s = seats(3, 0);
        let (mut g, mut rng) = game(&["...", "...", "..*"], Options::default(), &s);
        act(&mut g, &s, &mut rng, 2, Action::Open { i: 0 }).unwrap();
        act(&mut g, &s, &mut rng, 0, Action::Open { i: 0 }).unwrap();
        assert_eq!(g.runners[2].place, Some(1));
        assert_eq!(g.runners[0].place, Some(2));
        // 最後一個人時間到還沒完成
        let mut out = Outbox::default();
        let mut ctx = test_ctx(g.limit_at + Duration::from_secs(1), &mut rng, &s, &mut out);
        g.tick(&mut ctx);
        assert!(g.finished());
        assert_eq!(g.runners[1].place, Some(3));
        assert_eq!(g.scores[&3], 3);
        assert_eq!(g.scores[&1], 2);
        assert_eq!(g.scores[&2], 0);
        // 下一局接著累計
        let mut out = Outbox::default();
        let mut ctx = test_ctx(Instant::now(), &mut rng, &s, &mut out);
        let next = MinesRace::start(&Options::default(), Some(&g), &mut ctx);
        assert_eq!(next.scores[&3], 3);
    }

    #[test]
    fn views_never_leak_mines_or_other_boards_while_playing() {
        let s = seats(2, 0);
        let (mut g, mut rng) = game(MAP, Options::default(), &s);
        act(&mut g, &s, &mut rng, 1, Action::Open { i: 4 }).unwrap();
        act(&mut g, &s, &mut rng, 0, Action::Open { i: 0 }).unwrap(); // 踩雷
        let now = Instant::now();
        for viewer in [Some(0), Some(1), None] {
            let view = g.view(viewer, now);
            assert!(view["reveal"].is_null());
            for p in view["players"].as_array().unwrap() {
                assert!(p["mini"].is_null(), "nobody is done, so no full minis");
                assert!(p.get("board").is_none());
            }
            let text = view.to_string();
            // 熱度圖之外，只有自己的盤面
            if let Some(seat) = viewer {
                assert_eq!(view["me"]["board"].as_str().unwrap(), g.board(seat));
            } else {
                assert!(view["me"].is_null());
            }
            // 1 號沒有踩雷，他的畫面上不會有 X
            if viewer == Some(1) {
                assert!(!text.contains('X'));
            }
        }
        // 結束後公開
        let mut out = Outbox::default();
        let mut ctx = test_ctx(now, &mut rng, &s, &mut out);
        g.end(&mut ctx);
        let view = g.view(Some(1), now);
        assert_eq!(view["reveal"].as_str().unwrap(), g.mines_hex());
        assert!(view["players"][0]["mini"].is_string());
    }

    #[test]
    fn the_start_is_the_biggest_zero_region_and_everyone_gets_it() {
        let mut rng = Rng::new();
        for level in [Level::Beginner, Level::Intermediate, Level::Expert] {
            for _ in 0..20 {
                let field = Field::random(level, &mut rng);
                let (cols, rows, mines) = level.size();
                assert_eq!(field.len(), cols * rows);
                assert_eq!(field.mines.iter().filter(|&&m| m).count(), mines);
                assert_eq!(field.adj[field.start], 0);
                assert!(!field.mines[field.start]);
            }
        }
        let s = seats(2, 2);
        let mut out = Outbox::default();
        let mut ctx = test_ctx(Instant::now(), &mut rng, &s, &mut out);
        let mut g = MinesRace::start(&Options::default(), None, &mut ctx);
        assert!(g.runners[0].opened > 1);
        assert!(g.runners.iter().all(|r| r.open == g.runners[0].open));
        assert!(g.runners[2].brain.is_some() && g.runners[0].brain.is_none());
        // 倒數中不能動
        assert!(act(&mut g, &s, &mut rng, 0, Action::Open { i: 0 }).is_err());
    }

    #[test]
    fn bad_coordinates_are_rejected() {
        let s = seats(1, 0);
        let (mut g, mut rng) = game(MAP, Options::default(), &s);
        assert!(act(&mut g, &s, &mut rng, 0, Action::Open { i: 25 }).is_err());
        assert!(act(&mut g, &s, &mut rng, 0, Action::Flag { i: usize::MAX }).is_err());
    }

    #[test]
    fn the_solver_finds_mines_and_uses_subsets() {
        // 一列兩格「雷、1」：打開的 1 只剩一個未知鄰格，那格一定是雷
        let field = Field::from_mines(2, 1, vec![true, false]);
        let mut r = Runner::new(2);
        r.open[1] = true;
        assert_eq!(plan(&field, &r), (Plan::Nothing, vec![0]));

        // 3×2，雷在左上角，下排打開：(1,0) 的未知格 {0,1} 是 (1,1) 的 {0,1,2} 的子集，
        // 兩邊都剩 1 顆雷，所以多出來的 2 號格安全
        let field = Field::from_mines(3, 2, vec![true, false, false, false, false, false]);
        let mut r = Runner::new(6);
        for i in [3, 4, 5] {
            r.open[i] = true;
        }
        assert_eq!(plan(&field, &r).0, Plan::Safe(2));
    }

    /// 電腦真的能把整個盤面解完（旁邊放一個不動的真人，局才不會提早結算）
    #[test]
    fn bots_solve_whole_boards() {
        for level in [Level::Beginner, Level::Intermediate, Level::Expert] {
            for bots in [BotLevel::Easy, BotLevel::Hard] {
                let s = seats(1, 3);
                let options = Options { level, bots, ..Options::default() };
                let mut rng = Rng::new();
                let start = Instant::now();
                let mut g = {
                    let mut out = Outbox::default();
                    let mut ctx = test_ctx(start, &mut rng, &s, &mut out);
                    MinesRace::start(&options, None, &mut ctx)
                };
                let mut now = start;
                while !g.finished() && !g.runners[1..].iter().all(Runner::done) {
                    now += Duration::from_millis(250);
                    let mut out = Outbox::default();
                    let mut ctx = test_ctx(now, &mut rng, &s, &mut out);
                    g.tick(&mut ctx);
                }
                for r in &g.runners[1..] {
                    let time = r.finished.unwrap_or_else(|| panic!("{level:?} {bots:?}: a bot ran out of time"));
                    assert_eq!(r.opened, g.field.safe);
                    assert!(time < level.limit());
                }
                // 電腦插的旗一定是對的（推理出來的才插）
                for r in &g.runners[1..] {
                    assert!((0..g.field.len()).all(|i| !r.flag[i] || g.field.mines[i]));
                }
            }
        }
    }

    /// 只有電腦的局：沒有真人在玩就提早結算，名次 1～n 都有人
    #[test]
    fn bot_only_rounds_end_and_rank_everyone() {
        let s = seats(0, 4);
        let mut rng = Rng::new();
        let start = Instant::now();
        let mut g = {
            let mut out = Outbox::default();
            let mut ctx = test_ctx(start, &mut rng, &s, &mut out);
            MinesRace::start(&Options::default(), None, &mut ctx)
        };
        let mut now = start;
        while !g.finished() {
            now += Duration::from_millis(250);
            let mut out = Outbox::default();
            let mut ctx = test_ctx(now, &mut rng, &s, &mut out);
            g.tick(&mut ctx);
        }
        assert!(now.duration_since(start) <= COUNTDOWN + GRACE + Duration::from_secs(1));
        let mut places: Vec<usize> = g.runners.iter().map(|r| r.place.unwrap()).collect();
        places.sort();
        assert_eq!(places, vec![1, 2, 3, 4]);
    }
}
