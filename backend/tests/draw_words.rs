mod common;

use axum::http::StatusCode;
use backend::{auth::upsert_admin, draw};
use common::{TestApp, app};
use serde_json::{Value, json};

const PASSWORD: &str = "password123";
const MINE: &str = "/api/games/draw/words";
const ADMIN: &str = "/api/admin/draw-words";

async fn login(app: &TestApp, name: &str) -> String {
    let body = json!({ "username": name, "password": PASSWORD });
    app.call("POST", "/api/auth/login", None, Some(body)).await.cookie.expect("logs in")
}

/// 管理員和兩個一般使用者（alice、bob）
async fn setup() -> (TestApp, String, String, String) {
    let app = app().await;
    upsert_admin(&app.state.pool, "admin", PASSWORD.into()).await.unwrap();
    let admin = login(&app, "admin").await;
    for name in ["alice", "bob"] {
        let body = json!({ "username": name, "password": PASSWORD, "roles": [] });
        assert_eq!(app.call("POST", "/api/admin/users", Some(&admin), Some(body)).await.status, StatusCode::CREATED);
    }
    let alice = login(&app, "alice").await;
    let bob = login(&app, "bob").await;
    (app, admin, alice, bob)
}

fn words(list: &Value) -> Vec<&str> {
    list.as_array().unwrap().iter().map(|w| w["word"].as_str().unwrap()).collect()
}

fn in_bank(word: &str) -> bool {
    draw::bank().iter().any(|e| e.word == word)
}

#[tokio::test]
async fn submissions_need_login_and_skip_what_is_already_there() {
    let (app, admin, alice, bob) = setup().await;
    let body = json!({ "words": ["電音三太子"], "category": "台灣在地", "level": 3 });
    assert_eq!(app.get(MINE, None).await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(app.call("POST", MINE, None, Some(body.clone())).await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(app.get(ADMIN, Some(&alice)).await.status, StatusCode::FORBIDDEN);

    let mine = app.get(MINE, Some(&alice)).await;
    assert_eq!(mine.status, StatusCode::OK);
    assert_eq!(mine.body["trusted"], false);
    assert!(mine.body["builtin"].as_u64().unwrap() >= 400);
    assert!(mine.body["categories"].as_array().unwrap().iter().any(|c| c == "動物"));

    let body = json!({
        "words": ["電音三太子", " 雞蛋糕 ", "長頸鹿", "ｏｋ繃", "OK繃", "冰淇 淋", "貓", "", "雞蛋糕"],
        "category": "台灣在地",
        "level": 2,
    });
    let reply = app.call("POST", MINE, Some(&alice), Some(body)).await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
    assert_eq!(reply.body["added"], json!(["電音三太子", "雞蛋糕", "ｏｋ繃"]));
    let skipped: Vec<(&str, &str)> = reply.body["skipped"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| (s["word"].as_str().unwrap(), s["reason"].as_str().unwrap()))
        .collect();
    assert_eq!(
        skipped,
        [
            ("長頸鹿", "題庫裡已經有了"),
            ("OK繃", "重複了"),
            ("冰淇 淋", "只能有文字和數字，不能有空白或標點"),
            ("貓", "要 2～8 個字"),
            ("雞蛋糕", "重複了"),
        ]
    );
    // 待審核的還不會出題
    assert!(!in_bank("雞蛋糕"));
    let mine = app.get(MINE, Some(&alice)).await.body;
    assert_eq!(words(&mine["words"]), ["ｏｋ繃", "雞蛋糕", "電音三太子"]);
    assert!(mine["words"].as_array().unwrap().iter().all(|w| w["status"] == "pending" && w["level"] == 2));
    assert!(mine["words"][0].get("submitter").is_none());

    // 別人再投同一個詞
    let body = json!({ "words": ["雞蛋糕"], "category": "食物", "level": 1 });
    let reply = app.call("POST", MINE, Some(&bob), Some(body)).await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.body["added"], json!([]));
    assert_eq!(reply.body["skipped"][0]["reason"], "已經有人投稿，正在審核");

    // 只能收回自己待審核的
    let id = mine["words"][0]["id"].as_i64().unwrap();
    let path = format!("{MINE}/{id}");
    assert_eq!(app.call("DELETE", &path, Some(&bob), None).await.status, StatusCode::NOT_FOUND);
    assert_eq!(app.call("DELETE", &path, Some(&alice), None).await.status, StatusCode::NO_CONTENT);
    assert_eq!(words(&app.get(MINE, Some(&alice)).await.body["words"]), ["雞蛋糕", "電音三太子"]);
    let pending = app.get(ADMIN, Some(&admin)).await.body["pending"].clone();
    assert_eq!(words(&pending), ["電音三太子", "雞蛋糕"]);
    assert_eq!(pending[0]["submitter"], "alice");
}

#[tokio::test]
async fn bad_submissions_are_rejected() {
    let (app, _, alice, _) = setup().await;
    let submit = |body: Value| app.call("POST", MINE, Some(&alice), Some(body));
    let bad = [
        json!({ "words": [], "category": "動物", "level": 1 }),
        json!({ "words": ["  "], "category": "動物", "level": 1 }),
        json!({ "words": ["河豚"], "category": "", "level": 1 }),
        json!({ "words": ["河豚"], "category": "一二三四五六七", "level": 1 }),
        json!({ "words": ["河豚"], "category": "動物", "level": 0 }),
        json!({ "words": ["河豚"], "category": "動物", "level": 4 }),
        json!({ "words": (0..51).map(|i| format!("河豚{i}")).collect::<Vec<_>>(), "category": "動物", "level": 1 }),
    ];
    for body in bad {
        let reply = submit(body.clone()).await;
        assert_eq!(reply.status, StatusCode::BAD_REQUEST, "{body}");
    }
    // 待審核的有上限
    for batch in 0..4 {
        let words: Vec<String> = (0..50).map(|i| format!("測試{batch}號{i}")).collect();
        let reply = submit(json!({ "words": words, "category": "測試", "level": 2 })).await;
        assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
    }
    let reply = submit(json!({ "words": ["再多一個"], "category": "測試", "level": 2 })).await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST);
    assert!(reply.body["error"].as_str().unwrap_or_default().contains("200"), "{}", reply.body);
}

