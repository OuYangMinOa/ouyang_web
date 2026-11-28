//! 米其林星級餐廳的空位。伺服器不去抓：inline 等訂位系統沒有公開 API，也擋伺服器的程式存取，
//! 所以由家裡電腦上的爬蟲（miclin，用 Edge 打開 inline、TableCheck、SevenRooms 的公開訂位頁）每 3 小時跑一次，
//! 跑完上傳到這裡；網站只負責存起來給登入的人看。
//!
//! ```text
//! GET /api/michelin/availability   {"availability": null | {checked_at, uploaded_at, days, parties, restaurants}}  要登入
//! PUT /api/michelin/availability   爬蟲上傳（格式見 Snapshot），標頭 X-Michelin-Key 要等於 MICHELIN_UPLOAD_KEY → 204
//! ```
//!
//! - 沒設 `MICHELIN_UPLOAD_KEY` 的環境不收上傳（404）。金鑰放標頭不放網址，才不會進到 IP 訪問紀錄；
//!   先比對金鑰才解析內容，沒有金鑰的請求不會讓伺服器去解一大包 JSON。
//! - 上傳的內容整理過再存：店名對到地圖上的餐廳（`id`，對不到是 null），訂位網址只收 http(s)，
//!   時間統一成 UTC，時段排序去重，「新增」只留還在時段裡的。格式不對整包退回，方便爬蟲那邊發現。
//! - 只留最近 10 次；看的時候拿 `checked_at` 最新的那次，晚到的舊資料不會蓋掉新的。
//! - AI 助手的 `michelin_availability`（ai_builtin.rs）也讀最新的那次，篩選和整理在這裡的 `Query`。

use std::collections::{BTreeMap, BTreeSet, HashSet};

