-- 假 .env 的後續（見 honeypot.rs）：每個 IP 拿到的假密碼、有人拿假密碼來登入的紀錄、管理員手動解除封鎖的時間。

-- 發出去的假密碼。每個 IP 拿到的都不一樣，之後有人拿來登入，查這裡就知道當初是發給哪個 IP 的。保留 180 天。
CREATE TABLE honeypot_secrets (
    value      TEXT PRIMARY KEY,
    -- 拿到這份假檔案的 IP
    ip         TEXT NOT NULL,
    -- 假檔案裡的哪一行（DB_PASSWORD、ADMIN_PASSWORD…）
    field      TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX honeypot_secrets_created_at ON honeypot_secrets (created_at);

-- 有人拿假密碼來登入。保留 180 天。
CREATE TABLE honeypot_uses (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    -- 拿來登入的 IP
    ip         TEXT NOT NULL,
    -- 用的是哪一行的密碼
    field      TEXT NOT NULL,
    -- 當初拿走假檔案的 IP 和時間（從 honeypot_secrets 複製過來，那邊清掉了也還在）
    issued_ip  TEXT NOT NULL,
    issued_at  TEXT NOT NULL,
    -- 登入時填的帳號
    username   TEXT NOT NULL DEFAULT '',
    user_agent TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX honeypot_uses_created_at ON honeypot_uses (created_at);

-- 管理員按「解除封鎖」的時間：這之前的紀錄不再讓這個 IP 被擋，之後再來拿還是會被擋
CREATE TABLE honeypot_pardons (
    ip         TEXT PRIMARY KEY,
    user_id    INTEGER REFERENCES users (id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- 封鎖前先看這個 IP 最近有沒有帳號登入過（有就不擋），只需要有帳號的那幾筆
CREATE INDEX access_logs_user_ip ON access_logs (ip, created_at) WHERE user_id IS NOT NULL;
