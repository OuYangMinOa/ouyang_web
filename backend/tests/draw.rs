//! 你畫我猜（draw.rs）的 WebSocket 整合測試：答案不外流（view、事件、聊天都檢查）、筆畫即時轉送、重連拿回整張畫布

use std::time::Duration;

use crate::common::{TestApp, app};
use axum::http::StatusCode;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async, tungstenite::Message};

const NAMES: [&str; 4] = ["a", "b", "c", "e"];

async fn serve() -> (TestApp, String) {
    let app = app().await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    tokio::spawn(axum::serve(listener, app.router.clone()).into_future());
    (app, addr)
}

async fn create(app: &TestApp) -> String {
    let reply = app.call("POST", "/api/games/draw/party", None, None).await;
    assert_eq!(reply.status, StatusCode::CREATED);
    reply.body["code"].as_str().unwrap().to_owned()
}

/// 收到的每一則原始文字都記在 `log`，用來檢查答案有沒有出現在任何地方
struct Client {
    ws: WebSocketStream<MaybeTlsStream<TcpStream>>,
    log: Vec<String>,
}

impl Client {
    async fn connect(addr: &str, code: &str, player: &str) -> Self {
        let url = format!("ws://{addr}/api/games/draw/party/{code}/ws?player={player}&name={player}");
        Self { ws: connect_async(url).await.unwrap().0, log: Vec::new() }
    }

