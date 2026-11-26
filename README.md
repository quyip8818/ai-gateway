# AI Gateway

独立的 Go + PostgreSQL 网关和 React 控制台。OpenAI Responses 与 Anthropic Messages 原生入口走实时转发。即梦图片、视频走持久化任务 API。整体实现规格见 [实现文档](docs/implementation.md)。当前部署是单实例。

## 本地启动

安装 Node.js 24、pnpm、Go 1.26 和 PostgreSQL 16。在 `deploy/.env` 中填写 `BOOTSTRAP_USERNAME` 和 `BOOTSTRAP_PASSWORD`，然后运行 `pnpm start`。本地端口和即梦地址可在根目录 `.env` 配置。启动命令会安装前端锁定依赖、构建控制台和 Go 服务、启动本机数据库并初始化表结构。打开 `http://127.0.0.1:32270/app/`，使用 `deploy/.env` 中的用户名和密码登录。管理员只在空库创建。更改开发环境的管理员凭证后，运行 `pnpm reset` 重新初始化。首次创建管理员时会输出网关 API Key，之后也可以在控制台签发 Key。再次运行 `pnpm start` 会先关闭当前工作区的旧实例，再启动新实例。按 `Ctrl+C` 可手动停止。

本地数据库使用 `data/` 下的私有 Unix socket，数据库、媒体文件和生成的密钥均保存在该目录。PostgreSQL 工具可以来自 `PATH`、Homebrew 的 `postgresql@16` 或 `POSTGRES_BIN` 指定的 `bin` 目录。启动命令读取根目录的 `.env`，进程环境变量优先。可用 `HTTP_ADDR` 和 `PUBLIC_BASE_URL` 修改监听和访问地址。若配置了 `DATABASE_URL`，启动命令连接指定的 PostgreSQL 并初始化表结构，此时需要提供固定的 `KEY_DIGEST_SECRET` 和 `CONNECTION_SECRET`，也可以通过对应的 `_FILE` 变量指定密钥文件。

如果从支持自动重启之前的版本切换，先在原终端按 `Ctrl+C` 关闭旧实例。

## 代码检查与格式化

首次开发时运行 `npm --prefix frontend ci` 安装前端工具。已运行过 `pnpm start` 时可直接在根目录执行：

- `pnpm lint` 检查 TypeScript 类型与未使用声明、启动脚本语法、前端格式及 `go vet`。
- `pnpm format` 用 Prettier 格式化前端和启动脚本，并用 `gofmt` 格式化 Go 源码。

## SSH 部署

复制 `deploy/.env.example` 为 `deploy/.env`，填好 SSH、公开地址、数据库密码、网关密钥和初始管理员信息，然后在根目录执行 `pnpm run deploy`。部署脚本在目标服务器用 Docker Compose 构建并启动 Go 网关、PostgreSQL 和 Caddy，检查 `/readyz` 后切换当前版本。即梦服务独立部署。若两个服务在同一台服务器上，可以让网关加入即梦的 Docker 网络。 [部署配置与验证步骤](deploy/README.md)

部署后在项目管理中添加上游连接与模型路由。OpenAI 使用 `https://api.openai.com`，Anthropic 使用 `https://api.anthropic.com`。可用模型 ID 以凭证授权为准。

开发时可用 Node 24 执行 `make ui`，然后设置数据库、密钥和媒体目录等环境变量，在 `backend/` 运行 `go run ./cmd/gateway`。使用 Vite 独立开发服务器时，`PUBLIC_BASE_URL` 设为浏览器实际访问的开发地址。

## 即梦连接

1. 在相邻的 `../jimeng-api` 目录按该项目配置启用获授权的账号池并启动服务。使用 `GET /ping` 检查服务是否在线，并从该服务管理台签发托管 `jm_` Key。其当前图片和异步视频 API 都使用托管 Key。
2. `pnpm start` 默认将 `http://127.0.0.1:8000` 设为允许的即梦上游。上游使用其他地址时，将网关的 `JIMENG_BASE_URL` 改为网关进程可访问的服务根地址。用 Docker Compose 部署时填写容器可访问的上游地址。进入网关的「项目管理」，新建「即梦」连接，填写相同的服务地址和托管 Key。可用连接的「探活」检查模型目录接口是否可访问。
3. 发布 `image.generate` 或 `video.generate` 路由并填写真实上游模型 ID。可用模型从该 `jimeng-api` 实例的 `/v1/models` 查询。发布后，在网关的「产品接入 → 即梦」复制 API 调用示例，或打开「媒体工作台」提交任务和查看成品。

