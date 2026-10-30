-- 日曆的個人事項，每個使用者只看得到自己的。
-- 日期都是 YYYY-MM-DD（使用者當地的日期，不帶時區），end_date 含當天，多天的事項 end_date > start_date。
-- 重複規則由前端展開（農曆重複要換算農曆）：
--   repeat          none / daily / weekly / monthly / yearly / lunar_monthly / lunar_yearly
--   repeat_interval 每幾個單位一次（每 N 天、每 N 週…），農曆固定是 1
--   weekdays        weekly 用的星期位元遮罩，bit 0 = 星期日
--   repeat_until    最後一次可以開始的日期（含），NULL 是永遠重複
--   excluded        單獨刪掉的那幾次的開始日期（JSON 字串陣列）

CREATE TABLE calendar_events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    title           TEXT    NOT NULL,
    note            TEXT    NOT NULL DEFAULT '',
    color           TEXT    NOT NULL DEFAULT 'orange',
    start_date      TEXT    NOT NULL,
    end_date        TEXT    NOT NULL,
    repeat          TEXT    NOT NULL DEFAULT 'none',
    repeat_interval INTEGER NOT NULL DEFAULT 1,
    weekdays        INTEGER NOT NULL DEFAULT 0,
    repeat_until    TEXT,
    excluded        TEXT    NOT NULL DEFAULT '[]',
    created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX calendar_events_user_id ON calendar_events (user_id, start_date);
