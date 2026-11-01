//! 踩地雷競速（minesrace.rs）的 WebSocket 整合測試：一個真人加電腦玩一局，地雷不能外流

mod common;

use std::time::Duration;

use axum::http::StatusCode;
use common::{TestApp, app};
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
    async fn connect(addr: &str, code: &str, player: &str) -> Self {
        let url = format!("ws://{addr}/api/games/minesrace/party/{code}/ws?player={player}&name={player}");
        Self(connect_async(url).await.unwrap().0)
    }

    async fn next(&mut self) -> Value {
        loop {
            let message = tokio::time::timeout(Duration::from_secs(10), self.0.next())
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

    async fn send(&mut self, value: Value) {
        self.0.send(Message::text(value.to_string())).await.unwrap();
    }
}

/// 十六進位位元字串的第 i 位（和前端的 bitAt 一樣）
fn bit(hex: &str, i: usize) -> bool {
    let digit = u32::from_str_radix(&hex[i / 4..i / 4 + 1], 16).unwrap();
    (digit >> (i % 4)) & 1 == 1
}

#[tokio::test]
async fn a_race_against_a_bot_keeps_the_mines_on_the_server() {
    let (app, addr) = serve().await;
    let reply = app.call("POST", "/api/games/minesrace/party", None, None).await;
    assert_eq!(reply.status, StatusCode::CREATED);
    let code = reply.body["code"].as_str().unwrap().to_owned();

    let mut a = Client::connect(&addr, &code, "alice").await;
    let room = a.until(|m| m["type"] == "room").await;
    assert_eq!(room["min"], 1);
    assert_eq!(room["maxBots"], 7);
    a.send(json!({ "type": "addBot" })).await;
    a.send(json!({ "type": "options", "options": { "level": "beginner", "onMine": "out", "bots": "hard" } })).await;
    a.until(|m| m["type"] == "room" && m["options"]["bots"] == "hard" && m["players"].as_array().unwrap().len() == 2)
        .await;
    a.send(json!({ "type": "start" })).await;

    let view = a.until(|m| m["type"] == "view" && !m["view"].is_null()).await["view"].clone();
    assert_eq!(view["cols"], 9);
    assert_eq!(view["you"], 0);
    assert!(view["startsIn"].as_u64().unwrap() > 0);
    assert!(view["reveal"].is_null());
    // 起點大家一樣，已經打開了一塊
    let board = view["me"]["board"].as_str().unwrap().to_owned();
    assert_eq!(board.len(), 81);
    assert!(board.contains('0'));
    assert!(!board.contains('X'));
    // 對局中別人只看得到熱度圖
    assert!(view["players"][1]["mini"].is_null());
    assert_eq!(view["players"][1]["heat"].as_str().unwrap().len(), 9);

    // 倒數中不能動
    let unopened = board.find('.').unwrap();
    a.send(json!({ "type": "action", "action": { "type": "open", "i": unopened } })).await;
    let notice = a.until(|m| m["type"] == "notice").await;
    assert!(notice["message"].as_str().unwrap().contains("倒數"));

    // 倒數完：插旗只回傳自己的盤面（即時事件），不會重送所有人的 view
    tokio::time::sleep(Duration::from_millis(3100)).await;
    a.send(json!({ "type": "action", "action": { "type": "flag", "i": unopened } })).await;
    let event = a.until(|m| m["type"] == "event").await["event"].clone();
    assert_eq!(event["type"], "me");
    assert_eq!(event["me"]["board"].as_str().unwrap().as_bytes()[unopened], b'F');

    // 座標不對
    a.send(json!({ "type": "action", "action": { "type": "open", "i": 81 } })).await;
    assert_eq!(a.until(|m| m["type"] == "notice").await["message"], "沒有這一格");

    // 拔掉旗，接著閉著眼睛一格一格翻（出局模式），直到完成或踩到雷
    a.send(json!({ "type": "action", "action": { "type": "flag", "i": unopened } })).await;
    let mut me = a.until(|m| m["type"] == "event").await["event"]["me"].clone();
    let ended = loop {
        if me["out"] == true || me["finished"].is_u64() {
            break None;
        }
        let board = me["board"].as_str().unwrap().to_owned();
        let i = board.find('.').expect("not done, so something is still closed");
        let version = me["v"].as_u64().unwrap();
        a.send(json!({ "type": "action", "action": { "type": "open", "i": i } })).await;
        // 結果可能是即時事件（還在玩），或出局／完成時重送的 view；電腦的進度也會一直重送 view
        let next = loop {
            let message = a.next().await;
            let candidate = match message["type"].as_str() {
                Some("event") => message["event"]["me"].clone(),
                Some("view") if !message["view"].is_null() => {
                    if message["view"]["ended"] == true {
                        break Err(message["view"].clone());
                    }
                    message["view"]["me"].clone()
                }
                _ => continue,
            };
            if candidate["v"].as_u64().unwrap() > version {
                break Ok(candidate);
            }
        };
        match next {
            Ok(next) => me = next,
            Err(view) => break Some(view),
        }
    };
    // 等強電腦解完（我已經結束了，電腦最多再等 30 秒）；結算後公開地雷和完整縮圖，名次排好
    let view = match ended {
        Some(view) => view,
        None => loop {
            let message = a.next().await;
            if message["type"] == "view" && message["view"]["ended"] == true {
                break message["view"].clone();
            }
        },
    };
    let reveal = view["reveal"].as_str().unwrap();
    assert_eq!((0..81).filter(|&i| bit(reveal, i)).count(), 10);
    let board = view["me"]["board"].as_str().unwrap();
    if view["me"]["out"] == true {
        // 踩到的那一顆真的是雷
        let boom = board.find('X').unwrap();
        assert!(bit(reveal, boom));
    }
    let mut places: Vec<u64> = (0..2).map(|s| view["players"][s]["place"].as_u64().unwrap()).collect();
    places.sort();
    assert_eq!(places, [1, 2]);
    assert!(view["players"][0]["mini"].is_string());
    assert!(view["players"][1]["mini"].is_string());
}
