-- 即時方塊遊戲的操作手感（DAS、ARR），有登入就跟著帳號走，見 src/game_settings.rs
--   game      遊戲 id，例如 tetris
--   handling  JSON，例如 {"das":170,"arr":40}（毫秒）

CREATE TABLE game_handling (
    user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    game       TEXT    NOT NULL,
    handling   TEXT    NOT NULL,
    updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    PRIMARY KEY (user_id, game)
);
