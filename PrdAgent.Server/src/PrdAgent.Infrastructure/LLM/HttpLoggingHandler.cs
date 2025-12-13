using System.Diagnostics;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging;

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

    // 最大记录body长度（避免日志过大）
    private const int MaxBodyLength = 8000;

    public HttpLoggingHandler(ILogger<HttpLoggingHandler> logger)
    {
        _logger = logger;
    }

    protected override async Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request, 
        CancellationToken cancellationToken)
    {
        var requestId = Guid.NewGuid().ToString("N")[..8];
        var stopwatch = Stopwatch.StartNew();

        // 记录请求
        await LogRequestAsync(request, requestId);

        HttpResponseMessage response;
        try
        {
            response = await base.SendAsync(request, cancellationToken);
        }
        catch (Exception ex)
        {
            stopwatch.Stop();
            _logger.LogError(ex, 
                "\n========== HTTP REQUEST FAILED [{RequestId}] ==========\n" +
                "Duration: {Duration}ms\n" +
                "Error: {ErrorMessage}\n" +
                "=======================================================\n",
                requestId, stopwatch.ElapsedMilliseconds, ex.Message);
            throw;
        }

        stopwatch.Stop();

        // 记录响应
        await LogResponseAsync(response, requestId, stopwatch.ElapsedMilliseconds);

        return response;
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

