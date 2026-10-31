//! 俄羅斯方塊大逃殺：消行變成垃圾行送給目標。房間、選目標、KO 和名次見 arena.rs，這裡只有盤面格式和電腦玩家。

use std::{sync::Arc, time::Duration};

use tokio::time::Instant;

use crate::{
    AppState,
    arena::{self, Arenas, Rng, Rules},
};

/// 送給電腦玩家的垃圾行要等這麼久才會升上來（用戶端自己管自己的）
const GARBAGE_DELAY: Duration = Duration::from_secs(2);
const ROWS: usize = 20;
const COLS: usize = 10;

pub struct Tetris;

impl Rules for Tetris {
    /// 20 × 10，每格 `0`（空）～`8`（垃圾）
    const ROWS: usize = ROWS;
    const COLS: usize = COLS;
    const MAX_CELL: u8 = b'8';
    const MAX_ATTACK: u32 = 30;
    const PUBLIC: bool = true;
    type Bot = Bot;

    fn arenas(state: &AppState) -> &Arc<Arenas<Self>> {
        &state.tetris
    }

    fn danger(board: &str, pending: u32) -> u32 {
        let height = board.bytes().position(|b| b != b'0').map_or(0, |at| ROWS - at / COLS) as u32;
        height + pending.min(40)
    }
}

/// 沒有真的在下方塊：用機率模擬放塊、消行和被垃圾行推高
pub struct Bot {
    skill: f64,
    /// 由下往上
    rows: Vec<[u8; COLS]>,
    fill: f64,
    pending: Vec<(u32, Instant)>,
    next_move: Instant,
}

impl arena::Bot for Bot {
    fn new(skill: f64, next_move: Instant) -> Self {
        Self { skill, rows: Vec::new(), fill: 0.0, pending: Vec::new(), next_move }
    }

    fn next_move(&self) -> Instant {
        self.next_move
    }

    fn step(&mut self, level: u32, badges: u32, rng: &mut Rng, now: Instant) -> (u32, bool) {
        let level = f64::from(level);
        let pace = (1.0 - level * 0.035).max(0.45);
        self.next_move = now + Duration::from_secs_f64(rng.range(0.7, 1.3) * pace / self.skill);

        // 放一塊大約是 0.4 行，弱的堆得比較亂；等級越高越容易失誤留下洞、越來不及消行，
        // 不然只剩電腦時誰也打不死誰，一局要拖十幾分鐘（調成大約四分鐘內分出勝負）
        self.fill += 0.4 + 0.5 * (1.0 - self.skill).max(0.0) + 0.015 * (level - 1.0);
        if rng.chance(0.015 * level / self.skill) {
            self.fill += 1.0;
        }
        while self.fill >= 1.0 {
            self.fill -= 1.0;
            let mut row = [0u8; COLS];
            for cell in &mut row {
                *cell = 1 + rng.below(7) as u8;
            }
            row[rng.below(COLS)] = 0;
            self.rows.push(row);
        }

        let height = self.rows.len();
        let mut sent = 0;
        let clear = (0.08 + height as f64 / ROWS as f64 * 0.9 * self.skill).min(0.85 - 0.015 * (level - 1.0));
        if height > 0 && rng.chance(clear) {
            let roll = rng.range(0.0, 1.0);
            let lines = if height >= 4 && roll < 0.12 * self.skill {
                4
            } else if roll < 0.22 {
                3
            } else if roll < 0.5 {
                2
            } else {
                1
            }
            .min(height);
            // 偶爾當成 T-Spin 雙消
            let tspin = lines == 2 && rng.chance(0.1 * self.skill);
            sent = if tspin { 4 } else { [0, 0, 1, 2, 4][lines] };
            self.rows.truncate(height - lines);
            sent = arena::offset(&mut self.pending, arena::with_badges(sent, badges));
        } else {
            let mut budget = 8;
            while budget > 0 && self.pending.first().is_some_and(|&(_, at)| now >= at) {
                let lines = self.pending[0].0.min(budget);
                budget -= lines;
                self.pending[0].0 -= lines;
                if self.pending[0].0 == 0 {
                    self.pending.remove(0);
                }
                let hole = rng.below(COLS);
                for _ in 0..lines {
                    let mut row = [8u8; COLS];
                    row[hole] = 0;
                    self.rows.insert(0, row);
                }
            }
        }
        (sent, self.rows.len() > ROWS)
    }

    fn receive(&mut self, amount: u32, now: Instant) {
        self.pending.push((amount, now + GARBAGE_DELAY));
    }

    fn board(&self) -> String {
        let mut out = String::with_capacity(ROWS * COLS);
        for r in (0..ROWS).rev() {
            match self.rows.get(r) {
                Some(row) => out.extend(row.iter().map(|&c| char::from(b'0' + c))),
                None => out.push_str("0000000000"),
            }
        }
        out
    }

    fn danger(&self) -> u32 {
        self.rows.len() as u32 + self.pending.iter().map(|&(lines, _)| lines).sum::<u32>()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::arena::Bot as _;

    #[test]
    fn bot_board_is_drawn_bottom_up() {
        let bot = Bot {
            skill: 1.0,
            rows: vec![[8, 8, 8, 8, 8, 8, 8, 8, 8, 0]],
            fill: 0.0,
            pending: vec![(3, Instant::now())],
            next_move: Instant::now(),
        };
        let board = bot.board();
        assert_eq!(board.len(), ROWS * COLS);
        assert!(board.ends_with("8888888880"));
        assert!(board[..190].bytes().all(|b| b == b'0'));
        assert_eq!(bot.danger(), 4);
    }

    #[test]
    fn danger_is_height_plus_pending() {
        let mut board = Tetris::empty_board();
        assert_eq!(Tetris::danger(&board, 0), 0);
        board.replace_range(150..151, "8");
        assert_eq!(Tetris::danger(&board, 3), 5 + 3);
        assert_eq!(Tetris::danger(&board, 100), 5 + 40);
    }
}
