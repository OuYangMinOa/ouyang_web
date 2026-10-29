use std::{
    env,
    net::SocketAddr,
    path::PathBuf,
    str::FromStr,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use backend::{AppState, healthcheck, router};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let port = env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(8080);
    if env::args().nth(1).as_deref() == Some("healthcheck") {
        std::process::exit(if healthcheck(port) { 0 } else { 1 });
    }

    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

    let database_url = env::var("DATABASE_URL").unwrap_or_else(|_| "sqlite://data/app.db".into());
    let static_dir = PathBuf::from(env::var("STATIC_DIR").unwrap_or_else(|_| "../frontend/dist".into()));
    let app_env = env::var("APP_ENV").unwrap_or_else(|_| "dev".into());
    let commit = env::var("GIT_SHA").unwrap_or_else(|_| "local".into());

    let options = SqliteConnectOptions::from_str(&database_url)?
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .busy_timeout(Duration::from_secs(5))
        .foreign_keys(true);
    if let Some(parent) = options.get_filename().parent() {
        std::fs::create_dir_all(parent)?;
    }

    let pool = SqlitePoolOptions::new().max_connections(5).connect_with(options).await?;
    sqlx::migrate!().run(&pool).await?;

    let drain = Duration::from_secs(env::var("DRAIN_SECS").ok().and_then(|s| s.parse().ok()).unwrap_or(5));
    let draining = Arc::new(AtomicBool::new(false));
    let state = AppState {
        pool: pool.clone(),
        app_env: app_env.clone(),
        commit: commit.clone(),
        draining: draining.clone(),
    };
    let app = router(state, &static_dir);
    let listener = tokio::net::TcpListener::bind(SocketAddr::from(([0, 0, 0, 0], port))).await?;
    tracing::info!(%app_env, %commit, port, static_dir = %static_dir.display(), "listening");

    axum::serve(listener, app).with_graceful_shutdown(shutdown_signal(draining, drain)).await?;
    pool.close().await;
    Ok(())
}

/// docker stop 會送 SIGTERM：先進入 draining 繼續服務 `drain` 這段時間，
/// 等 Traefik 的 health check 把這個容器移出負載平衡後，才停止接新連線並讓進行中的請求跑完。
/// 本機 Ctrl-C 則直接關閉。
async fn shutdown_signal(draining: Arc<AtomicBool>, drain: Duration) {
    let ctrl_c = async {
        tokio::signal::ctrl_c().await.expect("failed to listen for ctrl-c");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to listen for SIGTERM")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {
            draining.store(true, Ordering::Relaxed);
            tracing::info!(secs = drain.as_secs(), "SIGTERM received, draining");
            tokio::time::sleep(drain).await;
        },
    }
    tracing::info!("shutting down");
}
