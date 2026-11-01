//! 帳號密碼登入、session cookie 與權限檢查。
//!
//! 權限模型：使用者 ─ 角色 ─ 權限（見 migrations/0002_create_auth.sql）。
//! 新的 APP 在 migration 裡登記自己的權限並授權給角色，再定義一個 [`Permission`]，
//! handler 用 `Require<那個權限>` 當參數就會自動檢查：沒登入回 401、沒權限回 403。

use std::{
    collections::HashMap,
    marker::PhantomData,
    sync::{LazyLock, Mutex},
    time::{Duration, Instant},
};

use argon2::{
    Argon2,
    password_hash::{PasswordHasher, PasswordVerifier, phc::PasswordHash},
};
use axum::{
    Json,
    extract::{FromRequestParts, OptionalFromRequestParts, State},
    http::{HeaderMap, StatusCode, header, request::Parts},
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use tokio::sync::Semaphore;

use crate::{AppError, AppState};

const SESSION_DAYS: i64 = 7;
const MIN_PASSWORD_LEN: usize = 8;
const MAX_PASSWORD_LEN: usize = 128;
const MAX_LOGIN_FAILURES: u32 = 10;
const LOGIN_WINDOW: Duration = Duration::from_secs(15 * 60);

pub trait Permission {
    const NAME: &'static str;
}

/// 管理使用者、重設密碼、指派角色
pub struct AdminUsers;
impl Permission for AdminUsers {
    const NAME: &'static str = "admin.users";
}

#[derive(Serialize)]
pub struct CurrentUser {
    pub id: i64,
    pub username: String,
    pub roles: Vec<String>,
    pub permissions: Vec<String>,
    /// 目前這個 session 的 token 雜湊（改密碼時保留這個 session、登出其他裝置）
    #[serde(skip)]
    session: String,
}

impl CurrentUser {
    pub fn has(&self, permission: &str) -> bool {
        self.permissions.iter().any(|p| p == permission)
    }
}

impl FromRequestParts<AppState> for CurrentUser {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, AppError> {
        let token = read_session_token(&parts.headers, &state.session_cookie_name())
            .ok_or(AppError::Unauthorized("請先登入"))?;
        let session = token_hash(&token);
        let (id, username) = sqlx::query_as::<_, (i64, String)>(
            "SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id
             WHERE s.token_hash = ? AND s.expires_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now') AND NOT u.disabled",
        )
        .bind(&session)
        .fetch_optional(&state.pool)
        .await?
        .ok_or(AppError::Unauthorized("請先登入"))?;

        let mut user = load_user(&state.pool, id, username).await?;
        user.session = session;
        Ok(user)
    }
}

/// 登入與否都可以用的 handler 拿 `Option<CurrentUser>`：沒登入是 None，資料庫錯誤才會失敗。
impl OptionalFromRequestParts<AppState> for CurrentUser {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Option<Self>, AppError> {
        match <Self as FromRequestParts<AppState>>::from_request_parts(parts, state).await {
            Ok(user) => Ok(Some(user)),
            Err(AppError::Unauthorized(_)) => Ok(None),
            Err(err) => Err(err),
        }
    }
}

/// 要求登入且擁有權限 `P`，例如 `Require(user, _): Require<AdminUsers>`。
pub struct Require<P>(pub CurrentUser, pub PhantomData<P>);

impl<P: Permission + Send + Sync> FromRequestParts<AppState> for Require<P> {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, AppError> {
        let user = <CurrentUser as FromRequestParts<AppState>>::from_request_parts(parts, state).await?;
        if !user.has(P::NAME) {
            return Err(AppError::Forbidden);
        }
        Ok(Self(user, PhantomData))
    }
}

async fn load_user(pool: &SqlitePool, id: i64, username: String) -> Result<CurrentUser, sqlx::Error> {
    let roles = sqlx::query_scalar(
        "SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ? ORDER BY r.name",
    )
    .bind(id)
    .fetch_all(pool)
    .await?;
    let permissions = sqlx::query_scalar(
        "SELECT DISTINCT rp.permission FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id
         WHERE ur.user_id = ? ORDER BY rp.permission",
    )
    .bind(id)
    .fetch_all(pool)
    .await?;
    Ok(CurrentUser { id, username, roles, permissions, session: String::new() })
}

// ---- 密碼 ----

/// argon2 每次約用 19 MiB 記憶體，限制同時計算的數量，避免大量登入請求撐爆容器的記憶體上限
static HASHING: Semaphore = Semaphore::const_new(2);

/// 帳號不存在時也拿這個跑一次驗證，回應時間才不會透露帳號是否存在
static DUMMY_HASH: LazyLock<String> =
    LazyLock::new(|| hash_blocking("not a real password").expect("hash dummy password"));

fn hash_blocking(password: &str) -> Result<String, AppError> {
    Argon2::default()
        .hash_password(password.as_bytes())
        .map(|hash| hash.to_string())
        .map_err(|err| AppError::Internal(format!("hash password: {err}")))
}

pub async fn hash_password(password: String) -> Result<String, AppError> {
    let _permit = HASHING.acquire().await.expect("semaphore is never closed");
    tokio::task::spawn_blocking(move || hash_blocking(&password))
        .await
        .map_err(|err| AppError::Internal(err.to_string()))?
}

async fn verify_password(password: String, hash: Option<String>) -> bool {
    let _permit = HASHING.acquire().await.expect("semaphore is never closed");
    tokio::task::spawn_blocking(move || {
        let exists = hash.is_some();
        let hash = hash.unwrap_or_else(|| DUMMY_HASH.clone());
        let valid = PasswordHash::new(&hash)
            .is_ok_and(|parsed| Argon2::default().verify_password(password.as_bytes(), &parsed).is_ok());
        exists && valid
    })
    .await
    .unwrap_or(false)
}

pub fn validate_password(password: &str) -> Result<(), AppError> {
    let len = password.chars().count();
    if !(MIN_PASSWORD_LEN..=MAX_PASSWORD_LEN).contains(&len) {
        return Err(AppError::BadRequest(format!("密碼長度需為 {MIN_PASSWORD_LEN}–{MAX_PASSWORD_LEN} 字")));
    }
    Ok(())
}

pub fn validate_username(username: &str) -> Result<(), AppError> {
    let valid =
        (3..=32).contains(&username.len()) && username.chars().all(|c| c.is_ascii_alphanumeric() || "_.-".contains(c));
    if !valid {
        return Err(AppError::BadRequest("帳號需為 3–32 個英數字或 _ . -".into()));
    }
    Ok(())
}

/// `backend create-admin <帳號>` 用：建立管理員；帳號已存在就重設密碼、重新啟用並加回 admin 角色（救援用）。
pub async fn upsert_admin(pool: &SqlitePool, username: &str, password: String) -> Result<(), AppError> {
    validate_username(username)?;
    validate_password(&password)?;
    let hash = hash_password(password).await?;

    let mut tx = pool.begin().await?;
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO users (username, password_hash) VALUES (?, ?)
         ON CONFLICT (username) DO UPDATE SET password_hash = excluded.password_hash, disabled = 0
         RETURNING id",
    )
    .bind(username)
    .bind(hash)
    .fetch_one(&mut *tx)
    .await?;
    sqlx::query("INSERT OR IGNORE INTO user_roles (user_id, role_id) SELECT ?, id FROM roles WHERE name = 'admin'")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM sessions WHERE user_id = ?").bind(id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

// ---- session ----

pub(crate) fn random_token() -> Result<String, AppError> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|err| AppError::Internal(format!("getrandom: {err}")))?;
    Ok(hex(&bytes))
}

