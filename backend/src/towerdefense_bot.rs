//! 迷宮塔防的電腦玩家（規則見 `towerdefense.rs`）。電腦和真人用同一套動作（蓋、升級、派兵），錢也一樣多，
//! 每隔一小段時間想一次、一次只做一件事：
//!
//! 1. **迷宮的藍圖**（只有對抗模式、自己的場地）：第一次想的時候先把整座迷宮規劃好（`blueprint`）：把每一欄、每一列都試一次
//!    「整條蓋滿、只在一頭留缺口」，挑「路線變長的格數 ÷ 要蓋的塔數」最高的那一道牆，當它蓋好了再挑下一道，直到路線夠長。
//!    一次只看一格的話排不出迷宮：擋了一邊怪就走另一邊，路線幾乎不會變長；一次看一整道牆，
//!    下一道自然會隔一欄、缺口留在另一頭，排出來就是來回繞的蛇形。
//!    之後新的塔優先蓋在藍圖上（不管哪一種塔），挑藍圖裡現在最打得到怪的那一格：牆和火力一起長，
//!    不會先蓋一整道離怪很遠、打不到東西的牆。蓋在藍圖上的塔另外加一筆「迷宮的價值」：
//!    路線每變長一點，現有的每一座塔都多打一會兒，所以手上的火力越強，補一格牆越划算（`wall`）。
//!    合作模式不排：只蓋在路線以外的格子，不會動到隊友排好的路。
//! 2. **派兵**（對抗）：偶爾拿一部分錢派買得起的最貴的那一種，順便拉高收入。
//! 3. **蓋塔或升級**：每個候選算「火力 × 打得到路線上幾格 ÷ 價錢」，挑最划算的；最划算的買不起、又比買得起的好很多就先存錢。
//!    塔還不夠多的時候先多蓋幾座；同一種塔蓋越多座、下一座的分數越低，所以會各種都蓋一些（只有弩箭塔的話，
//!    鐵甲龜一來就守不住），蓋夠了就輪到升級。快要來飛行怪的時候，打得到天上的塔和飛行路線旁邊的格子會加分。
//!
//! 難度差在多久想一次、會不會挑最划算的（簡單的電腦隨便挑、不存錢）和多常派兵。

use serde::{Deserialize, Serialize};

use crate::{
    party::Rng,
    towerdefense_field::Field,
    towerdefense_spec::{CHAIN_FALLOFF, MAX_LEVEL, TowerKind, UNITS},
};

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BotLevel {
    Easy,
    #[default]
    Normal,
    Hard,
}

impl BotLevel {
    /// 多久想一次（秒）
    fn pace(self) -> f64 {
        match self {
            Self::Easy => 3.0,
            Self::Normal => 1.5,
            Self::Hard => 0.8,
        }
    }

    /// 每次想的時候有多少機會派兵
    fn sends(self) -> f64 {
        match self {
            Self::Easy => 0.03,
            Self::Normal => 0.06,
            Self::Hard => 0.1,
        }
    }

