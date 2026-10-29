//! 系統管理 API：全部需要 `admin.users` 權限。

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use serde::{Deserialize, Serialize};
use sqlx::{SqliteConnection, SqlitePool};

use crate::{
    AppError, AppState,
    auth::{AdminUsers, Require, hash_password, validate_password, validate_username},
};

/// 有這個角色才能進系統管理頁；不能從自己身上移除，避免把自己鎖在外面
const ADMIN_ROLE: &str = "admin";

/// 使用者連同角色名稱的查詢，後面接上 WHERE / GROUP BY（用 concat! 組成靜態字串，sqlx 才不會當成動態 SQL）
macro_rules! user_query {
    ($tail:literal) => {
        concat!(
            "SELECT u.id, u.username, u.disabled, u.created_at, u.last_login_at,
                COALESCE(group_concat(r.name, ','), '') AS roles
             FROM users u
             LEFT JOIN user_roles ur ON ur.user_id = u.id
             LEFT JOIN roles r ON r.id = ur.role_id ",
            $tail
        )
    };
}

#[derive(sqlx::FromRow)]
struct UserRow {
    id: i64,
    username: String,
    disabled: bool,
    created_at: String,
    last_login_at: Option<String>,
    roles: String,
}

#[derive(Serialize)]
pub struct AdminUser {
    pub id: i64,
    pub username: String,
    pub disabled: bool,
    pub created_at: String,
    pub last_login_at: Option<String>,
    pub roles: Vec<String>,
}

impl From<UserRow> for AdminUser {
    fn from(row: UserRow) -> Self {
        let mut roles: Vec<String> = row.roles.split(',').filter(|r| !r.is_empty()).map(Into::into).collect();
        roles.sort();
        Self {
            id: row.id,
            username: row.username,
            disabled: row.disabled,
            created_at: row.created_at,
            last_login_at: row.last_login_at,
            roles,
        }
    }
}

async fn fetch_user(pool: &SqlitePool, id: i64) -> Result<AdminUser, AppError> {
    sqlx::query_as::<_, UserRow>(user_query!("WHERE u.id = ? GROUP BY u.id"))
        .bind(id)
        .fetch_optional(pool)
        .await?
        .map(Into::into)
        .ok_or(AppError::NotFound)
}

pub async fn list_users(
    State(state): State<AppState>,
    _: Require<AdminUsers>,
) -> Result<Json<Vec<AdminUser>>, AppError> {
    let rows = sqlx::query_as::<_, UserRow>(user_query!("GROUP BY u.id ORDER BY u.id")).fetch_all(&state.pool).await?;
    Ok(Json(rows.into_iter().map(Into::into).collect()))
}

#[derive(Deserialize)]
pub struct NewUser {
    pub username: String,
    pub password: String,
    #[serde(default)]
    pub roles: Vec<String>,
}

pub async fn create_user(
    State(state): State<AppState>,
    _: Require<AdminUsers>,
    Json(input): Json<NewUser>,
) -> Result<(StatusCode, Json<AdminUser>), AppError> {
    let username = input.username.trim();
    validate_username(username)?;
    validate_password(&input.password)?;
    let hash = hash_password(input.password).await?;

    let mut tx = state.pool.begin().await?;
    let id: i64 = sqlx::query_scalar("INSERT INTO users (username, password_hash) VALUES (?, ?) RETURNING id")
        .bind(username)
        .bind(hash)
        .fetch_one(&mut *tx)
        .await
        .map_err(|err| match err {
            sqlx::Error::Database(ref db) if db.is_unique_violation() => AppError::Conflict("帳號已存在".into()),
            err => err.into(),
        })?;
    set_roles(&mut tx, id, &input.roles).await?;
    tx.commit().await?;

    Ok((StatusCode::CREATED, Json(fetch_user(&state.pool, id).await?)))
}

/// 欄位都是選填，只更新有給的部分
#[derive(Deserialize)]
pub struct UserUpdate {
    pub disabled: Option<bool>,
    pub roles: Option<Vec<String>>,
    pub password: Option<String>,
}

