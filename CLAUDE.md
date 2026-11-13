# CLAUDE.md

專案說明、開發與部署流程見 [README.md](README.md)。

## 前端規則（每個頁面都要遵守）

- **外觀：深淺 × 風格**：顏色一律使用 `frontend/src/index.css` 定義的 CSS 變數（`--bg`、`--text`、`--accent`…），不要寫死色碼。外觀是兩個獨立的選擇，切換邏輯在 `frontend/src/theme.ts`：
  - 深淺：`<html data-theme>`（`light` / `dark`，沒設定就跟隨系統）。新增顏色時，亮色和深色兩組都要補上。
  - 風格：`<html data-style>`（沒設定是「墨與陽」，`doodle` 是手繪塗鴉，`mist` 是安靜的「山嵐」，`sticker` 是粗黑框的「貼紙」）。塗鴉和貼紙只換基本色、字型和形狀，專用色（遊戲、日曆…）沿用墨與陽的亮色／深色，不用另外補。山嵐也是，但新增的專用色如果是偏暖的中性色（底色、格子、牌邊這類），要在山嵐補一組冷灰：`index.css` 山嵐的亮色和兩個深色區塊都要列。
  - 用共用的元件（沒有 class 的 `<button>` 和 `.secondary`／`.danger`、`.card`、輸入框、`.menu-panel`、表格）就會自動變成塗鴉的樣子（`frontend/src/doodle.css`）、山嵐的樣子（`frontend/src/mist.css`）或貼紙的樣子（`frontend/src/sticker.css`）。頁面自己的卡片要跟著變時，在該頁的 CSS 用 `:root[data-style='doodle'] .xxx` 補，可以用 `--pen`（筆畫）、`--radius-card`、`--shadow-card` 這些變數（例如 `games/games.css` 的 `.game-card`）。
  - 山嵐的原則是安靜：頁面自己的卡片用 `:root[data-style='mist'] .xxx` 補上 `box-shadow: var(--shadow-card)`，滑過只換顏色，不要位移、發光或加裝飾性的動畫（一樣參考 `.game-card`）。
  - 貼紙：頁面自己的卡片用 `:root[data-style='sticker'] .xxx` 補上 `border: 2px solid var(--ink)`、`border-radius: var(--radius-card)`、`box-shadow: var(--shadow-card)`（白邊加左下的實心影子，卡片之間的間距要留 20px 以上），圖示底色用 `--pop`（一樣參考 `.game-card`）。
  - 換外觀時有全畫面的轉場（View Transitions，`theme.ts` 發動、動畫在 `components/Appearance.css` 最後面）；新增風格要補一種轉場和一張色票（`Appearance.tsx` 的 `STYLES`、`HINTS`，`index.css` 的 `data-preview`），`index.html` 的 inline script 也要認得新的名字。
- **手機版面**：所有頁面在 360px 寬也要能正常使用，不能出現橫向捲動。
  - 表格在窄螢幕改成卡片排列：每個 `<td>` 加 `data-label`，參考 `pages/admin/Users.tsx` 和 `App.css` 的 `.responsive`。
  - 輸入框字級至少 16px，避免 iOS 自動放大；按鈕的點擊區域至少 40px 高。
  - 並排的元素（`.row`、`.inline-form`）在窄螢幕要能換行或改成直排。
- **導覽**：APP 都登記在 `frontend/src/apps/registry.ts`，頁首的切換面板、側邊欄（窄於 900px 時改成頁首的下拉選單）和首頁卡片都從這裡產生。APP 的路由包在 `<AppLayout>` 底下，不要在頁面裡自己做導覽列。
- 交付前在亮色、深色、塗鴉、山嵐和貼紙風格、手機寬度下各檢查一次。
