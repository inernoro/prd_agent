# LLM Gateway 协议入口与模型池迁移 · 计划

> **版本**：v1.2 | **日期**：2026-07-11 | **状态**：开发中

## 1. 概述

本计划定义 LLM Gateway 的目标态：MAP 和外部系统都不直接管理上游模型请求，也不直接拥有模型池调度权。所有 AI 请求先进入独立 LLM Gateway，由 Gateway 完成协议适配、appCaller 注册、模型池路由、平台密钥使用、上游发送、日志与审计。

当前生产已经完成 **执行层 full-http** 和存量 caller 的 **配置权威迁移**：MAP 运行时通过 `llmgw-serve` 发送模型请求，GW 日志能看到 `transport=http`，配置权威报告为 ready、MAP fallback 对象为 0。`2026-07-11` 生产验收进一步发现一处最后的双权威：新 caller 虽会被动写入 GW registry，执行层仍要求命中 MAP 静态注册表。本计划当前批次正在移除该运行时硬门；合并部署前不得宣称新外部 caller 已完成目标态。

目标主线：

```text
MAP / 外部系统
  -> GW ingress adapter
  -> GW Request IR
  -> appCaller registry
  -> GW router
  -> GW model pools
  -> provider adapter
  -> upstream model provider
```

本计划与现有文档分工：

| 文档 | 职责 |
|---|---|
| `doc/plan.llm-gateway.full-cutover.md` | 发布 gate、生产 shadow/canary/http 阶段、MECE 回归与回滚 |
| `doc/design.llm-gateway-unification.md` | 解释模型池、协议、adapter、exchange 的历史演进与设计取舍 |
| 本文档 | 定义目标协议入口、GW 模型池归属、appCaller 迁移和下一阶段实施路线 |

## 1.1 后续实施切片

截至 2026-07-09，本文档本身只是目标架构 SSOT。下表描述的是后续拆分 PR 应逐步提供的目标实现证据，
不是 PR-A 单独合入 main 后即可使用的线上能力。各切片只有在对应代码 PR 合入、CI 通过、生产 gate 留证后，
才能从“计划证据”升级为“已落地证据”。

