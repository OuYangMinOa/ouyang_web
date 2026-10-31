-- 全站的 IP 訪問紀錄：每個請求一筆（不含前端打包出來的靜態檔和 /api/health），見 access_log.rs。
-- 保留 30 天。

CREATE TABLE access_logs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ip          TEXT    NOT NULL,
    method      TEXT    NOT NULL,
    path        TEXT    NOT NULL,
    -- 網址 ? 後面的部分（不含 ?），沒有就是空字串
    query       TEXT    NOT NULL DEFAULT '',
    status      INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    -- 寫入時 cookie 對應到的帳號；登入那一次還沒有 cookie、登出那一次 session 已經刪掉，都算訪客
    user_id     INTEGER REFERENCES users (id) ON DELETE SET NULL,
    user_agent  TEXT    NOT NULL DEFAULT '',
    created_at  TEXT    NOT NULL
);
CREATE INDEX access_logs_created_at ON access_logs (created_at);
CREATE INDEX access_logs_ip ON access_logs (ip, created_at);
