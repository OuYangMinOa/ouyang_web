//! 迷宮塔防的一塊場地：格子、塔、怪物，每一步（`DT` 秒）推進一次。規則和房間見 `towerdefense.rs`，數值在 `towerdefense_spec.rs`。
//!
//! - **迷宮**：怪物可以往八個方向走，但不能從兩座斜對角的塔中間鑽過去（斜走時旁邊兩格都要是空的）。
//!   每一路（入口 → 出口）各有一張「到出口還有多遠」的表（`Route::dist`，直走 10、斜走 14），塔蓋了、賣了就重算；
//!   怪物走到一格的中心時，挑旁邊離出口最近的那一格當下一站，一樣近就照原本的方向直走。
//! - **不能堵死**：蓋塔前先檢查每一路的入口、每一隻怪物正要去的那一格都還走得到出口（`can_build`）。
//!   能不能走到只看上下左右四個方向就夠了：斜走的條件是旁邊兩格都空，一定可以換成兩步直走。
//! - **飛行的怪**不看迷宮，從入口直直飛向出口。
//! - **攻擊**：塔開火時先記一筆「幾秒後打到」（`Pending`，照距離和砲彈速度算），到了才扣血，畫面上砲彈飛到時血才掉。
//!   單體的塔會避開「路上的砲彈已經夠打死」的怪，不然好幾座塔會一起打同一隻、浪費火力。
//!
//! 場地不知道誰是誰、也不管錢：打倒、漏掉的怪記在 `kills`、`leaks`，由 `towerdefense.rs` 每一步拿走去算。

use std::{cmp::Reverse, collections::BinaryHeap};

use crate::towerdefense_spec::{
    BUILD_TIME, CHAIN_FALLOFF, CHAIN_REACH, Group, MAX_LEVEL, MapData, Mode, MonsterKind, PIERCE, Tile, TowerKind,
};

/// 模擬的一步是幾秒（房間每個 tick 走幾步看遊戲速度）
pub const DT: f64 = 0.1;

const ORTH: u32 = 10;
const DIAG: u32 = 14;
const UNREACHABLE: u32 = u32::MAX;
/// 八個方向，前四個是上下左右
const DIRS: [(i32, i32); 8] = [(1, 0), (0, 1), (-1, 0), (0, -1), (1, 1), (-1, 1), (-1, -1), (1, -1)];
const NO_DIR: usize = 8;
/// 怪物狀態的編碼用的 64 個字（`encode`）
const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// 一路：入口、出口、每一格到出口的距離、目前會走的路線（給畫面畫）
pub struct Route {
    pub spawn: usize,
    pub exit: usize,
    dist: Vec<u32>,
    pub path: Vec<usize>,
}

pub struct Tower {
    pub id: u32,
    pub cell: usize,
    pub kind: TowerKind,
    /// 1～`MAX_LEVEL`
    pub level: u8,
    /// 誰蓋的（座位）
    pub owner: usize,
    pub mode: Mode,
    cooldown: f32,
    active_at: f64,
    /// 一共花了多少錢（賣掉時照這個退）
    pub spent: u32,
    pub kills: u32,
    pub damage: f64,
    /// 號角塔給的傷害加成
    buff: f32,
}

pub struct Monster {
    pub id: u32,
    pub kind: MonsterKind,
    route: usize,
    pub x: f32,
    pub y: f32,
    /// 正要走去的那一格
    to: usize,
    dir: usize,
    pub hp: f32,
    pub max_hp: f32,
    /// 這隻怪出生時那一波的基準血量、賞金（分裂出來的照這個算）
    base_hp: f32,
    base_bounty: f32,
    pub bounty: u32,
    speed: f32,
    slow: f32,
    slow_until: f64,
    poison: f32,
    poison_until: f64,
    poison_by: (usize, u32),
    /// 還在路上、打到就會扣的傷害
    incoming: f32,
    /// 被關住了（照理不會發生）：不管迷宮直接走向出口
    stray: bool,
    /// 對抗模式：誰派來的
    pub sent_by: Option<usize>,
    dead: bool,
    leaked: bool,
    killer: (usize, u32),
}

/// 排好要出場的怪
#[derive(Clone, Copy)]
pub struct Spawn {
    pub at: f64,
    pub kind: MonsterKind,
    pub route: usize,
    /// 這一波的基準血量、賞金（還沒乘上怪物自己的倍率）
    pub hp: f32,
    pub bounty: f32,
    pub sent_by: Option<usize>,
    /// 是這一波的怪（不是別人派來的）
    pub wave: bool,
}

/// 還在飛的一發
struct Pending {
    at: f64,
    tower: u32,
    owner: usize,
    kind: TowerKind,
    level: u8,
    target: u32,
    x: f32,
    y: f32,
    damage: f32,
    /// 開火時算進 `Monster::incoming` 的量
    counted: f32,
}

pub struct Kill {
    /// 打倒牠的塔是誰的
    pub owner: usize,
    pub bounty: u32,
    pub sent_by: Option<usize>,
}

pub struct Field {
    pub w: usize,
    pub h: usize,
    tiles: Vec<Tile>,
    /// 岩石或塔：怪物不能走
    blocked: Vec<bool>,
    /// 這一格的塔的 id，0 是沒有
    tower_at: Vec<u32>,
    pub routes: Vec<Route>,
    /// 照 id 由小到大排
    pub towers: Vec<Tower>,
    pub monsters: Vec<Monster>,
    pending: Vec<Pending>,
    spawns: Vec<Spawn>,
    pub lives: i32,
    /// 塔每變一次加一，用戶端靠它把 view 和之後的事件接起來
    pub rev: u32,
    pub time: f64,
    next_tower: u32,
    next_monster: u32,
    seed: u32,
    /// 這幾樣是「上次拿走之後」累積的，`towerdefense.rs` 每一步拿走
    pub shots: Vec<Vec<u32>>,
    pub kills: Vec<Kill>,
    pub leaks: Vec<u32>,
    /// 每個座位打出的傷害
    pub dealt: Vec<f64>,
}

