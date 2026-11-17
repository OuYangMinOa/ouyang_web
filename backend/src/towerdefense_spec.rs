//! 迷宮塔防的數值：塔、怪物、波次、地圖、派兵（規則和房間見 `towerdefense.rs`，場地的模擬在 `towerdefense_field.rs`）。
//!
//! 前端不另外抄一份：`GET /api/games/towerdefense/spec` 把整張表送過去（塔和怪物的說明文字也在這裡），
//! 前端只有模型、顏色這些畫面上的東西，用 `id` 對起來。**改數值只要改這個檔案。**
//!
//! 調平衡時看 `towerdefense.rs` 的 `balance_report`（電腦自己打一場，印出每一波的狀況）。

use std::sync::OnceLock;

use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// 一座塔最高幾級
pub const MAX_LEVEL: usize = 4;
/// 賣掉拿回已經花在這座塔上的幾成（第一波開始前全額退，方便排迷宮）
pub const REFUND: f64 = 0.7;
/// 蓋好多久後才開始攻擊（秒）；擋路是馬上生效
pub const BUILD_TIME: f64 = 0.6;
/// 雷電塔往下一隻跳最遠多遠（格）、每跳一次傷害剩幾成
pub const CHAIN_REACH: f32 = 1.8;
pub const CHAIN_FALLOFF: f32 = 0.7;
/// 重弩無視多少比例的物理抗性
pub const PIERCE: f32 = 0.6;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TowerKind {
    Bolt,
    Cannon,
    Frost,
    Tesla,
    Poison,
    Sniper,
    Beacon,
}

/// 一級的數值；用不到的欄位是 0
#[derive(Clone, Copy, Debug, Serialize)]
pub struct TowerLevel {
    /// 蓋（第 1 級）或升到這一級要花的錢
    pub cost: u32,
    pub damage: f32,
    /// 幾秒打一次
    pub cooldown: f32,
    /// 射程（格）；號角塔是加成的範圍
    pub range: f32,
    /// 爆炸／冰霜的半徑（格），0 是只打一隻
    pub splash: f32,
    /// 減速幾成（0.3 = 慢 30%）
    pub slow: f32,
    /// 減速、中毒持續幾秒
    pub duration: f32,
    /// 中毒每秒的傷害
    pub dot: f32,
    /// 雷電一次打幾隻
    pub chain: u8,
    /// 號角塔：範圍內的塔傷害加幾成
    pub buff: f32,
}

pub struct TowerSpec {
    pub kind: TowerKind,
    pub name: &'static str,
    pub blurb: &'static str,
    /// 打不打得到飛行的、地面的
    pub air: bool,
    pub ground: bool,
    /// 魔法傷害（不看物理抗性，看魔法抗性）
    pub magic: bool,
    /// 砲彈飛多快（格／秒），0 是一開火就打到
    pub shot_speed: f32,
    pub levels: [TowerLevel; MAX_LEVEL],
}

const fn lv(cost: u32, damage: f32, cooldown: f32, range: f32) -> TowerLevel {
    TowerLevel { cost, damage, cooldown, range, splash: 0.0, slow: 0.0, duration: 0.0, dot: 0.0, chain: 0, buff: 0.0 }
}

const fn splash(mut l: TowerLevel, radius: f32) -> TowerLevel {
    l.splash = radius;
    l
}

const fn slow(mut l: TowerLevel, radius: f32, slow: f32, duration: f32) -> TowerLevel {
    l.splash = radius;
    l.slow = slow;
    l.duration = duration;
    l
}

const fn dot(mut l: TowerLevel, dot: f32, duration: f32) -> TowerLevel {
    l.dot = dot;
    l.duration = duration;
    l
}

const fn chain(mut l: TowerLevel, chain: u8) -> TowerLevel {
    l.chain = chain;
    l
}

const fn buff(cost: u32, range: f32, buff: f32) -> TowerLevel {
    let mut l = lv(cost, 0.0, 0.0, range);
    l.buff = buff;
    l
}

