-- 魔法氣泡的個人設定（目前只有快捷鍵），格式和 tetris_settings 一樣，見 src/game_settings.rs
--   keys  JSON：{ 動作: [按鍵代碼, …] }，例如 {"left":["ArrowLeft"],"hard":["Space"]}

CREATE TABLE puyo_settings (
    user_id    INTEGER PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    keys       TEXT    NOT NULL,
    updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
