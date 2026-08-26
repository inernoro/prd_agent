using PrdAgent.Core.Models;

namespace PrdAgent.Api.Services;

/// <summary>本轮要刷新的一个镜像库：从哪个 CDS 拉、拉多大范围。</summary>
/// <param name="StoreId">目标知识库 id。**必须显式传给导入服务**，否则它会 find-or-create，
/// 同一个人有两个镜像库时只刷得到其中一个。</param>
/// <param name="OwnerId">库的属主。导入服务用它做写入鉴权。</param>
/// <param name="SourceBaseUrl">这个库上次是从哪个 CDS 同步的；null = 还没记过，退回默认解析。</param>
/// <param name="ProjectId">只刷这个 CDS 项目的报告；null = 不按项目过滤。</param>
/// <param name="ReportId">只刷这一份报告；null = 不按报告过滤。</param>
public readonly record struct CdsReportSyncTarget(
    string StoreId,
    string OwnerId,
    string? SourceBaseUrl,
    string? ProjectId,
    string? ReportId);

/// <summary>
/// 「刷哪些库、各自从哪个源拉、拉多大范围」的判据。
///
/// **单独一个文件、只依赖 Core 模型**，是为了让它能被测试项目直接 link 进去跑
///（<c>CdsReportImportWorker</c> 本体拖着 BackgroundService / Mongo / 导入服务，
/// 整个搬进测试项目代价太大）。判据在这里，回归也钉在这里。
/// </summary>
public static class CdsReportSyncTargets
{
    /// <summary>
    /// 决定本轮刷哪些库、各自从哪个源拉、拉多大范围。纯函数。
    ///
    /// ## 三条判据，各自都有过教训
    ///
    /// **一、每个库都要刷到。** 第一版按 OwnerId 去重，于是同一个人有两个镜像库时，
    /// 导入服务的 find-or-create 只会命中其中一个，另一个永远不刷新，而且看不出来
    /// ——它只是一直是旧的。
    ///
    /// **二、每个库只从它自己那个 CDS 拉。** 空 options 会让导入服务挑「最近更新的那条
    /// active CDS 连接」。装了两条系统互联时，它可能从 CDS-B 拉报告，写进一个来源记着
    /// CDS-A 的库里；两个来源的报告 id 与正文就此混进同一个镜像，每小时自动混一次，
    /// 而且没有任何地方会报错——报告 id 在不同 CDS 上可以重名，混完连「这条是谁家的」
    /// 都答不上来（Codex review P1）。所以源没了就让这个库这轮失败，也不换一个源接着拉。
    ///
    /// **三、按各自记下的范围重放，而不是「只刷全量镜像」。** 上一版怕把「用户特意只存了
    /// 一条报告」的库每小时撑成整座库，于是只肯刷有全量水位的库。方向对，代价却是**小范围
    /// 的库从此永远不会自动更新**：用户存的那条报告在 CDS 上更新了，这边永远看不到，
    /// 而且看不出为什么（2026-08-26 真人验收现场撞上：手工导入 1 份成功，等一小时没有任何
    /// 自动更新）。正解不是二选一——把首次导入的范围记在库上，自动任务照着重放：
    /// 单条刷那一条、单项目刷那个项目、全量走增量水位。三种都能自动新鲜，谁也不会被撑大。
    /// </summary>
    public static List<CdsReportSyncTarget> Build(IEnumerable<DocumentStore> stores)
    {
        var targets = new List<CdsReportSyncTarget>();
        foreach (var s in stores)
        {
            if (s == null) continue;
            // 缺属主就没法做写入鉴权，缺 id 就只能 find-or-create——两种都不该硬着头皮同步。
            if (string.IsNullOrWhiteSpace(s.Id) || string.IsNullOrWhiteSpace(s.OwnerId)) continue;

            string? projectId = null;
            string? reportId = null;
            if (s.CdsReportScopeRecordedAt.HasValue)
            {
                // 记过范围：照着重放。三种都合法，包括「记的就是全量」（两个都空）。
                projectId = Blank(s.CdsReportScopeProjectId);
                reportId = Blank(s.CdsReportScopeReportId);
            }
            else if (s.PeerSyncLastAt.HasValue)
            {
                // 没记过范围的老库（本改动之前建的）。这时候只能靠间接证据：
                // `PeerSyncLastAt` 只有**默认全量且零失败**的导入才回写，带过滤的从不写它。
                // 所以「有水位」等价于「这个库被当作全量镜像用过」，可以按全量刷。
                // 没水位又没范围记录的，证明不了它是什么，宁可不动——等它下次被手工导入
                // 一次，范围就登记上了，从此走上面那条路。
            }
            else
            {
                continue;
            }

            // 空白来源 = 这个库还没记下它从哪来（历史数据）。退回默认解析，与手动导入首次
            // 的行为一致；导入成功后服务会把来源写回库上，下一轮就钉住了。
            var source = Blank(s.PeerSyncNodeBaseUrl);
            targets.Add(new CdsReportSyncTarget(s.Id, s.OwnerId, source, projectId, reportId));
        }
        return targets;
    }

    /// <summary>空白一律当没有：`""` 与 `"   "` 与 null 在这里是同一件事。</summary>
    private static string? Blank(string? value)
        => string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    /// <summary>把一个目标的范围说成人话，进日志用。</summary>
    public static string DescribeScope(CdsReportSyncTarget target)
    {
        if (!string.IsNullOrWhiteSpace(target.ReportId)) return $"单份报告 {target.ReportId}";
        if (!string.IsNullOrWhiteSpace(target.ProjectId)) return $"项目 {target.ProjectId}";
        return "全部报告";
    }
}
