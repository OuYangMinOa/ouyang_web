pub mod access_log;
pub mod admin;
pub mod antique;
pub mod arena;
pub mod auth;
pub mod bigtwo;
pub mod calendar;
pub mod draw;
pub mod feedback;
pub mod game_monitor;
pub mod game_settings;
pub mod games;
pub mod honeypot;
pub mod invoice;
pub mod justone;
pub mod lobby;
pub mod minesrace;
pub mod monitor;
pub mod music;
pub mod nav_pins;
pub mod party;
pub mod poker;
pub mod puyo;
pub mod puyo_scores;
pub mod registration;
pub mod short_links;
pub mod telephone;
pub mod tetris;
pub mod tetris_scores;
pub mod threads;
pub mod undercover;
pub mod uno;
pub mod visits;
pub mod weather;
pub mod youtube;

use std::{
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Request, State},
    http::StatusCode,
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{delete, get, patch, post, put},
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
    /// 小遊戲線上對戰中有人連線的房間（房間本身存在資料庫）
    pub rooms: Arc<games::Rooms>,
    /// 俄羅斯方塊大逃殺的房間（只在記憶體裡）
    pub tetris: Arc<arena::Arenas<tetris::Tetris>>,
    pub puyo: Arc<arena::Arenas<puyo::Puyo>>,
    /// 派對遊戲的房間（只在記憶體裡，見 party.rs）
    pub undercover: Arc<party::Parties<undercover::Undercover>>,
    pub bigtwo: Arc<party::Parties<bigtwo::BigTwo>>,
    pub minesrace: Arc<party::Parties<minesrace::MinesRace>>,
    pub draw: Arc<party::Parties<draw::Draw>>,
    pub antique: Arc<party::Parties<antique::Antique>>,
    pub uno: Arc<party::Parties<uno::Uno>>,
    pub justone: Arc<party::Parties<justone::JustOne>>,
    pub telephone: Arc<party::Parties<telephone::Telephone>>,
    pub poker: Arc<party::Parties<poker::Poker>>,
    /// 遊戲室：同一群人換著玩不同遊戲（只在記憶體裡，見 lobby.rs）
    pub lobbies: Arc<lobby::Lobbies>,
    /// 俄羅斯方塊單人模式進行中的局（上傳排行榜前檢查中間態用）
    pub tetris_runs: Arc<tetris_scores::Runs>,
    /// 魔法氣泡單人模式進行中的局
    pub puyo_runs: Arc<puyo_scores::Runs>,
    /// 音樂資料夾（唯讀），見 music.rs
    pub music_dir: PathBuf,
    /// 天氣與環境：外部資料的快取，以及地震速報的即時連線
    pub weather: Arc<weather::Weather>,
    /// 統一發票中獎號碼的快取（見 invoice.rs）
    pub invoice: Arc<invoice::Invoice>,
    pub visit_limiter: Arc<visits::VisitLimiter>,
    /// 假的 `.env` 每個 IP 最多記幾筆（見 honeypot.rs）
    pub honeypot_limiter: Arc<visits::VisitLimiter>,
    /// 全站的 IP 訪問紀錄，背景整批寫進資料庫（見 access_log.rs）
    pub access_log: Arc<access_log::AccessLog>,
    /// 主機監控：背景取樣的 CPU、記憶體、磁碟和各服務的用量（見 monitor.rs）
    pub monitor: Arc<monitor::Monitor>,
    /// Threads 影片下載的 HTTP client 和每個 IP 的查詢間隔（見 threads.rs）
    pub threads: Arc<threads::Threads>,
    /// YouTube 影片下載：yt-dlp 下載好的暫存檔（見 youtube.rs）
    pub youtube: Arc<youtube::YouTube>,
    /// 短網址每個 IP 最多記幾次點擊（見 short_links.rs）
    pub short_link_limiter: Arc<visits::VisitLimiter>,
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
            tetris: Arc::default(),
            puyo: Arc::default(),
            undercover: Arc::default(),
            bigtwo: Arc::default(),
            minesrace: Arc::default(),
            draw: Arc::default(),
            antique: Arc::default(),
            uno: Arc::default(),
            justone: Arc::default(),
            telephone: Arc::default(),
            poker: Arc::default(),
            lobbies: Arc::default(),
            tetris_runs: Arc::default(),
            puyo_runs: Arc::default(),
            music_dir: PathBuf::from("data/music"),
            weather: Arc::default(),
            invoice: Arc::default(),
            visit_limiter: Arc::default(),
            honeypot_limiter: Arc::default(),
            access_log: Arc::default(),
            monitor: Arc::default(),
            threads: Arc::default(),
            youtube: Arc::default(),
            short_link_limiter: Arc::default(),
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
        .route("/auth/register", get(registration::status).post(registration::register))
        .route("/admin/users", get(admin::list_users).post(admin::create_user))
        .route("/admin/users/{id}", patch(admin::update_user))
        .route("/admin/roles", get(admin::list_roles))
        .route("/admin/registrations", get(registration::list))
        .route("/admin/registrations/open", put(registration::set_open))
        .route("/admin/registrations/{id}/approve", post(registration::approve))
        .route("/admin/registrations/{id}/reject", post(registration::reject))
        .route("/admin/access", get(access_log::report))
        .route("/admin/access/requests", get(access_log::requests))
        .route("/admin/honeypot", get(honeypot::report))
        .route("/admin/honeypot/hits", get(honeypot::hits))
        .route("/admin/feedback", get(feedback::admin_list))
        .route("/admin/feedback/{id}", get(feedback::admin_get).delete(feedback::admin_delete))
        .route("/admin/feedback/{id}/messages", post(feedback::admin_reply))
        .route("/admin/feedback/{id}/status", put(feedback::admin_set_status))
        .route("/admin/games", get(game_monitor::report))
        .route("/admin/system", get(monitor::status))
        .route("/admin/system/history", get(monitor::history))
        .route("/admin/system/targets", post(monitor::create_target))
        .route("/admin/system/targets/{id}", delete(monitor::delete_target))
        .route("/admin/visits/{page}", get(visits::list_sessions))
        .route("/admin/visits/{page}/{session}", get(visits::session_events))
        .route("/visits/{page}", post(visits::track))
        .route("/feedback", get(feedback::list_mine).post(feedback::create_thread))
        .route("/feedback/unread", get(feedback::unread))
        .route("/feedback/images", post(feedback::upload_image).layer(DefaultBodyLimit::max(feedback::MAX_IMAGE_BYTES)))
        .route("/feedback/images/{id}", get(feedback::image))
        .route("/feedback/{id}", get(feedback::get_mine))
        .route("/feedback/{id}/messages", post(feedback::reply_mine))
        .route("/calendar/events", get(calendar::list_events).post(calendar::create_event))
        .route("/calendar/events/{id}", put(calendar::update_event).delete(calendar::delete_event))
        .route("/games/rooms", post(games::create_room))
        .route("/games/rooms/{code}/ws", get(games::connect))
        .route("/games/tetris/rooms", post(arena::create_arena::<tetris::Tetris>))
        .route("/games/tetris/rooms/{code}/ws", get(arena::connect::<tetris::Tetris>))
        .route("/games/tetris/scores", get(tetris_scores::list_scores))
        .route("/games/tetris/runs", post(tetris_scores::start_run))
        .route("/games/tetris/runs/{id}/checkpoints", post(tetris_scores::checkpoint))
        .route("/games/tetris/runs/{id}/finish", post(tetris_scores::finish_run))
        .route("/games/tetris/settings", get(game_settings::get_tetris).put(game_settings::put_tetris))
        .route(
            "/games/tetris/handling",
            get(game_settings::get_tetris_handling).put(game_settings::put_tetris_handling),
        )
        .route("/games/puyo/rooms", post(arena::create_arena::<puyo::Puyo>))
        .route("/games/puyo/rooms/{code}/ws", get(arena::connect::<puyo::Puyo>))
        .route("/games/puyo/scores", get(puyo_scores::list_scores))
        .route("/games/puyo/runs", post(puyo_scores::start_run))
        .route("/games/puyo/runs/{id}/checkpoints", post(puyo_scores::checkpoint))
        .route("/games/puyo/runs/{id}/finish", post(puyo_scores::finish_run))
        .route("/games/puyo/settings", get(game_settings::get_puyo).put(game_settings::put_puyo))
        .route("/games/undercover/party", post(party::create::<undercover::Undercover>))
        .route("/games/undercover/party/{code}/ws", get(party::connect::<undercover::Undercover>))
        .route("/games/bigtwo/party", post(party::create::<bigtwo::BigTwo>))
        .route("/games/bigtwo/party/{code}/ws", get(party::connect::<bigtwo::BigTwo>))
        .route("/games/minesrace/party", post(party::create::<minesrace::MinesRace>))
        .route("/games/minesrace/party/{code}/ws", get(party::connect::<minesrace::MinesRace>))
        .route("/games/draw/party", post(party::create::<draw::Draw>))
        .route("/games/draw/party/{code}/ws", get(party::connect::<draw::Draw>))
        .route("/games/antique/party", post(party::create::<antique::Antique>))
        .route("/games/antique/party/{code}/ws", get(party::connect::<antique::Antique>))
        .route("/games/uno/party", post(party::create::<uno::Uno>))
        .route("/games/uno/party/{code}/ws", get(party::connect::<uno::Uno>))
        .route("/games/justone/party", post(party::create::<justone::JustOne>))
        .route("/games/justone/party/{code}/ws", get(party::connect::<justone::JustOne>))
        .route("/games/telephone/party", post(party::create::<telephone::Telephone>))
        .route("/games/telephone/party/{code}/ws", get(party::connect::<telephone::Telephone>))
        .route("/games/poker/party", post(party::create::<poker::Poker>))
        .route("/games/poker/party/{code}/ws", get(party::connect::<poker::Poker>))
        .route("/games/lobby", post(lobby::create))
        .route("/games/lobby/{code}/ws", get(lobby::connect))
        .route("/music", get(music::list_tracks))
        .route("/music/files/{name}", get(music::track_file))
        .route("/music/s/{alias}", get(music::shared_file))
        .route("/weather/forecast", get(weather::forecast::forecast))
        .route("/weather/typhoons", get(weather::typhoon::typhoons))
        .route("/weather/typhoon-names", get(weather::typhoon_names::names))
        .route("/weather/quakes", get(weather::quake::quakes))
        .route("/weather/quakes/ws", get(weather::quake::connect))
        .route("/invoice/winning", get(invoice::winning))
        .route("/threads/video", get(threads::video))
        .route("/threads/setup", get(threads::setup))
        .route("/threads/setup/key", post(threads::reset_key))
        .route("/threads/setup/shortcut", put(threads::set_shortcut))
        .route("/threads/downloads", get(threads::downloads))
        .route("/threads/downloads/{id}", delete(threads::delete_download))
        .route("/threads/files/{token}", get(youtube::file))
        .route("/links", get(short_links::list).post(short_links::create))
        .route("/links/{id}", get(short_links::get).put(short_links::update).delete(short_links::delete))
        .route("/links/{id}/stats", get(short_links::stats))
        .route("/nav/pins", get(nav_pins::list))
        .route("/nav/pins/{app}", put(nav_pins::set))
        .fallback(api_not_found);

    // 打包時已經把較大的檔案另存一份 .gz（Dockerfile），瀏覽器支援 gzip 就直接送那份
    let files = ServeDir::new(static_dir)
        .precompressed_gzip()
        .fallback(ServeFile::new(static_dir.join("index.html")).precompressed_gzip());
    let spa = Router::new().fallback_service(files).layer(middleware::from_fn(hide_dot_paths));

    let recorder = access_log::Recorder::new(state.clone(), static_dir);
    Router::new()
        .nest("/api", api)
        // 短網址不放在 /api 底下，網址才短
        .route("/s/{code}", get(short_links::follow))
        .fallback_service(spa)
        // 在 /api 和前端之前攔下 `.env`（含 `/api/.env`），IP 訪問紀錄在外層，所以也會記到
        .layer(middleware::from_fn_with_state(state.clone(), honeypot::intercept))
        .layer(middleware::from_fn_with_state(recorder, access_log::record))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
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

