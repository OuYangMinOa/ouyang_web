//! Web Push：讓瀏覽器在背景跳出系統通知（Windows 的通知中心、手機的推播）。
//!
//! ```text
//! GET    /api/push/key             {"key"}  VAPID 公鑰（base64url），瀏覽器訂閱時當 applicationServerKey
//! POST   /api/push/subscriptions   {"endpoint","keys":{"p256dh","auth"}}  登記這個瀏覽器（就是 PushSubscription.toJSON()）
//! DELETE /api/push/subscriptions   {"endpoint"}  取消這個瀏覽器
//! POST   /api/push/test            {"endpoint"}  馬上推一則測試通知給這個瀏覽器
//! ```
//!
//! - 推播服務由瀏覽器決定（Chrome 是 FCM、Edge 是 WNS、Firefox 是 Mozilla、Safari 是 Apple），
//!   伺服器只 POST 到這幾家的網域，不能被拿來打任意網址。
//! - VAPID（RFC 8292）：每次推播帶一個 ES256 簽的 JWT，推播服務用訂閱時給的公鑰確認是本站送的。
//!   金鑰第一次用到時產生，存在 site_settings 的 push_vapid_key（兩個容器同時產生時以先寫進去的為準）。
//!   換掉金鑰的話舊的訂閱全部失效，前端發現公鑰不一樣會自己重新訂閱。
//! - 內容用 aes128gcm 加密（RFC 8291），只有那個瀏覽器解得開，推播服務看不到。
//! - 推播服務回 404／410 代表訂閱已經失效（使用者關掉了通知權限、清了瀏覽器資料），直接刪掉。

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use aws_lc_rs::{
    aead::{AES_128_GCM, Aad, LessSafeKey, Nonce, UnboundKey},
    agreement::{self, ECDH_P256, PrivateKey, UnparsedPublicKey},
    error::Unspecified,
    hmac,
    rand::SystemRandom,
    signature::{ECDSA_P256_SHA256_FIXED_SIGNING, EcdsaKeyPair, KeyPair},
};
use axum::{
    Json,
    extract::State,
    http::{StatusCode, header},
};
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use reqwest::Url;
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::SqlitePool;
use tokio::sync::OnceCell;

use crate::{AppError, AppState, auth::CurrentUser};

/// 瀏覽器的推播服務。endpoint 的主機必須是其中之一或它的子網域
const PUSH_HOSTS: [&str; 4] = [
    "fcm.googleapis.com",        // Chrome、Opera、Samsung…
    "notify.windows.com",        // Edge（wns2-xxx.notify.windows.com）
    "push.services.mozilla.com", // Firefox
    "push.apple.com",            // Safari（web.push.apple.com）
];
const VAPID_SETTING: &str = "push_vapid_key";
/// VAPID 的 sub：推播服務有問題時聯絡誰。沒有設定 APP_HOST 時（本機）用這個
const DEFAULT_SUBJECT: &str = "https://ouyang.app";
/// 推播服務最多替關機的裝置留多久；聊天訊息太舊就沒必要再跳了
const TTL_SECS: u32 = 300;
/// aes128gcm 一筆紀錄最多 4096 bytes，扣掉標頭和驗證碼後留一點餘裕
pub const MAX_PAYLOAD: usize = 3000;
const MAX_ENDPOINT_LEN: usize = 2048;
/// 每個帳號最多幾個瀏覽器，超過就把最舊的刪掉
const MAX_SUBSCRIPTIONS: i64 = 20;

pub struct WebPush {
    vapid: OnceCell<Vapid>,
    http: reqwest::Client,
    subject: String,
    /// 測試用：接受 http 和任何主機的 endpoint（指到測試裡的假推播服務）
    any_endpoint: bool,
}

impl Default for WebPush {
    fn default() -> Self {
        Self::new(DEFAULT_SUBJECT)
    }
}

struct Vapid {
    key: EcdsaKeyPair,
    /// 公鑰（未壓縮的 65 bytes），base64url
    public: String,
}

#[derive(Debug)]
pub enum SendError {
    /// 訂閱已經失效，已經從資料庫刪掉
    Gone,
    /// 推播服務回了其他錯誤（狀態碼、內容的開頭）
    Rejected(u16, String),
    Failed(String),
}

impl std::fmt::Display for SendError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Gone => f.write_str("subscription gone"),
            Self::Rejected(status, body) => write!(f, "push service returned {status}: {body}"),
            Self::Failed(message) => f.write_str(message),
        }
    }
}

