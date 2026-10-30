mod common;

use std::time::Duration;

use axum::http::StatusCode;
use backend::auth::upsert_admin;
use common::{TestApp, app, app_on};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async,
    tungstenite::{Message, client::IntoClientRequest},
};

/// 起一個真的 listener（WebSocket 需要真的連線），和 `app` 共用同一份狀態
async fn serve() -> (TestApp, String) {
    let app = app().await;
    let addr = listen(&app).await;
    (app, addr)
}

async fn listen(app: &TestApp) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    tokio::spawn(axum::serve(listener, app.router.clone()).into_future());
    addr
}

/// 建立帳號並登入，回傳 cookie
async fn login(app: &TestApp, username: &str) -> String {
    upsert_admin(&app.state.pool, username, "password123".into()).await.unwrap();
    let credentials = json!({ "username": username, "password": "password123" });
    let reply = app.call("POST", "/api/auth/login", None, Some(credentials)).await;
    assert_eq!(reply.status, StatusCode::OK);
    reply.cookie.unwrap()
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

    /// 帶著登入的 cookie 連線；`query` 例如 `game=chess&player=x`
    async fn connect_as(addr: &str, code: &str, query: &str, cookie: &str) -> Self {
        let mut request = format!("ws://{addr}/api/games/rooms/{code}/ws?{query}").into_client_request().unwrap();
        request.headers_mut().insert("cookie", cookie.parse().unwrap());
        Self(connect_async(request).await.unwrap().0)
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

    // 舊連線還在時重連（例如開了第二個分頁）：舊的收到 replaced 後被關掉，對方不會收到離線通知
    let mut b2 = Client::connect(&addr, &code, "reversi", "bob").await;
    assert_eq!(b2.next().await, json!({ "type": "welcome", "seat": 1, "peer": true, "history": history }));
    b.expect_error("replaced").await;
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

#[tokio::test]
async fn rooms_survive_a_restart() {
    let (old, old_addr) = serve().await;
    let code = create_room(&old, "gomoku").await;
    let mut a = Client::connect(&old_addr, &code, "gomoku", "alice").await;
    a.next().await;
    let mut b = Client::connect(&old_addr, &code, "gomoku", "bob").await;
    b.next().await;
    a.next().await;
    a.send_msg(json!({ "move": 1 })).await;
    a.next().await;
    b.next().await;
    b.send_msg(json!({ "move": 2 })).await;
    a.next().await;
    b.next().await;

    // 新容器：記憶體是空的，從資料庫載入。舊連線不關，模擬容器直接被停掉
    let new = app_on(old.state.pool.clone());
    let new_addr = listen(&new).await;
    let history = json!([{ "seat": 0, "data": { "move": 1 } }, { "seat": 1, "data": { "move": 2 } }]);
    let mut b = Client::connect(&new_addr, &code, "gomoku", "bob").await;
    assert_eq!(b.next().await, json!({ "type": "welcome", "seat": 1, "peer": false, "history": history }));
    let mut a = Client::connect(&new_addr, &code, "gomoku", "alice").await;
    assert_eq!(a.next().await, json!({ "type": "welcome", "seat": 0, "peer": true, "history": history }));
    assert_eq!(b.next().await, json!({ "type": "peer", "online": true }));

    a.send_msg(json!({ "move": 3 })).await;
    assert_eq!(b.next().await, json!({ "type": "msg", "seat": 0, "data": { "move": 3 } }));

    // 最後一個人離開後記憶體會丟掉房間，再連進來還是從資料庫拿到完整歷史
    a.0.close(None).await.unwrap();
    assert_eq!(b.next().await, json!({ "type": "peer", "online": false }));
    b.0.close(None).await.unwrap();
    b.expect_closed().await;
    let mut a = Client::connect(&new_addr, &code, "gomoku", "alice").await;
    let welcome = a.next().await;
    assert_eq!(welcome["seat"], 0);
    assert_eq!(welcome["history"].as_array().unwrap().len(), 3);
}

#[tokio::test]
async fn two_containers_on_the_same_room_resync_through_the_database() {
    let (one, addr1) = serve().await;
    let two = app_on(one.state.pool.clone());
    let addr2 = listen(&two).await;
    let code = create_room(&one, "chess").await;

    let mut a = Client::connect(&addr1, &code, "chess", "alice").await;
    assert_eq!(a.next().await["seat"], 0);
    let mut b = Client::connect(&addr2, &code, "chess", "bob").await;
    assert_eq!(b.next().await["seat"], 1);

    // 容器一的記憶體以為 seat 1 還空著，但資料庫裡已經有人：第三個人還是進不來
    Client::connect(&addr1, &code, "chess", "carol").await.expect_error("full").await;

    // a 先寫入第 0 號；b 那邊也想寫第 0 號，撞到後容器二關掉連線讓它重連
    a.send_msg(json!("a1")).await;
    assert_eq!(a.next().await, json!({ "type": "msg", "seat": 0, "data": "a1" }));
    b.send_msg(json!("b1")).await;
    b.expect_closed().await;
    let mut b = Client::connect(&addr2, &code, "chess", "bob").await;
    assert_eq!(b.next().await["history"], json!([{ "seat": 0, "data": "a1" }]));

    // 換版結束後 b 連到容器一，也拿回自己的座位
    let mut b = Client::connect(&addr1, &code, "chess", "bob").await;
    assert_eq!(b.next().await["seat"], 1);
    assert_eq!(a.next().await, json!({ "type": "peer", "online": true }));
}

#[tokio::test]
async fn logged_in_players_are_identified_by_account() {
    let (app, addr) = serve().await;
    let cookie = login(&app, "alice").await;
    let code = create_room(&app, "xiangqi").await;

    let mut phone = Client::connect_as(&addr, &code, "game=xiangqi&player=same-id", &cookie).await;
    assert_eq!(phone.next().await["seat"], 0);

    // 訪客的 id 和帳號分開：就算送一樣的字串也拿不到帳號的座位
    let mut guest = Client::connect(&addr, &code, "xiangqi", "same-id").await;
    assert_eq!(guest.next().await["seat"], 1);
    phone.next().await; // peer online

    // 同一個帳號換裝置（player 不同）拿回同一個座位，舊裝置收到 replaced
    let mut laptop = Client::connect_as(&addr, &code, "game=xiangqi&player=other-id", &cookie).await;
    assert_eq!(laptop.next().await["seat"], 0);
    phone.expect_error("replaced").await;

    // 登入後不帶 player 也可以
    let mut desktop = Client::connect_as(&addr, &code, "game=xiangqi", &cookie).await;
    assert_eq!(desktop.next().await["seat"], 0);
    laptop.expect_error("replaced").await;
}

#[tokio::test]
async fn idle_rooms_expire_and_are_cleaned_up() {
    let (app, addr) = serve().await;
    let code = create_room(&app, "reversi").await;
    sqlx::query("UPDATE game_rooms SET updated_at = '2000-01-01T00:00:00Z' WHERE code = ?")
        .bind(&code)
        .execute(&app.state.pool)
        .await
        .unwrap();
    Client::connect(&addr, &code, "reversi", "alice").await.expect_error("not_found").await;

    // 下次有人建立房間時清掉
    create_room(&app, "reversi").await;
    let left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM game_rooms WHERE code = ?")
        .bind(&code)
        .fetch_one(&app.state.pool)
        .await
        .unwrap();
    assert_eq!(left, 0);
}
