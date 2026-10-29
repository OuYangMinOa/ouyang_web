mod common;

use std::time::Duration;

use axum::http::StatusCode;
use common::{TestApp, app};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async, tungstenite::Message};

/// 起一個真的 listener（WebSocket 需要真的連線），和 `app` 共用同一份狀態
async fn serve() -> (TestApp, String) {
    let app = app().await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    tokio::spawn(axum::serve(listener, app.router.clone()).into_future());
    (app, addr)
}

async fn create_room(app: &TestApp, game: &str) -> String {
    let reply = app.call("POST", "/api/games/rooms", None, Some(json!({ "game": game }))).await;
    assert_eq!(reply.status, StatusCode::CREATED);
    reply.body["code"].as_str().unwrap().to_owned()
}

struct Client(WebSocketStream<MaybeTlsStream<TcpStream>>);

impl Client {
    async fn connect(addr: &str, code: &str, game: &str, player: &str) -> Self {
        let url = format!("ws://{addr}/api/games/rooms/{code}/ws?game={game}&player={player}");
        Self(connect_async(url).await.unwrap().0)
    }

    /// 下一則 JSON 訊息（略過 ping）
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

    async fn send(&mut self, value: Value) {
        self.0.send(Message::text(value.to_string())).await.unwrap();
    }

    async fn send_msg(&mut self, data: Value) {
        self.send(json!({ "type": "msg", "data": data })).await;
    }

    /// 伺服器關閉連線（Close frame 或直接斷線）
    async fn expect_closed(&mut self) {
        loop {
            match tokio::time::timeout(Duration::from_secs(5), self.0.next()).await.expect("connection still open") {
                None | Some(Err(_)) | Some(Ok(Message::Close(_))) => return,
                Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
                Some(Ok(other)) => panic!("unexpected message: {other:?}"),
            }
        }
    }

    async fn expect_error(&mut self, code: &str) {
        let message = self.next().await;
        assert_eq!(message["type"], "error");
        assert_eq!(message["code"], code);
        assert!(message["message"].is_string());
        self.expect_closed().await;
    }
}

#[tokio::test]
async fn create_room_returns_code() {
    let app = app().await;
    let code = create_room(&app, "gomoku").await;
    assert_eq!(code.len(), 5);
    assert!(code.chars().all(|c| "ABCDEFGHJKLMNPQRSTUVWXYZ23456789".contains(c)));
    assert_ne!(create_room(&app, "chess").await, code);

    for body in [json!({ "game": "poker" }), json!({})] {
        let reply = app.call("POST", "/api/games/rooms", None, Some(body)).await;
        assert_eq!(reply.status, StatusCode::BAD_REQUEST);
        assert!(reply.body["error"].is_string());
    }
}

#[tokio::test]
async fn too_many_rooms_is_503() {
    let app = app().await;
    for _ in 0..1000 {
        create_room(&app, "reversi").await;
    }
    let reply = app.call("POST", "/api/games/rooms", None, Some(json!({ "game": "reversi" }))).await;
    assert_eq!(reply.status, StatusCode::SERVICE_UNAVAILABLE);
}

#[tokio::test]
async fn two_players_get_seats_and_peer_updates() {
    let (app, addr) = serve().await;
    let code = create_room(&app, "gomoku").await;

    let mut a = Client::connect(&addr, &code, "gomoku", "alice").await;
    assert_eq!(a.next().await, json!({ "type": "welcome", "seat": 0, "peer": false, "history": [] }));

    // 房號大小寫不拘
    let mut b = Client::connect(&addr, &code.to_lowercase(), "gomoku", "bob").await;
    assert_eq!(b.next().await, json!({ "type": "welcome", "seat": 1, "peer": true, "history": [] }));
    assert_eq!(a.next().await, json!({ "type": "peer", "online": true }));

    b.0.close(None).await.unwrap();
    assert_eq!(a.next().await, json!({ "type": "peer", "online": false }));
}

