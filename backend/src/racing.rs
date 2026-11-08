//! 3D 賽車的多人連線（派對房間的遊戲，房間本身見 `party.rs`；畫面和物理在 `frontend/src/games/racing/`）。
//!
//! 物理在每個人的瀏覽器裡跑，伺服器不算物理，也不知道賽道長什麼樣子：
//! - 每個人的瀏覽器每秒送 20 次自己車子的狀態（`Action::State`，格式見 `STATE_LEN`）。
//!   伺服器每個 `TICK`（50 毫秒）把這段時間有更新的車合併成一則 `cars` 事件送給所有人（含觀戰），
//!   用戶端再用速度把別人的車往前推算到「現在」才畫（`online.ts`）。
//! - 圈數和完賽時間由各自的瀏覽器回報（`Action::Lap`），伺服器只檢查合不合理：
//!   - 圈數要一圈一圈來。
//!   - 時間要對得上伺服器自己的時鐘。
//!   - 一圈不能快過「整圈都用噴射極速跑」。
//!   - 進度（跑了幾公尺）不能多過一路用極速跑的距離。
//!
//!   改用戶端可以作弊，但改不出不可能的成績。
//! - 車子互撞在各自的瀏覽器裡算，每個人只推開自己的車；撞到別人時把對方該拿到的速度變化送過去
//!   （`Action::Bump`，伺服器只轉給開被撞那台車的人），不然被撞的人常常看不到重疊、感覺不到被撞。
//! - 對時（`Action::Ping`）：用戶端照來回時間對準伺服器的比賽時鐘，別人的車才推算得準。
//! - 選完車倒數 `COUNTDOWN` 才起跑。第一個人跑完後，其他人還有 `GRACE` 可以跑。
//!   時間到時，沒跑完的照圈數和進度排名；連著線的真人都跑完就提早結算（不等電腦）。
//! - 電腦：伺服器沒有物理，所以指定一位真人（`driver`）在他的瀏覽器裡開所有電腦，
//!   電腦的狀態跟著他自己的狀態一起送（`State::bots`），過線也由他回報，檢查規則跟真人一樣。
//!   撞到電腦的通知轉給他。他斷線、或 `BOT_STALE` 沒送電腦的狀態（切到背景時瀏覽器不跑畫面）
//!   就輪給下一位連著線的真人，新的人從電腦最後的位置接著開。
//! - 選車：房主在大廳選好賽道、圈數、電腦後按開始，先有 `SELECT` 讓每個人選車種和車色（`Action::Pick`）。
//!   車種隨便選，車色先選先贏，別的真人選走的不能選；電腦隨機配一種車，顏色讓給真人（真人選了電腦的顏色，電腦就換一個）。
//!   連著線的真人都按了「選好了」（`Action::Ready`）或時間到，就照當時選的開始倒數。
//!   下一局一開始是上一局開的車（跟著人走，顏色被前面的人拿走才換）。

use std::{collections::HashMap, sync::Arc, time::Duration};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::time::Instant;

use crate::{
    AppState,
    party::{Ctx, Parties, PartyGame, To, shuffle},
};

/// 選車的時間：時間到了，還沒按「選好了」的人就開當時選的車
const SELECT: Duration = Duration::from_secs(30);
/// 選完車到起跑的倒數：前兩秒讓大家載入賽道，最後三秒才顯示 3、2、1
const COUNTDOWN: Duration = Duration::from_secs(5);
/// 第一個人跑完後，其他人還能跑多久
const GRACE: Duration = Duration::from_secs(30);
/// 平均一圈最多給多久（整局的時間上限 = 這個 × 圈數），免得有人掛著不動，房間永遠結束不了
const LAP_LIMIT: Duration = Duration::from_secs(4 * 60);
/// 伺服器認定的極速（公尺／秒）：最快的車種噴射時約 76（`spec.ts` 極速型的 62.5 × 1.22），再寬鬆一點
const MAX_SPEED: f64 = 80.0;
/// 回報的過線時間最多可以比伺服器的時鐘早多少（毫秒）：
/// 用戶端照「還剩幾毫秒起跑」自己計時，本來就比伺服器慢一點，訊息在路上也要時間
const CLOCK_SLACK_MS: u64 = 3000;
/// 車子狀態的數字個數：[比賽時間（毫秒）, x, z, 車頭方向, vx, vz, 轉向速度, 方向盤, 旗標, 進度（公尺）]，
/// 伺服器只看進度，其他原封不動轉送（用戶端的編碼在 `online.ts`）
pub const STATE_LEN: usize = 10;
const PROGRESS: usize = 9;
/// 狀態裡的數字不會超過這個（賽道都在 ±2000 公尺內；比這大的一定是亂送的）
const MAX_VALUE: f64 = 1e7;
/// 一次碰撞最多讓對方的速度變多少（公尺／秒）：兩台都用極速正面對撞也不會超過
const MAX_BUMP: f64 = 2.0 * MAX_SPEED;
/// 一則撞擊通知最多幾筆（自己的車加上開的電腦，同時撞到的車不會比這多）
const MAX_HITS: usize = 16;
/// 電腦的狀態多久沒進來就換人開
const BOT_STALE: Duration = Duration::from_secs(2);

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum Track {
    #[default]
    Coast,
    Canyon,
    City,
    Xinyi,
}

impl Track {
    fn name(self) -> &'static str {
        match self {
            Track::Coast => "海岸環線",
            Track::Canyon => "紅岩峽谷",
            Track::City => "霓虹夜城",
            Track::Xinyi => "台北信義",
        }
    }

    /// 一圈最快幾毫秒：賽道一圈的長度（`track.ts` 算的，海岸 1808、峽谷 1513、夜城 1591、信義 1542 公尺）
    /// 用 `MAX_SPEED` 跑完的時間。改了賽道或極速記得重算
    fn min_lap_ms(self) -> u64 {
        match self {
            Track::Coast => 22_500,
            Track::Canyon => 18_900,
            Track::City => 19_800,
            Track::Xinyi => 19_200,
        }
    }
}

/// 電腦的難度（電腦在用戶端開，伺服器只轉告；對應 `ai.ts` 的 Difficulty）
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum Difficulty {
    Easy,
    #[default]
    Normal,
    Hard,
}

/// 車種（數值在用戶端 `spec.ts` 的 `CARS`，伺服器只轉告大家誰開哪種）
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum CarKind {
    /// 綜合
    #[default]
    All,
    /// 極速
    Speed,
    /// 加速
    Accel,
    /// 操控
    Grip,
    /// 甩尾
    Drift,
}

