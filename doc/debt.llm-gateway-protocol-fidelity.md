# debt.llm-gateway-protocol-fidelity

| 字段 | 内容 |
|---|---|
| 模块 | LLM 网关协议保真层（函数调用穿协议 + 能力描述符路由） |
| 状态 | partial（核心已落地；Claude 流式 tool_use、池路径能力兜底与 OpenAI logprobs Extensions 消费已补齐，以下保留未完成边界） |
| 关联 | `doc/design.llm-gateway-unification.md` 决策一、`prd-api/src/PrdAgent.Infrastructure/LlmGateway/`、`OpenApiController.cs`、`changelogs/2026-06-26_vision-detail-fix.md` |
| 提出 | 用户「协议不能归一，要保真」+ 取证后分波落地（F1 识图 / F3a 采样 / G1-G6 函数调用穿协议） |

---

## 债务主题

「函数调用（tools/tool_calls）穿协议不丢」已落地核心路径（OpenAI 透传 + Claude 原生互转 + Claude 流式 tool_use 增量、Open Platform 代理回吐 + 池路径能力软门 + OpenAI logprobs Extensions 消费），但仍留下少量**已知边界**，下一波补齐。

## 已清账边界

### 1. Claude 流式函数调用（tool_use）增量映射
- 结论：已补齐。
- 证据：`ClaudeGatewayAdapter.ParseStreamChunk` 已把 `content_block_start(tool_use)` 映射为 OpenAI 形状 `ToolCall` 起始 delta，并把 `content_block_delta/input_json_delta` 映射为 `function.arguments` 增量。
- 测试：`LlmGatewayTests.ClaudeAdapter_ParseStreamChunk_ToolUseStart_EmitsToolCallChunk`、`LlmGatewayTests.ClaudeAdapter_ParseStreamChunk_InputJsonDelta_EmitsArgumentsDelta`、`GatewayProtocolFidelityTests` fixture cell `B071/B072`。

### 2. 能力软门在「池路径」为 null（best-effort 放行）
- 结论：已补齐。
- 证据：`ModelResolver` 在池成员缺少能力快照或模型级协议时，按 `(PlatformId, ModelId)` 读取 GW-owned/MAP `LLMModel`，只补解析结果的协议和能力元数据，不改变选路、不覆盖池成员价格和 MaxTokens；池成员已有快照时不额外查模型配置。
- 测试：`ModelResolverTests.PoolModelCapability_WhenPoolSnapshotMissing_ShouldFallbackToModelConfig`、`ModelResolverTests.PoolModelCapability_WhenFunctionCallingFalse_ShouldFlowToResolution`。

### 3. Extensions 透传容器消费
- 结论：已补齐第一条真实消费链路。
- 证据：`OpenAIGatewayAdapter.ParseExtensions` 已提取非流式 `choices[0].logprobs`；`LlmGateway.SendAsync` 写入 `GatewayResponse.Extensions`；OpenAI-compatible `/v1/chat/completions` 回吐 `choices[0].logprobs`。
- 测试：`OpenAIAdapter_ParseExtensions_PreservesChoiceLogprobs`、`SendAsync_PreservesOpenAiLogprobsInExtensions`、`OpenAiCompatibleEndpoint_PreservesLogprobsExtension`。

## 已知边界（本波未做，刻意不半成品）

### 1. 实机 E2E（G6）被鉴权阻断，未取证
- 现状：F1/F3a/G1-G5 已 CI 全绿（1037 测试 + 11 新增）+ 部署到预览（`/api/v` 确认运行本分支 commit）。但**实机** before/after 取证未完成：
  - 函数调用实跑 `/api/v1/chat/completions` 需 `sk-ak-*` OpenApi key（用户 JWT 在「接入 AI」弹窗签发）；`AI_ACCESS_KEY` 不被该端点接受（`AgentApiKeysController` 注释：AiAccessKey 双身份已撤回）。AI 无法自助签发。
  - 识图 detail 走内部 `LLMAttachment` 路径（缺陷图分析 / 多图合成等内部功能），需登录态 + 功能上下文；浏览器直连预览被 agent 代理阻断（chromium ERR_CONNECTION_CLOSED，本 session 已确认 curl 可达但 chromium 不可达）。
- 已补的非上游证据门：`/gw/v1/route-self-test` 提供受 `X-Gateway-Key` 保护的 dry-run 自检，覆盖 GW Native / OpenAI-compatible / Claude-compatible / Gemini-compatible 四类入口到 IR 的路由元数据，不访问上游、不写 appCaller 注册表、不递增限流窗口。它只能证明入口协议和路由上下文未漂移，不能替代真实 provider E2E。
- 补法：用户提供一个 `sk-ak-*`（接入 AI 弹窗一键生成）即可由 AI 跑函数调用实机冒烟；识图 A/B 由用户在缺陷图分析等功能页眼检，或后续补一条接受 AiAccessKey 的内部 vision 自测端点。

## 范围外（更大的后续波次，非本债务）

- gateway 物理独立成服务、观测性页面（Logs Generations/Upstream/Sessions）、池清理（IsMain/IsVision legacy 字段下线）、管理 UI OpenRouter 超集。
