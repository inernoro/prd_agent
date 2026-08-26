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
    /// 把连续空白压成一个空格，好让断言能跨行把「条件」和「它守着的那一句」绑在一起，
    /// 而不必写死换行符（`\n` 与 `\r\n` 在不同检出下不一样）。
    /// </summary>
    private static string Squash(string source)
        => string.Join(' ', source.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));

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

        Assert.Contains("SkipPeerSyncDisplayFields = true", ReadWorker());
    }

    [Fact]
    public void 定点刷新不许写库级来源_否则两台cds会每小时轮流清掉水位()
    {
        var source = ReadImportService();

        // 库级来源与水位是「默认全量镜像」那一路的状态，配对使用。定点刷新也去写库级来源的话，
        // 库里有两台 CDS 的报告时，每小时的定点刷新会一份接一份把它改成自己那台，
        // 下一份进来一看「换源了」就清一次水位——两台交替，水位每小时被清掉，
        // 而它同时还是跨库同步的「上次同步时间」（Codex review P2）。
        var squashed = Squash(source);
        // 带过滤的导入（指定项目 / 指定报告）一律不碰库级来源与「换没换源」。
        Assert.Contains("var sourceChanged = !isTargetedImport && CdsReportSyncTargets.SourceChanged(", squashed);
        Assert.Contains("var isDefaultScopeImport = !isTargetedImport && !sourceChanged;", squashed);
        // 写库级来源那一句必须被这道闸罩住——断言得把闸和它守着的那一句绑在一起，
        // 分开断言会被别处的同款表达式替作证（这个坑本文件上一轮刚踩过一次）。
        Assert.Contains(
            "if (!isTargetedImport) { // 记下这次全量镜像是从哪个 CDS 拉的",
            squashed);
        Assert.Contains(
            "updates.Add(Builders<DocumentStore>.Update.Set(s => s.CdsReportSourceBaseUrl, baseUrl)); }",
            squashed);
    }

    [Fact]
    public void 一条脏元数据不许掀掉整轮()
    {
        var worker = ReadWorker();
        var squashed = Squash(worker);

        // 条目的 Metadata 可被通用的元数据更新接口写成任意 BSON（null、数字、嵌套文档）。
        // 直接 AsString 会抛，而这段在逐份报告的 try/catch **之外**——一条脏数据就让
        // 整轮所有库都不刷，且每小时准时复发（Codex review P2）。
        var loop = Window(worker, "var mirrored = new List<CdsMirroredReport>();", "var targets = CdsReportSyncTargets.Build(");
        Assert.DoesNotContain(".AsString", loop);
        Assert.Contains("ReadMetaString(d, \"cdsReportId\")", loop);
        Assert.Contains("ReadMetaString(d, \"cdsSourceBaseUrl\")", loop);

        // 读取前先验类型，认不出来就当没有——只判非空是不够的，BsonNull 非空但 AsString 照抛。
        Assert.Contains("if (meta == null || !meta.IsBsonDocument) return null;", squashed);
        Assert.Contains("if (value == null || !value.IsString) return null;", squashed);
    }

    [Fact]
    public void 空跑一轮不许把镜像库顶到知识库列表最前面()
    {
        var source = ReadImportService();
        var squashed = Squash(source);

        // 知识库列表按库的「最后修改时间」倒序排。无条件更新它 = 每小时那一轮跑完，
        // CDS 镜像库就被顶到最前面，哪怕一份都没变、甚至一份都没刷到；用户手改过的库
        // 反而被挤下去（Codex review P2）。
        //
        // 断言把条件和它守着的那一句绑在一起——本文件已经因为分开断言漏过一次。
        Assert.Contains(
            "if (result.Imported > 0 || result.Updated > 0) updates.Add(Builders<DocumentStore>.Update.Set(s => s.UpdatedAt, DateTime.UtcNow));",
            squashed);

        // 而且 updates 是从空开始的：留着初始化里那一条，上面的条件就是死代码。
        Assert.Contains("var updates = new List<UpdateDefinition<DocumentStore>>();", squashed);

        // 全都没得写的那一轮别发空更新——空 Combine 拼不出合法的更新语句。
        Assert.Contains("if (updates.Count > 0) { await _db.DocumentStores.UpdateOneAsync(", squashed);
    }

    [Fact]
    public void 一份报告一旦开始写就写完_停机信号不许从中间掐断()
    {
        var worker = ReadWorker();

        // 导入一份报告是多步写：存正文、插条目、给库的条目计数加一。把 stoppingToken 透进去，
        // 优雅重启时可能停在「条目插了、计数没加」，留下对不上的计数和没人引用的正文
        //（Codex review P2；也是 server-authority 那条「数据库写操作用 CancellationToken.None」）。
        var call = Window(worker, "var result = await importer.ImportAsync(", "catch (OperationCanceledException)");
        Assert.Contains("CancellationToken.None);", call);
        // 取消只在两份报告之间判——这一句还得在，否则停机时整轮跑完才退。
        Assert.Contains("if (ct.IsCancellationRequested) return;", Window(worker, "foreach (var t in targets)", "var result = await importer.ImportAsync("));
    }

    [Fact]
    public void 一份报告导入失败就得算失败_不能只认抛出来的异常()
    {
        var worker = ReadWorker();

        // 导入服务把「正文 404」「资产归一化炸了」这类错误记进 result.Failed 而**不抛**。
        // 只在 catch 里计失败的话，这些全被计成「刷了 N 份」，本轮结束那行日志于是永远报成功，
        // 一份都没真刷进去也看不出来（Codex review P2）。
        var loop = Window(worker, "foreach (var t in targets)", "[CdsReportImportWorker] 本轮结束");

        Assert.Contains("if (result.Failed > 0) failed++;", loop);
        // 一份都没列到（报告在 CDS 上被删了）同样不算刷成功——它的 Total 与 Failed 都是 0，
        // 不单立一类就会被计进 ok，日志每小时报一次假的成功。
        Assert.Contains("else if (result.Total == 0) missing++;", loop);
        // 而且**每一份都要说出来**：它天生不会进 Updated>0 那个日志分支，不单独说等于没说。
        //
        // 断言必须把 LogWarning 和它的条件绑在一起。只分开断言「有 result.Total == 0」和
        // 「有 LogWarning」是不成立的证据——上面那句 `else if (result.Total == 0) missing++;`
        // 会替条件作证，于是把 if 改成 `if (false)` 也照样绿（第一次写就栽在这里）。
        Assert.Contains("if (result.Total == 0) { _logger.LogWarning(", Squash(loop));
        // 反面对照：别把 ok++ 又无条件写回去。整个循环里 ok++ 只该出现在上面那串条件里一次。
        Assert.Equal(1, loop.Split("ok++").Length - 1);

        // 本轮结束那行必须把三类都报出来，否则单立一类等于白立。
        var summary = Window(worker, "[CdsReportImportWorker] 本轮结束", "public const string CdsReportStoreAppKey");
        Assert.Contains("{Missing}", summary);
    }

    [Fact]
    public void 同一台cds换地址重新授权后_条目不该变成永久孤儿()
    {
        var source = ReadImportService();

        // 条目记的是地址，而重新授权时地址本来就可能变（仓库里 InfraAgentSessionService
        // 那段注释举的例子就是从带子域换成裸域）。只按地址找 active 连接，一次重新授权
        // 就把所有条目永久判成孤儿，每小时失败一次，直到人把每一份都重新保存（Codex review P2）。
        var resolve = Window(
            source,
            "private async Task<(string baseUrl, string key)> ResolveCdsCredentialsAsync",
            "private async Task<InfraConnection?> FindReauthorizedConnectionAsync");
        Assert.Contains("FindReauthorizedConnectionAsync(normalizedSource, ct)", resolve);

        // 判据照搬既有那条：同 partner + 同 projectId，不看地址。
        var fallback = Window(
            source,
            "private async Task<InfraConnection?> FindReauthorizedConnectionAsync",
            "private async Task<DocumentStore> ResolveStoreAsync");
        Assert.Contains("c.ProjectId, previous.ProjectId", fallback);
        // 两道收紧，防它退化成「找不到就随便挑一条」：老地址得真对应一条记录在案的连接，
        // 且那条得有 projectId（为空时按空值匹配会捞到一堆不相干的）。
        Assert.Contains("string.IsNullOrWhiteSpace(previous.ProjectId)", fallback);
        Assert.Contains("c.Id != previous.Id", fallback);
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