const CAR_KINDS: [CarKind; 5] = [CarKind::All, CarKind::Speed, CarKind::Accel, CarKind::Grip, CarKind::Drift];

/// 有幾種車色（用戶端 `spec.ts` 的 `CAR_COLORS`）；比座位數多，每個人一定分得到不同的顏色
const COLORS: usize = 10;

/// 每個座位的車：車種和車色（第幾個顏色）
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct Pick {
    pub car: CarKind,
    pub color: usize,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Options {
    pub track: Track,
    pub laps: u32,
    pub difficulty: Difficulty,
}

impl Default for Options {
    fn default() -> Self {
        Self { track: Track::Coast, laps: 3, difficulty: Difficulty::Normal }
    }
}

#[derive(Deserialize, Debug)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Action {
    /// 自己的車現在的狀態，格式見 `STATE_LEN`；跑完後重新整理（沒有自己的車）時沒有 `d`。
    /// 負責開電腦的人順便送電腦的狀態，每列是 [座位, ...狀態]
    State {
        #[serde(default)]
        d: Option<[f64; STATE_LEN]>,
        #[serde(default)]
        bots: Vec<[f64; STATE_LEN + 1]>,
    },
    /// 跑完第 `lap` 圈；`time` 是過線時的比賽時間（毫秒，從起跑算）。`bot` 是負責開電腦的人替那台電腦回報
    Lap {
        lap: u32,
        time: u64,
        #[serde(default)]
        bot: Option<usize>,
    },
    /// 對時：伺服器只回給送的人 `{type:"pong", t, clock}`，`t` 原封不動、`clock` 是伺服器現在的比賽時間
    /// （毫秒，起跑前是負的）。用戶端照來回時間估自己的時鐘差多少（見 `online.ts`）
    Ping { t: f64 },
    /// 撞到別人：撞人的瀏覽器算出被撞的車該拿到的速度變化。
    /// 伺服器轉給開那台車的人 `{type:"bump", from, to, v}`（被撞的是電腦就轉給負責開電腦的人），由他套到那台車上
    Bump { hits: Vec<Hit> },
    /// 選車時換車種和車色（`color` 是第幾個顏色）；按了「選好了」之後不能換
    Pick { car: CarKind, color: usize },
    /// 選好車了
    Ready,
}

#[derive(Deserialize, Debug)]
pub struct Hit {
    /// 被撞的座位
    seat: usize,
    /// 撞人的是自己開的電腦（座位）；自己的車撞的不用填
    #[serde(default)]
    by: Option<usize>,
    /// 被撞的車該拿到的速度變化（公尺／秒，[vx, vz]）
    v: [f64; 2],
}

struct Racer {
    /// 最後一次回報的狀態，還沒送過是 None
    state: Option<[f64; STATE_LEN]>,
    /// 上一個 tick 之後有沒有新的狀態（有的話這個 tick 要轉送）
    fresh: bool,
    /// 跑了幾公尺（從起跑線算，起跑前在線後面是負的）
    progress: f64,
    /// 每一圈花的時間（毫秒）
    lap_times: Vec<u64>,
    /// 上一次過線時的比賽時間（毫秒）
    lap_at: u64,
    /// 完賽時的比賽時間（毫秒）
    finish: Option<u64>,
    /// 結算後的名次
    place: Option<usize>,
}

impl Racer {
    fn new() -> Self {
        Self { state: None, fresh: false, progress: 0.0, lap_times: Vec::new(), lap_at: 0, finish: None, place: None }
    }
}

pub struct Racing {
    /// 這個房間的第幾局：用戶端靠它知道「換新的一局了」，要重新排起跑格
    game: u32,
    options: Options,
    racers: Vec<Racer>,
    pids: Vec<u32>,
    /// 起跑格：`grid[seat]` 是第幾格（0 在最前面），每局重新抽
    grid: Vec<usize>,
    /// 選車的截止時間；選完了（開始倒數）是 None
    select_until: Option<Instant>,
    /// 選車時每個座位按了「選好了」沒有（電腦一開始就選好了）
    ready: Vec<bool>,
    /// 起跑的時間（選車時先用「選車時間到才開始倒數」估，選完再定）
    go: Instant,
    /// 整局的時間上限
    limit_at: Instant,
    /// 第一個人跑完後，最晚什麼時候結算
    grace_at: Option<Instant>,
    /// 結算時的比賽時間；None 表示還在比
    ended: Option<Duration>,
    /// 這個房間累計的分數（pid → 分）
    scores: HashMap<u32, u32>,
    /// 每個座位是不是電腦
    bots: Vec<bool>,
    /// 負責開電腦的座位；沒有電腦、或沒有真人連著線是 None
    driver: Option<usize>,
    /// 最後一次收到電腦狀態的時間（換人開時重算；起跑前不會早於起跑時間，讓大家有時間載入）
    bots_heard: Instant,
    /// 每個座位的車種和車色（選車時可以換，車色不重複）
    cars: Vec<Pick>,
}

/// 選車開始時每個座位的車：上一局開的（跟著人走）；第一次玩的真人是綜合型、電腦隨機。
/// 真人先挑顏色、電腦拿剩下的，顏色被前面的人拿走了就換沒人用的第一個
fn first_cars(ctx: &mut Ctx, previous: Option<&Racing>) -> Vec<Pick> {
    let n = ctx.seats.len();
    let last = |pid: u32| previous.and_then(|p| p.pids.iter().position(|&q| q == pid).map(|s| p.cars[s]));
    let humans = (0..n).filter(|&s| !ctx.seats[s].bot);
    let bots = (0..n).filter(|&s| ctx.seats[s].bot);
    let order: Vec<usize> = humans.chain(bots).collect();
    let mut cars: Vec<Option<Pick>> = vec![None; n];
    for s in order {
        let before = last(ctx.seats[s].pid);
        let car = match before {
            Some(p) => p.car,
            None if ctx.seats[s].bot => CAR_KINDS[ctx.rng.below(CAR_KINDS.len())],
            None => CarKind::All,
        };
        let used = |c: usize| cars.iter().flatten().any(|p| p.color == c);
        let color = before
            .map(|p| p.color)
            .filter(|&c| !used(c))
            .or_else(|| (0..COLORS).find(|&c| !used(c)))
            .unwrap_or(s % COLORS);
        cars[s] = Some(Pick { car, color });
    }
    cars.into_iter().map(Option::unwrap_or_default).collect()
}

