//! 天氣與環境：颱風路徑、全台天氣、地震。資料都從外部公開來源抓，整理成前端好用的格式。
//!
//! 颱風、天氣和地震報告的結果放在記憶體快取裡，伺服器啟動後由背景每隔一段時間重抓（`spawn_refresh`），
//! 有人來看時直接回快取，不用等外部 API。背景重抓沒跟上（例如外部來源一直很慢）時，請求才自己去抓，
//! 這時同一時間只會有一個請求真的去抓，其他人等它；外部來源出錯時繼續回上一次成功的資料。
//! 地震速報則是伺服器啟動後就一直連著 wolfx 的 WebSocket（見 `quake.rs`）。

pub mod forecast;
pub mod quake;
pub mod typhoon;
pub mod typhoon_names;

use std::{
    env,
    future::Future,
    sync::Arc,
    time::{Duration, Instant},
};

use serde::Serialize;
use serde_json::Value;
use tokio::sync::Mutex;

use crate::AppError;

const USER_AGENT: &str =
    concat!("ouyang-web/", env!("CARGO_PKG_VERSION"), " (+https://github.com/OuYangMinOa/ouyang_web)");

pub struct Weather {
    pub http: reqwest::Client,
    /// 中央氣象署開放資料的授權碼（`CWA_API_KEY`）；沒設定就不抓氣象署的資料
    pub cwa_key: Option<String>,
    pub typhoons: Cached<typhoon::TyphoonReport>,
    pub forecast: Cached<forecast::ForecastReport>,
    pub quake_reports: Cached<quake::ReportLists>,
    pub quakes: Arc<quake::Quakes>,
    /// AI 颱風路徑（Weather Lab）一次預報的檔案不小，同一個起報時間只抓一次
    pub ai_cache: Mutex<Option<(String, Arc<Vec<typhoon::AiForecast>>)>>,
}

impl Weather {
    pub fn from_env() -> Self {
        Self { cwa_key: env::var("CWA_API_KEY").ok().filter(|key| !key.trim().is_empty()), ..Self::default() }
    }
}

impl Default for Weather {
    fn default() -> Self {
        let http = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .build()
            .expect("failed to build http client");
        Self {
            http,
            cwa_key: None,
            typhoons: Cached::default(),
            forecast: Cached::default(),
            quake_reports: Cached::default(),
            quakes: Arc::default(),
            ai_cache: Mutex::default(),
        }
    }
}

/// 有效期限內直接回快取；過期就重抓，抓失敗時沿用舊的（沒有舊的才回錯誤）。
/// 鎖會一直拿到抓完，所以快取過期的瞬間有很多人來，也只會打一次外部 API。
pub struct Cached<T> {
    slot: Mutex<Option<(Instant, Arc<T>)>>,
}

impl<T> Default for Cached<T> {
    fn default() -> Self {
        Self { slot: Mutex::new(None) }
    }
}

impl<T> Cached<T> {
    pub async fn get<F, Fut>(&self, ttl: Duration, fetch: F) -> Result<Arc<T>, AppError>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<T, String>>,
    {
        let mut slot = self.slot.lock().await;
        if let Some((at, value)) = slot.as_ref()
            && at.elapsed() < ttl
        {
            return Ok(value.clone());
        }
        match fetch().await {
            Ok(value) => {
                let value = Arc::new(value);
                *slot = Some((Instant::now(), value.clone()));
                Ok(value)
            }
            Err(error) => match slot.as_mut() {
                Some((at, value)) => {
                    tracing::warn!(%error, "refresh failed, serving stale data");
                    // 一分鐘後再試，不要每個請求都打一次掛掉的來源
                    *at = Instant::now() - ttl + Duration::from_secs(60).min(ttl);
                    Ok(value.clone())
                }
                None => {
                    tracing::warn!(%error, "fetch failed");
                    Err(AppError::ServiceUnavailable("外部資料來源暫時無法連線，請稍後再試"))
                }
            },
        }
    }

    /// 背景重抓：抓的時候不拿鎖，請求照樣拿得到舊資料；抓到才換上去，抓失敗就留著舊的。
    pub async fn refresh<F, Fut>(&self, fetch: F)
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<T, String>>,
    {
        match fetch().await {
            Ok(value) => *self.slot.lock().await = Some((Instant::now(), Arc::new(value))),
            Err(error) => tracing::warn!(%error, "background refresh failed, keeping old data"),
        }
    }
}

