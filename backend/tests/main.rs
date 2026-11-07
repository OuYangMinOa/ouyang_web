//! 整合測試全部編成同一個執行檔（`Cargo.toml` 設了 `autotests = false`，只有這個 `[[test]]`）。
//!
//! 每個檔案各自一個執行檔時，每個都要連結一次整個後端和所有相依套件，cargo 也一次只跑一個執行檔；
//! 合在一起只連結一次，不同檔案的測試可以同時跑。
//! 代價是同一個 process：改全域狀態（例如 `draw::set_submitted` 換掉的詞庫）的測試會被其他檔案的測試看到。
//!
//! 新增測試檔時在下面加一行 `mod`，沒加的話 `every_test_file_is_listed` 會失敗。
//! 只跑某個檔案：`cargo test --test integration bigtwo::`

mod common;

mod access_log;
mod ai;
mod ai_chat;
mod api;
mod auth;
mod bigtwo;
mod calendar;
mod chat;
mod draw;
mod draw_words;
mod feedback;
mod game_monitor;
mod game_settings;
mod games;
mod honeypot;
mod lobby;
mod minesrace;
mod monitor;
mod music;
mod nav_pins;
mod party;
mod puyo;
mod puyo_scores;
mod racing;
mod registration;
mod short_links;
mod tetris;
mod tetris_scores;
mod threads;
mod visits;

/// tests/ 底下的 .rs 都要在上面 mod 進來，不然不會編譯、也不會跑
#[test]
fn every_test_file_is_listed() {
    let listed: Vec<&str> =
        include_str!("main.rs").lines().filter_map(|line| line.strip_prefix("mod ")?.strip_suffix(';')).collect();
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests");
    let mut missing: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "rs"))
        .filter_map(|path| Some(path.file_stem()?.to_str()?.to_owned()))
        .filter(|name| name != "main" && !listed.contains(&name.as_str()))
        .collect();
    missing.sort();
    assert!(missing.is_empty(), "tests/main.rs 沒有 mod 這些檔案：{missing:?}");
}
