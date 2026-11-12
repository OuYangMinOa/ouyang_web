//! 機甲對戰的多人連線（派對房間的遊戲，房間本身見 `party.rs`；畫面、物理和地圖在 `frontend/src/games/mecha/`）。
//!
//! 分紅、藍兩隊，先把對方擊倒 `kill_target` 次的隊伍贏（時間到就比擊倒數）。
//! 和 3D 賽車一樣，物理在每個人的瀏覽器裡跑，伺服器不算物理、也不知道大樓在哪裡，只當裁判：
//! - 每個人每秒送 20 次自己機甲的狀態（`Action::State`，格式見 `STATE_LEN`），
//!   伺服器每個 `TICK`（50 毫秒）把有更新的機甲、血量變化和這段時間的傷害合併成一則 `tick` 事件送給所有人。
//! - 開火是不是打中，由開火的人的瀏覽器判斷（打的是他畫面上的位置），打中了送 `Action::Hit`。
//!   傷害由伺服器照武器和開火那台的機甲種類（`MechKind`）決定，用戶端只說「打中誰、用什麼打」。伺服器檢查：
//!   - 兩邊都還活著、不同隊、距離在射程內（用雙方最後回報的位置算）。
//!   - 主武器（速度型的機砲、狙擊型的電磁砲、偵察型的脈衝步槍）每秒最多幾發（多一點寬限），超過的不算。
//!     狙擊型的電磁砲打中頭（`Hit::head`，打到哪裡由用戶端判斷）一發擊倒，不管是哪一種機甲。
//!   - 飛彈要先發射（`Action::Missile`，每條命 `MISSILES` 發），一發飛彈只能在 `MISSILE_LIFE` 內打中，最多 `MISSILE_HITS` 台（爆風）。
//!   - 偵察型的偵察機（每條命 `DRONES` 架）引爆時送 `Action::Boom`（爆炸的位置和炸到誰）。偵察機在外面時，它的位置和鏡頭方向
//!     跟著機甲的狀態一起送（`STATE_LEN`）：爆炸點要在偵察機最後回報的位置附近（`DRONE_SLACK`；偵察機飛多遠都可以，
//!     只是越遠畫面越糊，那是用戶端的事），被炸的人最後回報的位置要在爆炸點附近（`DRONE_REACH`）。炸到的一律擊倒。
//!     掃描、標記敵人都是用戶端自己算，伺服器不管。
//!   - 偵察機可以被主武器打下來（`Hit::drone`）：被打的那台最後回報的狀態裡要有偵察機、而且是這條命現在這一架
//!     （旗標裡帶著第幾架，打下來、引爆之後還在路上的舊狀態不算），距離在射程內；累積 `DRONE_HP` 就擊落，
//!     少一架並送 `{type:"downed", seat, by, n}`（`n` 是這條命的第幾架）給所有人。
//!   - 堡壘型「要塞」、砲擊型「隕星」可以變身（狀態旗標的 `F_DEPLOY`，變身時不能走）：堡壘型變身後換成射速快很多的重機槍，
//!     主武器的額度照旗標算（`MechKind::gun`）；砲擊型變身後沒有主武器，改發射迫擊砲彈（`Action::Shell`，每秒最多 `SHELL_RATE` 發）：
//!     伺服器記下砲口和初速，打中時（`Weapon::Shell`）被打的人最後回報的位置要在這發砲彈的彈道附近（`SHELL_REACH`），
//!     一發最多炸到 `SHELL_HITS` 台，炸到的一律擊倒。堡壘型前面的盾牌擋不擋得住由開火的人那邊判斷（和大樓擋子彈一樣），伺服器不管。
//!   - 在自己家重生點（`in_base`）裡的人打不到、也不能開火；敵人進不去由用戶端的能量牆擋。
//!
//!   改用戶端還是可以作弊（例如自動瞄準），但打不出超過武器上限的傷害。
//! - 血量歸零就倒下，`RESPAWN` 後在自己家的重生點復活（`life` 加一，飛彈補滿）。
//!   還在路上的、上一條命的狀態和開火都不算（狀態裡帶著第幾條命）。
//! - 選隊：房主按開始後有 `SELECT` 讓每個人選紅隊或藍隊（`Action::Team`）和機體（`Action::Mech`）。兩隊人數最多差一個；
//!   想去的那隊人比較多時，那隊有電腦就跟電腦交換。連著線的人都按了「準備好了」或時間到，就倒數 `COUNTDOWN` 開打。
//!   機體沿用上一局選的；電腦第一局隨便挑一台。
//! - 開打後換機體（`Action::Mech`）：倒下等復活的時候（復活就是新選的那台），或站在自己家的重生點裡
//!   （最後回報的位置；馬上換，像重新出擊一樣：血、飛彈、偵察機補滿，`life` 加一，還在路上的舊狀態和開火都不算）。
//! - 電腦：伺服器沒有物理，所以指定一位真人（`driver`）在他的瀏覽器裡開所有電腦，
//!   電腦的狀態跟著他自己的一起送（`State::bots`），電腦開火打中也由他回報（`Hit::by`），檢查規則跟真人一樣。
//!   他斷線、或 `BOT_STALE` 沒送電腦的狀態（切到背景時瀏覽器不跑畫面）就輪給下一位連著線的真人。
//! - 對時（`Action::Ping`）和 3D 賽車一樣：用戶端照來回時間對準伺服器的時鐘，別人的機甲才推算得準。

use std::{collections::HashMap, sync::Arc, time::Duration};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::time::Instant;

use crate::{
    AppState,
    party::{Ctx, Parties, PartyGame, To},
};

/// 選隊的時間
const SELECT: Duration = Duration::from_secs(20);
/// 選完隊到開打的倒數（前兩秒讓大家載入地圖）
const COUNTDOWN: Duration = Duration::from_secs(5);
/// 倒下後多久復活
const RESPAWN: Duration = Duration::from_secs(5);
/// 速度型、狙擊型、偵察型、堡壘型、砲擊型機甲的耐久（`frontend/src/games/mecha/spec.ts` 的 `MECHS.*.hp`）
pub const SPEED_HP: u32 = 200;
pub const SNIPER_HP: u32 = 240;
pub const RECON_HP: u32 = 210;
pub const FORTRESS_HP: u32 = 320;
pub const MORTAR_HP: u32 = 220;
/// 每條命幾發飛彈
pub const MISSILES: u32 = 2;
/// 一擊擊倒的傷害（偵察機爆炸、迫擊砲彈、狙擊型打中頭）：扣到剩多少血就算多少
const KILL: u32 = u32::MAX;
/// 速度型的機砲近距離的傷害；`GUN_FALLOFF` 公尺以外慢慢降到 `GUN_FAR_DAMAGE`
const GUN_DAMAGE: f64 = 8.0;
const GUN_FAR_DAMAGE: f64 = 4.0;
const GUN_FALLOFF: f64 = 100.0;
/// 機砲的射程（用戶端 230 公尺），雙方的位置都是一小段時間以前的，再寬鬆一點
const GUN_RANGE: f64 = 260.0;
/// 機砲每秒幾發（用戶端兩支槍輪流，每秒 10 發）
const GUN_RATE: f64 = 10.0;
/// 機砲的寬限：最多一次累積幾發（網路忽快忽慢，幾則打中的通知可能擠在一起到）
const GUN_BURST: f64 = 15.0;
/// 狙擊型的電磁砲：一發的傷害（不分遠近）、射程（用戶端 420 公尺）、每秒幾發（用戶端 0.9 發）、寬限
const CANNON_DAMAGE: u32 = 50;
const CANNON_RANGE: f64 = 460.0;
const CANNON_RATE: f64 = 1.0;
const CANNON_BURST: f64 = 2.0;
/// 偵察型的脈衝步槍：一發的傷害（不分遠近）、射程（用戶端 260 公尺）、每秒幾發（用戶端 5 發）、寬限
const RIFLE_DAMAGE: u32 = 11;
const RIFLE_RANGE: f64 = 290.0;
const RIFLE_RATE: f64 = 5.0;
const RIFLE_BURST: f64 = 8.0;
/// 堡壘型的機槍（一般模式的輕機槍、變身後的重機槍一樣）：近距離一發的傷害，`MG_FALLOFF` 公尺以外慢慢降到 `MG_FAR_DAMAGE`
const MG_DAMAGE: f64 = 7.0;
const MG_FAR_DAMAGE: f64 = 4.0;
const MG_FALLOFF: f64 = 110.0;
/// 一般模式的輕機槍：射程（用戶端 200 公尺）、每秒幾發（用戶端 6 發）、寬限
const LMG_RANGE: f64 = 230.0;
const LMG_RATE: f64 = 6.0;
const LMG_BURST: f64 = 10.0;
/// 變身後的重機槍（四門輪流）：射程（用戶端 260 公尺）、每秒幾發（用戶端 24 發）、寬限
const HMG_RANGE: f64 = 290.0;
const HMG_RATE: f64 = 24.0;
const HMG_BURST: f64 = 36.0;
/// 砲擊型一般模式的卡賓槍：一發的傷害（不分遠近）、射程（用戶端 190 公尺）、每秒幾發（用戶端 4 發）、寬限
const CARBINE_DAMAGE: u32 = 9;
const CARBINE_RANGE: f64 = 220.0;
const CARBINE_RATE: f64 = 4.0;
const CARBINE_BURST: f64 = 7.0;
/// 迫擊砲彈（`spec.ts` 的 `SHELL`）：爆炸半徑內炸到的一律擊倒（`KILL`）；
/// 每秒最多幾發（用戶端 2.4 秒一發）、寬限；一發最多炸到幾台
const SHELL_RATE: f64 = 0.5;
const SHELL_BURST: f64 = 2.0;
const SHELL_HITS: usize = 6;
/// 砲彈發射後多久內打中才算（仰角最高時大約飛 8 秒，從屋頂打到河床再久一點）
const SHELL_LIFE: Duration = Duration::from_secs(14);
/// 砲彈往下掉的加速度（用戶端 `SHELL.gravity`）、最快的初速（用戶端固定 `SHELL.speed` = 137，再寬鬆一點）
const SHELL_GRAVITY: f64 = 36.0;
const SHELL_SPEED: f64 = 150.0;
/// 砲口離發射的人最後回報的位置最遠多遠（水平、垂直）
const SHELL_ORIGIN: f64 = 16.0;
/// 被炸的人（最後回報的腳底往上 3 公尺）離彈道最遠多遠：爆炸半徑 10 公尺加上機甲的大小、位置是一小段時間以前的
const SHELL_REACH: f64 = 24.0;
/// 偵察型每條命幾架偵察機（`spec.ts` 的 `MECHS.recon.drones`）
pub const DRONES: u32 = 2;
/// 爆炸點離偵察機最後回報的位置最遠多遠（偵察機最快每秒 26 公尺、狀態每秒送 20 次，再寬鬆一點）
const DRONE_SLACK: f64 = 30.0;
/// 被炸的人（最後回報的腳底往上 3 公尺）離爆炸點最遠多遠：爆炸半徑 9 公尺加上機甲的大小、位置是一小段時間以前的
const DRONE_REACH: f64 = 20.0;
/// 一次爆炸最多炸到幾台
const DRONE_HITS: usize = 4;
/// 偵察機的耐久：主武器累積打這麼多就擊落（`spec.ts` 的 `DRONE.hp`）
const DRONE_HP: u32 = 30;
/// 飛彈直接命中、爆風的傷害
const MISSILE_DAMAGE: u32 = 60;
const SPLASH_DAMAGE: u32 = 30;
/// 飛彈發射後多久內打中才算（用戶端飛 5 秒就自爆）
const MISSILE_LIFE: Duration = Duration::from_secs(8);
/// 一發飛彈的爆風最多打到幾台
const MISSILE_HITS: usize = 3;
/// 飛彈最遠打得到多遠（每秒 70 公尺飛 5 秒，再寬鬆一點）
const MISSILE_RANGE: f64 = 420.0;
/// 機甲狀態的數字個數：
/// [時間（毫秒）, x, y, z, vx, vy, vz, 腳的方向, 瞄準的水平角, 瞄準的仰角, 旗標, 第幾條命, 偵察機的 x, y, z, 偵察機鏡頭的水平角, 仰角]，
/// 伺服器只看位置、第幾條命和偵察機，其他原封不動轉送（用戶端的編碼在 `online.ts`；沒放偵察機時偵察機的那幾個數字是 0）
pub const STATE_LEN: usize = 17;
const X: usize = 1;
const Y: usize = 2;
const Z: usize = 3;
const FLAGS: usize = 10;
const LIFE: usize = 11;
const DRONE_X: usize = 12;
/// 旗標：偵察機在外面、是這條命的第二架（`online.ts` 的 `F_DRONE`、`F_DRONE2`）
const F_DRONE: u32 = 2048;
const F_DRONE2: u32 = 4096;
/// 旗標：堡壘型、砲擊型變身了（變身中、變身好了都是；`online.ts` 的 `F_DEPLOY`）
const F_DEPLOY: u32 = 8192;
/// 狀態裡的數字不會超過這個（地圖在 ±460 公尺內；比這大的一定是亂送的）
const MAX_VALUE: f64 = 1e6;
/// 一則打中通知最多幾筆
const MAX_HITS: usize = 96;
/// 電腦的狀態多久沒進來就換人開
const BOT_STALE: Duration = Duration::from_secs(2);
/// 重生點（機庫）：紅隊在西邊（x < 0）、藍隊在東邊，`|x| >= BASE_X` 而且 `|z| <= BASE_Z` 的地方
/// （`frontend/src/games/mecha/map.ts` 的 `BASE`，改了要一起改）
const BASE_X: f64 = 286.0;
const BASE_Z: f64 = 30.0;

