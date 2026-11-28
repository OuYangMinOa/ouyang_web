//! 給搜尋引擎和網站分類的爬蟲（公司防火牆靠它判斷網站是什麼類別）：`/robots.txt` 和 `/sitemap.xml`。
//!
//! 只有正式站（`APP_ENV=prod`）讓人爬；staging 和本機的 robots.txt 整站擋掉，免得跟正式站重複。
//! 網站地圖和要登入的 APP 都從前端 build 時產生的功能清單（`site_catalog.rs`）來，
//! 新增 APP、小工具、小遊戲只要登記進前端的 registry，這裡就會跟著變。
//! 首頁不跑 JavaScript 也看得到的介紹文字則是 build 時寫進 index.html（`frontend/scripts/site-catalog.mjs`）。

use std::fmt::Write as _;

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};

use crate::{AppState, site_catalog, site_origin};

/// 不是給人看的網址：API 和短網址的跳轉。要登入的 APP 和頁面從功能清單加上去
const DISALLOW: &[&str] = &["/api/", "/s/"];

/// GET /robots.txt
pub async fn robots(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let mut text = String::from("User-agent: *\n");
    if state.app_env != "prod" {
        text.push_str("Disallow: /\n");
        return plain_text(text);
    }
    for path in DISALLOW {
        let _ = writeln!(text, "Disallow: {path}");
    }
    // 要登入或權限的（AI 助手、系統管理、我的帳號…）：爬蟲進去只會被轉到登入頁。
    // 寫成 `/ai$` 和 `/ai/`，不會連 `/aim` 這種剛好同開頭的網址一起擋掉
    if let Ok(catalog) = site_catalog::load(&state.site_catalog).await {
        for item in catalog.items.iter().filter(|item| !item.is_public()) {
            let _ = writeln!(text, "Disallow: {}$\nDisallow: {}/", item.url, item.url);
        }
    }
    if let Some(origin) = site_origin(&headers, state.cookie_secure) {
        let _ = write!(text, "\nSitemap: {origin}/sitemap.xml\n");
    }
    plain_text(text)
}

/// GET /sitemap.xml：首頁、不用登入的 APP、每個小工具和小遊戲、不用登入的其他頁面（回報與許願）
pub async fn sitemap(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let Some(origin) = site_origin(&headers, state.cookie_secure) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let catalog = match site_catalog::load(&state.site_catalog).await {
        Ok(catalog) => catalog,
        Err(message) => return (StatusCode::NOT_FOUND, message).into_response(),
    };
    let mut paths = vec!["/"];
    for item in catalog.items.iter().filter(|item| item.is_public()) {
        if !paths.contains(&item.url.as_str()) {
            paths.push(&item.url);
        }
    }
    let mut xml = String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">\n",
    );
    for path in paths {
        let _ = writeln!(xml, "  <url><loc>{}</loc></url>", escape_xml(&format!("{origin}{path}")));
    }
    xml.push_str("</urlset>\n");
    ([(header::CONTENT_TYPE, "application/xml; charset=utf-8")], xml).into_response()
}

fn plain_text(text: String) -> Response {
    ([(header::CONTENT_TYPE, "text/plain; charset=utf-8")], text).into_response()
}

fn escape_xml(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            c => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xml_special_characters_are_escaped() {
        assert_eq!(
            escape_xml("https://ouyang.app/a?b=1&c=<2>'\""),
            "https://ouyang.app/a?b=1&amp;c=&lt;2&gt;&apos;&quot;"
        );
    }
}
