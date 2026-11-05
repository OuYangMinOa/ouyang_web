-- 主機監控每分鐘的平均（見 src/monitor.rs），換版重啟後 24 小時和 7 天的趨勢圖才不會從零開始。保留 7 天。
-- t 對齊到整分鐘。換版時新舊兩個容器同時在取樣，同一分鐘留取樣點多（samples）的那一筆。

CREATE TABLE monitor_points (
    -- 這一分鐘的開始，Unix 毫秒
    t         INTEGER PRIMARY KEY,
    -- 平均了幾個 5 秒的取樣點，滿的一分鐘是 12
    samples   INTEGER NOT NULL,
    cpu       REAL    NOT NULL,
    mem_used  INTEGER NOT NULL,
    rx_bps    REAL    NOT NULL,
    tx_bps    REAL    NOT NULL,
    read_bps  REAL    NOT NULL,
    write_bps REAL    NOT NULL,
    -- 監控清單各目標的用量：[{"id":1,"cpu":0.5,"rss":123,"processes":1.0}]
    targets   TEXT    NOT NULL DEFAULT '[]'
);
