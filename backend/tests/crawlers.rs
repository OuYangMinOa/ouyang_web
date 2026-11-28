//! 給爬蟲的 robots.txt 和 sitemap.xml（crawlers.rs）：只有正式站讓人爬，
//! 網站地圖和要登入的 APP 都照前端 build 時產生的功能清單。

use std::path::PathBuf;

use axum::{
    body::Body,
    http::{Request, StatusCode, header},
};
use backend::router;
use http_body_util::BodyExt;
use serde_json::json;
use tower::ServiceExt;

use crate::common::{TestApp, app};

/// 前端 build 出來的檔案：index.html（前端的頁面）和功能清單
fn static_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("crawlers-{name}-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("index.html"), "<!doctype html><title>ouyang.app</title>").unwrap();
    let catalog = json!({ "items": [
        { "kind": "app", "name": "小遊戲", "url": "/games" },
        { "kind": "app", "name": "AI 助手", "url": "/ai", "login": true },
        { "kind": "app", "name": "系統管理", "url": "/admin", "permission": "admin.users" },
        { "kind": "tool", "name": "QR Code", "url": "/tools/qrcode" },
        { "kind": "game", "name": "俄羅斯方塊 99", "url": "/games/tetris" },
        { "kind": "page", "name": "回報與許願", "url": "/feedback" },
        { "kind": "page", "name": "我的帳號", "url": "/account", "login": true },
    ] });
    std::fs::write(dir.join("site-catalog.json"), catalog.to_string()).unwrap();
    dir
}

/// `env` 環境的 app，前端的檔案在 `dir`
async fn app_in(env: &str, dir: &PathBuf) -> TestApp {
    let mut state = app().await.state;
    state.app_env = env.into();
    state.site_catalog = dir.join("site-catalog.json");
    TestApp { router: router(state.clone(), dir), state }
}

/// 經過 Traefik 的 GET：Host 是正式站的網址、X-Forwarded-Proto 是 https
async fn get(app: &TestApp, path: &str) -> (StatusCode, String, String) {
    let request = Request::get(path)
        .header(header::HOST, "ouyang.app")
        .header("x-forwarded-proto", "https")
        .body(Body::empty())
        .unwrap();
    let response = app.router.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let kind = response.headers().get(header::CONTENT_TYPE).map(|v| v.to_str().unwrap().to_owned()).unwrap_or_default();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, kind, String::from_utf8(bytes.to_vec()).unwrap())
}

#[tokio::test]
async fn only_prod_lets_crawlers_in() {
    let dir = static_dir("robots");
    // staging、本機：整站都不讓爬（前端有 index.html 也一樣是這裡回，不是前端的頁面）
    for env in ["staging", "dev"] {
        let (status, kind, body) = get(&app_in(env, &dir).await, "/robots.txt").await;
        assert_eq!((status, kind.as_str()), (StatusCode::OK, "text/plain; charset=utf-8"), "{env}");
        assert_eq!(body, "User-agent: *\nDisallow: /\n", "{env}");
    }

    let (status, _, body) = get(&app_in("prod", &dir).await, "/robots.txt").await;
    assert_eq!(status, StatusCode::OK);
    let lines: Vec<&str> = body.lines().collect();
    for line in [
        "User-agent: *",
        "Disallow: /api/",
        "Disallow: /s/",
        // 要登入或權限的 APP 和頁面
        "Disallow: /ai$",
        "Disallow: /ai/",
        "Disallow: /admin$",
        "Disallow: /admin/",
        "Disallow: /account$",
        "Sitemap: https://ouyang.app/sitemap.xml",
    ] {
        assert!(lines.contains(&line), "少了 {line}：\n{body}");
    }
    // 不用登入的都可以爬
    for public in ["/games", "/tools", "/feedback"] {
        assert!(!lines.iter().any(|l| l.starts_with(&format!("Disallow: {public}"))), "{public} 被擋了：\n{body}");
    }

    // 前端還沒 build（沒有功能清單）：照樣回，只是少了要登入的 APP
    let mut state = app().await.state;
    state.app_env = "prod".into();
    state.site_catalog = dir.join("missing.json");
    let bare = TestApp { router: router(state.clone(), &dir), state };
    let (status, _, body) = get(&bare, "/robots.txt").await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.contains("Disallow: /api/\n") && !body.contains("/ai$"), "{body}");
}

#[tokio::test]
async fn sitemap_lists_public_pages() {
    let dir = static_dir("sitemap");
    let app = app_in("prod", &dir).await;
    let (status, kind, body) = get(&app, "/sitemap.xml").await;
    assert_eq!((status, kind.as_str()), (StatusCode::OK, "application/xml; charset=utf-8"));
    assert!(body.starts_with("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<urlset "), "{body}");
    let locs: Vec<&str> =
        body.lines().filter_map(|l| l.trim().strip_prefix("<url><loc>")?.strip_suffix("</loc></url>")).collect();
    assert_eq!(
        locs,
        [
            "https://ouyang.app/",
            "https://ouyang.app/games",
            "https://ouyang.app/tools/qrcode",
            "https://ouyang.app/games/tetris",
            "https://ouyang.app/feedback",
        ]
    );

    // 沒有功能清單：404，不要回一個只有首頁的地圖
    let mut state = app.state.clone();
    state.site_catalog = dir.join("missing.json");
    let bare = TestApp { router: router(state.clone(), &dir), state };
    assert_eq!(get(&bare, "/sitemap.xml").await.0, StatusCode::NOT_FOUND);
}
