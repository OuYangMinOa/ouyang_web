//! 回報與許願：使用者開一串對話，管理員在系統管理裡回覆，雙方可以來回留言、貼圖片。
//!
//! 不用登入也能送：沒登入的人第一次送出時發一個訪客 cookie（`feedback_<env>`，只送到 /api/feedback），
//! 之後用它認出是誰的對話。登入的人用帳號，也看得到同一個瀏覽器先前以訪客身分送出的。
//!
//! 圖片先單獨上傳（`POST /api/feedback/images`，body 就是圖片本身），拿到 id 後隨留言一起送出才掛上去；
//! 一天內沒掛上的會被清掉。圖片只有對話的雙方看得到。

use axum::{
    Json,
    body::Bytes,
    extract::{Path, Query, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use sqlx::{SqliteConnection, SqlitePool};

use crate::{
    AppError, AppState,
    auth::{AdminUsers, CurrentUser, Permission, Require, client_key, random_token, read_session_token, token_hash},
};

const KINDS: &[&str] = &["bug", "wish"];
const MAX_TITLE_LEN: usize = 100;
const MAX_BODY_LEN: usize = 4000;
pub const MAX_IMAGE_BYTES: usize = 5 * 1024 * 1024;
const MAX_IMAGES_PER_MESSAGE: usize = 6;
/// 同一個 IP 一天內最多開幾串、留幾則、傳幾張圖（管理員不受限）
const MAX_THREADS_PER_DAY: i64 = 10;
const MAX_MESSAGES_PER_DAY: i64 = 100;
const MAX_IMAGES_PER_DAY: i64 = 60;
/// 管理頁一次列出最近的幾串
const MAX_LISTED: i64 = 300;
/// 瀏覽器最多只接受 400 天
const GUEST_COOKIE_DAYS: i64 = 400;

/// 一天前，寫在 SQL 裡比較用（sqlx 只收字面字串，所以用巨集接起來）
macro_rules! a_day_ago {
    () => {
        "strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 day')"
    };
}

// ---- 身分 ----

impl AppState {
    fn feedback_cookie_name(&self) -> String {
        format!("feedback_{}", self.app_env)
    }

    fn feedback_cookie(&self, token: &str) -> String {
        let secure = if self.cookie_secure { "; Secure" } else { "" };
        let max_age = GUEST_COOKIE_DAYS * 24 * 60 * 60;
        format!(
            "{}={token}; Path=/api/feedback; HttpOnly; SameSite=Lax; Max-Age={max_age}{secure}",
            self.feedback_cookie_name()
        )
    }
}

/// 正在看的人：登入的帳號，和（如果有的話）訪客 cookie 的雜湊。兩者任一對得上就是他的對話。
struct Viewer {
    user: Option<CurrentUser>,
    guest: Option<String>,
    /// 訪客寫入時要回給瀏覽器的 Set-Cookie（順便延長期限）
    set_cookie: Option<String>,
}

impl Viewer {
    fn read(state: &AppState, user: Option<CurrentUser>, headers: &HeaderMap) -> Self {
        let guest = read_session_token(headers, &state.feedback_cookie_name()).map(|token| token_hash(&token));
        Self { user, guest, set_cookie: None }
    }

    /// 要寫入時用：沒登入也沒有訪客 cookie 就發一個新的
    fn write(state: &AppState, user: Option<CurrentUser>, headers: &HeaderMap) -> Result<Self, AppError> {
        if user.is_some() {
            return Ok(Self::read(state, user, headers));
        }
        let token = match read_session_token(headers, &state.feedback_cookie_name()) {
            Some(token) => token,
            None => random_token()?,
        };
        Ok(Self { user: None, guest: Some(token_hash(&token)), set_cookie: Some(state.feedback_cookie(&token)) })
    }

    fn user_id(&self) -> Option<i64> {
        self.user.as_ref().map(|u| u.id)
    }

    /// 寫入時記的身分：登入就只記帳號
    fn author(&self) -> (Option<i64>, Option<&str>) {
        match &self.user {
            Some(user) => (Some(user.id), None),
            None => (None, self.guest.as_deref()),
        }
    }

    fn is_admin(&self) -> bool {
        self.user.as_ref().is_some_and(|u| u.has(AdminUsers::NAME))
    }

    fn respond(self, response: impl IntoResponse) -> Response {
        let mut response = response.into_response();
        if let Some(value) = self.set_cookie.and_then(|cookie| HeaderValue::from_str(&cookie).ok()) {
            response.headers_mut().insert(header::SET_COOKIE, value);
        }
        response
    }
}

/// 這個 IP 一天內在某張表寫了幾筆
macro_rules! count_recent {
    ($pool:expr, $table:literal, $ip:expr) => {
        sqlx::query_scalar::<_, i64>(concat!(
            "SELECT COUNT(*) FROM ",
            $table,
            " WHERE ip = ? AND created_at > ",
            a_day_ago!()
        ))
        .bind($ip)
        .fetch_one($pool)
    };
}

// ---- 資料 ----

#[derive(Serialize, sqlx::FromRow)]
pub struct Thread {
    pub id: i64,
    pub kind: String,
    pub title: String,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
    pub messages: i64,
    /// 對方有沒有新的留言
    pub unread: bool,
}

/// 管理員看到的多了發問者
#[derive(Serialize, sqlx::FromRow)]
pub struct AdminThread {
    #[serde(flatten)]
    #[sqlx(flatten)]
    pub thread: Thread,
    /// 發問的帳號；訪客是 None
    pub reporter: Option<String>,
    pub ip: String,
}

/// 對話的查詢，第一個參數是從誰的角度算未讀（user 看管理員的留言、admin 看使用者的），後面接上 WHERE / ORDER BY
macro_rules! thread_query {
    (user, $tail:literal) => {
        concat!(
            "SELECT t.id, t.kind, t.title, t.status, t.created_at, t.updated_at,
               (SELECT COUNT(*) FROM feedback_messages m WHERE m.thread_id = t.id) AS messages,
               EXISTS (SELECT 1 FROM feedback_messages m WHERE m.thread_id = t.id AND m.from_admin AND m.id > t.user_seen) AS unread
             FROM feedback_threads t ",
            $tail
        )
    };
    (admin, $tail:literal) => {
        concat!(
            "SELECT t.id, t.kind, t.title, t.status, t.created_at, t.updated_at,
               (SELECT COUNT(*) FROM feedback_messages m WHERE m.thread_id = t.id) AS messages,
               EXISTS (SELECT 1 FROM feedback_messages m WHERE m.thread_id = t.id AND NOT m.from_admin AND m.id > t.admin_seen) AS unread,
               u.username AS reporter, t.ip
             FROM feedback_threads t LEFT JOIN users u ON u.id = t.user_id ",
            $tail
        )
    };
}

#[derive(Serialize, sqlx::FromRow)]
pub struct Message {
    pub id: i64,
    pub from_admin: bool,
    /// 留言的帳號；訪客是 None
    pub author: Option<String>,
    pub body: String,
    pub created_at: String,
    #[sqlx(skip)]
    pub images: Vec<i64>,
}

#[derive(Serialize)]
pub struct Conversation<T> {
    pub thread: T,
    pub messages: Vec<Message>,
}

async fn load_messages(pool: &SqlitePool, thread_id: i64) -> Result<Vec<Message>, AppError> {
    let mut messages = sqlx::query_as::<_, Message>(
        "SELECT m.id, m.from_admin, u.username AS author, m.body, m.created_at
         FROM feedback_messages m LEFT JOIN users u ON u.id = m.author_id
         WHERE m.thread_id = ? ORDER BY m.id",
    )
    .bind(thread_id)
    .fetch_all(pool)
    .await?;
    let images = sqlx::query_as::<_, (i64, i64)>(
        "SELECT i.message_id, i.id FROM feedback_images i JOIN feedback_messages m ON m.id = i.message_id
         WHERE m.thread_id = ? ORDER BY i.id",
    )
    .bind(thread_id)
    .fetch_all(pool)
    .await?;
    for (message_id, image_id) in images {
        if let Some(message) = messages.iter_mut().find(|m| m.id == message_id) {
            message.images.push(image_id);
        }
    }
    Ok(messages)
}

#[derive(Deserialize)]
pub struct NewMessage {
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub images: Vec<i64>,
}

#[derive(Deserialize)]
pub struct NewThread {
    pub kind: String,
    pub title: String,
    #[serde(flatten)]
    pub message: NewMessage,
}

/// 文字和圖片至少要有一樣
fn validate_message(input: &NewMessage) -> Result<&str, AppError> {
    let body = input.body.trim();
    if body.is_empty() && input.images.is_empty() {
        return Err(AppError::BadRequest("請輸入內容或貼上圖片".into()));
    }
    if body.chars().count() > MAX_BODY_LEN {
        return Err(AppError::BadRequest(format!("內容不可超過 {MAX_BODY_LEN} 字")));
    }
    if input.images.len() > MAX_IMAGES_PER_MESSAGE {
        return Err(AppError::BadRequest(format!("一則留言最多 {MAX_IMAGES_PER_MESSAGE} 張圖片")));
    }
    Ok(body)
}

/// 新增一則留言並掛上圖片，回傳留言 id。圖片必須是同一個人上傳、還沒用過的。
async fn insert_message(
    conn: &mut SqliteConnection,
    thread_id: i64,
    viewer: &Viewer,
    from_admin: bool,
    body: &str,
    images: &[i64],
    ip: &str,
) -> Result<i64, AppError> {
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO feedback_messages (thread_id, from_admin, author_id, body, ip) VALUES (?, ?, ?, ?, ?) RETURNING id",
    )
    .bind(thread_id)
    .bind(from_admin)
    .bind(viewer.user_id())
    .bind(body)
    .bind(ip)
    .fetch_one(&mut *conn)
    .await?;
    let (user_id, guest) = viewer.author();
    for image in images {
        let attached = sqlx::query(
            "UPDATE feedback_images SET message_id = ?
             WHERE id = ? AND message_id IS NULL AND (user_id = ? OR guest = ?)",
        )
        .bind(id)
        .bind(image)
        .bind(user_id)
        .bind(guest)
        .execute(&mut *conn)
        .await?;
        if attached.rows_affected() == 0 {
            return Err(AppError::BadRequest("有圖片已經失效，請重新貼上".into()));
        }
    }
    let touch = if from_admin {
        "UPDATE feedback_threads SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), admin_seen = ? WHERE id = ?"
    } else {
        "UPDATE feedback_threads SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), user_seen = ? WHERE id = ?"
    };
    sqlx::query(touch).bind(id).bind(thread_id).execute(&mut *conn).await?;
    Ok(id)
}

// ---- 使用者 ----

/// 我的對話（帳號的，加上這個瀏覽器以訪客身分送出的）
pub async fn list_mine(
    State(state): State<AppState>,
    user: Option<CurrentUser>,
    headers: HeaderMap,
) -> Result<Json<Vec<Thread>>, AppError> {
    let viewer = Viewer::read(&state, user, &headers);
    if viewer.user.is_none() && viewer.guest.is_none() {
        return Ok(Json(Vec::new()));
    }
    let threads = sqlx::query_as::<_, Thread>(thread_query!(
        user,
        "WHERE t.user_id = ? OR t.guest = ? ORDER BY t.updated_at DESC, t.id DESC"
    ))
    .bind(viewer.user_id())
    .bind(&viewer.guest)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(threads))
}

