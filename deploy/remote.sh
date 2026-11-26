#!/usr/bin/env bash
set -euo pipefail

work=$1
port=$2
state="$HOME/ai-gateway-deploy"
umask 077
mkdir -p "$state/releases"
exec 9>"$state/lock"
flock -n 9 || { echo '已有网关部署正在执行' >&2; exit 1; }

# Use the selected release file as the only source of Compose interpolation.
unset GATEWAY_IMAGE POSTGRES_PASSWORD PUBLIC_BASE_URL KEY_DIGEST_SECRET CONNECTION_SECRET \
  BOOTSTRAP_USERNAME JIMENG_ACCOUNT_BASE_URL CODEX_ACCOUNT_BASE_URL KIRO_ACCOUNT_BASE_URL \
  CLAUDE_ACCOUNT_BASE_URL ACCOUNT_CONFIG_DIR JIMENG_DOWNLOAD_HOSTS JIMENG_NETWORK \
  HTTP_PORT HTTPS_PORT SITE_ADDRESS DEPLOY_PORT

compose() {
  local dir=$1
  shift
  local args=(--project-name ai-gateway --env-file "$dir/.env"
    -f "$dir/deploy/compose.yaml" -f "$dir/deploy/compose.remote.yaml")
  if grep -q '^JIMENG_NETWORK=' "$dir/.env"; then
    args+=(-f "$dir/deploy/compose.jimeng.yaml")
  fi
  if grep -q '^ACCOUNT_CONFIG_DIR=' "$dir/.env"; then
    args+=(-f "$dir/deploy/compose.accounts.yaml")
  fi
  docker compose "${args[@]}" "$@"
}

docker info >/dev/null
previous=
if [[ -L "$state/current" ]]; then
  previous=$(readlink "$state/current")
  [[ -f "$previous/.env" ]] || { echo '现有版本缺少运行配置' >&2; exit 1; }
fi
if [[ -z "$previous" && ! -s "$work/.bootstrap-password" ]]; then
  echo '首次部署需要 BOOTSTRAP_USERNAME 和 BOOTSTRAP_PASSWORD' >&2
  exit 1
fi

release=$(mktemp -d "$state/releases/release.XXXXXX")
pointer="$state/.current-${release##*/}"
keys="$pointer.keys"
switch_started=false
cleanup() {
  local status=$?
  rm -f -- "$pointer" "$keys"
  if [[ -L "$state/current" && "$(readlink "$state/current")" == "$release" ]]; then
    return "$status"
  fi
  if [[ "$switch_started" == true ]]; then
    if [[ -n "$previous" ]]; then
      if compose "$previous" up -d --no-build --no-deps app caddy; then
        echo '已重新启动上一个版本的网关和 Caddy 容器' >&2
      else
        echo "容器恢复失败，已保留候选版本目录 $release" >&2
        return "$status"
      fi
    elif ! compose "$release" rm -sf app caddy; then
      echo "容器清理失败，已保留候选版本目录 $release" >&2
      return "$status"
    fi
  fi
  rm -rf -- "$release"
  return "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

mv -- "$work/backend" "$work/frontend" "$work/deploy" "$work/Dockerfile" "$work/.dockerignore" "$release/"
mv -- "$work/release.env" "$release/.env"
printf 'GATEWAY_IMAGE=ai-gateway:%s\n' "${release##*/}" >> "$release/.env"

# The same database volume and encrypted records are reused across releases.
grep -E '^(POSTGRES_PASSWORD|KEY_DIGEST_SECRET|CONNECTION_SECRET)=' "$release/.env" > "$keys"
if [[ -f "$state/.persistent-keys" ]] && ! cmp -s "$state/.persistent-keys" "$keys"; then
  echo '数据库密码或网关密钥与此前部署不一致' >&2
  exit 1
fi

compose "$release" config -q
compose "$release" build app
if [[ ! -f "$state/.persistent-keys" ]]; then
  mv -- "$keys" "$state/.persistent-keys"
fi
compose "$release" up -d --wait --wait-timeout 90 db
compose "$release" run --rm --no-deps -T app gatewayctl init-db
if [[ -s "$work/.bootstrap-password" ]]; then
  compose "$release" run --rm --no-deps -T -i app gatewayctl bootstrap < "$work/.bootstrap-password"
fi

switch_started=true
compose "$release" up -d --no-build --no-deps app caddy
for ((attempt = 0; attempt < 30; attempt++)); do
  if [[ "$(curl -sS --max-time 2 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/readyz" 2>/dev/null)" == 204 ]]; then
    ln -s -- "$release" "$pointer"
    mv -Tf -- "$pointer" "$state/current"
    exit 0
  fi
  sleep 2
done
echo '新版本未通过 /readyz 检查' >&2
exit 1