fn distances(w: usize, h: usize, blocked: &[bool], exit: usize) -> Vec<u32> {
    let mut dist = vec![UNREACHABLE; w * h];
    let mut heap = BinaryHeap::new();
    dist[exit] = 0;
    heap.push(Reverse((0u32, exit)));
    while let Some(Reverse((d, c))) = heap.pop() {
        if d > dist[c] {
            continue;
        }
        for i in 0..8 {
            let Some(n) = neighbor(w, h, blocked, c, i) else { continue };
            let nd = d + if i < 4 { ORTH } else { DIAG };
            if nd < dist[n] {
                dist[n] = nd;
                heap.push(Reverse((nd, n)));
            }
        }
    }
    dist
}

/// 從 `c` 往第 `i` 個方向走得到的那一格（出界、被擋住、斜走會擦到角都是 None）
fn neighbor(w: usize, h: usize, blocked: &[bool], c: usize, i: usize) -> Option<usize> {
    let (dx, dy) = DIRS[i];
    let (cx, cy) = ((c % w) as i32, (c / w) as i32);
    let (nx, ny) = (cx + dx, cy + dy);
    if nx < 0 || ny < 0 || nx >= w as i32 || ny >= h as i32 {
        return None;
    }
    let n = ny as usize * w + nx as usize;
    if blocked[n] {
        return None;
    }
    if i >= 4 && (blocked[cy as usize * w + nx as usize] || blocked[ny as usize * w + cx as usize]) {
        return None;
    }
    Some(n)
}

/// 下一站：旁邊離出口最近的那一格，一樣近就先照原本的方向（`dir`）走。回傳（格子, 方向）
fn next_cell(w: usize, h: usize, blocked: &[bool], dist: &[u32], c: usize, dir: usize) -> Option<(usize, usize)> {
    let mut best: Option<(u32, usize, usize)> = None;
    let mut consider = |i: usize| {
        let Some(n) = neighbor(w, h, blocked, c, i) else { return };
        if dist[n] == UNREACHABLE {
            return;
        }
        let cost = dist[n] + if i < 4 { ORTH } else { DIAG };
        if best.is_none_or(|(b, _, _)| cost < b) {
            best = Some((cost, n, i));
        }
    };
    if dir < 8 {
        consider(dir);
    }
    for i in 0..8 {
        consider(i);
    }
    best.map(|(_, n, i)| (n, i))
}

/// 從入口照 `next_cell` 一路走到出口經過的格子
fn trace(w: usize, h: usize, blocked: &[bool], dist: &[u32], spawn: usize, exit: usize) -> Vec<usize> {
    let mut path = vec![spawn];
    let (mut c, mut dir) = (spawn, NO_DIR);
    while c != exit && path.len() <= w * h {
        let Some((n, d)) = next_cell(w, h, blocked, dist, c, dir) else { break };
        (c, dir) = (n, d);
        path.push(c);
    }
    path
}

/// 從 `from` 只走上下左右、不經過擋住的格子，到得了哪些格子
fn flood(w: usize, h: usize, blocked: &[bool], from: usize) -> Vec<bool> {
    let mut seen = vec![false; w * h];
    let mut stack = vec![from];
    seen[from] = true;
    while let Some(c) = stack.pop() {
        for i in 0..4 {
            if let Some(n) = neighbor(w, h, blocked, c, i)
                && !seen[n]
            {
                seen[n] = true;
                stack.push(n);
            }
        }
    }
    seen
}

impl Field {
    pub fn new(map: &MapData, lives: i32, seed: u32) -> Self {
        let blocked: Vec<bool> = map.tiles.iter().map(|&t| t == Tile::Rock).collect();
        let routes =
            map.routes.iter().map(|&(spawn, exit)| Route { spawn, exit, dist: Vec::new(), path: Vec::new() }).collect();
        let mut field = Self {
            w: map.w,
            h: map.h,
            tiles: map.tiles.clone(),
            blocked,
            tower_at: vec![0; map.w * map.h],
            routes,
            towers: Vec::new(),
            monsters: Vec::new(),
            pending: Vec::new(),
            spawns: Vec::new(),
            lives,
            rev: 0,
            time: 0.0,
            next_tower: 1,
            next_monster: 1,
            seed: seed | 1,
            shots: Vec::new(),
            kills: Vec::new(),
            leaks: Vec::new(),
            dealt: Vec::new(),
        };
        field.recompute();
        field
    }

    fn center(&self, cell: usize) -> (f32, f32) {
        ((cell % self.w) as f32 + 0.5, (cell / self.w) as f32 + 0.5)
    }

    fn cell_at(&self, x: f32, y: f32) -> usize {
        let cx = (x.max(0.0) as usize).min(self.w - 1);
        let cy = (y.max(0.0) as usize).min(self.h - 1);
        cy * self.w + cx
    }

    /// 0～1 的亂數（場地自己的，和房間的亂數分開，測試才重現得了）
    fn random(&mut self) -> f32 {
        self.seed ^= self.seed << 13;
        self.seed ^= self.seed >> 17;
        self.seed ^= self.seed << 5;
        (self.seed >> 8) as f32 / (1u32 << 24) as f32
    }

    /// 塔變了：重算每一路的距離和路線、號角的加成
    fn recompute(&mut self) {
        let (w, h) = (self.w, self.h);
        for route in &mut self.routes {
            route.dist = distances(w, h, &self.blocked, route.exit);
            route.path = trace(w, h, &self.blocked, &route.dist, route.spawn, route.exit);
        }
        let beacons: Vec<(f32, f32, f32, f32)> = self
            .towers
            .iter()
            .filter(|t| t.kind == TowerKind::Beacon)
            .map(|t| {
                let (x, y) = self.center(t.cell);
                let lv = t.kind.level(t.level);
                (x, y, lv.range, lv.buff)
            })
            .collect();
        for i in 0..self.towers.len() {
            let (x, y) = self.center(self.towers[i].cell);
            let t = &mut self.towers[i];
            t.buff = if t.kind == TowerKind::Beacon {
                0.0
            } else {
                beacons.iter().filter(|&&(bx, by, r, _)| (bx - x).hypot(by - y) <= r).map(|b| b.3).fold(0.0, f32::max)
            };
        }
    }

    // ---------- 蓋塔 ----------

    pub fn buildable(&self, cell: usize) -> bool {
        cell < self.tiles.len() && self.tiles[cell] == Tile::Ground && self.tower_at[cell] == 0
    }

