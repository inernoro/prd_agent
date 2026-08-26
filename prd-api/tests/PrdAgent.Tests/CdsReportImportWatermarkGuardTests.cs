using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 换 CDS 源时，旧源的增量水位必须一起作废。
///
/// ## 守的是什么
///
/// 库上有两个「跟着源走」的字段：`PeerSyncNodeBaseUrl`（上次从哪拉）和 `PeerSyncLastAt`
/// （上次拉到哪）。导入服务在收尾时**无条件**把来源改成本轮的 baseUrl，水位却只在
/// 「默认全量镜像」那一路才回写。于是换源导入之后，库上留下的是
/// **「源 = B、水位 = A 的游标」** ——这个组合看起来完全合法，没有任何字段自相矛盾。
///
/// 每小时的自动同步照着它拉：范围是全量、源是 B，于是走进「默认全量镜像」那一路，
/// 拿着 A 的游标当 `updatedSince` 去列 B 的报告。**B 上所有更新时间早于该游标的报告
/// 被永久跳过**，一次报错都没有，库看起来一直在正常同步（Codex review P1）。
///
/// ## 为什么用源码守卫
///
/// `CdsReportImportService` 拖着 Mongo 与 HttpClient，搬不进这个测试项目；判断本身
/// （<see cref="PrdAgent.Api.Services.CdsReportSyncTargets.SourceChanged"/>）能直接跑，
/// 但**「服务真的照着它清了水位」这条接线删掉之后不会有任何测试变红**——那正是
/// predicate-and-wiring-discipline 说的「建了一半」。所以这里扫源码补上。
/// </summary>
public class CdsReportImportWatermarkGuardTests
{
    private static string ReadImportService()
    {
        var path = Path.Combine(FindSrcRoot(), "PrdAgent.Api", "Services", "CdsReportImportService.cs");
        Assert.True(File.Exists(path), $"守卫要读的源文件不在了：{path}（改名了就同步改这里，别让守卫空跑）");
        return File.ReadAllText(path);
    }

    /// <summary>
    /// 截出「拼 updates → UpdateOneAsync」这一段。
    ///
    /// 不散扫整个文件：`PeerSyncLastAt` 在这个文件里出现七八次（注释、读水位、拼查询参数），
    /// 散扫的话随便哪句注释都能让守卫变绿。锚不到就报错，不许静默退化成扫全文。
    /// </summary>
    private static string StoreUpdateWindow(string source)
    {
        const string begin = "var updates = new List<UpdateDefinition<DocumentStore>>";
        const string end = "await _db.DocumentStores.UpdateOneAsync(";
        var from = source.IndexOf(begin, StringComparison.Ordinal);
        Assert.True(from >= 0, $"锚点不见了：{begin}。改了写法就同步改守卫，别让它扫了个寂寞");
        var to = source.IndexOf(end, from, StringComparison.Ordinal);
        Assert.True(to > from, $"锚点不见了：{end}");
        return source[from..to];
    }

    [Fact]
    public void 换源时把旧水位清掉()
    {
        var window = StoreUpdateWindow(ReadImportService());

        Assert.Contains("sourceChanged", window);
        // 「设成 null」而不是「不去动它」——不动等于把 A 的游标留给 B 用。
        Assert.Contains("s.PeerSyncLastAt, (DateTime?)null", window);
    }

    [Fact]
    public void 判断换没换源只有一个来源()
    {
        var source = ReadImportService();

        // 「同一个源吗」这件事有两个消费方：能不能复用增量水位、要不要清掉旧水位。
        // 两边必须同进同退，所以只许有一处定义。抄成两份 TrimEnd('/') 比较的话，
        // 改一处忘一处就会漏出上面那条静默通路。
        Assert.Contains("CdsReportSyncTargets.SourceChanged(store.CdsReportSourceBaseUrl, baseUrl)", source);
        Assert.DoesNotContain("store.CdsReportSourceBaseUrl.TrimEnd('/')", source);

        // 而且判的是**自己那个来源字段**，不是跨库同步那套的。同一个库若走过 peer-sync，
        // `MarkPeerSyncAsync` 会把 PeerSyncNodeBaseUrl 改写成对端 MAP 的地址；
        // 拿它当 CDS 源去解析凭据必然找不到 active 连接，这个库每小时被静默跳过一次
        //（Codex review P2）。
        Assert.DoesNotContain("SourceChanged(store.PeerSyncNodeBaseUrl", source);
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