#[derive(Serialize)]
pub struct Unread {
    /// 我的對話裡有幾串有管理員的新回覆
    pub mine: i64,
    /// 管理員才有：有幾串有使用者的新留言
    #[serde(skip_serializing_if = "Option::is_none")]
    pub admin: Option<i64>,
}

/// 頁首的紅點
pub async fn unread(
    State(state): State<AppState>,
    user: Option<CurrentUser>,
    headers: HeaderMap,
) -> Result<Json<Unread>, AppError> {
    let viewer = Viewer::read(&state, user, &headers);
    let mine = if viewer.user.is_none() && viewer.guest.is_none() {
        0
    } else {
        sqlx::query_scalar(
            "SELECT COUNT(*) FROM feedback_threads t
             WHERE (t.user_id = ? OR t.guest = ?)
               AND EXISTS (SELECT 1 FROM feedback_messages m WHERE m.thread_id = t.id AND m.from_admin AND m.id > t.user_seen)",
        )
        .bind(viewer.user_id())
        .bind(&viewer.guest)
        .fetch_one(&state.pool)
        .await?
    };
    let admin = if viewer.is_admin() {
        Some(
            sqlx::query_scalar(
                "SELECT COUNT(*) FROM feedback_threads t
                 WHERE EXISTS (SELECT 1 FROM feedback_messages m
                               WHERE m.thread_id = t.id AND NOT m.from_admin AND m.id > t.admin_seen)",
            )
            .fetch_one(&state.pool)
            .await?,
        )
    } else {
        None
    };
    Ok(Json(Unread { mine, admin }))
}

