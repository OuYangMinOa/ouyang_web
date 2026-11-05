//! 狼人殺（派對房間，房間本身見 `party.rs`）。
//!
//! 6～12 人分成狼人和好人（平民＋神職）。角色是民間通用的狼人、平民、預言家、女巫、獵人，守衛可選。
//! 依人數有預設配置（`Lineup::preset`），房主也可以自訂狼人數和要哪些神職（`Options::lineup` 檢查配不配得出來）。
//!
//! 流程：
//! 1. 看身分（狼人互相認識）。
//! 2. 夜晚：守衛、狼人、預言家同時行動。守衛守一個人（可以守自己、可以空守，不能連兩晚守同一人）；
//!    狼人私下聊天、各自投票刀誰（可以空刀），全部投同一個人就定案，時間到照多數，平手或沒人投就隨機；
//!    預言家查驗一個人是不是狼人。三種人都做完就提早結束。
//!    接著女巫：解藥救今晚被刀的人、或毒藥毒一個人，同一晚只能用一瓶；解藥用掉之後就看不到刀口。
//!    女巫出局或沒藥時這一步照樣等幾秒，其他人才看不出來。
//! 3. 天亮公布死訊（不公布死因）：被刀的人被守衛守護或被女巫救就沒事，但同守同救還是會死；守衛擋不住毒藥。
//! 4. 有獵人的局：這批出局的人都要確認技能，獵人不是被毒死的就可以開槍帶走一個人（別人看不出誰是獵人，除非他開槍）。
//! 5. 遺言（選項：沒有／第一晚和白天出局的人有／都有）。線上在聊天室說，線下當面說，按「說完了」換下一位。
//! 6. 討論：線上在聊天室打字、有倒數，大家都按「可以投票了」就提早投票；線下當面說，房主按「開始投票」（倒數到了也會開始）。
//! 7. 投票放逐：可以棄票，票最多的人出局；平票時（選項）由平票以外的人在平票的人之間再投一次，再平就沒人出局，或直接沒人出局。
//!    出局的人一樣走 4、5（獵人被放逐也能開槍），然後天黑。
//! 8. 勝負：狼人全部出局好人贏；屠邊（預設）是平民或神職其中一邊全部出局狼人贏，屠城是好人全部出局狼人贏。
//!    同時發生時好人贏（狼人已經全滅了）。打到第 20 天還沒分出勝負就算狼人贏。
//!
//! 聊天：夜晚只有活著的狼人之間看得到（其他人說的話不送出）；出局的人只能和出局、觀戰的人聊。
//! 剛出局、技能或遺言還沒處理完的人不能聊（免得從觀戰的人那裡聽到什麼再用遺言、開槍帶回場上），輪到他遺言時說的話大家都看得到。
//! 觀戰的人看不到任何身分和夜晚的結果，說的話也只有出局、觀戰的人看得到，所以聊天室漏不出東西給場上的人。
//!
//! 電腦玩家：照自己的角色和公開的「說法」（`Claim`）判斷誰可疑（`suspicion`）。預言家查最可疑的人、白天報查驗結果；
//! 守衛守跳預言家的人；女巫第一晚救人、確定誰是狼人才用毒；狼人跟著真人隊友刀，自己挑時先刀跳神職的人，
//! 有時候派一個狼人電腦假跳預言家；投票投最可疑的人。真人在聊天室說「我是預言家」「3號是狼」「小明金水」這類句子也會被記成說法。

use std::{cmp::Reverse, collections::HashMap, sync::Arc, time::Duration};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::time::Instant;

use crate::{
    AppState,
    party::{Chat, Ctx, Parties, PartyGame, To, shuffle},
};

const PEEK: Duration = Duration::from_secs(15);
const WITCH: Duration = Duration::from_secs(25);
const DAWN: Duration = Duration::from_secs(6);
const SKILL: Duration = Duration::from_secs(20);
const LAST_WORDS: Duration = Duration::from_secs(45);
const LAST_WORDS_OFFLINE: Duration = Duration::from_secs(60);
const VOTE: Duration = Duration::from_secs(40);
const REVOTE: Duration = Duration::from_secs(30);
const VERDICT: Duration = Duration::from_secs(6);
/// 斷線的真人最多等這麼久（從這個階段開始算），之後當作他不做事
const OFFLINE_WAIT: Duration = Duration::from_secs(10);
/// 打到這一天還沒分出勝負就算狼人贏（一直空刀、一直平票時才會發生）
const MAX_DAYS: u32 = 20;

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Wolf,
    Villager,
    Seer,
    Witch,
    Hunter,
    Guard,
}

impl Role {
    pub fn label(self) -> &'static str {
        match self {
            Role::Wolf => "狼人",
            Role::Villager => "平民",
            Role::Seer => "預言家",
            Role::Witch => "女巫",
            Role::Hunter => "獵人",
            Role::Guard => "守衛",
        }
    }

    fn god(self) -> bool {
        matches!(self, Role::Seer | Role::Witch | Role::Hunter | Role::Guard)
    }
}

/// 狼人怎樣算贏
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub enum Win {
    /// 屠邊：平民或神職其中一邊全部出局
    #[default]
    Side,
    /// 屠城：好人全部出局
    All,
}

/// 女巫能不能用解藥救自己
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub enum SelfSave {
    Never,
    #[default]
    FirstNight,
    Always,
}

/// 誰有遺言
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub enum LastWords {
    Never,
    /// 第一晚出局的人，以及白天被放逐、被獵人帶走的人
    #[default]
    FirstNight,
    Always,
}

/// 放逐投票平票時
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub enum Tie {
    /// 平票以外的人在平票的人之間再投一次，再平就沒人出局
    #[default]
    Revote,
    NoExile,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Options {
    /// 線下模式：白天當面討論，房主按「開始投票」；夜晚一樣在各自的手機上行動
    pub offline: bool,
    /// 自訂角色；false 是依人數的預設配置，下面五個欄位不用
    pub custom: bool,
    pub wolves: u8,
    pub seer: bool,
    pub witch: bool,
    pub hunter: bool,
    pub guard: bool,
    pub win: Win,
    pub self_save: SelfSave,
    pub last_words: LastWords,
    pub tie: Tie,
    /// 出局時公開身分
    pub reveal: bool,
    /// 夜晚（守衛、狼人、預言家）的秒數
    pub night_secs: u16,
    /// 白天討論的秒數（線下模式是上限）
    pub discuss_secs: u16,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            offline: false,
            custom: false,
            wolves: 3,
            seer: true,
            witch: true,
            hunter: true,
            guard: false,
            win: Win::Side,
            self_save: SelfSave::FirstNight,
            last_words: LastWords::FirstNight,
            tie: Tie::Revote,
            reveal: false,
            night_secs: 45,
            discuss_secs: 180,
        }
    }
}

impl Options {
    /// 這些選項配上 `n` 個人的角色；配不出來回傳原因
    pub fn lineup(&self, n: usize) -> Result<Lineup, String> {
        if !self.custom {
            return Ok(Lineup::preset(n));
        }
        let wolves = usize::from(self.wolves);
        let gods = [self.seer, self.witch, self.hunter, self.guard].iter().filter(|&&g| g).count();
        if wolves == 0 {
            return Err("至少要 1 個狼人".into());
        }
        if wolves * 2 >= n {
            return Err(format!("{n} 人最多 {} 個狼人（狼人要比好人少）", (n - 1) / 2));
        }
        if wolves + gods > n {
            return Err(format!("{n} 人放不下 {wolves} 個狼人和 {gods} 個神職"));
        }
        let villagers = n - wolves - gods;
        if self.win == Win::Side && (villagers == 0 || gods == 0) {
            return Err("屠邊至少要有 1 個平民和 1 個神職，不然一開局就分出勝負".into());
        }
        Ok(Lineup { wolves, villagers, seer: self.seer, witch: self.witch, hunter: self.hunter, guard: self.guard })
    }
}

/// 一局有哪些角色
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Lineup {
    pub wolves: usize,
    pub villagers: usize,
    pub seer: bool,
    pub witch: bool,
    pub hunter: bool,
    pub guard: bool,
}

impl Lineup {
    /// 依人數的預設配置（前端 `types.ts` 的 `preset` 要一樣）：
    /// 6 人 2 狼 2 民＋預言家、女巫；7、8 人再加獵人；9、10 人 3 狼；11 人再加守衛；12 人 4 狼
    pub fn preset(n: usize) -> Self {
        let (wolves, hunter, guard) = match n {
            ..=6 => (2, false, false),
            7 | 8 => (2, true, false),
            9 | 10 => (3, true, false),
            11 => (3, true, true),
            _ => (4, true, true),
        };
        let gods = 2 + usize::from(hunter) + usize::from(guard);
        Lineup { wolves, villagers: n.saturating_sub(wolves + gods), seer: true, witch: true, hunter, guard }
    }

    fn gods(&self) -> usize {
        [self.seer, self.witch, self.hunter, self.guard].iter().filter(|&&g| g).count()
    }

    fn roles(&self) -> Vec<Role> {
        let mut roles = vec![Role::Wolf; self.wolves];
        roles.extend(std::iter::repeat_n(Role::Villager, self.villagers));
        for (on, role) in
            [(self.seer, Role::Seer), (self.witch, Role::Witch), (self.hunter, Role::Hunter), (self.guard, Role::Guard)]
        {
            if on {
                roles.push(role);
            }
        }
        roles
    }

