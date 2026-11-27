# ai-gateway

单进程模型反代。应用内置即梦、Codex、Kiro 和 Claude 适配器，通过用户授权的账号直接访问各自上游。

## 启动

1. 用 `deploy/.env.example` 准备 `deploy/.env`，设置 `POSTGRES_PASSWORD`、`GATEWAY_SECRET`、`ADMIN_USERNAME` 和 `ADMIN_PASSWORD`。
2. 运行 `npm run deploy`，访问 `http://localhost:8088`。Compose 创建独立的 PostgreSQL 库和媒体卷。
3. 用管理员用户名和密码进入控制台，在「上游账号」选择产品并添加凭证。账号验证后自动更新该产品的模型目录。
4. 在「API 密钥」选择可调用的产品并签发网关 Key。用 `GET /v1/models` 查询该 Key 能访问的模型 ID。

本地开发可使用 Docker 中独立运行的 PostgreSQL 数据库。参考根目录 `.env.example` 配置连接、加密密钥和管理员用户名和密码，执行 `npm ci` 后运行 `npm start`。启动命令会重建前端和后端，默认监听 41873。端口冲突时通过 `lsof` 找到监听进程，先尝试正常停止，端口仍被占用时再强制停止该进程。启动成功后会打印控制台 URL。

## 账号和入口

| 供应商 | 凭证 | API |
| --- | --- | --- |
| 即梦 | 自己账号的 Cookie 或 `sessionid` | `/v1/images/generations`、`/v1/images/edits`、`/v1/videos`、`/v1/videos/edits` |
| Codex | 自己的 Codex 授权 JSON、控制台 OAuth 或 OpenAI API Key | `/v1/responses` |
| Kiro | 自己的 Desktop 或 IAM Identity Center OIDC 凭证 JSON | `/v1/messages` |
| Claude | Claude Console API Key | `/v1/messages`、`/v1/messages/count_tokens` |

Kiro Desktop 导入需要 `refreshToken` 或 `accessToken`。OIDC 续期需要与原授权匹配的 `clientId`、`clientSecret`、`region` 和 `refreshToken`。可选字段 `apiRegion` 和 `profileArn` 用于相应的 Kiro 数据面。

Codex 浏览器授权在控制台生成链接。完成授权后，将浏览器的回调地址粘贴到控制台。默认回调是 `http://localhost:1455/auth/callback`。

首次启动使用空的 PostgreSQL 数据库。调用 Key 按产品授权，也能访问之后添加的同产品账号。管理接口创建 Key 使用 `providers` 产品 ID 数组。

所有公开生成接口使用网关 Key，接受 `Authorization: Bearer <key>` 或 `x-api-key`。视频创建可带 `Idempotency-Key`，通过 `GET /v1/videos/:id` 查状态，通过 `GET /v1/videos/:id/content` 下载。复刻接受已授权的源任务 `video.id`，或同一上游账号可查询的即梦复刻任务 `video.upstream_id`。

即梦图片生成和编辑响应包含扩展字段 `usage.credits_used`。网关在生成后查询一次近期消费流水，按 `submit_id` 匹配该任务的已结算扣点。流水尚未确认、未出现在第一页或查询失败时，API 返回 `null`，请求记录显示「—」。

## 供应商配置和媒体资源

- 在「上游账号 → 即梦」配置浏览器传输默认值，单个账号可在「账号设置」中覆盖或恢复继承。生效顺序为账号覆盖、供应商默认值、`JIMENG_BROWSER_TRANSPORT`、内置默认值。各实例在后续请求中读取 PostgreSQL 中的配置。
- 「媒体资源」支持按图片、视频和供应商筛选，以及分页、预览和下载。视频任务可从同一页面查看。媒体目录读取网关已保存的文件，下载支持字节范围。管理接口 `GET /admin/v1/media` 接受 `type`、`provider`、`page` 和 `limit`，并使用现有的管理员会话。
- 首次启动时使用空的 PostgreSQL 数据库或 schema，服务会自动创建所需表。开发期间 schema 变更直接进入初始定义。
- 本地开发时先停止网关，确认可清空网关数据后再运行 `npm run reset`。命令会按 `DATABASE_URL` 在当前 PostgreSQL schema 中删除并重建网关表，清空账号、密钥、任务和运行配置。Shell 中设置的 `DATABASE_URL` 优先于 `.env`。磁盘上的媒体文件保留。

## 代码布局

- `app/frontend` 包含 React 控制台和管理 API 客户端。
- `app/backend` 包含 Koa 入口、业务模块、供应商适配器、持久化和集成测试。
- `shared/contracts` 包含前后端共用的公开契约。
- `npm run build` 生成 `dist/server.js` 和 `dist/frontend` 静态资源。

## 验证

- `npm run lint` 检查 TypeScript 源码、测试和构建脚本。
- `npm test` 构建并运行协议测试。
- 设置 `TEST_DATABASE_URL` 后，测试会在专用库中新建临时 schema，使用协议替身验证四个供应商、产品授权、SSE、媒体交付及视频幂等。

[部署配置](deploy/README.md) · [架构设计](docs/native-provider-architecture.md) · [测试与发布验收](docs/integration-validation.md) · [源码来源](app/backend/SOURCES.md)
