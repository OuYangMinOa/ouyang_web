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
//!   （`Action::Bump`，伺服器只轉給被撞的人），不然被撞的人常常看不到重疊、感覺不到被撞。
//! - 對時（`Action::Ping`）：用戶端照來回時間對準伺服器的比賽時鐘，別人的車才推算得準。
//! - 開局倒數 `COUNTDOWN`。第一個人跑完後，其他人還有 `GRACE` 可以跑。
//!   時間到時，沒跑完的照圈數和進度排名；連著線的人都跑完就提早結算。
//! - 不能加電腦：伺服器沒有物理，沒辦法替電腦開車。

use std::{collections::HashMap, sync::Arc, time::Duration};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::time::Instant;

use crate::{
    AppState,
    party::{Ctx, Parties, PartyGame, To, shuffle},
};

/// 開局倒數：前兩秒讓大家載入賽道，最後三秒才顯示 3、2、1
const COUNTDOWN: Duration = Duration::from_secs(5);
/// 第一個人跑完後，其他人還能跑多久
const GRACE: Duration = Duration::from_secs(30);
/// 平均一圈最多給多久（整局的時間上限 = 這個 × 圈數），免得有人掛著不動，房間永遠結束不了
const LAP_LIMIT: Duration = Duration::from_secs(4 * 60);
/// 伺服器認定的極速（公尺／秒）：噴射時的極速約 71（`spec.ts` 的 58 × 1.22），再寬鬆一點
const MAX_SPEED: f64 = 75.0;
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

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum Track {
    #[default]
    Coast,
    Canyon,
    City,
}

