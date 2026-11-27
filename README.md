# ai-gateway

单进程模型反代。应用内置即梦、Codex、Kiro 和 Claude 适配器，通过用户授权的账号直接访问各自上游。

## 启动

1. 用 `deploy/.env.example` 准备 `deploy/.env`，设置随机的 `POSTGRES_PASSWORD`、`GATEWAY_SECRET` 和 `ADMIN_TOKEN`。
2. 运行 `npm run deploy`，访问 `http://localhost:8088`。Compose 创建独立的 PostgreSQL 库和媒体卷。
3. 用管理员 token 进入控制台，添加上游账号。账号验证后自动建立账号池和模型目录。
4. 在 **Keys** 选择池并签发调用 Key。用 `GET /v1/models` 查询该 Key 能访问的模型 ID。

本地开发可使用空 PostgreSQL 库，配置根目录 `.env` 后执行 `npm ci --prefix native && npm run build && npm start`。应用默认监听 8080。

## 账号和入口

| 供应商 | 凭证 | API |
| --- | --- | --- |
| 即梦 | 自己账号的 Cookie 或 `sessionid` | `/v1/images/generations`、`/v1/images/edits`、`/v1/videos`、`/v1/videos/edits` |
| Codex | 自己的 Codex 授权 JSON、控制台 OAuth 或 OpenAI API Key | `/v1/responses` |
| Kiro | 自己的 Desktop 或 IAM Identity Center OIDC 凭证 JSON | `/v1/messages` |
| Claude | Claude Console API Key | `/v1/messages`、`/v1/messages/count_tokens` |

Kiro Desktop 导入需要 `refreshToken` 或 `accessToken`。OIDC 续期需要与原授权匹配的 `clientId`、`clientSecret`、`region` 和 `refreshToken`。可选字段 `apiRegion` 和 `profileArn` 用于相应的 Kiro 数据面。

Codex 浏览器授权在控制台生成链接。完成授权后，将浏览器的回调地址粘贴到控制台。默认回调是 `http://localhost:1455/auth/callback`。

所有公开生成接口使用网关 Key，接受 `Authorization: Bearer <key>` 或 `x-api-key`。视频创建可带 `Idempotency-Key`，通过 `GET /v1/videos/:id` 查状态，通过 `GET /v1/videos/:id/content` 下载。复刻接受已授权的源任务 `video.id`，或同一上游账号可查询的即梦复刻任务 `video.upstream_id`。

## 验证

- `npm test` 构建并运行协议测试。
- 设置 `TEST_DATABASE_URL` 后，测试会在专用库中新建临时 schema，使用协议替身验证单进程、四个供应商、账号池权限、SSE、媒体交付及视频幂等。

[部署配置](deploy/README.md) · [架构设计](docs/native-provider-architecture.md) · [测试与发布验收](docs/integration-validation.md) · [源码来源](native/SOURCES.md)
