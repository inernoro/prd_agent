# LLM Gateway 职责边界与调用 · 规则

> **版本**：v2.0 | **日期**：2026-08-12 | **状态**：已落地

**一句话**：所有大模型调用走统一入口，但 LLMGW 只在授权池内调度，跨池代选默认禁止，局部上游故障不得扩散成 MAP 整体不可用。
**谁该读**：写大模型调用代码、配置 AppCaller 或处理模型故障的人。
**读完能做什么**：判断模型选择、调度、熔断、恢复和业务提示分别由谁负责，并按清单发起合规调用。

---

所有大模型调用必须通过统一网关，禁止业务代码直接调用底层模型客户端。统一入口不改变职责边界：MAP 负责业务选择，LLMGW 负责获准模型池内的执行。

## 一、职责单一硬规则

1. MAP 的用户可选模型来自 AppCallerCode 获准的模型池；池的稳定标识是选择契约，Provider 模型名和 Offering 不是业务选择值。
2. LLMGW 可以在用户所选池内更换成员，但不得默认切到另一个模型池。
3. 跨池代选必须由 AppCaller 显式授权，缺失配置等同关闭；目标池必须属于该 AppCaller 的获准集合。
4. 显式选择未知池、越权池或类型不符的池必须直接失败，不得静默落到全局默认或 legacy 配置。
5. 池成员故障只修改该成员的健康状态；不得删除 AppCaller 配置、清空模型目录或关闭 MAP 页面。
6. MAP 负责推荐、排序、风险提示和用户坚持选择；LLMGW 不以健康状态替 MAP 做业务禁用决定。
7. 自动恢复不得依赖通知中心，也不得默认创建消耗供应商额度的合成探测请求。
8. 所有池不可用时，目录、错误详情、通知、隔离、恢复和回滚入口仍须可用。
9. 隔离、进入半开、跨池授权、默认池切换和回滚必须记录操作者、原因、前后值和关联审计。

## 二、失败与恢复规则

- 连接失败、超时、429 和 5xx 可以影响健康；输入错误、权限拒绝、内容政策拒绝和主动取消不得影响健康。
- 同池重试只在请求可安全重放时执行，并且必须有次数与时间上限。
- Open 成员冷却后进入 HalfOpen，只放行受限的真实业务请求；成功恢复，失败重新 Open 并延长冷却。
- 非幂等请求结果未知时不得自动重放，也不得借跨池代选重复提交。
- 通知中心消费故障和恢复事件，但通知投递失败不能阻断数据面、自愈或人工恢复。
- MAP 可以建议用户换池，但用户坚持时必须把原选择提交给 LLMGW，由严格路由返回成功或结构化失败。

## 三、基础调用规则

### 调用方式

通过 `GatewayRequest` 调用，必填字段：
- `AppCallerCode`：格式 `{app-key}.{feature}::{model-type}`
- `ModelType`：`chat` / `intent` / `vision` / `generation` / `embedding` 等

### 模型解析优先级

1. 用户显式选择且属于 AppCaller 获准集合的模型池；
2. 用户未选择时使用 AppCaller 的默认池；
3. 所选池耗尽时，只有 AppCaller 显式允许跨池代选才读取其候选顺序；
4. 全局默认与传统配置只作迁移兼容，不能越过显式选择或 AppCaller 权限。

### 日志字段

Gateway 自动记录到 `llmrequestlogs`：`RequestPurpose`、`ModelResolutionType`、`ModelGroupId`、`Model`、`StartedAt`、`FirstByteAt`、`EndedAt`、`InputTokens`、`OutputTokens`。

---

## 四、流式场景 5 个关键陷阱

### 陷阱 1：`FirstByteAt` 指标不等于"文本首字"

**误解**：`FirstByteAt - StartedAt` = LLM 生成第一个 token 的时间

**真相**：`FirstByteAt` 记录的是 **`LlmGateway.cs` 的 `sseReader.ReadEventsAsync` yield 出第一条 data 字符串的时间**。这条 data 可能是：
- `role: assistant` 的 header 事件
- SSE keepalive / 空 delta
- Gateway 自己发出的 `Start` chunk（只带路由元数据）

真正的"文本首字"（第一个 `content` 非空的 delta）可能要等几十秒后才到达。

**代码位置**：`prd-api/src/PrdAgent.Infrastructure/LlmGateway/LlmGateway.cs` line 304-310

### 陷阱 2：OpenRouter 默认不流式下发 reasoning

**现象**：
- OpenRouter Generations 页面显示 `latency: 2204ms`、`native_tokens_reasoning: 2756`
- 我们的 Gateway 收到第一个文本 chunk 要 50+ 秒
- 中间 48 秒里，OpenRouter 在本地累积 reasoning token，直到 reasoning 结束才一次性向下游 flush content

**原因**：OpenRouter 默认把 reasoning 当成"内部计算"，不在流里下发。即使你打开了 `IncludeThinking = true`，那只影响 Gateway 是否向服务层 yield thinking chunk，不影响上游是否往下流。

**修复**：请求体里要同时带上新旧两个「返回推理过程」的开关——上游对不同模型、不同时期
认的字段名不一致，只设一个会在部分模型上静默失效。


两个字段都要加，因为 OpenRouter 对不同模型/时期支持的字段名不一致。

同时服务层要显式打开「把思考内容透传给调用方」的开关。**这是两个独立的闸**：
一个让上游愿意吐推理过程，一个让网关愿意往下传，只开一个用户依旧看不到思考。


两个开关缺一不可：
- `include_reasoning: true` → **上游**愿意往下流 reasoning
- `IncludeThinking = true` → **Gateway 内部**把 Thinking chunk 透传给服务层

