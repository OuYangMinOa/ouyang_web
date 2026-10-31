//! 自行註冊：訪客送出申請，管理員在系統管理裡核准後才建立帳號。
//!
//! 註冊入口可以由管理員開關（`site_settings.registration_open`），關閉時前端不顯示註冊按鈕，後端也拒收。
//! 申請時就先把密碼雜湊好存起來，核准時直接搬進 users，管理員不會經手密碼。

use axum::{
    Json,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::{
    AppError, AppState,
    auth::{AdminUsers, Require, client_key, hash_password, validate_password, validate_username},
};

const OPEN_KEY: &str = "registration_open";
const MAX_NOTE_LEN: usize = 200;
/// 同一個 IP 一天內最多送幾次申請；待審核的總數也有上限，避免有人灌爆資料庫
const MAX_PER_IP_PER_DAY: i64 = 3;
const MAX_PENDING: i64 = 100;
/// 管理頁列出最近審核過的幾筆
const MAX_REVIEWED: i64 = 50;

async fn is_open(pool: &SqlitePool) -> Result<bool, AppError> {
    let value: Option<String> =
        sqlx::query_scalar("SELECT value FROM site_settings WHERE key = ?").bind(OPEN_KEY).fetch_optional(pool).await?;
    Ok(value.as_deref() == Some("1"))
}

#[derive(Serialize)]
pub struct RegistrationStatus {
    pub open: bool,
}

/// 前端用來決定要不要顯示註冊按鈕
pub async fn status(State(state): State<AppState>) -> Result<Json<RegistrationStatus>, AppError> {
    Ok(Json(RegistrationStatus { open: is_open(&state.pool).await? }))
}

#[derive(Deserialize)]
pub struct NewRegistration {
    pub username: String,
    pub password: String,
    #[serde(default)]
    pub note: String,
}

pub async fn register(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<NewRegistration>,
) -> Result<StatusCode, AppError> {
    if !is_open(&state.pool).await? {
        return Err(AppError::BadRequest("目前不開放註冊".into()));
    }
    let username = input.username.trim();
    validate_username(username)?;
    validate_password(&input.password)?;
    let note = input.note.trim();
    if note.chars().count() > MAX_NOTE_LEN {
        return Err(AppError::BadRequest(format!("備註不可超過 {MAX_NOTE_LEN} 字")));
    }

    let ip = client_key(&headers);
    let recent: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM registrations WHERE ip = ? AND created_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 day')",
    )
    .bind(&ip)
    .fetch_one(&state.pool)
    .await?;
    if recent >= MAX_PER_IP_PER_DAY {
        return Err(AppError::TooManyRequests("申請次數過多，請明天再試"));
    }
    let pending: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM registrations WHERE status = 'pending'")
        .fetch_one(&state.pool)
        .await?;
    if pending >= MAX_PENDING {
        return Err(AppError::ServiceUnavailable("待審核的申請太多，請稍後再試"));
    }
    let taken: Option<i64> = sqlx::query_scalar("SELECT id FROM users WHERE username = ?")
        .bind(username)
        .fetch_optional(&state.pool)
        .await?;
    if taken.is_some() {
        return Err(AppError::Conflict("帳號已存在".into()));
    }

    let hash = hash_password(input.password).await?;
    sqlx::query("INSERT INTO registrations (username, password_hash, note, ip) VALUES (?, ?, ?, ?)")
        .bind(username)
        .bind(hash)
        .bind(note)
        .bind(&ip)
        .execute(&state.pool)
        .await
        .map_err(|err| match err {
            sqlx::Error::Database(ref db) if db.is_unique_violation() => {
                AppError::Conflict("這個帳號已經有人申請，正在等待審核".into())
            }
            err => err.into(),
        })?;
    Ok(StatusCode::CREATED)
}

// ---- 系統管理 ----

#[derive(Serialize, sqlx::FromRow)]
pub struct Registration {
    pub id: i64,
    pub username: String,
    pub note: String,
    pub ip: String,
    pub status: String,
    pub created_at: String,
    pub reviewed_at: Option<String>,
    /// 審核的管理員帳號
    pub reviewer: Option<String>,
}

