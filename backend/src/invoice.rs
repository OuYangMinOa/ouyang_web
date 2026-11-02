//! 統一發票中獎號碼，給小工具「統一發票對獎」用。
//!
//! 號碼來自財政部的 RSS（`invoice.etax.nat.gov.tw/invoice.xml`，免金鑰，有最近六期的特別獎、特獎、頭獎）。
//! RSS 沒有領獎期間，最新兩期另外讀各期的公告頁（`ETW183W2_<期別>`）補上，順便看有沒有增開六獎；
//! 公告頁讀不到就用規則推算（開獎隔月 6 日起三個月）。
//!
//! 開獎日是單月 25 日下午，那兩天每 10 分鐘看一次，其他時候半天一次；抓失敗時沿用上一次的資料（見 `weather::Cached`）。

use std::{sync::Arc, time::Duration};

use axum::{Json, extract::State};
use chrono::{DateTime, Datelike, FixedOffset, Months, NaiveDate, Utc};
use serde::Serialize;

use crate::{AppError, AppState, weather::Cached};

const RSS_URL: &str = "https://invoice.etax.nat.gov.tw/invoice.xml";
const PAGE_URL: &str = "https://www.etax.nat.gov.tw/etw-main/ETW183W2_";
/// 開獎那兩天
const DRAW_DAY_TTL: Duration = Duration::from_secs(10 * 60);
const NORMAL_TTL: Duration = Duration::from_secs(12 * 60 * 60);
/// 讀公告頁補領獎期間的期數
const DETAIL_PERIODS: usize = 2;

#[derive(Default)]
pub struct Invoice {
    pub report: Cached<InvoiceReport>,
}

