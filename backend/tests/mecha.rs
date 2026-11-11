//! 機甲對戰（mecha.rs）的 WebSocket 整合測試：兩個人進同一間房、選隊、開打，
//! 機甲的狀態、血量和傷害合併轉送，飛彈一條命只有兩發

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
    async fn connect(addr: &str, code: &str, player: &str) -> Self {
        let url = format!("ws://{addr}/api/games/mecha/party/{code}/ws?player={player}&name={player}");
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

    async fn act(&mut self, action: Value) {
        self.send(json!({ "type": "action", "action": action })).await;
    }
}

/// 機甲的狀態：[時間, x, y, z, vx, vy, vz, 腳的方向, 瞄準水平角, 瞄準仰角, 旗標, 第幾條命, 偵察機的 x, y, z]
fn state(x: f64) -> Value {
    json!([1000, x, 0, 0, 0, 0, 0, 0, 0, 0, 4, 1, 0, 0, 0, 0, 0])
}

#[tokio::test]
async fn two_pilots_fight_through_the_server() {
    let (app, addr) = serve().await;
    let reply = app.call("POST", "/api/games/mecha/party", None, None).await;
    assert_eq!(reply.status, StatusCode::CREATED);
    let code = reply.body["code"].as_str().unwrap().to_owned();

    let mut a = Client::connect(&addr, &code, "alice").await;
    let room = a.until(|m| m["type"] == "room").await;
    assert_eq!(room["min"], 2);
    assert_eq!(room["max"], 60);
    assert_eq!(room["maxBots"], 59);
    assert_eq!(room["options"], json!({ "killTarget": 10, "timeLimit": 10, "difficulty": "normal" }));
    let mut b = Client::connect(&addr, &code, "bob").await;
    a.until(|m| m["type"] == "room" && m["players"].as_array().unwrap().len() == 2).await;
    a.send(json!({ "type": "options", "options": { "killTarget": 7, "timeLimit": 10 } })).await;
    assert_eq!(a.until(|m| m["type"] == "notice").await["message"], "擊倒目標只能選 10、20、30、50、100 次");
    a.send(json!({ "type": "start" })).await;

    // 選隊：一對一各在一隊，不能都去同一隊
    let view = a.until(|m| m["type"] == "view" && !m["view"].is_null()).await["view"].clone();
    assert_eq!(view["you"], 0);
    assert_eq!(view["select"]["ready"], json!([false, false]));
    let ta = view["players"][0]["team"].as_u64().unwrap();
    let tb = view["players"][1]["team"].as_u64().unwrap();
    assert_ne!(ta, tb);
    a.act(json!({ "type": "team", "team": tb })).await;
    assert!(a.until(|m| m["type"] == "notice").await["message"].as_str().unwrap().contains("人比較多"));
    a.act(json!({ "type": "ready" })).await;
    b.act(json!({ "type": "ready" })).await;
    let view = a.until(|m| m["type"] == "view" && m["view"]["select"].is_null()).await["view"].clone();
    let starts_in = view["startsIn"].as_u64().unwrap();
    assert!((3000..=5000).contains(&starts_in), "倒數 {starts_in}");
    // 還沒開打：飛彈不算
    a.act(json!({ "type": "missile", "id": 1, "o": [0, 5, 0], "dir": [1, 0, 0] })).await;

    tokio::time::sleep(Duration::from_millis(starts_in + 200)).await;
    // 狀態合併成 tick 事件：alice 收得到 bob 的機甲
    a.act(json!({ "type": "state", "d": state(0.0) })).await;
    b.act(json!({ "type": "state", "d": state(30.5) })).await;
    let tick = a
        .until(|m| m["type"] == "event" && m["event"]["m"].as_array().is_some_and(|m| m.iter().any(|row| row[0] == 1)))
        .await["event"]
        .clone();
    let bob = tick["m"].as_array().unwrap().iter().find(|row| row[0] == 1).unwrap();
    assert_eq!(bob.as_array().unwrap().len(), 18);
    assert_eq!(bob[2], 30.5);

    // 機槍打中兩發：傷害和血量跟著下一個 tick 送給大家
    a.act(json!({ "type": "hit", "hits": [{ "seat": 1, "w": "gun" }, { "seat": 1, "w": "gun" }] })).await;
    let tick = b.until(|m| m["type"] == "event" && m["event"]["d"].is_array()).await["event"].clone();
    assert_eq!(tick["d"], json!([[0, 1, 8, 0], [0, 1, 8, 0]]));
    assert_eq!(tick["hp"], json!([200, 184]));

    // 飛彈：一條命兩發，第三發伺服器擋下來；別人收到發射的事件
    a.act(json!({ "type": "missile", "id": 7, "o": [0, 5, 0], "dir": [1, 0, 0], "target": 1, "goal": [30.5, 3, 0] }))
        .await;
    let shot = b.until(|m| m["type"] == "event" && m["event"]["type"] == "missile").await["event"].clone();
    assert_eq!(shot["seat"], 0);
    assert_eq!(shot["target"], 1);
    assert_eq!(shot["goal"], json!([30.5, 3.0, 0.0]));
    a.act(json!({ "type": "missile", "id": 8, "o": [0, 5, 0], "dir": [1, 0, 0] })).await;
    a.act(json!({ "type": "missile", "id": 9, "o": [0, 5, 0], "dir": [1, 0, 0] })).await;
    assert_eq!(a.until(|m| m["type"] == "notice").await["message"], "這條命的飛彈用完了");
    // 直接命中 60
    a.act(json!({ "type": "hit", "hits": [{ "seat": 1, "w": "missile", "id": 7, "direct": true }] })).await;
    let tick = b.until(|m| m["type"] == "event" && m["event"]["d"].is_array()).await["event"].clone();
    assert_eq!(tick["d"], json!([[0, 1, 60, 1]]));
    assert_eq!(tick["hp"], json!([200, 124]));
}