pub async fn update_user(
    State(state): State<AppState>,
    Require(me, _): Require<AdminUsers>,
    Path(id): Path<i64>,
    Json(input): Json<UserUpdate>,
) -> Result<Json<AdminUser>, AppError> {
    if id == me.id {
        if input.disabled == Some(true) {
            return Err(AppError::BadRequest("不能停用自己的帳號".into()));
        }
        if input.roles.as_ref().is_some_and(|roles| !roles.iter().any(|r| r == ADMIN_ROLE)) {
            return Err(AppError::BadRequest("不能移除自己的管理員角色".into()));
        }
    }
    let hash = match input.password {
        Some(password) => {
            validate_password(&password)?;
            Some(hash_password(password).await?)
        }
        None => None,
    };

    let mut tx = state.pool.begin().await?;
    let exists: Option<i64> =
        sqlx::query_scalar("SELECT id FROM users WHERE id = ?").bind(id).fetch_optional(&mut *tx).await?;
    if exists.is_none() {
        return Err(AppError::NotFound);
    }
    if let Some(disabled) = input.disabled {
        sqlx::query("UPDATE users SET disabled = ? WHERE id = ?").bind(disabled).bind(id).execute(&mut *tx).await?;
    }
    if let Some(hash) = &hash {
        sqlx::query("UPDATE users SET password_hash = ? WHERE id = ?").bind(hash).bind(id).execute(&mut *tx).await?;
    }
    if let Some(roles) = &input.roles {
        set_roles(&mut tx, id, roles).await?;
    }
    // 停用或重設密碼後，這個帳號在所有裝置上都要重新登入
    if input.disabled == Some(true) || hash.is_some() {
        sqlx::query("DELETE FROM sessions WHERE user_id = ?").bind(id).execute(&mut *tx).await?;
    }
    tx.commit().await?;

    Ok(Json(fetch_user(&state.pool, id).await?))
}

async fn set_roles(conn: &mut SqliteConnection, user_id: i64, roles: &[String]) -> Result<(), AppError> {
    sqlx::query("DELETE FROM user_roles WHERE user_id = ?").bind(user_id).execute(&mut *conn).await?;
    for name in roles {
        let role_id: i64 = sqlx::query_scalar("SELECT id FROM roles WHERE name = ?")
            .bind(name)
            .fetch_optional(&mut *conn)
            .await?
            .ok_or_else(|| AppError::BadRequest(format!("角色不存在：{name}")))?;
        sqlx::query("INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)")
            .bind(user_id)
            .bind(role_id)
            .execute(&mut *conn)
            .await?;
    }
    Ok(())
}

#[derive(Serialize, sqlx::FromRow)]
pub struct PermissionInfo {
    pub name: String,
    pub description: String,
}

#[derive(Serialize)]
pub struct RoleInfo {
    pub id: i64,
    pub name: String,
    pub description: String,
    pub permissions: Vec<PermissionInfo>,
}

pub async fn list_roles(
    State(state): State<AppState>,
    _: Require<AdminUsers>,
) -> Result<Json<Vec<RoleInfo>>, AppError> {
    let roles = sqlx::query_as::<_, (i64, String, String)>("SELECT id, name, description FROM roles ORDER BY id")
        .fetch_all(&state.pool)
        .await?;
    let grants = sqlx::query_as::<_, (i64, String, String)>(
        "SELECT rp.role_id, p.name, p.description FROM role_permissions rp
         JOIN permissions p ON p.name = rp.permission ORDER BY p.name",
    )
    .fetch_all(&state.pool)
    .await?;

    let roles = roles
        .into_iter()
        .map(|(id, name, description)| RoleInfo {
            id,
            name,
            description,
            permissions: grants
                .iter()
                .filter(|(role_id, ..)| *role_id == id)
                .map(|(_, name, description)| PermissionInfo { name: name.clone(), description: description.clone() })
                .collect(),
        })
        .collect();
    Ok(Json(roles))
}
