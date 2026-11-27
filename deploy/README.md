# Docker Compose 部署

在项目根目录用 `deploy/.env.example` 准备 `deploy/.env`。用 `openssl rand -hex 32` 分别生成数据库密码、网关加密密钥和管理员密码。部署后应将环境文件存放在只有部署用户可读的位置。保留 `GATEWAY_SECRET`，已签发 Key 和已存上游凭证依赖它。

```sh
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d --build
```

访问 `http://localhost:8088`，用 `ADMIN_USERNAME` 和 `ADMIN_PASSWORD` 登录控制台。部署到公网时可在现有 TLS 入口后运行应用，并设置 `PUBLIC_BASE_URL` 使图片下载链接采用对外地址。Compose 的 `db` 仅在内部网络开放，`app` 暴露 HTTP 端口。应用启动时初始化数据库，`/livez` 和 `/readyz` 分别提供存活及就绪探针。

PostgreSQL 和媒体使用独立卷。Chromium 包含在应用镜像中。即梦浏览器传输默认自动选择，可用 `JIMENG_BROWSER_TRANSPORT=off` 关闭。每个内置供应商直接访问自己的上游。

## 从 `native/` 目录版本升级

升级前备份数据库并停止旧版本应用。当前版本启动时将 schema 3 或 4 升级到 schema 5，支持删除上游账号。从 schema 3 升级时会同时为已有凭证回填指纹。使用原 Compose 项目、PostgreSQL 卷、媒体卷及 `GATEWAY_SECRET` 重建应用即可继续使用现有账号、Key、任务和制品。历史重复账号予以保留，后续添加相同凭证会返回冲突。旧版本应用无法直接读取 schema 5，如需回滚请使用升级前的数据库备份。沿用管理员用户名和密码可继续使用尚未过期的管理会话。自定义脚本请改为在仓库根目录执行 `npm ci` 和 `npm run build`，服务产物为 `dist/server.js`。

schema 1 和 2 使用了不同的工作区或账号池授权模型。应用会拒绝这些版本并保留数据库内容。升级这类数据库前需单独映射原有授权范围，避免把账号池授权扩展为整个产品的授权。