pub static TOWERS: [TowerSpec; 7] = [
    TowerSpec {
        kind: TowerKind::Bolt,
        name: "弩箭塔",
        blurb: "便宜、射得快，天上地下都打得到。拿來排迷宮的牆最划算。",
        air: true,
        ground: true,
        magic: false,
        shot_speed: 14.0,
        levels: [lv(50, 10.0, 0.8, 2.6), lv(60, 22.0, 0.75, 2.8), lv(130, 50.0, 0.7, 3.0), lv(300, 118.0, 0.6, 3.3)],
    },
    TowerSpec {
        kind: TowerKind::Cannon,
        name: "火砲塔",
        blurb: "砲彈落地會炸開，一次打一群；打不到飛行的怪。",
        air: false,
        ground: true,
        magic: false,
        shot_speed: 7.0,
        levels: [
            splash(lv(90, 20.0, 1.8, 2.8), 1.0),
            splash(lv(110, 44.0, 1.7, 3.0), 1.1),
            splash(lv(240, 100.0, 1.6, 3.2), 1.25),
            splash(lv(520, 235.0, 1.5, 3.5), 1.4),
        ],
    },
    TowerSpec {
        kind: TowerKind::Frost,
        name: "冰霜塔",
        blurb: "打中的那一圈怪都會變慢，傷害不高。魔王只會慢一半。",
        air: true,
        ground: true,
        magic: true,
        shot_speed: 10.0,
        levels: [
            slow(lv(70, 5.0, 1.0, 2.3), 0.9, 0.3, 2.0),
            slow(lv(80, 11.0, 1.0, 2.5), 1.0, 0.38, 2.2),
            slow(lv(170, 24.0, 0.9, 2.7), 1.1, 0.46, 2.5),
            slow(lv(360, 52.0, 0.8, 3.0), 1.3, 0.55, 3.0),
        ],
    },
    TowerSpec {
        kind: TowerKind::Tesla,
        name: "雷電塔",
        blurb: "閃電會在怪物之間跳，每跳一次弱三成。魔法傷害，鐵甲擋不住。",
        air: true,
        ground: true,
        magic: true,
        shot_speed: 0.0,
        levels: [
            chain(lv(120, 15.0, 1.1, 2.4), 3),
            chain(lv(140, 32.0, 1.05, 2.6), 4),
            chain(lv(300, 70.0, 1.0, 2.8), 5),
            chain(lv(640, 160.0, 0.9, 3.0), 6),
        ],
    },
    TowerSpec {
        kind: TowerKind::Poison,
        name: "毒藤塔",
        blurb: "讓怪物中毒、持續掉血，中毒時不能再生；會先找還沒中毒的。打不到飛行的怪。",
        air: false,
        ground: true,
        magic: true,
        shot_speed: 9.0,
        levels: [
            dot(lv(80, 4.0, 1.2, 2.5), 10.0, 4.0),
            dot(lv(100, 9.0, 1.1, 2.7), 22.0, 4.5),
            dot(lv(210, 20.0, 1.0, 2.9), 50.0, 5.0),
            dot(lv(460, 46.0, 0.8, 3.2), 116.0, 5.0),
        ],
    },
    TowerSpec {
        kind: TowerKind::Sniper,
        name: "重弩塔",
        blurb: "射程很遠、一發很痛，還能穿透大半的鐵甲，但是裝填很慢。預設先打血最多的。",
        air: true,
        ground: true,
        magic: false,
        shot_speed: 30.0,
        levels: [lv(140, 85.0, 3.0, 5.0), lv(160, 185.0, 2.9, 5.5), lv(340, 410.0, 2.8, 6.0), lv(720, 950.0, 2.6, 6.5)],
    },
    TowerSpec {
        kind: TowerKind::Beacon,
        name: "號角塔",
        blurb: "自己不攻擊，範圍內其他塔的傷害提高（隊友的塔也算）。同一座塔只吃最強的一支號角。",
        air: false,
        ground: false,
        magic: false,
        shot_speed: 0.0,
        levels: [buff(110, 1.6, 0.15), buff(130, 1.6, 0.25), buff(280, 2.1, 0.35), buff(600, 2.1, 0.5)],
    },
];

