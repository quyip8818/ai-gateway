# ai-gateway 内置供应商反代架构

## 1. 产品与部署

**ai-gateway 是一个模块化反代应用。** 用户在控制台添加供应商账号、为调用 Key 选择产品并签发，然后通过标准协议调用模型。首发包含即梦图片与视频、Codex Responses、Kiro Messages 和 Claude Messages。

应用采用 Node.js 24、TypeScript、Koa、React 和 PostgreSQL。以本地 `jimeng-api` 的原生实现作为第一个供应商模块，同进程加载 Codex、Kiro、Claude。各模块直接访问供应商上游。发布一份镜像、一个 HTTP 入口和一个应用进程。即梦所需的 Chromium 随镜像提供，API 和视频任务循环由同一入口管理。PostgreSQL 与媒体卷承担持久化。

首发从空库初始化，由部署者配置管理员用户名和密码。公开 API、控制台、账号与数据模型都以本文为契约。源码来源和许可证记录服务于后续更新与发布审查。

```mermaid
flowchart LR
    U[客户端和控制台] --> R[ai-gateway Koa 路由]
    R --> A[鉴权和模型目录]
    A --> S[账号调度和凭证管理]
    S --> T[文本请求和流式响应]
    S --> W[媒体任务和制品]
    T --> C[Codex 模块]
    T --> K[Kiro 模块]
    T --> H[Claude 模块]
    W --> J[即梦模块]
    C --> CO[OpenAI / ChatGPT]
    K --> KO[Kiro / AWS]
    H --> HO[Anthropic]
    J --> JO[即梦官网和 CDN]
    S --> P[(PostgreSQL)]
    W --> P
    W --> F[媒体存储]
```

## 2. 源码调研

下表链接固定到此次审阅的提交。判断依据包括路由、运行时调用、授权和响应解析源码。各上游的真实账号调用留给实施验收。