use axum::{
    Json,
    body::Bytes,
    extract::State,
    http::{HeaderMap, StatusCode},
};
use chrono::{DateTime, NaiveDate, NaiveDateTime, TimeDelta, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::{AppError, AppState, auth::CurrentUser, michelin, party::clean};

const KEY_HEADER: &str = "x-michelin-key";
/// 留最近幾次上傳
const KEEP: i64 = 10;
const MAX_DAYS: usize = 31;
const MAX_RESTAURANTS: usize = 400;
const MAX_PARTIES: usize = 12;
const MAX_PARTY_SIZE: u8 = 30;
const MAX_TIMES: usize = 300;
const MAX_NAME_LEN: usize = 60;
const MAX_NOTE_LEN: usize = 200;
const MAX_PHONE_LEN: usize = 40;
const MAX_URL_LEN: usize = 500;
/// 資料庫和回應裡時間的格式（UTC）
const TIME_FORMAT: &str = "%Y-%m-%dT%H:%M:%SZ";

/// 一次查詢的結果。上傳和回應是同一個格式，`id`、`parties` 是伺服器補上的
#[derive(Deserialize, Serialize)]
pub struct Snapshot {
    /// 這次跑完的時間（RFC 3339，存成 UTC）
    pub checked_at: String,
    /// 查了哪幾天（台灣的日期 YYYY-MM-DD，由早到晚）
    pub days: Vec<String>,
    /// 有哪些人數（從各家的結果整理出來）
    #[serde(default, skip_deserializing)]
    pub parties: Vec<u8>,
    pub restaurants: Vec<Place>,
}

#[derive(Deserialize, Serialize)]
pub struct Place {
    /// 地圖上那家的 id（米其林網址最後一段），用店名對；對不到是 null
    #[serde(default, skip_deserializing)]
    pub id: Option<String>,
    pub name: String,
    /// 訂位頁或官網，沒有是空字串
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub phone: String,
    /// 人數 → 結果
    #[serde(default)]
    pub parties: BTreeMap<u8, PartyResult>,
}

#[derive(Deserialize, Serialize)]
pub struct PartyResult {
    /// 資料來源：inline、tablecheck、sevenrooms、mirror（Noline 的公開日曆）、manual（要問店家）
    #[serde(default)]
    pub source: String,
    /// 讀到這家的時間；沒讀到是 null
    #[serde(default)]
    pub checked_at: Option<String>,
    /// 沒讀到的原因或提醒，例如「訂位頁人數選單最高 4 位」
    #[serde(default)]
    pub note: String,
    /// 日期 → 那天的狀態；沒查到的日期不會出現
    #[serde(default)]
    pub days: BTreeMap<String, Day>,
}

#[derive(Deserialize, Serialize)]
pub struct Day {
    /// open、book（可訂）、full（額滿）、closed（公休）、booking-off（沒開放線上訂位）、
    /// selectable（TableCheck 列出可選的時間）、date_unselectable（訂位頁跳過這天）
    pub status: String,
    /// 這個人數可訂的時間 HH:MM（台灣時間）
    #[serde(default)]
    pub times: Vec<String>,
    /// 其中跟爬蟲上一次查到的比起來新出現的
    #[serde(default)]
    pub new: Vec<String>,
}

fn bad(message: impl Into<String>) -> AppError {
    AppError::BadRequest(message.into())
}

/// RFC 3339 → UTC 的固定格式
fn utc(value: &str) -> Option<String> {
    DateTime::parse_from_rfc3339(value.trim()).ok().map(|t| t.with_timezone(&Utc).format(TIME_FORMAT).to_string())
}

/// 狀態、來源這類代號：小寫英數字和 - _
fn code(value: &str, field: &str) -> Result<String, AppError> {
    let value = value.trim();
    let ok = value.len() <= 30
        && value.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_');
    if ok { Ok(value.to_owned()) } else { Err(bad(format!("{field} 只能是小寫英數字：{value}"))) }
}

/// HH:MM（00:00～23:59）
fn is_clock(value: &str) -> bool {
    let bytes = value.as_bytes();
    let digits = |s: &[u8]| s.iter().all(u8::is_ascii_digit);
    bytes.len() == 5
        && bytes[2] == b':'
        && digits(&bytes[..2])
        && digits(&bytes[3..])
        && value[..2].parse::<u8>().is_ok_and(|h| h < 24)
        && value[3..].parse::<u8>().is_ok_and(|m| m < 60)
}

/// 訂位網址只收 http(s)：前端會把它放進連結，`javascript:` 之類的不能進來
fn booking_url(value: &str) -> Result<String, AppError> {
    let url = value.trim();
    if url.is_empty() {
        return Ok(String::new());
    }
    let ok = (url.starts_with("https://") || url.starts_with("http://"))
        && url.len() <= MAX_URL_LEN
        && !url.chars().any(|c| c.is_whitespace() || c.is_control());
    if ok { Ok(url.to_owned()) } else { Err(bad(format!("訂位網址只收 http(s)：{url}"))) }
}

impl Snapshot {
    /// 檢查並整理上傳的內容；有一個地方不對就整包退回
    pub fn normalize(mut self) -> Result<Self, AppError> {
        self.checked_at = utc(&self.checked_at).ok_or_else(|| bad("checked_at 要是 RFC 3339 的時間"))?;
        if self.days.is_empty() || self.days.len() > MAX_DAYS {
            return Err(bad(format!("days 要有 1～{MAX_DAYS} 天")));
        }
        for day in &self.days {
            let parsed =
                NaiveDate::parse_from_str(day, "%Y-%m-%d").map_err(|_| bad(format!("日期要是 YYYY-MM-DD：{day}")))?;
            if parsed.format("%Y-%m-%d").to_string() != *day {
                return Err(bad(format!("日期要是 YYYY-MM-DD：{day}")));
            }
        }
        if !self.days.windows(2).all(|w| w[0] < w[1]) {
            return Err(bad("days 要由早到晚、不重複"));
        }
        if self.restaurants.len() > MAX_RESTAURANTS {
            return Err(bad(format!("一次最多 {MAX_RESTAURANTS} 家")));
        }

        let days: HashSet<&str> = self.days.iter().map(String::as_str).collect();
        let mut names = HashSet::new();
        let mut parties = BTreeSet::new();
        for place in &mut self.restaurants {
            place.name = clean(&place.name, MAX_NAME_LEN);
            if place.name.is_empty() {
                return Err(bad("店名不能是空的"));
            }
            if !names.insert(place.name.clone()) {
                return Err(bad(format!("{} 出現了兩次", place.name)));
            }
            place.url = booking_url(&place.url)?;
            place.phone = clean(&place.phone, MAX_PHONE_LEN);
            place.id = michelin::find_by_name(&place.name).map(|r| r.id.clone());
            if place.parties.len() > MAX_PARTIES || place.parties.keys().any(|&n| n == 0 || n > MAX_PARTY_SIZE) {
                return Err(bad(format!("{} 的人數要是 1～{MAX_PARTY_SIZE}", place.name)));
            }
            parties.extend(place.parties.keys().copied());
            for result in place.parties.values_mut() {
                result.source = code(&result.source, "source")?;
                result.checked_at = match result.checked_at.as_deref().map(str::trim) {
                    None | Some("") => None,
                    Some(at) => Some(utc(at).ok_or_else(|| bad(format!("{} 的 checked_at 不對：{at}", place.name)))?),
                };
                result.note = clean(&result.note, MAX_NOTE_LEN);
                for (date, day) in &mut result.days {
                    if !days.contains(date.as_str()) {
                        return Err(bad(format!("{} 的 {date} 不在 days 裡", place.name)));
                    }
                    day.status = code(&day.status, "status")?;
                    if day.status.is_empty() {
                        return Err(bad(format!("{} 的 {date} 沒有 status", place.name)));
                    }
                    if day.times.len() > MAX_TIMES || !day.times.iter().all(|t| is_clock(t)) {
                        return Err(bad(format!("{} 的 {date} 時段要是 HH:MM", place.name)));
                    }
                    day.times.sort_unstable();
                    day.times.dedup();
                    day.new.retain(|t| day.times.binary_search(t).is_ok());
                    day.new.sort_unstable();
                    day.new.dedup();
                }
            }
        }
        self.parties = parties.into_iter().collect();
        Ok(self)
    }
}

/// 比對上傳金鑰：比雜湊，比較花的時間跟金鑰內容無關
fn check_key(state: &AppState, headers: &HeaderMap) -> Result<(), AppError> {
    let Some(expected) = state.michelin_upload_key.as_deref() else {
        return Err(AppError::NotFound);
    };
    let given = headers.get(KEY_HEADER).and_then(|v| v.to_str().ok()).unwrap_or("").trim();
    if given.is_empty() || Sha256::digest(given.as_bytes()) != Sha256::digest(expected.as_bytes()) {
        return Err(AppError::Unauthorized("上傳金鑰不對"));
    }
    Ok(())
}

pub async fn upload(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Result<StatusCode, AppError> {
    check_key(&state, &headers)?;
    let snapshot: Snapshot = serde_json::from_slice(&body).map_err(|e| bad(format!("格式不對：{e}")))?;
    let snapshot = snapshot.normalize()?;
    let data = serde_json::to_string(&snapshot).map_err(|e| AppError::Internal(e.to_string()))?;
    let mut tx = state.pool.begin().await?;
    sqlx::query("INSERT INTO michelin_availability (checked_at, data) VALUES (?, ?)")
        .bind(&snapshot.checked_at)
        .bind(&data)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "DELETE FROM michelin_availability WHERE id NOT IN
             (SELECT id FROM michelin_availability ORDER BY checked_at DESC, id DESC LIMIT ?)",
    )
    .bind(KEEP)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    tracing::info!(checked_at = %snapshot.checked_at, restaurants = snapshot.restaurants.len(), "michelin availability uploaded");
    Ok(StatusCode::NO_CONTENT)
}

pub async fn latest(State(state): State<AppState>, _user: CurrentUser) -> Result<Json<Value>, AppError> {
    let row = sqlx::query_as::<_, (String, String)>(
        "SELECT uploaded_at, data FROM michelin_availability ORDER BY checked_at DESC, id DESC LIMIT 1",
    )
    .fetch_optional(&state.pool)
    .await?;
    let availability = match row {
        Some((uploaded_at, data)) => {
            let mut value: Value = serde_json::from_str(&data).map_err(|e| AppError::Internal(e.to_string()))?;
            value["uploaded_at"] = Value::String(uploaded_at);
            value
        }
        None => Value::Null,
    };
    Ok(Json(json!({ "availability": availability })))
}

// ---- AI 助手的 michelin_availability（ai_builtin.rs） ----

/// 午餐、晚餐從 16:00 切開，跟空位頁（frontend/src/michelin/availability.ts）一樣
pub const LUNCH: (&str, &str) = ("10:00", "15:59");
pub const DINNER: (&str, &str) = ("16:00", "23:59");
/// 一家最多列幾天的時段，再多的只寫日期，結果才不會太長
const LISTED_DAYS: usize = 7;
/// 一天最多列幾個時段
const LISTED_TIMES: usize = 12;
/// 「選的時段沒有、其他時段有」最多列幾家
const LISTED_ELSEWHERE: usize = 10;
/// 多久沒更新算太久：爬蟲每 3 小時跑一次，連兩次沒跑就提醒（跟空位頁一樣）
const STALE_HOURS: i64 = 7;

/// 最新一次的結果，還沒上傳過是 None。地圖的 `id` 存的時候有，但讀成 `Snapshot` 時會略過（上傳不能自己指定），照上傳時的規則補回來
pub async fn latest_snapshot(state: &AppState) -> Result<Option<Snapshot>, AppError> {
    let data = sqlx::query_scalar::<_, String>(
        "SELECT data FROM michelin_availability ORDER BY checked_at DESC, id DESC LIMIT 1",
    )
    .fetch_optional(&state.pool)
    .await?;
    let Some(data) = data else { return Ok(None) };
    let mut snapshot: Snapshot = serde_json::from_str(&data).map_err(|e| AppError::Internal(e.to_string()))?;
    for place in &mut snapshot.restaurants {
        place.id = michelin::find_by_name(&place.name).map(|r| r.id.clone());
    }
    Ok(Some(snapshot))
}

/// 模型給的時間：7:30、19:00:00 → 07:30、19:00；不是時間是 None
pub fn parse_clock(value: &str) -> Option<String> {
    let mut parts = value.trim().split(':');
    let hour: u8 = parts.next()?.parse().ok()?;
    let minute = parts.next()?;
    if parts.next().is_some_and(|seconds| seconds != "00") || parts.next().is_some() {
        return None;
    }
    let clock = format!("{hour:02}:{minute}");
    is_clock(&clock).then_some(clock)
}

/// 那天沒有時段時的原因，跟空位頁的寫法一樣
fn status_label(day: Option<&Day>) -> &'static str {
    match day.map(|d| d.status.as_str()) {
        None => "沒有資料",
        Some("full") => "額滿",
        Some("closed") => "公休",
        Some("booking-off") => "沒開放線上訂位",
        Some("date_unselectable") => "訂位頁不能選這天",
        Some("selectable") => "沒有可選的時間",
        Some(_) => "沒有這個人數的時段",
    }
}

