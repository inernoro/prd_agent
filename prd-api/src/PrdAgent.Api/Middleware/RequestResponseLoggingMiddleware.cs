using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Diagnostics;
using System.Text.RegularExpressions;
using PrdAgent.Core.Models;
using PrdAgent.Core.Interfaces;
using PrdAgent.Infrastructure.Database;

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
    private readonly MongoDbContext _db;
    private readonly ICacheManager _cache;

    // 只为“摘要提取”读取响应体，避免大响应占用内存
    private const int MaxInspectResponseBytes = 64 * 1024; // 64KB
    private const int MaxInspectRequestBytes = 256 * 1024; // 256KB（用于系统日志 request body）

    // 不记录日志的路径（避免噪音）
    private static readonly HashSet<string> SkipLogPathPrefixes = new(StringComparer.OrdinalIgnoreCase)
    {
        "/health",
        "/swagger"
    };

    public RequestResponseLoggingMiddleware(
        RequestDelegate next,
        ILogger<RequestResponseLoggingMiddleware> logger,
        MongoDbContext db,
        ICacheManager cache)
    {
        _next = next;
        _logger = logger;
        _db = db;
        _cache = cache;
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
        var startedAt = DateTime.UtcNow;

        // 仅记录用户侧请求（避免把后台自检/查询也塞进“系统日志”）
        var shouldPersistApiLog = path.StartsWith("/api/v1/", StringComparison.OrdinalIgnoreCase)
                                  && !path.StartsWith("/api/v1/admin/", StringComparison.OrdinalIgnoreCase);
        // heartbeat 属于系统噪音：不落 Mongo（但会更新 Redis presence）
        if (path.StartsWith("/api/v1/desktop/presence/heartbeat", StringComparison.OrdinalIgnoreCase))
        {
            shouldPersistApiLog = false;
        }

        var requestBodyCapture = await TryCaptureRequestBodyAsync(context);

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
                if (shouldPersistApiLog)
                {
                    await TryPersistApiRequestLogAsync(
                        context,
                        requestId,
                        startedAt,
                        endedAt: DateTime.UtcNow,
                        durationMs: sw.ElapsedMilliseconds,
                        isEventStream: true,
                        apiSummary: "stream=text/event-stream",
                        requestBodyCapture: requestBodyCapture);
                }

                await TryUpdateDesktopPresenceAsync(context, requestId, sw.ElapsedMilliseconds);
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

            if (shouldPersistApiLog)
            {
                await TryPersistApiRequestLogAsync(
                    context,
                    requestId,
                    startedAt,
                    endedAt: DateTime.UtcNow,
                    durationMs: sw.ElapsedMilliseconds,
                    isEventStream: false,
                    apiSummary: apiSummary,
                    requestBodyCapture: requestBodyCapture);
            }

            await TryUpdateDesktopPresenceAsync(context, requestId, sw.ElapsedMilliseconds);

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

        // 单行输出（控制台更清爽）
        // 示例：
        // 完成 GET http://localhost:5000/api/v1/config/models?page=1 - 200 null 3ms
        _logger.Log(level,
            "完成 {Method} {Url} - {StatusCode} null {DurationMs}ms",
            method,
            absoluteUrl,
            statusCode,
            $"{durationMs:0.####}");
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

    private sealed class CapturedRequestBody
    {
        public string? ContentType { get; init; }
        public string? RawText { get; init; }
        public string? SanitizedJsonText { get; init; }
        public bool Truncated { get; init; }
        public bool IsJson { get; init; }
    }

    private async Task<CapturedRequestBody?> TryCaptureRequestBodyAsync(HttpContext context)
    {
        // 仅在可能有 body 的方法上尝试捕获
        if (!(HttpMethods.IsPost(context.Request.Method) ||
              HttpMethods.IsPut(context.Request.Method) ||
              HttpMethods.IsPatch(context.Request.Method)))
        {
            return null;
        }

        var ct = context.Request.ContentType ?? "";
        if (string.IsNullOrWhiteSpace(ct)) return null;

        // multipart/二进制不记录（避免泄露文件内容）
        if (ct.Contains("multipart/form-data", StringComparison.OrdinalIgnoreCase) ||
            ct.Contains("application/octet-stream", StringComparison.OrdinalIgnoreCase))
        {
            return new CapturedRequestBody { ContentType = ct, RawText = null, SanitizedJsonText = null, Truncated = false, IsJson = false };
        }

        // 只对 json/text/表单做“文本读取”
        var isJson = ct.Contains("application/json", StringComparison.OrdinalIgnoreCase) ||
                     ct.Contains("+json", StringComparison.OrdinalIgnoreCase);
        var isText = ct.StartsWith("text/", StringComparison.OrdinalIgnoreCase) ||
                     ct.Contains("application/x-www-form-urlencoded", StringComparison.OrdinalIgnoreCase);

        if (!isJson && !isText) return null;

        try
        {
            context.Request.EnableBuffering();
            context.Request.Body.Seek(0, SeekOrigin.Begin);

            await using var ms = new MemoryStream();
            var buffer = new byte[16 * 1024];
            var total = 0;
            int read;
            while ((read = await context.Request.Body.ReadAsync(buffer.AsMemory(0, buffer.Length))) > 0)
            {
                var toWrite = read;
                if (total + toWrite > MaxInspectRequestBytes)
                {
                    toWrite = Math.Max(0, MaxInspectRequestBytes - total);
                }

                if (toWrite > 0)
                {
                    await ms.WriteAsync(buffer.AsMemory(0, toWrite));
                    total += toWrite;
                }

                if (total >= MaxInspectRequestBytes) break;
            }

            var truncated = context.Request.ContentLength.HasValue && context.Request.ContentLength.Value > MaxInspectRequestBytes;
            var rawText = Encoding.UTF8.GetString(ms.ToArray());

            // 恢复 position 让后续 controller 能正常读 body
            context.Request.Body.Seek(0, SeekOrigin.Begin);

            if (!isJson)
            {
                return new CapturedRequestBody { ContentType = ct, RawText = rawText, SanitizedJsonText = null, Truncated = truncated, IsJson = false };
            }

            var sanitized = TrySanitizePromptJson(rawText);
            return new CapturedRequestBody
            {
                ContentType = ct,
                RawText = rawText,
                SanitizedJsonText = sanitized,
                Truncated = truncated,
                IsJson = true
            };
        }
        catch
        {
            try { context.Request.Body.Seek(0, SeekOrigin.Begin); } catch { /* ignore */ }
            return null;
        }
    }

    private static string? TrySanitizePromptJson(string rawJson)
    {
        var raw = (rawJson ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(raw)) return null;

        try
        {
            var node = JsonNode.Parse(raw);
            if (node == null) return null;

            SanitizeNode(node);
            return node.ToJsonString(new JsonSerializerOptions { WriteIndented = false });
        }
        catch
        {
            return null;
        }

        static void SanitizeNode(JsonNode n)
        {
            if (n is JsonObject obj)
            {
                foreach (var key in obj.Select(kv => kv.Key).ToArray())
                {
                    var v = obj[key];
                    if (IsPromptKey(key))
                    {
                        // 保留结构但移除内容
                        obj[key] = "<omitted>";
                        continue;
                    }
                    if (v != null) SanitizeNode(v);
                }
            }
            else if (n is JsonArray arr)
            {
                foreach (var it in arr)
                {
                    if (it != null) SanitizeNode(it);
                }
            }
        }

        static bool IsPromptKey(string key)
        {
            var k = (key ?? string.Empty).Trim();
            if (k.Length == 0) return false;
            // 常见提示词字段：prompt/messages/systemPrompt 等
            return k.Equals("prompt", StringComparison.OrdinalIgnoreCase) ||
                   k.Equals("messages", StringComparison.OrdinalIgnoreCase) ||
                   k.Equals("systemPrompt", StringComparison.OrdinalIgnoreCase) ||
                   k.Equals("system_prompt", StringComparison.OrdinalIgnoreCase) ||
                   k.Equals("promptText", StringComparison.OrdinalIgnoreCase);
        }
    }

    private async Task TryPersistApiRequestLogAsync(
        HttpContext context,
        string requestId,
        DateTime startedAt,
        DateTime endedAt,
        long durationMs,
        bool isEventStream,
        string? apiSummary,
        CapturedRequestBody? requestBodyCapture)
    {
        try
        {
            var path = context.Request.Path.Value ?? "";
            var query = context.Request.QueryString.HasValue ? context.Request.QueryString.Value : "";
            var method = context.Request.Method;
            var protocol = context.Request.Protocol;
            var absoluteUrl = BuildAbsoluteUrl(context, path, query);
            var clientIp = context.Connection.RemoteIpAddress?.ToString() ?? "unknown";
            var userId = context.User?.FindFirst("sub")?.Value ?? "anonymous";
            var ua = context.Request.Headers.UserAgent.ToString();

            var clientType = context.Request.Headers["X-Client"].ToString();
            if (string.IsNullOrWhiteSpace(clientType)) clientType = "unknown";
            var clientId = context.Request.Headers["X-Client-Id"].ToString();
            if (string.IsNullOrWhiteSpace(clientId)) clientId = null;

            var routeSessionId = context.Request.RouteValues.TryGetValue("sessionId", out var sid) ? sid?.ToString() : null;
            var routeGroupId = context.Request.RouteValues.TryGetValue("groupId", out var gid) ? gid?.ToString() : null;

            var requestContentType = context.Request.ContentType;
            var responseContentType = context.Response.ContentType;

            var statusCode = context.Response.StatusCode;
            var errorCode = ExtractErrorCode(apiSummary);

            var requestBody = requestBodyCapture?.SanitizedJsonText ?? requestBodyCapture?.RawText;
            var truncated = requestBodyCapture?.Truncated ?? false;

            var curl = BuildCurl(method, absoluteUrl, requestContentType, requestBody, isEventStream, clientType, clientId);

            var log = new ApiRequestLog
            {
                Id = Guid.NewGuid().ToString("N"),
                RequestId = requestId,
                StartedAt = startedAt,
                EndedAt = endedAt,
                DurationMs = durationMs,
                Method = method,
                Path = path,
                Query = string.IsNullOrWhiteSpace(query) ? null : query,
                AbsoluteUrl = absoluteUrl,
                Protocol = protocol,
                RequestContentType = requestContentType,
                ResponseContentType = responseContentType,
                StatusCode = statusCode,
                ApiSummary = apiSummary,
                ErrorCode = errorCode,
                UserId = userId,
                GroupId = routeGroupId,
                SessionId = routeSessionId,
                ClientIp = clientIp,
                UserAgent = ua,
                ClientType = clientType,
                ClientId = clientId,
                RequestBody = requestBody,
                RequestBodyTruncated = truncated,
                Curl = curl,
                IsEventStream = isEventStream
            };

            await _db.ApiRequestLogs.InsertOneAsync(log);
        }
        catch
        {
            // 系统日志写入失败不影响业务请求
        }
    }

    private static string? ExtractErrorCode(string? apiSummary)
    {
        // apiSummary 形如：success=false errorCode=XXX items=.. total=..
        var raw = (apiSummary ?? "").Trim();
        if (string.IsNullOrWhiteSpace(raw)) return null;
        var m = Regex.Match(raw, @"\berrorCode=([A-Za-z0-9_]+)\b");
        if (!m.Success) return null;
        return m.Groups[1].Value;
    }

    private static string BuildCurl(
        string method,
        string url,
        string? contentType,
        string? body,
        bool isEventStream,
        string clientType,
        string? clientId)
    {
        var sb = new StringBuilder();
        sb.Append("curl");
        sb.Append(" -X ").Append(method.ToUpperInvariant());
        sb.Append(" '").Append(EscapeSingleQuoted(url)).Append("'");

        if (!string.IsNullOrWhiteSpace(clientType) && !clientType.Equals("unknown", StringComparison.OrdinalIgnoreCase))
        {
            sb.Append(" -H 'X-Client: ").Append(EscapeSingleQuoted(clientType)).Append("'");
        }
        if (!string.IsNullOrWhiteSpace(clientId))
        {
            sb.Append(" -H 'X-Client-Id: ").Append(EscapeSingleQuoted(clientId)).Append("'");
        }
        if (isEventStream)
        {
            sb.Append(" -H 'Accept: text/event-stream'");
        }
        if (!string.IsNullOrWhiteSpace(contentType))
        {
            sb.Append(" -H 'Content-Type: ").Append(EscapeSingleQuoted(contentType)).Append("'");
        }
        if (!string.IsNullOrWhiteSpace(body) && !HttpMethods.IsGet(method) && !HttpMethods.IsDelete(method))
        {
            sb.Append(" --data-raw '").Append(EscapeSingleQuoted(body)).Append("'");
        }
        return sb.ToString();
    }

    private static string EscapeSingleQuoted(string s)
    {
        // bash: close ', escape single quote, reopen
        return (s ?? string.Empty).Replace("'", "'\\''");
    }

    private static string PresenceKey(string userId, string clientId) => $"desktop:presence:{userId}:{clientId}";
    private static readonly TimeSpan PresenceTtl = TimeSpan.FromSeconds(90);
    private const int MaxRecentRequests = 50;

    private async Task TryUpdateDesktopPresenceAsync(HttpContext context, string requestId, long durationMs)
    {
        try
        {
            var clientType = (context.Request.Headers["X-Client"].ToString() ?? "").Trim();
            if (!clientType.Equals("desktop", StringComparison.OrdinalIgnoreCase))
            {
                return;
            }

            var userId = context.User?.FindFirst("sub")?.Value ?? "anonymous";
            var clientId = (context.Request.Headers["X-Client-Id"].ToString() ?? "").Trim();
            if (string.IsNullOrWhiteSpace(clientId)) clientId = "unknown";

            var key = PresenceKey(userId, clientId);
            var now = DateTime.UtcNow;

            var entry = await _cache.GetAsync<DesktopPresenceEntry>(key)
                        ?? new DesktopPresenceEntry
                        {
                            UserId = userId,
                            ClientId = clientId,
                            ClientType = "desktop",
                            LastSeenAt = now
                        };

            entry.LastSeenAt = now;
            entry.ClientType = "desktop";

            var path = context.Request.Path.Value ?? "";
            // 心跳不计入最近请求（避免刷屏）
            var isHeartbeat = path.StartsWith("/api/v1/desktop/presence/heartbeat", StringComparison.OrdinalIgnoreCase);

            if (!isHeartbeat)
            {
                var record = new DesktopRequestRecord
                {
                    At = now,
                    RequestId = requestId,
                    Method = context.Request.Method,
                    Path = path,
                    Query = context.Request.QueryString.HasValue ? context.Request.QueryString.Value : null,
                    StatusCode = context.Response.StatusCode,
                    DurationMs = durationMs
                };

                entry.LastRequest = record;
                entry.RecentRequests.Insert(0, record);
                if (entry.RecentRequests.Count > MaxRecentRequests)
                {
                    entry.RecentRequests = entry.RecentRequests.Take(MaxRecentRequests).ToList();
                }
            }

            await _cache.SetAsync(key, entry, PresenceTtl);
        }
        catch
        {
            // presence 更新失败不影响业务请求
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

