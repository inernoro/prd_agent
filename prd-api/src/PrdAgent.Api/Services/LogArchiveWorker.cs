using PrdAgent.Infrastructure.Services;

namespace PrdAgent.Api.Services;

public sealed class LogArchiveWorker(IServiceScopeFactory scopes, IConfiguration config, ILogger<LogArchiveWorker> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!PrdAgent.Infrastructure.Security.DeploymentAuthority.IsAuthoritativeDeployment(config)) return;
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                using var scope = scopes.CreateScope();
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
                timeout.CancelAfter(TimeSpan.FromMinutes(2));
                await scope.ServiceProvider.GetRequiredService<LogArchiveService>().ProcessOneAsync(InstanceIdentity.Get(config), timeout.Token);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
            catch (Exception ex) { logger.LogWarning("Log archive paused; failure type {Type}", ex.GetType().Name); }
            try { await Task.Delay(TimeSpan.FromSeconds(30), stoppingToken); }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
        }
    }
}