| 切片 | 目标实现证据 | 仍缺口 |
|---|---|---|
| 多入口协议 | `llmgw-serve` 已提供 GW Native、OpenAI-compatible、Claude-compatible、Gemini-compatible 入口，并统一转 `GatewayIngressRequest`；OpenAI-compatible 已覆盖 chat/completions、Responses 基础文本形态、Responses 非流式与流式 tool call、Responses input_image 视觉路由和 `detail` 参数保真、Images JSON 文生图、Images edits 基础 multipart 形态和 `image[]`/`image[n]` 多图 multipart 字段规范化；Claude-compatible 已覆盖 Messages 基础文本、base64/url image block 转统一 `image_url` 并按 vision 路由、非流式 tool_use 和流式 tool_use 事件；Gemini-compatible 已覆盖 generateContent 基础文本、streamGenerateContent 基础 SSE、inlineData/fileData image 转统一 `image_url` 并按 vision 路由、functionDeclarations/toolConfig 转统一 tools、functionCall/functionResponse 与统一 tool_calls/tool result 的双向映射；兼容入口支持 `X-Gateway-Model-Policy`、`provider.model_policy` 显式声明 `auto/pool/pinned`，并支持 `X-Gateway-Model-Pool-Id`、body `modelPoolId/model_pool_id`、`provider.modelPoolId/model_pool_id` 指定本次请求的 GW 模型池；兼容入口也支持 `X-Gateway-Pinned-Platform-Id`、`X-Gateway-Pinned-Model-Id`、body/provider metadata 的 `pinnedPlatformId/pinned_platform_id` 与 `pinnedModelId/pinned_model_id`，用于把 pinned 请求精确锁到指定平台和模型；GW Native 尊重 `Context.ModelPolicy` 与 `Context.ModelPoolId`，`pool` 策略会进入 IR、日志上下文和现有池 Id/Code/名称匹配链路 | OpenAI Responses 更完整原生事件格式、Images 对象存储引用 edits、Claude 更完整原生事件格式、Gemini multipart 与更完整原生事件格式仍需补齐 |
| appCaller registry | 请求进入 GW 后写入 `llm_gateway.llmgw_app_callers`；首次 discovered 会用请求里的 modelPolicy、modelPoolId、parameterPolicy 初始化治理建议，后续请求只更新观察字段，不覆盖管理员配置；控制台可维护状态、池、策略、owner、预算、RPM 和审计；运行时准入只校验 canonical code + modelType 后缀，不再要求动态 caller 写入 MAP 静态注册表；生产动态 caller 的预算、并发、scoped key、failover 和清理验收已通过 | MAP 静态表仍保留为源码字面量守卫和展示元数据，不再是运行时权威；流式输出后断流、Exchange async poll、二进制下载和 WebSocket ASR 仍不跨 provider 重放 |
| registry 优先路由 | `ModelResolver` 已在 pinned 之后优先读取可运行状态 + ModelPoolId 的 GW registry 绑定；生产已开启 `LlmGateway:DisableMapConfigFallbackForActiveAppCallers` 退场门，配置权威报告 ready、MAP fallback 对象为 0；动态 caller 生产验证通过 | disabled/archived 状态继续 fail closed；discovered caller 必须完成治理后才作为长期入口 |
| GW-owned model pool | 控制台可直接新建 `llm_gateway.llmgw_model_pools`，也可批量认领 MAP `model_groups`；resolver 命中 active appCaller 时优先读取 GW 池，找不到再回退 MAP 池；退场门开启后 active appCaller 只接受 GW-owned 池，且跳过 expectedModel 的 MAP 全量池与 LLMModels 直连兜底；GW 权威池已有属性编辑、成员添加、批量导入、删除和优先级更新入口；模型页可按平台/启用态批量维护 GW-owned 模型通用能力矩阵，并可套用 OpenAI/Claude/Gemini/OpenRouter 字段级参数模板；成员保存或批量导入时记录模型能力快照，模型池页可按当前池类型或 vision/image/tool/parallel-tools/parameters/thinking/structured-output/logprobs/prompt-cache 过滤候选；运行时池解析已读取能力和字段级参数矩阵；生产配置权威报告 ready、MAP fallback 对象为 0 | discovered caller 仍需治理后才能获得长期池策略；默认池与高级能力矩阵继续按真实需求维护 |
| GW-owned platforms/models/exchanges | 控制台 API 可将 MAP `llmplatforms`、`llmmodels`、`model_exchanges` 认领到 `llm_gateway.llmgw_platforms`、`llmgw_models`、`llmgw_model_exchanges`；resolver 解析普通池、pinned、exchange 和可用池展示时先读 GW 副本；退场门开启后可运行 appCaller 的 GW 池条目不再借 MAP platform/exchange；生产 key integrity、配置权威与 provider audit 均通过 | 平台/模型/Exchange 深度编辑仍可增强；serving 所需资产配置尚未从 MAP 配置域物理迁出 |
| 参数策略 | `parameterPolicy` 和 `droppedParameters` 已进入请求上下文、LLM 日志详情和控制台详情抽屉；`strict-require` 已对 function_calling、parallel_tool_calls、vision、image_generation、thinking、structured_output/json_schema、logprobs/top_logprobs 这些已模型化能力执行“未知也拒绝”的 router 门，覆盖普通 send/stream 与 raw 发送路径；字段级矩阵已支持 `parameter:<name>`/`param.<name>` 能力标记，对 `temperature/top_p/seed/stop/frequency_penalty/presence_penalty/response_format/json_schema/tools/tool_choice/parallel_tool_calls/logprobs/top_logprobs/reasoning_effort/thinking/max_completion_tokens/max_tokens/modalities/audio/prediction/stream_options/service_tier/store/user/n` 等参数执行 strict 校验；控制台暴露 `/gw/parameter-capabilities/meta`，模型池成员可按元数据提示输入 `seed, stop=false` 维护这些能力；模型页可批量写 `parameter:<name>` 能力到 GW-owned 模型，并支持 provider 模板一键填充；OpenAI-compatible 入口在 `provider.require_parameters=true` 且存在 dropped 参数时会直接 400，GW native/send/raw 也兜底拒绝 strict+droppedParameters | 仍需继续按真实 provider 文档扩展模板覆盖面 |

## 2. 目标边界

### 2.1 MAP 保留什么

MAP 是业务系统，不再是模型路由系统。MAP 保留：

| 范围 | 说明 |
|---|---|
| 业务协议 | 前端到 MAP 的接口、run 创建、工作流、画布、素材引用、消息协议 |
| 业务生命周期 | report run、image run、video run、ASR run、workflow run 的状态机 |
| 业务数据 | 用户、项目、会话、作品、素材、画布、业务日志 |
| GW 调用上下文 | `requestId`、`sessionId`、`runId`、`appCallerCode`、业务 metadata |

MAP 发给 GW 的请求必须是“我要完成什么 AI 能力”，而不是“我自己决定走哪个上游密钥和模型池”。

### 2.2 LLM Gateway 拥有什么

GW 是 AI 请求治理层。GW 拥有：

| 范围 | 说明 |
|---|---|
| appCaller 注册表 | appCallerCode、title、sourceSystem、requestType、owner、状态、月预算、每分钟限流元数据；每分钟限流已在 serving 发送入口 enforcement，月预算已基于已有日志成本证据 enforcement |
| 模型池 | 每个 appCaller/requestType 的默认池、专属池、兜底链、健康状态 |
| 路由策略 | auto、pool、pinned、fallback、provider preference、严格参数策略 |
| 平台与 exchange | 上游平台、协议、baseUrl、模型 slug、exchange transformer |
| 密钥 | 上游 API key、服务间 key、控制台账号和操作审计 |
| GW 日志 | 请求日志、上游尝试日志、shadow comparison、fallback 证据、router metadata |

