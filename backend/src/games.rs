//! 小遊戲的線上對戰：伺服器只負責轉送，不懂遊戲規則（協定說明見 `frontend/src/games/shared/useRoom.ts`）。
//!
//! 每個房間兩個座位。用戶端送來的訊息加上 seat 後依序存進歷史，並廣播給兩個座位（包含送出者）；
//! 同一個房間的修改、寫入資料庫與廣播都在那個房間的鎖裡完成，兩邊看到的順序才會一致。
//!
//! 房間和歷史存在資料庫（migrations/0003），記憶體裡只放有人連線的房間：最後一個人離開就丟掉，
//! 下次有人連進來再從資料庫載入。所以重啟或換版後，用戶端自動重連就能接著下。
//! 換版的幾秒內新舊容器可能各有同一個房間的連線：寫入事件時序號撞到（另一邊已經寫過這一號），
//! 就關掉這邊這個房間的所有連線，讓用戶端重連、從資料庫重新載入。

use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

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
use sqlx::SqlitePool;
use tokio::{
    sync::{Mutex as AsyncMutex, mpsc},
    time::Instant,
};

use crate::{AppError, AppState, auth::CurrentUser};

const GAMES: [&str; 4] = ["gomoku", "xiangqi", "chess", "reversi"];
/// 去掉容易看錯的 I、O、0、1；剛好 32 個字，`byte % 32` 不會有偏差
const CODE_CHARS: &[u8; 32] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LEN: usize = 5;
const MAX_ROOMS: i64 = 1000;
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

const NOT_FOUND: Reject = ("not_found", "找不到這個房間（可能已過期）");
const FULL: Reject = ("full", "房間已滿");
const REPLACED: Reject = ("replaced", "你在其他分頁或裝置開啟了這個房間");
const INTERNAL: Reject = ("internal", "伺服器發生錯誤，請稍後再試");

/// 搶空座位：只有資料庫裡還是空的才算搶到（換版時另一個容器可能同時在搶）
const CLAIM_SEAT: [&str; 2] = [
    "UPDATE game_rooms SET seat0 = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE code = ? AND seat0 IS NULL",
    "UPDATE game_rooms SET seat1 = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE code = ? AND seat1 IS NULL",
];

/// 記憶體裡的一個房間。鎖裡是 None 表示房間已經關閉並從 `Rooms::live` 移除，拿到的人要重新查表。
type Slot = Arc<AsyncMutex<Option<Room>>>;

#[derive(Default)]
pub struct Rooms {
    /// 有人連線中的房間
    live: Mutex<HashMap<String, Slot>>,
    next_conn: AtomicU64,
}

struct Room {
    game: String,
    seats: [Seat; 2],
    history: Vec<Event>,
}

#[derive(Default)]
struct Seat {
    /// 第一次坐下的 player，重連時用來拿回座位
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
    fn is_current(&self, seat: usize, id: u64) -> bool {
        self.seats[seat].conn.as_ref().is_some_and(|conn| conn.id == id)
    }

    fn seat_of(&self, player: &str) -> Option<usize> {
        self.seats.iter().position(|s| s.player.as_deref() == Some(player))
    }

    fn send(&self, seat: usize, text: &Utf8Bytes) {
        if let Some(conn) = &self.seats[seat].conn {
            // 失敗表示那條連線正在關閉，忽略即可
            let _ = conn.tx.send(text.clone());
        }
    }
}

