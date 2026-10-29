# ouyang_web

Rust（Axum + SQLite）後端 + React（Vite）前端，打包成單一 Docker image 部署。

```
frontend/   React + Vite + TypeScript
backend/    Axum + sqlx（SQLite），同時提供 /api 與前端靜態檔
deploy/     伺服器上用的 compose.yaml、各環境設定、deploy.sh
Dockerfile  多階段建置：前端打包 → cargo-chef 編譯 → distroless 執行
```

## 本機開發

```shell
# 後端（:8080，資料庫在 backend/data/app.db）
cd backend
cargo run

# 前端（:5173，/api 會 proxy 到 :8080）
cd frontend
npm install
npm run dev
```

測試：

```shell
cd backend && cargo test
cd frontend && npm run lint && npm run build
```

資料庫 migration 放在 `backend/migrations/`，服務啟動時自動執行。

## 登入與權限

```
使用者 ──user_roles──▶ 角色 ──role_permissions──▶ 權限
alice                  admin（系統管理員）         admin.users
```

- 密碼用 argon2id 雜湊；session 是隨機 token 放在 HttpOnly cookie（`session_<env>`），資料庫只存 token 的 SHA-256，7 天過期。
- 同一個 IP 15 分鐘內登入失敗 10 次會暫停登入。
- 停用帳號、重設密碼會讓該帳號所有裝置登出；自己改密碼只保留目前這個裝置。
- 管理員不能停用自己或移除自己的 `admin` 角色，避免把自己鎖在外面。

頁面：`/login` 登入、`/account` 改密碼、`/admin` 系統管理（需要 `admin.users`）。

### 建立或救回管理員

帳號已存在時會重設密碼、重新啟用並加回 `admin` 角色。密碼從 stdin 讀，不會留在指令列或 shell 歷史裡：

```shell
# 本機
cd backend && cargo run -- create-admin admin

# 伺服器（<env> 是 staging 或 prod），輸入密碼後按 Enter
cd ~/ouyang_web/<env> && docker compose exec -T app /app/backend create-admin admin
```

### 新的 APP 要加權限時

1. 新增 migration，登記權限並授權給角色：
   ```sql
   INSERT INTO permissions (name, description) VALUES ('notes.write', '編輯筆記');
   INSERT INTO role_permissions (role_id, permission) SELECT id, 'notes.write' FROM roles WHERE name = 'admin';
   ```
   需要新角色就 `INSERT INTO roles (name, description) VALUES ('editor', '編輯者');`。
2. 在 `backend/src/auth.rs` 定義權限，handler 參數加上 `Require<NotesWrite>`，沒登入回 401、沒權限回 403：
   ```rust
   pub struct NotesWrite;
   impl Permission for NotesWrite {
       const NAME: &'static str = "notes.write";
   }

   async fn create_note(Require(user, _): Require<NotesWrite>, ...) { ... }
   ```
3. 前端用 `useAuth().can('notes.write')` 決定要不要顯示，用 `<RequireAuth permission="notes.write">` 保護頁面。前端的判斷只是介面，真正的檢查在後端。

> 目前 staging / prod 都還是 HTTP，密碼和 cookie 在網路上是明文傳送。接上 HTTPS 前不要在公共網路登入重要帳號；接上之後在 `<env>.env` 加 `COOKIE_SECURE=true`。

## 小遊戲線上對戰

後端只負責轉送訊息，不懂遊戲規則；規則由兩端各自執行（`frontend/src/games/shared/useRoom.ts`、`backend/src/games.rs`）。不需要登入。

```
POST /api/games/rooms  {"game":"gomoku"}  →  201 {"code":"ABCDE"}      game：gomoku / xiangqi / chess / reversi
GET  /api/games/rooms/{code}/ws?game=<id>&player=<id>                  升級成 WebSocket

client → server  {type:"msg", data}
server → client  {type:"welcome", seat, peer, history:[{seat, data}]}
                 {type:"peer", online}
                 {type:"msg", seat, data}
                 {type:"error", code, message}   之後伺服器關閉連線
```

