//! 迷宮塔防（派對房間的遊戲，房間本身見 `party.rs`；畫面在 `frontend/src/games/towerdefense/`）。
//!
//! 怪物一波一波從入口走向出口，玩家在空地上蓋塔：塔會擋路，怪物要繞過去，所以塔同時也是迷宮的牆，
//! 但不能把路完全堵死。1～8 人，兩種模式（房主選）：
//! - **合作**：大家守同一塊場地、共用生命，各自有各自的錢；每打倒一隻怪每個人都拿到賞金，怪物的血量跟著人數變多。
//!   撐過指定的波數就贏（也可以選無限，看能撐到第幾波）。
//! - **對抗**：每個人一塊自己的場地，出一樣的波次；可以花錢派怪去打別人（`Action::Send`），每派一次自己的收入就變多。
//!   生命歸零就出局，剩最後一個人贏。
//!
//! 和 3D 賽車、機甲對戰不同，**模擬全部在伺服器**（`towerdefense_field.rs`），用戶端只負責畫：
//! - 房間每個 `TICK`（0.1 秒）推進 1～3 步（看遊戲速度），再把每塊場地的怪物位置、這段時間的開火送出去（`tick` 事件）。
//!   只送給正在看那塊場地的人（對抗模式可以切去看別人的，`Action::Look`）；觀戰的人每一塊都收得到。
//! - 蓋塔、升級、拆掉都不重送整份 view，改送 `tower` 事件；view 裡有每塊場地的 `rev`（塔變一次加一），
//!   用戶端靠它把 view 裡的塔和之後的事件接起來（重連、中途進來觀戰的人從 view 拿回所有的塔）。
//! - view 只在大事發生時重送：新的一波、打完一波、有人出局、結束、改速度、有人斷線或回來。
//! - 沒有真人連著的時候整局停住，等有人回來再繼續（不然大家斷線重連回來已經輸了）。
//!
//! 波次：開局先有 `FIRST_BREAK` 排迷宮，之後每一波打完休息 `BREAK`；大家都按「準備好了」就提早開始。
//! 一波拖太久（`WAVE_CAP`）沒打完，下一波照樣出來。每一波開始時發補給金（`wave_bonus`，對抗模式再加上派兵賺來的收入）。
//!
//! 數值都在 `towerdefense_spec.rs`，電腦玩家在 `towerdefense_bot.rs`。

use std::{collections::HashMap, sync::Arc, time::Duration};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::time::Instant;

use crate::{
    AppState,
    party::{Ctx, Parties, PartyGame, To},
    towerdefense_bot::{Bot, BotLevel, Decision, Situation},
    towerdefense_field::{DT, Field, Spawn},
    towerdefense_spec::{
        self as spec, MapData, Mode, MonsterKind, REFUND, SEND_BOUNTY, SEND_HP, TowerKind, UNITS, wave, wave_bonus,
        wave_bounty, wave_hp,
    },
};

