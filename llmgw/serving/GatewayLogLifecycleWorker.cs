using PrdAgent.Infrastructure.LLM;

namespace PrdAgent.LlmGatewayHost;

/// <summary>Host 只调度共享日志收口器；持久化与并发规则由 Infrastructure 复用。</summary>
public sealed class GatewayLogLifecycleWorker(LlmLogLifecycleReconciler reconciler,
    ILogger<GatewayLogLifecycleWorker> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(20));
        do
        {
            try { await reconciler.TickAsync(stoppingToken); }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
            catch (Exception error) { logger.LogError(error, "网关日志租约维护失败，将在下个周期重试"); }
        } while (await timer.WaitForNextTickAsync(stoppingToken));
    }
}