#[derive(sqlx::FromRow)]
struct Subscription {
    endpoint: String,
    p256dh: String,
    auth: String,
}

impl WebPush {
    /// `subject` 是 VAPID 的 sub，例如 `https://ouyang.app`
    pub fn new(subject: impl Into<String>) -> Self {
        let http = reqwest::Client::builder()
            // 推播服務不會轉址；不跟著轉址，endpoint 就只會連到上面那幾家
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(15))
            .build()
            .expect("failed to build http client");
        Self { vapid: OnceCell::new(), http, subject: subject.into(), any_endpoint: false }
    }

    pub fn allow_any_endpoint(mut self) -> Self {
        self.any_endpoint = true;
        self
    }

    fn allowed(&self, endpoint: &str) -> Option<Url> {
        let url = Url::parse(endpoint).ok()?;
        if self.any_endpoint {
            return matches!(url.scheme(), "http" | "https").then_some(url);
        }
        let host = url.host_str()?;
        let known = PUSH_HOSTS.iter().any(|d| host == *d || host.strip_suffix(d).is_some_and(|sub| sub.ends_with('.')));
        (url.scheme() == "https" && url.port().is_none() && known).then_some(url)
    }

    async fn vapid(&self, pool: &SqlitePool) -> Result<&Vapid, AppError> {
        self.vapid
            .get_or_try_init(|| async {
                let stored = load_vapid(pool).await?;
                let pkcs8 = match stored {
                    Some(pkcs8) => pkcs8,
                    None => {
                        let generated = EcdsaKeyPair::generate(&ECDSA_P256_SHA256_FIXED_SIGNING)
                            .and_then(|key| key.to_pkcs8v1())
                            .map_err(|err| AppError::Internal(format!("generate vapid key: {err}")))?;
                        sqlx::query("INSERT OR IGNORE INTO site_settings (key, value) VALUES (?, ?)")
                            .bind(VAPID_SETTING)
                            .bind(STANDARD.encode(generated.as_ref()))
                            .execute(pool)
                            .await?;
                        // 另一個容器可能剛好先寫進去了，以資料庫裡的為準
                        load_vapid(pool).await?.ok_or_else(|| AppError::Internal("vapid key missing".into()))?
                    }
                };
                let key = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &pkcs8)
                    .map_err(|err| AppError::Internal(format!("load vapid key: {err}")))?;
                let public = URL_SAFE_NO_PAD.encode(key.public_key().as_ref());
                Ok(Vapid { key, public })
            })
            .await
    }

    /// VAPID 的 Authorization header：`vapid t=<JWT>, k=<公鑰>`
    fn authorization(&self, vapid: &Vapid, endpoint: &Url) -> Result<String, Unspecified> {
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
        let header = URL_SAFE_NO_PAD.encode(br#"{"typ":"JWT","alg":"ES256"}"#);
        // 最長 24 小時；推播服務和本機的時鐘可能差一點，用 12 小時
        let claims =
            json!({ "aud": endpoint.origin().ascii_serialization(), "exp": now + 12 * 3600, "sub": self.subject });
        let claims = URL_SAFE_NO_PAD.encode(claims.to_string());
        let signing_input = format!("{header}.{claims}");
        let signature = vapid.key.sign(&SystemRandom::new(), signing_input.as_bytes())?;
        Ok(format!("vapid t={signing_input}.{}, k={}", URL_SAFE_NO_PAD.encode(signature.as_ref()), vapid.public))
    }

    async fn send(&self, pool: &SqlitePool, sub: &Subscription, payload: &[u8]) -> Result<(), SendError> {
        let failed = |message: String| SendError::Failed(message);
        let url = self.allowed(&sub.endpoint).ok_or_else(|| failed("endpoint not allowed".into()))?;
        let vapid = self.vapid(pool).await.map_err(|err| failed(err.to_string()))?;
        let ua_public = decode_key(&sub.p256dh).ok_or_else(|| failed("bad p256dh".into()))?;
        let auth = decode_key(&sub.auth).ok_or_else(|| failed("bad auth".into()))?;
        let body = encrypt(&ua_public, &auth, payload).map_err(|_| failed("encrypt failed".into()))?;
        let authorization = self.authorization(vapid, &url).map_err(|_| failed("sign failed".into()))?;

        let response = self
            .http
            .post(url)
            .header("TTL", TTL_SECS)
            .header("Urgency", "high")
            .header(header::CONTENT_ENCODING, "aes128gcm")
            .header(header::CONTENT_TYPE, "application/octet-stream")
            .header(header::AUTHORIZATION, authorization)
            .body(body)
            .send()
            .await
            .map_err(|err| failed(err.to_string()))?;
        let status = response.status();
        if status.is_success() {
            return Ok(());
        }
        if status == StatusCode::NOT_FOUND || status == StatusCode::GONE {
            sqlx::query("DELETE FROM push_subscriptions WHERE endpoint = ?")
                .bind(&sub.endpoint)
                .execute(pool)
                .await
                .map_err(|err| failed(err.to_string()))?;
            return Err(SendError::Gone);
        }
        let body = response.text().await.unwrap_or_default();
        Err(SendError::Rejected(status.as_u16(), body.chars().take(200).collect()))
    }
}

