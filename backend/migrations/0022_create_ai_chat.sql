-- AI 助手，見 src/ai_chat.rs、src/ai_tools.rs、src/mcp.rs、src/ai_usage.rs
--   ai_chats          每個人自己的對話
--   ai_chat_messages  對話裡的每一則：使用者、AI 的回答（可能要呼叫工具）、工具的結果
--   ai_mcp_servers    管理員接上的 MCP 伺服器（Streamable HTTP），tools 是最近一次讀到的工具清單
--   ai_tool_settings  每個工具要不要開放、執行前要不要使用者確認（沒有這一筆就用工具自己的預設）
--   ai_usage          每一次呼叫 AI 的用量，用來算每天的額度和給管理員看
--   ai_user_limits    個別使用者的額度（NULL 是用全站預設），blocked 是不讓這個人用 AI
-- 全站的預設額度放在 site_settings：ai_daily_requests、ai_daily_tokens、ai_max_running

CREATE TABLE ai_chats (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    title      TEXT    NOT NULL DEFAULT '',
    created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX ai_chats_user ON ai_chats (user_id, updated_at);

-- role       user / assistant / tool
-- tool_calls AI 要呼叫的工具（JSON：[{id, name, arguments}]），只有 assistant 會有
-- tool_*     tool 這一則是在回應哪一個呼叫
-- status     assistant：done / stopped（使用者按停止）/ error
--            tool：pending（等使用者確認）/ done / denied（使用者拒絕）/ error
CREATE TABLE ai_chat_messages (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id           INTEGER NOT NULL REFERENCES ai_chats (id) ON DELETE CASCADE,
    role              TEXT    NOT NULL,
    content           TEXT    NOT NULL DEFAULT '',
    reasoning         TEXT    NOT NULL DEFAULT '',
    tool_calls        TEXT,
    tool_call_id      TEXT,
    tool_name         TEXT,
    tool_arguments    TEXT,
    status            TEXT    NOT NULL DEFAULT 'done',
    prompt_tokens     INTEGER,
    completion_tokens INTEGER,
    created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX ai_chat_messages_chat ON ai_chat_messages (chat_id, id);

CREATE TABLE ai_mcp_servers (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT    NOT NULL,
    prefix           TEXT    NOT NULL UNIQUE,
    url              TEXT    NOT NULL,
    headers          TEXT    NOT NULL DEFAULT '{}',
    enabled          INTEGER NOT NULL DEFAULT 1,
    public           INTEGER NOT NULL DEFAULT 0,
    tools            TEXT    NOT NULL DEFAULT '[]',
    tools_fetched_at TEXT,
    last_error       TEXT,
    created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE ai_tool_settings (
    tool     TEXT    PRIMARY KEY,
    enabled  INTEGER NOT NULL,
    approval INTEGER NOT NULL
);

-- kind  chat（使用者送出一則訊息）/ chat_continue（確認工具後接著做）/ calendar（一句話新增事項）/ title（幫對話取標題）
--       chat 和 calendar 算進每天的次數，全部都算進 token
CREATE TABLE ai_usage (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id           INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    kind              TEXT    NOT NULL,
    prompt_tokens     INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    tool_calls        INTEGER NOT NULL DEFAULT 0,
    ok                INTEGER NOT NULL DEFAULT 1,
    ms                INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX ai_usage_user ON ai_usage (user_id, created_at);
CREATE INDEX ai_usage_created_at ON ai_usage (created_at);

CREATE TABLE ai_user_limits (
    user_id        INTEGER PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    daily_requests INTEGER,
    daily_tokens   INTEGER,
    blocked        INTEGER NOT NULL DEFAULT 0
);
