//! 聊天室：登入的人共用的大廳，加上知道代碼才進得來的私人房間（房間的管理在 chat_rooms.rs）。
//! 訊息存在 chat_messages（`room_id` 是 NULL 的是大廳），即時的部分走 WebSocket。
//!
//! ```text
//! GET /api/chat/ws?room=<id>                     升級成 WebSocket（要登入）；room 是一開始要看的房間，不帶是大廳
//! GET /api/chat/messages?room=<id>&before=<id>   更早的訊息 {room, messages:[…], more}，舊的在前
//!
//! client → server  {type:"send", room, text, nonce}    nonce 是用戶端替這則產生的編號，重送同一個不會變兩則；room 不帶是大廳
//!                  {type:"open", room}                  換到另一間：回 history
//!                  {type:"read", room, id}              私人房間看到哪一則了（未讀數用）
//!                  {type:"state", active, endpoint}     這個視窗有沒有人在看，以及這個瀏覽器的推播 endpoint（沒開通知是 null）
//!                  {type:"delete", id}                  刪掉自己的訊息（管理員、私人房間的房主可以刪任何人的）
//! server → client  {type:"welcome", you, room, messages, more}   room 的最近 50 則；要看的房間不在了（被移出、刪掉）就換成大廳
//!                  {type:"history", room, messages, more}        回應 open
//!                  {type:"message", message:{id, room, user_id, username, text, nonce, created_at}}
//!                  {type:"deleted", id, room}
//!                  {type:"presence", users:[{id, username, active}]}   誰開著聊天室、有沒有在看
//!                  {type:"rooms"}                                私人房間的列表變了（有人加入、離開、改名…），重新讀 GET /api/chat/rooms
//!                  {type:"error", code, message}   too_long、rate_limited、bad_request、not_found、room_not_found（帶 room）；
//!                                                  unauthorized（登出或被停用）之後會關閉連線
//! ```
//!
//! **誰收得到**（[`Audience`]）：大廳的訊息送給每一條連線；私人房間的只送給成員的連線，每則都從資料庫重新讀成員，
//! 被移出的人馬上就收不到。一條連線會收到自己所有房間的訊息（不只正在看的那間），用戶端拿來算其他房間的未讀數。
//!
//! **推播**：有新訊息時，只推給「看得到這則、有視窗開著聊天室、但沒在看」的人（視窗在背景、縮小、切到別的程式），
//! 而且只推到開著聊天室的那幾個瀏覽器（連線時回報的 endpoint）。正在看的人不用推；
//! 完全沒開聊天室的人也不推。判斷在 [`Chat::push_targets`]。
//!
//! 連線只記在記憶體，每個容器各自算。換版的幾秒內新舊容器各有一部分連線，
//! 這段時間在另一邊送出的訊息要等重連（拿最近 50 則）才看得到，也不會推播。

