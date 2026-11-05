//! 你畫我猜的投稿題目：登入的人投稿，管理員在系統管理裡審核，通過的詞和內建詞庫一起出題，所有房間都會出到。
//!
//! - 一次可以投好幾個詞（同一個分類和難度）。格式不對、題庫裡已經有、已經有人投過的會跳過，並告訴投稿的人原因；
//!   比對用跟猜題一樣的正規化（全形半形、英文大小寫不分）。
//! - 待審核的可以自己收回；之後就由管理員處理。沒通過的詞會一直擋著不能再投，管理員刪掉那筆才能再投。
//! - 有「管理使用者」權限的人投稿直接通過，不用自己審自己。
//! - 遊戲用的詞庫放在記憶體（`draw::set_submitted`）：伺服器啟動時讀一次，之後每次改到通過的詞就重讀。

use std::collections::{HashMap, HashSet};

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::{
    AppError, AppState,
    auth::{AdminUsers, CurrentUser, Permission, Require},
    draw::{self, Entry, Level, WORDS},
};

/// 一個詞幾個字（跟內建詞庫一樣）
pub const MIN_CHARS: usize = 2;
pub const MAX_CHARS: usize = 8;
pub const MAX_CATEGORY_CHARS: usize = 6;
/// 一次最多投幾個
pub const MAX_PER_SUBMIT: usize = 50;
/// 每個人最多同時有幾個待審核的；全站的上限，避免被灌爆
const MAX_PENDING_PER_USER: i64 = 200;
const MAX_PENDING: i64 = 3000;
/// 「我的投稿」列出最近幾筆；管理頁列出最近幾筆沒通過的
const MAX_MINE: i64 = 500;
const MAX_REJECTED_LISTED: i64 = 300;
/// 管理員一次最多審幾筆
const MAX_REVIEW: usize = 500;

/// 比對重複用的樣子：跟猜題時的比對方式一樣
fn norm(word: &str) -> String {
    draw::normalize(word).into_iter().collect()
}

/// 檢查一個詞，回傳去掉前後空白的樣子；不行的話回傳原因
pub fn check_word(raw: &str) -> Result<String, String> {
    let word = raw.trim();
    // 提示是一個字一個字揭露的，空白和標點會變成送分題
    if !word.chars().all(char::is_alphanumeric) {
        return Err("只能有文字和數字，不能有空白或標點".into());
    }
    if !(MIN_CHARS..=MAX_CHARS).contains(&word.chars().count()) {
        return Err(format!("要 {MIN_CHARS}～{MAX_CHARS} 個字"));
    }
    Ok(word.to_owned())
}

fn check_category(raw: &str) -> Result<String, AppError> {
    let category = raw.trim();
    let len = category.chars().count();
    if len == 0 || len > MAX_CATEGORY_CHARS || category.chars().any(char::is_control) {
        return Err(AppError::BadRequest(format!("分類要 1～{MAX_CATEGORY_CHARS} 個字")));
    }
    Ok(category.to_owned())
}

fn check_level(level: u8) -> Result<u8, AppError> {
    Level::from_number(level.into()).map(Level::number).ok_or_else(|| AppError::BadRequest("難度只能是 1～3".into()))
}

/// 從資料庫重讀通過的詞，換掉遊戲用的詞庫（之後開的局才會用到）
pub async fn reload(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    let rows = sqlx::query_as::<_, (String, String, i64)>(
        "SELECT word, category, level FROM draw_words WHERE status = 'approved' ORDER BY id",
    )
    .fetch_all(pool)
    .await?;
    draw::set_submitted(
        rows.into_iter()
            .filter_map(|(word, category, level)| Some(Entry { word, category, level: Level::from_number(level)? }))
            .collect(),
    );
    Ok(())
}

/// 題庫裡現有的分類，照內建詞庫的順序，投稿的新分類接在後面
fn categories(bank: &[Entry]) -> Vec<String> {
    let mut seen = HashSet::new();
    bank.iter().filter(|e| seen.insert(e.category.as_str())).map(|e| e.category.clone()).collect()
}

#[derive(Serialize, sqlx::FromRow)]
pub struct Word {
    pub id: i64,
    pub word: String,
    pub category: String,
    pub level: i64,
    pub status: String,
    pub created_at: String,
    pub reviewed_at: Option<String>,
    /// 投稿和審核的帳號，只在管理頁有
    #[serde(skip_serializing_if = "Option::is_none")]
    pub submitter: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reviewer: Option<String>,
}