/// 掃描器常找 `/.git/config`、`/.vscode/sftp.json`：前端不會有點開頭的路徑，直接 404，不要回 index.html 讓它們以為找到東西。
/// `.env` 在更外層就被 `honeypot::intercept` 攔下來回假檔案，不會走到這裡。
async fn hide_dot_paths(request: Request, next: Next) -> Response {
    if request.uri().path().split('/').any(|segment| segment.starts_with('.')) {
        return StatusCode::NOT_FOUND.into_response();
    }
    next.run(request).await
}

#[derive(Debug)]
pub enum AppError {
    BadRequest(String),
    Unauthorized(&'static str),
    Forbidden,
    NotFound,
    Conflict(String),
    TooManyRequests(&'static str),
    ServiceUnavailable(&'static str),
    Database(sqlx::Error),
    Internal(String),
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BadRequest(message) | Self::Conflict(message) | Self::Internal(message) => f.write_str(message),
            Self::Unauthorized(message) | Self::TooManyRequests(message) | Self::ServiceUnavailable(message) => {
                f.write_str(message)
            }
            Self::Forbidden => f.write_str("沒有權限"),
            Self::NotFound => f.write_str("not found"),
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
            Self::TooManyRequests(_) => StatusCode::TOO_MANY_REQUESTS,
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
