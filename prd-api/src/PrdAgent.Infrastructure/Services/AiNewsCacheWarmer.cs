using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using PrdAgent.Core.Interfaces;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// 「AI 大事」资讯缓存预热 + 定时刷新。
///
/// 背景（卡顿排查 2026-06-03）：AiNewsService 的新鲜缓存只有 5 分钟，旧实现「过期即同步阻塞拉外网」，
/// 于是每过 5 分钟、或容器冷启动后，第一个访问的用户都要同步等一次 GitHub Pages 拉取（最长顶到 8s 超时）→ 转圈。
///
/// 本预热器在后台每 4 分钟（小于 FreshTtl=5min）刷一次缓存，让新鲜缓存常驻，
/// 用户访问路径永远命中缓存、永不同步等外网。失败不阻断启动，也不影响用户（仍有 stale 兜底）。
///
/// IAiNewsService 是 Scoped（依赖 Scoped 的 ILlmGateway），故每次刷新都开一个 DI scope。
/// </summary>
public sealed class AiNewsCacheWarmer : BackgroundService
{
    private static readonly TimeSpan RefreshInterval = TimeSpan.FromMinutes(4);

    private readonly IServiceScopeFactory _scopeFactory;
    private readonly ILogger<AiNewsCacheWarmer> _logger;

    public AiNewsCacheWarmer(IServiceScopeFactory scopeFactory, ILogger<AiNewsCacheWarmer> logger)
    {
        _scopeFactory = scopeFactory;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // 启动即预热一次，再进入定时循环。
        await RefreshOnceAsync(stoppingToken).ConfigureAwait(false);

        using var timer = new PeriodicTimer(RefreshInterval);
        try
        {
            while (await timer.WaitForNextTickAsync(stoppingToken).ConfigureAwait(false))
            {
                await RefreshOnceAsync(stoppingToken).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException)
        {
            // 正常停机，忽略。
        }
    }

    private async Task RefreshOnceAsync(CancellationToken ct)
    {
        try
        {
            using var scope = _scopeFactory.CreateScope();
            var svc = scope.ServiceProvider.GetRequiredService<IAiNewsService>();
            await svc.RefreshAndCacheAsync(ct).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[AiNews] 后台预热刷新失败（退回懒加载 + stale 兜底，不影响服务）");
        }
    }
}
