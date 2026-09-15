using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// 保存分享时的复制循环有三个出口，它们都可能发生在「前面几个站点的对象已经上传完」
/// 之后，而三个出口全排在 InsertManyAsync 之前——此刻那批对象没有任何 HostedSite 认领，
/// 不登记就再也没人知道它们存在。去重那一关看的是 HostedSite，插入没发生就不算数，
/// 于是用户每重试一次都会再留下一批孤儿对象（Codex P2，2026-09-15）。
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
}
