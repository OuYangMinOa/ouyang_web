//! 魔法氣泡大逃殺：連鎖變成干擾泡送給目標。房間、選目標、KO 和名次見 arena.rs，這裡只有盤面格式和電腦玩家。
//! 規則（分數、干擾泡換算、加時）照 `frontend/src/games/puyo/engine.ts`。

use std::{sync::Arc, time::Duration};

use tokio::time::Instant;

use crate::{
    AppState,
    arena::{self, Arenas, Rng, Rules},
};

/// 含最上面看不到的第 13 列
const ROWS: usize = 13;
const COLS: usize = 6;
const COLORS: usize = 4;
const NUISANCE: u8 = 5;
/// 第 3 欄疊到這麼高（看得到的 12 列全滿）就輸了
const SPAWN_COL: usize = 2;
const TOPOUT: usize = ROWS - 1;
/// 一回合最多落下幾顆干擾泡（5 列）
const NUISANCE_PER_TURN: u32 = 30;
/// 送給電腦玩家的干擾泡要等這麼久才會落下（用戶端是放完這一組才落下）
const NUISANCE_DELAY: Duration = Duration::from_millis(1500);
const CHAIN_POWER: [u32; 19] = [0, 8, 16, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 480, 512];
const TARGET_POINTS: u32 = 70;
/// 開打這麼久後進入加時，之後每一段時間換算分數變成 3/4
const MARGIN: Duration = Duration::from_secs(96);
const MARGIN_STEP: Duration = Duration::from_secs(16);

pub struct Puyo;

impl Rules for Puyo {
    /// 13 × 6（含看不到的第 13 列），每格 `0`（空）、`1`～`4`（顏色）、`5`（干擾泡）
    const ROWS: usize = ROWS;
    const COLS: usize = COLS;
    const MAX_CELL: u8 = b'0' + NUISANCE;
    /// 一次最多 50 列干擾泡
    const MAX_ATTACK: u32 = 300;
    /// 只用房間代碼或邀請連結進來
    const PUBLIC: bool = false;
    type Bot = Bot;

    fn arenas(state: &AppState) -> &Arc<Arenas<Self>> {
        &state.puyo
    }

    /// 最高的那一欄加上待落下的干擾泡列數
    fn danger(board: &str, pending: u32) -> u32 {
        let bytes = board.as_bytes();
        let height = (0..COLS)
            .map(|x| (0..ROWS).find(|&y| bytes[y * COLS + x] != b'0').map_or(0, |y| ROWS - y))
            .max()
            .unwrap_or(0) as u32;
        height + (pending / COLS as u32).min(40)
    }
}

/// 對戰開打 `elapsed` 後，幾分換一顆干擾泡
fn target_points(elapsed: Duration) -> u32 {
    if elapsed < MARGIN {
        return TARGET_POINTS;
    }
    let steps = ((elapsed - MARGIN).as_millis() / MARGIN_STEP.as_millis()) as i32 + 1;
    ((f64::from(TARGET_POINTS) * 0.75f64.powi(steps)) as u32).max(1)
}

/// `chain` 連鎖、每一連鎖剛好消 4 顆同色時送出的干擾泡
fn chain_nuisance(chain: u32, target: u32) -> u32 {
    let points: u32 = (0..chain as usize).map(|i| 40 * CHAIN_POWER[i.min(CHAIN_POWER.len() - 1)].max(1)).sum();
    points / target
}

/// 沒有真的在疊氣泡：每一手放兩顆，其中有些「有用」（之後能拿來連鎖），存夠了就引爆一串連鎖。
/// 弱的放得亂，沒用的氣泡越積越多，盤面就越來越高
pub struct Bot {
    skill: f64,
    /// 每一欄由下往上
    cols: [Vec<u8>; COLS],
    /// 可以拿來連鎖的氣泡數
    useful: u32,
    /// 這一串打算打幾連鎖
    plan: u32,
    pending: Vec<(u32, Instant)>,
    next_move: Instant,
    started: Instant,
}

impl Bot {
    fn new_plan(&self, rng: &mut Rng) -> u32 {
        ((self.skill * rng.range(2.0, 7.0)) as u32).clamp(1, 10)
    }

    fn colored(&self) -> u32 {
        self.cols.iter().flatten().filter(|&&c| c != NUISANCE).count() as u32
    }

    /// 放一顆：強的挑比較矮的欄、盡量不放出生的那欄，弱的比較隨便
    fn place(&mut self, color: u8, rng: &mut Rng) {
        let a = rng.below(COLS);
        let b = rng.below(COLS);
        let height = |x: usize| self.cols[x].len() + if x == SPAWN_COL { 3 } else { 0 };
        let x = if rng.chance(self.skill.min(0.95)) && height(b) < height(a) { b } else { a };
        if self.cols[x].len() < ROWS {
            self.cols[x].push(color);
        }
    }

    /// 從某一欄拿掉最上面一顆符合條件的，上面的掉下來
    fn pop(&mut self, rng: &mut Rng, nuisance: bool) -> bool {
        let candidates: Vec<usize> =
            (0..COLS).filter(|&x| self.cols[x].iter().any(|&c| (c == NUISANCE) == nuisance)).collect();
        if candidates.is_empty() {
            return false;
        }
        let col = &mut self.cols[candidates[rng.below(candidates.len())]];
        let at = col.iter().rposition(|&c| (c == NUISANCE) == nuisance).unwrap();
        col.remove(at);
        true
    }

