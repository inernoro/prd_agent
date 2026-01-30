using System.Diagnostics;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using PrdAgent.Core.Models;

namespace PrdAgent.Infrastructure.LLM;

/// <summary>
/// HTTP日志处理程序 - 以Pretty格式记录所有HTTP请求和响应
/// </summary>
public class HttpLoggingHandler : DelegatingHandler
{
    private readonly ILogger<HttpLoggingHandler> _logger;
    private static readonly JsonSerializerOptions PrettyJsonOptions = new()
    {
        WriteIndented = true
    };

    // 敏感头部列表，需要脱敏
    private static readonly HashSet<string> SensitiveHeaders = new(StringComparer.OrdinalIgnoreCase)
    {
        "Authorization",
        "x-api-key",
        "api-key"
    };

    // 最大记录body长度（使用系统配置，默认 50k）
    private static readonly int MaxBodyLength = LlmLogLimits.DefaultHttpLogBodyMaxChars;
    
    // 避免把大文件/二进制读入内存并输出到控制台（尤其是 multipart 上传、COS/图片等）
    private const long MaxBodyBytesToInspect = 256 * 1024; // 256KB

    public HttpLoggingHandler(ILogger<HttpLoggingHandler> logger)
    {
        _logger = logger;
    }

    private static bool IsTextLikeContentType(string? mediaType)
    {
        if (string.IsNullOrWhiteSpace(mediaType)) return false;
        var mt = mediaType.Trim().ToLowerInvariant();
        if (mt.StartsWith("text/")) return true;
        if (mt == "application/json" || mt.EndsWith("+json")) return true;
        if (mt == "application/x-www-form-urlencoded") return true;
        if (mt == "application/xml" || mt.EndsWith("+xml")) return true;
        return false;
    }

    private static bool IsBinaryLikeContentType(string? mediaType)
    {
        if (string.IsNullOrWhiteSpace(mediaType)) return false;
        var mt = mediaType.Trim().ToLowerInvariant();
        if (mt.StartsWith("multipart/")) return true;
        if (mt == "application/octet-stream") return true;
        if (mt.StartsWith("image/") || mt.StartsWith("audio/") || mt.StartsWith("video/")) return true;
        if (mt is "application/zip" or "application/x-zip-compressed" or "application/gzip" or "application/x-gzip" or "application/pdf")
        {
            return true;
        }
        return false;
    }