#[tokio::test]
async fn messages_are_broadcast_to_both_in_the_same_order() {
    let (app, addr) = serve().await;
    let code = create_room(&app, "xiangqi").await;
    let mut a = Client::connect(&addr, &code, "xiangqi", "alice").await;
    a.next().await;
    let mut b = Client::connect(&addr, &code, "xiangqi", "bob").await;
    b.next().await;
    a.next().await; // peer online

    // 兩邊同時送，伺服器決定順序，但兩邊看到的要一樣
    for i in 0..5 {
        a.send_msg(json!({ "from": "a", "i": i })).await;
        b.send_msg(json!({ "from": "b", "i": i })).await;
    }
    // 非 JSON 和未知 type 會被忽略
    a.send(json!({ "type": "hello" })).await;
    a.0.send(Message::text("not json")).await.unwrap();

    let mut seen_a = Vec::new();
    let mut seen_b = Vec::new();
    for _ in 0..10 {
        seen_a.push(a.next().await);
        seen_b.push(b.next().await);
    }
    assert_eq!(seen_a, seen_b);
    for message in &seen_a {
        assert_eq!(message["type"], "msg");
        let seat = if message["data"]["from"] == "a" { 0 } else { 1 };
        assert_eq!(message["seat"], seat);
    }
    // 同一個人送的訊息維持送出順序
    let order: Vec<_> = seen_a.iter().filter(|m| m["seat"] == 0).map(|m| m["data"]["i"].clone()).collect();
    assert_eq!(order, (0..5).map(|i| json!(i)).collect::<Vec<_>>());
}

#[tokio::test]
async fn third_player_is_rejected() {
    let (app, addr) = serve().await;
    let code = create_room(&app, "chess").await;
    let mut a = Client::connect(&addr, &code, "chess", "alice").await;
    a.next().await;
    let mut b = Client::connect(&addr, &code, "chess", "bob").await;
    b.next().await;

    Client::connect(&addr, &code, "chess", "carol").await.expect_error("full").await;
}

#[tokio::test]
async fn reconnect_gets_same_seat_and_full_history() {
    let (app, addr) = serve().await;
    let code = create_room(&app, "reversi").await;
    let mut a = Client::connect(&addr, &code, "reversi", "alice").await;
    a.next().await;
    let mut b = Client::connect(&addr, &code, "reversi", "bob").await;
    b.next().await;
    a.next().await;

    a.send_msg(json!("a1")).await;
    a.next().await;
    b.next().await;
    b.send_msg(json!({ "move": [3, 4] })).await;
    a.next().await;
    b.next().await;
    let history = json!([{ "seat": 0, "data": "a1" }, { "seat": 1, "data": { "move": [3, 4] } }]);

    // 斷線後重連
    a.0.close(None).await.unwrap();
    assert_eq!(b.next().await, json!({ "type": "peer", "online": false }));
    let mut a = Client::connect(&addr, &code, "reversi", "alice").await;
    assert_eq!(a.next().await, json!({ "type": "welcome", "seat": 0, "peer": true, "history": history }));
    assert_eq!(b.next().await, json!({ "type": "peer", "online": true }));

    // 舊連線還在時重連（例如開了第二個分頁）：舊的被關掉，對方不會收到離線通知
    let mut b2 = Client::connect(&addr, &code, "reversi", "bob").await;
    assert_eq!(b2.next().await, json!({ "type": "welcome", "seat": 1, "peer": true, "history": history }));
    b.expect_closed().await;
    assert_eq!(a.next().await, json!({ "type": "peer", "online": true }));

    a.send_msg(json!("a2")).await;
    assert_eq!(b2.next().await, json!({ "type": "msg", "seat": 0, "data": "a2" }));
}

#[tokio::test]
async fn bad_joins_get_an_error_after_upgrade() {
    let (app, addr) = serve().await;
    let code = create_room(&app, "gomoku").await;

    Client::connect(&addr, "ZZZZZ", "gomoku", "alice").await.expect_error("not_found").await;
    Client::connect(&addr, &code, "chess", "alice").await.expect_error("game_mismatch").await;
    Client::connect(&addr, &code, "gomoku", "").await.expect_error("bad_request").await;
    Client::connect(&addr, &code, "gomoku", &"x".repeat(65)).await.expect_error("bad_request").await;

    // 被拒絕的連線不會佔座位
    let mut a = Client::connect(&addr, &code, "gomoku", "alice").await;
    assert_eq!(a.next().await["seat"], 0);
}

#[tokio::test]
async fn oversized_or_flooding_messages_close_the_connection() {
    let (app, addr) = serve().await;
    let code = create_room(&app, "gomoku").await;

    let mut a = Client::connect(&addr, &code, "gomoku", "alice").await;
    a.next().await;
    a.send_msg(json!("x".repeat(5000))).await;
    a.expect_error("too_large").await;

    let mut a = Client::connect(&addr, &code, "gomoku", "alice").await;
    a.next().await;
    for i in 0..25 {
        a.send_msg(json!(i)).await;
    }
    let mut last = Value::Null;
    while last["type"] != "error" {
        last = a.next().await;
    }
    assert_eq!(last["code"], "rate_limited");
}
