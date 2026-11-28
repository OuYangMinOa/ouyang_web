//! 米其林地圖的後端：餐廳資料（給 AI 助手、聚餐投票用）、想吃／吃過、訂位提醒。
//!
//! ```text
//! GET    /api/michelin/marks                 {"marks":[{restaurant,status,visited_on,updated_at}]}
//! PUT    /api/michelin/marks/{restaurant}    {"status":"want"|"been","visited_on"?:"YYYY-MM-DD"}  設定想吃或吃過
//! DELETE /api/michelin/marks/{restaurant}    取消
//! GET    /api/michelin/reminders             {"reminders":[{id,restaurant,remind_at,note,sent_at}]}  還沒送的和最近 7 天送過的
//! POST   /api/michelin/reminders             {"restaurant","remind_at","note"?}  → 201，remind_at 是 RFC 3339
//! DELETE /api/michelin/reminders/{id}
//! ```
//!
//! - 都要登入，每個人只看得到、改得到自己的。
//! - 餐廳資料是前端 `frontend/src/michelin/restaurants.json` 的副本：Docker 編後端時只拿得到 backend/，
//!   所以這裡另放一份（`michelin_restaurants.json`）。兩份不一樣時 `tests/michelin.rs` 會失敗，更新資料時兩邊一起換。
//! - 什麼時候開放訂位，米其林官網沒有、店家用的訂位系統（inline 等）也沒有公開 API，所以由使用者自己設時間；
//!   時間到了推播通知（webpush.rs）到這個人所有開了通知的瀏覽器，點通知回到地圖上那家。
//! - 提醒每 30 秒檢查一次。送之前先用 `UPDATE … WHERE sent_at IS NULL` 搶下來：
//!   換版時兩個容器同時在跑、共用同一個資料庫，也只會送一次。

use std::{sync::LazyLock, time::Duration};

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use chrono::{DateTime, Datelike, NaiveDate, TimeDelta, Utc};
use serde::{Deserialize, Deserializer, Serialize, de::Error as _};
use serde_json::{Value, json};

use crate::{AppError, AppState, auth::CurrentUser, party::clean, webpush};

/// 米其林指南的版本，和 `frontend/src/michelin/regions.ts` 的 `GUIDE_EDITION` 一樣
pub const GUIDE_EDITION: &str = "2026";

const MAX_PENDING_REMINDERS: i64 = 50;
const MAX_NOTE_LEN: usize = 100;
const MAX_AHEAD_DAYS: i64 = 400;
const CHECK_EVERY: Duration = Duration::from_secs(30);
/// 送過的提醒留多久（清單上會顯示最近 7 天送過的）
const KEEP_SENT_DAYS: i64 = 30;
/// 資料庫裡時間的格式（UTC），字串比較就是時間先後
const TIME_FORMAT: &str = "%Y-%m-%dT%H:%M:%SZ";

/// 星等 1～3，或必比登
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Award {
    Star(u8),
    Bib,
}

impl Award {
    pub fn label(self) -> &'static str {
        match self {
            Self::Star(3) => "米其林三星",
            Self::Star(2) => "米其林二星",
            Self::Star(_) => "米其林一星",
            Self::Bib => "必比登推薦",
        }
    }

    /// 排序用：三星最大，必比登最小
    pub fn rank(self) -> u8 {
        match self {
            Self::Star(n) => n,
            Self::Bib => 0,
        }
    }

    /// AI 工具參數的寫法：`3`、`2`、`1`、`bib`
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim() {
            "3" | "三星" => Some(Self::Star(3)),
            "2" | "二星" => Some(Self::Star(2)),
            "1" | "一星" => Some(Self::Star(1)),
            "bib" | "必比登" => Some(Self::Bib),
            _ => None,
        }
    }
}