- 每個房間兩個座位。`player` 是用戶端自己產生的 id，重連時用來拿回同一個座位（舊連線會被關掉），重連後會收到完整歷史。
- 任何一方送出的訊息，伺服器加上 seat 後依序存進歷史並廣播給兩邊（包含送出者），所以兩邊看到的順序完全一樣。
- 連線一律先升級，有問題再送 `error` 後關閉（瀏覽器讀不到升級失敗的 HTTP 狀態）：`not_found`、`game_mismatch`、`full`、`bad_request`，
  以及送太快（每秒超過 20 則）的 `rate_limited`、太大（data 超過 4KB）的 `too_large`、歷史超過 2000 筆的 `history_full`。
- 伺服器每 25 秒送一次 ping；60 秒沒收到任何東西就當作斷線。
- 沒有人連線超過 30 分鐘、或建立超過 24 小時的房間，會在下次有人建立房間時清掉。房間最多 1000 個，超過回 503。

> 房間只存在記憶體，重啟或部署換版後就會消失。換版的幾秒內新舊兩個容器同時存在，建立房間和連線可能落在不同容器而找不到房間；
> 這種情況使用者重新建立房間即可。

## 部署

| 環境 | 觸發 | Image tag | 伺服器 port |
|---|---|---|---|
| staging | merge / push 到 `dev` | `staging-<commit>`、`staging-latest` | 8102 |
| prod | merge 到 `main` | `prod-<commit>`、`prod-latest` | 443（目前是 HTTP，之後接 HTTPS） |

分支流程：

```
feature/xxx ──PR──▶ dev ──PR──▶ main
                     │            │
                  staging        prod
```

- `main` 受保護：只能透過 PR 合併，且 CI 的 `test` 必須通過，不能 force push 或刪除。
- 對 `dev` / `main` 開的 PR 只會跑測試，merge 後才會建置並部署。

### 不斷線部署（Traefik + docker-rollout）

```
外部 ─▶ Traefik（:8102 → staging、:443 → prod）─▶ app 容器（不直接對外綁 port）
```

`deploy.sh` 用 `docker rollout` 換版：先啟動新容器 → 等 healthcheck 通過 → 再等 3 秒讓 Traefik 接上 → 停掉舊容器。

舊容器收到 SIGTERM 後不會馬上關：先讓 `/api/health` 回 503（draining），其他請求照常處理 5 秒（`DRAIN_SECS`），
Traefik 每秒主動檢查 health，看到 503 就把它移出負載平衡，之後才真正停止。換版瞬間的連線錯誤另由 retry middleware 重送。

**migration 必須跟上一版相容**：換版期間新舊兩版會同時跑在同一個 SQLite 上。
例如要改欄位名稱，分兩次部署：先加新欄位並讓程式兩邊都寫，下一版再移除舊欄位。

`/api/health` 會回傳 `commit`，可以用來確認目前是哪一版在接流量。

每次部署成功後會清掉同環境的舊 image：伺服器上只留這次的加上前 2 版（`deploy.sh` 的 `KEEP_PREVIOUS_IMAGES`），
GHCR 上留最近 10 版（workflow 的 `cleanup` job）。

回滾：在伺服器上改 `.env` 的 `IMAGE` 再 rollout（本機現有的版本用 `docker image ls` 看，更舊的 tag 在 GitHub 的 Packages 頁面，要先 `docker login ghcr.io` 才拉得到）：

```shell
cd ~/ouyang_web/prod
sed -i 's#^IMAGE=.*#IMAGE=ghcr.io/ouyangminoa/ouyang_web:prod-<commit>#' .env
docker rollout app
```

### 需要的 GitHub secrets

- `SERVER_HOST`：伺服器 IP
- `SERVER_USER`：`ubuntu`
- `SSH_PRIVATE_KEY`：部署專用的 SSH 私鑰（公鑰在伺服器的 `~/.ssh/authorized_keys`）

拉 image 用的是 workflow 的 `GITHUB_TOKEN`，伺服器上不存放長期的 registry 憑證。

### 伺服器上的檔案

```
~/ouyang_web/staging/   compose.yaml、staging.env、deploy.sh、traefik/（每次部署覆蓋）、.env（deploy.sh 產生）
~/ouyang_web/prod/      同上
```

Traefik 以固定的專案名稱 `ouyang-web-traefik` 執行，staging 和 prod 共用，所以修改 `deploy/traefik/` 會同時影響兩個環境。

資料庫在 Docker volume `ouyang-web-staging_data` / `ouyang-web-prod_data`。