/// 投稿連同投稿者、審核者帳號的查詢，後面接上 WHERE / ORDER BY
macro_rules! word_query {
    ($tail:literal) => {
        concat!(
            "SELECT w.id, w.word, w.category, w.level, w.status, w.created_at, w.reviewed_at,
                    s.username AS submitter, r.username AS reviewer
             FROM draw_words w LEFT JOIN users s ON s.id = w.user_id LEFT JOIN users r ON r.id = w.reviewed_by ",
            $tail
        )
    };
}

// ---- 投稿 ----

#[derive(Serialize)]
pub struct Mine {
    /// 現有的分類，投稿時可以挑（也可以自己打新的）
    pub categories: Vec<String>,
    /// 題庫裡有幾個詞：內建的、投稿通過的
    pub builtin: usize,
    pub submitted: usize,
    /// 投稿直接通過（管理員）
    pub trusted: bool,
    /// 自己投過的，新的在前
    pub words: Vec<Word>,
}

pub async fn mine(State(state): State<AppState>, user: CurrentUser) -> Result<Json<Mine>, AppError> {
    let words = sqlx::query_as::<_, Word>(
        "SELECT id, word, category, level, status, created_at, reviewed_at, NULL AS submitter, NULL AS reviewer
         FROM draw_words WHERE user_id = ? ORDER BY id DESC LIMIT ?",
    )
    .bind(user.id)
    .bind(MAX_MINE)
    .fetch_all(&state.pool)
    .await?;
    let bank = draw::bank();
    Ok(Json(Mine {
        categories: categories(&bank),
        builtin: WORDS.len(),
        submitted: bank.len().saturating_sub(WORDS.len()),
        trusted: user.has(AdminUsers::NAME),
        words,
    }))
}

#[derive(Deserialize)]
pub struct NewWords {
    pub words: Vec<String>,
    pub category: String,
    pub level: u8,
}

#[derive(Serialize)]
pub struct Skipped {
    pub word: String,
    pub reason: String,
}

#[derive(Serialize)]
pub struct Submitted {
    /// 收下的詞（管理員的已經通過，其他人的待審核）
    pub added: Vec<String>,
    pub skipped: Vec<Skipped>,
}

pub async fn submit(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(input): Json<NewWords>,
) -> Result<(StatusCode, Json<Submitted>), AppError> {
    let category = check_category(&input.category)?;
    let level = check_level(input.level)?;
    let raws: Vec<&str> = input.words.iter().map(|w| w.trim()).filter(|w| !w.is_empty()).collect();
    if raws.is_empty() {
        return Err(AppError::BadRequest("請輸入至少一個詞".into()));
    }
    if raws.len() > MAX_PER_SUBMIT {
        return Err(AppError::BadRequest(format!("一次最多投 {MAX_PER_SUBMIT} 個詞")));
    }
    let trusted = user.has(AdminUsers::NAME);
    let builtin: HashSet<String> = WORDS.iter().map(|e| norm(&e.word)).collect();

    let mut tx = state.pool.begin().await?;
    let mut seen = HashSet::new();
    let mut accepted = Vec::new();
    let mut skipped = Vec::new();
    for raw in raws {
        let skip = |reason: &str| Skipped { word: raw.to_owned(), reason: reason.to_owned() };
        let word = match check_word(raw) {
            Ok(word) => word,
            Err(reason) => {
                skipped.push(skip(&reason));
                continue;
            }
        };
        let key = norm(&word);
        if !seen.insert(key.clone()) {
            skipped.push(skip("重複了"));
            continue;
        }
        if builtin.contains(&key) {
            skipped.push(skip("題庫裡已經有了"));
            continue;
        }
        let existing: Option<String> = sqlx::query_scalar("SELECT status FROM draw_words WHERE norm = ?")
            .bind(&key)
            .fetch_optional(&mut *tx)
            .await?;
        match existing.as_deref() {
            Some("approved") => skipped.push(skip("題庫裡已經有了")),
            Some("pending") => skipped.push(skip("已經有人投稿，正在審核")),
            Some(_) => skipped.push(skip("之前沒有通過審核")),
            None => accepted.push((word, key)),
        }
    }

    if !trusted && !accepted.is_empty() {
        let pending: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM draw_words WHERE status = 'pending'").fetch_one(&mut *tx).await?;
        if pending >= MAX_PENDING {
            return Err(AppError::ServiceUnavailable("待審核的投稿太多了，請過幾天再試"));
        }
        let mine: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM draw_words WHERE status = 'pending' AND user_id = ?")
            .bind(user.id)
            .fetch_one(&mut *tx)
            .await?;
        if mine + accepted.len() as i64 > MAX_PENDING_PER_USER {
            return Err(AppError::BadRequest(format!(
                "待審核的投稿最多 {MAX_PENDING_PER_USER} 個（你現在有 {mine} 個），等審核完再投"
            )));
        }
    }

    let status = if trusted { "approved" } else { "pending" };
    let reviewer = trusted.then_some(user.id);
    let mut added = Vec::new();
    for (word, key) in accepted {
        sqlx::query(
            "INSERT INTO draw_words (word, norm, category, level, status, user_id, reviewed_by, reviewed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, CASE WHEN ? THEN strftime('%Y-%m-%dT%H:%M:%SZ', 'now') END)",
        )
        .bind(&word)
        .bind(key)
        .bind(&category)
        .bind(level)
        .bind(status)
        .bind(user.id)
        .bind(reviewer)
        .bind(trusted)
        .execute(&mut *tx)
        .await?;
        added.push(word);
    }
    tx.commit().await?;
    if trusted && !added.is_empty() {
        reload(&state.pool).await?;
    }
    let code = if added.is_empty() { StatusCode::OK } else { StatusCode::CREATED };
    Ok((code, Json(Submitted { added, skipped })))
}

