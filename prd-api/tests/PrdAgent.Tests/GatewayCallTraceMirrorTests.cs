using PrdAgent.Core.LlmGateway;
using PrdAgent.LlmGw.LogicalModels;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 「调用全貌」面板的推演判据，与运行时真实挑选判据的**行为对照**。
///
/// 为什么必须有这条：面板的全部价值建立在「它说会落到谁，实际就落到谁」上。
/// 两份判据一旦漂了，面板给的是一份看着很确定的假话——比不给还糟，而且不会有任何东西发现。
///
/// 权威定义在 <see cref="GatewayRouteSelection"/>（ModelResolver 直接调它）；
/// 镜像在 <see cref="CallTracePlanner"/>（console-api 按既定架构不引用 PrdAgent.*，只能留一份）。
/// 本测试项目是全仓唯一同时引用两者的地方，所以对照只能在这里做。
///
/// 对照的是**行为不是源码**：扫源码只能证明那几行字面量还在，证明不了两边算出同一个答案。
/// 排序权重改了、跳过条件多了一项、tie-break 换了字段——源码扫描全都看不出来，这里会红。
/// </summary>
public sealed class GatewayCallTraceMirrorTests
{
    private static GatewayRouteSelection.RouteCandidate Core(
        string id, int priority, int weight, int health, bool enabled, bool targetUsable = true)
        => new(id, priority, weight, health, enabled, targetUsable);

    private static CallTracePlanner.RouteCandidate Mirror(
        string id, int priority, int weight, int health, bool enabled, bool targetUsable = true)
        => new(id, priority, weight, health, enabled, targetUsable);

    /// <summary>
    /// 覆盖用的输入集。每一组都对应一种真实会出现的库状态，不是随手编的排列——
    /// 排序只在「有东西能把两条线路分开」时才看得出差别，所以每组都刻意让某一级排序生效。
    /// </summary>
    public static TheoryData<string, (string Id, int Priority, int Weight, int Health, bool Enabled, bool TargetUsable)[]> Cases()
    {
        var data = new TheoryData<string, (string, int, int, int, bool, bool)[]>();
        data.Add("空线路", []);
        data.Add("单条健康", [("a", 10, 100, 0, true, true)]);
        data.Add("顺位分先后", [("a", 20, 100, 0, true, true), ("b", 10, 100, 0, true, true)]);
        data.Add("健康压过顺位", [("a", 10, 100, 1, true, true), ("b", 90, 100, 0, true, true)]);
        data.Add("同顺位同健康按标识定序", [("b", 10, 100, 0, true, true), ("a", 10, 100, 0, true, true)]);
        data.Add("熔断的不参与", [("a", 10, 100, 2, true, true), ("b", 20, 100, 0, true, true)]);
        data.Add("停用的不参与", [("a", 10, 100, 0, false, true), ("b", 20, 100, 0, true, true)]);
        data.Add("既停用又熔断", [("a", 10, 100, 2, false, true), ("b", 20, 100, 0, true, true)]);
        data.Add("全部不参与", [("a", 10, 100, 2, true, true), ("b", 20, 100, 0, false, true)]);
        data.Add("降级的仍然参与", [("a", 10, 100, 1, true, true), ("b", 20, 100, 1, true, true)]);
        data.Add("权重悬殊", [("a", 10, 90, 0, true, true), ("b", 20, 10, 0, true, true)]);
        data.Add("权重为零按一算", [("a", 10, 0, 0, true, true), ("b", 20, 0, 0, true, true)]);
        data.Add("权重为负按一算", [("a", 10, -5, 0, true, true), ("b", 20, 3, 0, true, true)]);
        data.Add("三条混合", [("a", 10, 50, 1, true, true), ("b", 10, 30, 0, true, true), ("c", 5, 20, 2, true, true)]);
        // 目标不可用：线路自己好好的，但它指向的物理模型（或所属上游）被停用了。
        // 运行时按 Offering 查目标时过滤掉它；面板必须说得出这个原因。
        // 2026-09-14 线上真实形态：default-chat 队首指向的 chat-latest 物理模型是停用的。
        data.Add("目标被停用", [("a", 10, 100, 0, true, false), ("b", 20, 100, 0, true, true)]);
        data.Add("目标被停用且自己也停用", [("a", 10, 100, 0, false, false), ("b", 20, 100, 0, true, true)]);
        data.Add("目标被停用且熔断", [("a", 10, 100, 2, true, false), ("b", 20, 100, 0, true, true)]);
        data.Add("全部目标不可用", [("a", 10, 100, 0, true, false), ("b", 20, 100, 0, true, false)]);
        data.Add("真实规模十条", Enumerable.Range(0, 10)
            .Select(i => ($"r{i:D2}", i * 10, 100 - i * 7, i % 3, i % 5 != 4, i % 7 != 3))
            .ToArray());
        return data;
    }

