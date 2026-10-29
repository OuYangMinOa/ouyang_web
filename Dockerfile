# syntax=docker/dockerfile:1

# ---- 前端：打包成靜態檔 ----
FROM node:22-alpine AS frontend
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ---- 後端：cargo-chef 把相依套件獨立成一層，Cargo.lock 沒變就不會重編 ----
FROM rust:1-bookworm AS chef
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

# ---- 執行：distroless 只有 glibc，沒有 shell ----
FROM gcr.io/distroless/cc-debian12:nonroot
WORKDIR /app
COPY --from=builder /app/target/release/backend /app/backend
COPY --from=frontend /app/dist /app/static
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
