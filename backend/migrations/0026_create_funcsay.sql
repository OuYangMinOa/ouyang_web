-- 幹話語錄（src/funcsay.rs）：語錄本身和讚／倒讚的總數在主機上的語錄服務（Func-say，Android APP 也在用），
-- 這裡只記每個帳號按了什麼，同一個帳號對同一則只算一票。
--   quote_id  語錄服務的 C_Id
--   vote      love（讚）或 hate（倒讚），兩個只能選一個；收回就整列刪掉
CREATE TABLE funcsay_votes (
    user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    quote_id   INTEGER NOT NULL,
    vote       TEXT    NOT NULL CHECK (vote IN ('love', 'hate')),
    created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    PRIMARY KEY (user_id, quote_id)
);

-- 收藏只存在這裡，跟語錄服務無關
CREATE TABLE funcsay_favorites (
    user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    quote_id   INTEGER NOT NULL,
    created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    PRIMARY KEY (user_id, quote_id)
);
