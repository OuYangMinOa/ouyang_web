-- 權限模型：使用者 ─(user_roles)─ 角色 ─(role_permissions)─ 權限
-- 權限是程式裡的固定字串（例如 admin.users），新的 APP 在自己的 migration 裡登記權限，再授權給需要的角色。

CREATE TABLE users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT    NOT NULL,
    disabled      INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    last_login_at TEXT
);

CREATE TABLE roles (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT ''
);

CREATE TABLE permissions (
    name        TEXT PRIMARY KEY,
    description TEXT NOT NULL DEFAULT ''
);

CREATE TABLE role_permissions (
    role_id    INTEGER NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
    permission TEXT    NOT NULL REFERENCES permissions (name) ON DELETE CASCADE,
    PRIMARY KEY (role_id, permission)
);

CREATE TABLE user_roles (
    user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    role_id INTEGER NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, role_id)
);

-- 只存 token 的 SHA-256：資料庫外洩也無法直接拿來登入
CREATE TABLE sessions (
    token_hash TEXT    PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    expires_at TEXT    NOT NULL
);
CREATE INDEX sessions_user_id ON sessions (user_id);

INSERT INTO roles (name, description) VALUES ('admin', '系統管理員');
INSERT INTO permissions (name, description) VALUES ('admin.users', '管理使用者、重設密碼、指派角色');
INSERT INTO role_permissions (role_id, permission) SELECT id, 'admin.users' FROM roles WHERE name = 'admin';
