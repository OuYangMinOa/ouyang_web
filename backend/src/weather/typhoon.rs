//! 颱風：各國氣象單位的官方路徑（傳統模式），以及 Google DeepMind Weather Lab 的 AI 路徑（AI 模式）。
//!
//! - 日本氣象廳（JMA）：西北太平洋，含過去路徑、強度與 70% 機率圓，不需要金鑰。
//! - GDACS：聯合國與歐盟合作的災害預警，整理 JTWC（美軍）與 NHC（美國）的全球路徑與不確定範圍。
//! - 中央氣象署（CWA）：要 `CWA_API_KEY`，有設定才抓。
//! - Weather Lab：每 6 小時起報一次的 AI 系集預報（平均路徑＋每個成員的路徑）。
//!
//! 各來源各自回報一份颱風清單，再依目前位置把同一個颱風合在一起（距離 600 公里內視為同一個）。

use std::{collections::BTreeMap, sync::Arc, time::Duration};

use axum::{Json, extract::State};
use chrono::{DateTime, Duration as ChronoDuration, NaiveDateTime, TimeZone, Timelike, Utc};
use serde::Serialize;
use serde_json::Value;

use super::{SourceStatus, Weather, distance_km, field, get_json, list, num, text};
use crate::{AppError, AppState};

const CACHE_TTL: Duration = Duration::from_secs(10 * 60);
/// 不同來源的目前位置在這個距離內，就當作同一個颱風（各家定位時間可能差到 6～12 小時）
const SAME_STORM_KM: f64 = 600.0;
const KT_PER_MS: f64 = 1.943_844;
const TAIWAN: (f64, f64) = (23.7, 121.0);

const JMA_TARGETS: &str = "https://www.jma.go.jp/bosai/typhoon/data/targetTc.json";
const GDACS_LIST: &str = "https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH";
const NHC_CURRENT: &str = "https://www.nhc.noaa.gov/CurrentStorms.json";
const CWA_TRACKS: &str = "https://opendata.cwa.gov.tw/api/v1/rest/datastore/W-C0034-005";
const WEATHER_LAB: &str = "https://deepmind.google.com/science/weatherlab/download/cyclones";
/// Weather Lab 目前作業中的模型
const WEATHER_LAB_MODEL: &str = "OPER";
/// AI 系集成員只留每 12 小時一個點，畫路徑夠用，資料量小很多
const MEMBER_STEP_HOURS: i64 = 12;

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct TrackPoint {
    /// UTC，RFC 3339；日本氣象廳的過去路徑沒有時間
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time: Option<String>,
    pub lat: f64,
    pub lon: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wind_kt: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gust_kt: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pressure_hpa: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    /// 預報點的 70% 機率圓半徑
    #[serde(skip_serializing_if = "Option::is_none")]
    pub radius_km: Option<f64>,
    /// 暴風圈：日本是 50 kt 以上，氣象署是 7 級風（15 m/s，約 30 kt）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub storm_radius_km: Option<f64>,
}

#[derive(Serialize, Clone, Debug)]
pub struct Forecast {
    /// jma / jtwc / nhc / cwa
    pub agency: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issued: Option<String>,
    /// 過去路徑，最後一點是目前位置
    pub past: Vec<TrackPoint>,
    pub forecast: Vec<TrackPoint>,
    /// 路徑的不確定範圍（GDACS 的 cone），`[lat, lon]`
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cone: Option<Vec<[f64; 2]>>,
}

#[derive(Serialize, Clone, Debug)]
pub struct AiForecast {
    pub model: String,
    pub track_id: String,
    pub init_time: String,
    /// 系集平均；第一點是起報時的位置
    pub mean: Vec<TrackPoint>,
    /// 每個成員的路徑，`[預報第幾小時, lat, lon]`
    pub members: Vec<Vec<[f64; 3]>>,
}

#[derive(Serialize, Clone, Debug)]
pub struct Storm {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name_en: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name_zh: Option<String>,
    /// 日本氣象廳的颱風編號，例如 2631 是 2026 年第 31 號
    #[serde(skip_serializing_if = "Option::is_none")]
    pub number: Option<String>,
    pub current: TrackPoint,
    /// 西北太平洋（含南海）；首頁只顯示這一區的颱風
    pub west_pacific: bool,
    pub distance_to_taiwan_km: f64,
    /// 官方預報路徑離台灣最近的距離
    #[serde(skip_serializing_if = "Option::is_none")]
    pub closest_forecast_km: Option<f64>,
    pub agencies: BTreeMap<String, Forecast>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ai: Option<AiForecast>,
}