/// 位置 (x, z) 在 `team` 這隊的重生點裡
fn in_base(team: usize, x: f64, z: f64) -> bool {
    let inward = if team == 0 { -x } else { x };
    inward >= BASE_X && z.abs() <= BASE_Z
}

/// 打中距離 `d` 公尺外的傷害：`falloff` 公尺以內是 `near`，到 `range` 公尺慢慢降到 `far`
fn falloff(d: f64, near: f64, far: f64, falloff: f64, range: f64) -> u32 {
    let t = ((d - falloff) / (range - falloff)).clamp(0.0, 1.0);
    (near + (far - near) * t).round() as u32
}

/// 機砲打中距離 `d` 公尺外的傷害
fn gun_damage(d: f64) -> u32 {
    falloff(d, GUN_DAMAGE, GUN_FAR_DAMAGE, GUN_FALLOFF, GUN_RANGE - 30.0)
}

/// 堡壘型的機槍打中距離 `d` 公尺外的傷害
fn mg_damage(d: f64) -> u32 {
    falloff(d, MG_DAMAGE, MG_FAR_DAMAGE, MG_FALLOFF, HMG_RANGE - 30.0)
}

/// 機甲的種類（對應 `spec.ts` 的 `MechKind`）：速度型「疾風」、狙擊型「長弓」、偵察型「渡鴉」、堡壘型「要塞」、砲擊型「隕星」
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum MechKind {
    #[default]
    Speed,
    Sniper,
    Recon,
    Fortress,
    Mortar,
}

impl MechKind {
    const ALL: [Self; 5] = [Self::Speed, Self::Sniper, Self::Recon, Self::Fortress, Self::Mortar];

    fn max_hp(self) -> u32 {
        match self {
            Self::Speed => SPEED_HP,
            Self::Sniper => SNIPER_HP,
            Self::Recon => RECON_HP,
            Self::Fortress => FORTRESS_HP,
            Self::Mortar => MORTAR_HP,
        }
    }

    /// 主武器的射程、每秒幾發、最多累積幾發；`deployed` 是變身了（堡壘型換成重機槍，砲擊型沒有主武器、改發射砲彈）
    fn gun(self, deployed: bool) -> Option<(f64, f64, f64)> {
        Some(match (self, deployed) {
            (Self::Speed, _) => (GUN_RANGE, GUN_RATE, GUN_BURST),
            (Self::Sniper, _) => (CANNON_RANGE, CANNON_RATE, CANNON_BURST),
            (Self::Recon, _) => (RIFLE_RANGE, RIFLE_RATE, RIFLE_BURST),
            (Self::Fortress, false) => (LMG_RANGE, LMG_RATE, LMG_BURST),
            (Self::Fortress, true) => (HMG_RANGE, HMG_RATE, HMG_BURST),
            (Self::Mortar, false) => (CARBINE_RANGE, CARBINE_RATE, CARBINE_BURST),
            (Self::Mortar, true) => return None,
        })
    }

    /// 一開始（沒變身）主武器的額度
    fn burst(self) -> f64 {
        self.gun(false).map_or(0.0, |g| g.2)
    }

    /// 主武器打中距離 `d` 公尺外的傷害
    fn damage(self, d: f64) -> u32 {
        match self {
            Self::Speed => gun_damage(d),
            Self::Sniper => CANNON_DAMAGE,
            Self::Recon => RIFLE_DAMAGE,
            Self::Fortress => mg_damage(d),
            Self::Mortar => CARBINE_DAMAGE,
        }
    }

    /// 可以變身（堡壘型、砲擊型）
    fn deploys(self) -> bool {
        matches!(self, Self::Fortress | Self::Mortar)
    }

    /// 每條命幾架偵察機
    fn drones(self) -> u32 {
        if self == Self::Recon { DRONES } else { 0 }
    }
}

const TEAM_NAMES: [&str; 2] = ["紅隊", "藍隊"];

/// 電腦的難度（電腦在用戶端開，伺服器只轉告；對應 `bot.ts` 的 Difficulty）
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum Difficulty {
    Easy,
    #[default]
    Normal,
    Hard,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Options {
    /// 先擊倒對方幾次的隊伍贏
    pub kill_target: u32,
    /// 時間上限（分鐘），時間到比擊倒數
    pub time_limit: u32,
    pub difficulty: Difficulty,
}

impl Default for Options {
    fn default() -> Self {
        Self { kill_target: 10, time_limit: 10, difficulty: Difficulty::Normal }
    }
}

#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Weapon {
    Gun,
    Missile,
    /// 砲擊型的迫擊砲彈
    Shell,
}

#[derive(Deserialize, Debug)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Action {
    /// 自己機甲現在的狀態，格式見 `STATE_LEN`；倒下時沒有 `d`。
    /// 負責開電腦的人順便送電腦的狀態，每列是 [座位, ...狀態]
    State {
        #[serde(default)]
        d: Option<[f64; STATE_LEN]>,
        #[serde(default)]
        bots: Vec<[f64; STATE_LEN + 1]>,
    },
    /// 打中別人（同一段時間的合成一則）
    Hit { hits: Vec<Hit> },
    /// 發射飛彈：`id` 是發射的人自己編的號碼（打中時用來對），`o` 是發射的位置、`dir` 是方向、`target` 是鎖定的座位，
    /// `goal` 是發射時準星對到的那一點（沒鎖定的飛彈先往上飛，再下來往這一點飛）。
    /// 伺服器數這條命還剩幾發，再轉給其他人畫出來。`by` 是負責開電腦的人替電腦發射
    Missile {
        id: u32,
        o: [f64; 3],
        dir: [f64; 3],
        #[serde(default)]
        target: Option<usize>,
        #[serde(default)]
        goal: Option<[f64; 3]>,
        #[serde(default)]
        by: Option<usize>,
    },
    /// 偵察型引爆偵察機：`o` 是爆炸的位置，`hits` 是炸到的座位（看不看得到爆炸點由用戶端判斷）。
    /// 伺服器數這條命還剩幾架、檢查距離，再轉給其他人畫出爆炸。`by` 是負責開電腦的人替電腦引爆
    Boom {
        o: [f64; 3],
        #[serde(default)]
        hits: Vec<usize>,
        #[serde(default)]
        by: Option<usize>,
        /// 這條命的第幾架（0 起算）：已經被打下來、還在路上的引爆不算
        #[serde(default)]
        n: Option<u32>,
    },
    /// 砲擊型（變身了）發射迫擊砲彈：`id` 是發射的人自己編的號碼（打中時用來對），`o` 是砲口的位置、`v` 是初速
    /// （之後照 `SHELL_GRAVITY` 往下掉）。伺服器檢查射速、記下彈道，再轉給其他人畫出來。`by` 是負責開電腦的人替電腦發射
    Shell {
        id: u32,
        o: [f64; 3],
        v: [f64; 3],
        #[serde(default)]
        by: Option<usize>,
    },
    /// 對時：伺服器只回給送的人 `{type:"pong", t, clock}`，`clock` 是伺服器現在的比賽時間（毫秒，開打前是負的）
    Ping { t: f64 },
    /// 選隊時換隊：0 是紅隊、1 是藍隊
    Team { team: usize },
    /// 換機體：選隊時隨時可以換（按了準備好就不行）；開打後只有倒下時、或站在自己家的重生點裡
    Mech { mech: MechKind },
    /// 選好隊了
    Ready,
}

#[derive(Deserialize, Debug)]
pub struct Hit {
    /// 被打中的座位
    seat: usize,
    w: Weapon,
    /// 飛彈、砲彈的號碼（`Action::Missile`、`Action::Shell` 的 `id`）
    #[serde(default)]
    id: Option<u32>,
    /// 飛彈直接命中（false 是爆風）
    #[serde(default)]
    direct: bool,
    /// 主武器打中頭（只有狙擊型的電磁砲有差：一發擊倒）
    #[serde(default)]
    head: bool,
    /// 開火的是自己開的電腦（座位）；自己打的不用填
    #[serde(default)]
    by: Option<usize>,
    /// 打中的是 `seat` 放出去的偵察機（只有主武器打得下來）
    #[serde(default)]
    drone: bool,
}

/// 飛行中的飛彈
struct Flight {
    id: u32,
    fired: Instant,
    /// 已經打到的座位（同一台只算一次）
    hits: Vec<usize>,
}

/// 飛行中的迫擊砲彈：砲口、初速（彈道照這兩個和重力算）
struct Shell {
    id: u32,
    fired: Instant,
    o: [f64; 3],
    v: [f64; 3],
    hits: Vec<usize>,
}

impl Shell {
    /// `c` 在彈道附近（`SHELL_REACH`）：每 0.1 秒取一點，掉到河床底下很深就不用再算
    fn passes(&self, c: [f64; 3]) -> bool {
        let steps = (SHELL_LIFE.as_secs_f64() * 10.0) as u32;
        for k in 0..=steps {
            let t = f64::from(k) * 0.1;
            let p = [
                self.o[0] + self.v[0] * t,
                self.o[1] + self.v[1] * t - 0.5 * SHELL_GRAVITY * t * t,
                self.o[2] + self.v[2] * t,
            ];
            if p[1] < -60.0 {
                break;
            }
            if ((p[0] - c[0]).powi(2) + (p[1] - c[1]).powi(2) + (p[2] - c[2]).powi(2)).sqrt() <= SHELL_REACH {
                return true;
            }
        }
        false
    }
}

struct Pilot {
    team: usize,
    kind: MechKind,
    hp: u32,
    alive: bool,
    respawn_at: Option<Instant>,
    /// 第幾條命（從 1 開始）
    life: u32,
    /// 這條命還剩幾發飛彈
    missiles: u32,
    flights: Vec<Flight>,
    /// 這條命還剩幾架偵察機（引爆、被打下來才少）
    drones: u32,
    /// 外面那架偵察機被打了多少
    drone_dmg: u32,
    /// 最後一次回報的狀態，倒下時清掉
    state: Option<[f64; STATE_LEN]>,
    /// 上一個 tick 之後有沒有新的狀態
    fresh: bool,
    kills: u32,
    deaths: u32,
    /// 打出去的總傷害
    damage: u32,
    /// 主武器的額度：每秒補幾發，最多累積幾發（照機甲種類和有沒有變身，見 `MechKind::gun`）
    ammo: f64,
    ammo_at: Instant,
    /// 砲擊型：飛行中的砲彈、發射砲彈的額度（`SHELL_RATE`）
    shells: Vec<Shell>,
    shell_ammo: f64,
    shell_at: Instant,
}

impl Pilot {
    fn new(team: usize, kind: MechKind, now: Instant) -> Self {
        Self {
            team,
            kind,
            hp: kind.max_hp(),
            alive: true,
            respawn_at: None,
            life: 1,
            missiles: MISSILES,
            flights: Vec::new(),
            drones: kind.drones(),
            drone_dmg: 0,
            state: None,
            fresh: false,
            kills: 0,
            deaths: 0,
            damage: 0,
            ammo: kind.burst(),
            ammo_at: now,
            shells: Vec::new(),
            shell_ammo: SHELL_BURST,
            shell_at: now,
        }
    }

    /// 最後回報的狀態裡是變身了的（只有堡壘型、砲擊型會變身）
    fn deployed(&self) -> bool {
        self.kind.deploys() && self.state.is_some_and(|d| d[FLAGS] as u32 & F_DEPLOY != 0)
    }

    fn pos(&self) -> Option<(f64, f64)> {
        self.state.map(|d| (d[X], d[Z]))
    }

    /// 身體中間（腳底往上 3 公尺）的位置
    fn center(&self) -> Option<[f64; 3]> {
        self.state.map(|d| [d[X], d[Y] + 3.0, d[Z]])
    }

    /// 這條命現在這一架偵察機是第幾架（0 起算）
    fn drone_index(&self) -> u32 {
        self.kind.drones().saturating_sub(self.drones)
    }

    /// 外面那架偵察機的位置：最後回報的狀態裡有偵察機、而且是現在這一架（打下來、引爆後的舊狀態不算）
    fn drone_at(&self) -> Option<[f64; 3]> {
        let d = self.state?;
        let flags = d[FLAGS] as u32;
        let second = flags & F_DRONE2 != 0;
        if self.drones == 0 || flags & F_DRONE == 0 || second != (self.drone_index() % 2 == 1) {
            return None;
        }
        Some([d[DRONE_X], d[DRONE_X + 1], d[DRONE_X + 2]])
    }

    /// 用掉一發主武器的額度；沒有額度就是打太快了（變身前後的射速不一樣，照最後回報的狀態）
    fn take_round(&mut self, now: Instant) -> bool {
        let Some((_, rate, burst)) = self.kind.gun(self.deployed()) else { return false };
        let refill = now.saturating_duration_since(self.ammo_at).as_secs_f64() * rate;
        self.ammo = (self.ammo + refill).min(burst);
        self.ammo_at = now;
        if self.ammo < 1.0 {
            return false;
        }
        self.ammo -= 1.0;
        true
    }