fn source_label(source: &str) -> &str {
    match source {
        "tablecheck" => "TableCheck",
        "sevenrooms" => "SevenRooms",
        "mirror" => "Noline 備援日曆",
        "manual" => "要問店家",
        other => other,
    }
}

/// 一天的時段寫成一串，太多的只寫前面幾個
fn times_text(times: &[&String]) -> String {
    let shown: Vec<&str> = times.iter().take(LISTED_TIMES).map(|t| t.as_str()).collect();
    if times.len() > LISTED_TIMES { format!("{}…共 {} 個", shown.join(" "), times.len()) } else { shown.join(" ") }
}

/// 一家店的基本資料：獎項、地區、訂位頁（要問店家的是官網）
fn place_view(place: &Place, map: Option<&michelin::Restaurant>, result: Option<&PartyResult>) -> Value {
    let mut view = json!({ "name": place.name });
    if let Some(r) = map {
        view["award"] = json!(r.award.label());
        view["area"] = json!(format!("{}{}", r.city, r.district));
        view["cuisine"] = json!(r.cuisine);
        view["map_link"] = json!(r.link());
    }
    if !place.url.is_empty() {
        let manual = result.is_some_and(|r| r.source == "manual");
        view[if manual { "website" } else { "booking" }] = json!(place.url);
    }
    if !place.phone.is_empty() {
        view["phone"] = json!(place.phone);
    }
    if let Some(result) = result {
        view["source"] = json!(source_label(&result.source));
        if !result.note.is_empty() {
            view["note"] = json!(result.note);
        }
    }
    view
}

