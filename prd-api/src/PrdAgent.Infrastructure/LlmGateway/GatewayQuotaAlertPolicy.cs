using Microsoft.Extensions.Logging;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Infrastructure.ModelPool;

namespace PrdAgent.Infrastructure.LlmGateway;

/// <summary>
/// 跨进程 Gateway 返回 MAP 后的额度告警桥接。
/// serving 端负责识别上游额度错误并返回统一错误码，MAP 端负责把该错误写入管理员通知。
/// </summary>
internal static class GatewayQuotaAlertPolicy
{
    internal const string QuotaErrorCode = GatewayBillingFailure.QuotaExceeded;
    internal static string UserReadableQuotaMessage => GatewayBillingFailure.FromCode(QuotaErrorCode)!.UserMessage;

    internal static bool IsQuotaFailure(string? errorCode, string? errorMessage)
        => GatewayBillingFailure.Classify(null, errorMessage, errorCode) != null;

    internal static async Task NotifyIfNeededAsync(
        IPoolFailoverNotifier? notifier,
        string? errorCode,
        string? errorMessage,
        string? platformName,
        string? modelName,
        ILogger logger,
        IReadOnlyList<GatewayBillingAlert>? alerts = null)
    {
        if (notifier == null) return;
        var failures = new HashSet<GatewayBillingAlert>();
        foreach (var alert in alerts ?? [])
            if (alert != null && GatewayBillingFailure.FromCode(alert.ErrorCode) != null) failures.Add(alert);
        if (GatewayBillingFailure.Classify(null, errorMessage, errorCode) is { } failure)
            failures.Add(new(failure.Code, platformName, modelName));
        foreach (var item in failures)
        {
            try
            {
                if (item.ErrorCode == QuotaErrorCode)
                    await notifier.NotifyQuotaExceededAsync(item.PlatformName, item.ModelName, CancellationToken.None);
                else
                    await notifier.NotifyBillingFailureAsync(item.PlatformName, item.ModelName, item.ErrorCode, CancellationToken.None);
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "[HttpLlmGatewayClient] 上游计费拒绝的站内告警写入失败（不阻断主流程）");
            }
        }
    }
}