pub(crate) fn token_hash(token: &str) -> String {
    hex(&Sha256::digest(token.as_bytes()))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

impl AppState {
    /// staging 和 prod 目前是同一個 IP 的不同 port，而 cookie 不分 port，名稱帶上環境才不會互相覆蓋
    pub(crate) fn session_cookie_name(&self) -> String {
        format!("session_{}", self.app_env)
    }

    fn session_cookie(&self, token: &str, max_age: i64) -> String {
        let secure = if self.cookie_secure { "; Secure" } else { "" };
        format!("{}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age}{secure}", self.session_cookie_name())
    }
}

pub(crate) fn read_session_token(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(key, value)| *key == name && !value.is_empty())
        .map(|(_, value)| value.to_owned())
}

// ---- 登入失敗限制 ----

/// 同一個來源 IP 在 15 分鐘內失敗 10 次就暫停登入。只存在記憶體：換版或重啟會歸零，
/// 換版期間新舊容器各算各的，對擋暴力破解來說夠用。
#[derive(Default)]
pub struct LoginLimiter {
    failures: Mutex<HashMap<String, (u32, Instant)>>,
}

impl LoginLimiter {
    fn blocked(&self, key: &str) -> bool {
        let failures = self.failures.lock().unwrap();
        failures.get(key).is_some_and(|(count, since)| *count >= MAX_LOGIN_FAILURES && since.elapsed() < LOGIN_WINDOW)
    }

