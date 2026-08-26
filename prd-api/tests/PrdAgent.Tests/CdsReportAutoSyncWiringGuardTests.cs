using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 「每小时自动刷新」这条链路上，四处删掉不会有任何测试变红的接线。
///
/// 四处的共同点是：判据本身在别处已经有真单测（<see cref="PrdAgent.Api.Services.CdsReportSyncTargets"/>），
/// 但**判据算出来的东西有没有真被用上**，靠 Mongo 才测得出——而导入服务与 worker 都拖着
/// Mongo / HttpClient / BackgroundService，搬不进这个纯单测项目。接线断掉的表现全都是静默的：
/// 不抛异常、不报错、日志还是绿的，只是数据悄悄变错。所以这里扫源码补上
///（predicate-and-wiring-discipline 形状 2「链路只建到一半」）。
/// </summary>
public class CdsReportAutoSyncWiringGuardTests
{
    private static string ReadImportService() => ReadApiSource("CdsReportImportService.cs");

    private static string ReadWorker() => ReadApiSource("CdsReportImportWorker.cs");

    private static string ReadApiSource(string fileName)
    {
        var path = Path.Combine(FindSrcRoot(), "PrdAgent.Api", "Services", fileName);
        Assert.True(File.Exists(path), $"守卫要读的源文件不在了：{path}（改名了就同步改这里，别让守卫空跑）");
        return File.ReadAllText(path);
    }

    /// <summary>
    /// 从 <paramref name="begin"/> 截到 <paramref name="end"/>。锚不到就报错，
    /// 不许静默退化成扫全文——散扫的话随便哪句注释都能让守卫变绿。
    /// </summary>
    private static string Window(string source, string begin, string end)
    {
        var from = source.IndexOf(begin, StringComparison.Ordinal);
        Assert.True(from >= 0, $"锚点不见了：{begin}。改了写法就同步改守卫，别让它扫了个寂寞");
        var to = source.IndexOf(end, from, StringComparison.Ordinal);
        Assert.True(to > from, $"锚点不见了：{end}");
        return source[from..to];
    }

    [Fact]
    public void 认领已有条目时必须连来源一起认()
    {
        var source = ReadImportService();

        // 报告 id 在不同 CDS 上可以重名。只按 (库, 报告id) 认领，会让从 CDS-B 拉回来的正文
        // 直接盖掉那条来自 CDS-A 的条目——A 的那一份就此消失，没有任何报错。
        // 调度那一侧已经按 (报告id, 来源) 排目标了（见 CdsReportSyncTargets.Build 的去重键），
        // 认领这一侧必须用同一个身份，否则等于「排了两份、写成一份」（Codex review P1）。
        var lookup = Window(
            source,
            "private async Task<DocumentEntry?> FindExistingEntryAsync(",
            "private async Task<(string baseUrl, string key)> ResolveCdsCredentialsAsync");

        Assert.Contains("Metadata.cdsReportId", lookup);
        // 同源的那一条优先——这一句就是身份里的「来源」那一维。删掉它，认领就退回
        // 只按 (库, 报告id)，B 的正文会盖掉 A 的条目。
        Assert.Contains("f.Eq(\"Metadata.cdsSourceBaseUrl\", baseUrl)", lookup);
        // 老条目（本改动之前存进来的）没记来源，必须认领得到；不认领的话每小时新插一条，
        // 一份报告变两份。
        Assert.Contains("Exists(\"Metadata.cdsSourceBaseUrl\", false)", lookup);

        // 而且正文那一路真的走这个函数，不是留着旧的两键过滤自己拼一份。
        Assert.Contains("await FindExistingEntryAsync(store.Id, r.Id, baseUrl, ct)", source);
    }