impl TowerKind {
    pub const ALL: [Self; 7] =
        [Self::Bolt, Self::Cannon, Self::Frost, Self::Tesla, Self::Poison, Self::Sniper, Self::Beacon];

    pub fn spec(self) -> &'static TowerSpec {
        &TOWERS[self as usize]
    }

    /// 第 `level` 級（1 起算）的數值
    pub fn level(self, level: u8) -> &'static TowerLevel {
        &self.spec().levels[usize::from(level).clamp(1, MAX_LEVEL) - 1]
    }

    /// 預設的瞄準方式
    pub fn default_mode(self) -> Mode {
        if self == Self::Sniper { Mode::Strong } else { Mode::First }
    }
}

/// 塔先打誰
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    /// 最靠近出口的
    First,
    /// 離出口最遠的
    Last,
    /// 血最多的
    Strong,
    /// 血最少的
    Weak,
    /// 離塔最近的
    Near,
}

impl Mode {
    pub const ALL: [Self; 5] = [Self::First, Self::Last, Self::Strong, Self::Weak, Self::Near];
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MonsterKind {
    Grunt,
    Runner,
    Brute,
    Swarm,
    Flyer,
    Regen,
    Splitter,
    Mudling,
    Ghost,
    Boss,
    Wyvern,
}

pub struct MonsterSpec {
    pub kind: MonsterKind,
    pub name: &'static str,
    pub blurb: &'static str,
    /// 血量是這一波基準血量的幾倍
    pub hp: f32,
    /// 每秒走幾格
    pub speed: f32,
    /// 受到物理、魔法傷害的幾成（1 = 沒有抗性）
    pub phys: f32,
    pub magic: f32,
    /// 賞金是這一波基準賞金的幾倍
    pub bounty: f32,
    /// 走到出口扣幾條命
    pub lives: u32,
    /// 飛行：不走迷宮，從入口直直飛向出口
    pub air: bool,
    /// 每秒回復最大血量的幾成（中毒時不回）
    pub regen: f32,
    /// 減速只有幾成效果（1 = 完全有效）
    pub slowable: f32,
    /// 被打倒時分裂出來的
    pub split: Option<(MonsterKind, u8)>,
    /// 身體的半徑（格），畫面用
    pub size: f32,
}

const fn mon(
    kind: MonsterKind,
    name: &'static str,
    blurb: &'static str,
    hp: f32,
    speed: f32,
    bounty: f32,
) -> MonsterSpec {
    MonsterSpec {
        kind,
        name,
        blurb,
        hp,
        speed,
        phys: 1.0,
        magic: 1.0,
        bounty,
        lives: 1,
        air: false,
        regen: 0.0,
        slowable: 1.0,
        split: None,
        size: 0.28,
    }
}

pub static MONSTERS: [MonsterSpec; 11] = [
    mon(MonsterKind::Grunt, "果凍怪", "最普通的怪，沒有特別的本事。", 1.0, 1.1, 1.0),
    MonsterSpec {
        size: 0.22,
        ..mon(MonsterKind::Runner, "飛毛腿", "血少但跑得飛快，迷宮不夠長就衝過去了。", 0.55, 2.1, 0.9)
    },
    MonsterSpec {
        phys: 0.45,
        size: 0.36,
        ..mon(
            MonsterKind::Brute,
            "鐵甲龜",
            "又慢又硬，物理傷害只吃得到不到一半。用雷電、毒或重弩對付。",
            2.3,
            0.75,
            2.2,
        )
    },
    MonsterSpec {
        size: 0.15,
        ..mon(MonsterKind::Swarm, "小蟲", "一隻很弱，但是一來就是一大群。範圍傷害最有效。", 0.22, 1.6, 0.35)
    },
    MonsterSpec {
        air: true,
        size: 0.24,
        ..mon(MonsterKind::Flyer, "蝙蝠", "用飛的，不走迷宮，從入口直直飛向出口。火砲和毒藤打不到。", 0.7, 1.5, 1.2)
    },
    MonsterSpec {
        regen: 0.03,
        size: 0.3,
        ..mon(MonsterKind::Regen, "樹精", "會自己回血，要一口氣打倒；中毒的時候不能回血。", 1.5, 1.0, 1.6)
    },
    MonsterSpec {
        split: Some((MonsterKind::Mudling, 3)),
        size: 0.32,
        ..mon(MonsterKind::Splitter, "泥巴怪", "被打倒會分裂成三隻小泥怪。", 1.3, 0.95, 1.0)
    },
    MonsterSpec {
        size: 0.17, ..mon(MonsterKind::Mudling, "小泥怪", "泥巴怪分裂出來的，跑得比較快。", 0.35, 1.5, 0.3)
    },
    MonsterSpec {
        magic: 0.4,
        size: 0.26,
        ..mon(MonsterKind::Ghost, "幽魂", "魔法傷害只吃得到四成，減速照樣有效。用弩箭、火砲、重弩打。", 1.1, 1.25, 1.4)
    },
    MonsterSpec {
        phys: 0.8,
        magic: 0.8,
        lives: 5,
        slowable: 0.5,
        size: 0.55,
        ..mon(
            MonsterKind::Boss,
            "魔王",
            "每十波來一次，血非常多，減速只有一半的效果，走到出口一次扣 5 條命。",
            14.0,
            0.6,
            12.0,
        )
    },
    MonsterSpec {
        air: true,
        lives: 5,
        slowable: 0.5,
        size: 0.5,
        ..mon(
            MonsterKind::Wyvern,
            "飛龍",
            "會飛的魔王：不走迷宮，要靠打得到天上的塔。走到出口一次扣 5 條命。",
            9.0,
            0.8,
            10.0,
        )
    },
];

impl MonsterKind {
    pub const ALL: [Self; 11] = [
        Self::Grunt,
        Self::Runner,
        Self::Brute,
        Self::Swarm,
        Self::Flyer,
        Self::Regen,
        Self::Splitter,
        Self::Mudling,
        Self::Ghost,
        Self::Boss,
        Self::Wyvern,
    ];

