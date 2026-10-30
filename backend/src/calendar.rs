//! 日曆的個人事項：登入就能用，每個人只看得到、改得到自己的事項。
//!
//! 後端只存事項和重複規則，不展開成每一次；展開由前端做（農曆重複要換算農曆，見 migrations/0004）。

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use serde::{Deserialize, Serialize};

use crate::{AppError, AppState, auth::CurrentUser};

const MAX_TITLE_LEN: usize = 100;
const MAX_NOTE_LEN: usize = 2000;
/// 一個事項最長跨幾天（含頭尾）
const MAX_SPAN_DAYS: i64 = 366;
const MAX_INTERVAL: u32 = 999;
const MAX_EXCLUDED: usize = 500;
const MAX_EVENTS_PER_USER: i64 = 2000;
/// 農曆換算只支援這個範圍
const YEARS: std::ops::RangeInclusive<i64> = 1901..=2099;

const COLORS: &[&str] = &["orange", "blue", "green", "red", "purple", "teal"];
const REPEATS: &[&str] = &["none", "daily", "weekly", "monthly", "yearly", "lunar_monthly", "lunar_yearly"];

/// 事項的欄位，後面接上 WHERE / RETURNING 的位置（用 concat! 組成靜態字串）
macro_rules! event_columns {
    () => {
        "id, title, note, color, start_date, end_date, repeat, repeat_interval, weekdays, repeat_until, excluded,
         created_at, updated_at"
    };
}

#[derive(sqlx::FromRow)]
struct EventRow {
    id: i64,
    title: String,
    note: String,
    color: String,
    start_date: String,
    end_date: String,
    repeat: String,
    repeat_interval: i64,
    weekdays: i64,
    repeat_until: Option<String>,
    excluded: String,
    created_at: String,
    updated_at: String,
}

#[derive(Serialize)]
pub struct CalendarEvent {
    pub id: i64,
    pub title: String,
    pub note: String,
    pub color: String,
    pub start_date: String,
    pub end_date: String,
    pub repeat: String,
    pub interval: i64,
    /// 0 = 星期日 … 6 = 星期六，只有 weekly 會有
    pub weekdays: Vec<u8>,
    pub until: Option<String>,
    pub excluded: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl From<EventRow> for CalendarEvent {
    fn from(row: EventRow) -> Self {
        Self {
            id: row.id,
            title: row.title,
            note: row.note,
            color: row.color,
            start_date: row.start_date,
            end_date: row.end_date,
            repeat: row.repeat,
            interval: row.repeat_interval,
            weekdays: (0..7).filter(|day| row.weekdays & (1 << day) != 0).collect(),
            until: row.repeat_until,
            excluded: serde_json::from_str(&row.excluded).unwrap_or_default(),
            created_at: row.created_at,
            updated_at: row.updated_at,
        }
    }
}

#[derive(Deserialize)]
pub struct EventInput {
    pub title: String,
    #[serde(default)]
    pub note: String,
    #[serde(default = "default_color")]
    pub color: String,
    pub start_date: String,
    pub end_date: String,
    #[serde(default = "default_repeat")]
    pub repeat: String,
    #[serde(default = "default_interval")]
    pub interval: u32,
    #[serde(default)]
    pub weekdays: Vec<u8>,
    #[serde(default)]
    pub until: Option<String>,
    #[serde(default)]
    pub excluded: Vec<String>,
}

fn default_color() -> String {
    COLORS[0].into()
}

fn default_repeat() -> String {
    "none".into()
}

fn default_interval() -> u32 {
    1
}

/// 檢查過、整理好可以直接寫進資料庫的事項
struct ValidEvent {
    title: String,
    note: String,
    color: String,
    start_date: String,
    end_date: String,
    repeat: String,
    interval: u32,
    weekdays: i64,
    until: Option<String>,
    excluded: String,
}

/// 西元日期轉成 1970-01-01 起算的天數（Howard Hinnant 的 days_from_civil）
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// 嚴格的 YYYY-MM-DD，回傳天數
fn parse_date(value: &str) -> Option<i64> {
    let bytes = value.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let number = |range: std::ops::Range<usize>| -> Option<i64> {
        let part = &value[range];
        part.bytes().all(|b| b.is_ascii_digit()).then(|| part.parse().ok())?
    };
    let (year, month, day) = (number(0..4)?, number(5..7)?, number(8..10)?);
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let month_days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return None,
    };
    if !YEARS.contains(&year) || !(1..=month_days).contains(&day) {
        return None;
    }
    Some(days_from_civil(year, month, day))
}

fn require_date(value: &str, field: &str) -> Result<i64, AppError> {
    parse_date(value).ok_or_else(|| {
        AppError::BadRequest(format!("{field}需為 {}–{} 年之間的 YYYY-MM-DD", YEARS.start(), YEARS.end()))
    })
}