impl Rooms {
    async fn create(&self, pool: &SqlitePool, game: &str) -> Result<String, AppError> {
        let live: Vec<String> = self.live.lock().unwrap().keys().cloned().collect();
        sqlx::query(
            "DELETE FROM game_rooms WHERE created_at <= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?)
             OR (updated_at <= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?) AND code NOT IN (SELECT value FROM json_each(?)))",
        )
        .bind(ago(ROOM_TTL))
        .bind(ago(EMPTY_TTL))
        .bind(json!(live).to_string())
        .execute(pool)
        .await?;
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM game_rooms").fetch_one(pool).await?;
        if count >= MAX_ROOMS {
            return Err(AppError::ServiceUnavailable("目前房間太多，請稍後再試"));
        }
        loop {
            let code = random_code()?;
            let inserted = sqlx::query("INSERT INTO game_rooms (code, game) VALUES (?, ?) ON CONFLICT DO NOTHING")
                .bind(&code)
                .bind(game)
                .execute(pool)
                .await?;
            if inserted.rows_affected() == 1 {
                return Ok(code);
            }
        }
    }

    /// 坐下：同一個 player 拿回原本的座位（踢掉舊連線），否則坐第一個空位。回傳 `(房間, seat, 連線 id)`。
    async fn join(
        &self,
        pool: &SqlitePool,
        code: &str,
        game: &str,
        player: &str,
        tx: mpsc::UnboundedSender<Utf8Bytes>,
    ) -> Result<(Slot, usize, u64), Reject> {
        loop {
            let (slot, fresh) = {
                let mut live = self.live.lock().unwrap();
                match live.get(code) {
                    Some(slot) => (slot.clone(), None),
                    None => {
                        // 先鎖住再放進表裡：載入完成前，其他人連進同一個房間會等這把鎖
                        let slot = Slot::default();
                        let guard = slot.clone().try_lock_owned().expect("a new mutex is unlocked");
                        live.insert(code.to_owned(), slot.clone());
                        (slot, Some(guard))
                    }
                }
            };
            let mut guard = match fresh {
                Some(mut guard) => {
                    match load(pool, code).await {
                        Ok(Some(room)) => *guard = Some(room),
                        result => {
                            self.remove(code, &slot);
                            if let Err(err) = result {
                                tracing::error!(%code, error = %err, "load game room");
                                return Err(INTERNAL);
                            }
                            return Err(NOT_FOUND);
                        }
                    }
                    guard
                }
                None => slot.clone().lock_owned().await,
            };
            // 等鎖的時候最後一個人剛好離開、房間被關掉了：重新查表（會再從資料庫載入）
            let Some(room) = guard.as_mut() else { continue };

            if room.game != game {
                return Err(("game_mismatch", "這個房間是其他遊戲的"));
            }
            let seat = take_seat(pool, code, room, player).await?;
            let id = self.next_conn.fetch_add(1, Ordering::Relaxed) + 1;
            if let Some(old) = room.seats[seat].conn.replace(Conn { id, tx }) {
                // 舊連線收到這則錯誤後就不會再自動重連，兩邊才不會一直互踢
                let _ = old.tx.send(error_text(REPLACED));
            }
            let peer = room.seats[1 - seat].conn.is_some();
            room.send(seat, &text(json!({ "type": "welcome", "seat": seat, "peer": peer, "history": room.history })));
            room.send(1 - seat, &text(json!({ "type": "peer", "online": true })));
            return Ok((slot, seat, id));
        }
    }

    async fn post(
        &self,
        pool: &SqlitePool,
        code: &str,
        slot: &Slot,
        seat: usize,
        id: u64,
        data: Value,
    ) -> Result<(), Reject> {
        let mut guard = slot.lock().await;
        // 房間被關掉或座位被新連線拿走：這條連線的佇列已經關閉，迴圈會自己結束
        let Some(room) = guard.as_mut().filter(|room| room.is_current(seat, id)) else {
            return Ok(());
        };
        if room.history.len() >= MAX_HISTORY {
            return Err(("history_full", "這局的紀錄太長了，請建立新房間"));
        }
        let saved = sqlx::query("INSERT INTO game_events (room_code, seq, seat, data) VALUES (?, ?, ?, ?)")
            .bind(code)
            .bind(room.history.len() as i64)
            .bind(seat as i64)
            .bind(data.to_string())
            .execute(pool)
            .await;
        if let Err(err) = saved {
            // 序號撞到（換版期間另一個容器也寫了這個房間）或房間已過期被刪掉：
            // 關掉這邊的連線，用戶端重連時會從資料庫重新載入
            tracing::warn!(%code, error = %err, "game event not saved, closing room");
            *guard = None;
            self.remove(code, slot);
            return Ok(());
        }
        let message = text(json!({ "type": "msg", "seat": seat, "data": data }));
        room.history.push(Event { seat, data });
        room.send(0, &message);
        room.send(1, &message);
        Ok(())
    }

    async fn leave(&self, pool: &SqlitePool, code: &str, slot: &Slot, seat: usize, id: u64) {
        let mut guard = slot.lock().await;
        let Some(room) = guard.as_mut().filter(|room| room.is_current(seat, id)) else {
            return;
        };
        room.seats[seat].conn = None;
        room.send(1 - seat, &text(json!({ "type": "peer", "online": false })));
        if room.seats.iter().any(|s| s.conn.is_some()) {
            return;
        }
        *guard = None;
        self.remove(code, slot);
        // 從現在開始算沒人連線的時間
        let touched =
            sqlx::query("UPDATE game_rooms SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE code = ?")
                .bind(code)
                .execute(pool)
                .await;
        if let Err(err) = touched {
            tracing::warn!(%code, error = %err, "touch game room");
        }
    }

    /// 從表裡移除；表裡已經換成別的房間物件（關掉後又有人重新載入）就不動
    fn remove(&self, code: &str, slot: &Slot) {
        let mut live = self.live.lock().unwrap();
        if live.get(code).is_some_and(|current| Arc::ptr_eq(current, slot)) {
            live.remove(code);
        }
    }
}

