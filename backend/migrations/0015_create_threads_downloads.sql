-- Threads 影片下載，見 src/threads.rs
--   threads_keys       每個帳號一把下載金鑰，iPhone 捷徑用它呼叫 API（存原文，頁面上要能一直顯示給本人複製）
--   threads_downloads  用金鑰查到影片的紀錄；url 是貼文的網址，video_count 是那則貼文有幾支影片
--   site_settings 的 threads_shortcut_url 是共用捷徑的 iCloud 連結，由管理員在頁面上設定

CREATE TABLE threads_keys (
    user_id    INTEGER PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    key        TEXT    NOT NULL UNIQUE,
    created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE threads_downloads (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    url         TEXT    NOT NULL,
    author      TEXT    NOT NULL,
    caption     TEXT    NOT NULL,
    video_count INTEGER NOT NULL,
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX threads_downloads_user ON threads_downloads (user_id, id);
