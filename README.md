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
| staging | push 到 `main` | `sha-<commit>` | 8102 |
| prod | 推 `v*` tag | `v1.2.3`、`latest`（直接沿用 staging 的 image） | 80 |

```shell
# 發佈正式版：該 commit 必須已經在 main 上跑完 staging
git tag v0.1.0
git push origin v0.1.0
```

回滾：對舊的 commit 重新打一個新版本 tag，或在伺服器上手動指定舊 image：

```shell
cd ~/ouyang_web/prod
IMAGE=ghcr.io/ouyangminoa/ouyang_web:v0.1.0 docker compose -p ouyang-web-prod --env-file prod.env up -d
```

### 需要的 GitHub secrets

- `SERVER_HOST`：伺服器 IP
- `SERVER_USER`：`ubuntu`
- `SSH_PRIVATE_KEY`：部署專用的 SSH 私鑰（公鑰在伺服器的 `~/.ssh/authorized_keys`）

拉 image 用的是 workflow 的 `GITHUB_TOKEN`，伺服器上不存放長期的 registry 憑證。

### 伺服器上的檔案

```
~/ouyang_web/staging/   compose.yaml、staging.env、deploy.sh（每次部署覆蓋）
~/ouyang_web/prod/      同上
```

資料庫在 Docker volume `ouyang-web-staging_data` / `ouyang-web-prod_data`。
