-- 米其林星級餐廳的空位（src/michelin_availability.rs）。伺服器不去抓：
-- 家裡電腦上的爬蟲（miclin）每 3 小時看一次訂位系統的公開頁面，跑完把結果上傳到這裡，只留最近 10 次。
--   checked_at   爬蟲跑完的時間，UTC 固定 YYYY-MM-DDTHH:MM:SSZ（字串比較就是時間先後），看的時候拿最新的
--   uploaded_at  收到的時間
--   data         整理過的 JSON：查了哪幾天、每家每種人數每天的狀態和可訂時段（格式見 michelin_availability.rs）
CREATE TABLE michelin_availability (
    id          INTEGER PRIMARY KEY,
    checked_at  TEXT NOT NULL,
    uploaded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    data        TEXT NOT NULL
);

CREATE INDEX michelin_availability_checked ON michelin_availability (checked_at);
