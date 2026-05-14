---
title: Lab 批量测试无输出根因分析
type: design
status: in-review
created: 2026-05-14
issue: "#602"
---

# Lab 批量测试无输出根因分析

## 管理摘要

Model Lab 批量测试（12 个 OpenRouter 模型并发 1 次，意图类型）全部显示"（无输出）"，根因有两层：**首要根因**是 `RunStreamWithClientAsync` 在 `Task.Run` 内部对 Singleton `ILLMRequestContextAccessor` 调用 `BeginScope`，而 `AsyncLocal` 写入在并发 `Task.Run` 子任务之间不互通，导致每个并发任务都能正确获得自己的上下文（这部分实际上是安全的）；**真正致命的根因**是 `cancellationToken`（绑定 `HttpContext.RequestAborted`）被传递给了所有并发子任务及 `WriteWithLockAsync` 的 `writeLock.WaitAsync(ct)`，当 ASP.NET Core 在 SSE 响应开始写出时检测到某种连接事件而触发 RequestAborted，12 个模型的全部流式调用会被同时取消，前端收到 `modelStart` 事件但永远不会收到 `delta` 或 `modelDone`，只能回落到"（无输出）"显示。与 #601 Arena SSE 的问题有相同结构（Task.Run + BeginScope），但 Arena 因为在 BackgroundService 中使用自己的 CancellationToken 而不直接暴露这个 token 问题。修复难度低，改动 < 20 行。

## 与 #601 Arena SSE 的关系

### 相同之处

两者都在 `Task.Run` 并发中调用 `BeginScope`，模式相同：

```
Task.Run(async () => {
    // ...
    using var _ = ctxAccessor.BeginScope(new LlmRequestContext(...));
    await foreach (var chunk in client.StreamGenerateAsync(...)) { ... }
})
```

两者都通过 `OpenAIClient` 或 `ClaudeClient` 发出 LLM 调用，日志写入路径完全相同。

### 不同之处（关键）

