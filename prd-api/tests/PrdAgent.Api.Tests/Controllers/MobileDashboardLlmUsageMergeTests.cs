using PrdAgent.Api.Controllers.Api;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

public sealed class MobileDashboardLlmUsageMergeTests
{
    [Fact]
    public void MergeLlmUsage_合并新旧日志库并按请求标识去重()
    {
        var now = DateTime.UtcNow;
        var gateway = new[]
        {
            Point("gateway-copy", "shared-request", now, 100, 20),
            Point("gateway-only", "gateway-request", now.AddMinutes(1), 30, 5),
        };
        var legacy = new[]
        {
            Point("legacy-copy", "shared-request", now, 999, 999),
            Point("legacy-only", "legacy-request", now.AddMinutes(2), 40, 6),
        };

        var merged = MobileDashboardController.MergeLlmUsage(gateway, legacy);

        merged.Count.ShouldBe(3);
        merged.Sum(x => x.Input + x.Output).ShouldBe(201);
        merged.Single(x => x.RequestId == "shared-request").Id.ShouldBe("gateway-copy");
    }

    [Fact]
    public void MergeLlmUsage_缺少请求标识时按文档标识去重()
    {
        var now = DateTime.UtcNow;
        var merged = MobileDashboardController.MergeLlmUsage(
            new[] { Point("same-document", string.Empty, now, 10, 1) },
            new[] { Point("same-document", string.Empty, now, 20, 2) });

        merged.Count.ShouldBe(1);
        merged[0].Input.ShouldBe(10);
    }

    private static MobileDashboardController.LlmUsagePoint Point(
        string id,
        string requestId,
        DateTime startedAt,
        int input,
        int output) => new()
        {
            Id = id,
            RequestId = requestId,
            StartedAt = startedAt,
            Input = input,
            Output = output,
        };
}