数据所有权原则：MAP 日志解释业务发生了什么；GW 日志解释模型请求如何路由、发给谁、为什么失败或 fallback。

## 3. 四类入口协议

GW 对外兼容多种入口，但内部只吃统一 IR。任何入口都必须先被 ingress adapter 规范化，不允许各入口直接绕过路由器。

| 入口 | 目标 | 示例路径 | 处理方式 |
|---|---|---|---|
| GW Native | MAP 和内部系统的最完整协议 | `/gw/v1/invoke`、`/gw/v1/stream`、`/gw/v1/raw` | 原生表达 appCaller、requestType、modelPolicy、attachments、trace metadata |
| OpenAI-compatible | 兼容业界默认调用心智 | `/v1/chat/completions`、`/v1/responses`、`/v1/images/generations` | 保留 OpenAI schema，补充 header/body 中的 app attribution |
| Claude-compatible | 兼容 Anthropic Messages 调用方式 | `/v1/messages` | Anthropic body 转 IR，工具、thinking、stop、stream 进入能力字段 |
| Gemini-compatible | 兼容 Gemini generateContent 调用方式 | `/v1beta/models/{model}:generateContent`、`/v1beta/models/{model}:streamGenerateContent` | content parts、inline data、generationConfig、functionDeclarations、toolConfig 转 IR；functionCall/functionResponse 与统一 tool_calls/tool result 双向转换 |

入口协议只是“皮肤”。真正的模型池选择、密钥、fallback、健康降级必须在 GW router 里完成。

## 4. GW Request IR

所有入口统一转成一个内部请求结构，router 只处理 IR，不理解 OpenAI/Claude/Gemini 的外部 body 细节。

IR 至少包含：

| 字段 | 说明 |
|---|---|
| `requestId` | 端到端追踪 ID。没有则 GW 生成 |
| `sourceSystem` | `map`、`external`、`console`、`workflow` 等 |
| `appCallerCode` | 业务归因和模型池绑定主键 |
| `requestType` | `chat`、`generation`、`vision`、`video-gen`、`asr`、`embedding` 等 |
| `input` | messages、prompt、image refs、audio refs、video refs、raw body 的规范化表达 |
| `modelPolicy` | `auto`、`pool`、`pinned` |
| `modelPoolId` | `pool` 模式的显式 GW 模型池选择键；兼容入口可从 header、body 或 provider metadata 传入 |
| `capabilityRequirements` | tools、json schema、thinking、vision detail、multipart、stream 等 |
| `parameterPolicy` | `default-drop` 或 `strict-require` |
| `trace` | `sessionId`、`runId`、`userId hash`、`workspaceId`、业务 metadata |

IR 的原则是“路由需要什么就保留什么，协议专有字段放进 extensions”。不要为了统一而丢掉 provider 专有能力。

## 5. 路由模式

### 5.1 auto

调用方不指定模型，只给 `appCallerCode` 和 `requestType`。GW 根据 appCaller 注册表和默认模型池选择模型。

适用场景：

| 场景 | 示例 |
|---|---|
| 普通业务能力 | 周报生成、聊天、摘要、普通图片生成 |
| 外部系统标准接入 | 第三方只想要“可用的 chat 模型” |
| 运维统一控价 | 某个 appCaller 从贵模型切到便宜模型，不改调用方代码 |

### 5.2 pool

调用方指定某个 GW 模型池。GW 仍在池内做健康、fallback 和能力过滤。

表达方式必须落到 IR 的 `modelPolicy=pool` 与 `modelPoolId`：

| 入口 | 表达方式 |
|---|---|
| GW Native | `Context.ModelPolicy=pool` + `Context.ModelPoolId=<gw-pool-id>` |
| OpenAI-compatible | `X-Gateway-Model-Policy: pool` + `X-Gateway-Model-Pool-Id`，或 body/provider metadata 的 `modelPoolId` / `model_pool_id` |
| Claude-compatible | 同 OpenAI-compatible 的 header/body/provider metadata 约定 |
| Gemini-compatible | 同 OpenAI-compatible 的 header/body/provider metadata 约定 |

resolver 选择池时按 GW 模型池 `Id`、`Code`、`Name` 匹配；一旦命中池，池内模型仍由 GW 依据健康、能力、fallback 策略选择。

适用场景：

| 场景 | 示例 |
|---|---|
| 产品分层 | 免费池、标准池、高质量池 |
| 客户隔离 | enterprise pool、byok pool |
| 实验性能力 | 某个业务暂时使用 video-beta pool |

### 5.3 pinned

调用方指定模型，或指定 `platformId + modelId`。GW 必须精确调用该平台该模型，不允许被默认池覆盖。

适用场景：