    pub fn spec(self) -> &'static MonsterSpec {
        &MONSTERS[self as usize]
    }
}

/// 一波裡的一批：`count` 隻 `kind`，這一波開始 `delay` 秒後每隔 `gap` 秒出一隻
#[derive(Clone, Copy, Debug)]
pub struct Group {
    pub kind: MonsterKind,
    pub count: u32,
    pub gap: f32,
    pub delay: f32,
}

const fn group(kind: MonsterKind, count: u32, gap: f32, delay: f32) -> Group {
    Group { kind, count, gap, delay }
}

/// 第 `n` 波（1 起算）出什麼：十波一輪，每一輪數量多三成；第 10、20… 波是魔王
pub fn wave(n: u32) -> Vec<Group> {
    use MonsterKind::*;
    let n = n.max(1);
    let tier = (n - 1) / 10;
    let c = |base: u32| ((base as f32) * (1.0 + 0.3 * tier as f32)).round() as u32;
    match (n - 1) % 10 + 1 {
        1 => vec![group(Grunt, c(10), 0.9, 0.0)],
        2 => vec![group(Grunt, c(8), 0.8, 0.0), group(Runner, c(6), 0.6, 5.0)],
        3 => vec![group(Swarm, c(24), 0.28, 0.0)],
        4 => vec![group(Brute, c(5), 1.6, 0.0), group(Grunt, c(8), 0.8, 2.0)],
        5 => vec![group(Flyer, c(10), 0.8, 0.0), group(Grunt, c(6), 0.9, 2.0)],
        6 => vec![group(Regen, c(8), 1.1, 0.0)],
        7 => vec![group(Splitter, c(8), 1.2, 0.0)],
        8 => vec![group(Ghost, c(10), 0.9, 0.0), group(Runner, c(8), 0.5, 4.0)],
        9 => vec![group(Brute, c(6), 1.4, 0.0), group(Flyer, c(8), 0.7, 3.0), group(Swarm, c(16), 0.25, 7.0)],
        // 單數輪（第 10、30… 波）是魔王，雙數輪（第 20、40… 波）多一隻飛龍
        _ if tier.is_multiple_of(2) => vec![group(Boss, 1 + tier / 2, 8.0, 0.0), group(Grunt, c(10), 0.7, 2.0)],
        _ => vec![group(Boss, tier.div_ceil(2), 8.0, 0.0), group(Wyvern, 1, 0.0, 4.0), group(Flyer, c(8), 0.7, 6.0)],
    }
}

