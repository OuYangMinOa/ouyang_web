mod common;

use std::path::PathBuf;

use axum::{
    body::Body,
    http::{Request, StatusCode, header},
};
use common::{TestApp, app, app_with_music};
use http_body_util::BodyExt;
use serde_json::json;
use tower::ServiceExt;

/// 每個測試一個獨立的暫存資料夾
fn music_dir(test: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("ouyang-web-music-{test}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("sub")).unwrap();
    std::fs::write(dir.join("你好 世界.mp3"), b"0123456789").unwrap();
    std::fs::write(dir.join("B.WAV"), b"wav").unwrap();
    std::fs::write(dir.join("notes.txt"), b"secret").unwrap();
    std::fs::write(dir.join(".hidden.mp3"), b"hidden").unwrap();
    std::fs::write(dir.join("sub/inner.mp3"), b"inner").unwrap();
    dir
}

async fn fetch(app: &TestApp, uri: &str, range: Option<&str>) -> (StatusCode, Option<String>, Vec<u8>) {
    let mut request = Request::builder().uri(uri);
    if let Some(range) = range {
        request = request.header(header::RANGE, range);
    }
    let response = app.router.clone().oneshot(request.body(Body::empty()).unwrap()).await.unwrap();
    let status = response.status();
    let content_type = response.headers().get(header::CONTENT_TYPE).map(|v| v.to_str().unwrap().to_owned());
    let body = response.into_body().collect().await.unwrap().to_bytes().to_vec();
    (status, content_type, body)
}

#[tokio::test]
async fn lists_only_audio_files_sorted_by_name() {
    let app = app_with_music(music_dir("list")).await;
    let reply = app.get("/api/music", None).await;
    assert_eq!(reply.status, StatusCode::OK);
    let names: Vec<_> = reply.body.as_array().unwrap().iter().map(|t| t["name"].clone()).collect();
    assert_eq!(names, [json!("B.WAV"), json!("你好 世界.mp3")]);
    assert_eq!(reply.body[1]["size"], 10);
    assert!(reply.body[1]["modified"].as_i64().unwrap() > 0);
}

#[tokio::test]
async fn missing_dir_lists_nothing() {
    let app = app().await;
    let reply = app.get("/api/music", None).await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.body, json!([]));
}

#[tokio::test]
async fn serves_files_with_ranges() {
    let app = app_with_music(music_dir("serve")).await;
    let uri = "/api/music/files/%E4%BD%A0%E5%A5%BD%20%E4%B8%96%E7%95%8C.mp3";

    let (status, content_type, body) = fetch(&app, uri, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(content_type.as_deref(), Some("audio/mpeg"));
    assert_eq!(body, b"0123456789");

    // 拖曳進度時瀏覽器會用 Range 只要一段
    let (status, _, body) = fetch(&app, uri, Some("bytes=2-4")).await;
    assert_eq!(status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(body, b"234");
}

#[tokio::test]
async fn serves_shared_alias_with_original_filename() {
    let app = app_with_music(music_dir("share")).await;
    // 「你好 世界」的 UTF-8 十六進位
    let uri = "/api/music/s/E4BDA0E5A5BD20E4B896E7958C.mp3";
    let response = app.router.clone().oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CONTENT_TYPE], "audio/mpeg");
    assert_eq!(
        response.headers()[header::CONTENT_DISPOSITION],
        "inline; filename*=UTF-8''%E4%BD%A0%E5%A5%BD%20%E4%B8%96%E7%95%8C.mp3"
    );
    assert_eq!(response.into_body().collect().await.unwrap().to_bytes().as_ref(), b"0123456789");

    // 小寫也可以
    let (status, _, body) = fetch(&app, "/api/music/s/e4bda0e5a5bd20e4b896e7958c.mp3", Some("bytes=2-4")).await;
    assert_eq!(status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(body, b"234");
}

#[tokio::test]
async fn refuses_bad_shared_aliases() {
    let app = app_with_music(music_dir("share-refuse")).await;
    for uri in [
        // 奇數位、不是十六進位、不是 UTF-8、沒有副檔名
        "/api/music/s/E4B.mp3",
        "/api/music/s/ZZZZ.mp3",
        "/api/music/s/FFFE.mp3",
        "/api/music/s/E4BDA0",
        "/api/music/s/.mp3",
        // notes.txt、sub/inner.mp3、../x.mp3：解出來還是要過 is_track
        "/api/music/s/6E6F746573.txt",
        "/api/music/s/7375622F696E6E6572.mp3",
        "/api/music/s/2E2E2F78.mp3",
    ] {
        let (status, _, _) = fetch(&app, uri, None).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{uri}");
    }
}

#[tokio::test]
async fn refuses_anything_but_top_level_audio() {
    let app = app_with_music(music_dir("refuse")).await;
    for uri in [
        "/api/music/files/notes.txt",
        "/api/music/files/.hidden.mp3",
        "/api/music/files/sub%2Finner.mp3",
        "/api/music/files/..%2F..%2Fetc%2Fpasswd.mp3",
        "/api/music/files/missing.mp3",
    ] {
        let (status, _, _) = fetch(&app, uri, None).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{uri}");
    }
}
