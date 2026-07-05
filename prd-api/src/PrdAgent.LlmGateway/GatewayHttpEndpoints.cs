using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;

namespace PrdAgent.LlmGatewayHost;

/// <summary>
/// serving 网关的 HTTP 端点装配（SSOT）。
/// 命名空间用 PrdAgent.LlmGatewayHost（非 PrdAgent.LlmGateway）——后者会与
/// PrdAgent.Infrastructure.LlmGateway.LlmGateway 类型的非限定引用在引用方撞车（CS0118）。Program.cs 与集成自测共用同一份端点映射，
/// 避免端点逻辑在测试里复制一份导致漂移。设计见 doc/design.llm-gateway-physical-isolation.md。
/// </summary>
public static class GatewayHttpEndpoints
{
    /// <summary>
    /// 装配 X-Gateway-Key 密钥门 + /gw/v1/* 全部 serving 端点。
    /// </summary>
    /// <param name="app">已 build 的 WebApplication。</param>
    /// <param name="jsonOpts">PascalCase JSON 口径（SSE 手动序列化复用）。</param>
    /// <param name="gatewayApiKey">内部 M2M 共享密钥（X-Gateway-Key）。</param>
    /// <param name="gitCommit">healthz 回显的构建 commit。</param>
    public static void MapGatewayServingEndpoints(
        this WebApplication app,
        JsonSerializerOptions jsonOpts,
        string gatewayApiKey,
        string gitCommit)
    {
        // 共享密钥门（内部 M2M，不走 JWT）：/gw/v1/* 除 healthz 外必须带 X-Gateway-Key。
        app.Use(async (context, next) =>
        {
            var path = context.Request.Path.Value ?? string.Empty;
            if (path.StartsWith("/gw/v1", StringComparison.OrdinalIgnoreCase)
                && !path.StartsWith("/gw/v1/healthz", StringComparison.OrdinalIgnoreCase))
            {
                var provided = context.Request.Headers["X-Gateway-Key"].FirstOrDefault();
                if (!string.Equals(provided, gatewayApiKey, StringComparison.Ordinal))
                {
                    context.Response.StatusCode = StatusCodes.Status401Unauthorized;
                    await context.Response.WriteAsync("unauthorized");
                    return;
                }
            }
            await next();
        });

        app.MapGet("/gw/v1/healthz", () => Results.Content(JsonSerializer.Serialize(new
        {
            status = "ok",
            commit = gitCommit,
            time = DateTime.UtcNow.ToString("o"),
        }, jsonOpts), "application/json"));

        // 预解析模型调度结果（不发送请求）。
        app.MapPost("/gw/v1/resolve", async (
            ResolveRequestDto body,
            PrdAgent.Infrastructure.LlmGateway.ILlmGateway gateway) =>
        {
            var resolution = await gateway.ResolveModelAsync(
                body.AppCallerCode, body.ModelType, body.ExpectedModel, body.PinnedPlatformId, body.PinnedModelId, CancellationToken.None);
            return Results.Json(resolution, jsonOpts);
        });

        // 非流式发送。
        app.MapPost("/gw/v1/send", async (
            GatewayRequest request,
            PrdAgent.Infrastructure.LlmGateway.ILlmGateway gateway,
            ILLMRequestContextAccessor accessor) =>
        {
            using var _ = OpenContextScope(accessor, request.Context, request.ModelType, request.AppCallerCode);
            var response = await gateway.SendAsync(request, CancellationToken.None);
            return Results.Json(response, jsonOpts);
        });

        // 流式发送（SSE）。server-authority：客户端断开不取消网关任务，向网关传 CancellationToken.None，
        // 仅在写失败时静默 break。
        app.MapPost("/gw/v1/stream", async (
            HttpContext http,
            GatewayRequest request,
            PrdAgent.Infrastructure.LlmGateway.ILlmGateway gateway,
            ILLMRequestContextAccessor accessor) =>
        {
            http.Response.Headers.ContentType = "text/event-stream";
            http.Response.Headers.CacheControl = "no-cache";
            http.Response.Headers["X-Accel-Buffering"] = "no";

            using var _ = OpenContextScope(accessor, request.Context, request.ModelType, request.AppCallerCode);
            try
            {
                await foreach (var chunk in gateway.StreamAsync(request, CancellationToken.None))
                {
                    var data = "data: " + JsonSerializer.Serialize(chunk, jsonOpts) + "\n\n";
                    await http.Response.WriteAsync(data);
                    await http.Response.Body.FlushAsync();
                }
            }
            catch (OperationCanceledException)
            {
                // 客户端断开或写中断：静默停止写循环（不向网关传递取消）。
            }
            catch (ObjectDisposedException)
            {
                // 响应已释放：静默停止。
            }
        });

        // 服务端解析后发原始 HTTP（API Key 解析保留在服务端）。
        app.MapPost("/gw/v1/raw", async (
            GatewayRawRequest request,
            PrdAgent.Infrastructure.LlmGateway.ILlmGateway gateway,
            ILLMRequestContextAccessor accessor) =>
        {
            using var _ = OpenContextScope(accessor, request.Context, request.ModelType, request.AppCallerCode);
            var res = await gateway.ResolveModelAsync(
                request.AppCallerCode, request.ModelType, request.ExpectedModel, request.PinnedPlatformId, request.PinnedModelId, CancellationToken.None);
            var raw = await gateway.SendRawWithResolutionAsync(request, res, CancellationToken.None);
            return Results.Json(raw, jsonOpts);
        });

        // 可用模型池列表。
        app.MapGet("/gw/v1/pools", async (
            string appCallerCode,
            string modelType,
            PrdAgent.Infrastructure.LlmGateway.ILlmGateway gateway) =>
        {
            var pools = await gateway.GetAvailablePoolsAsync(appCallerCode, modelType, CancellationToken.None);
            return Results.Json(pools, jsonOpts);
        });

        // ILLMClient 流式生成（SSE）。供 MAP 侧 HttpLlmClient（CreateClient 路径）跨进程调用。
        // MAP 侧把当前 LlmRequestContext 经 body.Context 透传过来，本端点据此开作用域，
        // 让 serving 端日志关联（RequestId/SessionId/GroupId/UserId）与用户归属与 send/stream 端点一致。
        // server-authority：客户端断开不取消网关任务，向网关传 CancellationToken.None，仅写失败时静默 break。
        app.MapPost("/gw/v1/client-stream", async (
            HttpContext http,
            ClientStreamRequestDto body,
            PrdAgent.Infrastructure.LlmGateway.ILlmGateway gateway,
            ILLMRequestContextAccessor accessor) =>
        {
            http.Response.Headers.ContentType = "text/event-stream";
            http.Response.Headers.CacheControl = "no-cache";
            http.Response.Headers["X-Accel-Buffering"] = "no";

            using var _ = OpenContextScope(accessor, body.Context, body.ModelType, body.AppCallerCode);
            var client = gateway.CreateClient(
                body.AppCallerCode,
                body.ModelType,
                body.MaxTokens,
                body.Temperature,
                body.IncludeThinking,
                body.ExpectedModel,
                body.PinnedPlatformId,
                body.PinnedModelId);

            try
            {
                await foreach (var chunk in client.StreamGenerateAsync(body.SystemPrompt, body.Messages, body.EnablePromptCache, CancellationToken.None))
                {
                    var data = "data: " + JsonSerializer.Serialize(chunk, jsonOpts) + "\n\n";
                    await http.Response.WriteAsync(data);
                    await http.Response.Body.FlushAsync();
                }
            }
            catch (OperationCanceledException)
            {
                // 客户端断开或写中断：静默停止写循环（不向网关传递取消）。
            }
            catch (ObjectDisposedException)
            {
                // 响应已释放：静默停止。
            }
        });

        // 影子比对读端点（观测）：X-Gateway-Key 门内，读 llmshadow_comparisons 给汇总 + 最近 N 条。
        // 灰度翻 http 前看「inproc vs http 逐字段一致性」的窗口（去黑盒）。serving 进程与 MAP 共享同一 Mongo，故能读到。
        app.MapGet("/gw/v1/shadow-comparisons", async (
            // [FromServices] 必填：GET 端点不允许「推断 body」参数，MongoDbContext 若被推断为 body，
            // RequestDelegateFactory 在首个请求构建 endpoint matcher 时会抛
            // InvalidOperationException（"Body was inferred but the method does not allow inferred body
            // parameters"），进而拖垮整张路由表（含 healthz / 全部 /gw/v1/*）。见 GatewayKeyGateContractTests。
            [Microsoft.AspNetCore.Mvc.FromServices] MongoDbContext db,
            int? limit,
            string? appCallerCode) =>
        {
            var n = Math.Clamp(limit ?? 50, 1, 500);
            var col = db.LlmShadowComparisons;
            var filter = string.IsNullOrWhiteSpace(appCallerCode)
                ? FilterDefinition<LlmShadowComparison>.Empty
                : Builders<LlmShadowComparison>.Filter.Eq(x => x.AppCallerCode, appCallerCode);

            var total = await col.CountDocumentsAsync(filter);
            var allMatch = await col.CountDocumentsAsync(filter & Builders<LlmShadowComparison>.Filter.Eq(x => x.AllMatch, true));
            var critical = await col.CountDocumentsAsync(filter & Builders<LlmShadowComparison>.Filter.Eq(x => x.HasCritical, true));
            var httpFail = await col.CountDocumentsAsync(filter & Builders<LlmShadowComparison>.Filter.Eq(x => x.HttpOk, false));
            var recent = await col.Find(filter).SortByDescending(x => x.ComparedAt).Limit(n).ToListAsync();

            return Results.Json(new
            {
                summary = new { total, allMatch, critical, httpFail },
                recent,
            }, jsonOpts);
        });
    }