| 场景 | 示例 |
|---|---|
| ModelLab | 用户明确测试某个模型 |
| Arena | A/B 两侧必须真实调用用户选中的模型 |
| 故障复现 | 运维要复现某个平台某个模型的错误 |

pinned 不是直连豁免。它仍必须经过 GW 鉴权、日志、密钥、上游 adapter 和审计。

表达方式：

| 入口 | 表达方式 |
|---|---|
| GW Native | `PinnedPlatformId` + `PinnedModelId`，或 `Context.ModelPolicy=pinned` + `ExpectedModel` |
| OpenAI-compatible | `X-Gateway-Pinned-Platform-Id` + `X-Gateway-Pinned-Model-Id`，或 body/provider metadata 的 `pinnedPlatformId` / `pinned_platform_id` 与 `pinnedModelId` / `pinned_model_id` |
| Claude-compatible | 同 OpenAI-compatible 的 header/body/provider metadata 约定 |
| Gemini-compatible | 同 OpenAI-compatible 的 header/body/provider metadata 约定；URL path 中的 `{model}` 仍作为 `ExpectedModel` 进入追踪 |

## 6. 参数策略

不同入口协议能表达的参数不一样，不同上游模型能吃的参数也不一样。GW 采用两档策略。

| 策略 | 行为 | 适用场景 |
|---|---|---|
| `default-drop` | provider adapter 丢弃目标模型不支持的参数，并把字段写入 `droppedParameters` | 普通业务请求，优先成功返回 |
| `strict-require` | 对已模型化的能力要求，目标模型未确认支持即拒绝；入口适配器已判定会被丢弃的参数直接拒绝；对第一批字段级参数读取 `parameter:<name>` 能力矩阵 | JSON schema、tool calling、thinking、合规要求、复现问题 |

当前已模型化能力门：

| 能力 | 请求触发条件 | 能力键 |
|---|---|---|
| 函数调用 | `tools` 非空 | `function_calling`、`tool_calling`、`tools` |
| 并行工具调用 | `parallel_tool_calls=true` | `parallel_tool_calls`、`parallel_tools`、`parallel_function_calling` |
| 视觉输入 | requestType 为 vision、multipart 图片、或 body 包含 image 输入 | `vision`、`image_input`、`multimodal` |
| 图片生成 | requestType 为 generation、images generation 路径 | `image_generation`、`text_to_image`、`image` |
| 推理输出 | `includeThinking=true` | `thinking`、`reasoning` |
| 结构化输出 | `response_format.type=json_schema/json_object` 或包含 `json_schema` | `structured_output`、`json_schema`、`json_mode`、`response_format` |
| Token 概率 | `logprobs=true` 或 `top_logprobs>0` | `logprobs`、`top_logprobs`、`token_logprobs` |
| 字段级参数 | 请求包含受管参数且模型能力标记为 `parameter:<name>` 或 `param.<name>` | 第一批：`seed`、`stop`、`frequency_penalty`、`presence_penalty`、`modalities`、`audio`、`prediction`、`stream_options`、`service_tier`、`store`、`user`、`n`；控制台元数据接口：`/gw/parameter-capabilities/meta` |

默认丢弃不是静默丢弃。日志必须记录：

| 字段 | 说明 |
|---|---|
| `requestedParameters` | 调用方传了什么能力或参数 |
| `supportedParameters` | 最终模型声明支持什么 |
| `droppedParameters` | 被适配器丢弃的字段 |
| `strictFailureReason` | 严格模式失败原因 |

## 7. appCaller 被动注册

appCallerCode 不应再由 MAP 预先长期维护。目标行为：

1. 请求进入 GW。
2. GW 解析出 `sourceSystem`、`appCallerCode`、`requestType`、`title`、metadata。
3. 如果 appCaller 不存在，GW 创建 discovered 记录。
4. 默认按 requestType 的系统默认池运行，或按安全策略要求先配置再启用。
5. 控制台允许管理员把 discovered 记录配置成 active，并绑定模型池、预算、限流、日志策略。

建议状态机：

| 状态 | 说明 | 是否可接真实流量 |
|---|---|---|
| `discovered` | GW 首次看到，但未人工确认 | 可按系统默认池低权限运行，或按部署策略拒绝 |
| `configured` | 已配置 title、owner、默认池、策略 | 可 |
| `active` | 已正式纳入治理 | 可 |
| `disabled` | 禁用 | 否 |
| `archived` | 历史保留 | 否 |

禁止把任何拼错的 appCallerCode 自动变成长期有效配置。被动注册解决“没人登记”，状态机解决“拼错污染”。

## 8. 模型池迁移路线

### Phase 1 - 目标模型盘点

输出一张迁移表：

| 来源 | 目标 |
|---|---|
| MAP `llm_app_callers` | GW appCaller registry |
| MAP `model_groups` | GW model pools |
| MAP `llmplatforms` | GW platforms |
| MAP `model_exchanges` | GW exchanges / provider adapters |
| MAP `llmrequestlogs` 中的模型请求字段 | GW request logs，MAP 保留业务关联字段 |