| 项目 | 实际实现 | 在本项目中的用途 |
| --- | --- | --- |
| Sub2API，`81ce835` | 网关按客户端协议和账号平台分派。OpenAI 路径先做账号选择，考虑组、模型、能力、会话粘性、账号可用性和负载，再由服务选择 OAuth 或 API Key 的上游路径。凭证续期单独维护。 | 借鉴「路由 → 账号调度 → 取凭证 → 原生转发」和会话绑定。在新 PostgreSQL 模型中实现精简的池授权、账号调度和租约。 [路由][sub-routes] · [调度][sub-schedule] · [OpenAI 网关][sub-openai] · [续期][sub-refresh] |
| `xiangking/sub2api-kiro`，`9541e0e` | Kiro 平台分支进入 `GatewayService.forwardKiro`，调用包内 Kiro 客户端。Anthropic 请求转为 Kiro 请求，AWS EventStream 被解码后生成 Claude SSE，非流式路径收集结果。OAuth 服务与同一个账号体系配合。 | 原生 Kiro 调用链和功能覆盖参考。Go 的 Gin、仓储、服务注入和调度依赖使整段服务难以直接迁入 Node。 [Kiro 网关][xiang-gateway] · [客户端][xiang-client] · [解码][xiang-parser] · [OAuth][xiang-oauth] |
| `kobojp/sub2api-kiro`，`5b44a01` | 另一条 Kiro fork，提供独立的 Kiro runtime、请求 translator、token provider。运行时处理账号凭证、上游调用、映射、错误和流式转换。 | 对照 Kiro 长会话、token 失效、账号粘性、上游错误分类等边界。重点看测试输入与预期行为。 [运行时][kobo-runtime] · [转换][kobo-translator] · [凭证][kobo-token] |
| CLIProxyAPI，`47f18e4` | `ProviderExecutor` 定义普通请求、流式请求、续期等能力。Codex HTTP 和 WebSocket 执行器在同进程内运行。审阅版本把 HTTP 实现拆在 `codex_executor_execute.go`、`_stream.go`、`_auth.go`。 | 给 Codex 协议兼容和流式行为提供对照。新架构直接使用应用内凭证和运行时。 [执行接口][cpa-interface] · [HTTP][cpa-execute] · [SSE][cpa-stream] · [续期][cpa-auth] · [WebSocket][cpa-ws] |
| `xwteam/kiro2api`，`124b14b` | Rust 运行时调用 Kiro，拆分 credential、refresh、provider、wire、AWS EventStream 和各客户端协议输出。流式与非流式共享上游事件来源。 | 用来核对 EventStream 帧、错误帧、认证类型、流终止和协议转换。源码可作为测试场景来源，Node 部署无需 Rust 服务。 [上游调用][rust-provider] · [解码器][rust-events] · [Anthropic 输出][rust-anthropic] |
| `krisamin/kiro-api`，`46c9f08` | TypeScript 实现。先构造 Kiro 请求，再由 HTTP 客户端读取 AWS 二进制事件并输出 Anthropic JSON/SSE。原项目的认证以 Bun SQLite 中的本地 Kiro CLI 账号为基础。 | **Kiro 首选的同语言代码来源。** 迁入解码、请求构造、事件转换和相关用例，把本地账号读取换成网关选定账号的凭证。 [解码器][ts-kiro-events] · [请求][ts-kiro-payload] · [HTTP][ts-kiro-client] · [输出][ts-kiro-stream] · [原认证][ts-kiro-auth] |
| `EvanZhouDev/openai-oauth`，`9079e62` | TypeScript 的 `@openai-oauth/core` 导出 OAuth 授权请求、交换、续期和进程内 transport。上层 Responses handler 调用 transport。该 handler 明确拒绝其无状态模式无法处理的服务器侧续接。 | **Codex 首选的同语言代码来源。** 按锁定提交纳入 core 源码。HTTP handler 只作对照。 [进程内 transport][oauth-runtime] · [SSE][oauth-sse] · [Responses handler][oauth-handler] · [包定义][oauth-package] |
| Pi，`ede8bdc` | TypeScript 中将 Codex OAuth 与 Responses 请求实现分开，后者还包含其 SDK 的模型和事件抽象。 | 对照 OAuth 流程和 Responses 特例。首版保持代理层面向客户端的原协议和完整字段。 [OAuth][pi-auth] · [Responses][pi-responses] |

## 3. 源码迁入清单

| 模块 | 迁入源文件或目录 | 接入工作 |
| --- | --- | --- |
| 即梦核心 | 本地 `jimeng-api` 的 `src/api/controllers/{core,models,images,image-size,videos,video-size,video-generation-task,video-tasks,video-history,video-task-progress,video-recast,generation-credits}.ts`，对应 images/video/model 路由，`src/lib/{image-reference,browser-transport,media-url}.ts` | 保留上游请求构造、模型映射、素材处理、积分流程、历史解析和浏览器生命周期。把 SQLite、模块级账号选择、设置和日志依赖接到网关。基线为本地 `jimeng-api` 的 `bf54a38451d18b80c66f1982590ef2f0a75b4c0a` 加已核对的工作树变更，包括图片编辑、尺寸、参考图校验和视频尾斜杠修正。构建只读取源码。 |
| Kiro 协议块 | `krisamin/kiro-api` 的 `src/kiro/{event-stream,type,convert,payload,client}.ts`、所需的 `thinking.ts` 和 `src/anthropic/{type,stream,response}.ts`，选取 `src/selftest.ts` 用例 | 解码器和无状态类型优先原样迁入。payload 的配置、模型能力和日志改由调用方提供。client 改成显式传入已选账号、凭证、发送函数和 `AbortSignal`。流式及 JSON 统一消费同一事件源。通过 Sub2API-Kiro 与 kiro2api 对照授权、区域和错误语义。 |
| Kiro 授权 | 参考两条 Sub2API-Kiro fork 的 OAuth，和 kiro2api 的 `kiro/login`、`credential.rs`、`refresh.rs` | 在统一凭证服务内实现授权回调、凭证导入和按类型续期。首版承诺经过验收的 Builder ID、IAM Identity Center 或 Social 类型，按能力逐个开放。批量导入读取用户指定的导出文件，正式服务从 PostgreSQL 获取授权账号。 |
| Codex | `openai-oauth/packages/core/src/{runtime,models,sse,utils}.ts` 及实际依赖，传输用例来自 `packages/core/test/transport.test.ts` | 迁入所需 TypeScript 模块和依赖，随网关构建。选中的账号每次显式传给 transport。持久化续期、租约、路由和用量归网关。路由级适配保留未知 JSON 字段、工具载荷和 SSE 输出。 |
| Claude | Anthropic Messages 官方契约和 CLIProxyAPI 原生转发作为实现参考 | 将 Console API Key 鉴权、版本和 beta 头、SSE、用量、`count_tokens` 能力按 Anthropic Messages 协议重新实现为 TypeScript 模块。 |
| 网关通用能力 | 新实现 | 从新的产品流程设计鉴权、账号存储、目录、调度、任务、用量、控制台和构建。为新契约编写测试。 |

