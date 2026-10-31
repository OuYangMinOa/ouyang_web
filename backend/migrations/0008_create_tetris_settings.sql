-- 俄羅斯方塊的個人設定（目前只有快捷鍵），有登入就跟著帳號走，換裝置也一樣。
--   keys  JSON：{ 動作: [按鍵代碼, …] }，例如 {"left":["ArrowLeft"],"hard":["Space"]}，見 src/tetris_settings.rs

CREATE TABLE tetris_settings (
    user_id    INTEGER PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    keys       TEXT    NOT NULL,
    updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
