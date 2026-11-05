//! 跳棋（派對房間，房間本身見 `party.rs`）。2～6 人，人不夠可以加電腦。
//!
//! 六角星棋盤 121 格：中間是 61 格的六邊形，六個角各是 10 格的三角形。每人 10 顆棋從一個角出發，
//! 目標是正對面那個角。用哪幾個角看人數（`LAYOUTS`）：2 人對角、3 人隔一個角、4 人兩組對角、
//! 5 人空一個角（那個角正對面的人目標是空的）、6 人全部。輪流的順序就是繞著棋盤的順序。
//!
//! - 走法：走到相鄰的空格；或跳過相鄰的一顆棋（不分顏色）落到正後方的空格，可以連續跳、中途想停就停。
//!   走一步之後不能再跳，同一手不能經過同一格兩次，被跳過的棋不會被吃掉。不能不走（沒棋能走時自動跳過）。
//! - 長跳（房主的選項，預設關）：同一直線上隔著一顆棋、棋前後的空格一樣多就能跳過去（對稱跳），
//!   例如中間隔兩個空格的那顆棋，跳過去落在它後面第三格。相鄰那顆的一般跳法也算在裡面。
//! - 防堵：目標三角形 10 格全部有棋、而且其中至少一顆是自己的，就算走完；別人的棋要等它的主人走滿
//!   `SPOIL_AFTER` 手（或已經走完）才算你的。開局時對方還沒來得及搬家不算，之後還賴在你目標裡的棋等於替你填格子，
//!   堵人只會讓對方更快走完。
//! - 第一個人走完就結束，其他人照進度排名；房主可以選「排出所有名次」，走完的人之後跳過，剩一個人時結束。
//!   排名次時走完的人的棋會拿下棋盤：不然它們永遠不會再動，可能把別人最後一顆棋困死在角落的尖端。
//! - 防拖延：每人最多走 `MOVE_LIMIT` 手，大家都走滿還沒分出勝負就照進度排名（剩下的距離越短越前面）。
//! - 每手有時限（可以不限），時間到或斷線（等 5 秒）由電腦代走這一手。
//! - 計分：每局第一名 +1，在同一個房間累計。上一局先走的人的下一位先走（輪流當先手）。
//!
//! 座標用立方座標 (x, y, z)，x + y + z = 0；星形是「三個都 ≥ -4」和「三個都 ≤ 4」兩個大三角形的聯集。
//! 格子的編號：z 從 -8 到 8 一列一列、每列 x 從小到大，0 是最上面的尖端、60 是正中央、120 是最下面的尖端
//! （前端 `frontend/src/games/chinesecheckers/board.ts` 用一模一樣的順序，兩邊都自己算，不用傳座標）。
//!
//! 電腦玩家：每顆棋到目標尖端的距離 d，代價是 Σ(d + 0.08·d²)（落後的棋權重比較大，會被拉上來），
//! 挑代價降最多的那一手，前幾名再往下看自己的下一手（能不能接著跳得更遠）；最近離開的格子不走回去，免得來回晃。

