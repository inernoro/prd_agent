---
title: Arena SSE 链路无输出问题排查与修复
type: design
status: resolved
issue: "#601"
date: 2026-05-14
author: claude
---

# Arena SSE 链路无输出问题（issue #601）

## 管理摘要

Arena（大模型竞技场）在发起对战后，两个面板均显示"0.9s · 完成"但内容区完全为空。
日志显示 `status=succeeded, firstByteAt=空, Assembled chars=0`，对应 OpenRouter
Generations 页面无该次调用记录。

根因是 `OpenAIClient` 的 SSE 解析器未识别上游 HTTP 200 流中内嵌的错误事件，导致
错误被静默丢弃，最终以"正常完成、零内容"上报。修复仅需在 `LLMJsonContext.cs` 和
`OpenAIClient.cs` 各改约 15 行，已验证编译零错误。

---

## 背景与现象

| 观测字段 | 值 |
|---------|---|
| `status` | `succeeded` |
| `firstByteAt` | 空（null） |
| `Assembled chars` | `0` |
| `model` | `deepseek/deepseek-v4-flash` |
| 耗时 | 约 0.9 秒 |
| OpenRouter Generations 记录 | 无 |

三个初始假设：
1. compute-then-send 违规（二次 Resolve 覆盖模型）
2. server-authority 违规（CancellationToken 传递错误）
3. Arena 专属模型配置指向不可达平台 / 上游拒绝

---

## 排查过程

### 假设 1：compute-then-send 违规

**结论：已排除。**

`ArenaRunWorker.RunOneSlotAsync` 直接使用 `slot.PlatformId` 和 `slot.ModelId`（从
数据库预先读取的已解析值），创建 `OpenAIClient` 时不调用 `IModelResolver.ResolveAsync`。
Arena 完全绕过了 `ILlmGateway`，整条链路中不存在二次 Resolve。

### 假设 2：server-authority 违规

**结论：已排除。**

`ArenaRunWorker` 第 468 行：
```csharp
await foreach (var chunk in client.StreamGenerateAsync("", messages, false, CancellationToken.None))
```
正确使用 `CancellationToken.None`，不受 HTTP 连接断开影响。

`LlmRequestContext.BeginScope` 在第 431-442 行正确设置，包含有效的 `UserId`、
`AppCallerCode` 和 `ModelResolutionType.DirectModel`。

### 假设 3 深入：上游平台错误处理

此处发现真正根因。

OpenRouter 在模型不可用（未订阅、余额不足、模型下线等）时，
**不使用 HTTP 4xx/5xx 状态码**，而是返回 HTTP 200，在 SSE 流体中内嵌错误：

```
HTTP/1.1 200 OK
Content-Type: text/event-stream

data: {"error":{"message":"This model requires credits","code":402},"choices":[],"id":"..."}

data: [DONE]
```

`OpenAIClient.TryParseEvent` 将此数据反序列化为 `OpenAIStreamEvent`。
由于 `OpenAIStreamEvent` **没有 `Error` 字段**，错误信息被静默忽略。
后续检查 `eventData.Choices?.Length > 0` → `false`（空数组）→ 跳过。
事件被完全丢弃，流正常以 `[DONE]` 结束。

最终状态：
- `completed = true` → `status = "succeeded"` （因为 `[DONE]` 正常到达）
- `firstByteMarked = false` → `firstByteAt = null`
- `assembledChars = 0`

**完全匹配全部观测症状。**

---

## 根因定位

### 主要 Bug：`OpenAIStreamEvent` 缺少 `Error` 字段

文件：`src/PrdAgent.Infrastructure/LLM/LLMJsonContext.cs`

```csharp
// 修复前：
internal class OpenAIStreamEvent
{
    public OpenAIChoice[]? Choices { get; set; }
    public OpenAIUsage? Usage { get; set; }
    // 无 Error 字段 → 上游错误被静默丢弃
}
```

### 附带问题：`OpenAIDelta` 缺少 `Reasoning` 字段

OpenRouter 对部分 DeepSeek 推理模型使用 `reasoning` 字段（而非原生的
`reasoning_content`），但 `OpenAIDelta` 只声明了 `ReasoningContent`。
这导致通过 OpenRouter 调用推理模型时，思考过程内容被静默丢弃，
前端无法展示 thinking 内容。

`ILlmGateway` 路径通过 `OpenAIGatewayAdapter.ParseStreamChunk` 的
扁平扫描器（Utf8JsonReader 单遍）已正确处理两种字段名，但 Arena 绕过了
网关，直接使用 `OpenAIClient` 故而受此影响。

