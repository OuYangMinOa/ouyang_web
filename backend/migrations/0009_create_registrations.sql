-- 註冊申請：送出後先放在這裡，管理員核准才建立帳號（見 src/registration.rs）。
--   status  pending（待審核）/ approved（已核准，帳號已建立）/ rejected（已拒絕）
-- 審核完就清掉密碼雜湊，這張表只留下紀錄。

CREATE TABLE registrations (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    NOT NULL COLLATE NOCASE,
    password_hash TEXT    NOT NULL,
    note          TEXT    NOT NULL DEFAULT '',
    ip            TEXT    NOT NULL,
    status        TEXT    NOT NULL DEFAULT 'pending',
    created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    reviewed_at   TEXT,
    reviewed_by   INTEGER REFERENCES users (id) ON DELETE SET NULL
);
-- 同一個帳號名稱同時只能有一筆待審核；被拒絕後可以再申請
CREATE UNIQUE INDEX registrations_pending_username ON registrations (username) WHERE status = 'pending';
CREATE INDEX registrations_ip ON registrations (ip, created_at);

-- 全站設定，管理員在後台切換。registration_open：1 開放註冊、0 關閉
CREATE TABLE site_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
INSERT INTO site_settings (key, value) VALUES ('registration_open', '0');
