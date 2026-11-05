//! 日曆的「一句話新增」：把「下週三晚上七點跟阿明吃飯」交給 AI 整理成事項的欄位，
//! 回傳草稿讓前端打開新增事項的視窗，使用者看過、按儲存才會真的存（走原本的 `POST /api/calendar/events`）。
//!
//! AI 只負責看懂句子；日期檢查、農曆換國曆由這裡處理，算錯的欄位就換成合理的預設值。

use axum::{Json, extract::State};
use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{
    AppError, AppState,
    ai::{ChatOptions, Message},
    ai_usage::{self, Record},
    auth::CurrentUser,
    lunar,
};

const MAX_INPUT_CHARS: usize = 500;
const REPEATS: &[&str] = &["none", "daily", "weekly", "monthly", "yearly", "lunar_monthly", "lunar_yearly"];

#[derive(Deserialize)]
pub struct ParseInput {
    pub text: String,
}

/// 跟 `calendar::EventInput` 一樣的欄位，前端直接拿去填表單
#[derive(Serialize, Debug, PartialEq)]
pub struct Draft {
    pub title: String,
    pub note: String,
    pub color: String,
    pub start_date: String,
    pub end_date: String,
    pub repeat: String,
    pub interval: u32,
    pub weekdays: Vec<u8>,
    pub until: Option<String>,
    pub excluded: Vec<String>,
    /// 用農曆說的日期，例如「農曆八月十五」，給使用者對照
    pub lunar_label: Option<String>,
}

fn prompt(today: NaiveDate) -> String {
    let lunar = lunar::lunar_of(today).map(|l| format!("，農曆{}", lunar::label(l))).unwrap_or_default();
    format!(
        "你把使用者的一句話整理成日曆事項，只輸出一個 JSON 物件，不要其他文字。\n\
         今天是 {today}（星期{}）{lunar}，日期一律用 YYYY-MM-DD，相對日期（明天、下週三、月底）以今天推算。\n\
         欄位：\n\
         - title：簡短的標題（例如「跟阿明吃飯」），不要包含日期\n\
         - start_date、end_date：開始和結束日期（含），只有一天就一樣\n\
         - note：時間、地點等細節（例如「19:00 信義區」），沒有就空字串\n\
         - repeat：none、daily、weekly、monthly、yearly、lunar_monthly、lunar_yearly 其中一個；生日、紀念日用 yearly，\
           農曆生日用 lunar_yearly\n\
         - interval：每幾個單位重複一次，通常是 1\n\
         - weekdays：weekly 時是星期幾（0 是星期日），其他是 []\n\
         - until：重複到哪天為止，沒說就是 null\n\
         - lunar_month、lunar_day：使用者用農曆說日期時填（例如農曆八月十五是 8 和 15），否則 null",
        lunar::weekday_name(today)
    )
}

fn schema() -> Value {
    json!({
        "type": "json_schema",
        "json_schema": {
            "name": "calendar_event",
            "schema": {
                "type": "object",
                "properties": {
                    "title": { "type": "string" },
                    "start_date": { "type": "string" },
                    "end_date": { "type": "string" },
                    "note": { "type": "string" },
                    "repeat": { "type": "string", "enum": REPEATS },
                    "interval": { "type": "integer" },
                    "weekdays": { "type": "array", "items": { "type": "integer" } },
                    "until": { "type": ["string", "null"] },
                    "lunar_month": { "type": ["integer", "null"] },
                    "lunar_day": { "type": ["integer", "null"] }
                },
                "required": ["title", "start_date", "end_date", "note", "repeat", "interval", "weekdays", "until",
                             "lunar_month", "lunar_day"]
            }
        }
    })
}

/// 回答裡的第一個 JSON 物件（模型偶爾會在前後多講話或包在 ```json 裡）
fn extract_json(text: &str) -> Option<Value> {
    if let Ok(value) = serde_json::from_str::<Value>(text.trim()) {
        return value.is_object().then_some(value);
    }
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    serde_json::from_str(text.get(start..=end)?).ok().filter(Value::is_object)
}

fn date(value: &Value) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(value.as_str()?.trim(), "%Y-%m-%d").ok()
}

