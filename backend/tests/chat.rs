//! 聊天室（chat.rs）和 Web Push（webpush.rs）：訊息即時送到每個人、存進資料庫，
//! 以及只推播給「有視窗開著聊天室、但沒在看」的人。推播送到測試裡的假推播服務，解密後檢查內容和 VAPID 簽章。

use std::{path::Path, sync::Arc, time::Duration};

use crate::common::{TestApp, app};
use aws_lc_rs::{
    agreement::{ECDH_P256, PrivateKey},
    signature::{ECDSA_P256_SHA256_FIXED, UnparsedPublicKey},
};
use axum::{
    Router,
    body::Bytes,
    extract::Path as UrlPath,
    http::{HeaderMap, StatusCode},
    routing::post,
};
use backend::{auth::upsert_admin, router, webpush::WebPush};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::{net::TcpStream, sync::mpsc};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async,
    tungstenite::{Message, client::IntoClientRequest},
};

const PASSWORD: &str = "password123";

/// 推播可以送到 http 的假推播服務的 app，以及它的位址
async fn serve() -> (TestApp, String) {
    let mut state = app().await.state;
    state.push = Arc::new(WebPush::default().allow_any_endpoint());
    let app = TestApp { router: router(state.clone(), Path::new("does-not-exist")), state };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    tokio::spawn(axum::serve(listener, app.router.clone()).into_future());
    (app, addr)
}

async fn login(app: &TestApp, name: &str) -> String {
    let body = json!({ "username": name, "password": PASSWORD });
    app.call("POST", "/api/auth/login", None, Some(body)).await.cookie.expect("logs in")
}

/// admin 是管理員，alice、bob 是沒有任何角色的一般帳號
async fn users(app: &TestApp) -> (String, String, String) {
    upsert_admin(&app.state.pool, "admin", PASSWORD.into()).await.unwrap();
    let admin = login(app, "admin").await;
    for name in ["alice", "bob"] {
        let body = json!({ "username": name, "password": PASSWORD, "roles": [] });
        let reply = app.call("POST", "/api/admin/users", Some(&admin), Some(body)).await;
        assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
    }
    let alice = login(app, "alice").await;
    let bob = login(app, "bob").await;
    (admin, alice, bob)
}

struct Client(WebSocketStream<MaybeTlsStream<TcpStream>>);

impl Client {
    async fn connect(addr: &str, cookie: Option<&str>) -> Self {
        Self::connect_from(addr, cookie, None).await
    }

    /// `origin` 是發起連線的網頁（瀏覽器會帶 Origin header）
    async fn connect_from(addr: &str, cookie: Option<&str>, origin: Option<&str>) -> Self {
        let mut request = format!("ws://{addr}/api/chat/ws").into_client_request().unwrap();
        if let Some(cookie) = cookie {
            request.headers_mut().insert("cookie", cookie.parse().unwrap());
        }
        if let Some(origin) = origin {
            request.headers_mut().insert("origin", origin.parse().unwrap());
        }
        Self(connect_async(request).await.unwrap().0)
    }

    /// 連上並讀掉 welcome
    async fn join(addr: &str, cookie: &str) -> (Self, Value) {
        let mut client = Self::connect(addr, Some(cookie)).await;
        let welcome = client.until(|m| m["type"] == "welcome").await;
        (client, welcome)
    }