/// 送出去的一列車子狀態：[座位, ...狀態]
fn row(seat: usize, d: &[f64; STATE_LEN]) -> Value {
    let mut row = Vec::with_capacity(STATE_LEN + 1);
    row.push(json!(seat));
    row.extend(d.iter().map(|v| json!(v)));
    Value::Array(row)
}

/// 1:23.45
fn lap_text(ms: u64) -> String {
    let cs = ms / 10;
    format!("{}:{:02}.{:02}", cs / 6000, cs % 6000 / 100, cs % 100)
}

impl Racing {
    fn deadline(&self) -> Instant {
        self.grace_at.map_or(self.limit_at, |g| g.min(self.limit_at))
    }

    fn has_bots(&self) -> bool {
        self.bots.contains(&true)
    }

    fn is_bot(&self, seat: usize) -> bool {
        self.bots.get(seat).copied().unwrap_or(false)
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

    /// 記下一台車的狀態；亂送的數字直接丟掉，進度不能比一路用極速跑還多
    fn store(&mut self, seat: usize, d: [f64; STATE_LEN], ctx: &Ctx) {
        if d.iter().any(|v| !v.is_finite() || v.abs() > MAX_VALUE) {
            return;
        }
        let elapsed = ctx.now.saturating_duration_since(self.go).as_secs_f64();
        let r = &mut self.racers[seat];
        r.progress = d[PROGRESS].min((elapsed + 1.0) * MAX_SPEED);
        r.state = Some(d);
        r.fresh = true;
    }

    /// 撞擊通知：檢查完轉給開被撞那台車的人
    fn bump(&self, seat: usize, hit: &Hit, ctx: &mut Ctx) {
        let n = self.racers.len();
        let from = hit.by.unwrap_or(seat);
        // 只有負責開電腦的人可以替電腦撞人
        if hit.by.is_some() && (self.driver != Some(seat) || !self.is_bot(from)) {
            return;
        }
        let target = hit.seat;
        // 撞自己、自己開的車互撞（在自己的瀏覽器裡就算好了）、沒有這個座位、亂送的數字都不轉
        let ok = target != from
            && target != seat
            && target < n
            && hit.v.iter().all(|x| x.is_finite())
            && hit.v[0].hypot(hit.v[1]) <= MAX_BUMP;
        if !ok {
            return;
        }
        let to = if self.is_bot(target) {
            match self.driver {
                Some(d) if d != seat => d,
                _ => return,
            }
        } else {
            target
        };
        ctx.emit(To::Seat(to), json!({ "type": "bump", "from": from, "to": target, "v": hit.v }));
    }

    /// 選車時換車：車色不能和別的真人一樣；和電腦一樣的話，電腦換一個沒人用的
    fn pick(&mut self, seat: usize, car: CarKind, color: usize, ctx: &mut Ctx) -> Result<(), String> {
        if color >= COLORS {
            return Err("沒有這個顏色".into());
        }
        if self.ready[seat] {
            return Err("你已經選好了，這局不能再換".into());
        }
        let n = self.cars.len();
        if (0..n).any(|s| s != seat && !self.bots[s] && self.cars[s].color == color) {
            return Err("這個顏色已經有人選了，換一個吧".into());
        }
        self.cars[seat] = Pick { car, color };
        for s in 0..n {
            if s != seat && self.bots[s] && self.cars[s].color == color {
                if let Some(free) = (0..COLORS).find(|&c| self.cars.iter().all(|p| p.color != c)) {
                    self.cars[s].color = free;
                }
            }
        }
        ctx.changed();
        Ok(())
    }

    /// 選車時：連著線的真人都選好了（斷線的不等）、或時間到了，就照現在選的開始倒數
    fn check_select(&mut self, ctx: &mut Ctx) {
        let Some(until) = self.select_until else { return };
        let all_ready = (0..self.ready.len()).all(|s| self.ready[s] || !ctx.seats[s].online);
        if !all_ready && ctx.now < until {
            return;
        }
        self.select_until = None;
        self.go = ctx.now + COUNTDOWN;
        self.limit_at = self.go + LAP_LIMIT * self.options.laps;
        self.bots_heard = self.go;
        ctx.system(To::All, if all_ready { "大家都選好車了，5 秒後起跑！" } else { "選車時間到，5 秒後起跑！" });
        ctx.changed();
    }

    /// 名次：跑完的照完賽時間，沒跑完的照圈數、再照進度；同樣的照座位
    fn order(&self) -> Vec<usize> {
        let mut order: Vec<usize> = (0..self.racers.len()).collect();
        order.sort_by(|&a, &b| {
            let (ra, rb) = (&self.racers[a], &self.racers[b]);
            match (ra.finish, rb.finish) {
                (Some(x), Some(y)) => x.cmp(&y),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (None, None) => rb.lap_times.len().cmp(&ra.lap_times.len()).then(rb.progress.total_cmp(&ra.progress)),
            }
            .then(a.cmp(&b))
        });
        order
    }

    /// 結算：排名次、加分、公布前三名
    fn end(&mut self, ctx: &mut Ctx) {
        self.ended = Some(ctx.now.saturating_duration_since(self.go));
        let n = self.racers.len();
        let mut lines = Vec::new();
        for (k, s) in self.order().into_iter().enumerate() {
            let place = k + 1;
            let r = &mut self.racers[s];
            r.place = Some(place);
            // 第 1 名 n 分，每差一名少 1 分；沒跑完的再少 1 分
            let points = (n - k) as u32 - u32::from(r.finish.is_none());
            *self.scores.entry(self.pids[s]).or_default() += points;
            if place <= 3 {
                let result = match r.finish {
                    Some(ms) => lap_text(ms),
                    None => format!("跑了 {} 圈", r.lap_times.len()),
                };
                lines.push(format!("{place}. {} {result}", ctx.seats[s].name));
            }
        }
        ctx.announce(To::All, format!("結算：{}", lines.join("、")), "accent");
        ctx.changed();
    }

    /// 過線：檢查合不合理再記下來
    fn lap(&mut self, seat: usize, lap: u32, time: u64, ctx: &mut Ctx) -> Result<(), String> {
        if ctx.now < self.go {
            return Err("還沒起跑".into());
        }
        let laps = self.options.laps;
        let r = &self.racers[seat];
        if r.finish.is_some() {
            return Err("你已經跑完了".into());
        }
        if lap as usize != r.lap_times.len() + 1 || lap > laps {
            return Err("圈數對不上，這圈不算".into());
        }
        let elapsed = ctx.now.duration_since(self.go).as_millis() as u64;
        // 回報的時間不能比伺服器的時鐘晚，也不能早太多
        let time = time.clamp(elapsed.saturating_sub(CLOCK_SLACK_MS), elapsed);
        let lap_ms = time.saturating_sub(r.lap_at);
        if lap_ms < self.options.track.min_lap_ms() {
            return Err("這圈快得不合理，不算".into());
        }
        let r = &mut self.racers[seat];
        r.lap_times.push(lap_ms);
        r.lap_at = time;
        if lap == laps {
            r.finish = Some(time);
            let name = ctx.seats[seat].name.clone();
            let done = self.racers.iter().filter(|r| r.finish.is_some()).count();
            if self.grace_at.is_none() {
                self.grace_at = Some(ctx.now + GRACE);
                ctx.announce(To::All, format!("{name} 第一個跑完！{}，其他人 30 秒內要過線", lap_text(time)), "ok");
            } else {
                ctx.system(To::All, format!("{name} 跑完了（第 {done} 個），{}", lap_text(time)));
            }
        }
        Ok(())
    }
}

impl PartyGame for Racing {
    const ID: &'static str = "racing";
    const MIN_PLAYERS: usize = 2;
    const MAX_PLAYERS: usize = 8;
    /// 至少要一個真人負責開電腦，所以最多 7 台
    const MAX_BOTS: usize = 7;
    /// 合併轉送車子狀態的間隔
    const TICK: Duration = Duration::from_millis(50);
    /// 狀態每秒 20 則，加上碰撞（用戶端最多每秒 10 則）、對時、過線、聊天
    const MSGS_PER_SEC: u32 = 40;

