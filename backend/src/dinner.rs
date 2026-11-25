//! 吃哪家（派對房間，房間本身見 `party.rs`）：一群人決定今天吃哪一家米其林，餐廳資料在 `michelin.rs`。
//!
//! 流程：
//! 1. 提名：每個人從米其林地圖的餐廳裡挑最多 N 家（房主在大廳選 1～5，預設 2），同一家只算一次。
//!    挑好按「好了」（一家都不挑也可以，表示都可以）。所有在線的人都好了、至少有一家就到下一步；只有一家就直接是它。
//! 2. 投票（`vote` 模式）：每個人勾「可以接受」的店，要勾幾家都可以（贊成投票），所有人投完之前都還能改。
//!    投完之前看不到別人勾了哪些，只看得到誰投好了。所有在線的人都投好了就開票：票最多的那家；同票的抽籤。
//!    抽籤模式（`draw`）不投票：提名完直接從所有候選裡抽一家。
//! 3. 結果：每家的票數和投給它的人；有抽籤時用戶端播轉盤動畫（`result.spin` 是轉盤上的候選）。
//!
//! 不會卡住：
//! - 「所有人」只算在線的座位，斷線的人不用等；他重新連上時如果還沒好，就要等他。
//! - 有人一直不按：已經好了的人在一半以上（含）都好了的時候可以按「不等了」直接往下。
//! - 遊戲不知道誰是房主；房主隨時可以用房間的「中止這局」。沒有電腦玩家，也沒有隱藏到結束都不公開的資訊。

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::time::Instant;

use crate::{
    AppState, michelin,
    party::{Ctx, Parties, PartyGame},
};

pub const MAX_PER_PLAYER: u8 = 5;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Vote,
    Draw,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Options {
    /// 每個人最多提名幾家
    pub per_player: u8,
    pub mode: Mode,
}

impl Default for Options {
    fn default() -> Self {
        Self { per_player: 2, mode: Mode::Vote }
    }
}

#[derive(Deserialize, Debug)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Action {
    /// 提名一家（米其林資料的 id）
    Nominate { id: String },
    /// 收回自己提名的
    Withdraw { id: String },
    /// 提名好了（false 是還要再挑）
    Ready { ready: bool },
    /// 投票：可以接受的候選（`candidates` 的索引），至少一家
    Vote { picks: Vec<usize> },
    /// 一半以上的人都好了：不等其他人，直接往下
    Proceed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Stage {
    Nominate,
    Vote,
    Result,
}

#[derive(Clone, Debug)]
struct Candidate {
    id: String,
    by: usize,
}

#[derive(Clone, Debug)]
struct Outcome {
    winner: usize,
    /// 每個候選拿到哪些座位的票（抽籤模式是空的）
    votes: Vec<Vec<usize>>,
    /// 轉盤上的候選：同票的那幾家，或抽籤模式的全部；不用抽籤是空的
    spin: Vec<usize>,
}

pub struct Dinner {
    options: Options,
    names: Vec<String>,
    online: Vec<bool>,
    stage: Stage,
    candidates: Vec<Candidate>,
    /// 提名階段按了「好了」
    ready: Vec<bool>,
    /// 投票：勾了哪些候選；None 是還沒投
    ballots: Vec<Option<Vec<usize>>>,
    outcome: Option<Outcome>,
}

impl Dinner {
    fn waiting_on(&self) -> (usize, usize) {
        let done = |seat: usize| match self.stage {
            Stage::Nominate => self.ready[seat],
            Stage::Vote => self.ballots[seat].is_some(),
            Stage::Result => true,
        };
        let online: Vec<usize> = (0..self.names.len()).filter(|&s| self.online[s]).collect();
        (online.iter().filter(|&&s| done(s)).count(), online.len())
    }

    /// 所有在線的人都好了就往下（沒人在線時停著等）
    fn advance_if_everyone(&mut self, ctx: &mut Ctx) {
        let (done, online) = self.waiting_on();
        if online > 0 && done == online {
            self.advance(ctx);
        }
    }