async fn load_vapid(pool: &SqlitePool) -> Result<Option<Vec<u8>>, AppError> {
    let stored: Option<String> = sqlx::query_scalar("SELECT value FROM site_settings WHERE key = ?")
        .bind(VAPID_SETTING)
        .fetch_optional(pool)
        .await?;
    stored
        .map(|value| STANDARD.decode(value).map_err(|err| AppError::Internal(format!("decode vapid key: {err}"))))
        .transpose()
}

/// 瀏覽器給的金鑰是 base64url，有的會帶 `=`
fn decode_key(value: &str) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD.decode(value.trim_end_matches('=')).ok()
}

/// 推一則通知給 `user_id` 在 `endpoints` 這幾個瀏覽器上的訂閱（`None` 是這個人所有的訂閱）。
/// 不屬於這個人的 endpoint 會略過；推不出去只記 log。
pub async fn notify(state: &AppState, user_id: i64, endpoints: Option<&[String]>, payload: &Value) {
    let subs =
        sqlx::query_as::<_, Subscription>("SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?")
            .bind(user_id)
            .fetch_all(&state.pool)
            .await;
    let subs = match subs {
        Ok(subs) => subs,
        Err(err) => return tracing::warn!(error = %err, "load push subscriptions"),
    };
    let payload = payload.to_string();
    for sub in subs.iter().filter(|sub| endpoints.is_none_or(|list| list.contains(&sub.endpoint))) {
        match state.push.send(&state.pool, sub, payload.as_bytes()).await {
            Ok(()) | Err(SendError::Gone) => {}
            Err(err) => tracing::warn!(user_id, error = %err, "web push failed"),
        }
    }
}

// ---- 加密（RFC 8291） ----

