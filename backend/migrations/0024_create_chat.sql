-- 聊天室（chat.rs）：登入的人共用的一間
CREATE TABLE chat_messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    body       TEXT    NOT NULL,
    -- 用戶端替每則訊息產生的編號：斷線時不知道送到了沒，重連後用同一個編號重送不會變成兩則
    nonce      TEXT,
    created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE UNIQUE INDEX chat_messages_nonce ON chat_messages (user_id, nonce);

-- Web Push 的訂閱（webpush.rs）：一個瀏覽器一筆，endpoint 是瀏覽器的推播服務（FCM、WNS…）給的網址，
-- p256dh、auth 是瀏覽器給的公鑰和驗證密鑰（base64url），用來加密推播內容
CREATE TABLE push_subscriptions (
    endpoint   TEXT    PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    p256dh     TEXT    NOT NULL,
    auth       TEXT    NOT NULL,
    created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX push_subscriptions_user_id ON push_subscriptions (user_id);

-- VAPID 金鑰（PKCS#8，base64）不在這裡產生：第一次用到時由程式產生並存進 site_settings 的 push_vapid_key