    fn advance(&mut self, ctx: &mut Ctx) {
        match self.stage {
            Stage::Nominate => {
                if self.candidates.is_empty() {
                    // 大家都沒提名：回去等人提名
                    self.ready.iter_mut().for_each(|r| *r = false);
                    ctx.announce(crate::party::To::All, "還沒有人提名，至少要有一家才能往下", "danger");
                    ctx.changed();
                    return;
                }
                if self.candidates.len() == 1 {
                    self.finish(Outcome { winner: 0, votes: vec![Vec::new()], spin: Vec::new() }, ctx);
                } else if self.options.mode == Mode::Draw {
                    let winner = ctx.rng.below(self.candidates.len());
                    let spin = (0..self.candidates.len()).collect();
                    self.finish(Outcome { winner, votes: vec![Vec::new(); self.candidates.len()], spin }, ctx);
                } else {
                    self.stage = Stage::Vote;
                    ctx.changed();
                }
            }
            Stage::Vote => {
                let mut votes = vec![Vec::new(); self.candidates.len()];
                for (seat, ballot) in self.ballots.iter().enumerate() {
                    for &pick in ballot.iter().flatten() {
                        votes[pick].push(seat);
                    }
                }
                let top = votes.iter().map(Vec::len).max().unwrap_or(0);
                let tied: Vec<usize> = (0..votes.len()).filter(|&i| votes[i].len() == top).collect();
                let winner = tied[ctx.rng.below(tied.len())];
                let spin = if tied.len() > 1 { tied } else { Vec::new() };
                self.finish(Outcome { winner, votes, spin }, ctx);
            }
            Stage::Result => {}
        }
    }

    fn finish(&mut self, outcome: Outcome, ctx: &mut Ctx) {
        let name = michelin::find(&self.candidates[outcome.winner].id).map_or("?", |r| r.name.as_str());
        let how = if outcome.spin.is_empty() { "" } else { "（抽籤）" };
        ctx.announce(crate::party::To::All, format!("就吃「{name}」{how}！"), "ok");
        self.outcome = Some(outcome);
        self.stage = Stage::Result;
        ctx.changed();
    }
}

impl PartyGame for Dinner {
    const ID: &'static str = "dinner";
    const MIN_PLAYERS: usize = 2;
    const MAX_PLAYERS: usize = 10;

    type Options = Options;
    type Action = Action;

    fn rooms(state: &AppState) -> &Arc<Parties<Self>> {
        &state.dinner
    }

    fn check_options(mut options: Options) -> Result<Options, String> {
        options.per_player = options.per_player.clamp(1, MAX_PER_PLAYER);
        Ok(options)
    }

    fn start(options: &Options, _previous: Option<&Self>, ctx: &mut Ctx) -> Self {
        let n = ctx.seats.len();
        Self {
            options: options.clone(),
            names: ctx.seats.iter().map(|s| s.name.clone()).collect(),
            online: ctx.seats.iter().map(|s| s.online).collect(),
            stage: Stage::Nominate,
            candidates: Vec::new(),
            ready: vec![false; n],
            ballots: vec![None; n],
            outcome: None,
        }
    }

    fn act(&mut self, seat: usize, action: Action, ctx: &mut Ctx) -> Result<(), String> {
        match (self.stage, action) {
            (Stage::Nominate, Action::Nominate { id }) => {
                let restaurant = michelin::find(&id).ok_or("沒有這家餐廳")?;
                if let Some(c) = self.candidates.iter().find(|c| c.id == id) {
                    return Err(format!("「{}」{}已經提名了", restaurant.name, self.names[c.by]));
                }
                let mine = self.candidates.iter().filter(|c| c.by == seat).count();
                if mine >= usize::from(self.options.per_player) {
                    return Err(format!("每個人最多提名 {} 家，先收回一家再換", self.options.per_player));
                }
                self.candidates.push(Candidate { id, by: seat });
            }
            (Stage::Nominate, Action::Withdraw { id }) => {
                let at = self.candidates.iter().position(|c| c.id == id && c.by == seat).ok_or("那家不是你提名的")?;
                self.candidates.remove(at);
            }
            (Stage::Nominate, Action::Ready { ready }) => self.ready[seat] = ready,
            (Stage::Vote, Action::Vote { mut picks }) => {
                picks.sort_unstable();
                picks.dedup();
                if picks.is_empty() {
                    return Err("至少勾一家（都可以就全部勾）".into());
                }
                if picks.iter().any(|&p| p >= self.candidates.len()) {
                    return Err("沒有這個候選".into());
                }
                self.ballots[seat] = Some(picks);
            }
            (Stage::Nominate | Stage::Vote, Action::Proceed) => {
                let (done, online) = self.waiting_on();
                let me_done = match self.stage {
                    Stage::Nominate => self.ready[seat],
                    _ => self.ballots[seat].is_some(),
                };
                if !me_done {
                    return Err("你自己還沒好".into());
                }
                if done * 2 < online {
                    return Err("一半以上的人好了才能不等".into());
                }
                self.advance(ctx);
                return Ok(());
            }
            (Stage::Result, _) => return Err("已經決定了".into()),
            _ => return Err("現在不能這樣做".into()),
        }
        ctx.changed();
        self.advance_if_everyone(ctx);
        Ok(())
    }