验收：每个现有 appCallerCode 都能在 GW 控制台看到归属、requestType、当前模型池和最近请求。

### Phase 2 - GW registry 写入权威

GW 首次写入 appCaller discovered/configured/active 状态；MAP 调用只携带 appCaller 上下文，不再负责长期注册。

验收：

| 断言 | 说明 |
|---|---|
| 新 appCaller 首次请求后出现在 GW registry | 不需要改 MAP seed |
| 管理员能在 GW 控制台绑定模型池 | 绑定后下一次请求生效 |
| MAP 不再直接写 appCaller 长期配置 | 只传上下文 |

### Phase 3 - 模型池权威迁移

GW 拥有池、平台、exchange、key。MAP 只读或不读这些集合。

验收：

| 断言 | 说明 |
|---|---|
| `auto` 请求按 GW 池路由 | 不依赖 MAP 模型池配置 |
| `pool` 请求命中指定 GW 池 | 池内 fallback 仍由 GW 决定 |
| `pinned` 请求精确命中平台和模型 | 不被默认池覆盖 |

### Phase 4 - 入口协议兼容

四类入口全部走 IR 和 router。

验收矩阵：

| 入口 | auto | pool | pinned | stream | tools | vision/multipart |
|---|---|---|---|---|---|---|
| GW Native | 必测 | 必测 | 必测 | 必测 | 必测 | 必测 |
| OpenAI-compatible | 必测 | 可选 | 必测 | 必测 | 必测 | 必测 |
| Claude-compatible | 必测 | 可选 | 必测 | 必测 | 必测 | 可选 |
| Gemini-compatible | 必测 | 可选 | 必测 | 必测 | 必测 | 必测 |

### Phase 5 - MAP 配置读取退场

MAP 内部残留的模型池读取路径降级为兼容层，然后删除或只保留迁移工具。

当前代码已经具备第一层退场门：`LlmGateway:DisableMapConfigFallbackForActiveAppCallers`（或环境变量 `LLMGW_DISABLE_MAP_CONFIG_FALLBACK_FOR_ACTIVE_APP_CALLERS=true`）。该开关默认关闭，不改变生产现状；开启后，`Status=active` 的 GW appCaller 必须绑定有效 GW-owned 模型池，池内平台和 Exchange 也必须在 `llm_gateway` 自有集合中可解析，否则 resolver fail closed，不再借 MAP 配置兜底。控制台 `/gw/config-authority/report` 已返回 `mapFallbackObjectsRemaining` 与 `activeAppCallerMapFallbackReady` 作为启用前证据。

退场操作通过 `scripts/llmgw-config-authority-apply.py` 固化：默认 dry-run 只读取 report；确认后传
`--execute` 才会调用 `/gw/config-authority/bulk-claim` 把 MAP 池、平台、模型、Exchange 认领到 GW 权威集合，
再调用 `/gw/config-authority/bind-active-app-callers` 给 active appCaller 绑定同 requestType 的 GW 默认池。
最终用 `--require-ready` 要求 `status=ready`，并输出 JSON/Markdown 证据。脚本拒绝 must-change-password 账号，
避免用未完成首登安全动作的控制台账号放行生产退场。

生产推进时该动作不是手工散跑，而是独立 `config-authority` 阶段：`scripts/llmgw-prod-stage.sh --stage config-authority`
排在 `rollback-rehearsal` 之后、所有 canary 之前。它会在同一 commit 的 rollout ledger 中要求前置阶段成功，
执行时不运行 `fast.sh` / `exec_dep.sh`，而是先运行 `scripts/llmgw-config-authority-backup.sh` 备份
`llm_gateway` 全库与 MAP 模型配置关键集合，再运行配置权威脚本。台账会把
`*.config-authority-backup.json` 和 `*.config-authority.json` 作为前置证据；备份证据必须是非 dry-run、
包含 `backupDir`、`archiveCount>0` 与 `sha256Sums`，否则不能记录 success。
后续 canary 和 `http-full` 只有在该阶段成功后才能继续，避免视频/ASR 暂缓时阻塞 GW 配置权威迁移，也避免灰度还依赖 MAP 配置兜底。
该阶段不切用户流量，因此不会新增 24 小时观察等待；canary 的观察窗口仍按上一个真实流量阶段计算。