Kiro 来源项目还实现了自动裁剪历史、缓存用量估算和本机数据库依赖。第一版将真实用量与估算分开，请求超过出站大小上限时返回 HTTP 413。Kiro 的 EventStream 必须处理分片、帧长度、CRC、消息类型、异常帧及中途截断。解码失败对应明确的上游错误，不能把缺失终止帧的流记成成功。[Kiro 客户端][ts-kiro-client] · [EventStream 解码][ts-kiro-events] · [Rust 对照][rust-events]

### 源码来源和许可证

迁入清单应记录源仓库、完整提交、文件路径、原许可证及本地改动。即梦本地仓库的 `LICENSE` 是 GPL v3 文本，`package.json` 的元数据另写 ISC，发布前核对来源和相应声明。此次审阅的 Sub2API 和两条 Kiro fork 的 `LICENSE` 是 LGPL v3，CLIProxyAPI、kiro2api、kiro-api 和 Pi 是 MIT，openai-oauth core 是 Apache-2.0，并有 NOTICE。直接迁入时保留源码中的权利声明和对应许可证或 NOTICE。Sub2API 系列在此方案主要提供架构与行为参考。[Sub2API][sub-license] · [xiangking][xiang-license] · [kobojp][kobo-license] · [CLIProxyAPI][cpa-license] · [kiro2api][rust-license] · [kiro-api][ts-kiro-license] · [openai-oauth][oauth-license] · [Pi][pi-license]

## 4. 模块边界和运行规则

### 目录和依赖

```text
app/
  frontend/                     React 控制台、管理 API 客户端与页面
  backend/
    src/
      server.ts                 Koa 装配、配置、生命周期
      http/                     管理与公开路由、请求和响应边界
      modules/
        identity/               管理会话、调用 Key 与权限
        accounts/               账号接入、凭证续期、授权流程、调度和租约
        catalog/                模型发现结果的管理与公开视图
        gateway/                文本与图片调用、尝试记录、流生命周期
        media/                  视频任务、任务循环、制品授权与交付
      providers/                适配器注册表及各供应商实现
      infrastructure/
        postgres/               连接池、初始化 SQL 和业务仓储
        files/                  媒体文件读写
    test/                       协议基线与集成测试
shared/contracts/               控制台与后端共同使用的公开契约
deploy/                         Compose 与部署配置
dist/                           构建生成的服务端和静态控制台
```

根目录管理依赖锁和构建命令。服务入口装配业务模块、仓储和供应商。HTTP 路由处理输入、鉴权上下文与输出。业务模块通过仓储方法读写数据，事务和锁由 PostgreSQL 仓储管理。控制台通过同源管理 API 获取数据。

供应商模块处理上游凭证、请求构造和响应解析。文本执行和媒体能力通过适配入口调用。视频任务先准备上游请求，再持久化提交状态并发送，任务循环持有租约直到本轮处理结束。文本流由 HTTP 层送达客户端，调用记录和账号租约由生成编排在流结束时结算。