    fn presence(&mut self, seat: usize, online: bool, ctx: &mut Ctx) {
        self.online[seat] = online;
        ctx.changed();
        // 斷線的人不用等
        if !online {
            self.advance_if_everyone(ctx);
        }
    }

    fn view(&self, seat: Option<usize>, _now: Instant) -> Value {
        let seats: Vec<Value> = (0..self.names.len())
            .map(|s| {
                let done = match self.stage {
                    Stage::Nominate => self.ready[s],
                    Stage::Vote => self.ballots[s].is_some(),
                    Stage::Result => true,
                };
                json!({ "name": self.names[s], "online": self.online[s], "done": done })
            })
            .collect();
        let candidates: Vec<Value> = self.candidates.iter().map(|c| json!({ "id": c.id, "by": c.by })).collect();
        let (done, online) = self.waiting_on();
        let result = self.outcome.as_ref().map(|o| json!({ "winner": o.winner, "votes": o.votes, "spin": o.spin }));
        json!({
            "stage": match self.stage { Stage::Nominate => "nominate", Stage::Vote => "vote", Stage::Result => "result" },
            "mode": self.options.mode,
            "perPlayer": self.options.per_player,
            "you": seat,
            "seats": seats,
            "candidates": candidates,
            "done": done,
            "online": online,
            "ballot": seat.and_then(|s| self.ballots.get(s).cloned().flatten()),
            "result": result,
        })
    }

