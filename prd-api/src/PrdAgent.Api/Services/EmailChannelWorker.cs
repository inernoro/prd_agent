using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services;

/// <summary>
/// 邮件通道后台轮询服务
/// 定期从配置的 IMAP 服务器拉取邮件并创建处理任务
/// </summary>
public sealed class EmailChannelWorker : BackgroundService
{
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly ILogger<EmailChannelWorker> _logger;

    public EmailChannelWorker(IServiceScopeFactory scopeFactory, ILogger<EmailChannelWorker> logger)
    {
        _scopeFactory = scopeFactory;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _logger.LogInformation("EmailChannelWorker started");

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
                _logger.LogError(ex, "EmailChannelWorker poll cycle failed");
            }

            // 获取配置的轮询间隔
            var interval = await GetPollIntervalAsync(stoppingToken);
            try
            {
                await Task.Delay(interval, stoppingToken);
            }
            catch (OperationCanceledException)
            {
                break;
            }
        }

        _logger.LogInformation("EmailChannelWorker stopped");
    }

    private async Task PollAsync(CancellationToken ct)
    {
        using var scope = _scopeFactory.CreateScope();
        var emailService = scope.ServiceProvider.GetRequiredService<IEmailChannelService>();
        var db = scope.ServiceProvider.GetRequiredService<MongoDbContext>();

        // 检查是否启用
        var settings = await db.ChannelSettings.Find(s => s.Id == "default").FirstOrDefaultAsync(ct);
        if (settings == null || !settings.IsEnabled)
        {
            _logger.LogDebug("Email channel is disabled, skipping poll");
            return;
        }

        _logger.LogDebug("Starting email poll...");
        var count = await emailService.PollEmailsAsync(ct);
        _logger.LogInformation("Email poll completed, processed {Count} emails", count);
    }

    private async Task<TimeSpan> GetPollIntervalAsync(CancellationToken ct)
    {
        try
        {
            using var scope = _scopeFactory.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<MongoDbContext>();
            var settings = await db.ChannelSettings.Find(s => s.Id == "default").FirstOrDefaultAsync(ct);

            if (settings != null && settings.PollIntervalMinutes > 0)
            {
                return TimeSpan.FromMinutes(settings.PollIntervalMinutes);
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to get poll interval from settings");
        }

        // 默认 5 分钟
        return TimeSpan.FromMinutes(5);
    }
}