    /// 用掉一發砲彈的額度；沒有額度就是打太快了
    fn take_shell(&mut self, now: Instant) -> bool {
        let refill = now.saturating_duration_since(self.shell_at).as_secs_f64() * SHELL_RATE;
        self.shell_ammo = (self.shell_ammo + refill).min(SHELL_BURST);
        self.shell_at = now;
        if self.shell_ammo < 1.0 {
            return false;
        }
        self.shell_ammo -= 1.0;
        true
    }
}

pub struct Mecha {
    /// 這個房間的第幾局：用戶端靠它知道「換新的一局了」
    game: u32,
    options: Options,
    pilots: Vec<Pilot>,
    pids: Vec<u32>,
    bots: Vec<bool>,
    /// 選隊的截止時間；選完了（開始倒數）是 None
    select_until: Option<Instant>,
    /// 選隊時每個座位按了「準備好了」沒有（電腦一開始就好了）
    ready: Vec<bool>,
    /// 開打的時間
    go: Instant,
    /// 時間上限
    limit_at: Instant,
    /// 結算時的比賽時間；None 表示還在打
    ended: Option<Duration>,
    /// 贏的隊伍；平手是 None
    winner: Option<usize>,
    /// 兩隊的擊倒數
    score: [u32; 2],
    /// 這個房間累計的勝場（pid → 場）
    wins: HashMap<u32, u32>,
    /// 負責開電腦的座位
    driver: Option<usize>,
    /// 最後一次收到電腦狀態的時間
    bots_heard: Instant,
    /// 血量有變，下一個 tick 要送
    hp_dirty: bool,
    /// 這個 tick 的傷害：[開火的座位, 被打的座位, 傷害, 0 機槍／1 飛彈]
    damage: Vec<[u32; 4]>,
}

/// 開局時分隊：上一局的人盡量留在原本那隊，新來的人補到人少的那隊，電腦最後補；兩隊最多差一個
fn first_teams(ctx: &mut Ctx, previous: Option<&Mecha>) -> Vec<usize> {
    let n = ctx.seats.len();
    let cap = n.div_ceil(2);
    let last = |pid: u32| previous.and_then(|p| p.pids.iter().position(|&q| q == pid).map(|s| p.pilots[s].team));
    let mut teams: Vec<Option<usize>> = vec![None; n];
    let mut count = [0usize; 2];
    // 先排有上一局隊伍的真人，再排新來的真人，最後是電腦
    let mut order: Vec<usize> = (0..n).filter(|&s| !ctx.seats[s].bot && last(ctx.seats[s].pid).is_some()).collect();
    order.extend((0..n).filter(|&s| !ctx.seats[s].bot && last(ctx.seats[s].pid).is_none()));
    order.extend((0..n).filter(|&s| ctx.seats[s].bot));
    for s in order {
        let smaller = if count[0] == count[1] {
            ctx.rng.below(2)
        } else if count[0] < count[1] {
            0
        } else {
            1
        };
        let want = last(ctx.seats[s].pid).filter(|&t| !ctx.seats[s].bot && count[t] < cap).unwrap_or(smaller);
        let team = if count[want] < cap { want } else { 1 - want };
        teams[s] = Some(team);
        count[team] += 1;
    }
    teams.into_iter().map(Option::unwrap_or_default).collect()
}

/// 送出去的一列機甲狀態：[座位, ...狀態]
fn row(seat: usize, d: &[f64; STATE_LEN]) -> Value {
    let mut row = Vec::with_capacity(STATE_LEN + 1);
    row.push(json!(seat));
    row.extend(d.iter().map(|v| json!(v)));
    Value::Array(row)
}

impl Mecha {
    fn is_bot(&self, seat: usize) -> bool {
        self.bots.get(seat).copied().unwrap_or(false)
    }

    fn has_bots(&self) -> bool {
        self.bots.contains(&true)
    }

    fn running(&self, now: Instant) -> bool {
        self.ended.is_none() && self.select_until.is_none() && now >= self.go
    }

    fn team_size(&self, team: usize) -> usize {
        self.pilots.iter().filter(|p| p.team == team).count()
    }

    /// 換人開電腦：從 `after` 的下一個座位開始輪，找連著線的真人（輪一圈都沒有別人就還是 `after` 自己）
    fn hand_over(&mut self, after: Option<usize>, ctx: &mut Ctx) {
        let n = self.bots.len();
        let first = after.map_or(0, |s| s + 1);
        let next = (0..n).map(|k| (first + k) % n).find(|&s| !self.bots[s] && ctx.seats[s].online);
        self.bots_heard = ctx.now.max(self.go);
        if next != self.driver {
            self.driver = next;
            ctx.changed();
        }
    }

    /// 記下一台機甲的狀態；亂送的數字、倒下時和上一條命的狀態直接丟掉
    fn store(&mut self, seat: usize, d: [f64; STATE_LEN]) {
        if d.iter().any(|v| !v.is_finite() || v.abs() > MAX_VALUE) {
            return;
        }
        let p = &mut self.pilots[seat];
        if !p.alive || d[LIFE] != f64::from(p.life) {
            return;
        }
        p.state = Some(d);
        p.fresh = true;
    }

    /// 選隊時換隊：兩隊最多差一個，想去的那隊人比較多時跟那隊的電腦交換
    fn switch(&mut self, seat: usize, team: usize, ctx: &mut Ctx) -> Result<(), String> {
        if team > 1 {
            return Err("沒有這一隊".into());
        }
        if self.ready[seat] {
            return Err("你已經準備好了，這局不能再換隊".into());
        }
        let from = self.pilots[seat].team;
        if from == team {
            ctx.quiet();
            return Ok(());
        }
        if self.team_size(team) < self.team_size(from) {
            self.pilots[seat].team = team;
        } else if let Some(bot) = (0..self.pilots.len()).find(|&s| self.bots[s] && self.pilots[s].team == team) {
            self.pilots[bot].team = from;
            self.pilots[seat].team = team;
        } else {
            return Err(format!("{}人比較多，等有人換過來再換", TEAM_NAMES[team]));
        }
        ctx.changed();
        Ok(())
    }

    /// 選隊時換機體（按了「準備好了」就不能換）
    fn choose(&mut self, seat: usize, mech: MechKind, ctx: &mut Ctx) -> Result<(), String> {
        if self.ready[seat] {
            return Err("你已經準備好了，這局不能再換機體".into());
        }
        let p = &mut self.pilots[seat];
        if p.kind == mech {
            ctx.quiet();
            return Ok(());
        }
        p.kind = mech;
        p.hp = mech.max_hp();
        p.ammo = mech.burst();
        p.drones = mech.drones();
        p.drone_dmg = 0;
        ctx.changed();
        Ok(())
    }

    /// 開打後換機體：倒下時改的是復活的那台；活著要站在自己家的重生點裡（還沒回報過位置就是剛出生，在機庫裡），
    /// 馬上換成新的一台（血、飛彈、偵察機補滿），`life` 加一：還在路上的舊狀態、開火都不算，用戶端照新的 `life` 在原地換機體
    fn swap(&mut self, seat: usize, mech: MechKind, ctx: &mut Ctx) -> Result<(), String> {
        let p = &mut self.pilots[seat];
        if p.kind == mech {
            ctx.quiet();
            return Ok(());
        }
        if p.alive {
            if !p.pos().is_none_or(|(x, z)| in_base(p.team, x, z)) {
                return Err("回到自己家的機庫（重生點）才能換機體".into());
            }
            p.life += 1;
            p.hp = mech.max_hp();
            p.missiles = MISSILES;
            p.flights.clear();
            p.shells.clear();
            p.state = None;
            p.fresh = false;
            self.hp_dirty = true;
        }
        p.kind = mech;
        p.drones = mech.drones();
        p.drone_dmg = 0;
        p.ammo = mech.burst();
        p.ammo_at = ctx.now;
        p.shell_ammo = SHELL_BURST;
        ctx.changed();
        Ok(())
    }

    /// 選隊時：連著線的真人都準備好了（斷線的不等）、或時間到了，就開始倒數
    fn check_select(&mut self, ctx: &mut Ctx) {
        let Some(until) = self.select_until else { return };
        let all_ready = (0..self.ready.len()).all(|s| self.ready[s] || !ctx.seats[s].online);
        if !all_ready && ctx.now < until {
            return;
        }
        self.select_until = None;
        self.go = ctx.now + COUNTDOWN;
        self.limit_at = self.go + Duration::from_secs(u64::from(self.options.time_limit) * 60);
        self.bots_heard = self.go;
        let [red, blue] = [0, 1].map(|t| self.team_size(t));
        ctx.system(
            To::All,
            format!("{red} 對 {blue}，5 秒後開打！先擊倒對方 {} 次的隊伍贏。", self.options.kill_target),
        );
        ctx.changed();
    }

    /// 結算：贏的隊伍每人加一場勝場
    fn end(&mut self, winner: Option<usize>, ctx: &mut Ctx) {
        self.ended = Some(ctx.now.saturating_duration_since(self.go));
        self.winner = winner;
        let [red, blue] = self.score;
        match winner {
            Some(team) => {
                for (s, p) in self.pilots.iter().enumerate() {
                    if p.team == team {
                        *self.wins.entry(self.pids[s]).or_default() += 1;
                    }
                }
                ctx.announce(To::All, format!("{}獲勝！（紅 {red} : {blue} 藍）", TEAM_NAMES[team]), "accent");
            }
            None => ctx.announce(To::All, format!("平手！（紅 {red} : {blue} 藍）"), "accent"),
        }
        ctx.changed();
    }

    /// 倒下：記擊倒、扣分、排復活，達到目標就結算；`weapon` 是擊倒訊息裡的武器（gun、head、missile、drone、shell）
    fn kill(&mut self, killer: usize, victim: usize, weapon: &str, ctx: &mut Ctx) {
        let v = &mut self.pilots[victim];
        v.alive = false;
        v.hp = 0;
        v.deaths += 1;
        v.state = None;
        v.fresh = false;
        v.flights.clear();
        v.shells.clear();
        v.respawn_at = Some(ctx.now + RESPAWN);
        let k = &mut self.pilots[killer];
        k.kills += 1;
        let team = k.team;
        self.score[team] += 1;
        ctx.emit(To::All, json!({ "type": "kill", "killer": killer, "victim": victim, "w": weapon }));
        ctx.changed();
        if self.score[team] >= self.options.kill_target {
            self.end(Some(team), ctx);
        }
    }

    /// 打中通知：檢查合不合理，算傷害
    fn hit(&mut self, seat: usize, hit: &Hit, ctx: &mut Ctx) {
        let n = self.pilots.len();
        let shooter = hit.by.unwrap_or(seat);
        // 只有負責開電腦的人可以替電腦開火
        if hit.by.is_some() && (self.driver != Some(seat) || !self.is_bot(shooter)) {
            return;
        }
        let target = hit.seat;
        if target >= n || target == shooter || self.ended.is_some() {
            return;
        }
        let (s, t) = (&self.pilots[shooter], &self.pilots[target]);
        if !s.alive || !t.alive || s.team == t.team {
            return;
        }
        if hit.drone {
            self.hit_drone(shooter, target, hit.w, ctx);
            return;
        }
        let (Some((sx, sz)), Some((tx, tz))) = (s.pos(), t.pos()) else { return };
        // 重生點裡不能開火、也打不到
        if in_base(t.team, tx, tz) || in_base(0, sx, sz) || in_base(1, sx, sz) {
            return;
        }
        let d = (tx - sx).hypot(tz - sz);
        let (amount, kind, weapon) = match hit.w {
            Weapon::Gun => {
                let p = &mut self.pilots[shooter];
                let mech = p.kind;
                let Some((range, _, _)) = mech.gun(p.deployed()) else { return };
                if d > range || !p.take_round(ctx.now) {
                    return;
                }
                // 狙擊型打中頭：一發擊倒
                if hit.head && mech == MechKind::Sniper { (KILL, 0, "head") } else { (mech.damage(d), 0, "gun") }
            }
            Weapon::Missile => {
                let now = ctx.now;
                let Some(id) = hit.id else { return };
                let Some(flight) = self.pilots[shooter]
                    .flights
                    .iter_mut()
                    .find(|f| f.id == id && now.saturating_duration_since(f.fired) <= MISSILE_LIFE)
                else {
                    return;
                };
                if d > MISSILE_RANGE || flight.hits.contains(&target) || flight.hits.len() >= MISSILE_HITS {
                    return;
                }
                flight.hits.push(target);
                (if hit.direct { MISSILE_DAMAGE } else { SPLASH_DAMAGE }, 1, "missile")
            }
            Weapon::Shell => {
                let now = ctx.now;
                let (Some(id), Some(c)) = (hit.id, self.pilots[target].center()) else { return };
                let Some(shell) = self.pilots[shooter]
                    .shells
                    .iter_mut()
                    .find(|s| s.id == id && now.saturating_duration_since(s.fired) <= SHELL_LIFE)
                else {
                    return;
                };
                if shell.hits.contains(&target) || shell.hits.len() >= SHELL_HITS || !shell.passes(c) {
                    return;
                }
                shell.hits.push(target);
                (KILL, 4, "shell")
            }
        };
        self.deal(shooter, target, amount, kind, weapon, ctx);
    }