发布 gate 已接入同一证据源：`scripts/llmgw-release-gate.py --require-config-authority` 会读取 GW 控制台
`/gw/config-authority/report`，要求 `status=ready`、`mapFallbackObjectsRemaining=0`、
`activeAppCallerMapFallbackReady=true`。`scripts/llmgw-rollout-ledger.py` 对 `http-full` 成功记录会强制校验
release gate 证据包含 `configAuthority.required=true` 且 `ok=true`，避免只靠 shadow 样本绕过配置权威退场门。
`scripts/llmgw-release-gate.py --require-runtime-gates` 会读取 GW 控制台 `/gw/runtime-gates`，要求
`readyForHttpFull=true` 且所有 blocking gate 通过；`exec_dep.sh` 在 `LLMGW_MODE=http` 的 post-deploy
verification 中会复用同一组 release gate 参数再跑一次并传入 `--expect-commit`，要求控制台 runtime gates
顶层 `releaseCommit` 与发布 commit 一致，然后写回 release-gate 证据。`http-full` rollout ledger
会拒绝缺少 `runtimeGates.required=true`、`ok=true`、`readyForHttpFull=true` 的成功记录。release gate 还提供
`--self-test` 离线验证 runtime-gates pass/fail 解析逻辑，并由 readiness audit 自动执行，避免该硬门只停留在
静态字符串检查。
因此 `scripts/llmgw-prod-stage.sh` 和 GitHub production stage workflow 在 `http-full` 阶段也会像
`config-authority` 一样前置要求 `LLMGW_CONSOLE_BASE` 和控制台 token 或账号密码，避免发布跑到后半程才因
无法读取控制台 gate 失败。
控制台另提供只读 `/gw/runtime-gates` 聚合视图，把配置权威、active appCaller 绑池、shadow/http 证据、
full-http rollout ledger 与 legacy 清理窗口压成同一组 gate；Overview 第一屏展示该 gate 列表。
每个 runtime gate item 同时提供 `facts` 字典，例如 `missingAppCallerCodes`、`droppedParameterLogs`、
`mapFallbackObjectsRemaining`，用于控制台、release gate JSON 和 Markdown 报告稳定引用阻塞事实，
避免后续脚本解析中文 detail。
该视图只用于定位阻塞点，不替代生产发布脚本、备份证据和 rollout ledger。`config_authority_rollout_ledger`
和 `full_http_rollout_ledger` gate 会读取 `LlmGateway:RolloutLedgerPath` 或 `LLMGW_ROLLOUT_LEDGER`
指向的 JSONL 台账，默认 `.llmgw-release-evidence/rollout-ledger.jsonl`。`config_authority_rollout_ledger`
只有同 `GIT_COMMIT` 的 `config-authority success` 记录同时带 `externalBackupJson` 和
`configAuthorityJson` 时才显示通过。`full_http_rollout_ledger` 只有同 `GIT_COMMIT` 的
`http-full success` 记录同时带 `releaseGateRequired=true`、`disableMapConfigFallbackForActiveAppCallers=true`、
`evidenceJson` 和 `releaseGateJson` 时才显示通过。`shadow_runtime_evidence` gate 同样只统计
`ReleaseCommit=GIT_COMMIT` 的 shadow comparison；缺 `GIT_COMMIT` 或当前 commit 无样本时保持 waiting，
台账类 gate 的 `facts` 会固定暴露 `rolloutLedger`、`currentCommit`、`latestCommit`、`sameCommit`、
`recordedAt`、`missing`，并按阶段补充 `externalBackupJson`、`configAuthorityJson`、`releaseGateJson`、
`disableMapConfigFallbackForActiveAppCallers` 等布尔字段；控制台和 release gate 报告应读取这些键，而不是解析中文 detail。
避免混用旧版本 shadow 样本。`gateway_key_integrity` gate 会复用 `/gw/key-health` 口径，要求 GW
专用主密钥已配置、无不可解 key、无 legacy secret 解密、无开发桩不可解，并且启用的平台/Exchange
不能缺 key；模型级 key 缺失不直接阻塞，因为模型可继承平台 key。`appcaller_policy_drift`
gate 只统计 `active/configured` appCaller：最近请求观察到的 `modelPolicy/modelPoolId/parameterPolicy`
与管理员配置值不一致时阻塞 full-http，要求先通过 `/app-callers?drift=any` 复核并治理。
`gateway_pool_member_readiness` gate 统计 active appCaller 绑定的 GW 池，要求每个池至少有一个
非 `Unavailable`、可解析到 GW-owned 启用平台/模型或启用 Exchange 的成员，避免只完成“绑池”但池内无可发送候选。
`active_appcaller_map_fallback_exit` gate 读取当前运行态 `LlmGateway:DisableMapConfigFallbackForActiveAppCallers`
或 `LLMGW_DISABLE_MAP_CONFIG_FALLBACK_FOR_ACTIVE_APP_CALLERS`，并同时要求 MAP-only 配置对象为 0、active appCaller
均已绑定有效 GW 池、无 discovered 调用方等待治理、active 绑定池均有可用成员。这样 full-http post-deploy
不能只依赖 rollout ledger 声明“已关闭 MAP fallback”，必须由控制台进程自己证明 resolver 的退场门已打开。
`current_commit_http_transport` gate 只统计当前 `GIT_COMMIT` 的 LLM 请求日志，要求 `GatewayTransport` 全部为
`http`；缺 commit、无当前 commit 日志、或任一日志为 direct/inproc/空值都会阻塞 full-http。该 gate 用来防止
“有样本覆盖但仍混入 MAP 直连路径”的误放行。
`dropped_parameter_runtime_evidence` gate 只统计当前 `GIT_COMMIT` 的 LLM 请求日志：缺 commit 或无当前 commit
日志时保持 waiting；当前 commit 任一日志出现 `DroppedParameters` 时阻塞 full-http。`/gw/logs` 支持
`releaseCommit` 过滤，便于从 gate 直接回查被丢弃的参数。参数丢弃要么通过严格模式拒绝或换支持模型，
要么补 provider adapter 支持；不能用旧日志或默认丢弃行为放行生产切换。
`appcaller_runtime_coverage` gate 按 active appCaller 逐个验证当前 commit 覆盖：同一 `GIT_COMMIT` 的
LLM 请求日志或 shadow comparison 任一出现该 `appCallerCode` 即算覆盖；缺 commit、没有 active appCaller、
或任一 active appCaller 没有当前 commit 样本时保持 waiting。该 gate 用来替代“总样本数足够”的粗口径，
确保全量切换前每个受治理调用方都至少跑过一次。
`/gw/v1/resolve` 和 `gw-smoke` route matrix 只证明 auto/pool/pinned 进入 GW router，并会更新 appCaller
governance 观察字段；它不发送上游模型，也不写 LLM 请求日志，因此不能替代 `appcaller_runtime_coverage`、
`current_commit_http_transport` 或 `dropped_parameter_runtime_evidence` 所需的真实 send/stream/raw 日志或
shadow comparison 样本。

