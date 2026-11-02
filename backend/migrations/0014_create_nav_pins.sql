-- 側邊欄的釘選：每個 APP 一列，有登入就跟著帳號走，換裝置也一樣，見 src/nav_pins.rs
--   app    APP 的 id（網址前綴），例如 tools
--   paths  JSON：釘選的頁面網址，依釘選順序，例如 ["/tools/json","/tools/qrcode"]
--          全部取消也留著 []，前端才分得出「取消光了」和「還沒用過」

CREATE TABLE nav_pins (
    user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    app        TEXT    NOT NULL,
    paths      TEXT    NOT NULL,
    updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    PRIMARY KEY (user_id, app)
);