/// 第 1 波的基準血量，之後每一波是上一波的 `HP_GROWTH` 倍。
/// 迷宮排得越長，每隻怪挨打的時間越久，所以血量要漲得比收入快很多，後面的波才有壓力
const HP_BASE: f32 = 26.0;
const HP_GROWTH: f32 = 1.19;

/// 第 `n` 波的基準血量
pub fn wave_hp(n: u32) -> f32 {
    HP_BASE * HP_GROWTH.powi(n.max(1) as i32 - 1)
}

/// 第 `n` 波的基準賞金（每隻怪再乘上自己的倍率，至少 1）
pub fn wave_bounty(n: u32) -> f32 {
    5.0 + 0.45 * (n.max(1) - 1) as f32
}

/// 第 `n` 波打完，每個人的獎金
pub fn wave_bonus(n: u32) -> u32 {
    20 + 5 * n
}

/// 這一波出完要多久（秒）
pub fn wave_span(groups: &[Group]) -> f32 {
    groups.iter().map(|g| g.delay + g.gap * g.count.saturating_sub(1) as f32).fold(0.0, f32::max)
}

/// 對抗模式可以派去打別人的怪
pub struct Unit {
    pub kind: MonsterKind,
    /// 一次派幾隻
    pub count: u32,
    pub cost: u32,
    /// 每波開始時的收入加多少
    pub income: u32,
    /// 第幾波開始才能派
    pub unlock: u32,
}

pub static UNITS: [Unit; 7] = [
    Unit { kind: MonsterKind::Grunt, count: 3, cost: 30, income: 3, unlock: 2 },
    Unit { kind: MonsterKind::Runner, count: 4, cost: 45, income: 4, unlock: 3 },
    Unit { kind: MonsterKind::Swarm, count: 10, cost: 60, income: 5, unlock: 4 },
    Unit { kind: MonsterKind::Brute, count: 2, cost: 90, income: 7, unlock: 6 },
    Unit { kind: MonsterKind::Flyer, count: 4, cost: 110, income: 8, unlock: 8 },
    Unit { kind: MonsterKind::Ghost, count: 4, cost: 140, income: 10, unlock: 11 },
    Unit { kind: MonsterKind::Boss, count: 1, cost: 450, income: 25, unlock: 15 },
];

/// 派去的怪血量是那一波基準的幾成、被打倒時對方拿到的賞金是幾成
pub const SEND_HP: f32 = 0.9;
pub const SEND_BOUNTY: f32 = 0.5;

/// 地圖上的一格
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Tile {
    /// 空地：可以蓋塔，怪物也能走
    Ground,
    /// 岩石：不能蓋、不能走
    Rock,
    /// 通道（入口、出口和它們前面那一格）：怪物能走，不能蓋
    Walk,
}

pub struct MapSpec {
    pub id: &'static str,
    pub name: &'static str,
    pub blurb: &'static str,
    /// 一列一個字串：`.` 空地、`#` 岩石、`_` 通道、`a`／`b` 入口、`A`／`B` 出口（`b` 沒有 `B` 時走 `A`）
    pub rows: &'static [&'static str],
}