fn validate(input: EventInput) -> Result<ValidEvent, AppError> {
    let title = input.title.trim();
    if title.is_empty() {
        return Err(AppError::BadRequest("標題不可為空".into()));
    }
    if title.chars().count() > MAX_TITLE_LEN {
        return Err(AppError::BadRequest(format!("標題不可超過 {MAX_TITLE_LEN} 字")));
    }
    let note = input.note.trim();
    if note.chars().count() > MAX_NOTE_LEN {
        return Err(AppError::BadRequest(format!("備註不可超過 {MAX_NOTE_LEN} 字")));
    }
    if !COLORS.contains(&input.color.as_str()) {
        return Err(AppError::BadRequest("顏色不正確".into()));
    }

    let start = require_date(&input.start_date, "開始日期")?;
    let end = require_date(&input.end_date, "結束日期")?;
    if end < start {
        return Err(AppError::BadRequest("結束日期不能早於開始日期".into()));
    }
    if end - start + 1 > MAX_SPAN_DAYS {
        return Err(AppError::BadRequest(format!("一個事項最多 {MAX_SPAN_DAYS} 天")));
    }

    if !REPEATS.contains(&input.repeat.as_str()) {
        return Err(AppError::BadRequest("重複方式不正確".into()));
    }
    let repeating = input.repeat != "none";
    if !(1..=MAX_INTERVAL).contains(&input.interval) {
        return Err(AppError::BadRequest(format!("重複間隔需為 1–{MAX_INTERVAL}")));
    }
    let interval = if input.repeat.starts_with("lunar_") || !repeating { 1 } else { input.interval };

    let weekdays = if input.repeat == "weekly" {
        if input.weekdays.iter().any(|&day| day > 6) {
            return Err(AppError::BadRequest("星期需為 0–6".into()));
        }
        // 沒選就用開始日期那天的星期（1970-01-01 是星期四）
        let start_weekday = (start + 4).rem_euclid(7) as u8;
        let days = if input.weekdays.is_empty() { vec![start_weekday] } else { input.weekdays };
        days.iter().fold(0, |mask, &day| mask | 1 << day)
    } else {
        0
    };

    let until = match input.until.filter(|_| repeating) {
        Some(until) => {
            if require_date(&until, "重複結束日期")? < start {
                return Err(AppError::BadRequest("重複結束日期不能早於開始日期".into()));
            }
            Some(until)
        }
        None => None,
    };

    let mut excluded = if repeating { input.excluded } else { Vec::new() };
    for date in &excluded {
        require_date(date, "略過的日期")?;
    }
    excluded.sort();
    excluded.dedup();
    if excluded.len() > MAX_EXCLUDED {
        return Err(AppError::BadRequest(format!("略過的日期最多 {MAX_EXCLUDED} 個")));
    }

    Ok(ValidEvent {
        title: title.into(),
        note: note.into(),
        color: input.color,
        start_date: input.start_date,
        end_date: input.end_date,
        repeat: input.repeat,
        interval,
        weekdays,
        until,
        excluded: serde_json::to_string(&excluded).map_err(|err| AppError::Internal(err.to_string()))?,
    })
}

pub async fn list_events(
    State(state): State<AppState>,
    user: CurrentUser,
) -> Result<Json<Vec<CalendarEvent>>, AppError> {
    let rows = sqlx::query_as::<_, EventRow>(concat!(
        "SELECT ",
        event_columns!(),
        " FROM calendar_events WHERE user_id = ? ORDER BY start_date, id"
    ))
    .bind(user.id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(rows.into_iter().map(Into::into).collect()))
}

pub async fn create_event(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(input): Json<EventInput>,
) -> Result<(StatusCode, Json<CalendarEvent>), AppError> {
    let event = validate(input)?;
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM calendar_events WHERE user_id = ?")
        .bind(user.id)
        .fetch_one(&state.pool)
        .await?;
    if count >= MAX_EVENTS_PER_USER {
        return Err(AppError::BadRequest(format!("事項最多 {MAX_EVENTS_PER_USER} 個")));
    }

    let row = sqlx::query_as::<_, EventRow>(concat!(
        "INSERT INTO calendar_events
            (user_id, title, note, color, start_date, end_date, repeat, repeat_interval, weekdays, repeat_until, excluded)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING ",
        event_columns!()
    ))
    .bind(user.id)
    .bind(event.title)
    .bind(event.note)
    .bind(event.color)
    .bind(event.start_date)
    .bind(event.end_date)
    .bind(event.repeat)
    .bind(event.interval)
    .bind(event.weekdays)
    .bind(event.until)
    .bind(event.excluded)
    .fetch_one(&state.pool)
    .await?;
    Ok((StatusCode::CREATED, Json(row.into())))
}

/// 整筆取代；別人的事項一律當作不存在
pub async fn update_event(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<i64>,
    Json(input): Json<EventInput>,
) -> Result<Json<CalendarEvent>, AppError> {
    let event = validate(input)?;
    let row = sqlx::query_as::<_, EventRow>(concat!(
        "UPDATE calendar_events SET
            title = ?, note = ?, color = ?, start_date = ?, end_date = ?, repeat = ?, repeat_interval = ?,
            weekdays = ?, repeat_until = ?, excluded = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
         WHERE id = ? AND user_id = ?
         RETURNING ",
        event_columns!()
    ))
    .bind(event.title)
    .bind(event.note)
    .bind(event.color)
    .bind(event.start_date)
    .bind(event.end_date)
    .bind(event.repeat)
    .bind(event.interval)
    .bind(event.weekdays)
    .bind(event.until)
    .bind(event.excluded)
    .bind(id)
    .bind(user.id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or(AppError::NotFound)?;
    Ok(Json(row.into()))
}

pub async fn delete_event(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<i64>,
) -> Result<StatusCode, AppError> {
    let result = sqlx::query("DELETE FROM calendar_events WHERE id = ? AND user_id = ?")
        .bind(id)
        .bind(user.id)
        .execute(&state.pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_only_real_dates() {
        assert_eq!(parse_date("1970-01-01"), Some(0));
        assert_eq!(parse_date("2026-10-30"), Some(20_756));
        assert_eq!(parse_date("2024-02-29").map(|d| d - parse_date("2024-02-28").unwrap()), Some(1));
        for bad in ["2025-02-29", "2026-13-01", "2026-00-10", "2026-1-01", "2026/10/30", "+026-10-30", "2100-01-01"] {
            assert_eq!(parse_date(bad), None, "{bad}");
        }
    }
}