    /// 連上時要看私人房間 `room`，讀掉 welcome
    async fn join_room(addr: &str, cookie: &str, room: i64) -> (Self, Value) {
        let mut request = format!("ws://{addr}/api/chat/ws?room={room}").into_client_request().unwrap();
        request.headers_mut().insert("cookie", cookie.parse().unwrap());
        let mut client = Self(connect_async(request).await.unwrap().0);
        let welcome = client.until(|m| m["type"] == "welcome").await;
        (client, welcome)
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

    async fn send(&mut self, message: Value) {
        self.0.send(Message::Text(message.to_string().into())).await.unwrap();
    }

    async fn say(&mut self, text: &str, nonce: &str) -> Value {
        self.send(json!({ "type": "send", "text": text, "nonce": nonce })).await;
        self.until(|m| m["type"] == "message" && m["message"]["nonce"] == nonce).await["message"].clone()
    }

    /// 在私人房間 `room` 說話
    async fn say_in(&mut self, room: i64, text: &str, nonce: &str) -> Value {
        self.send(json!({ "type": "send", "room": room, "text": text, "nonce": nonce })).await;
        self.until(|m| m["type"] == "message" && m["message"]["nonce"] == nonce).await["message"].clone()
    }

    /// 下一則訊息（略過 presence 之類的）
    async fn next_message(&mut self) -> Value {
        self.until(|m| m["type"] == "message").await["message"].clone()
    }

    /// 回報視窗狀態，等到 `watcher` 看到在線名單反映出來（伺服器處理完了）
    async fn report(&mut self, watcher: &mut Client, name: &str, active: bool, endpoint: Option<&str>) {
        self.send(json!({ "type": "state", "active": active, "endpoint": endpoint })).await;
        watcher
            .until(|m| {
                m["type"] == "presence"
                    && m["users"].as_array().unwrap().iter().any(|u| u["username"] == name && u["active"] == active)
            })
            .await;
    }
}

fn presence_of(message: &Value) -> Vec<(String, bool)> {
    message["users"]
        .as_array()
        .unwrap()
        .iter()
        .map(|u| (u["username"].as_str().unwrap().to_owned(), u["active"].as_bool().unwrap()))
        .collect()
}

#[tokio::test]
async fn requires_login() {
    let (app, addr) = serve().await;
    let mut guest = Client::connect(&addr, None).await;
    let error = guest.next().await;
    assert_eq!(error["type"], "error");
    assert_eq!(error["code"], "unauthorized");

    assert_eq!(app.get("/api/chat/messages", None).await.status, StatusCode::UNAUTHORIZED);

    // 別的網站的網頁帶著使用者的 cookie 連進來：當作沒登入
    let (_, alice, _) = users(&app).await;
    let mut hijack = Client::connect_from(&addr, Some(&alice), Some("https://evil.example")).await;
    assert_eq!(hijack.next().await["code"], "unauthorized");
    let mut own = Client::connect_from(&addr, Some(&alice), Some(&format!("http://{addr}"))).await;
    assert_eq!(own.next().await["type"], "welcome");
    assert_eq!(app.get("/api/push/key", None).await.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn messages_reach_everyone_and_are_stored() {
    let (app, addr) = serve().await;
    let (_, alice, bob) = users(&app).await;
    let (mut a, welcome) = Client::join(&addr, &alice).await;
    assert_eq!(welcome["messages"], json!([]));
    assert_eq!(welcome["more"], false);
    let (mut b, _) = Client::join(&addr, &bob).await;

    let sent = a.say("  晚餐吃什麼？ \n", "n1").await;
    assert_eq!(sent["text"], "晚餐吃什麼？");
    assert_eq!(sent["username"], "alice");
    let got = b.until(|m| m["type"] == "message").await;
    assert_eq!(got["message"], sent);

    // 斷線後用同一個 nonce 重送：不會多一則，只回給送的人
    a.send(json!({ "type": "send", "text": "晚餐吃什麼？", "nonce": "n1" })).await;
    let again = a.until(|m| m["type"] == "message").await;
    assert_eq!(again["message"]["id"], sent["id"]);
    b.send(json!({ "type": "send", "text": "麵", "nonce": "b1" })).await;
    let next = b.until(|m| m["type"] == "message").await;
    assert_eq!(next["message"]["text"], "麵", "bob 不會收到重送的那則");
    assert_eq!(a.until(|m| m["type"] == "message").await["message"]["text"], "麵");

    let history = app.get("/api/chat/messages", Some(&bob)).await;
    assert_eq!(history.status, StatusCode::OK);
    let texts: Vec<_> = history.body["messages"].as_array().unwrap().iter().map(|m| m["text"].clone()).collect();
    assert_eq!(texts, [json!("晚餐吃什麼？"), json!("麵")]);

    // 空白、太長的不收，連線不會斷
    a.send(json!({ "type": "send", "text": "   ", "nonce": "n2" })).await;
    assert_eq!(a.until(|m| m["type"] == "error").await["code"], "bad_request");
    a.send(json!({ "type": "send", "text": "長".repeat(2001), "nonce": "n3" })).await;
    let error = a.until(|m| m["type"] == "error").await;
    assert_eq!(error["code"], "too_long");
    assert_eq!(error["nonce"], "n3", "用戶端要知道是哪一則沒送出");
    a.say("還在", "n4").await;
}

#[tokio::test]
async fn history_pages_back() {
    let (app, addr) = serve().await;
    let (_, alice, _) = users(&app).await;
    for i in 1..=60 {
        sqlx::query("INSERT INTO chat_messages (user_id, body) SELECT id, ? FROM users WHERE username = 'alice'")
            .bind(format!("第 {i} 則"))
            .execute(&app.state.pool)
            .await
            .unwrap();
    }
    let (_, welcome) = Client::join(&addr, &alice).await;
    let messages = welcome["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 50);
    assert_eq!(messages[0]["text"], "第 11 則");
    assert_eq!(messages[49]["text"], "第 60 則");
    assert_eq!(welcome["more"], true);

    let older = app.get(&format!("/api/chat/messages?before={}", messages[0]["id"]), Some(&alice)).await;
    let older_messages = older.body["messages"].as_array().unwrap();
    assert_eq!(older_messages.len(), 10);
    assert_eq!(older_messages[0]["text"], "第 1 則");
    assert_eq!(older.body["more"], false);
}

#[tokio::test]
async fn only_own_messages_can_be_deleted_unless_admin() {
    let (app, addr) = serve().await;
    let (admin, alice, bob) = users(&app).await;
    let (mut a, _) = Client::join(&addr, &alice).await;
    let (mut b, _) = Client::join(&addr, &bob).await;
    let (mut root, _) = Client::join(&addr, &admin).await;

    let first = a.say("一", "a1").await["id"].clone();
    let second = a.say("二", "a2").await["id"].clone();

    b.send(json!({ "type": "delete", "id": first })).await;
    assert_eq!(b.until(|m| m["type"] == "error").await["code"], "not_found");

    a.send(json!({ "type": "delete", "id": first })).await;
    assert_eq!(a.until(|m| m["type"] == "deleted").await["id"], first);
    assert_eq!(b.until(|m| m["type"] == "deleted").await["id"], first);

    root.send(json!({ "type": "delete", "id": second })).await;
    assert_eq!(a.until(|m| m["type"] == "deleted").await["id"], second);
    assert_eq!(app.get("/api/chat/messages", Some(&alice)).await.body["messages"], json!([]));
}

#[tokio::test]
async fn presence_lists_open_windows() {
    let (app, addr) = serve().await;
    let (_, alice, bob) = users(&app).await;
    let (mut a, _) = Client::join(&addr, &alice).await;
    let (mut b, _) = Client::join(&addr, &bob).await;
    let both = a.until(|m| m["type"] == "presence" && m["users"].as_array().unwrap().len() == 2).await;
    assert_eq!(presence_of(&both), [("alice".into(), true), ("bob".into(), true)]);

    b.report(&mut a, "bob", false, None).await;
    // 同一個人再開一個在看的視窗：算一個人，而且是在看
    let (b2, _) = Client::join(&addr, &bob).await;
    let now = a.until(|m| m["type"] == "presence" && m["users"][1]["active"] == true).await;
    assert_eq!(presence_of(&now), [("alice".into(), true), ("bob".into(), true)]);

    drop(b);
    drop(b2);
    let alone = a.until(|m| m["type"] == "presence" && m["users"].as_array().unwrap().len() == 1).await;
    assert_eq!(presence_of(&alone), [("alice".into(), true)]);
}

// ---- 推播 ----

struct Pushed {
    path: String,
    headers: HeaderMap,
    body: Vec<u8>,
}

/// 假的推播服務：收到的請求都丟進 channel；路徑 /push/gone 回 410（訂閱失效），其他回 201
async fn push_service() -> (String, mpsc::UnboundedReceiver<Pushed>) {
    let (tx, rx) = mpsc::unbounded_channel();
    let service = Router::new().route(
        "/push/{id}",
        post(move |UrlPath(id): UrlPath<String>, headers: HeaderMap, body: Bytes| {
            let tx = tx.clone();
            async move {
                let gone = id == "gone";
                tx.send(Pushed { path: format!("/push/{id}"), headers, body: body.to_vec() }).unwrap();
                if gone { StatusCode::GONE } else { StatusCode::CREATED }
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    tokio::spawn(axum::serve(listener, service).into_future());
    (addr, rx)
}

/// 瀏覽器那一端：自己的金鑰，用來解開推播
struct Browser {
    endpoint: String,
    private: PrivateKey,
    auth: [u8; 16],
}

impl Browser {
    async fn subscribe(app: &TestApp, cookie: &str, endpoint: String) -> Self {
        let private = PrivateKey::generate(&ECDH_P256).unwrap();
        let public = private.compute_public_key().unwrap();
        let auth: [u8; 16] = std::array::from_fn(|i| i as u8 * 3);
        let body = json!({
            "endpoint": endpoint,
            "keys": { "p256dh": URL_SAFE_NO_PAD.encode(public.as_ref()), "auth": URL_SAFE_NO_PAD.encode(auth) },
        });
        let reply = app.call("POST", "/api/push/subscriptions", Some(cookie), Some(body)).await;
        assert_eq!(reply.status, StatusCode::NO_CONTENT, "{}", reply.body);
        Self { endpoint, private, auth }
    }

    fn open(&self, pushed: &Pushed) -> Value {
        let plaintext = backend::webpush::decrypt(&self.private, &self.auth, &pushed.body).expect("decrypts");
        serde_json::from_slice(&plaintext).unwrap()
    }
}

async fn next_push(rx: &mut mpsc::UnboundedReceiver<Pushed>) -> Pushed {
    tokio::time::timeout(Duration::from_secs(5), rx.recv()).await.expect("expected a push").unwrap()
}

async fn no_push(rx: &mut mpsc::UnboundedReceiver<Pushed>) {
    if let Ok(Some(pushed)) = tokio::time::timeout(Duration::from_millis(500), rx.recv()).await {
        panic!("unexpected push to {}", pushed.path);
    }
}

#[tokio::test]
async fn pushes_only_to_open_windows_nobody_is_watching() {
    let (app, addr) = serve().await;
    let (push_addr, mut pushes) = push_service().await;
    let (_, alice, bob) = users(&app).await;
    let bob_browser = Browser::subscribe(&app, &bob, format!("http://{push_addr}/push/bob")).await;
    let (mut a, _) = Client::join(&addr, &alice).await;

    // bob 沒開聊天室：不推
    a.say("有人在嗎", "1").await;
    no_push(&mut pushes).await;

    // bob 開著聊天室但視窗在背景：推到那個瀏覽器
    let (mut b, _) = Client::join(&addr, &bob).await;
    b.report(&mut a, "bob", false, Some(&bob_browser.endpoint)).await;
    let sent = a.say("晚餐吃什麼？", "2").await;
    let pushed = next_push(&mut pushes).await;
    assert_eq!(pushed.path, "/push/bob");
    let payload = bob_browser.open(&pushed);
    assert_eq!(payload["from"], "alice");
    assert_eq!(payload["body"], "晚餐吃什麼？");
    assert_eq!(payload["url"], "/chat");
    assert_eq!(payload["id"], sent["id"]);

    // 推播的 header 和 VAPID 簽章
    assert_eq!(pushed.headers["content-encoding"], "aes128gcm");
    assert_eq!(pushed.headers["ttl"], "300");
    let authorization = pushed.headers["authorization"].to_str().unwrap();
    let (jwt, key) = authorization.strip_prefix("vapid t=").unwrap().split_once(", k=").unwrap();
    assert_eq!(key, app.get("/api/push/key", Some(&bob)).await.body["key"]);
    let (signed, signature) = jwt.rsplit_once('.').unwrap();
    UnparsedPublicKey::new(&ECDSA_P256_SHA256_FIXED, URL_SAFE_NO_PAD.decode(key).unwrap())
        .verify(signed.as_bytes(), &URL_SAFE_NO_PAD.decode(signature).unwrap())
        .expect("VAPID signature verifies");
    let claims: Value =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(signed.split_once('.').unwrap().1).unwrap()).unwrap();
    assert_eq!(claims["aud"], format!("http://{push_addr}"));
    assert_eq!(claims["sub"], "https://ouyang.app");

    // 自己送的不推給自己
    b.say("我自己", "b1").await;
    no_push(&mut pushes).await;

    // bob 回到視窗前：不推
    b.report(&mut a, "bob", true, Some(&bob_browser.endpoint)).await;
    a.say("看到了吧", "3").await;
    no_push(&mut pushes).await;

    // 背景的視窗之外，bob 還有另一個正在看的視窗：也不推
    b.report(&mut a, "bob", false, Some(&bob_browser.endpoint)).await;
    let (b2, _) = Client::join(&addr, &bob).await;
    a.until(|m| m["type"] == "presence" && m["users"][1]["active"] == true).await;
    a.say("兩個視窗", "4").await;
    no_push(&mut pushes).await;
    drop(b2);
    a.until(|m| m["type"] == "presence" && m["users"][1]["active"] == false).await;

    // 背景的視窗沒有開通知（沒有 endpoint）：沒地方推
    b.report(&mut a, "bob", true, None).await;
    b.report(&mut a, "bob", false, None).await;
    a.say("沒開通知", "5").await;
    no_push(&mut pushes).await;

    // 回報別人的 endpoint 也推不過去：只推給這個帳號自己的訂閱
    let alice_browser = Browser::subscribe(&app, &alice, format!("http://{push_addr}/push/alice")).await;
    b.report(&mut a, "bob", true, Some(&alice_browser.endpoint)).await;
    b.report(&mut a, "bob", false, Some(&alice_browser.endpoint)).await;
    a.say("冒用", "6").await;
    no_push(&mut pushes).await;

    // bob 關掉聊天室：不推
    b.report(&mut a, "bob", true, Some(&bob_browser.endpoint)).await;
    b.report(&mut a, "bob", false, Some(&bob_browser.endpoint)).await;
    drop(b);
    a.until(|m| m["type"] == "presence" && m["users"].as_array().unwrap().len() == 1).await;
    a.say("走了嗎", "7").await;
    no_push(&mut pushes).await;
}

#[tokio::test]
async fn gone_subscriptions_are_removed() {
    let (app, addr) = serve().await;
    let (push_addr, mut pushes) = push_service().await;
    let (_, alice, bob) = users(&app).await;
    let browser = Browser::subscribe(&app, &bob, format!("http://{push_addr}/push/gone")).await;
    let (mut a, _) = Client::join(&addr, &alice).await;
    let (mut b, _) = Client::join(&addr, &bob).await;
    b.report(&mut a, "bob", false, Some(&browser.endpoint)).await;

    a.say("哈囉", "1").await;
    next_push(&mut pushes).await;
    for _ in 0..50 {
        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM push_subscriptions").fetch_one(&app.state.pool).await.unwrap();
        if count == 0 {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("410 的訂閱應該被刪掉");
}

#[tokio::test]
async fn test_notification_goes_to_this_browser() {
    let (app, _) = serve().await;
    let (push_addr, mut pushes) = push_service().await;
    let (_, alice, bob) = users(&app).await;
    let browser = Browser::subscribe(&app, &bob, format!("http://{push_addr}/push/bob")).await;

    let body = json!({ "endpoint": browser.endpoint });
    let reply = app.call("POST", "/api/push/test", Some(&bob), Some(body.clone())).await;
    assert_eq!(reply.status, StatusCode::NO_CONTENT, "{}", reply.body);
    assert_eq!(browser.open(&next_push(&mut pushes).await)["tag"], "push-test");

    // 別人的 endpoint 不行
    assert_eq!(
        app.call("POST", "/api/push/test", Some(&alice), Some(body.clone())).await.status,
        StatusCode::NOT_FOUND
    );
    // 別人也取消不了 bob 的訂閱
    app.call("DELETE", "/api/push/subscriptions", Some(&alice), Some(body.clone())).await;
    assert_eq!(app.call("POST", "/api/push/test", Some(&bob), Some(body.clone())).await.status, StatusCode::NO_CONTENT);
    next_push(&mut pushes).await;

    let reply = app.call("DELETE", "/api/push/subscriptions", Some(&bob), Some(body.clone())).await;
    assert_eq!(reply.status, StatusCode::NO_CONTENT);
    assert_eq!(app.call("POST", "/api/push/test", Some(&bob), Some(body)).await.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn subscriptions_must_point_at_a_push_service() {
    // 一般的 app：只接受瀏覽器推播服務的網址
    let app = app().await;
    let (_, alice, bob) = users(&app).await;
    let private = PrivateKey::generate(&ECDH_P256).unwrap();
    let p256dh = URL_SAFE_NO_PAD.encode(private.compute_public_key().unwrap().as_ref());
    let auth = URL_SAFE_NO_PAD.encode([1u8; 16]);
    let subscribe = |endpoint: &str, p256dh: &str, auth: &str| {
        Some(json!({ "endpoint": endpoint, "keys": { "p256dh": p256dh, "auth": auth } }))
    };
    let fcm = "https://fcm.googleapis.com/fcm/send/abc";

    for (endpoint, key, secret) in [
        ("http://127.0.0.1:9/push", p256dh.as_str(), auth.as_str()),
        ("https://169.254.169.254/latest", &p256dh, &auth),
        ("https://example.com/push", &p256dh, &auth),
        (fcm, "AAAA", &auth),
        (fcm, &p256dh, "AAAA"),
    ] {
        let reply = app.call("POST", "/api/push/subscriptions", Some(&alice), subscribe(endpoint, key, secret)).await;
        assert_eq!(reply.status, StatusCode::BAD_REQUEST, "{endpoint}");
    }
    let reply = app.call("POST", "/api/push/subscriptions", None, subscribe(fcm, &p256dh, &auth)).await;
    assert_eq!(reply.status, StatusCode::UNAUTHORIZED);

    let reply = app.call("POST", "/api/push/subscriptions", Some(&alice), subscribe(fcm, &p256dh, &auth)).await;
    assert_eq!(reply.status, StatusCode::NO_CONTENT);
    // 同一個瀏覽器換 bob 登入：訂閱跟著換人
    let reply = app.call("POST", "/api/push/subscriptions", Some(&bob), subscribe(fcm, &p256dh, &auth)).await;
    assert_eq!(reply.status, StatusCode::NO_CONTENT);
    let owner: String = sqlx::query_scalar(
        "SELECT u.username FROM push_subscriptions s JOIN users u ON u.id = s.user_id WHERE s.endpoint = ?",
    )
    .bind(fcm)
    .fetch_one(&app.state.pool)
    .await
    .unwrap();
    assert_eq!(owner, "bob");

    // 公鑰是固定的一把 P-256（未壓縮 65 bytes）
    let key = app.get("/api/push/key", Some(&alice)).await.body["key"].clone();
    assert_eq!(URL_SAFE_NO_PAD.decode(key.as_str().unwrap()).unwrap().len(), 65);
    assert_eq!(app.get("/api/push/key", Some(&bob)).await.body["key"], key);
}

// ---- 私人房間 ----

async fn create_room(app: &TestApp, cookie: &str, name: &str) -> Value {
    let reply = app.call("POST", "/api/chat/rooms", Some(cookie), Some(json!({ "name": name }))).await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
    reply.body
}

async fn join_room(app: &TestApp, cookie: &str, code: &str) -> crate::common::Reply {
    app.call("POST", "/api/chat/rooms/join", Some(cookie), Some(json!({ "code": code }))).await
}

async fn rooms(app: &TestApp, cookie: &str) -> Vec<Value> {
    let reply = app.get("/api/chat/rooms", Some(cookie)).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    reply.body["rooms"].as_array().unwrap().clone()
}

fn member_names(room: &Value) -> Vec<String> {
    room["members"].as_array().unwrap().iter().map(|m| m["username"].as_str().unwrap().to_owned()).collect()
}

fn texts(messages: &Value) -> Vec<String> {
    messages.as_array().unwrap().iter().map(|m| m["text"].as_str().unwrap().to_owned()).collect()
}

#[tokio::test]
async fn private_rooms_are_invisible_to_everyone_else() {
    let (app, addr) = serve().await;
    let (admin, alice, bob) = users(&app).await;
    let room = create_room(&app, &alice, "  小  團體 ").await;
    assert_eq!(room["name"], "小 團體");
    assert_eq!(member_names(&room), ["alice"]);
    let id = room["id"].as_i64().unwrap();
    let code = room["code"].as_str().unwrap().to_owned();
    assert_eq!(code.len(), 8);
    assert!(code.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit()), "{code}");

    // 不在房間裡的人（管理員也一樣）：列表沒有、讀不到、動不了，跟不存在一樣是 404
    for cookie in [&bob, &admin] {
        assert_eq!(rooms(&app, cookie).await, Vec::<Value>::new());
        let history = app.get(&format!("/api/chat/messages?room={id}"), Some(cookie)).await;
        assert_eq!(history.status, StatusCode::NOT_FOUND);
        let body = Some(json!({ "name": "x" }));
        let rename = app.call("PATCH", &format!("/api/chat/rooms/{id}"), Some(cookie), body).await;
        assert_eq!(rename.status, StatusCode::NOT_FOUND);
        let delete = app.call("DELETE", &format!("/api/chat/rooms/{id}"), Some(cookie), None).await;
        assert_eq!(delete.status, StatusCode::NOT_FOUND);
    }

    let (mut a, _) = Client::join(&addr, &alice).await;
    let (mut b, _) = Client::join(&addr, &bob).await;
    let (mut root, _) = Client::join(&addr, &admin).await;

    let secret = a.say_in(id, "秘密", "s1").await;
    assert_eq!(secret["room"], id);
    // 接著在大廳說的話大家都收得到；bob、admin 收到的第一則就是這則，表示房間裡那則沒有送給他們
    a.say("大家好", "p1").await;
    for client in [&mut b, &mut root] {
        let got = client.next_message().await;
        assert_eq!(got["text"], "大家好");
        assert_eq!(got["room"], Value::Null);
    }
    // 大廳的歷史裡也沒有房間的訊息
    assert_eq!(texts(&app.get("/api/chat/messages", Some(&bob)).await.body["messages"]), ["大家好"]);

    // 送進房間、打開房間、刪房間的訊息：都當作沒有這間
    b.send(json!({ "type": "send", "room": id, "text": "偷看", "nonce": "b1" })).await;
    let error = b.until(|m| m["type"] == "error").await;
    assert_eq!(error["code"], "room_not_found");
    assert_eq!(error["nonce"], "b1");
    b.send(json!({ "type": "open", "room": id })).await;
    let error = b.until(|m| m["type"] == "error").await;
    assert_eq!(error["code"], "room_not_found");
    assert_eq!(error["room"], id);
    root.send(json!({ "type": "delete", "id": secret["id"] })).await;
    assert_eq!(root.until(|m| m["type"] == "error").await["code"], "not_found", "管理員也刪不到看不到的房間");
    // 帶著房間連線：換成大廳
    let (_, welcome) = Client::join_room(&addr, &bob, id).await;
    assert_eq!(welcome["room"], Value::Null);
    assert_eq!(texts(&welcome["messages"]), ["大家好"]);

    // 用代碼加入：大小寫、空白、- 都不管
    let typed = format!(" {}-{} ", code[..4].to_lowercase(), &code[4..]);
    let joined = join_room(&app, &bob, &typed).await;
    assert_eq!(joined.status, StatusCode::OK, "{}", joined.body);
    assert_eq!(joined.body["id"], id);
    assert_eq!(member_names(&joined.body), ["alice", "bob"]);
    assert_eq!(joined.body["unread"], 0, "加入前的訊息不算未讀");
    a.until(|m| m["type"] == "rooms").await;
    b.until(|m| m["type"] == "rooms").await;
    // 再輸入一次一樣的代碼：還是成員，不會重複
    assert_eq!(member_names(&join_room(&app, &bob, &code).await.body), ["alice", "bob"]);

    // 加入後看得到之前的訊息
    let history = app.get(&format!("/api/chat/messages?room={id}"), Some(&bob)).await;
    assert_eq!(texts(&history.body["messages"]), ["秘密"]);
    let (_, welcome) = Client::join_room(&addr, &bob, id).await;
    assert_eq!(welcome["room"], id);
    assert_eq!(texts(&welcome["messages"]), ["秘密"]);
    b.send(json!({ "type": "open", "room": id })).await;
    let history = b.until(|m| m["type"] == "history").await;
    assert_eq!(history["room"], id);
    assert_eq!(texts(&history["messages"]), ["秘密"]);

    // bob 在房間說話：alice 收到，admin 還是收不到
    b.say_in(id, "我來了", "b2").await;
    assert_eq!(a.next_message().await["text"], "我來了");
    a.say("大廳還在", "p2").await;
    assert_eq!(root.next_message().await["text"], "大廳還在");
}

#[tokio::test]
async fn wrong_codes_are_limited() {
    let (app, _) = serve().await;
    let (admin, alice, bob) = users(&app).await;
    let code = create_room(&app, &alice, "房間").await["code"].as_str().unwrap().to_owned();
    for wrong in ["", "ABC", "XXXXXXXX", "XXXXXXXXX"] {
        let reply = join_room(&app, &bob, wrong).await;
        assert_eq!(reply.status, StatusCode::BAD_REQUEST, "{wrong}");
    }
    for _ in 0..6 {
        assert_eq!(join_room(&app, &bob, "YYYYYYYY").await.status, StatusCode::BAD_REQUEST);
    }
    // 錯了 10 次：連對的代碼也要等一下
    assert_eq!(join_room(&app, &bob, &code).await.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(rooms(&app, &bob).await, Vec::<Value>::new());
    // 別人不受影響
    assert_eq!(join_room(&app, &admin, &code).await.status, StatusCode::OK);
}

#[tokio::test]
async fn owner_manages_the_room() {
    let (app, addr) = serve().await;
    let (admin, alice, bob) = users(&app).await;
    let room = create_room(&app, &alice, "讀書會").await;
    let id = room["id"].as_i64().unwrap();
    let old_code = room["code"].as_str().unwrap().to_owned();
    join_room(&app, &bob, &old_code).await;
    let joined = join_room(&app, &admin, &old_code).await.body;
    assert_eq!(member_names(&joined), ["alice", "bob", "admin"]);
    let id_of = |name: &str| {
        joined["members"].as_array().unwrap().iter().find(|m| m["username"] == name).unwrap()["id"].clone()
    };
    let (alice_id, bob_id, admin_id) = (id_of("alice"), id_of("bob"), id_of("admin"));
    assert_eq!(joined["owner_id"], alice_id);

    let (mut a, _) = Client::join(&addr, &alice).await;
    let (mut b, _) = Client::join(&addr, &bob).await;

    // 不是房主：不能改名、換代碼、刪房間、移出別人
    let room_url = format!("/api/chat/rooms/{id}");
    for (method, path, body) in [
        ("PATCH", room_url.clone(), Some(json!({ "name": "改掉" }))),
        ("POST", format!("{room_url}/code"), None),
        ("DELETE", room_url.clone(), None),
        ("DELETE", format!("{room_url}/members/{admin_id}"), None),
    ] {
        assert_eq!(app.call(method, &path, Some(&bob), body).await.status, StatusCode::FORBIDDEN, "{method} {path}");
    }

    // 房主可以刪別人的訊息，一般成員不行
    let from_bob = b.say_in(id, "bob 的話", "b1").await;
    let from_alice = a.say_in(id, "alice 的話", "a1").await;
    b.send(json!({ "type": "delete", "id": from_alice["id"] })).await;
    assert_eq!(b.until(|m| m["type"] == "error").await["code"], "not_found");
    a.send(json!({ "type": "delete", "id": from_bob["id"] })).await;
    let deleted = b.until(|m| m["type"] == "deleted").await;
    assert_eq!(deleted["id"], from_bob["id"]);
    assert_eq!(deleted["room"], id);

    // 改名：大家都收到 rooms
    let renamed = app.call("PATCH", &room_url, Some(&alice), Some(json!({ "name": "讀書會 2" }))).await;
    assert_eq!(renamed.body["name"], "讀書會 2");
    b.until(|m| m["type"] == "rooms").await;

    // 移出 bob：bob 收到 rooms、列表裡沒有了、代碼換了，舊代碼進不來、也送不進去
    let kicked = app.call("DELETE", &format!("{room_url}/members/{bob_id}"), Some(&alice), None).await;
    assert_eq!(kicked.status, StatusCode::NO_CONTENT);
    b.until(|m| m["type"] == "rooms").await;
    assert_eq!(rooms(&app, &bob).await, Vec::<Value>::new());
    let after = rooms(&app, &alice).await;
    assert_eq!(member_names(&after[0]), ["alice", "admin"]);
    assert_ne!(after[0]["code"], old_code);
    assert_eq!(join_room(&app, &bob, &old_code).await.status, StatusCode::BAD_REQUEST);
    b.send(json!({ "type": "send", "room": id, "text": "還在嗎", "nonce": "b2" })).await;
    assert_eq!(b.until(|m| m["type"] == "error").await["code"], "room_not_found");
    // 房間裡的新訊息 bob 收不到
    a.say_in(id, "bob 走了", "a2").await;
    a.say("大廳", "a3").await;
    assert_eq!(b.next_message().await["text"], "大廳");

    // 房主換代碼
    let fresh = app.call("POST", &format!("{room_url}/code"), Some(&alice), None).await.body;
    assert_ne!(fresh["code"], after[0]["code"]);

    // 房主離開：交給最早加入的 admin
    let left = app.call("DELETE", &format!("{room_url}/members/{alice_id}"), Some(&alice), None).await;
    assert_eq!(left.status, StatusCode::NO_CONTENT);
    assert_eq!(rooms(&app, &alice).await, Vec::<Value>::new());
    let rest = rooms(&app, &admin).await;
    assert_eq!(rest[0]["owner_id"], admin_id);
    assert_eq!(member_names(&rest[0]), ["admin"]);

    // 最後一個人離開：房間和訊息一起刪掉
    let left = app.call("DELETE", &format!("{room_url}/members/{admin_id}"), Some(&admin), None).await;
    assert_eq!(left.status, StatusCode::NO_CONTENT);
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM chat_messages WHERE room_id IS NOT NULL")
        .fetch_one(&app.state.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM chat_rooms").fetch_one(&app.state.pool).await.unwrap();
    assert_eq!(count, 0);

    // 房主直接刪房間
    let other = create_room(&app, &alice, "另一間").await;
    join_room(&app, &bob, other["code"].as_str().unwrap()).await;
    let reply = app.call("DELETE", &format!("/api/chat/rooms/{}", other["id"]), Some(&alice), None).await;
    assert_eq!(reply.status, StatusCode::NO_CONTENT);
    assert_eq!(rooms(&app, &bob).await, Vec::<Value>::new());
}

#[tokio::test]
async fn unread_counts_follow_what_was_read() {
    let (app, addr) = serve().await;
    let (_, alice, bob) = users(&app).await;
    let room = create_room(&app, &alice, "房間").await;
    let id = room["id"].as_i64().unwrap();
    join_room(&app, &bob, room["code"].as_str().unwrap()).await;
    let (mut a, _) = Client::join(&addr, &alice).await;
    let (mut b, _) = Client::join(&addr, &bob).await;

    a.say_in(id, "一", "1").await;
    let second = a.say_in(id, "二", "2").await;
    a.say_in(id, "三", "3").await;
    assert_eq!(rooms(&app, &bob).await[0]["unread"], 3);
    assert_eq!(rooms(&app, &alice).await[0]["unread"], 0, "自己的訊息不算");

    b.send(json!({ "type": "read", "room": id, "id": second["id"] })).await;
    // 同一條連線依序處理：拿到 history 時 read 已經處理完了
    b.send(json!({ "type": "open", "room": id })).await;
    b.until(|m| m["type"] == "history").await;
    assert_eq!(rooms(&app, &bob).await[0]["unread"], 1);
    // 往回報不會讓未讀變多
    b.send(json!({ "type": "read", "room": id, "id": 0 })).await;
    b.send(json!({ "type": "open", "room": id })).await;
    b.until(|m| m["type"] == "history").await;
    assert_eq!(rooms(&app, &bob).await[0]["unread"], 1);
}

#[tokio::test]
async fn private_room_pushes_only_reach_members() {
    let (app, addr) = serve().await;
    let (push_addr, mut pushes) = push_service().await;
    let (admin, alice, bob) = users(&app).await;
    let room = create_room(&app, &alice, "小團體").await;
    let id = room["id"].as_i64().unwrap();
    join_room(&app, &bob, room["code"].as_str().unwrap()).await;

    let bob_browser = Browser::subscribe(&app, &bob, format!("http://{push_addr}/push/bob")).await;
    let admin_browser = Browser::subscribe(&app, &admin, format!("http://{push_addr}/push/admin")).await;
    let (mut a, _) = Client::join(&addr, &alice).await;
    let (mut b, _) = Client::join(&addr, &bob).await;
    let (mut root, _) = Client::join(&addr, &admin).await;
    b.report(&mut a, "bob", false, Some(&bob_browser.endpoint)).await;
    root.report(&mut a, "admin", false, Some(&admin_browser.endpoint)).await;

    let sent = a.say_in(id, "今晚見", "1").await;
    let pushed = next_push(&mut pushes).await;
    assert_eq!(pushed.path, "/push/bob");
    let payload = bob_browser.open(&pushed);
    assert_eq!(payload["title"], "🔒 小團體");
    assert_eq!(payload["body"], "今晚見");
    assert_eq!(payload["tag"], format!("chat-room-{id}"));
    assert_eq!(payload["url"], format!("/chat?room={id}"));
    assert_eq!(payload["id"], sent["id"]);
    no_push(&mut pushes).await;

    // 大廳的照樣推給兩個人
    a.say("大廳", "2").await;
    let mut paths = vec![next_push(&mut pushes).await.path, next_push(&mut pushes).await.path];
    paths.sort();
    assert_eq!(paths, ["/push/admin", "/push/bob"]);
}
