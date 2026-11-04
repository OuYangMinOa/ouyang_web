//! 古董局中局（派對房間，房間本身見 `party.rs`）。
//!
//! 改編自馬伯庸小說的同名桌遊：6～8 人分成許愿陣營和老朝奉陣營，三個回合鑑定十二生肖獸首。
//! 只做基本的 8 個角色（依人數取前幾個：6 人沒有鄭國渠和姬雲浮，7 人沒有姬雲浮）：
//!
//! | 角色 | 陣營 | 能力 |
//! |---|---|---|
//! | 許愿 | 好 | 每回合鑑定 2 件，會被老朝奉調換 |
//! | 方震 | 好 | 不鑑寶，每回合查驗一個人的陣營（不能重複查同一人）；方震被偷襲時許愿也一起被偷襲 |
//! | 黃煙煙、木戶加奈 | 好 | 每回合鑑定 1 件，各有一個隨機回合看不出真假；會被老朝奉調換 |
//! | 老朝奉 | 壞 | 鑑定 1 件；每回合可以讓「在他之後」鑑定的許愿、黃煙煙、木戶加奈看到相反的結果 |
//! | 藥不然 | 壞 | 鑑定 1 件；每回合偷襲一人，對方下一次行動不能鑑定也不能用技能 |
//! | 鄭國渠 | 壞 | 鑑定 1 件；每回合封鎖一件本回合的獸首，之後鑑定它的人都看不出真假 |
//! | 姬雲浮 | 好 | 鑑定 1 件，不受老朝奉影響；被偷襲一次就永遠不能鑑定 |
//!
//! 老朝奉和藥不然互相認識，鄭國渠不和隊友相認。
//!
//! 流程：
//! 1. 看身分。
//! 2. 每回合 4 件獸首（2 真 2 假）。第一回合隨機一個人先行動，之後由上一回合最後行動的人開始。
//!    輪到的人依序：鑑定（方震是查驗人）→ 用技能 → 指定一位這回合還沒行動的人接下去。
//! 3. 所有人行動完就討論。線上模式在聊天室打字、有倒數；線下模式大家當面說，都按「可以投票了」才往下。
//! 4. 投票：每人每回合拿到 2 枚籌碼，可以留到之後的回合，最後一回合要全部投出。
//!    得票第一的獸首入選但不公開真假，第二名入選並公開真假（同票照十二生肖的順序）。
//! 5. 三回合後鑑人：許愿陣營指認老朝奉，老朝奉指認許愿，藥不然指認方震（鄭國渠不投）。
//! 6. 計分（許愿陣營）：入選的真品每件 1 分；許愿陣營過半數投中同一個人而且他是老朝奉 +1；
//!    許愿沒被老朝奉指認 +2；方震沒被藥不然指認 +1。6 分以上許愿陣營贏，否則老朝奉陣營贏。
//!    六件入選的全是真品就直接贏，不用鑑人。
//!
//! 電腦玩家：好人照實說出自己看到的結果，壞人反著說；投籌碼時相信自己看到的、再參考別人的說法；
//! 鑑人時好人找「說法和公開的真假對不上」的人，老朝奉找每回合都報兩件的人（像許愿），藥不然找從來不報獸首的人（像方震）。
//! 真人在聊天室打「鼠首是真的」「牛 假」這類句子，電腦也會記下來參考。

use std::{cmp::Reverse, collections::HashMap, sync::Arc, time::Duration};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::time::Instant;

use crate::{
    AppState,
    party::{Chat, Ctx, Parties, PartyGame, To, shuffle},
};

const PEEK: Duration = Duration::from_secs(20);
const VOTE: Duration = Duration::from_secs(60);
const REVEAL: Duration = Duration::from_secs(10);
const IDENT: Duration = Duration::from_secs(90);
/// 輪到斷線的人行動時，最多等這麼久就自動交給下一個人
const OFFLINE_WAIT: Duration = Duration::from_secs(10);

pub const ROUNDS: usize = 3;
pub const PER_ROUND: usize = 4;
const CHIPS_PER_ROUND: u32 = 2;
const WIN_SCORE: usize = 6;

pub const ZODIAC: [&str; 12] = ["鼠", "牛", "虎", "兔", "龍", "蛇", "馬", "羊", "猴", "雞", "狗", "豬"];

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Options {
    /// 線下模式：大家當面討論，網站只負責鑑定、技能和投票；討論沒有倒數
    pub offline: bool,
    /// 每個人行動的秒數，0 表示不限時
    pub turn_secs: u16,
    /// 線上模式的討論秒數
    pub discuss_secs: u16,
}

impl Default for Options {
    fn default() -> Self {
        Self { offline: false, turn_secs: 60, discuss_secs: 180 }
    }
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum Role {
    XuYuan,
    FangZhen,
    HuangYanyan,
    KidoKana,
    LaoChaofeng,
    YaoBuran,
    ZhengGuoqu,
    JiYunfu,
}

/// 依人數取前幾個
const ROLES: [Role; 8] = [
    Role::XuYuan,
    Role::FangZhen,
    Role::HuangYanyan,
    Role::KidoKana,
    Role::LaoChaofeng,
    Role::YaoBuran,
    Role::ZhengGuoqu,
    Role::JiYunfu,
];

impl Role {
    fn label(self) -> &'static str {
        match self {
            Role::XuYuan => "許愿",
            Role::FangZhen => "方震",
            Role::HuangYanyan => "黃煙煙",
            Role::KidoKana => "木戶加奈",
            Role::LaoChaofeng => "老朝奉",
            Role::YaoBuran => "藥不然",
            Role::ZhengGuoqu => "鄭國渠",
            Role::JiYunfu => "姬雲浮",
        }
    }

    fn good(self) -> bool {
        !matches!(self, Role::LaoChaofeng | Role::YaoBuran | Role::ZhengGuoqu)
    }

    /// 鑑定時會被老朝奉調換真假
    fn swappable(self) -> bool {
        matches!(self, Role::XuYuan | Role::HuangYanyan | Role::KidoKana)
    }

    fn has_skill(self) -> bool {
        matches!(self, Role::LaoChaofeng | Role::YaoBuran | Role::ZhengGuoqu)
    }