    type Options = Options;
    type Action = Action;

    fn rooms(state: &AppState) -> &Arc<Parties<Self>> {
        &state.racing
    }

    fn check_options(options: Options) -> Result<Options, String> {
        if matches!(options.laps, 1 | 3 | 5) { Ok(options) } else { Err("圈數只能選 1、3、5 圈".into()) }
    }

    fn start(options: &Options, previous: Option<&Self>, ctx: &mut Ctx) -> Self {
        let n = ctx.seats.len();
        let mut grid: Vec<usize> = (0..n).collect();
        shuffle(ctx.rng, &mut grid);
        let select_until = ctx.now + SELECT;
        let go = select_until + COUNTDOWN;
        ctx.system(
            To::All,
            format!(
                "新的一局：{}，{} 圈。{} 秒內選好車，大家都選好就開始！",
                options.track.name(),
                options.laps,
                SELECT.as_secs()
            ),
        );
        ctx.changed();
        let bots: Vec<bool> = ctx.seats.iter().map(|s| s.bot).collect();
        let driver = if bots.contains(&true) { (0..n).find(|&s| !bots[s] && ctx.seats[s].online) } else { None };
        let cars = first_cars(ctx, previous);
        Self {
            game: previous.map_or(1, |p| p.game + 1),
            options: options.clone(),
            racers: (0..n).map(|_| Racer::new()).collect(),
            pids: ctx.seats.iter().map(|s| s.pid).collect(),
            grid,
            select_until: Some(select_until),
            ready: bots.clone(),
            go,
            limit_at: go + LAP_LIMIT * options.laps,
            grace_at: None,
            ended: None,
            scores: previous.map(|p| p.scores.clone()).unwrap_or_default(),
            bots,
            driver,
            bots_heard: go,
            cars,
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
            Action::Pick { car, color } if selecting => self.pick(seat, car, color, ctx),
            Action::Pick { .. } => Err("已經開始了，這局不能換車".into()),
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
            // 選車時還沒有車在跑
            Action::State { .. } | Action::Bump { .. } if selecting => {
                ctx.quiet();
                Ok(())
            }
            Action::State { d, bots } => {
                // 狀態只靠 tick 合併轉送，不重送 view；格式不對的直接丟掉（每秒 20 則，不要每則都回錯誤）
                ctx.quiet();
                if let Some(d) = d {
                    self.store(seat, d, ctx);
                }
                // 電腦的狀態只收負責開的人送的（剛換人時，前一個人還在路上的就不要了）
                if !bots.is_empty() && self.driver == Some(seat) {
                    self.bots_heard = ctx.now;
                    for row in bots {
                        let bot = row[0];
                        if bot >= 0.0 && bot.fract() == 0.0 && self.is_bot(bot as usize) {
                            let mut d = [0.0; STATE_LEN];
                            d.copy_from_slice(&row[1..]);
                            self.store(bot as usize, d, ctx);
                        }
                    }
                }
                Ok(())
            }
            Action::Lap { lap, time, bot: None } => self.lap(seat, lap, time, ctx),
            Action::Lap { lap, time, bot: Some(bot) } => {
                // 電腦的過線：只收負責開的人送的；不合理就不算，不用告訴他（不是他自己的成績）
                if self.driver != Some(seat) || !self.is_bot(bot) || self.lap(bot, lap, time, ctx).is_err() {
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
            Action::Bump { hits } => {
                ctx.quiet();
                for hit in hits.iter().take(MAX_HITS) {
                    self.bump(seat, hit, ctx);
                }
                Ok(())
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
        // 這段時間有更新的車合併成一則：[座位, ...狀態]
        let cars: Vec<Value> = self
            .racers
            .iter_mut()
            .enumerate()
            .filter_map(|(seat, r)| {
                let state = r.state.filter(|_| r.fresh)?;
                r.fresh = false;
                Some(row(seat, &state))
            })
            .collect();
        if !cars.is_empty() {
            ctx.emit(To::All, json!({ "type": "cars", "cars": cars }));
        }
        // 負責開電腦的人一陣子沒送電腦的狀態（切到背景、當掉）：換人開
        if self.has_bots() && ctx.now >= self.go {
            let stale = ctx.now.saturating_duration_since(self.bots_heard) > BOT_STALE;
            if self.driver.is_none() || stale {
                self.hand_over(self.driver, ctx);
            }
        }
        // 有人跑完、而且連著線的真人都跑完了（斷線的、電腦都不等），或時間到了就結算
        let someone_done = self.racers.iter().any(|r| r.finish.is_some());
        let all_done =
            (0..self.racers.len()).all(|s| self.racers[s].finish.is_some() || !ctx.seats[s].online || self.bots[s]);
        if (someone_done && all_done) || ctx.now >= self.deadline() {
            self.end(ctx);
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
        ctx.changed();
    }

    fn view(&self, seat: Option<usize>, now: Instant) -> Value {
        let ended = self.ended.is_some();
        let players: Vec<Value> = self
            .racers
            .iter()
            .enumerate()
            .map(|(s, r)| {
                json!({
                    "lapTimes": r.lap_times,
                    "finish": r.finish,
                    "place": r.place,
                    "points": self.scores.get(&self.pids[s]).copied().unwrap_or(0),
                })
            })
            .collect();
        let elapsed = self.ended.unwrap_or_else(|| now.saturating_duration_since(self.go));
        let bot_states: Vec<Value> = if seat.is_some() && seat == self.driver {
            (0..self.racers.len())
                .filter(|&s| self.bots[s])
                .filter_map(|s| {
                    let d = self.racers[s].state?;
                    Some(row(s, &d))
                })
                .collect()
        } else {
            Vec::new()
        };
        json!({
            "game": self.game,
            "track": self.options.track,
            "laps": self.options.laps,
            "grid": self.grid,
            "startsIn": self.go.saturating_duration_since(now).as_millis() as u64,
            "elapsed": elapsed.as_millis() as u64,
            // 第一個人跑完後的倒數；還沒有人跑完、或已經結算是 null
            "endsIn": self.grace_at.filter(|_| !ended).map(|_| self.deadline().saturating_duration_since(now).as_millis() as u64),
            "ended": ended,
            "you": seat,
            // 自己最後送出的狀態：重新整理頁面後從這裡接著跑，不用回到起跑線
            "resume": seat.and_then(|s| self.racers[s].state),
            "players": players,
            "difficulty": self.options.difficulty,
            "bots": (0..self.bots.len()).filter(|&s| self.bots[s]).collect::<Vec<_>>(),
            "driver": self.driver,
            // 負責開電腦的人才拿得到：電腦最後的狀態（重新整理後從這裡接著開），每列是 [座位, ...狀態]
            "botStates": bot_states,
            "cars": self.cars,
            // 選車時：還剩幾毫秒、每個座位選好了沒有；選完了是 null
            "select": self.select_until.map(|until| json!({
                "endsIn": until.saturating_duration_since(now).as_millis() as u64,
                "ready": self.ready,
            })),
        })
    }

    fn finished(&self) -> bool {
        self.ended.is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::party::{Outbox, Rng, SeatInfo, test_ctx};

    fn seats(n: usize) -> Vec<SeatInfo> {
        mixed(n, 0)
    }

    /// 前面 `humans` 個真人，後面 `bots` 個電腦
    fn mixed(humans: usize, bots: usize) -> Vec<SeatInfo> {
        (0..humans + bots)
            .map(|i| SeatInfo { pid: i as u32 + 1, name: format!("P{i}"), bot: i >= humans, online: true })
            .collect()
    }

    /// 開一局，起跑時間設成 `ago` 之前（測試不用真的等）
    fn game(n: usize, laps: u32, ago: Duration) -> (Racing, Vec<SeatInfo>, Rng) {
        start_with(seats(n), laps, ago)
    }

    fn start_with(seats: Vec<SeatInfo>, laps: u32, ago: Duration) -> (Racing, Vec<SeatInfo>, Rng) {
        let mut rng = Rng::new();
        let mut out = Outbox::default();
        let now = Instant::now();
        let mut game = {
            let mut ctx = test_ctx(now, &mut rng, &seats, &mut out);
            Racing::start(&Options { track: Track::City, laps, ..Options::default() }, None, &mut ctx)
        };
        // 跳過選車
        game.select_until = None;
        game.go = now - ago;
        game.limit_at = game.go + LAP_LIMIT * laps;
        game.bots_heard = now;
        (game, seats, rng)
    }

    fn act(g: &mut Racing, seats: &[SeatInfo], rng: &mut Rng, seat: usize, action: Action) -> Result<(), String> {
        let mut out = Outbox::default();
        let mut ctx = test_ctx(Instant::now(), rng, seats, &mut out);
        g.act(seat, action, &mut ctx)
    }

    fn tick(g: &mut Racing, seats: &[SeatInfo], rng: &mut Rng, now: Instant) -> Outbox {
        let mut out = Outbox::default();
        let mut ctx = test_ctx(now, rng, seats, &mut out);
        g.tick(&mut ctx);
        out
    }

    fn state(progress: f64) -> Action {
        Action::State { d: Some([1000.0, 1.0, 2.0, 0.5, 3.0, 4.0, 0.1, -0.2, 3.0, progress]), bots: vec![] }
    }

    fn lap(lap: u32, time: u64) -> Action {
        Action::Lap { lap, time, bot: None }
    }

    fn bump(seat: usize, by: Option<usize>, v: [f64; 2]) -> Action {
        Action::Bump { hits: vec![Hit { seat, by, v }] }
    }

    /// 負責開電腦的人送的狀態：自己的車沒有，只有電腦 `bot`
    fn bot_state(bot: f64, progress: f64) -> Action {
        Action::State { d: None, bots: vec![[bot, 1000.0, 1.0, 2.0, 0.5, 3.0, 4.0, 0.1, -0.2, 3.0, progress]] }
    }

    /// 把起跑時間改成 `secs` 秒前
    fn started(g: &mut Racing, secs: u64) {
        g.go = Instant::now() - Duration::from_secs(secs);
    }

    #[test]
    fn laps_must_come_in_order_and_be_possible() {
        let (mut g, seats, mut rng) = game(2, 3, Duration::from_secs(16));
        assert!(act(&mut g, &seats, &mut rng, 0, lap(2, 15_000)).is_err(), "跳過第一圈");
        // 夜城一圈至少 19.7 秒
        assert!(act(&mut g, &seats, &mut rng, 0, lap(1, 15_000)).is_err());
        started(&mut g, 26);
        assert!(act(&mut g, &seats, &mut rng, 0, lap(1, 25_000)).is_ok());
        assert_eq!(g.racers[0].lap_times, vec![25_000]);
        // 時間不能比伺服器的時鐘晚：報 90 秒也只算到現在（50 秒），這圈約 25 秒
        started(&mut g, 50);
        assert!(act(&mut g, &seats, &mut rng, 0, lap(2, 90_000)).is_ok());
        let second = g.racers[0].lap_times[1];
        assert!((24_000..=26_000).contains(&second), "第二圈 {second}");
        assert!(act(&mut g, &seats, &mut rng, 0, lap(3, 52_000)).is_err(), "這圈才跑不到一秒");
        assert!(act(&mut g, &seats, &mut rng, 0, lap(4, 200_000)).is_err(), "超過圈數");
    }

    #[test]
    fn lap_times_far_behind_the_server_clock_are_pulled_forward() {
        let (mut g, seats, mut rng) = game(2, 1, Duration::from_secs(40));
        // 說自己 20 秒就跑完，但伺服器已經過了 40 秒：最多只能早 3 秒
        act(&mut g, &seats, &mut rng, 0, lap(1, 20_000)).unwrap();
        let finish = g.racers[0].finish.unwrap();
        assert!((36_900..=37_100).contains(&finish), "完賽時間 {finish}");
    }

    #[test]
    fn nothing_counts_before_the_start() {
        let (mut g, seats, mut rng) = game(2, 1, Duration::ZERO);
        g.go = Instant::now() + Duration::from_secs(3);
        assert!(act(&mut g, &seats, &mut rng, 0, lap(1, 30_000)).is_err());
    }

    #[test]
    fn states_are_merged_into_one_event_per_tick() {
        let (mut g, seats, mut rng) = game(3, 1, Duration::from_secs(10));
        act(&mut g, &seats, &mut rng, 0, state(10.0)).unwrap();
        act(&mut g, &seats, &mut rng, 2, state(20.0)).unwrap();
        act(&mut g, &seats, &mut rng, 2, state(30.0)).unwrap();
        let out = tick(&mut g, &seats, &mut rng, Instant::now());
        let events = out.events();
        assert_eq!(events.len(), 1);
        let cars = events[0].1["cars"].as_array().unwrap();
        assert_eq!(cars.len(), 2, "只有送過狀態的車");
        assert_eq!(cars[0][0], 0);
        assert_eq!(cars[1][0], 2);
        assert_eq!(cars[1].as_array().unwrap().len(), STATE_LEN + 1);
        assert_eq!(cars[1][PROGRESS + 1], 30.0, "同一個 tick 裡只送最新的");
        // 沒有新的狀態就不送
        assert!(tick(&mut g, &seats, &mut rng, Instant::now()).events().is_empty());
    }

    #[test]
    fn progress_cannot_outrun_the_top_speed() {
        let (mut g, seats, mut rng) = game(2, 3, Duration::from_secs(10));
        act(&mut g, &seats, &mut rng, 0, state(5000.0)).unwrap();
        assert!(g.racers[0].progress <= 11.0 * MAX_SPEED + 1.0);
        // 亂送的數字直接丟掉
        let mut bad = [0.0; STATE_LEN];
        bad[1] = 1e12;
        act(&mut g, &seats, &mut rng, 1, Action::State { d: Some(bad), bots: vec![] }).unwrap();
        assert!(g.racers[1].state.is_none());
    }

    #[test]
    fn the_first_finish_starts_the_grace_and_unfinished_rank_by_progress() {
        let (mut g, seats, mut rng) = game(3, 1, Duration::from_secs(40));
        act(&mut g, &seats, &mut rng, 1, state(900.0)).unwrap();
        act(&mut g, &seats, &mut rng, 2, state(1200.0)).unwrap();
        act(&mut g, &seats, &mut rng, 0, lap(1, 39_000)).unwrap();
        assert!(g.grace_at.is_some());
        tick(&mut g, &seats, &mut rng, Instant::now());
        assert!(g.ended.is_none(), "其他人還在跑");
        // 寬限時間到了
        tick(&mut g, &seats, &mut rng, Instant::now() + GRACE + Duration::from_secs(1));
        assert!(g.ended.is_some());
        let places: Vec<_> = g.racers.iter().map(|r| r.place.unwrap()).collect();
        assert_eq!(places, vec![1, 3, 2]);
        // 3 人：第 1 名 3 分，沒跑完的再少 1 分
        assert_eq!(g.scores[&1], 3);
        assert_eq!(g.scores[&3], 1);
        assert_eq!(g.scores[&2], 0);
    }

    #[test]
    fn ends_early_when_everyone_online_has_finished() {
        let (mut g, mut seats, mut rng) = game(3, 1, Duration::from_secs(40));
        seats[2].online = false;
        act(&mut g, &seats, &mut rng, 0, lap(1, 38_000)).unwrap();
        tick(&mut g, &seats, &mut rng, Instant::now());
        assert!(g.ended.is_none());
        act(&mut g, &seats, &mut rng, 1, lap(1, 39_000)).unwrap();
        tick(&mut g, &seats, &mut rng, Instant::now());
        assert!(g.ended.is_some(), "斷線的人不用等");
        assert_eq!(g.racers[0].place, Some(1));
        assert_eq!(g.racers[1].place, Some(2));
    }

    #[test]
    fn grid_is_a_permutation_and_views_carry_your_own_state() {
        let (mut g, seats, mut rng) = game(4, 3, Duration::from_secs(5));
        let mut grid = g.grid.clone();
        grid.sort();
        assert_eq!(grid, vec![0, 1, 2, 3]);
        act(&mut g, &seats, &mut rng, 1, state(42.0)).unwrap();
        let mine = g.view(Some(1), Instant::now());
        assert_eq!(mine["resume"][PROGRESS], 42.0);
        assert!(g.view(Some(0), Instant::now())["resume"].is_null());
        assert!(g.view(None, Instant::now())["resume"].is_null());
    }

    #[test]
    fn ping_answers_only_the_sender_with_the_race_clock() {
        let (mut g, seats, mut rng) = game(2, 1, Duration::ZERO);
        g.go = Instant::now() + Duration::from_secs(2);
        let mut out = Outbox::default();
        let mut ctx = test_ctx(Instant::now(), &mut rng, &seats, &mut out);
        g.act(1, Action::Ping { t: 1234.5 }, &mut ctx).unwrap();
        let (to, pong) = &out.events()[0];
        assert!(matches!(to, To::Seat(1)));
        assert_eq!(pong["t"], 1234.5);
        let clock = pong["clock"].as_i64().unwrap();
        assert!((-2000..=-1900).contains(&clock), "起跑前是負的：{clock}");
    }

    #[test]
    fn bumps_go_only_to_the_car_that_was_hit() {
        let (mut g, seats, mut rng) = game(3, 1, Duration::from_secs(5));
        let mut out = Outbox::default();
        let mut ctx = test_ctx(Instant::now(), &mut rng, &seats, &mut out);
        g.act(0, bump(2, None, [3.0, -1.5]), &mut ctx).unwrap();
        g.act(0, bump(0, None, [3.0, 0.0]), &mut ctx).unwrap();
        g.act(0, bump(7, None, [3.0, 0.0]), &mut ctx).unwrap();
        g.act(0, bump(1, None, [500.0, 0.0]), &mut ctx).unwrap();
        g.act(0, bump(1, Some(2), [3.0, 0.0]), &mut ctx).unwrap();
        let events = out.events();
        assert_eq!(events.len(), 1, "撞自己、沒有的座位、太大的、冒充別人的車都不轉");
        assert!(matches!(events[0].0, To::Seat(2)));
        assert_eq!(events[0].1, json!({ "type": "bump", "from": 0, "to": 2, "v": [3.0, -1.5] }));
    }

    #[test]
    fn bot_states_come_only_from_the_driver() {
        let (mut g, seats, mut rng) = start_with(mixed(2, 2), 1, Duration::from_secs(10));
        assert_eq!(g.driver, Some(0), "第一個連著線的真人負責開電腦");
        act(&mut g, &seats, &mut rng, 1, bot_state(2.0, 50.0)).unwrap();
        assert!(g.racers[2].state.is_none(), "不是負責開的人");
        act(&mut g, &seats, &mut rng, 0, bot_state(2.0, 50.0)).unwrap();
        act(&mut g, &seats, &mut rng, 0, bot_state(1.0, 60.0)).unwrap();
        act(&mut g, &seats, &mut rng, 0, bot_state(3.5, 60.0)).unwrap();
        assert_eq!(g.racers[2].progress, 50.0);
        assert!(g.racers[1].state.is_none(), "真人的車不能替他送");
        assert!(g.racers[3].state.is_none());
        // 電腦的狀態跟著一起轉送
        let out = tick(&mut g, &seats, &mut rng, Instant::now());
        assert_eq!(out.events()[0].1["cars"][0][0], 2);
        // 重新整理時接著開：只有負責開的人拿得到電腦最後的狀態
        let mine = g.view(Some(0), Instant::now());
        assert_eq!(mine["bots"], json!([2, 3]));
        assert_eq!(mine["driver"], 0);
        assert_eq!(mine["botStates"][0][0], 2);
        assert_eq!(mine["botStates"][0][PROGRESS + 1], 50.0);
        assert_eq!(g.view(Some(1), Instant::now())["botStates"], json!([]));
    }

    #[test]
    fn the_bots_pass_on_when_the_driver_goes_quiet_or_offline() {
        let (mut g, mut seats, mut rng) = start_with(mixed(3, 1), 1, Duration::from_secs(10));
        assert_eq!(g.driver, Some(0));
        tick(&mut g, &seats, &mut rng, Instant::now() + Duration::from_secs(1));
        assert_eq!(g.driver, Some(0), "還沒到換人的時間");
        // 太久沒送電腦的狀態（切到背景）：輪給下一位
        tick(&mut g, &seats, &mut rng, Instant::now() + BOT_STALE + Duration::from_secs(1));
        assert_eq!(g.driver, Some(1));
        act(&mut g, &seats, &mut rng, 0, bot_state(3.0, 80.0)).unwrap();
        assert!(g.racers[3].state.is_none(), "換人後前一個人送的不要");
        // 負責開的人斷線：跳過斷線的人輪下去
        seats[2].online = false;
        seats[1].online = false;
        let mut out = Outbox::default();
        let mut ctx = test_ctx(Instant::now(), &mut rng, &seats, &mut out);
        g.presence(1, false, &mut ctx);
        assert_eq!(g.driver, Some(0));
        // 只剩自己一個真人：切到背景也只能等他回來
        tick(&mut g, &seats, &mut rng, Instant::now() + BOT_STALE * 3);
        assert_eq!(g.driver, Some(0));
        // 大家都斷線就沒人開，有人回來再交給他
        seats[0].online = false;
        let mut ctx = test_ctx(Instant::now(), &mut rng, &seats, &mut out);
        g.presence(0, false, &mut ctx);
        assert_eq!(g.driver, None);
        seats[2].online = true;
        let mut ctx = test_ctx(Instant::now(), &mut rng, &seats, &mut out);
        g.presence(2, true, &mut ctx);
        assert_eq!(g.driver, Some(2));
    }

    #[test]
    fn bot_laps_and_bumps_go_through_the_driver() {
        let (mut g, seats, mut rng) = start_with(mixed(2, 1), 3, Duration::from_secs(30));
        let bot_lap = |lap, time| Action::Lap { lap, time, bot: Some(2) };
        act(&mut g, &seats, &mut rng, 1, bot_lap(1, 29_000)).unwrap();
        assert!(g.racers[2].lap_times.is_empty(), "不是負責開的人");
        assert!(act(&mut g, &seats, &mut rng, 0, bot_lap(2, 29_000)).is_ok(), "電腦的成績不合理也不回錯誤");
        assert!(g.racers[2].lap_times.is_empty());
        act(&mut g, &seats, &mut rng, 0, bot_lap(1, 29_000)).unwrap();
        assert_eq!(g.racers[2].lap_times, vec![29_000]);
        assert!(g.racers[0].lap_times.is_empty(), "算在電腦身上，不是負責開的人");

        let mut out = Outbox::default();
        let mut ctx = test_ctx(Instant::now(), &mut rng, &seats, &mut out);
        // 撞到電腦：轉給負責開電腦的人
        g.act(1, bump(2, None, [1.0, 2.0]), &mut ctx).unwrap();
        // 負責開的人自己的車撞到自己開的電腦：在他的瀏覽器裡就算好了，不轉
        g.act(0, bump(2, None, [1.0, 2.0]), &mut ctx).unwrap();
        // 電腦撞到別人：用電腦的名義轉過去
        g.act(0, bump(1, Some(2), [-1.0, 0.5]), &mut ctx).unwrap();
        // 電腦撞到負責開的人自己：也是在他那邊算好了
        g.act(0, bump(0, Some(2), [-1.0, 0.5]), &mut ctx).unwrap();
        let events = out.events();
        assert_eq!(events.len(), 2);
        assert!(matches!(events[0].0, To::Seat(0)));
        assert_eq!(events[0].1, json!({ "type": "bump", "from": 1, "to": 2, "v": [1.0, 2.0] }));
        assert!(matches!(events[1].0, To::Seat(1)));
        assert_eq!(events[1].1, json!({ "type": "bump", "from": 2, "to": 1, "v": [-1.0, 0.5] }));
    }

    #[test]
    fn bots_do_not_hold_up_the_end() {
        let (mut g, seats, mut rng) = start_with(mixed(1, 2), 1, Duration::from_secs(40));
        act(&mut g, &seats, &mut rng, 0, bot_state(1.0, 900.0)).unwrap();
        act(&mut g, &seats, &mut rng, 0, lap(1, 39_000)).unwrap();
        tick(&mut g, &seats, &mut rng, Instant::now());
        assert!(g.ended.is_some(), "真人都跑完了就結算");
        assert_eq!(g.racers[0].place, Some(1));
        assert_eq!(g.racers[1].place, Some(2), "沒跑完的電腦照進度排");
        assert_eq!(g.scores[&2], 1, "電腦也拿分");
    }

    #[test]
    fn only_one_three_or_five_laps() {
        let options = |laps| Options { track: Track::Canyon, laps, ..Options::default() };
        assert!(Racing::check_options(options(5)).is_ok());
        assert!(Racing::check_options(options(2)).is_err());
        assert!(Racing::check_options(options(0)).is_err());
    }

    #[test]
    fn track_ids_match_the_frontend() {
        // tracks.ts 的 id（online.ts 的 OnlineTrack）
        for (id, track) in
            [("coast", Track::Coast), ("canyon", Track::Canyon), ("city", Track::City), ("xinyi", Track::Xinyi)]
        {
            assert_eq!(serde_json::from_value::<Track>(json!(id)).unwrap(), track);
        }
    }

    /// 開一局，停在選車
    fn selecting(seats: Vec<SeatInfo>, previous: Option<&Racing>) -> (Racing, Vec<SeatInfo>, Rng) {
        let mut rng = Rng::new();
        let mut out = Outbox::default();
        let game = {
            let mut ctx = test_ctx(Instant::now(), &mut rng, &seats, &mut out);
            Racing::start(&Options::default(), previous, &mut ctx)
        };
        (game, seats, rng)
    }

    fn pick(car: CarKind, color: usize) -> Action {
        Action::Pick { car, color }
    }

    #[test]
    fn colors_go_to_whoever_picks_first() {
        let (mut g, s, mut rng) = selecting(seats(3), None);
        assert!(g.select_until.is_some(), "開局先選車");
        // 第一局都是綜合型，顏色照座位
        let start: Vec<Pick> = (0..3).map(|color| Pick { car: CarKind::All, color }).collect();
        assert_eq!(g.cars, start);
        act(&mut g, &s, &mut rng, 0, pick(CarKind::Speed, 5)).unwrap();
        assert_eq!(act(&mut g, &s, &mut rng, 1, pick(CarKind::Drift, 5)), Err("這個顏色已經有人選了，換一個吧".into()));
        assert!(act(&mut g, &s, &mut rng, 1, pick(CarKind::Drift, 0)).is_ok(), "0 號換掉的顏色空出來了");
        assert!(act(&mut g, &s, &mut rng, 2, pick(CarKind::All, COLORS)).is_err(), "沒有這個顏色");
        // 選好了就不能換
        act(&mut g, &s, &mut rng, 0, Action::Ready).unwrap();
        assert!(act(&mut g, &s, &mut rng, 0, pick(CarKind::Grip, 7)).is_err());
        assert_eq!(g.cars[0], Pick { car: CarKind::Speed, color: 5 });
        let view = g.view(Some(1), Instant::now());
        assert_eq!(view["cars"][1], json!({ "car": "drift", "color": 0 }));
        assert_eq!(view["select"]["ready"], json!([true, false, false]));
        assert!(view["select"]["endsIn"].as_u64().unwrap() > 29_000);
    }

    #[test]
    fn bots_give_their_color_to_people() {
        let (mut g, s, mut rng) = selecting(mixed(1, 2), None);
        // 真人先拿第一個顏色，電腦拿剩下的
        assert_eq!(g.cars[0].color, 0);
        assert_eq!(g.cars[1].color, 1);
        assert_eq!(g.ready, vec![false, true, true], "電腦一開始就選好了");
        act(&mut g, &s, &mut rng, 0, pick(CarKind::Grip, 1)).unwrap();
        assert_eq!(g.cars[0], Pick { car: CarKind::Grip, color: 1 });
        let mut colors: Vec<usize> = g.cars.iter().map(|c| c.color).collect();
        colors.sort();
        colors.dedup();
        assert_eq!(colors.len(), 3, "顏色不重複：{:?}", g.cars);
    }

    #[test]
    fn the_countdown_starts_once_everyone_online_is_ready() {
        let (mut g, mut s, mut rng) = selecting(mixed(3, 1), None);
        assert!(act(&mut g, &s, &mut rng, 0, lap(1, 30_000)).is_err(), "選車時還不能跑");
        act(&mut g, &s, &mut rng, 0, Action::Ready).unwrap();
        tick(&mut g, &s, &mut rng, Instant::now());
        assert!(g.select_until.is_some(), "還有人在選");
        // 斷線的人不用等
        s[2].online = false;
        act(&mut g, &s, &mut rng, 1, Action::Ready).unwrap();
        assert!(g.select_until.is_none());
        let starts_in = g.go.saturating_duration_since(Instant::now());
        assert!(starts_in <= COUNTDOWN && starts_in > COUNTDOWN - Duration::from_secs(1), "倒數 {starts_in:?}");
        assert_eq!(g.limit_at, g.go + LAP_LIMIT * g.options.laps);
        assert!(g.view(Some(0), Instant::now())["select"].is_null());
        assert!(act(&mut g, &s, &mut rng, 0, pick(CarKind::Grip, 6)).is_err(), "開始倒數就不能換");
    }

    #[test]
    fn time_up_goes_with_what_was_picked() {
        let (mut g, s, mut rng) = selecting(seats(2), None);
        act(&mut g, &s, &mut rng, 1, pick(CarKind::Accel, 4)).unwrap();
        tick(&mut g, &s, &mut rng, Instant::now() + Duration::from_secs(20));
        assert!(g.select_until.is_some());
        tick(&mut g, &s, &mut rng, Instant::now() + SELECT + Duration::from_millis(100));
        assert!(g.select_until.is_none(), "時間到了，沒按選好了也開始");
        assert_eq!(g.cars[1], Pick { car: CarKind::Accel, color: 4 });
    }

    #[test]
    fn the_next_game_starts_with_the_same_cars() {
        let (mut g, s, mut rng) = selecting(mixed(2, 1), None);
        act(&mut g, &s, &mut rng, 0, pick(CarKind::Drift, 7)).unwrap();
        act(&mut g, &s, &mut rng, 1, pick(CarKind::Speed, 3)).unwrap();
        let bot = g.cars[2];
        // 下一局座位換了，車跟著人走
        let next_seats = vec![s[1].clone(), s[0].clone(), s[2].clone()];
        let (next, _, _) = selecting(next_seats, Some(&g));
        assert_eq!(next.game, 2);
        assert_eq!(next.cars[0], Pick { car: CarKind::Speed, color: 3 });
        assert_eq!(next.cars[1], Pick { car: CarKind::Drift, color: 7 });
        assert_eq!(next.cars[2], bot);
        assert_eq!(next.ready, vec![false, false, true], "每一局都要重新按選好了");
    }
}
