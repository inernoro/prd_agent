using Microsoft.Extensions.Logging;
using PrdAgent.Core.Interfaces;

namespace PrdAgent.Api.Services;

/// <summary>
/// 一次性启动任务：回填 PR #612 之前创建的 PDF 包装站的 WrappedAssetType marker。
/// 启动延迟 30s 让数据库连接稳定后再扫描；扫描自身幂等（已带 marker 的会跳过），
/// 重复启动不会出问题。回填完成后该服务进入空闲状态，不再做任何事。
/// </summary>
public class HostedSiteBackfillService : BackgroundService
{
    private readonly IServiceProvider _services;
    private readonly ILogger<HostedSiteBackfillService> _logger;

    public HostedSiteBackfillService(IServiceProvider services, ILogger<HostedSiteBackfillService> logger)
    {
        _services = services;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            await Task.Delay(TimeSpan.FromSeconds(30), stoppingToken);
        }
        catch (OperationCanceledException) { return; }

        try
        {
            using var scope = _services.CreateScope();
            var siteService = scope.ServiceProvider.GetRequiredService<IHostedSiteService>();
            var count = await siteService.BackfillPdfWrapperMarkersAsync(stoppingToken);
            if (count > 0)
            {
                _logger.LogInformation("HostedSiteBackfillService: 已回填 {Count} 个 PDF 包装站 marker", count);
            }
        }
        catch (OperationCanceledException) { /* 正常停机 */ }
        catch (Exception ex)
        {
            _logger.LogError(ex, "HostedSiteBackfillService 回填任务失败");
        }
    }
}