    /// 這一格能不能蓋：是空地、沒有怪物站著，蓋了之後每一路和每一隻怪都還走得到出口
    pub fn can_build(&self, cell: usize) -> Result<(), &'static str> {
        if cell >= self.tiles.len() || self.tiles[cell] != Tile::Ground {
            return Err("這一格不能蓋塔");
        }
        if self.tower_at[cell] != 0 {
            return Err("這一格已經有塔了");
        }
        let walking = |m: &&Monster| !m.kind.spec().air && !m.stray;
        if self.monsters.iter().filter(walking).any(|m| m.to == cell || self.cell_at(m.x, m.y) == cell) {
            return Err("有怪物站在這一格，等牠走過去再蓋");
        }
        let mut blocked = self.blocked.clone();
        blocked[cell] = true;
        for (ri, route) in self.routes.iter().enumerate() {
            let reach = flood(self.w, self.h, &blocked, route.exit);
            if !reach[route.spawn] {
                return Err("不能把路完全堵死，要留一條路給怪物走");
            }
            if self.monsters.iter().filter(walking).any(|m| m.route == ri && !reach[m.to]) {
                return Err("這樣會把怪物關在裡面，等牠走過去再蓋");
            }
        }
        Ok(())
    }

    /// 蓋一座塔（錢由呼叫的人先檢查），回傳塔的 id
    pub fn build(&mut self, cell: usize, kind: TowerKind, owner: usize) -> Result<u32, &'static str> {
        self.can_build(cell)?;
        let id = self.next_tower;
        self.next_tower += 1;
        self.towers.push(Tower {
            id,
            cell,
            kind,
            level: 1,
            owner,
            mode: kind.default_mode(),
            cooldown: 0.0,
            active_at: self.time + BUILD_TIME,
            spent: kind.level(1).cost,
            kills: 0,
            damage: 0.0,
            buff: 0.0,
        });
        self.tower_at[cell] = id;
        self.blocked[cell] = true;
        self.rev += 1;
        self.recompute();
        Ok(id)
    }

    fn index(&self, id: u32) -> Option<usize> {
        self.towers.binary_search_by_key(&id, |t| t.id).ok()
    }

    pub fn tower(&self, id: u32) -> Option<&Tower> {
        self.index(id).map(|i| &self.towers[i])
    }

    /// 升一級要多少錢；已經最高級是 None
    pub fn upgrade_cost(&self, id: u32) -> Option<u32> {
        let t = self.tower(id)?;
        (usize::from(t.level) < MAX_LEVEL).then(|| t.kind.level(t.level + 1).cost)
    }

    pub fn upgrade(&mut self, id: u32) -> bool {
        let Some(cost) = self.upgrade_cost(id) else { return false };
        let Some(i) = self.index(id) else { return false };
        let t = &mut self.towers[i];
        t.level += 1;
        t.spent += cost;
        // 升級也要一點時間才繼續打
        t.active_at = t.active_at.max(self.time + BUILD_TIME);
        self.rev += 1;
        self.recompute();
        true
    }

    /// 拆掉一座塔，回傳它（退多少錢由呼叫的人算）
    pub fn sell(&mut self, id: u32) -> Option<Tower> {
        let i = self.index(id)?;
        let tower = self.towers.remove(i);
        self.tower_at[tower.cell] = 0;
        self.blocked[tower.cell] = false;
        self.pending.retain(|p| p.tower != id);
        self.rev += 1;
        self.recompute();
        Some(tower)
    }

    pub fn set_mode(&mut self, id: u32, mode: Mode) -> bool {
        let Some(i) = self.index(id) else { return false };
        self.towers[i].mode = mode;
        self.rev += 1;
        true
    }

    // ---------- 怪物 ----------

    pub fn enqueue(&mut self, spawn: Spawn) {
        self.spawns.push(spawn);
    }

    /// 把一波排進來：`hp`、`bounty` 是這一波的基準（難度、人數的倍率已經乘好了）。怪物輪流從每一個入口出來
    pub fn start_wave(&mut self, groups: &[Group], hp: f32, bounty: f32) {
        let routes = self.routes.len();
        let mut n = 0;
        for g in groups {
            for i in 0..g.count {
                self.spawns.push(Spawn {
                    at: self.time + f64::from(g.delay) + f64::from(g.gap) * f64::from(i),
                    kind: g.kind,
                    route: n % routes,
                    hp,
                    bounty,
                    sent_by: None,
                    wave: true,
                });
                n += 1;
            }
        }
    }

    /// 這一波的怪還沒出完
    pub fn spawning(&self) -> bool {
        self.spawns.iter().any(|s| s.wave)
    }

    /// 場上沒有怪、也沒有排著要出來的
    pub fn idle(&self) -> bool {
        self.monsters.is_empty() && self.spawns.is_empty()
    }

    /// 出局了：場上清空，塔留著但不會再動
    pub fn clear(&mut self) {
        self.monsters.clear();
        self.spawns.clear();
        self.pending.clear();
    }

    /// 生出一隻怪：站在 (x, y)，正要走去 `to`
    fn birth(&mut self, s: &Spawn, x: f32, y: f32, to: usize) {
        let Spawn { kind, route, hp, bounty, sent_by, .. } = *s;
        let spec = kind.spec();
        let id = self.next_monster;
        self.next_monster += 1;
        // 每隻的速度差一點點，一群怪才不會整整齊齊疊成一隻
        let speed = spec.speed * (0.96 + 0.08 * self.random());
        let max_hp = (hp * spec.hp).max(1.0);
        self.monsters.push(Monster {
            id,
            kind,
            route,
            x,
            y,
            to,
            dir: NO_DIR,
            hp: max_hp,
            max_hp,
            base_hp: hp,
            base_bounty: bounty,
            bounty: ((bounty * spec.bounty).round() as u32).max(1),
            speed,
            slow: 0.0,
            slow_until: 0.0,
            poison: 0.0,
            poison_until: 0.0,
            poison_by: (0, 0),
            incoming: 0.0,
            stray: false,
            sent_by,
            dead: false,
            leaked: false,
            killer: (0, 0),
        });
    }

    /// 離出口還有多遠（格）
    fn remaining(&self, m: &Monster) -> f32 {
        let route = &self.routes[m.route];
        if m.kind.spec().air || m.stray {
            let (ex, ey) = self.center(route.exit);
            return (ex - m.x).hypot(ey - m.y);
        }
        let (tx, ty) = self.center(m.to);
        let d = route.dist[m.to];
        (tx - m.x).hypot(ty - m.y) + if d == UNREACHABLE { 999.0 } else { d as f32 / ORTH as f32 }
    }

    fn step_spawns(&mut self) {
        let time = self.time;
        let mut i = 0;
        while i < self.spawns.len() {
            if self.spawns[i].at > time {
                i += 1;
                continue;
            }
            let mut s = self.spawns.swap_remove(i);
            s.route = s.route.min(self.routes.len() - 1);
            let cell = self.routes[s.route].spawn;
            let (x, y) = self.center(cell);
            self.birth(&s, x, y, cell);
        }
    }

    fn step_monsters(&mut self) {
        let (w, h, time) = (self.w, self.h, self.time);
        let center = |cell: usize| ((cell % w) as f32 + 0.5, (cell / w) as f32 + 0.5);
        for m in &mut self.monsters {
            let spec = m.kind.spec();
            let route = &self.routes[m.route];
            let slow = if time < m.slow_until { 1.0 - m.slow * spec.slowable } else { 1.0 };
            let mut left = m.speed * slow * DT as f32;
            if spec.air || m.stray {
                let (ex, ey) = center(route.exit);
                let d = (ex - m.x).hypot(ey - m.y);
                if d <= left {
                    m.leaked = true;
                } else {
                    m.x += (ex - m.x) / d * left;
                    m.y += (ey - m.y) / d * left;
                }
                continue;
            }
            // 一步可能走過好幾個格子的中心（跑得快的怪）
            for _ in 0..4 {
                let (tx, ty) = center(m.to);
                let d = (tx - m.x).hypot(ty - m.y);
                if d > left {
                    m.x += (tx - m.x) / d * left;
                    m.y += (ty - m.y) / d * left;
                    break;
                }
                m.x = tx;
                m.y = ty;
                left -= d;
                if m.to == route.exit {
                    m.leaked = true;
                    break;
                }
                match next_cell(w, h, &self.blocked, &route.dist, m.to, m.dir) {
                    Some((n, dir)) => {
                        m.to = n;
                        m.dir = dir;
                    }
                    None => {
                        m.stray = true;
                        break;
                    }
                }
            }
        }
    }

    /// 這座塔現在要打誰（`monsters` 的索引）
    fn pick(&self, ti: usize) -> Option<usize> {
        let t = &self.towers[ti];
        let spec = t.kind.spec();
        let lv = t.kind.level(t.level);
        let (tx, ty) = self.center(t.cell);
        let r2 = lv.range * lv.range;
        let mut best: Option<(bool, f32, usize)> = None;
        for (mi, m) in self.monsters.iter().enumerate() {
            if m.dead || m.leaked {
                continue;
            }
            let air = m.kind.spec().air;
            if (air && !spec.air) || (!air && !spec.ground) {
                continue;
            }
            let d2 = (m.x - tx).powi(2) + (m.y - ty).powi(2);
            if d2 > r2 {
                continue;
            }
            // 先打「還需要打」的：毒藤找沒中毒的、冰霜找沒變慢的，其他的避開路上的砲彈已經夠打死的
            let fresh = match t.kind {
                TowerKind::Poison => m.poison_until <= self.time + 0.3 || m.poison < lv.dot * 0.99,
                TowerKind::Frost => m.slow_until <= self.time + 0.3,
                _ => m.hp > m.incoming,
            };
            let score = match t.mode {
                Mode::First => -self.remaining(m),
                Mode::Last => self.remaining(m),
                Mode::Strong => m.hp,
                Mode::Weak => -m.hp,
                Mode::Near => -d2,
            };
            if best.is_none_or(|(f, s, _)| (fresh, score) > (f, s)) {
                best = Some((fresh, score, mi));
            }
        }
        best.map(|b| b.2)
    }

    fn step_towers(&mut self) {
        for ti in 0..self.towers.len() {
            let t = &mut self.towers[ti];
            if t.kind == TowerKind::Beacon {
                continue;
            }
            t.cooldown -= DT as f32;
            if t.cooldown > 0.0 || self.time < t.active_at {
                t.cooldown = t.cooldown.max(0.0);
                continue;
            }
            let Some(mi) = self.pick(ti) else {
                // 沒東西打：下一步有怪進來就馬上開火
                self.towers[ti].cooldown = 0.0;
                continue;
            };
            let t = &mut self.towers[ti];
            let (id, kind, level, owner) = (t.id, t.kind, t.level, t.owner);
            let lv = kind.level(level);
            t.cooldown += lv.cooldown;
            let damage = lv.damage * (1.0 + t.buff);
            let (tx, ty) = self.center(self.towers[ti].cell);
            if kind == TowerKind::Tesla {
                // 閃電馬上打到，再往最近的還沒被電到的怪跳
                let mut hit = vec![mi];
                let mut ids = vec![id, self.monsters[mi].id];
                let (mut px, mut py) = (self.monsters[mi].x, self.monsters[mi].y);
                for _ in 1..lv.chain {
                    let next = self
                        .monsters
                        .iter()
                        .enumerate()
                        .filter(|(i, m)| !m.dead && !m.leaked && !hit.contains(i))
                        .map(|(i, m)| (i, (m.x - px).powi(2) + (m.y - py).powi(2)))
                        .filter(|&(_, d2)| d2 <= CHAIN_REACH * CHAIN_REACH)
                        .min_by(|a, b| a.1.total_cmp(&b.1));
                    let Some((i, _)) = next else { break };
                    hit.push(i);
                    ids.push(self.monsters[i].id);
                    (px, py) = (self.monsters[i].x, self.monsters[i].y);
                }
                let mut amount = damage;
                for i in hit {
                    self.hurt(i, amount, true, false, owner, id);
                    amount *= CHAIN_FALLOFF;
                }
                self.shots.push(ids);
                continue;
            }
            let spec = kind.spec();
            let m = &mut self.monsters[mi];
            let flight = if spec.shot_speed > 0.0 { (m.x - tx).hypot(m.y - ty) / spec.shot_speed } else { 0.0 };
            // 單體的塔：把這一發算進「路上的傷害」，別的塔就不會再多打一發已經死定的怪
            let counted = match kind {
                TowerKind::Bolt => damage * m.kind.spec().phys,
                TowerKind::Sniper => damage * pierced(m.kind.spec().phys),
                _ => 0.0,
            };
            m.incoming += counted;
            self.pending.push(Pending {
                at: self.time + f64::from(flight),
                tower: id,
                owner,
                kind,
                level,
                target: m.id,
                x: m.x,
                y: m.y,
                damage,
                counted,
            });
            self.shots.push(vec![id, m.id]);
        }
    }

    /// 飛到的砲彈扣血、減速、下毒
    fn step_hits(&mut self) {
        let time = self.time;
        let mut i = 0;
        while i < self.pending.len() {
            if self.pending[i].at > time {
                i += 1;
                continue;
            }
            let p = self.pending.swap_remove(i);
            let lv = p.kind.level(p.level);
            let target = self.monsters.iter().position(|m| m.id == p.target && !m.leaked);
            // 範圍傷害炸在目標現在的位置；目標已經不在了就炸在開火時的位置
            let (x, y) = target.map_or((p.x, p.y), |mi| (self.monsters[mi].x, self.monsters[mi].y));
            match p.kind {
                TowerKind::Bolt | TowerKind::Sniper => {
                    if let Some(mi) = target {
                        self.monsters[mi].incoming -= p.counted;
                        self.hurt(mi, p.damage, false, p.kind == TowerKind::Sniper, p.owner, p.tower);
                    }
                }
                TowerKind::Cannon | TowerKind::Frost => {
                    let frost = p.kind == TowerKind::Frost;
                    for mi in 0..self.monsters.len() {
                        let m = &mut self.monsters[mi];
                        if (m.kind.spec().air && !frost) || (m.x - x).hypot(m.y - y) > lv.splash {
                            continue;
                        }
                        if frost && (lv.slow >= m.slow || m.slow_until <= time) {
                            m.slow = lv.slow;
                            m.slow_until = time + f64::from(lv.duration);
                        }
                        self.hurt(mi, p.damage, frost, false, p.owner, p.tower);
                    }
                }
                TowerKind::Poison => {
                    if let Some(mi) = target {
                        let m = &mut self.monsters[mi];
                        // 傷害加成也算在毒上：開火時的傷害是「基本傷害 ×（1 + 加成）」
                        let dot = lv.dot * p.damage / lv.damage.max(0.01);
                        if dot >= m.poison || m.poison_until <= time {
                            m.poison = dot;
                            m.poison_until = time + f64::from(lv.duration);
                            m.poison_by = (p.owner, p.tower);
                        }
                        self.hurt(mi, p.damage, true, false, p.owner, p.tower);
                    }
                }
                TowerKind::Tesla | TowerKind::Beacon => {}
            }
        }
    }

    fn hurt(&mut self, mi: usize, amount: f32, magic: bool, pierce: bool, owner: usize, tower: u32) {
        let m = &mut self.monsters[mi];
        if m.dead || m.leaked {
            return;
        }
        let spec = m.kind.spec();
        let taken = if magic {
            spec.magic
        } else if pierce {
            pierced(spec.phys)
        } else {
            spec.phys
        };
        let dealt = (amount * taken).min(m.hp);
        m.hp -= dealt;
        let killed = m.hp <= 0.01;
        if killed {
            m.dead = true;
            m.killer = (owner, tower);
        }
        if self.dealt.len() <= owner {
            self.dealt.resize(owner + 1, 0.0);
        }
        self.dealt[owner] += f64::from(dealt);
        if let Some(i) = self.index(tower) {
            self.towers[i].damage += f64::from(dealt);
            self.towers[i].kills += u32::from(killed);
        }
    }

    /// 中毒扣血、樹精回血
    fn step_effects(&mut self) {
        let time = self.time;
        for mi in 0..self.monsters.len() {
            let m = &mut self.monsters[mi];
            if m.poison_until > time {
                let (amount, (owner, tower)) = (m.poison * DT as f32, m.poison_by);
                self.hurt(mi, amount, true, false, owner, tower);
            } else {
                let regen = m.kind.spec().regen;
                if regen > 0.0 {
                    m.hp = (m.hp + m.max_hp * regen * DT as f32).min(m.max_hp);
                }
            }
        }
    }

    /// 把打倒的、走到出口的清掉，分裂的生出小的
    fn step_cleanup(&mut self) {
        let mut born: Vec<(Spawn, f32, f32, usize)> = Vec::new();
        for m in &self.monsters {
            let spec = m.kind.spec();
            if m.dead {
                self.kills.push(Kill { owner: m.killer.0, bounty: m.bounty, sent_by: m.sent_by });
                if let Some((child, count)) = spec.split {
                    for _ in 0..count {
                        let small = Spawn {
                            at: self.time,
                            kind: child,
                            route: m.route,
                            hp: m.base_hp,
                            bounty: m.base_bounty,
                            sent_by: m.sent_by,
                            wave: false,
                        };
                        born.push((small, m.x, m.y, m.to));
                    }
                }
            } else if m.leaked {
                self.lives -= spec.lives as i32;
                self.leaks.push(m.id);
            }
        }
        self.monsters.retain(|m| !m.dead && !m.leaked);
        for (small, x, y, to) in born {
            // 小的散開一點，不要全部疊在同一點
            let (dx, dy) = ((self.random() - 0.5) * 0.3, (self.random() - 0.5) * 0.3);
            self.birth(&small, x + dx, y + dy, to);
        }
    }

    /// 推進一步（`DT` 秒）
    pub fn step(&mut self) {
        self.time += DT;
        self.step_spawns();
        self.step_monsters();
        self.step_towers();
        self.step_hits();
        self.step_effects();
        self.step_cleanup();
    }

    /// 場上所有怪物現在的樣子，一隻 10 個字（`B64`）：id 3 個字、種類 1、x 和 y 各 2（(座標 + 1) × 64）、
    /// 血量 1（1～63，最大血量的幾分之幾）、狀態 1（1 變慢、2 中毒、4 別人派來的）。
    /// 每個 tick 送一次，用戶端在兩次之間內插；解碼在 `frontend/src/games/towerdefense/online.ts`
    pub fn encode(&self) -> String {
        let mut out = String::with_capacity(self.monsters.len() * 10);
        let mut put = |value: u32, chars: u32| {
            for k in (0..chars).rev() {
                out.push(B64[((value >> (6 * k)) & 63) as usize] as char);
            }
        };
        for m in &self.monsters {
            let coord = |v: f32| ((v + 1.0) * 64.0).round().clamp(0.0, 4095.0) as u32;
            let status = u32::from(self.time < m.slow_until)
                | u32::from(self.time < m.poison_until) << 1
                | u32::from(m.sent_by.is_some()) << 2;
            put(m.id & 0x3_FFFF, 3);
            put(m.kind as u32, 1);
            put(coord(m.x), 2);
            put(coord(m.y), 2);
            put(((m.hp / m.max_hp * 63.0).ceil() as u32).clamp(1, 63), 1);
            put(status, 1);
        }
        out
    }

    // ---------- 給電腦玩家看的 ----------

    /// 所有路線加起來多長（直走一格 10）；有一路走不通是 None
    pub fn path_len(&self) -> Option<u32> {
        self.routes.iter().map(|r| Some(r.dist[r.spawn]).filter(|&d| d != UNREACHABLE)).sum()
    }

    /// 把 `cells` 全部蓋起來之後所有路線加起來多長；有一路被堵死是 None（電腦規劃一整道牆用，不看怪物站在哪）
    pub fn path_len_with(&self, cells: &[usize]) -> Option<u32> {
        let mut blocked = self.blocked.clone();
        for &c in cells {
            blocked[c] = true;
        }
        self.routes
            .iter()
            .map(|r| Some(distances(self.w, self.h, &blocked, r.exit)[r.spawn]).filter(|&d| d != UNREACHABLE))
            .sum()
    }

    /// 把 `cells` 全部蓋起來之後，路線會經過哪些格子（電腦規劃好迷宮後，這些格子要留給怪物走）
    pub fn path_cells_with(&self, cells: &[usize]) -> Vec<usize> {
        let mut blocked = self.blocked.clone();
        for &c in cells {
            blocked[c] = true;
        }
        let mut all = Vec::new();
        for r in &self.routes {
            let dist = distances(self.w, self.h, &blocked, r.exit);
            all.extend(trace(self.w, self.h, &blocked, &dist, r.spawn, r.exit));
        }
        all
    }

    /// 站在 `cell`、射程 `range` 的塔打得到路線上的幾格（每一路都算；`air` 是連飛行的直線也算）
    pub fn coverage(&self, cell: usize, range: f32, air: bool) -> f32 {
        let (x, y) = self.center(cell);
        let mut seen = vec![false; self.w * self.h];
        let mut total = 0.0;
        for route in &self.routes {
            for &c in &route.path {
                if !seen[c] {
                    seen[c] = true;
                    let (cx, cy) = self.center(c);
                    if (cx - x).hypot(cy - y) <= range {
                        total += 1.0;
                    }
                }
            }
            if air {
                total += self.air_coverage(route, x, y, range) * 0.5;
            }
        }
        total
    }

    /// 飛行的怪從入口直飛出口，這條線有幾格在射程內
    fn air_coverage(&self, route: &Route, x: f32, y: f32, range: f32) -> f32 {
        let (sx, sy) = self.center(route.spawn);
        let (ex, ey) = self.center(route.exit);
        let steps = ((ex - sx).hypot(ey - sy).ceil() as usize).max(1);
        (0..=steps)
            .filter(|&i| {
                let t = i as f32 / steps as f32;
                (sx + (ex - sx) * t - x).hypot(sy + (ey - sy) * t - y) <= range
            })
            .count() as f32
    }

    /// 只算飛行路線的覆蓋（電腦補防空用）
    pub fn air_cover(&self, cell: usize, range: f32) -> f32 {
        let (x, y) = self.center(cell);
        self.routes.iter().map(|r| self.air_coverage(r, x, y, range)).sum()
    }

    /// `cell` 離目前的路線最近幾格
    pub fn path_distance(&self, cell: usize) -> f32 {
        let (x, y) = self.center(cell);
        self.routes
            .iter()
            .flat_map(|r| r.path.iter())
            .map(|&c| {
                let (cx, cy) = self.center(c);
                (cx - x).hypot(cy - y)
            })
            .fold(f32::MAX, f32::min)
    }

    /// 目前路線經過的格子（每一路都算，不重複）
    pub fn path_cells(&self) -> Vec<usize> {
        let mut seen = vec![false; self.w * self.h];
        let mut cells = Vec::new();
        for route in &self.routes {
            for &c in &route.path {
                if !seen[c] {
                    seen[c] = true;
                    cells.push(c);
                }
            }
        }
        cells
    }

    #[cfg(test)]
    pub fn monster_at(&self, id: u32) -> Option<(f32, f32)> {
        self.monsters.iter().find(|m| m.id == id).map(|m| (m.x, m.y))
    }
}

