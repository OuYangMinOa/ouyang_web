//! 地震：即時的地震速報（EEW）與最近的地震報告。
//!
//! 速報來自 wolfx（https://wolfx.jp）的 WebSocket。伺服器啟動後每個來源各連一條，
//! 有設定 `EEW_RELAY_URL` 就經過伺服器上的 relay（`webscoket_relay_server`，和歐陽小俠共用同一條上游連線），
//! 沒設定才直接連 wolfx。收到的速報整理成同一種格式，再經 `/api/weather/quakes/ws` 推給瀏覽器。
//! wolfx 同一個 IP 大約只給 5 條 WebSocket，所以這裡只連歐陽小俠也在用的 4 個來源；
//! relay 連不上時也不改成直連，否則會和 relay 搶那 5 條，連歐陽小俠一起斷。
//!
//! 地震報告有人來看才抓（HTTP，快取幾分鐘）：wolfx 的日本氣象廳、中國地震台網清單，
//! USGS（台灣附近與全球），以及中央氣象署（要 `CWA_API_KEY`）。
//!
//! ```text
//! GET /api/weather/quakes        最新速報、各來源的地震報告、連線狀態
//! GET /api/weather/quakes/ws     server → client  {type:"snapshot", eew:[...]}
//!                                                 {type:"eew", eew}
//! ```

