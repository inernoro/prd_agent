using PrdAgent.Core.Analytics;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 时间窗解析的守卫。
///
/// 为什么必须有：team-insights 原本 12 处查询全是 <c>&gt;= start</c> 开区间，没有任何上界，
/// <c>meta.to</c> 只是响应时刻。周报按 ISO 周取数时，周一跑上周的报告会把本周的数据一起卷进去，
/// 而这种错误编译过、返回 200、数字看着有——只有断言能拦住。
/// </summary>
public class InsightWindowTests
{
    private static readonly DateTime Now = new(2026, 8, 5, 9, 30, 0, DateTimeKind.Utc);

    [Fact]
    public void 精确区间_to按闭区间最后一天理解()
    {
        // 周报口径是 MONDAY ~ SUNDAY 两个日期文本、两端都含。转成开区间右边界要 +1 天，
        // 少加这一天，周日一整天的数据会整体丢失。
        var w = InsightWindowResolver.Resolve(new DateTime(2026, 7, 27), new DateTime(2026, 8, 2), 0, Now);

        Assert.NotNull(w);
        Assert.True(w!.Bounded);
        Assert.Equal(new DateTime(2026, 7, 27), w.Start);
        Assert.Equal(new DateTime(2026, 8, 3), w.End);
        Assert.Equal(7, w.SpanDays);
    }

    [Fact]
    public void 精确区间_不把本周数据卷进上周()
    {
        // 事故形态：周一(8/3)跑上周(7/27~8/2)的周报，窗口右边界必须停在 8/3 00:00，
        // 而不是"今天"。停不住就等于周报纪律 1 被绕过。
        var w = InsightWindowResolver.Resolve(new DateTime(2026, 7, 27), new DateTime(2026, 8, 2), 0, Now)!;

        Assert.True(w.End <= new DateTime(2026, 8, 3));
        Assert.True(w.End < Now.Date, "右边界必须早于今天，否则本周数据会混进上周窗口");
    }

    [Fact]
    public void 上一窗必须等长且紧邻()
    {
        // 环比要是两个不等长的窗口，比出来的百分比没有意义。
        var w = InsightWindowResolver.Resolve(new DateTime(2026, 7, 27), new DateTime(2026, 8, 2), 0, Now)!;

        Assert.True(w.HasPrev);
        Assert.Equal(new DateTime(2026, 7, 20), w.PrevStart);
        Assert.Equal(w.Start, w.PrevEnd);
        Assert.Equal((w.End - w.Start).Days, (w.PrevEnd!.Value - w.PrevStart!.Value).Days);
    }

    [Fact]
    public void 右边界不许伸到未来()
    {
        // 未来的窗口只会让日均分母变大、数字变小，是一种看不出来的注水。
        var w = InsightWindowResolver.Resolve(new DateTime(2026, 8, 1), new DateTime(2026, 12, 31), 0, Now)!;

        Assert.Equal(Now.Date.AddDays(1), w.End);
    }

    [Fact]
    public void from晚于to判无效()
    {
        Assert.Null(InsightWindowResolver.Resolve(new DateTime(2026, 8, 2), new DateTime(2026, 7, 27), 0, Now));
    }

    [Fact]
    public void 同一天算一天不是零天()
    {
        var w = InsightWindowResolver.Resolve(new DateTime(2026, 8, 1), new DateTime(2026, 8, 1), 0, Now)!;

        Assert.Equal(1, w.SpanDays);
        Assert.Equal(1, w.DailyDivisor);
    }

    [Fact]
    public void 滚动天数与旧口径一致()
    {
        // 旧实现是 start = today - days + 1（含今天共 days 天）。换算不能悄悄差一天，
        // 否则面板上所有环比会整体错位一天。
        var w = InsightWindowResolver.Resolve(null, null, 7, Now)!;

        Assert.Equal(Now.Date.AddDays(-6), w.Start);
        Assert.Equal(Now.Date.AddDays(1), w.End);
        Assert.Equal(7, w.SpanDays);
    }