    /// 主武器打中 `target` 放出去的偵察機：累積 `DRONE_HP` 就擊落（少一架，通知所有人）。
    /// 傷害照開火那台的主武器算，tick 裡的種類是 3（被打的人看得到偵察機還剩多少）
    fn hit_drone(&mut self, shooter: usize, target: usize, w: Weapon, ctx: &mut Ctx) {
        if w != Weapon::Gun {
            return;
        }
        let Some(c) = self.pilots[shooter].center() else { return };
        let Some(o) = self.pilots[target].drone_at() else { return };
        if in_base(0, c[0], c[2]) || in_base(1, c[0], c[2]) {
            return;
        }
        let d = ((o[0] - c[0]).powi(2) + (o[1] - c[1]).powi(2) + (o[2] - c[2]).powi(2)).sqrt();
        let p = &mut self.pilots[shooter];
        let mech = p.kind;
        let Some((range, _, _)) = mech.gun(p.deployed()) else { return };
        if d > range || !p.take_round(ctx.now) {
            return;
        }
        let t = &mut self.pilots[target];
        let dealt = mech.damage(d).min(DRONE_HP - t.drone_dmg);
        t.drone_dmg += dealt;
        self.damage.push([shooter as u32, target as u32, dealt, 3]);
        if t.drone_dmg >= DRONE_HP {
            let n = t.drone_index();
            t.drones -= 1;
            t.drone_dmg = 0;
            ctx.emit(To::All, json!({ "type": "downed", "seat": target, "by": shooter, "n": n }));
            ctx.changed();
        }
    }

    /// 扣血、記傷害，沒血就倒下；`kind` 是 tick 裡傷害的種類（0 主武器、1 飛彈、2 偵察機、4 迫擊砲彈；3 是打偵察機，見 `hit_drone`）
    fn deal(&mut self, shooter: usize, target: usize, amount: u32, kind: u32, weapon: &str, ctx: &mut Ctx) {
        let t = &mut self.pilots[target];
        let dealt = amount.min(t.hp);
        t.hp -= dealt;
        let dead = t.hp == 0;
        self.pilots[shooter].damage += dealt;
        self.damage.push([shooter as u32, target as u32, dealt, kind]);
        self.hp_dirty = true;
        if dead {
            self.kill(shooter, target, weapon, ctx);
        }
    }

    /// 引爆偵察機：要是偵察型、這條命還有偵察機、爆炸點在偵察機最後回報的位置附近；轉給其他人畫出爆炸，炸到的人擊倒
    fn boom(
        &mut self,
        seat: usize,
        o: [f64; 3],
        hits: &[usize],
        (by, n): (Option<usize>, Option<u32>),
        ctx: &mut Ctx,
    ) -> Result<(), String> {
        let shooter = by.unwrap_or(seat);
        if by.is_some() && (self.driver != Some(seat) || !self.is_bot(shooter)) {
            ctx.quiet();
            return Ok(());
        }
        if o.iter().any(|v| !v.is_finite() || v.abs() > MAX_VALUE) {
            return Err("看不懂這架偵察機".into());
        }
        let p = &self.pilots[shooter];
        let Some((sx, sz)) = p.pos() else {
            ctx.quiet();
            return Ok(());
        };
        let stale = n.is_some_and(|n| n != p.drone_index());
        // 狀態裡沒有偵察機（沒放出去、已經被打下來），或爆炸點離它最後的位置太遠：不算
        let near = p.drone_at().is_some_and(|d| {
            ((d[0] - o[0]).powi(2) + (d[1] - o[1]).powi(2) + (d[2] - o[2]).powi(2)).sqrt() <= DRONE_SLACK
        });
        if !p.alive || p.drones == 0 || stale || !near {
            ctx.quiet();
            return Ok(());
        }
        self.pilots[shooter].drones -= 1;
        self.pilots[shooter].drone_dmg = 0;
        ctx.emit(To::Except(seat), json!({ "type": "boom", "seat": shooter, "o": o }));
        ctx.changed();
        // 從重生點裡放的不算（用戶端也不讓放）
        if in_base(0, sx, sz) || in_base(1, sx, sz) {
            return Ok(());
        }
        let team = self.pilots[shooter].team;
        let mut done: Vec<usize> = Vec::new();
        for &target in hits {
            if done.len() >= DRONE_HITS || done.contains(&target) || target >= self.pilots.len() || target == shooter {
                continue;
            }
            let t = &self.pilots[target];
            let Some(c) = t.center() else { continue };
            if !t.alive || t.team == team || in_base(t.team, c[0], c[2]) {
                continue;
            }
            let d = ((c[0] - o[0]).powi(2) + (c[1] - o[1]).powi(2) + (c[2] - o[2]).powi(2)).sqrt();
            if d > DRONE_REACH {
                continue;
            }
            done.push(target);
            self.deal(shooter, target, KILL, 2, "drone", ctx);
            if self.ended.is_some() {
                break;
            }
        }
        Ok(())
    }

    /// 發射飛彈：這條命還有沒有，有的話轉給其他人畫出來
    fn missile(&mut self, seat: usize, action: MissileShot, ctx: &mut Ctx) -> Result<(), String> {
        let shooter = action.by.unwrap_or(seat);
        if action.by.is_some() && (self.driver != Some(seat) || !self.is_bot(shooter)) {
            ctx.quiet();
            return Ok(());
        }
        let bad = |v: &[f64; 3]| v.iter().any(|x| !x.is_finite() || x.abs() > MAX_VALUE);
        if bad(&action.o)
            || bad(&action.dir)
            || action.goal.as_ref().is_some_and(bad)
            || action.target.is_some_and(|t| t >= self.pilots.len())
        {
            return Err("看不懂這發飛彈".into());
        }
        let now = ctx.now;
        let p = &mut self.pilots[shooter];
        if !p.alive || p.flights.iter().any(|f| f.id == action.id) {
            ctx.quiet();
            return Ok(());
        }
        if p.missiles == 0 {
            // 電腦的不用回錯誤（不是他自己的）
            if action.by.is_some() {
                ctx.quiet();
                return Ok(());
            }
            return Err("這條命的飛彈用完了".into());
        }
        p.missiles -= 1;
        p.flights.push(Flight { id: action.id, fired: now, hits: Vec::new() });
        ctx.emit(
            To::Except(seat),
            json!({
                "type": "missile",
                "seat": shooter,
                "id": action.id,
                "o": action.o,
                "dir": action.dir,
                "target": action.target,
                "goal": action.goal,
            }),
        );
        ctx.changed();
        Ok(())
    }
}

struct MissileShot {
    id: u32,
    o: [f64; 3],
    dir: [f64; 3],
    target: Option<usize>,
    goal: Option<[f64; 3]>,
    by: Option<usize>,
}

impl Mecha {
    /// 發射迫擊砲彈：要是變身好了的砲擊型、不在重生點裡、砲口在自己旁邊、初速不會快到射太遠、沒有打太快；
    /// 記下彈道（打中時檢查被炸的人在不在彈道附近），轉給其他人畫出來
    fn shell(
        &mut self,
        seat: usize,
        id: u32,
        o: [f64; 3],
        v: [f64; 3],
        by: Option<usize>,
        ctx: &mut Ctx,
    ) -> Result<(), String> {
        ctx.quiet();
        let shooter = by.unwrap_or(seat);
        if by.is_some() && (self.driver != Some(seat) || !self.is_bot(shooter)) {
            return Ok(());
        }
        if o.iter().chain(&v).any(|x| !x.is_finite() || x.abs() > MAX_VALUE) {
            return Err("看不懂這發砲彈".into());
        }
        let now = ctx.now;
        let p = &mut self.pilots[shooter];
        let Some(d) = p.state else { return Ok(()) };
        let near = (o[0] - d[X]).hypot(o[2] - d[Z]) <= SHELL_ORIGIN && (o[1] - d[Y]).abs() <= SHELL_ORIGIN;
        let speed = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
        if !p.alive
            || p.kind != MechKind::Mortar
            || !p.deployed()
            || in_base(0, d[X], d[Z])
            || in_base(1, d[X], d[Z])
            || !near
            || speed > SHELL_SPEED
            || p.shells.iter().any(|s| s.id == id)
            || !p.take_shell(now)
        {
            return Ok(());
        }
        p.shells.push(Shell { id, fired: now, o, v, hits: Vec::new() });
        ctx.emit(To::Except(seat), json!({ "type": "shell", "seat": shooter, "id": id, "o": o, "v": v }));
        Ok(())
    }
}

impl PartyGame for Mecha {
    const ID: &'static str = "mecha";
    const MIN_PLAYERS: usize = 2;
    /// 最多 30 對 30
    const MAX_PLAYERS: usize = 60;
    /// 至少要一個真人負責開電腦，所以最多 59 台
    const MAX_BOTS: usize = 59;
    /// 合併轉送機甲狀態的間隔
    const TICK: Duration = Duration::from_millis(50);
    /// 狀態每秒 20 則，加上打中（用戶端每秒最多 10 則）、對時、聊天；
    /// 負責開電腦的人還要替幾十台電腦發射飛彈、砲彈、引爆偵察機（每發一則）
    const MSGS_PER_SEC: u32 = 100;
    /// 負責開電腦的人一則狀態裡最多有 59 台電腦（每台 16 個數字）
    const MAX_FRAME_BYTES: usize = 32 * 1024;

    type Options = Options;
    type Action = Action;

    fn rooms(state: &AppState) -> &Arc<Parties<Self>> {
        &state.mecha
    }

    fn check_options(options: Options) -> Result<Options, String> {
        if !matches!(options.kill_target, 10 | 20 | 30 | 50 | 100) {
            return Err("擊倒目標只能選 10、20、30、50、100 次".into());
        }
        if !matches!(options.time_limit, 5 | 10 | 15 | 20 | 30) {
            return Err("時間只能選 5、10、15、20、30 分鐘".into());
        }
        Ok(options)
    }

    fn start(options: &Options, previous: Option<&Self>, ctx: &mut Ctx) -> Self {
        let n = ctx.seats.len();
        let select_until = ctx.now + SELECT;
        let go = select_until + COUNTDOWN;
        let teams = first_teams(ctx, previous);
        // 機體：上一局選的；沒有的話電腦隨便挑一台、真人先給速度型
        let kinds: Vec<MechKind> = ctx
            .seats
            .iter()
            .map(|s| {
                let last = previous.and_then(|p| p.pids.iter().position(|&q| q == s.pid).map(|i| p.pilots[i].kind));
                last.unwrap_or_else(|| {
                    if s.bot { MechKind::ALL[ctx.rng.below(MechKind::ALL.len())] } else { MechKind::Speed }
                })
            })
            .collect();
        ctx.system(
            To::All,
            format!(
                "新的一局：先擊倒對方 {} 次的隊伍贏（{} 分鐘）。{} 秒內選好隊伍，大家都準備好就開始！",
                options.kill_target,
                options.time_limit,
                SELECT.as_secs()
            ),
        );
        ctx.changed();
        let bots: Vec<bool> = ctx.seats.iter().map(|s| s.bot).collect();
        let driver = if bots.contains(&true) { (0..n).find(|&s| !bots[s] && ctx.seats[s].online) } else { None };
        Self {
            game: previous.map_or(1, |p| p.game + 1),
            options: options.clone(),
            pilots: teams.iter().zip(&kinds).map(|(&t, &k)| Pilot::new(t, k, ctx.now)).collect(),
            pids: ctx.seats.iter().map(|s| s.pid).collect(),
            select_until: Some(select_until),
            ready: bots.clone(),
            go,
            limit_at: go + Duration::from_secs(u64::from(options.time_limit) * 60),
            ended: None,
            winner: None,
            score: [0, 0],
            wins: previous.map(|p| p.wins.clone()).unwrap_or_default(),
            bots,
            driver,
            bots_heard: go,
            hp_dirty: false,
            damage: Vec::new(),
        }
    }

    fn act(&mut self, seat: usize, action: Action, ctx: &mut Ctx) -> Result<(), String> {
        if self.ended.is_some() {
            // 結算後還在路上的狀態不用理，也不用回錯誤
            ctx.quiet();
            return Ok(());
        }
        let selecting = self.select_until.is_some();
        match action {
            Action::Team { team } if selecting => self.switch(seat, team, ctx),
            Action::Team { .. } => Err("已經開打了，這局不能換隊".into()),
            Action::Mech { mech } if selecting => self.choose(seat, mech, ctx),
            Action::Mech { mech } => self.swap(seat, mech, ctx),
            Action::Ready => {
                if selecting && !self.ready[seat] {
                    self.ready[seat] = true;
                    ctx.changed();
                    self.check_select(ctx);
                } else {
                    ctx.quiet();
                }
                Ok(())
            }
            Action::Ping { t } => {
                ctx.quiet();
                let clock = if ctx.now >= self.go {
                    ctx.now.duration_since(self.go).as_millis() as i64
                } else {
                    -(self.go.duration_since(ctx.now).as_millis() as i64)
                };
                ctx.emit(To::Seat(seat), json!({ "type": "pong", "t": t, "clock": clock }));
                Ok(())
            }
            // 選隊時還沒有機甲在動
            Action::State { .. }
            | Action::Hit { .. }
            | Action::Missile { .. }
            | Action::Boom { .. }
            | Action::Shell { .. }
                if selecting =>
            {
                ctx.quiet();
                Ok(())
            }
            Action::State { d, bots } => {
                // 狀態只靠 tick 合併轉送，不重送 view；格式不對的直接丟掉
                ctx.quiet();
                if let Some(d) = d {
                    self.store(seat, d);
                }
                // 電腦的狀態只收負責開的人送的。他每一則都算「還在跑」（電腦都倒下時也會送空的來）
                if self.driver == Some(seat) {
                    self.bots_heard = ctx.now;
                    for row in bots {
                        let bot = row[0];
                        if bot >= 0.0 && bot.fract() == 0.0 && self.is_bot(bot as usize) {
                            let mut d = [0.0; STATE_LEN];
                            d.copy_from_slice(&row[1..]);
                            self.store(bot as usize, d);
                        }
                    }
                }
                Ok(())
            }
            Action::Hit { hits } => {
                ctx.quiet();
                if self.running(ctx.now) {
                    for hit in hits.iter().take(MAX_HITS) {
                        self.hit(seat, hit, ctx);
                    }
                }
                Ok(())
            }
            Action::Missile { id, o, dir, target, goal, by } => {
                if !self.running(ctx.now) {
                    ctx.quiet();
                    return Ok(());
                }
                self.missile(seat, MissileShot { id, o, dir, target, goal, by }, ctx)
            }
            Action::Boom { o, hits, by, n } => {
                if !self.running(ctx.now) {
                    ctx.quiet();
                    return Ok(());
                }
                self.boom(seat, o, &hits, (by, n), ctx)
            }
            Action::Shell { id, o, v, by } => {
                if !self.running(ctx.now) {
                    ctx.quiet();
                    return Ok(());
                }
                self.shell(seat, id, o, v, by, ctx)
            }
        }
    }