/// 收回自己待審核的投稿
pub async fn withdraw(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<i64>,
) -> Result<StatusCode, AppError> {
    let result = sqlx::query("DELETE FROM draw_words WHERE id = ? AND user_id = ? AND status = 'pending'")
        .bind(id)
        .bind(user.id)
        .execute(&state.pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    Ok(StatusCode::NO_CONTENT)
}

// ---- 系統管理 ----

/// 一個分類各難度有幾個詞（簡單、普通、困難）
#[derive(Serialize, Default)]
pub struct CategoryCount {
    pub category: String,
    pub builtin: [usize; 3],
    pub submitted: [usize; 3],
}

#[derive(Serialize)]
pub struct Report {
    pub pending: Vec<Word>,
    pub approved: Vec<Word>,
    /// 最近沒通過的
    pub rejected: Vec<Word>,
    pub categories: Vec<String>,
    /// 目前遊戲用的詞庫，每個分類各難度有幾個詞
    pub distribution: Vec<CategoryCount>,
}

fn distribution(bank: &[Entry]) -> Vec<CategoryCount> {
    let mut rows: Vec<CategoryCount> = Vec::new();
    let mut index: HashMap<&str, usize> = HashMap::new();
    for (i, entry) in bank.iter().enumerate() {
        let row = *index.entry(entry.category.as_str()).or_insert_with(|| {
            rows.push(CategoryCount { category: entry.category.clone(), ..CategoryCount::default() });
            rows.len() - 1
        });
        let counts = if i < WORDS.len() { &mut rows[row].builtin } else { &mut rows[row].submitted };
        counts[usize::from(entry.level.number() - 1)] += 1;
    }
    rows
}

async fn report(pool: &SqlitePool) -> Result<Report, AppError> {
    let pending =
        sqlx::query_as::<_, Word>(word_query!("WHERE w.status = 'pending' ORDER BY w.id")).fetch_all(pool).await?;
    let approved = sqlx::query_as::<_, Word>(word_query!("WHERE w.status = 'approved' ORDER BY w.id DESC"))
        .fetch_all(pool)
        .await?;
    let rejected = sqlx::query_as::<_, Word>(word_query!(
        "WHERE w.status = 'rejected' ORDER BY w.reviewed_at DESC, w.id DESC LIMIT ?"
    ))
    .bind(MAX_REJECTED_LISTED)
    .fetch_all(pool)
    .await?;
    let bank = draw::bank();
    Ok(Report { pending, approved, rejected, categories: categories(&bank), distribution: distribution(&bank) })
}

pub async fn admin_list(State(state): State<AppState>, _: Require<AdminUsers>) -> Result<Json<Report>, AppError> {
    Ok(Json(report(&state.pool).await?))
}

#[derive(Deserialize)]
pub struct Review {
    pub ids: Vec<i64>,
    /// approved / rejected
    pub status: String,
}

/// 通過或不通過（可以一次好幾筆，也可以把通過的改成不通過、反過來）；回傳整份新的清單
pub async fn admin_review(
    State(state): State<AppState>,
    Require(me, _): Require<AdminUsers>,
    Json(input): Json<Review>,
) -> Result<Json<Report>, AppError> {
    if !matches!(input.status.as_str(), "approved" | "rejected") {
        return Err(AppError::BadRequest("狀態只能是 approved 或 rejected".into()));
    }
    if input.ids.is_empty() || input.ids.len() > MAX_REVIEW {
        return Err(AppError::BadRequest(format!("一次要審 1～{MAX_REVIEW} 筆")));
    }
    let mut tx = state.pool.begin().await?;
    for id in &input.ids {
        sqlx::query(
            "UPDATE draw_words SET status = ?, reviewed_by = ?, reviewed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
             WHERE id = ? AND status != ?",
        )
        .bind(&input.status)
        .bind(me.id)
        .bind(id)
        .bind(&input.status)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    reload(&state.pool).await?;
    Ok(Json(report(&state.pool).await?))
}

#[derive(Deserialize)]
pub struct WordUpdate {
    pub category: Option<String>,
    pub level: Option<u8>,
}

/// 改分類或難度（審核前後都可以）
pub async fn admin_update(
    State(state): State<AppState>,
    _: Require<AdminUsers>,
    Path(id): Path<i64>,
    Json(input): Json<WordUpdate>,
) -> Result<Json<Word>, AppError> {
    let category = input.category.as_deref().map(check_category).transpose()?;
    let level = input.level.map(check_level).transpose()?;
    let result =
        sqlx::query("UPDATE draw_words SET category = COALESCE(?, category), level = COALESCE(?, level) WHERE id = ?")
            .bind(category)
            .bind(level)
            .bind(id)
            .execute(&state.pool)
            .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    let word = sqlx::query_as::<_, Word>(word_query!("WHERE w.id = ?")).bind(id).fetch_one(&state.pool).await?;
    if word.status == "approved" {
        reload(&state.pool).await?;
    }
    Ok(Json(word))
}

/// 整筆刪掉：通過的會從題庫拿掉，沒通過的刪掉之後那個詞就能再投
pub async fn admin_delete(
    State(state): State<AppState>,
    _: Require<AdminUsers>,
    Path(id): Path<i64>,
) -> Result<StatusCode, AppError> {
    let status: Option<String> = sqlx::query_scalar("DELETE FROM draw_words WHERE id = ? RETURNING status")
        .bind(id)
        .fetch_optional(&state.pool)
        .await?;
    match status.as_deref() {
        None => return Err(AppError::NotFound),
        Some("approved") => reload(&state.pool).await?,
        Some(_) => {}
    }
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checking_words() {
        assert_eq!(check_word("  珍珠奶茶 "), Ok("珍珠奶茶".into()));
        assert_eq!(check_word("卡拉OK"), Ok("卡拉OK".into()));
        assert_eq!(check_word("台北101"), Ok("台北101".into()));
        assert!(check_word("貓").is_err(), "太短");
        assert!(check_word("一二三四五六七八九").is_err(), "太長");
        assert!(check_word("冰淇 淋").is_err(), "中間有空白");
        assert!(check_word("T-shirt").is_err(), "標點");
        assert!(check_word("哈囉！").is_err());
    }

    #[test]
    fn distribution_splits_builtin_and_submitted() {
        let mut bank = WORDS.clone();
        bank.push(Entry { word: "電音三太子".into(), category: "台灣在地".into(), level: Level::Hard });
        bank.push(Entry { word: "貓跳台".into(), category: "寵物".into(), level: Level::Easy });
        let rows = distribution(&bank);
        let builtin: usize = rows.iter().map(|r| r.builtin.iter().sum::<usize>()).sum();
        assert_eq!(builtin, WORDS.len());
        let local = rows.iter().find(|r| r.category == "台灣在地").unwrap();
        assert_eq!(local.submitted, [0, 0, 1]);
        assert_eq!(rows.last().unwrap().category, "寵物", "新的分類接在後面");
        assert_eq!(rows.last().unwrap().submitted, [1, 0, 0]);
        assert_eq!(categories(&bank).last().map(String::as_str), Some("寵物"));
    }
}
