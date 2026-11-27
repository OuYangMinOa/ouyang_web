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

use std::collections::{BTreeMap, BTreeSet, HashSet};

use axum::{
    Json,
    body::Bytes,
    extract::State,
    http::{HeaderMap, StatusCode},
};
use chrono::{DateTime, NaiveDate, Utc};
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
}
