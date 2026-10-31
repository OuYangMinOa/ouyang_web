-- 回報與許願：每一筆是一串對話，使用者和管理員可以來回留言、貼圖片（見 src/feedback.rs）。
--   kind    bug（回報問題）/ wish（許願）
--   status  open（處理中）/ closed（已結案；使用者再留言會重新打開）
-- 發問的人是登入的帳號（user_id），或沒登入的訪客（guest：瀏覽器 cookie 裡 token 的 SHA-256）。
-- 登入後也看得到同一個瀏覽器先前以訪客身分送出的。

CREATE TABLE feedback_threads (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    kind       TEXT    NOT NULL,
    title      TEXT    NOT NULL,
    status     TEXT    NOT NULL DEFAULT 'open',
    user_id    INTEGER REFERENCES users (id) ON DELETE SET NULL,
    guest      TEXT,
    ip         TEXT    NOT NULL,
    created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    -- 雙方各自看到哪一則留言（feedback_messages.id），之後對方的留言就算未讀；管理員們共用一個
    user_seen  INTEGER NOT NULL DEFAULT 0,
    admin_seen INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX feedback_threads_user ON feedback_threads (user_id);
CREATE INDEX feedback_threads_guest ON feedback_threads (guest);
CREATE INDEX feedback_threads_ip ON feedback_threads (ip, created_at);

CREATE TABLE feedback_messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id  INTEGER NOT NULL REFERENCES feedback_threads (id) ON DELETE CASCADE,
    from_admin INTEGER NOT NULL DEFAULT 0,
    -- 留言的帳號；訪客是 NULL
    author_id  INTEGER REFERENCES users (id) ON DELETE SET NULL,
    body       TEXT    NOT NULL,
    ip         TEXT    NOT NULL,
    created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX feedback_messages_thread ON feedback_messages (thread_id, id);
CREATE INDEX feedback_messages_ip ON feedback_messages (ip, created_at);

-- 貼上的圖片先上傳（message_id 還是 NULL），送出留言時才掛到那則留言上；
-- 一天後還沒掛上的就刪掉。上傳者跟 feedback_threads 一樣用 user_id / guest 記。
CREATE TABLE feedback_images (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id   INTEGER REFERENCES feedback_messages (id) ON DELETE CASCADE,
    user_id      INTEGER REFERENCES users (id) ON DELETE SET NULL,
    guest        TEXT,
    content_type TEXT    NOT NULL,
    data         BLOB    NOT NULL,
    ip           TEXT    NOT NULL,
    created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX feedback_images_message ON feedback_images (message_id);
CREATE INDEX feedback_images_ip ON feedback_images (ip, created_at);