    [Theory]
    [MemberData(nameof(Cases))]
    public void 跳过原因_两边逐条相同(string label, (string Id, int Priority, int Weight, int Health, bool Enabled, bool TargetUsable)[] rows)
    {
        foreach (var row in rows)
        {
            var core = GatewayRouteSelection.SkipReason(Core(row.Id, row.Priority, row.Weight, row.Health, row.Enabled, row.TargetUsable));
            var mirror = CallTracePlanner.SkipReason(Mirror(row.Id, row.Priority, row.Weight, row.Health, row.Enabled, row.TargetUsable));
            Assert.Equal(core, mirror);
        }
        Assert.NotNull(label);
    }

    [Theory]
    [MemberData(nameof(Cases))]
    public void 排队顺序_两边逐条相同(string label, (string Id, int Priority, int Weight, int Health, bool Enabled, bool TargetUsable)[] rows)
    {
        var core = rows.Select(r => Core(r.Id, r.Priority, r.Weight, r.Health, r.Enabled, r.TargetUsable)).ToList();
        var mirror = rows.Select(r => Mirror(r.Id, r.Priority, r.Weight, r.Health, r.Enabled, r.TargetUsable)).ToList();

        // seed 必须扫一遍：按权重分配时旋转落点全靠它，只测一个 seed 等于只测了一种落点。
        foreach (var weighted in new[] { false, true })
        {
            foreach (var seed in new uint[] { 0, 1, 7, 99, 1000, uint.MaxValue })
            {
                var coreQueue = GatewayRouteSelection.Queue(core, weighted, seed).Select(x => x.Id).ToList();
                var mirrorQueue = CallTracePlanner.Queue(mirror, weighted, seed).Select(x => x.Id).ToList();
                Assert.Equal(coreQueue, mirrorQueue);
            }
        }
        Assert.NotNull(label);
    }

    [Theory]
    [MemberData(nameof(Cases))]
    public void 权重分配比例_两边逐条相同(string label, (string Id, int Priority, int Weight, int Health, bool Enabled, bool TargetUsable)[] rows)
    {
        var core = GatewayRouteSelection.WeightShare(
            rows.Select(r => Core(r.Id, r.Priority, r.Weight, r.Health, r.Enabled, r.TargetUsable)).ToList());
        var mirror = CallTracePlanner.WeightShare(
            rows.Select(r => Mirror(r.Id, r.Priority, r.Weight, r.Health, r.Enabled, r.TargetUsable)).ToList());
        Assert.Equal(core.Select(x => (x.Id, x.Percent)), mirror.Select(x => (x.Id, x.Percent)));
        Assert.NotNull(label);
    }

    [Theory]
    [InlineData("weighted", true)]
    [InlineData("WEIGHTED", true)]
    [InlineData("priority", false)]
    [InlineData("", false)]
    [InlineData(null, false)]
    public void 策略识别_两边相同(string? strategy, bool expected)
    {
        Assert.Equal(expected, GatewayRouteSelection.IsWeighted(strategy));
        Assert.Equal(expected, CallTracePlanner.IsWeighted(strategy));
        Assert.Equal(expected, CallTracePlanner.IsWeighted(strategy));
    }

    /// <summary>
    /// 跳过原因的文案也要对齐：它是产品语义，会直接出现在面板上。
    /// 两边各写各的文案不会让排序出错，但会让人在两个地方看到两种说法。
    /// </summary>
    [Fact]
    public void 跳过原因的文案两边逐字相同()
    {
        Assert.Equal(GatewayRouteSelection.SkipDisabled, CallTracePlanner.SkipDisabled);
        Assert.Equal(GatewayRouteSelection.SkipQuarantined, CallTracePlanner.SkipQuarantined);
        Assert.Equal(GatewayRouteSelection.SkipTargetDisabled, CallTracePlanner.SkipTargetDisabled);
        Assert.Equal(GatewayRouteSelection.HealthUnavailable, CallTracePlanner.HealthUnavailable);
    }

    /// <summary>
    /// 停用要排在熔断前面。一条既停用又熔断的线路，人要先知道它是被人关掉的——
    /// 「连续失败太多」会把人引去查上游，而那不是原因。
    /// </summary>
    [Fact]
    public void 既停用又熔断时先说停用()
    {
        var candidate = Core("x", 10, 100, GatewayRouteSelection.HealthUnavailable, enabled: false);
        Assert.Equal(GatewayRouteSelection.SkipDisabled, GatewayRouteSelection.SkipReason(candidate));
    }

