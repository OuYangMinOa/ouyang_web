//! 農曆換算（查表法），跟前端的 `frontend/src/calendar/lunar.ts` 用同一份表（1900–2100 年，香港天文台的農曆對照表）。
//! AI 助手把「農曆八月十五」換成國曆日期時用。
//!
//! 每年一個數字：
//!   bit 0–3   閏哪個月（0 是沒有閏月）
//!   bit 4–15  正月到十二月是大月（30 天）還是小月（29 天），正月在 bit 15
//!   bit 16    閏月是大月還是小月

use std::sync::LazyLock;

use chrono::{Datelike, NaiveDate, TimeDelta};

const FIRST_YEAR: i32 = 1900;

#[rustfmt::skip]
const LUNAR_INFO: [u32; 201] = [
    0x04bd8, 0x04ae0, 0x0a570, 0x054d5, 0x0d260, 0x0d950, 0x16554, 0x056a0, 0x09ad0, 0x055d2,
    0x04ae0, 0x0a5b6, 0x0a4d0, 0x0d250, 0x1d255, 0x0b540, 0x0d6a0, 0x0ada2, 0x095b0, 0x14977,
    0x04970, 0x0a4b0, 0x0b4b5, 0x06a50, 0x06d40, 0x1ab54, 0x02b60, 0x09570, 0x052f2, 0x04970,
    0x06566, 0x0d4a0, 0x0ea50, 0x16a95, 0x05ad0, 0x02b60, 0x186e3, 0x092e0, 0x1c8d7, 0x0c950,
    0x0d4a0, 0x1d8a6, 0x0b550, 0x056a0, 0x1a5b4, 0x025d0, 0x092d0, 0x0d2b2, 0x0a950, 0x0b557,
    0x06ca0, 0x0b550, 0x15355, 0x04da0, 0x0a5b0, 0x14573, 0x052b0, 0x0a9a8, 0x0e950, 0x06aa0,
    0x0aea6, 0x0ab50, 0x04b60, 0x0aae4, 0x0a570, 0x05260, 0x0f263, 0x0d950, 0x05b57, 0x056a0,
    0x096d0, 0x04dd5, 0x04ad0, 0x0a4d0, 0x0d4d4, 0x0d250, 0x0d558, 0x0b540, 0x0b6a0, 0x195a6,
    0x095b0, 0x049b0, 0x0a974, 0x0a4b0, 0x0b27a, 0x06a50, 0x06d40, 0x0af46, 0x0ab60, 0x09570,
    0x04af5, 0x04970, 0x064b0, 0x074a3, 0x0ea50, 0x06b58, 0x05ac0, 0x0ab60, 0x096d5, 0x092e0,
    0x0c960, 0x0d954, 0x0d4a0, 0x0da50, 0x07552, 0x056a0, 0x0abb7, 0x025d0, 0x092d0, 0x0cab5,
    0x0a950, 0x0b4a0, 0x0baa4, 0x0ad50, 0x055d9, 0x04ba0, 0x0a5b0, 0x15176, 0x052b0, 0x0a930,
    0x07954, 0x06aa0, 0x0ad50, 0x05b52, 0x04b60, 0x0a6e6, 0x0a4e0, 0x0d260, 0x0ea65, 0x0d530,
    0x05aa0, 0x076a3, 0x096d0, 0x04afb, 0x04ad0, 0x0a4d0, 0x1d0b6, 0x0d250, 0x0d520, 0x0dd45,
    0x0b5a0, 0x056d0, 0x055b2, 0x049b0, 0x0a577, 0x0a4b0, 0x0aa50, 0x1b255, 0x06d20, 0x0ada0,
    0x14b63, 0x09370, 0x049f8, 0x04970, 0x064b0, 0x168a6, 0x0ea50, 0x06aa0, 0x1a6c4, 0x0aae0,
    0x092e0, 0x0d2e3, 0x0c960, 0x0d557, 0x0d4a0, 0x0da50, 0x05d55, 0x056a0, 0x0a6d0, 0x055d4,
    0x052d0, 0x0a9b8, 0x0a950, 0x0b4a0, 0x0b6a6, 0x0ad50, 0x055a0, 0x0aba4, 0x0a5b0, 0x052b0,
    0x0b273, 0x06930, 0x07337, 0x06aa0, 0x0ad50, 0x14b55, 0x04b60, 0x0a570, 0x054e4, 0x0d160,
    0x0e968, 0x0d520, 0x0daa0, 0x16aa6, 0x056d0, 0x04ae0, 0x0a9d4, 0x0a2d0, 0x0d150, 0x0f252,
    0x0d520,
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LunarDate {
    /// 農曆年對應的西元年（正月初一所在的那一年）
    pub year: i32,
    pub month: u32,
    pub leap: bool,
    pub day: u32,
}

struct LunarMonth {
    month: u32,
    leap: bool,
    days: u32,
    start: NaiveDate,
}

/// 每個農曆年的月份（含閏月）與每個月初一是哪天
static YEARS: LazyLock<Vec<Vec<LunarMonth>>> = LazyLock::new(|| {
    // 1900 年正月初一是 1900-01-31
    let mut start = NaiveDate::from_ymd_opt(1900, 1, 31).expect("valid date");
    LUNAR_INFO
        .iter()
        .map(|&info| {
            let leap_month = info & 0xf;
            let mut months = Vec::with_capacity(13);
            for month in 1..=12 {
                let days = if info & (0x10000 >> month) != 0 { 30 } else { 29 };
                months.push(LunarMonth { month, leap: false, days, start });
                start += TimeDelta::days(days.into());
                if month == leap_month {
                    let days = if info & 0x10000 != 0 { 30 } else { 29 };
                    months.push(LunarMonth { month, leap: true, days, start });
                    start += TimeDelta::days(days.into());
                }
            }
            months
        })
        .collect()
});

/// 國曆轉農曆；超出表格範圍回傳 None
pub fn lunar_of(date: NaiveDate) -> Option<LunarDate> {
    for (i, months) in YEARS.iter().enumerate() {
        let last = months.last()?;
        if date < months[0].start {
            return None;
        }
        if date >= last.start + TimeDelta::days(last.days.into()) {
            continue;
        }
        let m = months.iter().rev().find(|m| m.start <= date)?;
        let day = (date - m.start).num_days() as u32 + 1;
        return Some(LunarDate { year: FIRST_YEAR + i as i32, month: m.month, leap: m.leap, day });
    }
    None
}

/// 農曆 `year` 年 `month` 月 `day` 日是國曆哪一天；那個月沒有這天（小月的三十）、沒有這個閏月或超出範圍回傳 None
pub fn to_solar(year: i32, month: u32, day: u32, leap: bool) -> Option<NaiveDate> {
    let months = YEARS.get(usize::try_from(year - FIRST_YEAR).ok()?)?;
    let m = months.iter().find(|m| m.month == month && m.leap == leap)?;
    (1..=m.days).contains(&day).then(|| m.start + TimeDelta::days((day - 1).into()))
}

/// 從 `from` 那天起（含），下一個農曆 `month` 月 `day` 日是國曆哪一天（非閏月；小月沒有三十就用二十九）
pub fn next_solar(from: NaiveDate, month: u32, day: u32) -> Option<NaiveDate> {
    if !(1..=12).contains(&month) || !(1..=30).contains(&day) {
        return None;
    }
    let start = lunar_of(from)?.year;
    (start..start + 3).find_map(|year| {
        let date = to_solar(year, month, day, false)
            .or_else(|| to_solar(year, month, day - 1, false).filter(|_| day == 30))?;
        (date >= from).then_some(date)
    })
}

const MONTH_NAMES: [&str; 12] = ["正", "二", "三", "四", "五", "六", "七", "八", "九", "十", "冬", "臘"];
const DIGITS: [&str; 10] = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];

