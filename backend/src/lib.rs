pub mod admin;
pub mod auth;
pub mod games;

use std::{
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use axum::{
    Json, Router,
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, patch, post},
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::SqlitePool;
use tower_http::{
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};

const MAX_MESSAGE_LEN: usize = 500;

#[derive(Clone)]
pub struct AppState {
    pub pool: SqlitePool,
    pub app_env: String,
    /// 建置時的 git commit，用來確認目前是哪一版在接流量
    pub commit: String,
    /// 收到 SIGTERM 後設為 true：health 回 503 讓 Traefik 移除這個容器，其他請求照常處理
    pub draining: Arc<AtomicBool>,
    /// 有 HTTPS 之後要設成 true，session cookie 才只會經由 HTTPS 傳送
    pub cookie_secure: bool,
    pub login_limiter: Arc<auth::LoginLimiter>,
    /// 小遊戲線上對戰的房間（只存在記憶體）
    pub rooms: Arc<games::Rooms>,
}

impl AppState {
    pub fn new(pool: SqlitePool, app_env: impl Into<String>, commit: impl Into<String>) -> Self {
        Self {
            pool,
            app_env: app_env.into(),
            commit: commit.into(),
            draining: Arc::default(),
            cookie_secure: false,
            login_limiter: Arc::default(),
            rooms: Arc::default(),
        }
    }
}

/// `/api/*` 走 JSON API，其他路徑交給 React 的靜態檔（找不到就回 index.html 讓前端路由處理）。
pub fn router(state: AppState, static_dir: &Path) -> Router {
    let api = Router::new()
        .route("/health", get(health))
        .route("/messages", get(list_messages).post(create_message))
        .route("/auth/login", post(auth::login))
        .route("/auth/logout", post(auth::logout))
        .route("/auth/me", get(auth::me))
        .route("/auth/password", post(auth::change_password))
        .route("/admin/users", get(admin::list_users).post(admin::create_user))
        .route("/admin/users/{id}", patch(admin::update_user))
        .route("/admin/roles", get(admin::list_roles))
        .route("/games/rooms", post(games::create_room))
        .route("/games/rooms/{code}/ws", get(games::connect))
        .fallback(api_not_found);

    let spa = ServeDir::new(static_dir).fallback(ServeFile::new(static_dir.join("index.html")));

    Router::new().nest("/api", api).fallback_service(spa).layer(TraceLayer::new_for_http()).with_state(state)
}

async fn health(State(state): State<AppState>) -> Response {
    let db_ok = sqlx::query("SELECT 1").execute(&state.pool).await.is_ok();
    let draining = state.draining.load(Ordering::Relaxed);
    let (status, label) = match (draining, db_ok) {
        (true, _) => (StatusCode::SERVICE_UNAVAILABLE, "draining"),
        (false, false) => (StatusCode::SERVICE_UNAVAILABLE, "degraded"),
        (false, true) => (StatusCode::OK, "ok"),
    };
    let body = json!({
        "status": label,
        "env": state.app_env,
        "version": env!("CARGO_PKG_VERSION"),
        "commit": state.commit,
        "db": db_ok,
    });
    (status, Json(body)).into_response()
}

/// 給 Docker healthcheck 用：distroless 沒有 curl，所以由程式自己打 /api/health。
pub fn healthcheck(port: u16) -> bool {
    let check = || -> std::io::Result<bool> {
        let addr = SocketAddr::from(([127, 0, 0, 1], port));
        let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(2))?;
        stream.set_read_timeout(Some(Duration::from_secs(2)))?;
        stream.write_all(b"GET /api/health HTTP/1.0\r\nHost: localhost\r\n\r\n")?;
        let mut status_line = [0u8; 12];
        stream.read_exact(&mut status_line)?;
        Ok(status_line.ends_with(b" 200"))
    };
    check().unwrap_or(false)
}

#[derive(Serialize, sqlx::FromRow)]
pub struct Message {
    pub id: i64,
    pub content: String,
    pub created_at: String,
}

#[derive(Deserialize)]
pub struct NewMessage {
    pub content: String,
}

async fn list_messages(State(state): State<AppState>) -> Result<Json<Vec<Message>>, AppError> {
    let messages =
        sqlx::query_as::<_, Message>("SELECT id, content, created_at FROM messages ORDER BY id DESC LIMIT 50")
            .fetch_all(&state.pool)
            .await?;
    Ok(Json(messages))
}

async fn create_message(
    State(state): State<AppState>,
    Json(input): Json<NewMessage>,
) -> Result<(StatusCode, Json<Message>), AppError> {
    let content = input.content.trim();
    if content.is_empty() {
        return Err(AppError::BadRequest("content 不可為空".into()));
    }
    if content.chars().count() > MAX_MESSAGE_LEN {
        return Err(AppError::BadRequest(format!("content 不可超過 {MAX_MESSAGE_LEN} 字")));
    }

    let message =
        sqlx::query_as::<_, Message>("INSERT INTO messages (content) VALUES (?) RETURNING id, content, created_at")
            .bind(content)
            .fetch_one(&state.pool)
            .await?;
    Ok((StatusCode::CREATED, Json(message)))
}

async fn api_not_found() -> AppError {
    AppError::NotFound
}

#[derive(Debug)]
pub enum AppError {
    BadRequest(String),
    Unauthorized(&'static str),
    Forbidden,
    NotFound,
    Conflict(String),
    TooManyRequests,
    ServiceUnavailable(&'static str),
    Database(sqlx::Error),
    Internal(String),
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BadRequest(message) | Self::Conflict(message) | Self::Internal(message) => f.write_str(message),
            Self::Unauthorized(message) | Self::ServiceUnavailable(message) => f.write_str(message),
            Self::Forbidden => f.write_str("沒有權限"),
            Self::NotFound => f.write_str("not found"),
            Self::TooManyRequests => f.write_str("嘗試次數過多，請 15 分鐘後再試"),
            Self::Database(err) => write!(f, "database error: {err}"),
        }
    }
}

impl std::error::Error for AppError {}

impl From<sqlx::Error> for AppError {
    fn from(err: sqlx::Error) -> Self {
        Self::Database(err)
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let status = match &self {
            Self::BadRequest(_) => StatusCode::BAD_REQUEST,
            Self::Unauthorized(_) => StatusCode::UNAUTHORIZED,
            Self::Forbidden => StatusCode::FORBIDDEN,
            Self::NotFound => StatusCode::NOT_FOUND,
            Self::Conflict(_) => StatusCode::CONFLICT,
            Self::TooManyRequests => StatusCode::TOO_MANY_REQUESTS,
            Self::ServiceUnavailable(_) => StatusCode::SERVICE_UNAVAILABLE,
            Self::Database(_) | Self::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        };
        let message = if status == StatusCode::INTERNAL_SERVER_ERROR {
            tracing::error!(error = %self, "internal error");
            "internal server error".to_owned()
        } else {
            self.to_string()
        };
        (status, Json(json!({ "error": message }))).into_response()
    }
}
