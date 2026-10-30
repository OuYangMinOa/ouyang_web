mod common;

use axum::http::StatusCode;
use backend::auth::upsert_admin;
use common::{TestApp, app};
use serde_json::{Value, json};

/// 建好兩個帳號並登入，回傳 (app, alice 的 cookie, bob 的 cookie)
async fn app_with_users() -> (TestApp, String, String) {
    let app = app().await;
    let mut cookies = Vec::new();
    for name in ["alice", "bob"] {
        upsert_admin(&app.state.pool, name, "password123".into()).await.unwrap();
        let reply = app
            .call("POST", "/api/auth/login", None, Some(json!({ "username": name, "password": "password123" })))
            .await;
        cookies.push(reply.cookie.unwrap());
    }
    let bob = cookies.pop().unwrap();
    let alice = cookies.pop().unwrap();
    (app, alice, bob)
}

fn event(title: &str, start: &str, end: &str) -> Value {
    json!({ "title": title, "start_date": start, "end_date": end })
}

async fn create(app: &TestApp, cookie: &str, body: Value) -> Value {
    let reply = app.call("POST", "/api/calendar/events", Some(cookie), Some(body)).await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
    reply.body
}

#[tokio::test]
async fn events_need_login() {
    let app = app().await;
    assert_eq!(app.get("/api/calendar/events", None).await.status, StatusCode::UNAUTHORIZED);
    let reply = app.call("POST", "/api/calendar/events", None, Some(event("x", "2026-10-30", "2026-10-30"))).await;
    assert_eq!(reply.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn create_list_update_and_delete() {
    let (app, alice, _) = app_with_users().await;
    let trip = create(
        &app,
        &alice,
        json!({ "title": "  旅行  ", "note": "帶護照", "start_date": "2026-11-02", "end_date": "2026-11-05", "color": "blue" }),
    )
    .await;
    assert_eq!(trip["title"], "旅行");
    assert_eq!(trip["repeat"], "none");
    assert_eq!(trip["interval"], 1);
    assert_eq!(trip["until"], Value::Null);
    create(&app, &alice, event("更早的事", "2026-10-01", "2026-10-01")).await;

    let list = app.get("/api/calendar/events", Some(&alice)).await;
    let titles: Vec<_> = list.body.as_array().unwrap().iter().map(|e| e["title"].clone()).collect();
    assert_eq!(titles, [json!("更早的事"), json!("旅行")]);

    let id = trip["id"].as_i64().unwrap();
    let mut changed = event("每兩週開會", "2026-11-03", "2026-11-03");
    changed["repeat"] = json!("weekly");
    changed["interval"] = json!(2);
    changed["weekdays"] = json!([4, 2]);
    changed["until"] = json!("2027-06-30");
    changed["excluded"] = json!(["2026-11-17", "2026-11-17"]);
    let updated = app.call("PUT", &format!("/api/calendar/events/{id}"), Some(&alice), Some(changed)).await;
    assert_eq!(updated.status, StatusCode::OK, "{}", updated.body);
    assert_eq!(updated.body["weekdays"], json!([2, 4]));
    assert_eq!(updated.body["interval"], 2);
    assert_eq!(updated.body["excluded"], json!(["2026-11-17"]));
    assert_eq!(updated.body["note"], "");

    let deleted = app.call("DELETE", &format!("/api/calendar/events/{id}"), Some(&alice), None).await;
    assert_eq!(deleted.status, StatusCode::NO_CONTENT);
    assert_eq!(app.get("/api/calendar/events", Some(&alice)).await.body.as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn repeat_rules_are_normalized() {
    let (app, alice, _) = app_with_users().await;

    // 每週沒選星期就用開始那天（2026-10-30 是星期五）
    let mut weekly = event("運動", "2026-10-30", "2026-10-30");
    weekly["repeat"] = json!("weekly");
    assert_eq!(create(&app, &alice, weekly).await["weekdays"], json!([5]));

    // 不重複的事項不留重複設定；農曆重複固定每 1 次
    let mut once = event("一次", "2026-10-30", "2026-10-30");
    once["interval"] = json!(3);
    once["until"] = json!("2027-01-01");
    once["excluded"] = json!(["2026-10-30"]);
    let once = create(&app, &alice, once).await;
    assert_eq!(
        (once["interval"].clone(), once["until"].clone(), once["excluded"].clone()),
        (json!(1), json!(null), json!([]))
    );

    let mut birthday = event("農曆生日", "2026-10-30", "2026-10-30");
    birthday["repeat"] = json!("lunar_yearly");
    birthday["interval"] = json!(5);
    assert_eq!(create(&app, &alice, birthday).await["interval"], 1);
}

#[tokio::test]
async fn invalid_events_are_rejected() {
    let (app, alice, _) = app_with_users().await;
    let with = |field: &str, value: Value| {
        let mut body = event("x", "2026-10-30", "2026-10-31");
        body[field] = value;
        body
    };
    let cases = [
        with("title", json!("   ")),
        with("title", json!("字".repeat(101))),
        with("note", json!("字".repeat(2001))),
        with("color", json!("#ff0000")),
        with("start_date", json!("2026-02-30")),
        with("end_date", json!("2026-10-29")),
        with("end_date", json!("2027-11-01")),
        with("repeat", json!("hourly")),
        with("interval", json!(0)),
        json!({ "title": "x", "start_date": "2026-10-30", "end_date": "2026-10-30", "repeat": "weekly", "weekdays": [7] }),
        json!({ "title": "x", "start_date": "2026-10-30", "end_date": "2026-10-30", "repeat": "daily", "until": "2026-10-29" }),
        json!({ "title": "x", "start_date": "2026-10-30", "end_date": "2026-10-30", "repeat": "daily", "excluded": ["soon"] }),
    ];
    for body in cases {
        let reply = app.call("POST", "/api/calendar/events", Some(&alice), Some(body.clone())).await;
        assert_eq!(reply.status, StatusCode::BAD_REQUEST, "{body}");
    }
}

#[tokio::test]
async fn users_only_see_their_own_events() {
    let (app, alice, bob) = app_with_users().await;
    let id = create(&app, &alice, event("alice 的事", "2026-10-30", "2026-10-30")).await["id"].as_i64().unwrap();

    assert_eq!(app.get("/api/calendar/events", Some(&bob)).await.body, json!([]));
    let path = format!("/api/calendar/events/{id}");
    let update = app.call("PUT", &path, Some(&bob), Some(event("搶走", "2026-10-30", "2026-10-30"))).await;
    assert_eq!(update.status, StatusCode::NOT_FOUND);
    assert_eq!(app.call("DELETE", &path, Some(&bob), None).await.status, StatusCode::NOT_FOUND);

    let list = app.get("/api/calendar/events", Some(&alice)).await;
    assert_eq!(list.body[0]["title"], "alice 的事");
}
