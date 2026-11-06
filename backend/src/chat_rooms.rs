//! 聊天室的私人房間：建立的人拿到一組代碼，知道代碼的人才進得來（訊息的收發在 chat.rs）。
//! 不在房間裡的人看不到房間：列表裡沒有、用 id 查一律 404（跟不存在一樣），也收不到裡面的訊息和推播。管理員也一樣。
//!
//! ```text
//! GET    /api/chat/rooms                          我加入的房間 {rooms:[Room]}，依加入的先後
//! POST   /api/chat/rooms              {name}      建立，自己是房主 → 201 Room
//! POST   /api/chat/rooms/join         {code}      用代碼加入 → Room（已經在裡面也一樣）；大小寫、空白、- 都不管
//! PATCH  /api/chat/rooms/{id}         {name}      改名（房主）→ Room
//! POST   /api/chat/rooms/{id}/code                換一組代碼，舊的不能再用（房主）→ Room
//! DELETE /api/chat/rooms/{id}                     刪掉房間和裡面的訊息（房主）
//! DELETE /api/chat/rooms/{id}/members/{user}      房主移出別人（代碼會跟著換，被移出的人不能用舊代碼再進來）；
//!                                                 user 是自己就是離開，房主離開時交給最早加入的人，沒人了就刪掉房間
//!
//! Room = {id, name, code, owner_id, members:[{id, username}], unread, created_at}
//!        members 依加入的先後；unread 是自己還沒看的別人的訊息數（用戶端用 WebSocket 的 read 回報看到哪裡）
//! ```
//!
//! 房間有變動時，WebSocket 會送 `{type:"rooms"}` 給相關的人（包括被移出的人），用戶端重新讀列表。

use std::collections::HashMap;

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{SqliteConnection, SqlitePool};

use crate::{AppError, AppState, auth::CurrentUser};

/// 代碼用的字：去掉容易看錯的 0、O、1、I
const CODE_CHARS: &[u8; 32] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LEN: usize = 8;
const MAX_NAME_CHARS: usize = 30;
/// 每個人最多當幾間的房主、加入幾間，每間最多幾個人
const MAX_OWNED: i64 = 20;
const MAX_JOINED: i64 = 50;
const MAX_MEMBERS: i64 = 100;

#[derive(Serialize)]
struct Member {
    id: i64,
    username: String,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct Room {
    id: i64,
    name: String,
    code: String,
    owner_id: i64,
    unread: i64,
    created_at: String,
    #[sqlx(skip)]
    members: Vec<Member>,
}

pub(crate) async fn is_member(pool: &SqlitePool, room: i64, user_id: i64) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM chat_room_members WHERE room_id = ? AND user_id = ?)")
        .bind(room)
        .bind(user_id)
        .fetch_one(pool)
        .await
}

pub(crate) async fn member_ids(pool: &SqlitePool, room: i64) -> Result<Vec<i64>, sqlx::Error> {
    sqlx::query_scalar("SELECT user_id FROM chat_room_members WHERE room_id = ?").bind(room).fetch_all(pool).await
}

/// 房間的名字和所有成員；`user` 不是成員就是 None
pub(crate) async fn audience(
    pool: &SqlitePool,
    room: i64,
    user_id: i64,
) -> Result<Option<(String, Vec<i64>)>, sqlx::Error> {
    let name: Option<String> = sqlx::query_scalar(
        "SELECT r.name FROM chat_rooms r JOIN chat_room_members m ON m.room_id = r.id AND m.user_id = ? WHERE r.id = ?",
    )
    .bind(user_id)
    .bind(room)
    .fetch_optional(pool)
    .await?;
    let Some(name) = name else { return Ok(None) };
    Ok(Some((name, member_ids(pool, room).await?)))
}

