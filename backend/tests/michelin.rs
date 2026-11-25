//! 米其林地圖（michelin.rs）：想吃／吃過、訂位提醒（含推播），以及前後端兩份餐廳資料要一樣。

use std::{path::Path as FsPath, sync::Arc, time::Duration};

use aws_lc_rs::agreement::{ECDH_P256, PrivateKey};
use axum::{
    Router,
    body::Bytes,
    extract::Path as UrlPath,
    http::{HeaderMap, StatusCode},
    routing::post,
};
use backend::{auth::upsert_admin, michelin, router, webpush::WebPush};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{TimeDelta, Utc};
use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::common::{TestApp, app};

async fn login(app: &TestApp, name: &str) -> String {
    upsert_admin(&app.state.pool, name, "password123".into()).await.unwrap();
    let reply =
        app.call("POST", "/api/auth/login", None, Some(json!({ "username": name, "password": "password123" }))).await;
    reply.cookie.unwrap()
}

fn in_minutes(minutes: i64) -> String {
    (Utc::now() + TimeDelta::minutes(minutes)).to_rfc3339()
}

#[test]
fn backend_data_is_the_same_as_the_frontend_copy() {
    let root = FsPath::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let read = |path: &str| std::fs::read_to_string(root.join(path)).unwrap_or_else(|e| panic!("{path}: {e}"));
    let frontend: Value = serde_json::from_str(&read("frontend/src/michelin/restaurants.json")).unwrap();
    let backend: Value = serde_json::from_str(&read("backend/src/michelin_restaurants.json")).unwrap();
    assert!(
        frontend == backend,
        "frontend/src/michelin/restaurants.json 更新了：複製一份到 backend/src/michelin_restaurants.json"
    );
    let regions = read("frontend/src/michelin/regions.ts");
    assert!(
        regions.contains(&format!("GUIDE_EDITION = '{}'", michelin::GUIDE_EDITION)),
        "regions.ts 的 GUIDE_EDITION 和 michelin.rs 的不一樣"
    );
}

