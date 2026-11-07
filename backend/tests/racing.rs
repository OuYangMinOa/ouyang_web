//! 3D 賽車多人連線（racing.rs）的 WebSocket 整合測試：兩個人進同一間房，車子狀態合併轉送，不合理的成績被擋下

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
        let url = format!("ws://{addr}/api/games/racing/party/{code}/ws?player={player}&name={player}");
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

/// 一台車的狀態：[時間, x, z, 車頭方向, vx, vz, 轉向速度, 方向盤, 旗標, 進度]
fn state(x: f64) -> Value {
    json!([-1500, x, 20.5, 1.25, 0, 0, 0, 0, 0, -9])
}

#[tokio::test]
async fn two_racers_share_states_and_impossible_laps_are_rejected() {
    let (app, addr) = serve().await;
    let reply = app.call("POST", "/api/games/racing/party", None, None).await;
    assert_eq!(reply.status, StatusCode::CREATED);
    let code = reply.body["code"].as_str().unwrap().to_owned();

    let mut a = Client::connect(&addr, &code, "alice").await;
    let room = a.until(|m| m["type"] == "room").await;
    assert_eq!(room["min"], 2);
    assert_eq!(room["max"], 8);
    assert_eq!(room["maxBots"], 0);
    assert_eq!(room["options"], json!({ "track": "coast", "laps": 3 }));

    let mut b = Client::connect(&addr, &code, "bob").await;
    a.until(|m| m["type"] == "room" && m["players"].as_array().unwrap().len() == 2).await;
    // 圈數只能 1、3、5
    a.send(json!({ "type": "options", "options": { "track": "canyon", "laps": 2 } })).await;
    assert_eq!(a.until(|m| m["type"] == "notice").await["message"], "圈數只能選 1、3、5 圈");
    a.send(json!({ "type": "options", "options": { "track": "canyon", "laps": 1 } })).await;
    a.until(|m| m["type"] == "room" && m["options"]["track"] == "canyon").await;
    a.send(json!({ "type": "start" })).await;

    let view = a.until(|m| m["type"] == "view" && !m["view"].is_null()).await["view"].clone();
    assert_eq!(view["game"], 1);
    assert_eq!(view["track"], "canyon");
    assert_eq!(view["laps"], 1);
    assert_eq!(view["you"], 0);
    assert!(view["resume"].is_null());
    let mut grid: Vec<u64> = view["grid"].as_array().unwrap().iter().map(|v| v.as_u64().unwrap()).collect();
    grid.sort();
    assert_eq!(grid, vec![0, 1]);
    let starts_in = view["startsIn"].as_u64().unwrap();
    assert!(starts_in > 3000, "倒數 {starts_in}");
    let bob_view = b.until(|m| m["type"] == "view" && !m["view"].is_null()).await["view"].clone();
    assert_eq!(bob_view["you"], 1);
    assert_eq!(bob_view["grid"], view["grid"]);

    // 狀態合併成 cars 事件轉送給所有人：alice 收得到 bob 的車
    a.act(json!({ "type": "state", "d": state(1.5) })).await;
    b.act(json!({ "type": "state", "d": state(-3.25) })).await;
    let cars = a
        .until(|m| {
            m["type"] == "event" && m["event"]["cars"].as_array().is_some_and(|cars| cars.iter().any(|row| row[0] == 1))
        })
        .await["event"]["cars"]
        .clone();
    let bob = cars.as_array().unwrap().iter().find(|row| row[0] == 1).unwrap();
    assert_eq!(bob.as_array().unwrap().len(), 11);
    assert_eq!(bob[2], -3.25);

    // 格式不對的狀態：伺服器看不懂
    a.act(json!({ "type": "state", "d": [1, 2, 3] })).await;
    assert_eq!(a.until(|m| m["type"] == "notice").await["message"], "看不懂這個動作");
    // 還沒起跑就說跑完一圈
    a.act(json!({ "type": "lap", "lap": 1, "time": 30000 })).await;
    assert_eq!(a.until(|m| m["type"] == "notice").await["message"], "還沒起跑");

    // 起跑後馬上說跑完一圈：時間對不上伺服器的時鐘，一圈也不可能這麼快
    tokio::time::sleep(Duration::from_millis(starts_in + 200)).await;
    a.act(json!({ "type": "lap", "lap": 1, "time": 30000 })).await;
    assert_eq!(a.until(|m| m["type"] == "notice").await["message"], "這圈快得不合理，不算");
}