fn pierced(phys: f32) -> f32 {
    phys + (1.0 - phys) * PIERCE
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::towerdefense_spec::{map, wave_bounty, wave_hp};

    fn plains() -> Field {
        Field::new(map("plains").unwrap(), 20, 7)
    }

    fn cell(f: &Field, x: usize, y: usize) -> usize {
        y * f.w + x
    }

    fn spawn(f: &mut Field, kind: MonsterKind, hp: f32) {
        let at = f.time;
        f.enqueue(Spawn { at, kind, route: 0, hp, bounty: 5.0, sent_by: None, wave: true });
    }

    fn run(f: &mut Field, secs: f64) {
        for _ in 0..(secs / DT).round() as usize {
            f.step();
        }
    }

    #[test]
    fn the_route_runs_from_the_spawn_to_the_exit() {
        let f = plains();
        let route = &f.routes[0];
        assert_eq!(route.path.first(), Some(&route.spawn));
        assert_eq!(route.path.last(), Some(&route.exit));
        // 空場地：直直走過去，21 格寬所以走 20 步
        assert_eq!(route.path.len(), 21);
        assert_eq!(f.path_len(), Some(200));
    }

    #[test]
    fn monsters_walk_the_route_and_leak_at_the_exit() {
        let mut f = plains();
        spawn(&mut f, MonsterKind::Grunt, 100.0);
        run(&mut f, 1.0);
        assert_eq!(f.monsters.len(), 1);
        let (x, y) = f.monster_at(1).unwrap();
        assert!(x > 1.0 && x < 2.2, "走了大約一格：{x}");
        assert!((y - 6.5).abs() < 0.01);
        // 20 格、每秒 1.1 格左右，20 秒內走完
        run(&mut f, 20.0);
        assert!(f.monsters.is_empty());
        assert_eq!(f.lives, 19);
        assert_eq!(f.leaks, vec![1]);
        assert!(f.idle());
    }

    #[test]
    fn a_wall_makes_the_route_longer_but_cannot_seal_it() {
        let mut f = plains();
        // 在第 10 欄從上到下排一道牆，最後留一格
        for y in 0..f.h - 1 {
            let c = cell(&f, 10, y);
            assert_eq!(f.build(c, TowerKind::Bolt, 0).map(|_| ()), Ok(()), "第 {y} 列");
        }
        // 斜著走到最下面的缺口再斜著走回來：左右各 6 步斜的、4 步直的
        assert_eq!(f.path_len(), Some(2 * (6 * 14 + 4 * 10)));
        let last = cell(&f, 10, f.h - 1);
        assert_eq!(f.can_build(last), Err("不能把路完全堵死，要留一條路給怪物走"));
        assert_eq!(f.path_len_with(&[last]), None);
        // 路線經過留下的那個缺口
        assert!(f.routes[0].path.contains(&last));
        // 賣掉一座，路又變短
        let before = f.path_len().unwrap();
        let id = f.towers[6].id;
        assert!(f.sell(id).is_some());
        assert!(f.path_len().unwrap() < before);
        assert!(f.tower(id).is_none());
    }

    #[test]
    fn monsters_cannot_squeeze_between_diagonal_towers() {
        let mut f = plains();
        // 斜斜的一排塔從上面排到右下角把場地切開：塔和塔之間斜角的縫鑽不過去，所以最後一座蓋不了
        let h = f.h;
        for y in 0..h {
            let c = cell(&f, 8 + y, y);
            let result = f.build(c, TowerKind::Bolt, 0);
            if y + 1 < h {
                assert!(result.is_ok(), "第 {y} 座");
            } else {
                assert_eq!(result.err(), Some("不能把路完全堵死，要留一條路給怪物走"));
            }
        }
        // 只剩右下角那一格能過，路線一定經過它
        let gap = cell(&f, 8 + h - 1, h - 1);
        assert!(f.routes[0].path.contains(&gap));
    }

    #[test]
    fn cannot_build_on_rocks_walkways_towers_or_monsters() {
        let mut f = plains();
        assert_eq!(f.can_build(f.routes[0].spawn), Err("這一格不能蓋塔"));
        assert_eq!(f.can_build(cell(&f, 6, 2)), Err("這一格不能蓋塔"));
        assert_eq!(f.can_build(usize::MAX), Err("這一格不能蓋塔"));
        let c = cell(&f, 5, 5);
        f.build(c, TowerKind::Bolt, 0).unwrap();
        assert_eq!(f.can_build(c), Err("這一格已經有塔了"));
        spawn(&mut f, MonsterKind::Grunt, 1e9);
        run(&mut f, 3.0);
        let (x, y) = f.monster_at(1).unwrap();
        let under = f.cell_at(x, y);
        assert_eq!(f.can_build(under), Err("有怪物站在這一格，等牠走過去再蓋"));
    }

    #[test]
    fn towers_shoot_kill_and_report_the_bounty() {
        let mut f = plains();
        let c = cell(&f, 4, 5);
        let id = f.build(c, TowerKind::Bolt, 3).unwrap();
        spawn(&mut f, MonsterKind::Grunt, 25.0);
        run(&mut f, 8.0);
        assert!(f.monsters.is_empty());
        assert_eq!(f.lives, 20);
        assert_eq!(f.kills.len(), 1);
        assert_eq!(f.kills[0].owner, 3);
        assert_eq!(f.kills[0].bounty, 5);
        // 25 滴血、一發 10：打了三發
        assert_eq!(f.shots.len(), 3);
        assert_eq!(f.shots[0], vec![id, 1]);
        let t = f.tower(id).unwrap();
        assert_eq!(t.kills, 1);
        assert!((t.damage - 25.0).abs() < 0.01);
        assert!((f.dealt[3] - 25.0).abs() < 0.01);
    }

    #[test]
    fn single_target_towers_do_not_overkill() {
        let mut f = plains();
        // 兩座弩箭塔、兩隻一發就死的怪：不會兩座都打同一隻
        f.build(cell(&f, 4, 5), TowerKind::Bolt, 0).unwrap();
        f.build(cell(&f, 4, 7), TowerKind::Bolt, 0).unwrap();
        run(&mut f, 1.0);
        spawn(&mut f, MonsterKind::Grunt, 9.0);
        spawn(&mut f, MonsterKind::Grunt, 9.0);
        run(&mut f, 6.0);
        assert_eq!(f.kills.len(), 2);
        assert_eq!(f.shots.len(), 2, "{:?}", f.shots);
    }

    #[test]
    fn cannons_splash_but_cannot_reach_flyers() {
        let mut f = plains();
        f.build(cell(&f, 4, 5), TowerKind::Cannon, 0).unwrap();
        for _ in 0..4 {
            spawn(&mut f, MonsterKind::Swarm, 50.0);
        }
        spawn(&mut f, MonsterKind::Flyer, 50.0);
        run(&mut f, 9.0);
        // 四隻小蟲疊在一起，一發全部炸到（11 滴血、一發 20）
        assert_eq!(f.kills.len(), 4);
        assert_eq!(f.shots.len(), 1);
        // 蝙蝠沒人打
        assert_eq!(f.monsters.len(), 1);
        assert_eq!(f.monsters[0].kind, MonsterKind::Flyer);
        assert_eq!(f.monsters[0].hp, f.monsters[0].max_hp);
    }

    #[test]
    fn flyers_ignore_the_maze() {
        let mut f = plains();
        for y in 0..f.h - 1 {
            f.build(cell(&f, 10, y), TowerKind::Beacon, 0).unwrap();
        }
        spawn(&mut f, MonsterKind::Flyer, 1e9);
        run(&mut f, 8.0);
        let (x, y) = f.monster_at(1).unwrap();
        assert!(x > 11.0, "已經飛過牆了：{x}");
        assert!((y - 6.5).abs() < 0.01);
    }

    #[test]
    fn frost_slows_and_poison_stops_regeneration() {
        let mut slowed = plains();
        slowed.build(cell(&slowed, 3, 5), TowerKind::Frost, 0).unwrap();
        let mut free = plains();
        for f in [&mut slowed, &mut free] {
            spawn(f, MonsterKind::Grunt, 1e9);
            run(f, 4.0);
        }
        assert!(slowed.monster_at(1).unwrap().0 < free.monster_at(1).unwrap().0 - 0.3);

        let mut f = plains();
        f.build(cell(&f, 3, 5), TowerKind::Poison, 0).unwrap();
        spawn(&mut f, MonsterKind::Regen, 1000.0);
        run(&mut f, 4.0);
        let m = &f.monsters[0];
        assert!(m.poison_until > f.time);
        let lost = m.max_hp - m.hp;
        // 中毒時不回血：扣的血只會越來越多
        run(&mut f, 1.0);
        assert!(f.monsters[0].max_hp - f.monsters[0].hp > lost);
    }

    #[test]
    fn tesla_chains_and_armor_resists_physical_damage() {
        let mut f = plains();
        let id = f.build(cell(&f, 4, 5), TowerKind::Tesla, 0).unwrap();
        for _ in 0..3 {
            spawn(&mut f, MonsterKind::Brute, 1e6);
        }
        run(&mut f, 5.0);
        let first = f.shots.first().unwrap();
        assert_eq!(first[0], id);
        assert_eq!(first.len(), 4, "一次電三隻：{first:?}");
        // 鐵甲龜物理只吃 45%，重弩穿透六成
        assert!((pierced(0.45) - 0.78).abs() < 1e-6);
        let mut bolt = plains();
        bolt.build(cell(&bolt, 4, 5), TowerKind::Bolt, 0).unwrap();
        spawn(&mut bolt, MonsterKind::Brute, 1e6);
        run(&mut bolt, 5.0);
        let m = &bolt.monsters[0];
        let shots = bolt.shots.len() as f32;
        assert!((m.max_hp - m.hp - shots * 4.5).abs() < 5.0, "每發 10 × 0.45");
    }

    #[test]
    fn beacons_boost_nearby_towers_and_upgrades_cost_money() {
        let mut f = plains();
        let bolt = f.build(cell(&f, 4, 5), TowerKind::Bolt, 0).unwrap();
        assert_eq!(f.tower(bolt).unwrap().buff, 0.0);
        let beacon = f.build(cell(&f, 5, 5), TowerKind::Beacon, 1).unwrap();
        assert!((f.tower(bolt).unwrap().buff - 0.15).abs() < 1e-6);
        assert_eq!(f.upgrade_cost(beacon), Some(130));
        assert!(f.upgrade(beacon));
        assert!((f.tower(bolt).unwrap().buff - 0.25).abs() < 1e-6);
        assert_eq!(f.tower(beacon).unwrap().spent, 240);
        for _ in 0..2 {
            assert!(f.upgrade(beacon));
        }
        assert_eq!(f.upgrade_cost(beacon), None);
        assert!(!f.upgrade(beacon));
        f.sell(beacon).unwrap();
        assert_eq!(f.tower(bolt).unwrap().buff, 0.0);
    }

    #[test]
    fn splitters_burst_into_small_ones() {
        let mut f = plains();
        f.build(cell(&f, 4, 5), TowerKind::Sniper, 0).unwrap();
        spawn(&mut f, MonsterKind::Splitter, 20.0);
        run(&mut f, 3.2);
        assert_eq!(f.kills.len(), 1);
        assert_eq!(f.monsters.len(), 3);
        assert!(f.monsters.iter().all(|m| m.kind == MonsterKind::Mudling));
    }

    #[test]
    fn rerouted_monsters_never_get_stuck() {
        let mut f = plains();
        spawn(&mut f, MonsterKind::Grunt, 1e9);
        run(&mut f, 5.0);
        // 怪走到一半，在牠前面蓋一道牆
        for y in 2..11 {
            let c = cell(&f, 12, y);
            if f.can_build(c).is_ok() {
                f.build(c, TowerKind::Beacon, 0).unwrap();
            }
        }
        run(&mut f, 40.0);
        assert!(f.monsters.is_empty(), "繞過去走到出口了");
        assert_eq!(f.lives, 19);
    }

    #[test]
    fn a_wave_spreads_over_every_entrance() {
        let mut f = Field::new(map("forks").unwrap(), 20, 3);
        f.start_wave(&crate::towerdefense_spec::wave(1), wave_hp(1), wave_bounty(1));
        assert!(f.spawning());
        run(&mut f, 3.0);
        let top = f.monsters.iter().filter(|m| m.y < 7.0).count();
        let bottom = f.monsters.iter().filter(|m| m.y > 7.0).count();
        assert!(top >= 1 && bottom >= 1, "{top} / {bottom}");
        run(&mut f, 10.0);
        assert!(!f.spawning());
    }

    #[test]
    fn the_snapshot_is_ten_characters_per_monster() {
        let mut f = plains();
        spawn(&mut f, MonsterKind::Runner, 100.0);
        run(&mut f, 0.1);
        let text = f.encode();
        assert_eq!(text.len(), 10);
        let value = |s: &str| s.bytes().fold(0u32, |v, b| v * 64 + B64.iter().position(|&c| c == b).unwrap() as u32);
        assert_eq!(value(&text[0..3]), 1);
        assert_eq!(value(&text[3..4]), MonsterKind::Runner as u32);
        let (x, y) = f.monster_at(1).unwrap();
        assert!((value(&text[4..6]) as f32 / 64.0 - 1.0 - x).abs() < 0.01);
        assert!((value(&text[6..8]) as f32 / 64.0 - 1.0 - y).abs() < 0.01);
        assert_eq!(value(&text[8..9]), 63);
        assert_eq!(value(&text[9..10]), 0);
    }
}