/// 用一把臨時的金鑰和隨機的 salt 加密，回傳 aes128gcm 的整個 body（標頭＋一筆紀錄）
pub fn encrypt(ua_public: &[u8], auth: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, Unspecified> {
    let as_private = PrivateKey::generate(&ECDH_P256)?;
    let mut salt = [0u8; 16];
    getrandom::fill(&mut salt).map_err(|_| Unspecified)?;
    encrypt_with(&as_private, salt, ua_public, auth, plaintext)
}

fn encrypt_with(
    as_private: &PrivateKey,
    salt: [u8; 16],
    ua_public: &[u8],
    auth: &[u8],
    plaintext: &[u8],
) -> Result<Vec<u8>, Unspecified> {
    let as_public = as_private.compute_public_key()?;
    let as_public = as_public.as_ref();
    let (cek, nonce) = derive(as_private, ua_public, ua_public, as_public, auth, &salt)?;

    // 只有一筆紀錄：內容後面接分隔字元 0x02，不另外補空白
    let mut record = Vec::with_capacity(plaintext.len() + 17);
    record.extend_from_slice(plaintext);
    record.push(2);
    let key = LessSafeKey::new(UnboundKey::new(&AES_128_GCM, &cek)?);
    key.seal_in_place_append_tag(Nonce::try_assume_unique_for_key(&nonce)?, Aad::empty(), &mut record)?;

    let mut body = Vec::with_capacity(21 + as_public.len() + record.len());
    body.extend_from_slice(&salt);
    body.extend_from_slice(&4096u32.to_be_bytes());
    body.push(as_public.len() as u8);
    body.extend_from_slice(as_public);
    body.extend_from_slice(&record);
    Ok(body)
}

/// 解開 `encrypt` 的結果（瀏覽器那一端做的事），測試用
pub fn decrypt(ua_private: &PrivateKey, auth: &[u8], body: &[u8]) -> Result<Vec<u8>, Unspecified> {
    let salt: [u8; 16] = body.get(..16).ok_or(Unspecified)?.try_into().map_err(|_| Unspecified)?;
    let id_len = *body.get(20).ok_or(Unspecified)? as usize;
    let as_public = body.get(21..21 + id_len).ok_or(Unspecified)?;
    let ua_public = ua_private.compute_public_key()?;
    let (cek, nonce) = derive(ua_private, as_public, ua_public.as_ref(), as_public, auth, &salt)?;

    let mut record = body.get(21 + id_len..).ok_or(Unspecified)?.to_vec();
    let key = LessSafeKey::new(UnboundKey::new(&AES_128_GCM, &cek)?);
    let plaintext = key.open_in_place(Nonce::try_assume_unique_for_key(&nonce)?, Aad::empty(), &mut record)?;
    // 去掉補的 0x00 和最後一筆的分隔字元 0x02
    let end = plaintext.iter().rposition(|&b| b != 0).ok_or(Unspecified)?;
    if plaintext[end] != 2 {
        return Err(Unspecified);
    }
    Ok(plaintext[..end].to_vec())
}

/// 從 ECDH 共用密鑰推出內容金鑰（CEK）和 nonce。`peer` 是對方的公鑰；
/// key_info 一律是「瀏覽器公鑰 ‖ 伺服器公鑰」，所以兩端各傳一次
fn derive(
    my_private: &PrivateKey,
    peer: &[u8],
    ua_public: &[u8],
    as_public: &[u8],
    auth: &[u8],
    salt: &[u8],
) -> Result<([u8; 16], [u8; 12]), Unspecified> {
    let ecdh = agreement::agree(my_private, UnparsedPublicKey::new(&ECDH_P256, peer), Unspecified, |secret| {
        Ok(secret.to_vec())
    })?;
    let mut key_info = b"WebPush: info\0".to_vec();
    key_info.extend_from_slice(ua_public);
    key_info.extend_from_slice(as_public);
    let ikm = hkdf(auth, &ecdh, &key_info);
    let cek = hkdf(salt, &ikm, b"Content-Encoding: aes128gcm\0");
    let nonce = hkdf(salt, &ikm, b"Content-Encoding: nonce\0");
    Ok((cek[..16].try_into().expect("16 bytes"), nonce[..12].try_into().expect("12 bytes")))
}

/// HKDF-SHA256，輸出不超過 32 bytes（一個區塊）就夠了
fn hkdf(salt: &[u8], ikm: &[u8], info: &[u8]) -> [u8; 32] {
    let prk = hmac::sign(&hmac::Key::new(hmac::HMAC_SHA256, salt), ikm);
    let mut input = info.to_vec();
    input.push(1);
    let okm = hmac::sign(&hmac::Key::new(hmac::HMAC_SHA256, prk.as_ref()), &input);
    okm.as_ref().try_into().expect("sha256 is 32 bytes")
}

// ---- handlers ----

pub async fn public_key(State(state): State<AppState>, _user: CurrentUser) -> Result<Json<Value>, AppError> {
    let vapid = state.push.vapid(&state.pool).await?;
    Ok(Json(json!({ "key": vapid.public })))
}

#[derive(Deserialize)]
pub struct NewSubscription {
    endpoint: String,
    keys: SubscriptionKeys,
}

#[derive(Deserialize)]
struct SubscriptionKeys {
    p256dh: String,
    auth: String,
}

/// 同一個瀏覽器換了帳號登入時，訂閱就改成新的帳號的
pub async fn subscribe(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(input): Json<NewSubscription>,
) -> Result<StatusCode, AppError> {
    if input.endpoint.len() > MAX_ENDPOINT_LEN || state.push.allowed(&input.endpoint).is_none() {
        return Err(AppError::BadRequest("不支援這個推播服務".into()));
    }
    let p256dh = decode_key(&input.keys.p256dh).filter(|key| key.len() == 65 && key[0] == 4);
    let auth = decode_key(&input.keys.auth).filter(|key| key.len() == 16);
    let (Some(p256dh), Some(auth)) = (p256dh, auth) else {
        return Err(AppError::BadRequest("訂閱的金鑰格式不對".into()));
    };

    let mut tx = state.pool.begin().await?;
    sqlx::query(
        "INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth) VALUES (?, ?, ?, ?)
         ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth",
    )
    .bind(&input.endpoint)
    .bind(user.id)
    .bind(URL_SAFE_NO_PAD.encode(p256dh))
    .bind(URL_SAFE_NO_PAD.encode(auth))
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "DELETE FROM push_subscriptions WHERE user_id = ?1 AND endpoint NOT IN
           (SELECT endpoint FROM push_subscriptions WHERE user_id = ?1 ORDER BY created_at DESC, rowid DESC LIMIT ?2)",
    )
    .bind(user.id)
    .bind(MAX_SUBSCRIPTIONS)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct EndpointInput {
    endpoint: String,
}

pub async fn unsubscribe(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(input): Json<EndpointInput>,
) -> Result<StatusCode, AppError> {
    sqlx::query("DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?")
        .bind(&input.endpoint)
        .bind(user.id)
        .execute(&state.pool)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// 讓使用者確認通知真的跳得出來（Windows 的「專注」模式、瀏覽器的通知設定都可能擋掉）
pub async fn test(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(input): Json<EndpointInput>,
) -> Result<StatusCode, AppError> {
    let sub = sqlx::query_as::<_, Subscription>(
        "SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE endpoint = ? AND user_id = ?",
    )
    .bind(&input.endpoint)
    .bind(user.id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or(AppError::NotFound)?;
    let payload = json!({
        "title": "測試通知",
        "body": "看到這則就代表這個瀏覽器收得到通知了",
        "tag": "push-test",
        "url": "/chat",
    });
    match state.push.send(&state.pool, &sub, payload.to_string().as_bytes()).await {
        Ok(()) => Ok(StatusCode::NO_CONTENT),
        Err(SendError::Gone) => Err(AppError::Conflict("這個瀏覽器的訂閱已經失效，請重新開啟通知".into())),
        Err(err) => {
            tracing::warn!(user_id = user.id, error = %err, "web push test failed");
            Err(AppError::ServiceUnavailable("推播服務沒有收下這則通知，請稍後再試"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b64(value: &str) -> Vec<u8> {
        URL_SAFE_NO_PAD.decode(value.replace([' ', '\n'], "")).unwrap()
    }

    /// RFC 8291 第 5 節的範例：同樣的金鑰和 salt 要加密出一模一樣的 body
    #[test]
    fn matches_rfc8291_example() {
        let as_private =
            PrivateKey::from_private_key(&ECDH_P256, &b64("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw")).unwrap();
        let ua_public = b64("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4");
        let auth = b64("BTBZMqHH6r4Tts7J_aSIgg");
        let salt: [u8; 16] = b64("DGv6ra1nlYgDCS1FRnbzlw").try_into().unwrap();

        let body =
            encrypt_with(&as_private, salt, &ua_public, &auth, b"When I grow up, I want to be a watermelon").unwrap();
        let expected = b64("DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml
             mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT
             pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN");
        assert_eq!(body, expected);

        let ua_private =
            PrivateKey::from_private_key(&ECDH_P256, &b64("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94")).unwrap();
        assert_eq!(decrypt(&ua_private, &auth, &body).unwrap(), b"When I grow up, I want to be a watermelon");
    }

    #[test]
    fn round_trips_with_random_keys() {
        let ua_private = PrivateKey::generate(&ECDH_P256).unwrap();
        let ua_public = ua_private.compute_public_key().unwrap();
        let auth = [7u8; 16];
        let body = encrypt(ua_public.as_ref(), &auth, "中文也可以".as_bytes()).unwrap();
        assert_eq!(decrypt(&ua_private, &auth, &body).unwrap(), "中文也可以".as_bytes());
        // 驗證密鑰不對就解不開
        assert!(decrypt(&ua_private, &[8u8; 16], &body).is_err());
    }

    #[test]
    fn only_known_push_services() {
        let push = WebPush::default();
        for ok in [
            "https://fcm.googleapis.com/fcm/send/abc",
            "https://wns2-sg2p.notify.windows.com/w/?token=abc",
            "https://updates.push.services.mozilla.com/wpush/v2/abc",
            "https://web.push.apple.com/abc",
        ] {
            assert!(push.allowed(ok).is_some(), "{ok}");
        }
        for bad in [
            "http://fcm.googleapis.com/fcm/send/abc",
            "https://fcm.googleapis.com:8443/fcm/send/abc",
            "https://evilfcm.googleapis.com.example.com/x",
            "https://notfcm.googleapis.com.evil/x",
            "https://xnotify.windows.com/x",
            "https://127.0.0.1/x",
            "not a url",
        ] {
            assert!(push.allowed(bad).is_none(), "{bad}");
        }
    }
}
