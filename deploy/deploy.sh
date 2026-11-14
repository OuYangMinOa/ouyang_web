#!/usr/bin/env bash
# 在伺服器上執行：deploy.sh <staging|prod> <image>
# 需要環境變數 GHCR_USER / GHCR_TOKEN（由 GitHub Actions 的 GITHUB_TOKEN 帶入，只在這次部署期間有效）
set -euo pipefail

ROLLOUT_VERSION=v0.14
ROLLOUT_SHA256=cdeaba6ae9eee3b0b606286e585bbda6787283d801a6ad6d9b9d2bc347fda05b
NETWORK=ouyang-web
# 除了這次部署的 image，本機再留幾個舊版，回滾時不用重新登入 GHCR 拉
KEEP_PREVIOUS_IMAGES=2

env_name=$1
image=$2
cd "$(dirname "$0")"

# compose 和 docker rollout 都會自動讀同目錄的 .env；之後在伺服器上手動操作也只要 cd 進來就好
# secrets.env 是手動放在伺服器上的金鑰（例如 CWA_API_KEY=...），不會被部署覆蓋，也不進 git
{
  cat "$env_name.env"
  if [ -f secrets.env ]; then cat secrets.env; fi
  echo "COMPOSE_PROJECT_NAME=ouyang-web-$env_name"
  echo "IMAGE=$image"
} > .env

plugin=~/.docker/cli-plugins/docker-rollout
if ! echo "$ROLLOUT_SHA256  $plugin" | sha256sum --check --status 2>/dev/null; then
  echo "==> Installing docker-rollout $ROLLOUT_VERSION"
  mkdir -p "$(dirname "$plugin")"
  curl -fsSL "https://raw.githubusercontent.com/wowu/docker-rollout/$ROLLOUT_VERSION/docker-rollout" -o "$plugin.tmp"
  echo "$ROLLOUT_SHA256  $plugin.tmp" | sha256sum --check --status
  chmod +x "$plugin.tmp"
  mv "$plugin.tmp" "$plugin"
fi

echo "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin
trap 'docker logout ghcr.io >/dev/null' EXIT

docker network inspect "$NETWORK" >/dev/null 2>&1 || docker network create "$NETWORK"

# AI 助手網路搜尋用的 SearXNG，staging 和 prod 共用一個（見 searxng/compose.yaml）。
# 複製到兩個環境共用的資料夾再啟動，兩邊輪流部署時掛載路徑才會一樣，不會一直重建容器。
# 搜尋只是 AI 助手的一個工具，啟動失敗不要擋住部署：app 會回「搜尋服務暫時連不上」
searxng_dir="$(cd .. && pwd)/searxng"
mkdir -p "$searxng_dir"
cp searxng/compose.yaml searxng/settings.yml "$searxng_dir/"
if [ ! -s "$searxng_dir/secret" ]; then
  (umask 077 && head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$searxng_dir/secret")
fi
if ! SEARXNG_SECRET=$(cat "$searxng_dir/secret") \
  SEARXNG_SETTINGS_SHA=$(sha256sum "$searxng_dir/settings.yml" | cut -d' ' -f1) \
  docker compose -p ouyang-web-searxng -f "$searxng_dir/compose.yaml" up -d --wait; then
  echo "warning: SearXNG failed to start, AI web search will be unavailable" >&2
fi

docker compose pull app
# 先啟動新容器、等它 healthy，再停掉舊容器；多等幾秒讓 Traefik 把新容器加進負載平衡
docker rollout --timeout 60 --wait-after-healthy 3 app

# Traefik 放在 app 之後：從舊版（app 直接綁 port）升級時，舊容器要先被移除才空得出 port
docker compose -p ouyang-web-traefik -f traefik/compose.yaml up -d --wait

# 用這個環境的網址連本機的 Traefik，才會分流到對的容器；新網域的憑證可能還在申請，所以加 -k
app_host=$(grep '^APP_HOST=' "$env_name.env" | cut -d= -f2)
for _ in $(seq 1 15); do
  if curl -fsSk --resolve "$app_host:443:127.0.0.1" "https://$app_host/api/health"; then
    echo
    # tag 都帶 commit，舊版不是 dangling，image prune 清不到，要自己刪；
    # 只動這個環境的 tag（staging / prod 在同一台），image ls 由新到舊排
    repo=${image%:*}
    docker image ls --filter "reference=$repo:$env_name-*" --format '{{.Repository}}:{{.Tag}}' \
      | grep -vxF -e "$image" -e "$repo:$env_name-latest" \
      | tail -n +$((KEEP_PREVIOUS_IMAGES + 1)) \
      | xargs -r docker image rm >/dev/null || true
    docker image prune -f >/dev/null
    exit 0
  fi
  sleep 2
done

echo "health check failed" >&2
docker compose logs --tail 50 app
exit 1
