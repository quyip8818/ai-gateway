# 测试与发布验收

`npm test` 构建应用并运行协议单测。配置 `TEST_DATABASE_URL` 后同时运行 HTTP 集成测试。测试在指定的 PostgreSQL 里创建专用 schema，结束后删除。真实产品进程通过本机 HTTP 接收请求，测试替身只在出站边界替换 `fetch` 和 Axios transport。CI 提供 PostgreSQL 并运行全部测试。

```sh
npm ci --prefix native
TEST_DATABASE_URL=postgres://gatewaytest:test-password@127.0.0.1:5432/gatewaytest npm test
```

## 源码对照与网关行为

| 链路 | 覆盖 |
| --- | --- |
| 即梦 | 原始本地 `jimeng-api` 控制器在替身上生成的四组请求基线。集成测试逐字段比较请求路径、参数和完整草稿，覆盖文生图、图生图、指定画幅和时长的视频及复刻。另验证参考图上传、Base64 和签名 URL、媒体下载、提交响应丢失后的原 ID 恢复、进程重启及并发幂等。 |
| Codex | 将工具请求与原始 `openai-oauth/core` 生成的出站基线比较。另断言授权域名、PKCE、回调状态单次消费、上游模型和 SSE 流。验证 OAuth 续期、OpenAI API Key 直连，以及非流式客户端从上游 SSE 聚合工具结果。 |
| Kiro | 将工具请求与原始 `kiro-api` 请求构造器生成的基线比较。另断言模型 ID、Desktop/OIDC 续期、数据面鉴权、分片工具参数、消息终止事件、异常和截断。单测覆盖坏 CRC。并发请求共享一次凭证刷新。 |
| Claude | 按 Messages 路径、账号凭证和计数接口验证。客户端断开后检查上游取消、尝试状态及账号租约可重新获取。 |
| 网关 | 空库、用户名密码登录、会话及改密失效、账号池筛选、无效账号池授权拒绝、视频归属、签名到期、并发幂等、重启后持久状态及拒绝未知数据库版本。 |

即梦固定基线在 [fixtures/jimeng-submissions.json](../native/test/fixtures/jimeng-submissions.json)。生成时使用本地 `jimeng-api` 的 `bf54a38451d18b80c66f1982590ef2f0a75b4c0a` 加 [源码来源](../native/SOURCES.md) 记录的工作树更新。捕获脚本加载原项目的生成控制器和依赖，需要在源项目中先安装其锁定依赖。测试替换持久化、浏览器与网络边界。归一化仅覆盖随机 ID、时间、随机种子和 Web ID。CI 读取已提交的基线，需要审阅上游源码改变时才重新生成：

```sh
cd native
npm run build
node test/capture-jimeng.mjs /path/to/jimeng-api > dist/jimeng-submissions.json
diff -u test/fixtures/jimeng-submissions.json dist/jimeng-submissions.json
```

Codex 和 Kiro 固定基线位于 [fixtures/text-provider-contracts.json](../native/test/fixtures/text-provider-contracts.json)，取自 [源码来源](../native/SOURCES.md) 列出的提交。在 Node.js 24 下用以下命令复现：

```sh
cd native
npm run build
node test/capture-text-providers.mjs /path/to/openai-oauth /path/to/kiro-api > dist/text-provider-contracts.json
diff -u test/fixtures/text-provider-contracts.json dist/text-provider-contracts.json
```

更新基线前应核对源码版本，审查差异。Claude 使用独立的 Messages 协议断言。所有源码对照均运行指定的控制器或库入口。

## 发布前待实证

替身测试能验证请求形状、目标地址、协议转换和持久化，真实账号的可用性和当前供应商响应仍需单独验收。用授权测试账号核对：

- 即梦直连和 Chromium 传输、实图上传、视频生成与复刻、实际 CDN 下载。
- Codex 浏览器登录和真实 token 续期、Responses 的流式及非流式工具回合；OpenAI API Key 路径。
- Kiro Desktop 与 IAM Identity Center 的续期、模型发现、工具结果回传和真实二进制流。
- Claude Messages、token 计数和实际限流响应。

授权范围限定为测试账号。测试产物记录账号类型、公开入口、上游目标和结果，省略凭证、授权码及生产媒体。WebSocket、服务器侧 Responses 续接和视频取消尚未开放。
