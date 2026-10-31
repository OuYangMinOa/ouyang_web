#![allow(dead_code)]

use std::path::{Path, PathBuf};

use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode, header},
};
use backend::{AppState, router};
use http_body_util::BodyExt;
use serde_json::Value;
use sqlx::{SqlitePool, sqlite::SqlitePoolOptions};
use tower::ServiceExt;

pub struct TestApp {
    pub router: Router,
    pub state: AppState,
}

pub struct Reply {
    pub status: StatusCode,
    pub body: Value,
    /// Set-Cookie 的 `name=value` 部分，可以直接當下一個請求的 Cookie
    pub cookie: Option<String>,
}

/// 不是 JSON 的請求或回應（例如上傳、下載圖片）
pub struct RawReply {
    pub status: StatusCode,
    pub content_type: Option<String>,
    pub bytes: Vec<u8>,
    pub cookie: Option<String>,
}

pub async fn app() -> TestApp {
    // 記憶體資料庫每條連線都是獨立的一份，所以只開一條
    let pool = SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
    sqlx::migrate!().run(&pool).await.unwrap();
    app_on(pool)
}

/// 共用同一個資料庫的另一個 app，用來模擬重啟後或換版時的另一個容器
pub fn app_on(pool: SqlitePool) -> TestApp {
    let state = AppState::new(pool, "test", "test-sha");
    TestApp { router: router(state.clone(), Path::new("does-not-exist")), state }
}

/// 音樂資料夾指到 `music_dir` 的 app
pub async fn app_with_music(music_dir: PathBuf) -> TestApp {
    let mut state = app().await.state;
    state.music_dir = music_dir;
    TestApp { router: router(state.clone(), Path::new("does-not-exist")), state }
}

impl TestApp {
    pub async fn call(&self, method: &str, path: &str, cookie: Option<&str>, body: Option<Value>) -> Reply {
        let mut request = Request::builder().method(method).uri(path);
        if let Some(cookie) = cookie {
            request = request.header(header::COOKIE, cookie);
        }
        let request = match body {
            Some(body) => request.header(header::CONTENT_TYPE, "application/json").body(Body::from(body.to_string())),
            None => request.body(Body::empty()),
        }
        .unwrap();

        let response = self.router.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let cookie = response
            .headers()
            .get(header::SET_COOKIE)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.split(';').next())
            .map(String::from);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        Reply { status, body: serde_json::from_slice(&bytes).unwrap_or(Value::Null), cookie }
    }

    pub async fn raw(&self, method: &str, path: &str, cookie: Option<&str>, body: Vec<u8>) -> RawReply {
        let mut request = Request::builder().method(method).uri(path);
        if let Some(cookie) = cookie {
            request = request.header(header::COOKIE, cookie);
        }
        let response = self.router.clone().oneshot(request.body(Body::from(body)).unwrap()).await.unwrap();
        let status = response.status();
        let header_value = |name| response.headers().get(name).and_then(|v| v.to_str().ok()).map(String::from);
        let content_type = header_value(header::CONTENT_TYPE);
        let cookie = header_value(header::SET_COOKIE).and_then(|v| v.split(';').next().map(String::from));
        let bytes = response.into_body().collect().await.unwrap().to_bytes().to_vec();
        RawReply { status, content_type, bytes, cookie }
    }

    pub async fn get(&self, path: &str, cookie: Option<&str>) -> Reply {
        self.call("GET", path, cookie, None).await
    }
}
