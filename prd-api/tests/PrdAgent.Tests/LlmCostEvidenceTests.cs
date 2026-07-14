using PrdAgent.Infrastructure.LLM;
using Xunit;

namespace PrdAgent.Tests;

public sealed class LlmCostEvidenceTests
{
    [Fact]
    public void PriceSnapshotHash_IsStableAndKeepsUnknownDistinctFromZero()
    {
        var first = LlmCostEvidence.BuildPriceSnapshotHash(1.5m, 2m, null, "usd");
        var repeated = LlmCostEvidence.BuildPriceSnapshotHash(1.50m, 2.0m, null, "USD");
        var zero = LlmCostEvidence.BuildPriceSnapshotHash(0m, 2m, null, "USD");

        Assert.Equal(first, repeated);
        Assert.NotEqual(first, zero);
        Assert.Null(LlmCostEvidence.BuildPriceSnapshotHash(null, null, null, null));
    }

    [Fact]
    public void ProviderRequestId_OnlyComesFromKnownResponseHeaders()
    {
        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["X-Untrusted-Id"] = "do-not-use",
            ["X-Request-Id"] = "provider-request-1",
        };

        Assert.Equal("provider-request-1", LlmCostEvidence.ResolveProviderRequestId(headers));
        Assert.Null(LlmCostEvidence.ResolveProviderRequestId(new Dictionary<string, string>
        {
            ["X-Untrusted-Id"] = "do-not-use",
        }));
        Assert.Equal("doubao-request-1", LlmCostEvidence.ResolveProviderRequestId(new Dictionary<string, string>
        {
            ["X-Tt-Logid"] = "doubao-request-1",
        }));
    }
}
