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
    let reply = app.call("POST", "/api/games/tetris/rooms", None, Some(json!({ "public": public }))).await;
    assert_eq!(reply.status, StatusCode::CREATED);
    reply.body["code"].as_str().unwrap().to_owned()
}

struct Client(WebSocketStream<MaybeTlsStream<TcpStream>>);

impl Client {
    async fn connect(addr: &str, code: &str, player: &str, name: &str) -> Self {
        let url = format!("ws://{addr}/api/games/tetris/rooms/{code}/ws?player={player}&name={name}");
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
async fn quick_match_reuses_open_public_room() {
    let (app, _) = serve().await;
    let first = create(&app, true).await;
    assert_eq!(create(&app, true).await, first);
    assert_ne!(create(&app, false).await, first);
}

#[tokio::test]
async fn unknown_room_is_rejected() {
    let (_, addr) = serve().await;
    let mut client = Client::connect(&addr, "ZZZZZ", "a", "A").await;
    let message = client.next().await;
    assert_eq!(message["type"], "error");
    assert_eq!(message["code"], "not_found");
}

#[tokio::test]
async fn attack_reaches_target_and_last_one_wins() {
    let (app, addr) = serve().await;
    let code = create(&app, false).await;

    let mut alice = Client::connect(&addr, &code, "a", "Alice").await;
    let welcome = alice.next().await;
    assert_eq!(welcome["type"], "welcome");
    let a = welcome["you"].as_u64().unwrap();
    let mut bob = Client::connect(&addr, &code, "b", "Bob").await;
    let b = bob.until(|m| m["type"] == "welcome").await["you"].as_u64().unwrap();

    let state = alice.until(|m| m["type"] == "state" && m["players"].as_array().unwrap().len() == 2).await;
    assert_eq!(state["host"], a);
    assert_eq!(state["players"][1]["name"], "Bob");

    // 不是房主不能開局；房主關掉電腦後開局
    bob.send(json!({ "type": "start" })).await;
    alice.send(json!({ "type": "bots", "count": 0 })).await;
    alice.until(|m| m["type"] == "state" && m["bots"] == 0).await;
    alice.send(json!({ "type": "start" })).await;
    let countdown = alice.phase("countdown").await;
    assert_eq!(countdown["players"].as_array().unwrap().len(), 2);
    alice.phase("playing").await;
    bob.phase("playing").await;

    // 兩個人時目標一定是對方
    let state = alice.until(|m| m["type"] == "state" && m["players"][0]["target"] == b).await;
    assert_eq!(state["players"][1]["target"], a);

    alice.send(json!({ "type": "attack", "lines": 4 })).await;
    let garbage = bob.until(|m| m["type"] == "garbage").await;
    assert_eq!(garbage["lines"], 4);
    assert_eq!(garbage["from"], a);

    let mut rows = "0".repeat(190);
    rows.push_str("8888888880");
    bob.send(json!({ "type": "board", "rows": rows, "pending": 2 })).await;
    let boards = alice.until(|m| m["type"] == "boards" && m["boards"][b.to_string()].is_string()).await;
    assert_eq!(boards["boards"][b.to_string()], rows.as_str());

    bob.send(json!({ "type": "topout" })).await;
    let ko = alice.until(|m| m["type"] == "ko").await;
    assert_eq!(ko["victim"], b);
    assert_eq!(ko["killer"], a);
    let results = alice.phase("results").await;
    let players = results["players"].as_array().unwrap();
    assert_eq!(players[0]["place"], 1);
    assert_eq!(players[0]["kos"], 1);
    assert_eq!(players[0]["badges"], 1);
    assert_eq!(players[1]["place"], 2);
}

#[tokio::test]
async fn solo_player_can_play_against_bots() {
    let (app, addr) = serve().await;
    let code = create(&app, false).await;
    let mut alice = Client::connect(&addr, &code, "a", "Alice").await;
    alice.until(|m| m["type"] == "welcome").await;
    alice.send(json!({ "type": "bots", "count": 3 })).await;
    alice.send(json!({ "type": "start" })).await;
    let state = alice.phase("countdown").await;
    let players = state["players"].as_array().unwrap();
    assert_eq!(players.len(), 4);
    assert!(players[1..].iter().all(|p| p["bot"] == true && p["alive"] == true));

    alice.phase("playing").await;
    // 電腦玩家會放方塊，盤面會更新
    alice
        .until(|m| {
            m["type"] == "boards"
                && m["boards"].as_object().unwrap().values().any(|b| b.as_str().unwrap() != "0".repeat(200))
        })
        .await;

    // 自己出局後不等電腦打完，直接結算
    alice.send(json!({ "type": "topout" })).await;
    let results = alice.phase("results").await;
    let mut places: Vec<u64> =
        results["players"].as_array().unwrap().iter().map(|p| p["place"].as_u64().unwrap()).collect();
    places.sort();
    assert_eq!(places, [1, 2, 3, 4]);
}

#[tokio::test]
async fn same_guest_reclaims_their_slot() {
    let (app, addr) = serve().await;
    let code = create(&app, false).await;
    let mut first = Client::connect(&addr, &code, "a", "Alice").await;
    let pid = first.until(|m| m["type"] == "welcome").await["you"].clone();
    let mut second = Client::connect(&addr, &code, "a", "Alice").await;
    assert_eq!(second.until(|m| m["type"] == "welcome").await["you"], pid);
    let error = first.until(|m| m["type"] == "error").await;
    assert_eq!(error["code"], "replaced");
}