    fn tick(&mut self, ctx: &mut Ctx) {
        if self.ended.is_some() {
            return;
        }
        if self.select_until.is_some() {
            self.check_select(ctx);
            return;
        }
        let now = ctx.now;
        // 復活
        for p in &mut self.pilots {
            if p.respawn_at.is_some_and(|at| now >= at) {
                p.alive = true;
                p.hp = p.kind.max_hp();
                p.life += 1;
                p.missiles = MISSILES;
                p.drones = p.kind.drones();
                p.drone_dmg = 0;
                p.respawn_at = None;
                p.ammo = p.kind.burst();
                p.shell_ammo = SHELL_BURST;
                self.hp_dirty = true;
                ctx.changed();
            }
            p.flights.retain(|f| now.saturating_duration_since(f.fired) <= MISSILE_LIFE);
            p.shells.retain(|s| now.saturating_duration_since(s.fired) <= SHELL_LIFE);
        }
        // 這段時間有更新的機甲、血量和傷害合併成一則
        let mechs: Vec<Value> = self
            .pilots
            .iter_mut()
            .enumerate()
            .filter_map(|(seat, p)| {
                let state = p.state.filter(|_| p.fresh)?;
                p.fresh = false;
                Some(row(seat, &state))
            })
            .collect();
        if !mechs.is_empty() || self.hp_dirty || !self.damage.is_empty() {
            let mut event = json!({ "type": "tick", "m": mechs });
            if self.hp_dirty {
                event["hp"] = json!(self.pilots.iter().map(|p| p.hp).collect::<Vec<_>>());
                self.hp_dirty = false;
            }
            if !self.damage.is_empty() {
                event["d"] = json!(std::mem::take(&mut self.damage));
            }
            ctx.emit(To::All, event);
        }
        // 負責開電腦的人一陣子沒送電腦的狀態（切到背景、當掉）：換人開
        if self.has_bots() && now >= self.go {
            let stale = now.saturating_duration_since(self.bots_heard) > BOT_STALE;
            if self.driver.is_none() || stale {
                self.hand_over(self.driver, ctx);
            }
        }
        if now >= self.limit_at {
            let [red, blue] = self.score;
            let winner = match red.cmp(&blue) {
                std::cmp::Ordering::Greater => Some(0),
                std::cmp::Ordering::Less => Some(1),
                std::cmp::Ordering::Equal => None,
            };
            ctx.system(To::All, "時間到！");
            self.end(winner, ctx);
        }
    }

    fn presence(&mut self, seat: usize, online: bool, ctx: &mut Ctx) {
        if self.has_bots() && self.ended.is_none() {
            if !online && self.driver == Some(seat) {
                self.hand_over(Some(seat), ctx);
            } else if online && self.driver.is_none() {
                self.hand_over(None, ctx);
            }
        }
        if self.select_until.is_some() && !online {
            // 選隊時有人斷線：剩下的人都好了就開始
            self.check_select(ctx);
        }
        ctx.changed();
    }

    fn view(&self, seat: Option<usize>, now: Instant) -> Value {
        let players: Vec<Value> = self
            .pilots
            .iter()
            .enumerate()
            .map(|(s, p)| {
                json!({
                    "team": p.team,
                    "mech": p.kind,
                    "alive": p.alive,
                    "respawnIn": p.respawn_at.map(|at| at.saturating_duration_since(now).as_millis() as u64),
                    "life": p.life,
                    "hp": p.hp,
                    "missiles": p.missiles,
                    "drones": p.drones,
                    "kills": p.kills,
                    "deaths": p.deaths,
                    "damage": p.damage,
                    "wins": self.wins.get(&self.pids[s]).copied().unwrap_or(0),
                })
            })
            .collect();
        let elapsed = self.ended.unwrap_or_else(|| now.saturating_duration_since(self.go));
        let bot_states: Vec<Value> = if seat.is_some() && seat == self.driver {
            (0..self.pilots.len())
                .filter(|&s| self.bots[s])
                .filter_map(|s| Some(row(s, &self.pilots[s].state?)))
                .collect()
        } else {
            Vec::new()
        };
        json!({
            "game": self.game,
            "killTarget": self.options.kill_target,
            "timeLimit": self.options.time_limit,
            "startsIn": self.go.saturating_duration_since(now).as_millis() as u64,
            "elapsed": elapsed.as_millis() as u64,
            // 還剩幾毫秒時間到；結算了是 null
            "endsIn": self.ended.is_none().then(|| self.limit_at.saturating_duration_since(now).as_millis() as u64),
            "ended": self.ended.is_some(),
            "winner": self.winner,
            "score": self.score,
            "you": seat,
            // 自己最後送出的狀態：重新整理頁面後從這裡接著打
            "resume": seat.and_then(|s| self.pilots[s].state),
            "players": players,
            "difficulty": self.options.difficulty,
            "bots": (0..self.bots.len()).filter(|&s| self.bots[s]).collect::<Vec<_>>(),
            "driver": self.driver,
            // 負責開電腦的人才拿得到：電腦最後的狀態（重新整理後從這裡接著開）
            "botStates": bot_states,
            // 選隊時：還剩幾毫秒、每個座位準備好了沒有；選完了是 null
            "select": self.select_until.map(|until| json!({
                "endsIn": until.saturating_duration_since(now).as_millis() as u64,
                "ready": self.ready,
            })),
        })
    }

    fn finished(&self) -> bool {
        self.ended.is_some()
    }

