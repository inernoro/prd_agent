using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace PrdAgent.Infrastructure.Services.Changelog;

/// <summary>
/// 更新中心后台刷新 Worker（取代旧的 ChangelogCacheWarmer）。
///
/// 设计意图（2026-06-04）——「第一个看的人不吃亏」：
///  - 启动时先以**只读存量**方式预热（GetXxx 非 force：命中数据库快照即返回；库空才真冷启动拉一次），
///    用户进页面立即有内容，绝不空白。
///  - 之后按固定周期（Changelog:RefreshIntervalHours，默认 4 小时）由服务器自己 force 刷新，
///    与用户访问完全解耦 —— 冷门项目、只有一个访客的项目，也不靠「谁来当倒霉的触发器」。
///  - 刷新内容有变化时，ChangelogReader 通过 push hub 推送 SSE 事件，打开着的页面自动更新。
///
/// 启动后会先做一次延迟的 force 刷新（让重启后的数据尽快与远端对齐），再进入固定周期循环。
/// </summary>
public sealed class ChangelogRefreshWorker : BackgroundService
{
    private readonly IChangelogReader _reader;
    private readonly ILogger<ChangelogRefreshWorker> _logger;

    // 与前端请求的 limit 对齐，保证预热/刷新的快照 key 正是前端会读取的那几个。
    private const int ReleasesLimit = 20;
    private const int GitHubLogsLimit = 1000;

    // 启动后首次 force 刷新的延迟：先让启动流程跑顺、用户先吃到存量，再后台对齐远端。
    private static readonly TimeSpan InitialForceDelay = TimeSpan.FromSeconds(60);

    public ChangelogRefreshWorker(IChangelogReader reader, ILogger<ChangelogRefreshWorker> logger)
    {
        _reader = reader;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // 1) 启动预热：只读存量（库有快照即秒回；库空则这一次真冷启动拉取，用户无感）
        try
        {
            await _reader.GetCurrentWeekAsync().ConfigureAwait(false);
            await _reader.GetReleasesAsync(ReleasesLimit).ConfigureAwait(false);
            await _reader.GetGitHubLogsAsync(GitHubLogsLimit).ConfigureAwait(false);
            _logger.LogInformation("[Changelog] 启动预热完成（只读存量）");
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[Changelog] 启动预热失败（退回懒加载，不影响服务启动）");
        }

        // 2) 启动后稍等再做一次 force 刷新，让重启后的数据尽快与远端对齐
        try { await Task.Delay(InitialForceDelay, stoppingToken).ConfigureAwait(false); }
        catch (OperationCanceledException) { return; }
        await RefreshOnceAsync(stoppingToken).ConfigureAwait(false);

        // 3) 固定周期循环刷新
        while (!stoppingToken.IsCancellationRequested)
        {
            var interval = TimeSpan.FromHours(Math.Max(1, _reader.GetRefreshIntervalHours()));
            try { await Task.Delay(interval, stoppingToken).ConfigureAwait(false); }
            catch (OperationCanceledException) { break; }
            await RefreshOnceAsync(stoppingToken).ConfigureAwait(false);
        }
    }

    private async Task RefreshOnceAsync(CancellationToken ct)
    {
        try
        {
            await _reader.RefreshAllAsync(ReleasesLimit, GitHubLogsLimit, ct).ConfigureAwait(false);
            _logger.LogInformation("[Changelog] 后台周期刷新完成（内容变化已落库+推送）");
        }
        catch (OperationCanceledException) { /* 关停中 */ }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[Changelog] 后台周期刷新失败（沿用存量，下个周期重试）");
        }
    }
}
