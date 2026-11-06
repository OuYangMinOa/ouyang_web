//! 系統管理的遊戲狀態（game_monitor.rs）：三種房間和單人排行榜都看得到，訪客的 id 不外流

use std::time::Duration;

use crate::common::{TestApp, app};
use axum::http::StatusCode;
use backend::auth::upsert_admin;
use futures_util::StreamExt;
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async,
    tungstenite::{Message, client::IntoClientRequest},
};

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

async fn serve() -> (TestApp, String) {
    let app = app().await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    tokio::spawn(axum::serve(listener, app.router.clone()).into_future());
    (app, addr)
}

async fn login(app: &TestApp, name: &str) -> String {
    upsert_admin(&app.state.pool, name, "password123".into()).await.unwrap();
    let reply =
        app.call("POST", "/api/auth/login", None, Some(json!({ "username": name, "password": "password123" }))).await;
    reply.cookie.unwrap()
}

/// 連上房間，`ip` 模擬 Traefik 放的 X-Forwarded-For；等到第一則訊息（已經坐下）才回傳
async fn connect(addr: &str, path: &str, ip: &str, cookie: Option<&str>) -> Socket {
    let mut request = format!("ws://{addr}{path}").into_client_request().unwrap();
    request.headers_mut().insert("x-forwarded-for", ip.parse().unwrap());
    if let Some(cookie) = cookie {
        request.headers_mut().insert("cookie", cookie.parse().unwrap());
    }
    let mut socket = connect_async(request).await.unwrap().0;
    loop {
        let message = tokio::time::timeout(Duration::from_secs(5), socket.next()).await.unwrap().unwrap().unwrap();
        if let Message::Text(text) = message {
            let value: Value = serde_json::from_str(&text).unwrap();
            assert_ne!(value["type"], "error", "{value}");
            return socket;
        }
    }
}

async fn create(app: &TestApp, path: &str, body: Value) -> String {
    let reply = app.call("POST", path, None, Some(body)).await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
    reply.body["code"].as_str().unwrap().to_owned()
}

async fn report(app: &TestApp, cookie: &str) -> Value {
    let reply = app.get("/api/admin/games", Some(cookie)).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    reply.body
}

fn room<'a>(report: &'a Value, code: &str) -> &'a Value {
    report["rooms"].as_array().unwrap().iter().find(|r| r["code"] == code).unwrap_or_else(|| panic!("{report}"))
}

#[tokio::test]
async fn needs_admin() {
    let app = app().await;
    assert_eq!(app.get("/api/admin/games", None).await.status, StatusCode::UNAUTHORIZED);

    let admin = login(&app, "alice").await;
    let created = app
        .call("POST", "/api/admin/users", Some(&admin), Some(json!({ "username": "bob", "password": "password123" })))
        .await;
    assert_eq!(created.status, StatusCode::CREATED);
    let bob = app
        .call("POST", "/api/auth/login", None, Some(json!({ "username": "bob", "password": "password123" })))
        .await
        .cookie
        .unwrap();
    assert_eq!(app.get("/api/admin/games", Some(&bob)).await.status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn lists_rooms_players_and_solo_runs() {
    let (app, addr) = serve().await;
    let admin = login(&app, "alice").await;

    // 棋類：一個訪客坐下，另一個座位還空著
    let duel = create(&app, "/api/games/rooms", json!({ "game": "gomoku" })).await;
    let _guest =
        connect(&addr, &format!("/api/games/rooms/{duel}/ws?game=gomoku&player=secret-tab-id"), "203.0.113.5", None)
            .await;

    // 派對：登入的人當房主，加一個訪客
    let party = create(&app, "/api/games/undercover/party", json!({})).await;
    let path = format!("/api/games/undercover/party/{party}/ws?player=x&name=");
    let _alice = connect(&addr, &path, "198.51.100.7", Some(&admin)).await;
    let _carol =
        connect(&addr, &format!("/api/games/undercover/party/{party}/ws?player=c&name=Carol"), "203.0.113.9", None)
            .await;

    // 大逃殺：沒人連線的房間也列出來
    let arena = create(&app, "/api/games/tetris/rooms", json!({ "public": false })).await;

    // 單人排行榜
    let run = app.call("POST", "/api/games/tetris/runs", Some(&admin), Some(json!({}))).await;
    assert_eq!(run.status, StatusCode::CREATED);

    let body = report(&app, &admin).await;

    let r = room(&body, &duel);
    assert_eq!(r["kind"], "duel");
    assert_eq!(r["game"], "gomoku");
    assert_eq!(r["phase"], "waiting");
    let players = r["players"].as_array().unwrap();
    assert_eq!(players.len(), 1);
    assert_eq!(players[0]["name"], "訪客");
    assert_eq!(players[0]["username"], Value::Null);
    assert_eq!(players[0]["online"], true);
    assert_eq!(players[0]["ip"], "203.0.113.5");
    assert_eq!(players[0]["status"], "座位 1");
    // 訪客的 id 能拿來坐回座位，不能出現在回應裡
    assert!(!body.to_string().contains("secret-tab-id"));

    let r = room(&body, &party);
    assert_eq!(r["kind"], "party");
    assert_eq!(r["game"], "undercover");
    assert_eq!(r["phase"], "lobby");
    let players = r["players"].as_array().unwrap();
    assert_eq!(players.len(), 2);
    assert_eq!(players[0]["name"], "alice");
    assert_eq!(players[0]["username"], "alice");
    assert_eq!(players[0]["host"], true);
    assert_eq!(players[0]["ip"], "198.51.100.7");
    assert_eq!(players[1]["name"], "Carol");
    assert_eq!(players[1]["host"], false);
    assert_ne!(players[0]["who"], players[1]["who"]);

    let r = room(&body, &arena);
    assert_eq!(r["kind"], "arena");
    assert_eq!(r["game"], "tetris");
    assert_eq!(r["players"], json!([]));
    assert_eq!(r["bots"], 30);

    let solo = body["solo"].as_array().unwrap();
    assert_eq!(solo.len(), 1);
    assert_eq!(solo[0]["game"], "tetris");
    assert_eq!(solo[0]["username"], "alice");

    // 有人連著的房間排在前面
    let rooms = body["rooms"].as_array().unwrap();
    assert_eq!(rooms.last().unwrap()["code"], arena.as_str());
}

#[tokio::test]
async fn duel_room_keeps_seats_after_everyone_leaves() {
    let (app, addr) = serve().await;
    let admin = login(&app, "alice").await;
    let code = create(&app, "/api/games/rooms", json!({ "game": "chess" })).await;
    let socket = connect(&addr, &format!("/api/games/rooms/{code}/ws?game=chess&player=g1"), "203.0.113.5", None).await;
    drop(socket);

    // 斷線要等伺服器發現，最多等一下
    for _ in 0..50 {
        let body = report(&app, &admin).await;
        let r = room(&body, &code);
        if r["phase"] == "idle" {
            assert_eq!(r["players"][0]["online"], false);
            assert_eq!(r["players"][0]["ip"], Value::Null);
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("room never became idle");
}
