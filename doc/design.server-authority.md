# 服务器权威性设计 (Server Authority Design)

> **版本**：v1.0 | **创建日期**：2026-03-04

## 1. 问题背景

在 Web 应用中，HTTP 连接（包括 SSE 流）随时可能因为以下原因断开：

- 用户关闭浏览器标签页
- 用户切换路由（SPA 页面跳转）
- 网络中断或不稳定
- 浏览器刷新

ASP.NET Core 默认行为是：当客户端断开时，`HttpContext.RequestAborted`（即 Controller 方法接收到的 `CancellationToken`）会被触发，导致服务端正在执行的操作被取消。

**这对短请求没问题，但对长时间运行的任务是灾难性的**：LLM 已经消耗了 token、数据库写了一半、图片生成到一半——这些不完整的操作浪费资源且留下脏数据。

## 2. 核心设计决策

**服务器端任务一旦启动，只有显式的用户主动取消请求才能中断。客户端被动断开连接不应取消服务器处理。**

### 2.1 主动取消 vs 被动断开

| 类型 | 触发方式 | 服务器行为 |
|------|---------|-----------|
| **主动取消** | 用户点击"取消"按钮 → 调用显式取消 API（如 `POST /runs/{id}/cancel`） | 允许取消任务 |
| **被动断开** | 关闭页面、切换路由、网络中断、浏览器刷新 | **不取消**，继续完成任务并持久化结果 |

### 2.2 设计收益

1. **资源不浪费**：LLM 调用已消耗的 token 不会白费
2. **数据完整性**：数据库操作能完整执行，不留脏数据
3. **断线续传**：用户重新连接后可查看已完成的结果（通过 `afterSeq` 机制）

## 3. 实现模式

### 3.1 SSE 流式响应模式

适用于需要实时推送结果给前端的场景（如 LLM 流式输出）。

**核心要点**：
- 业务逻辑（LLM 调用、数据库操作）使用 `CancellationToken.None`
- SSE 写入操作捕获 `OperationCanceledException` / `ObjectDisposedException`，客户端断开后跳过写入但继续处理
- 用 `clientDisconnected` 标志避免重复的异常捕获开销

**标准实现**：

```csharp
public async Task StreamGenerateAsync(CancellationToken clientCt)
{
    Response.ContentType = "text/event-stream";
    var clientDisconnected = false;
    var fullResponse = new StringBuilder();

    // ✅ LLM 调用使用 CancellationToken.None
    await foreach (var chunk in client.StreamGenerateAsync(
        prompt, messages, false, CancellationToken.None))
    {
        fullResponse.Append(chunk.Content);

        if (!clientDisconnected)
        {
            try
            {
                await Response.WriteAsync($"data: {chunk}\n\n");
                await Response.Body.FlushAsync();
            }
            catch (OperationCanceledException)
            {
                clientDisconnected = true;
                _logger.LogDebug("客户端已断开，继续处理 LLM 响应");
            }
            catch (ObjectDisposedException)
            {
                clientDisconnected = true;
            }
        }
    }

    // ✅ 数据库操作使用 CancellationToken.None
    await _db.SaveAsync(result, CancellationToken.None);
}
```

**反模式**：

```csharp
// ❌ 直接传递客户端 CancellationToken → 客户端关页面就全部取消
await foreach (var chunk in client.StreamGenerateAsync(prompt, messages, false, ct))
{
    await Response.WriteAsync($"data: {chunk}\n\n", ct);
}
await _db.SaveAsync(result, ct);  // 可能不会执行
```

### 3.2 Run/Worker 解耦模式

适用于长时间运行的任务（如图片生成、视频渲染）。

**核心要点**：
- Controller 只负责创建 Run 记录并入队，立即返回 `runId`
- 后台 Worker 从队列消费并执行，完全与 HTTP 连接解耦
- 前端通过 SSE 事件流（支持 `afterSeq` 断线续传）或轮询获取进度

**架构**：

```
[Controller] → 创建 Run + 入队 → 返回 runId
                    ↓
[BackgroundWorker] → 消费队列 → 执行任务 → 持久化结果
                    ↓
[SSE Endpoint] ← 前端 afterSeq 断线续传 ← 查询 IRunEventStore
```

**Worker 中的 CancellationToken 使用**：

```csharp
// Worker 的 stoppingToken 仅用于应用关闭场景
protected override async Task ExecuteAsync(CancellationToken stoppingToken)
{
    while (!stoppingToken.IsCancellationRequested)
    {
        var run = await DequeueAsync(stoppingToken);
        try
        {
            // 核心处理使用 CancellationToken.None
            await ProcessRunAsync(run, CancellationToken.None);
        }
        catch (OperationCanceledException)
        {
            // 应用正在关闭，标记 run 为失败
            await MarkRunFailedSafeAsync(run.Id, "WORKER_STOPPED",
                "服务正在停止", CancellationToken.None);
        }
    }
}
```

### 3.3 SSE Keepalive 心跳

SSE 连接需要定期发送心跳，防止代理服务器或浏览器因超时断开：

```csharp
// 每 10 秒发送 keepalive 注释
if ((DateTime.UtcNow - lastKeepAliveAt).TotalSeconds >= 10)
{
    try
    {
        await Response.WriteAsync(": keepalive\n\n", cancellationToken);
        await Response.Body.FlushAsync(cancellationToken);
    }
    catch { break; }  // 客户端已断开
    lastKeepAliveAt = DateTime.UtcNow;
}
```

## 4. 已实现的场景

| 场景 | 模式 | 关键文件 |
|------|------|---------|
| 对话执行 | Run/Worker | `ChatRunWorker.cs` |
| 图片生成 | Run/Worker | `ImageGenRunWorker.cs` |
| 视频生成 | Run/Worker | `VideoGenRunWorker.cs` |
| 工作流 DAG 执行 | Run/Worker | `WorkflowRunWorker.cs` |
| 文学创作标记生成 | SSE 流式 | `ImageMasterController.cs` → `GenerateArticleMarkers` |
| 文学创作生图事件 | SSE 流式 | `LiteraryAgentImageGenController.cs` → `StreamRun` |
| 工作流执行事件 | SSE 流式 | `WorkflowAgentController.cs` → `StreamExecution` |
| 延时控制舱 | Worker 内部 | `CapsuleExecutor.cs` → `ExecuteDelayAsync` |

## 5. 检查清单

新增 SSE 端点或后台任务时，逐项检查：

- [ ] LLM 调用是否使用 `CancellationToken.None`？
- [ ] 数据库写操作是否使用 `CancellationToken.None`？
- [ ] SSE 写入是否捕获 `OperationCanceledException` + `ObjectDisposedException`？
- [ ] 是否有 `clientDisconnected` 标志避免重复捕获？
- [ ] SSE 流是否有 10 秒 keepalive 心跳？
- [ ] 是否支持 `afterSeq` 断线续传？
- [ ] 长任务是否通过 Run/Worker 与 HTTP 连接解耦？
- [ ] Worker 应用关闭时是否将 run 标记为失败？
