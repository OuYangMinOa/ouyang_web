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

async fn create(app: &TestApp, public: bool) -> String {
    let reply = app.call("POST", "/api/games/puyo/rooms", None, Some(json!({ "public": public }))).await;
    assert_eq!(reply.status, StatusCode::CREATED);
    reply.body["code"].as_str().unwrap().to_owned()
}

struct Client(WebSocketStream<MaybeTlsStream<TcpStream>>);

impl Client {
    async fn connect(addr: &str, code: &str, player: &str, name: &str) -> Self {
        let url = format!("ws://{addr}/api/games/puyo/rooms/{code}/ws?player={player}&name={name}");
        Self(connect_async(url).await.unwrap().0)
    }

    async fn next(&mut self) -> Value {
        loop {
            let message = tokio::time::timeout(Duration::from_secs(8), self.0.next())
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

    /// 跳過其他訊息，直到收到符合條件的那一則
    async fn until(&mut self, check: impl Fn(&Value) -> bool) -> Value {
        loop {
            let message = self.next().await;
            if check(&message) {
                return message;
            }
        }
    }

    async fn phase(&mut self, phase: &str) -> Value {
        self.until(|m| m["type"] == "state" && m["phase"] == phase).await
    }

    async fn send(&mut self, value: Value) {
        self.0.send(Message::text(value.to_string())).await.unwrap();
    }
}

#[tokio::test]
async fn rooms_are_private_only() {
    let (app, addr) = serve().await;
    let first = create(&app, true).await;
    assert_ne!(create(&app, true).await, first);
    let mut alice = Client::connect(&addr, &first, "a", "Alice").await;
    let state = alice.until(|m| m["type"] == "state").await;
    assert_eq!(state["public"], false);
}

#[tokio::test]
async fn nuisance_reaches_target_and_boards_are_relayed() {
    let (app, addr) = serve().await;
    let code = create(&app, false).await;
    let mut alice = Client::connect(&addr, &code, "a", "Alice").await;
    let a = alice.until(|m| m["type"] == "welcome").await["you"].as_u64().unwrap();
    let mut bob = Client::connect(&addr, &code, "b", "Bob").await;
    let b = bob.until(|m| m["type"] == "welcome").await["you"].as_u64().unwrap();

    alice.send(json!({ "type": "bots", "count": 0 })).await;
    alice.until(|m| m["type"] == "state" && m["bots"] == 0 && m["players"].as_array().unwrap().len() == 2).await;
    alice.send(json!({ "type": "start" })).await;
    alice.phase("playing").await;
    bob.phase("playing").await;
    alice.until(|m| m["type"] == "state" && m["players"][0]["target"] == b).await;

    // 一次送很多干擾泡也照轉（俄羅斯方塊最多 30 行，這裡是顆數）
    alice.send(json!({ "type": "attack", "lines": 120 })).await;
    let garbage = bob.until(|m| m["type"] == "garbage").await;
    assert_eq!(garbage["lines"], 120);
    assert_eq!(garbage["from"], a);

    // 13 × 6，干擾泡是 5；俄羅斯方塊格式的盤面不收
    bob.send(json!({ "type": "board", "rows": "0".repeat(200), "pending": 0 })).await;
    let mut rows = "0".repeat(72);
    rows.push_str("512345");
    bob.send(json!({ "type": "board", "rows": rows, "pending": 12 })).await;
    let boards = alice.until(|m| m["type"] == "boards" && m["boards"][b.to_string()].is_string()).await;
    assert_eq!(boards["boards"][b.to_string()], rows.as_str());

    bob.send(json!({ "type": "topout" })).await;
    let ko = alice.until(|m| m["type"] == "ko").await;
    assert_eq!(ko["victim"], b);
    assert_eq!(ko["killer"], a);
    alice.phase("results").await;
}

#[tokio::test]
async fn bots_stack_puyos() {
    let (app, addr) = serve().await;
    let code = create(&app, false).await;
    let mut alice = Client::connect(&addr, &code, "a", "Alice").await;
    alice.until(|m| m["type"] == "welcome").await;
    alice.send(json!({ "type": "bots", "count": 3 })).await;
    alice.send(json!({ "type": "start" })).await;
    let state = alice.phase("countdown").await;
    assert_eq!(state["players"].as_array().unwrap().len(), 4);
    alice.phase("playing").await;
    let boards = alice
        .until(|m| {
            m["type"] == "boards"
                && m["boards"].as_object().unwrap().values().any(|b| b.as_str().unwrap() != "0".repeat(78))
        })
        .await;
    for board in boards["boards"].as_object().unwrap().values() {
        let board = board.as_str().unwrap();
        assert_eq!(board.len(), 78);
        assert!(board.bytes().all(|c| (b'0'..=b'5').contains(&c)));
    }
    alice.send(json!({ "type": "topout" })).await;
    alice.phase("results").await;
}