use std::{
    cmp::Reverse,
    collections::{HashMap, VecDeque},
    sync::{Arc, LazyLock},
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::time::Instant;

use crate::{
    AppState,
    party::{Ctx, Parties, PartyGame, Rng, To},
};

pub const CELLS: usize = 121;
pub const PIECES: usize = 10;
/// 棋盤上的空格；有棋的格子存座位
const EMPTY: u8 = u8::MAX;
/// 每人最多走幾手；大家都走滿還沒分出勝負就照進度排名
pub const MOVE_LIMIT: u32 = 150;
/// 輪到斷線的人：等這麼久就由電腦代走
const OFFLINE_WAIT: Duration = Duration::from_secs(5);
pub const THINK_CHOICES: [u16; 5] = [0, 15, 30, 60, 120];
/// 電腦記得自己最近幾手離開的格子，不走回去
const TABU: usize = 6;
/// 一開始在家裡的 10 顆棋到目標尖端的距離總和（每個角都一樣），走完時最少是 20
const START_DISTANCE: i32 = 140;
/// 防堵：別人的棋在它的主人走滿這麼多手之後還留在你的目標裡，就算你的（正常一局在這之前早就搬走了）
pub const SPOIL_AFTER: u32 = 30;
const BEST_DISTANCE: i32 = 20;

type Coord = [i8; 3];
pub type Board = [u8; CELLS];

/// 六個方向（立方座標的差）
const DIRS: [Coord; 6] = [[1, -1, 0], [1, 0, -1], [0, 1, -1], [-1, 1, 0], [-1, 0, 1], [0, -1, 1]];

/// 每個角的尖端。沒有旋轉時照順時針：0 右上、1 右下、2 下、3 左下、4 左上、5 上；k 的對面是 k + 3
const TIPS: [Coord; 6] = [[8, -4, -4], [4, -8, 4], [-4, -4, 8], [-8, 4, 4], [-4, 8, -4], [4, 4, -8]];

/// 幾個人用哪幾個角，照輪流的順序（座位 i 從 `LAYOUTS[人數 - 2][i]` 出發）
const LAYOUTS: [&[u8]; 5] = [&[0, 3], &[0, 2, 4], &[0, 1, 3, 4], &[0, 1, 2, 3, 4], &[0, 1, 2, 3, 4, 5]];

pub const COLOR_NAMES: [&str; 6] = ["紅", "藍", "綠", "黃", "黑", "白"];

/// 棋盤的形狀：每格的座標、座標 → 編號、每格屬於哪個角
struct Geometry {
    coords: Vec<Coord>,
    /// `lookup[slot(c)]`：座標 → 格子編號，不在棋盤上的是 `EMPTY`
    lookup: [u8; 17 * 17],
    /// 每個角的 10 格
    corners: [Vec<u8>; 6],
}

static GEO: LazyLock<Geometry> = LazyLock::new(Geometry::new);

fn slot(c: Coord) -> usize {
    (c[2] + 8) as usize * 17 + (c[0] + 8) as usize
}

fn in_star([x, y, z]: Coord) -> bool {
    (x >= -4 && y >= -4 && z >= -4) || (x <= 4 && y <= 4 && z <= 4)
}

/// 這格在哪個角（中間的六邊形是 None）
fn corner_of([x, y, z]: Coord) -> Option<u8> {
    if x >= 5 {
        Some(0)
    } else if y <= -5 {
        Some(1)
    } else if z >= 5 {
        Some(2)
    } else if x <= -5 {
        Some(3)
    } else if y >= 5 {
        Some(4)
    } else if z <= -5 {
        Some(5)
    } else {
        None
    }
}

impl Geometry {
    fn new() -> Self {
        let mut coords = Vec::with_capacity(CELLS);
        let mut lookup = [EMPTY; 17 * 17];
        for z in -8..=8i8 {
            for x in -8..=8i8 {
                let c = [x, -x - z, z];
                if in_star(c) {
                    lookup[slot(c)] = coords.len() as u8;
                    coords.push(c);
                }
            }
        }
        let corners = std::array::from_fn(|k| {
            (0..coords.len() as u8).filter(|&i| corner_of(coords[usize::from(i)]) == Some(k as u8)).collect()
        });
        Self { coords, lookup, corners }
    }

    fn at(&self, c: Coord) -> Option<u8> {
        if c.iter().any(|v| v.abs() > 8) {
            return None;
        }
        let i = self.lookup[slot(c)];
        (i != EMPTY).then_some(i)
    }

    /// 從 `cell` 往方向 `d` 走 `k` 格
    fn step(&self, cell: u8, d: usize, k: i8) -> Option<u8> {
        let c = self.coords[usize::from(cell)];
        let v = DIRS[d];
        self.at([c[0] + v[0] * k, c[1] + v[1] * k, c[2] + v[2] * k])
    }

    fn distance(&self, a: u8, b: u8) -> i32 {
        coord_distance(self.coords[usize::from(a)], self.coords[usize::from(b)])
    }
}

fn coord_distance(a: Coord, b: Coord) -> i32 {
    (0..3).map(|i| (i32::from(a[i]) - i32::from(b[i])).abs()).max().unwrap_or(0)
}

/// `cell` 到 `corner` 那個角尖端的距離
fn to_tip(cell: u8, corner: usize) -> i32 {
    coord_distance(GEO.coords[usize::from(cell)], TIPS[corner])
}

/// 這一手的棋從 `origin` 出發（那格當作已經空了），現在停在 `at`，跳一次能落在哪些格子
fn hops_from(board: &Board, origin: u8, at: u8, long: bool, out: &mut Vec<u8>) {
    let g = &*GEO;
    let occupied = |c: u8| c != origin && board[usize::from(c)] != EMPTY;
    for d in 0..DIRS.len() {
        // 往這個方向找第一顆棋，一般跳法只看相鄰那格
        let mut k = 1;
        let over = loop {
            match g.step(at, d, k) {
                Some(c) if occupied(c) => break Some(k),
                Some(_) if long => k += 1,
                _ => break None,
            }
        };
        let Some(k) = over else { continue };
        // 棋後面要有一樣多的空格，再落在下一格
        let clear = (k + 1..2 * k).all(|j| g.step(at, d, j).is_some_and(|c| !occupied(c)));
        if clear
            && let Some(land) = g.step(at, d, 2 * k)
            && !occupied(land)
        {
            out.push(land);
        }
    }
}

/// `from` 上的棋這一手能到的每一格各一條路徑（含起點），連跳的用跳最少次的路徑。
/// 每跳一次座標都差偶數，所以跳得到的格子一定不是相鄰的格子，兩種走法的終點不會重複。
pub fn destinations(board: &Board, from: u8, long: bool) -> Vec<Vec<u8>> {
    let g = &*GEO;
    let mut paths = Vec::new();
    for d in 0..DIRS.len() {
        if let Some(n) = g.step(from, d, 1)
            && board[usize::from(n)] == EMPTY
        {
            paths.push(vec![from, n]);
        }
    }
    // 連跳：盤面在這一手裡不會變（只有起點空出來），所以用 BFS 找得到的就是不重複經過的路徑
    let mut parent = [EMPTY; CELLS];
    let mut seen = [false; CELLS];
    seen[usize::from(from)] = true;
    let mut queue = VecDeque::from([from]);
    let mut lands = Vec::new();
    while let Some(at) = queue.pop_front() {
        lands.clear();
        hops_from(board, from, at, long, &mut lands);
        for &land in &lands {
            if std::mem::replace(&mut seen[usize::from(land)], true) {
                continue;
            }
            parent[usize::from(land)] = at;
            queue.push_back(land);
            let mut path = vec![land];
            let mut c = land;
            while c != from {
                c = parent[usize::from(c)];
                path.push(c);
            }
            path.reverse();
            paths.push(path);
        }
    }
    paths
}

/// 檢查座位 `seat` 走 `path`（含起點）合不合法
pub fn check_path(board: &Board, seat: usize, path: &[u8], long: bool) -> Result<(), &'static str> {
    if path.len() < 2 {
        return Err("選一格要走到的地方");
    }
    if path.len() > CELLS || path.iter().any(|&c| usize::from(c) >= CELLS) {
        return Err("棋盤上沒有這一格");
    }
    let from = path[0];
    if usize::from(board[usize::from(from)]) != seat {
        return Err("這不是你的棋");
    }
    if path.iter().enumerate().any(|(i, c)| path[..i].contains(c)) {
        return Err("同一手不能經過同一格兩次");
    }
    if path[1..].iter().any(|&c| board[usize::from(c)] != EMPTY) {
        return Err("那一格已經有棋了");
    }
    let g = &*GEO;
    let stepped = |w: &[u8]| g.distance(w[0], w[1]) == 1;
    if path.len() == 2 && stepped(path) {
        return Ok(());
    }
    if path.windows(2).any(stepped) {
        return Err("走一步就停了，不能再走或再跳");
    }
    let mut lands = Vec::new();
    for w in path.windows(2) {
        lands.clear();
        hops_from(board, from, w[0], long, &mut lands);
        if !lands.contains(&w[1]) {
            return Err(if long {
                "跳不過去：要跳過同一直線上的一顆棋，棋前後的空格一樣多"
            } else {
                "跳不過去：要跳過相鄰的一顆棋，落在正後方的空格"
            });
        }
    }
    Ok(())
}

