-- 隱藏頁面（不在任何選單裡，只有知道網址的人進得來）的瀏覽紀錄。
-- 前端送 open / click / scan / error，後端補上來源 IP、登入的帳號和 User-Agent。

CREATE TABLE page_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    page       TEXT    NOT NULL,
    -- 前端每個分頁產生一個隨機 id，同一次瀏覽的事件靠它串起來
    session    TEXT    NOT NULL,
    action     TEXT    NOT NULL,
    detail     TEXT    NOT NULL DEFAULT '',
    ip         TEXT    NOT NULL,
    user_id    INTEGER REFERENCES users (id) ON DELETE SET NULL,
    user_agent TEXT    NOT NULL DEFAULT '',
    created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX page_events_session ON page_events (page, session);
CREATE INDEX page_events_created_at ON page_events (created_at);