    fn describe(&self) -> String {
        let mut parts = vec![format!("{} 狼人", self.wolves), format!("{} 平民", self.villagers)];
        for (on, role) in
            [(self.seer, Role::Seer), (self.witch, Role::Witch), (self.hunter, Role::Hunter), (self.guard, Role::Guard)]
        {
            if on {
                parts.push(role.label().to_owned());
            }
        }
        parts.join("、")
    }
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    Good,
    Wolf,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Action {
    /// 看身分時「記住了」、線上討論時「可以投票了」
    Ready,
    /// 守衛：None 是空守
    Guard {
        #[serde(default)]
        seat: Option<usize>,
    },
    /// 狼人投票刀誰：None 是空刀
    Kill {
        #[serde(default)]
        seat: Option<usize>,
    },
    /// 預言家查驗
    Check { seat: usize },
    /// 女巫：解藥救今晚被刀的人
    Save,
    /// 女巫：毒藥
    Poison { seat: usize },
    /// 女巫：今晚不用藥
    Pass,
    /// 夜晚沒事做的人記一下懷疑誰（只有自己看得到；線下時大家都在點手機，旁邊的人看不出誰有身分）
    Suspect {
        #[serde(default)]
        seat: Option<usize>,
    },
    /// 出局後確認技能：獵人帶走一個人，None 是不開槍（其他人一律送 None）
    Shoot {
        #[serde(default)]
        seat: Option<usize>,
    },
    /// 遺言說完了
    Done,
    /// 線下模式由房主推進：開始投票、下一位遺言（伺服器不知道誰是房主，前端只給房主看到按鈕，見 README）
    Advance,
    /// 放逐投票：None 是棄票
    Vote {
        #[serde(default)]
        seat: Option<usize>,
    },
}

#[derive(Clone, PartialEq, Debug)]
enum Stage {
    Peek,
    /// 守衛、狼人、預言家
    Night,
    Witch,
    /// 公布死訊
    Dawn,
    /// 剛出局的人確認技能（獵人開槍）
    Skill,
    /// `at` 是 `speakers` 的第幾個
    LastWords {
        at: usize,
    },
    Discuss,
    /// `voters` 是這輪能投的人；重投時平票的人不能投
    Vote {
        candidates: Vec<usize>,
        voters: Vec<usize>,
        revote: bool,
    },
    /// 公布投票結果
    Verdict,
    End,
}

impl Stage {
    fn name(&self) -> &'static str {
        match self {
            Stage::Peek => "peek",
            Stage::Night => "night",
            Stage::Witch => "witch",
            Stage::Dawn => "dawn",
            Stage::Skill => "skill",
            Stage::LastWords { .. } => "lastWords",
            Stage::Discuss => "discuss",
            Stage::Vote { .. } => "vote",
            Stage::Verdict => "verdict",
            Stage::End => "end",
        }
    }
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
enum Cause {
    /// 被狼人刀
    Knife,
    Poison,
    Exile,
    /// 被獵人帶走
    Shot,
}

impl Cause {
    /// 對局中公開的部分：夜裡死的不說是被刀還是被毒
    fn when(self) -> &'static str {
        match self {
            Cause::Knife | Cause::Poison => "night",
            Cause::Exile => "exile",
            Cause::Shot => "shot",
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct Death {
    day: u32,
    seat: usize,
    cause: Cause,
}

/// 這批死亡處理完（技能、遺言）之後要去哪
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Then {
    Discuss,
    Night,
}

/// 預言家的查驗，只有預言家看得到
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
struct Check {
    night: u32,
    seat: usize,
    wolf: bool,
}

/// 一晚發生的事，結束後才公開
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct NightLog {
    night: u32,
    guard: Option<usize>,
    kill: Option<usize>,
    saved: bool,
    poison: Option<usize>,
    check: Option<Check>,
    deaths: Vec<usize>,
}

#[derive(Serialize, Clone, Copy, Debug)]
struct Shot {
    day: u32,
    hunter: usize,
    target: usize,
}

#[derive(Serialize, Clone, Debug)]
struct Tally {
    day: u32,
    revote: bool,
    voters: Vec<usize>,
    /// 每個座位投給誰；不能投、棄票或沒投是 null
    ballots: Vec<Option<usize>>,
    out: Option<usize>,
}

/// 公開說過的話（電腦說的，或從真人的聊天裡認出來的），給電腦判斷用
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Said {
    /// 自稱是這個角色
    Role(Role),
    /// 說某人是狼（自稱預言家的人說就是「查殺」）
    Wolf(usize),
    /// 說某人是好人（自稱預言家的人說就是「金水」）
    Good(usize),
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
struct Claim {
    seat: usize,
    said: Said,
}

/// 今晚的行動，每晚重來
#[derive(Clone, Debug, Default)]
struct Night {
    /// 守衛守誰：None 還沒決定，Some(None) 空守
    guard: Option<Option<usize>>,
    /// 每個座位（狼人）投刀誰，同上
    kills: Vec<Option<Option<usize>>>,
    check: Option<usize>,
    /// 狼人階段結束時定的刀口
    kill: Option<usize>,
    /// 女巫這一步開始時還有解藥（看得到刀口）
    victim_known: bool,
    witch_done: bool,
    save: bool,
    poison: Option<usize>,
}

impl Night {
    fn new(n: usize) -> Self {
        Self { kills: vec![None; n], ..Self::default() }
    }
}

pub struct Werewolf {
    options: Options,
    lineup: Lineup,
    pids: Vec<u32>,
    names: Vec<String>,
    bots: Vec<bool>,
    online: Vec<bool>,
    roles: Vec<Role>,
    alive: Vec<bool>,
    /// 第幾天：第 N 晚之後是第 N 天，看身分時是 0
    day: u32,
    stage: Stage,
    deadline: Option<Instant>,
    stage_started: Instant,
    ready: Vec<bool>,
    night: Night,
    /// 守衛上一晚守的人（這晚不能再守）
    last_guard: Option<usize>,
    antidote: bool,
    poison: bool,
    checks: Vec<Check>,
    suspects: Vec<Option<usize>>,
    nights: Vec<NightLog>,
    deaths: Vec<Death>,
    /// 正在處理的這批出局的人（技能、遺言），處理完去 `then`
    batch: Vec<usize>,
    then: Then,
    /// 還沒確認技能的人
    skill_wait: Vec<usize>,
    speakers: Vec<usize>,
    shots: Vec<Shot>,
    /// 放逐投票：None 還沒投，Some(None) 棄票
    votes: Vec<Option<Option<usize>>>,
    tallies: Vec<Tally>,
    claims: Vec<Claim>,
    winner: Option<Side>,
    reason: Option<String>,
    /// 累計分數（pid → 分）
    scores: HashMap<u32, u32>,
    /// 每個電腦下一次出手的時間
    bot_at: Vec<Option<Instant>>,
    /// 這局要假跳預言家的狼人電腦
    fake_seer: Option<usize>,
}

impl Werewolf {
    fn n(&self) -> usize {
        self.roles.len()
    }

    fn is_wolf(&self, seat: usize) -> bool {
        self.roles[seat] == Role::Wolf
    }

    fn alive_seats(&self) -> Vec<usize> {
        (0..self.n()).filter(|&s| self.alive[s]).collect()
    }

    fn alive_wolves(&self) -> Vec<usize> {
        (0..self.n()).filter(|&s| self.alive[s] && self.is_wolf(s)).collect()
    }

    /// 還活著的這個角色（神職每種只有一個）
    fn alive_role(&self, role: Role) -> Option<usize> {
        (0..self.n()).find(|&s| self.alive[s] && self.roles[s] == role)
    }

    fn death_of(&self, seat: usize) -> Option<&Death> {
        self.deaths.iter().find(|d| d.seat == seat)
    }

    /// 斷線的真人在這個階段已經等夠久了（電腦永遠連著線）
    fn away(&self, seat: usize, now: Instant) -> bool {
        !self.online[seat] && now.duration_since(self.stage_started) >= OFFLINE_WAIT
    }

    /// 剛出局、技能或遺言還沒處理完
    fn pending(&self, seat: usize) -> bool {
        match &self.stage {
            Stage::Dawn | Stage::Verdict | Stage::Skill => self.batch.contains(&seat),
            Stage::LastWords { at } => self.speakers[*at..].contains(&seat),
            _ => false,
        }
    }

    /// 出局、手上沒事的人：可以和觀戰的人聊天
    fn ghosts(&self) -> Vec<usize> {
        (0..self.n()).filter(|&s| !self.alive[s] && !self.pending(s)).collect()
    }

    fn speaker(&self) -> Option<usize> {
        match self.stage {
            Stage::LastWords { at } => self.speakers.get(at).copied(),
            _ => None,
        }
    }

    fn can_self_save(&self) -> bool {
        match self.options.self_save {
            SelfSave::Never => false,
            SelfSave::FirstNight => self.day == 1,
            SelfSave::Always => true,
        }
    }

    fn witch_can_act(&self) -> bool {
        self.alive_role(Role::Witch).is_some() && (self.antidote || self.poison)
    }

    fn can_shoot(&self, seat: usize) -> bool {
        self.roles[seat] == Role::Hunter
            && self.skill_wait.contains(&seat)
            && self.death_of(seat).is_some_and(|d| d.cause != Cause::Poison)
    }

    /// 公告用的名字；出局公開身分時加上身分
    fn label(&self, seat: usize) -> String {
        if self.options.reveal {
            format!("{}（{}）", self.names[seat], self.roles[seat].label())
        } else {
            self.names[seat].clone()
        }
    }

    fn set_stage(&mut self, stage: Stage, length: Option<Duration>, ctx: &mut Ctx) {
        self.stage = stage;
        self.stage_started = ctx.now;
        self.deadline = length.map(|d| ctx.now + d);
        self.ready.fill(false);
        self.schedule_bots(ctx);
        ctx.changed();
    }

    /// 進到新的階段時排好每個電腦什麼時候出手
    fn schedule_bots(&mut self, ctx: &mut Ctx) {
        for seat in 0..self.n() {
            self.bot_at[seat] = None;
            if !self.bots[seat] {
                continue;
            }
            let alive = self.alive[seat];
            let role = self.roles[seat];
            let delay = match &self.stage {
                Stage::Peek => Some(ctx.rng.range(0.5, 2.0)),
                Stage::Night if alive && matches!(role, Role::Guard | Role::Seer | Role::Wolf) => {
                    Some(ctx.rng.range(2.0, 7.0))
                }
                Stage::Witch if alive && role == Role::Witch && self.witch_can_act() => Some(ctx.rng.range(2.0, 5.0)),
                Stage::Skill if self.skill_wait.contains(&seat) => Some(ctx.rng.range(1.5, 4.0)),
                Stage::LastWords { at } if self.speakers.get(*at) == Some(&seat) => Some(ctx.rng.range(2.0, 4.0)),
                Stage::Discuss if alive => Some(ctx.rng.range(2.0, 12.0)),
                Stage::Vote { voters, .. } if voters.contains(&seat) => Some(ctx.rng.range(3.0, 12.0)),
                _ => None,
            };
            self.bot_at[seat] = delay.map(|d| ctx.now + Duration::from_secs_f64(d));
        }
    }

    // ---- 夜晚 ----

    fn begin_night(&mut self, ctx: &mut Ctx) {
        if self.day >= MAX_DAYS {
            self.finish(Side::Wolf, "打了太多天還沒分出勝負，撐到最後的狼人獲勝".into(), ctx);
            return;
        }
        self.day += 1;
        self.night = Night::new(self.n());
        self.suspects.fill(None);
        let mut actors = Vec::new();
        if self.lineup.guard {
            actors.push("守衛");
        }
        actors.push("狼人");
        if self.lineup.seer {
            actors.push("預言家");
        }
        ctx.announce(To::All, format!("第 {} 晚，天黑請閉眼。{}請在手機上行動", self.day, actors.join("、")), "accent");
        ctx.system(To::Seats(self.alive_wolves()), "狼人請睜眼：這裡說的話只有狼隊友看得到，點玩家投票決定今晚刀誰");
        let secs = Duration::from_secs(u64::from(self.options.night_secs));
        self.set_stage(Stage::Night, Some(secs), ctx);
    }

    /// 守衛、預言家做完了，狼人也都投同一個人（斷線等夠久的不算）
    fn night_done(&self, now: Instant) -> bool {
        let guard = self.alive_role(Role::Guard).is_none_or(|g| self.night.guard.is_some() || self.away(g, now));
        let seer = self.alive_role(Role::Seer).is_none_or(|s| self.night.check.is_some() || self.away(s, now));
        let wolves: Vec<usize> = self.alive_wolves().into_iter().filter(|&w| !self.away(w, now)).collect();
        let first = wolves.first().and_then(|&w| self.night.kills[w]);
        let agreed = wolves.iter().all(|&w| self.night.kills[w].is_some() && self.night.kills[w] == first);
        guard && seer && agreed
    }

    fn end_night(&mut self, ctx: &mut Ctx) {
        let kill = self.decide_kill(ctx);
        self.night.kill = kill;
        let text = match kill {
            Some(t) => format!("狼人決定刀 {}", self.names[t]),
            None => "狼人決定今晚不殺人".to_owned(),
        };
        ctx.system(To::Seats(self.alive_wolves()), text);
        if self.lineup.witch { self.begin_witch(ctx) } else { self.dawn(ctx) }
    }

    /// 刀口：狼人投票的多數，平手隨機；沒有人投就隨機刀一個好人
    fn decide_kill(&self, ctx: &mut Ctx) -> Option<usize> {
        let mut tally: Vec<(Option<usize>, usize)> = Vec::new();
        for w in self.alive_wolves() {
            if let Some(choice) = self.night.kills[w] {
                match tally.iter_mut().find(|(c, _)| *c == choice) {
                    Some((_, k)) => *k += 1,
                    None => tally.push((choice, 1)),
                }
            }
        }
        if tally.is_empty() {
            let pool: Vec<usize> = self.alive_seats().into_iter().filter(|&s| !self.is_wolf(s)).collect();
            return (!pool.is_empty()).then(|| pool[ctx.rng.below(pool.len())]);
        }
        let top = tally.iter().map(|t| t.1).max().unwrap_or(0);
        let tied: Vec<Option<usize>> = tally.iter().filter(|t| t.1 == top).map(|t| t.0).collect();
        tied[ctx.rng.below(tied.len())]
    }

    fn begin_witch(&mut self, ctx: &mut Ctx) {
        self.night.victim_known = self.antidote;
        // 女巫出局或沒藥時隨便等幾秒，其他人看不出來
        let length = if self.witch_can_act() { WITCH } else { Duration::from_secs_f64(ctx.rng.range(4.0, 8.0)) };
        self.set_stage(Stage::Witch, Some(length), ctx);
    }

    fn guard(&mut self, target: Option<usize>) -> Result<(), String> {
        if let Some(t) = target {
            if t >= self.n() || !self.alive[t] {
                return Err("請選一位還活著的玩家".into());
            }
            if Some(t) == self.last_guard {
                return Err("不能連續兩晚守同一個人".into());
            }
        }
        self.night.guard = Some(target);
        Ok(())
    }

    fn wolf_vote(&mut self, seat: usize, target: Option<usize>, ctx: &mut Ctx) -> Result<(), String> {
        if let Some(t) = target
            && (t >= self.n() || !self.alive[t])
        {
            return Err("請選一位還活著的玩家".into());
        }
        self.night.kills[seat] = Some(target);
        if !self.bots[seat] {
            // 真人改了票，電腦隊友過一下就跟上
            for w in self.alive_wolves() {
                if self.bots[w] {
                    self.bot_at[w] = Some(ctx.now + Duration::from_secs_f64(ctx.rng.range(1.0, 2.5)));
                }
            }
        }
        Ok(())
    }

    fn check(&mut self, seat: usize, target: usize) -> Result<(), String> {
        if self.night.check.is_some() {
            return Err("今晚已經查驗過了".into());
        }
        if target == seat || target >= self.n() || !self.alive[target] {
            return Err("請選另一位還活著的玩家".into());
        }
        if self.checks.iter().any(|c| c.seat == target) {
            return Err("這個人已經查驗過了".into());
        }
        self.checks.push(Check { night: self.day, seat: target, wolf: self.is_wolf(target) });
        self.night.check = Some(target);
        Ok(())
    }

    fn witch(&mut self, seat: usize, action: Action, ctx: &mut Ctx) -> Result<(), String> {
        if self.night.witch_done {
            return Err("今晚已經決定過了".into());
        }
        match action {
            Action::Save => {
                if !self.antidote {
                    return Err("解藥已經用過了".into());
                }
                let Some(target) = self.night.kill else { return Err("今晚沒有人被刀".into()) };
                if target == seat && !self.can_self_save() {
                    return Err(match self.options.self_save {
                        SelfSave::FirstNight => "只有第一晚能救自己".into(),
                        _ => "女巫不能救自己".into(),
                    });
                }
                self.antidote = false;
                self.night.save = true;
            }
            Action::Poison { seat: target } => {
                if !self.poison {
                    return Err("毒藥已經用過了".into());
                }
                if target == seat {
                    return Err("不能毒自己".into());
                }
                if target >= self.n() || !self.alive[target] {
                    return Err("請選一位還活著的玩家".into());
                }
                self.poison = false;
                self.night.poison = Some(target);
            }
            Action::Pass => {}
            _ => return Err("現在不能這樣做".into()),
        }
        self.night.witch_done = true;
        self.dawn(ctx);
        Ok(())
    }

    /// 結算這一晚：守衛和解藥擋刀（同守同救還是會死），毒藥擋不住
    fn dawn(&mut self, ctx: &mut Ctx) {
        let night = self.night.clone();
        let mut dead: Vec<(usize, Cause)> = Vec::new();
        if let Some(t) = night.kill {
            let guarded = night.guard == Some(Some(t));
            if guarded == night.save {
                dead.push((t, Cause::Knife));
            }
        }
        if let Some(p) = night.poison {
            match dead.iter_mut().find(|d| d.0 == p) {
                Some(d) => d.1 = Cause::Poison,
                None => dead.push((p, Cause::Poison)),
            }
        }
        dead.sort_by_key(|d| d.0);
        let seats: Vec<usize> = dead.iter().map(|d| d.0).collect();
        self.nights.push(NightLog {
            night: self.day,
            guard: night.guard.flatten(),
            kill: night.kill,
            saved: night.save,
            poison: night.poison,
            check: self.checks.iter().find(|c| c.night == self.day).copied(),
            deaths: seats.clone(),
        });
        self.last_guard = night.guard.flatten();
        for &(seat, cause) in &dead {
            self.kill(seat, cause);
        }
        if seats.is_empty() {
            ctx.announce(To::All, format!("第 {} 天，天亮了。昨晚是平安夜", self.day), "ok");
        } else {
            let names: Vec<String> = seats.iter().map(|&s| self.label(s)).collect();
            ctx.announce(To::All, format!("第 {} 天，天亮了。昨晚 {} 出局", self.day, names.join("、")), "danger");
        }
        if self.check_win(ctx) {
            return;
        }
        self.batch = seats;
        self.then = Then::Discuss;
        self.set_stage(Stage::Dawn, Some(DAWN), ctx);
    }

    // ---- 出局之後：技能、遺言 ----

    fn kill(&mut self, seat: usize, cause: Cause) {
        self.alive[seat] = false;
        self.deaths.push(Death { day: self.day, seat, cause });
    }

    /// 公布完這批出局的人：有獵人的局先確認技能，再遺言
    fn after_batch(&mut self, ctx: &mut Ctx) {
        if self.batch.is_empty() {
            self.proceed(ctx);
        } else if self.lineup.hunter {
            // 每個出局的人都要確認，別人才看不出誰是獵人
            self.skill_wait = self.batch.clone();
            ctx.system(To::All, "出局的人確認技能中…");
            self.set_stage(Stage::Skill, Some(SKILL), ctx);
        } else {
            self.begin_last_words(ctx);
        }
    }

    fn shoot(&mut self, seat: usize, target: Option<usize>, ctx: &mut Ctx) -> Result<(), String> {
        if !self.skill_wait.contains(&seat) {
            return Err("現在沒有要你確認的技能".into());
        }
        if let Some(t) = target {
            if self.roles[seat] != Role::Hunter {
                return Err("你沒有可以發動的技能".into());
            }
            if !self.can_shoot(seat) {
                return Err("你被毒死了，不能開槍".into());
            }
            if t == seat || t >= self.n() || !self.alive[t] {
                return Err("請選一位還活著的玩家".into());
            }
            self.kill(t, Cause::Shot);
            self.shots.push(Shot { day: self.day, hunter: seat, target: t });
            self.batch.push(t);
            ctx.announce(To::All, format!("{} 是獵人，開槍帶走了 {}", self.names[seat], self.label(t)), "danger");
        }
        self.skill_wait.retain(|&s| s != seat);
        if target.is_some() && self.check_win(ctx) {
            return Ok(());
        }
        if self.skill_wait.is_empty() {
            self.begin_last_words(ctx);
        }
        Ok(())
    }

    fn has_last_words(&self, seat: usize) -> bool {
        let Some(death) = self.death_of(seat) else { return false };
        match self.options.last_words {
            LastWords::Never => false,
            LastWords::Always => true,
            LastWords::FirstNight => !matches!(death.cause, Cause::Knife | Cause::Poison) || death.day == 1,
        }
    }

    fn last_words_length(&self) -> Duration {
        if self.options.offline { LAST_WORDS_OFFLINE } else { LAST_WORDS }
    }

    fn begin_last_words(&mut self, ctx: &mut Ctx) {
        self.skill_wait.clear();
        self.speakers = self.batch.iter().copied().filter(|&s| self.has_last_words(s)).collect();
        if self.speakers.is_empty() {
            self.proceed(ctx);
            return;
        }
        let names: Vec<&str> = self.speakers.iter().map(|&s| self.names[s].as_str()).collect();
        ctx.system(To::All, format!("遺言：{}", names.join("、")));
        self.set_stage(Stage::LastWords { at: 0 }, Some(self.last_words_length()), ctx);
    }

    fn next_speaker(&mut self, ctx: &mut Ctx) {
        let Stage::LastWords { at } = self.stage else { return };
        if at + 1 < self.speakers.len() {
            self.set_stage(Stage::LastWords { at: at + 1 }, Some(self.last_words_length()), ctx);
        } else {
            self.proceed(ctx);
        }
    }

    fn proceed(&mut self, ctx: &mut Ctx) {
        self.batch.clear();
        self.speakers.clear();
        self.skill_wait.clear();
        match self.then {
            Then::Discuss => self.begin_discuss(ctx),
            Then::Night => self.begin_night(ctx),
        }
    }

    // ---- 白天 ----

    fn begin_discuss(&mut self, ctx: &mut Ctx) {
        let text = if self.options.offline {
            "討論：大家當面說，房主按「開始投票」就投票"
        } else {
            "討論：在聊天室說說你的看法，大家都按「可以投票了」就提早投票"
        };
        ctx.system(To::All, text);
        let secs = Duration::from_secs(u64::from(self.options.discuss_secs));
        self.set_stage(Stage::Discuss, Some(secs), ctx);
    }

    fn begin_vote(&mut self, candidates: Vec<usize>, voters: Vec<usize>, revote: bool, ctx: &mut Ctx) {
        self.votes.fill(None);
        if !revote {
            ctx.system(To::All, "投票放逐：點一位玩家投他，也可以棄票");
        }
        self.set_stage(Stage::Vote { candidates, voters, revote }, Some(if revote { REVOTE } else { VOTE }), ctx);
    }

    fn all_ready(&self, now: Instant) -> bool {
        self.alive_seats().into_iter().all(|s| self.ready[s] || self.away(s, now))
    }

    fn all_voted(&self, now: Instant) -> bool {
        let Stage::Vote { voters, .. } = &self.stage else { return false };
        voters.iter().all(|&s| self.votes[s].is_some() || self.away(s, now))
    }

    fn tally(&mut self, ctx: &mut Ctx) {
        let Stage::Vote { candidates, voters, revote } = self.stage.clone() else { return };
        let n = self.n();
        let mut counts = vec![0usize; n];
        for &s in &voters {
            if let Some(Some(t)) = self.votes[s]
                && candidates.contains(&t)
            {
                counts[t] += 1;
            }
        }
        let top = candidates.iter().map(|&c| counts[c]).max().unwrap_or(0);
        let tied: Vec<usize> = candidates.iter().copied().filter(|&c| counts[c] == top).collect();
        let out = (top > 0 && tied.len() == 1).then(|| tied[0]);
        let ballots = (0..n).map(|s| if voters.contains(&s) { self.votes[s].flatten() } else { None }).collect();
        self.tallies.push(Tally { day: self.day, revote, voters: voters.clone(), ballots, out });

        if let Some(seat) = out {
            self.kill(seat, Cause::Exile);
            ctx.announce(To::All, format!("{} 被放逐出局（{} 票）", self.label(seat), top), "danger");
            if self.check_win(ctx) {
                return;
            }
            self.batch = vec![seat];
        } else if top > 0 && !revote && self.options.tie == Tie::Revote {
            let next: Vec<usize> = self.alive_seats().into_iter().filter(|s| !tied.contains(s)).collect();
            let names: Vec<&str> = tied.iter().map(|&s| self.names[s].as_str()).collect();
            if !next.is_empty() {
                ctx.system(To::All, format!("{} 平票，其他人在他們之間再投一次", names.join("、")));
                self.begin_vote(tied, next, true, ctx);
                return;
            }
            ctx.system(To::All, "大家都平票，今天沒有人被放逐");
            self.batch.clear();
        } else {
            let text = match (top, revote) {
                (0, _) => "沒有人投票，今天沒有人被放逐",
                (_, true) => "又平票了，今天沒有人被放逐",
                _ => "平票，今天沒有人被放逐",
            };
            ctx.system(To::All, text);
            self.batch.clear();
        }
        self.then = Then::Night;
        self.set_stage(Stage::Verdict, Some(VERDICT), ctx);
    }

    // ---- 勝負 ----

    fn winner_now(&self) -> Option<(Side, &'static str)> {
        let count =
            |pred: &dyn Fn(Role) -> bool| (0..self.n()).filter(|&s| self.alive[s] && pred(self.roles[s])).count();
        let wolves = count(&|r| r == Role::Wolf);
        if wolves == 0 {
            return Some((Side::Good, "狼人全部出局，好人獲勝"));
        }
        let villagers = count(&|r| r == Role::Villager);
        let gods = count(&|r| r.god());
        match self.options.win {
            Win::Side if self.lineup.villagers > 0 && villagers == 0 => {
                Some((Side::Wolf, "平民全部出局，狼人屠邊獲勝"))
            }
            Win::Side if self.lineup.gods() > 0 && gods == 0 => Some((Side::Wolf, "神職全部出局，狼人屠邊獲勝")),
            Win::All if villagers + gods == 0 => Some((Side::Wolf, "好人全部出局，狼人屠城獲勝")),
            _ => None,
        }
    }

    fn check_win(&mut self, ctx: &mut Ctx) -> bool {
        let Some((side, reason)) = self.winner_now() else { return false };
        self.finish(side, reason.to_owned(), ctx);
        true
    }

    fn finish(&mut self, side: Side, reason: String, ctx: &mut Ctx) {
        for seat in 0..self.n() {
            if self.is_wolf(seat) == (side == Side::Wolf) {
                *self.scores.entry(self.pids[seat]).or_default() += 1;
            }
        }
        ctx.announce(To::All, format!("{reason}！"), "ok");
        self.winner = Some(side);
        self.reason = Some(reason);
        self.batch.clear();
        self.skill_wait.clear();
        self.speakers.clear();
        self.set_stage(Stage::End, None, ctx);
    }

    fn deadline_passed(&mut self, ctx: &mut Ctx) {
        match self.stage.clone() {
            Stage::Peek => self.begin_night(ctx),
            Stage::Night => self.end_night(ctx),
            Stage::Witch => self.dawn(ctx),
            Stage::Dawn | Stage::Verdict => self.after_batch(ctx),
            Stage::Skill => self.begin_last_words(ctx),
            Stage::LastWords { .. } => self.next_speaker(ctx),
            Stage::Discuss => {
                let alive = self.alive_seats();
                self.begin_vote(alive.clone(), alive, false, ctx);
            }
            Stage::Vote { .. } => self.tally(ctx),
            Stage::End => {}
        }
    }

    // ---- 說法 ----

    fn claim(&mut self, seat: usize, said: Said) {
        self.claims.retain(|c| !(c.seat == seat && c.said == said));
        self.claims.push(Claim { seat, said });
    }

    fn claimed(&self, seat: usize, role: Role) -> bool {
        self.claims.iter().any(|c| c.seat == seat && c.said == Said::Role(role))
    }

    fn claimants(&self, role: Role) -> Vec<usize> {
        (0..self.n()).filter(|&s| self.claimed(s, role)).collect()
    }

    /// 從聊天裡認出「我是預言家」「3號是狼」「小明金水」「投小華」這類說法，記下來給電腦參考
    fn read_claims(&mut self, seat: usize, text: &str) {
        const ROLE_WORDS: [(Role, &[&str]); 6] = [
            (Role::Seer, &["預言家"]),
            (Role::Witch, &["女巫"]),
            (Role::Hunter, &["獵人"]),
            (Role::Guard, &["守衛"]),
            (Role::Villager, &["平民", "村民"]),
            (Role::Wolf, &["狼人"]),
        ];
        for (role, words) in ROLE_WORDS {
            // 自稱狼人多半是開玩笑，不記
            if role == Role::Wolf {
                continue;
            }
            let said = words
                .iter()
                .any(|w| ["我是", "我跳", "本人是", "我就是"].iter().any(|p| text.contains(&format!("{p}{w}"))));
            if said {
                self.claim(seat, Said::Role(role));
            }
        }

        let chars: Vec<char> = text.chars().map(halfwidth).collect();
        let mut mentions: Vec<(usize, usize, usize)> = Vec::new();
        let mut taken = vec![false; chars.len()];
        // 名字：長的先比，比到的字蓋掉（「電腦 10」不會被當成「電腦 1」）
        let mut order: Vec<usize> = (0..self.n()).collect();
        order.sort_by_key(|&s| Reverse(self.names[s].chars().count()));
        for s in order {
            let name: Vec<char> = self.names[s].chars().map(halfwidth).collect();
            if name.is_empty() || name.len() > chars.len() {
                continue;
            }
            let mut i = 0;
            while i + name.len() <= chars.len() {
                if chars[i..i + name.len()] == name[..] && !taken[i..i + name.len()].iter().any(|&t| t) {
                    taken[i..i + name.len()].fill(true);
                    mentions.push((i, i + name.len(), s));
                    i += name.len();
                } else {
                    i += 1;
                }
            }
        }
        // 「3號」「3 号」
        let mut i = 0;
        while i < chars.len() {
            if taken[i] || !chars[i].is_ascii_digit() {
                i += 1;
                continue;
            }
            let start = i;
            let mut number = 0usize;
            while i < chars.len() && chars[i].is_ascii_digit() && !taken[i] && i - start < 2 {
                number = number * 10 + chars[i].to_digit(10).unwrap_or(0) as usize;
                i += 1;
            }
            let mut j = i;
            while j < chars.len() && chars[j] == ' ' {
                j += 1;
            }
            if j < chars.len() && matches!(chars[j], '號' | '号') && (1..=self.n()).contains(&number) {
                mentions.push((start, j + 1, number - 1));
                i = j + 1;
            }
        }
        mentions.sort_by_key(|m| m.0);

        let has = |part: &[char], words: &[&str]| {
            let part: String = part.iter().collect();
            words.iter().any(|w| part.contains(w))
        };
        for (k, &(start, end, target)) in mentions.iter().enumerate() {
            if target == seat {
                continue;
            }
            let next = mentions.get(k + 1).map_or(chars.len(), |m| m.0);
            let prev = if k > 0 { mentions[k - 1].1 } else { 0 };
            let after = &chars[end..next.min(end + 8).max(end)];
            // 名字前面只看同一個短句（「12號查殺！3號好人」的「查殺」是在說 12 號）
            let mut from = prev.max(start.saturating_sub(4)).min(start);
            if let Some(p) = chars[from..start].iter().rposition(|c| "，。！？、；,.!?;".contains(*c)) {
                from += p + 1;
            }
            let before = &chars[from..start];
            // 名字後面說的優先，再看前面的「查殺 X」「投 X」「金水 X」
            let said = if has(after, &["不是狼", "不是壞人", "不像狼"]) {
                Some(Said::Good(target))
            } else if has(after, &["不是好人"]) {
                Some(Said::Wolf(target))
            } else if has(after, &["查殺", "狼", "壞人", "可疑"]) {
                Some(Said::Wolf(target))
            } else if has(after, &["金水", "好人", "清白"]) {
                Some(Said::Good(target))
            } else if has(before, &["查殺", "投"]) && !has(before, &["不投", "別投"]) {
                Some(Said::Wolf(target))
            } else if has(before, &["金水"]) {
                Some(Said::Good(target))
            } else {
                None
            };
            if let Some(said) = said {
                self.claim(seat, said);
            }
        }
    }

    /// 從 `viewer` 的角度看 `t` 有多像狼人（越大越像）；None 是只看公開說法的旁觀者
    fn suspicion(&self, viewer: Option<usize>, t: usize) -> f64 {
        if let Some(v) = viewer {
            if v == t {
                return -100.0;
            }
            match self.roles[v] {
                // 狼人：隊友不算，其他人照公開的說法（想跟著好人推）
                Role::Wolf => return if self.is_wolf(t) { -100.0 } else { self.suspicion(None, t) },
                Role::Seer => {
                    if let Some(c) = self.checks.iter().find(|c| c.seat == t) {
                        return if c.wolf { 100.0 } else { -100.0 };
                    }
                }
                _ => {}
            }
        }
        let my_role = viewer.map(|v| self.roles[v]);
        let seers = self.claimants(Role::Seer);
        let trust = |c: usize| -> f64 {
            if my_role == Some(Role::Seer) {
                // 我才是預言家，別人跳的都是假的
                return -0.6;
            }
            let base = 1.0 / seers.len().max(1) as f64;
            // 夜裡出局的預言家多半是真的（狼人才會刀他）
            if self.death_of(c).is_some_and(|d| matches!(d.cause, Cause::Knife | Cause::Poison)) {
                base * 1.5
            } else {
                base
            }
        };
        let mut score = 0.0;
        for c in &self.claims {
            if Some(c.seat) == viewer {
                continue;
            }
            match c.said {
                Said::Role(r) if c.seat == t && r != Role::Villager => {
                    if my_role == Some(r) {
                        score += 5.0;
                    } else if r == Role::Seer {
                        score += if seers.len() >= 2 { 1.0 } else { -1.0 };
                    } else if self.claimants(r).len() >= 2 {
                        score += 1.5;
                    } else {
                        score -= 0.5;
                    }
                }
                Said::Wolf(x) if x == t => score += if seers.contains(&c.seat) { 4.0 * trust(c.seat) } else { 0.6 },
                Said::Good(x) if x == t => score -= if seers.contains(&c.seat) { 3.0 * trust(c.seat) } else { 0.4 },
                _ => {}
            }
        }
        score
    }

    /// `pool` 裡分數最高的，分數加一點隨機
    fn pick(&self, pool: &[usize], noise: f64, ctx: &mut Ctx, score: impl Fn(usize) -> f64) -> Option<(f64, usize)> {
        let mut best: Option<(f64, usize)> = None;
        for &t in pool {
            let s = score(t) + ctx.rng.range(0.0, noise);
            if best.is_none_or(|(b, _)| s > b) {
                best = Some((s, t));
            }
        }
        best
    }

    // ---- 電腦玩家 ----

    fn bot_act(&mut self, seat: usize, ctx: &mut Ctx) {
        match self.stage.clone() {
            Stage::Peek => {
                self.ready[seat] = true;
                ctx.changed();
            }
            Stage::Night => self.bot_night(seat, ctx),
            Stage::Witch => self.bot_witch(seat, ctx),
            Stage::Skill => {
                let target = if self.can_shoot(seat) { self.bot_shot(seat, ctx) } else { None };
                let _ = self.shoot(seat, target, ctx);
                ctx.changed();
            }
            Stage::LastWords { at } if self.speakers.get(at) == Some(&seat) => {
                self.bot_last_words(seat, ctx);
                self.next_speaker(ctx);
            }
            Stage::Discuss if self.alive[seat] => {
                self.bot_talk(seat, ctx);
                self.ready[seat] = true;
                ctx.changed();
            }
            Stage::Vote { candidates, voters, .. } if voters.contains(&seat) => {
                let pick = self.bot_vote(seat, &candidates, ctx);
                self.votes[seat] = Some(pick);
                ctx.changed();
            }
            _ => {}
        }
    }

    fn bot_night(&mut self, seat: usize, ctx: &mut Ctx) {
        if !self.alive[seat] {
            return;
        }
        match self.roles[seat] {
            Role::Guard if self.night.guard.is_none() => {
                let target = self.bot_guard(seat, ctx);
                if self.guard(target).is_err() {
                    let _ = self.guard(None);
                }
            }
            Role::Seer if self.night.check.is_none() => {
                let pool: Vec<usize> = self
                    .alive_seats()
                    .into_iter()
                    .filter(|&t| t != seat && !self.checks.iter().any(|c| c.seat == t))
                    .collect();
                if let Some((_, t)) = self.pick(&pool, 1.5, ctx, |t| self.suspicion(None, t)) {
                    let _ = self.check(seat, t);
                }
            }
            Role::Wolf => {
                let (target, own) = self.bot_kill(seat, ctx);
                if self.night.kills[seat] != Some(target) {
                    self.night.kills[seat] = Some(target);
                    if ctx.rng.chance(if own { 0.7 } else { 0.4 }) {
                        let text = match target {
                            Some(t) if own => format!("刀 {} 吧", self.names[t]),
                            Some(t) => format!("好，刀 {}", self.names[t]),
                            None => "今晚空刀吧".to_owned(),
                        };
                        ctx.say(To::Seats(self.alive_wolves()), seat, text);
                    }
                }
            }
            _ => return,
        }
        ctx.changed();
        if self.stage == Stage::Night && self.night_done(ctx.now) {
            self.end_night(ctx);
        }
    }

    /// 守衛：只有一個人跳預言家就守他，不然一半機率守自己，或守一個看起來是好人的人
    fn bot_guard(&self, seat: usize, ctx: &mut Ctx) -> Option<usize> {
        let ok = |t: usize| self.alive[t] && Some(t) != self.last_guard;
        let seers: Vec<usize> = self.claimants(Role::Seer).into_iter().filter(|&s| self.alive[s]).collect();
        if seers.len() == 1 && seers[0] != seat && ok(seers[0]) {
            return Some(seers[0]);
        }
        if ok(seat) && ctx.rng.chance(0.5) {
            return Some(seat);
        }
        let pool: Vec<usize> =
            self.alive_seats().into_iter().filter(|&t| ok(t) && self.suspicion(Some(seat), t) < 1.0).collect();
        (!pool.is_empty()).then(|| pool[ctx.rng.below(pool.len())])
    }

    /// 電腦狼人刀誰：跟著隊友（真人優先）；自己挑時先刀跳神職的人和大家相信的人，避開跳出來的獵人。
    /// 第二個值表示是自己挑的
    fn bot_kill(&self, seat: usize, ctx: &mut Ctx) -> (Option<usize>, bool) {
        let mates: Vec<usize> = self.alive_wolves().into_iter().filter(|&w| w != seat).collect();
        if let Some(choice) = mates.iter().filter(|&&w| !self.bots[w]).find_map(|&w| self.night.kills[w]) {
            return (choice, false);
        }
        if let Some(choice) = mates.iter().find_map(|&w| self.night.kills[w]) {
            return (choice, false);
        }
        if let Some(mine) = self.night.kills[seat] {
            return (mine, true);
        }
        let pool: Vec<usize> = self.alive_seats().into_iter().filter(|&t| !self.is_wolf(t)).collect();
        let best = self.pick(&pool, 1.0, ctx, |t| {
            let mut score = -0.3 * self.suspicion(None, t);
            if self.claimed(t, Role::Seer) {
                score += 3.0;
            }
            if self.claimed(t, Role::Witch) || self.claimed(t, Role::Guard) {
                score += 2.0;
            }
            if self.claimed(t, Role::Hunter) {
                score -= 2.0;
            }
            score
        });
        (best.map(|b| b.1), true)
    }

    /// 女巫：第一晚幾乎一定救；之後救跳預言家或看起來是好人的人；確定誰是狼人才毒
    fn bot_witch(&mut self, seat: usize, ctx: &mut Ctx) {
        if !self.alive[seat] || self.roles[seat] != Role::Witch || self.night.witch_done {
            return;
        }
        if self.antidote
            && let Some(t) = self.night.kill
            && (t != seat || self.can_self_save())
        {
            let save = if self.day == 1 {
                ctx.rng.chance(0.9)
            } else {
                self.claimed(t, Role::Seer) || (self.suspicion(Some(seat), t) < -1.0 && ctx.rng.chance(0.6))
            };
            if save {
                let _ = self.witch(seat, Action::Save, ctx);
                return;
            }
        }
        if self.poison && self.day >= 2 {
            let pool: Vec<usize> = self.alive_seats().into_iter().filter(|&t| t != seat).collect();
            if let Some((score, t)) = self.pick(&pool, 0.5, ctx, |t| self.suspicion(Some(seat), t))
                && score >= 3.5
            {
                let _ = self.witch(seat, Action::Poison { seat: t }, ctx);
                return;
            }
        }
        let _ = self.witch(seat, Action::Pass, ctx);
    }

    /// 獵人開槍：夠可疑才帶走
    fn bot_shot(&self, seat: usize, ctx: &mut Ctx) -> Option<usize> {
        let pool: Vec<usize> = self.alive_seats().into_iter().filter(|&t| t != seat).collect();
        self.pick(&pool, 0.5, ctx, |t| self.suspicion(Some(seat), t)).filter(|(score, _)| *score >= 1.0).map(|b| b.1)
    }

    fn bot_vote(&self, seat: usize, candidates: &[usize], ctx: &mut Ctx) -> Option<usize> {
        let wolf = self.is_wolf(seat);
        let pool: Vec<usize> =
            candidates.iter().copied().filter(|&c| c != seat && !(wolf && self.is_wolf(c))).collect();
        self.pick(&pool, 1.5, ctx, |c| {
            let votes = self.votes.iter().filter(|v| **v == Some(Some(c))).count() as f64;
            let mut score = self.suspicion(Some(seat), c) + 0.5 * votes;
            // 狼人想推掉跳預言家的人
            if wolf && self.claimed(c, Role::Seer) {
                score += 2.0;
            }
            score
        })
        .map(|b| b.1)
    }

    fn bot_talk(&mut self, seat: usize, ctx: &mut Ctx) {
        let text = match self.roles[seat] {
            Role::Seer => self.seer_report(seat),
            Role::Wolf if self.fake_seer == Some(seat) => self.fake_report(seat, ctx),
            _ => self.opinion(seat, ctx),
        };
        ctx.say(To::All, seat, text);
    }

    /// 預言家報查驗結果，說出來的也記成說法
    fn seer_report(&mut self, seat: usize) -> String {
        self.claim(seat, Said::Role(Role::Seer));
        let checks = self.checks.clone();
        for c in &checks {
            self.claim(seat, if c.wolf { Said::Wolf(c.seat) } else { Said::Good(c.seat) });
        }
        let Some(last) = checks.last() else { return "我是預言家，還沒查到人".into() };
        let mut text =
            format!("我是預言家，第 {} 晚查驗 {}：{}", last.night, self.names[last.seat], verdict(last.wolf));
        if checks.len() > 1 {
            let earlier: Vec<String> = checks[..checks.len() - 1]
                .iter()
                .map(|c| format!("{} {}", self.names[c.seat], verdict(c.wolf)))
                .collect();
            text.push_str(&format!("（之前查過：{}）", earlier.join("、")));
        }
        text
    }

    /// 狼人假跳預言家：有人跳就查殺他（對跳），偶爾給隊友金水，不然隨便查殺一個好人
    fn fake_report(&mut self, seat: usize, ctx: &mut Ctx) -> String {
        let rivals: Vec<usize> = self.claimants(Role::Seer).into_iter().filter(|&c| c != seat).collect();
        self.claim(seat, Said::Role(Role::Seer));
        let named: Vec<usize> = self
            .claims
            .iter()
            .filter(|c| c.seat == seat)
            .filter_map(|c| match c.said {
                Said::Wolf(t) | Said::Good(t) => Some(t),
                Said::Role(_) => None,
            })
            .collect();
        let fresh = |t: &usize| self.alive[*t] && *t != seat && !named.contains(t);
        let rival = rivals.iter().copied().find(fresh);
        let mates: Vec<usize> = self.alive_wolves().into_iter().filter(fresh).collect();
        let others: Vec<usize> = self.alive_seats().into_iter().filter(|&t| !self.is_wolf(t) && fresh(&t)).collect();
        let (target, wolf) = if let Some(r) = rival {
            (r, true)
        } else if !mates.is_empty() && ctx.rng.chance(0.3) {
            (mates[ctx.rng.below(mates.len())], false)
        } else if !others.is_empty() {
            (others[ctx.rng.below(others.len())], ctx.rng.chance(0.7))
        } else {
            return "我是預言家，大家相信我".into();
        };
        self.claim(seat, if wolf { Said::Wolf(target) } else { Said::Good(target) });
        let me = if rivals.is_empty() { "我是預言家" } else { "我才是預言家" };
        format!("{me}，第 {} 晚查驗 {}：{}", self.day, self.names[target], verdict(wolf))
    }

    /// 平民（和其他不報查驗的人）的發言：說出最可疑的人，或跟著預言家
    fn opinion(&mut self, seat: usize, ctx: &mut Ctx) -> String {
        let pool: Vec<usize> =
            self.alive_seats().into_iter().filter(|&t| t != seat && !(self.is_wolf(seat) && self.is_wolf(t))).collect();
        let best = self.pick(&pool, 0.8, ctx, |t| self.suspicion(Some(seat), t));
        let seers: Vec<usize> = self.claimants(Role::Seer).into_iter().filter(|&c| c != seat).collect();
        match best {
            Some((score, t)) if score >= 2.0 => {
                self.claim(seat, Said::Wolf(t));
                let name = &self.names[t];
                match ctx.rng.below(3) {
                    0 => format!("我覺得 {name} 是狼"),
                    1 => format!("{name} 很像狼人，投他"),
                    _ => format!("我投 {name}，他是狼的機會很大"),
                }
            }
            Some((score, t)) if score >= 0.6 => {
                let name = &self.names[t];
                if ctx.rng.chance(0.5) {
                    format!("{name} 有點可疑")
                } else {
                    format!("先觀察 {name}，他的說法怪怪的")
                }
            }
            _ if seers.len() == 1 => format!("我相信 {} 的查驗", self.names[seers[0]]),
            _ => {
                const LINES: [&str; 5] = [
                    "我是好人，先聽聽大家怎麼說",
                    "昨晚的死訊看不太出什麼",
                    "沒什麼資訊，大家多說一點",
                    "我是平民，沒有特別的身分",
                    "預言家可以出來報一下嗎？",
                ];
                LINES[ctx.rng.below(LINES.len())].to_owned()
            }
        }
    }

    fn bot_last_words(&mut self, seat: usize, ctx: &mut Ctx) {
        let text = match self.roles[seat] {
            Role::Seer => {
                self.seer_report(seat);
                let all: Vec<String> =
                    self.checks.iter().map(|c| format!("{} {}", self.names[c.seat], verdict(c.wolf))).collect();
                if all.is_empty() {
                    "我是預言家，可惜還沒查到人".to_owned()
                } else {
                    format!("我是預言家，查驗結果：{}", all.join("、"))
                }
            }
            Role::Wolf if self.claimed(seat, Role::Seer) => "我才是真的預言家，大家相信我的查驗".to_owned(),
            Role::Witch => {
                self.claim(seat, Said::Role(Role::Witch));
                let mut used = Vec::new();
                for log in &self.nights {
                    if log.saved
                        && let Some(t) = log.kill
                    {
                        used.push(format!("第 {} 晚救了 {}", log.night, self.names[t]));
                    }
                    if let Some(t) = log.poison {
                        used.push(format!("第 {} 晚毒了 {}", log.night, self.names[t]));
                    }
                }
                if used.is_empty() {
                    "我是女巫，藥都還沒用".to_owned()
                } else {
                    format!("我是女巫，{}", used.join("、"))
                }
            }
            Role::Guard => {
                self.claim(seat, Said::Role(Role::Guard));
                "我是守衛，大家加油".to_owned()
            }
            Role::Hunter => {
                self.claim(seat, Said::Role(Role::Hunter));
                "我是獵人，剩下的交給你們了".to_owned()
            }
            _ => {
                let pool: Vec<usize> =
                    self.alive_seats().into_iter().filter(|&t| !(self.is_wolf(seat) && self.is_wolf(t))).collect();
                match self.pick(&pool, 0.5, ctx, |t| self.suspicion(Some(seat), t)) {
                    Some((score, t)) if score >= 1.0 => format!("我是好人。{} 最可疑，大家小心", self.names[t]),
                    _ => "我是好人，大家加油".to_owned(),
                }
            }
        };
        ctx.say(To::All, seat, text);
    }

    // ---- 畫面 ----

    fn my_view(&self, s: usize) -> Value {
        let role = self.roles[s];
        let alive = self.alive[s];
        let wolf = role == Role::Wolf;
        let witch_stage = self.stage == Stage::Witch;
        let night_done = match role {
            Role::Guard => self.night.guard.is_some(),
            Role::Seer => self.night.check.is_some(),
            Role::Wolf => self.night.kills.get(s).is_some_and(Option::is_some),
            Role::Witch => self.night.witch_done,
            _ => true,
        };
        json!({
            "role": role,
            "alive": alive,
            "nightDone": night_done,
            "suspect": self.suspects[s],
            "wolves": wolf.then(|| (0..self.n()).filter(|&w| self.is_wolf(w)).collect::<Vec<_>>()),
            "kills": (wolf && alive && self.stage == Stage::Night).then(|| {
                self.alive_wolves()
                    .into_iter()
                    .map(|w| json!({ "seat": w, "voted": self.night.kills[w].is_some(), "target": self.night.kills[w].flatten() }))
                    .collect::<Vec<_>>()
            }),
            "decided": (wolf && alive && witch_stage).then(|| json!({ "target": self.night.kill })),
            "guard": (role == Role::Guard).then(|| json!({
                "last": self.last_guard,
                "decided": self.night.guard.is_some(),
                "pick": self.night.guard.flatten(),
                "history": self.nights.iter().map(|l| json!({ "night": l.night, "seat": l.guard })).collect::<Vec<_>>(),
            })),
            "checks": (role == Role::Seer).then_some(&self.checks),
            "checked": (role == Role::Seer).then_some(self.night.check).flatten(),
            "witch": (role == Role::Witch).then(|| {
                let known = alive && witch_stage && self.night.victim_known;
                json!({
                    "antidote": self.antidote,
                    "poison": self.poison,
                    "victimKnown": known,
                    "victim": if known { self.night.kill } else { None },
                    "canSelfSave": self.can_self_save(),
                    "done": self.night.witch_done,
                    "history": self.nights
                        .iter()
                        .filter(|l| l.saved || l.poison.is_some())
                        .map(|l| json!({ "night": l.night, "saved": if l.saved { l.kill } else { None }, "poisoned": l.poison }))
                        .collect::<Vec<_>>(),
                })
            }),
            "skill": self.skill_wait.contains(&s).then(|| json!({
                "hunter": role == Role::Hunter,
                "canShoot": self.can_shoot(s),
            })),
        })
    }
}

/// 全形數字轉半形，比對「３號」用
fn halfwidth(c: char) -> char {
    match c {
        '０'..='９' => char::from_u32(c as u32 - '０' as u32 + '0' as u32).unwrap_or(c),
        '　' => ' ',
        _ => c,
    }
}

fn verdict(wolf: bool) -> &'static str {
    if wolf { "狼人！" } else { "好人" }
}

impl PartyGame for Werewolf {
    const ID: &'static str = "werewolf";
    const MIN_PLAYERS: usize = 6;
    const MAX_PLAYERS: usize = 12;
    const MAX_BOTS: usize = 11;

    type Options = Options;
    type Action = Action;

    fn rooms(state: &AppState) -> &Arc<Parties<Self>> {
        &state.werewolf
    }

    fn check_options(mut options: Options) -> Result<Options, String> {
        options.wolves = options.wolves.clamp(1, 5);
        options.night_secs = options.night_secs.clamp(20, 120);
        options.discuss_secs = options.discuss_secs.clamp(60, 900);
        Ok(options)
    }

    fn can_start(options: &Options, players: usize) -> Result<(), String> {
        options.lineup(players).map(|_| ())
    }

    fn start(options: &Options, previous: Option<&Self>, ctx: &mut Ctx) -> Self {
        let n = ctx.seats.len();
        let lineup = options.lineup(n).unwrap_or_else(|_| Lineup::preset(n));
        let mut roles = lineup.roles();
        shuffle(ctx.rng, &mut roles);
        let wolf_bots: Vec<usize> = (0..n).filter(|&s| roles[s] == Role::Wolf && ctx.seats[s].bot).collect();
        let fake_seer = (lineup.seer && !wolf_bots.is_empty() && ctx.rng.chance(0.35))
            .then(|| wolf_bots[ctx.rng.below(wolf_bots.len())]);
        let mut game = Self {
            options: options.clone(),
            lineup,
            pids: ctx.seats.iter().map(|s| s.pid).collect(),
            names: ctx.seats.iter().map(|s| s.name.clone()).collect(),
            bots: ctx.seats.iter().map(|s| s.bot).collect(),
            online: ctx.seats.iter().map(|s| s.online).collect(),
            roles,
            alive: vec![true; n],
            day: 0,
            stage: Stage::Peek,
            deadline: None,
            stage_started: ctx.now,
            ready: vec![false; n],
            night: Night::new(n),
            last_guard: None,
            antidote: true,
            poison: true,
            checks: Vec::new(),
            suspects: vec![None; n],
            nights: Vec::new(),
            deaths: Vec::new(),
            batch: Vec::new(),
            then: Then::Discuss,
            skill_wait: Vec::new(),
            speakers: Vec::new(),
            shots: Vec::new(),
            votes: vec![None; n],
            tallies: Vec::new(),
            claims: Vec::new(),
            winner: None,
            reason: None,
            scores: previous.map(|p| p.scores.clone()).unwrap_or_default(),
            bot_at: vec![None; n],
            fake_seer,
        };
        ctx.system(To::All, format!("新的一局，{n} 人：{}。先看看你的身分，狼人會看到隊友", lineup.describe()));
        game.set_stage(Stage::Peek, Some(PEEK), ctx);
        game
    }

    fn act(&mut self, seat: usize, action: Action, ctx: &mut Ctx) -> Result<(), String> {
        let now = ctx.now;
        let alive = self.alive[seat];
        let role = self.roles[seat];
        let result = match (action, self.stage.clone()) {
            (Action::Ready, Stage::Peek) => {
                self.ready[seat] = true;
                if self.all_ready(now) {
                    self.begin_night(ctx);
                }
                Ok(())
            }
            (Action::Ready, Stage::Discuss) if alive => {
                if self.options.offline {
                    return Err("線下模式由房主按「開始投票」".into());
                }
                self.ready[seat] = true;
                if self.all_ready(now) {
                    self.deadline_passed(ctx);
                }
                Ok(())
            }
            (Action::Advance, Stage::Discuss) if self.options.offline => {
                self.deadline_passed(ctx);
                Ok(())
            }
            (Action::Advance, Stage::LastWords { .. }) if self.options.offline => {
                self.next_speaker(ctx);
                Ok(())
            }
            (Action::Done, Stage::LastWords { .. }) if self.speaker() == Some(seat) => {
                self.next_speaker(ctx);
                Ok(())
            }
            (Action::Shoot { seat: target }, Stage::Skill) => self.shoot(seat, target, ctx),
            (_, _) if !alive => Err("你已經出局了，可以和其他出局、觀戰的人聊天".into()),
            (Action::Guard { seat: target }, Stage::Night) if role == Role::Guard => self.guard(target),
            (Action::Kill { seat: target }, Stage::Night) if role == Role::Wolf => self.wolf_vote(seat, target, ctx),
            (Action::Check { seat: target }, Stage::Night) if role == Role::Seer => self.check(seat, target),
            (Action::Suspect { seat: target }, Stage::Night | Stage::Witch) => {
                if let Some(t) = target
                    && (t == seat || t >= self.n() || !self.alive[t])
                {
                    return Err("請選另一位還活著的玩家".into());
                }
                self.suspects[seat] = target;
                Ok(())
            }
            (action @ (Action::Save | Action::Poison { .. } | Action::Pass), Stage::Witch) if role == Role::Witch => {
                self.witch(seat, action, ctx)
            }
            (Action::Vote { seat: target }, Stage::Vote { candidates, voters, .. }) => {
                if !voters.contains(&seat) {
                    return Err("你在平票名單上，這輪不能投票".into());
                }
                if let Some(t) = target {
                    if t == seat {
                        return Err("不能投自己".into());
                    }
                    if !candidates.contains(&t) {
                        return Err("只能投還活著的人（重投時是平票的人）".into());
                    }
                }
                self.votes[seat] = Some(target);
                if self.all_voted(now) {
                    self.tally(ctx);
                }
                Ok(())
            }
            (_, Stage::Night | Stage::Witch) => Err("現在不是你行動的時候".into()),
            _ => Err("現在不能這樣做".into()),
        };
        if result.is_ok() && self.stage == Stage::Night && self.night_done(now) {
            self.end_night(ctx);
        }
        result
    }

    fn tick(&mut self, ctx: &mut Ctx) {
        for seat in 0..self.bot_at.len() {
            if self.bot_at[seat].is_some_and(|t| ctx.now >= t) {
                self.bot_at[seat] = None;
                self.bot_act(seat, ctx);
            }
        }
        let now = ctx.now;
        match &self.stage {
            Stage::Peek if self.all_ready(now) => self.deadline_passed(ctx),
            Stage::Night if self.night_done(now) => self.end_night(ctx),
            Stage::Witch if self.witch_can_act() && self.alive_role(Role::Witch).is_some_and(|w| self.away(w, now)) => {
                self.dawn(ctx)
            }
            Stage::Skill if self.skill_wait.iter().all(|&s| self.away(s, now)) => self.begin_last_words(ctx),
            Stage::LastWords { at } if self.away(self.speakers[*at], now) => self.next_speaker(ctx),
            Stage::Discuss if !self.options.offline && self.all_ready(now) => self.deadline_passed(ctx),
            Stage::Vote { .. } if self.all_voted(now) => self.tally(ctx),
            _ if self.deadline.is_some_and(|d| now >= d) => self.deadline_passed(ctx),
            _ => {}
        }
    }

    fn chat(&mut self, seat: Option<usize>, text: &str, ctx: &mut Ctx) -> Chat {
        if self.stage == Stage::End {
            return Chat::Show;
        }
        // 觀戰的人只能跟出局（手上沒事）的人聊，不影響場上
        let Some(s) = seat else { return Chat::Only(To::SeatsAndSpectators(self.ghosts())) };
        if !self.alive[s] {
            if self.speaker() == Some(s) {
                self.read_claims(s, text);
                return Chat::Show;
            }
            if self.pending(s) {
                ctx.system(To::Seat(s), "你剛出局，等輪到你的遺言再說（沒有遺言的話，之後可以和出局、觀戰的人聊天）");
                return Chat::Drop;
            }
            return Chat::Only(To::SeatsAndSpectators(self.ghosts()));
        }
        match self.stage {
            Stage::Night | Stage::Witch if self.is_wolf(s) => Chat::Only(To::Seats(self.alive_wolves())),
            Stage::Night | Stage::Witch => {
                ctx.system(To::Seat(s), "天黑了，夜晚只有狼人能私下交談，這句沒有送出");
                Chat::Drop
            }
            Stage::Peek => Chat::Show,
            _ => {
                self.read_claims(s, text);
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
        let wolf_view = seat.is_some_and(|s| self.is_wolf(s));
        let seats: Vec<Value> = (0..n)
            .map(|s| {
                let known = ended
                    || seat == Some(s)
                    || (wolf_view && self.is_wolf(s))
                    || (self.options.reveal && !self.alive[s])
                    || self.shots.iter().any(|x| x.hunter == s);
                json!({
                    "alive": self.alive[s],
                    "online": self.online[s],
                    "role": known.then_some(self.roles[s]),
                    "ready": self.ready[s],
                    "voted": matches!(self.stage, Stage::Vote { .. }) && self.votes[s].is_some(),
                    "points": self.scores.get(&self.pids[s]).copied().unwrap_or(0),
                })
            })
            .collect();
        let vote = match &self.stage {
            Stage::Vote { candidates, voters, revote } => Some(json!({
                "candidates": candidates,
                "voters": voters,
                "revote": revote,
                "voted": seat.is_some_and(|s| self.votes[s].is_some()),
                "mine": seat.and_then(|s| self.votes[s]).flatten(),
            })),
            _ => None,
        };
        let deaths: Vec<Value> = self
            .deaths
            .iter()
            .map(|d| json!({ "day": d.day, "seat": d.seat, "when": d.cause.when(), "cause": ended.then_some(d.cause) }))
            .collect();
        json!({
            "stage": self.stage.name(),
            "endsIn": self.deadline.map(|d| d.saturating_duration_since(now).as_millis() as u64),
            "day": self.day,
            "options": self.options,
            "lineup": self.lineup,
            "you": seat,
            "me": seat.map(|s| self.my_view(s)),
            "seats": seats,
            "deaths": deaths,
            "shots": self.shots,
            "batch": self.batch,
            "skillWait": self.skill_wait,
            "speaker": self.speaker(),
            "speakers": self.speakers,
            "vote": vote,
            "tallies": self.tallies,
            "result": self.winner.map(|w| json!({ "winner": w, "reason": self.reason })),
            "nights": if ended { json!(self.nights) } else { Value::Null },
        })
    }

    fn finished(&self) -> bool {
        self.stage == Stage::End
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::party::{Outbox, Rng, SeatInfo, test_ctx};
    use Role::{Guard as GUARD, Hunter as HUNTER, Seer as SEER, Villager as VIL, Witch as WITCH, Wolf as WOLF};

    const EIGHT: [Role; 8] = [WOLF, WOLF, SEER, WITCH, HUNTER, GUARD, VIL, VIL];
    const NIGHT: Duration = Duration::from_secs(45);

    fn seats(n: usize, bots: usize) -> Vec<SeatInfo> {
        (0..n)
            .map(|i| SeatInfo { pid: i as u32 + 1, name: format!("P{i}"), bot: i >= n - bots, online: true })
            .collect()
    }

    fn lineup_of(roles: &[Role]) -> Lineup {
        let count = |r: Role| roles.iter().filter(|&&x| x == r).count();
        Lineup {
            wolves: count(WOLF),
            villagers: count(VIL),
            seer: count(SEER) > 0,
            witch: count(WITCH) > 0,
            hunter: count(HUNTER) > 0,
            guard: count(GUARD) > 0,
        }
    }

    fn start(n: usize, bots: usize, options: &Options, now: Instant, rng: &mut Rng) -> (Werewolf, Vec<SeatInfo>) {
        let seats = seats(n, bots);
        let mut out = Outbox::default();
        let g = Werewolf::start(options, None, &mut test_ctx(now, rng, &seats, &mut out));
        (g, seats)
    }

    /// 固定角色（座位 i 是 `roles[i]`）的一局；最後 `bots` 個座位是電腦
    struct T {
        g: Werewolf,
        seats: Vec<SeatInfo>,
        rng: Rng,
        now: Instant,
    }

    impl T {
        fn new(roles: &[Role], options: Options) -> Self {
            Self::with_bots(roles, options, 0)
        }

        fn with_bots(roles: &[Role], options: Options, bots: usize) -> Self {
            let mut rng = Rng::new();
            let now = Instant::now();
            let (mut g, seats) = start(roles.len(), bots, &options, now, &mut rng);
            g.roles = roles.to_vec();
            g.lineup = lineup_of(roles);
            g.fake_seer = None;
            T { g, seats, rng, now }
        }

        fn run<R>(&mut self, f: impl FnOnce(&mut Werewolf, &mut Ctx) -> R) -> R {
            let mut out = Outbox::default();
            let mut ctx = test_ctx(self.now, &mut self.rng, &self.seats, &mut out);
            f(&mut self.g, &mut ctx)
        }

        fn act(&mut self, seat: usize, action: Action) -> Result<(), String> {
            self.run(|g, ctx| g.act(seat, action, ctx))
        }

        fn ok(&mut self, seat: usize, action: Action) {
            self.act(seat, action).unwrap();
        }

        fn tick_after(&mut self, wait: Duration) {
            self.now += wait;
            self.run(|g, ctx| g.tick(ctx));
        }

        fn night(&mut self) {
            self.run(|g, ctx| g.begin_night(ctx));
        }

        fn view(&self, seat: Option<usize>) -> Value {
            self.g.view(seat, self.now)
        }

        fn chat(&mut self, seat: Option<usize>, text: &str) -> Chat {
            self.run(|g, ctx| g.chat(seat, text, ctx))
        }

        fn kill(&mut self, wolves: &[usize], target: Option<usize>) {
            for &w in wolves {
                self.ok(w, Action::Kill { seat: target });
            }
        }

        fn vote_all(&mut self, ballots: &[(usize, Option<usize>)]) {
            for &(s, b) in ballots {
                self.ok(s, Action::Vote { seat: b });
            }
        }
    }

    fn ghosts_are(chat: Chat, expected: &[usize]) -> bool {
        matches!(chat, Chat::Only(To::SeatsAndSpectators(ref v)) if v == expected)
    }

    #[test]
    fn presets_and_custom_lineups() {
        for n in 6..=12 {
            let l = Lineup::preset(n);
            assert_eq!(l.roles().len(), n, "{n} 人");
            assert!(l.wolves * 2 < n && l.villagers >= 1 && l.seer && l.witch, "{n} 人：{l:?}");
            assert_eq!(Options::default().lineup(n), Ok(l));
        }
        assert_eq!(Lineup::preset(12).describe(), "4 狼人、4 平民、預言家、女巫、獵人、守衛");

        let custom = |wolves: u8, guard: bool| Options { custom: true, wolves, guard, ..Options::default() };
        assert!(custom(3, false).lineup(6).is_err(), "6 人不能 3 狼");
        assert_eq!(custom(2, true).lineup(8).map(|l| l.villagers), Ok(2));
        assert!(custom(2, true).lineup(6).is_err(), "沒有平民，屠邊不行");
        assert!(Options { win: Win::All, ..custom(2, true) }.lineup(6).is_ok(), "屠城可以沒有平民");
        let no_gods = Options { seer: false, witch: false, hunter: false, ..custom(2, false) };
        assert!(no_gods.lineup(8).is_err(), "沒有神職，屠邊不行");
        assert!(Options { win: Win::All, ..no_gods }.lineup(8).is_ok());
        assert!(custom(5, true).lineup(9).is_err());
        assert!(Werewolf::can_start(&custom(3, true), 6).is_err());
        assert!(Werewolf::can_start(&Options::default(), 6).is_ok());

        let fixed =
            Werewolf::check_options(Options { wolves: 9, night_secs: 1, discuss_secs: 5000, ..Options::default() })
                .unwrap();
        assert_eq!((fixed.wolves, fixed.night_secs, fixed.discuss_secs), (5, 20, 900));
    }

    #[test]
    fn roles_and_night_results_stay_hidden() {
        for n in 6..=12 {
            let mut rng = Rng::new();
            let now = Instant::now();
            let (g, _) = start(n, 0, &Options::default(), now, &mut rng);
            let mut roles = g.roles.clone();
            roles.sort_by_key(|r| *r as u8);
            let mut expected = Lineup::preset(n).roles();
            expected.sort_by_key(|r| *r as u8);
            assert_eq!(roles, expected);
            let wolves: Vec<usize> = (0..n).filter(|&s| g.is_wolf(s)).collect();
            for me in 0..n {
                let view = g.view(Some(me), now);
                assert_eq!(view["me"]["role"], json!(g.roles[me]));
                for other in 0..n {
                    let sees = other == me || (wolves.contains(&me) && wolves.contains(&other));
                    assert_eq!(view["seats"][other]["role"].is_null(), !sees, "座位 {me} 看座位 {other}");
                }
            }
            let spectator = g.view(None, now);
            assert!(spectator["me"].is_null());
            assert!(spectator["seats"].as_array().unwrap().iter().all(|s| s["role"].is_null()));
        }

        let mut t = T::new(&EIGHT, Options::default());
        t.night();
        t.ok(2, Action::Check { seat: 0 });
        t.ok(0, Action::Kill { seat: Some(6) });
        // 狼人的票只有狼人看得到，查驗結果只有預言家看得到
        assert_eq!(t.view(Some(1))["me"]["kills"][0]["target"], 6);
        for s in [Some(2), Some(6), None] {
            assert!(t.view(s)["me"]["kills"].is_null());
        }
        assert_eq!(t.view(Some(2))["me"]["checks"][0]["wolf"], true);
        assert!(t.view(Some(3))["me"]["checks"].is_null());
        t.ok(1, Action::Kill { seat: Some(6) });
        t.ok(5, Action::Guard { seat: None });
        assert_eq!(t.g.stage, Stage::Witch);
        // 刀口只有女巫看得到
        assert_eq!(t.view(Some(3))["me"]["witch"]["victim"], 6);
        for s in [Some(2), Some(5), Some(6), None] {
            assert!(!t.view(s).to_string().contains("victim"));
        }
        assert!(t.view(Some(6))["nights"].is_null(), "夜晚紀錄結束後才公開");
        t.ok(3, Action::Pass);
        let view = t.view(None);
        assert_eq!(view["deaths"][0]["when"], "night");
        assert!(view["deaths"][0]["cause"].is_null(), "對局中不公開死因");
    }

    #[test]
    fn guard_witch_and_poison() {
        let mut t = T::new(&EIGHT, Options::default());
        // 第一晚：守衛守 6，狼人刀 6 → 平安夜
        t.night();
        assert_eq!(t.act(6, Action::Kill { seat: Some(7) }), Err("現在不是你行動的時候".into()));
        t.ok(5, Action::Guard { seat: Some(6) });
        t.ok(2, Action::Check { seat: 0 });
        assert_eq!(t.act(2, Action::Check { seat: 1 }), Err("今晚已經查驗過了".into()));
        t.ok(0, Action::Kill { seat: Some(6) });
        assert_eq!(t.g.stage, Stage::Night, "狼人還沒全部投同一個人");
        t.ok(1, Action::Kill { seat: Some(6) });
        assert_eq!(t.g.stage, Stage::Witch);
        assert_eq!(t.act(2, Action::Pass), Err("現在不是你行動的時候".into()));
        t.ok(3, Action::Pass);
        assert_eq!(t.g.stage, Stage::Dawn);
        assert!(t.g.alive.iter().all(|&a| a), "守衛擋下來了");

        // 第二晚：不能連守；同守同救還是會死
        t.night();
        assert_eq!(t.act(5, Action::Guard { seat: Some(6) }), Err("不能連續兩晚守同一個人".into()));
        t.ok(5, Action::Guard { seat: Some(7) });
        assert_eq!(t.act(2, Action::Check { seat: 0 }), Err("這個人已經查驗過了".into()));
        t.ok(2, Action::Check { seat: 1 });
        t.kill(&[0, 1], Some(7));
        t.ok(3, Action::Save);
        assert!(!t.g.alive[7], "同守同救");
        assert!(!t.g.antidote);

        // 第三晚：解藥用過了看不到刀口；毒死獵人，獵人不能開槍
        t.night();
        t.ok(5, Action::Guard { seat: None });
        t.ok(2, Action::Check { seat: 3 });
        t.kill(&[0, 1], Some(2));
        let witch = t.view(Some(3));
        assert_eq!(witch["me"]["witch"]["victimKnown"], false);
        assert!(witch["me"]["witch"]["victim"].is_null());
        assert_eq!(t.act(3, Action::Save), Err("解藥已經用過了".into()));
        assert_eq!(t.act(3, Action::Poison { seat: 3 }), Err("不能毒自己".into()));
        t.ok(3, Action::Poison { seat: 4 });
        assert_eq!(t.g.alive, [true, true, false, true, false, true, true, false]);
        assert_eq!(t.g.nights[2].deaths, [2, 4]);
        t.tick_after(DAWN);
        assert_eq!(t.g.stage, Stage::Skill);
        assert_eq!(t.view(Some(4))["me"]["skill"]["canShoot"], false);
        assert_eq!(t.act(4, Action::Shoot { seat: Some(0) }), Err("你被毒死了，不能開槍".into()));
        assert_eq!(t.act(2, Action::Shoot { seat: Some(0) }), Err("你沒有可以發動的技能".into()));
        t.ok(2, Action::Shoot { seat: None });
        t.ok(4, Action::Shoot { seat: None });
        assert_eq!(t.g.stage, Stage::Discuss, "第三晚出局的人沒有遺言");
    }

    #[test]
    fn hunter_shoots_and_last_words() {
        let roles = [WOLF, WOLF, SEER, WITCH, HUNTER, VIL, VIL];
        let mut t = T::new(&roles, Options::default());
        t.night();
        t.ok(2, Action::Check { seat: 5 });
        t.kill(&[0, 1], Some(4));
        t.ok(3, Action::Pass);
        t.tick_after(DAWN);
        assert_eq!(t.g.stage, Stage::Skill);
        assert_eq!(t.g.skill_wait, [4]);
        // 技能還沒確認的人不能聊天，觀戰的人也碰不到他
        assert!(matches!(t.chat(Some(4), "嗨"), Chat::Drop));
        assert!(ghosts_are(t.chat(None, "嗨"), &[]));
        assert_eq!(t.view(Some(4))["me"]["skill"]["canShoot"], true);
        assert_eq!(t.act(4, Action::Shoot { seat: Some(4) }), Err("請選一位還活著的玩家".into()));
        t.ok(4, Action::Shoot { seat: Some(0) });
        assert!(!t.g.alive[0]);
        assert_eq!(t.view(Some(6))["seats"][4]["role"], "hunter", "開槍的獵人公開身分");
        assert!(t.view(Some(6))["seats"][0]["role"].is_null(), "被帶走的人不公開身分");

        // 第一晚出局的人和被帶走的人都有遺言
        assert_eq!(t.g.stage, Stage::LastWords { at: 0 });
        assert_eq!(t.g.speakers, [4, 0]);
        assert!(matches!(t.chat(Some(4), "我是獵人"), Chat::Show));
        assert!(matches!(t.chat(Some(0), "等等"), Chat::Drop));
        assert!(t.act(0, Action::Done).is_err());
        t.ok(4, Action::Done);
        assert_eq!(t.g.stage, Stage::LastWords { at: 1 });
        // 講完遺言就可以和觀戰的人聊
        assert!(ghosts_are(t.chat(Some(4), "嗨"), &[4]));
        t.tick_after(LAST_WORDS);
        assert_eq!(t.g.stage, Stage::Discuss);
        assert!(ghosts_are(t.chat(Some(0), "嗨"), &[0, 4]));
    }

    #[test]
    fn witch_self_save_rules() {
        for (rule, first, later) in
            [(SelfSave::Never, false, false), (SelfSave::FirstNight, true, false), (SelfSave::Always, true, true)]
        {
            let mut t = T::new(&EIGHT, Options { self_save: rule, ..Options::default() });
            for (night, allowed) in [(0, first), (1, later)] {
                t.night();
                t.g.antidote = true;
                t.ok(5, Action::Guard { seat: None });
                t.ok(2, Action::Check { seat: night });
                t.kill(&[0, 1], Some(3));
                assert_eq!(t.act(3, Action::Save).is_ok(), allowed, "{rule:?} 第 {} 晚", night + 1);
                if !allowed {
                    t.ok(3, Action::Pass);
                }
                assert_eq!(t.g.alive[3], allowed);
                t.g.alive[3] = true;
                t.g.deaths.clear();
            }
        }
    }

    #[test]
    fn wolves_decide_by_majority_or_random() {
        let roles = [WOLF, WOLF, WOLF, SEER, WITCH, HUNTER, VIL, VIL, VIL];
        let mut t = T::new(&roles, Options::default());
        t.night();
        t.kill(&[0, 1], Some(6));
        t.ok(2, Action::Kill { seat: Some(7) });
        t.tick_after(NIGHT);
        assert_eq!(t.g.night.kill, Some(6), "多數");

        for _ in 0..20 {
            let mut t = T::new(&roles, Options::default());
            t.night();
            t.ok(0, Action::Kill { seat: Some(6) });
            t.ok(1, Action::Kill { seat: Some(7) });
            t.tick_after(NIGHT);
            assert!(matches!(t.g.night.kill, Some(6 | 7)), "平手隨機");

            let mut t = T::new(&roles, Options::default());
            t.night();
            t.tick_after(NIGHT);
            assert!(t.g.night.kill.is_some_and(|k| !t.g.is_wolf(k)), "沒人投就隨機刀一個好人");
        }

        let mut t = T::new(&roles, Options::default());
        t.night();
        t.ok(3, Action::Check { seat: 0 });
        t.kill(&[0, 1, 2], None);
        assert_eq!(t.g.stage, Stage::Witch, "一起空刀");
        assert_eq!(t.g.night.kill, None);
        assert_eq!(t.act(4, Action::Save), Err("今晚沒有人被刀".into()));
        t.ok(4, Action::Pass);
        assert!(t.g.alive.iter().all(|&a| a), "平安夜");
    }

    #[test]
    fn exile_votes_and_ties() {
        let mut t = T::new(&EIGHT, Options::default());
        t.g.day = 1;
        t.run(|g, ctx| g.begin_discuss(ctx));
        assert_eq!(t.act(0, Action::Advance), Err("現在不能這樣做".into()), "線上模式不能由房主跳過討論");
        for s in 0..8 {
            t.ok(s, Action::Ready);
        }
        assert!(matches!(t.g.stage, Stage::Vote { revote: false, .. }), "大家都按了就提早投票");
        assert_eq!(t.act(0, Action::Vote { seat: Some(0) }), Err("不能投自己".into()));
        t.vote_all(&[(0, Some(5)), (1, Some(5)), (2, Some(6)), (3, Some(6)), (4, None), (5, Some(0)), (6, Some(1))]);
        assert!(matches!(t.g.stage, Stage::Vote { revote: false, .. }), "還有人沒投");
        t.vote_all(&[(7, None)]);
        let Stage::Vote { candidates, voters, revote } = t.g.stage.clone() else { panic!("平票要重投") };
        assert!(revote);
        assert_eq!(candidates, [5, 6]);
        assert_eq!(voters, [0, 1, 2, 3, 4, 7]);
        assert_eq!(t.act(5, Action::Vote { seat: Some(6) }), Err("你在平票名單上，這輪不能投票".into()));
        assert!(t.act(0, Action::Vote { seat: Some(1) }).is_err(), "重投只能投平票的人");
        t.vote_all(&[(0, Some(5)), (1, Some(6)), (2, None), (3, None), (4, None), (7, None)]);
        assert_eq!(t.g.stage, Stage::Verdict, "又平票就沒人出局");
        assert!(t.g.alive.iter().all(|&a| a));
        assert_eq!(t.g.tallies.len(), 2);
        assert_eq!(t.g.tallies[0].ballots[5], Some(0));
        t.tick_after(VERDICT);
        assert_eq!((t.g.stage.clone(), t.g.day), (Stage::Night, 2));

        // 平票直接沒人出局
        let mut t = T::new(&EIGHT, Options { tie: Tie::NoExile, ..Options::default() });
        t.g.day = 1;
        let all: Vec<usize> = (0..8).collect();
        t.run(|g, ctx| g.begin_vote(all.clone(), all.clone(), false, ctx));
        t.vote_all(&[(0, Some(5)), (1, Some(6)), (2, None), (3, None), (4, None), (5, None), (6, None), (7, None)]);
        assert_eq!(t.g.stage, Stage::Verdict);
        assert_eq!(t.g.tallies.len(), 1);

        // 多數放逐：有獵人的局要確認技能，白天出局有遺言，然後天黑
        t.run(|g, ctx| g.begin_vote(all.clone(), all.clone(), false, ctx));
        for s in 0..8 {
            t.ok(s, Action::Vote { seat: Some(if s == 6 { 7 } else { 6 }) });
        }
        assert!(!t.g.alive[6]);
        assert_eq!(t.g.tallies[1].out, Some(6));
        assert_eq!(t.g.stage, Stage::Verdict);
        t.tick_after(VERDICT);
        assert_eq!(t.g.stage, Stage::Skill);
        t.ok(6, Action::Shoot { seat: None });
        assert_eq!(t.g.stage, Stage::LastWords { at: 0 });
        t.ok(6, Action::Done);
        assert_eq!(t.g.stage, Stage::Night);
    }

    #[test]
    fn win_conditions() {
        let mut t = T::new(&EIGHT, Options::default());
        let winner = |t: &T| t.g.winner_now().map(|w| w.0);
        assert_eq!(winner(&t), None);
        t.g.alive[6] = false;
        t.g.alive[7] = false;
        assert_eq!(winner(&t), Some(Side::Wolf), "屠邊：平民全部出局");
        t.g.alive[6] = true;
        t.g.alive[7] = true;
        for s in 2..6 {
            t.g.alive[s] = false;
        }
        assert_eq!(winner(&t), Some(Side::Wolf), "屠邊：神職全部出局");
        t.g.options.win = Win::All;
        assert_eq!(winner(&t), None, "屠城還要殺光平民");
        t.g.alive[6] = false;
        t.g.alive[7] = false;
        assert_eq!(winner(&t), Some(Side::Wolf));
        t.g.alive[0] = false;
        t.g.alive[1] = false;
        assert_eq!(winner(&t), Some(Side::Good), "狼人也全部出局時算好人贏");

        // 夜裡結算時分出勝負就直接結束
        let mut t = T::new(&EIGHT, Options::default());
        t.g.alive[7] = false;
        t.night();
        t.ok(5, Action::Guard { seat: None });
        t.ok(2, Action::Check { seat: 0 });
        t.kill(&[0, 1], Some(6));
        t.ok(3, Action::Pass);
        assert_eq!(t.g.winner, Some(Side::Wolf));
        assert!(t.g.finished());
        assert_eq!(t.view(Some(6))["seats"][0]["role"], "wolf", "結束後公開身分");
        assert!(!t.view(None)["nights"].is_null());
        assert_eq!(t.g.scores.get(&1), Some(&1), "贏的人加分");

        let mut t = T::new(&EIGHT, Options::default());
        t.g.day = MAX_DAYS;
        t.night();
        assert_eq!(t.g.winner, Some(Side::Wolf), "打太多天算狼人贏");
    }

    #[test]
    fn who_can_see_chat() {
        let mut t = T::new(&EIGHT, Options::default());
        assert!(matches!(t.chat(Some(6), "大家好"), Chat::Show));
        t.night();
        assert!(matches!(t.chat(Some(0), "刀誰"), Chat::Only(To::Seats(ref v)) if *v == [0, 1]));
        assert!(matches!(t.chat(Some(6), "嗨"), Chat::Drop), "夜晚好人不能說話");
        assert!(ghosts_are(t.chat(None, "嗨"), &[]), "觀戰的人只能跟出局的人聊");
        t.g.alive[7] = false;
        assert!(ghosts_are(t.chat(Some(7), "嗨"), &[7]));
        t.g.alive[1] = false;
        assert!(matches!(t.chat(Some(0), "剩我了"), Chat::Only(To::Seats(ref v)) if *v == [0]), "出局的狼人看不到");
        assert!(ghosts_are(t.chat(Some(1), "加油"), &[1, 7]), "出局的狼人也只能跟出局的人聊");
        t.run(|g, ctx| g.begin_discuss(ctx));
        assert!(matches!(t.chat(Some(6), "我是預言家，P0 是狼"), Chat::Show));
        assert!(t.g.claimed(6, SEER), "白天的話會記成說法");
        assert!(t.g.claims.iter().any(|c| c.seat == 6 && c.said == Said::Wolf(0)));
        t.run(|g, ctx| g.finish(Side::Good, "測試".into(), ctx));
        assert!(matches!(t.chat(Some(7), "gg"), Chat::Show), "結束後大家都看得到");
        assert!(matches!(t.chat(None, "gg"), Chat::Show));
    }

    #[test]
    fn claims_are_read_from_chat() {
        let roles = [WOLF, WOLF, WOLF, SEER, WITCH, HUNTER, GUARD, VIL, VIL, VIL, VIL, VIL];
        let mut t = T::new(&roles, Options::default());
        t.g.read_claims(3, "我是預言家，P10 是狼，５號金水");
        t.g.read_claims(7, "P2 不是狼，投P1，別投 P0");
        t.g.read_claims(8, "我覺得預言家怪怪的，P8 是好人");
        t.g.read_claims(9, "12號查殺！3 號好人");
        t.g.read_claims(10, "今天投 P6");
        let said: Vec<(usize, Said)> = t.g.claims.iter().map(|c| (c.seat, c.said)).collect();
        assert_eq!(
            said,
            [
                (3, Said::Role(SEER)),
                (3, Said::Wolf(10)),
                (3, Said::Good(4)),
                (7, Said::Good(2)),
                (7, Said::Wolf(1)),
                (9, Said::Wolf(11)),
                (9, Said::Good(2)),
                (10, Said::Wolf(6)),
            ]
        );
        // 同一句話說兩次只記一次
        t.g.read_claims(3, "P10 狼人");
        assert_eq!(t.g.claims.len(), 8);
        // 只有一個人跳預言家時，大家相信他的查殺
        assert!(t.g.suspicion(Some(7), 10) > 2.0);
        assert!(t.g.suspicion(Some(7), 4) < 0.0);
        // 真的預言家知道跳預言家的是假的
        t.g.read_claims(5, "我是預言家");
        assert!(t.g.suspicion(Some(3), 5) > 4.0);
    }

    #[test]
    fn offline_host_moves_the_day_along() {
        let mut t = T::new(&EIGHT, Options { offline: true, ..Options::default() });
        t.g.day = 1;
        t.run(|g, ctx| g.begin_discuss(ctx));
        assert_eq!(t.act(6, Action::Ready), Err("線下模式由房主按「開始投票」".into()));
        assert!(t.g.deadline.is_some(), "線下討論也有上限");
        t.ok(6, Action::Advance);
        assert!(matches!(t.g.stage, Stage::Vote { .. }));

        // 遺言時房主可以按下一位（房主出局了也能按）
        t.g.alive[7] = false;
        t.g.deaths.push(Death { day: 1, seat: 7, cause: Cause::Exile });
        t.g.batch = vec![7];
        t.g.then = Then::Night;
        t.run(|g, ctx| g.begin_last_words(ctx));
        assert_eq!(t.g.stage, Stage::LastWords { at: 0 });
        assert_eq!(t.g.deadline, Some(t.now + LAST_WORDS_OFFLINE));
        t.ok(7, Action::Advance);
        assert_eq!(t.g.stage, Stage::Night);
    }

    #[test]
    fn disconnected_players_do_not_block() {
        let mut t = T::new(&EIGHT, Options::default());
        t.night();
        for s in [0, 2, 5] {
            t.run(|g, ctx| g.presence(s, false, ctx));
        }
        t.ok(1, Action::Kill { seat: Some(6) });
        assert_eq!(t.g.stage, Stage::Night);
        t.tick_after(OFFLINE_WAIT);
        assert_eq!(t.g.stage, Stage::Witch, "斷線的守衛、預言家、狼人等 10 秒就不等了");
        assert_eq!(t.g.night.kill, Some(6));
        t.run(|g, ctx| g.presence(3, false, ctx));
        t.tick_after(OFFLINE_WAIT);
        assert_eq!(t.g.stage, Stage::Dawn);
        assert!(!t.g.alive[6]);
    }

    #[test]
    fn witch_step_waits_even_when_she_cannot_act() {
        let mut t = T::new(&EIGHT, Options::default());
        t.g.alive[3] = false;
        t.night();
        t.ok(5, Action::Guard { seat: None });
        t.ok(2, Action::Check { seat: 0 });
        t.kill(&[0, 1], Some(6));
        assert_eq!(t.g.stage, Stage::Witch, "女巫出局了也照樣有這一步");
        assert!(t.g.deadline.is_some_and(|d| d >= t.now + Duration::from_secs(4)));
        t.tick_after(Duration::from_secs(8));
        assert_eq!(t.g.stage, Stage::Dawn);
    }

    #[test]
    fn bots_follow_human_wolves_and_report_checks() {
        // 座位 0 是真人狼人，其他都是電腦
        let mut t = T::with_bots(&EIGHT, Options::default(), 7);
        t.night();
        t.ok(0, Action::Kill { seat: Some(6) });
        for _ in 0..30 {
            if t.g.stage != Stage::Night {
                break;
            }
            t.tick_after(Duration::from_secs(1));
        }
        assert_ne!(t.g.stage, Stage::Night, "電腦做完就提早結束");
        assert_eq!(t.g.night.kill, Some(6), "電腦狼人跟著真人刀");
        assert_eq!(t.g.checks.len(), 1, "電腦預言家有查驗");
        for _ in 0..200 {
            if t.g.claimed(2, SEER) || t.g.finished() {
                break;
            }
            t.tick_after(Duration::from_secs(1));
        }
        assert!(t.g.claimed(2, SEER), "電腦預言家白天報查驗");
        let check = t.g.checks[0];
        let said = if check.wolf { Said::Wolf(check.seat) } else { Said::Good(check.seat) };
        assert!(t.g.claims.iter().any(|c| c.seat == 2 && c.said == said));
    }

    /// 一直 tick 到結束（或放棄）
    fn play_out(g: &mut Werewolf, seats: &[SeatInfo], rng: &mut Rng, mut now: Instant, step: Duration) {
        for _ in 0..50_000 {
            if g.finished() {
                break;
            }
            now += step;
            let mut out = Outbox::default();
            g.tick(&mut test_ctx(now, rng, seats, &mut out));
        }
        assert!(g.finished(), "卡在 {:?}（第 {} 天）", g.stage, g.day);
    }

    #[test]
    fn bots_play_whole_games() {
        let variants = [
            Options::default(),
            Options { offline: true, ..Options::default() },
            Options {
                win: Win::All,
                tie: Tie::NoExile,
                last_words: LastWords::Always,
                reveal: true,
                self_save: SelfSave::Always,
                ..Options::default()
            },
            Options { custom: true, wolves: 2, guard: true, last_words: LastWords::Never, ..Options::default() },
        ];
        for n in 6..=12 {
            for options in &variants {
                if options.lineup(n).is_err() {
                    continue;
                }
                for _ in 0..6 {
                    let mut rng = Rng::new();
                    let now = Instant::now();
                    let (mut g, seats) = start(n, n, options, now, &mut rng);
                    play_out(&mut g, &seats, &mut rng, now, Duration::from_millis(500));
                    match g.winner {
                        Some(Side::Good) => assert!(g.alive_wolves().is_empty()),
                        Some(Side::Wolf) => assert!(!g.alive_wolves().is_empty()),
                        None => panic!("沒有贏家"),
                    }
                    assert!(g.deaths.iter().all(|d| !g.alive[d.seat]));
                }
            }
        }
    }

    #[test]
    fn idle_humans_still_finish() {
        for options in [Options::default(), Options { offline: true, ..Options::default() }] {
            let mut rng = Rng::new();
            let now = Instant::now();
            let (mut g, seats) = start(9, 0, &options, now, &mut rng);
            play_out(&mut g, &seats, &mut rng, now, Duration::from_secs(1));
        }
    }
}
