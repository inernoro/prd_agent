using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// 两条 SSE 流（生成、改写）在 Redis 批次为空时都会回到 Mongo 快照补发 phase 与 model。
/// 这两段补发**不得**被 redisProjectionAvailable 把门：那个标志只在「本 Controller 读
/// Redis 失败」时才翻，而 worker 的写入侧是独立失效的（它的 RunProjection 捕到写失败
/// 就停写）。写侧挂了、读侧好着时标志恒为 true，补发被永久抑制——用户盯着一个几分钟
/// 不动的进度，而库里一直在推进，坏的那条路产出的结果和正常结果分不开。
///
/// 这条守卫是补的：上一轮只把条件从改写流的 model 那一段拿掉，写了注释却没留判据，
/// 于是同一个文件里 phase 那一段原样留着，下一轮又被报了一次（判据分裂）。
/// 注释里可以提这个标志名，判定只看可执行的那几行。
/// </summary>
public sealed class RunStreamMongoFallbackContractTests
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

    private static string CodeWithoutComments(string source) =>
        string.Join('\n', source
            .Split('\n')
            .Where(line => !line.TrimStart().StartsWith("//", StringComparison.Ordinal)));

    [Theory]
    [InlineData("DesignArtifactsController.cs", "生成流")]
    [InlineData("HostedSiteEditsController.cs", "改写流")]
    public void MongoFallbackRepublishesPhaseAndModelRegardlessOfReaderHealth(string fileName, string streamName)
    {
        var source = ReadRepoFile("PrdAgent.Api", "Controllers", "Api", fileName);

        var start = source.IndexOf("var snapshot =", StringComparison.Ordinal);
        Assert.True(start > 0, $"{streamName}的 Mongo 兜底不见了");
        var end = source.IndexOf("if (snapshot.Status == RunStatuses.Done)", start, StringComparison.Ordinal);
        Assert.True(end > start, $"{streamName}的兜底终态分支不见了");

        var region = source[start..end];

        // companion：确实截到了补发 phase 与 model 的那一段。
        Assert.Contains("\"phase\"", region, StringComparison.Ordinal);
        Assert.Contains("\"model\"", region, StringComparison.Ordinal);
        Assert.Contains("snapshot.ResolvedModel", region, StringComparison.Ordinal);

        Assert.DoesNotContain(
            "redisProjectionAvailable",
            CodeWithoutComments(region),
            StringComparison.Ordinal);
    }
}
