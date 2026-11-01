mod common;

use axum::http::StatusCode;
use backend::auth::upsert_admin;
use common::{TestApp, app};
use serde_json::{Value, json};

const ADMIN_PASSWORD: &str = "correct horse battery";
/// 最小的 PNG 檔頭就夠過格式檢查
const PNG: &[u8] = b"\x89PNG\r\n\x1a\n-not-really-pixels";

async fn app_with_admin() -> (TestApp, String) {
    let app = app().await;
    upsert_admin(&app.state.pool, "admin", ADMIN_PASSWORD.into()).await.unwrap();
    let admin = login(&app, "admin", ADMIN_PASSWORD).await;
    (app, admin)
}

async fn login(app: &TestApp, username: &str, password: &str) -> String {
    let reply =
        app.call("POST", "/api/auth/login", None, Some(json!({ "username": username, "password": password }))).await;
    reply.cookie.expect("logs in")
}

async fn create_user(app: &TestApp, admin: &str, username: &str) -> String {
    let body = json!({ "username": username, "password": "password123" });
    let reply = app.call("POST", "/api/admin/users", Some(admin), Some(body)).await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
    login(app, username, "password123").await
}

/// 上傳圖片，回傳 (id, 訪客 cookie)
async fn upload(app: &TestApp, cookie: Option<&str>, bytes: &[u8]) -> (i64, Option<String>) {
    let reply = app.raw("POST", "/api/feedback/images", cookie, bytes.to_vec()).await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", String::from_utf8_lossy(&reply.bytes));
    let body: Value = serde_json::from_slice(&reply.bytes).unwrap();
    (body["id"].as_i64().unwrap(), reply.cookie)
}

fn thread(kind: &str, title: &str, body: &str, images: &[i64]) -> Option<Value> {
    Some(json!({ "kind": kind, "title": title, "body": body, "images": images }))
}

#[tokio::test]
async fn guest_and_admin_talk_back_and_forth() {
    let (app, admin) = app_with_admin().await;

    // 訪客先貼圖（拿到 cookie），再開一串回報
    let (image, cookie) = upload(&app, None, PNG).await;
    let guest = cookie.expect("guest cookie is issued");
    assert!(guest.starts_with("feedback_test="));
    let created =
        app.call("POST", "/api/feedback", Some(&guest), thread("bug", "按鈕壞了", "點了沒反應", &[image])).await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.body);
    let id = created.body["thread"]["id"].as_i64().unwrap();
    assert_eq!(created.body["thread"]["status"], "open");
    assert_eq!(created.body["messages"][0]["images"], json!([image]));
    assert_eq!(created.body["messages"][0]["author"], Value::Null);

    let mine = app.get("/api/feedback", Some(&guest)).await.body;
    assert_eq!(mine.as_array().unwrap().len(), 1);
    // 別人看不到
    assert_eq!(app.get("/api/feedback", None).await.body, json!([]));
    assert_eq!(app.get(&format!("/api/feedback/{id}"), None).await.status, StatusCode::NOT_FOUND);
    let stranger = "feedback_test=someone-else";
    assert_eq!(app.get(&format!("/api/feedback/{id}"), Some(stranger)).await.status, StatusCode::NOT_FOUND);

    // 管理員看到一串未讀，打開後變已讀
    assert_eq!(app.get("/api/feedback/unread", Some(&admin)).await.body, json!({ "mine": 0, "admin": 1 }));
    let list = app.get("/api/admin/feedback", Some(&admin)).await.body;
    assert_eq!(list[0]["title"], "按鈕壞了");
    assert_eq!(list[0]["unread"], true);
    assert_eq!(list[0]["reporter"], Value::Null);
    assert_eq!(list[0]["ip"], "local");
    app.get(&format!("/api/admin/feedback/{id}"), Some(&admin)).await;
    assert_eq!(app.get("/api/feedback/unread", Some(&admin)).await.body["admin"], 0);

    // 管理員回覆（也附圖），然後結案
    let (admin_image, _) = upload(&app, Some(&admin), PNG).await;
    let body = json!({ "body": "請問是哪個瀏覽器？", "images": [admin_image] });
    let replied = app.call("POST", &format!("/api/admin/feedback/{id}/messages"), Some(&admin), Some(body)).await;
    assert_eq!(replied.status, StatusCode::OK, "{}", replied.body);
    assert_eq!(replied.body["messages"][1]["from_admin"], true);
    assert_eq!(replied.body["messages"][1]["author"], "admin");
    let closed = app
        .call("PUT", &format!("/api/admin/feedback/{id}/status"), Some(&admin), Some(json!({ "status": "closed" })))
        .await;
    assert_eq!(closed.body["thread"]["status"], "closed");
    assert_eq!(app.get("/api/admin/feedback?status=open", Some(&admin)).await.body, json!([]));

    // 訪客看到新回覆，管理員的圖也看得到
    assert_eq!(app.get("/api/feedback/unread", Some(&guest)).await.body, json!({ "mine": 1 }));
    let opened = app.get(&format!("/api/feedback/{id}"), Some(&guest)).await.body;
    assert_eq!(opened["messages"].as_array().unwrap().len(), 2);
    assert_eq!(app.get("/api/feedback/unread", Some(&guest)).await.body, json!({ "mine": 0 }));
    let picture = app.raw("GET", &format!("/api/feedback/images/{admin_image}"), Some(&guest), vec![]).await;
    assert_eq!(picture.status, StatusCode::OK);
    assert_eq!(picture.content_type.as_deref(), Some("image/png"));
    assert_eq!(picture.bytes, PNG);

    // 訪客再留言會重新打開
    let again = app
        .call("POST", &format!("/api/feedback/{id}/messages"), Some(&guest), Some(json!({ "body": "Firefox" })))
        .await;
    assert_eq!(again.status, StatusCode::OK, "{}", again.body);
    assert_eq!(again.body["thread"]["status"], "open");
    assert_eq!(app.get("/api/feedback/unread", Some(&admin)).await.body["admin"], 1);
}