use std::{
    collections::{BTreeMap, HashMap},
    sync::{
        Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use axum::{
    Json,
    extract::{
        Query, State,
        ws::{Message, Utf8Bytes, WebSocket, WebSocketUpgrade},
    },
    http::{HeaderMap, header},
    response::Response,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::SqlitePool;
use tokio::{sync::mpsc, time::Instant};

use crate::{
    AppError, AppState,
    auth::{AdminUsers, CurrentUser, Permission},
    chat_rooms, webpush,
};

const HISTORY: i64 = 50;
pub const MAX_TEXT_CHARS: usize = 2000;
const MAX_FRAME_BYTES: usize = 16 * 1024;
const MAX_NONCE_LEN: usize = 64;
const MAX_ENDPOINT_LEN: usize = 2048;
const PING_INTERVAL: Duration = Duration::from_secs(25);
const IDLE_TIMEOUT: Duration = Duration::from_secs(60);
/// 每條連線每秒最多幾個 frame，超過就斷線
const MAX_FRAMES_PER_SEC: u32 = 20;
/// 每條連線 10 秒內最多送幾則訊息，超過的不收
const SEND_WINDOW: Duration = Duration::from_secs(10);
const MAX_SENDS: u32 = 15;
/// 通知裡最多顯示幾個字
const PREVIEW_CHARS: usize = 200;
/// 每個人 10 分鐘內最多輸入錯幾次房間代碼，超過就要等（代碼有 32^8 種，本來就猜不到，這是再多一層）
const CODE_WINDOW: Duration = Duration::from_secs(10 * 60);
const MAX_CODE_FAILURES: u32 = 10;

type Reject = (&'static str, &'static str);

#[derive(Default)]
pub struct Chat {
    conns: Mutex<HashMap<u64, Conn>>,
    next_id: AtomicU64,
    /// 每個人輸入錯房間代碼的次數（時間窗開始的時間、次數）
    code_failures: Mutex<HashMap<i64, (Instant, u32)>>,
}

struct Conn {
    user_id: i64,
    username: String,
    tx: mpsc::UnboundedSender<Utf8Bytes>,
    /// 視窗看得到而且在前景。剛連上時當作在看（通常是剛打開），用戶端會馬上回報實際狀態
    active: bool,
    endpoint: Option<String>,
}

/// 一則訊息要送給誰：大廳是每一條連線，私人房間只有成員的連線
pub(crate) enum Audience {
    Everyone,
    Members(Vec<i64>),
}

impl Audience {
    fn includes(&self, user_id: i64) -> bool {
        match self {
            Self::Everyone => true,
            Self::Members(members) => members.contains(&user_id),
        }
    }
}

impl Chat {
    fn join(&self, user: &CurrentUser, tx: mpsc::UnboundedSender<Utf8Bytes>) -> u64 {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let conn = Conn { user_id: user.id, username: user.username.clone(), tx, active: true, endpoint: None };
        self.conns.lock().unwrap().insert(id, conn);
        self.broadcast_presence();
        id
    }

    fn leave(&self, id: u64) {
        self.conns.lock().unwrap().remove(&id);
        self.broadcast_presence();
    }

    fn set_state(&self, id: u64, active: bool, endpoint: Option<String>) {
        let changed = {
            let mut conns = self.conns.lock().unwrap();
            let Some(conn) = conns.get_mut(&id) else { return };
            conn.endpoint = endpoint;
            std::mem::replace(&mut conn.active, active) != active
        };
        if changed {
            self.broadcast_presence();
        }
    }

    fn deliver(&self, audience: &Audience, value: &Value) {
        let text = Utf8Bytes::from(value.to_string());
        for conn in self.conns.lock().unwrap().values().filter(|conn| audience.includes(conn.user_id)) {
            let _ = conn.tx.send(text.clone());
        }
    }

    fn send_to(&self, id: u64, value: &Value) {
        if let Some(conn) = self.conns.lock().unwrap().get(&id) {
            let _ = conn.tx.send(Utf8Bytes::from(value.to_string()));
        }
    }

    /// 告訴這些人的每個視窗：私人房間的列表變了，重新讀一次
    pub(crate) fn rooms_changed(&self, users: &[i64]) {
        self.deliver(&Audience::Members(users.to_vec()), &json!({ "type": "rooms" }));
    }

    /// 開著聊天室的人（同一個人開好幾個視窗只算一次，任一個在看就是在看）
    fn presence(&self) -> Value {
        let mut users: BTreeMap<String, (i64, bool)> = BTreeMap::new();
        for conn in self.conns.lock().unwrap().values() {
            let entry = users.entry(conn.username.clone()).or_insert((conn.user_id, false));
            entry.1 |= conn.active;
        }
        let users: Vec<Value> = users
            .into_iter()
            .map(|(username, (id, active))| json!({ "id": id, "username": username, "active": active }))
            .collect();
        json!({ "type": "presence", "users": users })
    }

    fn broadcast_presence(&self) {
        self.deliver(&Audience::Everyone, &self.presence());
    }

    /// 要推播給誰、推到哪幾個瀏覽器：看得到這則、有視窗開著聊天室、但每個視窗都沒在看的人，
    /// 推到那些視窗所在的瀏覽器。送出的人自己不推。
    fn push_targets(&self, sender: i64, audience: &Audience) -> Vec<(i64, Vec<String>)> {
        let mut users: HashMap<i64, (bool, Vec<String>)> = HashMap::new();
        let conns = self.conns.lock().unwrap();
        for conn in conns.values().filter(|conn| conn.user_id != sender && audience.includes(conn.user_id)) {
            let entry = users.entry(conn.user_id).or_default();
            entry.0 |= conn.active;
            if let Some(endpoint) = &conn.endpoint
                && !entry.1.contains(endpoint)
            {
                entry.1.push(endpoint.clone());
            }
        }
        users
            .into_iter()
            .filter(|(_, (active, endpoints))| !active && !endpoints.is_empty())
            .map(|(user_id, (_, endpoints))| (user_id, endpoints))
            .collect()
    }

    /// 這個人還可以試房間代碼嗎（10 分鐘內錯太多次就不行，連對的也先不收）
    pub(crate) fn may_try_code(&self, user_id: i64) -> bool {
        let failures = self.code_failures.lock().unwrap();
        !failures
            .get(&user_id)
            .is_some_and(|(start, count)| start.elapsed() < CODE_WINDOW && *count >= MAX_CODE_FAILURES)
    }

    pub(crate) fn code_failed(&self, user_id: i64) {
        let mut failures = self.code_failures.lock().unwrap();
        failures.retain(|_, (start, _)| start.elapsed() < CODE_WINDOW);
        failures.entry(user_id).or_insert((Instant::now(), 0)).1 += 1;
    }
}

#[derive(Serialize, sqlx::FromRow)]
pub struct ChatMessage {
    id: i64,
    room: Option<i64>,
    user_id: i64,
    username: String,
    text: String,
    nonce: Option<String>,
    created_at: String,
}

/// 讀訊息的 SELECT，後面接條件（sqlx 只收編譯時就固定的 SQL）
macro_rules! select_messages {
    ($rest:literal) => {
        concat!(
            "SELECT m.id, m.room_id AS room, m.user_id, u.username, m.body AS text, m.nonce, m.created_at
             FROM chat_messages m JOIN users u ON u.id = m.user_id ",
            $rest
        )
    };
}

/// 一間房間 `before` 之前（不含）最近的 50 則，舊的在前；more 是更早還有沒有
async fn page(
    pool: &SqlitePool,
    room: Option<i64>,
    before: Option<i64>,
) -> Result<(Vec<ChatMessage>, bool), sqlx::Error> {
    let mut messages = sqlx::query_as::<_, ChatMessage>(select_messages!(
        "WHERE m.room_id IS ? AND m.id < ? ORDER BY m.id DESC LIMIT ?"
    ))
    .bind(room)
    .bind(before.unwrap_or(i64::MAX))
    .bind(HISTORY + 1)
    .fetch_all(pool)
    .await?;
    let more = messages.len() as i64 > HISTORY;
    messages.truncate(HISTORY as usize);
    messages.reverse();
    Ok((messages, more))
}

/// `user` 看得到這間嗎：大廳一定看得到，私人房間要是成員（不是成員就跟沒有這間一樣，不透露房間在不在）
async fn can_see(pool: &SqlitePool, user_id: i64, room: Option<i64>) -> Result<bool, sqlx::Error> {
    match room {
        None => Ok(true),
        Some(room) => chat_rooms::is_member(pool, room, user_id).await,
    }
}

#[derive(Deserialize)]
pub struct HistoryQuery {
    room: Option<i64>,
    before: Option<i64>,
}

pub async fn history(
    State(state): State<AppState>,
    user: CurrentUser,
    Query(query): Query<HistoryQuery>,
) -> Result<Json<Value>, AppError> {
    if !can_see(&state.pool, user.id, query.room).await? {
        return Err(AppError::NotFound);
    }
    let (messages, more) = page(&state.pool, query.room, query.before).await?;
    Ok(Json(json!({ "room": query.room, "messages": messages, "more": more })))
}

#[derive(Deserialize)]
pub struct ConnectQuery {
    room: Option<i64>,
}

/// 一律先升級再用 `{type:"error"}` 回報問題：瀏覽器的 WebSocket 讀不到升級失敗時的 HTTP 狀態。
pub async fn connect(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    headers: HeaderMap,
    user: Option<CurrentUser>,
    Query(query): Query<ConnectQuery>,
) -> Response {
    let user = user.filter(|_| same_origin(&headers));
    ws.max_message_size(MAX_FRAME_BYTES).on_upgrade(move |socket| session(socket, state, user, query.room))
}

/// WebSocket 不受同源政策限制，別的網站的網頁也連得進來，瀏覽器還會帶上 cookie。
/// 有 Origin（瀏覽器一定會帶）就必須是本站，不然當作沒登入。
fn same_origin(headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get(header::ORIGIN) else { return true };
    let origin_host = origin.to_str().ok().and_then(|o| o.split_once("://")).map(|(_, host)| host);
    let host = headers.get(header::HOST).and_then(|h| h.to_str().ok());
    matches!((origin_host, host), (Some(o), Some(h)) if o.eq_ignore_ascii_case(h))
}

async fn session(mut socket: WebSocket, state: AppState, user: Option<CurrentUser>, room: Option<i64>) {
    let Some(user) = user else { return close_with(socket, ("unauthorized", "請先登入")).await };
    let (tx, mut rx) = mpsc::unbounded_channel();
    // 先加入再讀歷史：中間送出的訊息會同時出現在歷史和佇列裡，用戶端依 id 去掉重複的
    let id = state.chat.join(&user, tx);
    let welcome = async {
        // 要看的房間已經不在了（被移出、房間被刪掉）：改看大廳，用戶端看 welcome 的 room 就知道
        let room = if can_see(&state.pool, user.id, room).await? { room } else { None };
        let (messages, more) = page(&state.pool, room, None).await?;
        Ok::<_, sqlx::Error>(
            json!({ "type": "welcome", "you": user.id, "room": room, "messages": messages, "more": more }),
        )
    };
    let welcome = match welcome.await {
        Ok(welcome) => welcome,
        Err(err) => {
            tracing::error!(error = %err, "load chat history");
            state.chat.leave(id);
            return close_with(socket, ("internal", "讀取訊息失敗")).await;
        }
    };

    let error = if socket.send(Message::Text(welcome.to_string().into())).await.is_err() {
        None
    } else {
        run(&mut socket, &state, &user, id, &mut rx).await
    };
    state.chat.leave(id);
    match error {
        Some(reject) => close_with(socket, reject).await,
        None => {
            let _ = socket.send(Message::Close(None)).await;
        }
    }
}

/// 連線的主迴圈；回傳要告訴用戶端的錯誤（正常斷線是 None）
async fn run(
    socket: &mut WebSocket,
    state: &AppState,
    user: &CurrentUser,
    id: u64,
    rx: &mut mpsc::UnboundedReceiver<Utf8Bytes>,
) -> Option<Reject> {
    let mut ping = tokio::time::interval_at(Instant::now() + PING_INTERVAL, PING_INTERVAL);
    let mut last_seen = Instant::now();
    let mut frames = (Instant::now(), 0);
    let mut sends = (Instant::now(), 0);
    loop {
        tokio::select! {
            outgoing = rx.recv() => {
                let text = outgoing?;
                if socket.send(Message::Text(text)).await.is_err() {
                    return None;
                }
            }
            incoming = socket.recv() => {
                let Some(Ok(message)) = incoming else { return None };
                last_seen = Instant::now();
                let Message::Text(text) = message else { continue };
                if !within(&mut frames, Duration::from_secs(1), MAX_FRAMES_PER_SEC) {
                    return Some(("rate_limited", "訊息送得太快了"));
                }
                if let Err(error) = handle(state, user, id, &text, &mut sends).await {
                    state.chat.send_to(id, &error);
                }
            }
            _ = ping.tick() => {
                // 順便確認還是登入狀態：登出、被停用之後就不能再看
                if !user.still_signed_in(&state.pool).await.unwrap_or(true) {
                    return Some(("unauthorized", "登入已經失效，請重新登入"));
                }
                if socket.send(Message::Ping(Default::default())).await.is_err() {
                    return None;
                }
            }
            _ = tokio::time::sleep_until(last_seen + IDLE_TIMEOUT) => return None,
        }
    }
}

/// 固定時間窗內的次數限制；超過就回 false
fn within(window: &mut (Instant, u32), length: Duration, max: u32) -> bool {
    let now = Instant::now();
    if now.duration_since(window.0) >= length {
        *window = (now, 0);
    }
    window.1 += 1;
    window.1 <= max
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum ClientMessage {
    Send { room: Option<i64>, text: String, nonce: Option<String> },
    Open { room: Option<i64> },
    Read { room: i64, id: i64 },
    State { active: bool, endpoint: Option<String> },
    Delete { id: i64 },
}

const ROOM_NOT_FOUND: Reject = ("room_not_found", "找不到這個房間，可能已經被刪掉，或你被移出了");

/// 處理用戶端的一則訊息；回傳的錯誤（`{type:"error"}`）只告訴這條連線，不會斷線。
/// 送訊息失敗時錯誤裡帶著那則的 nonce，用戶端才知道是哪一則沒送出去
async fn handle(
    state: &AppState,
    user: &CurrentUser,
    id: u64,
    text: &str,
    sends: &mut (Instant, u32),
) -> Result<(), Value> {
    let Ok(message) = serde_json::from_str::<ClientMessage>(text) else {
        return Err(error_value(("bad_request", "看不懂的訊息")));
    };
    match message {
        ClientMessage::Send { room, text, nonce } => {
            let result = if within(sends, SEND_WINDOW, MAX_SENDS) {
                post(state, user, id, room, &text, nonce.clone()).await
            } else {
                Err(("rate_limited", "訊息送得太快了，稍等一下再送"))
            };
            result.map_err(|reject| {
                let mut error = error_value(reject);
                error["nonce"] = json!(nonce);
                error
            })
        }
        ClientMessage::Open { room } => open(state, user, id, room).await.map_err(|reject| {
            let mut error = error_value(reject);
            error["room"] = json!(room);
            error
        }),
        ClientMessage::Read { room, id: message_id } => {
            sqlx::query("UPDATE chat_room_members SET read_id = MAX(read_id, ?) WHERE room_id = ? AND user_id = ?")
                .bind(message_id)
                .bind(room)
                .bind(user.id)
                .execute(&state.pool)
                .await
                .map_err(|err| error_value(internal(err)))?;
            Ok(())
        }
        ClientMessage::State { active, endpoint } => {
            let endpoint = endpoint.filter(|e| !e.is_empty() && e.len() <= MAX_ENDPOINT_LEN);
            state.chat.set_state(id, active, endpoint);
            Ok(())
        }
        ClientMessage::Delete { id: message_id } => delete(state, user, message_id).await.map_err(error_value),
    }
}

/// 換到另一間：把那間最近的 50 則給這條連線
async fn open(state: &AppState, user: &CurrentUser, conn: u64, room: Option<i64>) -> Result<(), Reject> {
    if !can_see(&state.pool, user.id, room).await.map_err(internal)? {
        return Err(ROOM_NOT_FOUND);
    }
    let (messages, more) = page(&state.pool, room, None).await.map_err(internal)?;
    state.chat.send_to(conn, &json!({ "type": "history", "room": room, "messages": messages, "more": more }));
    Ok(())
}

/// 刪掉自己的訊息；管理員、私人房間的房主可以刪任何人的。都只能刪自己看得到的房間裡的
async fn delete(state: &AppState, user: &CurrentUser, message_id: i64) -> Result<(), Reject> {
    let deleted: Option<Option<i64>> = sqlx::query_scalar(
        "DELETE FROM chat_messages
         WHERE id = ?1
           AND (room_id IS NULL OR room_id IN (SELECT room_id FROM chat_room_members WHERE user_id = ?2))
           AND (user_id = ?2 OR ?3 OR room_id IN (SELECT id FROM chat_rooms WHERE owner_id = ?2))
         RETURNING room_id",
    )
    .bind(message_id)
    .bind(user.id)
    .bind(user.has(AdminUsers::NAME))
    .fetch_optional(&state.pool)
    .await
    .map_err(internal)?;
    let Some(room) = deleted else {
        return Err(("not_found", "找不到這則訊息，或不是你的訊息"));
    };
    let audience = match room {
        None => Audience::Everyone,
        Some(room) => Audience::Members(chat_rooms::member_ids(&state.pool, room).await.map_err(internal)?),
    };
    state.chat.deliver(&audience, &json!({ "type": "deleted", "id": message_id, "room": room }));
    Ok(())
}

async fn post(
    state: &AppState,
    user: &CurrentUser,
    conn: u64,
    room: Option<i64>,
    text: &str,
    nonce: Option<String>,
) -> Result<(), Reject> {
    let text = text.trim();
    if text.is_empty() {
        return Err(("bad_request", "訊息是空的"));
    }
    if text.chars().count() > MAX_TEXT_CHARS {
        return Err(("too_long", "訊息太長了（最多 2000 字）"));
    }
    if nonce.as_ref().is_some_and(|n| n.is_empty() || n.len() > MAX_NONCE_LEN) {
        return Err(("bad_request", "nonce 格式不對"));
    }
    // 私人房間：每則都重新確認還是成員，順便拿到要送給誰
    let (audience, room_name) = match room {
        None => (Audience::Everyone, None),
        Some(room) => match chat_rooms::audience(&state.pool, room, user.id).await.map_err(internal)? {
            Some((name, members)) => (Audience::Members(members), Some(name)),
            None => return Err(ROOM_NOT_FOUND),
        },
    };

    let inserted: Option<(i64, String)> = sqlx::query_as(
        "INSERT INTO chat_messages (user_id, room_id, body, nonce) VALUES (?, ?, ?, ?)
         ON CONFLICT (user_id, nonce) DO NOTHING RETURNING id, created_at",
    )
    .bind(user.id)
    .bind(room)
    .bind(text)
    .bind(&nonce)
    .fetch_optional(&state.pool)
    .await
    .map_err(internal)?;
    let Some((message_id, created_at)) = inserted else {
        // 同一個 nonce 已經送過了（斷線前其實有送到）：只把那一則再給這條連線，不再廣播、不再推播
        let existing = sqlx::query_as::<_, ChatMessage>(select_messages!("WHERE m.user_id = ? AND m.nonce = ?"))
            .bind(user.id)
            .bind(&nonce)
            .fetch_optional(&state.pool)
            .await
            .map_err(internal)?;
        if let Some(existing) = existing {
            state.chat.send_to(conn, &json!({ "type": "message", "message": existing }));
        }
        return Ok(());
    };

    let message = ChatMessage {
        id: message_id,
        room,
        user_id: user.id,
        username: user.username.clone(),
        text: text.to_owned(),
        nonce,
        created_at,
    };
    state.chat.deliver(&audience, &json!({ "type": "message", "message": message }));

    let targets = state.chat.push_targets(user.id, &audience);
    if !targets.is_empty() {
        let mut preview: String = text.chars().take(PREVIEW_CHARS).collect();
        if preview.len() < text.len() {
            preview.push('…');
        }
        // 每間房間各自合成一則通知（tag 不同），點下去回到那一間
        let (title, tag, url) = match (room, room_name) {
            (Some(room), Some(name)) => {
                (format!("🔒 {name}"), format!("chat-room-{room}"), format!("/chat?room={room}"))
            }
            _ => ("聊天室".to_owned(), "chat".to_owned(), "/chat".to_owned()),
        };
        let payload = json!({
            "title": title,
            "from": user.username,
            "body": preview,
            "tag": tag,
            "url": url,
            "id": message_id,
        });
        let state = state.clone();
        tokio::spawn(async move {
            for (user_id, endpoints) in targets {
                webpush::notify(&state, user_id, Some(&endpoints), &payload).await;
            }
        });
    }
    Ok(())
}

fn internal(err: sqlx::Error) -> Reject {
    tracing::error!(error = %err, "chat database error");
    ("internal", "伺服器出了點問題，請再試一次")
}

fn error_value((code, message): Reject) -> Value {
    json!({ "type": "error", "code": code, "message": message })
}

async fn close_with(mut socket: WebSocket, reject: Reject) {
    let text = Message::Text(error_value(reject).to_string().into());
    if socket.send(text).await.is_err() || socket.send(Message::Close(None)).await.is_err() {
        return;
    }
    // 等用戶端回應關閉，避免還沒讀完就被斷線而漏掉錯誤訊息
    let _ =
        tokio::time::timeout(Duration::from_secs(2), async { while let Some(Ok(_)) = socket.recv().await {} }).await;
}
