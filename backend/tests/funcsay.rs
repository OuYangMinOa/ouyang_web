use std::{
    collections::BTreeMap,
    path::Path as FsPath,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
};
use backend::{auth::upsert_admin, funcsay::FuncSay, router};
use serde_json::{Value, json};

use crate::common::{TestApp, app};

/// 假的語錄服務：跟 Func-say 的 FastAPI 一樣的網址和欄位，LOVE／HATE 最低 0
type Counts = Arc<Mutex<BTreeMap<i64, (i64, i64)>>>;

/// 設成 true 時倒讚 +1 回 500，用來測換邊換到一半失敗
static HATE_BROKEN: AtomicBool = AtomicBool::new(false);

const SOURCES: [(i64, &str, &str); 3] = [
    (1, "在非洲，每六十秒，就有一分鐘過去", "由來是有個傳教士在非洲"),
    (2, "聽說你脫光後就會裸體", "None"),
    (47, "去跟你們老闆講", "政治:總統出訪途中，有記者當面喊話\n"),
];

fn row(id: i64, (love, hate): (i64, i64)) -> Value {
    let (_, text, source) = SOURCES.iter().find(|(i, ..)| *i == id).unwrap();
    json!({ "C_Id": id, "FUNC": text, "SOURCE": source, "LOVE": love, "HATE": hate })
}

