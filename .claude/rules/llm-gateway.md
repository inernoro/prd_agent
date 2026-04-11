---
globs: ["prd-api/src/**/*.cs"]
---

# LLM Gateway 统一调用规则

所有大模型调用必须通过 `ILlmGateway`，禁止直接调用底层 LLM 客户端。

## 使用方式

通过 `GatewayRequest` 调用，必填字段：`AppCallerCode`、`ModelType`。

## AppCallerCode 命名规范

格式：`{app-key}.{feature}::{model-type}`

示例：`visual-agent.image.vision::generation`、`prd-agent.chat::chat`

## 模型调度优先级

1. 专属模型池（AppCallerCode 绑定的 ModelGroupIds）
2. 默认模型池（ModelType 对应的 IsDefaultForType 池）
3. 传统配置（IsMain / IsIntent / IsVision / IsImageGen 标记）

## Gateway 核心文件

`ILlmGateway.cs`、`LlmGateway.cs`、`GatewayRequest.cs`、`GatewayResponse.cs`、`Adapters/*.cs`

## 日志字段

Gateway 自动记录到 `llmrequestlogs`：`RequestPurpose`、`ModelResolutionType`、`ModelGroupId`、`Model`

---

## ⚠️ 流式场景关键陷阱

下列坑都是真实线上踩过的，每一条都对应过"几十秒空白等待"级别的故障。
**任何新增的流式 LLM 调用必须逐条对照**。

### 1. `firstByteAt` 指标的语义歧义

`llmrequestlogs.firstByteAt` 记录的是 **Gateway 的 `sseReader.ReadEventsAsync` yield 第一个 data 字符串的时间**，不是"LLM 吐出第一个文本 token 的时间"。

具体差异：
- firstByteAt ≈ 上游 HTTP body 的第一个 SSE 事件时间（可能只是 `role: assistant` 头或 keepalive）
- 真正的"文本首字"可能要等 reasoning 结束后才到达

**排查空白等待时，不要只看 firstByteAt—— 必须加一条服务层 debug 日志，打印前 5 个 chunk 的 type + elapsed + content 前 50 字**。

示例诊断代码（故障时临时加，验证后删）：
```csharp
var chunkIndex = 0;
var startAt = DateTime.UtcNow;
await foreach (var chunk in _gateway.StreamAsync(request, CT.None))
{
    chunkIndex++;
    if (chunkIndex <= 5)
    {
        var elapsed = (DateTime.UtcNow - startAt).TotalMilliseconds;
        _logger.LogInformation(
            "[XxxService] chunk #{Idx} @ {Elapsed:F0}ms type={Type} len={Len} preview={Preview}",
            chunkIndex, elapsed, chunk.Type, chunk.Content?.Length ?? 0,
            (chunk.Content ?? "").Length > 50 ? chunk.Content![..50] : chunk.Content);
    }
    // ... 正常处理 ...
}
```

### 2. OpenRouter Reasoning：必须显式要求流式推送

OpenRouter 默认**不向客户端转发 reasoning 内容**。即使上游模型（qwen-thinking / deepseek-r1 等）实际生成了几千个 reasoning token，OpenRouter 也会把它们留在服务端，等 reasoning 结束后才开始向客户端 flush content。表现为：
- `latency: 2204ms`（OpenRouter 收到上游第一个 byte）
- 我们的 Gateway 收到第一个 Text chunk 要 50+ 秒
- 之间 48 秒是 OpenRouter hold 住 reasoning 的时间

**修复**：在 `RequestBody` 里显式设置两个字段：
```csharp
RequestBody = new JsonObject
{
    ["messages"] = ...,
    ["temperature"] = ...,
    ["include_reasoning"] = true,                               // 旧字段，仍然生效
    ["reasoning"] = new JsonObject { ["exclude"] = false },     // 新字段
},
```

两个都要加，因为 OpenRouter 对不同模型/时期支持的字段名不一致。

同时服务层必须设置：
```csharp
IncludeThinking = true,  // Gateway 决定是否向调用方 yield Thinking chunk
```

这是两个独立的开关：
- `include_reasoning: true` 让**上游**愿意往下流 reasoning
- `IncludeThinking = true` 让**Gateway 内部**把 Thinking chunk 透传给调用方

只设一个不够，必须都设。

### 3. Reasoning 字段名不统一

推理模型通过不同上游返回 reasoning 时字段名不一致：
| 上游 | 字段名 |
|------|--------|
| DeepSeek 原生 / 硅基流动 / Alibaba 原生 | `reasoning_content` |
| OpenRouter 归一 deepseek-r1 | `reasoning` |
| 某些模型内嵌 `<think>...</think>` | 走 `content` 字段，由 LlmGateway 的 `ThinkTagStripper` 剥离 |

`OpenAIGatewayAdapter.ParseStreamChunk` 必须同时识别 `reasoning_content` 和 `reasoning`，否则切换上游会有一边完全看不到思考内容。

### 4. Fake Streaming 的降级体验

即使加了 `include_reasoning: true`，某些上游供应商仍然可能是"假流式"—— 服务端生成接近完成才开始 flush。对这种情况能做的只有 UX 降级：
- 心跳事件文案分级（0-15s / 15-40s / 40s+）
- 文案里带出 model 名，让用户明确知道是"这个特定模型慢"不是系统卡死
- 40s+ 提示用户可以中止重试

实现参考：`PrReviewController.StreamLlmWithHeartbeatAsync`。

### 5. 诊断工具定位

以下 3 个信息源互相校验，缺一个都可能误判根因：

1. **LLM 日志页**（`/admin/llm-logs`）：看 `firstByteAt`、`durationMs`、`inputTokens/outputTokens`——但注意 firstByteAt 的歧义
2. **OpenRouter Generations 页**：看 `latency`、`native_tokens_reasoning`、`generation_time`——这是最接近真相的上游视角
3. **服务层 debug 日志**：临时在 service 里打 `chunk #N @ Xms type=...`——这是**唯一**能准确测量"Gateway → 业务代码"延迟的手段

**禁止仅凭单一信息源下结论**。曾经有一次我连续三轮都错判根因（先以为是 LLM 慢、然后以为是 `<think>` 标签被 Stripper 吞掉、最后才发现是 OpenRouter 不转发 reasoning），就是因为没有同时看这三个源。
