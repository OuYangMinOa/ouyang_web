-- AI 服務的設定，見 src/ai.rs
--   ai_providers  管理員設定的每一組 OpenAI 相容 API（名稱、網址、金鑰、模型）
--   site_settings 的 ai_active_provider 是目前全站使用哪一組（ai_providers.id），沒有這一筆就是不開放 AI 功能

CREATE TABLE ai_providers (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    base_url   TEXT    NOT NULL,
    api_key    TEXT    NOT NULL DEFAULT '',
    model      TEXT    NOT NULL,
    created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
