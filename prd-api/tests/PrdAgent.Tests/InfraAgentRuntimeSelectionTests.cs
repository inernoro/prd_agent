using PrdAgent.Infrastructure.Services.InfraAgentSessions;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// CDS Agent 优雅降级决策的纯函数测试。
/// 守护「R1 未闭合时不再硬卡，自动降级到 lite」这条核心行为。
/// </summary>
public class InfraAgentRuntimeSelectionTests
{
    [Fact]
    public void OfficialSelectedWhenSidecarConfiguredAndProfileCompatible()
    {
        var result = InfraAgentSessionService.DecideRuntimeSelection(
            sidecarConfigured: true,
            profileCompatible: true,
            liteAvailable: true);

        Assert.Equal(InfraAgentSessionService.InfraAgentRuntimeMode.Official, result.Mode);
        Assert.Equal("official_sdk_ready", result.Reason);
    }

    [Fact]
    public void LiteSelectedWhenProfileIncompatibleButLiteAvailable_R1NotClosed()
    {
        var result = InfraAgentSessionService.DecideRuntimeSelection(
            sidecarConfigured: true,
            profileCompatible: false,
            liteAvailable: true);

        Assert.Equal(InfraAgentSessionService.InfraAgentRuntimeMode.Lite, result.Mode);
        Assert.Equal("r1_profile_incompatible", result.Reason);
    }

    [Fact]
    public void LiteSelectedWhenSidecarNotConfiguredButLiteAvailable()
    {
        var result = InfraAgentSessionService.DecideRuntimeSelection(
            sidecarConfigured: false,
            profileCompatible: true,
            liteAvailable: true);

        Assert.Equal(InfraAgentSessionService.InfraAgentRuntimeMode.Lite, result.Mode);
        Assert.Equal("sidecar_not_configured", result.Reason);
    }

    [Fact]
    public void UnavailableWhenNeitherSidecarNorLite()
    {
        var result = InfraAgentSessionService.DecideRuntimeSelection(
            sidecarConfigured: false,
            profileCompatible: false,
            liteAvailable: false);

        Assert.Equal(InfraAgentSessionService.InfraAgentRuntimeMode.Unavailable, result.Mode);
        Assert.Equal("sidecar_not_configured", result.Reason);
    }

    [Fact]
    public void UnavailableWhenSidecarConfiguredIncompatibleAndNoLite()
    {
        var result = InfraAgentSessionService.DecideRuntimeSelection(
            sidecarConfigured: true,
            profileCompatible: false,
            liteAvailable: false);

        Assert.Equal(InfraAgentSessionService.InfraAgentRuntimeMode.Unavailable, result.Mode);
        Assert.Equal("r1_profile_incompatible", result.Reason);
    }
}
