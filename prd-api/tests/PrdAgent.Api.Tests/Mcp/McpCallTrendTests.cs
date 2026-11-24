using PrdAgent.Api.Services.Mcp;
using Shouldly;
using Xunit;
namespace PrdAgent.Api.Tests.Mcp;
public class McpCallTrendTests
{
    [Fact]
    public void 跨天窗口补齐空小时并保留完整计数()
    {
        var now = new DateTime(2026, 11, 3, 1, 25, 0, DateTimeKind.Utc);
        var first = new DateTime(2026, 11, 2, 2, 0, 0, DateTimeKind.Utc);
        var result = McpCallTrend.Build(now, new Dictionary<DateTime, long>
        { [first] = 5001, [first.AddHours(23)] = 3, [first.AddHours(-1)] = 99 });
        result.SinceUtc.ShouldBe(first);
        result.UntilUtc.ShouldBe(now);
        result.Points.Count.ShouldBe(24);
        result.Points.First().Calls.ShouldBe(5001);
        result.Points.Last().Calls.ShouldBe(3);
        result.Points.Skip(1).Take(22).ShouldAllBe(point => point.Calls == 0);
        result.Points.Sum(point => point.Calls).ShouldBe(5004);
    }
}
