using PrdAgent.LlmGw.Governance;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

public sealed class LegacySuccessorScopePolicyTests
{
    [Fact]
    public void FindMissing_ReportsUncoveredLegacyCallersAndProtocols()
    {
        LegacySuccessorScopePolicy.FindMissing(
                ["map.weekly::chat"],
                ["map.weekly::chat", "map.marketing::chat"])
            .ShouldBe(["map.marketing::chat"]);

        LegacySuccessorScopePolicy.FindMissing(
                ["openai-compatible"],
                ["gw-native", "openai-compatible", "claude-compatible", "gemini-compatible"])
            .ShouldBe(["claude-compatible", "gemini-compatible", "gw-native"]);
    }

    [Fact]
    public void FindMissing_WildcardCoversEveryRequiredValue()
    {
        LegacySuccessorScopePolicy.FindMissing(["*"], ["caller-a", "caller-b"])
            .ShouldBeEmpty();
    }
}