/// AI 助手問空位的條件
pub struct Query {
    pub party: u8,
    /// 只看這段日子（台灣日期，含頭尾）；沒給的那頭不限
    pub from: Option<NaiveDate>,
    pub to: Option<NaiveDate>,
    /// 只看這段時間的時段（HH:MM，含頭尾）；None 是全天
    pub time: Option<(String, String)>,
    /// 店名的關鍵字；有給的話沒位子的店也列出來，寫每天為什麼沒有
    pub restaurant: String,
    /// 縣市或區，跟 michelin_search 一樣比對
    pub area: String,
    /// 只要這些星等，空的是不限
    pub awards: Vec<michelin::Award>,
    /// 有位子的最多列幾家
    pub limit: usize,
}

impl Query {
    /// 給模型看的結果（JSON 或一句話）；now 是台灣時間，已經過去的時段不算。
    /// 條件查不了（沒查這個人數、日期不在範圍裡）回 Err，模型可以換個條件再查
    pub fn run(&self, snapshot: &Snapshot, now: NaiveDateTime) -> Result<String, String> {
        let parties: BTreeSet<u8> = snapshot.restaurants.iter().flat_map(|p| p.parties.keys().copied()).collect();
        if !parties.contains(&self.party) {
            let list: Vec<String> = parties.iter().map(|n| format!("{n} 位")).collect();
            return Err(format!(
                "只查了 {}的空位，沒有 {} 位的；可以改查最接近的人數，並告訴使用者",
                list.join("、"),
                self.party
            ));
        }
        let now_key = now.format("%Y-%m-%d %H:%M").to_string();
        let today = now.format("%Y-%m-%d").to_string();
        let upcoming: Vec<&str> = snapshot.days.iter().map(String::as_str).filter(|d| *d >= today.as_str()).collect();
        let (Some(first_day), Some(last_day)) = (upcoming.first(), upcoming.last()) else {
            return Err("最新一次的空位資料查的日子都過了，家裡電腦上的爬蟲可能沒在跑".into());
        };
        let from = self.from.map(|d| d.format("%Y-%m-%d").to_string());
        let to = self.to.map(|d| d.format("%Y-%m-%d").to_string());
        let days: Vec<&str> = upcoming
            .iter()
            .copied()
            .filter(|d| from.as_deref().is_none_or(|f| *d >= f) && to.as_deref().is_none_or(|t| *d <= t))
            .collect();
        if days.is_empty() {
            return Err(format!("空位只查到 {first_day}～{last_day}，要查的日子不在這段裡"));
        }
        let in_time = |t: &str| self.time.as_ref().is_none_or(|(a, b)| t >= a.as_str() && t <= b.as_str());
        let named = michelin::fold(&self.restaurant);
        let area = michelin::Search { area: self.area.clone(), ..Default::default() };

        // 有位子的：（最早的時段, 星等, 那家）
        let mut open: Vec<(String, u8, Value)> = Vec::new();
        // 有給店名時，沒位子的那幾家
        let mut closed = Vec::new();
        // 選的時段沒有、同樣幾天其他時段有的
        let mut elsewhere = Vec::new();
        let (mut matched, mut total, mut without, mut no_data) = (0, 0, 0, 0);
        for place in &snapshot.restaurants {
            let map = place.id.as_deref().and_then(michelin::find);
            let name_ok = named.is_empty()
                || michelin::fold(&place.name).contains(&named)
                || map.is_some_and(|r| michelin::fold(&r.name).contains(&named));
            let area_ok = self.area.trim().is_empty() || map.is_some_and(|r| area.matches(r));
            let award_ok = self.awards.is_empty() || map.is_some_and(|r| self.awards.contains(&r.award));
            if !(name_ok && area_ok && award_ok) {
                continue;
            }
            matched += 1;
            let result = place.parties.get(&self.party);
            let (mut slots, mut other, mut has_data) = (0, 0, false);
            let mut first = None;
            let mut times = BTreeMap::new();
            let mut more_days = Vec::new();
            let mut fresh = Vec::new();
            let mut reasons = BTreeMap::new();
            for &date in &days {
                let day = result.and_then(|r| r.days.get(date));
                has_data |= day.is_some();
                let later: Vec<&String> = day
                    .map(|d| d.times.iter().filter(|t| format!("{date} {t}") > now_key).collect())
                    .unwrap_or_default();
                let chosen: Vec<&String> = later.iter().copied().filter(|t| in_time(t)).collect();
                other += later.len() - chosen.len();
                let Some(&earliest) = chosen.first() else {
                    let reason = if later.is_empty() {
                        status_label(day).to_owned()
                    } else {
                        format!("選的時段沒有，其他時段有 {} 個", later.len())
                    };
                    reasons.insert(date, reason);
                    continue;
                };
                slots += chosen.len();
                first.get_or_insert_with(|| format!("{date} {earliest}"));
                if let Some(day) = day {
                    fresh.extend(day.new.iter().filter(|t| chosen.contains(t)).map(|t| format!("{date} {t}")));
                }
                if times.len() < LISTED_DAYS {
                    times.insert(date, times_text(&chosen));
                } else {
                    more_days.push(date);
                }
            }
            let mut view = place_view(place, map, result);
            if let Some(first) = first {
                total += slots;
                view["slots"] = json!(slots);
                view["first"] = json!(first);
                view["times"] = json!(times);
                if !more_days.is_empty() {
                    view["more_days"] = json!(more_days);
                }
                if !fresh.is_empty() {
                    view["new"] = json!(fresh);
                }
                if !named.is_empty() && !reasons.is_empty() {
                    view["unavailable"] = json!(reasons);
                }
                open.push((first, map.map_or(0, |r| r.award.rank()), view));
            } else if !named.is_empty() {
                view["slots"] = json!(0);
                view["unavailable"] = json!(reasons);
                closed.push(view);
            } else if other > 0 {
                elsewhere.push(json!({ "name": place.name, "other_slots": other }));
            } else if has_data {
                without += 1;
            } else {
                no_data += 1;
            }
        }
        if matched == 0 {
            return Ok(if named.is_empty() {
                "空位資料裡沒有符合的店（只有星級餐廳有查空位），可以放寬地區或星等再查".into()
            } else {
                format!("空位資料裡沒有「{}」：只有星級餐廳有查空位，店名可以用 michelin_search 確認", self.restaurant)
            });
        }

        // 最早有位的在前，一樣早的星等高的在前
        open.sort_by(|a, b| a.0.cmp(&b.0).then(b.1.cmp(&a.1)));
        let with_slots = open.len();
        let mut restaurants: Vec<Value> = open.into_iter().take(self.limit).map(|(_, _, view)| view).collect();
        restaurants.extend(closed);
        let span = |list: &[&str]| match list {
            [one] => (*one).to_owned(),
            _ => format!("{}～{}", list[0], list[list.len() - 1]),
        };
        let mut out = json!({
            "days_covered": span(&upcoming),
            "party": self.party,
            "dates": span(&days),
            "time": self.time.as_ref().map_or_else(|| "全天".to_owned(), |(a, b)| format!("{a}–{b}")),
            "restaurants_with_slots": with_slots,
            "total_slots": total,
            "restaurants": restaurants,
            "page": "/michelin/availability",
            "note": "時間都是台灣時間；new 是跟前一次查詢比新出現的時段（多半是有人取消）；空位每 3 小時查一次，能不能訂以 booking 的訂位頁為準",
        });
        if with_slots > self.limit {
            out["shown"] = json!(self.limit);
        }
        if !elsewhere.is_empty() {
            elsewhere.truncate(LISTED_ELSEWHERE);
            out["only_other_times"] = json!(elsewhere);
            // 實際讓模型讀過：沒寫清楚的話會當成「別天才有」
            out["only_other_times_note"] = json!(
                "同樣這幾天、選的時段以外還有位子的店（other_slots 是幾個），不是別天；要看是幾點就不限時段再查一次"
            );
        }
        if named.is_empty() {
            out["no_slots"] = json!(without);
            out["no_data"] = json!(no_data);
        }
        if let Ok(checked) = NaiveDateTime::parse_from_str(&snapshot.checked_at, TIME_FORMAT) {
            let checked = checked + TimeDelta::hours(8);
            let hours = (now - checked).num_hours();
            out["checked_at"] = json!(checked.format("%Y-%m-%d %H:%M").to_string());
            out["hours_ago"] = json!(hours);
            if hours > STALE_HOURS {
                out["warning"] =
                    json!(format!("已經 {hours} 小時沒更新，家裡電腦上的爬蟲可能沒在跑，現在的空位可能不一樣了"));
            }
        }
        Ok(out.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clocks_and_urls() {
        assert!(is_clock("00:00") && is_clock("23:59") && is_clock("18:30"));
        for wrong in ["24:00", "18:60", "1830", "8:30", "18:3", "１８:３０", "+1:30"] {
            assert!(!is_clock(wrong), "{wrong}");
        }
        assert_eq!(booking_url(" https://inline.app/booking/a ").unwrap(), "https://inline.app/booking/a");
        assert_eq!(booking_url("").unwrap(), "");
        for wrong in ["javascript:alert(1)", "ftp://x", "https://a b", "//inline.app"] {
            assert!(booking_url(wrong).is_err(), "{wrong}");
        }
    }

    #[test]
    fn clocks_from_the_model() {
        assert_eq!(parse_clock("7:30").as_deref(), Some("07:30"));
        assert_eq!(parse_clock(" 19:00:00 ").as_deref(), Some("19:00"));
        assert_eq!(parse_clock("18:30").as_deref(), Some("18:30"));
        for wrong in ["25:00", "19", "19:5", "19:00:30", "晚上七點", "", "19:00:00:00"] {
            assert_eq!(parse_clock(wrong), None, "{wrong}");
        }
    }

    /// 頤宮（台北三星）12/4 午晚都有、12/5 額滿、12/6 只有中午；JL Studio（台中三星，大小寫跟地圖不一樣）12/4 晚上、12/5 中午；
    /// 米香沒讀到；還有一家地圖上沒有的。查詢時間是台灣 12/4 11:00
    fn snapshot() -> Snapshot {
        let data = json!({
            "checked_at": "2026-12-04T11:00:00+08:00",
            "days": ["2026-12-03", "2026-12-04", "2026-12-05", "2026-12-06"],
            "restaurants": [
                { "name": "頤宮", "url": "https://inline.app/booking/le-palais", "phone": "02-2181-9950",
                  "parties": {
                      "2": { "source": "inline", "days": {
                          "2026-12-04": { "status": "open", "times": ["12:00", "18:00", "18:30"], "new": ["18:30"] },
                          "2026-12-05": { "status": "full" },
                          "2026-12-06": { "status": "open", "times": ["12:00"] } } },
                      "4": { "source": "inline", "days": { "2026-12-04": { "status": "full" } } } } },
                { "name": "JL Studio", "url": "https://jl.example/booking",
                  "parties": { "2": { "source": "tablecheck", "days": {
                      "2026-12-04": { "status": "open", "times": ["19:00"] },
                      "2026-12-05": { "status": "open", "times": ["12:30", "13:00"] } } } } },
                { "name": "米香", "parties": { "2": { "source": "inline", "note": "訂位頁打不開", "days": {} } } },
                { "name": "地圖上沒有的店", "url": "https://example.com",
                  "parties": { "2": { "source": "manual", "days": {} } } }
            ]
        });
        serde_json::from_value::<Snapshot>(data).unwrap().normalize().unwrap()
    }

    fn base() -> Query {
        Query {
            party: 2,
            from: None,
            to: None,
            time: None,
            restaurant: String::new(),
            area: String::new(),
            awards: Vec::new(),
            limit: 10,
        }
    }

    fn date(text: &str) -> Option<NaiveDate> {
        Some(NaiveDate::parse_from_str(text, "%Y-%m-%d").unwrap())
    }

    fn meal((from, to): (&str, &str)) -> Option<(String, String)> {
        Some((from.to_owned(), to.to_owned()))
    }

    fn ask(query: &Query, now: &str) -> Value {
        let now = NaiveDateTime::parse_from_str(now, "%Y-%m-%d %H:%M").unwrap();
        let text = query.run(&snapshot(), now).unwrap();
        serde_json::from_str(&text).unwrap_or(Value::String(text))
    }

    #[test]
    fn a_day_and_a_meal() {
        // 12/4 晚上：頤宮 18:00 18:30（18:30 是新的）、JL Studio 19:00
        let dinner = Query { from: date("2026-12-04"), to: date("2026-12-04"), time: meal(DINNER), ..base() };
        let out = ask(&dinner, "2026-12-04 12:30");
        assert_eq!((out["restaurants_with_slots"].clone(), out["total_slots"].clone()), (json!(2), json!(3)));
        assert_eq!((out["dates"].clone(), out["time"].clone()), (json!("2026-12-04"), json!("16:00–23:59")));
        let palais = &out["restaurants"][0];
        assert_eq!(palais["name"], "頤宮");
        assert_eq!(palais["times"], json!({ "2026-12-04": "18:00 18:30" }));
        assert_eq!(palais["first"], "2026-12-04 18:00");
        assert_eq!(palais["new"], json!(["2026-12-04 18:30"]));
        assert_eq!(palais["award"], "米其林三星");
        assert_eq!(palais["area"], "台北市大同區");
        assert_eq!(palais["booking"], "https://inline.app/booking/le-palais");
        assert_eq!(palais["map_link"], "/michelin?r=le-palais");
        assert_eq!(out["restaurants"][1]["name"], "JL Studio");
        assert_eq!((out["no_slots"].clone(), out["no_data"].clone()), (json!(0), json!(2)));
        assert_eq!((out["checked_at"].clone(), out["hours_ago"].clone()), (json!("2026-12-04 11:00"), json!(1)));
        assert!(out.get("warning").is_none());

        // 12/4 中午：12:00 已經過了，只剩晚上的，列在 only_other_times
        let lunch = Query { time: meal(LUNCH), ..dinner };
        let out = ask(&lunch, "2026-12-04 12:30");
        assert_eq!(out["restaurants_with_slots"], 0);
        assert_eq!(
            out["only_other_times"],
            json!([{ "name": "頤宮", "other_slots": 2 }, { "name": "JL Studio", "other_slots": 1 }])
        );
        assert!(out["only_other_times_note"].as_str().unwrap().contains("不是別天"), "{out}");
    }

    #[test]
    fn one_restaurant_says_why_not() {
        // 12/3 已經過了；12/5 額滿
        let out = ask(&Query { restaurant: "頤宮".into(), ..base() }, "2026-12-04 12:30");
        assert_eq!(out["days_covered"], "2026-12-04～2026-12-06");
        let palais = &out["restaurants"][0];
        assert_eq!(palais["times"], json!({ "2026-12-04": "18:00 18:30", "2026-12-06": "12:00" }));
        assert_eq!(palais["unavailable"], json!({ "2026-12-05": "額滿" }));
        assert!(out.get("no_slots").is_none());

        // 大小寫不同也找得到；那天中午沒有、晚上有
        let query = Query {
            restaurant: "jl studio".into(),
            from: date("2026-12-04"),
            to: date("2026-12-05"),
            time: meal(LUNCH),
            ..base()
        };
        let out = ask(&query, "2026-12-04 12:30");
        let jl = &out["restaurants"][0];
        assert_eq!(jl["times"], json!({ "2026-12-05": "12:30 13:00" }));
        assert_eq!(jl["unavailable"], json!({ "2026-12-04": "選的時段沒有，其他時段有 1 個" }));

        // 沒位子的也列出來，寫原因
        let out = ask(&Query { restaurant: "米香".into(), ..base() }, "2026-12-04 12:30");
        let mipon = &out["restaurants"][0];
        assert_eq!((mipon["slots"].clone(), mipon["note"].clone()), (json!(0), json!("訂位頁打不開")));
        assert_eq!(mipon["unavailable"]["2026-12-05"], "沒有資料");

        let out = ask(&Query { restaurant: "鼎泰豐".into(), ..base() }, "2026-12-04 12:30");
        assert!(out.as_str().unwrap().contains("沒有「鼎泰豐」"), "{out}");
    }

    #[test]
    fn area_awards_and_limit() {
        let out = ask(&Query { area: "台中".into(), ..base() }, "2026-12-04 12:30");
        assert_eq!(out["restaurants_with_slots"], 1);
        assert_eq!(out["restaurants"][0]["times"], json!({ "2026-12-04": "19:00", "2026-12-05": "12:30 13:00" }));
        let out = ask(&Query { awards: vec![michelin::Award::Star(1)], ..base() }, "2026-12-04 12:30");
        assert_eq!((out["restaurants_with_slots"].clone(), out["no_data"].clone()), (json!(0), json!(1)));
        let out = ask(&Query { area: "花蓮".into(), ..base() }, "2026-12-04 12:30");
        assert!(out.as_str().unwrap().contains("沒有符合的店"), "{out}");
        // 最早有位的排前面，只列一家時寫列了幾家
        let out = ask(&Query { limit: 1, ..base() }, "2026-12-04 12:30");
        assert_eq!((out["restaurants_with_slots"].clone(), out["shown"].clone()), (json!(2), json!(1)));
        assert_eq!(out["restaurants"].as_array().unwrap().len(), 1);
        assert_eq!(out["restaurants"][0]["name"], "頤宮");
    }

    #[test]
    fn what_cannot_be_asked() {
        let now = NaiveDateTime::parse_from_str("2026-12-04 12:30", "%Y-%m-%d %H:%M").unwrap();
        let error = Query { party: 3, ..base() }.run(&snapshot(), now).unwrap_err();
        assert!(error.contains("2 位、4 位") && error.contains("沒有 3 位"), "{error}");
        let later = Query { from: date("2026-12-20"), to: date("2026-12-20"), ..base() };
        assert!(later.run(&snapshot(), now).unwrap_err().contains("2026-12-04～2026-12-06"));
        // 資料太舊：提醒；查的日子都過了：講清楚
        let out = ask(&base(), "2026-12-04 20:00");
        assert!(out["warning"].as_str().unwrap().contains("9 小時"), "{out}");
        let old = NaiveDateTime::parse_from_str("2026-12-07 09:00", "%Y-%m-%d %H:%M").unwrap();
        assert!(base().run(&snapshot(), old).unwrap_err().contains("都過了"));
    }
}
