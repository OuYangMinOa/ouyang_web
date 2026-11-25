-- 米其林地圖（src/michelin.rs）的個人資料：登入才能用，每個人只看得到自己的。
-- 餐廳本身是靜態資料（src/michelin_restaurants.json），這裡只存餐廳的 id（米其林網址最後一段）。

-- 想吃／吃過：每家一列，兩個只能選一個；取消就整列刪掉
--   status      want（想吃）或 been（吃過）
--   visited_on  吃過的日期 YYYY-MM-DD，不知道就是 NULL；只有 been 會有
CREATE TABLE michelin_marks (
    user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    restaurant TEXT    NOT NULL,
    status     TEXT    NOT NULL CHECK (status IN ('want', 'been')),
    visited_on TEXT,
    updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    PRIMARY KEY (user_id, restaurant)
);

-- 訂位提醒：到了 remind_at 推播通知給這個人所有開了通知的瀏覽器
--   remind_at  UTC，固定 YYYY-MM-DDTHH:MM:SSZ（字串比較就是時間先後）
--   sent_at    送出的時間；還沒送是 NULL。送之前先把它填上，兩個容器同時在跑也只會送一次
CREATE TABLE michelin_reminders (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    restaurant TEXT    NOT NULL,
    remind_at  TEXT    NOT NULL,
    note       TEXT    NOT NULL DEFAULT '',
    sent_at    TEXT,
    created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX michelin_reminders_due ON michelin_reminders (remind_at) WHERE sent_at IS NULL;
CREATE INDEX michelin_reminders_user ON michelin_reminders (user_id, remind_at);