/// JSON 裡是數字 1～3 或字串 "bib"
impl<'de> Deserialize<'de> for Award {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        match Value::deserialize(deserializer)? {
            Value::Number(n) => match n.as_u64() {
                Some(stars @ 1..=3) => Ok(Self::Star(stars as u8)),
                _ => Err(D::Error::custom("award 要是 1～3 或 bib")),
            },
            Value::String(s) if s == "bib" => Ok(Self::Bib),
            _ => Err(D::Error::custom("award 要是 1～3 或 bib")),
        }
    }
}

#[derive(Deserialize, Clone, Debug)]
pub struct Restaurant {
    /// 米其林網址最後一段
    pub id: String,
    pub name: String,
    pub award: Award,
    #[serde(default)]
    pub green: bool,
    pub city: String,
    pub district: String,
    pub address: String,
    /// 官網上的寫法，例如 +886 2 2181 9985
    pub phone: Option<String>,
    pub lat: f64,
    pub lng: f64,
    #[serde(default)]
    pub approx: bool,
    pub cuisine: String,
    /// 1～4，對應 $～$$$$
    pub price: u8,
    pub path: String,
    /// 上一版的獎項，跟今年一樣就沒有：`"none"` 是上一版不在指南裡，`"selected"` 是只是入選，數字是星等，`"bib"` 是必比登
    #[serde(default)]
    pub last: Option<Value>,
}

impl Restaurant {
    /// +886 2 2181 9985 → 02 2181 9985
    pub fn display_phone(&self) -> Option<String> {
        self.phone
            .as_ref()
            .map(|p| p.strip_prefix("+886").map_or_else(|| p.clone(), |rest| format!("0{}", rest.trim())))
    }

    /// 今年的變動，例如「2026 新入選」「2026 升星（上一版一星）」；跟上一版一樣是 None
    pub fn change(&self) -> Option<String> {
        let (before, name) = match self.last.as_ref()? {
            Value::String(s) if s == "none" => return Some(format!("{GUIDE_EDITION} 新入選")),
            Value::String(s) if s == "selected" => (-1, "入選"),
            Value::String(s) if s == "bib" => (0, "必比登"),
            Value::Number(n) => match n.as_u64() {
                Some(1) => (1, "一星"),
                Some(2) => (2, "二星"),
                Some(3) => (3, "三星"),
                _ => return None,
            },
            _ => return None,
        };
        Some(if i32::from(self.award.rank()) > before {
            let what = if before < 0 { "新摘星" } else { "升星" };
            format!("{GUIDE_EDITION} {what}（上一版{name}）")
        } else {
            format!("{GUIDE_EDITION} 降級（上一版{name}）")
        })
    }

    /// 站內的網址：打開地圖並選好這家
    pub fn link(&self) -> String {
        format!("/michelin?r={}", self.id)
    }
}

pub static RESTAURANTS: LazyLock<Vec<Restaurant>> = LazyLock::new(|| {
    serde_json::from_str(include_str!("michelin_restaurants.json")).expect("michelin_restaurants.json 格式不對")
});

pub fn find(id: &str) -> Option<&'static Restaurant> {
    RESTAURANTS.iter().find(|r| r.id == id)
}

/// 用店名找（不分大小寫，臺、台都可以）：空位爬蟲的資料只有店名，例如「JL Studio」對到「JL STUDIO」
pub fn find_by_name(name: &str) -> Option<&'static Restaurant> {
    let name = fold(name);
    RESTAURANTS.iter().find(|r| fold(&r.name) == name)
}

fn existing(id: &str) -> Result<&'static Restaurant, AppError> {
    find(id).ok_or_else(|| AppError::BadRequest("沒有這家餐廳".into()))
}

fn now_text() -> String {
    Utc::now().format(TIME_FORMAT).to_string()
}

// ---- 搜尋（AI 助手的 michelin_search） ----

/// 「臺」「台」都有人寫（資料裡縣市是台、料理是臺），比對前統一
pub fn fold(text: &str) -> String {
    text.trim().to_lowercase().replace('臺', "台")
}