    /// 迷宮排到空場地路線的幾倍長
    fn maze(self) -> f32 {
        match self {
            Self::Easy => 1.8,
            Self::Normal => 2.6,
            Self::Hard => 3.4,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Decision {
    Build { cell: usize, kind: TowerKind },
    Upgrade { id: u32 },
    Send { unit: usize },
    Wait,
}

/// 電腦這次想的時候看得到的東西
pub struct Situation<'a> {
    pub field: &'a Field,
    pub seat: usize,
    pub gold: u32,
    pub wave: u32,
    /// 現在這一波一隻普通怪大概多少血（單體的塔一發打超過的部分是浪費）
    pub hp: f32,
    /// 可以改路線（對抗模式自己的場地）
    pub maze: bool,
    /// 接下來兩波有飛行的怪
    pub air_soon: bool,
    /// 現在能派的（`UNITS` 的索引，便宜的在前面）；合作模式是空的
    pub units: Vec<usize>,
}

pub struct Bot {
    level: BotLevel,
    /// 下次什麼時候想（遊戲時間）
    pub think_at: f64,
    /// 整座迷宮要蓋塔的格子（第一次想的時候規劃）
    blueprint: Option<Vec<usize>>,
    /// 迷宮排好之後怪物要走的格子：不能蓋東西，不然迷宮排不完
    corridor: Vec<usize>,
}

/// 一道牆至少要讓路線多繞幾格才值得蓋
const WALL_GAIN: f32 = 3.0;
/// 攻擊用的塔，照這個順序考慮
const ATTACKERS: [TowerKind; 6] =
    [TowerKind::Bolt, TowerKind::Cannon, TowerKind::Tesla, TowerKind::Poison, TowerKind::Sniper, TowerKind::Frost];

/// 一座塔大概有多少火力（每秒傷害，範圍和連鎖的多算一些，冰霜另外算拖慢的價值）。
/// `hp` 是現在一隻普通怪的血量：單體的塔一發打超過一隻怪的血量就是浪費，
/// 重弩在前幾波（怪又多又弱，三秒才打一發）才不會被高估
fn power(kind: TowerKind, level: u8, hp: f32) -> f32 {
    let lv = kind.level(level);
    let dps = if lv.cooldown > 0.0 { lv.damage / lv.cooldown } else { 0.0 };
    match kind {
        TowerKind::Bolt | TowerKind::Sniper => lv.damage.min(hp) / lv.cooldown,
        TowerKind::Cannon => dps * 2.2,
        TowerKind::Tesla => dps * (0..lv.chain).map(|k| CHAIN_FALLOFF.powi(i32::from(k))).sum::<f32>() * 0.75,
        TowerKind::Poison => dps + lv.dot * 1.5,
        TowerKind::Frost => dps * 2.0 + 45.0 * lv.slow * f32::from(level),
        TowerKind::Beacon => 0.0,
    }
}

/// 規劃整座迷宮：一道一道牆加上去，直到路線有空場地的 `stretch` 倍長、或找不到值得蓋的牆
fn blueprint(f: &Field, stretch: f32) -> Vec<usize> {
    let Some(direct) = f.path_len() else { return Vec::new() };
    let columns = (0..f.w).map(|x| (0..f.h).map(|y| y * f.w + x).collect::<Vec<usize>>());
    let rows = (0..f.h).map(|y| (0..f.w).map(|x| y * f.w + x).collect::<Vec<usize>>());
    let lines: Vec<Vec<usize>> = columns.chain(rows).collect();
    let mut cells: Vec<usize> = Vec::new();
    let mut len = direct;
    while (len as f32) < direct as f32 * stretch {
        let mut best: Option<(f32, u32, Vec<usize>)> = None;
        for line in &lines {
            let open: Vec<usize> = line.iter().copied().filter(|&c| f.buildable(c) && !cells.contains(&c)).collect();
            if open.len() < 3 {
                continue;
            }
            // 缺口留在這條線的哪一頭
            for gap in [0, open.len() - 1] {
                let mut wall = open.clone();
                wall.remove(gap);
                let mut all = cells.clone();
                all.extend(&wall);
                let Some(longer) = f.path_len_with(&all) else { continue };
                let gain = longer.saturating_sub(len) as f32 / 10.0;
                let score = gain / wall.len() as f32;
                if gain >= WALL_GAIN && best.as_ref().is_none_or(|b| score > b.0) {
                    best = Some((score, longer, wall));
                }
            }
        }
        let Some((_, longer, wall)) = best else { break };
        cells.extend(wall);
        len = longer;
    }
    cells
}

impl Bot {
    pub fn new(level: BotLevel, now: f64, rng: &mut Rng) -> Self {
        Self { level, think_at: now + rng.range(0.5, 2.5), blueprint: None, corridor: Vec::new() }
    }

    /// 想一次；回傳要做的事，並排好下次想的時間
    pub fn decide(&mut self, s: &Situation, now: f64, rng: &mut Rng) -> Decision {
        self.think_at = now + self.level.pace() * rng.range(0.7, 1.4);
        if s.maze && self.blueprint.is_none() {
            let cells = blueprint(s.field, self.level.maze());
            self.corridor = s.field.path_cells_with(&cells);
            self.blueprint = Some(cells);
        }
        // 派兵：自己守得住（塔夠多、命還夠）才派，拿一半的錢
        let towers = s.field.towers.len();
        let steady = s.wave >= 4 && towers >= 4 + s.wave as usize / 2 && s.field.lives >= 8;
        if steady && !s.units.is_empty() && rng.chance(self.level.sends()) {
            let budget = s.gold / 2;
            if let Some(&unit) = s.units.iter().rev().find(|&&u| UNITS[u].cost <= budget) {
                return Decision::Send { unit };
            }
        }
        self.strengthen(s, rng)
    }

    /// 蓋一座攻擊的塔或升級一座：挑最划算的
    fn strengthen(&self, s: &Situation, rng: &mut Rng) -> Decision {
        let f = s.field;
        let mut options: Vec<(f32, u32, Decision)> = Vec::new();
        let frosts = f.towers.iter().filter(|t| t.kind == TowerKind::Frost).count();
        let others = f.towers.len() - frosts;
        let mine = f.towers.iter().filter(|t| t.owner == s.seat).count();
        // 塔還不夠多：先多蓋幾座，不要把錢全部砸在同一座上
        let spread: f32 = if mine < 3 + s.wave as usize / 2 { 1.6 } else { 1.0 };
        // 快要來飛行怪：打得到天上的加分，打不到的扣分
        let air_weight = |kind: TowerKind| match (s.air_soon, kind.spec().air) {
            (true, true) => 1.5,
            (true, false) => 0.6,
            _ => 1.0,
        };
        for t in f.towers.iter().filter(|t| t.owner == s.seat && usize::from(t.level) < MAX_LEVEL) {
            let cost = t.kind.level(t.level + 1).cost;
            let value = if t.kind == TowerKind::Beacon {
                0.0
            } else {
                let cover = f.coverage(t.cell, t.kind.level(t.level + 1).range, s.air_soon && t.kind.spec().air);
                (power(t.kind, t.level + 1, s.hp) - power(t.kind, t.level, s.hp)) * cover * air_weight(t.kind)
                    / cost as f32
            };
            options.push((value, cost, Decision::Upgrade { id: t.id }));
        }
        // 新的塔蓋在哪：迷宮藍圖上還沒蓋的格子（塔就是牆，優先），或路線以外的空地（不動到路線、也不佔迷宮排好後怪物要走的格子）。
        // 多入口的地圖一開始最該守的是幾路會合的地方，那裡不一定在藍圖上，所以兩種都考慮
        let planned: Vec<usize> = match &self.blueprint {
            Some(cells) if s.maze => cells.iter().copied().filter(|&c| f.can_build(c).is_ok()).collect(),
            _ => Vec::new(),
        };
        let on_path = f.path_cells();
        let spare = (0..f.w * f.h).filter(|&c| {
            f.buildable(c) && !on_path.contains(&c) && !self.corridor.contains(&c) && !planned.contains(&c)
        });
        let free: Vec<(usize, f32)> = planned.iter().map(|&c| (c, 1.3)).chain(spare.map(|c| (c, 1.0))).collect();
        // 迷宮的價值：整張藍圖蓋完路線會變成 `maze()` 倍長，等於現有的火力多打這麼久；平均分給藍圖的每一格。
        // 只算一半（牆要整道蓋完才有用，中途的每一格沒那麼值錢），而且前幾波先顧火力，不然還沒排好就守不住了
        let wall = match &self.blueprint {
            Some(cells) if !planned.is_empty() && s.wave >= 6 => {
                let strength: f32 = f
                    .towers
                    .iter()
                    .filter(|t| t.owner == s.seat)
                    .map(|t| power(t.kind, t.level, s.hp) * f.coverage(t.cell, t.kind.level(t.level).range, false))
                    .sum();
                0.5 * strength * (self.level.maze() - 1.0) / cells.len().max(1) as f32
            }
            _ => 0.0,
        };
        for kind in ATTACKERS {
            // 冰霜塔是輔助：每五座別的塔配一座就好
            if kind == TowerKind::Frost && frosts * 5 >= others {
                continue;
            }
            let lv = kind.level(1);
            let air = s.air_soon && kind.spec().air;
            // 同一種蓋越多座分數越低：各種都蓋一些，之後才輪到升級
            let same = f.towers.iter().filter(|t| t.owner == s.seat && t.kind == kind).count();
            let variety = 1.0 / (1.0 + 0.2 * same as f32);
            let best = free
                .iter()
                .map(|&(c, bonus)| {
                    ((f.coverage(c, lv.range, air) + if air { f.air_cover(c, lv.range) } else { 0.0 }) * bonus, c)
                })
                .max_by(|a, b| a.0.total_cmp(&b.0));
            if let Some((cover, cell)) = best
                && cover > 0.0
            {
                let maze = if planned.contains(&cell) { wall } else { 0.0 };
                let value =
                    (power(kind, 1, s.hp) * cover * air_weight(kind) * spread * variety + maze) / lv.cost as f32;
                options.push((value, lv.cost, Decision::Build { cell, kind }));
            }
        }
        let affordable: Vec<&(f32, u32, Decision)> = options.iter().filter(|o| o.1 <= s.gold && o.0 > 0.0).collect();
        if self.level == BotLevel::Easy {
            // 簡單的電腦：買得起的隨便挑一個
            return if affordable.is_empty() { Decision::Wait } else { affordable[rng.below(affordable.len())].2 };
        }
        let Some(best) = options.iter().max_by(|a, b| a.0.total_cmp(&b.0)) else { return Decision::Wait };
        match affordable.iter().max_by(|a, b| a.0.total_cmp(&b.0)) {
            // 最划算的那個買不起、又好很多：先存錢（困難的電腦比較有耐心）。前幾波塔還很少，有錢就蓋
            Some(p)
                if s.wave >= 5
                    && best.1 > s.gold
                    && best.0 > p.0 * if self.level == BotLevel::Hard { 1.3 } else { 1.6 } =>
            {
                Decision::Wait
            }
            Some(p) => p.2,
            None => Decision::Wait,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::towerdefense_spec::{map, maps};

    fn situation(field: &Field, gold: u32, maze: bool, wave: u32) -> Situation<'_> {
        let hp = crate::towerdefense_spec::wave_hp(wave.max(1));
        Situation { field, seat: 0, gold, wave, hp, maze, air_soon: false, units: Vec::new() }
    }

    /// 讓電腦一直蓋到沒錢、或連續好幾次都不動為止（第 0 波：有錢就蓋，不會存錢等更好的）
    fn build_up(field: &mut Field, bot: &mut Bot, gold: u32, maze: bool, rng: &mut Rng) -> u32 {
        build_up_at(field, bot, gold, maze, 0, rng)
    }

    fn build_up_at(field: &mut Field, bot: &mut Bot, mut gold: u32, maze: bool, wave: u32, rng: &mut Rng) -> u32 {
        let mut idle = 0;
        while idle < 12 {
            match bot.decide(&situation(field, gold, maze, wave), 0.0, rng) {
                Decision::Build { cell, kind } => {
                    field.build(cell, kind, 0).unwrap();
                    gold -= kind.level(1).cost;
                    idle = 0;
                }
                Decision::Upgrade { id } => {
                    gold -= field.upgrade_cost(id).unwrap();
                    assert!(field.upgrade(id));
                    idle = 0;
                }
                Decision::Send { .. } => panic!("沒有能派的兵"),
                Decision::Wait => idle += 1,
            }
        }
        gold
    }

    #[test]
    fn the_blueprint_is_a_winding_maze_that_never_seals_the_route() {
        for m in maps() {
            let field = Field::new(m, 20, 5);
            let direct = field.path_len().unwrap();
            let cells = blueprint(&field, 3.4);
            let len = field.path_len_with(&cells).expect("藍圖不會堵死");
            // 兩路交叉的地圖一道牆只顧得到一路，排不了那麼長
            let enough = if m.spec.id == "cross" { 1.7 } else { 3.0 };
            assert!(len as f32 >= direct as f32 * enough, "{}：{direct} → {len}", m.spec.id);
            assert!(cells.iter().all(|&c| field.buildable(c)));
            let mut unique = cells.clone();
            unique.sort_unstable();
            unique.dedup();
            assert_eq!(unique.len(), cells.len());
        }
    }

    #[test]
    fn a_mazing_bot_builds_its_towers_as_the_walls() {
        let mut rng = Rng::new();
        let mut field = Field::new(map("plains").unwrap(), 20, 5);
        let direct = field.path_len().unwrap();
        let mut bot = Bot::new(BotLevel::Hard, 0.0, &mut rng);
        // 開局的錢：幾座塔都蓋在怪物會經過的地方
        build_up(&mut field, &mut bot, 300, true, &mut rng);
        assert!(field.towers.len() >= 2, "{}", field.towers.len());
        assert!(field.towers.iter().all(|t| field.coverage(t.cell, t.kind.level(1).range, false) > 0.0));
        // 打到中後期的錢：迷宮越排越長（手上的火力越強，補牆越划算）
        let left = build_up_at(&mut field, &mut bot, 9000, true, 15, &mut rng);
        let len = field.path_len().unwrap();
        assert!(len as f32 >= direct as f32 * 1.8, "{direct} → {len}");
        assert!(left < 9000);
        // 牆不是只有弩箭塔
        assert!(field.towers.iter().any(|t| t.kind != TowerKind::Bolt));
    }

    #[test]
    fn a_cooperative_bot_never_touches_the_route() {
        let mut rng = Rng::new();
        let mut field = Field::new(map("plains").unwrap(), 20, 5);
        let direct = field.path_len().unwrap();
        let before = field.routes[0].path.clone();
        let mut bot = Bot::new(BotLevel::Normal, 0.0, &mut rng);
        build_up(&mut field, &mut bot, 3000, false, &mut rng);
        assert!(field.towers.len() >= 5, "{}", field.towers.len());
        assert_eq!(field.path_len(), Some(direct));
        assert_eq!(field.routes[0].path, before);
        // 都蓋在打得到路線的地方
        assert!(field.towers.iter().all(|t| field.coverage(t.cell, t.kind.level(t.level).range, false) > 0.0));
    }

    #[test]
    fn bots_send_only_what_is_unlocked_and_affordable() {
        let mut rng = Rng::new();
        let mut field = Field::new(map("plains").unwrap(), 20, 5);
        for x in 3..10 {
            field.build(5 * field.w + x, TowerKind::Bolt, 0).unwrap();
        }
        let mut bot = Bot::new(BotLevel::Hard, 0.0, &mut rng);
        let mut sent = 0;
        for _ in 0..300 {
            let s = Situation {
                field: &field,
                seat: 0,
                gold: 200,
                wave: 5,
                hp: 50.0,
                maze: false,
                air_soon: false,
                units: vec![0, 1, 2],
            };
            if let Decision::Send { unit } = bot.decide(&s, 0.0, &mut rng) {
                assert!(unit <= 2 && UNITS[unit].cost <= 100);
                sent += 1;
            }
        }
        assert!(sent > 5, "{sent}");
        // 塔還沒幾座、或前幾波：先顧好自己，不派
        let empty = Field::new(map("plains").unwrap(), 20, 5);
        for _ in 0..300 {
            let s = Situation {
                field: &empty,
                seat: 0,
                gold: 200,
                wave: 5,
                hp: 50.0,
                maze: false,
                air_soon: false,
                units: vec![0, 1, 2],
            };
            assert!(!matches!(bot.decide(&s, 0.0, &mut rng), Decision::Send { .. }));
        }
    }
}
