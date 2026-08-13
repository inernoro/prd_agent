using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Infrastructure.LlmGateway;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// 将视频供应商和网关诊断归一为可操作的用户文案。
/// 原始响应、供应商名称、模型、协议、状态码和链接只允许进入服务端日志。
/// </summary>
internal static partial class VideoGenerationUserError
{
    internal static string FromGateway(GatewayRawResponse response)
    {
        var diagnostic = response.ErrorMessage ?? ExtractErrorMessage(response.Content);
        if (GatewayQuotaAlertPolicy.IsQuotaFailure(response.ErrorCode, diagnostic))
            return GatewayQuotaAlertPolicy.UserReadableQuotaMessage;

        return FromDiagnostic(diagnostic, response.StatusCode);
    }

    internal static string FromDiagnostic(string? diagnostic, int? statusCode = null)
    {
        var text = diagnostic ?? string.Empty;
        if (GatewayQuotaAlertPolicy.IsQuotaFailure(null, text))
            return GatewayQuotaAlertPolicy.UserReadableQuotaMessage;

        var duration = UnsupportedDurationRegex().Match(text);
        if (duration.Success)
        {
            return $"当前模型不支持 {duration.Groups[1].Value} 秒视频，仅支持 {duration.Groups[2].Value.Trim()} 秒。请改用支持的时长后重试。";
        }

        if (statusCode == 408 || ContainsAny(text, "timed out", "timeout", "deadline exceeded"))
            return "视频生成等待超时，请稍后重试。";

        if (statusCode == 429 || ContainsAny(text, "rate limit", "too many requests"))
            return "当前视频生成请求较多，请稍后再试。";

        if (statusCode is 400 or 422)
            return "当前视频模型无法处理这次请求，请检查描述、参考图和视频参数后重试。";

        return ServiceUnavailable();
    }

    internal static string ServiceUnavailable()
        => "当前视频生成服务暂时不可用，请稍后重试。若持续出现，请联系管理员。";

    internal static string DownloadUnavailable()
        => "视频已经生成，但下载服务暂时不可用，请稍后重试。";

    private static string? ExtractErrorMessage(string? body)
    {
        if (string.IsNullOrWhiteSpace(body)) return null;
        try
        {
            var error = JsonNode.Parse(body)?["error"];
            return error is JsonObject errorObject
                ? errorObject["message"]?.GetValue<string>()
                : error?.ToString();
        }
        catch
        {
            return body;
        }
    }

    private static bool ContainsAny(string text, params string[] values)
        => values.Any(value => text.Contains(value, StringComparison.OrdinalIgnoreCase));

    [GeneratedRegex(@"Duration\s+(\d+)s\s+is not supported.*Supported durations:\s*([\d,\s]+)s", RegexOptions.IgnoreCase)]
    private static partial Regex UnsupportedDurationRegex();
}