/// 會改到遊戲用的詞庫（整個程式共用一份），這個檔案裡只有這個測試會去改，免得互相干擾
#[tokio::test]
async fn reviewing_changes_the_word_bank() {
    let (app, admin, alice, _) = setup().await;
    let body = json!({ "words": ["珍奶雪花冰", "夾娃娃", "放天燈喔"], "category": "台灣在地", "level": 2 });
    assert_eq!(app.call("POST", MINE, Some(&alice), Some(body)).await.status, StatusCode::CREATED);
    let report = app.get(ADMIN, Some(&admin)).await.body;
    let ids: Vec<i64> = report["pending"].as_array().unwrap().iter().map(|w| w["id"].as_i64().unwrap()).collect();
    assert_eq!(ids.len(), 3);
    let builtin: usize = report["distribution"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|r| r["builtin"].as_array().unwrap())
        .map(|n| n.as_u64().unwrap() as usize)
        .sum();
    assert_eq!(builtin, draw::WORDS.len());

    // 先改難度再通過兩個、不通過一個
    let reply = app.call("PATCH", &format!("{ADMIN}/{}", ids[0]), Some(&admin), Some(json!({ "level": 3 }))).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    assert_eq!(reply.body["level"], 3);
    let bad = app.call("PATCH", &format!("{ADMIN}/{}", ids[0]), Some(&admin), Some(json!({ "level": 9 }))).await;
    assert_eq!(bad.status, StatusCode::BAD_REQUEST);
    let status_path = format!("{ADMIN}/status");
    let review = |ids: Vec<i64>, status: &str| {
        app.call("PUT", &status_path, Some(&admin), Some(json!({ "ids": ids, "status": status })))
    };
    assert_eq!(review(vec![ids[0]], "pending").await.status, StatusCode::BAD_REQUEST);
    assert_eq!(review(vec![ids[0], ids[1]], "approved").await.status, StatusCode::OK);
    let report = review(vec![ids[2]], "rejected").await.body;
    assert_eq!(words(&report["approved"]), ["夾娃娃", "珍奶雪花冰"]);
    assert_eq!(report["approved"][0]["reviewer"], "admin");
    assert_eq!(words(&report["rejected"]), ["放天燈喔"]);
    assert!(report["pending"].as_array().unwrap().is_empty());
    let local = report["distribution"].as_array().unwrap().iter().find(|r| r["category"] == "台灣在地").unwrap();
    assert_eq!(local["submitted"], json!([0, 1, 1]));

    // 通過的會出題，難度照改過的
    let bank = draw::bank();
    let entry = bank.iter().find(|e| e.word == "珍奶雪花冰").unwrap();
    assert_eq!(entry.level, draw::Level::Hard);
    assert!(in_bank("夾娃娃") && !in_bank("放天燈喔"));
    // 投稿的人看得到結果，不能收回審過的
    let mine = app.get(MINE, Some(&alice)).await.body;
    assert_eq!(mine["submitted"], 2);
    let statuses: Vec<&str> = mine["words"].as_array().unwrap().iter().map(|w| w["status"].as_str().unwrap()).collect();
    assert_eq!(statuses, ["rejected", "approved", "approved"]);
    let path = format!("{MINE}/{}", ids[0]);
    assert_eq!(app.call("DELETE", &path, Some(&alice), None).await.status, StatusCode::NOT_FOUND);
    // 沒通過的不能再投，管理員刪掉後才可以
    let again = json!({ "words": ["放天燈喔"], "category": "節日", "level": 2 });
    let reply = app.call("POST", MINE, Some(&alice), Some(again.clone())).await;
    assert_eq!(reply.body["skipped"][0]["reason"], "之前沒有通過審核");
    assert_eq!(
        app.call("DELETE", &format!("{ADMIN}/{}", ids[2]), Some(&admin), None).await.status,
        StatusCode::NO_CONTENT
    );
    assert_eq!(app.call("POST", MINE, Some(&alice), Some(again)).await.status, StatusCode::CREATED);

    // 拿掉通過的詞，題庫跟著變
    assert_eq!(
        app.call("DELETE", &format!("{ADMIN}/{}", ids[1]), Some(&admin), None).await.status,
        StatusCode::NO_CONTENT
    );
    assert!(!in_bank("夾娃娃") && in_bank("珍奶雪花冰"));
    assert_eq!(
        app.call("DELETE", &format!("{ADMIN}/{}", ids[1]), Some(&admin), None).await.status,
        StatusCode::NOT_FOUND
    );

    // 管理員投稿直接通過
    assert_eq!(app.get(MINE, Some(&admin)).await.body["trusted"], true);
    let body = json!({ "words": ["鹹酥龍珠"], "category": "食物", "level": 3 });
    let reply = app.call("POST", MINE, Some(&admin), Some(body)).await;
    assert_eq!(reply.status, StatusCode::CREATED);
    assert!(in_bank("鹹酥龍珠"));
    assert_eq!(app.get(MINE, Some(&admin)).await.body["words"][0]["status"], "approved");
}