新发布的图片路由默认使用当前即梦协议，文生图发送 `size`，参考图走 `/v1/images/edits`。例如上游 `jimeng-image-5.0-pro` 可配置 `{"aspect_ratios":["1:1"],"image_sizes":{"1:1":"1536x1536"},"input_roles":["reference_image"]}`。已有路由及恢复的历史版本继续沿用原协议。需要切换的旧图片路由，发布一个新的版本即可。兼容较旧的即梦服务时可显式设置 `"image_api":"legacy"`。

视频路由例如 `jimeng-video-seedance-2.0` 可填写 `{"aspect_ratios":["16:9"],"video_sizes":{"16:9":"1280x720"},"duration_seconds":[5],"input_roles":["first_frame"]}`。规格和账号权益以实际部署为准。`jimeng-api` 的视频成品接口返回 CDN 重定向，需要把部署方允许的 CDN 主机名写入逗号分隔的 `JIMENG_DOWNLOAD_HOSTS`。网关拒绝未列出的重定向并在任务中显示 `download_host_not_allowed`，服务日志会显示被拒绝的主机名。修改配置并重启后，仍在交付中的任务会继续尝试下载。

客户端遇到提交超时应沿用原幂等键。受理未知时默认保留待核验。只有在连接登记时明确启用并已验证视频幂等协议，网关才会在原连接上用同一上游幂等键重放一次。图片提交的受理未知状态保留给人工核验。图片提交或视频轮询若从上游获得该任务的 `usage.credits_used`，按原值记入用量并在控制台显示。未报告时显示未知。任务详情支持图片预览和视频播放。

## 运行规则

- 路由支持草稿校验和将历史版本重发为新的版本。CLI 接入验证采用服务端签发的项目检查 ID，只有该检查开始后的实际生成请求才会使状态成功。
- 应用内部 `/metrics` 提供媒体队列、未确认提交、活跃任务、过期租约及最老排队任务时间。Caddy 公网入口屏蔽此路径。
- 编程路由可配置一个同供应商、同区域、同额度域的备用连接。仅在原连接拨号失败且未发送请求时切换一次。流已经开始时保留断流记录。
- 请求、媒体任务使用按项目与过滤条件签名的游标。控制台可翻页并回到最新记录。
- 每小时执行一次清理。终态任务素材、成品和幂等键保留 30 天，审计保留 90 天。清理上游用量关联之外的旧诊断记录，保留未决任务和账本引用。无引用的本地文件至少经过 24 小时宽限期才回收。
- 项目管理员可在后台为指标发布版本化内部积分价格，并对已确认的编程用量执行计费试算。每次尝试和指标只能入账一次，按调用发生前已生效的费率计算。支付、充值、退款和自动扣款需要独立的运营方案及授权。

## 数据库初始化

`pnpm reset` 会停止当前工作区的实例，用新建的 PostgreSQL 库替换 `data/postgres`，再用 `deploy/.env` 初始化管理员、默认项目和网关 Key，并启动服务。本地数据库中的数据会被清空。设置了 `DATABASE_URL` 时，命令会拒绝执行。

`gatewayctl init-db` 从单份 SQL 初始化空库，启动时可重复执行。

## 验证

- 后端编译和静态检查：`cd backend && go test ./... && go vet ./...`。
- PostgreSQL 集成测试：将 `TEST_DATABASE_URL` 指向专用测试数据库，在 `backend/` 执行 `go test ./tests/integration -count=1 -v`。仅在有该环境变量时启用。CI 启动 PostgreSQL 16 并执行。
- 集成测试用模拟上游覆盖原生 SSE、流中断、备用连接、图片和视频交付、受理确认丢失、租约恢复、幂等冲突、跨项目隔离、游标验签、撤销、保留清理、路由重发、接入验证、报告积分、混合运行和幂等计费。
- 控制台构建：`cd frontend && npm ci && npm run build`。
- 真实 Codex、Claude Code 和即梦验收需要获授权的上游连接、对应模型与客户端。试算账本使用内部积分。

上线前可用 `go test ./tests/integration -run TestLiveAuthorized -v` 做授权环境冒烟验证。仅在显式设置 `GATEWAY_LIVE_TEST=1`、`GATEWAY_LIVE_URL` 和 `GATEWAY_LIVE_KEY` 时发请求。逐项设置 `GATEWAY_LIVE_OPENAI_MODEL`、`GATEWAY_LIVE_ANTHROPIC_MODEL`、`GATEWAY_LIVE_IMAGE_MODEL` 或 `GATEWAY_LIVE_VIDEO_MODEL`，仅运行已配置的链路。该测试会消耗相应的真实上游额度。

[集成测试覆盖表与参考项目](docs/test-coverage.md)
