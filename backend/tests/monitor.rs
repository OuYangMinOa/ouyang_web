use std::{path::PathBuf, sync::Arc};

use crate::common::{TestApp, app};
use axum::http::StatusCode;
use backend::{
    auth::upsert_admin,
    monitor::{Monitor, Target},
    router,
};
use serde_json::{Value, json};

async fn login_admin(app: &TestApp) -> String {
    upsert_admin(&app.state.pool, "alice", "password123".into()).await.unwrap();
    let reply = app
        .call("POST", "/api/auth/login", None, Some(json!({ "username": "alice", "password": "password123" })))
        .await;
    reply.cookie.unwrap()
}

/// 假的 /proc：兩顆 CPU、一個 systemd 服務（bot）、一個 Docker 容器，以及自己（self）
fn fake_proc(test: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("ouyang-web-proc-{test}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("sys/kernel")).unwrap();
    std::fs::create_dir_all(dir.join("1/net")).unwrap();
    std::fs::write(dir.join("sys/kernel/osrelease"), "6.8.0-1015-aws\n").unwrap();
    std::fs::write(dir.join("cpuinfo"), "processor\t: 0\nmodel name\t: Intel Xeon\n").unwrap();
    std::fs::write(dir.join("uptime"), "3600.50 7000.00\n").unwrap();
    std::fs::write(dir.join("loadavg"), "0.50 0.25 0.10 1/200 999\n").unwrap();
    std::fs::write(
        dir.join("meminfo"),
        "MemTotal:        2000000 kB\nMemFree:          100000 kB\nMemAvailable:     500000 kB\nSwapTotal:             0 kB\nSwapFree:              0 kB\n",
    )
    .unwrap();
    write_counters(&dir, 0);
    write_process(&dir, 100, "python3\0/home/ubuntu/Xiao-Xia/main.py\0", "0::/system.slice/xiao-xia.service", 0);
    write_process(&dir, 200, "traefik\0", "0::/../docker-0123456789abcdef0123456789abcdef.scope", 0);
    write_process(&dir, 300, "/app/backend\0", "0::/", 0);
    std::fs::create_dir_all(dir.join("self")).unwrap();
    std::fs::write(dir.join("self/cgroup"), "0::/\n").unwrap();
    // kernel thread：沒有指令列，不列出來
    write_process(&dir, 2, "", "0::/", 0);
    dir
}

/// `step` 越大，累計值越多：每一步 CPU 忙 100 ticks、閒 100 ticks，網路收 1000 送 500，磁碟讀 8 寫 16 個 sector
fn write_counters(dir: &std::path::Path, step: u64) {
    let busy = 1000 + step * 100;
    let idle = 1000 + step * 100;
    std::fs::write(
        dir.join("stat"),
        format!(
            "cpu  {busy} 0 0 {idle} 0 0 0 0 0 0\ncpu0 0 0 0 0 0 0 0 0 0 0\ncpu1 0 0 0 0 0 0 0 0 0 0\nbtime 1700000000\n"
        ),
    )
    .unwrap();
    std::fs::write(
        dir.join("1/net/dev"),
        format!(
            "Inter-|\n face |\n    lo: 5 0 0 0 0 0 0 0 5 0\n  ens5: {} 0 0 0 0 0 0 0 {} 0\n",
            step * 1000,
            step * 500
        ),
    )
    .unwrap();
    std::fs::write(
        dir.join("diskstats"),
        format!(
            " 259 0 nvme0n1 1 0 {} 0 1 0 {} 0 0 0 0\n 259 1 nvme0n1p1 1 0 999 0 1 0 999 0 0 0 0\n",
            step * 8,
            step * 16
        ),
    )
    .unwrap();
}

fn write_process(dir: &std::path::Path, pid: u32, cmdline: &str, cgroup: &str, ticks: u64) {
    let p = dir.join(pid.to_string());
    std::fs::create_dir_all(&p).unwrap();
    // 第 14、15 欄是 utime、stime，第 20 欄 threads，第 22 欄 starttime，第 24 欄 rss（page）
    std::fs::write(
        p.join("stat"),
        format!("{pid} (x y) S 1 1 1 0 -1 0 0 0 0 0 {ticks} 0 0 0 20 0 3 0 {} 0 {} 0", pid * 100, pid * 10),
    )
    .unwrap();
    std::fs::write(p.join("cmdline"), cmdline).unwrap();
    std::fs::write(p.join("cgroup"), format!("{cgroup}\n")).unwrap();
}

#[tokio::test]
async fn requires_admin() {
    let app = app().await;
    assert_eq!(app.get("/api/admin/system", None).await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(app.get("/api/admin/system/history", None).await.status, StatusCode::UNAUTHORIZED);
    let reply =
        app.call("POST", "/api/admin/system/targets", None, Some(json!({ "label": "a", "pattern": "b" }))).await;
    assert_eq!(reply.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn reports_unavailable_without_proc() {
    let mut app = app().await;
    let admin = login_admin(&app).await;
    let monitor = Arc::new(Monitor::new(std::env::temp_dir().join("ouyang-web-no-proc"), "."));
    assert!(monitor.sample(&[]).is_err());
    app.state.monitor = monitor;
    app.router = router(app.state.clone(), std::path::Path::new("does-not-exist"));

    let reply = app.get("/api/admin/system", Some(&admin)).await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.body["snapshot"], Value::Null);
    assert!(reply.body["error"].as_str().unwrap().contains("ouyang-web-no-proc"));
}

#[tokio::test]
async fn samples_host_and_groups_processes() {
    let proc_dir = fake_proc("groups");
    let mut app = app().await;
    let admin = login_admin(&app).await;
    let monitor = Arc::new(Monitor::new(&proc_dir, "."));
    app.state.monitor = monitor.clone();
    app.router = router(app.state.clone(), std::path::Path::new("does-not-exist"));

    // 監控清單：小俠在跑，另一個沒在跑
    let reply = app
        .call(
            "POST",
            "/api/admin/system/targets",
            Some(&admin),
            Some(json!({ "label": "小俠", "pattern": "xiao-XIA" })),
        )
        .await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
    let bot_id = reply.body["id"].as_i64().unwrap();
    let reply = app
        .call("POST", "/api/admin/system/targets", Some(&admin), Some(json!({ "label": "不存在", "pattern": "nope" })))
        .await;
    let missing_id = reply.body["id"].as_i64().unwrap();
    let reply = app
        .call("POST", "/api/admin/system/targets", Some(&admin), Some(json!({ "label": " ", "pattern": "x" })))
        .await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST);

    let targets = vec![
        Target { id: bot_id, label: "小俠".into(), pattern: "xiao-XIA".into() },
        Target { id: missing_id, label: "不存在".into(), pattern: "nope".into() },
    ];
    monitor.sample(&targets).unwrap();
    // 第一次沒有上一次可以比，CPU 是 null，也還沒有歷史
    let body = app.get("/api/admin/system", Some(&admin)).await.body;
    assert_eq!(body["snapshot"]["cpu"], Value::Null);
    assert_eq!(body["snapshot"]["cpus"], 2);
    assert_eq!(body["snapshot"]["kernel"], "6.8.0-1015-aws");
    assert_eq!(body["snapshot"]["memory"]["total"], 2_000_000 * 1024);
    assert_eq!(app.get("/api/admin/system/history", Some(&admin)).await.body["points"], json!([]));

    std::thread::sleep(std::time::Duration::from_millis(50));
    write_counters(&proc_dir, 1);
    write_process(&proc_dir, 100, "python3\0/home/ubuntu/Xiao-Xia/main.py\0", "0::/system.slice/xiao-xia.service", 5);
    monitor.sample(&targets).unwrap();

    let body = app.get("/api/admin/system", Some(&admin)).await.body;
    let snapshot = &body["snapshot"];
    assert_eq!(snapshot["cpu"]["busy"], 50.0);
    assert_eq!(snapshot["load"], json!([0.5, 0.25, 0.1]));
    assert!(snapshot["net"]["rx_bps"].as_f64().unwrap() > 0.0);
    assert!(snapshot["disk_io"]["write_bps"].as_f64().unwrap() > snapshot["disk_io"]["read_bps"].as_f64().unwrap());

    let groups = snapshot["groups"].as_array().unwrap();
    let kinds: Vec<(&str, &str)> =
        groups.iter().map(|g| (g["kind"].as_str().unwrap(), g["name"].as_str().unwrap())).collect();
    // 依記憶體由大到小，kernel thread 不算
    assert_eq!(kinds, [("self", ""), ("container", "0123456789ab"), ("service", "xiao-xia")]);
    let bot = &groups[2];
    assert_eq!(bot["rss"], 100 * 10 * 4096);
    assert_eq!(bot["processes"][0]["cmd"], "python3 /home/ubuntu/Xiao-Xia/main.py");
    assert_eq!(bot["processes"][0]["threads"], 3);
    assert!(bot["cpu"].as_f64().unwrap() > 0.0);
    assert_eq!(bot["started_at"], 1_700_000_000 + 100);

    let targets = body["targets"].as_array().unwrap();
    assert_eq!((targets[0]["label"].clone(), targets[0]["processes"].clone()), (json!("小俠"), json!(1)));
    assert_eq!(targets[1]["processes"], 0);
    assert_eq!(targets[1]["started_at"], Value::Null);

    let history = app.get("/api/admin/system/history", Some(&admin)).await.body;
    assert_eq!(history["step_secs"], 5);
    let points = history["points"].as_array().unwrap();
    assert_eq!(points.len(), 1);
    assert_eq!(points[0]["cpu"], 50.0);
    assert_eq!(points[0]["targets"][0]["processes"], 1.0);
    // 不到一分鐘的也平均起來給 24 小時的圖
    let day = app.get("/api/admin/system/history?range=24h", Some(&admin)).await.body;
    assert_eq!((day["step_secs"].clone(), day["points"].as_array().unwrap().len()), (json!(60), 1));

    assert_eq!(
        app.call("DELETE", &format!("/api/admin/system/targets/{missing_id}"), Some(&admin), None).await.status,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        app.call("DELETE", &format!("/api/admin/system/targets/{missing_id}"), Some(&admin), None).await.status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(app.get("/api/admin/system", Some(&admin)).await.body["targets"].as_array().unwrap().len(), 1);

    let _ = std::fs::remove_dir_all(&proc_dir);
}

async fn stored_samples(app: &TestApp) -> Vec<(i64, i64)> {
    sqlx::query_as("SELECT t, samples FROM monitor_points ORDER BY t").fetch_all(&app.state.pool).await.unwrap()
}

/// 跨過整分鐘時把上一分鐘的平均寫進資料庫。換版時新舊兩個容器都在取樣，同一分鐘留取樣點多的；
/// 重啟後 24 小時、7 天的圖從資料庫讀，1 小時的圖用分鐘點補上重啟前的部分。
#[tokio::test]
async fn keeps_minutes_in_database_across_restarts() {
    let proc_dir = fake_proc("minutes");
    let mut app = app().await;
    let admin = login_admin(&app).await;
    let now = chrono::Utc::now().timestamp_millis();
    // 10 分鐘前的整分鐘
    let m = now - now.rem_euclid(60_000) - 10 * 60_000;

    let old = Monitor::new(&proc_dir, ".");
    let new = Monitor::new(&proc_dir, ".");
    let mut step = 0;
    let mut tick = |monitor: &Monitor, secs: i64| {
        write_counters(&proc_dir, step);
        step += 1;
        monitor.sample_at(&[], m + secs * 1000).unwrap();
    };

    // 第 m 分鐘：舊容器 3 個點（第一次取樣沒有上一次可以比，不算），新容器中途啟動只有 1 個點
    for secs in [0, 5, 10, 15] {
        tick(&old, secs);
    }
    tick(&new, 40);
    tick(&new, 45);
    // 下一分鐘的第一個點把上一分鐘平均起來
    tick(&old, 60);
    tick(&new, 65);
    // 新容器先寫進去，舊容器的點比較多，蓋過去
    new.flush(&app.state.pool).await.unwrap();
    assert_eq!(stored_samples(&app).await, [(m, 1)]);
    old.flush(&app.state.pool).await.unwrap();
    assert_eq!(stored_samples(&app).await, [(m, 3)]);

    // 第 m+1 分鐘：舊容器先寫，新容器的點比較少，不蓋
    tick(&old, 70);
    tick(&old, 80);
    tick(&old, 120);
    tick(&new, 125);
    old.flush(&app.state.pool).await.unwrap();
    new.flush(&app.state.pool).await.unwrap();
    assert_eq!(stored_samples(&app).await, [(m, 3), (m + 60_000, 3)]);

    // 3 天前同一個 10 分鐘裡的兩分鐘（7 天的圖平均成一點），以及超過 7 天的
    let week_ago = now - 3 * 86_400_000;
    let bucket = week_ago - week_ago.rem_euclid(600_000);
    for (t, cpu) in [(bucket, 20.0), (bucket + 60_000, 40.0), (now - 8 * 86_400_000, 90.0)] {
        sqlx::query("INSERT INTO monitor_points (t, samples, cpu, mem_used, rx_bps, tx_bps, read_bps, write_bps) VALUES (?, 12, ?, 0, 0, 0, 0, 0)")
            .bind(t)
            .bind(cpu)
            .execute(&app.state.pool)
            .await
            .unwrap();
    }

    // 重啟：記憶體裡什麼都沒有，只取樣了一次（還沒有點）
    let restarted = Arc::new(Monitor::new(&proc_dir, "."));
    write_counters(&proc_dir, step);
    restarted.sample_at(&[], m + 180_000).unwrap();
    app.state.monitor = restarted.clone();
    app.router = router(app.state.clone(), std::path::Path::new("does-not-exist"));

    let times = |body: &Value| -> Vec<i64> {
        body["points"].as_array().unwrap().iter().map(|p| p["t"].as_i64().unwrap()).collect()
    };
    let day = app.get("/api/admin/system/history?range=24h", Some(&admin)).await.body;
    assert_eq!(day["step_secs"], 60);
    assert_eq!(times(&day), [m, m + 60_000]);
    assert_eq!(day["points"][0]["cpu"], 50.0);

    let week = app.get("/api/admin/system/history?range=7d", Some(&admin)).await.body;
    assert_eq!(week["step_secs"], 600);
    let week_times = times(&week);
    assert_eq!(week_times[0], bucket);
    assert_eq!(week["points"][0]["cpu"], 30.0);
    // 最近的兩分鐘可能落在同一個或相鄰的 10 分鐘
    assert!(matches!(week_times.len(), 2 | 3), "{week_times:?}");

    // 1 小時：重啟後的 5 秒點接在資料庫的分鐘點後面
    assert_eq!(times(&app.get("/api/admin/system/history?range=1h", Some(&admin)).await.body), [m, m + 60_000]);
    write_counters(&proc_dir, step + 1);
    restarted.sample_at(&[], m + 185_000).unwrap();
    let hour = app.get("/api/admin/system/history?range=1h", Some(&admin)).await.body;
    assert_eq!(hour["step_secs"], 5);
    assert_eq!(times(&hour), [m, m + 60_000, m + 185_000]);

    let _ = std::fs::remove_dir_all(&proc_dir);
}
