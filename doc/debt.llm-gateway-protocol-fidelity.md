# debt.llm-gateway-protocol-fidelity

| 字段 | 内容 |
|---|---|
| 模块 | LLM 网关协议保真层（函数调用穿协议 + 能力描述符路由） |
| 状态 | partial（核心已落地 2026-06-26；以下为已知边界，未排期） |
| 关联 | `doc/design.llm-gateway-unification.md` 决策一、`prd-api/src/PrdAgent.Infrastructure/LlmGateway/`、`OpenApiController.cs`、`changelogs/2026-06-26_vision-detail-fix.md` |
| 提出 | 用户「协议不能归一，要保真」+ 取证后分波落地（F1 识图 / F3a 采样 / G1-G6 函数调用穿协议） |

---

## 债务主题

「函数调用（tools/tool_calls）穿协议不丢」本波已落地核心路径（OpenAI 透传 + Claude 原生互转 + Open Platform 代理回吐 + 能力软门），但留下三处**已知边界**，下一波补齐。

## 已知边界（本波未做，刻意不半成品）

### 1. Claude 流式函数调用（tool_use）增量未映射
- 现状：Claude **非流式** tool_use → OpenAI tool_calls 已实现（`ClaudeGatewayAdapter.ParseToolCalls`）。Claude **流式** 函数调用走 `content_block_start(tool_use)` + `input_json_delta` 多事件协议，映射到 OpenAI 流式 `delta.tool_calls` 增量更复杂，本波未做。
- 影响：客户端对 Claude 池**流式**调用函数时，tool_use 增量不透出（非流式不受影响；OpenAI 池流式不受影响）。
- 补法：`ClaudeGatewayAdapter.ParseStreamChunk` 增加 `content_block_start`(tool_use→起始 tool_call) + `input_json_delta`(→arguments 增量) 的状态机，产出 `ToolCall` chunk。

### 2. 能力软门在「池路径」为 null（best-effort 放行）
- 现状：G4 能力软门读 `LLMModelCapability.function_calling`。但主路径 `ModelResolver.FromPool` 的解析上下文**只有 `ModelGroupItem`（ModelId+PlatformId），无 `LLMModel` 对象**（见 `IModelResolver.cs:FromPool` 注释），故 `SupportsFunctionCalling` 留 null（未知→放行）。仅直连/Legacy 路径（`FromLegacy` 持有 LLMModel）能填真值并触发熔断。
- 影响：池路径下，带 tools 但模型实际不支持函数调用时，不会被早熔断，而是透传给上游、由上游报错（用户仍拿到错误，只是不够友好/不够早）。
- 补法：在 `FromPool` 选中 ModelGroupItem 后，按 (ModelId, PlatformId) 加一次轻量 `LLMModel` 能力查询填充 `SupportsFunctionCalling`（需评估给热路径 resolve 加一次 DB 查询的代价，或在 resolver 已加载模型集时顺带带出，避免额外往返）。

### 3. Extensions 透传容器已建未消费
- 现状：`GatewayResponse.Extensions` / `GatewayStreamChunk.Extensions` 容器已加（G1），但目前只有 `ToolCalls` 是有真实消费者的强类型属性；`logprobs` 等 provider 特有字段尚无消费方读 Extensions。
- 影响：无（reserved，init-only 可空，零运行时代价）。
- 补法：需要 logprobs/其它特有字段时，在适配器解析处填 Extensions、在消费端（如 Open Platform 代理 / 日志）读出。

## 范围外（更大的后续波次，非本债务）

- gateway 物理独立成服务、观测性页面（Logs Generations/Upstream/Sessions）、池清理（IsMain/IsVision legacy 字段下线）、管理 UI OpenRouter 超集。
