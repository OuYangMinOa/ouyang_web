//! 遊戲室（lobby.rs）的 WebSocket 整合測試：房主選遊戲後，大家拿到的房間真的開好了，房主和座位也照遊戲室排

use std::time::Duration;

use crate::common::{TestApp, app};
use axum::http::StatusCode;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async, tungstenite::Message};

async fn serve() -> (TestApp, String) {
    let app = app().await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    tokio::spawn(axum::serve(listener, app.router.clone()).into_future());
    (app, addr)
}

struct Client(WebSocketStream<MaybeTlsStream<TcpStream>>);

impl Client {
    /// 名字和 player 一樣；`game` 是棋類房間要的，其他房間會忽略
    async fn connect(addr: &str, path: &str, player: &str) -> Self {
        let url = format!("ws://{addr}/api/games/{path}/ws?player={player}&name={player}&game=chess");
        Self(connect_async(url).await.unwrap().0)
    }

    async fn next(&mut self) -> Value {
        loop {
            let message = tokio::time::timeout(Duration::from_secs(5), self.0.next())
                .await
                .expect("timed out waiting for a message")
                .expect("connection closed")
                .unwrap();
            match message {
                Message::Text(text) => return serde_json::from_str(&text).unwrap(),
                Message::Ping(_) | Message::Pong(_) => {}
                other => panic!("unexpected message: {other:?}"),
            }
        }
    }

    async fn until(&mut self, check: impl Fn(&Value) -> bool) -> Value {
        loop {
            let message = self.next().await;
            if check(&message) {
                return message;
            }
        }
    }

    async fn send(&mut self, message: Value) {
        self.0.send(Message::Text(message.to_string().into())).await.unwrap();
    }

    /// 等到遊戲室開好第 `id` 間
    async fn playing(&mut self, id: u32) -> Value {
        self.until(|m| m["type"] == "lobby" && m["playing"]["id"] == id).await["playing"].clone()
    }
}

#[tokio::test]
async fn host_moves_everyone_between_games() {
    let (app, addr) = serve().await;
    let reply = app.call("POST", "/api/games/lobby", None, None).await;
    assert_eq!(reply.status, StatusCode::CREATED);
    let lobby = format!("lobby/{}", reply.body["code"].as_str().unwrap());

    let mut a = Client::connect(&addr, &lobby, "a").await;
    let a_pid = a.until(|m| m["type"] == "welcome").await["you"].clone();
    let mut b = Client::connect(&addr, &lobby, "b").await;
    let b_pid = b.until(|m| m["type"] == "welcome").await["you"].clone();
    let mut c = Client::connect(&addr, &lobby, "c").await;
    c.until(|m| m["type"] == "welcome").await;

    // 派對遊戲：B 比房主先連進去，房主還是 A
    a.send(json!({ "type": "play", "game": "undercover" })).await;
    let playing = b.playing(1).await;
    assert_eq!(playing["game"], "undercover");
    assert!(playing["players"].is_null());
    let room = playing["room"].as_str().unwrap();
    let mut b_party = Client::connect(&addr, &format!("undercover/party/{room}"), "b").await;
    b_party.until(|m| m["type"] == "room").await;
    let mut a_party = Client::connect(&addr, &format!("undercover/party/{room}"), "a").await;
    let a_party_pid = a_party.until(|m| m["type"] == "welcome").await["you"].clone();
    let state = b_party.until(|m| m["type"] == "room" && m["players"].as_array().unwrap().len() == 2).await;
    assert_eq!(state["host"], a_party_pid);

    // 棋類：房主挑 B 先手、自己後手，C 只能觀戰
    a.send(json!({ "type": "play", "game": "chess" })).await;
    let notice = a.until(|m| m["type"] == "notice").await;
    assert_eq!(notice["message"], "這是兩個人的遊戲，請挑兩個人上場");
    tokio::time::sleep(Duration::from_millis(2100)).await;
    a.send(json!({ "type": "play", "game": "chess", "players": [b_pid, a_pid] })).await;
    let playing = c.playing(2).await;
    assert_eq!(playing["players"], json!([b_pid, a_pid]));
    let room = playing["room"].as_str().unwrap();
    let duel = format!("rooms/{room}");
    let mut c_duel = Client::connect(&addr, &duel, "c").await;
    let watching = c_duel.next().await;
    assert_eq!(watching["type"], "welcome");
    assert_eq!(watching["seat"], Value::Null);
    let mut a_duel = Client::connect(&addr, &duel, "a").await;
    assert_eq!(a_duel.next().await["seat"], 1);
    let mut b_duel = Client::connect(&addr, &duel, "b").await;
    assert_eq!(b_duel.next().await["seat"], 0);

    // 大逃殺也一樣交給遊戲室的房主
    tokio::time::sleep(Duration::from_millis(2100)).await;
    a.send(json!({ "type": "play", "game": "tetris" })).await;
    let room = b.playing(3).await["room"].as_str().unwrap().to_owned();
    let mut b_arena = Client::connect(&addr, &format!("tetris/rooms/{room}"), "b").await;
    b_arena.until(|m| m["type"] == "state").await;
    let mut a_arena = Client::connect(&addr, &format!("tetris/rooms/{room}"), "a").await;
    let a_arena_pid = a_arena.until(|m| m["type"] == "welcome").await["you"].clone();
    b_arena.until(|m| m["type"] == "state" && m["host"] == a_arena_pid).await;
}
