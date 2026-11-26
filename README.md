# AI Gateway

账号池反代网关。管理员导入上游账号凭证，网关发现模型并建立账号池。调用方拿到网关地址、公开模型 ID 和本系统签发的 Key。编程请求保留原生 SSE，图片和视频通过持久化媒体任务交付。

## 启动与使用

1. 安装 Node.js 24、pnpm、Go 1.26 和 PostgreSQL 16。在 `deploy/.env` 填写初始管理员的 `BOOTSTRAP_USERNAME` 和 `BOOTSTRAP_PASSWORD`。
2. 运行 `pnpm start`，访问 `http://127.0.0.1:32270/app/`。启动器构建前后端、启动 PostgreSQL，并初始化空库和管理员。运行配置读取根目录 `.env`，进程环境变量优先。
3. 打开「账号」，选择供应商并导入凭证。通过上游目录检查后，网关自动填充对应账号池和公开模型，无需手工发布路由。
4. 打开「调用密钥」，勾选要授权的池并签发 Key。复制密钥原文后，在「使用」页按模型配置 Codex 或 Claude Code，或打开「媒体创作」生成图片和视频。Key 轮换保留授权范围和任务归属。

本地 PostgreSQL、媒体和生成的密钥位于 `data/`。用现有 PostgreSQL 时，提供空库的 `DATABASE_URL`，并为 `KEY_DIGEST_SECRET` 和 `CONNECTION_SECRET` 提供固定值或相应的 `_FILE`。开发环境需要重新初始化时，`pnpm reset` 会清空当前工作区的本地数据库。外部数据库用 `gatewayctl init-db` 初始化空库。

## 上游配置

| 供应商 | 控制台输入 | 执行方式 |
| --- | --- | --- |
| 即梦 | 包含 `sessionid` 的账号 Cookie | 网关在专用 `jimeng-api` 实例验证 Cookie、添加账号并签发内部调用凭证。 |
| Codex | Codex `auth.json` | CLI 账号文件导入专用 CLIProxyAPI v8；带 `OPENAI_API_KEY` 的文件可直连 OpenAI Platform。 |
| Kiro | 含 `refreshToken` 的授权 JSON | 导入专用 kiro2api，执行器负责令牌续期。Builder ID 或 IAM Identity Center 导出还需匹配的客户端字段。公开入口使用 Anthropic Messages。 |
| Claude | Anthropic Console 密钥 | 直连 Anthropic API，公开入口使用 Anthropic Messages。 |

部署方用 `ACCOUNT_EXECUTORS_FILE` 指向私有 JSON 配置。每个实例从空账号池启动，由网关独占，一个实例对应一个导入账号。执行器只在私有网络监听，管理凭证和内部调用凭证保存在部署配置中。

```json
[
  {"provider":"jimeng","url":"http://jimeng-1:8000","username":"gateway","password":"replace-with-private-password"},
  {"provider":"codex","url":"http://codex-1:8317","management_key":"replace-with-management-key","runtime_key":"replace-with-codex-runtime-key"},
  {"provider":"kiro","url":"http://kiro-1:8080","management_key":"replace-with-management-key","runtime_key":"replace-with-kiro-runtime-key"}
]
```

- 即梦使用 [jimeng-free-api-all](https://github.com/zhizinan1997/jimeng-free-api-all) 的账号池、图片和异步视频 API。为成品重定向配置允许的 CDN 主机名 `JIMENG_DOWNLOAD_HOSTS`。视频始终回原执行器查询。
- Codex 执行器启用 [CLIProxyAPI v8 管理 API](https://github.com/router-for-me/CLIProxyAPIDocs/blob/main/docs/en/management/apiv8.md)，使用独立、可写的凭证目录，并将 `runtime_key` 配到客户端 Key 列表。
- Kiro 执行器用 [kiro2api](https://github.com/xwteam/kiro2api/blob/main/docs/en/API.md) 的管理接口导入和验证模型，分别配置其管理 Key 和调用 Key，并存储到独立的数据卷。

部署方也可指定直接接受上游账号凭证的兼容执行器。变量为 `CODEX_ACCOUNT_BASE_URL`、`KIRO_ACCOUNT_BASE_URL`、`CLAUDE_ACCOUNT_BASE_URL`、`JIMENG_ACCOUNT_BASE_URL`。兼容执行器需要实现 `/v1/models` 和对应调用接口。已注册的 Codex 或 Kiro OAuth 客户端可通过 `ACCOUNT_OAUTH_CLIENTS_FILE` 配置浏览器授权和续期。以供应商 ID 为键填写 `token_url`、`client_id`，按需填写 `authorize_url`、`scope`、`resource`、`client_secret`，并注册网关的 `/console/v1/oauth/callback`。该流程需要可直接接受交换后令牌的兼容执行器。Claude 目前使用官方 Console 密钥。

## 添加兼容供应商

账号池按供应商和授权归属隔离，网关 Key 可授权多个池。公开模型 ID 带池前缀，即使两个供应商提供同名模型，也会路由到指定的池。供应商身份用于凭证导入与目录展示，运行时按协议执行。Codex 对接 Responses，Claude 和 Kiro 可共用 Messages；token 计数由供应商声明。即梦沿用媒体任务协议、租约和原账号恢复流程。

已有兼容端点可以配置到 `ACCOUNT_PROVIDERS_FILE`，Compose 下用挂载目录中的 `providers.json`。端点实现 `/v1/models` 和相应的调用 API。

```json
[
  {"id":"team-models","label":"团队模型","base_url":"https://models.example.test","protocol":"messages","count_tokens":true}
]
```

`protocol` 接受 `responses`、`messages` 或 `openai_media`。媒体端点须使用当前图片和视频任务契约，并通过 `media_models` 将模型 ID 映射到 `image.generate` 或 `video.generate`。仅在验证端点支持 `/v1/messages/count_tokens` 后为 Messages 配置 `count_tokens`。重启后控制台会显示该供应商和 API Key 输入，并为其账号创建独立的池。新授权或执行协议需要代码适配器。

## 版本切换

账号池版使用从空库初始化的数据库。启动和初始化命令会检查结构版本，发现旧原型库或版本不匹配时在写入前退出。若要保留旧数据，可给账号池版指定独立的新数据库或数据卷。

调用端的 Responses、Messages 与媒体 API 路径延续。公开模型 ID 使用 `<账号池>/<模型>`，客户端更新模型配置并使用新签发的池授权 Key。旧的手工连接、模型路由和计费试算入口已退役。

## 部署与验证

Docker Compose 与 SSH 部署见 [部署指南](deploy/README.md)。架构与实施范围见 [账号池反代网关设计](docs/account-proxy-design.md)。

- `pnpm lint` 检查前端、脚本和 Go 静态检查。 `pnpm --dir frontend run build` 构建控制台。
- `go -C backend test ./...` 运行 Go 测试。将 `TEST_DATABASE_URL` 指向专用测试 PostgreSQL 启用集成测试，覆盖账号入池、模型权限、Key 轮换、SSE、媒体幂等、异步交付和任务恢复。
- 真实账号可使用 `go -C backend test ./tests/integration -run TestLiveAuthorized -v`。显式设置 `GATEWAY_LIVE_TEST=1`、`GATEWAY_LIVE_URL`、`GATEWAY_LIVE_KEY`，按需设置 `GATEWAY_LIVE_OPENAI_MODEL`、`GATEWAY_LIVE_ANTHROPIC_MODEL`、`GATEWAY_LIVE_IMAGE_MODEL` 或 `GATEWAY_LIVE_VIDEO_MODEL`。测试发送实际请求并消耗上游额度。