    fn finished(&self) -> bool {
        self.stage == Stage::Result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::party::{Outbox, Rng, SeatInfo, test_ctx};

    fn seats(n: usize) -> Vec<SeatInfo> {
        (0..n).map(|i| SeatInfo { pid: i as u32 + 1, name: format!("P{i}"), bot: false, online: true }).collect()
    }

    struct Table {
        game: Dinner,
        seats: Vec<SeatInfo>,
        rng: Rng,
    }

    impl Table {
        fn new(n: usize, options: Options) -> Self {
            let seats = seats(n);
            let mut rng = Rng::new();
            let mut out = Outbox::default();
            let game = Dinner::start(&options, None, &mut test_ctx(Instant::now(), &mut rng, &seats, &mut out));
            Self { game, seats, rng }
        }

        fn act(&mut self, seat: usize, action: Action) -> Result<(), String> {
            let mut out = Outbox::default();
            self.game.act(seat, action, &mut test_ctx(Instant::now(), &mut self.rng, &self.seats, &mut out))
        }

        fn presence(&mut self, seat: usize, online: bool) {
            let mut out = Outbox::default();
            self.game.presence(seat, online, &mut test_ctx(Instant::now(), &mut self.rng, &self.seats, &mut out));
        }

        fn nominate(&mut self, seat: usize, id: &str) {
            self.act(seat, Action::Nominate { id: id.into() }).unwrap();
        }

        fn ready(&mut self, seat: usize) {
            self.act(seat, Action::Ready { ready: true }).unwrap();
        }

        fn view(&self, seat: usize) -> Value {
            self.game.view(Some(seat), Instant::now())
        }
    }

    #[test]
    fn nominations_are_checked() {
        let mut t = Table::new(3, Options { per_player: 2, mode: Mode::Vote });
        assert!(t.act(0, Action::Nominate { id: "no-such-place".into() }).is_err());
        t.nominate(0, "le-palais");
        assert!(t.act(1, Action::Nominate { id: "le-palais".into() }).unwrap_err().contains("P0"));
        t.nominate(0, "tairroir");
        assert!(t.act(0, Action::Nominate { id: "ya-ge".into() }).unwrap_err().contains("最多"));
        // 別人提名的收不回來，自己的可以
        assert!(t.act(1, Action::Withdraw { id: "tairroir".into() }).is_err());
        t.act(0, Action::Withdraw { id: "tairroir".into() }).unwrap();
        t.nominate(0, "ya-ge");
        assert_eq!(t.view(1)["candidates"], json!([{ "id": "le-palais", "by": 0 }, { "id": "ya-ge", "by": 0 }]));
        // 投票階段才能投
        assert!(t.act(1, Action::Vote { picks: vec![0] }).is_err());
    }

    #[test]
    fn approval_vote_picks_the_most_accepted() {
        let mut t = Table::new(3, Options::default());
        t.nominate(0, "le-palais");
        t.nominate(1, "tairroir");
        t.nominate(2, "ya-ge");
        for s in 0..3 {
            t.ready(s);
        }
        assert_eq!(t.view(0)["stage"], "vote");
        t.act(0, Action::Vote { picks: vec![0, 1] }).unwrap();
        t.act(1, Action::Vote { picks: vec![1] }).unwrap();
        // 投完之前只看得到自己的票和誰投好了
        assert_eq!(t.view(0)["ballot"], json!([0, 1]));
        assert_eq!(t.view(2)["ballot"], Value::Null);
        assert_eq!(t.view(2)["result"], Value::Null);
        assert_eq!(t.view(2)["done"], 2);
        assert!(t.act(2, Action::Vote { picks: vec![] }).is_err());
        assert!(t.act(2, Action::Vote { picks: vec![7] }).is_err());
        // 還沒開票前可以改
        t.act(0, Action::Vote { picks: vec![1, 2, 2] }).unwrap();
        t.act(2, Action::Vote { picks: vec![2, 1] }).unwrap();
        assert!(t.game.finished());
        let result = &t.view(0)["result"];
        assert_eq!(result["winner"], 1, "{result}");
        assert_eq!(result["votes"], json!([[], [0, 1, 2], [0, 2]]));
        assert_eq!(result["spin"], json!([]));
        assert!(t.act(0, Action::Vote { picks: vec![0] }).is_err());
    }

    #[test]
    fn ties_are_drawn_among_the_tied() {
        for _ in 0..20 {
            let mut t = Table::new(2, Options::default());
            t.nominate(0, "le-palais");
            t.nominate(1, "tairroir");
            t.nominate(1, "ya-ge");
            t.ready(0);
            t.ready(1);
            t.act(0, Action::Vote { picks: vec![0] }).unwrap();
            t.act(1, Action::Vote { picks: vec![2] }).unwrap();
            let result = &t.view(0)["result"];
            assert_eq!(result["spin"], json!([0, 2]));
            assert!(result["winner"] == 0 || result["winner"] == 2, "{result}");
        }
    }

    #[test]
    fn draw_mode_skips_voting_and_one_candidate_wins_outright() {
        let mut t = Table::new(2, Options { per_player: 3, mode: Mode::Draw });
        t.nominate(0, "le-palais");
        t.nominate(0, "tairroir");
        t.nominate(1, "ya-ge");
        t.ready(0);
        t.ready(1);
        let result = &t.view(1)["result"];
        assert_eq!(result["spin"], json!([0, 1, 2]));
        assert!(result["winner"].as_u64().unwrap() < 3);

        let mut t = Table::new(2, Options::default());
        t.nominate(1, "ya-ge");
        t.ready(0);
        t.ready(1);
        assert_eq!(t.view(0)["result"], json!({ "winner": 0, "votes": [[]], "spin": [] }));
    }

    #[test]
    fn nobody_waits_forever() {
        // 沒人提名：大家都按好了也不會往下，「好了」被清掉
        let mut t = Table::new(2, Options::default());
        t.ready(0);
        t.ready(1);
        assert_eq!(t.view(0)["stage"], "nominate");
        assert_eq!(t.view(0)["done"], 0);

        // 斷線的人不用等
        let mut t = Table::new(3, Options::default());
        t.nominate(0, "le-palais");
        t.nominate(1, "tairroir");
        t.ready(0);
        t.ready(1);
        assert_eq!(t.view(0)["stage"], "nominate");
        t.presence(2, false);
        assert_eq!(t.view(0)["stage"], "vote");

        // 一直不按的人：一半以上好了就能不等，自己還沒好不能按
        let mut t = Table::new(4, Options::default());
        t.nominate(0, "le-palais");
        t.nominate(1, "tairroir");
        t.ready(0);
        assert!(t.act(0, Action::Proceed).unwrap_err().contains("一半"));
        assert!(t.act(2, Action::Proceed).unwrap_err().contains("還沒好"));
        t.ready(1);
        t.act(1, Action::Proceed).unwrap();
        assert_eq!(t.view(0)["stage"], "vote");
        t.act(3, Action::Vote { picks: vec![0] }).unwrap();
        t.act(2, Action::Vote { picks: vec![0, 1] }).unwrap();
        t.act(2, Action::Proceed).unwrap();
        assert_eq!(t.view(0)["result"]["winner"], 0);
    }

    #[test]
    fn options_are_clamped() {
        let fixed = Dinner::check_options(Options { per_player: 0, mode: Mode::Draw }).unwrap();
        assert_eq!(fixed.per_player, 1);
        assert_eq!(Dinner::check_options(Options { per_player: 9, mode: Mode::Vote }).unwrap().per_player, 5);
        let parsed: Options = serde_json::from_value(json!({ "perPlayer": 3, "mode": "draw" })).unwrap();
        assert_eq!(parsed, Options { per_player: 3, mode: Mode::Draw });
    }
}
