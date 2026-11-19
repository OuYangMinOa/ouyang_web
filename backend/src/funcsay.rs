//! 幹話語錄：語錄和讚／倒讚的總數放在主機上的語錄服務（Func-say 的 FastAPI + MariaDB，Android APP 也在用），
//! 這裡代理讀取，沒登入也能看。登入的人按讚、倒讚時，先在這裡記下每個帳號按了什麼（同一則只算一票），
//! 再把 +1／-1 轉給語錄服務，兩邊看到的數字一樣。收藏只存在這裡。
//!
//! 語錄服務的網址是 `FUNCSAY_API_URL`（compose.yaml 預設 `http://host.docker.internal:7666`），沒設定時 API 回 503。
//!
//! ```text
//! GET  {FUNCSAY_API_URL}/funcs                 [{C_Id, FUNC, SOURCE, LOVE, HATE}]   SOURCE 沒有是字串 "None"，政治類開頭是 "政治:"
//! GET  {FUNCSAY_API_URL}/funcs/{id}            同上的一筆
//! POST / DELETE {FUNCSAY_API_URL}/funcs/{id}/love   LOVE +1 / -1（最低 0）
//! POST / DELETE {FUNCSAY_API_URL}/funcs/{id}/hate   HATE +1 / -1（最低 0）
//! ```

use std::{collections::BTreeMap, env, sync::Arc, time::Duration};

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use tokio::sync::Mutex;

use crate::{AppError, AppState, auth::CurrentUser, weather::Cached};

/// 整份清單快取多久；Android APP 那邊的票數最多晚這麼久才看得到，自己投的票會馬上換上去
const LIST_TTL: Duration = Duration::from_secs(60);
const UNAVAILABLE: &str = "幹話語錄的資料來源暫時連不上，請稍後再試";

pub struct FuncSay {
    /// 語錄服務的網址（結尾沒有 `/`），沒設定是 None
    base: Option<String>,
    http: reqwest::Client,
    quotes: Cached<Vec<Quote>>,
    /// 投票要先看這個帳號原本按了什麼、改語錄服務的數字、再記下來，兩個請求同時做會多算或少算，所以一次一個。
    /// 語錄服務在同一台主機上，一次只要幾毫秒
    voting: Mutex<()>,
}

impl Default for FuncSay {
    fn default() -> Self {
        Self::new(None)
    }
}

impl FuncSay {
    pub fn from_env() -> Self {
        Self::new(env::var("FUNCSAY_API_URL").ok().as_deref())
    }

    pub fn new(base: Option<&str>) -> Self {
        let base = base.map(|url| url.trim().trim_end_matches('/').to_owned()).filter(|url| !url.is_empty());
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(3))
            .timeout(Duration::from_secs(10))
            .build()
            .expect("failed to build http client");
        Self { base, http, quotes: Cached::default(), voting: Mutex::new(()) }
    }

    fn base(&self) -> Result<&str, AppError> {
        self.base.as_deref().ok_or(AppError::ServiceUnavailable("幹話語錄的資料來源沒有設定"))
    }

    async fn quotes(&self) -> Result<Arc<Vec<Quote>>, AppError> {
        let base = self.base()?;
        self.quotes.get(LIST_TTL, || self.fetch_all(base)).await
    }

    async fn fetch_all(&self, base: &str) -> Result<Vec<Quote>, String> {
        let url = format!("{base}/funcs");
        let rows: Vec<Row> = self.get_json(&url).await?;
        let mut quotes: Vec<Quote> = rows.into_iter().map(Quote::from).collect();
        quotes.sort_by_key(|quote| quote.id);
        Ok(quotes)
    }

    async fn fetch_one(&self, base: &str, id: i64) -> Result<Quote, String> {
        let row: Row = self.get_json(&format!("{base}/funcs/{id}")).await?;
        Ok(row.into())
    }

    async fn get_json<T: for<'de> Deserialize<'de>>(&self, url: &str) -> Result<T, String> {
        let response = self.http.get(url).send().await.map_err(|err| format!("{url}: {err}"))?;
        let status = response.status();
        if !status.is_success() {
            return Err(format!("{url}: HTTP {status}"));
        }
        response.json().await.map_err(|err| format!("{url}: {err}"))
    }

    /// 語錄服務的讚或倒讚 +1（`add`）或 -1
    async fn adjust(&self, base: &str, id: i64, vote: Vote, add: bool) -> Result<(), AppError> {
        let url = format!("{base}/funcs/{id}/{}", vote.as_str());
        let request = if add { self.http.post(&url) } else { self.http.delete(&url) };
        match request.send().await {
            Ok(response) if response.status().is_success() => Ok(()),
            Ok(response) => {
                tracing::warn!(%url, status = %response.status(), "funcsay vote rejected");
                Err(AppError::ServiceUnavailable(UNAVAILABLE))
            }
            Err(error) => {
                tracing::warn!(%url, %error, "funcsay vote failed");
                Err(AppError::ServiceUnavailable(UNAVAILABLE))
            }
        }
    }
}

