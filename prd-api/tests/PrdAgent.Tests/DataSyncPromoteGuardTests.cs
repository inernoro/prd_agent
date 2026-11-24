using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 试跑转正那段流程的接线守卫。
///
/// 为什么是源码守卫而不是行为测试：转正整段都在 Controller 里，要跑起来得有真 Mongo
/// 和真票据仓，搬进单测项目的代价远大于收益。但这两条**删掉之后全量测试仍然全绿**，
/// 按「改动删掉后测试仍全绿就需要一条守卫」的判据，它们必须有守卫。
///
/// 守卫锚在**窗口**里而不是散着扫字面量：只扫「文件里有没有这个词」的话，注释里提一嘴
/// 就能骗过去。这里先定位到那一段，再在段内断言。
/// </summary>
public class DataSyncPromoteGuardTests
{
    private static string ReadController()
    {
        var path = Path.Combine(
            DataSyncScopeCoverageTests.LocateSrcRootForTests(),
            "PrdAgent.Api", "Controllers", "Api", "DataSyncConsumerController.cs");
        Assert.True(File.Exists(path), $"找不到 DataSyncConsumerController.cs：{path}");
        return File.ReadAllText(path);
    }

    /// <summary>从锚点往后取一段，锚点找不到就直接失败（别静默扫过整个文件）。</summary>
    private static string WindowAfter(string source, string anchor, int length)
    {
        var i = source.IndexOf(anchor, StringComparison.Ordinal);
        Assert.True(i >= 0, $"找不到锚点，转正那段被改写过，守卫要跟着更新：{anchor}");
        return source.Substring(i, Math.Min(length, source.Length - i));
    }

    [Fact]
    public void 真跑照抄试跑冻结的覆盖策略_不用请求里带的那个()
    {
        // 对照表里的「预计新增 / 预计更新」和跳过数，都是按试跑那次的 OverwriteExisting
        // 算出来的。转正时换成覆盖，那批「本来会跳过」的记录会被真的写掉，而这些破坏性
        // 写入一次都没被预览过（Codex review P1）。
        var window = WindowAfter(ReadController(), "var child = new DataSyncRun", 1600);
        Assert.Contains("OverwriteExisting = run.OverwriteExisting", window);
        Assert.DoesNotContain("OverwriteExisting = request.Overwrite", window);
    }

    [Fact]
    public void 策略与试跑不一致时直接拒绝_并说清怎么才行()
    {
        // 静默照抄对用户同样是撒谎：他明明改了开关，系统当没看见。所以要拒、要说清。
        var source = ReadController();
        Assert.Contains("DATA_SYNC_PROMOTE_POLICY_CHANGED", source);
        var window = WindowAfter(source, "if (request.Overwrite != run.OverwriteExisting)", 700);
        Assert.Contains("重新试跑", window);
    }

    [Fact]
    public void 激活子记录一行都没改到时_走和抛异常同一套补偿()
    {
        // 票据在最初那次查库之后过期的话，清扫器会把这条 pending 收走，于是条件更新
        // 匹配不到任何文档、`ModifiedCount == 0`、**不抛异常**。上一版把返回值整个丢掉，
        // 接口照样回「status: running」——而父记录已经永久转正到一条永远不会被执行的
        // 子记录上，那唯一一次机会就此作废（Codex review P1）。
        var source = ReadController();
        var window = WindowAfter(source, "UpdateResult activated;", 2000);
        Assert.Contains("activated.ModifiedCount == 0", window);
        // 两条路必须汇到同一个补偿函数：各写一份迟早改一处忘一处（形状 3）。
        Assert.Contains("CompensateAsync", window);
    }

    [Fact]
    public void 补偿只有一处实现_两条失败路径共用()
    {
        var source = ReadController();
        // 一个定义（本地函数）+ 至少两个调用点。定义被复制成两份时这里会变成 3 个以上。
        var definitions = CountOccurrences(source, "async Task<IActionResult> CompensateAsync(");
        Assert.True(definitions == 1, $"补偿函数应当只有一处定义，实际 {definitions} 处");
        var calls = CountOccurrences(source, "await CompensateAsync(");
        Assert.True(calls >= 2, $"补偿应当被两条失败路径共用，实际只有 {calls} 个调用点");
    }

    [Theory]
    [InlineData(true, "覆盖")]
    [InlineData(false, "跳过")]
    public void 覆盖策略的说法两处共用_不许一处说覆盖另一处说替换(bool overwrite, string expected)
    {
        Assert.Contains(expected, PrdAgent.Core.DataSync.DataSyncOverwriteWording.Describe(overwrite));
    }

    private static int CountOccurrences(string haystack, string needle)
    {
        var n = 0;
        var i = 0;
        while ((i = haystack.IndexOf(needle, i, StringComparison.Ordinal)) >= 0) { n++; i += needle.Length; }
        return n;
    }
}