#[derive(Default)]
pub struct Search {
    /// 關鍵字，空白分開的每一個都要出現在店名、料理、地址其中一個
    pub text: String,
    /// 縣市或區，例如「台北」「新竹」「大安區」
    pub area: String,
    /// 空的是不限
    pub awards: Vec<Award>,
    pub max_price: Option<u8>,
    pub green_only: bool,
    /// 只要今年有變動的（新入選、升星）
    pub changed_only: bool,
}

impl Search {
    pub fn matches(&self, r: &Restaurant) -> bool {
        let fields = [fold(&r.name), fold(&r.cuisine), fold(&r.address), fold(&format!("{}{}", r.city, r.district))];
        let area = fold(&self.area);
        (area.is_empty() || fields[3].contains(&area) || fields[2].contains(&area))
            && fold(&self.text).split_whitespace().all(|term| fields.iter().any(|f| f.contains(term)))
            && (self.awards.is_empty() || self.awards.contains(&r.award))
            && self.max_price.is_none_or(|max| r.price <= max)
            && (!self.green_only || r.green)
            && (!self.changed_only || r.last.is_some())
    }

    /// 符合的餐廳，星級高的在前
    pub fn run(&self) -> Vec<&'static Restaurant> {
        let mut found: Vec<_> = RESTAURANTS.iter().filter(|r| self.matches(r)).collect();
        found.sort_by(|a, b| b.award.rank().cmp(&a.award.rank()).then_with(|| a.city.cmp(&b.city)));
        found
    }
}

// ---- 想吃／吃過 ----

#[derive(Serialize, sqlx::FromRow)]
pub struct Mark {
    pub restaurant: String,
    pub status: String,
    pub visited_on: Option<String>,
    pub updated_at: String,
}

pub async fn marks_of(state: &AppState, user_id: i64) -> Result<Vec<Mark>, AppError> {
    Ok(sqlx::query_as::<_, Mark>(
        "SELECT restaurant, status, visited_on, updated_at FROM michelin_marks WHERE user_id = ?
         ORDER BY updated_at DESC, restaurant",
    )
    .bind(user_id)
    .fetch_all(&state.pool)
    .await?)
}

pub async fn list_marks(State(state): State<AppState>, user: CurrentUser) -> Result<Json<Value>, AppError> {
    Ok(Json(json!({ "marks": marks_of(&state, user.id).await? })))
}

#[derive(Deserialize)]
pub struct MarkInput {
    pub status: String,
    #[serde(default)]
    pub visited_on: Option<String>,
}

/// YYYY-MM-DD，不能是未來（多給一天：使用者在台灣，伺服器用 UTC）
fn visit_date(value: &str) -> Result<String, AppError> {
    let date = NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .map_err(|_| AppError::BadRequest("visited_on 要是 YYYY-MM-DD".into()))?;
    let latest = Utc::now().date_naive() + TimeDelta::days(1);
    if date > latest || date.year() < 1950 {
        return Err(AppError::BadRequest("吃過的日期不對".into()));
    }
    Ok(date.format("%Y-%m-%d").to_string())
}

