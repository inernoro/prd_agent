using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services;

namespace PrdAgent.Api.Services;

/// <summary>
/// 教程邮件后台任务：定期轮询到期的 enrollment，发送对应邮件。
/// 轮询间隔：每 30 分钟检查一次（邮件是按天发送的，不需要高频轮询）。
/// </summary>
public sealed class TutorialEmailWorker : BackgroundService
{
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly ILogger<TutorialEmailWorker> _logger;

    private static readonly TimeSpan DefaultPollInterval = TimeSpan.FromMinutes(30);

    public TutorialEmailWorker(IServiceScopeFactory scopeFactory, ILogger<TutorialEmailWorker> logger)
    {
        _scopeFactory = scopeFactory;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _logger.LogInformation("TutorialEmailWorker started");

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await PollAsync(stoppingToken);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "TutorialEmailWorker poll cycle failed");
            }

            try
            {
                await Task.Delay(DefaultPollInterval, stoppingToken);
            }
            catch (OperationCanceledException)
            {
                break;
            }
        }

        _logger.LogInformation("TutorialEmailWorker stopped");
    }

    private async Task PollAsync(CancellationToken ct)
    {
        using var scope = _scopeFactory.CreateScope();
        var service = scope.ServiceProvider.GetRequiredService<ITutorialEmailService>();

        var processed = await service.ProcessDueEnrollmentsAsync(ct);
        if (processed > 0)
        {
            _logger.LogInformation("TutorialEmailWorker processed {Count} enrollments", processed);
        }
        else
        {
            _logger.LogDebug("TutorialEmailWorker: no due enrollments");
        }
    }
}
