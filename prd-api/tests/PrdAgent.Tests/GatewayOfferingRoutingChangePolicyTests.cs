using PrdAgent.LlmGw.Governance;
using Xunit;

namespace PrdAgent.Tests;

public sealed class GatewayOfferingRoutingChangePolicyTests
{
    [Fact]
    public void FullEditorDraft_WithUnchangedRoutingValues_DoesNotResetHealth()
    {
        var changed = OfferingRoutingChangePolicy.HasChanged(
            "gemini-2.5-flash-image",
            "gemini-compatible",
            "/v1beta/models",
            " gemini-2.5-flash-image ",
            "GEMINI-COMPATIBLE",
            " /v1beta/models ");

        Assert.False(changed);
    }

    [Theory]
    [InlineData("new-model", null, null)]
    [InlineData(null, "openai-compatible", null)]
    [InlineData(null, null, "/v1/images/generations")]
    public void ChangedRoutingValue_ResetsHealth(
        string? requestedUpstreamModelId,
        string? requestedProtocol,
        string? requestedEndpointPath)
    {
        var changed = OfferingRoutingChangePolicy.HasChanged(
            "old-model",
            "gemini-compatible",
            "/v1beta/models",
            requestedUpstreamModelId,
            requestedProtocol,
            requestedEndpointPath);

        Assert.True(changed);
    }

    [Fact]
    public void EmptySubmittedValue_ChangesExistingRoutingValueToUnset()
    {
        var changed = OfferingRoutingChangePolicy.HasChanged(
            "old-model",
            null,
            null,
            " ",
            null,
            null);

        Assert.True(changed);
    }
}