#[tokio::test]
async fn images_are_private_to_the_conversation() {
    let (app, admin) = app_with_admin().await;
    let (image, cookie) = upload(&app, None, PNG).await;
    let guest = cookie.unwrap();
    let path = format!("/api/feedback/images/{image}");

    // 還沒送出時只有上傳的人和管理員看得到
    assert_eq!(app.raw("GET", &path, Some(&guest), vec![]).await.status, StatusCode::OK);
    assert_eq!(app.raw("GET", &path, Some(&admin), vec![]).await.status, StatusCode::OK);
    assert_eq!(app.raw("GET", &path, None, vec![]).await.status, StatusCode::NOT_FOUND);
    let alice = create_user(&app, &admin, "alice").await;
    assert_eq!(app.raw("GET", &path, Some(&alice), vec![]).await.status, StatusCode::NOT_FOUND);

    // 別人的圖不能掛到自己的留言上
    let stolen = app.call("POST", "/api/feedback", Some(&alice), thread("wish", "偷圖", "", &[image])).await;
    assert_eq!(stolen.status, StatusCode::BAD_REQUEST);
    assert_eq!(app.get("/api/feedback", Some(&alice)).await.body, json!([]), "failed thread is rolled back");

    // 掛上去之後就不能再用一次
    let first = app.call("POST", "/api/feedback", Some(&guest), thread("wish", "加個功能", "", &[image])).await;
    assert_eq!(first.status, StatusCode::CREATED);
    let reused = app.call("POST", "/api/feedback", Some(&guest), thread("wish", "再一次", "", &[image])).await;
    assert_eq!(reused.status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn rejects_bad_images() {
    let app = app().await;
    let text = app.raw("POST", "/api/feedback/images", None, b"<svg onload=alert(1)>".to_vec()).await;
    assert_eq!(text.status, StatusCode::BAD_REQUEST);
    let mut huge = PNG.to_vec();
    huge.resize(backend::feedback::MAX_IMAGE_BYTES + 1, 0);
    let too_big = app.raw("POST", "/api/feedback/images", None, huge).await;
    assert_eq!(too_big.status, StatusCode::PAYLOAD_TOO_LARGE);
}

#[tokio::test]
async fn logged_in_user_also_sees_threads_sent_as_guest_in_this_browser() {
    let (app, admin) = app_with_admin().await;
    let bob = create_user(&app, &admin, "bob").await;

    let as_guest = app.call("POST", "/api/feedback", None, thread("bug", "訪客時送的", "內容", &[])).await;
    let guest = as_guest.cookie.unwrap();
    let as_user = app.call("POST", "/api/feedback", Some(&bob), thread("wish", "登入後送的", "內容", &[])).await;
    assert_eq!(as_user.status, StatusCode::CREATED);
    assert!(as_user.cookie.is_none(), "logged-in users don't get a guest cookie");

    let both = format!("{bob}; {guest}");
    let titles: Vec<Value> = app
        .get("/api/feedback", Some(&both))
        .await
        .body
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["title"].clone())
        .collect();
    assert_eq!(titles, vec![json!("登入後送的"), json!("訪客時送的")]);
    // 只有帳號時看不到訪客的
    assert_eq!(app.get("/api/feedback", Some(&bob)).await.body.as_array().unwrap().len(), 1);

    let list = app.get("/api/admin/feedback", Some(&admin)).await.body;
    assert_eq!(list[0]["reporter"], "bob");
    // 一般使用者不能進管理頁
    assert_eq!(app.get("/api/admin/feedback", Some(&bob)).await.status, StatusCode::FORBIDDEN);
    assert_eq!(app.get("/api/feedback/unread", Some(&bob)).await.body, json!({ "mine": 0 }));
}

#[tokio::test]
async fn validates_input_and_limits_per_ip() {
    let (app, admin) = app_with_admin().await;
    let bad_kind = app.call("POST", "/api/feedback", None, thread("rant", "標題", "內容", &[])).await;
    assert_eq!(bad_kind.status, StatusCode::BAD_REQUEST);
    let no_title = app.call("POST", "/api/feedback", None, thread("bug", "  ", "內容", &[])).await;
    assert_eq!(no_title.status, StatusCode::BAD_REQUEST);
    let empty = app.call("POST", "/api/feedback", None, thread("bug", "標題", "  ", &[])).await;
    assert_eq!(empty.status, StatusCode::BAD_REQUEST);

    for i in 0..10 {
        let reply = app.call("POST", "/api/feedback", None, thread("bug", &format!("第 {i} 個"), "內容", &[])).await;
        assert_eq!(reply.status, StatusCode::CREATED);
    }
    let over = app.call("POST", "/api/feedback", None, thread("bug", "太多了", "內容", &[])).await;
    assert_eq!(over.status, StatusCode::TOO_MANY_REQUESTS);
    // 管理員不受限
    let by_admin = app.call("POST", "/api/feedback", Some(&admin), thread("wish", "管理員自己記", "內容", &[])).await;
    assert_eq!(by_admin.status, StatusCode::CREATED);

    let id = by_admin.body["thread"]["id"].as_i64().unwrap();
    let deleted = app.call("DELETE", &format!("/api/admin/feedback/{id}"), Some(&admin), None).await;
    assert_eq!(deleted.status, StatusCode::NO_CONTENT);
    assert_eq!(app.get(&format!("/api/admin/feedback/{id}"), Some(&admin)).await.status, StatusCode::NOT_FOUND);
}
