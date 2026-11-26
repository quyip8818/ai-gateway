# 集成测试覆盖与验收边界

## 对照来源

| 来源 | 参考场景 | 在本项目中的验证 |
| --- | --- | --- |
| 现有即梦仓库 | 视频历史同 ID 读取、封面与成品区分、终态、视频进度。Windows portable 脚本验证启动、改端口、端口冲突及移动后的可运行性。 | PostgreSQL 集成测试覆盖首帧上传、跨项目素材拒绝、封面期间保持运行、成品下载及 Range。Portable 场景属于旧仓库的 Windows 分发产品。 |
| CLIProxyAPI | Responses 工具事件、并行工具、输出恢复及 WebSocket 生命周期。 | 首发 HTTP/SSE 回归覆盖分片、多行事件、工具调用 ID 与工具结果续轮、取消、断流及安全备用切换。 [Codex 流式输出用例](https://github.com/router-for-me/CLIProxyAPI/blob/main/internal/runtime/executor/codex_executor_stream_output_test.go) · [Executor 测试目录](https://github.com/router-for-me/CLIProxyAPI/tree/main/internal/runtime/executor) |
| Sub2API | Anthropic 原生凭证、直通约束。 | 验证 Anthropic 原生 `x-api-key`、版本、Beta 标头和 token 计数。 [Anthropic passthrough 测试](https://github.com/Wei-Shaw/sub2api/blob/main/backend/internal/service/account_anthropic_passthrough_test.go) |
| Kiro Gateway | 账户故障分类、网络错误、流解析、协议转换和模型解析。 | 同类故障在本网关的 HTTP/SSE 和持久化任务测试中验证。Kiro 的 AWS EventStream、认证、转换与 WebSocket 文档仍归供应商对应接入阶段。 [Kiro 测试说明](https://github.com/jwadow/kiro-gateway/tree/main/tests) · [用例目录](https://github.com/jwadow/kiro-gateway/tree/main/tests/unit) |

## 本地运行

启动专用 PostgreSQL 16 测试库，将 `TEST_DATABASE_URL` 指向该库。在 `backend/` 执行 `go test ./tests/integration -count=1 -timeout=90s -v`。套件自动迁移数据库，并用进程内上游夹具验证真实 HTTP 请求、PostgreSQL 状态、媒体工作器与文件交付。

真上游用例 `TestLiveAuthorized` 默认跳过，需按 README 显式给出已授权网关、Key 和模型。首发仍需验证真实 CLI 多轮工具工作流、实际即梦模型与账号权益、真实 CDN 和积分回执。CI 的模拟验证覆盖这些工作流依赖的协议与持久化边界。
