-- 主機監控的監控清單（見 src/monitor.rs）：cgroup 路徑或指令列含有 pattern（不分大小寫）的行程都算這個目標的，
-- 一個都沒有就顯示沒在跑。例如 label「歐陽小俠」、pattern「Xiao-Xia」。

CREATE TABLE monitor_targets (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    label      TEXT    NOT NULL,
    pattern    TEXT    NOT NULL,
    created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
