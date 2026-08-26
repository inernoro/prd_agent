using PrdAgent.Core.Models;

namespace PrdAgent.Api.Services;

/// <summary>本轮要刷新的一份报告：刷哪个库里的哪一份、从哪个 CDS 拉。</summary>
/// <param name="StoreId">目标知识库 id。**必须显式传给导入服务**，否则它会 find-or-create，
/// 同一个人有两个镜像库时只刷得到其中一个。</param>
/// <param name="OwnerId">库的属主。导入服务用它做写入鉴权。</param>
/// <param name="SourceBaseUrl">这个库上次是从哪个 CDS 同步的；null = 还没记过，退回默认解析。</param>
/// <param name="ReportId">要刷新的那一份报告。</param>
public readonly record struct CdsReportSyncTarget(
    string StoreId,
    string OwnerId,
    string? SourceBaseUrl,
    string ReportId);

/// <summary>本轮要刷新的一个库，以及它当前镜像着哪些报告。</summary>
/// <param name="MirroredReportIds">库里已有条目的 `cdsReportId` 集合——**这就是要刷的清单**。</param>
public readonly record struct CdsReportMirror(
    DocumentStore Store,
    IReadOnlyCollection<string> MirroredReportIds);

/// <summary>
/// 「刷哪些库的哪些报告、各自从哪个源拉」的判据。
///
/// **单独一个文件、只依赖 Core 模型**，是为了让它能被测试项目直接 link 进去跑
///（<c>CdsReportImportWorker</c> 本体拖着 BackgroundService / Mongo / 导入服务，
/// 整个搬进测试项目代价太大）。判据在这里，回归也钉在这里。
/// </summary>
public static class CdsReportSyncTargets
{
    /// <summary>
    /// 一个库一轮最多刷多少份报告。
    ///
    /// 不是为了省事截断，是为了**别让一个异常大的库把整轮拖死、顺带把 CDS 打爆**。
    /// 超出时调用方必须把「这轮少刷了几份」如实说出来（no-silent-caps），不许闷着。
    /// </summary>
    public const int MaxReportsPerStorePerRound = 200;

    /// <summary>
    /// 决定本轮刷哪些库的哪些报告、各自从哪个源拉。纯函数。
    ///
    /// ## 判据：要刷的清单，库里已经写着了
    ///
    /// 早先这里试过「把首次导入的筛选范围记在库上，自动任务照着重放」。那个设计有个
    /// 致命前提——「首次导入的范围」代表用户想要什么。**产品里根本不成立**：
    /// 唯一的导入入口是 CDS 报告页的「保存到 MAP 知识库」，它一次存**一份**报告，
    /// 而且都存进同一个默认库。于是每存一份新报告就把库的范围改写成那一份，
    /// 自动任务从此只刷它，用户之前存的全部就此不再更新——**存得越多，坏得越彻底**
    ///（Codex review P1）。
    ///
    /// 正解不需要另记一套账：**这个库里已经有哪些报告，就刷哪些**。每条 entry 的
    /// `Metadata.cdsReportId` 就是权威清单，它天然跟着用户的实际操作走——存一份多一份，
    /// 删一份少一份，永远不会和事实对不上。少一个字段，也少一处会漂移的状态。
    ///
    /// ## 另外两条，各自都有过教训
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
    /// </summary>
    public static List<CdsReportSyncTarget> Build(IEnumerable<CdsReportMirror> mirrors)
    {
        var targets = new List<CdsReportSyncTarget>();
        foreach (var m in mirrors)
        {
            var s = m.Store;
            if (s == null) continue;
            // 缺属主就没法做写入鉴权，缺 id 就只能 find-or-create——两种都不该硬着头皮同步。
            if (string.IsNullOrWhiteSpace(s.Id) || string.IsNullOrWhiteSpace(s.OwnerId)) continue;

            // 空白来源 = 这个库还没记下它从哪来（历史数据）。退回默认解析，与手动导入首次
            // 的行为一致；导入成功后服务会把来源写回库上，下一轮就钉住了。
            var source = Blank(s.CdsReportSourceBaseUrl);

            // 报告 id 去重且保持稳定顺序：同一份报告在库里理论上只有一条，
            // 但重复插入的历史数据（见 debt 里那条「自动与手动没有互斥」）会让它出现两次，
            // 那时候没必要刷两遍。
            var seen = new HashSet<string>(StringComparer.Ordinal);
            var taken = 0;
            foreach (var raw in m.MirroredReportIds ?? Array.Empty<string>())
            {
                var reportId = Blank(raw);
                if (reportId == null || !seen.Add(reportId)) continue;
                if (taken >= MaxReportsPerStorePerRound) break;
                taken++;
                targets.Add(new CdsReportSyncTarget(s.Id, s.OwnerId, source, reportId));
            }
        }
        return targets;
    }

    /// <summary>
    /// 这个库这轮被截掉了几份没刷。调用方必须把它报出来——
    /// 悄悄少刷会让「每小时都在更新」这句话在大库上变成假话。
    /// </summary>
    public static int TruncatedCount(CdsReportMirror mirror)
    {
        var distinct = new HashSet<string>(StringComparer.Ordinal);
        foreach (var raw in mirror.MirroredReportIds ?? Array.Empty<string>())
        {
            var id = Blank(raw);
            if (id != null) distinct.Add(id);
        }
        return Math.Max(0, distinct.Count - MaxReportsPerStorePerRound);
    }

    /// <summary>空白一律当没有：`""` 与 `"   "` 与 null 在这里是同一件事。</summary>
    private static string? Blank(string? value)
        => string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    /// <summary>
    /// 这一轮要拉的源，和库上记着的那个是不是**换了一个**。
    ///
    /// 「库上还没记过来源」不算换——那是历史数据或第一次导入，没有旧状态可作废。
    ///
    /// ## 为什么这个判断值得单独一个函数
    ///
    /// 它有两个消费方，而且两边必须给出完全一致的答案：
    ///
    /// - `CdsReportImportService` 判「能不能复用增量水位」——换了源就不能，
    ///   否则 `updatedSince` 会拿着 CDS-A 的游标去列 CDS-B 的报告；
    /// - 同一个地方判「要不要把旧水位清掉」——水位是**跟着源走**的状态，
    ///   源换了它就作废。
    ///
    /// 这两件事必须同进同退。抄成两份 `TrimEnd('/') + OrdinalIgnoreCase` 的话，
    /// 改一处忘一处就会漏出这样一条静默通路：先从 CDS-A 全量导入（水位戳到 T_A），
    /// 再从 CDS-B 全量导入一次（换源，这轮不用水位、也不回写，但**来源字段被改成了 B**），
    /// 从此库上是「源 = B、水位 = T_A」——每小时的自动同步看这个组合完全合法，
    /// 于是一直拿 T_A 当游标去拉 B，**B 上所有更新时间早于 T_A 的报告被永久跳过**，
    /// 没有任何报错（Codex review P1）。
    /// </summary>
    public static bool SourceChanged(string? recordedBaseUrl, string? resolvedBaseUrl)
    {
        var recorded = Blank(recordedBaseUrl);
        if (recorded == null) return false;
        return !string.Equals(
            recorded.TrimEnd('/'),
            Blank(resolvedBaseUrl)?.TrimEnd('/') ?? string.Empty,
            StringComparison.OrdinalIgnoreCase);
    }
}
