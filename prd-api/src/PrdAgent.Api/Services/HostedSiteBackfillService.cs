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

            // 一次性 visibility backfill（PR 2026-05-28）：把存量分享链接 Visibility
            // 从默认 "owner-only" 迁移为 "public"，保护历史公开链路；仅作用于发布前已存在的链接，幂等。
            var visCount = await siteService.BackfillShareVisibilityAsync(stoppingToken);
            if (visCount > 0)
            {
                _logger.LogInformation("HostedSiteBackfillService: 已迁移 {Count} 条存量分享到 public Visibility", visCount);
            }

            // 翻页方向兼容垫片回填（2026-06-03）：把存量 PPT / 旧垫片版本的站点重新注入当前版垫片，
            // 让用户无需重新上传即可获得「上下键也能翻页」。注入保持在隔离对象存储域名上。
            var navCount = await siteService.BackfillSlideNavCompatAsync(stoppingToken);
            if (navCount > 0)
            {
                _logger.LogInformation("HostedSiteBackfillService: 已为 {Count} 个存量站点注入/升级翻页兼容垫片", navCount);
            }
        }
        catch (OperationCanceledException) { /* 正常停机 */ }
        catch (Exception ex)
        {
            _logger.LogError(ex, "HostedSiteBackfillService 回填任务失败");
        }
    }
}
