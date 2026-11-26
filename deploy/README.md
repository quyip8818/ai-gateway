# SSH 部署

`pnpm start` 和 `pnpm run deploy` 共用 `deploy/.env` 中的管理员凭证。本地服务的端口等运行配置来自根目录 `.env`。`pnpm run deploy` 通过 SSH 在 Linux 服务器上运行 Docker Compose，项目名为 `ai-gateway`。

1. 在项目根目录执行 `(umask 077 && cp deploy/.env.example deploy/.env)`，填写目标 SSH 主机、用户及端口。部署机需要 Node.js 24、`tar` 和 `ssh`。提前验证目标服务器的 SSH 指纹，配置密钥登录和 `known_hosts`。
2. 设置 `DEPLOY_PORT` 和浏览器实际使用的 `PUBLIC_BASE_URL`。Caddy 在目标服务器绑定 `127.0.0.1:$DEPLOY_PORT`。公网入口可由现有反向代理转发该端口并终止 TLS，或者通过 SSH 端口转发访问。
3. 用 `openssl rand -hex 24` 生成 `POSTGRES_PASSWORD`，分别用 `openssl rand -base64 32` 生成 `KEY_DIGEST_SECRET` 和 `CONNECTION_SECRET`。部署后保留这些值，以便连接同一数据库、继续验证已签发的网关 Key 和解密上游凭证。
4. 首次部署在 `deploy/.env` 设置 `BOOTSTRAP_USERNAME`（例如 `admin`）和 12 至 72 字节的 `BOOTSTRAP_PASSWORD`。密码含 `#` 时在 `.env` 里用合适的引号包裹。空库会创建管理员并输出一次网关 API Key。已有数据库时，部署会验证提供的凭证。仅用于远程部署时，后续部署可省略密码。
5. 服务器需有 `bash`、`tar`、`flock`、`curl`、Docker 和支持 `!override` 的 Docker Compose（2.24.4 或更新版本）。SSH 用户需要 Docker 操作权限。在本机根目录执行 `pnpm run deploy`。成功后访问 `PUBLIC_BASE_URL` 下的 `/app/`。

如果 `jimeng-api` 容器已加入 `jimeng-public`，可以同时设置 `JIMENG_NETWORK=jimeng-public` 和 `JIMENG_BASE_URL=http://jimeng-api:8000`。Compose 将网关容器加入同一个网络。使用远端即梦服务时，填网关容器可访问的 `JIMENG_BASE_URL` 即可。视频成品 CDN 主机通过 `JIMENG_DOWNLOAD_HOSTS` 配置。

构建、表结构和管理员初始化完成后，部署脚本启动新版本并通过环回端口检查 `/readyz`。启动或健康检查失败时，脚本尝试恢复上一个网关和 Caddy 版本。此前写入的数据继续保存在数据库中。开发环境使用新表结构时，先准备空库。数据库和媒体保存在 Compose 的固定命名卷，服务器端当前版本由 `~/ai-gateway-deploy/current` 指向。

同一份基础 Compose 文件也可用于手动部署。显式传入 `--env-file deploy/.env` 和 `-f deploy/compose.yaml`，先运行 `gatewayctl init-db`，再运行 `gatewayctl bootstrap` 并通过标准输入传入 `BOOTSTRAP_PASSWORD`。基础 Compose 的默认主机映射是 HTTP `8088` 和 HTTPS `8443`，可通过 `HTTP_PORT`、`HTTPS_PORT` 和 `SITE_ADDRESS` 修改。
