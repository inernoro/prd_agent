using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using PrdAgent.Core.Interfaces;

namespace PrdAgent.Infrastructure.Services.ClaudeSidecar;

/// <summary>
/// 周期触发 DynamicSidecarRegistry.RefreshAsync —— 把 CDS 部署的远程主机
/// 实例自动同步进路由池。详见 IDynamicSidecarRegistry。
///
/// 不与 ClaudeSidecarHealthChecker 重复：本服务只负责"实例列表"刷新，
/// 实例健康探针仍由 HealthChecker 周期 GET /healthz 完成。
/// </summary>
public sealed class CdsSidecarSyncService : BackgroundService
{
    private readonly IDynamicSidecarRegistry _registry;
    private readonly IOptionsMonitor<ClaudeSidecarOptions> _options;
    private readonly ILogger<CdsSidecarSyncService> _logger;

    public CdsSidecarSyncService(
        IDynamicSidecarRegistry registry,
        IOptionsMonitor<ClaudeSidecarOptions> options,
        ILogger<CdsSidecarSyncService> logger)
    {
        _registry = registry;
        _options = options;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // 启动时先做一次初始同步（即便 CdsDiscovery 未启用也跑：会清空动态快照、记录时间戳，
        // 让 GetCurrent() 行为可预测）。
        try { await _registry.RefreshAsync(stoppingToken); }
        catch (Exception ex) { _logger.LogWarning(ex, "[CdsSync] initial refresh failed"); }

        while (!stoppingToken.IsCancellationRequested)
        {
            var interval = Math.Max(5, _options.CurrentValue.CdsDiscovery.RefreshIntervalSeconds);
            try { await Task.Delay(TimeSpan.FromSeconds(interval), stoppingToken); }
            catch (OperationCanceledException) { return; }

            try { await _registry.RefreshAsync(stoppingToken); }
            catch (Exception ex)
            {
                // RefreshAsync 内部已经 catch 并写 LastRefreshError，这里只可能是接口本身抛
                _logger.LogWarning(ex, "[CdsSync] refresh threw outside RefreshAsync (unexpected)");
            }
        }
    }
}
