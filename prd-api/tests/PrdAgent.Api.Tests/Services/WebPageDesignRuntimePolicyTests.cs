using PrdAgent.Api.Services;
using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed class WebPageDesignRuntimePolicyTests
{
    [Theory]
    [InlineData(null, false)]
    [InlineData("", false)]
    [InlineData("   ", false)]
    [InlineData("open-design", false)]
    [InlineData(" OPEN-DESIGN ", false)]
    [InlineData("map-gateway", true)]
    [InlineData("codex", true)]
    [InlineData("unknown-runtime", true)]
    public void 新网页任务始终使用OpenDesign_旧客户端选择只记录为被忽略(
        string? requestedRuntime,
        bool overrideIgnored)
    {
        var decision = WebPageDesignRuntimePolicy.ResolveForNewRun(requestedRuntime);

        Assert.Equal(DesignArtifactRuntimes.OpenDesign, decision.Runtime);
        Assert.Equal(overrideIgnored, decision.ClientOverrideIgnored);
    }
}