/// 開局到第一波的時間（遊戲時間，秒）：先排迷宮
const FIRST_BREAK: f64 = 30.0;
/// 一波打完到下一波
const BREAK: f64 = 10.0;
/// 一波開始後最久多久，沒打完下一波也照出
const WAVE_CAP: f64 = 55.0;
/// 大家都準備好了之後多久開始
const READY_DELAY: f64 = 1.5;
/// 開局每個人的錢
const START_GOLD: u32 = 300;
/// 合作模式每多一個人，怪物的血量多幾成
const COOP_HP: f32 = 0.8;
/// 派去的怪每隔幾秒出一隻
const SEND_GAP: f64 = 0.45;
/// 遊戲速度最快幾倍
const MAX_SPEED: u8 = 3;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GameMode {
    #[default]
    Coop,
    Versus,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Difficulty {
    Easy,
    #[default]
    Normal,
    Hard,
}

impl Difficulty {
    /// 怪物血量的倍率
    fn hp(self) -> f32 {
        match self {
            Self::Easy => 0.75,
            Self::Normal => 1.0,
            Self::Hard => 1.25,
        }
    }

    fn lives(self) -> i32 {
        match self {
            Self::Easy => 30,
            Self::Normal => 20,
            Self::Hard => 10,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Options {
    pub mode: GameMode,
    /// 地圖的 id（`towerdefense_spec.rs` 的 `MAPS`）
    pub map: String,
    pub difficulty: Difficulty,
    /// 合作模式要撐幾波（20／30／40），0 是無限；對抗模式不看這個
    pub waves: u32,
    /// 電腦玩家的強度
    pub bots: BotLevel,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            mode: GameMode::Coop,
            map: "plains".into(),
            difficulty: Difficulty::Normal,
            waves: 20,
            bots: BotLevel::Normal,
        }
    }
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Action {
    /// 在自己的場地（合作是共用的那一塊）第 `cell` 格蓋一座塔
    Build {
        cell: usize,
        kind: TowerKind,
    },
    Upgrade {
        id: u32,
    },
    Sell {
        id: u32,
    },
    /// 改一座塔先打誰
    Mode {
        id: u32,
        mode: Mode,
    },
    /// 準備好了：大家都好了就提早開始下一波
    Ready {
        ready: bool,
    },
    /// 對抗：派 `UNITS[unit]` 去打目標
    Send {
        unit: usize,
    },
    /// 對抗：指定要打誰；`null` 是自動（下一位還沒出局的人）
    Aim {
        seat: Option<usize>,
    },
    /// 合作：把錢分給隊友
    Give {
        seat: usize,
        amount: u32,
    },
    /// 對抗：切去看第 `field` 塊場地
    Look {
        field: usize,
    },
    /// 想要的遊戲速度（1～3）；實際的速度是連著線的真人裡最慢的那個
    Speed {
        speed: u8,
    },
}

struct Player {
    gold: u32,
    /// 對抗：派兵賺來的收入，每一波開始時發
    income: u32,
    /// 自己的場地
    field: usize,
    /// 正在看哪一塊場地
    look: usize,
    aim: Option<usize>,
    ready: bool,
    speed: u8,
    /// 對抗：出局了
    out: bool,
    place: Option<usize>,
    kills: u32,
    damage: f64,
    built: u32,
    sent: u32,
}

pub struct TowerDefense {
    /// 這個房間的第幾局（用戶端靠它知道換了一局）
    game: u32,
    options: Options,
    map: &'static MapData,
    /// 合作只有一塊，對抗是每個座位一塊（索引就是座位）
    fields: Vec<Field>,
    players: Vec<Player>,
    pids: Vec<u32>,
    bots: Vec<Option<Bot>>,
    online: Vec<bool>,
    /// 房間的 tick 數（不管遊戲速度，每 0.1 秒加一），用戶端拿來對時、內插
    tick: u32,
    /// 遊戲時間（秒）
    time: f64,
    /// 已經出到第幾波，0 是還沒開始
    wave: u32,
    wave_started: f64,
    /// 下一波什麼時候開始；None 是這一波還在打
    next_at: Option<f64>,
    hp_scale: f32,
    ended: bool,
    /// 合作：贏了沒
    won: Option<bool>,
    /// 對抗：誰贏了
    winner: Option<usize>,
    /// 每個人在這個房間贏了幾局（合作是一起贏）
    wins: HashMap<u32, u32>,
    /// 合作：這個房間最多撐過幾波
    best: u32,
    /// 電腦會不會自己排迷宮：對抗才會（自己的場地）；合作不排，怕動到隊友排好的路
    bots_maze: bool,
}

/// 塔在 view 和 `tower` 事件裡的樣子：[id, 格子, 種類, 等級, 誰的, 瞄準方式]
fn tower_row(t: &crate::towerdefense_field::Tower) -> Value {
    json!([t.id, t.cell, t.kind as u8, t.level, t.owner, t.mode as u8])
}

fn paths(field: &Field) -> Vec<&Vec<usize>> {
    field.routes.iter().map(|r| &r.path).collect()
}

fn has_air(n: u32) -> bool {
    wave(n).iter().any(|g| g.kind.spec().air)
}

impl TowerDefense {
    fn versus(&self) -> bool {
        self.options.mode == GameMode::Versus
    }

    fn is_bot(&self, seat: usize) -> bool {
        self.bots[seat].is_some()
    }

    /// 還在場上的真人裡連著線的
    fn present(&self) -> impl Iterator<Item = usize> + '_ {
        (0..self.players.len()).filter(|&s| !self.is_bot(s) && self.online[s] && !self.players[s].out)
    }

    /// 實際的遊戲速度：還在場上、連著線的真人裡最慢的那個。
    /// 真人都出局了（對抗模式只剩電腦在打）就聽在旁邊看的人的，不然只能用一倍速慢慢等
    fn speed(&self) -> u8 {
        let watching = || (0..self.players.len()).filter(|&s| !self.is_bot(s) && self.online[s]);
        let slowest = |seats: &mut dyn Iterator<Item = usize>| seats.map(|s| self.players[s].speed).min();
        slowest(&mut self.present()).or_else(|| slowest(&mut watching())).unwrap_or(1).clamp(1, MAX_SPEED)
    }

    fn all_ready(&self) -> bool {
        self.present().next().is_some() && self.present().all(|s| self.players[s].ready)
    }

    /// 這塊場地的主人（合作是所有人）
    fn owners(&self, field: usize) -> Vec<usize> {
        (0..self.players.len()).filter(|&s| self.players[s].field == field && !self.players[s].out).collect()
    }

    fn alive(&self) -> Vec<usize> {
        (0..self.players.len()).filter(|&s| !self.players[s].out).collect()
    }

    /// 對抗：`seat` 派兵會打到誰（指定的人出局了就換下一位還在場上的）
    fn target_of(&self, seat: usize) -> Option<usize> {
        let n = self.players.len();
        let ok = |t: usize| t != seat && t < n && !self.players[t].out;
        self.players[seat].aim.filter(|&t| ok(t)).or_else(|| (1..n).map(|k| (seat + k) % n).find(|&t| ok(t)))
    }

    /// 這個人可不可以動這座塔（賣掉、改瞄準）：自己蓋的，或蓋的人是電腦、不在線上
    fn may_manage(&self, seat: usize, owner: usize) -> bool {
        seat == owner || self.is_bot(owner) || !self.online[owner]
    }

    fn emit_tower(&self, field: usize, op: &str, row: Value, routes: bool, ctx: &mut Ctx) {
        let f = &self.fields[field];
        let mut event = json!({ "type": "tower", "f": field, "rev": f.rev, "op": op, "t": row });
        if routes {
            event["paths"] = json!(paths(f));
        }
        ctx.emit(To::All, event);
    }

    fn build(&mut self, seat: usize, cell: usize, kind: TowerKind, ctx: &mut Ctx) -> Result<(), String> {
        let cost = kind.level(1).cost;
        if self.players[seat].gold < cost {
            return Err(format!("錢不夠：{}要 {cost}", kind.spec().name));
        }
        let fi = self.players[seat].field;
        let id = self.fields[fi].build(cell, kind, seat)?;
        self.players[seat].gold -= cost;
        self.players[seat].built += 1;
        let row = tower_row(self.fields[fi].tower(id).expect("just built"));
        self.emit_tower(fi, "add", row, true, ctx);
        Ok(())
    }

    fn upgrade(&mut self, seat: usize, id: u32, ctx: &mut Ctx) -> Result<(), String> {
        let fi = self.players[seat].field;
        let field = &mut self.fields[fi];
        if field.tower(id).is_none() {
            return Err("找不到這座塔".into());
        }
        let Some(cost) = field.upgrade_cost(id) else { return Err("這座塔已經是最高級了".into()) };
        if self.players[seat].gold < cost {
            return Err(format!("錢不夠：升級要 {cost}"));
        }
        field.upgrade(id);
        self.players[seat].gold -= cost;
        let row = tower_row(self.fields[fi].tower(id).expect("still there"));
        self.emit_tower(fi, "up", row, false, ctx);
        Ok(())
    }

    fn sell(&mut self, seat: usize, id: u32, ctx: &mut Ctx) -> Result<(), String> {
        let fi = self.players[seat].field;
        let Some(owner) = self.fields[fi].tower(id).map(|t| t.owner) else { return Err("找不到這座塔".into()) };
        if !self.may_manage(seat, owner) {
            return Err("這是隊友的塔，只有他能拆".into());
        }
        let tower = self.fields[fi].sell(id).expect("checked above");
        // 第一波開始前全額退，之後退七成；錢退給蓋的人
        let refund = if self.wave == 0 { tower.spent } else { (f64::from(tower.spent) * REFUND).round() as u32 };
        self.players[owner].gold += refund;
        self.emit_tower(fi, "sell", tower_row(&tower), true, ctx);
        Ok(())
    }

    fn send(&mut self, seat: usize, unit: usize, ctx: &mut Ctx) -> Result<(), String> {
        if !self.versus() {
            return Err("合作模式不能派兵".into());
        }
        let Some(u) = UNITS.get(unit) else { return Err("沒有這種兵".into()) };
        if self.wave < u.unlock {
            return Err(format!("第 {} 波以後才能派{}", u.unlock, u.kind.spec().name));
        }
        if self.players[seat].gold < u.cost {
            return Err(format!("錢不夠：派{}要 {}", u.kind.spec().name, u.cost));
        }
        let Some(target) = self.target_of(seat) else { return Err("沒有對手可以打了".into()) };
        self.players[seat].gold -= u.cost;
        self.players[seat].income += u.income;
        self.players[seat].sent += u.count;
        let (hp, bounty) = (wave_hp(self.wave) * self.hp_scale * SEND_HP, wave_bounty(self.wave) * SEND_BOUNTY);
        let field = &mut self.fields[self.players[target].field];
        let routes = field.routes.len();
        for i in 0..u.count {
            field.enqueue(Spawn {
                at: field.time + SEND_GAP * f64::from(i),
                kind: u.kind,
                route: ctx.rng.below(routes),
                hp,
                bounty,
                sent_by: Some(seat),
                wave: false,
            });
        }
        ctx.emit(
            To::All,
            json!({ "type": "send", "from": seat, "to": target, "unit": unit, "income": self.players[seat].income }),
        );
        Ok(())
    }

    fn give(&mut self, seat: usize, to: usize, amount: u32, ctx: &mut Ctx) -> Result<(), String> {
        if self.versus() {
            return Err("對抗模式不能給錢".into());
        }
        if to >= self.players.len() || to == seat {
            return Err("要給誰？".into());
        }
        if amount == 0 || amount > self.players[seat].gold {
            return Err("錢不夠".into());
        }
        self.players[seat].gold -= amount;
        self.players[to].gold += amount;
        ctx.emit(To::All, json!({ "type": "give", "from": seat, "to": to, "amount": amount }));
        Ok(())
    }

    fn emit_ready(&self, ctx: &mut Ctx) {
        let ready: Vec<bool> = self.players.iter().map(|p| p.ready).collect();
        ctx.emit(To::All, json!({ "type": "ready", "ready": ready }));
    }

    fn start_wave(&mut self, ctx: &mut Ctx) {
        self.wave += 1;
        self.wave_started = self.time;
        self.next_at = None;
        let groups = wave(self.wave);
        let (hp, bounty) = (wave_hp(self.wave) * self.hp_scale, wave_bounty(self.wave));
        for fi in 0..self.fields.len() {
            if !self.owners(fi).is_empty() {
                self.fields[fi].start_wave(&groups, hp, bounty);
            }
        }
        // 補給金：上一波的獎金，對抗再加上派兵賺來的收入
        for p in self.players.iter_mut().filter(|p| !p.out) {
            p.gold += p.income + if self.wave > 1 { wave_bonus(self.wave - 1) } else { 0 };
            p.ready = false;
        }
        ctx.emit(To::All, json!({ "type": "wave", "wave": self.wave }));
        if groups.iter().any(|g| matches!(g.kind, MonsterKind::Boss | MonsterKind::Wyvern)) {
            ctx.announce(To::All, format!("第 {} 波：魔王來了！", self.wave), "danger");
        }
        ctx.changed();
    }

    /// 場上清空了：合作撐過最後一波就贏，不然休息一下出下一波
    fn wave_cleared(&mut self, ctx: &mut Ctx) {
        if !self.versus() {
            self.best = self.best.max(self.wave);
            if self.options.waves > 0 && self.wave >= self.options.waves {
                for p in &mut self.players {
                    p.gold += wave_bonus(self.wave);
                }
                self.won = Some(true);
                for &pid in &self.pids {
                    *self.wins.entry(pid).or_default() += 1;
                }
                ctx.announce(To::All, format!("守住了！{} 波全部撐過去。", self.wave), "ok");
                self.ended = true;
                ctx.changed();
                return;
            }
        }
        self.next_at = Some(self.time + BREAK);
        ctx.changed();
    }

    /// 對抗：生命歸零的人出局；剩一個人就結束
    fn eliminate(&mut self, seat: usize, ctx: &mut Ctx) {
        let place = self.alive().len();
        let p = &mut self.players[seat];
        p.out = true;
        p.place = Some(place);
        self.fields[p.field].clear();
        ctx.emit(To::All, json!({ "type": "out", "seat": seat, "place": place }));
        ctx.announce(To::All, format!("{} 守不住了，第 {place} 名。", ctx.seats[seat].name), "danger");
        let alive = self.alive();
        if alive.len() <= 1 {
            if let Some(&winner) = alive.first() {
                self.players[winner].place = Some(1);
                self.winner = Some(winner);
                *self.wins.entry(self.pids[winner]).or_default() += 1;
                ctx.announce(To::All, format!("{} 撐到最後，獲勝！", ctx.seats[winner].name), "ok");
            }
            self.ended = true;
        }
        ctx.changed();
    }

    /// 把一塊場地這一步打倒的怪換成錢，生命歸零就輸
    fn collect(&mut self, fi: usize, ctx: &mut Ctx) {
        let owners = self.owners(fi);
        let field = &mut self.fields[fi];
        let kills = std::mem::take(&mut field.kills);
        let dealt = std::mem::take(&mut field.dealt);
        let lives = field.lives;
        for k in kills {
            for &s in &owners {
                self.players[s].gold += k.bounty;
            }
            if let Some(p) = self.players.get_mut(k.owner) {
                p.kills += 1;
            }
        }
        for (seat, amount) in dealt.into_iter().enumerate() {
            if let Some(p) = self.players.get_mut(seat) {
                p.damage += amount;
            }
        }
        if lives > 0 || self.ended {
            return;
        }
        if self.versus() {
            for seat in owners {
                self.eliminate(seat, ctx);
            }
        } else {
            self.won = Some(false);
            self.ended = true;
            // 這一波沒守住：撐過的是前一波
            self.best = self.best.max(self.wave.saturating_sub(1));
            ctx.announce(To::All, format!("守不住了…倒在第 {} 波。", self.wave), "danger");
            ctx.changed();
        }
    }

    fn run_bots(&mut self, ctx: &mut Ctx) {
        for seat in 0..self.players.len() {
            let due = self.bots[seat].as_ref().is_some_and(|b| self.time >= b.think_at);
            if !due || self.players[seat].out || self.ended {
                continue;
            }
            let versus = self.versus();
            let situation = Situation {
                field: &self.fields[self.players[seat].field],
                seat,
                gold: self.players[seat].gold,
                wave: self.wave,
                hp: wave_hp(self.wave.max(1)) * self.hp_scale,
                maze: self.bots_maze,
                air_soon: has_air(self.wave + 1) || has_air(self.wave + 2),
                units: if versus {
                    (0..UNITS.len()).filter(|&u| self.wave >= UNITS[u].unlock).collect()
                } else {
                    Vec::new()
                },
            };
            let decision = self.bots[seat].as_mut().expect("checked above").decide(&situation, self.time, ctx.rng);
            // 電腦的動作被擋下來（剛好有怪走過去…）就算了，下次再想
            let _ = match decision {
                Decision::Build { cell, kind } => self.build(seat, cell, kind, ctx),
                Decision::Upgrade { id } => self.upgrade(seat, id, ctx),
                Decision::Send { unit } => self.send(seat, unit, ctx),
                Decision::Wait => Ok(()),
            };
        }
    }

    /// 推進一步（`DT` 秒）
    fn step(&mut self, ctx: &mut Ctx) {
        self.time += DT;
        match self.next_at {
            Some(at) if self.time >= at => self.start_wave(ctx),
            Some(at) => {
                if self.all_ready() && at > self.time + READY_DELAY {
                    self.next_at = Some(self.time + READY_DELAY);
                    ctx.changed();
                }
            }
            None => {
                let active = || (0..self.fields.len()).filter(|&fi| !self.owners(fi).is_empty());
                if active().all(|fi| self.fields[fi].idle()) {
                    self.wave_cleared(ctx);
                } else if !active().any(|fi| self.fields[fi].spawning())
                    && (self.time >= self.wave_started + WAVE_CAP || self.all_ready())
                {
                    // 拖太久，或大家都說可以了：這一波還沒清完，下一波照樣出來
                    self.start_wave(ctx);
                }
            }
        }
        if self.ended {
            return;
        }
        for fi in 0..self.fields.len() {
            if self.owners(fi).is_empty() {
                continue;
            }
            self.fields[fi].step();
            self.collect(fi, ctx);
        }
        self.run_bots(ctx);
    }

    /// 這個 tick 的畫面：每塊場地的怪物和開火，送給正在看那一塊的人
    fn broadcast(&mut self, ctx: &mut Ctx) {
        let gold: Vec<u32> = self.players.iter().map(|p| p.gold).collect();
        let lives: Vec<i32> = self.fields.iter().map(|f| f.lives.max(0)).collect();
        let counts: Vec<usize> = self.fields.iter().map(|f| f.monsters.len()).collect();
        let kills: Vec<u32> = self.players.iter().map(|p| p.kills).collect();
        for fi in 0..self.fields.len() {
            let viewers: Vec<usize> = (0..self.players.len()).filter(|&s| self.players[s].look == fi).collect();
            let field = &mut self.fields[fi];
            let mut event = json!({
                "type": "tick",
                "n": self.tick,
                "f": fi,
                "m": field.encode(),
                "g": gold,
                "l": lives,
                "c": counts,
                "k": kills,
            });
            if !field.shots.is_empty() {
                event["s"] = json!(std::mem::take(&mut field.shots));
            }
            if !field.leaks.is_empty() {
                event["x"] = json!(std::mem::take(&mut field.leaks));
            }
            ctx.emit(To::SeatsAndSpectators(viewers), event);
        }
    }
}

impl PartyGame for TowerDefense {
    const ID: &'static str = "towerdefense";
    const MIN_PLAYERS: usize = 1;
    const MAX_PLAYERS: usize = 8;
    const MAX_BOTS: usize = 7;
    const TICK: Duration = Duration::from_millis(100);
    /// 連點蓋塔、連按派兵
    const MSGS_PER_SEC: u32 = 30;

    type Options = Options;
    type Action = Action;

    fn rooms(state: &AppState) -> &Arc<Parties<Self>> {
        &state.towerdefense
    }

    fn check_options(options: Options) -> Result<Options, String> {
        if spec::map(&options.map).is_none() {
            return Err("沒有這張地圖".into());
        }
        if !matches!(options.waves, 0 | 20 | 30 | 40) {
            return Err("波數只能選 20、30、40 或無限".into());
        }
        Ok(options)
    }

    fn can_start(options: &Options, players: usize) -> Result<(), String> {
        if options.mode == GameMode::Versus && players < 2 {
            return Err("對抗模式至少要 2 個人，可以加電腦玩家".into());
        }
        Ok(())
    }

    fn start(options: &Options, previous: Option<&Self>, ctx: &mut Ctx) -> Self {
        let map = spec::map(&options.map).unwrap_or(&spec::maps()[0]);
        let n = ctx.seats.len();
        let versus = options.mode == GameMode::Versus;
        let lives = options.difficulty.lives();
        let mut seed = || ctx.rng.below(u32::MAX as usize) as u32;
        let fields: Vec<Field> = (0..if versus { n } else { 1 }).map(|_| Field::new(map, lives, seed())).collect();
        let players = (0..n)
            .map(|s| {
                let field = if versus { s } else { 0 };
                Player {
                    gold: START_GOLD,
                    income: 0,
                    field,
                    look: field,
                    aim: None,
                    ready: false,
                    speed: 1,
                    out: false,
                    place: None,
                    kills: 0,
                    damage: 0.0,
                    built: 0,
                    sent: 0,
                }
            })
            .collect();
        let bots = (0..n).map(|s| ctx.seats[s].bot.then(|| Bot::new(options.bots, 0.0, ctx.rng))).collect();
        ctx.system(
            To::All,
            if versus {
                format!("新的一局（對抗・{}）：各守各的場地，派怪去打別人，撐到最後的人贏。", map.spec.name)
            } else if options.waves > 0 {
                format!("新的一局（合作・{}）：一起撐過 {} 波就贏。", map.spec.name, options.waves)
            } else {
                format!("新的一局（合作・{}）：無限波，看大家能撐到第幾波。", map.spec.name)
            },
        );
        ctx.changed();
        Self {
            game: previous.map_or(1, |p| p.game + 1),
            options: options.clone(),
            map,
            fields,
            players,
            pids: ctx.seats.iter().map(|s| s.pid).collect(),
            bots,
            online: ctx.seats.iter().map(|s| s.online).collect(),
            tick: 0,
            time: 0.0,
            wave: 0,
            wave_started: 0.0,
            next_at: Some(FIRST_BREAK),
            hp_scale: options.difficulty.hp() * if versus { 1.0 } else { 1.0 + COOP_HP * (n - 1) as f32 },
            ended: false,
            won: None,
            winner: None,
            wins: previous.map(|p| p.wins.clone()).unwrap_or_default(),
            best: previous.map_or(0, |p| p.best),
            bots_maze: versus,
        }
    }

    fn act(&mut self, seat: usize, action: Action, ctx: &mut Ctx) -> Result<(), String> {
        // 動作的結果用事件通知（`tower`、`send`…），不重送整份 view；要重送的地方自己呼叫 `changed`
        ctx.quiet();
        if self.ended {
            return Ok(());
        }
        if self.players[seat].out && !matches!(action, Action::Look { .. }) {
            return Err("你已經出局了，可以看別人的場地".into());
        }
        match action {
            Action::Build { cell, kind } => self.build(seat, cell, kind, ctx),
            Action::Upgrade { id } => self.upgrade(seat, id, ctx),
            Action::Sell { id } => self.sell(seat, id, ctx),
            Action::Mode { id, mode } => {
                let fi = self.players[seat].field;
                let Some(owner) = self.fields[fi].tower(id).map(|t| t.owner) else {
                    return Err("找不到這座塔".into());
                };
                if !self.may_manage(seat, owner) {
                    return Err("這是隊友的塔，只有他能改".into());
                }
                self.fields[fi].set_mode(id, mode);
                let row = tower_row(self.fields[fi].tower(id).expect("checked above"));
                self.emit_tower(fi, "mode", row, false, ctx);
                Ok(())
            }
            Action::Ready { ready } => {
                if self.players[seat].ready != ready {
                    self.players[seat].ready = ready;
                    self.emit_ready(ctx);
                }
                Ok(())
            }
            Action::Send { unit } => self.send(seat, unit, ctx),
            Action::Aim { seat: target } => {
                if target.is_some_and(|t| t == seat || t >= self.players.len() || self.players[t].out) {
                    return Err("不能打這個人".into());
                }
                self.players[seat].aim = target;
                ctx.emit(To::Seat(seat), json!({ "type": "aim", "seat": target, "target": self.target_of(seat) }));
                Ok(())
            }
            Action::Give { seat: to, amount } => self.give(seat, to, amount, ctx),
            Action::Look { field } => {
                if field >= self.fields.len() {
                    return Err("沒有這塊場地".into());
                }
                self.players[seat].look = field;
                Ok(())
            }
            Action::Speed { speed } => {
                // 每個人想要的速度在 view 裡（自己的按鈕要亮），實際的速度可能跟著變，所以重送
                self.players[seat].speed = speed.clamp(1, MAX_SPEED);
                ctx.changed();
                Ok(())
            }
        }
    }

    fn tick(&mut self, ctx: &mut Ctx) {
        // 沒有真人連著：停住，等有人回來
        if self.ended || !(0..self.players.len()).any(|s| !self.is_bot(s) && self.online[s]) {
            return;
        }
        self.tick += 1;
        for _ in 0..self.speed() {
            self.step(ctx);
            if self.ended {
                break;
            }
        }
        self.broadcast(ctx);
    }

    fn presence(&mut self, seat: usize, online: bool, ctx: &mut Ctx) {
        self.online[seat] = online;
        ctx.changed();
    }

    fn view(&self, seat: Option<usize>, _now: Instant) -> Value {
        let speed = self.speed();
        let fields: Vec<Value> = self
            .fields
            .iter()
            .map(|f| {
                json!({
                    "rev": f.rev,
                    "lives": f.lives.max(0),
                    "towers": f.towers.iter().map(tower_row).collect::<Vec<_>>(),
                    "paths": paths(f),
                })
            })
            .collect();
        let players: Vec<Value> = self
            .players
            .iter()
            .enumerate()
            .map(|(s, p)| {
                json!({
                    "gold": p.gold,
                    "income": p.income,
                    "field": p.field,
                    "ready": p.ready,
                    "speed": p.speed,
                    "out": p.out,
                    "place": p.place,
                    "kills": p.kills,
                    "damage": p.damage.round() as u64,
                    "built": p.built,
                    "sent": p.sent,
                    "online": self.online[s],
                    "wins": self.wins.get(&self.pids[s]).copied().unwrap_or(0),
                })
            })
            .collect();
        let groups = |n: u32| wave(n).iter().map(|g| json!([g.kind as u8, g.count])).collect::<Vec<Value>>();
        json!({
            "game": self.game,
            "mode": self.options.mode,
            "map": self.map.spec.id,
            "difficulty": self.options.difficulty,
            "waves": self.options.waves,
            "you": seat,
            "tick": self.tick,
            "wave": self.wave,
            // 還剩幾毫秒（照現在的遊戲速度換成真實時間）下一波開始；這一波還在打是 null
            "nextIn": self.next_at.map(|at| ((at - self.time).max(0.0) / f64::from(speed) * 1000.0) as u64),
            // 這一波（還沒開始是空的）和下一波出什麼：[怪物種類, 幾隻]
            "now": if self.wave > 0 { groups(self.wave) } else { Vec::new() },
            "next": groups(self.wave + 1),
            "speed": speed,
            "fields": fields,
            "players": players,
            "bots": (0..self.bots.len()).filter(|&s| self.is_bot(s)).collect::<Vec<_>>(),
            // 對抗：自己派兵現在會打到誰
            "target": seat.filter(|_| self.versus()).and_then(|s| self.target_of(s)),
            "aim": seat.and_then(|s| self.players[s].aim),
            "look": seat.map(|s| self.players[s].look),
            "ended": self.ended,
            "won": self.won,
            "winner": self.winner,
            "best": self.best,
        })
    }

    fn finished(&self) -> bool {
        self.ended
    }

    fn bot_name(n: usize) -> String {
        const NAMES: [&str; 8] = ["阿土", "小石", "阿月", "鐵柱", "木蘭", "阿弩", "小砲", "石敢當"];
        NAMES[n.saturating_sub(1) % NAMES.len()].to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::party::{Outbox, Rng, SeatInfo, test_ctx};

    /// 前面 `humans` 個真人，後面 `bots` 個電腦
    fn seats(humans: usize, bots: usize) -> Vec<SeatInfo> {
        (0..humans + bots)
            .map(|i| SeatInfo { pid: i as u32 + 1, name: format!("P{i}"), bot: i >= humans, online: true })
            .collect()
    }

    fn options(mode: GameMode) -> Options {
        Options { mode, ..Options::default() }
    }

    struct Table {
        g: TowerDefense,
        seats: Vec<SeatInfo>,
        rng: Rng,
        now: Instant,
    }

    impl Table {
        fn new(options: &Options, humans: usize, bots: usize) -> Self {
            let seats = seats(humans, bots);
            let mut rng = Rng::new();
            let mut out = Outbox::default();
            let now = Instant::now();
            let g = {
                let mut ctx = test_ctx(now, &mut rng, &seats, &mut out);
                TowerDefense::start(options, None, &mut ctx)
            };
            Self { g, seats, rng, now }
        }

        fn act(&mut self, seat: usize, action: Action) -> Result<(), String> {
            let mut out = Outbox::default();
            let mut ctx = test_ctx(self.now, &mut self.rng, &self.seats, &mut out);
            self.g.act(seat, action, &mut ctx)
        }

        fn act_out(&mut self, seat: usize, action: Action) -> Outbox {
            let mut out = Outbox::default();
            let mut ctx = test_ctx(self.now, &mut self.rng, &self.seats, &mut out);
            self.g.act(seat, action, &mut ctx).unwrap();
            out
        }

        fn tick(&mut self) -> Outbox {
            let mut out = Outbox::default();
            let mut ctx = test_ctx(self.now, &mut self.rng, &self.seats, &mut out);
            self.g.tick(&mut ctx);
            out
        }

        /// 不管有沒有真人在線，直接推進（電腦自己打的測試用）
        fn steps(&mut self, n: usize) {
            for _ in 0..n {
                if self.g.ended {
                    break;
                }
                let mut out = Outbox::default();
                let mut ctx = test_ctx(self.now, &mut self.rng, &self.seats, &mut out);
                self.g.step(&mut ctx);
            }
        }

        fn run(&mut self, secs: f64) {
            for _ in 0..(secs / DT).round() as usize {
                self.tick();
            }
        }

        fn view(&self, seat: Option<usize>) -> Value {
            self.g.view(seat, self.now)
        }
    }

    fn cell(t: &Table, x: usize, y: usize) -> usize {
        y * t.g.map.w + x
    }

    fn events<'a>(out: &'a Outbox, kind: &str) -> Vec<&'a Value> {
        out.events().iter().map(|(_, e)| e).filter(|e| e["type"] == kind).collect()
    }

    #[test]
    fn options_are_checked() {
        assert!(TowerDefense::check_options(Options::default()).is_ok());
        assert!(TowerDefense::check_options(Options { map: "moon".into(), ..Options::default() }).is_err());
        assert!(TowerDefense::check_options(Options { waves: 7, ..Options::default() }).is_err());
        assert!(TowerDefense::check_options(Options { waves: 0, ..Options::default() }).is_ok());
        assert!(TowerDefense::can_start(&options(GameMode::Versus), 1).is_err());
        assert!(TowerDefense::can_start(&options(GameMode::Versus), 2).is_ok());
        assert!(TowerDefense::can_start(&options(GameMode::Coop), 1).is_ok());
        // 沒填的選項用預設值
        let partial: Options = serde_json::from_value(json!({ "mode": "versus" })).unwrap();
        assert_eq!(partial.mode, GameMode::Versus);
        assert_eq!(partial.map, "plains");
        assert_eq!(partial.waves, 20);
    }

    #[test]
    fn building_costs_gold_and_tells_everyone() {
        let mut t = Table::new(&options(GameMode::Coop), 2, 0);
        let c = cell(&t, 5, 5);
        let out = t.act_out(0, Action::Build { cell: c, kind: TowerKind::Bolt });
        assert_eq!(t.g.players[0].gold, START_GOLD - 50);
        assert_eq!(t.g.players[1].gold, START_GOLD);
        let added = events(&out, "tower");
        assert_eq!(added.len(), 1);
        assert_eq!(added[0]["op"], "add");
        assert_eq!(added[0]["rev"], 1);
        assert_eq!(added[0]["t"], json!([1, c, 0, 1, 0, 0]));
        assert!(added[0]["paths"][0].as_array().unwrap().len() >= 21);
        // 同一格不能再蓋、沒錢不能蓋
        assert_eq!(t.act(1, Action::Build { cell: c, kind: TowerKind::Bolt }).unwrap_err(), "這一格已經有塔了");
        t.g.players[1].gold = 10;
        assert!(t.act(1, Action::Build { cell: c + 1, kind: TowerKind::Bolt }).unwrap_err().contains("錢不夠"));
        // view 裡有這座塔
        let view = t.view(Some(1));
        assert_eq!(view["fields"][0]["towers"], json!([[1, c, 0, 1, 0, 0]]));
        assert_eq!(view["fields"][0]["rev"], 1);
        assert_eq!(view["you"], 1);
    }

    #[test]
    fn teammates_can_upgrade_but_only_the_owner_sells() {
        let mut t = Table::new(&options(GameMode::Coop), 2, 0);
        let c = cell(&t, 5, 5);
        t.act(0, Action::Build { cell: c, kind: TowerKind::Bolt }).unwrap();
        // 隊友幫忙升級，花的是隊友的錢
        let out = t.act_out(1, Action::Upgrade { id: 1 });
        assert_eq!(events(&out, "tower")[0]["op"], "up");
        assert_eq!(t.g.players[1].gold, START_GOLD - 60);
        assert_eq!(t.act(1, Action::Sell { id: 1 }).unwrap_err(), "這是隊友的塔，只有他能拆");
        assert_eq!(t.act(1, Action::Mode { id: 1, mode: Mode::Strong }).unwrap_err(), "這是隊友的塔，只有他能改");
        t.act(0, Action::Mode { id: 1, mode: Mode::Strong }).unwrap();
        assert_eq!(t.g.fields[0].tower(1).unwrap().mode, Mode::Strong);
        // 第一波還沒開始：全額退給蓋的人（連隊友出的升級費）
        let out = t.act_out(0, Action::Sell { id: 1 });
        assert_eq!(events(&out, "tower")[0]["op"], "sell");
        assert_eq!(t.g.players[0].gold, START_GOLD + 60);
        assert!(t.g.fields[0].towers.is_empty());
        // 蓋的人不在線上，隊友就可以拆
        t.act(0, Action::Build { cell: c, kind: TowerKind::Bolt }).unwrap();
        t.g.online[0] = false;
        assert!(t.act(1, Action::Sell { id: 2 }).is_ok());
    }

    #[test]
    fn selling_after_the_first_wave_refunds_seventy_percent() {
        let mut t = Table::new(&options(GameMode::Coop), 1, 0);
        t.act(0, Action::Build { cell: cell(&t, 5, 5), kind: TowerKind::Cannon }).unwrap();
        t.g.wave = 3;
        t.act(0, Action::Sell { id: 1 }).unwrap();
        assert_eq!(t.g.players[0].gold, START_GOLD - 90 + 63);
    }

    #[test]
    fn the_first_wave_comes_after_the_break_or_when_everyone_is_ready() {
        let mut t = Table::new(&options(GameMode::Coop), 2, 0);
        let view = t.view(Some(0));
        assert_eq!(view["wave"], 0);
        assert_eq!(view["nextIn"], 30_000);
        assert_eq!(view["now"], json!([]));
        assert_eq!(view["next"], json!([[0, 10]]));
        t.run(5.0);
        assert_eq!(t.g.wave, 0);
        // 只有一個人準備好不算
        let out = t.act_out(0, Action::Ready { ready: true });
        assert_eq!(events(&out, "ready")[0]["ready"], json!([true, false]));
        t.run(3.0);
        assert_eq!(t.g.wave, 0);
        t.act(1, Action::Ready { ready: true }).unwrap();
        t.run(READY_DELAY + 0.3);
        assert_eq!(t.g.wave, 1);
        assert_eq!(t.view(Some(0))["nextIn"], Value::Null);
        // 開始之後準備的記號清掉
        assert!(t.g.players.iter().all(|p| !p.ready));
        assert!(t.g.fields[0].spawning());
    }

    #[test]
    fn ticks_carry_monsters_gold_and_shots_to_whoever_is_watching() {
        let mut t = Table::new(&options(GameMode::Coop), 1, 0);
        t.act(0, Action::Build { cell: cell(&t, 3, 5), kind: TowerKind::Bolt }).unwrap();
        t.act(0, Action::Ready { ready: true }).unwrap();
        t.run(READY_DELAY + 0.5);
        let out = t.tick();
        let ticks = events(&out, "tick");
        assert_eq!(ticks.len(), 1);
        assert_eq!(ticks[0]["f"], 0);
        assert_eq!(ticks[0]["n"], t.g.tick);
        assert_eq!(ticks[0]["m"].as_str().unwrap().len(), 10);
        assert_eq!(ticks[0]["g"], json!([START_GOLD - 50]));
        assert_eq!(ticks[0]["l"], json!([20]));
        assert_eq!(ticks[0]["c"], json!([1]));
        assert_eq!(ticks[0]["k"], json!([0]));
        // 打倒第一隻：賞金進帳，開火跟著 tick 送出去
        let mut shots = 0;
        for _ in 0..80 {
            shots += events(&t.tick(), "tick").iter().filter(|e| e["s"].is_array()).count();
        }
        assert!(shots >= 3);
        assert!(t.g.players[0].gold > START_GOLD - 50);
        assert!(t.g.players[0].kills >= 1);
        assert!(t.g.players[0].damage > 0.0);
    }

    #[test]
    fn everyone_is_paid_for_each_kill_and_monsters_get_tougher_with_more_players() {
        let solo = Table::new(&options(GameMode::Coop), 1, 0);
        let mut trio = Table::new(&options(GameMode::Coop), 3, 0);
        assert!((solo.g.hp_scale - 1.0).abs() < 1e-6);
        assert!((trio.g.hp_scale - 2.6).abs() < 1e-6);
        trio.act(0, Action::Build { cell: cell(&trio, 3, 5), kind: TowerKind::Sniper }).unwrap();
        for s in 0..3 {
            trio.act(s, Action::Ready { ready: true }).unwrap();
        }
        trio.run(12.0);
        assert!(trio.g.players[0].kills >= 1);
        // 只有 0 號蓋塔，但三個人都拿到賞金
        assert_eq!(trio.g.players[1].gold, trio.g.players[2].gold);
        assert!(trio.g.players[1].gold > START_GOLD);
        assert_eq!(trio.g.players[1].kills, 0);
    }

    #[test]
    fn gold_can_be_given_to_a_teammate() {
        let mut t = Table::new(&options(GameMode::Coop), 2, 0);
        let out = t.act_out(0, Action::Give { seat: 1, amount: 100 });
        assert_eq!(events(&out, "give")[0]["amount"], 100);
        assert_eq!(t.g.players[0].gold, START_GOLD - 100);
        assert_eq!(t.g.players[1].gold, START_GOLD + 100);
        assert!(t.act(0, Action::Give { seat: 1, amount: 9999 }).is_err());
        assert!(t.act(0, Action::Give { seat: 0, amount: 1 }).is_err());
        assert!(t.act(0, Action::Give { seat: 1, amount: 0 }).is_err());
        assert!(t.act(0, Action::Send { unit: 0 }).unwrap_err().contains("合作模式"));
    }

    #[test]
    fn leaking_every_life_loses_the_cooperative_game() {
        let mut t = Table::new(&Options { difficulty: Difficulty::Hard, ..options(GameMode::Coop) }, 1, 0);
        assert_eq!(t.g.fields[0].lives, 10);
        t.act(0, Action::Ready { ready: true }).unwrap();
        t.run(60.0);
        assert!(t.g.ended);
        assert_eq!(t.g.won, Some(false));
        assert!(t.g.finished());
        let view = t.view(Some(0));
        assert_eq!(view["ended"], true);
        assert_eq!(view["won"], false);
        assert_eq!(view["fields"][0]["lives"], 0);
        // 結束後的動作不理、也不回錯誤
        assert!(t.act(0, Action::Build { cell: cell(&t, 5, 5), kind: TowerKind::Bolt }).is_ok());
        assert!(t.g.fields[0].towers.is_empty());
    }

    #[test]
    fn surviving_the_last_wave_wins() {
        let mut t = Table::new(&Options { waves: 20, ..options(GameMode::Coop) }, 2, 0);
        t.g.wave = 20;
        t.g.next_at = None;
        t.tick();
        assert!(t.g.ended);
        assert_eq!(t.g.won, Some(true));
        assert_eq!(t.g.best, 20);
        assert_eq!(t.view(None)["players"][0]["wins"], 1);
        assert_eq!(t.view(None)["players"][1]["wins"], 1);
    }

    #[test]
    fn versus_players_each_get_a_field_and_can_look_around() {
        let mut t = Table::new(&options(GameMode::Versus), 2, 1);
        assert_eq!(t.g.fields.len(), 3);
        assert!((t.g.hp_scale - 1.0).abs() < 1e-6);
        t.act(0, Action::Build { cell: cell(&t, 5, 5), kind: TowerKind::Bolt }).unwrap();
        assert_eq!(t.g.fields[0].towers.len(), 1);
        assert!(t.g.fields[1].towers.is_empty());
        // 每個人只收自己在看的那一塊
        let out = t.tick();
        let to: Vec<String> =
            out.events().iter().filter(|(_, e)| e["type"] == "tick").map(|(to, _)| format!("{to:?}")).collect();
        assert_eq!(to, ["SeatsAndSpectators([0])", "SeatsAndSpectators([1])", "SeatsAndSpectators([2])"]);
        t.act(0, Action::Look { field: 1 }).unwrap();
        let out = t.tick();
        let to: Vec<String> =
            out.events().iter().filter(|(_, e)| e["type"] == "tick").map(|(to, _)| format!("{to:?}")).collect();
        assert_eq!(to, ["SeatsAndSpectators([])", "SeatsAndSpectators([0, 1])", "SeatsAndSpectators([2])"]);
        assert!(t.act(0, Action::Look { field: 9 }).is_err());
        assert!(t.act(0, Action::Give { seat: 1, amount: 1 }).unwrap_err().contains("對抗模式"));
    }

    #[test]
    fn sending_monsters_raises_income_and_attacks_the_next_player() {
        let mut t = Table::new(&options(GameMode::Versus), 3, 0);
        assert!(t.act(0, Action::Send { unit: 0 }).unwrap_err().contains("第 2 波以後"));
        t.g.wave = 2;
        t.g.next_at = None;
        t.g.wave_started = t.g.time;
        let out = t.act_out(0, Action::Send { unit: 0 });
        let sent = events(&out, "send");
        assert_eq!(sent[0]["from"], 0);
        assert_eq!(sent[0]["to"], 1);
        assert_eq!(sent[0]["income"], 3);
        assert_eq!(t.g.players[0].gold, START_GOLD - 30);
        assert_eq!(t.g.players[0].sent, 3);
        t.run(2.0);
        assert_eq!(t.g.fields[1].monsters.len(), 3);
        assert!(t.g.fields[0].monsters.is_empty() && t.g.fields[2].monsters.is_empty());
        // 派去的怪在快照裡有記號（狀態的第三個位元）
        assert!(t.g.fields[1].monsters.iter().all(|m| m.sent_by == Some(0)));
        // 指定打 2 號
        t.act(0, Action::Aim { seat: Some(2) }).unwrap();
        assert_eq!(t.view(Some(0))["target"], 2);
        t.act(0, Action::Send { unit: 0 }).unwrap();
        t.run(2.0);
        assert_eq!(t.g.fields[2].monsters.len(), 3);
        assert!(t.act(0, Action::Aim { seat: Some(0) }).is_err());
        assert!(t.act(0, Action::Send { unit: 99 }).is_err());
        // 下一波開始時收入進帳
        let before = t.g.players[0].gold;
        let mut out = Outbox::default();
        let mut ctx = test_ctx(t.now, &mut t.rng, &t.seats, &mut out);
        t.g.start_wave(&mut ctx);
        assert_eq!(t.g.players[0].gold, before + 6 + wave_bonus(2));
        assert_eq!(t.g.players[1].gold, START_GOLD + wave_bonus(2));
    }

    #[test]
    fn the_last_player_standing_wins_versus() {
        let mut t = Table::new(&options(GameMode::Versus), 3, 0);
        t.g.wave = 1;
        t.g.next_at = None;
        t.g.fields[1].lives = 0;
        t.g.fields[1].enqueue(Spawn {
            at: 0.0,
            kind: MonsterKind::Grunt,
            route: 0,
            hp: 1e9,
            bounty: 1.0,
            sent_by: None,
            wave: true,
        });
        let out = t.tick();
        assert!(t.g.players[1].out);
        assert_eq!(t.g.players[1].place, Some(3));
        assert_eq!(events(&out, "out")[0]["seat"], 1);
        assert!(!t.g.ended);
        // 出局的人只能看
        assert!(t.act(1, Action::Build { cell: cell(&t, 5, 5), kind: TowerKind::Bolt }).unwrap_err().contains("出局"));
        assert!(t.act(1, Action::Look { field: 0 }).is_ok());
        // 自動的目標跳過出局的人
        assert_eq!(t.g.target_of(0), Some(2));
        t.g.fields[2].lives = 0;
        t.g.fields[2].enqueue(Spawn {
            at: 0.0,
            kind: MonsterKind::Grunt,
            route: 0,
            hp: 1e9,
            bounty: 1.0,
            sent_by: None,
            wave: true,
        });
        t.tick();
        assert!(t.g.ended);
        assert_eq!(t.g.winner, Some(0));
        assert_eq!(t.g.players[0].place, Some(1));
        assert_eq!(t.g.players[2].place, Some(2));
        assert_eq!(t.view(None)["players"][0]["wins"], 1);
    }

    #[test]
    fn the_game_waits_while_nobody_is_connected_and_runs_at_the_slowest_speed() {
        let mut t = Table::new(&options(GameMode::Coop), 2, 1);
        t.act(0, Action::Speed { speed: 3 }).unwrap();
        assert_eq!(t.g.speed(), 1, "另一個人還是 1 倍");
        t.act(1, Action::Speed { speed: 2 }).unwrap();
        assert_eq!(t.g.speed(), 2);
        let before = t.g.time;
        t.tick();
        assert!((t.g.time - before - 0.2).abs() < 1e-9);
        assert_eq!(t.view(Some(0))["speed"], 2);
        // 兩倍速時倒數照真實時間算
        assert!(t.view(Some(0))["nextIn"].as_u64().unwrap() < 15_000);
        // 慢的那個人斷線了，剩下的人說了算
        t.g.online[1] = false;
        assert_eq!(t.g.speed(), 3);
        // 還在場上的真人都出局了：聽在旁邊看的人的
        t.g.online[1] = true;
        t.g.players[0].out = true;
        t.g.players[1].out = true;
        assert_eq!(t.g.speed(), 2);
        t.g.players[0].out = false;
        t.g.online[1] = false;
        // 真人都斷線：停住
        t.g.online[0] = false;
        let (time, tick) = (t.g.time, t.g.tick);
        assert!(t.tick().events().is_empty());
        assert_eq!((t.g.time, t.g.tick), (time, tick));
    }

    #[test]
    fn scores_carry_over_to_the_next_game() {
        let mut t = Table::new(&options(GameMode::Coop), 1, 0);
        t.g.best = 12;
        t.g.wins.insert(1, 2);
        let mut out = Outbox::default();
        let mut ctx = test_ctx(t.now, &mut t.rng, &t.seats, &mut out);
        let next = TowerDefense::start(&options(GameMode::Coop), Some(&t.g), &mut ctx);
        assert_eq!(next.game, 2);
        assert_eq!(next.best, 12);
        assert_eq!(next.view(Some(0), t.now)["players"][0]["wins"], 2);
    }

    /// 電腦自己打完一局：不會卡住、不會當掉
    #[test]
    fn bots_can_play_both_modes_to_the_end() {
        for mode in [GameMode::Coop, GameMode::Versus] {
            // 合作用困難（比較快分出勝負），對抗用一般（撐得夠久才看得到派兵）
            let difficulty = if mode == GameMode::Coop { Difficulty::Hard } else { Difficulty::Normal };
            let o = Options { mode, waves: 20, difficulty, ..Options::default() };
            let mut t = Table::new(&o, 0, 3);
            // 最多一個小時的遊戲時間
            t.steps(36_000);
            assert!(t.g.ended, "{mode:?} 打到第 {} 波還沒結束", t.g.wave);
            assert!(t.g.players.iter().all(|p| p.built > 0), "每台電腦都有蓋塔");
            if mode == GameMode::Versus {
                assert!(t.g.winner.is_some());
                let mut places: Vec<usize> = t.g.players.iter().filter_map(|p| p.place).collect();
                places.sort_unstable();
                assert_eq!(places, [1, 2, 3]);
            }
        }
    }

    /// 調平衡用：`cargo test --lib towerdefense::tests::balance_report -- --ignored --nocapture`
    /// 電腦自己打，印出各種難度、人數、地圖撐到第幾波（每種跑幾局，電腦每局蓋的不一樣，只看一局會差很多）。
    /// 合作的電腦平常不排迷宮（怕動到隊友的路）；這裡沒有真人，讓它們排，量的是「有人排迷宮」時的難度
    #[test]
    #[ignore]
    fn balance_report() {
        const RUNS: usize = 4;
        let coop = |difficulty: Difficulty, map: &str, bots: usize, level: BotLevel| {
            let o = Options { difficulty, waves: 0, bots: level, map: map.into(), ..Options::default() };
            let waves: Vec<u32> = (0..RUNS)
                .map(|_| {
                    let mut t = Table::new(&o, 0, bots);
                    t.g.bots_maze = true;
                    t.steps(72_000);
                    t.g.wave
                })
                .collect();
            let average = waves.iter().sum::<u32>() as f32 / RUNS as f32;
            println!("合作 {difficulty:?} {map} 電腦×{bots}（{level:?}）→ 平均第 {average:.1} 波 {waves:?}");
        };
        for map in ["plains", "forks", "cross", "canyon"] {
            coop(Difficulty::Normal, map, 1, BotLevel::Normal);
        }
        coop(Difficulty::Easy, "plains", 1, BotLevel::Normal);
        coop(Difficulty::Normal, "plains", 1, BotLevel::Easy);
        coop(Difficulty::Normal, "plains", 1, BotLevel::Hard);
        coop(Difficulty::Hard, "plains", 1, BotLevel::Hard);
        coop(Difficulty::Normal, "plains", 3, BotLevel::Normal);
        coop(Difficulty::Normal, "canyon", 6, BotLevel::Normal);
        for (map, level) in [("plains", BotLevel::Normal), ("forks", BotLevel::Hard), ("cross", BotLevel::Easy)] {
            let o = Options { mode: GameMode::Versus, bots: level, map: map.into(), ..Options::default() };
            let mut lines = Vec::new();
            for _ in 0..RUNS {
                let mut t = Table::new(&o, 0, 4);
                t.steps(72_000);
                let sent: u32 = t.g.players.iter().map(|p| p.sent).sum();
                let maze: Vec<u32> = t.g.fields.iter().map(|f| f.path_len().unwrap_or(0) / 10).collect();
                lines.push(format!("第 {} 波（{:.0} 分鐘，派 {sent} 隻，迷宮 {maze:?}）", t.g.wave, t.g.time / 60.0));
            }
            println!("對抗 {map} 電腦×4（{level:?}）→ {}", lines.join("、"));
        }
    }
}
