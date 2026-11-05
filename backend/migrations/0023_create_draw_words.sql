-- 你畫我猜的投稿題目（見 src/draw_words.rs）：登入的人投稿，管理員審核通過後和內建詞庫一起出題，所有房間都會出到。
--   status  pending（待審核）/ approved（已通過）/ rejected（沒通過）
--   level   1 簡單、2 普通、3 困難（投稿的人先選，管理員可以改）
-- word 是投稿時的樣子（去掉前後空白）；norm 是比對用的（全形轉半形、英文小寫，跟遊戲判斷猜中一樣），
-- 同一個詞不管狀態只能有一筆：沒通過的詞也擋著，不會被一直重投（管理員刪掉那筆才能再投）。

CREATE TABLE draw_words (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    word        TEXT    NOT NULL,
    norm        TEXT    NOT NULL UNIQUE,
    category    TEXT    NOT NULL,
    level       INTEGER NOT NULL,
    status      TEXT    NOT NULL DEFAULT 'pending',
    user_id     INTEGER REFERENCES users (id) ON DELETE SET NULL,
    reviewed_by INTEGER REFERENCES users (id) ON DELETE SET NULL,
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    reviewed_at TEXT
);
CREATE INDEX draw_words_status ON draw_words (status, id);
CREATE INDEX draw_words_user ON draw_words (user_id, id);