    async fn next(&mut self) -> Value {
        loop {
            let message = tokio::time::timeout(Duration::from_secs(5), self.ws.next())
                .await
                .expect("timed out waiting for a message")
                .expect("connection closed")
                .unwrap();
            match message {
                Message::Text(text) => {
                    self.log.push(text.to_string());
                    return serde_json::from_str(&text).unwrap();
                }
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
        self.ws.send(Message::text(value.to_string())).await.unwrap();
    }

    async fn act(&mut self, action: Value) {
        self.send(json!({ "type": "action", "action": action })).await;
    }

    async fn chat(&mut self, text: &str) {
        self.send(json!({ "type": "chat", "text": text })).await;
    }

    /// 說一句話並等到自己的那一句回來：在那之前收到的都已經處理完了（用來確認「沒有收到」某些東西）
    async fn sync(&mut self, marker: &str) -> Vec<Value> {
        self.chat(marker).await;
        let mut seen = Vec::new();
        loop {
            let message = self.next().await;
            if message["type"] == "chat" && message["line"]["text"] == marker {
                return seen;
            }
            seen.push(message);
        }
    }

    fn saw(&self, text: &str) -> bool {
        self.log.iter().any(|line| line.contains(text))
    }
}

#[tokio::test]
async fn the_answer_stays_hidden_and_strokes_are_relayed() {
    let (app, addr) = serve().await;
    let code = create(&app).await;
    let mut clients = Vec::new();
    for name in NAMES {
        let mut client = Client::connect(&addr, &code, name).await;
        client.until(|m| m["type"] == "room").await;
        clients.push(client);
    }
    clients[0].until(|m| m["type"] == "room" && m["players"].as_array().unwrap().len() == 4).await;
    clients[0].send(json!({ "type": "options", "options": { "cycles": 1, "drawSecs": 120 } })).await;
    clients[0].until(|m| m["type"] == "room" && m["options"]["drawSecs"] == 120).await;
    clients[0].send(json!({ "type": "start" })).await;

    // 誰畫是隨機的：照 view 裡的座位分出畫的人（d）和三個猜的人（x 先猜中、y 測聊天、z 斷線重連）
    let mut views = Vec::new();
    for client in clients.iter_mut() {
        views.push(client.view().await);
    }
    assert!(views.iter().all(|v| v["stage"] == "choose"));
    let drawer_seat = views[0]["drawer"].as_u64().unwrap();
    let d = views.iter().position(|v| v["you"].as_u64() == Some(drawer_seat)).unwrap();
    let others: Vec<usize> = (0..4).filter(|&i| i != d).collect();
    let (x, y, z) = (others[0], others[1], others[2]);
    let choices: Vec<String> =
        views[d]["choices"].as_array().unwrap().iter().map(|c| c["word"].as_str().unwrap().to_owned()).collect();
    assert_eq!(choices.len(), 3);
    assert!([x, y, z].iter().all(|&i| views[i]["choices"].is_null()));

    clients[d].act(json!({ "type": "choose", "index": 1 })).await;
    let answer = choices[1].clone();
    let view = clients[d].until(|m| m["type"] == "view" && m["view"]["stage"] == "draw").await["view"].clone();
    assert_eq!(view["word"], answer.as_str());
    for i in [x, y, z] {
        let view = clients[i].until(|m| m["type"] == "view" && m["view"]["stage"] == "draw").await["view"].clone();
        assert!(view["word"].is_null());
        assert_eq!(view["hint"]["chars"].as_array().unwrap().len(), answer.chars().count());
    }

    // 筆畫：其他人收到版本連續的事件，畫的人自己不會收到
    clients[d].act(json!({ "type": "begin", "c": 1, "w": 1, "p": [100, 100, 120, 130] })).await;
    clients[d].act(json!({ "type": "more", "p": [140, 160, 180, 200] })).await;
    for i in [x, y, z] {
        let first = clients[i].until(|m| m["type"] == "event").await["event"].clone();
        assert_eq!(first["v"], 1);
        assert_eq!(first["op"]["kind"], "begin");
        let second = clients[i].until(|m| m["type"] == "event").await["event"].clone();
        assert_eq!(second["v"], 2);
        assert_eq!(second["op"]["p"], json!([140, 160, 180, 200]));
    }
    let seen = clients[d].sync("畫好了").await;
    assert!(seen.iter().all(|m| m["type"] != "event"), "畫的人不會收到自己的筆畫");

    // x 猜中：他自己看得到那一句，其他人只看到「猜對了」
    clients[x].chat(&answer).await;
    let mine = clients[x].until(|m| m["type"] == "chat" && m["line"]["text"] == answer.as_str()).await;
    assert_eq!(mine["line"]["private"], true);
    clients[y].until(|m| m["type"] == "chat" && m["line"]["text"].as_str().unwrap().contains("猜對了")).await;
    let view =
        clients[x].until(|m| m["type"] == "view" && m["view"]["seats"][x_seat(&views, x)]["guessed"] == true).await;
    assert_eq!(view["view"]["word"], answer.as_str());

    // 猜中的人說話，還沒猜中的人看不到；畫的人看得到
    clients[x].chat("好像有點難").await;
    clients[d].until(|m| m["type"] == "chat" && m["line"]["text"] == "好像有點難").await;
    clients[y].sync("y 的同步").await;
    assert!(!clients[y].saw("好像有點難"));
    // 畫的人說出答案不會送出
    clients[d].chat(&format!("答案是{answer}")).await;
    clients[d].sync("畫的人的同步").await;
    // y 猜的整句裡有答案也不會公開
    clients[y].chat(&format!("{answer}嗎？")).await;
    clients[y].sync("y 的第二次同步").await;

    // z 斷線重連：從 view 拿回整張畫布，還是看不到答案（y 還沒猜中，這一棒不會因為 z 斷線就結束）
    let old_z = std::mem::replace(&mut clients[z], Client::connect(&addr, &code, NAMES[z]).await);
    assert!(!old_z.saw(&answer));
    drop(old_z);
    let view = clients[z].view().await;
    assert_eq!(view["stage"], "draw");
    assert!(view["word"].is_null());
    assert_eq!(view["canvas"]["v"], 2);
    assert_eq!(view["canvas"]["strokes"][0]["p"], json!([100, 100, 120, 130, 140, 160, 180, 200]));

    // 中途進來的人觀戰：有畫布、沒有答案
    let mut spectator = Client::connect(&addr, &code, "d").await;
    let view = spectator.view().await;
    assert!(view["you"].is_null());
    assert!(view["word"].is_null());
    assert_eq!(view["canvas"]["strokes"].as_array().unwrap().len(), 1);
    spectator.sync("觀戰的同步").await;

    // 公布之前，還沒猜中的人、觀戰的人在任何訊息裡都沒看過答案或候選詞
    for client in [&clients[y], &clients[z], &spectator] {
        assert!(!client.saw(&answer), "答案外流了");
        for word in &choices {
            assert!(!client.saw(word), "候選詞外流了：{word}");
        }
    }

    // y、z 也猜中：大家都猜中了，公布答案
    clients[y].chat(&answer).await;
    clients[z].chat(&answer).await;
    let view = spectator.until(|m| m["type"] == "view" && m["view"]["stage"] == "reveal").await["view"].clone();
    assert_eq!(view["word"], answer.as_str());
    assert_eq!(view["ending"], "all");
}

/// 某個 client 在這局的座位
fn x_seat(views: &[Value], client: usize) -> usize {
    views[client]["you"].as_u64().unwrap() as usize
}

#[tokio::test]
async fn bad_strokes_and_spam_are_limited() {
    let (app, addr) = serve().await;
    let code = create(&app).await;
    let mut a = Client::connect(&addr, &code, "a").await;
    let mut b = Client::connect(&addr, &code, "b").await;
    a.until(|m| m["type"] == "room" && m["players"].as_array().unwrap().len() == 2).await;
    b.until(|m| m["type"] == "room").await;
    a.send(json!({ "type": "start" })).await;
    let va = a.view().await;
    b.view().await;
    let (drawer, guesser) = if va["choices"].is_array() { (&mut a, &mut b) } else { (&mut b, &mut a) };
    drawer.act(json!({ "type": "choose", "index": 0 })).await;
    drawer.until(|m| m["type"] == "view" && m["view"]["stage"] == "draw").await;

    // 超出畫布的點：只告訴畫的人，版本不變
    drawer.act(json!({ "type": "begin", "c": 1, "w": 0, "p": [2000, 10] })).await;
    let notice = drawer.until(|m| m["type"] == "notice").await;
    assert!(notice["message"].as_str().unwrap().contains("超出"));
    drawer.act(json!({ "type": "begin", "c": 1, "w": 0, "p": [10, 10] })).await;
    let event = guesser.until(|m| m["type"] == "event").await;
    assert_eq!(event["event"]["v"], 1);

    // 畫畫的速度（每秒二十幾則）不會被當成洗版
    for i in 0..25 {
        drawer.act(json!({ "type": "more", "p": [i, i] })).await;
    }
    let last = guesser.until(|m| m["type"] == "event" && m["event"]["v"] == 26).await;
    assert_eq!(last["event"]["op"]["kind"], "more");
    tokio::time::sleep(Duration::from_millis(1100)).await;

    // 但真的灌爆還是會斷線
    for i in 0..80 {
        drawer.act(json!({ "type": "more", "p": [i, i] })).await;
    }
    loop {
        match tokio::time::timeout(Duration::from_secs(5), drawer.ws.next()).await.unwrap() {
            Some(Ok(Message::Text(text))) if text.contains("rate_limited") => break,
            Some(Ok(_)) => {}
            other => panic!("expected rate_limited, got {other:?}"),
        }
    }
}