| 维度 | Arena (#601) | Model Lab (#602) |
|---|---|---|
| 执行位置 | BackgroundService (`ArenaRunWorker`) | Controller Action (`ModelLabController`) |
| CancellationToken 来源 | `CancellationTokenSource.CreateLinkedTokenSource(stoppingToken)` — 不绑定 HTTP | `HttpContext.RequestAborted` — 绑定 SSE 连接生命周期 |
| 写 SSE | 写到 `IRunEventStore`（独立于 HTTP） | 直接写 `Response.Body`，依赖 HTTP 连接 |
| 主要 bug | 需进一步确认（#601 独立调查） | `cancellationToken` 传给 `writeLock.WaitAsync(ct)` + 所有 LLM 调用 |

Model Lab 有一个独立的致命问题，不依赖 #601 的根因。

## 排查过程

### Step 1：定位 Controller 入口

`POST /api/lab/model/runs/stream`（`ModelLabController.RunStream`，第 195 行）。

该端点直接在 HTTP Controller Action 里运行，参数签名：
```csharp
public async Task RunStream([FromBody] RunStreamRequest request, CancellationToken cancellationToken)
```

`cancellationToken` 由 ASP.NET Core 自动绑定到 `HttpContext.RequestAborted`。

### Step 2：追踪 cancellationToken 传播链

`ModelLabController.cs` 第 236-249 行：

```csharp
tasks.Add(Task.Run(async () =>
{
    await sem.WaitAsync(cancellationToken);   // <-- HTTP token
    try
    {
        await RunOneModelAsync(..., cancellationToken);  // <-- 继续传递
    }
    finally { sem.Release(); }
}, cancellationToken));  // <-- 传给 Task.Run 本身
```

`RunOneModelAsync` 把同一个 `ct` 传给 `RunStreamWithClientAsync`，后者：

1. 第 687 行：`client.StreamGenerateAsync(..., ct)` — LLM 流式调用绑定 HTTP token
2. 第 696 行、714 行、748 行、775 行：`WriteWithLockAsync(writeLock, ..., ct)`
3. 第 811 行：`writeLock.WaitAsync(ct)` — **锁等待绑定 HTTP token**

当 12 个任务并发争 `writeLock`（容量 1 的 SemaphoreSlim），排队中的任务在等待 `writeLock.WaitAsync(ct)` 时，一旦 `ct` 被取消，就会抛出 `OperationCanceledException`，被 `catch (Exception ex)` 捕获，记为 LLM_ERROR，但此时 `ct` 已取消，`WriteWithLockAsync` 内部试图写 SSE 事件也会失败，导致前端收不到任何 `delta` 或 `modelDone`。

### Step 3：分析 SSE 连接生命周期与 RequestAborted 时机

ASP.NET Core Kestrel 在以下情况会触发 `RequestAborted`：

- 客户端关闭连接
- 客户端发送了不带 `Accept: text/event-stream` 的标准 HTTP 请求，Kestrel 判断响应完整后触发
- 某些代理/负载均衡器（如 nginx）在接收完完整 HTTP 响应头后若检测到流式连接问题，会关闭连接

Model Lab 的 SSE 端点没有 `DisableRequestAbortedToken` 保护，在真人提交 12 个模型请求时，SSE 连接建立后，Kestrel 写出第一条 `runStart` 事件，如果此刻 HTTP 层发生任何问题，`cancellationToken` 就会被 signal，所有 12 个并发 Task.Run 任务立即受影响。

### Step 4：确认 writeLock 争用对 Intent 类型的放大效应

Intent 模型的输出通常只有 1-10 个 token（JSON 意图分类结果），响应极快。12 个模型几乎同时完成 LLM 调用，在极短时间内全部争抢 `writeLock` 写 `delta` 和 `modelDone` 事件。争锁时间窗口内，任何 `ct` 取消都会导致全部等待者抛出 `OperationCanceledException`。

### Step 5：与 #601 Arena 对比验证

Arena 在 `ArenaRunWorker.cs` 第 192 行使用：
```csharp
using var cts = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
```

并在 `RunOneSlotAsync` 中传 `cts.Token`，这个 token 不绑定 HTTP 连接，只在后台服务停止时才取消。Arena 的 LLM 调用（第 468 行）使用 `CancellationToken.None`，彻底不受 HTTP 影响。

**结论**：#601 Arena 的问题（如果存在）有不同的根因，不是 HTTP RequestAborted。#602 Model Lab 的问题是独立的。

### Step 6：AsyncLocal 并发分析（排除为次要问题）

`ILLMRequestContextAccessor` 以 `AddSingleton` 注册（`Program.cs` 第 133 行），使用 `AsyncLocal<LlmRequestContext?>` 实现。

在 `Task.Run` 中，每个新 Task 的 `ExecutionContext` 是从父上下文浅拷贝（copy-on-write）而来的。`BeginScope` 在 Task 内调用时，写入只影响该 Task 自己的 `ExecutionContext`，不会影响兄弟任务。因此 12 个并发任务的 `LlmRequestContext` 互相隔离，这部分是正确的。

但存在一个副作用：因为每个 Task 是从 Controller 线程的 `ExecutionContext` 浅拷贝的，若 Controller 线程在 `foreach` 循环中设置过任何全局 `AsyncLocal` 值（本例没有），则子任务会继承该值。本例中，`BeginScope` 发生在每个 Task 内部，上下文是独立的，不是根因。

## 根因定位

**主根因（致命）**：

文件：`/home/user/prd_agent/prd-api/src/PrdAgent.Api/Controllers/Api/ModelLabController.cs`

- 第 239 行：`sem.WaitAsync(cancellationToken)` — HTTP token 传给锁等待
- 第 243 行：`await RunOneModelAsync(..., cancellationToken)` — HTTP token 传给下游所有操作
- 第 687 行：`client.StreamGenerateAsync(..., ct)` — LLM 调用绑定 HTTP token（违反 `server-authority.md` 规则 1）
- 第 811 行：`writeLock.WaitAsync(ct)` — **写锁等待绑定 HTTP token，这是触发级联取消的最短路径**

**次要问题（可靠性隐患）**：

`Task.Run(..., cancellationToken)` 第三个参数也是 HTTP token，意味着在 task 真正开始之前如果 token 取消，task 永远不会执行，而前端已经收到了 `modelStart` 事件（因为 `modelStart` 在 `Task.Run` 内发出），这会产生永久 running 的卡片。

## 修复方案

### 方案：用 CancellationToken.None 替换传递给 LLM 调用和 writeLock 的 token

参照 `server-authority.md` 规则："LLM 调用、数据库写操作必须使用 `CancellationToken.None`，禁止传递 `HttpContext.RequestAborted`"。

对 `RunStreamWithClientAsync` 中：
1. `writeLock.WaitAsync(ct)` → `writeLock.WaitAsync(CancellationToken.None)` — 写 SSE 事件不应被 HTTP 断开取消
2. `client.StreamGenerateAsync(..., ct)` → `client.StreamGenerateAsync(..., CancellationToken.None)` — LLM 调用不应被 HTTP 断开取消
3. `Response.Body.FlushAsync(ct)` 和 `Response.WriteAsync(..., ct)` 保留 ct（SSE 写入如果 HTTP 断了确实没意义，可以 catch 后 skip）

对 `RunStream` 中：
1. `sem.WaitAsync(cancellationToken)` 可以保留 ct（排队等待阶段取消是合理的）
2. `Task.Run(async () => { ... }, cancellationToken)` 的第三个参数改为 `CancellationToken.None`

但要给 `RunStreamWithClientAsync` 里的写操作（`WriteWithLockAsync`、`WriteEventAsync`）包裹 try-catch，当 HTTP 断开时 catch `OperationCanceledException` / `ObjectDisposedException` 并 skip，不让它中断 LLM 流的消费。

### 具体改动

**改动 1**：`ModelLabController.cs` 第 809 行 `WriteWithLockAsync` 内部

```csharp
// 原代码
private async Task WriteWithLockAsync(SemaphoreSlim writeLock, string eventName, object payload, CancellationToken ct)
{
    await writeLock.WaitAsync(ct);      // 绑定了 HTTP token，会级联取消
    try
    {
        await WriteEventAsync(eventName, payload, ct);
    }
    finally
    {
        writeLock.Release();
    }
}

// 修复后
private async Task WriteWithLockAsync(SemaphoreSlim writeLock, string eventName, object payload, CancellationToken ct)
{
    await writeLock.WaitAsync(CancellationToken.None);   // 不被 HTTP 断开取消
    try
    {
        if (ct.IsCancellationRequested) return;          // HTTP 已断，跳过写入
        await WriteEventAsync(eventName, payload, ct);
    }
    catch (OperationCanceledException) { /* HTTP 断开，正常跳过 */ }
    catch (ObjectDisposedException) { /* Response 已释放，正常跳过 */ }
    finally
    {
        writeLock.Release();
    }
}
```

**改动 2**：`ModelLabController.cs` 第 687 行

```csharp
// 原代码
await foreach (var chunk in client.StreamGenerateAsync(systemPrompt, messages, enablePromptCache, ct).WithCancellation(ct))

// 修复后
await foreach (var chunk in client.StreamGenerateAsync(systemPrompt, messages, enablePromptCache, CancellationToken.None))
```

LLM 调用不受 HTTP 取消影响，让结果能落入数据库。

**改动 3**：`ModelLabController.cs` 第 249 行

```csharp
// 原代码
}, cancellationToken));

// 修复后
}, CancellationToken.None));
```

Task.Run 本身不依赖 HTTP token 启动。

## 改动范围估计

- 文件数：1 个（`ModelLabController.cs`）
- 行数：约 15 行改动（`WriteWithLockAsync` 方法体 +8 行，`StreamGenerateAsync` 调用 -1 行，`Task.Run` 第三参数 -1 行）
- 风险：低。改动遵循项目已有的 `server-authority.md` 规则，与 `ChatService`、`ArenaRunWorker` 的处理方式一致。

## 注意事项

1. 修复后 LLM 调用不再被 HTTP 断开取消，意味着用户关闭页面后，后台仍会继续消费 12 个模型的 token。这是正确行为（server-authority 原则），但需要确保 `ModelLabRunItem` 的 `EndedAt` 和 `Success` 字段在 HTTP 断开后仍能正确落库。当前代码的 `UpdateRunItemAsync` 使用 `ct`（被取消的 token）——需要改为 `CancellationToken.None`。

2. 上述注意事项同样适用于 `Arena (#601)`，Arena Worker 已经正确使用了 `CancellationToken.None`，是参考实现。