impl Track {
    fn name(self) -> &'static str {
        match self {
            Track::Coast => "海岸環線",
            Track::Canyon => "紅岩峽谷",
            Track::City => "霓虹夜城",
        }
    }

    /// 一圈最快幾毫秒：賽道一圈的長度（`track.ts` 算的，海岸 1805、峽谷 1508、夜城 1483 公尺）
    /// 用 `MAX_SPEED` 跑完的時間。改了賽道記得重算
    fn min_lap_ms(self) -> u64 {
        match self {
            Track::Coast => 24_000,
            Track::Canyon => 20_000,
            Track::City => 19_700,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Options {
    pub track: Track,
    pub laps: u32,
}

impl Default for Options {
    fn default() -> Self {
        Self { track: Track::Coast, laps: 3 }
    }
}

#[derive(Deserialize, Debug)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Action {
    /// 自己的車現在的狀態，格式見 `STATE_LEN`
    State { d: [f64; STATE_LEN] },
    /// 跑完第 `lap` 圈；`time` 是過線時的比賽時間（毫秒，從起跑算）
    Lap { lap: u32, time: u64 },
    /// 對時：伺服器只回給送的人 `{type:"pong", t, clock}`，`t` 原封不動、`clock` 是伺服器現在的比賽時間
    /// （毫秒，起跑前是負的）。用戶端照來回時間估自己的時鐘差多少（見 `online.ts`）
    Ping { t: f64 },
    /// 撞到別人：撞人的瀏覽器算出被撞的車該拿到的速度變化 `v`（公尺／秒，[vx, vz]），
    /// 伺服器只轉給那個座位 `{type:"bump", from, v}`，由他自己套到自己的車上
    Bump { seat: usize, v: [f64; 2] },
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
    /// 起跑的時間
    go: Instant,
    /// 整局的時間上限
    limit_at: Instant,
    /// 第一個人跑完後，最晚什麼時候結算
    grace_at: Option<Instant>,
    /// 結算時的比賽時間；None 表示還在比
    ended: Option<Duration>,
    /// 這個房間累計的分數（pid → 分）
    scores: HashMap<u32, u32>,
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
        let go = ctx.now + COUNTDOWN;
        ctx.system(
            To::All,
            format!("新的一局：{}，{} 圈，起跑位置抽好了。5 秒後起跑！", options.track.name(), options.laps),
        );
        ctx.changed();
        Self {
            game: previous.map_or(1, |p| p.game + 1),
            options: options.clone(),
            racers: (0..n).map(|_| Racer::new()).collect(),
            pids: ctx.seats.iter().map(|s| s.pid).collect(),
            grid,
            go,
            limit_at: go + LAP_LIMIT * options.laps,
            grace_at: None,
            ended: None,
            scores: previous.map(|p| p.scores.clone()).unwrap_or_default(),
        }
    }

    fn act(&mut self, seat: usize, action: Action, ctx: &mut Ctx) -> Result<(), String> {
        if self.ended.is_some() {
            // 結算後還在路上的狀態不用理，也不用回錯誤
            ctx.quiet();
            return Ok(());
        }
        match action {
            Action::State { d } => {
                // 狀態只靠 tick 合併轉送，不重送 view；格式不對的直接丟掉（每秒 20 則，不要每則都回錯誤）
                ctx.quiet();
                if d.iter().any(|v| !v.is_finite() || v.abs() > MAX_VALUE) {
                    return Ok(());
                }
                let elapsed = ctx.now.saturating_duration_since(self.go).as_secs_f64();
                let r = &mut self.racers[seat];
                // 進度不能比一路用極速跑還多
                r.progress = d[PROGRESS].min((elapsed + 1.0) * MAX_SPEED);
                r.state = Some(d);
                r.fresh = true;
                Ok(())
            }
            Action::Lap { lap, time } => self.lap(seat, lap, time, ctx),
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
            Action::Bump { seat: target, v } => {
                ctx.quiet();
                // 撞自己、沒有這個座位、亂送的數字都不轉
                let ok = target != seat
                    && target < self.racers.len()
                    && v.iter().all(|x| x.is_finite())
                    && v[0].hypot(v[1]) <= MAX_BUMP;
                if ok {
                    ctx.emit(To::Seat(target), json!({ "type": "bump", "from": seat, "v": v }));
                }
                Ok(())
            }
        }
    }

    fn tick(&mut self, ctx: &mut Ctx) {
        if self.ended.is_some() {
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
                let mut row = Vec::with_capacity(STATE_LEN + 1);
                row.push(json!(seat));
                row.extend(state.iter().map(|v| json!(v)));
                Some(Value::Array(row))
            })
            .collect();
        if !cars.is_empty() {
            ctx.emit(To::All, json!({ "type": "cars", "cars": cars }));
        }
        // 有人跑完、而且連著線的人都跑完了（斷線的不等），或時間到了就結算
        let someone_done = self.racers.iter().any(|r| r.finish.is_some());
        let all_done = (0..self.racers.len()).all(|s| self.racers[s].finish.is_some() || !ctx.seats[s].online);
        if (someone_done && all_done) || ctx.now >= self.deadline() {
            self.end(ctx);
        }
    }

    fn presence(&mut self, _seat: usize, _online: bool, ctx: &mut Ctx) {
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
        (0..n).map(|i| SeatInfo { pid: i as u32 + 1, name: format!("P{i}"), bot: false, online: true }).collect()
    }

    /// 開一局，起跑時間設成 `ago` 之前（測試不用真的等）
    fn game(n: usize, laps: u32, ago: Duration) -> (Racing, Vec<SeatInfo>, Rng) {
        let seats = seats(n);
        let mut rng = Rng::new();
        let mut out = Outbox::default();
        let now = Instant::now();
        let mut game = {
            let mut ctx = test_ctx(now, &mut rng, &seats, &mut out);
            Racing::start(&Options { track: Track::City, laps }, None, &mut ctx)
        };
        game.go = now - ago;
        game.limit_at = game.go + LAP_LIMIT * laps;
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
        Action::State { d: [1000.0, 1.0, 2.0, 0.5, 3.0, 4.0, 0.1, -0.2, 3.0, progress] }
    }

    /// 把起跑時間改成 `secs` 秒前
    fn started(g: &mut Racing, secs: u64) {
        g.go = Instant::now() - Duration::from_secs(secs);
    }

    #[test]
    fn laps_must_come_in_order_and_be_possible() {
        let (mut g, seats, mut rng) = game(2, 3, Duration::from_secs(16));
        let lap = |lap, time| Action::Lap { lap, time };
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
        act(&mut g, &seats, &mut rng, 0, Action::Lap { lap: 1, time: 20_000 }).unwrap();
        let finish = g.racers[0].finish.unwrap();
        assert!((36_900..=37_100).contains(&finish), "完賽時間 {finish}");
    }

    #[test]
    fn nothing_counts_before_the_start() {
        let (mut g, seats, mut rng) = game(2, 1, Duration::ZERO);
        g.go = Instant::now() + Duration::from_secs(3);
        assert!(act(&mut g, &seats, &mut rng, 0, Action::Lap { lap: 1, time: 30_000 }).is_err());
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
        act(&mut g, &seats, &mut rng, 1, Action::State { d: bad }).unwrap();
        assert!(g.racers[1].state.is_none());
    }

    #[test]
    fn the_first_finish_starts_the_grace_and_unfinished_rank_by_progress() {
        let (mut g, seats, mut rng) = game(3, 1, Duration::from_secs(40));
        act(&mut g, &seats, &mut rng, 1, state(900.0)).unwrap();
        act(&mut g, &seats, &mut rng, 2, state(1200.0)).unwrap();
        act(&mut g, &seats, &mut rng, 0, Action::Lap { lap: 1, time: 39_000 }).unwrap();
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
        act(&mut g, &seats, &mut rng, 0, Action::Lap { lap: 1, time: 38_000 }).unwrap();
        tick(&mut g, &seats, &mut rng, Instant::now());
        assert!(g.ended.is_none());
        act(&mut g, &seats, &mut rng, 1, Action::Lap { lap: 1, time: 39_000 }).unwrap();
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
        g.act(0, Action::Bump { seat: 2, v: [3.0, -1.5] }, &mut ctx).unwrap();
        g.act(0, Action::Bump { seat: 0, v: [3.0, 0.0] }, &mut ctx).unwrap();
        g.act(0, Action::Bump { seat: 7, v: [3.0, 0.0] }, &mut ctx).unwrap();
        g.act(0, Action::Bump { seat: 1, v: [500.0, 0.0] }, &mut ctx).unwrap();
        let events = out.events();
        assert_eq!(events.len(), 1, "撞自己、沒有的座位、太大的都不轉");
        assert!(matches!(events[0].0, To::Seat(2)));
        assert_eq!(events[0].1, json!({ "type": "bump", "from": 0, "v": [3.0, -1.5] }));
    }

    #[test]
    fn only_one_three_or_five_laps() {
        assert!(Racing::check_options(Options { track: Track::Canyon, laps: 5 }).is_ok());
        assert!(Racing::check_options(Options { track: Track::Canyon, laps: 2 }).is_err());
        assert!(Racing::check_options(Options { track: Track::Canyon, laps: 0 }).is_err());
    }
}
