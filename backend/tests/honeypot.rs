use crate::common::{TestApp, app};
use axum::{
    body::Body,
    http::{Request, StatusCode, header},
};
use backend::auth::upsert_admin;
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;

async fn login(app: &TestApp, name: &str) -> String {
    upsert_admin(&app.state.pool, name, "password123".into()).await.unwrap();
    let reply =
        app.call("POST", "/api/auth/login", None, Some(json!({ "username": name, "password": "password123" }))).await;
    reply.cookie.unwrap()
}

/// 從 `ip` 送一個 JSON 請求，回傳狀態碼、內容和 Set-Cookie 的 `name=value`
async fn send(
    app: &TestApp,
    method: &str,
    ip: &str,
    path: &str,
    cookie: Option<&str>,
    body: Option<Value>,
) -> (StatusCode, Value, Option<String>) {
    let mut request =
        Request::builder().method(method).uri(path).header("x-forwarded-for", ip).header(header::USER_AGENT, "curl/8");
    if let Some(cookie) = cookie {
        request = request.header(header::COOKIE, cookie);
    }
    let request = match body {
        Some(body) => request.header(header::CONTENT_TYPE, "application/json").body(Body::from(body.to_string())),
        None => request.body(Body::empty()),
    };
    let response = app.router.clone().oneshot(request.unwrap()).await.unwrap();
    let status = response.status();
    let cookie = response
        .headers()
        .get(header::SET_COOKIE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(';').next())
        .map(String::from);
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null), cookie)
}

async fn login_from(app: &TestApp, ip: &str, username: &str, password: &str) -> StatusCode {
    let body = json!({ "username": username, "password": password });
    send(app, "POST", ip, "/api/auth/login", None, Some(body)).await.0
}

async fn register_from(app: &TestApp, ip: &str, username: &str) -> StatusCode {
    let body = json!({ "username": username, "password": "password123" });
    send(app, "POST", ip, "/api/auth/register", None, Some(body)).await.0
}

/// 假檔案裡 `field=` 那一行的值
fn value_of(bait: &str, field: &str) -> String {
    let prefix = format!("{field}=");
    bait.lines().find_map(|line| line.strip_prefix(&prefix)).unwrap_or_else(|| panic!("{field}")).to_owned()
}

/// 從 `ip` 送一個請求，回傳狀態碼、Content-Type 和內容
async fn fetch(
    app: &TestApp,
    method: &str,
    ip: &str,
    path: &str,
    cookie: Option<&str>,
) -> (StatusCode, String, String) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("x-forwarded-for", ip)
        .header(header::USER_AGENT, "zgrab/0.x");
    if let Some(cookie) = cookie {
        request = request.header(header::COOKIE, cookie);
    }
    let response = app.router.clone().oneshot(request.body(Body::empty()).unwrap()).await.unwrap();
    let status = response.status();
    let content_type =
        response.headers().get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or_default().to_owned();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    (status, content_type, String::from_utf8(body.to_vec()).unwrap())
}