/// `user` 加入的房間（`only` 指定的話只要那一間），依加入的先後
async fn rooms_of(pool: &SqlitePool, user_id: i64, only: Option<i64>) -> Result<Vec<Room>, sqlx::Error> {
    let mut rooms = sqlx::query_as::<_, Room>(
        "SELECT r.id, r.name, r.code, r.owner_id, r.created_at,
                (SELECT COUNT(*) FROM chat_messages m
                 WHERE m.room_id = r.id AND m.id > me.read_id AND m.user_id <> me.user_id) AS unread
         FROM chat_rooms r JOIN chat_room_members me ON me.room_id = r.id
         WHERE me.user_id = ?1 AND (?2 IS NULL OR r.id = ?2)
         ORDER BY me.joined_at, me.rowid",
    )
    .bind(user_id)
    .bind(only)
    .fetch_all(pool)
    .await?;
    let members: Vec<(i64, i64, String)> = sqlx::query_as(
        "SELECT rm.room_id, u.id, u.username
         FROM chat_room_members rm JOIN users u ON u.id = rm.user_id
         WHERE rm.room_id IN (SELECT room_id FROM chat_room_members WHERE user_id = ?1 AND (?2 IS NULL OR room_id = ?2))
         ORDER BY rm.joined_at, rm.rowid",
    )
    .bind(user_id)
    .bind(only)
    .fetch_all(pool)
    .await?;
    let mut by_room: HashMap<i64, Vec<Member>> = HashMap::new();
    for (room, id, username) in members {
        by_room.entry(room).or_default().push(Member { id, username });
    }
    for room in &mut rooms {
        room.members = by_room.remove(&room.id).unwrap_or_default();
    }
    Ok(rooms)
}

/// `user` 看得到的一間；不是成員就是 404
async fn room_of(pool: &SqlitePool, user_id: i64, room: i64) -> Result<Room, AppError> {
    rooms_of(pool, user_id, Some(room)).await?.pop().ok_or(AppError::NotFound)
}

/// 確認 `user` 是這間的房主。不是成員一樣 404，是成員但不是房主 403
async fn require_owner(pool: &SqlitePool, user_id: i64, room: i64) -> Result<(), AppError> {
    let owner: Option<i64> = sqlx::query_scalar(
        "SELECT r.owner_id FROM chat_rooms r JOIN chat_room_members m ON m.room_id = r.id AND m.user_id = ? WHERE r.id = ?",
    )
    .bind(user_id)
    .bind(room)
    .fetch_optional(pool)
    .await?;
    match owner {
        None => Err(AppError::NotFound),
        Some(owner) if owner != user_id => Err(AppError::Denied("只有房主可以這樣做".into())),
        Some(_) => Ok(()),
    }
}

fn random_code() -> Result<String, AppError> {
    let mut bytes = [0u8; CODE_LEN];
    getrandom::fill(&mut bytes).map_err(|err| AppError::Internal(format!("getrandom: {err}")))?;
    Ok(bytes.iter().map(|b| char::from(CODE_CHARS[usize::from(b % 32)])).collect())
}

/// 使用者輸入的代碼：大小寫、空白、- 都不管
fn normalize_code(input: &str) -> String {
    input.chars().filter(char::is_ascii_alphanumeric).map(|c| c.to_ascii_uppercase()).collect()
}

fn clean_name(name: &str) -> Result<String, AppError> {
    let name = name.split_whitespace().collect::<Vec<_>>().join(" ");
    if name.is_empty() {
        return Err(AppError::BadRequest("請輸入房間名稱".into()));
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(AppError::BadRequest(format!("房間名稱最多 {MAX_NAME_CHARS} 個字")));
    }
    Ok(name)
}

fn is_unique_violation(err: &sqlx::Error) -> bool {
    matches!(err, sqlx::Error::Database(db) if db.is_unique_violation())
}

/// 換一組新代碼（萬一跟別間撞到就再抽一次）
async fn rotate_code(conn: &mut SqliteConnection, room: i64) -> Result<(), AppError> {
    for _ in 0..5 {
        match sqlx::query("UPDATE chat_rooms SET code = ? WHERE id = ?")
            .bind(random_code()?)
            .bind(room)
            .execute(&mut *conn)
            .await
        {
            Err(err) if is_unique_violation(&err) => continue,
            result => return result.map(|_| ()).map_err(AppError::from),
        }
    }
    Err(AppError::Internal("chat room code collided 5 times".into()))
}

