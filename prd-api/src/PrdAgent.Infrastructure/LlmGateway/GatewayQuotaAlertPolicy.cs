using Microsoft.Extensions.Logging;
using PrdAgent.Infrastructure.ModelPool;

namespace PrdAgent.Infrastructure.LlmGateway;

/// <summary>
/// 跨进程 Gateway 返回 MAP 后的额度告警桥接。
/// serving 端负责识别上游额度错误并返回统一错误码，MAP 端负责把该错误写入管理员通知。
/// </summary>
internal static class GatewayQuotaAlertPolicy
{
    internal const string QuotaErrorCode = "LLM_QUOTA_EXCEEDED";

    internal static bool IsQuotaFailure(string? errorCode, string? errorMessage)
    {
        if (string.Equals(errorCode, QuotaErrorCode, StringComparison.OrdinalIgnoreCase))
            return true;

        var message = (errorMessage ?? string.Empty).ToLowerInvariant();
        return message.Contains("llm_quota_exceeded")
            || message.Contains("key limit exceeded")
            || message.Contains("额度已用尽")
            || message.Contains("额度用尽")
            || (message.Contains("quota") && (message.Contains("exceed") || message.Contains("insufficient")));
    }

    internal static async Task NotifyIfNeededAsync(
        IPoolFailoverNotifier? notifier,
        string? errorCode,
        string? errorMessage,
        string? platformName,
        ILogger logger)
    {
        if (notifier == null || !IsQuotaFailure(errorCode, errorMessage))
            return;

        var message = string.IsNullOrWhiteSpace(errorMessage)
            ? "独立大模型网关报告平台额度已用尽或被限额，请充值或更换 API Key。"
            : errorMessage.Trim();
        if (message.Length > 500)
            message = message[..500] + "…";

        try
        {
            await notifier.NotifyQuotaExceededAsync(
                string.IsNullOrWhiteSpace(platformName) ? "独立 LLM 网关" : platformName,
                message,
                CancellationToken.None);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "[HttpLlmGatewayClient] 独立网关额度告警写入失败（不阻断主流程）");
        }
    }
}