pub async fn create_thread(
    State(state): State<AppState>,
    user: Option<CurrentUser>,
    headers: HeaderMap,
    Json(input): Json<NewThread>,
) -> Result<Response, AppError> {
    let viewer = Viewer::write(&state, user, &headers)?;
    if !KINDS.contains(&input.kind.as_str()) {
        return Err(AppError::BadRequest("種類只能是回報或許願".into()));
    }
    let title = input.title.trim();
    if title.is_empty() {
        return Err(AppError::BadRequest("請輸入標題".into()));
    }
    if title.chars().count() > MAX_TITLE_LEN {
        return Err(AppError::BadRequest(format!("標題不可超過 {MAX_TITLE_LEN} 字")));
    }
    let body = validate_message(&input.message)?;
    let ip = client_key(&headers);
    if !viewer.is_admin() && count_recent!(&state.pool, "feedback_threads", &ip).await? >= MAX_THREADS_PER_DAY {
        return Err(AppError::TooManyRequests("今天送出太多了，請明天再試"));
    }

    let (user_id, guest) = viewer.author();
    let mut tx = state.pool.begin().await?;
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO feedback_threads (kind, title, user_id, guest, ip) VALUES (?, ?, ?, ?, ?) RETURNING id",
    )
    .bind(&input.kind)
    .bind(title)
    .bind(user_id)
    .bind(guest)
    .bind(&ip)
    .fetch_one(&mut *tx)
    .await?;
    insert_message(&mut tx, id, &viewer, false, body, &input.message.images, &ip).await?;
    tx.commit().await?;

    let conversation = user_conversation(&state.pool, id).await?;
    Ok(viewer.respond((StatusCode::CREATED, Json(conversation))))
}

