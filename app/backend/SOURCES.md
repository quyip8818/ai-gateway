# 内置供应商源码

| 路径 | 来源 | 接入改动 |
| --- | --- | --- |
| `src/providers/jimeng` | 本地 `jimeng-api`，`bf54a38451d18b80c66f1982590ef2f0a75b4c0a` 加图片和视频路由工作树更新 | 复用上游请求、上传、模型、媒体和浏览器传输。网关控制凭证、取消和任务存储。附来源仓库的 LICENSE。 |
| `src/providers/codex` | [openai-oauth core](https://github.com/EvanZhouDev/openai-oauth/tree/9079e62840a7f4b19114cb8f4bb0009b5bcf1773/packages/core) | OAuth、模型目录、Responses 和 SSE 按职责拆分，供网关直接调用。附 Apache-2.0 LICENSE 和 NOTICE。 |
| `src/providers/kiro` | [kiro-api](https://github.com/krisamin/kiro-api/tree/46c9f086d8b6d04932f829d80ef76afae3c8dcac/src) | 复用 EventStream、请求构造和 Messages 输出；注入账号凭证，替换原存储，关闭请求自动裁剪和缓存估算。附 MIT LICENSE。 |

所有来源代码纳入本仓库，构建和运行只需要本仓库的文件与 npm 锁定依赖。