    fn bot_name(n: usize) -> String {
        // 不要跟機體（疾風、長弓、渡鴉、要塞、隕星）同名，不然名單上「疾風・狙擊」看不懂
        const NAMES: [&str; 30] = [
            "獵鷹", "鐵砧", "蒼隼", "赤狐", "雷鳴", "夜梟", "灰狼", "黑豹", "白虎", "烈焰", "寒霜", "鋼牙", "磐石",
            "風暴", "閃電", "金雕", "鐵壁", "孤狼", "霜刃", "野牛", "犀牛", "山貓", "獅鷲", "海燕", "雷霆", "赤焰",
            "銀狐", "巨熊", "飛鯊", "鐵騎",
        ];
        NAMES[n.saturating_sub(1) % NAMES.len()].to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::party::{Outbox, Rng, SeatInfo, test_ctx};

    /// 前面 `humans` 個真人，後面 `bots` 個電腦
    fn mixed(humans: usize, bots: usize) -> Vec<SeatInfo> {
        (0..humans + bots)
            .map(|i| SeatInfo { pid: i as u32 + 1, name: format!("P{i}"), bot: i >= humans, online: true })
            .collect()
    }

    /// 開一局、跳過選隊，開打時間設成 `ago` 之前；隊伍照座位單雙號排（0、2、4… 紅隊），都是速度型
    fn game(seats: Vec<SeatInfo>, ago: Duration) -> (Mecha, Vec<SeatInfo>, Rng) {
        let mut rng = Rng::new();
        let mut out = Outbox::default();
        let now = Instant::now();
        let mut g = {
            let mut ctx = test_ctx(now, &mut rng, &seats, &mut out);
            Mecha::start(&Options::default(), None, &mut ctx)
        };
        g.select_until = None;
        g.go = now - ago;
        g.limit_at = g.go + Duration::from_secs(600);
        g.bots_heard = now;
        // 電腦會隨便挑機體：測試裡一律用速度型，要狙擊型的自己換
        for (s, p) in g.pilots.iter_mut().enumerate() {
            p.team = s % 2;
            p.kind = MechKind::Speed;
            p.hp = SPEED_HP;
            p.ammo = GUN_BURST;
            p.drones = 0;
        }
        (g, seats, rng)
    }

    fn act(g: &mut Mecha, seats: &[SeatInfo], rng: &mut Rng, seat: usize, action: Action) -> Result<(), String> {
        let mut out = Outbox::default();
        let mut ctx = test_ctx(Instant::now(), rng, seats, &mut out);
        g.act(seat, action, &mut ctx)
    }

    fn act_out(g: &mut Mecha, seats: &[SeatInfo], rng: &mut Rng, seat: usize, action: Action) -> Outbox {
        let mut out = Outbox::default();
        let mut ctx = test_ctx(Instant::now(), rng, seats, &mut out);
        let _ = g.act(seat, action, &mut ctx);
        out
    }

    fn tick(g: &mut Mecha, seats: &[SeatInfo], rng: &mut Rng, now: Instant) -> Outbox {
        let mut out = Outbox::default();
        let mut ctx = test_ctx(now, rng, seats, &mut out);
        g.tick(&mut ctx);
        out
    }

    /// 狀態：在 (x, z)，第 `life` 條命
    fn at(x: f64, z: f64, life: u32) -> [f64; STATE_LEN] {
        let mut d = [0.0; STATE_LEN];
        d[0] = 1000.0;
        d[X] = x;
        d[Z] = z;
        d[LIFE] = f64::from(life);
        d
    }

    fn boom(o: [f64; 3], hits: Vec<usize>) -> Action {
        Action::Boom { o, hits, by: None, n: None }
    }

    /// `seat` 站在 (x, z)，這條命的第 `k` 架偵察機（0 起算）在 `o`
    #[allow(clippy::too_many_arguments)]
    fn flying(g: &mut Mecha, seats: &[SeatInfo], rng: &mut Rng, seat: usize, x: f64, z: f64, o: [f64; 3], k: u32) {
        let mut d = at(x, z, g.pilots[seat].life);
        d[FLAGS] = f64::from(F_DRONE | if k % 2 == 1 { F_DRONE2 } else { 0 });
        d[DRONE_X..DRONE_X + 3].copy_from_slice(&o);
        act(g, seats, rng, seat, Action::State { d: Some(d), bots: vec![] }).unwrap();
    }

    fn place(g: &mut Mecha, seats: &[SeatInfo], rng: &mut Rng, seat: usize, x: f64, z: f64) {
        let life = g.pilots[seat].life;
        place_life(g, seats, rng, seat, x, z, life);
    }

    /// 送一則第 `life` 條命的狀態（舊的、還在路上的）
    #[allow(clippy::too_many_arguments)]
    fn place_life(g: &mut Mecha, seats: &[SeatInfo], rng: &mut Rng, seat: usize, x: f64, z: f64, life: u32) {
        act(g, seats, rng, seat, Action::State { d: Some(at(x, z, life)), bots: vec![] }).unwrap();
    }

    fn gun(seat: usize) -> Hit {
        Hit { seat, w: Weapon::Gun, id: None, direct: false, head: false, by: None, drone: false }
    }

    /// 打中 `seat` 的頭
    fn head(seat: usize) -> Hit {
        Hit { head: true, ..gun(seat) }
    }

    /// 倒下的人馬上站起來（同一條命、血補滿），測試接著用
    fn revive(g: &mut Mecha, seat: usize) {
        let p = &mut g.pilots[seat];
        p.alive = true;
        p.hp = p.kind.max_hp();
        p.respawn_at = None;
    }

    /// 打 `seat` 放出去的偵察機
    fn at_drone(seat: usize) -> Hit {
        Hit { drone: true, ..gun(seat) }
    }

    fn hits(list: Vec<Hit>) -> Action {
        Action::Hit { hits: list }
    }

    fn shot(id: u32) -> Action {
        Action::Missile { id, o: [0.0, 5.0, 0.0], dir: [1.0, 0.0, 0.0], target: Some(1), goal: None, by: None }
    }

    #[test]
    fn teams_are_balanced_and_keep_last_game() {
        let seats = mixed(3, 2);
        let mut rng = Rng::new();
        let mut out = Outbox::default();
        let mut ctx = test_ctx(Instant::now(), &mut rng, &seats, &mut out);
        let g = Mecha::start(&Options::default(), None, &mut ctx);
        let red = g.team_size(0);
        assert!(red == 2 || red == 3, "5 個人分成 2 對 3");
        // 下一局：每個人留在原本那隊
        let next = Mecha::start(&Options::default(), Some(&g), &mut ctx);
        for (s, seat) in seats.iter().enumerate() {
            if !seat.bot {
                assert_eq!(next.pilots[s].team, g.pilots[s].team, "真人留在上一局的隊伍");
            }
        }
        assert!(next.team_size(0).abs_diff(next.team_size(1)) <= 1);
    }

    #[test]
    fn switching_teams_keeps_them_even_and_swaps_bots() {
        let seats = mixed(2, 2);
        let (mut g, seats, mut rng) = game(seats, Duration::ZERO);
        g.select_until = Some(Instant::now() + SELECT);
        // 0、2 紅隊（2 是電腦），1、3 藍隊（3 是電腦）
        act(&mut g, &seats, &mut rng, 0, Action::Team { team: 1 }).unwrap();
        assert_eq!(g.pilots[0].team, 1);
        assert_eq!(g.pilots[3].team, 0, "跟藍隊的電腦交換");
        assert_eq!(g.team_size(0), 2);
        // 兩個真人都在藍隊；1 想去紅隊：紅隊和藍隊一樣多，紅隊有電腦可以換
        act(&mut g, &seats, &mut rng, 1, Action::Team { team: 0 }).unwrap();
        assert_eq!(g.team_size(0), 2);
        // 沒有電腦可以換：只有兩個真人
        let (mut g, seats, mut rng) = game(mixed(2, 0), Duration::ZERO);
        g.select_until = Some(Instant::now() + SELECT);
        assert!(act(&mut g, &seats, &mut rng, 0, Action::Team { team: 1 }).is_err(), "1 對 1 不能都去同一隊");
        // 準備好了就不能換
        act(&mut g, &seats, &mut rng, 0, Action::Ready).unwrap();
        assert!(act(&mut g, &seats, &mut rng, 0, Action::Team { team: 1 }).is_err());
        // 兩個人都好了就開始倒數
        act(&mut g, &seats, &mut rng, 1, Action::Ready).unwrap();
        assert!(g.select_until.is_none());
        assert!(act(&mut g, &seats, &mut rng, 1, Action::Team { team: 0 }).is_err(), "開打後不能換隊");
    }

    #[test]
    fn gun_hits_deal_damage_and_kill() {
        let (mut g, seats, mut rng) = game(mixed(2, 0), Duration::from_secs(10));
        place(&mut g, &seats, &mut rng, 0, 0.0, 0.0);
        place(&mut g, &seats, &mut rng, 1, 50.0, 0.0);
        act(&mut g, &seats, &mut rng, 0, hits(vec![gun(1), gun(1)])).unwrap();
        assert_eq!(g.pilots[1].hp, SPEED_HP - 16);
        assert_eq!(g.pilots[0].damage, 16);
        let out = tick(&mut g, &seats, &mut rng, Instant::now());
        let event = &out.events().iter().find(|(_, e)| e["type"] == "tick").unwrap().1;
        assert_eq!(event["hp"], json!([SPEED_HP, SPEED_HP - 16]));
        assert_eq!(event["d"], json!([[0, 1, 8, 0], [0, 1, 8, 0]]));
        assert_eq!(event["m"].as_array().unwrap().len(), 2);

        // 打到沒血：倒下、加分，之後的打中不算
        g.pilots[1].hp = 8;
        let out = act_out(&mut g, &seats, &mut rng, 0, hits(vec![gun(1), gun(1)]));
        assert!(!g.pilots[1].alive);
        assert_eq!(g.pilots[1].hp, 0);
        assert_eq!(g.score, [1, 0]);
        assert_eq!(g.pilots[0].kills, 1);
        assert_eq!(g.pilots[1].deaths, 1);
        assert_eq!(out.events()[0].1, json!({ "type": "kill", "killer": 0, "victim": 1, "w": "gun" }));
        // 倒下時送的狀態不算
        place(&mut g, &seats, &mut rng, 1, 40.0, 0.0);
        assert!(g.pilots[1].state.is_none());
        // 時間到復活：第 2 條命、滿血、飛彈補滿；上一條命的狀態不算
        g.pilots[1].missiles = 0;
        tick(&mut g, &seats, &mut rng, Instant::now() + RESPAWN);
        assert!(g.pilots[1].alive);
        assert_eq!((g.pilots[1].life, g.pilots[1].hp, g.pilots[1].missiles), (2, SPEED_HP, MISSILES));
        act(&mut g, &seats, &mut rng, 1, Action::State { d: Some(at(40.0, 0.0, 1)), bots: vec![] }).unwrap();
        assert!(g.pilots[1].state.is_none(), "上一條命的狀態");
        place(&mut g, &seats, &mut rng, 1, 40.0, 0.0);
        assert!(g.pilots[1].state.is_some());
    }

    #[test]
    fn impossible_hits_are_ignored() {
        let (mut g, seats, mut rng) = game(mixed(3, 0), Duration::from_secs(10));
        place(&mut g, &seats, &mut rng, 0, 0.0, 0.0);
        place(&mut g, &seats, &mut rng, 1, 0.0, 280.0);
        place(&mut g, &seats, &mut rng, 2, 10.0, 0.0);
        // 太遠、打自己人、打自己、沒有這個座位
        act(&mut g, &seats, &mut rng, 0, hits(vec![gun(1), gun(2), gun(0), gun(9)])).unwrap();
        assert_eq!(g.pilots.iter().map(|p| p.hp).collect::<Vec<_>>(), vec![SPEED_HP; 3]);
        // 打太快：額度用完就不算
        place(&mut g, &seats, &mut rng, 1, 20.0, 0.0);
        let many: Vec<Hit> = (0..30).map(|_| gun(1)).collect();
        act(&mut g, &seats, &mut rng, 0, hits(many)).unwrap();
        assert_eq!(g.pilots[1].hp, SPEED_HP - 8 * GUN_BURST as u32);
        // 在自己家的重生點裡：打不到，也不能從重生點開火
        place(&mut g, &seats, &mut rng, 1, 300.0, 0.0);
        g.pilots[0].ammo = GUN_BURST;
        let before = g.pilots[1].hp;
        act(&mut g, &seats, &mut rng, 0, hits(vec![gun(1)])).unwrap();
        assert_eq!(g.pilots[1].hp, before, "藍隊在東邊的重生點裡");
        place(&mut g, &seats, &mut rng, 1, 20.0, 0.0);
        place(&mut g, &seats, &mut rng, 0, -300.0, 0.0);
        act(&mut g, &seats, &mut rng, 0, hits(vec![gun(1)])).unwrap();
        assert_eq!(g.pilots[1].hp, before, "從重生點裡開火");
        // 還沒開打
        let (mut g, seats, mut rng) = game(mixed(2, 0), Duration::ZERO);
        g.go = Instant::now() + Duration::from_secs(3);
        place(&mut g, &seats, &mut rng, 0, 0.0, 0.0);
        place(&mut g, &seats, &mut rng, 1, 20.0, 0.0);
        act(&mut g, &seats, &mut rng, 0, hits(vec![gun(1)])).unwrap();
        assert_eq!(g.pilots[1].hp, SPEED_HP);
    }

    #[test]
    fn missiles_are_counted_per_life() {
        let (mut g, seats, mut rng) = game(mixed(4, 0), Duration::from_secs(10));
        place(&mut g, &seats, &mut rng, 0, 0.0, 0.0);
        place(&mut g, &seats, &mut rng, 1, 30.0, 0.0);
        place(&mut g, &seats, &mut rng, 3, 32.0, 0.0);
        let missile = |seat, id, direct| Hit { w: Weapon::Missile, id: Some(id), direct, ..gun(seat) };
        // 沒發射過的飛彈打不到
        act(&mut g, &seats, &mut rng, 0, hits(vec![missile(1, 7, true)])).unwrap();
        assert_eq!(g.pilots[1].hp, SPEED_HP);
        let out = act_out(&mut g, &seats, &mut rng, 0, shot(7));
        assert_eq!(g.pilots[0].missiles, 1);
        assert!(matches!(out.events()[0].0, To::Except(0)));
        assert_eq!(out.events()[0].1["type"], "missile");
        // 直接命中一台，爆風波及另一台；同一台不會算兩次
        act(&mut g, &seats, &mut rng, 0, hits(vec![missile(1, 7, true), missile(3, 7, false), missile(1, 7, false)]))
            .unwrap();
        assert_eq!(g.pilots[1].hp, SPEED_HP - MISSILE_DAMAGE);
        assert_eq!(g.pilots[3].hp, SPEED_HP - SPLASH_DAMAGE);
        // 同一個號碼不能再發一次；第二發用完就沒了
        act(&mut g, &seats, &mut rng, 0, shot(7)).unwrap();
        assert_eq!(g.pilots[0].missiles, 1);
        act(&mut g, &seats, &mut rng, 0, shot(8)).unwrap();
        assert!(act(&mut g, &seats, &mut rng, 0, shot(9)).is_err(), "一條命只有兩發");
        // 飛太久的飛彈不算
        g.pilots[0].flights[1].fired = Instant::now() - MISSILE_LIFE - Duration::from_secs(1);
        act(&mut g, &seats, &mut rng, 0, hits(vec![missile(1, 8, true)])).unwrap();
        assert_eq!(g.pilots[1].hp, SPEED_HP - MISSILE_DAMAGE);
    }

    #[test]
    fn first_team_to_the_target_wins() {
        let (mut g, seats, mut rng) = game(mixed(2, 0), Duration::from_secs(10));
        g.options.kill_target = 2;
        for round in 0..2 {
            place(&mut g, &seats, &mut rng, 0, 0.0, 0.0);
            place(&mut g, &seats, &mut rng, 1, 20.0, 0.0);
            g.pilots[1].hp = 8;
            act(&mut g, &seats, &mut rng, 0, hits(vec![gun(1)])).unwrap();
            if round == 0 {
                assert!(g.ended.is_none());
                tick(&mut g, &seats, &mut rng, Instant::now() + RESPAWN);
            }
        }
        assert!(g.finished());
        assert_eq!(g.winner, Some(0));
        assert_eq!(g.wins.get(&1), Some(&1));
        assert_eq!(g.wins.get(&2), None);
        let view = g.view(Some(0), Instant::now());
        assert_eq!(view["score"], json!([2, 0]));
        assert_eq!(view["winner"], 0);
        assert_eq!(view["players"][0]["wins"], 1);
    }

    #[test]
    fn time_up_compares_scores() {
        let (mut g, seats, mut rng) = game(mixed(2, 0), Duration::from_secs(10));
        g.score = [3, 5];
        let at = g.limit_at;
        tick(&mut g, &seats, &mut rng, at);
        assert_eq!(g.winner, Some(1));
        let (mut g, seats, mut rng) = game(mixed(2, 0), Duration::from_secs(10));
        g.score = [4, 4];
        let at = g.limit_at;
        tick(&mut g, &seats, &mut rng, at);
        assert!(g.finished());
        assert_eq!(g.winner, None, "平手");
    }

    #[test]
    fn bots_are_driven_by_one_player() {
        let (mut g, seats, mut rng) = game(mixed(2, 2), Duration::from_secs(10));
        assert_eq!(g.driver, Some(0));
        let bot_row = |seat: f64, x: f64| {
            let mut row = [0.0; STATE_LEN + 1];
            row[0] = seat;
            row[1..].copy_from_slice(&at(x, 0.0, 1));
            row
        };
        // 不是負責開的人送的電腦狀態不算
        act(&mut g, &seats, &mut rng, 1, Action::State { d: None, bots: vec![bot_row(2.0, 5.0)] }).unwrap();
        assert!(g.pilots[2].state.is_none());
        // 不能替真人送狀態
        act(&mut g, &seats, &mut rng, 0, Action::State { d: None, bots: vec![bot_row(1.0, 5.0)] }).unwrap();
        assert!(g.pilots[1].state.is_none());
        act(&mut g, &seats, &mut rng, 0, Action::State { d: None, bots: vec![bot_row(2.0, 5.0), bot_row(3.0, 25.0)] })
            .unwrap();
        assert!(g.pilots[2].state.is_some() && g.pilots[3].state.is_some());
        place(&mut g, &seats, &mut rng, 1, 15.0, 0.0);
        // 電腦（座位 2，紅隊）打藍隊的 1：只有負責開的人能替它回報
        let bot_gun = Hit { by: Some(2), ..gun(1) };
        act(&mut g, &seats, &mut rng, 1, hits(vec![bot_gun])).unwrap();
        assert_eq!(g.pilots[1].hp, SPEED_HP);
        let bot_gun = Hit { by: Some(2), ..gun(1) };
        act(&mut g, &seats, &mut rng, 0, hits(vec![bot_gun])).unwrap();
        assert_eq!(g.pilots[1].hp, SPEED_HP - 8);
        assert_eq!(g.pilots[2].damage, 8);
        // 負責開的人很久沒送電腦的狀態：換人
        tick(&mut g, &seats, &mut rng, Instant::now() + BOT_STALE * 2);
        assert_eq!(g.driver, Some(1));
        let view = g.view(Some(1), Instant::now());
        assert_eq!(view["botStates"].as_array().unwrap().len(), 2, "接手的人拿到電腦最後的位置");
        assert!(g.view(Some(0), Instant::now())["botStates"].as_array().unwrap().is_empty());
    }

    #[test]
    fn options_are_checked() {
        assert!(Mecha::check_options(Options { kill_target: 20, time_limit: 15, ..Options::default() }).is_ok());
        assert!(Mecha::check_options(Options { kill_target: 7, ..Options::default() }).is_err());
        assert!(Mecha::check_options(Options { time_limit: 60, ..Options::default() }).is_err());
    }

    #[test]
    fn mech_is_chosen_while_selecting() {
        let (mut g, seats, mut rng) = game(mixed(2, 0), Duration::ZERO);
        g.select_until = Some(Instant::now() + SELECT);
        act(&mut g, &seats, &mut rng, 0, Action::Mech { mech: MechKind::Sniper }).unwrap();
        assert_eq!((g.pilots[0].kind, g.pilots[0].hp), (MechKind::Sniper, SNIPER_HP));
        assert_eq!(g.view(Some(0), Instant::now())["players"][0]["mech"], "sniper");
        assert_eq!(g.view(Some(0), Instant::now())["players"][1]["mech"], "speed");
        // 準備好了就不能換
        act(&mut g, &seats, &mut rng, 0, Action::Ready).unwrap();
        assert!(act(&mut g, &seats, &mut rng, 0, Action::Mech { mech: MechKind::Speed }).is_err());
        // 下一局沿用上一局選的
        let mut out = Outbox::default();
        let mut ctx = test_ctx(Instant::now(), &mut rng, &seats, &mut out);
        let next = Mecha::start(&Options::default(), Some(&g), &mut ctx);
        assert_eq!(next.pilots[0].kind, MechKind::Sniper);
        assert_eq!(next.pilots[0].hp, SNIPER_HP);
    }

    #[test]
    fn mech_is_swapped_at_home_or_while_down() {
        let (mut g, seats, mut rng) = game(mixed(2, 0), Duration::from_secs(10));
        // 在外面不能換
        place(&mut g, &seats, &mut rng, 0, -100.0, 0.0);
        assert!(act(&mut g, &seats, &mut rng, 0, Action::Mech { mech: MechKind::Sniper }).is_err());
        assert_eq!(g.pilots[0].kind, MechKind::Speed);
        // 在自己家的重生點裡：馬上換、補滿，第幾條命加一（舊的狀態不收）
        g.pilots[0].hp = 50;
        g.pilots[0].missiles = 0;
        place(&mut g, &seats, &mut rng, 0, -300.0, 10.0);
        act(&mut g, &seats, &mut rng, 0, Action::Mech { mech: MechKind::Recon }).unwrap();
        let p = &g.pilots[0];
        assert_eq!((p.kind, p.hp, p.missiles, p.drones, p.life), (MechKind::Recon, RECON_HP, MISSILES, DRONES, 2));
        assert!(p.state.is_none());
        place_life(&mut g, &seats, &mut rng, 0, -300.0, 10.0, 1);
        assert!(g.pilots[0].state.is_none());
        place(&mut g, &seats, &mut rng, 0, -300.0, 10.0);
        assert!(g.pilots[0].state.is_some());
        assert_eq!(g.view(Some(0), Instant::now())["players"][0]["mech"], "recon");
        // 敵人家的重生點不行
        place(&mut g, &seats, &mut rng, 0, 300.0, 0.0);
        assert!(act(&mut g, &seats, &mut rng, 0, Action::Mech { mech: MechKind::Speed }).is_err());
        // 倒下時：選的是復活的那台
        place(&mut g, &seats, &mut rng, 0, -100.0, 0.0);
        place(&mut g, &seats, &mut rng, 1, -60.0, 0.0);
        let killer = 1;
        let mut out = Outbox::default();
        let mut ctx = test_ctx(Instant::now(), &mut rng, &seats, &mut out);
        g.kill(killer, 0, "gun", &mut ctx);
        act(&mut g, &seats, &mut rng, 0, Action::Mech { mech: MechKind::Sniper }).unwrap();
        assert_eq!((g.pilots[0].kind, g.pilots[0].alive, g.pilots[0].life), (MechKind::Sniper, false, 2));
        tick(&mut g, &seats, &mut rng, Instant::now() + RESPAWN + Duration::from_millis(10));
        let p = &g.pilots[0];
        assert_eq!((p.alive, p.kind, p.hp, p.life, p.drones), (true, MechKind::Sniper, SNIPER_HP, 3, 0));
    }

    #[test]
    fn sniper_cannon_hits_hard_far_and_slow() {
        let (mut g, seats, mut rng) = game(mixed(2, 0), Duration::from_secs(10));
        g.pilots[0].kind = MechKind::Sniper;
        g.pilots[0].ammo = CANNON_BURST;
        // 350 公尺：機砲打不到，電磁砲打得到
        place(&mut g, &seats, &mut rng, 0, -200.0, 100.0);
        place(&mut g, &seats, &mut rng, 1, 150.0, 100.0);
        act(&mut g, &seats, &mut rng, 0, hits(vec![gun(1), gun(1), gun(1)])).unwrap();
        assert_eq!(g.pilots[1].hp, SPEED_HP - 2 * CANNON_DAMAGE, "寬限兩發，第三發打太快不算");
        assert_eq!(g.pilots[0].damage, 2 * CANNON_DAMAGE);
        // 太遠
        g.pilots[0].ammo = CANNON_BURST;
        place(&mut g, &seats, &mut rng, 1, 300.0, 100.0);
        act(&mut g, &seats, &mut rng, 0, hits(vec![gun(1)])).unwrap();
        assert_eq!(g.pilots[1].hp, SPEED_HP - 2 * CANNON_DAMAGE);
        // 速度型的機砲打 300 公尺外：不算
        g.pilots[1].kind = MechKind::Speed;
        place(&mut g, &seats, &mut rng, 0, 0.0, 100.0);
        act(&mut g, &seats, &mut rng, 1, hits(vec![gun(0)])).unwrap();
        assert_eq!(g.pilots[0].hp, SPEED_HP);
    }

    #[test]
    fn sniper_headshot_downs_any_mech() {
        let (mut g, seats, mut rng) = game(mixed(2, 0), Duration::from_secs(10));
        set_kind(&mut g, 0, MechKind::Sniper);
        set_kind(&mut g, 1, MechKind::Fortress);
        place(&mut g, &seats, &mut rng, 0, 0.0, 100.0);
        place(&mut g, &seats, &mut rng, 1, 150.0, 100.0);
        // 最耐打的堡壘型滿血也是一發；傷害算到剩下的血，擊倒訊息的武器是 head
        let out = act_out(&mut g, &seats, &mut rng, 0, hits(vec![head(1)]));
        assert!(!g.pilots[1].alive);
        assert_eq!(g.pilots[0].damage, FORTRESS_HP);
        assert_eq!(g.damage.last(), Some(&[0, 1, FORTRESS_HP, 0]));
        let kill = out.events().iter().find(|(_, e)| e["type"] == "kill").unwrap().1.clone();
        assert_eq!(kill, json!({ "type": "kill", "killer": 0, "victim": 1, "w": "head" }));
        // 別種機甲說打中頭：照平常的傷害算
        revive(&mut g, 1);
        set_kind(&mut g, 1, MechKind::Speed);
        place(&mut g, &seats, &mut rng, 1, 50.0, 100.0);
        act(&mut g, &seats, &mut rng, 1, hits(vec![head(0)])).unwrap();
        assert_eq!(g.pilots[0].hp, SNIPER_HP - 8);
        // 打太快的那一發不算，打中頭也一樣
        g.pilots[0].ammo = 0.0;
        act(&mut g, &seats, &mut rng, 0, hits(vec![head(1)])).unwrap();
        assert!(g.pilots[1].alive);
    }

    #[test]
    fn recon_rifle_and_drone_blast() {
        let (mut g, seats, mut rng) = game(mixed(4, 0), Duration::from_secs(10));
        // 0、2 紅隊（0 是偵察型），1、3 藍隊
        let mut out = Outbox::default();
        let mut ctx = test_ctx(Instant::now(), &mut rng, &seats, &mut out);
        g.select_until = Some(Instant::now() + SELECT);
        g.choose(0, MechKind::Recon, &mut ctx).unwrap();
        g.select_until = None;
        assert_eq!((g.pilots[0].hp, g.pilots[0].drones), (RECON_HP, DRONES));
        assert_eq!(g.view(Some(0), Instant::now())["players"][0]["drones"], DRONES);
        place(&mut g, &seats, &mut rng, 0, 0.0, 0.0);
        place(&mut g, &seats, &mut rng, 1, 200.0, 0.0);
        place(&mut g, &seats, &mut rng, 2, 198.0, 0.0);
        place(&mut g, &seats, &mut rng, 3, 205.0, 4.0);
        // 脈衝步槍：200 公尺外一樣 11
        act(&mut g, &seats, &mut rng, 0, hits(vec![gun(1)])).unwrap();
        assert_eq!(g.pilots[1].hp, SPEED_HP - RIFLE_DAMAGE);

        // 偵察機沒放出去（狀態裡沒有）：引爆不算
        act(&mut g, &seats, &mut rng, 0, boom([202.0, 4.0, 1.0], vec![1])).unwrap();
        assert_eq!((g.pilots[1].hp, g.pilots[0].drones), (SPEED_HP - RIFLE_DAMAGE, DRONES));
        // 偵察機在敵人中間爆炸：1、3 炸到就倒（3 是滿血的堡壘型也一樣），2 是自己人、9 沒這個座位、1 重複都不算；
        // 別人收到爆炸的位置，傷害算到剩下的血，擊倒訊息的武器是 drone
        set_kind(&mut g, 3, MechKind::Fortress);
        flying(&mut g, &seats, &mut rng, 0, 0.0, 0.0, [203.0, 4.0, 1.0], 0);
        let out = act_out(&mut g, &seats, &mut rng, 0, boom([202.0, 4.0, 1.0], vec![1, 3, 2, 1, 9]));
        assert_eq!((g.pilots[1].alive, g.pilots[3].alive), (false, false));
        assert_eq!(g.pilots[2].hp, SPEED_HP);
        assert_eq!(g.pilots[0].drones, 1);
        assert_eq!(g.pilots[0].damage, RIFLE_DAMAGE + (SPEED_HP - RIFLE_DAMAGE) + FORTRESS_HP);
        assert_eq!(g.score, [2, 0]);
        let (to, event) = &out.events()[0];
        assert!(matches!(to, To::Except(0)));
        assert_eq!(event["type"], "boom");
        assert_eq!(event["seat"], 0);
        let kill = out.events().iter().find(|(_, e)| e["type"] == "kill").unwrap().1.clone();
        assert_eq!(kill, json!({ "type": "kill", "killer": 0, "victim": 1, "w": "drone" }));
        tick(&mut g, &seats, &mut rng, Instant::now());
        revive(&mut g, 3);
        place(&mut g, &seats, &mut rng, 3, 205.0, 4.0);

        // 爆炸點離偵察機最後回報的位置太遠（亂送的）：不算，也不扣偵察機
        flying(&mut g, &seats, &mut rng, 0, 0.0, 0.0, [150.0, 4.0, 0.0], 1);
        act(&mut g, &seats, &mut rng, 0, boom([300.0, 4.0, 0.0], vec![3])).unwrap();
        assert_eq!((g.pilots[3].alive, g.pilots[0].drones), (true, 1));
        // 被炸的人離爆炸點太遠：偵察機用掉了，但沒炸到
        act(&mut g, &seats, &mut rng, 0, boom([150.0, 4.0, 0.0], vec![3])).unwrap();
        assert_eq!((g.pilots[3].hp, g.pilots[0].drones), (FORTRESS_HP, 0));
        // 這條命的偵察機用完了
        act(&mut g, &seats, &mut rng, 0, boom([205.0, 4.0, 4.0], vec![3])).unwrap();
        assert_eq!(g.pilots[3].hp, FORTRESS_HP);
        // 不是偵察型不能引爆
        revive(&mut g, 1);
        place(&mut g, &seats, &mut rng, 1, 200.0, 0.0);
        act(&mut g, &seats, &mut rng, 1, boom([1.0, 4.0, 0.0], vec![0])).unwrap();
        assert_eq!(g.pilots[0].hp, RECON_HP);

        // 偵察機飛多遠都可以（機甲在 400 公尺外）；復活後偵察機補滿
        g.pilots[0].drones = 1;
        flying(&mut g, &seats, &mut rng, 0, -200.0, 0.0, [204.0, 4.0, 3.0], 1);
        act(&mut g, &seats, &mut rng, 0, boom([205.0, 4.0, 4.0], vec![3])).unwrap();
        assert!(!g.pilots[3].alive);
        g.pilots[0].hp = 1;
        place(&mut g, &seats, &mut rng, 1, 10.0, 0.0);
        g.pilots[1].ammo = GUN_BURST;
        act(&mut g, &seats, &mut rng, 1, hits(vec![gun(0)])).unwrap();
        assert!(!g.pilots[0].alive);
        tick(&mut g, &seats, &mut rng, Instant::now() + RESPAWN);
        assert_eq!((g.pilots[0].hp, g.pilots[0].drones), (RECON_HP, DRONES));
    }

    #[test]
    fn drones_can_be_shot_down() {
        let (mut g, seats, mut rng) = game(mixed(4, 0), Duration::from_secs(10));
        // 0 是紅隊的偵察型，1 是藍隊的速度型、3 是藍隊的狙擊型
        g.pilots[0].kind = MechKind::Recon;
        g.pilots[0].hp = RECON_HP;
        g.pilots[0].drones = DRONES;
        g.pilots[3].kind = MechKind::Sniper;
        g.pilots[3].ammo = CANNON_BURST;
        // 偵察機在 (100, 20, 0)：第一架（旗標只有 F_DRONE）
        let fly = |g: &mut Mecha, rng: &mut Rng, second: bool| {
            let mut d = at(0.0, 0.0, g.pilots[0].life);
            d[FLAGS] = f64::from(F_DRONE | if second { F_DRONE2 } else { 0 });
            d[DRONE_X] = 100.0;
            d[DRONE_X + 1] = 20.0;
            act(g, &seats, rng, 0, Action::State { d: Some(d), bots: vec![] }).unwrap();
        };
        place(&mut g, &seats, &mut rng, 1, 180.0, 0.0);
        place(&mut g, &seats, &mut rng, 3, 150.0, 30.0);
        // 沒放偵察機：打不到
        act(&mut g, &seats, &mut rng, 1, hits(vec![at_drone(0)])).unwrap();
        assert_eq!(g.pilots[0].drone_dmg, 0);
        fly(&mut g, &mut rng, false);
        // 機砲 80 多公尺外一發 8：打三發還沒掉，tick 裡的種類是 3，機甲本身不扣血
        act(&mut g, &seats, &mut rng, 1, hits(vec![at_drone(0), at_drone(0), at_drone(0)])).unwrap();
        assert_eq!((g.pilots[0].drone_dmg, g.pilots[0].hp, g.pilots[0].drones), (24, RECON_HP, DRONES));
        assert_eq!(g.damage[0], [1, 0, 8, 3]);
        // 第四發擊落：少一架，所有人收到 downed，只算到滿
        let out = act_out(&mut g, &seats, &mut rng, 1, hits(vec![at_drone(0)]));
        assert_eq!((g.pilots[0].drone_dmg, g.pilots[0].drones), (0, DRONES - 1));
        assert_eq!(g.damage.last(), Some(&[1, 0, 6, 3]));
        let (to, event) = &out.events()[0];
        assert!(matches!(to, To::All));
        assert_eq!(*event, json!({ "type": "downed", "seat": 0, "by": 1, "n": 0 }));
        // 還在路上的舊狀態（第一架）：打不到第二架的額度，引爆也不算
        act(&mut g, &seats, &mut rng, 3, hits(vec![at_drone(0)])).unwrap();
        assert_eq!(g.pilots[0].drone_dmg, 0);
        let stale = Action::Boom { o: [100.0, 20.0, 0.0], hits: vec![], by: None, n: Some(0) };
        act(&mut g, &seats, &mut rng, 0, stale).unwrap();
        assert_eq!(g.pilots[0].drones, DRONES - 1);
        // 放出第二架：狙擊型一砲 50 直接打下來；自己人打不到
        fly(&mut g, &mut rng, true);
        act(&mut g, &seats, &mut rng, 2, hits(vec![at_drone(0)])).unwrap();
        assert_eq!(g.pilots[0].drone_dmg, 0);
        act(&mut g, &seats, &mut rng, 3, hits(vec![at_drone(0)])).unwrap();
        assert_eq!((g.pilots[0].drone_dmg, g.pilots[0].drones), (0, 0));
        // 飛彈打不下來；射程外打不到
        g.pilots[0].drones = 1;
        act(&mut g, &seats, &mut rng, 1, hits(vec![Hit { w: Weapon::Missile, id: Some(1), ..at_drone(0) }])).unwrap();
        place(&mut g, &seats, &mut rng, 1, 400.0, 0.0);
        g.pilots[1].ammo = GUN_BURST;
        act(&mut g, &seats, &mut rng, 1, hits(vec![at_drone(0)])).unwrap();
        assert_eq!(g.pilots[0].drone_dmg, 0);
    }

    /// 狀態：在 (x, z)，第 `life` 條命，變身了（旗標 `F_DEPLOY`）
    fn deployed(x: f64, z: f64, life: u32) -> [f64; STATE_LEN] {
        let mut d = at(x, z, life);
        d[FLAGS] = f64::from(F_DEPLOY);
        d
    }

    fn set_kind(g: &mut Mecha, seat: usize, kind: MechKind) {
        let p = &mut g.pilots[seat];
        p.kind = kind;
        p.hp = kind.max_hp();
        p.ammo = kind.burst();
    }

    fn state(g: &mut Mecha, seats: &[SeatInfo], rng: &mut Rng, seat: usize, d: [f64; STATE_LEN]) {
        act(g, seats, rng, seat, Action::State { d: Some(d), bots: vec![] }).unwrap();
    }

    fn guns(seat: usize, n: usize) -> Action {
        hits((0..n).map(|_| gun(seat)).collect())
    }

    #[test]
    fn new_kinds_are_selectable() {
        let (mut g, seats, mut rng) = game(mixed(2, 0), Duration::ZERO);
        g.select_until = Some(Instant::now() + SELECT);
        act(&mut g, &seats, &mut rng, 0, Action::Mech { mech: MechKind::Fortress }).unwrap();
        act(&mut g, &seats, &mut rng, 1, Action::Mech { mech: MechKind::Mortar }).unwrap();
        assert_eq!((g.pilots[0].hp, g.pilots[1].hp), (FORTRESS_HP, MORTAR_HP));
        let view = g.view(Some(0), Instant::now());
        assert_eq!(
            (view["players"][0]["mech"].clone(), view["players"][1]["mech"].clone()),
            (json!("fortress"), json!("mortar"))
        );
    }

    #[test]
    fn fortress_fires_faster_when_deployed() {
        let (mut g, seats, mut rng) = game(mixed(2, 0), Duration::from_secs(10));
        set_kind(&mut g, 0, MechKind::Fortress);
        set_kind(&mut g, 1, MechKind::Fortress);
        place(&mut g, &seats, &mut rng, 0, 0.0, 0.0);
        place(&mut g, &seats, &mut rng, 1, 50.0, 0.0);
        // 沒變身：輕機槍，一次最多算 LMG_BURST 發，一發 7
        act(&mut g, &seats, &mut rng, 0, guns(1, 40)).unwrap();
        assert_eq!(g.pilots[1].hp, FORTRESS_HP - 7 * LMG_BURST as u32);
        // 變身了：重機槍，一次最多算 HMG_BURST 發（剛剛的額度用完了，直接給滿）
        state(&mut g, &seats, &mut rng, 0, deployed(0.0, 0.0, 1));
        g.pilots[0].ammo = HMG_BURST;
        g.pilots[1].hp = FORTRESS_HP;
        act(&mut g, &seats, &mut rng, 0, guns(1, 40)).unwrap();
        assert_eq!(g.pilots[1].hp, FORTRESS_HP - 7 * HMG_BURST as u32);
        // 遠的傷害低一點；變身後打得到 270 公尺，沒變身打不到
        assert_eq!((mg_damage(50.0), mg_damage(260.0)), (7, 4));
        g.pilots[0].ammo = HMG_BURST;
        place(&mut g, &seats, &mut rng, 1, 270.0, 0.0);
        let before = g.pilots[1].hp;
        act(&mut g, &seats, &mut rng, 0, guns(1, 1)).unwrap();
        assert_eq!(g.pilots[1].hp, before - 4);
        place(&mut g, &seats, &mut rng, 0, 0.0, 0.0);
        g.pilots[0].ammo = LMG_BURST;
        act(&mut g, &seats, &mut rng, 0, guns(1, 1)).unwrap();
        assert_eq!(g.pilots[1].hp, before - 4, "沒變身的輕機槍射程比較近");
        // 速度型送來變身的旗標也沒用
        set_kind(&mut g, 1, MechKind::Speed);
        state(&mut g, &seats, &mut rng, 1, deployed(20.0, 0.0, 1));
        assert!(!g.pilots[1].deployed());
    }

    /// 從 (0, 6, 100) 往 +x 射：6 秒後落在 (250, 0, 100)
    fn lob(id: u32) -> Action {
        Action::Shell { id, o: [0.0, 6.0, 100.0], v: [250.0 / 6.0, 107.0, 0.0], by: None }
    }

    fn shell(seat: usize, id: u32) -> Hit {
        Hit { w: Weapon::Shell, id: Some(id), ..gun(seat) }
    }

    #[test]
    fn mortar_shells_hit_near_their_arc() {
        let (mut g, seats, mut rng) = game(mixed(4, 0), Duration::from_secs(10));
        // 0、2 紅隊（0 是砲擊型），1、3 藍隊
        set_kind(&mut g, 0, MechKind::Mortar);
        place(&mut g, &seats, &mut rng, 0, 0.0, 100.0);
        place(&mut g, &seats, &mut rng, 1, 250.0, 100.0);
        place(&mut g, &seats, &mut rng, 2, 245.0, 100.0);
        place(&mut g, &seats, &mut rng, 3, 240.0, 100.0);
        // 沒變身不能發射
        act(&mut g, &seats, &mut rng, 0, lob(1)).unwrap();
        assert!(g.pilots[0].shells.is_empty());
        // 變身了：記下彈道，轉給其他人
        state(&mut g, &seats, &mut rng, 0, deployed(0.0, 100.0, 1));
        let out = act_out(&mut g, &seats, &mut rng, 0, lob(1));
        assert_eq!(g.pilots[0].shells.len(), 1);
        let (to, event) = &out.events()[0];
        assert!(matches!(to, To::Except(0)));
        assert_eq!(
            (event["type"].clone(), event["seat"].clone(), event["id"].clone()),
            (json!("shell"), json!(0), json!(1))
        );
        // 炸到 1、3 就倒（3 是滿血的堡壘型也一樣）；2 是自己人、1 重複、9 沒這個座位都不算；擊倒訊息的武器是 shell
        set_kind(&mut g, 3, MechKind::Fortress);
        let out = act_out(
            &mut g,
            &seats,
            &mut rng,
            0,
            hits(vec![shell(1, 1), shell(3, 1), shell(2, 1), shell(1, 1), shell(9, 1)]),
        );
        assert_eq!((g.pilots[1].alive, g.pilots[2].hp, g.pilots[3].alive), (false, SPEED_HP, false));
        assert_eq!(g.pilots[0].damage, SPEED_HP + FORTRESS_HP);
        let kill = out.events().iter().find(|(_, e)| e["type"] == "kill").unwrap().1.clone();
        assert_eq!(kill, json!({ "type": "kill", "killer": 0, "victim": 1, "w": "shell" }));
        revive(&mut g, 1);
        revive(&mut g, 3);
        place(&mut g, &seats, &mut rng, 1, 250.0, 100.0);
        // 不在彈道附近（彈道經過 x = 150 時在 150 公尺高）：不算；沒發射過的號碼也不算
        act(&mut g, &seats, &mut rng, 0, lob(2)).unwrap();
        place(&mut g, &seats, &mut rng, 3, 150.0, 100.0);
        act(&mut g, &seats, &mut rng, 0, hits(vec![shell(3, 2), shell(1, 7)])).unwrap();
        assert_eq!((g.pilots[1].hp, g.pilots[3].hp), (SPEED_HP, FORTRESS_HP));
        // 打太快：寬限兩發都用掉了
        act(&mut g, &seats, &mut rng, 0, lob(3)).unwrap();
        assert_eq!(g.pilots[0].shells.len(), 2);
        // 初速太快（會射太遠）、砲口離自己太遠：不算
        g.pilots[0].shell_ammo = SHELL_BURST;
        act(
            &mut g,
            &seats,
            &mut rng,
            0,
            Action::Shell { id: 4, o: [0.0, 6.0, 100.0], v: [200.0, 20.0, 0.0], by: None },
        )
        .unwrap();
        act(
            &mut g,
            &seats,
            &mut rng,
            0,
            Action::Shell { id: 5, o: [60.0, 6.0, 100.0], v: [40.0, 70.0, 0.0], by: None },
        )
        .unwrap();
        assert_eq!(g.pilots[0].shells.len(), 2);
        // 變身了沒有主武器；收回來才能用卡賓槍（一發 9）
        act(&mut g, &seats, &mut rng, 0, guns(1, 1)).unwrap();
        assert_eq!(g.pilots[1].hp, SPEED_HP);
        place(&mut g, &seats, &mut rng, 1, 100.0, 100.0);
        place(&mut g, &seats, &mut rng, 0, 0.0, 100.0);
        act(&mut g, &seats, &mut rng, 0, guns(1, 1)).unwrap();
        assert_eq!(g.pilots[1].hp, SPEED_HP - CARBINE_DAMAGE);
        // 不是砲擊型不能發射
        state(&mut g, &seats, &mut rng, 1, deployed(100.0, 100.0, 1));
        act(&mut g, &seats, &mut rng, 1, lob(1)).unwrap();
        assert!(g.pilots[1].shells.is_empty());
        // 倒下時飛在空中的砲彈不算了
        state(&mut g, &seats, &mut rng, 0, deployed(0.0, 100.0, 1));
        g.pilots[0].shell_ammo = SHELL_BURST;
        act(&mut g, &seats, &mut rng, 0, lob(6)).unwrap();
        assert!(!g.pilots[0].shells.is_empty());
        let mut out = Outbox::default();
        let mut ctx = test_ctx(Instant::now(), &mut rng, &seats, &mut out);
        g.kill(1, 0, "gun", &mut ctx);
        assert!(g.pilots[0].shells.is_empty());
    }

    #[test]
    fn gun_damage_falls_off() {
        assert_eq!(gun_damage(10.0), 8);
        assert_eq!(gun_damage(100.0), 8);
        assert_eq!(gun_damage(230.0), 4);
        assert!(gun_damage(165.0) < 8 && gun_damage(165.0) > 4);
    }
}
