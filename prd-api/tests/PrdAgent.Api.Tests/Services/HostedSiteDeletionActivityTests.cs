using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// 删除站点遇到内容发布租约时会推迟清理，返回 202 + deleted=false。
/// 但 ActivityLogActionFilter 把一切 2xx 都记成成功，WebPages.Delete 的文案是「删除了站点」——
/// 于是团队活动流会声称站点已删，而它还在（Codex P2，2026-09-15）。
///
/// 过滤器本来就为这种情况留了抑制钩子（幂等回放等「没发生新写入」的成功响应）。
/// 这条守卫盯的是：推迟分支必须用上它，别让活动流说一件没发生的事。
/// </summary>
public sealed class HostedSiteDeletionActivityTests
{
    [Fact]
    public void DeferredDeletionDoesNotLeaveACompletedDeletionInTheActivityFeed()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory != null
               && !Directory.Exists(Path.Combine(directory.FullName, "prd-api", "src", "PrdAgent.Api")))
            directory = directory.Parent;
        Assert.NotNull(directory);

        var source = File.ReadAllText(Path.Combine(directory!.FullName, "prd-api", "src", "PrdAgent.Api",
            "Controllers", "Api", "WebPagesController.cs"));

        var branch = source.IndexOf("catch (HostedSiteDeletionPendingException", StringComparison.Ordinal);
        Assert.True(branch > 0, "找不到推迟删除的分支，契约可能被挪走了");

        // companion：这个分支确实还在返回 202，否则下面那条会对着一段别的代码判绿。
        var body = source.Substring(branch, Math.Min(900, source.Length - branch));
        Assert.Contains("Status202Accepted", body, StringComparison.Ordinal);
        Assert.Contains("ActivityLogActionFilter.Suppress(HttpContext)", body, StringComparison.Ordinal);
    }
}
