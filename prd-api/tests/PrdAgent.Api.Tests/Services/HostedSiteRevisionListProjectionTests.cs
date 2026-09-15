using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// 版本记录里带着整页 HTML 与整包文件字节（byte[]），而版本列表一次取 100 条、
/// 对外只映射元数据。不在查询里排除这两个字段，光是打开版本面板就会读出并分配
/// 几百兆，卡顿甚至打爆 API 进程（Codex P1，2026-09-15）。
///
/// 返回类型仍是实体，所以「哪些字段是空的」必须是写进契约的事，不能只在实现里
/// 偷偷 Project 掉——那就成了「看着完整、其实被掏空」的又一处静默降级。
/// 这条守卫同时钉住三件：查询排除了、契约写明了、唯一的消费方没有去读它们。
/// </summary>
public sealed class HostedSiteRevisionListProjectionTests
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
    public void ListQueryExcludesTheHeavyFields()
    {
        var service = ReadRepoFile("PrdAgent.Infrastructure", "Services", "HostedSiteRevisionService.cs");
        var start = service.IndexOf("public async Task<IReadOnlyList<HostedSiteRevision>> ListAsync(",
            StringComparison.Ordinal);
        Assert.True(start > 0, "ListAsync 不见了，契约可能被挪走了");
        var body = service.Substring(start, Math.Min(1200, service.Length - start));

        // companion：确实截到了那段（它带着 100 条上限）。
        Assert.Contains("Limit(100)", body, StringComparison.Ordinal);

        Assert.True(body.Contains("Exclude(x => x.Html)", StringComparison.Ordinal),
            "版本列表没有排除整页 HTML，一次取 100 条会把它们全读进内存");
        Assert.True(body.Contains("Exclude(x => x.VerifiedFiles)", StringComparison.Ordinal),
            "版本列表没有排除文件字节数组");
    }

    [Fact]
    public void ContractSaysTheListIsMetadataOnly()
    {
        var contract = ReadRepoFile("PrdAgent.Core", "Interfaces", "IHostedSiteRevisionService.cs");
        var start = contract.IndexOf("Task<IReadOnlyList<HostedSiteRevision>> ListAsync(", StringComparison.Ordinal);
        Assert.True(start > 0);
        // 文档注释在声明之前，往回截一段。
        var doc = contract[Math.Max(0, start - 1200)..start];
        Assert.Contains("只带元数据", doc, StringComparison.Ordinal);
        Assert.Contains("VerifiedFiles", doc, StringComparison.Ordinal);
    }

    [Fact]
    public void TheOnlyConsumerProjectsMetadataOnly()
    {
        var controller = ReadRepoFile("PrdAgent.Api", "Controllers", "Api", "HostedSiteEditsController.cs");
        var start = controller.IndexOf("private static object ToDto(HostedSiteRevision item", StringComparison.Ordinal);
        Assert.True(start > 0, "版本 DTO 不见了");
        var body = controller.Substring(start, Math.Min(900, controller.Length - start));

        // companion：确实是那个 DTO（它算 isCurrent）。
        Assert.Contains("isCurrent", body, StringComparison.Ordinal);
        Assert.DoesNotContain("item.Html", body, StringComparison.Ordinal);
        Assert.DoesNotContain("item.VerifiedFiles", body, StringComparison.Ordinal);
    }
}