#[tokio::test]
async fn serves_fake_env_and_records_who_took_it() {
    let app = app().await;
    let admin = login(&app, "alice").await;

    let (status, content_type, first) = fetch(&app, "GET", "203.0.113.5", "/.env", None).await;
    assert_eq!(status, StatusCode::OK);
    assert!(content_type.starts_with("text/plain"), "{content_type}");
    assert!(first.contains("DB_PASSWORD="), "{first}");
    // 同一個 IP 每次拿到的一樣，看起來才像真的檔案
    let (_, _, again) = fetch(&app, "GET", "203.0.113.5", "/.env.production?x=1", None).await;
    assert_eq!(again, first);
    // 在 /api 底下、其他資料夾底下也一樣
    assert_eq!(fetch(&app, "POST", "198.51.100.7", "/api/.env", None).await.0, StatusCode::OK);
    assert_eq!(fetch(&app, "GET", "192.0.2.9", "/laravel/.env", Some(&admin)).await.0, StatusCode::OK);
    // 不是 .env 的照舊
    assert_eq!(fetch(&app, "GET", "203.0.113.5", "/.git/config", None).await.0, StatusCode::NOT_FOUND);
    assert_eq!(fetch(&app, "GET", "203.0.113.5", "/api/nope", None).await.0, StatusCode::NOT_FOUND);

    let reply = app.get("/api/admin/honeypot", Some(&admin)).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    let body = reply.body;
    // 有登入的那次不會讓 IP 被擋
    assert_eq!(
        body["summary"],
        json!({ "hits": 4, "ips": 3, "last_day": 4, "last_day_ips": 3, "uses": 0, "blocked": 2 })
    );
    let blocked: Vec<_> = body["blocks"].as_array().unwrap().iter().map(|b| b["ip"].clone()).collect();
    assert!(blocked.contains(&json!("203.0.113.5")) && blocked.contains(&json!("198.51.100.7")), "{blocked:?}");
    let ips = body["ips"].as_array().unwrap();
    let rows: Vec<_> = ips.iter().map(|r| (r["ip"].clone(), r["hits"].clone(), r["users"].clone())).collect();
    // 最近來過的在前面；登入的人會記下帳號
    assert_eq!(
        rows,
        [
            (json!("192.0.2.9"), json!(1), json!(["alice"])),
            (json!("198.51.100.7"), json!(1), json!([])),
            (json!("203.0.113.5"), json!(2), json!([])),
        ]
    );
    assert_eq!(ips[2]["paths"], json!(["/.env", "/.env.production"]));
    assert_eq!(ips[2]["user_agent"], "zgrab/0.x");
    assert_eq!(body["paths"].as_array().unwrap().len(), 4);

    let hits = app.get("/api/admin/honeypot/hits?ip=203.0.113.5", Some(&admin)).await.body;
    let rows: Vec<_> =
        hits.as_array().unwrap().iter().map(|h| (h["method"].clone(), h["path"].clone(), h["query"].clone())).collect();
    assert_eq!(
        rows,
        [(json!("GET"), json!("/.env.production"), json!("x=1")), (json!("GET"), json!("/.env"), json!(""))]
    );
    assert_eq!(app.get("/api/admin/honeypot/hits", Some(&admin)).await.body.as_array().unwrap().len(), 4);

    // IP 訪問紀錄也記得到，狀態碼是 200
    app.state.access_log.flush(&app.state.pool).await.unwrap();
    let access = app.get("/api/admin/access/requests?ip=198.51.100.7", Some(&admin)).await.body;
    assert_eq!((access[0]["path"].clone(), access[0]["status"].clone()), (json!("/api/.env"), json!(200)));
}