/// 「閏六月初一」
pub fn label(lunar: LunarDate) -> String {
    let day = match lunar.day {
        d @ 1..=10 => format!("初{}", DIGITS[d as usize - 1]),
        d @ 11..=19 => format!("十{}", DIGITS[d as usize - 11]),
        20 => "二十".into(),
        d @ 21..=29 => format!("廿{}", DIGITS[d as usize - 21]),
        _ => "三十".into(),
    };
    let leap = if lunar.leap { "閏" } else { "" };
    format!("{leap}{}月{day}", MONTH_NAMES[lunar.month as usize - 1])
}

/// 國曆日期的星期（「一」…「日」）
pub fn weekday_name(date: NaiveDate) -> &'static str {
    ["一", "二", "三", "四", "五", "六", "日"][date.weekday().num_days_from_monday() as usize]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn date(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    #[test]
    fn known_dates() {
        // 2027 年春節是 2/6（瀏覽器的 Intl 會算成 2/7）
        assert_eq!(lunar_of(date("2027-02-06")), Some(LunarDate { year: 2027, month: 1, leap: false, day: 1 }));
        assert_eq!(to_solar(2026, 8, 15, false), Some(date("2026-09-25")));
        assert_eq!(label(lunar_of(date("2026-09-25")).unwrap()), "八月十五");
        // 2025 年閏六月
        assert_eq!(lunar_of(date("2025-07-25")), Some(LunarDate { year: 2025, month: 6, leap: true, day: 1 }));
        assert_eq!(to_solar(2025, 6, 1, true), Some(date("2025-07-25")));
        assert_eq!(to_solar(2026, 6, 1, true), None);
    }

    #[test]
    fn next_occurrence() {
        assert_eq!(next_solar(date("2026-11-05"), 8, 15), Some(date("2027-09-15")));
        assert_eq!(next_solar(date("2026-09-01"), 8, 15), Some(date("2026-09-25")));
        assert_eq!(next_solar(date("2026-09-25"), 8, 15), Some(date("2026-09-25")));
        assert_eq!(next_solar(date("2026-01-01"), 13, 1), None);
    }
}
