-- 魔法氣泡單人模式的排行榜：每個帳號只留最高分那一局。
-- 分數由前端算好送上來，後端只做粗略的合理性檢查（見 src/puyo_scores.rs）。
--   max_chain    那一局打出的最大連鎖數
--   duration_ms  那一局玩了多久（不含暫停）
--   achieved_at  打出這個分數的時間；同分時先打出來的排前面

CREATE TABLE puyo_scores (
    user_id     INTEGER PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    score       INTEGER NOT NULL,
    max_chain   INTEGER NOT NULL,
    level       INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    achieved_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX puyo_scores_rank ON puyo_scores (score DESC, achieved_at);