#[derive(Serialize, Debug)]
pub struct InvoiceReport {
    pub updated_at: String,
    /// 新的在前
    pub periods: Vec<Period>,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Period {
    /// 民國年＋起始月，例如 `11507` 是 115 年 7～8 月
    pub id: String,
    pub year: u32,
    pub months: [u32; 2],
    /// 開獎日、領獎期間（西元 `YYYY-MM-DD`）
    pub draw_date: String,
    pub claim_start: String,
    pub claim_end: String,
    pub special: String,
    pub grand: String,
    pub first: Vec<String>,
    /// 增開六獎（三碼），沒有就是空的
    pub extra: Vec<String>,
    pub link: String,
}

pub async fn winning(State(state): State<AppState>) -> Result<Json<Arc<InvoiceReport>>, AppError> {
    let http = state.weather.http.clone();
    let report = state.invoice.report.get(ttl(taipei_today()), || async move { build_report(&http).await }).await?;
    Ok(Json(report))
}

fn taipei_today() -> NaiveDate {
    Utc::now().with_timezone(&FixedOffset::east_opt(8 * 3600).unwrap()).date_naive()
}

/// 單月 25、26 日（開獎當天和隔天）常常看，其他時候號碼不會變
fn ttl(today: NaiveDate) -> Duration {
    if today.month() % 2 == 1 && (25..=26).contains(&today.day()) { DRAW_DAY_TTL } else { NORMAL_TTL }
}

async fn build_report(http: &reqwest::Client) -> Result<InvoiceReport, String> {
    let rss = get_text(http, RSS_URL).await?;
    let mut periods = parse_rss(&rss);
    if periods.is_empty() {
        return Err(format!("{RSS_URL}: 資料格式不認得"));
    }
    // 公告頁只是補充，讀不到就用推算的領獎期間
    let urls: Vec<String> = periods.iter().take(DETAIL_PERIODS).map(|p| format!("{PAGE_URL}{}/", p.id)).collect();
    let pages = futures_util::future::join_all(urls.iter().map(|url| get_text(http, url))).await;
    for (period, page) in periods.iter_mut().zip(pages) {
        match page {
            Ok(html) => apply_detail(period, &html),
            Err(error) => tracing::warn!(%error, "invoice detail page failed"),
        }
    }
    Ok(InvoiceReport { updated_at: Utc::now().to_rfc3339(), periods })
}

async fn get_text(http: &reqwest::Client, url: &str) -> Result<String, String> {
    let response = http.get(url).send().await.map_err(|e| format!("{url}: {e}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("{url}: HTTP {status}"));
    }
    response.text().await.map_err(|e| format!("{url}: {e}"))
}

/// RSS 的每個 `<item>`：標題像 `115年 07~08月`，內容像 `<p>特別獎：89996565</p><p>頭獎：54348835、44991397</p>`
fn parse_rss(xml: &str) -> Vec<Period> {
    let mut periods: Vec<Period> = xml
        .split("<item>")
        .skip(1)
        .filter_map(|item| {
            let item = item.split("</item>").next()?;
            let title = tag_text(item, "title")?;
            let link = tag_text(item, "link").unwrap_or_default();
            let description = strip_tags(&tag_text(item, "description")?);
            let (year, start) = parse_title(&title).or_else(|| parse_link(&link))?;
            let pub_date = tag_text(item, "pubDate").and_then(|d| DateTime::parse_from_rfc2822(d.trim()).ok());
            let special = numbers_after(&description, "特別獎").into_iter().next()?;
            let grand = numbers_after(&description, "特獎").into_iter().next()?;
            let first = numbers_after(&description, "頭獎");
            if first.is_empty() || [&special, &grand].into_iter().chain(&first).any(|n| n.len() != 8) {
                return None;
            }
            let mut period = Period::new(year, start, pub_date);
            period.special = special;
            period.grand = grand;
            period.first = first;
            period.extra = numbers_after(&description, "增開六獎").into_iter().filter(|n| n.len() == 3).collect();
            if !link.is_empty() {
                period.link = link;
            }
            Some(period)
        })
        .collect();
    periods.sort_by(|a, b| b.id.cmp(&a.id));
    periods.dedup_by(|a, b| a.id == b.id);
    periods
}

impl Period {
    /// 只有期別、號碼還沒填的一期；開獎日優先用 RSS 的發布時間（台灣時間的日期），沒有就是隔月 25 日
    fn new(year: u32, start: u32, published: Option<DateTime<FixedOffset>>) -> Self {
        let id = format!("{year}{start:02}");
        let first_day = NaiveDate::from_ymd_opt(year as i32 + 1911, start, 1).unwrap();
        let rule_draw = (first_day + Months::new(2)).with_day(25).unwrap();
        let draw = published
            .map(|t| t.with_timezone(&FixedOffset::east_opt(8 * 3600).unwrap()).date_naive())
            // 發布時間差太多（例如之後更正過）就不信它
            .filter(|d| (*d - rule_draw).num_days().abs() <= 7)
            .unwrap_or(rule_draw);
        let (claim_start, claim_end) = claim_period(draw);
        Self {
            link: format!("{PAGE_URL}{id}"),
            id,
            year,
            months: [start, start + 1],
            draw_date: draw.to_string(),
            claim_start: claim_start.to_string(),
            claim_end: claim_end.to_string(),
            special: String::new(),
            grand: String::new(),
            first: Vec::new(),
            extra: Vec::new(),
        }
    }
}

/// 統一發票給獎辦法：開獎日的次月 6 日起，三個月內領獎
fn claim_period(draw: NaiveDate) -> (NaiveDate, NaiveDate) {
    let next = (draw.with_day(1).unwrap() + Months::new(1)).with_day(6).unwrap();
    let end = (next + Months::new(3)).with_day(5).unwrap();
    (next, end)
}

/// `115年 07~08月` → (115, 7)
fn parse_title(title: &str) -> Option<(u32, u32)> {
    let nums = digit_groups(title);
    let (&year, &start) = (nums.first()?, nums.get(1)?);
    valid_period(year, start)
}

/// `.../ETW183W2_11507` → (115, 7)
fn parse_link(link: &str) -> Option<(u32, u32)> {
    let id = link.trim_end_matches('/').rsplit('_').next()?;
    if id.len() != 5 || !id.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    valid_period(id[..3].parse().ok()?, id[3..].parse().ok()?)
}

fn valid_period(year: u32, start: u32) -> Option<(u32, u32)> {
    ((80..300).contains(&year) && start % 2 == 1 && start <= 11).then_some((year, start))
}

/// 公告頁：`增開六獎 252` 與 `領獎期間自115年10月6日起至116年1月5日止`
fn apply_detail(period: &mut Period, html: &str) {
    let text = strip_tags(html);
    if let Some(rest) = text.split("領獎期間自").nth(1) {
        let nums = digit_groups(rest.get(..rest.len().min(80)).unwrap_or(rest));
        let date = |i: usize| -> Option<NaiveDate> {
            NaiveDate::from_ymd_opt(*nums.get(i)? as i32 + 1911, *nums.get(i + 1)?, *nums.get(i + 2)?)
        };
        if let (Some(start), Some(end)) = (date(0), date(3))
            && start < end
        {
            period.claim_start = start.to_string();
            period.claim_end = end.to_string();
        }
    }
    if period.extra.is_empty() {
        period.extra = numbers_after(&text, "增開六獎").into_iter().filter(|n| n.len() == 3).collect();
    }
}

/// `<tag>...</tag>` 的內容，去掉 CDATA
fn tag_text(xml: &str, tag: &str) -> Option<String> {
    let start = xml.find(&format!("<{tag}>"))? + tag.len() + 2;
    let end = start + xml[start..].find(&format!("</{tag}>"))?;
    let inner = xml[start..end].trim();
    let inner = inner.strip_prefix("<![CDATA[").and_then(|s| s.strip_suffix("]]>")).unwrap_or(inner);
    Some(inner.trim().to_owned())
}

/// 拿掉 HTML 標籤（換成空白），`&nbsp;` 之類的也當空白
fn strip_tags(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    for c in html.chars() {
        match c {
            '<' => in_tag = true,
            '>' if in_tag => {
                in_tag = false;
                out.push(' ');
            }
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out.replace("&nbsp;", " ")
}

/// 標題後面接著的號碼：`頭獎：54348835、44991397、06595111` → 三個號碼。
/// 號碼之間可以是頓號、逗號或空白，遇到其他文字就停。
fn numbers_after(text: &str, label: &str) -> Vec<String> {
    let Some(index) = text.find(label) else { return Vec::new() };
    let rest = &text[index + label.len()..];
    let mut out = Vec::new();
    let mut current = String::new();
    for c in rest.chars() {
        if c.is_ascii_digit() {
            current.push(c);
        } else if matches!(c, '：' | ':' | '、' | ',' | '，') || c.is_whitespace() {
            if !current.is_empty() {
                out.push(std::mem::take(&mut current));
            }
        } else {
            break;
        }
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

fn digit_groups(text: &str) -> Vec<u32> {
    text.split(|c: char| !c.is_ascii_digit()).filter(|s| !s.is_empty()).filter_map(|s| s.parse().ok()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const RSS: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title><![CDATA[統一發票中獎號碼]]></title>
    <item>
      <title><![CDATA[115年 05~06月]]></title>
      <link><![CDATA[https://www.etax.nat.gov.tw/etw-main/ETW183W2_11505]]></link>
      <pubDate>Sat, 25 Jul 2026 05:16:59 GMT</pubDate>
      <description><![CDATA[<p>特別獎：38548029</p><p>特獎：10138845</p><p>頭獎：24121106、28589937、83663333</p>]]></description>
    </item>
    <item>
      <title><![CDATA[115年 07~08月]]></title>
      <link><![CDATA[https://www.etax.nat.gov.tw/etw-main/ETW183W2_11507]]></link>
      <pubDate>Fri, 25 Sep 2026 05:00:33 GMT</pubDate>
      <description><![CDATA[<p>特別獎：89996565</p><p>特獎：91098182</p><p>頭獎：54348835、44991397、06595111</p>]]></description>
    </item>
    <item>
      <title><![CDATA[110年 11~12月]]></title>
      <link><![CDATA[https://www.etax.nat.gov.tw/etw-main/ETW183W2_11011]]></link>
      <description><![CDATA[<p>特別獎：12345678</p><p>特獎：87654321</p><p>頭獎：11111111、22222222、33333333</p><p>增開六獎：252、987</p>]]></description>
    </item>
    <item>
      <title><![CDATA[壞掉的一期]]></title>
      <description><![CDATA[<p>特別獎：123</p>]]></description>
    </item>
  </channel>
</rss>"#;

    #[test]
    fn parses_rss_newest_first() {
        let periods = parse_rss(RSS);
        assert_eq!(periods.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(), ["11507", "11505", "11011"]);
        let latest = &periods[0];
        assert_eq!(latest.year, 115);
        assert_eq!(latest.months, [7, 8]);
        assert_eq!(latest.special, "89996565");
        assert_eq!(latest.grand, "91098182");
        assert_eq!(latest.first, ["54348835", "44991397", "06595111"]);
        assert!(latest.extra.is_empty());
        assert_eq!(latest.draw_date, "2026-09-25");
        assert_eq!(latest.claim_start, "2026-10-06");
        assert_eq!(latest.claim_end, "2027-01-05");
        assert_eq!(latest.link, "https://www.etax.nat.gov.tw/etw-main/ETW183W2_11507");
    }

    #[test]
    fn year_end_period_is_drawn_next_january() {
        let old = &parse_rss(RSS)[2];
        assert_eq!(old.extra, ["252", "987"]);
        // 沒有 pubDate：用隔年 1 月 25 日推算
        assert_eq!(old.draw_date, "2022-01-25");
        assert_eq!(old.claim_start, "2022-02-06");
        assert_eq!(old.claim_end, "2022-05-05");
    }

    #[test]
    fn detail_page_overrides_claim_period_and_adds_extra_prize() {
        let mut period = Period::new(110, 11, None);
        let html = r#"<tr><th scope="row" rowspan="1">增開六獎</th>
            <td class="d-flex"><div class="row"><div class="col-12 mb-3">
                252
            </div></div></td></tr>
            <tr><th>領獎注意事項</th><td><p>1.領獎期間自111年2月7日起至111年5月6日止，中獎人請於領獎期間攜帶</p></td></tr>"#;
        apply_detail(&mut period, html);
        assert_eq!(period.extra, ["252"]);
        assert_eq!(period.claim_start, "2022-02-07");
        assert_eq!(period.claim_end, "2022-05-06");
    }

    #[test]
    fn parses_titles_and_links() {
        assert_eq!(parse_title("115年 07~08月"), Some((115, 7)));
        assert_eq!(parse_title("115年 08~09月"), None);
        assert_eq!(parse_link("https://www.etax.nat.gov.tw/etw-main/ETW183W2_11411/"), Some((114, 11)));
        assert_eq!(numbers_after("頭獎：1、2 增開六獎：3", "頭獎"), ["1", "2"]);
    }

    #[test]
    fn checks_often_on_draw_days() {
        assert_eq!(ttl(NaiveDate::from_ymd_opt(2026, 11, 25).unwrap()), DRAW_DAY_TTL);
        assert_eq!(ttl(NaiveDate::from_ymd_opt(2026, 11, 2).unwrap()), NORMAL_TTL);
        assert_eq!(ttl(NaiveDate::from_ymd_opt(2026, 12, 25).unwrap()), NORMAL_TTL);
    }
}
