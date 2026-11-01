//! 派對房間（party.rs）的 WebSocket 整合測試，用誰是臥底當遊戲

mod common;

use std::time::Duration;

use axum::http::StatusCode;
use backend::auth::upsert_admin;
use common::{TestApp, app};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async,
    tungstenite::{Message, client::IntoClientRequest},
};

async fn serve() -> (TestApp, String) {
    let app = app().await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    tokio::spawn(axum::serve(listener, app.router.clone()).into_future());
    (app, addr)
}

async fn create(app: &TestApp) -> String {
    let reply = app.call("POST", "/api/games/undercover/party", None, None).await;
    assert_eq!(reply.status, StatusCode::CREATED);
    reply.body["code"].as_str().unwrap().to_owned()
}

struct Client(WebSocketStream<MaybeTlsStream<TcpStream>>);

impl Client {
    async fn connect(addr: &str, code: &str, player: &str, name: &str) -> Self {
        let url = format!("ws://{addr}/api/games/undercover/party/{code}/ws?player={player}&name={name}");
        Self(connect_async(url).await.unwrap().0)
    }

    async fn connect_as(addr: &str, code: &str, cookie: &str) -> Self {
        let mut request =
            format!("ws://{addr}/api/games/undercover/party/{code}/ws?player=ignored").into_client_request().unwrap();
        request.headers_mut().insert("cookie", cookie.parse().unwrap());
        Self(connect_async(request).await.unwrap().0)
    }

    /// 下一則 JSON 訊息（略過 ping）；連線關閉時回傳 None
    async fn try_next(&mut self) -> Option<Value> {
        loop {
            let message = tokio::time::timeout(Duration::from_secs(5), self.0.next())
                .await
                .expect("timed out waiting for a message")?;
            match message {
                Ok(Message::Text(text)) => return Some(serde_json::from_str(&text).unwrap()),
                Ok(Message::Ping(_) | Message::Pong(_)) => {}
                Ok(Message::Close(_)) | Err(_) => return None,
                Ok(other) => panic!("unexpected message: {other:?}"),
            }
        }
    }

    async fn next(&mut self) -> Value {
        self.try_next().await.expect("connection closed")
    }

    async fn until(&mut self, check: impl Fn(&Value) -> bool) -> Value {
        loop {
            let message = self.next().await;
            if check(&message) {
                return message;
            }
        }
    }

    async fn room(&mut self) -> Value {
        self.until(|m| m["type"] == "room").await
    }

    async fn view(&mut self) -> Value {
        self.until(|m| m["type"] == "view" && !m["view"].is_null()).await["view"].clone()
    }

    async fn send(&mut self, value: Value) {
        self.0.send(Message::text(value.to_string())).await.unwrap();
    }

    /// 等到連線關閉，回傳最後的錯誤代碼
    async fn closed(&mut self) -> Option<String> {
        let mut code = None;
        while let Some(message) = self.try_next().await {
            if message["type"] == "error" {
                code = message["code"].as_str().map(String::from);
            }
        }
        code
    }
}

