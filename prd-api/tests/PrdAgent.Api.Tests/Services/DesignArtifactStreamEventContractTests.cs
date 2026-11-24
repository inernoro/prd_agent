using System.Text.RegularExpressions;
using PrdAgent.Api.Controllers.Api;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// 公开生成流的事件白名单，必须盖住 worker 真正产出的每一个事件（Codex P1，2026-09-15）。
///
/// 这是同一条链路上第三次漏掉中间一段：执行器发了、worker 存了、前端也会渲染，唯独 SSE 出口
/// 的白名单没加 `model`，事件在那里被静默丢掉——编译过、测试绿、面板永远空着。
/// 白名单和 worker 的 append 是两份判据，改一处忘一处不会红（判据与接线纪律 形状 2 + 形状 3）。
/// 这里把两份对齐成机械断言：worker append 了什么，白名单就得放行什么。
/// </summary>
public sealed class DesignArtifactStreamEventContractTests
{
    [Fact]
    public void EveryEventTheWorkerAppendsIsAllowedOnThePublicStream()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory != null
               && !File.Exists(Path.Combine(directory.FullName, "prd-api", "src", "PrdAgent.Api",
                   "Services", "HostedSiteEditRunWorker.cs")))
            directory = directory.Parent;
        Assert.NotNull(directory);
        var worker = File.ReadAllText(Path.Combine(directory!.FullName, "prd-api", "src", "PrdAgent.Api",
            "Services", "HostedSiteEditRunWorker.cs"));

        // AppendEventAsync(RunKinds.X, runId, "<事件名>", ...) —— 第三个实参就是事件名。
        var appended = Regex
            .Matches(worker, @"AppendEventAsync\(\s*RunKinds\.\w+\s*,\s*\w+\s*,\s*""(?<name>[a-z_]+)""")
            .Select(m => m.Groups["name"].Value)
            .ToHashSet(StringComparer.Ordinal);

        // companion：正则真的扫到了事件名，否则下面那条会对着空集合判绿。
        Assert.True(appended.Count >= 5, $"只扫到 {appended.Count} 个事件名，正则多半失配了");
        Assert.Contains("model", appended);

        var missing = appended.Except(DesignArtifactsController.PublicGenerationStreamEvents).ToArray();
        Assert.Empty(missing);
    }
}