async fn load(pool: &SqlitePool, code: &str) -> Result<Option<Room>, sqlx::Error> {
    let row = sqlx::query_as::<_, (String, Option<String>, Option<String>)>(
        "SELECT game, seat0, seat1 FROM game_rooms WHERE code = ?
         AND created_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?) AND updated_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?)",
    )
    .bind(code)
    .bind(ago(ROOM_TTL))
    .bind(ago(EMPTY_TTL))
    .fetch_optional(pool)
    .await?;
    let Some((game, seat0, seat1)) = row else { return Ok(None) };
    let history =
        sqlx::query_as::<_, (i64, String)>("SELECT seat, data FROM game_events WHERE room_code = ? ORDER BY seq")
            .bind(code)
            .fetch_all(pool)
            .await?
            .into_iter()
            .map(|(seat, data)| Event { seat: seat as usize, data: serde_json::from_str(&data).unwrap_or(Value::Null) })
            .collect();
    let seats = [Seat { player: seat0, conn: None }, Seat { player: seat1, conn: None }];
    Ok(Some(Room { game, seats, history }))
}

/// 找出 player 的座位，還沒坐下就搶一個空位
async fn take_seat(pool: &SqlitePool, code: &str, room: &mut Room, player: &str) -> Result<usize, Reject> {
    let internal = |err: sqlx::Error| {
        tracing::error!(%code, error = %err, "take game seat");
        INTERNAL
    };
    loop {
        if let Some(seat) = room.seat_of(player) {
            return Ok(seat);
        }
        let seat = room.seats.iter().position(|s| s.player.is_none()).ok_or(FULL)?;
        let claimed = sqlx::query(CLAIM_SEAT[seat]).bind(player).bind(code).execute(pool).await.map_err(internal)?;
        if claimed.rows_affected() == 1 {
            room.seats[seat].player = Some(player.to_owned());
            return Ok(seat);
        }
        // 另一個容器先坐下了：以資料庫為準再找一次（每次失敗都代表多了一個有人的座位，最多兩輪）
        let (seat0, seat1) =
            sqlx::query_as::<_, (Option<String>, Option<String>)>("SELECT seat0, seat1 FROM game_rooms WHERE code = ?")
                .bind(code)
                .fetch_optional(pool)
                .await
                .map_err(internal)?
                .ok_or(NOT_FOUND)?;
        room.seats[0].player = seat0;
        room.seats[1].player = seat1;
    }
}

