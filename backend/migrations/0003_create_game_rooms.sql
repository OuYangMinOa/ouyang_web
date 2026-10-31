-- 小遊戲線上對戰的房間。存進資料庫，重啟或換版後還能接著下；伺服器還是只轉送，不懂遊戲規則。
-- 換版時新舊兩個容器會同時讀寫：座位用條件式 UPDATE 搶，事件用 (room_code, seq) 主鍵擋住重複的序號。

CREATE TABLE game_rooms (
    code       TEXT PRIMARY KEY,
    game       TEXT NOT NULL,
    -- 坐在這個座位的 player：登入的人是 user:<帳號 id>，訪客是 guest:<用戶端產生的 id>
    seat0      TEXT,
    seat1      TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    -- 最後一次有人坐下、送出訊息或離開的時間，用來清掉沒人玩的房間
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE game_events (
    room_code TEXT    NOT NULL REFERENCES game_rooms (code) ON DELETE CASCADE,
    seq       INTEGER NOT NULL,
    seat      INTEGER NOT NULL,
    data      TEXT    NOT NULL,
    PRIMARY KEY (room_code, seq)
);

CREATE TRIGGER game_events_touch_room AFTER INSERT ON game_events BEGIN
    UPDATE game_rooms SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE code = NEW.room_code;
END;
