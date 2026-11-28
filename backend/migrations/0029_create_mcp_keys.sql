-- 本站 MCP 伺服器（/mcp，見 src/mcp_server.rs）的金鑰：每個人在 MCP 頁面自己建立，貼給自己（或朋友）的 AI 用。
-- 用金鑰呼叫就是以建立的人的身分查；刪掉帳號或停用時一起失效。
--   name          自己取的名字，認得出是給誰的（例如「小明的 Claude」）
--   token_hash    金鑰的 SHA-256；金鑰本身只在建立時顯示一次，不存
--   prefix        金鑰開頭的幾個字，列表上看得出是哪一把
--   last_used_at  最近一次用它呼叫 /mcp 的時間（最多一分鐘更新一次）
CREATE TABLE mcp_keys (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name         TEXT    NOT NULL,
    token_hash   TEXT    NOT NULL UNIQUE,
    prefix       TEXT    NOT NULL,
    created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    last_used_at TEXT
);
CREATE INDEX mcp_keys_user ON mcp_keys (user_id, id);