/// 電腦的代價：離目標越遠越大，平方項讓落後的棋比較急著走
fn weight(d: i32) -> f64 {
    let d = f64::from(d);
    d + 0.08 * d * d
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Options {
    /// 長跳（對稱跳）
    pub long_jumps: bool,
    /// 第一個人走完之後繼續，排出所有名次
    pub full_ranking: bool,
    /// 每手的思考秒數，0 是不限
    pub think_secs: u16,
}

impl Default for Options {
    fn default() -> Self {
        Self { long_jumps: false, full_ranking: false, think_secs: 30 }
    }
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Action {
    /// 走一手：`path` 是經過的格子（含起點）；走一步是兩格，連跳是起點加上每次落下的格子
    Move { path: Vec<u8> },
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
enum End {
    /// 有人走完了（排出所有名次時是剩一個人）
    Finish,
    /// 大家都走滿步數，照進度排名
    Limit,
}

#[derive(Clone, Debug)]
struct Outcome {
    /// 名次，第一個是贏家
    ranking: Vec<usize>,
    reason: End,
}

pub struct ChineseCheckers {
    options: Options,
    pids: Vec<u32>,
    names: Vec<String>,
    bots: Vec<bool>,
    online: Vec<bool>,
    /// 座位 → 出發的角
    corners: Vec<u8>,
    board: Board,
    turn: usize,
    /// 每個人走了幾手（沒棋能走被跳過也算）
    moves: Vec<u32>,
    /// 走完的人，照走完的順序
    done: Vec<usize>,
    turn_started: Instant,
    deadline: Option<Instant>,
    bot_at: Option<Instant>,
    /// 走完時自己有幾顆棋在目標裡（排名次時走完的棋會拿下棋盤，畫面上還是要顯示）
    finished_home: Vec<usize>,
    /// 斷線的人第一次由電腦代走時說一聲，重新連上就清掉
    covered: Vec<bool>,
    /// 上一手：誰、經過哪些格子
    last: Option<(usize, Vec<u8>)>,
    /// 這局一共走了幾手，前端靠這個知道有新的一手（播動畫）
    move_no: u32,
    /// 每個人最近離開的格子（電腦代走時不走回去）
    recent: Vec<VecDeque<u8>>,
    outcome: Option<Outcome>,
    /// 累計贏了幾局（pid → 局數）
    wins: HashMap<u32, u32>,
    /// 這個房間的第幾局
    game: u32,
    /// 這局誰先走
    starter: usize,
}

impl ChineseCheckers {
    fn players(&self) -> usize {
        self.pids.len()
    }

    fn target(&self, seat: usize) -> usize {
        (usize::from(self.corners[seat]) + 3) % 6
    }

    /// 座位 `seat` 在 `board` 上走完了沒：目標 10 格都有棋、至少一顆是自己的，
    /// 而且別人的棋都是賴著不走的（主人走滿 `SPOIL_AFTER` 手，或已經走完、棋不會再動）
    fn arrived(&self, board: &Board, seat: usize) -> bool {
        let mut own = false;
        for &c in &GEO.corners[self.target(seat)] {
            match board[usize::from(c)] {
                EMPTY => return false,
                s if usize::from(s) == seat => own = true,
                s => {
                    let s = usize::from(s);
                    if self.moves[s] < SPOIL_AFTER && !self.done.contains(&s) {
                        return false;
                    }
                }
            }
        }
        own
    }

    fn pieces(&self, seat: usize) -> Vec<u8> {
        (0..CELLS as u8).filter(|&c| usize::from(self.board[usize::from(c)]) == seat).collect()
    }

    /// 剩下的距離：每顆棋到目標尖端的距離總和（走完時是 20）
    fn remaining(&self, seat: usize) -> i32 {
        let target = self.target(seat);
        self.pieces(seat).into_iter().map(|c| to_tip(c, target)).sum()
    }

    /// 自己有幾顆棋在目標裡
    fn home_count(&self, seat: usize) -> usize {
        GEO.corners[self.target(seat)].iter().filter(|&&c| usize::from(self.board[usize::from(c)]) == seat).count()
    }

    /// 進度百分比：走完是 100，還沒走完最多 99
    fn progress(&self, seat: usize) -> i32 {
        if self.done.contains(&seat) {
            return 100;
        }
        ((START_DISTANCE - self.remaining(seat)) * 100 / (START_DISTANCE - BEST_DISTANCE)).clamp(0, 99)
    }

    fn has_move(&self, seat: usize) -> bool {
        self.pieces(seat).into_iter().any(|c| !destinations(&self.board, c, self.options.long_jumps).is_empty())
    }

    /// `seat` 之後下一個還沒走完的人
    fn next_player(&self, seat: usize) -> usize {
        let n = self.players();
        (1..=n).map(|i| (seat + i) % n).find(|s| !self.done.contains(s)).unwrap_or(seat)
    }

    fn limit_reached(&self) -> bool {
        (0..self.players()).filter(|s| !self.done.contains(s)).all(|s| self.moves[s] >= MOVE_LIMIT)
    }

    /// 輪到 `seat`（還沒走完的人）。沒有棋能走就算走了一手、換下一位；步數用完就結束
    fn begin_turn(&mut self, mut seat: usize, ctx: &mut Ctx) {
        for _ in 0..self.players() {
            if self.limit_reached() {
                self.finish(End::Limit, ctx);
                return;
            }
            if self.has_move(seat) {
                self.turn = seat;
                self.turn_started = ctx.now;
                self.deadline = (self.options.think_secs > 0)
                    .then(|| ctx.now + Duration::from_secs(u64::from(self.options.think_secs)));
                // 電腦想一下再走，看起來比較自然
                self.bot_at = self.bots[seat].then(|| ctx.now + Duration::from_secs_f64(ctx.rng.range(0.7, 1.4)));
                ctx.changed();
                return;
            }
            ctx.system(To::All, format!("{} 沒有棋可以走，跳過", self.names[seat]));
            self.moves[seat] += 1;
            seat = self.next_player(seat);
        }
        // 大家都沒棋能走（幾乎不可能）：照進度排名
        self.finish(End::Limit, ctx);
    }

    /// 走一手（已經驗證過）
    fn play(&mut self, seat: usize, path: Vec<u8>, ctx: &mut Ctx) {
        let from = path[0];
        let to = *path.last().expect("path has a destination");
        self.board[usize::from(from)] = EMPTY;
        self.board[usize::from(to)] = seat as u8;
        self.moves[seat] += 1;
        self.move_no += 1;
        let recent = &mut self.recent[seat];
        recent.push_back(from);
        if recent.len() > TABU {
            recent.pop_front();
        }
        self.last = Some((seat, path));

        // 先看走的人，再照順序看其他人：別人的棋填滿你的目標也算你走完
        let n = self.players();
        for s in (0..n).map(|i| (seat + i) % n) {
            if !self.done.contains(&s) && self.arrived(&self.board, s) {
                self.done.push(s);
                self.finished_home[s] = self.home_count(s);
                if self.options.full_ranking && n > 2 {
                    let rank = self.done.len();
                    ctx.announce(To::All, format!("{} 走完了，第 {rank} 名！", self.names[s]), "ok");
                }
            }
        }
        let left = n - self.done.len();
        if !self.done.is_empty() && (!self.options.full_ranking || left <= 1) {
            self.finish(End::Finish, ctx);
        } else {
            // 走完的人的棋不會再動，留著可能把別人的棋永遠困住，拿下棋盤
            for c in &mut self.board {
                if *c != EMPTY && self.done.contains(&usize::from(*c)) {
                    *c = EMPTY;
                }
            }
            let next = self.next_player(seat);
            self.begin_turn(next, ctx);
        }
    }

    fn finish(&mut self, reason: End, ctx: &mut Ctx) {
        let n = self.players();
        let mut ranking = self.done.clone();
        let mut rest: Vec<usize> = (0..n).filter(|s| !self.done.contains(s)).collect();
        // 沒走完的照剩下的距離排，一樣的話看目標裡的棋，再一樣就照這局的先後順序
        rest.sort_by_key(|&s| (self.remaining(s), Reverse(self.home_count(s)), (s + n - self.starter) % n));
        ranking.extend(rest);
        let winner = ranking[0];
        *self.wins.entry(self.pids[winner]).or_default() += 1;
        let who = &self.names[winner];
        let (text, tone) = match reason {
            End::Finish if self.options.full_ranking && n > 2 => {
                (format!("名次排完了，{who} 拿下第 {} 局", self.game), "ok")
            }
            End::Finish => (format!("{who} 走完了！拿下第 {} 局", self.game), "ok"),
            End::Limit => {
                (format!("大家都走滿 {MOVE_LIMIT} 手了，照進度排名：{who} 拿下第 {} 局", self.game), "accent")
            }
        };
        ctx.announce(To::All, text, tone);
        self.outcome = Some(Outcome { ranking, reason });
        self.deadline = None;
        self.bot_at = None;
        ctx.changed();
    }

    /// 電腦（或代走）走一手
    fn auto_move(&mut self, ctx: &mut Ctx) {
        let seat = self.turn;
        match self.bot_choice(seat, ctx.rng) {
            Some(path) => self.play(seat, path, ctx),
            // begin_turn 已經確認有棋能走，照理不會到這裡
            None => {
                self.moves[seat] += 1;
                let next = self.next_player(seat);
                self.begin_turn(next, ctx);
            }
        }
    }

    /// 這個盤面下 `seat` 走一手最多能讓代價降多少（往下看一手用，不加亂數）
    fn best_gain(&self, board: &Board, seat: usize) -> f64 {
        let target = self.target(seat);
        let mut best = 0.0f64;
        for from in (0..CELLS as u8).filter(|&c| usize::from(board[usize::from(c)]) == seat) {
            for path in destinations(board, from, self.options.long_jumps) {
                let to = *path.last().expect("destination");
                best = best.max(weight(to_tip(from, target)) - weight(to_tip(to, target)));
            }
        }
        best
    }

    /// 電腦挑一手，見檔頭。只用到公開的盤面，和真人看到的一樣
    fn bot_choice(&self, seat: usize, rng: &mut Rng) -> Option<Vec<u8>> {
        let target = self.target(seat);
        let mut board = self.board;
        let mut candidates: Vec<(f64, Vec<u8>)> = Vec::new();
        for from in self.pieces(seat) {
            for path in destinations(&board, from, self.options.long_jumps) {
                let to = *path.last().expect("destination");
                let mut gain = weight(to_tip(from, target)) - weight(to_tip(to, target));
                if self.recent[seat].contains(&to) {
                    gain -= 3.0;
                }
                board[usize::from(from)] = EMPTY;
                board[usize::from(to)] = seat as u8;
                if self.arrived(&board, seat) {
                    gain += 1000.0;
                }
                board[usize::from(to)] = EMPTY;
                board[usize::from(from)] = seat as u8;
                candidates.push((gain + rng.range(0.0, 0.3), path));
            }
        }
        candidates.sort_by(|a, b| b.0.total_cmp(&a.0));
        candidates.truncate(6);
        // 前幾名再往下看自己的下一手：能接著跳得更遠的比較好
        let mut best: Option<(f64, Vec<u8>)> = None;
        for (gain, path) in candidates {
            let from = usize::from(path[0]);
            let to = usize::from(*path.last().expect("destination"));
            board[from] = EMPTY;
            board[to] = seat as u8;
            let score = gain + 0.5 * self.best_gain(&board, seat);
            board[to] = EMPTY;
            board[from] = seat as u8;
            if best.as_ref().is_none_or(|(b, _)| score > *b) {
                best = Some((score, path));
            }
        }
        best.map(|(_, path)| path)
    }
}

impl PartyGame for ChineseCheckers {
    const ID: &'static str = "chinesecheckers";
    const MIN_PLAYERS: usize = 2;
    const MAX_PLAYERS: usize = 6;
    const MAX_BOTS: usize = 5;

    type Options = Options;
    type Action = Action;

    fn rooms(state: &AppState) -> &Arc<Parties<Self>> {
        &state.chinesecheckers
    }

    fn check_options(options: Options) -> Result<Options, String> {
        if !THINK_CHOICES.contains(&options.think_secs) {
            return Err("思考時間只能選不限、15、30、60 或 120 秒".into());
        }
        Ok(options)
    }

    fn start(options: &Options, previous: Option<&Self>, ctx: &mut Ctx) -> Self {
        let n = ctx.seats.len();
        let corners = LAYOUTS[n - 2].to_vec();
        let mut board = [EMPTY; CELLS];
        for (seat, &k) in corners.iter().enumerate() {
            for &c in &GEO.corners[usize::from(k)] {
                board[usize::from(c)] = seat as u8;
            }
        }
        let pids: Vec<u32> = ctx.seats.iter().map(|s| s.pid).collect();
        // 上一局先走的人的下一位先走（輪流當先手），找不到就隨機
        let starter = previous
            .and_then(|p| pids.iter().position(|&pid| pid == p.pids[p.starter]))
            .map_or_else(|| ctx.rng.below(n), |s| (s + 1) % n);
        let mut game = Self {
            options: options.clone(),
            names: ctx.seats.iter().map(|s| s.name.clone()).collect(),
            bots: ctx.seats.iter().map(|s| s.bot).collect(),
            online: ctx.seats.iter().map(|s| s.online).collect(),
            pids,
            corners,
            board,
            turn: starter,
            moves: vec![0; n],
            done: Vec::new(),
            turn_started: ctx.now,
            deadline: None,
            bot_at: None,
            finished_home: vec![0; n],
            covered: vec![false; n],
            last: None,
            move_no: 0,
            recent: vec![VecDeque::new(); n],
            outcome: None,
            wins: previous.map(|p| p.wins.clone()).unwrap_or_default(),
            game: previous.map_or(1, |p| p.game + 1),
            starter,
        };
        ctx.system(To::All, format!("第 {} 局：{n} 人，由 {} 先走", game.game, game.names[starter]));
        game.begin_turn(starter, ctx);
        game
    }

    fn act(&mut self, seat: usize, action: Action, ctx: &mut Ctx) -> Result<(), String> {
        if self.outcome.is_some() {
            return Err("這局已經結束了".into());
        }
        match action {
            Action::Move { path } => {
                if self.done.contains(&seat) {
                    return Err("你已經走完了".into());
                }
                if seat != self.turn {
                    return Err("還沒輪到你".into());
                }
                check_path(&self.board, seat, &path, self.options.long_jumps)?;
                self.play(seat, path, ctx);
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
            self.auto_move(ctx);
        } else if !self.bots[seat] && !self.online[seat] && ctx.now.duration_since(self.turn_started) >= OFFLINE_WAIT {
            if !std::mem::replace(&mut self.covered[seat], true) {
                ctx.system(To::All, format!("{} 離線了，由電腦代走", self.names[seat]));
            }
            self.auto_move(ctx);
        } else if self.deadline.is_some_and(|d| ctx.now >= d) {
            ctx.system(To::All, format!("{} 時間到，由電腦代走這一手", self.names[seat]));
            self.auto_move(ctx);
        }
    }

    fn presence(&mut self, seat: usize, online: bool, ctx: &mut Ctx) {
        self.online[seat] = online;
        if online {
            self.covered[seat] = false;
        }
        if seat == self.turn {
            // 斷線的人從現在開始算等待時間
            self.turn_started = ctx.now;
        }
        ctx.changed();
    }

    fn view(&self, seat: Option<usize>, now: Instant) -> Value {
        let ended = self.outcome.is_some();
        let board: String = self.board.iter().map(|&c| if c == EMPTY { '.' } else { char::from(b'0' + c) }).collect();
        let seats: Vec<Value> = (0..self.players())
            .map(|s| {
                json!({
                    "online": self.online[s],
                    "moves": self.moves[s],
                    "home": if self.done.contains(&s) { self.finished_home[s] } else { self.home_count(s) },
                    "progress": self.progress(s),
                    "rank": self.done.iter().position(|&d| d == s).map(|r| r + 1),
                    "wins": self.wins.get(&self.pids[s]).copied().unwrap_or(0),
                })
            })
            .collect();
        json!({
            "stage": if ended { "end" } else { "play" },
            "game": self.game,
            "options": self.options,
            "you": seat,
            "board": board,
            "corners": self.corners,
            "turn": (!ended).then_some(self.turn),
            "endsIn": self.deadline.filter(|_| !ended).map(|d| d.saturating_duration_since(now).as_millis() as u64),
            "moveLimit": MOVE_LIMIT,
            "spoilAfter": SPOIL_AFTER,
            "moveNo": self.move_no,
            "last": self.last.as_ref().map(|(s, path)| json!({ "seat": s, "path": path })),
            "seats": seats,
            "result": self.outcome.as_ref().map(|o| json!({ "ranking": o.ranking, "reason": o.reason })),
        })
    }

    fn finished(&self) -> bool {
        self.outcome.is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::party::{Outbox, SeatInfo, test_ctx};

    fn seats(n: usize, bots: usize) -> Vec<SeatInfo> {
        (0..n)
            .map(|i| SeatInfo { pid: i as u32 + 1, name: format!("P{i}"), bot: i >= n - bots, online: true })
            .collect()
    }

    fn start(
        options: &Options,
        previous: Option<&ChineseCheckers>,
        seats: &[SeatInfo],
        rng: &mut Rng,
    ) -> ChineseCheckers {
        let mut out = Outbox::default();
        ChineseCheckers::start(options, previous, &mut test_ctx(Instant::now(), rng, seats, &mut out))
    }

    fn act(g: &mut ChineseCheckers, seats: &[SeatInfo], rng: &mut Rng, seat: usize, path: &[u8]) -> Result<(), String> {
        let mut out = Outbox::default();
        g.act(seat, Action::Move { path: path.to_vec() }, &mut test_ctx(Instant::now(), rng, seats, &mut out))
    }

    /// 座標 → 格子編號
    fn at(x: i8, y: i8, z: i8) -> u8 {
        assert_eq!(x + y + z, 0);
        GEO.at([x, y, z]).expect("on the board")
    }

    /// 空盤面上放幾顆棋：`(座位, 格子)`
    fn board_with(pieces: &[(u8, u8)]) -> Board {
        let mut board = [EMPTY; CELLS];
        for &(seat, cell) in pieces {
            board[usize::from(cell)] = seat;
        }
        board
    }

    fn ends(paths: &[Vec<u8>]) -> Vec<u8> {
        let mut v: Vec<u8> = paths.iter().map(|p| *p.last().unwrap()).collect();
        v.sort_unstable();
        v
    }

    /// 每顆棋都還在、每人 10 顆
    /// 每顆棋都還在、每人 10 顆（排名次時走完的人的棋拿下棋盤了，是 0 顆）
    fn assert_conserved(g: &ChineseCheckers) {
        let mut total = 0;
        for s in 0..g.players() {
            let count = g.pieces(s).len();
            if g.done.contains(&s) && g.options.full_ranking {
                assert!(count == PIECES || count == 0, "座位 {s}：{count}");
            } else {
                assert_eq!(count, PIECES, "座位 {s}");
            }
            total += count;
        }
        assert_eq!(g.board.iter().filter(|&&c| c != EMPTY).count(), total);
    }

    #[test]
    fn the_star_has_121_holes() {
        let g = &*GEO;
        assert_eq!(g.coords.len(), CELLS);
        for k in 0..6 {
            assert_eq!(g.corners[k].len(), 10, "角 {k}");
            assert_eq!(corner_of(TIPS[k]), Some(k as u8));
            // 角就是離尖端 3 格以內的格子
            for (i, &c) in g.coords.iter().enumerate() {
                assert_eq!(coord_distance(c, TIPS[k]) <= 3, g.corners[k].contains(&(i as u8)));
            }
        }
        assert_eq!(g.coords.iter().filter(|&&c| corner_of(c).is_none()).count(), 61);
        // 編號：從上到下、從左到右，和前端一樣
        assert_eq!(g.coords[0], [4, 4, -8]);
        assert_eq!(g.coords[60], [0, 0, 0]);
        assert_eq!(g.coords[120], [-4, -4, 8]);
        assert_eq!(g.coords[1], [3, 4, -7]);
        assert_eq!(g.coords[10], [-4, 8, -4], "第五列從左上角的尖端開始");
        // 每格的鄰居都在棋盤上、而且互相是鄰居
        for i in 0..CELLS as u8 {
            for d in 0..6 {
                if let Some(n) = g.step(i, d, 1) {
                    assert_eq!(g.step(n, (d + 3) % 6, 1), Some(i));
                }
            }
        }
        // 一開始在家裡的棋到對面尖端的距離總和每個角都一樣
        for k in 0..6 {
            let sum: i32 = g.corners[k].iter().map(|&c| to_tip(c, (k + 3) % 6)).sum();
            assert_eq!(sum, START_DISTANCE);
            let best: i32 = g.corners[k].iter().map(|&c| to_tip(c, k)).sum();
            assert_eq!(best, BEST_DISTANCE);
        }
    }

    #[test]
    fn corners_follow_the_player_count() {
        let mut rng = Rng::new();
        for n in 2..=6 {
            let seats = seats(n, 0);
            let g = start(&Options::default(), None, &seats, &mut rng);
            assert_conserved(&g);
            for s in 0..n {
                let home = &GEO.corners[usize::from(g.corners[s])];
                assert!(home.iter().all(|&c| usize::from(g.board[usize::from(c)]) == s));
                assert_eq!(g.remaining(s), START_DISTANCE);
                assert_eq!(g.progress(s), 0);
            }
        }
        let corners = |n: usize| LAYOUTS[n - 2].to_vec();
        assert_eq!(corners(2), [0, 3], "兩個人對角");
        assert_eq!(corners(3), [0, 2, 4], "三個人隔一個角，目標都是空的");
        assert_eq!(corners(4), [0, 1, 3, 4], "兩組對角");
        for n in [3] {
            for &k in LAYOUTS[n - 2] {
                assert!(!LAYOUTS[n - 2].contains(&((k + 3) % 6)));
            }
        }
    }

    #[test]
    fn steps_and_single_hops() {
        // 0 在中央，1 在右邊相鄰
        let center = at(0, 0, 0);
        let right = at(1, -1, 0);
        let board = board_with(&[(0, center), (1, right)]);
        assert!(check_path(&board, 0, &[center, at(0, 1, -1)], false).is_ok(), "走到相鄰的空格");
        assert_eq!(check_path(&board, 0, &[center, right], false), Err("那一格已經有棋了"));
        assert!(check_path(&board, 0, &[center, at(2, -2, 0)], false).is_ok(), "跳過別人的棋");
        assert_eq!(check_path(&board, 1, &[center, at(0, 1, -1)], false), Err("這不是你的棋"));
        assert_eq!(
            check_path(&board, 0, &[center, at(0, 2, -2)], false),
            Err("跳不過去：要跳過相鄰的一顆棋，落在正後方的空格"),
            "中間沒有棋"
        );
        assert!(check_path(&board, 0, &[center, at(3, -3, 0)], false).is_err(), "一般跳法不能隔空");
        assert_eq!(check_path(&board, 0, &[center], false), Err("選一格要走到的地方"));
        assert_eq!(check_path(&board, 0, &[center, 200], false), Err("棋盤上沒有這一格"));
        let reach = destinations(&board, center, false);
        assert_eq!(reach.len(), 6, "五個方向走一步、一個方向跳：{reach:?}");
        assert!(reach.contains(&vec![center, at(2, -2, 0)]));
    }

    #[test]
    fn chained_hops_can_stop_anywhere() {
        // 0 在 (0,0,0)，往右一路隔一格放棋：可以連跳兩次，中途可以停
        let a = at(0, 0, 0);
        let board = board_with(&[(0, a), (1, at(1, -1, 0)), (0, at(3, -3, 0)), (2, at(4, -3, -1))]);
        let one = at(2, -2, 0);
        let two = at(4, -4, 0);
        assert!(check_path(&board, 0, &[a, one], false).is_ok());
        assert!(check_path(&board, 0, &[a, one, two], false).is_ok(), "連跳，跳過自己的棋也可以");
        // 從 (4,-4,0) 再跳過 (4,-3,-1) 落到 (4,-2,-2)
        assert!(check_path(&board, 0, &[a, one, two, at(4, -2, -2)], false).is_ok());
        assert_eq!(check_path(&board, 0, &[a, one, a], false), Err("同一手不能經過同一格兩次"));
        assert_eq!(check_path(&board, 0, &[a, at(0, 1, -1), at(0, 2, -2)], false), Err("走一步就停了，不能再走或再跳"));
        assert_eq!(
            check_path(&board, 0, &[a, one, at(3, -2, -1)], false),
            Err("走一步就停了，不能再走或再跳"),
            "跳完也不能再走一步"
        );
        let reach = destinations(&board, a, false);
        for path in &reach {
            assert!(check_path(&board, 0, path, false).is_ok(), "{path:?}");
        }
        assert!(ends(&reach).contains(&at(4, -2, -2)));
        assert!(reach.contains(&vec![a, one, two, at(4, -2, -2)]));
    }

    #[test]
    fn every_destination_is_listed_once_with_a_legal_path() {
        let mut rng = Rng::new();
        for n in 2..=6 {
            let seats = seats(n, n);
            let mut g = start(&Options::default(), None, &seats, &mut rng);
            for _ in 0..40 {
                for long in [false, true] {
                    for s in 0..n {
                        for from in g.pieces(s) {
                            let reach = destinations(&g.board, from, long);
                            let mut cells = ends(&reach);
                            cells.dedup();
                            assert_eq!(cells.len(), reach.len(), "每個終點只列一次");
                            for path in &reach {
                                assert_eq!(path[0], from);
                                assert!(check_path(&g.board, s, path, long).is_ok(), "{path:?}");
                                if path.len() > 2 {
                                    assert!(GEO.distance(from, *path.last().unwrap()) > 1, "跳的終點不會是相鄰的格子");
                                }
                            }
                        }
                    }
                }
                let seat = g.turn;
                let path = g.bot_choice(seat, &mut rng).unwrap();
                act(&mut g, &seats, &mut rng, seat, &path).unwrap();
            }
        }
    }

    #[test]
    fn long_jumps_are_symmetric() {
        // 中間那一列：起點、空、棋、空、落點
        let a = at(-4, 4, 0);
        let board = board_with(&[(0, a), (1, at(-2, 2, 0))]);
        let land = at(0, 0, 0);
        assert!(check_path(&board, 0, &[a, land], false).is_err(), "沒開長跳不行");
        assert!(!ends(&destinations(&board, a, false)).contains(&land));
        assert!(check_path(&board, 0, &[a, land], true).is_ok());
        assert!(ends(&destinations(&board, a, true)).contains(&land));
        assert!(check_path(&board, 0, &[a, at(1, -1, 0)], true).is_err(), "落點要對稱");
        // 棋後面的空格裡有棋就不行
        let blocked = board_with(&[(0, a), (1, at(-2, 2, 0)), (2, at(-1, 1, 0))]);
        assert!(check_path(&blocked, 0, &[a, land], true).is_err());
        // 落點在棋盤外也不行：(0,0,0) 往左下隔 4 格的棋，落點 (-8,0,8) 不在棋盤上
        let center = at(0, 0, 0);
        let edge = board_with(&[(0, center), (1, at(-4, 0, 4))]);
        assert!(destinations(&edge, center, true).iter().all(|p| p.len() == 2), "只剩走一步");
        // 長跳模式也包含一般的跳法，而且可以連跳
        let chain = board_with(&[(0, a), (1, at(-3, 3, 0)), (1, at(0, 0, 0))]);
        let path = [a, at(-2, 2, 0), at(2, -2, 0)];
        assert!(check_path(&chain, 0, &path, true).is_ok());
        assert!(check_path(&chain, 0, &path, false).is_err());
    }

    #[test]
    fn jumping_over_the_starting_hole_is_not_possible() {
        // 起點在這一手裡算空的：不能跳回來、也不能跳過它
        let a = at(0, 0, 0);
        let board = board_with(&[(0, a), (1, at(1, -1, 0))]);
        assert!(check_path(&board, 0, &[a, at(2, -2, 0), at(-2, 2, 0)], true).is_err());
        for path in destinations(&board, a, true) {
            assert!(!path[1..].contains(&a));
        }
    }

    #[test]
    fn turns_rotate_and_moves_are_validated() {
        let seats = seats(3, 0);
        let mut rng = Rng::new();
        let mut g = start(&Options::default(), None, &seats, &mut rng);
        let first = g.turn;
        let other = (first + 1) % 3;
        let mine = g.pieces(first);
        let path = mine.iter().find_map(|&c| destinations(&g.board, c, false).into_iter().next()).unwrap();
        let theirs = g.pieces(other)[0];
        assert_eq!(act(&mut g, &seats, &mut rng, other, &[theirs, 0]), Err("還沒輪到你".into()));
        assert_eq!(act(&mut g, &seats, &mut rng, first, &[theirs, 0]), Err("這不是你的棋".into()));
        act(&mut g, &seats, &mut rng, first, &path).unwrap();
        assert_eq!(g.turn, other);
        assert_eq!(g.moves[first], 1);
        assert_eq!(g.move_no, 1);
        assert_eq!(g.last, Some((first, path.clone())));
        let view = g.view(Some(other), Instant::now());
        assert_eq!(view["last"]["path"], json!(path));
        assert_eq!(view["turn"], other);
        assert_conserved(&g);
    }

    /// 把座位 `seat` 的棋（除了 `keep` 顆）直接搬進目標，模擬快走完的局面
    fn fill_target(g: &mut ChineseCheckers, seat: usize, keep: usize) {
        let target = GEO.corners[g.target(seat)].clone();
        let mut mine = g.pieces(seat);
        // 先清掉目標裡的棋（搬回對方家，測試用不管合不合理）
        for &c in &target {
            g.board[usize::from(c)] = EMPTY;
        }
        mine.retain(|c| !target.contains(c));
        for (i, &c) in target.iter().enumerate().take(PIECES - keep) {
            g.board[usize::from(mine[i])] = EMPTY;
            g.board[usize::from(c)] = seat as u8;
        }
    }

    #[test]
    fn the_first_to_finish_wins() {
        let seats = seats(2, 0);
        let mut rng = Rng::new();
        let mut g = start(&Options::default(), None, &seats, &mut rng);
        g.turn = 0;
        // 座位 1 的家就是座位 0 的目標：先把座位 1 的棋搬出來，再讓座位 0 只差一顆
        let target = GEO.corners[g.target(0)].clone();
        let free: Vec<u8> = (0..CELLS as u8)
            .filter(|&c| g.board[usize::from(c)] == EMPTY && corner_of(GEO.coords[usize::from(c)]).is_none())
            .collect();
        for (&c, &to) in target.iter().zip(&free) {
            g.board[usize::from(c)] = EMPTY;
            g.board[usize::from(to)] = 1;
        }
        fill_target(&mut g, 0, 1);
        assert_conserved(&g);
        let hole = *target.iter().find(|&&c| g.board[usize::from(c)] == EMPTY).unwrap();
        let outside = g.pieces(0).into_iter().find(|c| !target.contains(c)).unwrap();
        g.board[usize::from(outside)] = EMPTY;
        // 放在洞旁邊、目標外面的一格
        let next = (0..6)
            .filter_map(|d| GEO.step(hole, d, 1))
            .find(|c| !target.contains(c) && g.board[usize::from(*c)] == EMPTY)
            .unwrap();
        g.board[usize::from(next)] = 0;
        act(&mut g, &seats, &mut rng, 0, &[next, hole]).unwrap();
        assert!(g.finished());
        let o = g.outcome.clone().unwrap();
        assert_eq!(o.ranking, [0, 1]);
        assert_eq!(o.reason, End::Finish);
        assert_eq!(g.view(None, Instant::now())["seats"][0]["wins"], 1);
        assert_eq!(act(&mut g, &seats, &mut rng, 1, &[0, 1]), Err("這局已經結束了".into()));
        // 下一局：分數累計，先手輪到下一位
        let next_game = start(&Options::default(), Some(&g), &seats, &mut rng);
        assert_eq!(next_game.game, 2);
        assert_eq!(next_game.starter, (g.starter + 1) % 2);
        assert_eq!(next_game.wins.get(&1), Some(&1));
    }

    #[test]
    fn pieces_squatting_in_your_target_count_for_you() {
        let seats = seats(2, 0);
        let mut rng = Rng::new();
        let mut g = start(&Options::default(), None, &seats, &mut rng);
        let target = GEO.corners[g.target(0)].clone();
        // 目標裡全是對方的棋：自己一顆都沒有，不算
        g.moves[1] = SPOIL_AFTER;
        assert!(!g.arrived(&g.board, 0));
        // 對方留 3 顆不走，其他 7 格是自己的
        let mut board = [EMPTY; CELLS];
        for (i, &c) in target.iter().enumerate() {
            board[usize::from(c)] = if i < 3 { 1 } else { 0 };
        }
        assert!(g.arrived(&board, 0), "對方走滿 30 手還賴著：算走完");
        g.moves[1] = SPOIL_AFTER - 1;
        assert!(!g.arrived(&board, 0), "開局沒多久，對方還沒來得及搬走：不算");
        g.done.push(1);
        assert!(g.arrived(&board, 0), "走完的人的棋不會再動，也算");
        g.done.clear();
        g.moves[1] = SPOIL_AFTER;
        // 還有空格就不算
        board[usize::from(target[9])] = EMPTY;
        assert!(!g.arrived(&board, 0));
    }

    #[test]
    fn full_ranking_keeps_going_and_skips_finished_players() {
        let seats = seats(3, 0);
        let mut rng = Rng::new();
        let o = Options { full_ranking: true, ..Options::default() };
        let mut g = start(&o, None, &seats, &mut rng);
        // 三個人的目標都是空的角：座位 0 只差一顆
        fill_target(&mut g, 0, 1);
        g.turn = 0;
        let target = GEO.corners[g.target(0)].clone();
        let hole = *target.iter().find(|&&c| g.board[usize::from(c)] == EMPTY).unwrap();
        let outside = g.pieces(0).into_iter().find(|c| !target.contains(c)).unwrap();
        g.board[usize::from(outside)] = EMPTY;
        let next = (0..6)
            .filter_map(|d| GEO.step(hole, d, 1))
            .find(|c| !target.contains(c) && g.board[usize::from(*c)] == EMPTY)
            .unwrap();
        g.board[usize::from(next)] = 0;
        act(&mut g, &seats, &mut rng, 0, &[next, hole]).unwrap();
        assert!(!g.finished(), "還要排出其他人的名次");
        assert_eq!(g.done, [0]);
        assert_eq!(g.turn, 1);
        assert_eq!(g.view(None, Instant::now())["seats"][0]["rank"], 1);
        // 座位 1、2 輪流走，座位 0 被跳過
        for _ in 0..4 {
            let seat = g.turn;
            assert_ne!(seat, 0);
            let path = g.bot_choice(seat, &mut rng).unwrap();
            act(&mut g, &seats, &mut rng, seat, &path).unwrap();
        }
        assert_eq!(act(&mut g, &seats, &mut rng, 0, &[hole, next]), Err("你已經走完了".into()));
        assert!(g.pieces(0).is_empty(), "走完的人的棋拿下棋盤");
        assert_eq!(g.view(None, Instant::now())["seats"][0]["home"], 10, "畫面上還是顯示走完時的樣子");
    }

    #[test]
    fn the_move_limit_ends_the_game_by_progress() {
        // 三個人的目標都是空的角
        let seats = seats(3, 0);
        let mut rng = Rng::new();
        let mut g = start(&Options::default(), None, &seats, &mut rng);
        g.moves = vec![MOVE_LIMIT - 1; 3];
        // 座位 1 走得比較遠
        fill_target(&mut g, 1, 4);
        assert_conserved(&g);
        for i in 0..3 {
            assert!(!g.finished());
            let seat = g.turn;
            let path = g.bot_choice(seat, &mut rng).unwrap();
            act(&mut g, &seats, &mut rng, seat, &path).unwrap();
            assert_eq!(g.finished(), i == 2);
        }
        assert!(g.finished(), "三個人都走滿了");
        let o = g.outcome.clone().unwrap();
        assert_eq!(o.reason, End::Limit);
        assert_eq!(o.ranking[0], 1, "剩下的距離比較短的贏");
        assert_eq!(g.view(None, Instant::now())["result"]["reason"], "limit");
    }

    #[test]
    fn players_without_moves_are_skipped() {
        let seats = seats(2, 0);
        let mut rng = Rng::new();
        let mut g = start(&Options::default(), None, &seats, &mut rng);
        // 整個棋盤塞滿座位 1 的棋（數量不合理沒關係），只空出左下角的尖端：座位 0（右上）動不了
        let hole = GEO.at(TIPS[3]).unwrap();
        for c in 0..CELLS {
            if g.board[c] != 0 {
                g.board[c] = 1;
            }
        }
        g.board[usize::from(hole)] = EMPTY;
        assert!(!g.has_move(0));
        assert!(g.has_move(1));
        let mut out = Outbox::default();
        g.begin_turn(0, &mut test_ctx(Instant::now(), &mut rng, &seats, &mut out));
        assert_eq!(g.turn, 1);
        assert_eq!(g.moves[0], 1, "跳過也算一手");
    }

    #[test]
    fn timeouts_and_disconnects_are_covered_by_the_computer() {
        let seats = seats(2, 0);
        let mut rng = Rng::new();
        let o = Options { think_secs: 15, ..Options::default() };
        let mut g = start(&o, None, &seats, &mut rng);
        let first = g.turn;
        let mut out = Outbox::default();
        let soon = Instant::now() + Duration::from_secs(5);
        g.tick(&mut test_ctx(soon, &mut rng, &seats, &mut out));
        assert_eq!(g.move_no, 0, "時間還沒到");
        let later = Instant::now() + Duration::from_secs(16);
        g.tick(&mut test_ctx(later, &mut rng, &seats, &mut out));
        assert_eq!(g.move_no, 1, "時間到由電腦代走");
        assert_eq!(g.moves[first], 1);
        assert_eq!(g.turn, 1 - first);
        // 斷線的人等 5 秒就代走，不用等滿思考時間
        let second = g.turn;
        g.presence(second, false, &mut test_ctx(later, &mut rng, &seats, &mut out));
        g.tick(&mut test_ctx(later + Duration::from_secs(2), &mut rng, &seats, &mut out));
        assert_eq!(g.move_no, 1);
        g.tick(&mut test_ctx(later + OFFLINE_WAIT, &mut rng, &seats, &mut out));
        assert_eq!(g.move_no, 2);
        assert!(g.covered[second]);
        assert_conserved(&g);
    }

    #[test]
    fn options_are_checked() {
        assert!(ChineseCheckers::check_options(Options { think_secs: 7, ..Options::default() }).is_err());
        let o =
            ChineseCheckers::check_options(Options { think_secs: 0, long_jumps: true, full_ranking: true }).unwrap();
        assert_eq!(o.think_secs, 0);
        let parsed: Options = serde_json::from_value(json!({ "longJumps": true })).unwrap();
        assert_eq!(parsed, Options { long_jumps: true, ..Options::default() });
    }

    #[test]
    fn views_show_the_whole_board() {
        let seats = seats(4, 0);
        let mut rng = Rng::new();
        let g = start(&Options::default(), None, &seats, &mut rng);
        let view = g.view(Some(2), Instant::now());
        let board = view["board"].as_str().unwrap();
        assert_eq!(board.len(), CELLS);
        for s in 0..4 {
            assert_eq!(board.chars().filter(|&c| c == char::from(b'0' + s as u8)).count(), PIECES);
        }
        assert_eq!(view["corners"], json!([0, 1, 3, 4]));
        assert_eq!(view["you"], 2);
        assert_eq!(view["seats"][0]["progress"], 0);
        assert!(view["result"].is_null());
        assert!(g.view(None, Instant::now())["you"].is_null());
    }

    /// 跑一局到結束（全部由電腦走），回傳結束的原因
    fn play_out(g: &mut ChineseCheckers, seats: &[SeatInfo], rng: &mut Rng) -> End {
        for _ in 0..(MOVE_LIMIT as usize + 1) * 6 {
            if g.finished() {
                break;
            }
            let seat = g.turn;
            let path = g.bot_choice(seat, rng).expect("begin_turn 確認過有棋能走");
            assert!(check_path(&g.board, seat, &path, g.options.long_jumps).is_ok(), "電腦只走合法的棋：{path:?}");
            act(g, seats, rng, seat, &path).unwrap_or_else(|e| panic!("座位 {seat}：{e}"));
        }
        assert!(g.finished(), "一局一定會結束");
        assert_conserved(g);
        g.outcome.as_ref().unwrap().reason
    }

    #[test]
    fn bots_finish_games_for_every_player_count() {
        let mut rng = Rng::new();
        for long_jumps in [false, true] {
            for n in 2..=6 {
                let seats = seats(n, n);
                let mut previous: Option<ChineseCheckers> = None;
                for _ in 0..6 {
                    let o = Options { long_jumps, full_ranking: true, ..Options::default() };
                    let mut g = start(&o, previous.as_ref(), &seats, &mut rng);
                    let reason = play_out(&mut g, &seats, &mut rng);
                    assert_eq!(reason, End::Finish, "{n} 人、長跳 {long_jumps}：電腦應該走得完，不會卡到步數上限");
                    let most = g.moves.iter().max().unwrap();
                    assert!(*most < 120, "{n} 人走了 {most} 手");
                    let o = g.outcome.as_ref().unwrap();
                    assert_eq!(o.ranking.len(), n);
                    previous = Some(g);
                }
            }
        }
    }

    /// 電腦互打一局要走幾手：`cargo test --lib game_lengths -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn game_lengths() {
        let mut rng = Rng::new();
        for long_jumps in [false, true] {
            for n in 2..=6 {
                let seats = seats(n, n);
                let mut first = Vec::new();
                let mut most = 0;
                for _ in 0..30 {
                    let o = Options { long_jumps, full_ranking: true, ..Options::default() };
                    let mut g = start(&o, None, &seats, &mut rng);
                    let mut winner_moves = None;
                    while !g.finished() {
                        let seat = g.turn;
                        let path = g.bot_choice(seat, &mut rng).unwrap();
                        act(&mut g, &seats, &mut rng, seat, &path).unwrap();
                        if winner_moves.is_none() && !g.done.is_empty() {
                            winner_moves = Some(g.moves[g.done[0]]);
                        }
                    }
                    first.push(winner_moves.unwrap_or(MOVE_LIMIT));
                    most = most.max(*g.moves.iter().max().unwrap());
                }
                let avg = f64::from(first.iter().sum::<u32>()) / first.len() as f64;
                println!("{n} 人、長跳 {long_jumps}：第一名平均 {avg:.1} 手，排完名次最多 {most} 手");
            }
        }
    }

    #[test]
    fn bots_also_run_through_the_tick() {
        let mut rng = Rng::new();
        for n in [2, 3, 6] {
            let seats = seats(n, n);
            let mut g = start(&Options::default(), None, &seats, &mut rng);
            let mut now = Instant::now();
            for _ in 0..10_000 {
                if g.finished() {
                    break;
                }
                now += Duration::from_millis(500);
                let mut out = Outbox::default();
                g.tick(&mut test_ctx(now, &mut rng, &seats, &mut out));
            }
            assert!(g.finished());
            assert_conserved(&g);
            assert_eq!(g.done.len(), 1, "預設第一個人走完就結束");
        }
    }
}
