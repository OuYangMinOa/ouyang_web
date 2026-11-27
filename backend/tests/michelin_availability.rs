//! 米其林空位（michelin_availability.rs）：上傳要金鑰、上傳的內容整理過再存、只有登入的人看得到。

use std::path::Path;

use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use backend::{auth::upsert_admin, router};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;

use crate::common::{TestApp, app};

const KEY: &str = "test-upload-key";

async fn app_with_key(key: Option<&str>) -> TestApp {
    let mut state = app().await.state;
    state.michelin_upload_key = key.map(str::to_owned);
    TestApp { router: router(state.clone(), Path::new("does-not-exist")), state }
}

async fn login(app: &TestApp, name: &str) -> String {
    upsert_admin(&app.state.pool, name, "password123".into()).await.unwrap();
    let reply =
        app.call("POST", "/api/auth/login", None, Some(json!({ "username": name, "password": "password123" }))).await;
    reply.cookie.unwrap()
}

async fn upload(app: &TestApp, key: Option<&str>, body: String) -> (StatusCode, Value) {
    let mut request =
        Request::builder().method("PUT").uri("/api/michelin/availability").header("content-type", "application/json");
    if let Some(key) = key {
        request = request.header("x-michelin-key", key);
    }
    let response = app.router.clone().oneshot(request.body(Body::from(body)).unwrap()).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

/// 爬蟲上傳的樣子：頤宮 2 位有時段（有重複、沒排序、「新增」裡有不在時段裡的）、4 位沒讀到；
/// JL Studio 的大小寫跟地圖上的不一樣；還有一家地圖上沒有的
fn sample(checked_at: &str) -> Value {
    json!({
        "checked_at": checked_at,
        "days": ["2026-11-27", "2026-11-28"],
        "restaurants": [
            {
                "name": "頤宮",
                "url": "https://inline.app/booking/-LUoSpuw9DsGR06x5Mnv:inline-live-2a466/-LUoSpxysiQlIqWed9MA",
                "phone": "02-2181-9950#3261",
                "parties": {
                    "2": {
                        "source": "inline",
                        "checked_at": "2026-11-27T14:18:03+08:00",
                        "note": "",
                        "days": {
                            "2026-11-27": { "status": "booking-off", "times": [] },
                            "2026-11-28": { "status": "open", "times": ["19:00", "18:00", "18:00"], "new": ["19:00", "20:00"] }
                        }
                    },
                    "4": { "source": "inline", "checked_at": "", "note": "公開頁未傳回這間分店的日期庫存", "days": {} }
                }
            },
            {
                "name": "JL Studio",
                "url": "",
                "phone": "",
                "parties": { "2": { "source": "tablecheck", "days": { "2026-11-27": { "status": "selectable", "times": ["12:00"] } } } }
            },
            { "name": "不在地圖上的店", "parties": {} }
        ]
    })
}

async fn latest(app: &TestApp, cookie: &str) -> Value {
    let reply = app.get("/api/michelin/availability", Some(cookie)).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    reply.body["availability"].clone()
}

#[tokio::test]
async fn upload_needs_the_configured_key() {
    let body = sample("2026-11-27T14:20:19+08:00").to_string();

    // 沒設金鑰的環境不收
    let closed = app_with_key(None).await;
    assert_eq!(upload(&closed, Some(KEY), body.clone()).await.0, StatusCode::NOT_FOUND);

    let app = app_with_key(Some(KEY)).await;
    assert_eq!(upload(&app, None, body.clone()).await.0, StatusCode::UNAUTHORIZED);
    assert_eq!(upload(&app, Some("wrong-key"), body.clone()).await.0, StatusCode::UNAUTHORIZED);
    // 金鑰不對時不管內容是什麼都一樣是 401，不會先去解析
    assert_eq!(upload(&app, Some("wrong-key"), "not json".into()).await.0, StatusCode::UNAUTHORIZED);
    let (status, reply) = upload(&app, Some(KEY), body).await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{reply}");
}

#[tokio::test]
async fn only_logged_in_users_see_the_cleaned_up_result() {
    let app = app_with_key(Some(KEY)).await;
    assert_eq!(app.get("/api/michelin/availability", None).await.status, StatusCode::UNAUTHORIZED);
    let alice = login(&app, "alice").await;
    assert_eq!(latest(&app, &alice).await, Value::Null, "還沒上傳過");

    let (status, reply) = upload(&app, Some(KEY), sample("2026-11-27T14:20:19+08:00").to_string()).await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{reply}");
    let got = latest(&app, &alice).await;
    assert_eq!(got["checked_at"], "2026-11-27T06:20:19Z", "存成 UTC");
    assert!(got["uploaded_at"].is_string());
    assert_eq!(got["days"], json!(["2026-11-27", "2026-11-28"]));
    assert_eq!(got["parties"], json!([2, 4]));

    let places = got["restaurants"].as_array().unwrap();
    assert_eq!(places.len(), 3);
    let palais = &places[0];
    assert_eq!(palais["id"], "le-palais", "店名對到地圖上的餐廳");
    assert_eq!(palais["phone"], "02-2181-9950#3261");
    let two = &palais["parties"]["2"];
    assert_eq!(two["checked_at"], "2026-11-27T06:18:03Z");
    assert_eq!(two["days"]["2026-11-28"]["times"], json!(["18:00", "19:00"]), "排序、去重");
    assert_eq!(two["days"]["2026-11-28"]["new"], json!(["19:00"]), "新增只留還在時段裡的");
    assert_eq!(two["days"]["2026-11-27"], json!({ "status": "booking-off", "times": [], "new": [] }));
    let four = &palais["parties"]["4"];
    assert_eq!(four["checked_at"], Value::Null, "沒讀到就是 null");
    assert_eq!(four["note"], "公開頁未傳回這間分店的日期庫存");
    assert_eq!(places[1]["id"], "jl-studio", "不分大小寫");
    assert_eq!(places[2]["id"], Value::Null);
}

#[tokio::test]
async fn newest_check_wins_and_only_ten_are_kept() {
    let app = app_with_key(Some(KEY)).await;
    let alice = login(&app, "alice").await;
    for hour in 0..12 {
        let at = format!("2026-11-27T{hour:02}:00:00Z");
        assert_eq!(upload(&app, Some(KEY), sample(&at).to_string()).await.0, StatusCode::NO_CONTENT);
    }
    let kept: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM michelin_availability").fetch_one(&app.state.pool).await.unwrap();
    assert_eq!(kept, 10);
    assert_eq!(latest(&app, &alice).await["checked_at"], "2026-11-27T11:00:00Z");

    // 晚到的舊資料（例如手動重送上一次的結果）不會蓋掉比較新的
    assert_eq!(upload(&app, Some(KEY), sample("2026-11-27T05:30:00Z").to_string()).await.0, StatusCode::NO_CONTENT);
    assert_eq!(latest(&app, &alice).await["checked_at"], "2026-11-27T11:00:00Z");
}

#[tokio::test]
async fn rejects_strange_uploads() {
    let app = app_with_key(Some(KEY)).await;
    let alice = login(&app, "alice").await;
    let changed = |edit: &dyn Fn(&mut Value)| {
        let mut body = sample("2026-11-27T14:20:19+08:00");
        edit(&mut body);
        body.to_string()
    };
    let day = "/restaurants/0/parties/2/days/2026-11-28";
    let cases: Vec<(&str, String)> = vec![
        ("不是 JSON", "{".into()),
        ("時間不對", changed(&|b| b["checked_at"] = json!("2026-11-27 14:20"))),
        ("日期不對", changed(&|b| b["days"] = json!(["2026-11-27", "2026-11-31"]))),
        ("日期不是由早到晚", changed(&|b| b["days"] = json!(["2026-11-28", "2026-11-27"]))),
        ("沒有日期", changed(&|b| b["days"] = json!([]))),
        ("不在 days 裡的日期", changed(&|b| b["days"] = json!(["2026-11-28"]))),
        ("時段不對", changed(&|b| *b.pointer_mut(day).unwrap() = json!({ "status": "open", "times": ["25:00"] }))),
        ("沒有狀態", changed(&|b| *b.pointer_mut(day).unwrap() = json!({ "status": "", "times": [] }))),
        ("狀態不是代號", changed(&|b| *b.pointer_mut(day).unwrap() = json!({ "status": "<b>", "times": [] }))),
        ("網址不是 http(s)", changed(&|b| b["restaurants"][0]["url"] = json!("javascript:alert(1)"))),
        ("人數是 0", changed(&|b| b["restaurants"][2]["parties"] = json!({ "0": {} }))),
        ("人數不是數字", changed(&|b| b["restaurants"][2]["parties"] = json!({ "two": {} }))),
        ("同一家兩次", changed(&|b| b["restaurants"][2]["name"] = json!("頤宮"))),
        ("店名是空的", changed(&|b| b["restaurants"][2]["name"] = json!("  "))),
    ];
    for (why, body) in cases {
        let (status, reply) = upload(&app, Some(KEY), body).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{why}: {reply}");
        assert!(reply["error"].is_string(), "{why}");
    }
    assert_eq!(latest(&app, &alice).await, Value::Null, "退回的都沒有存");
}