#[tokio::test]
async fn marks_are_per_account() {
    let app = app().await;
    let alice = login(&app, "alice").await;
    let bob = login(&app, "bob").await;
    let marks = |cookie: String| {
        let app = &app;
        async move { app.get("/api/michelin/marks", Some(&cookie)).await.body["marks"].clone() }
    };

    assert_eq!(app.get("/api/michelin/marks", None).await.status, StatusCode::UNAUTHORIZED);
    let put = app.call("PUT", "/api/michelin/marks/le-palais", None, Some(json!({ "status": "want" }))).await;
    assert_eq!(put.status, StatusCode::UNAUTHORIZED);

    let put = app.call("PUT", "/api/michelin/marks/le-palais", Some(&alice), Some(json!({ "status": "want" }))).await;
    assert_eq!(put.status, StatusCode::NO_CONTENT, "{}", put.body);
    let body = json!({ "status": "been", "visited_on": "2025-03-02" });
    let put = app.call("PUT", "/api/michelin/marks/tairroir", Some(&alice), Some(body)).await;
    assert_eq!(put.status, StatusCode::NO_CONTENT, "{}", put.body);

    let mine = marks(alice.clone()).await;
    let rows: Vec<(&str, &str, Value)> = mine
        .as_array()
        .unwrap()
        .iter()
        .map(|m| (m["restaurant"].as_str().unwrap(), m["status"].as_str().unwrap(), m["visited_on"].clone()))
        .collect();
    assert_eq!(rows.len(), 2);
    assert!(rows.contains(&("le-palais", "want", Value::Null)));
    assert!(rows.contains(&("tairroir", "been", json!("2025-03-02"))));
    assert_eq!(marks(bob.clone()).await, json!([]));

    // 想吃改成吃過（沒有日期），再取消
    let put = app.call("PUT", "/api/michelin/marks/le-palais", Some(&alice), Some(json!({ "status": "been" }))).await;
    assert_eq!(put.status, StatusCode::NO_CONTENT);
    let mine = marks(alice.clone()).await;
    let palais = mine.as_array().unwrap().iter().find(|m| m["restaurant"] == "le-palais").unwrap();
    assert_eq!((palais["status"].clone(), palais["visited_on"].clone()), (json!("been"), Value::Null));
    let del = app.call("DELETE", "/api/michelin/marks/le-palais", Some(&alice), None).await;
    assert_eq!(del.status, StatusCode::NO_CONTENT);
    assert_eq!(marks(alice).await.as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn rejects_strange_marks() {
    let app = app().await;
    let alice = login(&app, "alice").await;
    let tomorrow_plus = (Utc::now() + TimeDelta::days(3)).format("%Y-%m-%d").to_string();
    for (restaurant, body) in [
        ("no-such-place", json!({ "status": "want" })),
        ("le-palais", json!({ "status": "love" })),
        ("le-palais", json!({ "status": "want", "visited_on": "2025-01-01" })),
        ("le-palais", json!({ "status": "been", "visited_on": "2025/01/01" })),
        ("le-palais", json!({ "status": "been", "visited_on": "2025-02-30" })),
        ("le-palais", json!({ "status": "been", "visited_on": tomorrow_plus })),
        ("le-palais", json!({})),
    ] {
        let reply =
            app.call("PUT", &format!("/api/michelin/marks/{restaurant}"), Some(&alice), Some(body.clone())).await;
        assert!(reply.status.is_client_error(), "{restaurant} {body} → {}", reply.status);
    }
    assert_eq!(app.get("/api/michelin/marks", Some(&alice)).await.body["marks"], json!([]));
}

#[tokio::test]
async fn reminders_can_be_listed_and_deleted_by_their_owner() {
    let app = app().await;
    let alice = login(&app, "alice").await;
    let bob = login(&app, "bob").await;

    let body = json!({ "restaurant": "le-palais", "remind_at": in_minutes(90), "note": "12:00 開放下個月訂位" });
    assert_eq!(
        app.call("POST", "/api/michelin/reminders", None, Some(body.clone())).await.status,
        StatusCode::UNAUTHORIZED
    );
    let created = app.call("POST", "/api/michelin/reminders", Some(&alice), Some(body)).await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.body);
    assert_eq!(created.body["restaurant"], "le-palais");
    assert_eq!(created.body["note"], "12:00 開放下個月訂位");
    assert_eq!(created.body["sent_at"], Value::Null);
    // 存成固定格式的 UTC
    let at = created.body["remind_at"].as_str().unwrap();
    assert!(at.ends_with('Z') && at.len() == 20, "{at}");
    let id = created.body["id"].as_i64().unwrap();

    // 帶時區的寫法也可以，存的時候換成 UTC
    let local = (Utc::now() + TimeDelta::hours(3)).with_timezone(&chrono::FixedOffset::east_opt(8 * 3600).unwrap());
    let body = json!({ "restaurant": "tairroir", "remind_at": local.to_rfc3339() });
    let second = app.call("POST", "/api/michelin/reminders", Some(&alice), Some(body)).await;
    assert_eq!(second.status, StatusCode::CREATED, "{}", second.body);

    let listed = app.get("/api/michelin/reminders", Some(&alice)).await.body["reminders"].clone();
    let ids: Vec<i64> = listed.as_array().unwrap().iter().map(|r| r["id"].as_i64().unwrap()).collect();
    assert_eq!(ids, [id, second.body["id"].as_i64().unwrap()], "依時間排");
    assert_eq!(app.get("/api/michelin/reminders", Some(&bob)).await.body["reminders"], json!([]));

    // 別人的刪不掉
    let path = format!("/api/michelin/reminders/{id}");
    assert_eq!(app.call("DELETE", &path, Some(&bob), None).await.status, StatusCode::NOT_FOUND);
    assert_eq!(app.call("DELETE", &path, Some(&alice), None).await.status, StatusCode::NO_CONTENT);
    assert_eq!(app.get("/api/michelin/reminders", Some(&alice)).await.body["reminders"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn rejects_strange_reminders() {
    let app = app().await;
    let alice = login(&app, "alice").await;
    for body in [
        json!({ "restaurant": "no-such-place", "remind_at": in_minutes(10) }),
        json!({ "restaurant": "le-palais", "remind_at": in_minutes(-10) }),
        json!({ "restaurant": "le-palais", "remind_at": in_minutes(60 * 24 * 500) }),
        json!({ "restaurant": "le-palais", "remind_at": "明天中午" }),
        json!({ "restaurant": "le-palais", "remind_at": "2026-12-01 12:00" }),
        json!({ "restaurant": "le-palais" }),
    ] {
        let reply = app.call("POST", "/api/michelin/reminders", Some(&alice), Some(body.clone())).await;
        assert!(reply.status.is_client_error(), "{body} → {}", reply.status);
    }
    // 備註太長就裁掉，控制字元換成空白
    let body = json!({ "restaurant": "le-palais", "remind_at": in_minutes(5), "note": format!("a\u{7}b{}", "字".repeat(200)) });
    let reply = app.call("POST", "/api/michelin/reminders", Some(&alice), Some(body)).await;
    assert_eq!(reply.status, StatusCode::CREATED);
    let note = reply.body["note"].as_str().unwrap();
    assert_eq!(note.chars().count(), 100);
    assert!(note.starts_with("a b"));

    // 還沒到的最多 50 個
    for _ in 1..50 {
        let body = json!({ "restaurant": "le-palais", "remind_at": in_minutes(30) });
        assert_eq!(
            app.call("POST", "/api/michelin/reminders", Some(&alice), Some(body)).await.status,
            StatusCode::CREATED
        );
    }
    let body = json!({ "restaurant": "le-palais", "remind_at": in_minutes(30) });
    assert_eq!(
        app.call("POST", "/api/michelin/reminders", Some(&alice), Some(body)).await.status,
        StatusCode::BAD_REQUEST
    );
}

// ---- 推播：假的推播服務，收到什麼就丟進 channel ----

struct Pushed {
    body: Vec<u8>,
}

async fn push_service() -> (String, mpsc::UnboundedReceiver<Pushed>) {
    let (tx, rx) = mpsc::unbounded_channel();
    let service = Router::new().route(
        "/push/{id}",
        post(move |UrlPath(_id): UrlPath<String>, _headers: HeaderMap, body: Bytes| {
            let tx = tx.clone();
            async move {
                tx.send(Pushed { body: body.to_vec() }).unwrap();
                StatusCode::CREATED
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    tokio::spawn(axum::serve(listener, service).into_future());
    (addr, rx)
}

#[tokio::test]
async fn due_reminders_are_pushed_once() {
    let mut state = app().await.state;
    state.push = Arc::new(WebPush::default().allow_any_endpoint());
    let app = TestApp { router: router(state.clone(), FsPath::new("does-not-exist")), state };
    let alice = login(&app, "alice").await;
    let (push_addr, mut pushes) = push_service().await;

    // 瀏覽器那一端的金鑰，用來解開推播
    let private = PrivateKey::generate(&ECDH_P256).unwrap();
    let public = private.compute_public_key().unwrap();
    let auth: [u8; 16] = std::array::from_fn(|i| i as u8 * 5);
    let body = json!({
        "endpoint": format!("http://{push_addr}/push/alice"),
        "keys": { "p256dh": URL_SAFE_NO_PAD.encode(public.as_ref()), "auth": URL_SAFE_NO_PAD.encode(auth) },
    });
    let reply = app.call("POST", "/api/push/subscriptions", Some(&alice), Some(body)).await;
    assert_eq!(reply.status, StatusCode::NO_CONTENT, "{}", reply.body);

    let body = json!({ "restaurant": "le-palais", "remind_at": in_minutes(0), "note": "12:00 開放訂位" });
    let due = app.call("POST", "/api/michelin/reminders", Some(&alice), Some(body)).await;
    assert_eq!(due.status, StatusCode::CREATED, "{}", due.body);
    let body = json!({ "restaurant": "tairroir", "remind_at": in_minutes(60) });
    assert_eq!(app.call("POST", "/api/michelin/reminders", Some(&alice), Some(body)).await.status, StatusCode::CREATED);

    // 到期的只有一個；換版時兩個容器各跑一次也只送一次
    let other = crate::common::app_on(app.state.pool.clone());
    let (a, b) = tokio::join!(michelin::send_due(&app.state), michelin::send_due(&other.state));
    assert_eq!(a.unwrap() + b.unwrap(), 1);

    let pushed = tokio::time::timeout(Duration::from_secs(5), pushes.recv()).await.expect("a push").unwrap();
    let plaintext = backend::webpush::decrypt(&private, &auth, &pushed.body).expect("decrypts");
    let payload: Value = serde_json::from_slice(&plaintext).unwrap();
    assert_eq!(payload["title"], "⏰ 頤宮");
    assert_eq!(payload["body"], "12:00 開放訂位");
    assert_eq!(payload["url"], "/michelin?r=le-palais");
    assert!(tokio::time::timeout(Duration::from_millis(300), pushes.recv()).await.is_err(), "只有一則");

    // 送過的還留在清單上（標著送出時間），沒到的照舊
    let listed = app.get("/api/michelin/reminders", Some(&alice)).await.body["reminders"].clone();
    let sent: Vec<bool> = listed.as_array().unwrap().iter().map(|r| r["sent_at"].is_string()).collect();
    assert_eq!(sent, [true, false]);
    assert_eq!(michelin::send_due(&app.state).await.unwrap(), 0);
}