pub static MAPS: [MapSpec; 4] = [
    MapSpec {
        id: "plains",
        name: "曠野",
        blurb: "一個入口、一個出口，中間一大片空地隨你排。",
        rows: &[
            ".....................",
            ".....................",
            "......#..............",
            "......#.......#......",
            "..............#......",
            ".....................",
            "a_................._A",
            ".....................",
            "......#..............",
            "......#.......#......",
            "..............#......",
            ".....................",
            ".....................",
        ],
    },
    MapSpec {
        id: "forks",
        name: "雙岔口",
        blurb: "兩個入口的怪會合成一路，迷宮要兩邊都顧到。",
        rows: &[
            ".....................",
            ".....................",
            ".....................",
            "a_...................",
            ".........##..........",
            ".....................",
            ".....................",
            "....#.............._A",
            ".....................",
            ".....................",
            ".........##..........",
            "b_...................",
            ".....................",
            ".....................",
            ".....................",
        ],
    },
    MapSpec {
        id: "cross",
        name: "十字路口",
        blurb: "一路從左到右、一路從上到下，在中間交叉：一座迷宮要同時拖住兩路。",
        rows: &[
            "........b........",
            "........_........",
            ".................",
            ".................",
            "....#.......#....",
            ".................",
            ".................",
            ".................",
            "a_............._A",
            ".................",
            ".................",
            ".................",
            "....#.......#....",
            ".................",
            ".................",
            "........_........",
            "........B........",
        ],
    },
    MapSpec {
        id: "canyon",
        name: "大峽谷",
        blurb: "最大的一張，岩壁已經隔出幾道關口。人多的時候才蓋得滿。",
        rows: &[
            "...........................",
            "......#.............#......",
            "......#.............#......",
            "......#......#......#......",
            ".............#.............",
            ".............#.............",
            ".............#.............",
            "a_......................._A",
            ".............#.............",
            ".............#.............",
            ".............#.............",
            "......#......#......#......",
            "......#.............#......",
            "......#.............#......",
            "...........................",
        ],
    },
];

/// 解析好的地圖
pub struct MapData {
    pub spec: &'static MapSpec,
    pub w: usize,
    pub h: usize,
    pub tiles: Vec<Tile>,
    /// 每一路的（入口格, 出口格）
    pub routes: Vec<(usize, usize)>,
}

fn parse(spec: &'static MapSpec) -> MapData {
    let h = spec.rows.len();
    let w = spec.rows[0].chars().count();
    let mut tiles = Vec::with_capacity(w * h);
    let mut spawns: Vec<(char, usize)> = Vec::new();
    let mut exits: Vec<(char, usize)> = Vec::new();
    for (y, row) in spec.rows.iter().enumerate() {
        assert_eq!(row.chars().count(), w, "地圖 {} 第 {y} 列的長度不對", spec.id);
        for (x, ch) in row.chars().enumerate() {
            let cell = y * w + x;
            tiles.push(match ch {
                '.' => Tile::Ground,
                '#' => Tile::Rock,
                '_' => Tile::Walk,
                'a'..='z' => {
                    spawns.push((ch, cell));
                    Tile::Walk
                }
                'A'..='Z' => {
                    exits.push((ch.to_ascii_lowercase(), cell));
                    Tile::Walk
                }
                other => panic!("地圖 {} 有看不懂的字 {other:?}", spec.id),
            });
        }
    }
    spawns.sort_unstable();
    let fallback = exits.iter().find(|(ch, _)| *ch == 'a').expect("地圖要有出口 A").1;
    let routes = spawns
        .iter()
        .map(|&(ch, spawn)| (spawn, exits.iter().find(|(e, _)| *e == ch).map_or(fallback, |&(_, cell)| cell)))
        .collect();
    MapData { spec, w, h, tiles, routes }
}

pub fn maps() -> &'static [MapData] {
    static PARSED: OnceLock<Vec<MapData>> = OnceLock::new();
    PARSED.get_or_init(|| MAPS.iter().map(parse).collect())
}

pub fn map(id: &str) -> Option<&'static MapData> {
    maps().iter().find(|m| m.spec.id == id)
}

