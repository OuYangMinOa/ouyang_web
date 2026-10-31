//! 全台 22 個縣市的天氣與空氣品質，來自 Open-Meteo（免金鑰，一次請求就能查所有縣市）。

use std::{sync::Arc, time::Duration};

use axum::{Json, extract::State};
use chrono::Utc;
use serde::Serialize;
use serde_json::Value;

use super::{SourceStatus, get_json};
use crate::{AppError, AppState};

const CACHE_TTL: Duration = Duration::from_secs(15 * 60);
const FORECAST_URL: &str = "https://api.open-meteo.com/v1/forecast";
const AIR_URL: &str = "https://air-quality-api.open-meteo.com/v1/air-quality";

const CURRENT: &str = "temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,\
                       wind_speed_10m,wind_direction_10m,wind_gusts_10m,is_day";
const HOURLY: &str = "temperature_2m,precipitation_probability,weather_code";
const DAILY: &str = "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,\
                     precipitation_sum,uv_index_max,sunrise,sunset";
const AIR_CURRENT: &str = "us_aqi,pm2_5,pm10";

pub struct City {
    pub id: &'static str,
    pub name: &'static str,
    pub region: &'static str,
    pub lat: f64,
    pub lon: f64,
}

/// 縣市政府所在地附近的座標
pub const CITIES: [City; 22] = [
    City { id: "keelung", name: "基隆市", region: "北部", lat: 25.1283, lon: 121.7419 },
    City { id: "taipei", name: "臺北市", region: "北部", lat: 25.0375, lon: 121.5637 },
    City { id: "new-taipei", name: "新北市", region: "北部", lat: 25.0120, lon: 121.4657 },
    City { id: "taoyuan", name: "桃園市", region: "北部", lat: 24.9937, lon: 121.3010 },
    City { id: "hsinchu-city", name: "新竹市", region: "北部", lat: 24.8039, lon: 120.9647 },
    City { id: "hsinchu", name: "新竹縣", region: "北部", lat: 24.8387, lon: 121.0178 },
    City { id: "yilan", name: "宜蘭縣", region: "北部", lat: 24.7570, lon: 121.7533 },
    City { id: "miaoli", name: "苗栗縣", region: "中部", lat: 24.5602, lon: 120.8214 },
    City { id: "taichung", name: "臺中市", region: "中部", lat: 24.1477, lon: 120.6736 },
    City { id: "changhua", name: "彰化縣", region: "中部", lat: 24.0752, lon: 120.5440 },
    City { id: "nantou", name: "南投縣", region: "中部", lat: 23.9097, lon: 120.6838 },
    City { id: "yunlin", name: "雲林縣", region: "中部", lat: 23.7092, lon: 120.4313 },
    City { id: "chiayi-city", name: "嘉義市", region: "南部", lat: 23.4801, lon: 120.4491 },
    City { id: "chiayi", name: "嘉義縣", region: "南部", lat: 23.4588, lon: 120.2930 },
    City { id: "tainan", name: "臺南市", region: "南部", lat: 22.9908, lon: 120.2133 },
    City { id: "kaohsiung", name: "高雄市", region: "南部", lat: 22.6273, lon: 120.3014 },
    City { id: "pingtung", name: "屏東縣", region: "南部", lat: 22.6762, lon: 120.4880 },
    City { id: "hualien", name: "花蓮縣", region: "東部", lat: 23.9772, lon: 121.6044 },
    City { id: "taitung", name: "臺東縣", region: "東部", lat: 22.7583, lon: 121.1444 },
    City { id: "penghu", name: "澎湖縣", region: "離島", lat: 23.5711, lon: 119.5793 },
    City { id: "kinmen", name: "金門縣", region: "離島", lat: 24.4321, lon: 118.3171 },
    City { id: "lienchiang", name: "連江縣", region: "離島", lat: 26.1602, lon: 119.9497 },
];

#[derive(Serialize)]
pub struct CityWeather {
    pub id: &'static str,
    pub name: &'static str,
    pub region: &'static str,
    pub lat: f64,
    pub lon: f64,
    /// 以下都是 Open-Meteo 的原始欄位（變數名稱見上面的常數），時間是台灣時間
    pub current: Value,
    pub hourly: Value,
    pub daily: Value,
    pub air: Value,
}

#[derive(Serialize)]
pub struct ForecastReport {
    pub updated_at: String,
    pub cities: Vec<CityWeather>,
    pub sources: Vec<SourceStatus>,
}

pub async fn forecast(State(state): State<AppState>) -> Result<Json<Arc<ForecastReport>>, AppError> {
    let http = state.weather.http.clone();
    let report = state.weather.forecast.get(CACHE_TTL, || async move { build_report(&http).await }).await?;
    Ok(Json(report))
}

async fn build_report(http: &reqwest::Client) -> Result<ForecastReport, String> {
    let join = |f: fn(&City) -> f64| CITIES.iter().map(|c| f(c).to_string()).collect::<Vec<_>>().join(",");
    let (lats, lons) = (join(|c| c.lat), join(|c| c.lon));
    let forecast_url = format!(
        "{FORECAST_URL}?latitude={lats}&longitude={lons}&current={CURRENT}&hourly={HOURLY}&daily={DAILY}\
         &forecast_days=7&forecast_hours=24&timezone=Asia%2FTaipei&wind_speed_unit=ms"
    );
    let air_url = format!("{AIR_URL}?latitude={lats}&longitude={lons}&current={AIR_CURRENT}&timezone=Asia%2FTaipei");
    let (weather, air) =
        tokio::join!(get_json::<Vec<Value>>(http, &forecast_url), get_json::<Vec<Value>>(http, &air_url));
    let sources = vec![
        SourceStatus::from_result("open-meteo", "Open-Meteo 天氣預報", &weather),
        SourceStatus::from_result("open-meteo-air", "Open-Meteo 空氣品質", &air),
    ];
    // 天氣是主體，抓不到就算失敗（會沿用上一次的）；空氣品質抓不到就留空
    let weather = weather?;
    let air = air.unwrap_or_default();
    let cities = CITIES
        .iter()
        .enumerate()
        .map(|(i, city)| {
            let w = weather.get(i).unwrap_or(&Value::Null);
            CityWeather {
                id: city.id,
                name: city.name,
                region: city.region,
                lat: city.lat,
                lon: city.lon,
                current: w["current"].clone(),
                hourly: w["hourly"].clone(),
                daily: w["daily"].clone(),
                air: air.get(i).map(|a| a["current"].clone()).unwrap_or(Value::Null),
            }
        })
        .collect();
    Ok(ForecastReport { updated_at: Utc::now().to_rfc3339(), cities, sources })
}