/// 申請連同審核者帳號的查詢，後面接上 WHERE / ORDER BY
macro_rules! registration_query {
    ($tail:literal) => {
        concat!(
            "SELECT r.id, r.username, r.note, r.ip, r.status, r.created_at, r.reviewed_at, u.username AS reviewer
             FROM registrations r LEFT JOIN users u ON u.id = r.reviewed_by ",
            $tail
        )
    };
}

#[derive(Serialize)]
pub struct RegistrationReport {
    pub open: bool,
    pub pending: Vec<Registration>,
    pub reviewed: Vec<Registration>,
}

pub async fn list(State(state): State<AppState>, _: Require<AdminUsers>) -> Result<Json<RegistrationReport>, AppError> {
    let pending = sqlx::query_as::<_, Registration>(registration_query!("WHERE r.status = 'pending' ORDER BY r.id"))
        .fetch_all(&state.pool)
        .await?;
    let reviewed = sqlx::query_as::<_, Registration>(registration_query!(
        "WHERE r.status != 'pending' ORDER BY r.reviewed_at DESC, r.id DESC LIMIT ?"
    ))
    .bind(MAX_REVIEWED)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(RegistrationReport { open: is_open(&state.pool).await?, pending, reviewed }))
}

#[derive(Deserialize)]
pub struct OpenUpdate {
    pub open: bool,
}

pub async fn set_open(
    State(state): State<AppState>,
    _: Require<AdminUsers>,
    Json(input): Json<OpenUpdate>,
) -> Result<Json<RegistrationStatus>, AppError> {
    sqlx::query(
        "INSERT INTO site_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    )
    .bind(OPEN_KEY)
    .bind(if input.open { "1" } else { "0" })
    .execute(&state.pool)
    .await?;
    Ok(Json(RegistrationStatus { open: input.open }))
}

async fn fetch(pool: &SqlitePool, id: i64) -> Result<Registration, AppError> {
    sqlx::query_as::<_, Registration>(registration_query!("WHERE r.id = ?"))
        .bind(id)
        .fetch_optional(pool)
        .await?
        .ok_or(AppError::NotFound)
}

/// 核准：用申請時的密碼建立帳號（沒有任何角色，需要的話再到「使用者」指派）
pub async fn approve(
    State(state): State<AppState>,
    Require(me, _): Require<AdminUsers>,
    Path(id): Path<i64>,
) -> Result<Json<Registration>, AppError> {
    let mut tx = state.pool.begin().await?;
    let (username, hash) = sqlx::query_as::<_, (String, String)>(
        "SELECT username, password_hash FROM registrations WHERE id = ? AND status = 'pending'",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(AppError::NotFound)?;
    sqlx::query("INSERT INTO users (username, password_hash) VALUES (?, ?)")
        .bind(&username)
        .bind(hash)
        .execute(&mut *tx)
        .await
        .map_err(|err| match err {
            sqlx::Error::Database(ref db) if db.is_unique_violation() => {
                AppError::Conflict(format!("帳號 {username} 已存在，請拒絕這筆申請"))
            }
            err => err.into(),
        })?;
    mark_reviewed(&mut tx, id, "approved", me.id).await?;
    tx.commit().await?;
    Ok(Json(fetch(&state.pool, id).await?))
}

pub async fn reject(
    State(state): State<AppState>,
    Require(me, _): Require<AdminUsers>,
    Path(id): Path<i64>,
) -> Result<Json<Registration>, AppError> {
    let mut conn = state.pool.acquire().await?;
    if !mark_reviewed(&mut conn, id, "rejected", me.id).await? {
        return Err(AppError::NotFound);
    }
    drop(conn);
    Ok(Json(fetch(&state.pool, id).await?))
}

/// 只處理還在待審核的申請，回傳有沒有改到；審核完就不再保留密碼雜湊
async fn mark_reviewed(
    conn: &mut sqlx::SqliteConnection,
    id: i64,
    status: &str,
    reviewer: i64,
) -> Result<bool, AppError> {
    let result = sqlx::query(
        "UPDATE registrations
         SET status = ?, password_hash = '', reviewed_by = ?, reviewed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
         WHERE id = ? AND status = 'pending'",
    )
    .bind(status)
    .bind(reviewer)
    .bind(id)
    .execute(conn)
    .await?;
    Ok(result.rows_affected() > 0)
}
