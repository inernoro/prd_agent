using PrdAgent.Api.Services;
using Xunit;

namespace PrdAgent.Api.Tests;

/// <summary>
/// 守的是「OpenDesign 生成的 9–12 分钟里进度不再停在 18%」（2026-09-23 用户报告）。
/// 用真实的阶段事件序列回放（CDS 约每 3 秒发一条 open_design_running），断言进度只增不减、
/// 首轮设计期间持续往前走、阶段文案带着用时、更新条数远低于生命周期上限。
/// 红绿闭环：把执行器里新增的 status 分支删掉，接线守卫会红；把 Observe 改成恒返回 null，回放用例会红。
/// </summary>
public sealed class OpenDesignStageProgressTests
{
    private static List<OpenDesignProgressUpdate> Replay(
        OpenDesignStageProgress tracker,
        IEnumerable<(string Reason, int? Elapsed, int? Attempt)> events)
    {
        var updates = new List<OpenDesignProgressUpdate>();
        foreach (var (reason, elapsed, attempt) in events)
        {
            var update = tracker.Observe(reason, elapsed, attempt);
            if (update != null)
                updates.Add(update);
        }
        return updates;
    }

    private static IEnumerable<(string, int?, int?)> Running(int seconds)
    {
        for (var t = 0; t <= seconds; t += 3)
            yield return ("open_design_running", t, null);
    }

    private static IEnumerable<(string, int?, int?)> TypicalGenerate()
    {
        yield return ("workspace_downloading", null, null);
        yield return ("workspace_materialized", null, null);
        yield return ("container_starting", null, null);
        yield return ("container_ready", null, null);
        yield return ("open_design_importing", null, null);
        yield return ("open_design_run_starting", null, null);
        foreach (var e in Running(480)) yield return e;
        yield return ("open_design_reviewing", null, null);
        foreach (var e in Running(120)) yield return e;
        yield return ("workspace_collecting", null, null);
        yield return ("deliverable_entry_resolved", null, null);
        yield return ("workspace_committing", null, null);
    }

    [Fact]
    public void 一次典型生成的进度全程只增不减且不越过收尾区间()
    {
        var updates = Replay(new OpenDesignStageProgress(editing: false, startProgress: 18), TypicalGenerate());

        Assert.NotEmpty(updates);
        for (var i = 1; i < updates.Count; i++)
            Assert.True(updates[i].Progress >= updates[i - 1].Progress, $"第 {i} 条进度倒退");
        Assert.All(updates, u => Assert.InRange(u.Progress, 18, OpenDesignStageProgress.MaxProgress));
        Assert.Equal(85, updates[^1].Progress);
        Assert.Equal("正在提交产物", updates[^1].Phase);
    }

    [Fact]
    public void 首轮设计期间进度持续往前走而不是停在一个数上()
    {
        var tracker = new OpenDesignStageProgress(editing: false, startProgress: 18);
        Replay(tracker, TypicalGenerate().Take(6));
        var atStart = tracker.Progress;

        var designing = Replay(tracker, Running(480));

        Assert.True(designing.Count >= 20, $"8 分钟只出了 {designing.Count} 条更新，用户仍会以为卡住");
        Assert.True(tracker.Progress >= atStart + 30, $"8 分钟只从 {atStart} 走到 {tracker.Progress}");
        Assert.All(designing.Skip(1), u => Assert.Contains("已运行", u.Phase));
        Assert.Contains("8 分 00 秒", designing[^1].Phase);
    }

    [Fact]
    public void 同一个15秒窗口里的多条运行事件只写一次()
    {
        var tracker = new OpenDesignStageProgress(editing: false, startProgress: 18);
        tracker.Observe("open_design_run_starting", null, null);

        var first = tracker.Observe("open_design_running", 15, null);
        var same = tracker.Observe("open_design_running", 18, null);
        var next = tracker.Observe("open_design_running", 30, null);

        Assert.NotNull(first);
        Assert.Null(same);
        Assert.NotNull(next);
    }

    [Fact]
    public void 整次生成的写入条数远低于生命周期上限()
    {
        var updates = Replay(new OpenDesignStageProgress(editing: false, startProgress: 18), TypicalGenerate());

        // 生命周期服务每个 run 最多保留 1000 条非权威事件；15 分钟上限的运行不该逼近它。
        Assert.InRange(updates.Count, 20, 120);
    }

    [Fact]
    public void 修复回路回到运行中时进度不能倒退且文案说明第几次修复()
    {
        var tracker = new OpenDesignStageProgress(editing: false, startProgress: 18);
        Replay(tracker, TypicalGenerate().TakeWhile(e => e.Item1 != "workspace_collecting"));
        var beforeRepair = tracker.Progress;

        var repair = Replay(tracker, new (string, int?, int?)[]
        {
            ("open_design_quality_repairing", null, 1),
            ("open_design_running", 3, null),
            ("open_design_running", 45, null),
        });

        Assert.NotEmpty(repair);
        Assert.All(repair, u => Assert.True(u.Progress >= beforeRepair));
        Assert.Contains("第 1 次", repair[0].Phase);
    }

    [Fact]
    public void 认不出的阶段不编造进度()
    {
        var tracker = new OpenDesignStageProgress(editing: false, startProgress: 18);

        Assert.Null(tracker.Observe("something_new_from_cds", 30, null));
        Assert.Null(tracker.Observe(null, null, null));
        Assert.Equal(18, tracker.Progress);
    }

    [Fact]
    public void 修改已有页面时文案说的是修改而不是设计新页面()
    {
        var tracker = new OpenDesignStageProgress(editing: true, startProgress: 18);
        tracker.Observe("open_design_run_starting", null, null);

        var update = tracker.Observe("open_design_running", 30, null);

        Assert.NotNull(update);
        Assert.StartsWith("OpenDesign 正在修改页面", update!.Phase);
    }

    [Fact]
    public void 起始进度高于阶段目标时沿用起始进度()
    {
        var tracker = new OpenDesignStageProgress(editing: false, startProgress: 40);

        var update = tracker.Observe("container_ready", null, null);

        Assert.NotNull(update);
        Assert.Equal(40, update!.Progress);
    }

    [Theory]
    [InlineData(0, "0 秒")]
    [InlineData(59, "59 秒")]
    [InlineData(60, "1 分 00 秒")]
    [InlineData(605, "10 分 05 秒")]
    public void 用时格式对人友好(int seconds, string expected)
        => Assert.Equal(expected, OpenDesignStageProgress.FormatElapsed(seconds));

    private static string Source(params string[] relative)
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null)
        {
            var candidate = Path.Combine(new[] { dir.FullName }.Concat(relative).ToArray());
            if (File.Exists(candidate)) return File.ReadAllText(candidate);
            dir = dir.Parent;
        }
        throw new FileNotFoundException($"定位不到 {string.Join('/', relative)}——守卫本身失效了，请修这里而不是删掉它");
    }

    [Fact]
    public void 接线守卫_执行器必须把status事件交给进度翻译器_worker必须写入phase分片()
    {
        var executor = Source("prd-api", "src", "PrdAgent.Api", "Services", "DesignArtifactExecutor.cs");
        var worker = Source("prd-api", "src", "PrdAgent.Api", "Services", "HostedSiteEditRunWorker.cs");

        Assert.Contains("case InfraAgentEventTypes.Status:", executor);
        Assert.Contains("stageProgress.Observe(", executor);
        Assert.Contains("chunk.Type == \"phase\"", worker);
    }
}
