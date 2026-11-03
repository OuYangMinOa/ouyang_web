-- 短網址，見 src/short_links.rs
--   short_links        每個帳號自己的短網址；網址是 /s/<code>，require_login 是要不要登入才跳轉
--   short_link_clicks  每一次跳轉的來源 IP、帳號（有登入的話）、User-Agent 和 Referer，刪掉短網址時一起刪

CREATE TABLE short_links (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    code          TEXT    NOT NULL UNIQUE,
    url           TEXT    NOT NULL,
    title         TEXT    NOT NULL DEFAULT '',
    require_login INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX short_links_user ON short_links (user_id, id);

CREATE TABLE short_link_clicks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    link_id    INTEGER NOT NULL REFERENCES short_links (id) ON DELETE CASCADE,
    ip         TEXT    NOT NULL,
    user_id    INTEGER REFERENCES users (id) ON DELETE SET NULL,
    user_agent TEXT    NOT NULL DEFAULT '',
    referer    TEXT    NOT NULL DEFAULT '',
    created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX short_link_clicks_link ON short_link_clicks (link_id, id);
CREATE INDEX short_link_clicks_created_at ON short_link_clicks (created_at);
