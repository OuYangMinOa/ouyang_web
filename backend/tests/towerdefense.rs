//! 迷宮塔防（towerdefense.rs）的 WebSocket 整合測試：開房、蓋塔、開打，
//! 塔的變化走 `tower` 事件、怪物和開火走 `tick` 事件，中途進來的人從 view 拿回所有的塔

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
        let url = format!("ws://{addr}/api/games/towerdefense/party/{code}/ws?player={player}&name={player}");
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

    async fn event(&mut self, kind: &str) -> Value {
        self.until(|m| m["type"] == "event" && m["event"]["type"] == kind).await["event"].clone()
    }

    async fn send(&mut self, value: Value) {
        self.0.send(Message::text(value.to_string())).await.unwrap();
    }

    async fn act(&mut self, action: Value) {
        self.send(json!({ "type": "action", "action": action })).await;
    }
}

#[tokio::test]
async fn the_spec_lists_towers_monsters_and_maps() {
    let app = app().await;
    let reply = app.call("GET", "/api/games/towerdefense/spec", None, None).await;
    assert_eq!(reply.status, StatusCode::OK);
    let spec = &reply.body;
    assert_eq!(spec["towers"].as_array().unwrap().len(), 7);
    assert_eq!(spec["towers"][0]["id"], "bolt");
    assert_eq!(spec["towers"][0]["levels"][0]["cost"], 50);
    assert_eq!(spec["towers"][0]["levels"].as_array().unwrap().len(), 4);
    assert_eq!(spec["monsters"].as_array().unwrap().len(), 11);
    assert_eq!(spec["monsters"][4]["id"], "flyer");
    assert_eq!(spec["monsters"][4]["air"], true);
    assert_eq!(spec["maps"].as_array().unwrap().len(), 4);
    assert_eq!(spec["maps"][0]["id"], "plains");
    assert_eq!(spec["maps"][0]["w"], 21);
    assert_eq!(spec["maps"][0]["rows"].as_array().unwrap().len(), 13);
    assert_eq!(spec["units"][0]["kind"], "grunt");
}

#[tokio::test]
async fn a_solo_defender_builds_and_fights_through_the_server() {
    let (app, addr) = serve().await;
    let reply = app.call("POST", "/api/games/towerdefense/party", None, None).await;
    assert_eq!(reply.status, StatusCode::CREATED);
    let code = reply.body["code"].as_str().unwrap().to_owned();

    let mut a = Client::connect(&addr, &code, "alice").await;
    let room = a.until(|m| m["type"] == "room").await;
    assert_eq!(room["min"], 1);
    assert_eq!(room["max"], 8);
    assert_eq!(room["maxBots"], 7);
    assert_eq!(
        room["options"],
        json!({ "mode": "coop", "map": "plains", "difficulty": "normal", "waves": 20, "bots": "normal" })
    );
    a.send(json!({ "type": "options", "options": { "map": "moon" } })).await;
    assert_eq!(a.until(|m| m["type"] == "notice").await["message"], "沒有這張地圖");
    // 對抗模式一個人開不了
    a.send(json!({ "type": "options", "options": { "mode": "versus" } })).await;
    a.until(|m| m["type"] == "room" && m["options"]["mode"] == "versus").await;
    a.send(json!({ "type": "start" })).await;
    assert_eq!(a.until(|m| m["type"] == "notice").await["message"], "對抗模式至少要 2 個人，可以加電腦玩家");
    a.send(json!({ "type": "options", "options": { "mode": "coop" } })).await;
    a.send(json!({ "type": "start" })).await;

    let view = a.until(|m| m["type"] == "view" && !m["view"].is_null()).await["view"].clone();
    assert_eq!(view["you"], 0);
    assert_eq!(view["mode"], "coop");
    assert_eq!(view["wave"], 0);
    assert_eq!(view["players"][0]["gold"], 300);
    assert_eq!(view["fields"][0]["lives"], 20);
    assert_eq!(view["fields"][0]["towers"], json!([]));
    assert!(view["nextIn"].as_u64().unwrap() > 25_000);

    // 蓋在入口旁邊：塔的變化用事件送，帶著新的路線
    let cell = 5 * 21 + 3;
    a.act(json!({ "type": "build", "cell": cell, "kind": "bolt" })).await;
    let built = a.event("tower").await;
    assert_eq!(built["op"], "add");
    assert_eq!(built["f"], 0);
    assert_eq!(built["rev"], 1);
    assert_eq!(built["t"], json!([1, cell, 0, 1, 0, 0]));
    assert_eq!(built["paths"][0].as_array().unwrap().len(), 21);
    // 蓋在入口上：被擋下來
    a.act(json!({ "type": "build", "cell": 6 * 21, "kind": "bolt" })).await;
    assert_eq!(a.until(|m| m["type"] == "notice").await["message"], "這一格不能蓋塔");

    // 準備好了：第一波提早開始，怪物跟著 tick 送過來
    a.act(json!({ "type": "ready", "ready": true })).await;
    assert_eq!(a.event("wave").await["wave"], 1);
    let tick =
        a.until(|m| m["type"] == "event" && m["event"]["m"].as_str().is_some_and(|s| !s.is_empty())).await["event"]
            .clone();
    assert_eq!(tick["f"], 0);
    assert_eq!(tick["m"].as_str().unwrap().len() % 10, 0);
    assert_eq!(tick["g"], json!([250]));
    assert_eq!(tick["l"], json!([20]));
    // 塔開火：[塔的 id, 怪物的 id]
    let shot = a.until(|m| m["type"] == "event" && m["event"]["s"].is_array()).await["event"].clone();
    assert_eq!(shot["s"][0][0], 1);

    // 中途進來的人是觀戰：view 裡已經有那座塔，之後的 tick 也收得到
    let mut b = Client::connect(&addr, &code, "bob").await;
    let view = b.until(|m| m["type"] == "view" && !m["view"].is_null()).await["view"].clone();
    assert_eq!(view["you"], Value::Null);
    assert_eq!(view["wave"], 1);
    assert_eq!(view["fields"][0]["towers"], json!([[1, cell, 0, 1, 0, 0]]));
    assert_eq!(view["fields"][0]["rev"], 1);
    assert_eq!(b.event("tick").await["f"], 0);
    // 觀戰的人不能蓋塔
    b.act(json!({ "type": "build", "cell": cell + 1, "kind": "bolt" })).await;
    assert_eq!(b.until(|m| m["type"] == "notice").await["message"], "你在觀戰，下一局才能參加");
}