### 供应商契约

供应商入口绑定固定的供应商 ID、凭证种类、模型发现与适配器实现。有新供应商时增加其模块、注册及契约测试。

| 契约 | 责任 |
| --- | --- |
| 账号接入 | 验证用户提交的凭证，返回去敏账号信息。按受支持的授权类型提供授权与刷新操作，续期返回新凭证及过期时间，由账号模块落库。 |
| 模型发现 | 返回上游模型 ID、可执行操作、已知参数约束和能力来源。目录维护公开别名及可用账号关联。 |
| 文本执行 | 接收具体协议、上游模型、所选凭证及取消信号。返回 JSON 或流及已报告用量。原生同协议路径保留工具载荷及未知字段，Kiro 的 AWS 事件转换在适配器内完成。 |
| 媒体执行 | 提供图片生成、视频提交、查询、下载和复刻所需的能力。视频查询支持使用提交 ID 恢复，结果携带可用于交付的上游标识。 |
| 失败结果 | 使用明确的失败类型描述无效输入、过期凭证、限流、上游拒绝、传输中断或提交待确认。编排层依据失败类型、发送阶段和操作的幂等语义决定后续处理。 |

文本与媒体使用各自的契约。原生协议之间按实际需求实现转换。统一的部分是身份、授权、模型路由、调度、请求追踪和错误分类。

### 请求生命周期

1. **接入账号和模型。** 管理员选择供应商，提交凭证或完成授权。凭证服务加密落库并触发模型发现。模型目录在账号登记时发现并持久化。独立的周期目录刷新属于后续增强。路由基于请求操作与模型能力筛选。
2. **鉴权与调度。** 由调用 Key 确定操作权限和池范围。从支持该模型及参数的健康账号中选取可用租约。文本默认按容量和最近使用时间选择，显式续接和视频任务绑定原账号。账号分配事务结束后发送请求。
3. **凭证续期。** 每账号合并并发刷新，租约和版本比较保护 token 轮换。续期失败进入短时冷却，控制台显示冷却与到期状态。已被禁用的账号不会获得新执行租约。管理会话与调用 Key 分开验证，日志和控制台只展示去敏状态。
4. **文本执行。** 用同一个取消信号贯穿网络读取与写回。客户端断开时取消上游并释放租约。只有确认上游未收到请求或协议明确允许重试时才能重新执行。输出首字节后维持原执行尝试。SSE 按协议终止事件确定成功，截断和超时记录为中断。
5. **媒体执行。** 同步图片与异步视频共享输入素材校验和制品存储。视频任务先持久化任务、输入摘要、账号和提交 ID，再调用即梦。复刻先验证来源归属及原账号绑定。轮询和制品入库可重复执行，失败任务保留可向用户展示的状态。
6. **用量与诊断。** 请求 ID 关联账号、尝试与用量。真实报告与估算单独标记。指标关注首字节延迟、流中断、续期失败、任务积压及交付时间。日志省略 Cookie、token、授权码和媒体内容。

### 接口

客户端从 `GET /v1/models` 获取其密钥可用的模型。文本模型使用 `provider/model`，媒体模型使用 `seedream-5.5`、`seedance-2.0` 等公开 ID。

