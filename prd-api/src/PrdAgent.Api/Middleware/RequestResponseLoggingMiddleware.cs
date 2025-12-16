using System.Text;
using System.Text.Json;

namespace PrdAgent.Api.Middleware;

/// <summary>
/// 请求响应日志中间件 - 以Pretty格式记录所有HTTP请求和响应内容
/// </summary>
public class RequestResponseLoggingMiddleware
{
    private readonly RequestDelegate _next;
    
    private static readonly JsonSerializerOptions PrettyJsonOptions = new()
    {
        WriteIndented = true,
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping
    };

    // 最大记录body长度
    private const int MaxBodyLength = 10000;

    // 不需要记录body的路径
    private static readonly HashSet<string> SkipBodyPaths = new(StringComparer.OrdinalIgnoreCase)
    {
        "/health",
        "/swagger",
        // 安全约束：不记录用户原文/PRD原文。以下路径可能包含大段敏感内容，默认跳过 body。
        "/api/v1/documents",
        "/api/v1/sessions",
        "/api/v1/groups"
    };

    public RequestResponseLoggingMiddleware(RequestDelegate next)
    {
        _next = next;
    }

    public async Task InvokeAsync(HttpContext context)
    {
        var requestId = Guid.NewGuid().ToString("N")[..8];
        
        // 检查是否需要跳过
        var path = context.Request.Path.Value ?? "";
        var shouldSkipBody = SkipBodyPaths.Any(p => path.StartsWith(p, StringComparison.OrdinalIgnoreCase));

        // 记录请求
        var requestBody = shouldSkipBody ? "[SKIPPED]" : await ReadRequestBodyAsync(context.Request);
        LogRequest(context.Request, requestId, requestBody);

        // 包装响应流以捕获响应内容
        var originalBodyStream = context.Response.Body;
        using var responseBodyStream = new MemoryStream();
        context.Response.Body = responseBodyStream;

        var stopwatch = System.Diagnostics.Stopwatch.StartNew();
        
        try
        {
            await _next(context);
        }
        finally
        {
            stopwatch.Stop();
            
            // 读取响应内容
            var responseBody = shouldSkipBody ? "[SKIPPED]" : await ReadResponseBodyAsync(responseBodyStream);
            
            // 记录响应
            LogResponse(context.Response, requestId, stopwatch.ElapsedMilliseconds, responseBody);
            
            // 将响应写回原始流
            responseBodyStream.Seek(0, SeekOrigin.Begin);
            await responseBodyStream.CopyToAsync(originalBodyStream);
        }
    }

    private async Task<string> ReadRequestBodyAsync(HttpRequest request)
    {
        if (request.ContentLength == 0 || request.ContentLength == null)
        {
            return string.Empty;
        }

        request.EnableBuffering();
        
        using var reader = new StreamReader(
            request.Body, 
            Encoding.UTF8, 
            detectEncodingFromByteOrderMarks: false, 
            bufferSize: 1024, 
            leaveOpen: true);
        
        var body = await reader.ReadToEndAsync();
        request.Body.Position = 0;
        
        return body;
    }

    private static async Task<string> ReadResponseBodyAsync(MemoryStream responseBody)
    {
        responseBody.Seek(0, SeekOrigin.Begin);
        var body = await new StreamReader(responseBody).ReadToEndAsync();
        responseBody.Seek(0, SeekOrigin.Begin);
        return body;
    }

    private static void LogRequest(HttpRequest request, string requestId, string body)
    {
        var sb = new StringBuilder();
        sb.AppendLine();
        sb.AppendLine($"\u001b[36m========== API REQUEST [{requestId}] ==========\u001b[0m");
        sb.AppendLine($"  \u001b[33mMethod:\u001b[0m {request.Method}");
        sb.AppendLine($"  \u001b[33mPath:\u001b[0m {request.Path}{request.QueryString}");
        sb.AppendLine($"  \u001b[33mHeaders:\u001b[0m");
        
        foreach (var header in request.Headers)
        {
            // 跳过敏感头部或过长的头部
            var value = header.Key.Equals("Authorization", StringComparison.OrdinalIgnoreCase)
                ? MaskSensitiveValue(header.Value.ToString())
                : header.Value.ToString();
            
            if (value.Length > 200)
            {
                value = value[..200] + "...[TRUNCATED]";
            }
            
            sb.AppendLine($"    {header.Key}: {value}");
        }

        if (!string.IsNullOrEmpty(body) && body != "[SKIPPED]")
        {
            sb.AppendLine($"  \u001b[33mBody:\u001b[0m");
            var prettyBody = TryPrettyPrintJson(body);
            
            if (prettyBody.Length > MaxBodyLength)
            {
                prettyBody = prettyBody[..MaxBodyLength] + "\n    ... [TRUNCATED]";
            }
            
            foreach (var line in prettyBody.Split('\n'))
            {
                sb.AppendLine($"    {line}");
            }
        }
        
        sb.AppendLine($"\u001b[36m==============================================\u001b[0m");

        Console.WriteLine(sb.ToString());
    }

    private static void LogResponse(HttpResponse response, string requestId, long durationMs, string body)
    {
        var sb = new StringBuilder();
        sb.AppendLine();
        
        var statusColor = response.StatusCode >= 400 ? "\u001b[31m" : "\u001b[32m";
        sb.AppendLine($"{statusColor}========== API RESPONSE [{requestId}] ==========\u001b[0m");
        sb.AppendLine($"  \u001b[33mStatus:\u001b[0m {statusColor}{response.StatusCode}\u001b[0m");
        sb.AppendLine($"  \u001b[33mDuration:\u001b[0m {durationMs}ms");
        sb.AppendLine($"  \u001b[33mHeaders:\u001b[0m");
        
        foreach (var header in response.Headers)
        {
            sb.AppendLine($"    {header.Key}: {header.Value}");
        }

        if (!string.IsNullOrEmpty(body) && body != "[SKIPPED]")
        {
            sb.AppendLine($"  \u001b[33mBody:\u001b[0m");
            var prettyBody = TryPrettyPrintJson(body);
            
            if (prettyBody.Length > MaxBodyLength)
            {
                prettyBody = prettyBody[..MaxBodyLength] + "\n    ... [TRUNCATED]";
            }
            
            foreach (var line in prettyBody.Split('\n'))
            {
                sb.AppendLine($"    {line}");
            }
        }
        
        sb.AppendLine($"{statusColor}===============================================\u001b[0m");

        Console.WriteLine(sb.ToString());
    }

    private static string TryPrettyPrintJson(string json)
    {
        if (string.IsNullOrWhiteSpace(json))
        {
            return json;
        }

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
        if (string.IsNullOrEmpty(value) || value.Length <= 12)
        {
            return "***";
        }
        
        return $"{value[..8]}...{value[^4..]}";
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