/// AI 的回答整理成可以直接填表單的草稿
fn to_draft(value: &Value, today: NaiveDate) -> Result<Draft, AppError> {
    let title: String = value["title"].as_str().unwrap_or_default().trim().chars().take(100).collect();
    if title.is_empty() {
        return Err(AppError::BadRequest("看不出要記什麼，換個說法試試".into()));
    }
    let note: String = value["note"].as_str().unwrap_or_default().trim().chars().take(2000).collect();
    let mut repeat = value["repeat"].as_str().filter(|r| REPEATS.contains(r)).unwrap_or("none").to_owned();
    let mut start = date(&value["start_date"]).unwrap_or(today);
    let mut end = date(&value["end_date"]).filter(|end| *end >= start);
    let mut lunar_label = None;

    let lunar_month = value["lunar_month"].as_u64().map(|m| m as u32);
    let lunar_day = value["lunar_day"].as_u64().map(|d| d as u32);
    if let (Some(month), Some(day)) = (lunar_month, lunar_day) {
        // 農曆日期由這裡換算，不信任模型算的國曆
        let span = end.map(|end| end - start);
        let from = date(&value["start_date"]).filter(|d| *d > today).map_or(today, |d| d - chrono::Days::new(40));
        if let Some(solar) = lunar::next_solar(from.max(today), month, day) {
            start = solar;
            end = span.map(|span| solar + span);
            lunar_label = lunar::lunar_of(solar).map(|l| format!("農曆{}", lunar::label(l)));
            repeat = match repeat.as_str() {
                "yearly" => "lunar_yearly".into(),
                "monthly" => "lunar_monthly".into(),
                other => other.into(),
            };
        }
    }
    let end = end.unwrap_or(start);
    let end = if (end - start).num_days() > 365 { start } else { end };
    let repeating = repeat != "none";
    let interval = value["interval"].as_u64().unwrap_or(1).clamp(1, 999) as u32;
    let weekdays: Vec<u8> = if repeat == "weekly" {
        let mut days: Vec<u8> = value["weekdays"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|d| d.as_u64())
            .filter(|d| *d <= 6)
            .map(|d| d as u8)
            .collect();
        days.sort_unstable();
        days.dedup();
        days
    } else {
        Vec::new()
    };
    let until = date(&value["until"]).filter(|u| repeating && *u >= start).map(|u| u.to_string());
    Ok(Draft {
        title,
        note,
        color: "orange".into(),
        start_date: start.to_string(),
        end_date: end.to_string(),
        interval: if repeating && !repeat.starts_with("lunar_") { interval } else { 1 },
        repeat,
        weekdays,
        until,
        excluded: Vec::new(),
        lunar_label,
    })
}

pub async fn parse(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(input): Json<ParseInput>,
) -> Result<Json<Draft>, AppError> {
    let text = input.text.trim();
    if text.is_empty() {
        return Err(AppError::BadRequest("請輸入要記的事".into()));
    }
    if text.chars().count() > MAX_INPUT_CHARS {
        return Err(AppError::BadRequest(format!("最多 {MAX_INPUT_CHARS} 字")));
    }
    if crate::ai::active_provider(&state.pool).await?.is_none() {
        return Err(AppError::ServiceUnavailable("AI 功能尚未開放"));
    }
    let guard = ai_usage::begin(&state, &user, true).await?;
    let today = ai_usage::taipei_today();
    let messages = [Message::new("system", prompt(today)), Message::new("user", text)];
    let options = ChatOptions {
        thinking: Some(false),
        temperature: Some(0.1),
        max_tokens: Some(600),
        response_format: Some(schema()),
        ..ChatOptions::default()
    };
    let result = state.ai.complete(&state.pool, &messages, &options).await;
    let mut record = Record { ok: result.is_ok(), ms: guard.elapsed_ms(), ..Record::default() };
    if let Ok(completion) = &result {
        record.add(completion.usage.as_ref());
    }
    ai_usage::record(&state.pool, user.id, "calendar", record).await;
    let completion = result?;
    let value =
        extract_json(&completion.content).ok_or_else(|| AppError::BadRequest("AI 沒有看懂，換個說法試試".into()))?;
    Ok(Json(to_draft(&value, today)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn today() -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 11, 5).unwrap()
    }

    #[test]
    fn json_is_found_inside_extra_text() {
        assert!(extract_json("```json\n{\"title\":\"a\"}\n```").is_some());
        assert!(extract_json("好的：{\"title\":\"a\"}").is_some());
        assert!(extract_json("沒有").is_none());
    }

    #[test]
    fn plain_event() {
        let value = json!({ "title": "跟阿明吃飯", "start_date": "2026-11-11", "end_date": "2026-11-11",
                            "note": "19:00", "repeat": "none", "interval": 1, "weekdays": [], "until": null,
                            "lunar_month": null, "lunar_day": null });
        let draft = to_draft(&value, today()).unwrap();
        assert_eq!(draft.start_date, "2026-11-11");
        assert_eq!(draft.end_date, "2026-11-11");
        assert_eq!(draft.repeat, "none");
        assert_eq!(draft.note, "19:00");
    }

    #[test]
    fn lunar_birthday_is_converted_here() {
        // 模型算錯國曆也沒關係，以農曆欄位為準
        let value = json!({ "title": "媽媽生日", "start_date": "2026-08-15", "end_date": "2026-08-15", "note": "",
                            "repeat": "yearly", "interval": 1, "weekdays": [], "until": null,
                            "lunar_month": 8, "lunar_day": 15 });
        let draft = to_draft(&value, today()).unwrap();
        assert_eq!(draft.start_date, "2027-09-15");
        assert_eq!(draft.repeat, "lunar_yearly");
        assert_eq!(draft.lunar_label.as_deref(), Some("農曆八月十五"));
    }

    #[test]
    fn bad_fields_fall_back() {
        let value = json!({ "title": " 繳費 ", "start_date": "下週", "end_date": "2026-01-01", "repeat": "hourly",
                            "interval": 0, "weekdays": [9], "until": "2020-01-01" });
        let draft = to_draft(&value, today()).unwrap();
        assert_eq!(draft.title, "繳費");
        assert_eq!(draft.start_date, "2026-11-05");
        assert_eq!(draft.end_date, "2026-11-05");
        assert_eq!(draft.repeat, "none");
        assert_eq!(draft.until, None);
        assert!(to_draft(&json!({ "title": "" }), today()).is_err());
    }
}
