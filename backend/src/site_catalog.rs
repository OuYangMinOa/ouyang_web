//! 本站的功能清單：前端 build 時從 APP、小工具、小遊戲的登記產生的 `site-catalog.json`
//! （`frontend/scripts/site-catalog.mjs`），後端從 `STATIC_DIR` 讀。
//! AI 助手的「搜尋本站功能」（`ai_builtin.rs`）和給爬蟲的網站地圖（`crawlers.rs`）都從這裡查。

use std::path::Path;

use serde::Deserialize;

/// 功能清單裡的一項
#[derive(Deserialize, Debug, Clone)]
pub struct CatalogItem {
    /// app、tool、game、page
    pub kind: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub url: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub players: Option<String>,
    #[serde(default)]
    pub login: bool,
    /// 要有這個權限才看得到（例如系統管理）
    #[serde(default)]
    pub permission: Option<String>,
    #[serde(default)]
    pub pages: Vec<CatalogPage>,
}

impl CatalogItem {
    /// 沒登入也看得到
    pub fn is_public(&self) -> bool {
        !self.login && self.permission.is_none()
    }
}

#[derive(Deserialize, Debug, Clone)]
pub struct CatalogPage {
    pub label: String,
    pub url: String,
}

#[derive(Deserialize)]
pub struct Catalog {
    pub items: Vec<CatalogItem>,
}

/// 讀功能清單。錯誤訊息會給 AI 看，寫成一句話
pub async fn load(path: &Path) -> Result<Catalog, String> {
    let text =
        tokio::fs::read_to_string(path).await.map_err(|_| "還沒有本站的功能清單（前端還沒 build）".to_owned())?;
    serde_json::from_str(&text).map_err(|_| "本站的功能清單格式不對".to_owned())
}