#[derive(Serialize, Debug)]
pub struct TyphoonReport {
    pub updated_at: String,
    pub storms: Vec<Storm>,
    pub sources: Vec<SourceStatus>,
}

/// 某個來源回報的一個颱風
#[derive(Debug)]
struct Candidate {
    id: String,
    name_en: Option<String>,
    name_zh: Option<String>,
    number: Option<String>,
    forecast: Forecast,
}

impl Candidate {
    fn current(&self) -> Option<&TrackPoint> {
        self.forecast.past.last()
    }
}

pub async fn typhoons(State(state): State<AppState>) -> Result<Json<Arc<TyphoonReport>>, AppError> {
    let weather = state.weather.clone();
    let report = state.weather.typhoons.get(CACHE_TTL, || async move { Ok(build_report(&weather).await) }).await?;
    Ok(Json(report))
}

async fn build_report(weather: &Weather) -> TyphoonReport {
    let http = &weather.http;
    let cwa = async {
        match &weather.cwa_key {
            Some(key) => Some(fetch_cwa(http, key).await),
            None => None,
        }
    };
    let (cwa, jma, gdacs, ai) = tokio::join!(cwa, fetch_jma(http), fetch_gdacs(http), fetch_ai(weather));

    let mut sources = Vec::new();
    if let Some(cwa) = &cwa {
        sources.push(SourceStatus::from_result("cwa", "中央氣象署", cwa));
    }
    sources.push(SourceStatus::from_result("jma", "日本氣象廳", &jma));
    sources.push(SourceStatus::from_result("gdacs", "GDACS（JTWC／NHC）", &gdacs));
    sources.push(SourceStatus::from_result("ai", "Google DeepMind Weather Lab", &ai));

    // 先放的來源優先決定颱風的名稱與目前位置
    let official = [cwa.unwrap_or(Ok(Vec::new())), jma, gdacs].into_iter().flat_map(Result::unwrap_or_default);
    let storms = merge(official.collect(), ai.map(|ai| (*ai).clone()).unwrap_or_default());
    TyphoonReport { updated_at: Utc::now().to_rfc3339(), storms, sources }
}

fn merge(candidates: Vec<Candidate>, ai: Vec<AiForecast>) -> Vec<Storm> {
    let mut storms: Vec<Storm> = Vec::new();
    for candidate in candidates {
        let Some(current) = candidate.current().cloned() else { continue };
        match storms.iter_mut().find(|s| near(&s.current, &current)) {
            Some(storm) => {
                storm.name_en = storm.name_en.take().or(candidate.name_en);
                storm.name_zh = storm.name_zh.take().or(candidate.name_zh);
                storm.number = storm.number.take().or(candidate.number);
                storm.agencies.entry(candidate.forecast.agency.clone()).or_insert(candidate.forecast);
            }
            None => storms.push(Storm {
                id: candidate.id,
                name_en: candidate.name_en,
                name_zh: candidate.name_zh,
                number: candidate.number,
                west_pacific: is_west_pacific(current.lat, current.lon),
                distance_to_taiwan_km: 0.0,
                closest_forecast_km: None,
                current,
                agencies: BTreeMap::from([(candidate.forecast.agency.clone(), candidate.forecast)]),
                ai: None,
            }),
        }
    }

    for forecast in ai {
        let Some(start) = forecast.mean.first().cloned() else { continue };
        match storms.iter_mut().find(|s| s.ai.is_none() && near(&s.current, &start)) {
            Some(storm) => storm.ai = Some(forecast),
            // 只有 AI 有的（例如還沒編號的熱帶擾動），也列出來給 AI 模式看
            None => storms.push(Storm {
                id: format!("ai:{}", forecast.track_id),
                name_en: None,
                name_zh: None,
                number: None,
                west_pacific: is_west_pacific(start.lat, start.lon),
                distance_to_taiwan_km: 0.0,
                closest_forecast_km: None,
                current: start,
                agencies: BTreeMap::new(),
                ai: Some(forecast),
            }),
        }
    }

    for storm in &mut storms {
        storm.distance_to_taiwan_km = distance_km(storm.current.lat, storm.current.lon, TAIWAN.0, TAIWAN.1).round();
        storm.closest_forecast_km = storm
            .agencies
            .values()
            .flat_map(|f| &f.forecast)
            .map(|p| distance_km(p.lat, p.lon, TAIWAN.0, TAIWAN.1).round())
            .reduce(f64::min);
    }
    // 有官方資料的在前，再依離台灣的距離
    storms.sort_by(|a, b| {
        a.agencies
            .is_empty()
            .cmp(&b.agencies.is_empty())
            .then(a.distance_to_taiwan_km.total_cmp(&b.distance_to_taiwan_km))
    });
    storms
}

