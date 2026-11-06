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
