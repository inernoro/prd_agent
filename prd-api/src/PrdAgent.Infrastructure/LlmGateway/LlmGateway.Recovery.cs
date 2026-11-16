using System.Net.Sockets;
using Microsoft.Extensions.Logging;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.LLM;

namespace PrdAgent.Infrastructure.LlmGateway;

public partial class LlmGateway
{
    private const string OutcomeUnknownErrorCode = "UPSTREAM_OUTCOME_UNKNOWN";
    private const string OutcomeUnknownMessage = "上游可能已执行，结果尚未确认；请核对原请求，勿重复提交";

    private static CancellationTokenSource CreateRequestDeadline(CancellationToken caller, int seconds)
    {
        var deadline = CancellationTokenSource.CreateLinkedTokenSource(caller);
        deadline.CancelAfter(TimeSpan.FromSeconds(seconds > 0 ? seconds : 120));
        return deadline;
    }

    // HTTP 错误不等于生成未执行。仅明确拒绝的状态允许换线路；408/409/5xx
    // 可能由中间代理在付费请求已经提交后产生，缺少供应商幂等证明时必须停止。
    private static bool IsAmbiguousProviderStatus(int code) => code is 408 or 409 || code >= 500;

    private static void ExcludeRateLimitedProvider(List<ModelResolutionResult> candidates, int current, int status)
    {
        if (status != 429) return;
        var platform = candidates[current].ActualPlatformId;
        // 不在同一次恢复中立即重打被限流的供应商；备用供应商有独立配额，可以继续。
        for (var index = candidates.Count - 1; index > current; index--)
            if (string.Equals(candidates[index].ActualPlatformId, platform, StringComparison.OrdinalIgnoreCase))
                candidates.RemoveAt(index);
    }

    private static bool IsConfirmedNotSent(Exception error)
    {
        if (error is not HttpRequestException http) return false;
        if (http.HttpRequestError == HttpRequestError.NameResolutionError) return true;
        return http.HttpRequestError == HttpRequestError.ConnectionError
            && http.InnerException is SocketException { SocketErrorCode: SocketError.ConnectionRefused };
    }

    private static void RecordTransportFailure(List<LlmProviderAttempt> attempts, Exception error,
        int status, long duration, string message)
    {
        var notSent = attempts.Last(a => a.Stage == "send").ReachedProvider == false || IsConfirmedNotSent(error);
        CompleteLastSendAttempt(attempts, status, duration,
            notSent ? message : $"{OutcomeUnknownErrorCode}: {message}");
        var attempt = attempts.Last(a => a.Stage == "send");
        if (notSent) attempt.ReachedProvider = false;
        attempt.Reason = $"{(notSent ? "not_sent" : "outcome_unknown")}; recovery=stop; {message}";
    }

    private static void MarkRecoveryToNextCandidate(List<LlmProviderAttempt> attempts)
    {
        var attempt = attempts.LastOrDefault(a => a.Stage == "send");
        if (attempt is not null)
            attempt.Reason = attempt.Reason?.Replace("recovery=stop", "recovery=next_candidate", StringComparison.Ordinal);
    }

    private async Task RecordRecoveryFailureAsync(ModelResolutionResult resolution, CancellationToken ct)
    {
        if (ct.IsCancellationRequested) return;
        try { await _modelResolver.RecordFailureAsync(resolution, ct); }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            _logger.LogWarning("[LlmGateway] 请求期限已到，健康回写未确认；保留原请求失败证据");
        }
    }

    private Task FinishFailedRecoveryLogAsync(string? logId, ModelResolutionResult? resolution,
        List<LlmProviderAttempt>? attempts, int status, string error, DateTime startedAt,
        string answer = "", string? thinking = null, GatewayTokenUsage? usage = null)
    {
        if (logId is null || _logWriter is null) return Task.CompletedTask;
        try
        {
            var cost = EstimateCost(resolution, usage, countCall: false);
            _logWriter.MarkDone(logId, new LlmLogDone(
                StatusCode: status, ResponseHeaders: null,
                InputTokens: usage?.InputTokens, OutputTokens: usage?.OutputTokens,
                CacheCreationInputTokens: usage?.CacheCreationInputTokens, CacheReadInputTokens: usage?.CacheReadInputTokens,
                TokenUsageSource: usage?.Source ?? "missing", ImageSuccessCount: null,
                AnswerText: answer.Length > 5000 ? answer[..5000] + "...[truncated]" : answer,
                ThinkingText: thinking, AssembledTextChars: answer.Length,
                AssembledTextHash: LlmLogRedactor.Sha256Hex(answer), Status: "failed", EndedAt: DateTime.UtcNow,
                DurationMs: (long)(DateTime.UtcNow - startedAt).TotalMilliseconds,
                FinishReason: error, CostStatus: cost.Status, EstimatedCostUsd: cost.Usd,
                EstimatedCost: cost.Total, EstimatedCostCurrency: cost.Currency,
                ProviderAttempts: attempts,
                Provider: resolution?.ActualPlatformName ?? resolution?.ActualPlatformId,
                Model: resolution?.ActualModel, PlatformId: resolution?.ActualPlatformId,
                PlatformName: resolution?.ActualPlatformName, Protocol: resolution?.Protocol,
                ModelGroupId: resolution?.ModelGroupId, ModelGroupName: resolution?.ModelGroupName));
            _logWriter.MarkError(logId, error, status);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[LlmGateway] 恢复终态审计写入失败 logId={LogId}", logId);
        }
        return Task.CompletedTask;
    }
}