/// 整張表（前端開頁面時抓一次）
fn spec_json() -> Value {
    let towers: Vec<Value> = TOWERS
        .iter()
        .map(|t| {
            json!({
                "id": t.kind,
                "name": t.name,
                "blurb": t.blurb,
                "air": t.air,
                "ground": t.ground,
                "magic": t.magic,
                "shotSpeed": t.shot_speed,
                "mode": t.kind.default_mode(),
                "levels": t.levels,
            })
        })
        .collect();
    let monsters: Vec<Value> = MONSTERS
        .iter()
        .map(|m| {
            json!({
                "id": m.kind,
                "name": m.name,
                "blurb": m.blurb,
                "hp": m.hp,
                "speed": m.speed,
                "phys": m.phys,
                "magic": m.magic,
                "bounty": m.bounty,
                "lives": m.lives,
                "air": m.air,
                "regen": m.regen,
                "slowable": m.slowable,
                "split": m.split.map(|(kind, count)| json!({ "kind": kind, "count": count })),
                "size": m.size,
            })
        })
        .collect();
    let units: Vec<Value> = UNITS
        .iter()
        .map(|u| json!({ "kind": u.kind, "count": u.count, "cost": u.cost, "income": u.income, "unlock": u.unlock }))
        .collect();
    let maps: Vec<Value> = maps()
        .iter()
        .map(|m| {
            json!({
                "id": m.spec.id,
                "name": m.spec.name,
                "blurb": m.spec.blurb,
                "w": m.w,
                "h": m.h,
                "rows": m.spec.rows,
                "routes": m.routes.iter().map(|&(spawn, exit)| json!([spawn, exit])).collect::<Vec<_>>(),
            })
        })
        .collect();
    json!({
        "towers": towers,
        "monsters": monsters,
        "units": units,
        "maps": maps,
        "maxLevel": MAX_LEVEL,
        "refund": REFUND,
        "buildTime": BUILD_TIME,
        "sendHp": SEND_HP,
    })
}

/// `GET /api/games/towerdefense/spec`
pub async fn spec() -> Json<&'static Value> {
    static SPEC: OnceLock<Value> = OnceLock::new();
    Json(SPEC.get_or_init(spec_json))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tables_line_up_with_the_enums() {
        for (i, kind) in TowerKind::ALL.iter().enumerate() {
            assert_eq!(TOWERS[i].kind, *kind);
            assert_eq!(kind.spec().kind, *kind);
        }
        for (i, kind) in MonsterKind::ALL.iter().enumerate() {
            assert_eq!(MONSTERS[i].kind, *kind);
        }
        // 分裂出來的不能再分裂（不然打不完）
        for m in &MONSTERS {
            if let Some((child, count)) = m.split {
                assert!(child.spec().split.is_none());
                assert!(count > 0);
            }
        }
    }

    #[test]
    fn towers_get_stronger_with_each_level() {
        for t in &TOWERS {
            for pair in t.levels.windows(2) {
                assert!(pair[1].range >= pair[0].range, "{}", t.name);
                assert!(pair[1].damage >= pair[0].damage, "{}", t.name);
                assert!(pair[1].buff >= pair[0].buff, "{}", t.name);
                assert!(pair[1].cost > pair[0].cost, "{} 升級要比上一級貴", t.name);
            }
            assert!(t.kind == TowerKind::Beacon || t.levels[0].cooldown > 0.0);
        }
    }

    #[test]
    fn maps_parse_and_every_route_has_both_ends() {
        for m in maps() {
            assert!(m.w >= 9 && m.h >= 9 && m.w <= 62 && m.h <= 62, "{}", m.spec.id);
            assert_eq!(m.tiles.len(), m.w * m.h);
            assert!(!m.routes.is_empty());
            for &(spawn, exit) in &m.routes {
                assert_ne!(spawn, exit);
                assert_eq!(m.tiles[spawn], Tile::Walk);
                assert_eq!(m.tiles[exit], Tile::Walk);
            }
        }
        assert!(map("plains").is_some());
        assert!(map("nowhere").is_none());
    }

    #[test]
    fn waves_grow_and_bosses_come_every_tenth() {
        assert!(wave(10).iter().any(|g| g.kind == MonsterKind::Boss));
        assert!(wave(20).iter().any(|g| g.kind == MonsterKind::Wyvern));
        assert!(wave(1).iter().all(|g| g.kind == MonsterKind::Grunt));
        let total = |n: u32| wave(n).iter().map(|g| g.count).sum::<u32>();
        assert!(total(11) > total(1));
        assert!(wave_hp(30) > wave_hp(10) * 10.0);
        for n in 1..=60 {
            assert!(!wave(n).is_empty());
            assert!(wave(n).iter().all(|g| g.count > 0), "第 {n} 波有一批是 0 隻");
        }
    }
}