/// 語錄服務回傳的一筆（FUNC_TABLE 的欄位）
#[derive(Deserialize)]
struct Row {
    #[serde(rename = "C_Id")]
    id: i64,
    #[serde(rename = "FUNC")]
    text: String,
    #[serde(rename = "SOURCE", default)]
    source: Option<String>,
    #[serde(rename = "LOVE", default)]
    love: i64,
    #[serde(rename = "HATE", default)]
    hate: i64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Quote {
    pub id: i64,
    pub text: String,
    /// 由來、出處；沒有是空字串
    pub source: String,
    /// 政治類（Android APP 預設不顯示）
    pub politics: bool,
    pub love: i64,
    pub hate: i64,
}

impl From<Row> for Quote {
    fn from(row: Row) -> Self {
        let raw = row.source.unwrap_or_default();
        let raw = raw.trim();
        // 跟 Android APP 一樣：出處提到「政治」就算政治類。開頭的「政治:」是分類，不顯示
        let politics = raw.contains("政治");
        let source = raw.strip_prefix("政治:").or_else(|| raw.strip_prefix("政治：")).unwrap_or(raw).trim();
        // 語錄服務把 NULL 印成 Python 的 "None"
        let source = if source == "None" { "" } else { source };
        Self {
            id: row.id,
            text: row.text.trim().to_owned(),
            source: source.to_owned(),
            politics,
            love: row.love.max(0),
            hate: row.hate.max(0),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Vote {
    Love,
    Hate,
}

impl Vote {
    fn as_str(self) -> &'static str {
        match self {
            Self::Love => "love",
            Self::Hate => "hate",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "love" => Some(Self::Love),
            "hate" => Some(Self::Hate),
            _ => None,
        }
    }
}

#[derive(Serialize)]
pub struct Listing {
    pub quotes: Arc<Vec<Quote>>,
    /// 自己按過的讚和收藏；沒登入是 null
    pub mine: Option<Mine>,
}

#[derive(Serialize)]
pub struct Mine {
    /// 語錄編號 → love／hate
    pub votes: BTreeMap<i64, Vote>,
    /// 新收藏的在前
    pub favorites: Vec<i64>,
}

pub async fn list(State(state): State<AppState>, user: Option<CurrentUser>) -> Result<Json<Listing>, AppError> {
    let quotes = state.funcsay.quotes().await?;
    let mine = match user {
        Some(user) => Some(mine(&state.pool, user.id).await?),
        None => None,
    };
    Ok(Json(Listing { quotes, mine }))
}

async fn mine(pool: &SqlitePool, user_id: i64) -> Result<Mine, AppError> {
    let votes: Vec<(i64, String)> = sqlx::query_as("SELECT quote_id, vote FROM funcsay_votes WHERE user_id = ?")
        .bind(user_id)
        .fetch_all(pool)
        .await?;
    let favorites = sqlx::query_scalar(
        "SELECT quote_id FROM funcsay_favorites WHERE user_id = ? ORDER BY created_at DESC, rowid DESC",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await?;
    let votes = votes.into_iter().filter_map(|(id, vote)| Some((id, Vote::parse(&vote)?))).collect();
    Ok(Mine { votes, favorites })
}

async fn current_vote(pool: &SqlitePool, user_id: i64, quote_id: i64) -> Result<Option<Vote>, AppError> {
    let vote: Option<String> = sqlx::query_scalar("SELECT vote FROM funcsay_votes WHERE user_id = ? AND quote_id = ?")
        .bind(user_id)
        .bind(quote_id)
        .fetch_optional(pool)
        .await?;
    Ok(vote.as_deref().and_then(Vote::parse))
}

/// 只收語錄服務裡有的編號，免得被塞一堆不存在的收藏或投票
async fn existing(state: &AppState, id: i64) -> Result<Quote, AppError> {
    state.funcsay.quotes().await?.iter().find(|quote| quote.id == id).cloned().ok_or(AppError::NotFound)
}

#[derive(Deserialize)]
pub struct SetVote {
    /// love、hate，或 null 收回
    pub vote: Option<Vote>,
}

#[derive(Serialize)]
pub struct Voted {
    /// 投完之後的票數
    pub quote: Quote,
    pub vote: Option<Vote>,
}

/// 讚和倒讚只能選一個：從讚換成倒讚時，語錄服務那邊讚 -1、倒讚 +1
pub async fn vote(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<i64>,
    Json(body): Json<SetVote>,
) -> Result<Json<Voted>, AppError> {
    let funcsay = &state.funcsay;
    let base = funcsay.base()?;
    let mut quote = existing(&state, id).await?;
    let new = body.vote;

    let _turn = funcsay.voting.lock().await;
    let old = current_vote(&state.pool, user.id, id).await?;
    if old == new {
        return Ok(Json(Voted { quote, vote: new }));
    }

    // 先改語錄服務，失敗就什麼都沒變；換邊時第二步失敗，把第一步改回去
    if let Some(old) = old {
        funcsay.adjust(base, id, old, false).await?;
    }
    if let Some(new) = new
        && let Err(err) = funcsay.adjust(base, id, new, true).await
    {
        if let Some(old) = old
            && funcsay.adjust(base, id, old, true).await.is_err()
        {
            tracing::warn!(id, "funcsay vote half applied: could not restore the previous vote");
        }
        return Err(err);
    }

    match new {
        Some(vote) => {
            sqlx::query(
                "INSERT INTO funcsay_votes (user_id, quote_id, vote) VALUES (?, ?, ?)
                 ON CONFLICT (user_id, quote_id) DO UPDATE SET vote = excluded.vote, created_at = excluded.created_at",
            )
            .bind(user.id)
            .bind(id)
            .bind(vote.as_str())
            .execute(&state.pool)
            .await?;
        }
        None => {
            sqlx::query("DELETE FROM funcsay_votes WHERE user_id = ? AND quote_id = ?")
                .bind(user.id)
                .bind(id)
                .execute(&state.pool)
                .await?;
        }
    }

    // 拿最新的票數（Android 那邊也可能剛投過）；拿不到就用快取的數字自己加減
    quote = match funcsay.fetch_one(base, id).await {
        Ok(fresh) => fresh,
        Err(error) => {
            tracing::warn!(%error, "funcsay refresh after vote failed");
            apply(quote, old, new)
        }
    };
    let updated = quote.clone();
    funcsay
        .quotes
        .modify(|quotes| {
            if let Some(slot) = quotes.iter_mut().find(|q| q.id == id) {
                *slot = updated;
            }
        })
        .await;
    Ok(Json(Voted { quote, vote: new }))
}

fn apply(mut quote: Quote, old: Option<Vote>, new: Option<Vote>) -> Quote {
    fn count(quote: &mut Quote, vote: Vote) -> &mut i64 {
        match vote {
            Vote::Love => &mut quote.love,
            Vote::Hate => &mut quote.hate,
        }
    }
    if let Some(old) = old {
        let n = count(&mut quote, old);
        *n = (*n - 1).max(0);
    }
    if let Some(new) = new {
        *count(&mut quote, new) += 1;
    }
    quote
}

#[derive(Deserialize)]
pub struct SetFavorite {
    pub favorite: bool,
}

pub async fn favorite(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<i64>,
    Json(body): Json<SetFavorite>,
) -> Result<StatusCode, AppError> {
    if body.favorite {
        existing(&state, id).await?;
        sqlx::query("INSERT OR IGNORE INTO funcsay_favorites (user_id, quote_id) VALUES (?, ?)")
            .bind(user.id)
            .bind(id)
            .execute(&state.pool)
            .await?;
    } else {
        // 取消不用問語錄服務：語錄被刪掉之後也要能從收藏拿掉
        sqlx::query("DELETE FROM funcsay_favorites WHERE user_id = ? AND quote_id = ?")
            .bind(user.id)
            .bind(id)
            .execute(&state.pool)
            .await?;
    }
    Ok(StatusCode::NO_CONTENT)
}