    fn record_failure(&self, key: &str) {
        let mut failures = self.failures.lock().unwrap();
        if failures.len() > 10_000 {
            failures.retain(|_, (_, since)| since.elapsed() < LOGIN_WINDOW);
        }
        let entry = failures.entry(key.to_owned()).or_insert((0, Instant::now()));
        if entry.1.elapsed() >= LOGIN_WINDOW {
            *entry = (0, Instant::now());
        }
        entry.0 += 1;
    }

    fn clear(&self, key: &str) {
        self.failures.lock().unwrap().remove(key);
    }
}

/// 對外流量一律經過 Traefik：它不信任客戶端送來的 X-Forwarded-For，會改成真正的來源 IP
pub(crate) fn client_key(headers: &HeaderMap) -> String {
    headers
        .get("x-forwarded-for")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.rsplit(',').next())
        .map(|ip| ip.trim().to_owned())
        .unwrap_or_else(|| "local".into())
}

// ---- handlers ----

#[derive(Deserialize)]
pub struct Credentials {
    pub username: String,
    pub password: String,
}

pub async fn login(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<Credentials>,
) -> Result<Response, AppError> {
    let key = client_key(&headers);
    if state.login_limiter.blocked(&key) {
        return Err(AppError::TooManyRequests("嘗試次數過多，請 15 分鐘後再試"));
    }

    let row = sqlx::query_as::<_, (i64, String, String, bool)>(
        "SELECT id, username, password_hash, disabled FROM users WHERE username = ?",
    )
    .bind(input.username.trim())
    .fetch_optional(&state.pool)
    .await?;
    let valid = verify_password(input.password, row.as_ref().map(|r| r.2.clone())).await;
    let (id, username) = match row {
        Some((id, username, _, false)) if valid => (id, username),
        _ => {
            state.login_limiter.record_failure(&key);
            return Err(AppError::Unauthorized("帳號或密碼錯誤"));
        }
    };
    state.login_limiter.clear(&key);

    let token = random_token()?;
    sqlx::query("DELETE FROM sessions WHERE expires_at <= strftime('%Y-%m-%dT%H:%M:%SZ', 'now')")
        .execute(&state.pool)
        .await?;
    sqlx::query(
        "INSERT INTO sessions (token_hash, user_id, expires_at)
         VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?))",
    )
    .bind(token_hash(&token))
    .bind(id)
    .bind(format!("+{SESSION_DAYS} days"))
    .execute(&state.pool)
    .await?;
    sqlx::query("UPDATE users SET last_login_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?")
        .bind(id)
        .execute(&state.pool)
        .await?;

    let user = load_user(&state.pool, id, username).await?;
    let cookie = state.session_cookie(&token, SESSION_DAYS * 24 * 60 * 60);
    Ok(([(header::SET_COOKIE, cookie)], Json(user)).into_response())
}

pub async fn logout(State(state): State<AppState>, headers: HeaderMap) -> Result<Response, AppError> {
    if let Some(token) = read_session_token(&headers, &state.session_cookie_name()) {
        sqlx::query("DELETE FROM sessions WHERE token_hash = ?").bind(token_hash(&token)).execute(&state.pool).await?;
    }
    Ok((StatusCode::NO_CONTENT, [(header::SET_COOKIE, state.session_cookie("", 0))]).into_response())
}

pub async fn me(user: CurrentUser) -> Json<CurrentUser> {
    Json(user)
}

#[derive(Deserialize)]
pub struct PasswordChange {
    pub current_password: String,
    pub new_password: String,
}

pub async fn change_password(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(input): Json<PasswordChange>,
) -> Result<StatusCode, AppError> {
    validate_password(&input.new_password)?;
    let current: String =
        sqlx::query_scalar("SELECT password_hash FROM users WHERE id = ?").bind(user.id).fetch_one(&state.pool).await?;
    if !verify_password(input.current_password, Some(current)).await {
        return Err(AppError::BadRequest("目前的密碼不正確".into()));
    }

    let hash = hash_password(input.new_password).await?;
    sqlx::query("UPDATE users SET password_hash = ? WHERE id = ?")
        .bind(hash)
        .bind(user.id)
        .execute(&state.pool)
        .await?;
    // 其他裝置上的登入一併失效
    sqlx::query("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?")
        .bind(user.id)
        .bind(&user.session)
        .execute(&state.pool)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}