验收：

| 断言 | 说明 |
|---|---|
| `activeAppCallerMapFallbackReady=true` | active appCaller 均已绑定有效 GW 池 |
| `mapFallbackObjectsRemaining=0` | MAP-only 池、平台、模型、Exchange 已被 GW 接管或明确清理 |
| `llmgw-config-authority-apply.py --execute --require-ready` 有证据文件 | 配置退场动作可审计、可复跑、不可默认误写 |
| `llmgw-config-authority-backup.sh` 有非 dry-run 备份证据 | 配置退场写库前可恢复，备份归档有 SHA256 校验 |
| `config-authority` 阶段成功入 rollout ledger | 配置退场不再靠手工命令记忆，`http-full` 前置可审计 |
| `http-full` release gate 包含 `configAuthority.ok=true` | 全量 HTTP 切换前配置权威证据可复核 |
| `http-full` release gate 包含 `runtimeGates.ok=true` | 全量 HTTP 切换后控制台 runtime gates 已 readyForHttpFull |
| `runtimeGates.releaseCommit` 等于发布 commit | full-http 不能用其他 commit 的控制台 runtime gate 证据放行 |
| `/gw/runtime-gates readyForHttpFull=false/true` 可解释 | 控制台第一屏能直接说明 full-http 发布 gate 通过、阻塞、等待或保留项；config-authority 与 full-http 台账必须是同 commit |
| `shadow_runtime_evidence` 只看当前 commit | shadow/http 等价证据不能来自旧 releaseCommit |
| `gateway_key_integrity` 通过 | GW 主密钥、平台和 Exchange key 满足 full-http 运行要求 |
| `appcaller_policy_drift=0` | active/configured appCaller 的路由和参数策略配置与最近请求意图一致 |
| `gateway_pool_member_readiness` 通过 | active appCaller 绑定的 GW 池均至少有一个可解析、非 unavailable 成员 |
| `current_commit_http_transport` 通过 | 当前 commit 的 LLM 请求日志均为 `GatewayTransport=http` |
| `dropped_parameter_runtime_evidence` 通过 | 当前 commit 的 LLM 请求日志无 DroppedParameters |
| `appcaller_runtime_coverage` 通过 | 每个 active appCaller 在当前 commit 的日志或 shadow comparison 中至少出现一次 |
| 开启退场门后 active appCaller 不走 MAP fallback | resolver 对 MAP 池、MAP platform/exchange、legacy config fail closed |
| `gw-smoke` 可选 route matrix 通过 | `GW_SMOKE_ROUTE_MATRIX=1` 或生产 workflow `route_matrix=true` 时用 `/gw/v1/resolve` 验证 auto/pool/pinned 进入 GW router；pool/pinned 需显式提供池 ID 或 pinned platform/model，rollout ledger 记录 `smokeRouteMatrixRequired=true` 后会拒绝 skipped 或缺失行；该证据不计入 appCaller runtime coverage |
| MAP 业务流程仍能跑通 | chat、stream、image、vision、video、ASR |
| GW 控制台能解释每次路由 | requested model、actual model、pool、provider、fallback、dropped parameters |
| MAP 无新增直连或模型池写入 | ratchet baseline 保持空 |

