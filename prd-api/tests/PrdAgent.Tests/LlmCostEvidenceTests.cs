using PrdAgent.Infrastructure.LLM;
using Xunit;

namespace PrdAgent.Tests;

public sealed class LlmCostEvidenceTests
{
    [Fact]
    public void PriceSnapshotHash_IsStableAndKeepsUnknownDistinctFromZero()
    {
        var first = LlmCostEvidence.BuildPriceSnapshotHash(1.5m, 2m, null, null, null, "usd");
        var repeated = LlmCostEvidence.BuildPriceSnapshotHash(1.50m, 2.0m, null, null, null, "USD");
        var zero = LlmCostEvidence.BuildPriceSnapshotHash(0m, 2m, null, null, null, "USD");

        Assert.Equal(first, repeated);
        Assert.NotEqual(first, zero);
        Assert.Null(LlmCostEvidence.BuildPriceSnapshotHash(null, null, null, null, null, null));
    }

    /// <summary>
    /// 缓存两档价必须进指纹。漏掉的话，「按缓存价算」与「按全价算」这两次口径不同的计价
    /// 会得到同一个快照，事后谁都无法复算出当时那笔账是怎么来的。
    /// </summary>
    [Fact]
    public void PriceSnapshotHash_ChangesWhenCachePricesChange()
    {
        var noCachePrice = LlmCostEvidence.BuildPriceSnapshotHash(2.5m, 10m, null, null, null, "USD");
        var withCacheRead = LlmCostEvidence.BuildPriceSnapshotHash(2.5m, 10m, 0.625m, null, null, "USD");
        var withCacheWrite = LlmCostEvidence.BuildPriceSnapshotHash(2.5m, 10m, null, 3.75m, null, "USD");
        var withBoth = LlmCostEvidence.BuildPriceSnapshotHash(2.5m, 10m, 0.625m, 3.75m, null, "USD");

        Assert.NotEqual(noCachePrice, withCacheRead);
        Assert.NotEqual(noCachePrice, withCacheWrite);
        Assert.NotEqual(withCacheRead, withCacheWrite);
        Assert.NotEqual(withCacheRead, withBoth);
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

    [Fact]
    public void SafeResponseHeaders_PreserveProviderRequestIdAndExcludeUntrustedHeaders()
    {
        using var response = new HttpResponseMessage(System.Net.HttpStatusCode.OK)
        {
            Content = new StringContent("{}", System.Text.Encoding.UTF8, "application/json"),
        };
        response.Headers.TryAddWithoutValidation("OpenAI-Request-Id", "provider-request-2");
        response.Headers.TryAddWithoutValidation("Set-Cookie", "secret=must-not-be-logged");

        var headers = LlmCostEvidence.BuildSafeResponseHeaders(response, "application/octet-stream");

        Assert.Equal("provider-request-2", LlmCostEvidence.ResolveProviderRequestId(headers));
        Assert.Equal("application/json; charset=utf-8", headers["content-type"]);
        Assert.DoesNotContain("Set-Cookie", headers.Keys, StringComparer.OrdinalIgnoreCase);
    }
}