#[tokio::test]
async fn ip_that_took_the_bait_cannot_log_in_or_register() {
    let app = app().await;
    let admin = login(&app, "alice").await;
    let reply = app.call("PUT", "/api/admin/registrations/open", Some(&admin), Some(json!({ "open": true }))).await;
    assert_eq!(reply.status, StatusCode::OK);

    assert_eq!(login_from(&app, "203.0.113.5", "alice", "password123").await, StatusCode::OK);
    fetch(&app, "GET", "203.0.113.5", "/.env", None).await;
    // 密碼對也不行
    assert_eq!(login_from(&app, "203.0.113.5", "alice", "password123").await, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(register_from(&app, "203.0.113.5", "mallory").await, StatusCode::TOO_MANY_REQUESTS);
    // 別的 IP 照常
    assert_eq!(login_from(&app, "198.51.100.7", "alice", "password123").await, StatusCode::OK);
    assert_eq!(register_from(&app, "198.51.100.7", "bob").await, StatusCode::CREATED);

    let report = app.get("/api/admin/honeypot", Some(&admin)).await.body;
    assert_eq!(report["blocks"].as_array().unwrap().len(), 1);
    assert_eq!(report["blocks"][0]["ip"], "203.0.113.5");
    assert!(report["blocks"][0]["until"].as_str().unwrap().ends_with('Z'));

    // 管理員解除之後可以登入
    let unblock = "/api/admin/honeypot/blocks/203.0.113.5";
    assert_eq!(app.call("DELETE", unblock, None, None).await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(app.call("DELETE", unblock, Some(&admin), None).await.status, StatusCode::NO_CONTENT);
    assert_eq!(login_from(&app, "203.0.113.5", "alice", "password123").await, StatusCode::OK);
    assert_eq!(app.get("/api/admin/honeypot", Some(&admin)).await.body["summary"]["blocked"], 0);

    // 解除之後再來拿，又會被擋（時間只記到秒，把解除的時間往前調，才不會跟下一次落在同一秒）
    sqlx::query("UPDATE honeypot_pardons SET created_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 minute')")
        .execute(&app.state.pool)
        .await
        .unwrap();
    fetch(&app, "GET", "203.0.113.5", "/.env.local", None).await;
    assert_eq!(login_from(&app, "203.0.113.5", "alice", "password123").await, StatusCode::TOO_MANY_REQUESTS);
}

#[tokio::test]
async fn ips_with_logged_in_accounts_are_not_blocked() {
    let app = app().await;
    upsert_admin(&app.state.pool, "alice", "password123".into()).await.unwrap();
    let body = json!({ "username": "alice", "password": "password123" });
    let (_, _, cookie) = send(&app, "POST", "203.0.113.5", "/api/auth/login", None, Some(body)).await;
    // 登入後的請求會在 IP 訪問紀錄留下帳號
    let (status, _, _) = send(&app, "GET", "203.0.113.5", "/api/auth/me", cookie.as_deref(), None).await;
    assert_eq!(status, StatusCode::OK);
    app.state.access_log.flush(&app.state.pool).await.unwrap();

    // 登出時點開 .env 來看，也不會把自己鎖在外面
    fetch(&app, "GET", "203.0.113.5", "/.env", None).await;
    assert_eq!(login_from(&app, "203.0.113.5", "alice", "password123").await, StatusCode::OK);
    // 沒有帳號登入過的 IP 照樣擋
    fetch(&app, "GET", "198.51.100.7", "/.env", None).await;
    assert_eq!(login_from(&app, "198.51.100.7", "alice", "password123").await, StatusCode::TOO_MANY_REQUESTS);
}

#[tokio::test]
async fn using_a_fake_password_is_recorded_and_blocked() {
    let app = app().await;
    let admin = login(&app, "alice").await;
    let (_, _, bait) = fetch(&app, "GET", "203.0.113.5", "/.env", None).await;
    assert_eq!(value_of(&bait, "ADMIN_USER"), "sysadmin");
    let admin_password = value_of(&bait, "ADMIN_PASSWORD");

    // 換一個 IP 來用：看起來跟一般的密碼錯誤一樣
    let body = json!({ "username": "sysadmin", "password": admin_password });
    let (status, body, _) = send(&app, "POST", "198.51.100.7", "/api/auth/login", None, Some(body)).await;
    assert_eq!((status, body["error"].clone()), (StatusCode::UNAUTHORIZED, json!("帳號或密碼錯誤")));
    // 用過假密碼的 IP 也被擋；被擋的時候拿資料庫密碼來試也記得到
    assert_eq!(login_from(&app, "198.51.100.7", "alice", "password123").await, StatusCode::TOO_MANY_REQUESTS);
    let db_password = value_of(&bait, "DB_PASSWORD");
    assert_eq!(login_from(&app, "198.51.100.7", "ouyang_app", &db_password).await, StatusCode::TOO_MANY_REQUESTS);
    // 一般的密碼錯誤不算
    assert_eq!(login_from(&app, "192.0.2.9", "alice", "wrong-password").await, StatusCode::UNAUTHORIZED);

    let report = app.get("/api/admin/honeypot", Some(&admin)).await.body;
    assert_eq!(report["summary"]["uses"], 2);
    assert_eq!(report["summary"]["blocked"], 2);
    let uses: Vec<_> = report["uses"]
        .as_array()
        .unwrap()
        .iter()
        .map(|u| (u["ip"].clone(), u["field"].clone(), u["issued_ip"].clone(), u["username"].clone()))
        .collect();
    assert_eq!(
        uses,
        [
            (json!("198.51.100.7"), json!("DB_PASSWORD"), json!("203.0.113.5"), json!("ouyang_app")),
            (json!("198.51.100.7"), json!("ADMIN_PASSWORD"), json!("203.0.113.5"), json!("sysadmin")),
        ]
    );
    assert_eq!(report["uses"][0]["user_agent"], "curl/8");
}

#[tokio::test]
async fn auto_block_can_be_turned_off() {
    let app = app().await;
    let admin = login(&app, "alice").await;
    fetch(&app, "GET", "203.0.113.5", "/.env", None).await;
    assert_eq!(login_from(&app, "203.0.113.5", "alice", "password123").await, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(app.get("/api/admin/honeypot", Some(&admin)).await.body["auto_block"], true);

    let off = app.call("PUT", "/api/admin/honeypot/auto-block", Some(&admin), Some(json!({ "enabled": false }))).await;
    assert_eq!((off.status, off.body), (StatusCode::OK, json!({ "enabled": false })));
    // 關掉之後不擋，但照樣記錄
    assert_eq!(login_from(&app, "203.0.113.5", "alice", "password123").await, StatusCode::OK);
    fetch(&app, "GET", "198.51.100.7", "/.env", None).await;
    let report = app.get("/api/admin/honeypot", Some(&admin)).await.body;
    assert_eq!(report["auto_block"], false);
    assert_eq!((report["summary"]["hits"].clone(), report["summary"]["blocked"].clone()), (json!(2), json!(0)));

    // 再打開，之前的紀錄又算數
    let on = app.call("PUT", "/api/admin/honeypot/auto-block", Some(&admin), Some(json!({ "enabled": true }))).await;
    assert_eq!(on.status, StatusCode::OK);
    assert_eq!(login_from(&app, "198.51.100.7", "alice", "password123").await, StatusCode::TOO_MANY_REQUESTS);
}

#[tokio::test]
async fn admins_can_block_ips_by_hand() {
    let app = app().await;
    let admin = login(&app, "alice").await;
    let block = |body: Value| app.call("POST", "/api/admin/honeypot/blocks", Some(&admin), Some(body));

    // 有帳號登入過的 IP、自動封鎖關掉，手動封鎖照樣擋
    let body = json!({ "username": "alice", "password": "password123" });
    let (_, _, cookie) = send(&app, "POST", "198.51.100.7", "/api/auth/login", None, Some(body)).await;
    send(&app, "GET", "198.51.100.7", "/api/auth/me", cookie.as_deref(), None).await;
    app.state.access_log.flush(&app.state.pool).await.unwrap();
    app.call("PUT", "/api/admin/honeypot/auto-block", Some(&admin), Some(json!({ "enabled": false }))).await;
    assert_eq!(block(json!({ "ip": " 198.51.100.7 ", "note": "一直猜密碼" })).await.status, StatusCode::CREATED);
    assert_eq!(login_from(&app, "198.51.100.7", "alice", "password123").await, StatusCode::TOO_MANY_REQUESTS);

    // 有期限的；IPv6 存成標準寫法
    assert_eq!(block(json!({ "ip": "2001:DB8:0::1", "days": 7 })).await.status, StatusCode::CREATED);
    assert_eq!(login_from(&app, "2001:db8::1", "alice", "password123").await, StatusCode::TOO_MANY_REQUESTS);

    let report = app.get("/api/admin/honeypot", Some(&admin)).await.body;
    assert_eq!(report["summary"]["blocked"], 2);
    let find = |ip: &str| report["blocks"].as_array().unwrap().iter().find(|b| b["ip"] == ip).unwrap().clone();
    let forever = find("198.51.100.7");
    assert_eq!((forever["manual"].clone(), forever["until"].clone()), (json!(true), Value::Null));
    assert_eq!(forever["note"], "一直猜密碼");
    assert!(find("2001:db8::1")["until"].as_str().unwrap().ends_with('Z'));

    // 格式不對、天數不對、自己目前的 IP 都不行
    assert_eq!(block(json!({ "ip": "not-an-ip" })).await.status, StatusCode::BAD_REQUEST);
    assert_eq!(block(json!({ "ip": "192.0.2.1", "days": 0 })).await.status, StatusCode::BAD_REQUEST);
    let mine = json!({ "ip": "192.0.2.50" });
    let (status, _, _) = send(&app, "POST", "192.0.2.50", "/api/admin/honeypot/blocks", Some(&admin), Some(mine)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // 過期就不擋
    sqlx::query("UPDATE honeypot_blocks SET until = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 minute') WHERE ip = ?")
        .bind("2001:db8::1")
        .execute(&app.state.pool)
        .await
        .unwrap();
    assert_eq!(login_from(&app, "2001:db8::1", "alice", "password123").await, StatusCode::OK);
    // 解除
    let unblock = app.call("DELETE", "/api/admin/honeypot/blocks/198.51.100.7", Some(&admin), None).await;
    assert_eq!(unblock.status, StatusCode::NO_CONTENT);
    assert_eq!(login_from(&app, "198.51.100.7", "alice", "password123").await, StatusCode::OK);
}

#[tokio::test]
async fn limits_records_per_ip() {
    let app = app().await;
    let admin = login(&app, "alice").await;
    for _ in 0..205 {
        assert_eq!(fetch(&app, "GET", "203.0.113.5", "/.env", None).await.0, StatusCode::OK);
    }
    let body: Value = app.get("/api/admin/honeypot", Some(&admin)).await.body;
    assert_eq!(body["summary"]["hits"], 200);
}

#[tokio::test]
async fn requires_admin() {
    let app = app().await;
    assert_eq!(app.get("/api/admin/honeypot", None).await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(app.get("/api/admin/honeypot/hits", None).await.status, StatusCode::UNAUTHORIZED);
    let unblock = app.call("DELETE", "/api/admin/honeypot/blocks/203.0.113.5", None, None).await;
    assert_eq!(unblock.status, StatusCode::UNAUTHORIZED);
    let block = app.call("POST", "/api/admin/honeypot/blocks", None, Some(json!({ "ip": "203.0.113.5" }))).await;
    assert_eq!(block.status, StatusCode::UNAUTHORIZED);
    let toggle = app.call("PUT", "/api/admin/honeypot/auto-block", None, Some(json!({ "enabled": false }))).await;
    assert_eq!(toggle.status, StatusCode::UNAUTHORIZED);
}
