-- 假的 .env 被拿走的紀錄：掃描器找 /.env、/.env.local、/api/.env 這類設定檔時回一份假的，順便記下是誰，見 honeypot.rs。
-- 保留 180 天。

CREATE TABLE honeypot_hits (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ip         TEXT    NOT NULL,
    method     TEXT    NOT NULL,
    path       TEXT    NOT NULL,
    -- 網址 ? 後面的部分（不含 ?），沒有就是空字串
    query      TEXT    NOT NULL DEFAULT '',
    -- 當時有登入的帳號（通常是管理員自己點開來看）
    user_id    INTEGER REFERENCES users (id) ON DELETE SET NULL,
    user_agent TEXT    NOT NULL DEFAULT '',
    created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX honeypot_hits_created_at ON honeypot_hits (created_at);
CREATE INDEX honeypot_hits_ip ON honeypot_hits (ip, id);