    /// 落下等夠久的干擾泡，一次最多 5 列：滿 6 顆的部分每欄一顆，零頭隨機挑不同的欄
    fn drop_nuisance(&mut self, now: Instant, rng: &mut Rng) {
        let mut n = 0;
        while n < NUISANCE_PER_TURN && self.pending.first().is_some_and(|&(_, at)| now >= at) {
            let take = self.pending[0].0.min(NUISANCE_PER_TURN - n);
            n += take;
            self.pending[0].0 -= take;
            if self.pending[0].0 == 0 {
                self.pending.remove(0);
            }
        }
        let mut per_col = [n as usize / COLS; COLS];
        let mut cols: Vec<usize> = (0..COLS).collect();
        for _ in 0..n as usize % COLS {
            per_col[cols.swap_remove(rng.below(cols.len()))] += 1;
        }
        for (col, count) in self.cols.iter_mut().zip(per_col) {
            for _ in 0..count.min(ROWS - col.len()) {
                col.push(NUISANCE);
            }
        }
    }
}

impl arena::Bot for Bot {
    fn new(skill: f64, next_move: Instant) -> Self {
        Self {
            skill,
            cols: Default::default(),
            useful: 0,
            plan: ((skill * 4.5) as u32).clamp(1, 10),
            pending: Vec::new(),
            next_move,
            started: next_move,
        }
    }

    fn next_move(&self) -> Instant {
        self.next_move
    }

    fn step(&mut self, level: u32, badges: u32, rng: &mut Rng, now: Instant) -> (u32, bool) {
        let level = f64::from(level);
        let pace = (1.0 - level * 0.03).max(0.5);
        self.next_move = now + Duration::from_secs_f64(rng.range(0.8, 1.3) * pace / self.skill.min(1.0));

        // 等級越高越手忙腳亂，有用的比例越低
        let aim = (0.35 + 0.6 * self.skill - 0.015 * (level - 1.0)).clamp(0.2, 0.97);
        for _ in 0..2 {
            self.place(1 + rng.below(COLORS) as u8, rng);
            if rng.chance(aim) {
                self.useful += 1;
            }
        }
        self.useful = self.useful.min(self.colored());

        // 存夠了就引爆；快被堵住或干擾泡快落下時，有多少先打多少
        let incoming = self.pending.iter().any(|&(_, at)| at <= now + Duration::from_secs(1));
        let urgent = self.cols[SPAWN_COL].len() >= 9 || incoming;
        let mut sent = 0;
        if self.useful >= 4 * self.plan || (urgent && self.useful >= 4) {
            let chain = (self.useful / 4).min(self.plan);
            for _ in 0..4 * chain {
                self.pop(rng, false);
            }
            // 旁邊的干擾泡跟著消掉
            for _ in 0..chain * 2 {
                if !self.pop(rng, true) {
                    break;
                }
            }
            self.useful -= 4 * chain;
            let nuisance = chain_nuisance(chain, target_points(now.saturating_duration_since(self.started)));
            sent = arena::offset(&mut self.pending, arena::with_badges(nuisance, badges));
            self.plan = self.new_plan(rng);
        } else {
            self.drop_nuisance(now, rng);
        }
        (sent, self.cols[SPAWN_COL].len() >= TOPOUT)
    }

    fn receive(&mut self, amount: u32, now: Instant) {
        self.pending.push((amount, now + NUISANCE_DELAY));
    }

    fn board(&self) -> String {
        let mut out = String::with_capacity(ROWS * COLS);
        for y in (0..ROWS).rev() {
            out.extend(self.cols.iter().map(|col| char::from(b'0' + col.get(y).copied().unwrap_or(0))));
        }
        out
    }

    fn danger(&self) -> u32 {
        let height = self.cols.iter().map(Vec::len).max().unwrap_or(0) as u32;
        let pending: u32 = self.pending.iter().map(|&(n, _)| n).sum();
        height + pending / COLS as u32
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::arena::Bot as _;

    #[test]
    fn nuisance_follows_the_client_formula() {
        // 1 連鎖 40 分、2 連鎖再 320 分…（engine.ts 的 chainScore）
        assert_eq!(chain_nuisance(1, 70), 0);
        assert_eq!(chain_nuisance(2, 70), 360 / 70);
        assert_eq!(chain_nuisance(5, 70), (40 + 320 + 640 + 1280 + 2560) / 70);
        assert_eq!(target_points(Duration::from_secs(95)), 70);
        assert_eq!(target_points(Duration::from_secs(96)), 52);
        assert_eq!(target_points(Duration::from_secs(112)), 39);
        assert_eq!(target_points(Duration::from_secs(10_000)), 1);
    }

    #[test]
    fn board_is_drawn_top_down() {
        let mut bot = Bot::new(1.0, Instant::now());
        bot.cols[0] = vec![1, 5];
        bot.cols[5] = vec![4];
        let board = bot.board();
        assert_eq!(board.len(), ROWS * COLS);
        assert!(board.ends_with("100004"));
        assert_eq!(&board[board.len() - 12..board.len() - 6], "500000");
        assert_eq!(Puyo::danger(&board, 13), 2 + 2);
        assert_eq!(bot.danger(), 2);
    }

    #[test]
    fn nuisance_lands_after_the_delay_at_most_five_rows() {
        let now = Instant::now();
        let mut rng = Rng::new();
        let mut bot = Bot::new(1.0, now);
        bot.receive(40, now);
        bot.drop_nuisance(now, &mut rng);
        assert!(bot.cols.iter().all(Vec::is_empty));
        bot.drop_nuisance(now + NUISANCE_DELAY, &mut rng);
        assert_eq!(bot.cols.iter().map(Vec::len).sum::<usize>(), 30);
        assert!(bot.cols.iter().all(|c| c.len() == 5));
        assert_eq!(bot.pending, vec![(10, now + NUISANCE_DELAY)]);
    }
}