async fn user_conversation(pool: &SqlitePool, id: i64) -> Result<Conversation<Thread>, AppError> {
    let thread = sqlx::query_as::<_, Thread>(thread_query!(user, "WHERE t.id = ?")).bind(id).fetch_one(pool).await?;
    Ok(Conversation { thread, messages: load_messages(pool, id).await? })
}

/// 確認是這個人的對話；不是的話一律當作不存在
async fn ensure_owner(pool: &SqlitePool, id: i64, viewer: &Viewer) -> Result<(), AppError> {
    if viewer.user.is_none() && viewer.guest.is_none() {
        return Err(AppError::NotFound);
    }
    sqlx::query_scalar::<_, i64>("SELECT id FROM feedback_threads WHERE id = ? AND (user_id = ? OR guest = ?)")
        .bind(id)
        .bind(viewer.user_id())
        .bind(&viewer.guest)
        .fetch_optional(pool)
        .await?
        .map(|_| ())
        .ok_or(AppError::NotFound)
}

/// 打開對話，順便標成已讀
pub async fn get_mine(
    State(state): State<AppState>,
    user: Option<CurrentUser>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Result<Json<Conversation<Thread>>, AppError> {
    let viewer = Viewer::read(&state, user, &headers);
    ensure_owner(&state.pool, id, &viewer).await?;
    mark_seen(&state.pool, id, false).await?;
    Ok(Json(user_conversation(&state.pool, id).await?))
}

/// 標成已讀到目前最後一則；`admin` 決定是管理員還是使用者這一邊
async fn mark_seen(pool: &SqlitePool, id: i64, admin: bool) -> Result<(), AppError> {
    let sql = if admin {
        "UPDATE feedback_threads
         SET admin_seen = (SELECT COALESCE(MAX(id), 0) FROM feedback_messages WHERE thread_id = ?) WHERE id = ?"
    } else {
        "UPDATE feedback_threads
         SET user_seen = (SELECT COALESCE(MAX(id), 0) FROM feedback_messages WHERE thread_id = ?) WHERE id = ?"
    };
    sqlx::query(sql).bind(id).bind(id).execute(pool).await?;
    Ok(())
}

/// 使用者留言；已結案的對話會重新打開
pub async fn reply_mine(
    State(state): State<AppState>,
    user: Option<CurrentUser>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(input): Json<NewMessage>,
) -> Result<Response, AppError> {
    let viewer = Viewer::write(&state, user, &headers)?;
    ensure_owner(&state.pool, id, &viewer).await?;
    let body = validate_message(&input)?;
    let ip = client_key(&headers);
    if !viewer.is_admin() && count_recent!(&state.pool, "feedback_messages", &ip).await? >= MAX_MESSAGES_PER_DAY {
        return Err(AppError::TooManyRequests("今天留言太多了，請明天再試"));
    }

    let mut tx = state.pool.begin().await?;
    insert_message(&mut tx, id, &viewer, false, body, &input.images, &ip).await?;
    sqlx::query("UPDATE feedback_threads SET status = 'open' WHERE id = ?").bind(id).execute(&mut *tx).await?;
    tx.commit().await?;
    let conversation = user_conversation(&state.pool, id).await?;
    Ok(viewer.respond(Json(conversation)))
}

// ---- 圖片 ----

/// 只收常見的點陣圖格式，看檔案開頭判斷，不信任 Content-Type（SVG 可以藏程式碼，不收）
fn sniff_image(data: &[u8]) -> Option<&'static str> {
    if data.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if data.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if data.len() >= 12 && &data[..4] == b"RIFF" && &data[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

#[derive(Serialize)]
pub struct UploadedImage {
    pub id: i64,
}

/// body 就是圖片檔本身。上限由路由的 DefaultBodyLimit 擋（[`MAX_IMAGE_BYTES`]）。
pub async fn upload_image(
    State(state): State<AppState>,
    user: Option<CurrentUser>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, AppError> {
    let viewer = Viewer::write(&state, user, &headers)?;
    let content_type = sniff_image(&body).ok_or(AppError::BadRequest("只能上傳 PNG、JPEG、GIF 或 WebP 圖片".into()))?;
    let ip = client_key(&headers);
    if !viewer.is_admin() && count_recent!(&state.pool, "feedback_images", &ip).await? >= MAX_IMAGES_PER_DAY {
        return Err(AppError::TooManyRequests("今天上傳太多圖片了，請明天再試"));
    }

    // 順便清掉一天前上傳卻沒送出的
    sqlx::query(concat!("DELETE FROM feedback_images WHERE message_id IS NULL AND created_at < ", a_day_ago!()))
        .execute(&state.pool)
        .await?;
    let (user_id, guest) = viewer.author();
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO feedback_images (user_id, guest, content_type, data, ip) VALUES (?, ?, ?, ?, ?) RETURNING id",
    )
    .bind(user_id)
    .bind(guest)
    .bind(content_type)
    .bind(body.as_ref())
    .bind(&ip)
    .fetch_one(&state.pool)
    .await?;
    Ok(viewer.respond((StatusCode::CREATED, Json(UploadedImage { id }))))
}

/// 看得到的人：管理員、上傳的人，以及圖片所在對話的發問者。其他人一律 404。
pub async fn image(
    State(state): State<AppState>,
    user: Option<CurrentUser>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Result<Response, AppError> {
    let viewer = Viewer::read(&state, user, &headers);
    let (content_type, data) = sqlx::query_as::<_, (String, Vec<u8>)>(
        "SELECT i.content_type, i.data FROM feedback_images i
         LEFT JOIN feedback_messages m ON m.id = i.message_id
         LEFT JOIN feedback_threads t ON t.id = m.thread_id
         WHERE i.id = ? AND (? OR i.user_id = ? OR i.guest = ? OR t.user_id = ? OR t.guest = ?)",
    )
    .bind(id)
    .bind(viewer.is_admin())
    .bind(viewer.user_id())
    .bind(&viewer.guest)
    .bind(viewer.user_id())
    .bind(&viewer.guest)
    .fetch_optional(&state.pool)
    .await?
    .ok_or(AppError::NotFound)?;
    Ok((
        [
            (header::CONTENT_TYPE, content_type),
            // 同一個 id 的內容不會變
            (header::CACHE_CONTROL, "private, max-age=31536000, immutable".into()),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff".into()),
        ],
        data,
    )
        .into_response())
}

// ---- 系統管理 ----

#[derive(Deserialize)]
pub struct ListQuery {
    /// open / closed；沒給就全部
    pub status: Option<String>,
}

pub async fn admin_list(
    State(state): State<AppState>,
    _: Require<AdminUsers>,
    Query(query): Query<ListQuery>,
) -> Result<Json<Vec<AdminThread>>, AppError> {
    let threads = sqlx::query_as::<_, AdminThread>(thread_query!(
        admin,
        "WHERE ?1 IS NULL OR t.status = ?1 ORDER BY t.updated_at DESC, t.id DESC LIMIT ?2"
    ))
    .bind(query.status.filter(|s| !s.is_empty()))
    .bind(MAX_LISTED)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(threads))
}

async fn admin_conversation(pool: &SqlitePool, id: i64) -> Result<Conversation<AdminThread>, AppError> {
    let thread = sqlx::query_as::<_, AdminThread>(thread_query!(admin, "WHERE t.id = ?"))
        .bind(id)
        .fetch_optional(pool)
        .await?
        .ok_or(AppError::NotFound)?;
    Ok(Conversation { thread, messages: load_messages(pool, id).await? })
}

pub async fn admin_get(
    State(state): State<AppState>,
    _: Require<AdminUsers>,
    Path(id): Path<i64>,
) -> Result<Json<Conversation<AdminThread>>, AppError> {
    mark_seen(&state.pool, id, true).await?;
    Ok(Json(admin_conversation(&state.pool, id).await?))
}

pub async fn admin_reply(
    State(state): State<AppState>,
    Require(me, _): Require<AdminUsers>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(input): Json<NewMessage>,
) -> Result<Json<Conversation<AdminThread>>, AppError> {
    let body = validate_message(&input)?;
    let viewer = Viewer::read(&state, Some(me), &headers);
    let mut tx = state.pool.begin().await?;
    let exists: Option<i64> =
        sqlx::query_scalar("SELECT id FROM feedback_threads WHERE id = ?").bind(id).fetch_optional(&mut *tx).await?;
    if exists.is_none() {
        return Err(AppError::NotFound);
    }
    insert_message(&mut tx, id, &viewer, true, body, &input.images, &client_key(&headers)).await?;
    tx.commit().await?;
    Ok(Json(admin_conversation(&state.pool, id).await?))
}

#[derive(Deserialize)]
pub struct StatusUpdate {
    pub status: String,
}

pub async fn admin_set_status(
    State(state): State<AppState>,
    _: Require<AdminUsers>,
    Path(id): Path<i64>,
    Json(input): Json<StatusUpdate>,
) -> Result<Json<Conversation<AdminThread>>, AppError> {
    if !["open", "closed"].contains(&input.status.as_str()) {
        return Err(AppError::BadRequest("狀態只能是 open 或 closed".into()));
    }
    let result = sqlx::query("UPDATE feedback_threads SET status = ? WHERE id = ?")
        .bind(&input.status)
        .bind(id)
        .execute(&state.pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    Ok(Json(admin_conversation(&state.pool, id).await?))
}

/// 刪掉整串（連同留言和圖片），給垃圾訊息用
pub async fn admin_delete(
    State(state): State<AppState>,
    _: Require<AdminUsers>,
    Path(id): Path<i64>,
) -> Result<StatusCode, AppError> {
    let result = sqlx::query("DELETE FROM feedback_threads WHERE id = ?").bind(id).execute(&state.pool).await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    Ok(StatusCode::NO_CONTENT)
}