/// 伺服器啟動時呼叫：每個快取在過期前就先重抓，有人來看時一定是現成的。
/// 間隔比各自的 TTL 短一點，留時間給外部 API 回應；第一次在啟動時就抓。
pub fn spawn_refresh(weather: Arc<Weather>) {
    let w = weather.clone();
    every(typhoon::REFRESH_EVERY, move || {
        let w = w.clone();
        async move { w.typhoons.refresh(|| async { Ok(typhoon::build_report(&w).await) }).await }
    });
    let w = weather.clone();
    every(forecast::REFRESH_EVERY, move || {
        let w = w.clone();
        async move { w.forecast.refresh(|| forecast::build_report(&w.http)).await }
    });
    let w = weather;
    every(quake::REFRESH_EVERY, move || {
        let w = w.clone();
        async move { w.quake_reports.refresh(|| async { Ok(quake::fetch_reports(&w).await) }).await }
    });
}

fn every<F, Fut>(period: Duration, mut task: F)
where
    F: FnMut() -> Fut + Send + 'static,
    Fut: Future<Output = ()> + Send,
{
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(period);
        // 抓得比較久時從抓完開始重新計時，不要連著補抓
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tick.tick().await;
            task().await;
        }
    });
}

/// 每個外部來源這次有沒有抓成功，前端用來顯示「某某來源暫時無法連線」
#[derive(Serialize, Clone, Debug)]
pub struct SourceStatus {
    pub id: &'static str,
    pub name: &'static str,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl SourceStatus {
    pub fn from_result<T>(id: &'static str, name: &'static str, result: &Result<T, String>) -> Self {
        Self { id, name, ok: result.is_ok(), error: result.as_ref().err().cloned() }
    }
}

pub async fn get_json<T: serde::de::DeserializeOwned>(http: &reqwest::Client, url: &str) -> Result<T, String> {
    let response = http.get(url).send().await.map_err(|e| format!("{url}: {e}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("{url}: HTTP {status}"));
    }
    response.json::<T>().await.map_err(|e| format!("{url}: {e}"))
}

/// JSON 裡的數字可能是數字也可能是字串
pub fn num(value: &Value) -> Option<f64> {
    match value {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

pub fn text(value: &Value) -> Option<String> {
    value.as_str().map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned)
}

/// XML 轉來的 JSON 只有一筆時常常不是陣列
pub fn list(value: &Value) -> Vec<&Value> {
    match value {
        Value::Array(items) => items.iter().collect(),
        Value::Null => Vec::new(),
        other => vec![other],
    }
}

/// 不分大小寫找欄位（氣象署的欄位大小寫不太一致）
pub fn field<'a>(value: &'a Value, key: &str) -> &'a Value {
    value
        .as_object()
        .and_then(|map| map.get(key).or_else(|| map.iter().find(|(k, _)| k.eq_ignore_ascii_case(key)).map(|(_, v)| v)))
        .unwrap_or(&Value::Null)
}

/// 兩點之間的大圓距離（公里）
pub fn distance_km(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let (p1, p2) = (lat1.to_radians(), lat2.to_radians());
    let dp = p2 - p1;
    let dl = (lon2 - lon1).to_radians();
    let a = (dp / 2.0).sin().powi(2) + p1.cos() * p2.cos() * (dl / 2.0).sin().powi(2);
    6371.0 * 2.0 * a.sqrt().atan2((1.0 - a).sqrt())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn distance_between_taipei_and_kaohsiung() {
        let km = distance_km(25.0375, 121.5637, 22.6273, 120.3014);
        assert!((km - 297.0).abs() < 5.0, "{km}");
    }

    #[tokio::test]
    async fn cached_serves_stale_data_when_refresh_fails() {
        let cache = Cached::<u32>::default();
        let first = cache.get(Duration::ZERO, || async { Ok(1) }).await.unwrap();
        assert_eq!(*first, 1);
        let stale = cache.get(Duration::ZERO, || async { Err("down".into()) }).await.unwrap();
        assert_eq!(*stale, 1);
        let empty = Cached::<u32>::default();
        assert!(empty.get(Duration::ZERO, || async { Err("down".into()) }).await.is_err());
    }

    #[tokio::test]
    async fn background_refresh_fills_cache_and_keeps_old_data_on_failure() {
        let cache = Cached::<u32>::default();
        cache.refresh(|| async { Ok(1) }).await;
        // 還在 TTL 內，請求直接拿背景抓好的，不會自己去抓
        let hit = cache.get(Duration::from_secs(60), || async { panic!("should not fetch") }).await.unwrap();
        assert_eq!(*hit, 1);
        cache.refresh(|| async { Err("down".into()) }).await;
        let kept = cache.get(Duration::from_secs(60), || async { panic!("should not fetch") }).await.unwrap();
        assert_eq!(*kept, 1);
    }
}