fn near(a: &TrackPoint, b: &TrackPoint) -> bool {
    distance_km(a.lat, a.lon, b.lat, b.lon) < SAME_STORM_KM
}

fn is_west_pacific(lat: f64, lon: f64) -> bool {
    let lon = lon.rem_euclid(360.0);
    lat > -5.0 && (100.0..=180.0).contains(&lon)
}

// ---------- 共用的小工具 ----------

fn utc_string(time: DateTime<Utc>) -> String {
    time.format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

fn parse_time(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .map(|t| t.with_timezone(&Utc))
        .ok()
        .or_else(|| NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S").ok().map(|t| Utc.from_utc_datetime(&t)))
}

fn round2(x: f64) -> f64 {
    (x * 100.0).round() / 100.0
}

// ---------- 日本氣象廳 ----------

async fn fetch_jma(http: &reqwest::Client) -> Result<Vec<Candidate>, String> {
    let targets: Vec<Value> = get_json(http, JMA_TARGETS).await?;
    let mut storms = Vec::new();
    for target in targets {
        let Some(tc) = target["tropicalCyclone"].as_str() else { continue };
        let base = format!("https://www.jma.go.jp/bosai/typhoon/data/{tc}");
        let (spec_url, track_url) = (format!("{base}/specifications.json"), format!("{base}/forecast.json"));
        let (spec, track) = tokio::join!(get_json::<Value>(http, &spec_url), get_json::<Value>(http, &track_url));
        if let Some(candidate) = parse_jma(tc, &spec?, &track?) {
            storms.push(candidate);
        }
    }
    Ok(storms)
}

fn parse_jma(tc: &str, spec: &Value, track: &Value) -> Option<Candidate> {
    let parts = spec.as_array()?;
    let title = parts.iter().find(|p| p["part"] == "title")?;

    let mut past: Vec<TrackPoint> = Vec::new();
    // forecast.json 的實況裡有過去路徑（只有位置）：先是熱帶性低氣壓時期，再來是颱風時期
    if let Some(analysis) = track.as_array().and_then(|parts| parts.iter().find(|p| p["advancedHours"] == 0)) {
        for key in ["preTyphoon", "typhoon"] {
            for point in analysis["track"][key].as_array().into_iter().flatten() {
                let (Some(lat), Some(lon)) = (num(&point[0]), num(&point[1])) else { continue };
                if past.last().is_some_and(|p| p.lat == lat && p.lon == lon) {
                    continue;
                }
                past.push(TrackPoint { lat, lon, ..Default::default() });
            }
        }
    }

    let mut forecast = Vec::new();
    for part in parts.iter().filter(|p| p["part"] != "title") {
        let (Some(lat), Some(lon)) = (num(&part["position"]["deg"][0]), num(&part["position"]["deg"][1])) else {
            continue;
        };
        let max_range = |key: &str| list(&part[key]).iter().filter_map(|w| num(&w["range"]["km"])).reduce(f64::max);
        let point = TrackPoint {
            time: part["validtime"]["UTC"].as_str().and_then(parse_time).map(utc_string),
            lat,
            lon,
            wind_kt: num(&part["maximumWind"]["sustained"]["kt"]),
            gust_kt: num(&part["maximumWind"]["gust"]["kt"]),
            pressure_hpa: num(&part["pressure"]),
            category: text(&part["category"]["en"]),
            radius_km: num(&part["probabilityCircleRadius"]["km"]),
            storm_radius_km: max_range("stormWarning"),
        };
        if part["advancedHours"].as_i64().unwrap_or(0) <= 0 {
            // 實況：取代過去路徑的最後一點（同一個位置），補上時間與強度
            if past.last().is_some_and(|p| p.time.is_none() && p.lat == lat && p.lon == lon) {
                past.pop();
            }
            past.push(point);
        } else {
            forecast.push(point);
        }
    }
    if past.is_empty() {
        return None;
    }

    Some(Candidate {
        id: format!("jma:{tc}"),
        name_en: text(&title["name"]["en"]),
        name_zh: None,
        number: text(&title["typhoonNumber"]),
        forecast: Forecast {
            agency: "jma".into(),
            issued: title["issue"]["UTC"].as_str().and_then(parse_time).map(utc_string),
            past,
            forecast,
            cone: None,
        },
    })
}

// ---------- GDACS（JTWC、NHC） ----------

async fn fetch_gdacs(http: &reqwest::Client) -> Result<Vec<Candidate>, String> {
    let from = (Utc::now() - ChronoDuration::days(14)).format("%Y-%m-%d");
    let list_url = format!("{GDACS_LIST}?eventlist=TC&alertlevel=green;orange;red&fromDate={from}");
    let (events, nhc) = tokio::join!(get_json::<Value>(http, &list_url), get_json::<Value>(http, NHC_CURRENT));
    let events = events?;
    // GDACS 會在颱風消散後還掛著一陣子；美國那邊可以用 NHC 自己的清單確認還在不在
    let nhc_names: Option<Vec<String>> = nhc.ok().map(|nhc| {
        list(&nhc["activeStorms"]).iter().filter_map(|s| s["name"].as_str()).map(str::to_uppercase).collect()
    });
    let now = Utc::now();

    let mut storms = Vec::new();
    for event in events["features"].as_array().into_iter().flatten() {
        let props = &event["properties"];
        if props["iscurrent"] != "true" {
            continue;
        }
        let last_update = props["todate"].as_str().and_then(|t| parse_time(&format!("{t}Z")));
        if last_update.is_none_or(|t| now - t > ChronoDuration::hours(36)) {
            continue;
        }
        let name = gdacs_name(props["eventname"].as_str().unwrap_or_default());
        // 美國的颱風 GDACS 標成 NOAA 或 NHC
        let source = match props["source"].as_str().unwrap_or("JTWC").to_lowercase().as_str() {
            "noaa" | "nhc" => "nhc".to_owned(),
            other => other.to_owned(),
        };
        if source == "nhc" && nhc_names.as_ref().is_some_and(|names| !names.contains(&name.to_uppercase())) {
            continue;
        }
        let Some(geometry_url) = props["url"]["geometry"].as_str() else { continue };
        let geometry: Value = get_json(http, geometry_url).await?;
        let wind_kt = num(&props["severitydata"]["severity"]).map(|kmh| (kmh / 1.852).round());
        if let Some(mut forecast) = parse_gdacs_geometry(&geometry, &source) {
            if let Some(current) = forecast.past.last_mut() {
                current.wind_kt = wind_kt;
            }
            storms.push(Candidate {
                id: format!("gdacs:{}", props["eventid"]),
                name_en: Some(name).filter(|n| !n.is_empty()),
                name_zh: None,
                number: None,
                forecast,
            });
        }
    }
    Ok(storms)
}

/// `IN-FA-26` → `In-fa`
fn gdacs_name(event_name: &str) -> String {
    let name = match event_name.rsplit_once('-') {
        Some((name, year)) if year.len() == 2 && year.chars().all(|c| c.is_ascii_digit()) => name,
        _ => event_name,
    };
    let mut chars = name.chars();
    chars
        .next()
        .map(|first| first.to_uppercase().chain(chars.flat_map(char::to_lowercase)).collect())
        .unwrap_or_default()
}

fn parse_gdacs_geometry(geometry: &Value, agency: &str) -> Option<Forecast> {
    let features = geometry["features"].as_array()?;
    let mut issued = None;
    let mut points: Vec<(usize, TrackPoint)> = Vec::new();
    let mut cone = None;
    for feature in features {
        let props = &feature["properties"];
        let class = props["Class"].as_str().unwrap_or_default();
        if class == "Poly_Cones" {
            cone = feature["geometry"]["coordinates"][0].as_array().map(|ring| {
                ring.iter().filter_map(|c| Some([round2(num(&c[1])?), round2(num(&c[0])?)])).collect::<Vec<_>>()
            });
            continue;
        }
        let Some(index) = class.strip_prefix("Point_Polygon_Point_").and_then(|n| n.parse().ok()) else { continue };
        let polygon_date = props["polygondate"].as_str().and_then(|t| parse_time(&format!("{t}Z")))?;
        issued.get_or_insert(polygon_date);
        let coordinate = &feature["geometry"]["coordinates"][0][0];
        let (Some(lon), Some(lat)) = (num(&coordinate[0]), num(&coordinate[1])) else { continue };
        let time = props["polygonlabel"].as_str().and_then(|label| gdacs_label_time(label, polygon_date));
        points.push((index, TrackPoint { time: time.map(utc_string), lat, lon, ..Default::default() }));
    }
    let issued = issued?;
    points.sort_by_key(|(index, _)| *index);
    let issued_text = utc_string(issued);
    let (past, forecast): (Vec<_>, Vec<_>) = points
        .into_iter()
        .map(|(_, point)| point)
        .partition(|p| p.time.as_deref().is_none_or(|t| t <= issued_text.as_str()));
    if past.is_empty() {
        return None;
    }
    Some(Forecast { agency: agency.into(), issued: Some(issued_text), past, forecast, cone })
}

/// `25/10 06:00 UTC` 加上年份；跨年時（12 月發布、1 月的預報點）要調整
fn gdacs_label_time(label: &str, reference: DateTime<Utc>) -> Option<DateTime<Utc>> {
    let label = label.trim_end_matches(" UTC");
    let year = reference.format("%Y").to_string().parse::<i32>().ok()?;
    let at = |year: i32| NaiveDateTime::parse_from_str(&format!("{year}/{label}"), "%Y/%d/%m %H:%M").ok();
    let time = Utc.from_utc_datetime(&at(year)?);
    let days = (time - reference).num_days();
    Some(if days > 180 {
        Utc.from_utc_datetime(&at(year - 1)?)
    } else if days < -180 {
        Utc.from_utc_datetime(&at(year + 1)?)
    } else {
        time
    })
}

// ---------- 中央氣象署 ----------

async fn fetch_cwa(http: &reqwest::Client, key: &str) -> Result<Vec<Candidate>, String> {
    let response = http
        .get(CWA_TRACKS)
        .query(&[("Authorization", key), ("format", "JSON")])
        .send()
        .await
        .map_err(|e| format!("中央氣象署：{e}"))?;
    if !response.status().is_success() {
        return Err(format!("中央氣象署：HTTP {}", response.status()));
    }
    let body: Value = response.json().await.map_err(|e| format!("中央氣象署：{e}"))?;
    Ok(parse_cwa(&body))
}

fn parse_cwa(body: &Value) -> Vec<Candidate> {
    let cyclones = field(field(field(body, "records"), "tropicalCyclones"), "tropicalCyclone");
    list(cyclones)
        .into_iter()
        .filter_map(|tc| {
            let past: Vec<TrackPoint> = list(field(field(tc, "analysisData"), "fix"))
                .into_iter()
                .filter_map(|fix| cwa_point(fix, None))
                .collect();
            if past.is_empty() {
                return None;
            }
            let forecast = list(field(field(tc, "forecastData"), "fix"))
                .into_iter()
                .filter_map(|fix| {
                    let init = text(field(fix, "initTime")).as_deref().and_then(parse_time)?;
                    let tau = num(field(fix, "tau"))?;
                    cwa_point(fix, Some(init + ChronoDuration::minutes((tau * 60.0) as i64)))
                })
                .collect();
            let issued = list(field(field(tc, "forecastData"), "fix"))
                .first()
                .and_then(|fix| text(field(fix, "initTime")))
                .as_deref()
                .and_then(parse_time)
                .map(utc_string);
            let number = text(field(tc, "cwaTyNo")).or_else(|| text(field(tc, "cwaTdNo")));
            Some(Candidate {
                id: format!("cwa:{}", number.clone().unwrap_or_default()),
                name_en: text(field(tc, "typhoonName")).map(|n| gdacs_name(&n)),
                name_zh: text(field(tc, "cwaTyphoonName")),
                number: None,
                forecast: Forecast { agency: "cwa".into(), issued, past, forecast, cone: None },
            })
        })
        .collect()
}

fn cwa_point(fix: &Value, forecast_time: Option<DateTime<Utc>>) -> Option<TrackPoint> {
    // coordinate 是 "經度,緯度" 的字串；為了保險，看哪個超過 90 度就是經度
    let coordinate = text(field(fix, "coordinate"))?;
    let (a, b) = coordinate.split_once(',')?;
    let (a, b): (f64, f64) = (a.trim().parse().ok()?, b.trim().parse().ok()?);
    let (lat, lon) = if a.abs() > 90.0 || b.abs() <= a.abs() { (b, a) } else { (a, b) };
    let time = forecast_time.or_else(|| text(field(fix, "fixTime")).as_deref().and_then(parse_time));
    let ms = |key: &str| num(field(fix, key)).map(|ms| (ms * KT_PER_MS).round());
    Some(TrackPoint {
        time: time.map(utc_string),
        lat,
        lon,
        wind_kt: ms("maxWindSpeed"),
        gust_kt: ms("maxGustSpeed"),
        pressure_hpa: num(field(fix, "pressure")),
        category: None,
        radius_km: num(field(fix, "radiusOf70PercentProbability")),
        storm_radius_km: num(field(field(fix, "circleOf15Ms"), "radius")),
    })
}

// ---------- Google DeepMind Weather Lab ----------

/// 找最新一次已經發布的起報時間（通常比起報時間晚 6～8 小時才出來），同一次只下載一次
async fn fetch_ai(weather: &Weather) -> Result<Arc<Vec<AiForecast>>, String> {
    let now = Utc::now();
    let cycle = now.with_hour(now.hour() / 6 * 6).and_then(|t| t.with_minute(0)).and_then(|t| t.with_second(0));
    let cycle = cycle.ok_or("時間計算錯誤")?.with_nanosecond(0).ok_or("時間計算錯誤")?;
    let mut last_error = String::from("找不到最近的 AI 預報");
    for back in 0..6 {
        let init = cycle - ChronoDuration::hours(6 * back);
        let key = init.format("%Y_%m_%dT%H_00").to_string();
        let mut cache = weather.ai_cache.lock().await;
        if let Some((cached_key, forecasts)) = cache.as_ref()
            && *cached_key == key
        {
            return Ok(forecasts.clone());
        }
        let url = |product: &str| {
            format!("{WEATHER_LAB}/{WEATHER_LAB_MODEL}/{product}/paired/csv/{WEATHER_LAB_MODEL}_{key}_paired.csv")
        };
        match fetch_text(&weather.http, &url("ensemble_mean")).await {
            Ok(Some(mean)) => {
                // 系集成員檔案比較大（約 0.5 MB），抓不到就只顯示平均路徑
                let members = fetch_text(&weather.http, &url("ensemble")).await.ok().flatten();
                let forecasts = Arc::new(parse_weather_lab(&mean, members.as_deref(), &utc_string(init)));
                *cache = Some((key, forecasts.clone()));
                return Ok(forecasts);
            }
            // 還沒發布就往前找；更早那次如果已經在快取裡，下一圈會直接用快取
            Ok(None) => continue,
            Err(error) => last_error = error,
        }
    }
    Err(last_error)
}

/// 404 回 `None`（這個起報時間還沒發布）
async fn fetch_text(http: &reqwest::Client, url: &str) -> Result<Option<String>, String> {
    let response = http.get(url).timeout(Duration::from_secs(60)).send().await.map_err(|e| format!("{url}: {e}"))?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !response.status().is_success() {
        return Err(format!("{url}: HTTP {}", response.status()));
    }
    response.text().await.map(Some).map_err(|e| format!("{url}: {e}"))
}

struct CsvRow<'a> {
    track_id: &'a str,
    sample: i64,
    valid_time: &'a str,
    lead_hours: i64,
    lat: f64,
    lon: f64,
    pressure: Option<f64>,
    wind: Option<f64>,
}

fn csv_rows(csv: &str) -> Vec<CsvRow<'_>> {
    let mut lines = csv.lines().filter(|l| !l.starts_with('#') && !l.trim().is_empty());
    let Some(header) = lines.next() else { return Vec::new() };
    let columns: Vec<&str> = header.split(',').collect();
    let col = |name: &str| columns.iter().position(|c| *c == name);
    let (Some(track), Some(sample), Some(valid), Some(lead), Some(lat), Some(lon)) =
        (col("track_id"), col("sample"), col("valid_time"), col("lead_time_hours"), col("lat"), col("lon"))
    else {
        return Vec::new();
    };
    let (pressure, wind) = (col("minimum_sea_level_pressure_hpa"), col("maximum_sustained_wind_speed_knots"));
    lines
        .filter_map(|line| {
            let cells: Vec<&str> = line.split(',').collect();
            let float = |i: Option<usize>| i.and_then(|i| cells.get(i)).and_then(|c| c.parse::<f64>().ok());
            Some(CsvRow {
                track_id: cells.get(track)?,
                sample: cells.get(sample)?.parse().ok()?,
                valid_time: cells.get(valid)?,
                lead_hours: cells.get(lead)?.parse::<f64>().ok()? as i64,
                lat: float(Some(lat))?,
                lon: float(Some(lon))?,
                pressure: float(pressure),
                wind: float(wind),
            })
        })
        .collect()
}