### 次要问题：AppCallerCode 裸字符串

`ArenaRunWorker` 第 441 行使用硬编码字符串 `"prd-agent.arena.battle::chat"`
而非 `AppCallerRegistry.Admin.Arena.BattleChat` 常量。此问题不影响当前 bug
的症状，但违反了 `app-caller-registry.md` 规则，会在 CI 守卫测试中报警。
（本次修复未覆盖，留作后续 chore。）

---

## 修复方案

### 改动 1：`LLMJsonContext.cs` — 新增 `OpenAIErrorInfo` 类型并接入 `OpenAIStreamEvent`

```csharp
internal class OpenAIStreamEvent
{
    public OpenAIChoice[]? Choices { get; set; }
    public OpenAIUsage? Usage { get; set; }
    public OpenAIErrorInfo? Error { get; set; }  // 新增
}

internal class OpenAIErrorInfo  // 新增
{
    public string? Message { get; set; }
    public int? Code { get; set; }
}
```

同时在 `OpenAIDelta` 补充 `Reasoning` 字段：

```csharp
internal class OpenAIDelta
{
    public string? Content { get; set; }
    public string? ReasoningContent { get; set; }
    public string? Reasoning { get; set; }  // 新增：OpenRouter 归一化字段
}
```

在 `[JsonSerializable]` 属性中注册 `OpenAIErrorInfo`。

### 改动 2：`OpenAIClient.cs` — SSE 循环中处理内嵌错误与推理字段

在 `eventData.Choices` 检查之前新增错误拦截：

```csharp
if (eventData.Error != null)
{
    var errMsg = eventData.Error.Message ?? "UPSTREAM_ERROR";
    var errCode = eventData.Error.Code?.ToString() ?? "unknown";
    yield return new LLMStreamChunk
    {
        Type = "error",
        ErrorMessage = $"上游错误 [{errCode}]: {errMsg}"
    };
    yield break;
}
```

推理内容提取改为合并两种字段名：

```csharp
var reasoningText = delta?.ReasoningContent ?? delta?.Reasoning;
if (!string.IsNullOrEmpty(reasoningText)) { ... }
```

---

## 改动范围

| 文件 | 行数变化 | 说明 |
|------|---------|------|
| `src/PrdAgent.Infrastructure/LLM/LLMJsonContext.cs` | +17 | 新增 `OpenAIErrorInfo` 类、`Error` 属性、`Reasoning` 字段、`JsonSerializable` 注册 |
| `src/PrdAgent.Infrastructure/LLM/OpenAIClient.cs` | +17 | SSE 循环中内嵌错误检测与双字段推理内容合并 |

**总计约 34 行增减，完全在 50 行阈值内。**

不涉及：Controller、Service、DB 模型、前端代码、配置文件。

---

## 风险评估

| 风险 | 等级 | 说明 |
|------|------|------|
| 误触非 Arena 路径 | 低 | `OpenAIClient` 被 Arena 和 ResilientLLMClient 使用；ResilientLLMClient 消费 `error` chunk 时已有重试逻辑，现在能获得明确错误消息而非空响应，行为更好 |
| `OpenAIErrorInfo.Code` 为 null | 无 | 使用 `int?` + `?? "unknown"` 兜底 |
| 上游错误字段名变化 | 低 | 仅检测 `error.message` / `error.code`，是 OpenRouter/OpenAI 文档中的稳定字段 |
| 推理模型 `reasoning` 字段 | 无 | `ReasoningContent ?? Reasoning` 优先原生字段，不影响非 OpenRouter 路径 |

---

## 验证方式

1. **本地编译**：`dotnet build --no-restore`，零 `error CS*` / `warning CS*`（已验证）
2. **Arena 对战复现**：使用 `deepseek/deepseek-v4-flash` 触发对战，观察是否改为展示错误消息而非空内容
3. **LLM 日志**：`llmrequestlogs` 记录中 `errorMessage` 应含"上游错误 [402]"而非 `null`

---

## 关联

- Issue: #601
- 修复提交: `fix(arena): 修复 Arena SSE 链路无输出问题 (#601)`
- 规则参考: `.claude/rules/llm-gateway.md` § 流式场景关键陷阱
- 正确处理对比: `LlmGateway.cs`（使用 `OpenAIGatewayAdapter.ParseStreamChunk`，扁平扫描器不受 `Choices` 为空影响）
