using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace PrdAgent.Infrastructure.Services.Changelog;

/// <summary>
/// 启动预热更新中心缓存：在第一个用户请求到达前，先把「历史发布 / 待发布」拉好放进缓存。
/// 配合 ChangelogReader 的 serve-stale-while-revalidate，让用户几乎永远不必等冷启动拉取
/// （生产镜像无本地源时，冷启动那一次 GitHub 拉取被挪到这里后台完成，用户无感）。
/// 预热失败不阻断启动：懒加载路径仍会在首个请求时拉取。
/// </summary>
public sealed class ChangelogCacheWarmer : BackgroundService
{
    private readonly IChangelogReader _reader;
    private readonly ILogger<ChangelogCacheWarmer> _logger;

    public ChangelogCacheWarmer(IChangelogReader reader, ILogger<ChangelogCacheWarmer> logger)
    {
        _reader = reader;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            await _reader.GetCurrentWeekAsync().ConfigureAwait(false);
            await _reader.GetReleasesAsync(20).ConfigureAwait(false);
            _logger.LogInformation("[Changelog] 启动预热完成（current-week + releases）");
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[Changelog] 启动预热失败（退回懒加载，不影响服务启动）");
        }
    }
}
