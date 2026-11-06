-- 聊天室的私人房間（chat_rooms.rs）：知道代碼的人才進得來。不在房間裡的人（包括管理員）看不到房間、也收不到裡面的訊息
CREATE TABLE chat_rooms (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    -- 加入用的代碼（8 碼大寫英數字）。房主換新代碼、移出成員時會換掉，舊的就不能用了
    code       TEXT    NOT NULL UNIQUE,
    owner_id   INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE chat_room_members (
    room_id   INTEGER NOT NULL REFERENCES chat_rooms (id) ON DELETE CASCADE,
    user_id   INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    -- 看到哪一則（chat_messages.id）為止，之後別人說的話算未讀
    read_id   INTEGER NOT NULL DEFAULT 0,
    joined_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    PRIMARY KEY (room_id, user_id)
);
CREATE INDEX chat_room_members_user ON chat_room_members (user_id);

-- 訊息在哪一間：NULL 是大家共用的大廳。房間刪掉時裡面的訊息跟著刪
ALTER TABLE chat_messages ADD COLUMN room_id INTEGER REFERENCES chat_rooms (id) ON DELETE CASCADE;
CREATE INDEX chat_messages_room ON chat_messages (room_id, id);