async fn fake_funcsay() -> (String, Counts) {
    let counts: Counts = Arc::new(Mutex::new(BTreeMap::from([(1, (41, 14)), (2, (0, 0)), (47, (3, 1))])));
    let one = |State(counts): State<Counts>, Path(id): Path<i64>| async move {
        match counts.lock().unwrap().get(&id) {
            Some(&c) => Json(row(id, c)).into_response(),
            None => (StatusCode::NOT_FOUND, Json(json!({ "detail": "Not Found" }))).into_response(),
        }
    };
    let change = |delta: i64, love: bool| {
        move |State(counts): State<Counts>, Path(id): Path<i64>| async move {
            if !love && delta > 0 && id == 2 && HATE_BROKEN.load(Ordering::Relaxed) {
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            }
            let mut counts = counts.lock().unwrap();
            let Some(c) = counts.get_mut(&id) else { return StatusCode::NOT_FOUND.into_response() };
            let n = if love { &mut c.0 } else { &mut c.1 };
            *n = (*n + delta).max(0);
            Json(json!({ "ok": true })).into_response()
        }
    };
    let router = Router::new()
        .route(
            "/funcs",
            get(|State(counts): State<Counts>| async move {
                Json(counts.lock().unwrap().iter().map(|(&id, &c)| row(id, c)).collect::<Vec<_>>())
            }),
        )
        .route("/funcs/{id}", get(one))
        .route("/funcs/{id}/love", post(change(1, true)).delete(change(-1, true)))
        .route("/funcs/{id}/hate", post(change(1, false)).delete(change(-1, false)))
        .with_state(counts.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    (url, counts)
}

/// 一個沒有在聽的 port：連不上的語錄服務
fn closed_port() -> String {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    format!("http://{}", listener.local_addr().unwrap())
}

async fn app_with(url: Option<&str>) -> TestApp {
    let mut state = app().await.state;
    state.funcsay = Arc::new(FuncSay::new(url));
    TestApp { router: router(state.clone(), FsPath::new("does-not-exist")), state }
}

async fn login(app: &TestApp, name: &str) -> String {
    upsert_admin(&app.state.pool, name, "password123".into()).await.unwrap();
    let reply =
        app.call("POST", "/api/auth/login", None, Some(json!({ "username": name, "password": "password123" }))).await;
    reply.cookie.unwrap()
}

async fn vote(app: &TestApp, cookie: Option<&str>, id: i64, vote: Value) -> crate::common::Reply {
    app.call("PUT", &format!("/api/funcsay/{id}/vote"), cookie, Some(json!({ "vote": vote }))).await
}

fn counts_of(counts: &Counts, id: i64) -> (i64, i64) {
    counts.lock().unwrap()[&id]
}

#[tokio::test]
async fn guests_can_read_the_quotes() {
    let (url, _) = fake_funcsay().await;
    let app = app_with(Some(&url)).await;

    let reply = app.get("/api/funcsay", None).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert_eq!(reply.body["mine"], Value::Null);
    let quotes = reply.body["quotes"].as_array().unwrap();
    assert_eq!(quotes.len(), 3);
    assert_eq!(
        quotes[0],
        json!({ "id": 1, "text": SOURCES[0].1, "source": SOURCES[0].2, "politics": false, "love": 41, "hate": 14 })
    );
    // "None" 是沒有出處；「政治:」是分類，拿掉之後標成 politics
    assert_eq!(quotes[1]["source"], "");
    assert_eq!(quotes[2]["politics"], true);
    assert_eq!(quotes[2]["source"], "總統出訪途中，有記者當面喊話");

    // 沒登入不能投票、收藏
    assert_eq!(vote(&app, None, 1, json!("love")).await.status, StatusCode::UNAUTHORIZED);
    let fav = app.call("PUT", "/api/funcsay/1/favorite", None, Some(json!({ "favorite": true }))).await;
    assert_eq!(fav.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn each_account_votes_once_and_counts_go_to_the_quote_service() {
    let (url, counts) = fake_funcsay().await;
    let app = app_with(Some(&url)).await;
    let alice = login(&app, "alice").await;
    let bob = login(&app, "bob").await;

    let reply = vote(&app, Some(&alice), 1, json!("love")).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert_eq!(reply.body["vote"], "love");
    assert_eq!((reply.body["quote"]["love"].clone(), reply.body["quote"]["hate"].clone()), (json!(42), json!(14)));
    assert_eq!(counts_of(&counts, 1), (42, 14));

    // 同一個人再按一次讚不會多算
    vote(&app, Some(&alice), 1, json!("love")).await;
    assert_eq!(counts_of(&counts, 1), (42, 14));

    // 換成倒讚：讚 -1、倒讚 +1
    let reply = vote(&app, Some(&alice), 1, json!("hate")).await;
    assert_eq!(reply.body["quote"]["love"], 41);
    assert_eq!(reply.body["quote"]["hate"], 15);
    assert_eq!(counts_of(&counts, 1), (41, 15));

    // 別人另外算一票
    vote(&app, Some(&bob), 1, json!("hate")).await;
    assert_eq!(counts_of(&counts, 1), (41, 16));

    // 清單上是投完之後的數字（快取也跟著換），和自己按了什麼
    let list = app.get("/api/funcsay", Some(&alice)).await;
    assert_eq!(list.body["quotes"][0]["hate"], 16);
    assert_eq!(list.body["mine"]["votes"], json!({ "1": "hate" }));
    assert_eq!(app.get("/api/funcsay", Some(&bob)).await.body["mine"]["votes"], json!({ "1": "hate" }));

    // 收回
    let reply = vote(&app, Some(&alice), 1, Value::Null).await;
    assert_eq!(reply.body["vote"], Value::Null);
    assert_eq!(counts_of(&counts, 1), (41, 15));
    assert_eq!(app.get("/api/funcsay", Some(&alice)).await.body["mine"]["votes"], json!({}));

    // 不存在的語錄、亂填的票
    assert_eq!(vote(&app, Some(&alice), 999, json!("love")).await.status, StatusCode::NOT_FOUND);
    assert!(vote(&app, Some(&alice), 1, json!("meh")).await.status.is_client_error());
}

#[tokio::test]
async fn favorites_are_per_account() {
    let (url, _) = fake_funcsay().await;
    let app = app_with(Some(&url)).await;
    let alice = login(&app, "alice").await;
    let bob = login(&app, "bob").await;
    let set = |cookie: String, id: i64, favorite: bool| {
        let app = &app;
        async move {
            app.call(
                "PUT",
                &format!("/api/funcsay/{id}/favorite"),
                Some(&cookie),
                Some(json!({ "favorite": favorite })),
            )
            .await
        }
    };

    assert_eq!(set(alice.clone(), 2, true).await.status, StatusCode::NO_CONTENT);
    set(alice.clone(), 47, true).await;
    set(alice.clone(), 47, true).await;
    assert_eq!(set(alice.clone(), 999, true).await.status, StatusCode::NOT_FOUND);
    // 新收藏的在前
    assert_eq!(app.get("/api/funcsay", Some(&alice)).await.body["mine"]["favorites"], json!([47, 2]));
    assert_eq!(app.get("/api/funcsay", Some(&bob)).await.body["mine"]["favorites"], json!([]));

    assert_eq!(set(alice.clone(), 2, false).await.status, StatusCode::NO_CONTENT);
    assert_eq!(app.get("/api/funcsay", Some(&alice)).await.body["mine"]["favorites"], json!([47]));
}

#[tokio::test]
async fn quote_service_down_or_missing() {
    let app = app_with(None).await;
    assert_eq!(app.get("/api/funcsay", None).await.status, StatusCode::SERVICE_UNAVAILABLE);

    let app = app_with(Some(&closed_port())).await;
    let alice = login(&app, "alice").await;
    let reply = app.get("/api/funcsay", Some(&alice)).await;
    assert_eq!(reply.status, StatusCode::SERVICE_UNAVAILABLE);
    assert!(reply.body["error"].is_string());
}

#[tokio::test]
async fn failed_vote_leaves_nothing_behind() {
    let (url, counts) = fake_funcsay().await;
    let app = app_with(Some(&url)).await;
    let alice = login(&app, "alice").await;
    // 先讓清單進快取，之後語錄服務的投票壞掉
    assert_eq!(app.get("/api/funcsay", Some(&alice)).await.status, StatusCode::OK);
    vote(&app, Some(&alice), 47, json!("love")).await;
    assert_eq!(counts_of(&counts, 47), (4, 1));

    // 語錄服務那邊這一則被刪掉了（投票回 404）：要回錯誤，而且自己的票不變
    counts.lock().unwrap().remove(&47);
    let reply = vote(&app, Some(&alice), 47, json!("hate")).await;
    assert_eq!(reply.status, StatusCode::SERVICE_UNAVAILABLE, "{}", reply.body);
    assert_eq!(app.get("/api/funcsay", Some(&alice)).await.body["mine"]["votes"], json!({ "47": "love" }));

    // 從讚換成倒讚：讚 -1 成功、倒讚 +1 失敗，要把讚加回去
    vote(&app, Some(&alice), 2, json!("love")).await;
    assert_eq!(counts_of(&counts, 2), (1, 0));
    HATE_BROKEN.store(true, Ordering::Relaxed);
    let reply = vote(&app, Some(&alice), 2, json!("hate")).await;
    HATE_BROKEN.store(false, Ordering::Relaxed);
    assert_eq!(reply.status, StatusCode::SERVICE_UNAVAILABLE, "{}", reply.body);
    assert_eq!(counts_of(&counts, 2), (1, 0));
    assert_eq!(app.get("/api/funcsay", Some(&alice)).await.body["mine"]["votes"], json!({ "2": "love", "47": "love" }));
}
