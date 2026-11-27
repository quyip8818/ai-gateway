# Docker Compose 部署

在项目根目录用 `deploy/.env.example` 准备 `deploy/.env`。用 `openssl rand -hex 32` 分别生成数据库密码、网关加密密钥和管理员 token。部署后应将环境文件存放在只有部署用户可读的位置。保留 `GATEWAY_SECRET`，已签发 Key 和已存上游凭证依赖它。

```sh
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d --build
```

访问 `http://localhost:8088`，用 `ADMIN_TOKEN` 打开控制台。部署到公网时可在现有 TLS 入口后运行应用，并设置 `PUBLIC_BASE_URL` 使图片下载链接采用对外地址。Compose 的 `db` 仅在内部网络开放，`app` 暴露 HTTP 端口。应用启动时初始化数据库，`/livez` 和 `/readyz` 分别提供存活及就绪探针。

PostgreSQL 和媒体使用独立卷。Chromium 包含在应用镜像中。即梦浏览器传输默认自动选择，可用 `JIMENG_BROWSER_TRANSPORT=off` 关闭。每个内置供应商直接访问自己的上游。
