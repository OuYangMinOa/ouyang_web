//! 小遊戲的線上對戰：伺服器只負責轉送，不懂遊戲規則（協定說明見 `frontend/src/games/shared/useRoom.ts`）。
//!
//! 每個房間兩個座位。用戶端送來的訊息加上 seat 後依序存進歷史，並廣播給兩個座位（包含送出者）；
//! 所有房間狀態的修改與廣播都在同一把鎖裡完成，兩邊看到的順序才會一致。
//! 房間只存在記憶體，重啟或換版就會消失。

use std::{collections::HashMap, sync::Mutex, time::Duration};

use axum::{
    Json,
    extract::{
        Path, Query, State,
        ws::{Message, Utf8Bytes, WebSocket, WebSocketUpgrade},
    },
    http::StatusCode,
    response::Response,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::{sync::mpsc, time::Instant};

use crate::{AppError, AppState};

const GAMES: [&str; 4] = ["gomoku", "xiangqi", "chess", "reversi"];
/// 去掉容易看錯的 I、O、0、1；剛好 32 個字，`byte % 32` 不會有偏差
const CODE_CHARS: &[u8; 32] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LEN: usize = 5;
const MAX_ROOMS: usize = 1000;
const MAX_HISTORY: usize = 2000;
const MAX_DATA_BYTES: usize = 4 * 1024;
/// 整個 WebSocket 訊息的上限（data 之外還有外層的 JSON）
const MAX_FRAME_BYTES: usize = 16 * 1024;
const MAX_PLAYER_LEN: usize = 64;
const MAX_MSGS_PER_SEC: u32 = 20;
/// 沒有任何人連線超過這麼久的房間會被清掉
const EMPTY_TTL: Duration = Duration::from_secs(30 * 60);
const ROOM_TTL: Duration = Duration::from_secs(24 * 60 * 60);
/// 定期 ping，避免 Traefik 或手機網路把閒置的連線切掉
const PING_INTERVAL: Duration = Duration::from_secs(25);
/// 這麼久沒收到任何東西（包含 pong）就當作已經斷線
const IDLE_TIMEOUT: Duration = Duration::from_secs(60);

/// 送給用戶端的錯誤：`(code, message)`，送出後關閉連線
type Reject = (&'static str, &'static str);

#[derive(Default)]
pub struct Rooms {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    rooms: HashMap<String, Room>,
    next_conn: u64,
}

struct Room {
    game: &'static str,
    created: Instant,
    /// 最後一個人離開的時間；有人在線時是 None
    empty_since: Option<Instant>,
    seats: [Seat; 2],
    history: Vec<Event>,
}

#[derive(Default)]
struct Seat {
    /// 第一次坐下的 player id，重連時用來拿回座位
    player: Option<String>,
    conn: Option<Conn>,
}

/// 一條連線的送出佇列；從座位上移除（drop）後，那條連線就會關閉
struct Conn {
    id: u64,
    tx: mpsc::UnboundedSender<Utf8Bytes>,
}

#[derive(Serialize)]
struct Event {
    seat: usize,
    data: Value,
}

impl Room {
    fn expired(&self, now: Instant) -> bool {
        now.duration_since(self.created) > ROOM_TTL
            || self.empty_since.is_some_and(|since| now.duration_since(since) > EMPTY_TTL)
    }

    fn is_current(&self, seat: usize, id: u64) -> bool {
        self.seats[seat].conn.as_ref().is_some_and(|conn| conn.id == id)
    }

    fn send(&self, seat: usize, text: &Utf8Bytes) {
        if let Some(conn) = &self.seats[seat].conn {
            // 失敗表示那條連線正在關閉，忽略即可
            let _ = conn.tx.send(text.clone());
        }
    }
}

impl Rooms {
    fn create(&self, game: &'static str) -> Result<String, AppError> {
        let mut inner = self.inner.lock().unwrap();
        let now = Instant::now();
        inner.rooms.retain(|_, room| !room.expired(now));
        if inner.rooms.len() >= MAX_ROOMS {
            return Err(AppError::ServiceUnavailable("目前房間太多，請稍後再試"));
        }
        let code = loop {
            let code = random_code()?;
            if !inner.rooms.contains_key(&code) {
                break code;
            }
        };
        let room = Room { game, created: now, empty_since: Some(now), seats: Default::default(), history: Vec::new() };
        inner.rooms.insert(code.clone(), room);
        Ok(code)
    }

    /// 坐下：同一個 player 拿回原本的座位（踢掉舊連線），否則坐第一個空位。回傳 `(seat, 連線 id)`。
    fn join(
        &self,
        code: &str,
        game: &str,
        player: &str,
        tx: mpsc::UnboundedSender<Utf8Bytes>,
    ) -> Result<(usize, u64), Reject> {
        let mut inner = self.inner.lock().unwrap();
        let Inner { rooms, next_conn } = &mut *inner;
        let now = Instant::now();
        let room = rooms
            .get_mut(code)
            .filter(|room| !room.expired(now))
            .ok_or(("not_found", "找不到這個房間（可能已過期）"))?;
        if room.game != game {
            return Err(("game_mismatch", "這個房間是其他遊戲的"));
        }
        let seat = room
            .seats
            .iter()
            .position(|s| s.player.as_deref() == Some(player))
            .or_else(|| room.seats.iter().position(|s| s.player.is_none()))
            .ok_or(("full", "房間已滿"))?;

        *next_conn += 1;
        let id = *next_conn;
        room.seats[seat] = Seat { player: Some(player.to_owned()), conn: Some(Conn { id, tx }) };
        room.empty_since = None;
        let peer = room.seats[1 - seat].conn.is_some();
        room.send(seat, &text(json!({ "type": "welcome", "seat": seat, "peer": peer, "history": room.history })));
        room.send(1 - seat, &text(json!({ "type": "peer", "online": true })));
        Ok((seat, id))
    }

    fn post(&self, code: &str, seat: usize, id: u64, data: Value) -> Result<(), Reject> {
        let mut inner = self.inner.lock().unwrap();
        // 房間被清掉或座位被新連線拿走：這條連線的佇列已經關閉，迴圈會自己結束
        let Some(room) = inner.rooms.get_mut(code).filter(|room| room.is_current(seat, id)) else {
            return Ok(());
        };
        if room.history.len() >= MAX_HISTORY {
            return Err(("history_full", "這局的紀錄太長了，請建立新房間"));
        }
        let message = text(json!({ "type": "msg", "seat": seat, "data": data }));
        room.history.push(Event { seat, data });
        room.send(0, &message);
        room.send(1, &message);
        Ok(())
    }

    fn leave(&self, code: &str, seat: usize, id: u64) {
        let mut inner = self.inner.lock().unwrap();
        let Some(room) = inner.rooms.get_mut(code).filter(|room| room.is_current(seat, id)) else {
            return;
        };
        room.seats[seat].conn = None;
        room.send(1 - seat, &text(json!({ "type": "peer", "online": false })));
        if room.seats.iter().all(|s| s.conn.is_none()) {
            room.empty_since = Some(Instant::now());
        }
    }
}

fn random_code() -> Result<String, AppError> {
    let mut bytes = [0u8; CODE_LEN];
    getrandom::fill(&mut bytes).map_err(|err| AppError::Internal(format!("getrandom: {err}")))?;
    Ok(bytes.iter().map(|b| char::from(CODE_CHARS[usize::from(b % 32)])).collect())
}

fn text(value: Value) -> Utf8Bytes {
    value.to_string().into()
}

#[derive(Deserialize)]
pub struct NewRoom {
    #[serde(default)]
    game: String,
}

pub async fn create_room(
    State(state): State<AppState>,
    Json(input): Json<NewRoom>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    let game =
        GAMES.into_iter().find(|g| *g == input.game).ok_or_else(|| AppError::BadRequest("不支援這個遊戲".into()))?;
    let code = state.rooms.create(game)?;
    Ok((StatusCode::CREATED, Json(json!({ "code": code }))))
}

#[derive(Deserialize)]
pub struct JoinQuery {
    game: Option<String>,
    player: Option<String>,
}

/// 一律先升級再用 `{type:"error"}` 回報問題：瀏覽器的 WebSocket 讀不到升級失敗時的 HTTP 狀態。
pub async fn connect(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Path(code): Path<String>,
    Query(query): Query<JoinQuery>,
) -> Response {
    let code = code.to_ascii_uppercase();
    ws.max_message_size(MAX_FRAME_BYTES).on_upgrade(move |socket| session(socket, state, code, query))
}

async fn session(mut socket: WebSocket, state: AppState, code: String, query: JoinQuery) {
    let rooms = &state.rooms;
    let (tx, mut rx) = mpsc::unbounded_channel();
    let joined = match (query.game.as_deref(), query.player.as_deref()) {
        (Some(game), Some(player)) if !player.is_empty() && player.chars().count() <= MAX_PLAYER_LEN => {
            rooms.join(&code, game, player, tx)
        }
        _ => Err(("bad_request", "缺少 game 或 player，或 player 太長")),
    };
    let (seat, id) = match joined {
        Ok(joined) => joined,
        Err(reject) => return close_with(socket, reject).await,
    };

    let mut ping = tokio::time::interval_at(Instant::now() + PING_INTERVAL, PING_INTERVAL);
    let mut last_seen = Instant::now();
    let mut window = (Instant::now(), 0);
    let error = loop {
        tokio::select! {
            outgoing = rx.recv() => match outgoing {
                Some(text) => {
                    if socket.send(Message::Text(text)).await.is_err() {
                        break None;
                    }
                }
                // 同一個 player 從別處重連，或房間被清掉
                None => break None,
            },
            incoming = socket.recv() => {
                let Some(Ok(message)) = incoming else { break None };
                last_seen = Instant::now();
                if let Message::Text(text) = message
                    && let Err(reject) = handle(&state, &code, seat, id, &text, &mut window)
                {
                    break Some(reject);
                }
            }
            _ = ping.tick() => {
                if socket.send(Message::Ping(Default::default())).await.is_err() {
                    break None;
                }
            }
            _ = tokio::time::sleep_until(last_seen + IDLE_TIMEOUT) => break None,
        }
    };
    rooms.leave(&code, seat, id);
    if let Some(reject) = error {
        close_with(socket, reject).await;
    }
}

/// 處理用戶端送來的一則訊息；非 JSON 或未知的 type 直接忽略。
fn handle(
    state: &AppState,
    code: &str,
    seat: usize,
    id: u64,
    text: &str,
    window: &mut (Instant, u32),
) -> Result<(), Reject> {
    let now = Instant::now();
    if now.duration_since(window.0) >= Duration::from_secs(1) {
        *window = (now, 0);
    }
    window.1 += 1;
    if window.1 > MAX_MSGS_PER_SEC {
        return Err(("rate_limited", "訊息送得太快了"));
    }

    #[derive(Deserialize)]
    struct ClientMessage {
        #[serde(rename = "type")]
        kind: String,
        #[serde(default)]
        data: Value,
    }
    let Ok(ClientMessage { kind, data }) = serde_json::from_str(text) else { return Ok(()) };
    if kind != "msg" {
        return Ok(());
    }
    if data.to_string().len() > MAX_DATA_BYTES {
        return Err(("too_large", "訊息太大"));
    }
    state.rooms.post(code, seat, id, data)
}

async fn close_with(mut socket: WebSocket, (code, message): Reject) {
    let error = text(json!({ "type": "error", "code": code, "message": message }));
    if socket.send(Message::Text(error)).await.is_err() || socket.send(Message::Close(None)).await.is_err() {
        return;
    }
    // 等用戶端回應關閉，避免還沒讀完就被斷線而漏掉錯誤訊息
    let _ =
        tokio::time::timeout(Duration::from_secs(2), async { while let Some(Ok(_)) = socket.recv().await {} }).await;
}