async fn joined_count(pool: &SqlitePool, user_id: i64) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar("SELECT COUNT(*) FROM chat_room_members WHERE user_id = ?").bind(user_id).fetch_one(pool).await
}

pub async fn list(State(state): State<AppState>, user: CurrentUser) -> Result<Json<Value>, AppError> {
    Ok(Json(json!({ "rooms": rooms_of(&state.pool, user.id, None).await? })))
}

#[derive(Deserialize)]
pub struct NameBody {
    name: String,
}

pub async fn create(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(body): Json<NameBody>,
) -> Result<(StatusCode, Json<Room>), AppError> {
    let name = clean_name(&body.name)?;
    let owned: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM chat_rooms WHERE owner_id = ?")
        .bind(user.id)
        .fetch_one(&state.pool)
        .await?;
    if owned >= MAX_OWNED {
        return Err(AppError::BadRequest(format!("每個人最多建立 {MAX_OWNED} 間房間，先刪掉用不到的")));
    }
    if joined_count(&state.pool, user.id).await? >= MAX_JOINED {
        return Err(AppError::BadRequest(format!("最多加入 {MAX_JOINED} 間房間，先離開用不到的")));
    }

    let mut tx = state.pool.begin().await?;
    let mut room = None;
    for _ in 0..5 {
        match sqlx::query_scalar::<_, i64>(
            "INSERT INTO chat_rooms (name, code, owner_id) VALUES (?, ?, ?) RETURNING id",
        )
        .bind(&name)
        .bind(random_code()?)
        .bind(user.id)
        .fetch_one(&mut *tx)
        .await
        {
            Err(err) if is_unique_violation(&err) => continue,
            result => {
                room = Some(result?);
                break;
            }
        }
    }
    let room = room.ok_or_else(|| AppError::Internal("chat room code collided 5 times".into()))?;
    sqlx::query("INSERT INTO chat_room_members (room_id, user_id) VALUES (?, ?)")
        .bind(room)
        .bind(user.id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    state.chat.rooms_changed(&[user.id]);
    Ok((StatusCode::CREATED, Json(room_of(&state.pool, user.id, room).await?)))
}

#[derive(Deserialize)]
pub struct JoinBody {
    code: String,
}

pub async fn join(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(body): Json<JoinBody>,
) -> Result<Json<Room>, AppError> {
    if !state.chat.may_try_code(user.id) {
        return Err(AppError::TooManyRequests("代碼輸入錯太多次了，請 10 分鐘後再試"));
    }
    let code = normalize_code(&body.code);
    let room: Option<i64> = if code.len() == CODE_LEN {
        sqlx::query_scalar("SELECT id FROM chat_rooms WHERE code = ?").bind(&code).fetch_optional(&state.pool).await?
    } else {
        None
    };
    let Some(room) = room else {
        state.chat.code_failed(user.id);
        return Err(AppError::BadRequest("代碼不對，或是房主已經換了新的代碼".into()));
    };

    if !is_member(&state.pool, room, user.id).await? {
        if joined_count(&state.pool, user.id).await? >= MAX_JOINED {
            return Err(AppError::BadRequest(format!("最多加入 {MAX_JOINED} 間房間，先離開用不到的")));
        }
        let members: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM chat_room_members WHERE room_id = ?")
            .bind(room)
            .fetch_one(&state.pool)
            .await?;
        if members >= MAX_MEMBERS {
            return Err(AppError::BadRequest(format!("這間已經滿了（最多 {MAX_MEMBERS} 人）")));
        }
        // 加入前的訊息看得到，但不算未讀
        sqlx::query(
            "INSERT INTO chat_room_members (room_id, user_id, read_id)
             VALUES (?1, ?2, COALESCE((SELECT MAX(id) FROM chat_messages WHERE room_id = ?1), 0))
             ON CONFLICT DO NOTHING",
        )
        .bind(room)
        .bind(user.id)
        .execute(&state.pool)
        .await?;
        state.chat.rooms_changed(&member_ids(&state.pool, room).await?);
    }
    Ok(Json(room_of(&state.pool, user.id, room).await?))
}

pub async fn rename(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(room): Path<i64>,
    Json(body): Json<NameBody>,
) -> Result<Json<Room>, AppError> {
    let name = clean_name(&body.name)?;
    require_owner(&state.pool, user.id, room).await?;
    sqlx::query("UPDATE chat_rooms SET name = ? WHERE id = ?").bind(&name).bind(room).execute(&state.pool).await?;
    state.chat.rooms_changed(&member_ids(&state.pool, room).await?);
    Ok(Json(room_of(&state.pool, user.id, room).await?))
}

pub async fn new_code(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(room): Path<i64>,
) -> Result<Json<Room>, AppError> {
    require_owner(&state.pool, user.id, room).await?;
    rotate_code(&mut *state.pool.acquire().await?, room).await?;
    state.chat.rooms_changed(&member_ids(&state.pool, room).await?);
    Ok(Json(room_of(&state.pool, user.id, room).await?))
}

pub async fn delete(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(room): Path<i64>,
) -> Result<StatusCode, AppError> {
    require_owner(&state.pool, user.id, room).await?;
    let members = member_ids(&state.pool, room).await?;
    // 訊息、成員跟著 ON DELETE CASCADE 刪掉
    sqlx::query("DELETE FROM chat_rooms WHERE id = ?").bind(room).execute(&state.pool).await?;
    state.chat.rooms_changed(&members);
    Ok(StatusCode::NO_CONTENT)
}

/// 房主移出別人，或自己離開
pub async fn remove_member(
    State(state): State<AppState>,
    user: CurrentUser,
    Path((room, member)): Path<(i64, i64)>,
) -> Result<StatusCode, AppError> {
    let owner: Option<i64> = sqlx::query_scalar(
        "SELECT r.owner_id FROM chat_rooms r JOIN chat_room_members m ON m.room_id = r.id AND m.user_id = ? WHERE r.id = ?",
    )
    .bind(user.id)
    .bind(room)
    .fetch_optional(&state.pool)
    .await?;
    let Some(owner) = owner else { return Err(AppError::NotFound) };
    if member != user.id && owner != user.id {
        return Err(AppError::Denied("只有房主可以移出別人".into()));
    }
    let before = member_ids(&state.pool, room).await?;
    if !before.contains(&member) {
        return Err(AppError::NotFound);
    }

    let mut tx = state.pool.begin().await?;
    sqlx::query("DELETE FROM chat_room_members WHERE room_id = ? AND user_id = ?")
        .bind(room)
        .bind(member)
        .execute(&mut *tx)
        .await?;
    if member != user.id {
        // 被移出的人可能還記得代碼
        rotate_code(&mut tx, room).await?;
    } else if member == owner {
        // 房主離開：交給最早加入的人，沒人了就把房間刪掉
        let next: Option<i64> = sqlx::query_scalar(
            "SELECT user_id FROM chat_room_members WHERE room_id = ? ORDER BY joined_at, rowid LIMIT 1",
        )
        .bind(room)
        .fetch_optional(&mut *tx)
        .await?;
        match next {
            Some(next) => {
                sqlx::query("UPDATE chat_rooms SET owner_id = ? WHERE id = ?")
                    .bind(next)
                    .bind(room)
                    .execute(&mut *tx)
                    .await?;
            }
            None => {
                sqlx::query("DELETE FROM chat_rooms WHERE id = ?").bind(room).execute(&mut *tx).await?;
            }
        }
    }
    tx.commit().await?;

    state.chat.rooms_changed(&before);
    Ok(StatusCode::NO_CONTENT)
}
