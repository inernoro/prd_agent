using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// 保存分享时的复制循环，每一次离开都可能发生在「前面几个站点的对象已经上传完」之后，
/// 而它们全排在 InsertManyAsync 之前——此刻那批对象没有任何 HostedSite 认领，不登记就
/// 再也没人知道它们存在。去重那一关看的是 HostedSite，插入没发生就不算数，于是用户每
/// 重试一次都会再留下一批孤儿对象（Codex P2 x2，2026-09-15）。
///
/// 「离开」不止 return：finally 里释放借用围栏那一步（写 Mongo）抛出来的话，异常直接
/// 穿过整个方法，一个 return 都不经过。所以除了逐个出口，还要钉住外面那层
/// catch → 收尾 → 重抛——只数 return 的守卫恰恰盖不住第二条 P2 报的那个路径。
///
/// 真实行为由 DesignArtifactRunRecoveryTests 的 SaveSharedSite_ShouldDiscardCopiedObjects_*
/// 证明，但那条带 Integration 标记、CI 的测试步骤把这一档排除在外。所以这里再钉一条
/// 不依赖 Mongo 的结构守卫：循环里每一个 return 之前都必须先过同一个收尾。
/// 三个出口各写各的收尾正是判据分裂的起点，这条守卫同时挡住那种写法。
/// </summary>
public sealed class SharedSiteCopyCleanupContractTests
{
    private static string ReadRepoFile(params string[] relative)
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory != null
               && !Directory.Exists(Path.Combine(directory.FullName, "prd-api", "src")))
            directory = directory.Parent;
        Assert.NotNull(directory);
        var path = Path.Combine(new[] { directory!.FullName, "prd-api", "src" }.Concat(relative).ToArray());
        Assert.True(File.Exists(path), $"找不到 {path}");
        return File.ReadAllText(path);
    }

    [Fact]
    public void EveryEarlyExitInTheCopyLoopDiscardsAlreadyCopiedObjects()
    {
        var service = ReadRepoFile("PrdAgent.Infrastructure", "Services", "HostedSiteService.cs");
        var start = service.IndexOf("public async Task<SaveSharedSiteResult> SaveSharedSiteAsync(",
            StringComparison.Ordinal);
        Assert.True(start > 0, "SaveSharedSiteAsync 不见了，契约可能被挪走了");

        var loopStart = service.IndexOf("foreach (var original in originalSites)", start, StringComparison.Ordinal);
        Assert.True(loopStart > start, "复制循环不见了");
        var insertStart = service.IndexOf("InsertManyAsync(savedSites", loopStart, StringComparison.Ordinal);
        Assert.True(insertStart > loopStart, "InsertManyAsync 不见了");

        var loopBody = service[loopStart..insertStart];

        // companion：确实截到了复制循环（它会上传对象并登记 key）。
        Assert.Contains("copiedKeys.Add(key)", loopBody, StringComparison.Ordinal);

        // 循环体里的每一个 return，前面都必须紧跟着那一次收尾。
        var exits = 0;
        var cursor = 0;
        while (true)
        {
            var returnAt = loopBody.IndexOf("return new SaveSharedSiteResult", cursor, StringComparison.Ordinal);
            if (returnAt < 0) break;
            exits++;
            var preceding = loopBody[..returnAt];
            var discardAt = preceding.LastIndexOf("await DiscardCopiedObjectsAsync();", StringComparison.Ordinal);
            var previousReturnAt = preceding.LastIndexOf("return new SaveSharedSiteResult", StringComparison.Ordinal);
            Assert.True(
                discardAt > previousReturnAt,
                $"复制循环里第 {exits} 个出口没有先收尾：已上传的对象会成为没有主人、也没有账本的孤儿");
            cursor = returnAt + 1;
        }

        // 出口数量本身也钉住：新增一个出口而不补收尾，这条会先提醒重审。
        Assert.Equal(3, exits);
    }

    [Fact]
    public void AnEscapingExceptionAlsoDiscardsAlreadyCopiedObjects()
    {
        var service = ReadRepoFile("PrdAgent.Infrastructure", "Services", "HostedSiteService.cs");
        var start = service.IndexOf("public async Task<SaveSharedSiteResult> SaveSharedSiteAsync(",
            StringComparison.Ordinal);
        Assert.True(start > 0, "SaveSharedSiteAsync 不见了，契约可能被挪走了");

        var loopStart = service.IndexOf("foreach (var original in originalSites)", start, StringComparison.Ordinal);
        Assert.True(loopStart > start, "复制循环不见了");
        var insertStart = service.IndexOf("InsertManyAsync(savedSites", loopStart, StringComparison.Ordinal);
        Assert.True(insertStart > loopStart, "InsertManyAsync 不见了");

        // 循环之前必须有一层 try 罩着（它就在 foreach 上面几行）。
        var wrapperTry = service.LastIndexOf("try", loopStart, StringComparison.Ordinal);
        Assert.True(wrapperTry > start, "复制循环外面没有罩 try，异常会直接穿过整个方法");
        Assert.DoesNotContain(
            "return new SaveSharedSiteResult",
            service[wrapperTry..loopStart],
            StringComparison.Ordinal);

        // 循环结束到 InsertManyAsync 之间，必须有一段「收尾 + 重抛」。
        var loopEnd = service.LastIndexOf("savedSites.Add(saved);", insertStart, StringComparison.Ordinal);
        Assert.True(loopEnd > loopStart, "循环体尾部不见了");
        var betweenLoopAndInsert = service[loopEnd..insertStart];

        // companion：确实截到了循环与插入之间那一段。
        Assert.Contains("catch", betweenLoopAndInsert, StringComparison.Ordinal);

        Assert.Contains("DiscardCopiedObjectsAsync();", betweenLoopAndInsert, StringComparison.Ordinal);
        Assert.True(
            betweenLoopAndInsert.Contains("throw;", StringComparison.Ordinal),
            "收尾之后必须原样重抛：吞掉异常会让保存失败变成一次看不出来的成功");
    }
}
