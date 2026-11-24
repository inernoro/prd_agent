using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// 模型可见性这条链上剩下的两处接线（Codex，2026-09-15）：
///
/// 1. 落库要过租约闸。worker 可能在模型流刚起步时就丢了租约、恢复 worker 已接管，
///    而缓冲里的 model 分片才姗姗到达；不设闸，掉队的 worker 会覆盖新 worker 的模型
///    并推一条骗人的事件。相邻的 phase / 产物写入本来就设了闸（形状 3：判据分裂）。
/// 2. Redis 投影不可用时的 Mongo 兜底要补发 model 事件。值就在库里，不补的话
///    「读不到模型」长得跟「这次没有模型」一模一样（形状 10：静默降级）。
/// </summary>
public sealed class DesignArtifactModelFencingTests
{
    private static string ReadApiFile(params string[] relative)
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory != null
               && !Directory.Exists(Path.Combine(directory.FullName, "prd-api", "src", "PrdAgent.Api")))
            directory = directory.Parent;
        Assert.NotNull(directory);
        var segments = new[] { directory!.FullName, "prd-api", "src", "PrdAgent.Api" }
            .Concat(relative)
            .ToArray();
        var path = Path.Combine(segments);
        Assert.True(File.Exists(path), $"找不到 {path}");
        return File.ReadAllText(path);
    }

    [Fact]
    public void ResolvedModelIsPersistedBehindTheSameLeaseFenceAsPhase()
    {
        var worker = ReadApiFile("Services", "HostedSiteEditRunWorker.cs");

        var start = worker.IndexOf("PersistResolvedModelAsync(\n        MongoDbContext db", StringComparison.Ordinal);
        if (start < 0) start = worker.IndexOf("internal static async Task<bool> PersistResolvedModelAsync", StringComparison.Ordinal);
        Assert.True(start > 0, "模型落库没有走独立的带闸方法");
        var body = worker.Substring(start, Math.Min(1200, worker.Length - start));

        // 与 PersistPhaseAsync 逐条同判据：状态、租约持有者、租约未过期。
        Assert.Contains("x.Status == RunStatuses.Running", body, StringComparison.Ordinal);
        Assert.Contains("x.LeaseOwnerId == leaseOwner", body, StringComparison.Ordinal);
        Assert.Contains("x.LeaseExpiresAt > updatedAt", body, StringComparison.Ordinal);
        Assert.Contains("write.ModifiedCount == 1", body, StringComparison.Ordinal);

        // 没命中就得停手，而不是继续往流里写一条骗人的事件。
        var callSite = worker.IndexOf("PersistResolvedModelAsync(\n                            db", StringComparison.Ordinal);
        Assert.True(callSite > 0, "调用点没找到，闸可能没接上");
        var call = worker.Substring(callSite, Math.Min(700, worker.Length - callSite));
        Assert.Contains("DesignArtifactRunLeaseLostException", call, StringComparison.Ordinal);
        Assert.True(
            call.IndexOf("DesignArtifactRunLeaseLostException", StringComparison.Ordinal)
                < call.IndexOf("AppendEventAsync", StringComparison.Ordinal),
            "租约判定必须排在推事件之前，否则掉队的 worker 照样能推出去");
    }

    [Theory]
    [InlineData("DesignArtifactsController.cs", "生成流")]
    [InlineData("HostedSiteEditsController.cs", "改写流")]
    public void MongoFallbackReplaysTheResolvedModel(string file, string label)
    {
        var source = ReadApiFile("Controllers", "Api", file);

        // companion：这确实是那段读快照补事件的兜底，不是别的代码。
        Assert.Contains("lastMongoPhase", source, StringComparison.Ordinal);
        Assert.Contains("\"phase\"", source, StringComparison.Ordinal);

        Assert.True(source.Contains("snapshot.ResolvedModel", StringComparison.Ordinal),
            $"{label}的 Mongo 兜底没有从快照读回模型，Redis 挂了徽章就无声消失");
        Assert.True(source.Contains("lastMongoModel", StringComparison.Ordinal),
            $"{label}的 Mongo 兜底没有对模型事件去重，会每轮重复推送");
        Assert.True(source.Contains("snapshot.ResolvedPlatform", StringComparison.Ordinal),
            $"{label}的 Mongo 兜底只补了模型名、没带平台");
    }

    /// <summary>
    /// 同一段兜底还漏了另一个字段：正常路径的 done 事件带 destinationApplyError，
    /// 前端据此提醒「页面留在了个人空间」。兜底这条不带，就是把一次「站建好了、
    /// 但没归到目标团队」报成完全成功——降级路径产出的结果与正常结果分不开
    /// （形状 10；Codex P2，2026-09-16）。
    /// </summary>
    [Fact]
    public void MongoFallbackKeepsTheDestinationFailureOnTheTerminalEvent()
    {
        var source = ReadApiFile("Controllers", "Api", "DesignArtifactsController.cs");

        // companion：先锚定到兜底里那条 done，而不是别处的 done。
        var marker = source.IndexOf("status = HostedSiteRevisionStatuses.Draft,", StringComparison.Ordinal);
        Assert.True(marker > 0, "找不到兜底的终态事件，判据可能已经挂错地方");
        var window = source.Substring(
            Math.Max(0, marker - 600),
            Math.Min(900, source.Length - Math.Max(0, marker - 600)));

        Assert.True(
            window.Contains("destinationApplyError", StringComparison.Ordinal),
            "Mongo 兜底的 done 没带 destinationApplyError，归属失败会被报成完全成功");
        Assert.True(
            window.Contains("snapshot.DestinationApplyError", StringComparison.Ordinal),
            "destinationApplyError 必须取自快照，值本来就在库里");
    }
}
