# CLAUDE.md

專案說明、開發與部署流程見 [README.md](README.md)。

## 前端規則（每個頁面都要遵守）

- **亮色與深色主題**：顏色一律使用 `frontend/src/index.css` 定義的 CSS 變數（`--bg`、`--text`、`--accent`…），不要寫死色碼。主題由 `<html data-theme>` 控制（`light` / `dark`，沒設定就跟隨系統），切換邏輯在 `frontend/src/theme.ts`。新增顏色時，亮色和深色兩組都要補上。
- **手機版面**：所有頁面在 360px 寬也要能正常使用，不能出現橫向捲動。
  - 表格在窄螢幕改成卡片排列：每個 `<td>` 加 `data-label`，參考 `pages/admin/Users.tsx` 和 `App.css` 的 `.responsive`。
  - 輸入框字級至少 16px，避免 iOS 自動放大；按鈕的點擊區域至少 40px 高。
  - 並排的元素（`.row`、`.inline-form`）在窄螢幕要能換行或改成直排。
- **導覽**：APP 都登記在 `frontend/src/apps/registry.ts`，頁首的切換面板、側邊欄（窄於 900px 時改成頁首的下拉選單）和首頁卡片都從這裡產生。APP 的路由包在 `<AppLayout>` 底下，不要在頁面裡自己做導覽列。
- 交付前在亮色、深色和手機寬度下各檢查一次。