#[tokio::test]
async fn join_lobby_and_host_moves_on() {
    let (app, addr) = serve().await;
    let code = create(&app).await;

    let mut a = Client::connect(&addr, &code, "a", "阿明").await;
    let welcome = a.next().await;
    assert_eq!(welcome["type"], "welcome");
    let me = welcome["you"].clone();
    let room = a.next().await;
    assert_eq!(room["type"], "room");
    assert_eq!(room["phase"], "lobby");
    assert_eq!(room["host"], me);
    assert_eq!(room["min"], 3);
    assert_eq!(room["options"]["speakSecs"], 45);
    assert_eq!(a.next().await["type"], "chats");
    assert_eq!(a.next().await["view"], Value::Null);

    let mut b = Client::connect(&addr, &code, "b", "阿明").await;
    let room = b.room().await;
    let names: Vec<&str> = room["players"].as_array().unwrap().iter().map(|p| p["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["阿明", "阿明 2"]);
    let b_pid = room["players"][1]["pid"].clone();
    // 不是房主的操作被忽略
    b.send(json!({ "type": "addBot" })).await;
    a.send(json!({ "type": "chat", "text": "大家好" })).await;
    let line = b.until(|m| m["type"] == "chat").await["line"].clone();
    assert_eq!(line["text"], "大家好");
    assert_eq!(line["name"], "阿明");

    drop(a);
    let room = b.until(|m| m["type"] == "room" && m["players"].as_array().unwrap().len() == 1).await;
    assert_eq!(room["host"], b_pid);
}

#[tokio::test]
async fn words_stay_private_and_seats_survive_reconnects() {
    let (app, addr) = serve().await;
    let code = create(&app).await;
    let mut a = Client::connect(&addr, &code, "a", "A").await;
    a.room().await;
    let mut b = Client::connect(&addr, &code, "b", "B").await;
    b.room().await;
    a.send(json!({ "type": "addBot" })).await;
    a.send(json!({ "type": "addBot" })).await;
    a.until(|m| m["type"] == "room" && m["players"].as_array().unwrap().len() == 4).await;
    a.send(json!({ "type": "start" })).await;

    let va = a.view().await;
    let vb = b.view().await;
    assert_eq!(va["stage"], "peek");
    assert_eq!(va["you"], 0);
    assert_eq!(vb["you"], 1);
    // 每個人只看得到自己的詞，身分也不會外流
    let wa = va["word"].as_str().unwrap();
    let wb = vb["word"].as_str().unwrap();
    if wa != wb && !wa.contains(wb) && !wb.contains(wa) {
        assert!(!vb.to_string().contains(wa));
        assert!(!va.to_string().contains(wb));
    }
    assert!(va["seats"].as_array().unwrap().iter().all(|s| s["role"].is_null()));

    // 斷線再連回來，拿回同一個座位和同一個詞
    drop(b);
    let room = a.until(|m| m["type"] == "room" && m["players"][1]["online"] == false).await;
    assert_eq!(room["players"][1]["seat"], 1);
    let mut b = Client::connect(&addr, &code, "b", "B").await;
    let view = b.view().await;
    assert_eq!(view["you"], 1);
    assert_eq!(view["word"], wb);

    // 對局中才進來的人觀戰：看不到任何人的詞
    let mut c = Client::connect(&addr, &code, "c", "C").await;
    let room = c.room().await;
    assert_eq!(room["phase"], "playing");
    let view = c.view().await;
    assert_eq!(view["you"], Value::Null);
    assert_eq!(view["word"], Value::Null);
    assert!(!view.to_string().contains(wa));

    // 觀戰的人說話，場上的人看不到
    c.send(json!({ "type": "chat", "text": "我只是來看的" })).await;
    let line = c.until(|m| m["type"] == "chat" && m["line"]["pid"].is_number()).await["line"].clone();
    assert_eq!(line["private"], true);

    // 動作被拒絕只回給自己
    b.send(json!({ "type": "action", "action": { "type": "vote", "seat": 0 } })).await;
    let notice = b.until(|m| m["type"] == "notice").await;
    assert!(!notice["message"].as_str().unwrap().is_empty());

    // 同一個人從別的分頁連進來：舊的被取代
    let mut b2 = Client::connect(&addr, &code, "b", "B").await;
    b2.view().await;
    assert_eq!(b.closed().await.as_deref(), Some("replaced"));
}

#[tokio::test]
async fn logged_in_players_use_their_account() {
    let (app, addr) = serve().await;
    upsert_admin(&app.state.pool, "alice", "password123".into()).await.unwrap();
    let credentials = json!({ "username": "alice", "password": "password123" });
    let cookie = app.call("POST", "/api/auth/login", None, Some(credentials)).await.cookie.unwrap();
    let code = create(&app).await;

    let mut first = Client::connect_as(&addr, &code, &cookie).await;
    let room = first.room().await;
    assert_eq!(room["players"][0]["name"], "alice");
    // 換一個分頁（不同的 player id）也認得是同一個人
    let mut second = Client::connect_as(&addr, &code, &cookie).await;
    let room = second.room().await;
    assert_eq!(room["players"].as_array().unwrap().len(), 1);
    assert_eq!(first.closed().await.as_deref(), Some("replaced"));
}

#[tokio::test]
async fn kicked_players_cannot_come_back() {
    let (app, addr) = serve().await;
    let code = create(&app).await;
    let mut a = Client::connect(&addr, &code, "a", "A").await;
    a.room().await;
    let mut b = Client::connect(&addr, &code, "b", "B").await;
    let room = b.room().await;
    let pid = room["players"][1]["pid"].clone();
    a.send(json!({ "type": "kick", "pid": pid })).await;
    assert_eq!(b.closed().await.as_deref(), Some("kicked"));
    let mut again = Client::connect(&addr, &code, "b", "B").await;
    assert_eq!(again.closed().await.as_deref(), Some("kicked"));
}

#[tokio::test]
async fn limits() {
    let (app, addr) = serve().await;

    let mut lost = Client::connect(&addr, "ZZZZZ", "a", "A").await;
    assert_eq!(lost.closed().await.as_deref(), Some("not_found"));

    let code = create(&app).await;
    // 太大的訊息直接斷線
    let mut big = Client::connect(&addr, &code, "big", "B").await;
    big.room().await;
    big.send(json!({ "type": "chat", "text": "長".repeat(5000) })).await;
    assert_eq!(big.closed().await, None);

    // 送太快
    let mut fast = Client::connect(&addr, &code, "fast", "F").await;
    fast.room().await;
    for _ in 0..30 {
        fast.send(json!({ "type": "chat", "text": "嗨" })).await;
    }
    assert_eq!(fast.closed().await.as_deref(), Some("rate_limited"));

    // 聊天的長度會被裁掉
    let mut a = Client::connect(&addr, &code, "a", "A").await;
    a.room().await;
    a.send(json!({ "type": "chat", "text": "字".repeat(300) })).await;
    let line = a.until(|m| m["type"] == "chat").await["line"].clone();
    assert_eq!(line["text"].as_str().unwrap().chars().count(), 200);

    let mut no_player = connect_async(format!("ws://{addr}/api/games/undercover/party/{code}/ws")).await.unwrap().0;
    let reply = no_player.next().await.unwrap().unwrap();
    assert!(reply.to_text().unwrap().contains("bad_request"));
}

#[tokio::test]
async fn options_are_checked() {
    let (app, addr) = serve().await;
    let code = create(&app).await;
    let mut a = Client::connect(&addr, &code, "a", "A").await;
    a.room().await;
    a.send(json!({ "type": "options", "options": { "undercover": 5 } })).await;
    assert_eq!(a.until(|m| m["type"] == "notice").await["message"], "臥底最多 3 人");
    a.send(json!({ "type": "options", "options": { "blank": true, "speakSecs": 999 } })).await;
    let room = a.until(|m| m["type"] == "room" && m["options"]["blank"] == true).await;
    assert_eq!(room["options"]["speakSecs"], 180);
    a.send(json!({ "type": "addBot" })).await;
    a.send(json!({ "type": "addBot" })).await;
    a.send(json!({ "type": "addBot" })).await;
    a.until(|m| m["type"] == "room" && m["players"].as_array().unwrap().len() == 4).await;
    a.send(json!({ "type": "start" })).await;
    assert_eq!(a.until(|m| m["type"] == "notice").await["message"], "5 人以上才能加白板");
}
