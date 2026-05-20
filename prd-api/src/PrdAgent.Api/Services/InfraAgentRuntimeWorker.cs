using PrdAgent.Core.Interfaces;

namespace PrdAgent.Api.Services;

/// <summary>
/// Runs CDS Agent runtime jobs outside HTTP request lifetimes.
/// MAP/CDS stays the control plane; this worker only drains queued adapter runs.
/// </summary>
public sealed class InfraAgentRuntimeWorker : BackgroundService
{
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly IInfraAgentRuntimeJobQueue _queue;
    private readonly ILogger<InfraAgentRuntimeWorker> _logger;

    public InfraAgentRuntimeWorker(
        IServiceScopeFactory scopeFactory,
        IInfraAgentRuntimeJobQueue queue,
        ILogger<InfraAgentRuntimeWorker> logger)
    {
        _scopeFactory = scopeFactory;
        _queue = queue;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await foreach (var job in _queue.DequeueAsync(stoppingToken))
        {
            try
            {
                using var scope = _scopeFactory.CreateScope();
                var sessions = scope.ServiceProvider.GetRequiredService<IInfraAgentSessionService>();
                await sessions.RunRuntimeJobAsync(job.UserId, job.SessionId, job.Content, stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex,
                    "Infra agent runtime job failed session={SessionId} user={UserId}",
                    job.SessionId,
                    job.UserId);
            }
        }
    }
}