| 路径 | 行为 |
| --- | --- |
| `GET /v1/models` | 列出调用 Key 可用的模型及操作。控制台可展示画幅、数量、上传限制、时长、工具和流式等能力。 |
| `POST /v1/responses` | Codex OAuth 与 OpenAI API Key，按模型和凭证类型直连。首发验证 HTTP、SSE、非流式和工具回合。WebSocket 和服务器侧续接分别验收后开放。 |
| `POST /v1/messages`、`POST /v1/messages/count_tokens` | Kiro 与 Claude Messages。仅为实现并验收过计数的模型开放 count_tokens。 |
| `POST /v1/images/generations`、`POST /v1/images/edits` | 同步图片生成和参考图编辑，按模型验证输入，支持 URL 或 Base64。 |
| `POST /v1/videos`、`GET /v1/videos/:id`、`GET /v1/videos/:id/content`、`POST /v1/videos/edits` | 即梦视频创建、查询、下载和复刻，视频 ID 和任务状态由新服务管理。 |
| `/admin/v1/*` | 新控制台管理产品账号、模型、调用 Key、请求记录和媒体。 |
| `/livez`、`/readyz` | 进程健康与本地依赖就绪。供应商账号的状态单独显示。 |

视频任务循环处理提交确认恢复、轮询和交付。控制台与公开 API 读取同一批制品。

## 5. PostgreSQL 数据模型

空库从 [initial.sql](../app/backend/src/infrastructure/postgres/initial.sql) 初始化，版本记录在 `gateway_schema`。每个实例由一个管理员管理。调用权限由 API Key 的授权产品和操作决定。同一产品下的账号参与调度。媒体资源按调用 Key 归属。

| 表 | 职责与主要字段 |
| --- | --- |
| `admin_sessions` | 管理员用用户名和密码登录后建立限时 Cookie 会话。 |
| `api_keys` | Key 摘要、前缀、操作范围、到期、撤销和授权产品。 |
| `provider_accounts` | 账号通过 `provider` 区分产品。记录授权类型、凭证密文及版本、到期、冷却、启用状态和内部调度容量。 |
| `account_models` | 按账号保存公开模型 ID、上游模型 ID、操作和能力。 |
| `authorization_flows`、`account_leases` | OAuth 流程状态、加密 verifier、超时和一次性消费；账号并发及凭证刷新租约。 |
| `request_attempts` | 保存文本与图片的上游尝试、状态和可用的用量记录。视频生命周期由 `video_jobs` 记录。 |
| `video_jobs`、`media_assets` | 视频任务持有调用方、选定账号、幂等键及输入摘要、提交和历史 ID、状态、执行租约与下一次执行时间。制品记录对象 ID、归属、格式和大小。待提交视频参数和参考图加密保存于任务中。 |

数据库约束确保这些关联引用有效记录，视频的源任务和制品与其调用 Key 归属一致。视频幂等唯一键为 `(owner_id, operation, idempotency_key)`。同键同摘要返回原任务，同键不同摘要报冲突。调用前持久化提交 ID 和账号绑定，提交确认丢失时进入待确认并按原 ID 查询。数据库事务在出站 HTTP 前结束并释放连接，任务租约采用过期时间与版本校验。媒体文件存储在应用卷，数据库保存元数据与授权关系。

### 任务状态与存储一致性

正常路径为 `queued → submitting → in_progress → completed`，在最终完成前先写入影片及制品记录。读取不到提交确认时进入 `submission_unknown`，保持原账号及提交 ID 继续核对。明确失败进入 `failed`。视频取消 API 属于后续功能。任务领取与状态更新检查租约版本，进程重启后由任务循环继续推进。

制品先写入临时对象，校验后通过稳定对象键完成，再写入数据库引用。通过对象键和任务输出序号去重。原子写入在退出写入操作时清理临时文件。下载按调用方归属校验，图片 URL 可使用限时签名。定期扫描孤立文件属于后续增强。服务启动检查 SQL 版本和媒体卷，停止时先停止领任务、关闭新连接，再为现有流和任务提供限时收尾。

## 6. 测试与验收

四个供应商的发布验收记录入站协议、账号类型、上游服务和响应类型。即梦对照测试对时间戳、请求 ID 和随机字段做归一化。媒体测试覆盖上游接收后提交响应丢失的恢复。部署验收确认应用镜像内只有一个产品服务入口，上游访问由该进程发起，配置只包含应用基础设施和供应商原生账号所需设置。

覆盖详情和发布验收边界见 [测试与发布验收](integration-validation.md)。

### 长期维护约束