    /// <summary>
    /// 跳过原因按「人该去改哪儿」排：线路自己被关掉 → 目标被关掉 → 熔断。
    /// 目标被停用时说成「连续失败太多」会把人引去查上游密钥，而那不是原因。
    /// </summary>
    [Fact]
    public void 目标被停用时说目标而不是熔断()
    {
        var quarantinedAndTargetOff = Core(
            "x", 10, 100, GatewayRouteSelection.HealthUnavailable, enabled: true, targetUsable: false);
        Assert.Equal(GatewayRouteSelection.SkipTargetDisabled,
            GatewayRouteSelection.SkipReason(quarantinedAndTargetOff));

        var healthyButTargetOff = Core("y", 10, 100, 0, enabled: true, targetUsable: false);
        Assert.Equal(GatewayRouteSelection.SkipTargetDisabled,
            GatewayRouteSelection.SkipReason(healthyButTargetOff));

        // 线路自己被关掉仍然优先：那是更直接的施动者
        var bothOff = Core("z", 10, 100, 0, enabled: false, targetUsable: false);
        Assert.Equal(GatewayRouteSelection.SkipDisabled, GatewayRouteSelection.SkipReason(bothOff));
    }

    /// <summary>
    /// 队首指向的物理模型被停用时，结论不许指着它说「会落到它」。
    /// 这是 2026-09-14 线上真实出现过的那一条：default-chat 的第 1 顺位 chat-latest
    /// 物理模型是停用的，运行时跳过它，而面板照样指着它。
    /// </summary>
    [Fact]
    public void 队首目标被停用时结论指向下一条()
    {
        var rows = new List<CallTracePlanner.RouteCandidate>
        {
            Mirror("head", 10, 100, 0, true, targetUsable: false),
            Mirror("next", 20, 100, 0, true, targetUsable: true),
        };
        var conclusion = CallTracePlanner.Conclusion(rows, weighted: false, id => $"上游-{id}");
        Assert.Contains("会落到 上游-next", conclusion);
        Assert.DoesNotContain("上游-head", conclusion);
    }

    /// <summary>
    /// 按权重分配时，结论句**不许**指名道姓说会落到谁。
    /// 运行时的 seed 由 requestId 派生，面板用固定 seed；说「会落到 A」在按权重时就是编的。
    /// </summary>
    [Fact]
    public void 按权重分配时结论只给比例不指名()
    {
        var rows = new List<CallTracePlanner.RouteCandidate>
        {
            Mirror("a", 10, 70, 0, true, true),
            Mirror("b", 20, 30, 0, true, true),
        };
        var conclusion = CallTracePlanner.Conclusion(rows, weighted: true, id => id);
        Assert.Contains("按权重", conclusion);
        Assert.Contains("70%", conclusion);
        Assert.Contains("30%", conclusion);
        Assert.DoesNotContain("会落到 a", conclusion);
    }

    /// <summary>按顺位时必须能指名道姓——这才是面板存在的理由。</summary>
    [Fact]
    public void 按顺位时结论指名道姓并说清还有几条后备()
    {
        var rows = new List<CallTracePlanner.RouteCandidate>
        {
            Mirror("b", 20, 100, 0, true, true),
            Mirror("a", 10, 100, 0, true, true),
        };
        var conclusion = CallTracePlanner.Conclusion(rows, weighted: false, id => $"上游-{id}");
        Assert.Contains("会落到 上游-a", conclusion);
        Assert.Contains("还有 1 条后备", conclusion);
    }

    /// <summary>一条都不参与时必须直说调不通，并说清是被停用还是被摘掉。</summary>
    [Fact]
    public void 全部不参与时结论直说调不通()
    {
        var allQuarantined = new List<CallTracePlanner.RouteCandidate>
        {
            Mirror("a", 10, 100, CallTracePlanner.HealthUnavailable, true, true),
            Mirror("b", 20, 100, CallTracePlanner.HealthUnavailable, true, true),
        };
        var text = CallTracePlanner.Conclusion(allQuarantined, weighted: false, id => id);
        Assert.Contains("现在调它会失败", text);
        Assert.Contains("2 条全被摘掉", text);

        var mixed = new List<CallTracePlanner.RouteCandidate>
        {
            Mirror("a", 10, 100, CallTracePlanner.HealthUnavailable, true, true),
            Mirror("b", 20, 100, 0, false, true),
        };
        var mixedText = CallTracePlanner.Conclusion(mixed, weighted: false, id => id);
        Assert.Contains("1 条被停用", mixedText);
        Assert.Contains("1 条已被摘掉", mixedText);
    }

    /// <summary>一条线路都没有时不许说「会落到」什么——没有根就别长树。</summary>
    [Fact]
    public void 没有线路时直说没有线路()
    {
        var text = CallTracePlanner.Conclusion([], weighted: false, id => id);
        Assert.Contains("还没有线路", text);
        Assert.DoesNotContain("会落到", text);
    }

    /// <summary>唯一一条线路时要说清「失败就没有后备」，不能让人以为还有兜底。</summary>
    [Fact]
    public void 只有一条线路时说清没有后备()
    {
        var text = CallTracePlanner.Conclusion([Mirror("a", 10, 100, 0, true, true)], weighted: false, id => $"上游-{id}");
        Assert.Contains("唯一一条", text);
        Assert.Contains("没有后备", text);
    }
}
