use std::{env, net::SocketAddr, path::PathBuf, str::FromStr, time::Duration};

use backend::{AppState, router};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

    let database_url = env::var("DATABASE_URL").unwrap_or_else(|_| "sqlite://data/app.db".into());
    let static_dir = PathBuf::from(env::var("STATIC_DIR").unwrap_or_else(|_| "../frontend/dist".into()));
    let app_env = env::var("APP_ENV").unwrap_or_else(|_| "dev".into());
    let port = env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(8080);

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

    let app = router(AppState { pool: pool.clone(), app_env: app_env.clone() }, &static_dir);
    let listener = tokio::net::TcpListener::bind(SocketAddr::from(([0, 0, 0, 0], port))).await?;
    tracing::info!(%app_env, port, static_dir = %static_dir.display(), "listening");

    axum::serve(listener, app).with_graceful_shutdown(shutdown_signal()).await?;
    pool.close().await;
    Ok(())
}

/// docker stop 會送 SIGTERM，收到後讓進行中的請求跑完再關閉。
async fn shutdown_signal() {
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
        _ = terminate => {},
    }
    tracing::info!("shutting down");
}
