//! 大老二（bigtwo.rs）的 WebSocket 整合測試：一個真人加三個電腦，真的打幾手

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
        let url = format!("ws://{addr}/api/games/bigtwo/party/{code}/ws?player={player}&name={player}");
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

    async fn view(&mut self) -> Value {
        self.until(|m| m["type"] == "view" && !m["view"].is_null()).await["view"].clone()
    }

    async fn send(&mut self, value: Value) {
        self.0.send(Message::text(value.to_string())).await.unwrap();
    }
}

#[tokio::test]
async fn one_player_and_three_bots() {
    let (app, addr) = serve().await;
    let reply = app.call("POST", "/api/games/bigtwo/party", None, None).await;
    assert_eq!(reply.status, StatusCode::CREATED);
    let code = reply.body["code"].as_str().unwrap().to_owned();

    let mut me = Client::connect(&addr, &code, "alice").await;
    let room = me.until(|m| m["type"] == "room").await;
    assert_eq!((room["min"].as_u64(), room["max"].as_u64(), room["maxBots"].as_u64()), (Some(4), Some(4), Some(3)));

    // 人不夠不能開始
    me.send(json!({ "type": "start" })).await;
    me.until(|m| m["type"] == "notice").await;
    for _ in 0..3 {
        me.send(json!({ "type": "addBot" })).await;
    }
    me.until(|m| m["type"] == "room" && m["players"].as_array().unwrap().len() == 4).await;
    // 思考時間只能選固定的幾種
    let mut options = room["options"].clone();
    options["thinkSecs"] = json!(7);
    me.send(json!({ "type": "options", "options": options })).await;
    me.until(|m| m["type"] == "notice").await;
    me.send(json!({ "type": "start" })).await;

    let view = me.view().await;
    // 真人照名單排在電腦前面，坐座位 0
    assert_eq!(view["you"], 0);
    assert_eq!(view["hand"].as_array().unwrap().len(), 13);
    for seat in view["seats"].as_array().unwrap() {
        assert_eq!(seat["count"], 13);
    }

    // 打到輪到自己第二次：中間電腦一定動過
    let mut my_turns = 0;
    let mut view = view;
    loop {
        if view["turn"] == 0 {
            my_turns += 1;
            if my_turns == 3 {
                break;
            }
            let plays = view["plays"].as_array().unwrap();
            let action = match plays.first() {
                Some(play) => json!({ "type": "play", "cards": play["cards"] }),
                None => json!({ "type": "pass" }),
            };
            // 出牌前試一次不合法的：不是自己的牌
            let hand: Vec<u64> = serde_json::from_value(view["hand"].clone()).unwrap();
            let foreign = (0..52).find(|c| !hand.contains(c)).unwrap();
            me.send(json!({ "type": "action", "action": { "type": "play", "cards": [foreign] } })).await;
            let notice = me.until(|m| m["type"] == "notice").await;
            assert_eq!(notice["message"], "你手上沒有這些牌");
            me.send(json!({ "type": "action", "action": action })).await;
        }
        if view["stage"] == "end" {
            break;
        }
        view = me.view().await;
        // 別人的手牌永遠不會出現
        assert!(view["seats"].as_array().unwrap().iter().all(|s| s.get("hand").is_none()));
        if view["turn"] != 0 {
            assert!(view["plays"].as_array().unwrap().is_empty());
        }
    }
    let played: u64 = view["seats"].as_array().unwrap().iter().map(|s| 13 - s["count"].as_u64().unwrap()).sum();
    assert!(played >= 2, "至少有人出過牌");
}
