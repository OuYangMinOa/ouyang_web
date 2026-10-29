#!/usr/bin/env bash
# 在伺服器上執行：deploy.sh <staging|prod> <image>
# 需要環境變數 GHCR_USER / GHCR_TOKEN（由 GitHub Actions 的 GITHUB_TOKEN 帶入，只在這次部署期間有效）
set -euo pipefail

env_name=$1
export IMAGE=$2
cd "$(dirname "$0")"

echo "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin
trap 'docker logout ghcr.io >/dev/null' EXIT

compose=(docker compose -p "ouyang-web-$env_name" --env-file "$env_name.env")
"${compose[@]}" pull
"${compose[@]}" up -d --remove-orphans

port=$(grep '^HOST_PORT=' "$env_name.env" | cut -d= -f2)
for _ in $(seq 1 15); do
  if curl -fsS "http://127.0.0.1:$port/api/health"; then
    echo
    docker image prune -f >/dev/null
    exit 0
  fi
  sleep 2
done

echo "health check failed" >&2
"${compose[@]}" logs --tail 50
exit 1
