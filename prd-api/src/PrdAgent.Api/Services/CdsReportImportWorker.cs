using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Security;

namespace PrdAgent.Api.Services;

/// <summary>
/// 每小时把 CDS 验收中心的报告同步进 MAP 知识库。
///
/// ## 为什么要有
///
/// 导入这件事本来只有一个手动入口（<c>POST /api/document-store/import-cds-reports</c>）：
/// 有人点一次才同步一次。于是「CDS 上有新验收报告」和「MAP 里看得到」之间隔着一个
/// 谁也不会记得去做的动作，报告镜像库一直是陈的。
///
/// ## 三条刻意的边界
///
/// 1. **只在权威部署上跑**。同一个 CDS 项目下所有分支预览共用一个 Mongo（见
///    cross-project-isolation 通道 4），每个分支预览也都跑着一份 MAP。不加这道闸的话，
///    N 个分支预览会同时对 CDS 发起导入、并往同一个共享库里写同一批文档——既是对 CDS
///    的自我 DDoS，也让「谁写的」变得不可追。判据复用 <see cref="DeploymentAuthority"/>，
///    不另造一份。
/// 2. **不新建知识库，只刷新已有的**。<c>ImportAsync</c> 会 find-or-create 一个属于某个用户的
///    镜像库；后台任务如果替所有用户建库，等于替人做主。所以这里只枚举**已经存在**的
///    <c>cds-reports</c> 库并刷新它们——第一次同步仍然由人手动触发，之后才由它保持新鲜。
///    一个都没有时安静跳过，并说清是这个原因，而不是留一条看不出所以然的静默。
/// 3. **一个库失败不影响其他库**。逐个 catch，失败只记日志；否则第一个没配好连接的用户
///    会让整轮同步停摆。
/// 4. **每个库只从它自己那个 CDS 拉**。判据与理由见 <see cref="CdsReportSyncTargets"/>。
/// </summary>
public class CdsReportImportWorker : BackgroundService
{
    /// <summary>同步间隔。用户 2026-08-25 明确要求 60 分钟。</summary>
    public static readonly TimeSpan SyncInterval = TimeSpan.FromMinutes(60);

    /// <summary>
    /// 启动后先等一会儿再跑第一轮。
    ///
    /// 容器刚起来时要建连接、跑迁移、暖缓存，这时候再去拉一遍 CDS 是给自己添堵；
    /// 而且多个实例同时重启时错峰能避免一起打 CDS。
    /// </summary>
    private static readonly TimeSpan StartupDelay = TimeSpan.FromMinutes(3);

    private readonly IServiceScopeFactory _scopeFactory;
    private readonly IConfiguration _configuration;
    private readonly ILogger<CdsReportImportWorker> _logger;

    public CdsReportImportWorker(
        IServiceScopeFactory scopeFactory,
        IConfiguration configuration,
        ILogger<CdsReportImportWorker> logger)
    {
        _scopeFactory = scopeFactory;
        _configuration = configuration;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!DeploymentAuthority.IsAuthoritativeDeployment(_configuration))
        {
            // 说清为什么不跑。一条没有理由的静默会让人以为任务坏了。
            _logger.LogInformation(
                "[CdsReportImportWorker] 本部署不是权威部署（CDS 分支预览），不跑验收报告自动同步——"
                + "同项目所有分支共用一个库，多份同时写会互相打架");
            return;
        }

        try { await Task.Delay(StartupDelay, stoppingToken); }
        catch (OperationCanceledException) { return; }

        _logger.LogInformation("[CdsReportImportWorker] 已启动，每 {Interval} 同步一次 CDS 验收报告", SyncInterval);

        using var timer = new PeriodicTimer(SyncInterval);
        do
        {
            try
            {
                await RunOnceAsync(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                // 一轮失败不许让 worker 退出——退出之后没有任何东西会把它拉起来，
                // 而「任务不在了」在外部看来和「同步一直没有新东西」长得一模一样。
                _logger.LogError(ex, "[CdsReportImportWorker] 本轮同步失败，等下一轮重试");
            }
        }
        while (await timer.WaitForNextTickAsync(stoppingToken));
    }

    /// <summary>跑一轮：刷新每个已存在的 CDS 报告镜像库。</summary>
    private async Task RunOnceAsync(CancellationToken ct)
    {
        using var scope = _scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MongoDbContext>();
        var importer = scope.ServiceProvider.GetRequiredService<CdsReportImportService>();

        var stores = await db.DocumentStores
            .Find(s => s.AppKey == CdsReportStoreAppKey)
            .ToListAsync(ct);

        var targets = CdsReportSyncTargets.Build(stores);

        if (targets.Count == 0)
        {
            // 说清是「一个库都没有」还是「有库但都不符合自动刷新条件」——两者的下一步不一样。
            _logger.LogInformation(
                "[CdsReportImportWorker] 本轮没有可自动刷新的 CDS 报告镜像库（扫到 {Total} 个 {AppKey} 库）。"
                + "只有「默认全量导入且零失败」过的库才会自动刷新：只导过单条报告或单个项目的库不会被撑成全量，"
                + "从没成功全量导入过的库也不会。第一次同步请在知识库里手动导入一次",
                stores.Count, CdsReportStoreAppKey);
            return;
        }

        var ok = 0;
        var failed = 0;
        foreach (var t in targets)
        {
            if (ct.IsCancellationRequested) return;
            try
            {
                var result = await importer.ImportAsync(
                    t.OwnerId,
                    new CdsReportImportOptions { StoreId = t.StoreId, SourceBaseUrl = t.SourceBaseUrl },
                    ct);
                ok++;
                _logger.LogInformation(
                    "[CdsReportImportWorker] 库 {StoreId}（用户 {OwnerId}，源 {Source}）同步完成："
                    + "共 {Total}，新增 {Imported}，更新 {Updated}，跳过 {Skipped}，失败 {Failed}",
                    t.StoreId, t.OwnerId, t.SourceBaseUrl ?? "(默认连接)",
                    result.Total, result.Imported, result.Updated, result.Skipped, result.Failed);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                failed++;
                // 一个库的源没了或没配好，不该让别的库也同步不了。
                // **失败时宁可不同步，也不换个源接着拉**——那正是混源要防的事。
                _logger.LogWarning(ex,
                    "[CdsReportImportWorker] 库 {StoreId}（用户 {OwnerId}，源 {Source}）同步失败，跳过",
                    t.StoreId, t.OwnerId, t.SourceBaseUrl ?? "(默认连接)");
            }
        }

        _logger.LogInformation("[CdsReportImportWorker] 本轮结束：成功 {Ok}，失败 {Failed}", ok, failed);
    }

    /// <summary>
    /// CDS 报告镜像库的 AppKey。
    ///
    /// 与 <see cref="CdsReportImportService"/> 里 find-or-create 用的那个必须是同一个值——
    /// 两边各写一遍字面量的话，改一处忘一处就会变成「后台任务永远找不到库、静默什么都不做」。
    /// </summary>
    public const string CdsReportStoreAppKey = "cds-reports";
}