pub async fn set_mark(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(restaurant): Path<String>,
    Json(input): Json<MarkInput>,
) -> Result<StatusCode, AppError> {
    existing(&restaurant)?;
    let date = input.visited_on.as_deref().map(str::trim).filter(|d| !d.is_empty());
    let visited_on = match (input.status.as_str(), date) {
        ("want", None) => None,
        ("want", Some(_)) => return Err(AppError::BadRequest("只有吃過的才有日期".into())),
        ("been", date) => date.map(visit_date).transpose()?,
        _ => return Err(AppError::BadRequest("status 要是 want 或 been".into())),
    };
    sqlx::query(
        "INSERT INTO michelin_marks (user_id, restaurant, status, visited_on) VALUES (?, ?, ?, ?)
         ON CONFLICT (user_id, restaurant) DO UPDATE SET
             status = excluded.status, visited_on = excluded.visited_on,
             updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')",
    )
    .bind(user.id)
    .bind(&restaurant)
    .bind(&input.status)
    .bind(visited_on)
    .execute(&state.pool)
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn delete_mark(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(restaurant): Path<String>,
) -> Result<StatusCode, AppError> {
    sqlx::query("DELETE FROM michelin_marks WHERE user_id = ? AND restaurant = ?")
        .bind(user.id)
        .bind(&restaurant)
        .execute(&state.pool)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

// ---- 訂位提醒 ----

#[derive(Serialize, sqlx::FromRow)]
pub struct Reminder {
    pub id: i64,
    pub restaurant: String,
    pub remind_at: String,
    pub note: String,
    pub sent_at: Option<String>,
}

pub async fn list_reminders(State(state): State<AppState>, user: CurrentUser) -> Result<Json<Value>, AppError> {
    let reminders = sqlx::query_as::<_, Reminder>(
        "SELECT id, restaurant, remind_at, note, sent_at FROM michelin_reminders
         WHERE user_id = ? AND (sent_at IS NULL OR sent_at >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-7 days'))
         ORDER BY remind_at, id",
    )
    .bind(user.id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(json!({ "reminders": reminders })))
}

#[derive(Deserialize)]
pub struct ReminderInput {
    pub restaurant: String,
    pub remind_at: String,
    #[serde(default)]
    pub note: String,
}

pub async fn create_reminder(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(input): Json<ReminderInput>,
) -> Result<(StatusCode, Json<Reminder>), AppError> {
    existing(&input.restaurant)?;
    let at = DateTime::parse_from_rfc3339(input.remind_at.trim())
        .map_err(|_| AppError::BadRequest("remind_at 要是 RFC 3339 的時間，例如 2026-12-01T04:00:00Z".into()))?
        .with_timezone(&Utc);
    let now = Utc::now();
    if at < now - TimeDelta::minutes(1) {
        return Err(AppError::BadRequest("提醒時間已經過了".into()));
    }
    if at > now + TimeDelta::days(MAX_AHEAD_DAYS) {
        return Err(AppError::BadRequest("提醒時間最多設到一年後".into()));
    }
    let note = clean(&input.note, MAX_NOTE_LEN);
    let pending: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM michelin_reminders WHERE user_id = ? AND sent_at IS NULL")
            .bind(user.id)
            .fetch_one(&state.pool)
            .await?;
    if pending >= MAX_PENDING_REMINDERS {
        return Err(AppError::BadRequest(format!("還沒到的提醒最多 {MAX_PENDING_REMINDERS} 個")));
    }
    let reminder = sqlx::query_as::<_, Reminder>(
        "INSERT INTO michelin_reminders (user_id, restaurant, remind_at, note) VALUES (?, ?, ?, ?)
         RETURNING id, restaurant, remind_at, note, sent_at",
    )
    .bind(user.id)
    .bind(&input.restaurant)
    .bind(at.format(TIME_FORMAT).to_string())
    .bind(note)
    .fetch_one(&state.pool)
    .await?;
    Ok((StatusCode::CREATED, Json(reminder)))
}

pub async fn delete_reminder(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<i64>,
) -> Result<StatusCode, AppError> {
    let deleted = sqlx::query("DELETE FROM michelin_reminders WHERE id = ? AND user_id = ?")
        .bind(id)
        .bind(user.id)
        .execute(&state.pool)
        .await?;
    if deleted.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(sqlx::FromRow)]
struct Due {
    id: i64,
    user_id: i64,
    restaurant: String,
    note: String,
}

/// 背景每 30 秒送一次到期的提醒
pub fn spawn(state: AppState) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(CHECK_EVERY);
        loop {
            tick.tick().await;
            if let Err(err) = send_due(&state).await {
                tracing::warn!(error = %err, "michelin reminders");
            }
        }
    });
}

