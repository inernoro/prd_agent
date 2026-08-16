using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.LlmGateway;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// 将视频供应商和网关诊断归一为可操作的用户文案。
/// 原始响应、供应商名称、模型、协议、状态码和链接只允许进入服务端日志。
/// </summary>
public static partial class VideoGenerationUserError
{
    internal static string FromGateway(GatewayRawResponse response)
    {
        var diagnostic = response.ErrorMessage ?? ExtractErrorMessage(response.Content);
        if (GatewayQuotaAlertPolicy.IsQuotaFailure(response.ErrorCode, diagnostic))
            return GatewayQuotaAlertPolicy.UserReadableQuotaMessage;

        return FromDiagnostic(diagnostic, response.StatusCode);
    }

    public static string FromDiagnostic(string? diagnostic, int? statusCode = null)
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

    /// <summary>
    /// 后台任务写库和事件推送前的最后一道用户文案闸门。
    /// errorCode 是稳定诊断标识；diagnostic 仅用于归类，绝不能原样返回。
    /// </summary>
    public static string ForPersistence(string? errorCode, string? diagnostic)
    {
        var normalizedCode = (errorCode ?? string.Empty).Trim().ToUpperInvariant();
        return normalizedCode switch
        {
            "EMPTY_PROMPT" => "视频描述为空，请返回并输入内容后重试。",
            "EMPTY_ARTICLE" => "创作内容为空，请补充文稿后重试。",
            "MODEL_RESOLVE_FAILED" => "当前没有可用的视频生成模型，请联系管理员检查模型配置后重试。",
            "LLM_FAILED" => "视频脚本生成暂时失败，请稍后重试。",
            "PARSE_FAILED" => "视频脚本格式暂时无法识别，请重新生成脚本后重试。",
            "OPENROUTER_TIMEOUT" => "视频生成等待超时，请稍后重试。",
            "DOWNLOAD_FAILED" => DownloadUnavailable(),
            "EXPORT_FAILED" => ExportUnavailable(diagnostic),
            "SCENE_RENDER_FAILED" => SceneUnavailable(diagnostic),
            _ => FromDiagnostic(diagnostic),
        };
    }

    /// <summary>将历史任务中的原始诊断转为可安全返回的用户文案。</summary>
    public static VideoGenRun SanitizeForResponse(VideoGenRun run)
    {
        run.ErrorMessage = string.IsNullOrWhiteSpace(run.ErrorMessage)
            ? run.ErrorMessage
            : ForPersistence(run.ErrorCode, run.ErrorMessage);
        run.ExportErrorMessage = string.IsNullOrWhiteSpace(run.ExportErrorMessage)
            ? run.ExportErrorMessage
            : ForPersistence("EXPORT_FAILED", run.ExportErrorMessage);
        foreach (var scene in run.Scenes)
        {
            if (!string.IsNullOrWhiteSpace(scene.ErrorMessage))
                scene.ErrorMessage = ForPersistence("SCENE_RENDER_FAILED", scene.ErrorMessage);
        }
        return run;
    }

    /// <summary>净化历史任务事件回放，避免旧的原始诊断绕过当前写入闸门。</summary>
    public static string SanitizeEventPayload(string eventName, string payloadJson)
    {
        if (!eventName.Contains("error", StringComparison.OrdinalIgnoreCase))
            return payloadJson;

        try
        {
            var payload = JsonNode.Parse(payloadJson) as JsonObject;
            if (payload == null) return SafeEventFallback();
            var diagnostic = payload["message"]?.GetValue<string>();
            var code = payload["code"]?.GetValue<string>()
                ?? (eventName.Contains("export", StringComparison.OrdinalIgnoreCase)
                    ? "EXPORT_FAILED"
                    : eventName.Contains("scene", StringComparison.OrdinalIgnoreCase)
                        ? "SCENE_RENDER_FAILED"
                        : "VIDEOGEN_ERROR");
            payload["message"] = ForPersistence(code, diagnostic);
            return payload.ToJsonString();
        }
        catch
        {
            return SafeEventFallback();
        }
    }

    public static string ServiceUnavailable()
        => "当前视频生成服务暂时不可用，请稍后重试。若持续出现，请联系管理员。";

    public static string DownloadUnavailable()
        => "视频已经生成，但下载服务暂时不可用，请稍后重试。";

    private static string ExportUnavailable(string? diagnostic)
    {
        if (ContainsAny(diagnostic ?? string.Empty, "视频轨已静音"))
            return "视频轨已静音，无法导出可播放视频。请恢复视频轨后重试。";
        if (ContainsAny(diagnostic ?? string.Empty, "尚未生成的视频分镜"))
            return "仍有分镜尚未生成，请完成全部分镜后再导出。";
        return "视频导出暂时失败，请稍后重试。若持续出现，请联系管理员。";
    }

    private static string SceneUnavailable(string? diagnostic)
    {
        var text = diagnostic ?? string.Empty;
        if (ContainsAny(text, "生成提交进程已中断"))
            return "生成提交进程已中断。为避免重复扣费，系统没有自动重新提交；请确认后手动重试。";
        if (ContainsAny(text, "LLM 返回为空"))
            return "分镜描述生成结果为空，请重新生成后重试。";
        if (ContainsAny(text, "模型调度失败"))
            return "当前没有可用的视频生成模型，请联系管理员检查模型配置后重试。";
        return FromDiagnostic(text);
    }

    private static string SafeEventFallback()
        => new JsonObject { ["message"] = ServiceUnavailable() }.ToJsonString();

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
