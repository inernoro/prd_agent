using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using PrdAgent.Infrastructure.Security;

namespace PrdAgent.Api.Services.ModelLeaderboard;

/// <summary>
/// 每天把 arena.ai 的公开模型榜同步进本地库，供首页挂件与 /model-leaderboard 页读取。
///
/// ## 三条刻意的边界
///
/// 1. **只在权威部署上跑**。同一个 CDS 项目下所有分支预览共用一个 Mongo
///    （见 .claude/rules/cross-project-isolation.md 通道 4），而榜单快照是共享库里的
///    全局单行状态——每个榜单一条文档，谁都能覆盖。不加这道闸，N 个分支预览会同时对
///    arena.ai 发请求并互相覆盖同一批文档：既是对外站的自我 DDoS，也让「这份数据是哪个
///    构建写的」变得不可追。判据用 <see cref="DeploymentAuthority.CanRunSharedScheduledWork"/>，
///    与 CdsReportImportWorker 同口径。
///
/// 2. **抓失败就保留旧快照**。外站改版、超时、限流都会让某一轮失败。这时候绝不写库——
///    宁可让页面显示「数据截至 9 月 12 日」，也不要用空榜覆盖掉昨天的好数据。
///    每个榜单独立 try/catch，一个榜失败不影响其他榜。
///
/// 3. **首次同步不编造升降**。<see cref="ModelLeaderboardEntry.PreviousRank"/> 靠比对上一份
///    快照得出；没有上一份时留 null，前端据此不显示箭头。没有的数据就是没有。
/// </summary>
public class ModelLeaderboardSyncWorker : BackgroundService
{
    /// <summary>
    /// 注册与取用 HttpClient 的名字。收成常量，免得 Program.cs 和这里各写一遍字符串——
    /// 写歪了不会编译报错，只会在运行时静默拿到一个没配超时和 UA 的默认 client。
    /// </summary>
    public const string HttpClientName = "ModelLeaderboard";

    /// <summary>同步间隔。榜单本身按天更新，抓更勤没有意义，只是给外站添堵。</summary>
    public static readonly TimeSpan SyncInterval = TimeSpan.FromHours(24);

    /// <summary>
    /// 启动后先等一会儿再跑第一轮：容器刚起来要建连接、跑迁移，这时候再去拉外站是给自己添堵；
    /// 多实例同时重启时错峰也能避免一起打过去。
    /// </summary>
    private static readonly TimeSpan StartupDelay = TimeSpan.FromMinutes(2);

    /// <summary>
    /// 要同步的分榜，对应 arena.ai 的路径。选这五个是因为它们各自对得上本平台的一块功能：
    /// agent 对智能体、code 对 PR 审查、document 对文档空间、vision 对视觉创作、
    /// text-to-image 对生图。
    /// </summary>
    public static readonly string[] Boards = ["agent", "code", "document", "vision", "text-to-image"];

    private readonly IServiceScopeFactory _scopeFactory;
    private readonly IConfiguration _configuration;
    private readonly ILogger<ModelLeaderboardSyncWorker> _logger;

    public ModelLeaderboardSyncWorker(
        IServiceScopeFactory scopeFactory,
        IConfiguration configuration,
        ILogger<ModelLeaderboardSyncWorker> logger)
    {
        _scopeFactory = scopeFactory;
        _configuration = configuration;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!DeploymentAuthority.CanRunSharedScheduledWork(_configuration))
        {
            _logger.LogInformation(
                "模型榜同步：本容器是 CDS 分支预览，不对共享库跑周期同步（读取不受影响，页面照常显示已有快照）。");
            return;
        }

        try
        {
            await Task.Delay(StartupDelay, stoppingToken);
        }
        catch (OperationCanceledException)
        {
            return;
        }

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await SyncAllAsync(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                // 整轮兜底：单个榜的失败已经在 SyncAllAsync 里各自处理了，能走到这里说明是
                // 循环本身出了问题（比如拿不到 scope）。记下来，下一轮继续，不让 worker 死掉。
                _logger.LogError(ex, "模型榜同步：整轮失败。");
            }

            try
            {
                await Task.Delay(SyncInterval, stoppingToken);
            }
            catch (OperationCanceledException)
            {
                return;
            }
        }
    }

    private async Task SyncAllAsync(CancellationToken ct)
    {
        using var scope = _scopeFactory.CreateScope();
        // 同步逻辑只有一份，在 ModelLeaderboardSyncService 里；本 Worker 只负责「什么时候跑」。
        var service = scope.ServiceProvider.GetRequiredService<ModelLeaderboardSyncService>();

        var results = await service.SyncAllAsync(ct);
        var succeeded = results.Count(r => r.Ok);

        _logger.LogInformation("模型榜同步：本轮完成 {Succeeded}/{Total} 个分榜。", succeeded, results.Count);
    }
}