    protected override async Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request, 
        CancellationToken cancellationToken)
    {
        // 防护：检测非 HTTP(S) 请求，提前报错（避免 'file' scheme not supported 等模糊错误）
        var requestUri = request.RequestUri;
        if (requestUri != null && requestUri.IsAbsoluteUri &&
            requestUri.Scheme != Uri.UriSchemeHttp && requestUri.Scheme != Uri.UriSchemeHttps)
        {
            var errorMsg = $"不支持的请求协议 '{requestUri.Scheme}'（必须是 http 或 https）: {requestUri}";
            _logger.LogError("HTTP 请求失败: {Error}", errorMsg);
            throw new NotSupportedException(errorMsg);
        }

        var requestId = Guid.NewGuid().ToString("N")[..8];
        var stopwatch = Stopwatch.StartNew();

        HttpResponseMessage response;
        try
        {
            response = await base.SendAsync(request, cancellationToken);
        }
        catch (Exception ex)
        {
            stopwatch.Stop();
            var url = request.RequestUri?.ToString() ?? "(null)";
            _logger.LogError(ex, "失败 OUT {Method} {Url} - null {DurationMs}ms", request.Method, url, $"{stopwatch.ElapsedMilliseconds:0.####}");
            throw;
        }

        stopwatch.Stop();

        LogResponseSummary(response, requestId, stopwatch.ElapsedMilliseconds, request);

        return response;
    }

    private void LogResponseSummary(HttpResponseMessage response, string requestId, long durationMs, HttpRequestMessage request)
    {
        var url = request.RequestUri?.ToString() ?? "(null)";
        var level = response.IsSuccessStatusCode ? LogLevel.Information : LogLevel.Warning;
        _logger.Log(level, "完成 OUT {Method} {Url} - {StatusCode} null {DurationMs}ms", request.Method, url, (int)response.StatusCode, $"{durationMs:0.####}");
    }

    private async Task LogRequestAsync(HttpRequestMessage request, string requestId)
    {
        var sb = new StringBuilder();
        sb.AppendLine();
        sb.AppendLine($"========== HTTP REQUEST [{requestId}] ==========");
        sb.AppendLine($"  Method: {request.Method}");
        sb.AppendLine($"  URL: {request.RequestUri}");
        
        // 记录请求头
        sb.AppendLine("  Headers:");
        foreach (var header in request.Headers)
        {
            var value = SensitiveHeaders.Contains(header.Key) 
                ? MaskSensitiveValue(string.Join(", ", header.Value))
                : string.Join(", ", header.Value);
            sb.AppendLine($"    {header.Key}: {value}");
        }

        // 记录Content头
        if (request.Content != null)
        {
            foreach (var header in request.Content.Headers)
            {
                sb.AppendLine($"    {header.Key}: {string.Join(", ", header.Value)}");
            }
        }

        // 记录请求体
        if (request.Content != null)
        {
            var mediaType = request.Content.Headers.ContentType?.MediaType;
            var len = request.Content.Headers.ContentLength;

            var shouldSkip =
                IsBinaryLikeContentType(mediaType) ||
                !IsTextLikeContentType(mediaType) ||
                (len.HasValue && len.Value > MaxBodyBytesToInspect);

            if (shouldSkip)
            {
                sb.AppendLine("  Body: [SKIPPED]");
                sb.AppendLine($"    contentType: {mediaType ?? "unknown"}");
                sb.AppendLine($"    contentLength: {(len.HasValue ? len.Value.ToString() : "unknown")}");
            }
            else
            {
                var body = await request.Content.ReadAsStringAsync();
                if (!string.IsNullOrEmpty(body))
                {
                    sb.AppendLine("  Body:");
                    var prettyBody = TryPrettyPrintJson(body);

                    // 截断过长的body
                    if (prettyBody.Length > MaxBodyLength)
                    {
                        prettyBody = prettyBody[..MaxBodyLength] + "\n    ... [TRUNCATED]";
                    }

                    // 添加缩进
                    foreach (var line in prettyBody.Split('\n'))
                    {
                        sb.AppendLine($"    {line}");
                    }
                }
            }
        }
        
        sb.AppendLine("================================================");

        _logger.LogInformation(sb.ToString());
    }

    private async Task LogResponseAsync(HttpResponseMessage response, string requestId, long durationMs)
    {
        var sb = new StringBuilder();
        sb.AppendLine();
        sb.AppendLine($"========== HTTP RESPONSE [{requestId}] ==========");
        sb.AppendLine($"  Status: {(int)response.StatusCode} {response.StatusCode}");
        sb.AppendLine($"  Duration: {durationMs}ms");
        
        // 记录响应头
        sb.AppendLine("  Headers:");
        foreach (var header in response.Headers)
        {
            sb.AppendLine($"    {header.Key}: {string.Join(", ", header.Value)}");
        }

        // 对于流式响应，不读取内容
        if (response.Content.Headers.ContentType?.MediaType?.Contains("text/event-stream") == true)
        {
            sb.AppendLine("  Body: [SSE Stream - Content logged separately]");
        }
        else if (response.Content != null)
        {
            var mediaType = response.Content.Headers.ContentType?.MediaType;
            var len = response.Content.Headers.ContentLength;

            var shouldSkip =
                IsBinaryLikeContentType(mediaType) ||
                !IsTextLikeContentType(mediaType) ||
                (len.HasValue && len.Value > MaxBodyBytesToInspect);

            if (shouldSkip)
            {
                sb.AppendLine("  Body: [SKIPPED]");
                sb.AppendLine($"    contentType: {mediaType ?? "unknown"}");
                sb.AppendLine($"    contentLength: {(len.HasValue ? len.Value.ToString() : "unknown")}");
            }
            else
            {
                // 记录响应体
                var body = await response.Content.ReadAsStringAsync();
                if (!string.IsNullOrEmpty(body))
                {
                    sb.AppendLine("  Body:");
                    var prettyBody = TryPrettyPrintJson(body);

                    // 截断过长的body
                    if (prettyBody.Length > MaxBodyLength)
                    {
                        prettyBody = prettyBody[..MaxBodyLength] + "\n    ... [TRUNCATED]";
                    }

                    // 添加缩进
                    foreach (var line in prettyBody.Split('\n'))
                    {
                        sb.AppendLine($"    {line}");
                    }
                }
            }
        }
        
        sb.AppendLine("=================================================");

        if (response.IsSuccessStatusCode)
        {
            _logger.LogInformation(sb.ToString());
        }
        else
        {
            _logger.LogWarning(sb.ToString());
        }
    }

    private static string TryPrettyPrintJson(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            return JsonSerializer.Serialize(doc, PrettyJsonOptions);
        }
        catch
        {
            return json;
        }
    }

    private static string MaskSensitiveValue(string value)
    {
        if (string.IsNullOrEmpty(value) || value.Length <= 8)
        {
            return "***";
        }
        
        // 只显示前4位和后4位
        return $"{value[..4]}...{value[^4..]}";
    }
}

