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

回滾：在伺服器上改 `.env` 的 `IMAGE` 再 rollout（tag 可以在 GitHub 的 Packages 頁面找到）：

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