    [Fact]
    public void 全部时间无界_不给环比不给日序列()
    {
        var w = InsightWindowResolver.Resolve(null, null, 0, Now)!;

        Assert.False(w.Bounded);
        Assert.False(w.HasPrev);
        Assert.False(w.WantSeries);
        Assert.Null(w.DailyDivisor);
        Assert.Equal(DateTime.MinValue, w.Start);
        // 即便无界，右边界仍然是"到今天为止"——未来时间戳属于脏数据，不该计入。
        Assert.Equal(Now.Date.AddDays(1), w.End);
    }

    [Fact]
    public void 只给右边界_左边界仍无界且不出环比()
    {
        var w = InsightWindowResolver.Resolve(null, new DateTime(2026, 7, 31), 0, Now)!;

        Assert.False(w.Bounded);
        Assert.False(w.HasPrev);
        Assert.Equal(new DateTime(2026, 8, 1), w.End);
    }

    [Fact]
    public void 超长窗口不给日序列()
    {
        var w = InsightWindowResolver.Resolve(new DateTime(2026, 1, 1), new DateTime(2026, 6, 30), 0, Now)!;

        Assert.True(w.Bounded);
        Assert.True(w.HasPrev);
        Assert.False(w.WantSeries);
    }

    [Fact]
    public void 恰好45天给日序列_46天不给()
    {
        var d0 = new DateTime(2026, 6, 1);
        Assert.True(InsightWindowResolver.Resolve(d0, d0.AddDays(44), 0, Now)!.WantSeries);
        Assert.False(InsightWindowResolver.Resolve(d0, d0.AddDays(45), 0, Now)!.WantSeries);
    }
}

/// <summary>用量口径 token 的解析守卫 —— 写错的标签必须现形，不许被静默丢掉。</summary>
public class AdoptionTokenTests
{
    [Fact]
    public void 四种前缀都能解析()
    {
        var list = AdoptionToken.ParseList("llm:visual-agent, route:/visual-agent, dim:image-gen, none:平台能力");

        Assert.Equal(4, list.Count);
        Assert.Equal(new[] { "llm", "route", "dim", "none" }, list.Select(t => t.Kind));
        Assert.Equal("/visual-agent", list[1].Key);
    }

    [Fact]
    public void 反引号被剥掉()
    {
        // 周报正文里 token 写在反引号里（`llm:visual-agent`），采集器原样搬过来就会带上它们。
        var list = AdoptionToken.ParseList("`llm:visual-agent`");

        Assert.Equal("llm", list[0].Kind);
        Assert.Equal("visual-agent", list[0].Key);
    }

    [Fact]
    public void 缺冒号不静默丢弃而是标记为malformed()
    {
        // 丢掉的话，写错标签的能力会从采用率报告里凭空消失，看起来像"没这条"。
        var list = AdoptionToken.ParseList("visual-agent");

        Assert.Single(list);
        Assert.Equal("malformed", list[0].Kind);
    }

    [Fact]
    public void 路由里的冒号参数段不被误切()
    {
        var list = AdoptionToken.ParseList("route:/visual-agent/:id");

        Assert.Equal("route", list[0].Kind);
        Assert.Equal("/visual-agent/:id", list[0].Key);
    }

    [Fact]
    public void 空串给空列表()
    {
        Assert.Empty(AdoptionToken.ParseList(null));
        Assert.Empty(AdoptionToken.ParseList("   "));
    }

    [Fact]
    public void none的原因限三个枚举值()
    {
        // 自由文本会让平台类工作在采用率报告里静默消失——必须可枚举、可统计。
        Assert.Contains("平台能力", AdoptionToken.KnownNoSignalReasons);
        Assert.Contains("研发流程", AdoptionToken.KnownNoSignalReasons);
        Assert.Contains("基础设施", AdoptionToken.KnownNoSignalReasons);
        Assert.Equal(3, AdoptionToken.KnownNoSignalReasons.Count);
    }
}