/// 把到期的提醒推播出去，回傳這次送了幾則；也順便清掉送過很久的
pub async fn send_due(state: &AppState) -> Result<usize, AppError> {
    let now = now_text();
    let due = sqlx::query_as::<_, Due>(
        "SELECT id, user_id, restaurant, note FROM michelin_reminders
         WHERE sent_at IS NULL AND remind_at <= ? ORDER BY remind_at LIMIT 200",
    )
    .bind(&now)
    .fetch_all(&state.pool)
    .await?;
    let mut sent = 0;
    for row in due {
        // 先搶下來：另一個容器已經搶走的就不送
        let claimed = sqlx::query("UPDATE michelin_reminders SET sent_at = ? WHERE id = ? AND sent_at IS NULL")
            .bind(&now)
            .bind(row.id)
            .execute(&state.pool)
            .await?;
        if claimed.rows_affected() == 0 {
            continue;
        }
        let name = find(&row.restaurant).map_or(row.restaurant.as_str(), |r| r.name.as_str());
        let body = if row.note.is_empty() { "到了你設定的訂位時間".to_owned() } else { row.note };
        let payload = json!({
            "title": format!("⏰ {name}"),
            "body": body,
            "tag": format!("michelin-reminder-{}", row.id),
            "url": format!("/michelin?r={}", row.restaurant),
        });
        webpush::notify(state, row.user_id, None, &payload).await;
        sent += 1;
    }
    sqlx::query("DELETE FROM michelin_reminders WHERE sent_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?)")
        .bind(format!("-{KEEP_SENT_DAYS} days"))
        .execute(&state.pool)
        .await?;
    Ok(sent)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_loads_and_ids_are_unique() {
        assert_eq!(RESTAURANTS.len(), 207);
        let mut ids: Vec<_> = RESTAURANTS.iter().map(|r| r.id.as_str()).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), RESTAURANTS.len());
        assert_eq!(find("le-palais").map(|r| r.award), Some(Award::Star(3)));
        assert_eq!(find("le-palais").and_then(Restaurant::display_phone).as_deref(), Some("02 2181 9985"));
    }

    #[test]
    fn search_folds_tai_and_combines_filters() {
        let names = |s: Search| s.run().iter().map(|r| r.name.clone()).collect::<Vec<_>>();
        // 料理寫的是「臺灣菜」，用「台灣菜」也找得到
        let taiwanese = names(Search { text: "台灣菜".into(), ..Default::default() });
        assert!(taiwanese.len() >= 40, "{taiwanese:?}");
        let three = names(Search { awards: vec![Award::Star(3)], ..Default::default() });
        assert_eq!(three.len(), 3);
        assert!(three.contains(&"頤宮".to_owned()));
        let cheap_tainan =
            Search { area: "臺南".into(), max_price: Some(1), awards: vec![Award::Bib], ..Default::default() };
        let found = cheap_tainan.run();
        assert!(!found.is_empty());
        assert!(found.iter().all(|r| r.city == "台南市" && r.price == 1 && r.award == Award::Bib));
        // 新竹包含新竹市和新竹縣
        let hsinchu = Search { area: "新竹".into(), ..Default::default() }.run();
        assert!(hsinchu.iter().any(|r| r.city == "新竹縣") && hsinchu.iter().any(|r| r.city == "新竹市"));
        // 星級高的在前
        let all = Search::default().run();
        assert!(all.windows(2).all(|w| w[0].award.rank() >= w[1].award.rank()));
    }

    #[test]
    fn yearly_changes_and_green_stars() {
        let change = |id: &str| find(id).and_then(Restaurant::change);
        assert_eq!(change("mizue").as_deref(), Some("2026 新入選"));
        assert_eq!(change("nobuo").as_deref(), Some("2026 升星（上一版一星）"));
        assert_eq!(change("mume").as_deref(), Some("2026 新摘星（上一版入選）"));
        assert_eq!(change("le-palais"), None);
        // 官網 2026 名單：2 家新二星、9 家新一星、13 家新入選的必比登
        let changed = Search { changed_only: true, ..Default::default() }.run();
        assert_eq!(changed.len(), 24);
        assert_eq!(changed.iter().filter(|r| r.award == Award::Bib).count(), 13);
        let green: Vec<_> = RESTAURANTS.iter().filter(|r| r.green).map(|r| r.id.as_str()).collect();
        assert_eq!(green.len(), 5, "{green:?}");
    }
}