use std::{
    collections::BTreeMap,
    sync::{
        Arc, RwLock,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use axum::{
    Json,
    extract::{
        State,
        ws::{Message, Utf8Bytes, WebSocket, WebSocketUpgrade},
    },
    response::Response,
};
use chrono::{DateTime, Duration as ChronoDuration, NaiveDateTime, Utc};
use futures_util::StreamExt;
use serde::Serialize;
use serde_json::{Value, json};
use tokio::{
    sync::broadcast,
    time::{Instant, timeout},
};
use tokio_tungstenite::tungstenite::Message as UpstreamMessage;

use super::{SourceStatus, Weather, field, get_json, list, num, text};
use crate::{AppError, AppState};

const WOLFX_WS: &str = "wss://ws-api.wolfx.jp";
const WOLFX_HTTP: &str = "https://api.wolfx.jp";
const USGS_QUERY: &str = "https://earthquake.usgs.gov/fdsnws/event/1/query";
const USGS_GLOBAL: &str = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_week.geojson";
const CWA_DATASTORE: &str = "https://opendata.cwa.gov.tw/api/v1/rest/datastore";
const REPORT_TTL: Duration = Duration::from_secs(3 * 60);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// wolfx 每分鐘送一次 heartbeat、relay 每 9 秒 ping 一次；這麼久都沒動靜就重連
const UPSTREAM_IDLE: Duration = Duration::from_secs(150);
const MAX_BACKOFF: Duration = Duration::from_secs(60);
const PING_INTERVAL: Duration = Duration::from_secs(25);
const CLIENT_IDLE: Duration = Duration::from_secs(60);
const MAX_CLIENTS: usize = 1000;
const MAX_LIST: usize = 50;

struct Feed {
    /// cwa / jma / sc / fj
    source: &'static str,
    name: &'static str,
    /// wolfx 的路徑；和歐陽小俠用一樣的，relay 才會共用同一條上游
    path: &'static str,
    /// 時間欄位的時區
    offset: &'static str,
}

const FEEDS: [Feed; 4] = [
    Feed { source: "cwa", name: "中央氣象署 地震速報", path: "cwa_eew", offset: "+08:00" },
    Feed { source: "jma", name: "日本氣象廳 緊急地震速報", path: "jma_eew", offset: "+09:00" },
    Feed { source: "sc", name: "四川地震局 地震預警", path: "sc_eew", offset: "+08:00" },
    Feed { source: "fj", name: "福建地震局 地震預警", path: "fj_eew", offset: "+08:00" },
];

/// wolfx 的地震清單（HTTP）：`(代號, 名稱, 路徑, 時區)`
const WOLFX_LISTS: [(&str, &str, &str, &str); 2] = [
    ("jma", "日本氣象廳 地震情報", "jma_eqlist", "+09:00"),
    ("cenc", "中國地震台網 地震資訊", "cenc_eqlist", "+08:00"),
];

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Eew {
    pub source: &'static str,
    pub event_id: String,
    /// 第幾報
    #[serde(skip_serializing_if = "Option::is_none")]
    pub serial: Option<i64>,
    /// 帶時區的 RFC 3339
    pub origin_time: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub report_time: Option<String>,
    pub hypocenter: String,
    pub lat: f64,
    pub lon: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub magnitude: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub depth_km: Option<f64>,
    /// 台灣、日本是震度（例如 5弱），四川、福建是中國的烈度
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_intensity: Option<String>,
    pub is_final: bool,
    pub is_cancel: bool,
    pub is_warn: bool,
    pub is_training: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct QuakeReport {
    pub id: String,
    /// 帶時區的 RFC 3339
    pub time: String,
    pub location: String,
    pub lat: f64,
    pub lon: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub magnitude: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub depth_km: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_intensity: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub info: Option<String>,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct FeedStatus {
    pub path: &'static str,
    pub name: &'static str,
    pub connected: bool,
    /// relay 或 direct
    #[serde(skip_serializing_if = "Option::is_none")]
    pub via: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_message_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

/// wolfx 推來的速報，以及連著 `/api/weather/quakes/ws` 的瀏覽器
pub struct Quakes {
    eew: RwLock<BTreeMap<&'static str, Eew>>,
    feeds: RwLock<BTreeMap<&'static str, FeedStatus>>,
    tx: broadcast::Sender<Utf8Bytes>,
    clients: AtomicUsize,
}

impl Default for Quakes {
    fn default() -> Self {
        let feeds = FEEDS.iter().map(|f| (f.path, FeedStatus { path: f.path, name: f.name, ..Default::default() }));
        Self {
            eew: RwLock::default(),
            feeds: RwLock::new(feeds.collect()),
            tx: broadcast::channel(64).0,
            clients: AtomicUsize::new(0),
        }
    }
}

impl Quakes {
    fn latest_eew(&self) -> Vec<Eew> {
        let mut eew: Vec<Eew> = self.eew.read().unwrap().values().cloned().collect();
        eew.sort_by(|a, b| b.origin_time.cmp(&a.origin_time));
        eew
    }

    /// 存起來；跟上一筆一樣（重複推送或初始化時抓到同一筆）就回 false
    fn store_eew(&self, eew: Eew) -> bool {
        let mut latest = self.eew.write().unwrap();
        if latest.get(eew.source) == Some(&eew) {
            return false;
        }
        latest.insert(eew.source, eew);
        true
    }

    fn update_feed(&self, path: &str, update: impl FnOnce(&mut FeedStatus)) {
        if let Some(status) = self.feeds.write().unwrap().get_mut(path) {
            update(status);
        }
    }

    fn broadcast(&self, message: Value) {
        // 沒有人在看的時候 send 會回錯誤，不用理會
        let _ = self.tx.send(Utf8Bytes::from(message.to_string()));
    }

    fn apply(&self, feed: &Feed, value: &Value, notify: bool) {
        if let Some(eew) = parse_eew(feed, value)
            && self.store_eew(eew.clone())
            && notify
        {
            tracing::info!(source = feed.source, event = %eew.event_id, serial = ?eew.serial, "eew");
            self.broadcast(json!({ "type": "eew", "eew": eew }));
        }
    }
}

/// 伺服器啟動時呼叫：先用 HTTP 抓一次目前的資料，再為每個來源開一條常駐的 WebSocket
pub fn spawn(weather: Arc<Weather>, relay: Option<String>) {
    let relay = relay.map(|r| r.trim_end_matches('/').to_owned()).filter(|r| !r.is_empty());
    tracing::info!(relay = relay.as_deref().unwrap_or("(none)"), "starting earthquake feeds");
    for feed in &FEEDS {
        let weather = weather.clone();
        let relay = relay.clone();
        tokio::spawn(async move {
            // 台灣的 HTTP 版被 Cloudflare 擋（只剩 WebSocket），抓不到就等推送
            match get_json::<Value>(&weather.http, &format!("{WOLFX_HTTP}/{}.json", feed.path)).await {
                Ok(value) => weather.quakes.apply(feed, &value, false),
                Err(error) => tracing::debug!(%error, "initial fetch failed"),
            }
            run_feed(&weather.quakes, feed, relay.as_deref()).await;
        });
    }
}

async fn run_feed(quakes: &Quakes, feed: &Feed, relay: Option<&str>) {
    let direct = format!("{WOLFX_WS}/{}", feed.path);
    // relay 的 source 參數要和歐陽小俠寫得一模一樣（不做 URL 編碼），才會共用同一個 hub
    let (via, url) = match relay {
        Some(relay) => ("relay", format!("{relay}?source={direct}")),
        None => ("direct", direct),
    };

    let mut backoff = Duration::from_secs(1);
    loop {
        match timeout(CONNECT_TIMEOUT, tokio_tungstenite::connect_async(url.as_str())).await {
            Ok(Ok((socket, _))) => {
                tracing::info!(path = feed.path, via, "eew connected");
                quakes.update_feed(feed.path, |s| {
                    s.connected = true;
                    s.via = Some(via);
                });
                let started = Instant::now();
                let reason = read_feed(quakes, feed, socket).await;
                tracing::warn!(path = feed.path, via, %reason, "eew disconnected");
                quakes.update_feed(feed.path, |s| {
                    s.connected = false;
                    s.last_error = Some(reason);
                });
                // 連了一陣子才斷的是正常的斷線，馬上重連；一連上就斷的要慢慢退避，避免一直重連
                if started.elapsed() > Duration::from_secs(60) {
                    backoff = Duration::from_secs(1);
                }
            }
            Ok(Err(error)) => {
                tracing::warn!(path = feed.path, via, %error, "eew connect failed");
                quakes.update_feed(feed.path, |s| s.last_error = Some(error.to_string()));
            }
            Err(_) => quakes.update_feed(feed.path, |s| s.last_error = Some("連線逾時".into())),
        }
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(MAX_BACKOFF);
    }
}

async fn read_feed<S>(quakes: &Quakes, feed: &Feed, mut socket: S) -> String
where
    S: StreamExt<Item = Result<UpstreamMessage, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    loop {
        let message = match timeout(UPSTREAM_IDLE, socket.next()).await {
            Err(_) => return "太久沒有收到資料".into(),
            Ok(None) => return "連線關閉".into(),
            Ok(Some(Err(error))) => return error.to_string(),
            Ok(Some(Ok(message))) => message,
        };
        quakes.update_feed(feed.path, |s| s.last_message_at = Some(Utc::now().to_rfc3339()));
        let UpstreamMessage::Text(text) = message else { continue };
        let Ok(value) = serde_json::from_str::<Value>(&text) else { continue };
        if matches!(value["type"].as_str(), Some("heartbeat" | "pong")) {
            continue;
        }
        quakes.apply(feed, &value, true);
    }
}

// ---------- 解析 ----------

/// `2026/10/31 01:45:42`（或 `-` 分隔）加上時區 → RFC 3339
fn local_time(value: &Value, offset: &str) -> Option<String> {
    let raw = value.as_str()?.trim().replace('/', "-");
    let naive = NaiveDateTime::parse_from_str(&raw, "%Y-%m-%d %H:%M:%S")
        .or_else(|_| NaiveDateTime::parse_from_str(&raw, "%Y-%m-%d %H:%M"))
        .ok()?;
    let time = DateTime::parse_from_rfc3339(&format!("{}{offset}", naive.format("%Y-%m-%dT%H:%M:%S"))).ok()?;
    Some(time.to_rfc3339())
}

/// 日本的「5-」「5+」寫成台灣習慣的「5弱」「5強」；數字的烈度保留一位小數
fn intensity(value: &Value) -> Option<String> {
    let raw = match value {
        Value::Number(n) => {
            let x = n.as_f64()?;
            return Some(if x.fract() == 0.0 { format!("{x:.0}") } else { format!("{x:.1}") });
        }
        Value::String(s) => s.trim(),
        _ => return None,
    };
    let raw = raw.trim_end_matches('級');
    if raw.is_empty() || raw == "-" || raw == "不明" {
        return None;
    }
    Some(raw.replace('-', "弱").replace('+', "強"))
}

fn depth(value: &Value) -> Option<f64> {
    num(value).or_else(|| value.as_str()?.trim_end_matches("km").trim().parse().ok())
}

fn parse_eew(feed: &Feed, value: &Value) -> Option<Eew> {
    let lat = num(&value["Latitude"])?;
    let lon = num(&value["Longitude"])?;
    let origin_time = local_time(&value["OriginTime"], feed.offset)?;
    let event_id =
        text(&value["EventID"]).or_else(|| value.get("ID").map(|id| id.to_string().trim_matches('"').to_owned()))?;
    let flag = |key: &str| value[key].as_bool().unwrap_or(false);
    Some(Eew {
        source: feed.source,
        event_id,
        serial: value["Serial"].as_i64().or_else(|| value["ReportNum"].as_i64()),
        origin_time,
        report_time: local_time(&value["AnnouncedTime"], feed.offset)
            .or_else(|| local_time(&value["ReportTime"], feed.offset)),
        hypocenter: text(&value["Hypocenter"]).or_else(|| text(&value["HypoCenter"])).unwrap_or_default(),
        lat,
        lon,
        magnitude: num(&value["Magnitude"]).or_else(|| num(&value["Magunitude"])),
        depth_km: depth(&value["Depth"]),
        max_intensity: intensity(&value["MaxIntensity"]),
        is_final: flag("isFinal"),
        is_cancel: flag("isCancel"),
        is_warn: flag("isWarn"),
        is_training: flag("isTraining"),
    })
}

/// wolfx 的清單是 `{"No1": {...}, "No2": {...}, ...}`
fn parse_wolfx_list(offset: &str, value: &Value) -> Vec<QuakeReport> {
    let Some(map) = value.as_object() else { return Vec::new() };
    let mut entries: Vec<(u32, &Value)> =
        map.iter().filter_map(|(k, v)| Some((k.strip_prefix("No")?.parse().ok()?, v))).collect();
    entries.sort_by_key(|(n, _)| *n);
    entries
        .into_iter()
        .filter_map(|(_, item)| {
            let time = local_time(&item["time_full"], offset).or_else(|| local_time(&item["time"], offset))?;
            Some(QuakeReport {
                id: text(&item["EventID"]).unwrap_or_else(|| time.clone()),
                time,
                location: text(&item["location"]).or_else(|| text(&item["placeName"])).unwrap_or_default(),
                lat: num(&item["latitude"])?,
                lon: num(&item["longitude"])?,
                magnitude: num(&item["magnitude"]),
                depth_km: depth(&item["depth"]),
                max_intensity: intensity(&item["shindo"]).or_else(|| intensity(&item["intensity"])),
                url: None,
                info: text(&item["info"]),
            })
        })
        .take(MAX_LIST)
        .collect()
}

fn parse_usgs(body: &Value) -> Vec<QuakeReport> {
    list(&body["features"])
        .into_iter()
        .filter_map(|feature| {
            let props = &feature["properties"];
            let coordinates = &feature["geometry"]["coordinates"];
            let time = DateTime::<Utc>::from_timestamp_millis(props["time"].as_i64()?)?;
            Some(QuakeReport {
                id: text(&feature["id"])?,
                time: time.to_rfc3339(),
                location: text(&props["place"]).unwrap_or_default(),
                lat: num(&coordinates[1])?,
                lon: num(&coordinates[0])?,
                magnitude: num(&props["mag"]).map(|m| (m * 10.0).round() / 10.0),
                depth_km: num(&coordinates[2]).map(|d| d.round()),
                max_intensity: None,
                url: text(&props["url"]),
                info: None,
            })
        })
        .take(MAX_LIST * 2)
        .collect()
}

/// 中央氣象署的「顯著有感地震報告」與「小區域有感地震報告」
fn parse_cwa(body: &Value) -> Vec<QuakeReport> {
    list(field(field(body, "records"), "Earthquake"))
        .into_iter()
        .filter_map(|quake| {
            let info = field(quake, "EarthquakeInfo");
            let epicenter = field(info, "Epicenter");
            let max_intensity = list(field(field(quake, "Intensity"), "ShakingArea"))
                .into_iter()
                .filter_map(|area| intensity(field(area, "AreaIntensity")))
                .max_by(|a, b| intensity_rank(a).total_cmp(&intensity_rank(b)));
            Some(QuakeReport {
                id: field(quake, "EarthquakeNo").to_string().trim_matches('"').to_owned(),
                time: local_time(field(info, "OriginTime"), "+08:00")?,
                location: text(field(epicenter, "Location")).unwrap_or_default(),
                lat: num(field(epicenter, "EpicenterLatitude"))?,
                lon: num(field(epicenter, "EpicenterLongitude"))?,
                magnitude: num(field(field(info, "EarthquakeMagnitude"), "MagnitudeValue")),
                depth_km: num(field(info, "FocalDepth")),
                max_intensity,
                url: text(field(quake, "Web")),
                info: text(field(quake, "ReportContent")),
            })
        })
        .collect()
}

/// 「5弱」排在 5 和「5強」之間
fn intensity_rank(value: &str) -> f64 {
    let base: f64 = value.trim_end_matches(['弱', '強']).parse().unwrap_or(0.0);
    base + if value.ends_with('弱') {
        -0.25
    } else if value.ends_with('強') {
        0.25
    } else {
        0.0
    }
}

// ---------- HTTP 與 WebSocket ----------

#[derive(Serialize)]
pub struct ReportLists {
    pub lists: BTreeMap<&'static str, Vec<QuakeReport>>,
    pub sources: Vec<SourceStatus>,
}

#[derive(Serialize)]
pub struct QuakeSnapshot {
    pub updated_at: String,
    pub eew: Vec<Eew>,
    pub lists: BTreeMap<&'static str, Vec<QuakeReport>>,
    pub feeds: Vec<FeedStatus>,
    pub sources: Vec<SourceStatus>,
}

pub async fn quakes(State(state): State<AppState>) -> Result<Json<QuakeSnapshot>, AppError> {
    let weather = state.weather.clone();
    let reports =
        state.weather.quake_reports.get(REPORT_TTL, || async move { Ok(fetch_reports(&weather).await) }).await?;
    let quakes = &state.weather.quakes;
    Ok(Json(QuakeSnapshot {
        updated_at: Utc::now().to_rfc3339(),
        eew: quakes.latest_eew(),
        lists: reports.lists.clone(),
        feeds: quakes.feeds.read().unwrap().values().cloned().collect(),
        sources: reports.sources.clone(),
    }))
}

async fn fetch_reports(weather: &Weather) -> ReportLists {
    let http = &weather.http;
    let start = (Utc::now() - ChronoDuration::days(30)).format("%Y-%m-%d");
    let taiwan_url = format!(
        "{USGS_QUERY}?format=geojson&minlatitude=20&maxlatitude=27.5&minlongitude=117.5&maxlongitude=125\
         &minmagnitude=3&starttime={start}&orderby=time&limit={MAX_LIST}"
    );
    let cwa = async {
        let key = weather.cwa_key.as_deref()?;
        let fetch = |dataset: &'static str| async move {
            let url = format!("{CWA_DATASTORE}/{dataset}");
            let response = http
                .get(&url)
                .query(&[("Authorization", key), ("format", "JSON"), ("limit", "30")])
                .send()
                .await
                .map_err(|e| format!("中央氣象署：{e}"))?;
            if !response.status().is_success() {
                return Err(format!("中央氣象署：HTTP {}", response.status()));
            }
            response.json::<Value>().await.map(|body| parse_cwa(&body)).map_err(|e| format!("中央氣象署：{e}"))
        };
        let (large, small) = tokio::join!(fetch("E-A0015-001"), fetch("E-A0016-001"));
        Some(large.map(|mut large| {
            large.extend(small.unwrap_or_default());
            large.sort_by(|a, b| b.time.cmp(&a.time));
            large.truncate(MAX_LIST);
            large
        }))
    };
    let wolfx = |(id, name, path, offset): (&'static str, &'static str, &'static str, &'static str)| async move {
        let list = get_json::<Value>(http, &format!("{WOLFX_HTTP}/{path}.json")).await;
        (id, name, list.map(|body| parse_wolfx_list(offset, &body)))
    };
    let (taiwan, global, cwa, jma, cenc) = tokio::join!(
        get_json::<Value>(http, &taiwan_url),
        get_json::<Value>(http, USGS_GLOBAL),
        cwa,
        wolfx(WOLFX_LISTS[0]),
        wolfx(WOLFX_LISTS[1]),
    );
    let taiwan = taiwan.map(|body| parse_usgs(&body));
    let global = global.map(|body| parse_usgs(&body));

    let mut sources = Vec::new();
    let mut lists = BTreeMap::new();
    if let Some(cwa) = cwa {
        sources.push(SourceStatus::from_result("cwa", "中央氣象署", &cwa));
        lists.insert("cwa", cwa.unwrap_or_default());
    }
    sources.push(SourceStatus::from_result("usgs_taiwan", "USGS 台灣附近", &taiwan));
    sources.push(SourceStatus::from_result("usgs_global", "USGS 全球 M4.5+", &global));
    lists.insert("usgs_taiwan", taiwan.unwrap_or_default());
    lists.insert("usgs_global", global.unwrap_or_default());
    for (id, name, list) in [jma, cenc] {
        sources.push(SourceStatus::from_result(id, name, &list));
        lists.insert(id, list.unwrap_or_default());
    }
    ReportLists { lists, sources }
}

pub async fn connect(State(state): State<AppState>, ws: WebSocketUpgrade) -> Response {
    let quakes = state.weather.quakes.clone();
    ws.max_message_size(1024).on_upgrade(move |socket| session(socket, quakes))
}

async fn session(mut socket: WebSocket, quakes: Arc<Quakes>) {
    if quakes.clients.fetch_add(1, Ordering::Relaxed) >= MAX_CLIENTS {
        quakes.clients.fetch_sub(1, Ordering::Relaxed);
        let error = json!({ "type": "error", "code": "full", "message": "連線人數已滿，請稍後再試" });
        let _ = socket.send(Message::Text(Utf8Bytes::from(error.to_string()))).await;
        let _ = socket.send(Message::Close(None)).await;
        return;
    }
    // 先訂閱再送快照，中間進來的速報才不會漏掉（重複的由前端用 event_id 和 serial 去掉）
    let mut rx = quakes.tx.subscribe();
    let snapshot = json!({ "type": "snapshot", "eew": quakes.latest_eew() });
    if socket.send(Message::Text(Utf8Bytes::from(snapshot.to_string()))).await.is_ok() {
        let mut ping = tokio::time::interval_at(Instant::now() + PING_INTERVAL, PING_INTERVAL);
        let mut last_seen = Instant::now();
        loop {
            tokio::select! {
                message = rx.recv() => match message {
                    Ok(text) => {
                        if socket.send(Message::Text(text)).await.is_err() {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                },
                incoming = socket.recv() => match incoming {
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    Some(Ok(_)) => last_seen = Instant::now(),
                },
                _ = ping.tick() => {
                    if last_seen.elapsed() > CLIENT_IDLE || socket.send(Message::Ping(Default::default())).await.is_err() {
                        break;
                    }
                }
            }
        }
    }
    quakes.clients.fetch_sub(1, Ordering::Relaxed);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed(path: &str) -> &'static Feed {
        FEEDS.iter().find(|f| f.path == path).unwrap()
    }

    #[test]
    fn parses_cwa_and_jma_eew() {
        let cwa = json!({"ID": 1150123, "ReportTime": "2026-10-30 12:00:30", "ReportNum": 3, "OriginTime": "2026-10-30 12:00:05",
                         "HypoCenter": "花蓮縣近海", "Latitude": 23.92, "Longitude": 121.59, "Magunitude": 5.6, "Depth": 40, "MaxIntensity": "5弱"});
        let eew = parse_eew(feed("cwa_eew"), &cwa).unwrap();
        assert_eq!(eew.event_id, "1150123");
        assert_eq!(eew.serial, Some(3));
        assert_eq!(eew.origin_time, "2026-10-30T12:00:05+08:00");
        assert_eq!(eew.max_intensity.as_deref(), Some("5弱"));
        assert_eq!(eew.magnitude, Some(5.6));

        let jma = json!({"EventID": "20261031014545", "Serial": 5, "AnnouncedTime": "2026/10/31 01:46:23",
                         "OriginTime": "2026/10/31 01:45:42", "Hypocenter": "熊本県熊本地方", "Latitude": 32.7, "Longitude": 130.7,
                         "Magunitude": 3.7, "Magnitude": 3.7, "Depth": 10, "MaxIntensity": "5-", "isFinal": true});
        let eew = parse_eew(feed("jma_eew"), &jma).unwrap();
        assert_eq!(eew.origin_time, "2026-10-31T01:45:42+09:00");
        assert_eq!(eew.max_intensity.as_deref(), Some("5弱"));
        assert!(eew.is_final);

        let sc = json!({"ID": 8204, "EventID": "202610231016.0001_2", "ReportTime": "2026-10-23 10:17:10", "ReportNum": 2,
                        "OriginTime": "2026-10-23 10:16:58", "HypoCenter": "云南丽江市宁蒗县", "Latitude": 27.824,
                        "Longitude": 100.582, "Magnitude": 4.3, "Depth": 0.0, "MaxIntensity": 6.3});
        let eew = parse_eew(feed("sc_eew"), &sc).unwrap();
        assert_eq!(eew.max_intensity.as_deref(), Some("6.3"));
        assert_eq!(eew.event_id, "202610231016.0001_2");
    }

    #[test]
    fn parses_wolfx_lists_in_order() {
        let jma = json!({"type": "jma_eqlist", "md5": "x",
            "No2": {"EventID": "b", "time_full": "2026/10/30 23:11:00", "location": "島根県東部", "magnitude": "3.5",
                    "shindo": "2", "depth": "10km", "latitude": "35.3", "longitude": "133.2", "info": ""},
            "No1": {"EventID": "a", "time_full": "2026/10/31 01:45:00", "location": "熊本県熊本地方", "magnitude": "4.1",
                    "shindo": "5+", "depth": "10km", "latitude": "32.7", "longitude": "130.7", "info": "津波の心配はありません。"}});
        let items = parse_wolfx_list("+09:00", &jma);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].id, "a");
        assert_eq!(items[0].max_intensity.as_deref(), Some("5強"));
        assert_eq!(items[0].depth_km, Some(10.0));
        assert_eq!(items[1].time, "2026-10-30T23:11:00+09:00");
    }

    #[test]
    fn parses_cwa_reports() {
        let body = json!({"records": {"Earthquake": [{
            "EarthquakeNo": 115123, "ReportContent": "10/30-12:00花蓮縣近海發生規模5.6有感地震", "Web": "https://scweb.cwa.gov.tw/x",
            "EarthquakeInfo": {"OriginTime": "2026-10-30 12:00:05", "FocalDepth": 40.0,
                "Epicenter": {"Location": "花蓮縣政府東方 30.0 公里", "EpicenterLatitude": 23.92, "EpicenterLongitude": 121.9},
                "EarthquakeMagnitude": {"MagnitudeType": "芮氏規模", "MagnitudeValue": 5.6}},
            "Intensity": {"ShakingArea": [{"AreaIntensity": "4級"}, {"AreaIntensity": "5弱"}, {"AreaIntensity": "5級"}]}
        }]}});
        let items = parse_cwa(&body);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, "115123");
        assert_eq!(items[0].max_intensity.as_deref(), Some("5"));
        assert_eq!(items[0].time, "2026-10-30T12:00:05+08:00");
    }

    #[test]
    fn duplicate_eew_is_not_stored_twice() {
        let quakes = Quakes::default();
        let value = json!({"ID": 1, "OriginTime": "2026-10-30 12:00:05", "Latitude": 23.9, "Longitude": 121.6});
        let eew = parse_eew(feed("cwa_eew"), &value).unwrap();
        assert!(quakes.store_eew(eew.clone()));
        assert!(!quakes.store_eew(eew));
    }
}