fn parse_weather_lab(mean: &str, members: Option<&str>, init_time: &str) -> Vec<AiForecast> {
    let mut tracks: BTreeMap<String, AiForecast> = BTreeMap::new();
    for row in csv_rows(mean) {
        let track = tracks.entry(row.track_id.to_owned()).or_insert_with(|| AiForecast {
            model: "WeatherNext".into(),
            track_id: row.track_id.to_owned(),
            init_time: init_time.to_owned(),
            mean: Vec::new(),
            members: Vec::new(),
        });
        track.mean.push(TrackPoint {
            time: parse_time(row.valid_time).map(utc_string),
            lat: round2(row.lat),
            lon: round2(row.lon),
            wind_kt: row.wind.map(f64::round),
            pressure_hpa: row.pressure.map(f64::round),
            ..Default::default()
        });
    }

    let mut paths: BTreeMap<(&str, i64), Vec<[f64; 3]>> = BTreeMap::new();
    for row in members.map(csv_rows).unwrap_or_default() {
        if row.lead_hours % MEMBER_STEP_HOURS == 0 {
            paths.entry((row.track_id, row.sample)).or_default().push([
                row.lead_hours as f64,
                round2(row.lat),
                round2(row.lon),
            ]);
        }
    }
    for ((track_id, _), path) in paths {
        if let Some(track) = tracks.get_mut(track_id)
            && path.len() > 1
        {
            track.members.push(path);
        }
    }
    tracks.into_values().filter(|t| !t.mean.is_empty()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_jma_track_and_forecast() {
        let spec = json!([
            {"part": "title", "issue": {"UTC": "2026-10-30T15:50:00Z"}, "typhoonNumber": "2631", "name": {"en": "In-fa"}},
            {"part": {"en": "Analysis"}, "advancedHours": 0, "position": {"deg": [20.1, 144.1]},
             "maximumWind": {"sustained": {"kt": "90"}, "gust": {"kt": "130"}}, "pressure": "940",
             "category": {"en": "TY"}, "stormWarning": [{"range": {"km": 150}}, {"range": {"km": 110}}],
             "validtime": {"UTC": "2026-10-30T15:00:00Z"}},
            {"part": {"en": "Forecast"}, "advancedHours": 12, "position": {"deg": [21.8, 142.9]},
             "probabilityCircleRadius": {"km": 45}, "validtime": {"UTC": "2026-10-31T03:00:00Z"}}
        ]);
        let track = json!([
            {"part": {"en": "Analysis"}, "advancedHours": 0,
             "track": {"preTyphoon": [[11.4, 166.0], [10.4, 166.7]], "typhoon": [[10.4, 166.7], [19.6, 144.6], [20.1, 144.1]]}}
        ]);
        let storm = parse_jma("TC2637", &spec, &track).unwrap();
        assert_eq!(storm.name_en.as_deref(), Some("In-fa"));
        assert_eq!(storm.number.as_deref(), Some("2631"));
        let past = &storm.forecast.past;
        assert_eq!(past.len(), 4, "{past:?}");
        let current = past.last().unwrap();
        assert_eq!(current.time.as_deref(), Some("2026-10-30T15:00:00Z"));
        assert_eq!(current.wind_kt, Some(90.0));
        assert_eq!(current.storm_radius_km, Some(150.0));
        assert_eq!(storm.forecast.forecast[0].radius_km, Some(45.0));
    }

    #[test]
    fn gdacs_names_and_label_times() {
        assert_eq!(gdacs_name("IN-FA-26"), "In-fa");
        assert_eq!(gdacs_name("VANCE-26"), "Vance");
        let reference = Utc.with_ymd_and_hms(2026, 12, 30, 12, 0, 0).unwrap();
        let time = gdacs_label_time("02/01 06:00 UTC", reference).unwrap();
        assert_eq!(utc_string(time), "2027-01-02T06:00:00Z");
        let reference = Utc.with_ymd_and_hms(2027, 1, 2, 0, 0, 0).unwrap();
        let time = gdacs_label_time("30/12 18:00 UTC", reference).unwrap();
        assert_eq!(utc_string(time), "2026-12-30T18:00:00Z");
    }

    #[test]
    fn splits_gdacs_points_into_past_and_forecast() {
        let point = |i: usize, label: &str, lon: f64, lat: f64| {
            json!({"properties": {"Class": format!("Point_Polygon_Point_{i}"), "polygondate": "2026-10-30T12:00:00",
                   "polygonlabel": label}, "geometry": {"type": "Polygon", "coordinates": [[[lon, lat], [lon + 0.001, lat]]]}})
        };
        let geometry = json!({"features": [
            point(1, "30/10 12:00 UTC", 144.5, 19.7),
            point(0, "30/10 06:00 UTC", 145.0, 19.0),
            point(2, "31/10 00:00 UTC", 143.6, 21.0),
        ]});
        let forecast = parse_gdacs_geometry(&geometry, "jtwc").unwrap();
        assert_eq!(forecast.past.len(), 2);
        assert_eq!(forecast.past[1].lat, 19.7);
        assert_eq!(forecast.forecast.len(), 1);
        assert_eq!(forecast.forecast[0].time.as_deref(), Some("2026-10-31T00:00:00Z"));
    }

    #[test]
    fn parses_cwa_with_either_coordinate_order() {
        let body = json!({"records": {"tropicalCyclones": {"tropicalCyclone": [{
            "typhoonName": "IN-FA", "cwaTyphoonName": "煙花", "cwaTyNo": "30",
            "analysisData": {"fix": [{"fixTime": "2026-10-30T20:00:00+08:00", "coordinate": "144.1,20.1",
                                      "maxWindSpeed": "45", "pressure": "940", "circleOf15Ms": {"radius": "250"}}]},
            "forecastData": {"fix": {"initTime": "2026-10-30T20:00:00+08:00", "tau": "12", "coordinate": "21.8,142.9",
                                     "radiusOf70PercentProbability": "80"}}
        }]}}});
        let storms = parse_cwa(&body);
        assert_eq!(storms.len(), 1);
        let storm = &storms[0];
        assert_eq!(storm.name_zh.as_deref(), Some("煙花"));
        let current = &storm.forecast.past[0];
        assert_eq!((current.lat, current.lon), (20.1, 144.1));
        assert_eq!(current.time.as_deref(), Some("2026-10-30T12:00:00Z"));
        assert_eq!(current.wind_kt, Some(87.0));
        let next = &storm.forecast.forecast[0];
        assert_eq!((next.lat, next.lon), (21.8, 142.9));
        assert_eq!(next.time.as_deref(), Some("2026-10-31T00:00:00Z"));
    }

    #[test]
    fn parses_weather_lab_csv() {
        let header = "init_time,track_id,sample,valid_time,lead_time,lead_time_hours,lat,lon,minimum_sea_level_pressure_hpa,maximum_sustained_wind_speed_knots";
        let mean = format!(
            "# comment\n# BEGIN DATA\n{header}\n\
             2026-10-30 12:00:00,WP302026,-1,2026-10-30 12:00:00,0 days 00:00:00,0,19.7,144.5,949.0,119.0\n\
             2026-10-30 12:00:00,WP302026,-1,2026-10-30 18:00:00,0 days 06:00:00,6,20.53,143.53,940.2,122.0\n"
        );
        let members = format!(
            "{header}\n\
             x,WP302026,0,2026-10-30 12:00:00,,0,19.7,144.5,,\n\
             x,WP302026,0,2026-10-30 18:00:00,,6,20.5,143.5,,\n\
             x,WP302026,0,2026-10-31 00:00:00,,12,21.3,142.9,,\n"
        );
        let tracks = parse_weather_lab(&mean, Some(&members), "2026-10-30T12:00:00Z");
        assert_eq!(tracks.len(), 1);
        assert_eq!(tracks[0].mean.len(), 2);
        assert_eq!(tracks[0].mean[1].time.as_deref(), Some("2026-10-30T18:00:00Z"));
        assert_eq!(tracks[0].members, vec![vec![[0.0, 19.7, 144.5], [12.0, 21.3, 142.9]]]);
    }

    #[test]
    fn merges_sources_by_position() {
        let candidate = |id: &str, agency: &str, lat: f64, lon: f64| Candidate {
            id: id.into(),
            name_en: Some(id.into()),
            name_zh: None,
            number: None,
            forecast: Forecast {
                agency: agency.into(),
                issued: None,
                past: vec![TrackPoint { lat, lon, ..Default::default() }],
                forecast: vec![],
                cone: None,
            },
        };
        let ai = AiForecast {
            model: "WeatherNext".into(),
            track_id: "IO912026".into(),
            init_time: String::new(),
            mean: vec![TrackPoint { lat: 9.5, lon: 93.2, ..Default::default() }],
            members: vec![],
        };
        let storms = merge(
            vec![
                candidate("jma", "jma", 20.1, 144.1),
                candidate("jtwc", "jtwc", 19.7, 144.5),
                candidate("vance", "nhc", 20.7, -107.7),
            ],
            vec![ai],
        );
        assert_eq!(storms.len(), 3);
        let infa = storms.iter().find(|s| s.id == "jma").unwrap();
        assert_eq!(infa.agencies.len(), 2);
        assert!(infa.west_pacific);
        let vance = storms.iter().find(|s| s.id == "vance").unwrap();
        assert!(!vance.west_pacific);
        // 只有 AI 的排最後
        assert_eq!(storms.last().unwrap().id, "ai:IO912026");
    }
}
