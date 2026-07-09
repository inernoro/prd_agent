# debt.llm-gateway-protocol-fidelity

| 字段 | 内容 |
|---|---|
| 模块 | LLM 网关协议保真层（函数调用穿协议 + 能力描述符路由） |
| 状态 | partial（核心已落地；Claude 流式 tool_use 增量已在后续分支补齐，以下保留未完成边界） |
| 关联 | `doc/design.llm-gateway-unification.md` 决策一、`prd-api/src/PrdAgent.Infrastructure/LlmGateway/`、`OpenApiController.cs`、`changelogs/2026-06-26_vision-detail-fix.md` |
| 提出 | 用户「协议不能归一，要保真」+ 取证后分波落地（F1 识图 / F3a 采样 / G1-G6 函数调用穿协议） |

---

## 债务主题

「函数调用（tools/tool_calls）穿协议不丢」已落地核心路径（OpenAI 透传 + Claude 原生互转 + Claude 流式 tool_use 增量、Open Platform 代理回吐 + 能力软门），但仍留下若干**已知边界**，下一波补齐。

## 已清账边界

### 1. Claude 流式函数调用（tool_use）增量映射
- 结论：已补齐。
- 证据：`ClaudeGatewayAdapter.ParseStreamChunk` 已把 `content_block_start(tool_use)` 映射为 OpenAI 形状 `ToolCall` 起始 delta，并把 `content_block_delta/input_json_delta` 映射为 `function.arguments` 增量。
- 测试：`LlmGatewayTests.ClaudeAdapter_ParseStreamChunk_ToolUseStart_EmitsToolCallChunk`、`LlmGatewayTests.ClaudeAdapter_ParseStreamChunk_InputJsonDelta_EmitsArgumentsDelta`、`GatewayProtocolFidelityTests` fixture cell `B071/B072`。

## 已知边界（本波未做，刻意不半成品）

### 1. 能力软门在「池路径」为 null（best-effort 放行）
- 现状：G4 能力软门读 `LLMModelCapability.function_calling`。但主路径 `ModelResolver.FromPool` 的解析上下文**只有 `ModelGroupItem`（ModelId+PlatformId），无 `LLMModel` 对象**（见 `IModelResolver.cs:FromPool` 注释），故 `SupportsFunctionCalling` 留 null（未知→放行）。仅直连/Legacy 路径（`FromLegacy` 持有 LLMModel）能填真值并触发熔断。
- 影响：池路径下，带 tools 但模型实际不支持函数调用时，不会被早熔断，而是透传给上游、由上游报错（用户仍拿到错误，只是不够友好/不够早）。
- 补法：在 `FromPool` 选中 ModelGroupItem 后，按 (ModelId, PlatformId) 加一次轻量 `LLMModel` 能力查询填充 `SupportsFunctionCalling`（需评估给热路径 resolve 加一次 DB 查询的代价，或在 resolver 已加载模型集时顺带带出，避免额外往返）。

### 2. Extensions 透传容器已建未消费
- 现状：`GatewayResponse.Extensions` / `GatewayStreamChunk.Extensions` 容器已加（G1），但目前只有 `ToolCalls` 是有真实消费者的强类型属性；`logprobs` 等 provider 特有字段尚无消费方读 Extensions。
- 影响：无（reserved，init-only 可空，零运行时代价）。
- 补法：需要 logprobs/其它特有字段时，在适配器解析处填 Extensions、在消费端（如 Open Platform 代理 / 日志）读出。

### 3. 实机 E2E（G6）被鉴权阻断，未取证
- 现状：F1/F3a/G1-G5 已 CI 全绿（1037 测试 + 11 新增）+ 部署到预览（`/api/v` 确认运行本分支 commit）。但**实机** before/after 取证未完成：
  - 函数调用实跑 `/api/v1/chat/completions` 需 `sk-ak-*` OpenApi key（用户 JWT 在「接入 AI」弹窗签发）；`AI_ACCESS_KEY` 不被该端点接受（`AgentApiKeysController` 注释：AiAccessKey 双身份已撤回）。AI 无法自助签发。
  - 识图 detail 走内部 `LLMAttachment` 路径（缺陷图分析 / 多图合成等内部功能），需登录态 + 功能上下文；浏览器直连预览被 agent 代理阻断（chromium ERR_CONNECTION_CLOSED，本 session 已确认 curl 可达但 chromium 不可达）。
- 补法：用户提供一个 `sk-ak-*`（接入 AI 弹窗一键生成）即可由 AI 跑函数调用实机冒烟；识图 A/B 由用户在缺陷图分析等功能页眼检，或后续补一条接受 AiAccessKey 的内部 vision 自测端点。

## 范围外（更大的后续波次，非本债务）

- gateway 物理独立成服务、观测性页面（Logs Generations/Upstream/Sessions）、池清理（IsMain/IsVision legacy 字段下线）、管理 UI OpenRouter 超集。