/// SQLite 時間修飾詞，例如 `-1800 seconds`
fn ago(ttl: Duration) -> String {
    format!("-{} seconds", ttl.as_secs())
}

pub(crate) fn random_code() -> Result<String, AppError> {
    let mut bytes = [0u8; CODE_LEN];
    getrandom::fill(&mut bytes).map_err(|err| AppError::Internal(format!("getrandom: {err}")))?;
    Ok(bytes.iter().map(|b| char::from(CODE_CHARS[usize::from(b % 32)])).collect())
}

fn text(value: Value) -> Utf8Bytes {
    value.to_string().into()
}

fn error_text((code, message): Reject) -> Utf8Bytes {
    text(json!({ "type": "error", "code": code, "message": message }))
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
    let code = state.rooms.create(&state.pool, game).await?;
    Ok((StatusCode::CREATED, Json(json!({ "code": code }))))
}

#[derive(Deserialize)]
pub struct JoinQuery {
    game: Option<String>,
    player: Option<String>,
}

/// 一律先升級再用 `{type:"error"}` 回報問題：瀏覽器的 WebSocket 讀不到升級失敗時的 HTTP 狀態。
///
/// 登入的人用帳號當 player，換分頁或裝置也拿得回座位，query 的 player 會被忽略；
/// 訪客才用用戶端自己產生的 id。兩者加上不同前綴，訪客不能冒用帳號的座位。
pub async fn connect(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Path(code): Path<String>,
    Query(query): Query<JoinQuery>,
    user: Option<CurrentUser>,
) -> Response {
    let code = code.to_ascii_uppercase();
    let player = match (user, query.player) {
        (Some(user), _) => Some(format!("user:{}", user.id)),
        (None, Some(player)) if !player.is_empty() && player.chars().count() <= MAX_PLAYER_LEN => {
            Some(format!("guest:{player}"))
        }
        _ => None,
    };
    ws.max_message_size(MAX_FRAME_BYTES).on_upgrade(move |socket| session(socket, state, code, query.game, player))
}

async fn session(mut socket: WebSocket, state: AppState, code: String, game: Option<String>, player: Option<String>) {
    let rooms = &state.rooms;
    let (tx, mut rx) = mpsc::unbounded_channel();
    let joined = match (game.as_deref(), player.as_deref()) {
        (Some(game), Some(player)) => rooms.join(&state.pool, &code, game, player, tx).await,
        _ => Err(("bad_request", "缺少 game 或 player，或 player 太長")),
    };
    let (slot, seat, id) = match joined {
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
                // 同一個 player 從別處連進來，或房間被關掉
                None => break None,
            },
            incoming = socket.recv() => {
                let Some(Ok(message)) = incoming else { break None };
                last_seen = Instant::now();
                if let Message::Text(text) = message
                    && let Err(reject) = handle(&state, &code, &slot, seat, id, &text, &mut window).await
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
    rooms.leave(&state.pool, &code, &slot, seat, id).await;
    match error {
        Some(reject) => close_with(socket, reject).await,
        // 被取代時的錯誤已經從佇列送出了，這裡只要關閉（對方已經斷線就會失敗，忽略）
        None => {
            let _ = socket.send(Message::Close(None)).await;
        }
    }
}

/// 處理用戶端送來的一則訊息；非 JSON 或未知的 type 直接忽略。
async fn handle(
    state: &AppState,
    code: &str,
    slot: &Slot,
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
    state.rooms.post(&state.pool, code, slot, seat, id, data).await
}

async fn close_with(mut socket: WebSocket, reject: Reject) {
    if socket.send(Message::Text(error_text(reject))).await.is_err() || socket.send(Message::Close(None)).await.is_err()
    {
        return;
    }
    // 等用戶端回應關閉，避免還沒讀完就被斷線而漏掉錯誤訊息
    let _ =
        tokio::time::timeout(Duration::from_secs(2), async { while let Some(Ok(_)) = socket.recv().await {} }).await;
}