## 9. 观测与控制台要求

GW 控制台必须能回答四个问题：

| 问题 | 页面能力 |
|---|---|
| 谁在调用 | appCaller registry、sourceSystem、title、requestType |
| 为什么选这个模型 | router metadata、pool、policy、fallback chain |
| 上游发生了什么 | upstream attempts、status、latency、first byte、tokens、error |
| 参数有没有丢 | requested/supported/dropped parameters、strict failure |

控制台至少需要这些视图：

| 视图 | 说明 |
|---|---|
| Activity | 请求列表、筛选、聚合、transport、状态 |
| Generation detail | 请求/响应片段、tokens、latency、finish reason、thinking、tool calls |
| Router trace | auto/pool/pinned 的决策轨迹 |
| App callers | discovered/configured/active 状态、绑定模型池、预算、限流 |
| Model pools | 池成员、健康、fallback、成本/延迟偏好 |
| Provider attempts | 每次上游尝试、失败原因、重试和 fallback |

## 10. 与 OpenRouter 的对标关系

参考 OpenRouter 是为了借鉴成熟心智，不是复制产品定位。

| OpenRouter 能力 | 本系统采用方式 |
|---|---|
| 统一 API 访问多模型 | GW 提供多入口协议，但内部统一 IR |
| 可不指定模型而使用默认模型 | `auto` 模式按 appCaller 的 GW 默认池路由 |
| model fallback | GW 模型池有序兜底链 |
| provider routing | GW provider preference 和健康/成本/延迟策略 |
| require parameters | `strict-require` 参数策略；已覆盖 function_calling、parallel_tool_calls、vision、image_generation、thinking、structured_output/json_schema、logprobs/top_logprobs 能力门、第一批 `parameter:<name>` 字段级矩阵和 droppedParameters 拒绝门 |
| router metadata | GW router trace、actual model、pool、provider attempts |
| app attribution | `appCallerCode`、sourceSystem、title、owner |

官方参考：

| 主题 | URL |
|---|---|
| Quickstart | https://openrouter.ai/docs/quickstart |
| API Reference | https://openrouter.ai/docs/api/reference/overview |
| Model Fallbacks | https://openrouter.ai/docs/guides/routing/model-fallbacks |
| Provider Routing | https://openrouter.ai/docs/guides/routing/provider-selection |
| Router Metadata | https://openrouter.ai/docs/guides/features/router-metadata |

## 11. 架构图和原型状态

当前 staging 工作区里存在两个架构说明原型，已按本文档目标态改写，不再描述“生产 full-http 当前态”。这两个文件只作为辅助材料，不作为 PR-A 必带产物；若进入仓库，必须单独验收视觉表达和长期维护位置：

| 文件 | 状态 |
|---|---|
| `assets/prototypes/llmgw-architecture-map.html` | 目标架构 HTML，主线为 MAP/外部系统 -> GW ingress adapter -> GW Request IR -> appCaller registry/router/model pools -> provider adapter -> upstream |
| `assets/prototypes/llmgw-architecture-drawing-brief.md` | 目标架构绘制说明，给设计师或架构评审复刻专业长图 |

这两个文件不是新的 SSOT，SSOT 仍是本文档；它们不能替代发布 gate 或生产证据。PR-A 可以只合入本文档和拆分计划，暂缓这两个原型，避免文档 PR 带入未验收视觉资产。

## 12. 风险与约束

| 风险 | 处理方式 |
|---|---|
| 四种入口协议语义不同 | ingress adapter 只负责转 IR，不绕过 router |
| 参数被丢导致用户无感 | `droppedParameters` 必须入日志和详情页 |
| appCaller 拼错污染配置 | discovered/configured/active 状态机，不自动长期激活 |
| pinned 被默认池覆盖 | pinned 作为契约测试重点，失败阻断发布 |
| MAP 仍残留模型池读取 | 退场门已落地但默认关闭；作为迁移债务跟踪，不宣称配置权威已完成 |
| 外部系统直接打 MAP | 新接入文档只公布 GW 入口，不再把 MAP 当统一 AI 网关 |

## 13. 完成标准

达到以下条件后，才能说“LLM Gateway 成为统一 AI 请求治理层”：

| 标准 | 验收 |
|---|---|
| 所有 AI 请求进入 GW | MAP 和外部系统不直接请求上游模型 |
| appCaller 权威在 GW | 新 appCaller 被 GW 被动注册，控制台可配置 |
| 模型池权威在 GW | auto/pool/pinned 都由 GW router 决定 |
| 四类入口可用 | GW Native、OpenAI-compatible、Claude-compatible、Gemini-compatible 走同一 IR |
| 参数策略可解释 | dropped/strict failure 可查 |
| 日志所有权清晰 | MAP 看业务，GW 看路由和上游 |
| 旧配置不再新增 | MAP 侧模型池残留只作为兼容层或迁移工具 |