- **按模块测试。** 协议编解码用固定载荷和分片测试，供应商用可注入 HTTP 替身跑契约测试，账号租约与视频幂等用真实 PostgreSQL 集成测试。发布验收覆盖授权账号直连和客户端行为。
- **按模块升级上游。** 为复用代码固定来源提交。同步时重跑对应适配器测试和协议契约测试。增加模型映射属于目录变更，增加上游协议只影响对应供应商与公开协议边界。
- **先保持单体。** 应用实例共用数据库和媒体存储即可扩容时，沿用现有事务与租约。出现独立扩缩需求后，可调整同一应用中的任务循环部署方式，共享模块契约。数据库和媒体权限保持同一个产品边界。
- **控制首发规模。** 先验证账号接入、签发 Key、直接调用、流式和视频交付。跨协议任意互转、支付、分布式缓存和独立进程调度按具体需要再增加。

[sub-routes]: https://github.com/Wei-Shaw/sub2api/blob/81ce8356d9a289411987bdefeddc9710340d6d52/backend/internal/server/routes/gateway.go
[sub-schedule]: https://github.com/Wei-Shaw/sub2api/blob/81ce8356d9a289411987bdefeddc9710340d6d52/backend/internal/service/openai_account_scheduler.go
[sub-openai]: https://github.com/Wei-Shaw/sub2api/blob/81ce8356d9a289411987bdefeddc9710340d6d52/backend/internal/service/openai_gateway_service.go
[sub-refresh]: https://github.com/Wei-Shaw/sub2api/blob/81ce8356d9a289411987bdefeddc9710340d6d52/backend/internal/service/token_refresh_service.go
[sub-license]: https://github.com/Wei-Shaw/sub2api/blob/81ce8356d9a289411987bdefeddc9710340d6d52/LICENSE
[xiang-gateway]: https://github.com/xiangking/sub2api-kiro/blob/9541e0e9fb64718c15581985c84807232536d39b/backend/internal/service/kiro_gateway.go
[xiang-client]: https://github.com/xiangking/sub2api-kiro/blob/9541e0e9fb64718c15581985c84807232536d39b/backend/internal/pkg/kiro/client.go
[xiang-parser]: https://github.com/xiangking/sub2api-kiro/blob/9541e0e9fb64718c15581985c84807232536d39b/backend/internal/pkg/kiro/parse.go
[xiang-oauth]: https://github.com/xiangking/sub2api-kiro/blob/9541e0e9fb64718c15581985c84807232536d39b/backend/internal/service/kiro_oauth_service.go
[xiang-license]: https://github.com/xiangking/sub2api-kiro/blob/9541e0e9fb64718c15581985c84807232536d39b/LICENSE
[kobo-runtime]: https://github.com/kobojp/sub2api-kiro/blob/5b44a0110c9f846ee6ba2a467d540216244f6f20/backend/internal/service/kiro_runtime.go
[kobo-translator]: https://github.com/kobojp/sub2api-kiro/blob/5b44a0110c9f846ee6ba2a467d540216244f6f20/backend/internal/pkg/kiro/translator.go
[kobo-token]: https://github.com/kobojp/sub2api-kiro/blob/5b44a0110c9f846ee6ba2a467d540216244f6f20/backend/internal/service/kiro_token_provider.go
[kobo-license]: https://github.com/kobojp/sub2api-kiro/blob/5b44a0110c9f846ee6ba2a467d540216244f6f20/LICENSE
[cpa-interface]: https://github.com/router-for-me/CLIProxyAPI/blob/47f18e4d82bd72f7d2b5ecf5ede93e4837a4625e/sdk/cliproxy/auth/conductor.go
[cpa-execute]: https://github.com/router-for-me/CLIProxyAPI/blob/47f18e4d82bd72f7d2b5ecf5ede93e4837a4625e/internal/runtime/executor/codex_executor_execute.go
[cpa-stream]: https://github.com/router-for-me/CLIProxyAPI/blob/47f18e4d82bd72f7d2b5ecf5ede93e4837a4625e/internal/runtime/executor/codex_executor_stream.go
[cpa-auth]: https://github.com/router-for-me/CLIProxyAPI/blob/47f18e4d82bd72f7d2b5ecf5ede93e4837a4625e/internal/runtime/executor/codex_executor_auth.go
[cpa-ws]: https://github.com/router-for-me/CLIProxyAPI/blob/47f18e4d82bd72f7d2b5ecf5ede93e4837a4625e/internal/runtime/executor/codex_websockets_executor.go
[cpa-license]: https://github.com/router-for-me/CLIProxyAPI/blob/47f18e4d82bd72f7d2b5ecf5ede93e4837a4625e/LICENSE
[rust-provider]: https://github.com/xwteam/kiro2api/blob/124b14b4327d16148170c06af0161a615a6f0c0e/src/kiro/provider.rs
[rust-events]: https://github.com/xwteam/kiro2api/blob/124b14b4327d16148170c06af0161a615a6f0c0e/src/kiro/eventstream/decoder.rs
[rust-anthropic]: https://github.com/xwteam/kiro2api/blob/124b14b4327d16148170c06af0161a615a6f0c0e/src/protocol/anthropic/stream.rs
[rust-license]: https://github.com/xwteam/kiro2api/blob/124b14b4327d16148170c06af0161a615a6f0c0e/LICENSE
[ts-kiro-events]: https://github.com/krisamin/kiro-api/blob/46c9f086d8b6d04932f829d80ef76afae3c8dcac/src/kiro/event-stream.ts
[ts-kiro-payload]: https://github.com/krisamin/kiro-api/blob/46c9f086d8b6d04932f829d80ef76afae3c8dcac/src/kiro/payload.ts
[ts-kiro-client]: https://github.com/krisamin/kiro-api/blob/46c9f086d8b6d04932f829d80ef76afae3c8dcac/src/kiro/client.ts
[ts-kiro-stream]: https://github.com/krisamin/kiro-api/blob/46c9f086d8b6d04932f829d80ef76afae3c8dcac/src/anthropic/stream.ts
[ts-kiro-auth]: https://github.com/krisamin/kiro-api/blob/46c9f086d8b6d04932f829d80ef76afae3c8dcac/src/kiro/auth.ts
[ts-kiro-license]: https://github.com/krisamin/kiro-api/blob/46c9f086d8b6d04932f829d80ef76afae3c8dcac/LICENSE
[oauth-runtime]: https://github.com/EvanZhouDev/openai-oauth/blob/9079e62840a7f4b19114cb8f4bb0009b5bcf1773/packages/core/src/runtime.ts
[oauth-sse]: https://github.com/EvanZhouDev/openai-oauth/blob/9079e62840a7f4b19114cb8f4bb0009b5bcf1773/packages/core/src/sse.ts
[oauth-handler]: https://github.com/EvanZhouDev/openai-oauth/blob/9079e62840a7f4b19114cb8f4bb0009b5bcf1773/packages/openai-oauth/src/responses.ts
[oauth-package]: https://github.com/EvanZhouDev/openai-oauth/blob/9079e62840a7f4b19114cb8f4bb0009b5bcf1773/packages/core/package.json
[oauth-license]: https://github.com/EvanZhouDev/openai-oauth/blob/9079e62840a7f4b19114cb8f4bb0009b5bcf1773/packages/core/LICENSE
[pi-auth]: https://github.com/earendil-works/pi/blob/ede8bdca0b76dba9e0dc77376318cc3479ba8142/packages/ai/src/auth/oauth/openai-codex.ts
[pi-responses]: https://github.com/earendil-works/pi/blob/ede8bdca0b76dba9e0dc77376318cc3479ba8142/packages/ai/src/api/openai-codex-responses.ts
[pi-license]: https://github.com/earendil-works/pi/blob/ede8bdca0b76dba9e0dc77376318cc3479ba8142/LICENSE
