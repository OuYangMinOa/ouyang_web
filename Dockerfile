# syntax=docker/dockerfile:1

# ---- 前端：打包成靜態檔 ----
FROM node:22-alpine AS frontend
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json ./
# @huggingface/transformers 帶進來的 onnxruntime-node 在 linux/x64 安裝時會從 nuget.org 下載 CUDA 的檔案；
# 前端只在瀏覽器用（onnxruntime-web），用不到，跳過免得 nuget.org 連不上就整個失敗
ENV ONNXRUNTIME_NODE_INSTALL=skip
RUN npm ci
COPY frontend/ ./
# 大於 1 KB 的文字檔與 wasm 另存一份 .gz，後端直接送壓縮版（去背用的 onnxruntime wasm 從 27 MB 降到約 7 MB）
RUN npm run build \
 && find dist -type f \( -name '*.js' -o -name '*.mjs' -o -name '*.css' -o -name '*.html' -o -name '*.svg' -o -name '*.json' -o -name '*.wasm' -o -name '*.flf' \) \
      -size +1k -exec gzip -k -9 {} +

# ---- 後端：cargo-chef 把相依套件獨立成一層，Cargo.lock 沒變就不會重編 ----
# Rust 連 digest 一起固定：rust:1-bookworm 這種浮動 tag 一更新（Rust 小版本、Debian 更新），Docker 快取就全部失效，
# 整條 Rust 重編約 4 分鐘。這一段只負責編譯，最後的映像是 distroless，不會因此少了安全更新。
# 升級時版本和 digest 一起改（digest 用 docker buildx imagetools inspect rust:<版本>-bookworm 查）；
# CI 的 cargo test 也從這一行讀版本，兩邊用同一版編譯。
FROM rust:1.99.1-bookworm@sha256:cfcbed05398d0f6f81b7c3a24579475c567f97007ae7837ab421f9ca3e66333d AS chef
RUN cargo install cargo-chef --locked
WORKDIR /app

FROM chef AS planner
COPY backend/ ./
RUN cargo chef prepare --recipe-path recipe.json

FROM chef AS builder
COPY --from=planner /app/recipe.json recipe.json
RUN cargo chef cook --release --recipe-path recipe.json
COPY backend/ ./
RUN cargo build --release --locked && mkdir -p /out/data

# ---- YouTube 下載工具（見 backend/src/youtube.rs）----
# yt-dlp 用 PyInstaller 打包的版本（不用裝 Python），另外要 libz；Deno 給 yt-dlp 解 YouTube 的簽章，ffmpeg 合併影音。
# YouTube 改版時 yt-dlp 會壞掉，到 https://github.com/yt-dlp/yt-dlp/releases 換新版號重新部署
FROM debian:bookworm-slim AS youtube
ARG YTDLP_VERSION=2026.10.26
ADD --chmod=755 https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp_linux /out/yt-dlp

# ---- 執行：distroless 只有 glibc，沒有 shell ----
FROM gcr.io/distroless/cc-debian12:nonroot
WORKDIR /app
COPY --from=builder /app/target/release/backend /app/backend
COPY --from=frontend /app/dist /app/static
COPY --from=youtube /out/yt-dlp /usr/local/bin/yt-dlp
COPY --from=youtube /lib/x86_64-linux-gnu/libz.so.1 /lib/x86_64-linux-gnu/libz.so.1
COPY --from=denoland/deno:bin-2.9.8 /deno /usr/local/bin/deno
COPY --from=mwader/static-ffmpeg:7.1 /ffmpeg /usr/local/bin/ffmpeg
# 讓第一次掛上的 named volume 繼承 nonroot 的擁有者
COPY --from=builder --chown=65532:65532 /out/data /data
ARG GIT_SHA=unknown
ENV DATABASE_URL=sqlite:///data/app.db \
    STATIC_DIR=/app/static \
    PORT=8080 \
    GIT_SHA=$GIT_SHA
EXPOSE 8080
# docker-rollout 等這個變成 healthy 才移除舊容器；Traefik 也只把流量送給 healthy 的容器
HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=3 \
    CMD ["/app/backend", "healthcheck"]
ENTRYPOINT ["/app/backend"]
