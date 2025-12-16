using System.Text.Json;
using System.Diagnostics;

namespace PrdAgent.Api.Middleware;

/// <summary>
/// 请求响应日志中间件 - 默认只记录“高信噪摘要”：
/// - 请求是否到达（method/path/query）
/// - 响应状态码/耗时
/// - 统一响应格式(ApiResponse)的 success / error.code / 常见分页 itemsCount / total
/// 
/// 说明：
/// - 默认不记录 request/response 原文 body，避免泄露用户内容（安全约束）
/// - 对 SSE(text/event-stream) 自动跳过响应捕获，避免阻塞流式传输
/// </summary>
public class RequestResponseLoggingMiddleware
{
    private readonly RequestDelegate _next;
    private readonly ILogger<RequestResponseLoggingMiddleware> _logger;

    // 只为“摘要提取”读取响应体，避免大响应占用内存
    private const int MaxInspectResponseBytes = 64 * 1024; // 64KB

    // 不记录日志的路径（避免噪音）
    private static readonly HashSet<string> SkipLogPathPrefixes = new(StringComparer.OrdinalIgnoreCase)
    {
        "/health",
        "/swagger"
    };

    public RequestResponseLoggingMiddleware(
        RequestDelegate next,
        ILogger<RequestResponseLoggingMiddleware> logger)
    {
        _next = next;
        _logger = logger;
    }

    public async Task InvokeAsync(HttpContext context)
    {
        // CORS 预检请求非常多，且不携带业务信息，默认不记录，避免“看起来一次操作很多请求”
        if (HttpMethods.IsOptions(context.Request.Method))
        {
            await _next(context);
            return;
        }

        var path = context.Request.Path.Value ?? "";
        if (SkipLogPathPrefixes.Any(p => path.StartsWith(p, StringComparison.OrdinalIgnoreCase)))
        {
            await _next(context);
            return;
        }

        var requestId = Activity.Current?.Id ?? Guid.NewGuid().ToString("N")[..8];
        var method = context.Request.Method;
        var query = context.Request.QueryString.HasValue ? context.Request.QueryString.Value : "";
        var clientIp = context.Connection.RemoteIpAddress?.ToString() ?? "unknown";
        var userId = context.User?.FindFirst("sub")?.Value ?? "anonymous";
        var protocol = context.Request.Protocol;
        var absoluteUrl = BuildAbsoluteUrl(context, path, query);

        var accept = context.Request.Headers.Accept.ToString();
        var isEventStream = accept.Contains("text/event-stream", StringComparison.OrdinalIgnoreCase);

        var sw = Stopwatch.StartNew();

        // SSE 流式响应不能缓存整个 body，否则会阻塞/卡住
        if (isEventStream)
        {
            try
            {
                await _next(context);
            }
            finally
            {
                sw.Stop();
                WriteSummaryLog(
                    context.Response.StatusCode,
                    sw.ElapsedMilliseconds,
                    requestId,
                    method,
                    protocol,
                    absoluteUrl,
                    context.Response.ContentType,
                    clientIp,
                    userId,
                    apiSummary: "stream=text/event-stream",
                    responseBytes: null);
            }
            return;
        }

        // 包装响应流用于“摘要提取”
        var originalBodyStream = context.Response.Body;
        await using var responseBodyStream = new MemoryStream();
        context.Response.Body = responseBodyStream;

        try
        {
            await _next(context);
        }
        finally
        {
            sw.Stop();

            var statusCode = context.Response.StatusCode;
            string? responseBody = null;
            string apiSummary = "";

            try
            {
                if (responseBodyStream.Length > 0 && responseBodyStream.Length <= MaxInspectResponseBytes)
                {
                    responseBodyStream.Seek(0, SeekOrigin.Begin);
                    using var reader = new StreamReader(responseBodyStream, leaveOpen: true);
                    responseBody = await reader.ReadToEndAsync();
                }

                apiSummary = SummarizeApiResponse(responseBody);
            }
            catch
            {
                // 摘要提取失败不影响请求，只输出最小信息
                apiSummary = "";
            }

            WriteSummaryLog(
                statusCode,
                sw.ElapsedMilliseconds,
                requestId,
                method,
                protocol,
                absoluteUrl,
                context.Response.ContentType,
                clientIp,
                userId,
                apiSummary,
                responseBytes: responseBodyStream.Length);

            // 写回原始响应流
            responseBodyStream.Seek(0, SeekOrigin.Begin);
            await responseBodyStream.CopyToAsync(originalBodyStream);
            context.Response.Body = originalBodyStream;
        }
    }

