using PrdAgent.Core.Interfaces;

namespace PrdAgent.Api.Services;

/// <summary>
/// Reclaims one-shot remote sessions from the durable MongoDB cleanup ledger.
/// Multiple API replicas are safe because StopAsync owns a per-session database lease.
/// </summary>
public sealed class InfraAgentSessionCleanupWorker : BackgroundService
{
    private static readonly TimeSpan SweepInterval = TimeSpan.FromSeconds(5);
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly ILogger<InfraAgentSessionCleanupWorker> _logger;

    public InfraAgentSessionCleanupWorker(
        IServiceScopeFactory scopeFactory,
        ILogger<InfraAgentSessionCleanupWorker> logger)
    {
        _scopeFactory = scopeFactory;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(SweepInterval);
        do
        {
            try
            {
                using var scope = _scopeFactory.CreateScope();
                var sessions = scope.ServiceProvider.GetRequiredService<IInfraAgentSessionService>();
                var stoppedCount = await sessions.RecoverPendingStopsAsync(stoppingToken);
                var expiredPrewarmCount = await sessions.RecoverExpiredPrewarmsAsync(stoppingToken);
                if (stoppedCount > 0)
                {
                    _logger.LogInformation(
                        "Recovered {StoppedCount} persisted infra agent session cleanup requests",
                        stoppedCount);
                }
                if (expiredPrewarmCount > 0)
                {
                    _logger.LogInformation(
                        "Recovered {StoppedCount} expired PPT prewarm sessions",
                        expiredPrewarmCount);
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Infra agent persisted cleanup sweep failed");
            }
        }
        while (await timer.WaitForNextTickAsync(stoppingToken));
    }
}