### 陷阱 3：Reasoning 字段名不统一

不同上游返回 reasoning 时用的 JSON 字段名不一致：

| 上游 | 字段名 | 示例 |
|------|--------|------|
| DeepSeek 原生 / 硅基流动 / Alibaba 原生 | `reasoning_content` | `{"delta":{"reasoning_content":"..."}}` |
| OpenRouter 归一 deepseek-r1 等 | `reasoning` | `{"delta":{"reasoning":"..."}}` |
| 某些模型内嵌 `<think>...</think>` 标签 | 走 `content` 字段 | 由 `ThinkTagStripper` 在 LlmGateway 层剥离 |

**代码要求**：`OpenAIGatewayAdapter.ParseStreamChunk` 必须同时识别 `reasoning_content` 和 `reasoning`。只支持一个会让切换上游的时候丢思考内容。

**代码位置**：`prd-api/src/PrdAgent.Infrastructure/LlmGateway/Adapters/OpenAIGatewayAdapter.cs` line 111-118

### 陷阱 4：Fake Streaming 只能靠 UX 降级

即使加了 `include_reasoning: true`，某些供应商（比如 qwen-plus 走某些 region）仍然是"假流式"——服务端生成接近完成才开始 flush，或者 reasoning 本身就没真正流式。这种情况代码层面无法修复，只能靠 UX 降级：

1. **心跳 SSE 事件分级**（`PrReviewController.StreamLlmWithHeartbeatAsync` 是参考实现）：
   - `0-15s`：`AI 正在思考　Xs`（正常等待）
   - `15-40s`：`上游首字延迟较高（{model}），已等待 Xs，部分推理模型首字需 30~60s`
   - `40s+`：`警告 上游响应异常缓慢，已等待 Xs，如仍无输出建议点击中止重试`
2. **文案里带出 model 名**，让用户明确知道是"这个特定模型慢"不是系统卡死
3. 40s+ 暗示用户可以中止重试

### 陷阱 5：诊断必须 3 个信息源交叉验证

排查空白等待故障时，**任何单一信息源都可能误导**。必须同时看：

1. **LLM 日志页**（`/admin/llm-logs`）
   - 看 `firstByteAt`、`durationMs`、`inputTokens/outputTokens`
   - 但 `firstByteAt` 有陷阱 1 的语义歧义

2. **OpenRouter Generations 页**（如果走 OpenRouter）
   - 看 `latency`、`native_tokens_reasoning`、`generation_time`
   - 这是最接近上游真相的视角

3. **服务层临时 debug 日志**
   - 在 service 里打 `chunk #N @ Xms type=... preview=...`
   - 这是**唯一**能准确测量"Gateway → 业务代码"延迟的手段

参考 PR-review 排查历史：曾经连续三轮都错判根因：
- **第一轮**：看 firstByteAt=5s，以为 LLM 首字快
- **第二轮**：以为 `<think>` 标签被 Stripper 吞掉
- **第三轮**：通过服务层 debug 日志发现 chunk #2 在 52s 才到，再看 OpenRouter 面板发现 `latency=2.2s / reasoning=2756 tokens`，才定位到是 OpenRouter 未转发 reasoning 的问题

教训：指标名称听起来像 X，实际测的是 Y。**遇到"日志正常但用户体验异常"的矛盾，第一反应应该是"指标测的和用户感知的是不是同一回事"**。

---

## 五、核心文件索引

| 文件 | 用途 |
|------|------|
| `ILlmGateway.cs` | Gateway 接口 |
| `LlmGateway.cs` | 主实现，包含 ModelResolver 路由、ThinkTagStripper、日志记录 |
| `GatewayRequest.cs` | 请求对象，含 `IncludeThinking` 等控制字段 |
| `GatewayResponse.cs` | 响应 chunk 定义（`Start`/`Thinking`/`Text`/`Done`/`Error`） |
| `Adapters/OpenAIGatewayAdapter.cs` | OpenAI 兼容协议解析（兼容 `reasoning` 和 `reasoning_content`） |
| `Adapters/ClaudeGatewayAdapter.cs` | Anthropic 原生协议解析 |

## 六、新增 LLM 调用前的 Checklist

- [ ] 用 `ILlmGateway`，**不**直接调底层 LLM 客户端
- [ ] `AppCallerCode` 遵循 `{app-key}.{feature}::{model-type}` 格式
- [ ] 用户选择值来自该 AppCaller 的获准模型池，不是 Provider 模型名
- [ ] 跨池代选缺省关闭；如开启，候选范围、原因、失效时间和审计已明确
- [ ] 未知池、越权池、池耗尽和网关不可用分别返回结构化错误
- [ ] 健康反馈只统计受认可的上游执行失败
- [ ] 没有新增默认付费探活或无限重试
- [ ] 如果可能走推理模型，`IncludeThinking = true`
- [ ] 如果走 OpenRouter，`RequestBody["include_reasoning"] = true` + `RequestBody["reasoning"] = {"exclude": false}`
- [ ] 服务层用 `IAsyncEnumerable<LlmStreamDelta>` 或类似结构区分 Thinking / Text
- [ ] Controller 层推送 SSE `thinking` / `typing` / `phase` / `model` / `result` 事件
- [ ] 前端订阅 `thinking` 事件并在 ThinkingBlock 组件中渲染
- [ ] 前端订阅 `model` 事件并在面板顶部显示 model 名（`rule.platform.ai-model-visibility`）
- [ ] 心跳事件分级文案（参考 `PrReviewController.StreamLlmWithHeartbeatAsync`）
- [ ] 调试时**同时**看 LLM 日志页、OpenRouter Generations 页、服务层临时 debug 日志