    private void WriteSummaryLog(
        int statusCode,
        long durationMs,
        string requestId,
        string method,
        string protocol,
        string absoluteUrl,
        string? responseContentType,
        string clientIp,
        string userId,
        string? apiSummary,
        long? responseBytes)
    {
        var level = statusCode >= 500
            ? LogLevel.Error
            : statusCode >= 400
                ? LogLevel.Warning
                : LogLevel.Information;

        // 单行输出，尽量贴近 ASP.NET 的 "Request finished ..." 风格，但更聚焦且可控（不打 starting、不打 OPTIONS）
        // 示例：
        // Request finished HTTP/1.1 GET http://localhost:5000/api/v1/config/models?page=1 - 200 null application/json; charset=utf-8 13.4012ms success=true items=20 total=123 rid=abcd ip=127.0.0.1
        // ContentType 只用于展示；可能为空（例如 NoContent/204）
        var contentType = string.IsNullOrWhiteSpace(responseContentType) ? "null" : responseContentType;
        _logger.Log(level,
            "Request finished {Protocol} {Method} {Url} - {StatusCode} null {ContentType} {DurationMs}ms{ApiSummary} rid={RequestId} ip={ClientIp}",
            protocol,
            method,
            absoluteUrl,
            statusCode,
            contentType,
            $"{durationMs:0.####}",
            string.IsNullOrWhiteSpace(apiSummary) ? "" : $" {apiSummary}",
            requestId,
            clientIp);
    }

    private static string BuildAbsoluteUrl(HttpContext context, string path, string? query)
    {
        // 仅用于日志展示：在常见本地联调场景下给出完整 URL
        // 如果 Host/Schema 不可用，退化为 path+query
        try
        {
            var scheme = context.Request.Scheme;
            var host = context.Request.Host.HasValue ? context.Request.Host.Value : "";
            if (string.IsNullOrWhiteSpace(host)) return path + (query ?? "");
            return $"{scheme}://{host}{path}{(query ?? "")}";
        }
        catch
        {
            return path + (query ?? "");
        }
    }

    private static string SummarizeApiResponse(string? responseBody)
    {
        if (string.IsNullOrWhiteSpace(responseBody))
        {
            return "";
        }

        // 仅尝试解析统一响应格式：{ success, data, error }
        // 注意：控制器 JSON 配置使用 camelCase
        try
        {
            var trimmed = responseBody.TrimStart();
            if (!(trimmed.StartsWith("{") || trimmed.StartsWith("[")))
            {
                return "";
            }

            using var doc = JsonDocument.Parse(responseBody);
            if (doc.RootElement.ValueKind != JsonValueKind.Object)
            {
                return "";
            }

            var root = doc.RootElement;
            if (!root.TryGetProperty("success", out var successEl) || successEl.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
            {
                return "";
            }

            var success = successEl.GetBoolean();
            string? errorCode = null;
            if (!success && root.TryGetProperty("error", out var errorEl) && errorEl.ValueKind == JsonValueKind.Object)
            {
                if (errorEl.TryGetProperty("code", out var codeEl) && codeEl.ValueKind == JsonValueKind.String)
                {
                    errorCode = codeEl.GetString();
                }
            }

            int? itemsCount = null;
            int? total = null;

            if (root.TryGetProperty("data", out var dataEl))
            {
                // Paged: data.items + data.total
                if (dataEl.ValueKind == JsonValueKind.Object)
                {
                    if (dataEl.TryGetProperty("items", out var itemsEl) && itemsEl.ValueKind == JsonValueKind.Array)
                    {
                        itemsCount = itemsEl.GetArrayLength();
                    }
                    if (dataEl.TryGetProperty("total", out var totalEl) && totalEl.ValueKind == JsonValueKind.Number && totalEl.TryGetInt32(out var totalVal))
                    {
                        total = totalVal;
                    }
                }
                else if (dataEl.ValueKind == JsonValueKind.Array)
                {
                    itemsCount = dataEl.GetArrayLength();
                }
            }

            var parts = new List<string>
            {
                $"success={success.ToString().ToLowerInvariant()}"
            };
            if (!string.IsNullOrWhiteSpace(errorCode))
            {
                parts.Add($"errorCode={errorCode}");
            }
            if (itemsCount.HasValue)
            {
                parts.Add($"items={itemsCount.Value}");
            }
            if (total.HasValue)
            {
                parts.Add($"total={total.Value}");
            }

            return string.Join(' ', parts);
        }
        catch
        {
            return "";
        }
    }
}

/// <summary>
/// 中间件扩展方法
/// </summary>
public static class RequestResponseLoggingMiddlewareExtensions
{
    public static IApplicationBuilder UseRequestResponseLogging(this IApplicationBuilder builder)
    {
        return builder.UseMiddleware<RequestResponseLoggingMiddleware>();
    }
}