    [Fact]
    public void 没记来源又有多条连接时不许挑一条接着拉()
    {
        var source = ReadImportService();

        // 判据在 CdsReportSyncTargets.PickDefaultSource 有真单测；这里守的是「服务真的照着它走」。
        // 断掉的话服务退回「挑最近更新的那条 active 连接」，自动刷新每小时猜一次，猜错不响。
        var resolve = Window(
            source,
            "private async Task<(string baseUrl, string key)> ResolveCdsCredentialsAsync",
            "private async Task<DocumentStore> ResolveStoreAsync");

        Assert.Contains("CdsReportSyncTargets.PickDefaultSource(", resolve);
        Assert.Contains("allowGuess: !opts.RejectAmbiguousSource", resolve);
        Assert.Contains("CdsSourcePick.Ambiguous", resolve);
        // 只有一条连接时照样能用——否则装了一条连接的人反而刷不动了。
        Assert.Contains("CdsSourcePick.Single", resolve);

        // worker 那侧必须真的把这个开关打开，否则上面整段是死代码。
        Assert.Contains("RejectAmbiguousSource = true", ReadWorker());
    }

    [Fact]
    public void 自动刷新不许改跨库同步的那四个展示字段()
    {
        var source = ReadImportService();

        // 那四个字段归 peer-sync 所有。人手动点一次导入时顺带改写还说得过去（是他刚做的事）；
        // 改成每小时自动跑之后，一个既走 peer-sync 又存过 CDS 报告的库，其真正的对端同步状态
        // 会被每小时覆盖成「CDS 验收中心」，用户再也看不到对端同步到底成没成（Codex review P2）。
        var updateWindow = Window(
            source,
            "var updates = new List<UpdateDefinition<DocumentStore>>",
            "await _db.DocumentStores.UpdateOneAsync(");

        Assert.Contains("if (!opts.SkipPeerSyncDisplayFields)", updateWindow);
        // 四个字段都得在那个 if 里面——漏一个就是每小时还在盖一个。
        var guarded = updateWindow[updateWindow.IndexOf("if (!opts.SkipPeerSyncDisplayFields)", StringComparison.Ordinal)..];
        foreach (var field in new[] { "PeerSyncStatus", "PeerSyncNodeName", "PeerSyncNodeBaseUrl", "PeerSyncLastResult" })
            Assert.Contains($"s.{field}", guarded);

        // 而**来源字段与水位**不在这道闸里：它们是自动刷新赖以工作的状态，
        // 一起关掉的话每一轮都在从头猜源、从头全量扫。
        var beforeGuard = updateWindow[..updateWindow.IndexOf("if (!opts.SkipPeerSyncDisplayFields)", StringComparison.Ordinal)];
        Assert.Contains("s.CdsReportSourceBaseUrl, baseUrl", beforeGuard);

        Assert.Contains("SkipPeerSyncDisplayFields = true", ReadWorker());
    }

    [Fact]
    public void 一份报告导入失败就得算失败_不能只认抛出来的异常()
    {
        var worker = ReadWorker();

        // 导入服务把「正文 404」「资产归一化炸了」这类错误记进 result.Failed 而**不抛**。
        // 只在 catch 里计失败的话，这些全被计成「刷了 N 份」，本轮结束那行日志于是永远报成功，
        // 一份都没真刷进去也看不出来（Codex review P2）。
        var loop = Window(worker, "foreach (var t in targets)", "[CdsReportImportWorker] 本轮结束");

        Assert.Contains("if (result.Failed > 0) failed++; else ok++;", loop);
        // 反面对照：别把 ok++ 又无条件写回去。整个循环里 ok++ 只该出现在上面那个三目里一次。
        Assert.Equal(1, loop.Split("ok++").Length - 1);
    }

    private static string FindSrcRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null)
        {
            var candidate = Path.Combine(dir.FullName, "prd-api", "src");
            if (Directory.Exists(candidate)) return candidate;
            candidate = Path.Combine(dir.FullName, "src");
            if (Directory.Exists(candidate) && File.Exists(Path.Combine(dir.FullName, "PrdAgent.sln")))
                return candidate;
            dir = dir.Parent;
        }
        return Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "src"));
    }
}
