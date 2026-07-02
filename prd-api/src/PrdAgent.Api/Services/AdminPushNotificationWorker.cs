namespace PrdAgent.Api.Services;

public sealed class AdminPushNotificationWorker : BackgroundService
{
    private static readonly TimeSpan SweepInterval = TimeSpan.FromMinutes(1);

    private readonly IServiceScopeFactory _scopeFactory;
    private readonly AdminPushDispatchSignal _dispatchSignal;
    private readonly ILogger<AdminPushNotificationWorker> _logger;

    public AdminPushNotificationWorker(
        IServiceScopeFactory scopeFactory,
        AdminPushDispatchSignal dispatchSignal,
        ILogger<AdminPushNotificationWorker> logger)
    {
        _scopeFactory = scopeFactory;
        _dispatchSignal = dispatchSignal;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            await SweepOnceAsync(stoppingToken);

            try
            {
                await _dispatchSignal.WaitAsync(SweepInterval, stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
        }
    }

    private async Task SweepOnceAsync(CancellationToken stoppingToken)
    {
        try
        {
            using var scope = _scopeFactory.CreateScope();
            var service = scope.ServiceProvider.GetRequiredService<AdminPushNotificationService>();
            await service.DispatchPendingAsync(stoppingToken);
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "管理员推送后台扫描失败");
        }
    }
}