    /// 鑑人階段要找誰；鄭國渠不投
    fn goal(self) -> Option<Role> {
        match self {
            Role::LaoChaofeng => Some(Role::XuYuan),
            Role::YaoBuran => Some(Role::FangZhen),
            Role::ZhengGuoqu => None,
            _ => Some(Role::LaoChaofeng),
        }
    }
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    Good,
    Bad,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Action {
    /// 看身分時「記住了」、討論時「可以投票了」、公布結果時「下一步」
    Ready,
    /// 鑑定本回合第 `slot` 件獸首
    Identify { slot: usize },
    /// 方震查驗一個人
    Check { seat: usize },
    /// 老朝奉：這回合要不要調換
    Swap { on: bool },
    /// 藥不然：偷襲一個人
    Ambush { seat: usize },
    /// 鄭國渠：封鎖本回合第 `slot` 件
    Block { slot: usize },
    /// 這回合不用技能
    Skip,
    /// 交給下一個人；所有人都行動過了就是 None
    Pass {
        #[serde(default)]
        seat: Option<usize>,
    },
    /// 本回合 4 件獸首各投幾枚籌碼
    Chips { alloc: [u32; PER_ROUND] },
    /// 鑑人
    Accuse { seat: usize },
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Stage {
    Peek,
    Act,
    Discuss,
    Vote,
    Reveal,
    Ident,
    End,
}

impl Stage {
    fn name(self) -> &'static str {
        match self {
            Stage::Peek => "peek",
            Stage::Act => "act",
            Stage::Discuss => "discuss",
            Stage::Vote => "vote",
            Stage::Reveal => "reveal",
            Stage::Ident => "ident",
            Stage::End => "end",
        }
    }
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
enum Step {
    Identify,
    Skill,
    Pass,
}

#[derive(Clone, Debug, PartialEq)]
struct Turn {
    seat: usize,
    step: Step,
    /// 還能鑑定幾件（方震是查驗幾人）
    left: usize,
    /// 這次行動被偷襲（或姬雲浮已經不能鑑定）：不能鑑定、不能用技能
    ambushed: bool,
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
enum Outcome {
    Genuine,
    Fake,
    /// 黃煙煙、木戶加奈失去能力的那一回合
    Sealed,
    /// 被鄭國渠封鎖
    Blocked,
    /// 方震查驗的結果
    Good,
    Bad,
    /// 被偷襲，這次不能鑑定
    Ambushed,
    /// 姬雲浮被偷襲過，之後都不能鑑定
    Crippled,
}

/// 一次鑑定或查驗；只有本人看得到
#[derive(Clone, Debug)]
struct Record {
    round: usize,
    slot: Option<usize>,
    seat: Option<usize>,
    outcome: Outcome,
    /// 看到的結果被老朝奉調換過（本人不知道，結束後才公開）
    swapped: bool,
}

impl Record {
    fn json(&self, ended: bool) -> Value {
        json!({
            "round": self.round,
            "slot": self.slot,
            "seat": self.seat,
            "outcome": self.outcome,
            "swapped": ended && self.swapped,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Skill {
    Swap(bool),
    Ambush(usize),
    Block(usize),
}

#[derive(Clone, Debug)]
struct SkillUse {
    round: usize,
    seat: usize,
    skill: Skill,
}

impl SkillUse {
    fn json(&self) -> Value {
        let (kind, target, slot, on) = match self.skill {
            Skill::Swap(on) => ("swap", None, None, Some(on)),
            Skill::Ambush(t) => ("ambush", Some(t), None, None),
            Skill::Block(s) => ("block", None, Some(s), None),
        };
        json!({ "round": self.round, "seat": self.seat, "kind": kind, "target": target, "slot": slot, "on": on })
    }
}

/// 有人公開說某件獸首是真是假（電腦說的，或從真人的聊天裡認出來的）；給電腦判斷用
#[derive(Clone, Debug, PartialEq)]
struct Claim {
    round: usize,
    seat: usize,
    slot: usize,
    genuine: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct RoundResult {
    round: usize,
    votes: [u32; PER_ROUND],
    /// 每個人這回合怎麼投（沒投是 null），開票後公開
    allocs: Vec<Option<[u32; PER_ROUND]>>,
    first: usize,
    second: usize,
    second_genuine: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct Final {
    /// 入選的真品件數
    genuine: usize,
    /// 六件全是真品，直接獲勝（沒有鑑人）
    direct: bool,
    /// 許愿陣營投給每個座位的票數
    boss_votes: Vec<usize>,
    boss_required: usize,
    boss_target: Option<usize>,
    boss_found: bool,
    xu_found: bool,
    fang_found: bool,
    score: usize,
    winner: Side,
}

pub struct Antique {
    options: Options,
    pids: Vec<u32>,
    names: Vec<String>,
    bots: Vec<bool>,
    online: Vec<bool>,
    roles: Vec<Role>,
    /// 12 個位置各是哪個生肖，第 r 回合是 `r*4..r*4+4`（每回合照生肖順序排）
    heads: [usize; 12],
    genuine: [bool; 12],
    huang_fail: usize,
    kido_fail: usize,
    /// 0 起算
    round: usize,
    stage: Stage,
    deadline: Option<Instant>,
    stage_started: Instant,
    turn: Option<Turn>,
    /// 每回合的行動順序
    order: Vec<Vec<usize>>,
    /// 老朝奉在這回合發動了調換
    swap: [bool; ROUNDS],
    /// 被封鎖的位置
    blocked: Vec<usize>,
    /// 每個人還有幾次偷襲沒生效
    ambush: Vec<u32>,
    /// 姬雲浮被偷襲過了
    crippled: bool,
    /// 方震查驗過的人
    checked: Vec<usize>,
    records: Vec<Vec<Record>>,
    skills: Vec<SkillUse>,
    claims: Vec<Claim>,
    ready: Vec<bool>,
    chips: Vec<u32>,
    alloc: Vec<Option<[u32; PER_ROUND]>>,
    results: Vec<RoundResult>,
    accuse: Vec<Option<usize>>,
    outcome: Option<Final>,
    /// 累計分數（pid → 分）
    scores: HashMap<u32, u32>,
    /// 每個電腦下一次出手的時間
    bot_at: Vec<Option<Instant>>,
}

fn head_label(zodiac: usize) -> String {
    format!("{}首", ZODIAC[zodiac])
}

impl Antique {
    fn n(&self) -> usize {
        self.roles.len()
    }

    fn seat_of(&self, role: Role) -> Option<usize> {
        self.roles.iter().position(|&r| r == role)
    }

    fn pos(&self, slot: usize) -> usize {
        self.round * PER_ROUND + slot
    }

    fn head_name(&self, pos: usize) -> String {
        head_label(self.heads[pos])
    }

    /// 這回合還沒行動的人
    fn remaining(&self) -> Vec<usize> {
        (0..self.n()).filter(|s| !self.order[self.round].contains(s)).collect()
    }

    fn is_last_round(&self) -> bool {
        self.round + 1 == ROUNDS
    }

    /// 已知的隊友不能指認（也不能指認自己）
    fn forbidden(&self, seat: usize) -> Vec<usize> {
        let mut out = vec![seat];
        let partner = match self.roles[seat] {
            Role::LaoChaofeng => self.seat_of(Role::YaoBuran),
            Role::YaoBuran => self.seat_of(Role::LaoChaofeng),
            _ => None,
        };
        out.extend(partner);
        out
    }

    /// 看得到這個座位身分的人：老朝奉和藥不然互相認識
    fn knows_role(&self, viewer: usize, seat: usize) -> bool {
        viewer == seat
            || matches!(
                (self.roles[viewer], self.roles[seat]),
                (Role::LaoChaofeng, Role::YaoBuran) | (Role::YaoBuran, Role::LaoChaofeng)
            )
    }

    fn set_stage(&mut self, stage: Stage, length: Option<Duration>, ctx: &mut Ctx) {
        self.stage = stage;
        self.stage_started = ctx.now;
        self.deadline = length.map(|d| ctx.now + d);
        self.ready.fill(false);
        self.schedule_bots(ctx);
        ctx.changed();
    }

    /// 排好每個電腦什麼時候出手（換階段、輪到下一步時呼叫）
    fn schedule_bots(&mut self, ctx: &mut Ctx) {
        for seat in 0..self.n() {
            self.bot_at[seat] = None;
            if !self.bots[seat] {
                continue;
            }
            let delay = match self.stage {
                Stage::Peek | Stage::Reveal => Some(ctx.rng.range(0.5, 2.0)),
                Stage::Act if self.turn.as_ref().is_some_and(|t| t.seat == seat) => Some(ctx.rng.range(1.0, 2.5)),
                Stage::Discuss => Some(ctx.rng.range(2.0, 8.0)),
                Stage::Vote | Stage::Ident => Some(ctx.rng.range(3.0, 10.0)),
                _ => None,
            };
            self.bot_at[seat] = delay.map(|d| ctx.now + Duration::from_secs_f64(d));
        }
    }

    fn turn_length(&self) -> Option<Duration> {
        (self.options.turn_secs > 0).then(|| Duration::from_secs(u64::from(self.options.turn_secs)))
    }

    fn begin_round(&mut self, first: usize, ctx: &mut Ctx) {
        let base = self.round * PER_ROUND;
        let names: Vec<String> = (base..base + PER_ROUND).map(|p| self.head_name(p)).collect();
        ctx.system(
            To::All,
            format!("第 {} 回合：{}，由 {} 先行動", self.round + 1, names.join("、"), self.names[first]),
        );
        self.start_turn(first, ctx);
    }

    fn start_turn(&mut self, seat: usize, ctx: &mut Ctx) {
        self.order[self.round].push(seat);
        let role = self.roles[seat];
        let mut turn =
            Turn { seat, step: Step::Identify, left: if role == Role::XuYuan { 2 } else { 1 }, ambushed: false };
        let blocked = if role == Role::JiYunfu && self.crippled {
            Some(Outcome::Crippled)
        } else if self.ambush[seat] > 0 {
            self.ambush[seat] -= 1;
            Some(Outcome::Ambushed)
        } else {
            None
        };
        if let Some(outcome) = blocked {
            self.records[seat].push(Record { round: self.round, slot: None, seat: None, outcome, swapped: false });
            turn = Turn { seat, step: Step::Pass, left: 0, ambushed: true };
        }
        self.turn = Some(turn);
        self.set_stage(Stage::Act, self.turn_length(), ctx);
    }

    /// 鑑定或查驗完：有技能就用技能，否則交給下一個人
    fn after_identify(&mut self, ctx: &mut Ctx) {
        let Some(turn) = self.turn.as_mut() else { return };
        if turn.left == 0 {
            turn.step = if self.roles[turn.seat].has_skill() { Step::Skill } else { Step::Pass };
        }
        self.schedule_bots(ctx);
        ctx.changed();
    }

    fn identify(&mut self, seat: usize, slot: usize, ctx: &mut Ctx) -> Result<(), String> {
        let role = self.roles[seat];
        if role == Role::FangZhen {
            return Err("方震查驗的是人，請選一位玩家".into());
        }
        if slot >= PER_ROUND {
            return Err("沒有這件獸首".into());
        }
        if self.records[seat].iter().any(|r| r.round == self.round && r.slot == Some(slot)) {
            return Err("這件你這回合已經看過了".into());
        }
        let pos = self.pos(slot);
        let mut swapped = false;
        let outcome = if (role == Role::HuangYanyan && self.round == self.huang_fail)
            || (role == Role::KidoKana && self.round == self.kido_fail)
        {
            Outcome::Sealed
        } else if self.blocked.contains(&pos) {
            Outcome::Blocked
        } else {
            swapped = role.swappable() && self.swap[self.round];
            if self.genuine[pos] != swapped { Outcome::Genuine } else { Outcome::Fake }
        };
        self.records[seat].push(Record { round: self.round, slot: Some(slot), seat: None, outcome, swapped });
        if let Some(turn) = self.turn.as_mut() {
            turn.left -= 1;
        }
        self.after_identify(ctx);
        Ok(())
    }

    fn check(&mut self, seat: usize, target: usize, ctx: &mut Ctx) -> Result<(), String> {
        if self.roles[seat] != Role::FangZhen {
            return Err("只有方震能查驗人".into());
        }
        if target == seat || target >= self.n() {
            return Err("請選另一位玩家".into());
        }
        if self.checked.contains(&target) {
            return Err("這個人已經查驗過了".into());
        }
        self.checked.push(target);
        let outcome = if self.roles[target].good() { Outcome::Good } else { Outcome::Bad };
        self.records[seat].push(Record { round: self.round, slot: None, seat: Some(target), outcome, swapped: false });
        if let Some(turn) = self.turn.as_mut() {
            turn.left -= 1;
        }
        self.after_identify(ctx);
        Ok(())
    }

    fn use_skill(&mut self, seat: usize, skill: Skill, ctx: &mut Ctx) -> Result<(), String> {
        match (self.roles[seat], skill) {
            (Role::LaoChaofeng, Skill::Swap(on)) => self.swap[self.round] = on,
            (Role::YaoBuran, Skill::Ambush(target)) => {
                if target == seat || target >= self.n() {
                    return Err("請選另一位玩家".into());
                }
                match self.roles[target] {
                    Role::JiYunfu => self.crippled = true,
                    Role::FangZhen => {
                        self.ambush[target] += 1;
                        if let Some(xu) = self.seat_of(Role::XuYuan) {
                            self.ambush[xu] += 1;
                        }
                    }
                    _ => self.ambush[target] += 1,
                }
            }
            (Role::ZhengGuoqu, Skill::Block(slot)) => {
                if slot >= PER_ROUND {
                    return Err("沒有這件獸首".into());
                }
                let pos = self.pos(slot);
                if !self.blocked.contains(&pos) {
                    self.blocked.push(pos);
                }
            }
            _ => return Err("你沒有這個技能".into()),
        }
        self.skills.push(SkillUse { round: self.round, seat, skill });
        self.skill_done(ctx);
        Ok(())
    }

    fn skill_done(&mut self, ctx: &mut Ctx) {
        if let Some(turn) = self.turn.as_mut() {
            turn.step = Step::Pass;
        }
        self.schedule_bots(ctx);
        ctx.changed();
    }

    fn pass(&mut self, next: Option<usize>, ctx: &mut Ctx) -> Result<(), String> {
        let remaining = self.remaining();
        match next {
            Some(t) if remaining.contains(&t) => {
                self.start_turn(t, ctx);
                Ok(())
            }
            None if remaining.is_empty() => {
                self.turn = None;
                if self.options.offline {
                    ctx.system(To::All, "大家都行動完了，當面討論，都按「可以投票了」就開始投票");
                    self.set_stage(Stage::Discuss, None, ctx);
                } else {
                    ctx.system(To::All, "大家都行動完了，在聊天室說說你看到了什麼");
                    let secs = Duration::from_secs(u64::from(self.options.discuss_secs));
                    self.set_stage(Stage::Discuss, Some(secs), ctx);
                }
                Ok(())
            }
            _ if remaining.is_empty() => Err("所有人都行動過了".into()),
            _ => Err("請選一位這回合還沒行動的人".into()),
        }
    }

    /// 時間到或斷線：跳過還沒做的事，隨機交給一個還沒行動的人
    fn auto_turn(&mut self, ctx: &mut Ctx) {
        let Some(turn) = self.turn.clone() else { return };
        let remaining = self.remaining();
        let next = (!remaining.is_empty()).then(|| remaining[ctx.rng.below(remaining.len())]);
        let who = &self.names[turn.seat];
        match next {
            Some(t) => ctx.system(To::All, format!("{who} 時間到，自動交給 {}", self.names[t])),
            None => ctx.system(To::All, format!("{who} 時間到，自動結束行動")),
        }
        let _ = self.pass(next, ctx);
    }

    fn begin_vote(&mut self, ctx: &mut Ctx) {
        for chips in &mut self.chips {
            *chips += CHIPS_PER_ROUND;
        }
        self.alloc.fill(None);
        let text = if self.is_last_round() {
            "投票：最後一回合，手上的籌碼要全部投出"
        } else {
            "投票：把籌碼投給你覺得是真品的獸首，沒用完的可以留到下一回合"
        };
        ctx.system(To::All, text);
        self.set_stage(Stage::Vote, Some(VOTE), ctx);
    }

    fn chips(&mut self, seat: usize, alloc: [u32; PER_ROUND]) -> Result<(), String> {
        let total: u32 = alloc.iter().sum();
        let balance = self.chips[seat];
        if total > balance {
            return Err(format!("你只有 {balance} 枚籌碼"));
        }
        if self.is_last_round() && total != balance {
            return Err(format!("最後一回合要把 {balance} 枚籌碼全部投出"));
        }
        self.alloc[seat] = Some(alloc);
        Ok(())
    }

    /// 連著線的人都投了就提早開票（斷線的人不等）
    fn all_voted(&self) -> bool {
        (0..self.n()).all(|s| self.alloc[s].is_some() || !self.online[s])
    }

    fn all_ready(&self) -> bool {
        (0..self.n()).all(|s| self.ready[s] || !self.online[s])
    }

    fn all_accused(&self) -> bool {
        (0..self.n()).all(|s| self.roles[s].goal().is_none() || self.accuse[s].is_some() || !self.online[s])
    }

    fn tally(&mut self, ctx: &mut Ctx) {
        let base = self.round * PER_ROUND;
        let mut votes = [0u32; PER_ROUND];
        for s in 0..self.n() {
            if let Some(a) = self.alloc[s] {
                self.chips[s] -= a.iter().sum::<u32>();
                for (v, x) in votes.iter_mut().zip(a) {
                    *v += x;
                }
            } else if self.is_last_round() {
                // 最後一回合沒投，剩下的籌碼就沒用了
                self.chips[s] = 0;
            }
        }
        // 同票照十二生肖的順序
        let mut rank: Vec<usize> = (0..PER_ROUND).collect();
        rank.sort_by_key(|&i| (Reverse(votes[i]), self.heads[base + i]));
        let (first, second) = (rank[0], rank[1]);
        let second_genuine = self.genuine[base + second];
        self.results.push(RoundResult {
            round: self.round,
            votes,
            allocs: self.alloc.clone(),
            first,
            second,
            second_genuine,
        });
        ctx.announce(
            To::All,
            format!(
                "第一名 {} 入選，真假不公開；第二名 {} 入選，是{}",
                self.head_name(base + first),
                self.head_name(base + second),
                if second_genuine { "真品" } else { "贗品" }
            ),
            "accent",
        );
        self.set_stage(Stage::Reveal, Some(REVEAL), ctx);
    }

    /// 入選的真品件數
    fn genuine_selected(&self) -> usize {
        self.results
            .iter()
            .flat_map(|r| [r.round * PER_ROUND + r.first, r.round * PER_ROUND + r.second])
            .filter(|&p| self.genuine[p])
            .count()
    }

    fn after_reveal(&mut self, ctx: &mut Ctx) {
        if !self.is_last_round() {
            let first = *self.order[self.round].last().expect("everyone acted this round");
            self.round += 1;
            self.begin_round(first, ctx);
        } else if self.genuine_selected() == ROUNDS * 2 {
            self.finish(ctx);
        } else {
            ctx.system(To::All, "三回合結束，開始鑑人：許愿陣營找老朝奉，老朝奉找許愿，藥不然找方震");
            self.set_stage(Stage::Ident, Some(IDENT), ctx);
        }
    }

    fn accuse(&mut self, seat: usize, target: usize) -> Result<(), String> {
        if self.roles[seat].goal().is_none() {
            return Err("鄭國渠不用鑑人".into());
        }
        if target >= self.n() {
            return Err("沒有這個人".into());
        }
        if target == seat {
            return Err("不能指認自己".into());
        }
        if self.forbidden(seat).contains(&target) {
            return Err("不能指認你的隊友".into());
        }
        self.accuse[seat] = Some(target);
        Ok(())
    }

    fn compute_final(&self) -> Final {
        let n = self.n();
        let genuine = self.genuine_selected();
        let direct = genuine == ROUNDS * 2;
        let good: Vec<usize> = (0..n).filter(|&s| self.roles[s].good()).collect();
        let mut boss_votes = vec![0usize; n];
        for &s in &good {
            if let Some(t) = self.accuse[s] {
                boss_votes[t] += 1;
            }
        }
        let boss_required = good.len() / 2 + 1;
        let top = boss_votes.iter().copied().max().unwrap_or(0);
        let leaders: Vec<usize> = (0..n).filter(|&s| boss_votes[s] == top).collect();
        let boss_target = (top >= boss_required && leaders.len() == 1).then(|| leaders[0]);
        let boss_found = boss_target.is_some_and(|t| self.roles[t] == Role::LaoChaofeng);
        let found = |hunter: Role, prey: Role| {
            self.seat_of(hunter).and_then(|h| self.accuse[h]).is_some_and(|t| self.roles[t] == prey)
        };
        let xu_found = found(Role::LaoChaofeng, Role::XuYuan);
        let fang_found = found(Role::YaoBuran, Role::FangZhen);
        let score = if direct {
            genuine
        } else {
            genuine + usize::from(boss_found) + if xu_found { 0 } else { 2 } + usize::from(!fang_found)
        };
        let winner = if score >= WIN_SCORE { Side::Good } else { Side::Bad };
        Final {
            genuine,
            direct,
            boss_votes,
            boss_required,
            boss_target,
            boss_found,
            xu_found,
            fang_found,
            score,
            winner,
        }
    }

    fn finish(&mut self, ctx: &mut Ctx) {
        let result = self.compute_final();
        for seat in 0..self.n() {
            if self.roles[seat].good() == (result.winner == Side::Good) {
                *self.scores.entry(self.pids[seat]).or_default() += 1;
            }
        }
        let text = match (result.direct, result.winner) {
            (true, _) => "六件入選的全是真品，許愿陣營直接獲勝！".to_owned(),
            (false, Side::Good) => format!("許愿陣營拿到 {} 分，獲勝！", result.score),
            (false, Side::Bad) => format!("許愿陣營只拿到 {} 分（要 {WIN_SCORE} 分），老朝奉陣營獲勝！", result.score),
        };
        ctx.announce(To::All, text, "ok");
        self.outcome = Some(result);
        self.turn = None;
        self.set_stage(Stage::End, None, ctx);
    }

    fn deadline_passed(&mut self, ctx: &mut Ctx) {
        match self.stage {
            Stage::Peek => {
                let first = ctx.rng.below(self.n());
                self.begin_round(first, ctx);
            }
            Stage::Act => self.auto_turn(ctx),
            Stage::Discuss => self.begin_vote(ctx),
            Stage::Vote => self.tally(ctx),
            Stage::Reveal => self.after_reveal(ctx),
            Stage::Ident => self.finish(ctx),
            Stage::End => {}
        }
    }

    /// 從聊天裡認出「鼠首是真的」「牛 假」這類說法，記下來給電腦參考
    fn read_claims(&mut self, seat: usize, text: &str) {
        let base = self.round * PER_ROUND;
        let names: Vec<char> =
            (0..PER_ROUND).map(|i| ZODIAC[self.heads[base + i]].chars().next().expect("zodiac")).collect();
        let chars: Vec<char> = text.chars().collect();
        for (i, c) in chars.iter().enumerate() {
            let Some(slot) = names.iter().position(|n| n == c) else { continue };
            // 生肖後面幾個字內的「真」或「假」，中間又出現別的生肖就不算
            for &next in chars.iter().skip(i + 1).take(5) {
                if names.contains(&next) {
                    break;
                }
                let genuine = match next {
                    '真' => true,
                    '假' | '贗' => false,
                    _ => continue,
                };
                self.claim(seat, slot, genuine);
                break;
            }
        }
    }

    fn claim(&mut self, seat: usize, slot: usize, genuine: bool) {
        let round = self.round;
        self.claims.retain(|c| !(c.round == round && c.seat == seat && c.slot == slot));
        self.claims.push(Claim { round, seat, slot, genuine });
    }

    fn bot_act(&mut self, seat: usize, ctx: &mut Ctx) {
        match self.stage {
            Stage::Peek | Stage::Reveal => {
                self.ready[seat] = true;
                ctx.changed();
            }
            Stage::Discuss => {
                self.bot_talk(seat, ctx);
                self.ready[seat] = true;
                ctx.changed();
            }
            Stage::Act => self.bot_turn(seat, ctx),
            Stage::Vote => {
                let alloc = self.bot_chips(seat, ctx);
                let _ = self.chips(seat, alloc);
                ctx.changed();
            }
            Stage::Ident => {
                if let Some(target) = self.bot_accuse(seat, ctx) {
                    let _ = self.accuse(seat, target);
                    ctx.changed();
                }
            }
            Stage::End => {}
        }
    }

    /// 電腦輪到自己：一次做一步，做完會再排下一步
    fn bot_turn(&mut self, seat: usize, ctx: &mut Ctx) {
        let Some(turn) = self.turn.clone().filter(|t| t.seat == seat) else { return };
        let role = self.roles[seat];
        match turn.step {
            Step::Identify if role == Role::FangZhen => {
                let options: Vec<usize> = (0..self.n()).filter(|&s| s != seat && !self.checked.contains(&s)).collect();
                if options.is_empty() {
                    if let Some(t) = self.turn.as_mut() {
                        t.left = 0;
                    }
                    self.after_identify(ctx);
                } else {
                    let _ = self.check(seat, options[ctx.rng.below(options.len())], ctx);
                }
            }
            Step::Identify => {
                let options: Vec<usize> = (0..PER_ROUND)
                    .filter(|&slot| !self.records[seat].iter().any(|r| r.round == self.round && r.slot == Some(slot)))
                    .collect();
                let _ = self.identify(seat, options[ctx.rng.below(options.len())], ctx);
            }
            Step::Skill => {
                let skill = match role {
                    Role::LaoChaofeng => Skill::Swap(ctx.rng.chance(0.7)),
                    Role::YaoBuran => {
                        // 偷襲還沒行動的人這回合就有效；老朝奉是隊友不偷襲
                        let lao = self.seat_of(Role::LaoChaofeng);
                        let others: Vec<usize> = (0..self.n()).filter(|&s| s != seat && Some(s) != lao).collect();
                        let waiting: Vec<usize> =
                            others.iter().copied().filter(|s| self.remaining().contains(s)).collect();
                        let pool = if waiting.is_empty() { others } else { waiting };
                        Skill::Ambush(pool[ctx.rng.below(pool.len())])
                    }
                    _ => {
                        // 鄭國渠：封鎖自己看到是真品的那件，沒看到就隨便挑
                        let seen = self.records[seat]
                            .iter()
                            .find(|r| r.round == self.round && r.outcome == Outcome::Genuine)
                            .and_then(|r| r.slot);
                        Skill::Block(seen.unwrap_or_else(|| ctx.rng.below(PER_ROUND)))
                    }
                };
                let _ = self.use_skill(seat, skill, ctx);
            }
            Step::Pass => {
                let remaining = self.remaining();
                let next = (!remaining.is_empty()).then(|| remaining[ctx.rng.below(remaining.len())]);
                let _ = self.pass(next, ctx);
            }
        }
    }

    /// 電腦在討論時說自己看到什麼：好人說實話，壞人反著說
    fn bot_talk(&mut self, seat: usize, ctx: &mut Ctx) {
        let role = self.roles[seat];
        let base = self.round * PER_ROUND;
        let mine: Vec<Record> = self.records[seat].iter().filter(|r| r.round == self.round).cloned().collect();
        if role == Role::FangZhen {
            let text = match mine.iter().find(|r| r.seat.is_some()) {
                Some(Record { seat: Some(t), outcome: Outcome::Bad, .. }) => {
                    format!("我覺得 {} 有點可疑", self.names[*t])
                }
                Some(_) => "這回合沒什麼特別的".to_owned(),
                None => "我這回合被偷襲了".to_owned(),
            };
            ctx.say(To::All, seat, text);
            return;
        }
        let mut said: Vec<(usize, bool)> = Vec::new();
        for r in &mine {
            if let (Some(slot), Outcome::Genuine | Outcome::Fake) = (r.slot, r.outcome) {
                let seen = r.outcome == Outcome::Genuine;
                said.push((slot, if role.good() { seen } else { !seen }));
            }
        }
        if said.is_empty() && !role.good() {
            // 壞人沒看到也要編一個
            said.push((ctx.rng.below(PER_ROUND), ctx.rng.chance(0.5)));
        }
        let text = if said.is_empty() {
            if mine.iter().any(|r| matches!(r.outcome, Outcome::Ambushed | Outcome::Crippled)) {
                "我被偷襲了，這回合什麼都沒看到".to_owned()
            } else {
                "我這回合看不出真假".to_owned()
            }
        } else {
            let parts: Vec<String> = said
                .iter()
                .map(|&(slot, g)| format!("{}是{}", self.head_name(base + slot), if g { "真品" } else { "贗品" }))
                .collect();
            format!("我看了{}", parts.join("、"))
        };
        for (slot, genuine) in said {
            self.claim(seat, slot, genuine);
        }
        ctx.say(To::All, seat, text);
    }

    /// 電腦投籌碼：好人投最像真品的兩件，壞人投最像贗品的兩件；每回合都全部投出
    fn bot_chips(&self, seat: usize, ctx: &mut Ctx) -> [u32; PER_ROUND] {
        let mut belief = [0f64; PER_ROUND];
        for b in &mut belief {
            *b = ctx.rng.range(0.0, 0.5);
        }
        for r in self.records[seat].iter().filter(|r| r.round == self.round) {
            if let Some(slot) = r.slot {
                match r.outcome {
                    Outcome::Genuine => belief[slot] += 3.0,
                    Outcome::Fake => belief[slot] -= 3.0,
                    _ => {}
                }
            }
        }
        for c in self.claims.iter().filter(|c| c.round == self.round && c.seat != seat) {
            belief[c.slot] += if c.genuine { 1.0 } else { -1.0 };
        }
        let mut order: Vec<usize> = (0..PER_ROUND).collect();
        let good = self.roles[seat].good();
        order.sort_by(|&a, &b| {
            let (x, y) = if good { (belief[b], belief[a]) } else { (belief[a], belief[b]) };
            x.total_cmp(&y)
        });
        let mut alloc = [0u32; PER_ROUND];
        for k in 0..self.chips[seat] as usize {
            alloc[order[k % 2]] += 1;
        }
        alloc
    }

    /// 電腦鑑人
    fn bot_accuse(&self, seat: usize, ctx: &mut Ctx) -> Option<usize> {
        let role = self.roles[seat];
        role.goal()?;
        let forbidden = self.forbidden(seat);
        let mut best: Option<(f64, usize)> = None;
        for c in (0..self.n()).filter(|c| !forbidden.contains(c)) {
            let mut score = ctx.rng.range(0.0, 1.0);
            let claims: Vec<&Claim> = self.claims.iter().filter(|x| x.seat == c).collect();
            match role {
                // 老朝奉找許愿：每回合都報兩件的人
                Role::LaoChaofeng => {
                    for round in 0..ROUNDS {
                        if claims.iter().filter(|x| x.round == round).count() >= 2 {
                            score += 2.0;
                        }
                    }
                }
                // 藥不然找方震：從來不報獸首的人
                Role::YaoBuran => {
                    if claims.is_empty() {
                        score += 2.0;
                    }
                }
                // 好人找老朝奉：說法和公開的真假、自己看到的對不上
                _ => {
                    for r in &self.results {
                        let wrong = claims
                            .iter()
                            .any(|x| x.round == r.round && x.slot == r.second && x.genuine != r.second_genuine);
                        if wrong {
                            score += 2.0;
                        }
                    }
                    for mine in &self.records[seat] {
                        let seen = match mine.outcome {
                            Outcome::Genuine => true,
                            Outcome::Fake => false,
                            Outcome::Good if mine.seat == Some(c) => {
                                score -= 5.0;
                                continue;
                            }
                            Outcome::Bad if mine.seat == Some(c) => {
                                score += 5.0;
                                continue;
                            }
                            _ => continue,
                        };
                        if claims
                            .iter()
                            .any(|x| x.round == mine.round && Some(x.slot) == mine.slot && x.genuine != seen)
                        {
                            score += 1.0;
                        }
                    }
                }
            }
            if best.is_none_or(|(b, _)| score > b) {
                best = Some((score, c));
            }
        }
        best.map(|(_, c)| c)
    }
}

impl PartyGame for Antique {
    const ID: &'static str = "antique";
    const MIN_PLAYERS: usize = 6;
    const MAX_PLAYERS: usize = 8;
    const MAX_BOTS: usize = 7;

    type Options = Options;
    type Action = Action;

    fn rooms(state: &AppState) -> &Arc<Parties<Self>> {
        &state.antique
    }

    fn check_options(mut options: Options) -> Result<Options, String> {
        if options.turn_secs > 0 {
            options.turn_secs = options.turn_secs.clamp(20, 180);
        }
        options.discuss_secs = options.discuss_secs.clamp(30, 600);
        Ok(options)
    }

    fn start(options: &Options, previous: Option<&Self>, ctx: &mut Ctx) -> Self {
        let n = ctx.seats.len();
        let mut roles = ROLES[..n].to_vec();
        shuffle(ctx.rng, &mut roles);

        // 十二生肖洗牌後每 4 個一回合，回合內照生肖順序排；每回合 2 真 2 假
        let mut zodiac: Vec<usize> = (0..12).collect();
        shuffle(ctx.rng, &mut zodiac);
        let mut heads = [0usize; 12];
        let mut genuine = [false; 12];
        for r in 0..ROUNDS {
            let mut part = zodiac[r * PER_ROUND..(r + 1) * PER_ROUND].to_vec();
            part.sort_unstable();
            let mut truth = [true, true, false, false];
            shuffle(ctx.rng, &mut truth);
            for i in 0..PER_ROUND {
                heads[r * PER_ROUND + i] = part[i];
                genuine[r * PER_ROUND + i] = truth[i];
            }
        }

        let mut game = Self {
            options: options.clone(),
            pids: ctx.seats.iter().map(|s| s.pid).collect(),
            names: ctx.seats.iter().map(|s| s.name.clone()).collect(),
            bots: ctx.seats.iter().map(|s| s.bot).collect(),
            online: ctx.seats.iter().map(|s| s.online).collect(),
            roles,
            heads,
            genuine,
            huang_fail: ctx.rng.below(ROUNDS),
            kido_fail: ctx.rng.below(ROUNDS),
            round: 0,
            stage: Stage::Peek,
            deadline: None,
            stage_started: ctx.now,
            turn: None,
            order: vec![Vec::new(); ROUNDS],
            swap: [false; ROUNDS],
            blocked: Vec::new(),
            ambush: vec![0; n],
            crippled: false,
            checked: Vec::new(),
            records: vec![Vec::new(); n],
            skills: Vec::new(),
            claims: Vec::new(),
            ready: vec![false; n],
            chips: vec![0; n],
            alloc: vec![None; n],
            results: Vec::new(),
            accuse: vec![None; n],
            outcome: None,
            scores: previous.map(|p| p.scores.clone()).unwrap_or_default(),
            bot_at: vec![None; n],
        };
        let names: Vec<&str> = ROLES[..n].iter().map(|r| r.label()).collect();
        ctx.system(To::All, format!("新的一局，{n} 人：{}。看看你的身分！", names.join("、")));
        game.set_stage(Stage::Peek, Some(PEEK), ctx);
        game
    }

    fn act(&mut self, seat: usize, action: Action, ctx: &mut Ctx) -> Result<(), String> {
        let turn = self.turn.clone().filter(|t| t.seat == seat);
        match (action, self.stage) {
            (Action::Ready, Stage::Peek | Stage::Discuss | Stage::Reveal) => {
                self.ready[seat] = true;
                if self.all_ready() {
                    self.deadline_passed(ctx);
                }
                Ok(())
            }
            (Action::Identify { slot }, Stage::Act) if turn.as_ref().is_some_and(|t| t.step == Step::Identify) => {
                self.identify(seat, slot, ctx)
            }
            (Action::Check { seat: target }, Stage::Act) if turn.as_ref().is_some_and(|t| t.step == Step::Identify) => {
                self.check(seat, target, ctx)
            }
            (Action::Swap { on }, Stage::Act) if turn.as_ref().is_some_and(|t| t.step == Step::Skill) => {
                self.use_skill(seat, Skill::Swap(on), ctx)
            }
            (Action::Ambush { seat: target }, Stage::Act) if turn.as_ref().is_some_and(|t| t.step == Step::Skill) => {
                self.use_skill(seat, Skill::Ambush(target), ctx)
            }
            (Action::Block { slot }, Stage::Act) if turn.as_ref().is_some_and(|t| t.step == Step::Skill) => {
                self.use_skill(seat, Skill::Block(slot), ctx)
            }
            (Action::Skip, Stage::Act) if turn.as_ref().is_some_and(|t| t.step == Step::Skill) => {
                self.skill_done(ctx);
                Ok(())
            }
            (Action::Pass { seat: next }, Stage::Act) if turn.as_ref().is_some_and(|t| t.step == Step::Pass) => {
                self.pass(next, ctx)
            }
            (Action::Chips { alloc }, Stage::Vote) => self.chips(seat, alloc).map(|()| {
                if self.all_voted() {
                    self.tally(ctx);
                }
            }),
            (Action::Accuse { seat: target }, Stage::Ident) => self.accuse(seat, target).map(|()| {
                if self.all_accused() {
                    self.finish(ctx);
                }
            }),
            (_, Stage::Act) if turn.is_none() => Err("還沒輪到你".into()),
            (_, Stage::Act) => Err("現在不是做這一步的時候".into()),
            _ => Err("現在不能這樣做".into()),
        }
    }

    fn tick(&mut self, ctx: &mut Ctx) {
        for seat in 0..self.bot_at.len() {
            if self.bot_at[seat].is_some_and(|t| ctx.now >= t) {
                self.bot_at[seat] = None;
                self.bot_act(seat, ctx);
            }
        }
        match self.stage {
            Stage::Peek | Stage::Discuss | Stage::Reveal if self.all_ready() => self.deadline_passed(ctx),
            Stage::Vote if self.all_voted() => self.tally(ctx),
            Stage::Ident if self.all_accused() => self.finish(ctx),
            // 輪到斷線的人：不等滿整個行動時間
            Stage::Act
                if self.turn.as_ref().is_some_and(|t| !self.online[t.seat])
                    && ctx.now.duration_since(self.stage_started) >= OFFLINE_WAIT =>
            {
                self.auto_turn(ctx)
            }
            _ if self.deadline.is_some_and(|d| ctx.now >= d) => self.deadline_passed(ctx),
            _ => {}
        }
    }

    fn chat(&mut self, seat: Option<usize>, text: &str, _ctx: &mut Ctx) -> Chat {
        if self.stage == Stage::End {
            return Chat::Show;
        }
        match seat {
            // 觀戰的人只能跟觀戰的人聊，不影響場上
            None => Chat::Only(To::SeatsAndSpectators(Vec::new())),
            Some(s) => {
                if matches!(self.stage, Stage::Act | Stage::Discuss | Stage::Vote) {
                    self.read_claims(s, text);
                }
                Chat::Show
            }
        }
    }

    fn presence(&mut self, seat: usize, online: bool, ctx: &mut Ctx) {
        self.online[seat] = online;
        ctx.changed();
    }

    fn view(&self, seat: Option<usize>, now: Instant) -> Value {
        let ended = self.stage == Stage::End;
        let n = self.n();
        let shown_rounds = if ended { ROUNDS } else { self.round + 1 };
        let heads: Vec<Value> = (0..shown_rounds * PER_ROUND)
            .map(|pos| {
                let (round, slot) = (pos / PER_ROUND, pos % PER_ROUND);
                let result = self.results.get(round);
                let pick = result.and_then(|r| {
                    if r.first == slot {
                        Some("first")
                    } else if r.second == slot {
                        Some("second")
                    } else {
                        None
                    }
                });
                let revealed = ended || result.is_some_and(|r| r.second == slot);
                json!({
                    "zodiac": self.heads[pos],
                    "round": round,
                    "slot": slot,
                    "pick": pick,
                    "genuine": revealed.then_some(self.genuine[pos]),
                    "votes": result.map(|r| r.votes[slot]),
                })
            })
            .collect();
        let seats: Vec<Value> = (0..n)
            .map(|s| {
                let known = ended || seat.is_some_and(|me| self.knows_role(me, s));
                let voted = match self.stage {
                    Stage::Vote => self.alloc[s].is_some(),
                    Stage::Ident => self.accuse[s].is_some(),
                    _ => false,
                };
                json!({
                    "online": self.online[s],
                    "ready": self.ready[s],
                    "voted": voted,
                    "acted": self.order[self.round].contains(&s),
                    "role": known.then_some(self.roles[s]),
                    "points": self.scores.get(&self.pids[s]).copied().unwrap_or(0),
                })
            })
            .collect();
        let turn = self.turn.as_ref().map(|t| {
            let mine = seat == Some(t.seat);
            json!({
                "seat": t.seat,
                "step": mine.then_some(t.step),
                "left": mine.then_some(t.left),
                "ambushed": mine.then_some(t.ambushed),
            })
        });
        let me = seat.map(|s| {
            let role = self.roles[s];
            json!({
                "role": role,
                "records": self.records[s].iter().map(|r| r.json(ended)).collect::<Vec<_>>(),
                "skills": self.skills.iter().filter(|u| u.seat == s).map(SkillUse::json).collect::<Vec<_>>(),
                "checked": if role == Role::FangZhen { self.checked.clone() } else { Vec::new() },
                "chips": self.chips[s],
                "alloc": self.alloc[s],
                "goal": role.goal(),
                "accused": self.accuse[s],
                "forbidden": self.forbidden(s),
            })
        });
        let end = self.outcome.as_ref().map(|result| {
            json!({
                "result": result,
                "roles": self.roles,
                "accusations": self.accuse,
                "skills": self.skills.iter().map(SkillUse::json).collect::<Vec<_>>(),
                "fails": { "huangYanyan": self.huang_fail, "kidoKana": self.kido_fail },
            })
        });
        json!({
            "stage": self.stage.name(),
            "endsIn": self.deadline.map(|d| d.saturating_duration_since(now).as_millis() as u64),
            "round": self.round,
            "options": self.options,
            "lineup": &ROLES[..n],
            "you": seat,
            "me": me,
            "heads": heads,
            "seats": seats,
            "turn": turn,
            "order": self.order[self.round],
            "results": self.results,
            "end": end,
        })
    }

    fn finished(&self) -> bool {
        self.stage == Stage::End
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::party::{Outbox, Rng, SeatInfo};
    use Role::{
        FangZhen as FANG, HuangYanyan as HUANG, JiYunfu as JI, KidoKana as KIDO, LaoChaofeng as LAO, XuYuan as XU,
        YaoBuran as YAO, ZhengGuoqu as ZHENG,
    };

    const ALL: [Role; 8] = [XU, FANG, HUANG, KIDO, LAO, YAO, ZHENG, JI];

    fn seats(n: usize, bots: usize) -> Vec<SeatInfo> {
        (0..n)
            .map(|i| SeatInfo { pid: i as u32 + 1, name: format!("P{i}"), bot: i >= n - bots, online: true })
            .collect()
    }

    fn start(n: usize, bots: usize, now: Instant, rng: &mut Rng) -> (Antique, Vec<SeatInfo>) {
        let seats = seats(n, bots);
        let mut out = Outbox::default();
        let g = Antique::start(&Options::default(), None, &mut crate::party::test_ctx(now, rng, &seats, &mut out));
        (g, seats)
    }

    /// 固定角色（座位 i 是 `roles[i]`），每回合第 0、1 件是真品、2、3 件是贗品，生肖照順序排
    struct T {
        g: Antique,
        seats: Vec<SeatInfo>,
        rng: Rng,
        now: Instant,
    }

    impl T {
        fn new(roles: &[Role]) -> Self {
            let mut rng = Rng::new();
            let now = Instant::now();
            let (mut g, seats) = start(roles.len(), 0, now, &mut rng);
            g.roles = roles.to_vec();
            g.heads = std::array::from_fn(|i| i);
            g.genuine = std::array::from_fn(|i| i % PER_ROUND < 2);
            g.huang_fail = 2;
            g.kido_fail = 2;
            T { g, seats, rng, now }
        }

        fn run<R>(&mut self, f: impl FnOnce(&mut Antique, &mut Ctx) -> R) -> R {
            let mut out = Outbox::default();
            let mut ctx = crate::party::test_ctx(self.now, &mut self.rng, &self.seats, &mut out);
            f(&mut self.g, &mut ctx)
        }

        fn act(&mut self, seat: usize, action: Action) -> Result<(), String> {
            self.run(|g, ctx| g.act(seat, action, ctx))
        }

        fn ok(&mut self, seat: usize, action: Action) {
            self.act(seat, action).unwrap();
        }

        fn begin(&mut self, first: usize) {
            self.run(|g, ctx| g.begin_round(first, ctx));
        }

        fn tick_after(&mut self, wait: Duration) {
            self.now += wait;
            self.run(|g, ctx| g.tick(ctx));
        }

        fn last(&self, seat: usize) -> Outcome {
            self.g.records[seat].last().unwrap().outcome
        }

        fn pass(&mut self, seat: usize, next: usize) {
            self.ok(seat, Action::Pass { seat: Some(next) });
        }
    }

    #[test]
    fn roles_heads_and_what_each_seat_can_see() {
        for n in 6..=8 {
            for _ in 0..10 {
                let mut rng = Rng::new();
                let (g, _) = start(n, 0, Instant::now(), &mut rng);
                let mut roles = g.roles.clone();
                roles.sort_by_key(|r| ALL.iter().position(|a| a == r));
                assert_eq!(roles, ALL[..n], "{n} 人的角色");
                let mut zodiac = g.heads.to_vec();
                zodiac.sort_unstable();
                assert_eq!(zodiac, (0..12).collect::<Vec<_>>());
                for r in 0..ROUNDS {
                    let part = &g.heads[r * PER_ROUND..(r + 1) * PER_ROUND];
                    assert!(part.windows(2).all(|w| w[0] < w[1]), "回合內照生肖排");
                    assert_eq!(g.genuine[r * PER_ROUND..(r + 1) * PER_ROUND].iter().filter(|&&x| x).count(), 2);
                }

                let lao = g.seat_of(LAO).unwrap();
                let yao = g.seat_of(YAO).unwrap();
                for me in 0..n {
                    let view = g.view(Some(me), Instant::now());
                    assert_eq!(view["me"]["role"], json!(g.roles[me]));
                    for other in 0..n {
                        let sees = other == me || (me == lao && other == yao) || (me == yao && other == lao);
                        assert_eq!(view["seats"][other]["role"].is_null(), !sees, "座位 {me} 看座位 {other}");
                    }
                    let heads = view["heads"].as_array().unwrap();
                    assert!(heads.iter().all(|h| h["genuine"].is_null()), "真假不能外流");
                    assert_eq!(heads.len(), PER_ROUND, "只看得到這回合的獸首");
                }
                let spectator = g.view(None, Instant::now());
                assert!(spectator["me"].is_null());
                assert!(spectator["seats"].as_array().unwrap().iter().all(|s| s["role"].is_null()));
            }
        }
    }

    #[test]
    fn a_full_round_of_identifying_and_skills() {
        let mut t = T::new(&ALL);
        t.begin(0);
        assert_eq!(t.act(1, Action::Identify { slot: 0 }), Err("還沒輪到你".into()));

        // 許愿看兩件
        t.ok(0, Action::Identify { slot: 0 });
        assert_eq!(t.last(0), Outcome::Genuine);
        assert_eq!(t.act(0, Action::Identify { slot: 0 }), Err("這件你這回合已經看過了".into()));
        t.ok(0, Action::Identify { slot: 2 });
        assert_eq!(t.last(0), Outcome::Fake);
        assert!(t.act(0, Action::Identify { slot: 3 }).is_err(), "最多兩件");
        assert!(t.act(0, Action::Skip).is_err(), "許愿沒有技能");
        assert_eq!(t.act(0, Action::Pass { seat: Some(0) }), Err("請選一位這回合還沒行動的人".into()));
        t.pass(0, 4);

        // 老朝奉自己看到的是真的，然後發動調換
        t.ok(4, Action::Identify { slot: 1 });
        assert_eq!(t.last(4), Outcome::Genuine);
        assert!(t.act(4, Action::Ambush { seat: 0 }).is_err(), "不是他的技能");
        t.ok(4, Action::Swap { on: true });
        t.pass(4, 2);

        // 黃煙煙在老朝奉之後：看到相反的；姬雲浮不受影響
        t.ok(2, Action::Identify { slot: 0 });
        assert_eq!(t.last(2), Outcome::Fake);
        assert!(t.g.records[2].last().unwrap().swapped);
        t.pass(2, 7);
        t.ok(7, Action::Identify { slot: 0 });
        assert_eq!(t.last(7), Outcome::Genuine);
        t.pass(7, 6);

        // 鄭國渠封鎖第 1 件，之後木戶加奈看不出來
        t.ok(6, Action::Identify { slot: 3 });
        t.ok(6, Action::Block { slot: 1 });
        t.pass(6, 3);
        t.ok(3, Action::Identify { slot: 1 });
        assert_eq!(t.last(3), Outcome::Blocked);
        t.pass(3, 1);

        // 方震查人
        assert_eq!(t.act(1, Action::Identify { slot: 0 }), Err("方震查驗的是人，請選一位玩家".into()));
        assert!(t.act(1, Action::Check { seat: 1 }).is_err());
        t.ok(1, Action::Check { seat: 4 });
        assert_eq!(t.last(1), Outcome::Bad);
        t.pass(1, 5);

        // 藥不然偷襲方震：方震和許愿下一次都不能鑑定
        t.ok(5, Action::Identify { slot: 2 });
        t.ok(5, Action::Ambush { seat: 1 });
        assert_eq!(t.g.ambush, [1, 1, 0, 0, 0, 0, 0, 0]);
        assert_eq!(t.act(5, Action::Pass { seat: Some(0) }), Err("所有人都行動過了".into()));
        t.ok(5, Action::Pass { seat: None });
        assert_eq!(t.g.stage, Stage::Discuss);
        assert_eq!(t.g.order[0], [0, 4, 2, 7, 6, 3, 1, 5]);

        // 自己的紀錄只有自己看得到；被調換的事要結束才公開
        let view = t.g.view(Some(2), t.now);
        assert_eq!(view["me"]["records"][0]["outcome"], "fake");
        assert_eq!(view["me"]["records"][0]["swapped"], false);
        assert_eq!(t.g.view(Some(3), t.now)["me"]["records"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn ambushes_take_effect_on_the_next_turn() {
        let mut t = T::new(&ALL);
        t.begin(5);
        t.ok(5, Action::Identify { slot: 0 });
        t.ok(5, Action::Ambush { seat: 1 });
        t.pass(5, 0);
        // 許愿跟著方震被偷襲：這次直接跳到交棒
        assert_eq!(t.last(0), Outcome::Ambushed);
        assert!(t.act(0, Action::Identify { slot: 0 }).is_err());
        t.pass(0, 1);
        assert_eq!(t.last(1), Outcome::Ambushed);
        assert!(t.act(1, Action::Check { seat: 4 }).is_err());
        assert_eq!(t.g.ambush, [0; 8]);

        // 姬雲浮被偷襲一次就永遠不能鑑定
        let mut t = T::new(&ALL);
        t.begin(5);
        t.ok(5, Action::Identify { slot: 0 });
        t.ok(5, Action::Ambush { seat: 7 });
        t.pass(5, 7);
        assert_eq!(t.last(7), Outcome::Crippled);
        t.g.round = 1;
        t.begin(7);
        assert_eq!(t.last(7), Outcome::Crippled);

        // 被偷襲的老朝奉這次也不能調換
        let mut t = T::new(&ALL);
        t.begin(5);
        t.ok(5, Action::Identify { slot: 0 });
        t.ok(5, Action::Ambush { seat: 4 });
        t.pass(5, 4);
        assert!(t.act(4, Action::Swap { on: true }).is_err());
        assert!(!t.g.swap[0]);
    }

    #[test]
    fn huang_and_kido_lose_one_round() {
        let mut t = T::new(&ALL);
        t.g.huang_fail = 0;
        t.begin(2);
        t.ok(2, Action::Identify { slot: 0 });
        assert_eq!(t.last(2), Outcome::Sealed);
        t.pass(2, 3);
        t.ok(3, Action::Identify { slot: 0 });
        assert_eq!(t.last(3), Outcome::Genuine);
    }

    #[test]
    fn chips_carry_over_and_ties_go_by_zodiac() {
        let mut t = T::new(&ALL[..6]);
        t.run(|g, ctx| g.begin_vote(ctx));
        assert_eq!(t.g.chips, [2; 6]);
        assert_eq!(t.act(0, Action::Chips { alloc: [3, 0, 0, 0] }), Err("你只有 2 枚籌碼".into()));
        t.ok(0, Action::Chips { alloc: [0, 1, 0, 0] });
        t.ok(1, Action::Chips { alloc: [0, 2, 0, 0] });
        t.ok(2, Action::Chips { alloc: [0, 1, 1, 0] });
        t.ok(3, Action::Chips { alloc: [0, 0, 1, 1] });
        t.ok(4, Action::Chips { alloc: [0, 0, 0, 1] });
        assert_eq!(t.g.stage, Stage::Vote);
        t.ok(5, Action::Chips { alloc: [0, 0, 0, 0] });
        assert_eq!(t.g.stage, Stage::Reveal);
        let r = &t.g.results[0];
        assert_eq!(r.votes, [0, 4, 2, 2]);
        assert_eq!((r.first, r.second), (1, 2), "2、3 同票，生肖在前的贏");
        assert!(!r.second_genuine);
        assert_eq!(t.g.chips, [1, 0, 0, 0, 1, 2]);
        let view = t.g.view(Some(0), t.now);
        assert_eq!(view["heads"][2]["genuine"], false, "第二名公開");
        assert!(view["heads"][1]["genuine"].is_null(), "第一名不公開");

        // 最後一回合要全部投出
        t.g.round = 2;
        t.run(|g, ctx| g.begin_vote(ctx));
        assert_eq!(t.g.chips[5], 4);
        assert_eq!(t.act(5, Action::Chips { alloc: [1, 0, 0, 0] }), Err("最後一回合要把 4 枚籌碼全部投出".into()));
        t.ok(5, Action::Chips { alloc: [1, 1, 1, 1] });
    }

    fn result(round: usize, first: usize, second: usize) -> RoundResult {
        RoundResult { round, votes: [0; PER_ROUND], allocs: Vec::new(), first, second, second_genuine: second < 2 }
    }

    #[test]
    fn scoring() {
        let mut t = T::new(&ALL);
        // 每回合入選一真一假：3 分
        t.g.results = (0..ROUNDS).map(|r| result(r, 0, 2)).collect();
        // 好人（0、1、2、3、7）有 3 人投老朝奉，過半
        t.g.accuse = vec![Some(4), Some(4), Some(4), Some(6), Some(4), Some(2), None, Some(6)];
        let f = t.g.compute_final();
        assert_eq!(f.genuine, 3);
        assert_eq!(f.boss_required, 3);
        assert_eq!(f.boss_target, Some(4));
        assert!(f.boss_found && !f.xu_found && !f.fang_found);
        assert_eq!(f.score, 3 + 1 + 2 + 1);
        assert_eq!(f.winner, Side::Good);

        // 老朝奉找到許愿、藥不然找到方震、好人沒過半
        t.g.accuse = vec![Some(4), Some(4), Some(6), Some(6), Some(0), Some(1), None, Some(5)];
        let f = t.g.compute_final();
        assert_eq!(f.boss_target, None);
        assert!(f.xu_found && f.fang_found);
        assert_eq!(f.score, 3);
        assert_eq!(f.winner, Side::Bad);
    }

    #[test]
    fn six_genuine_heads_win_without_accusing() {
        let mut t = T::new(&ALL);
        t.g.results = (0..ROUNDS).map(|r| result(r, 0, 1)).collect();
        t.g.round = 2;
        t.run(|g, ctx| g.after_reveal(ctx));
        assert_eq!(t.g.stage, Stage::End);
        let f = t.g.outcome.as_ref().unwrap();
        assert!(f.direct);
        assert_eq!(f.winner, Side::Good);
        assert_eq!(t.g.scores.get(&1), Some(&1), "許愿陣營每人 1 分");
        assert_eq!(t.g.scores.get(&5), None);
        let view = t.g.view(Some(0), t.now);
        assert_eq!(view["heads"].as_array().unwrap().len(), 12, "結束後公開全部");
        assert!(view["seats"].as_array().unwrap().iter().all(|s| !s["role"].is_null()));
    }

    #[test]
    fn accusing() {
        let mut t = T::new(&ALL);
        t.g.results = (0..ROUNDS).map(|r| result(r, 0, 2)).collect();
        t.g.round = 2;
        t.run(|g, ctx| g.after_reveal(ctx));
        assert_eq!(t.g.stage, Stage::Ident);
        assert_eq!(t.act(4, Action::Accuse { seat: 5 }), Err("不能指認你的隊友".into()));
        assert_eq!(t.act(5, Action::Accuse { seat: 4 }), Err("不能指認你的隊友".into()));
        assert_eq!(t.act(0, Action::Accuse { seat: 0 }), Err("不能指認自己".into()));
        assert_eq!(t.act(6, Action::Accuse { seat: 0 }), Err("鄭國渠不用鑑人".into()));
        for (seat, target) in [(0, 4), (1, 4), (2, 4), (3, 4), (4, 1), (5, 0)] {
            t.ok(seat, Action::Accuse { seat: target });
        }
        assert_eq!(t.g.stage, Stage::Ident);
        // 鄭國渠不用等
        t.ok(7, Action::Accuse { seat: 6 });
        assert_eq!(t.g.stage, Stage::End);
        assert_eq!(t.g.outcome.as_ref().unwrap().score, 3 + 1 + 2 + 1);
    }

    #[test]
    fn claims_are_read_from_chat() {
        let mut t = T::new(&ALL);
        t.begin(0);
        // 第一回合是鼠牛虎兔
        t.g.read_claims(3, "我覺得鼠首是真的，牛是假的，豬真");
        t.g.read_claims(2, "虎兔真");
        let claims: Vec<(usize, usize, bool)> = t.g.claims.iter().map(|c| (c.seat, c.slot, c.genuine)).collect();
        assert_eq!(claims, [(3, 0, true), (3, 1, false), (2, 3, true)]);
        // 同一件改口，只留最新的
        t.g.read_claims(3, "更正：鼠是贗品");
        assert!(t.g.claims.contains(&Claim { round: 0, seat: 3, slot: 0, genuine: false }));
        assert_eq!(t.g.claims.len(), 3);
    }

    #[test]
    fn timeouts_and_offline_players_pass_automatically() {
        let mut t = T::new(&ALL[..6]);
        t.begin(0);
        t.tick_after(Duration::from_secs(61));
        assert_eq!(t.g.order[0].len(), 2, "時間到自動交棒");
        let actor = t.g.turn.as_ref().unwrap().seat;
        t.run(|g, ctx| g.presence(actor, false, ctx));
        t.tick_after(OFFLINE_WAIT);
        assert_eq!(t.g.order[0].len(), 3, "斷線的人等 10 秒就跳過");
    }

    /// 一直 tick 到結束（或放棄）
    fn play_out(g: &mut Antique, seats: &[SeatInfo], rng: &mut Rng, mut now: Instant, step: Duration) {
        for _ in 0..20_000 {
            if g.finished() {
                break;
            }
            now += step;
            let mut out = Outbox::default();
            g.tick(&mut crate::party::test_ctx(now, rng, seats, &mut out));
        }
        assert!(g.finished(), "卡在 {:?}", g.stage);
    }

    #[test]
    fn bots_can_play_whole_games() {
        for n in 6..=8 {
            for _ in 0..30 {
                let mut rng = Rng::new();
                let now = Instant::now();
                let (mut g, seats) = start(n, n, now, &mut rng);
                play_out(&mut g, &seats, &mut rng, now, Duration::from_millis(500));
                assert!(g.order.iter().take(g.results.len()).all(|o| o.len() == n), "每個人每回合都行動一次");
                assert_eq!(g.results.len(), ROUNDS);
                assert!(g.chips.iter().all(|&c| c == 0), "籌碼都投完了");
                assert!(!g.claims.is_empty(), "電腦有發言");
            }
        }
    }

    #[test]
    fn idle_humans_still_finish() {
        let mut rng = Rng::new();
        let now = Instant::now();
        let (mut g, seats) = start(6, 0, now, &mut rng);
        play_out(&mut g, &seats, &mut rng, now, Duration::from_secs(1));
    }
}
