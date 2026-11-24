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

/// <summary>库里已经镜像着的一份报告：它是谁、当初从哪个 CDS 拉来的。</summary>
/// <param name="ReportId">条目上记的 `cdsReportId`。</param>
/// <param name="SourceBaseUrl">条目上记的 `cdsSourceBaseUrl`；老条目可能没有，此时退回库级来源。</param>
public readonly record struct CdsMirroredReport(string ReportId, string? SourceBaseUrl);

/// <summary>本轮要刷新的一个库，以及它当前镜像着哪些报告。</summary>
/// <param name="MirroredReports">库里已有条目——**这就是要刷的清单**，每一条自带它的来源。</param>
public readonly record struct CdsReportMirror(
    DocumentStore Store,
    IReadOnlyCollection<CdsMirroredReport> MirroredReports);

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
    /// **二、每一份报告刷回它自己那台 CDS。** 库级来源记的是「最后一次导入从哪来」，
    /// 不是「这一份从哪来」。一个人从两台 CDS 各存过报告时，两次都落进同一个默认库，
    /// 库级来源被后存的那次覆盖；照它去刷，先存的那台的报告要么找不到、要么在 id 撞车时
    /// 被另一台的同名报告覆盖掉（Codex review P1）。条目上本来就记着自己的来源，用它。
    ///
    /// **三、每个库只从它自己那个 CDS 拉。** 空 options 会让导入服务挑「最近更新的那条
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

            // 按 (报告, 来源) 去重且保持稳定顺序：同一份报告在库里理论上只有一条，
            // 但重复插入的历史数据（见 debt 里那条「自动与手动没有互斥」）会让它出现两次，
            // 那时候没必要刷两遍。**去重带上来源**——两台 CDS 上的同名报告是两份不同的东西，
            // 按 id 去重会把其中一份悄悄吞掉。
            var seen = new HashSet<(string, string?)>();
            var taken = 0;
            foreach (var entry in m.MirroredReports ?? Array.Empty<CdsMirroredReport>())
            {
                var reportId = Blank(entry.ReportId);
                if (reportId == null) continue;
                // **条目没记来源就留空，不拿库级来源顶替。** 库级来源记的是「最后一次导入从哪来」，
                // 拿它替一条来历不明的老条目作答，就是猜。而且这个猜会绕开「不许猜」那道闸：
                // 老库里有一堆没记来源的条目时，用户按提示重新保存**其中一份**就会把库级来源
                // 钉上，下一轮剩下那些老条目全都「有来源」了，于是被一股脑按这个源去刷——
                // 恰恰是那道闸要拦的事（Codex review P1）。留空则交给凭据解析判：
                // 只有一条已授权连接时照常用，两条以上就让这一份失败，等它自己被重新保存。
                var source = Blank(entry.SourceBaseUrl);
                if (!seen.Add((reportId, source))) continue;
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
        var distinct = new HashSet<(string, string?)>();
        foreach (var entry in mirror.MirroredReports ?? Array.Empty<CdsMirroredReport>())
        {
            var id = Blank(entry.ReportId);
            if (id != null) distinct.Add((id, Blank(entry.SourceBaseUrl)));
        }
        return Math.Max(0, distinct.Count - MaxReportsPerStorePerRound);
    }

    /// <summary>空白一律当没有：`""` 与 `"   "` 与 null 在这里是同一件事。</summary>
    private static string? Blank(string? value)
        => string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    /// <summary>
    /// 没记来源时，能不能从「已授权的 CDS 连接」里挑一条出来用。
    ///
    /// 本改动之前存进来的条目没有 `cdsSourceBaseUrl`，刷新它们时只能退回默认解析。
    /// 默认解析挑的是「最近更新的那条 active 连接」——**装了两条系统互联时，那就是在猜**。
    /// 猜错的后果不响：从 CDS-B 拉回正文，写进一条本来来自 CDS-A 的条目；报告 id 在两台
    /// CDS 上可以重名，混完连「这条是谁家的」都答不上来，而且没有任何地方会报错
    ///（Codex review P1）。
    ///
    /// 所以每小时的自动刷新传 <c>allowGuess: false</c>：只有一条连接（没有可猜的余地）才用，
    /// 不止一条就让这一份这轮失败，等人在报告页重新保存一次把来源钉住。
    /// 手动导入维持原样（<c>allowGuess: true</c>）——那是人当场发起的，猜错他看得见。
    /// </summary>
    public static CdsSourcePick PickDefaultSource(int activeConnectionCount, bool allowGuess)
    {
        if (activeConnectionCount <= 0) return CdsSourcePick.None;
        if (activeConnectionCount == 1) return CdsSourcePick.Single;
        return allowGuess ? CdsSourcePick.Single : CdsSourcePick.Ambiguous;
    }

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

/// <summary>没指定来源时，默认解析的三种结局。</summary>
public enum CdsSourcePick
{
    /// <summary>一条已授权的 CDS 连接都没有。</summary>
    None,

    /// <summary>用得了：要么只有一条（没什么可挑的），要么调用方允许在多条里挑。</summary>
    Single,

    /// <summary>不止一条，而调用方不允许猜——这一份该失败，不该随便挑一条接着拉。</summary>
    Ambiguous,
}