    // 把 GatewayRequestContext 转成 LlmRequestContext 并打开作用域。
    // LlmRequestContext 必填位置参数：RequestId / GroupId / SessionId / UserId / ViewRole /
    //   DocumentChars / DocumentHash / SystemPromptRedacted，随后是可选 RequestType / AppCallerCode。
    private static IDisposable OpenContextScope(
        ILLMRequestContextAccessor accessor,
        GatewayRequestContext? ctx,
        string requestType,
        string appCallerCode)
    {
        return accessor.BeginScope(new LlmRequestContext(
            RequestId: ctx?.RequestId ?? Guid.NewGuid().ToString("N"),
            GroupId: ctx?.GroupId,
            SessionId: ctx?.SessionId,
            UserId: ctx?.UserId,
            ViewRole: ctx?.ViewRole,
            DocumentChars: ctx?.DocumentChars,
            DocumentHash: ctx?.DocumentHash,
            SystemPromptRedacted: null,
            RequestType: requestType,
            AppCallerCode: appCallerCode,
            // S2：MAP 侧 http 模式已把传输标记随 body.Context 过线，透传进作用域，
            // 供 serving 端直连客户端（若有）读取；网关日志由 LlmGateway 直接读 request.Context 标注。
            GatewayTransport: ctx?.GatewayTransport));
    }
}

// /gw/v1/resolve 的请求体 DTO（PascalCase）。
public sealed record ResolveRequestDto(
    string AppCallerCode,
    string ModelType,
    string? ExpectedModel,
    string? PinnedPlatformId,
    string? PinnedModelId);

// /gw/v1/client-stream 的请求体 DTO（PascalCase）。Messages 用 Core 的 LLMMessage，
// 与 MAP 侧 HttpLlmClient 序列化口径一致。
public sealed record ClientStreamRequestDto(
    string AppCallerCode,
    string ModelType,
    int MaxTokens,
    double Temperature,
    bool IncludeThinking,
    string? ExpectedModel,
    string? PinnedPlatformId,
    string? PinnedModelId,
    string SystemPrompt,
    List<PrdAgent.Core.Interfaces.LLMMessage> Messages,
    bool EnablePromptCache,
    GatewayRequestContext? Context = null);
