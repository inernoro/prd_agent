using PrdAgent.Core.LlmGateway;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

public sealed class GatewayFederationProtocolTests
{
    [Fact]
    public void BuildOutbound_FirstHop_AddsCurrentNode()
    {
        var decision = GatewayFederationProtocol.BuildOutbound(null, null, "MAP-Formal", 2);

        Assert.True(decision.Allowed);
        Assert.Equal(1, decision.Trace?.Hop);
        Assert.Equal("map-formal", decision.Trace?.Path);
    }

    [Fact]
    public void BuildOutbound_SecondHop_AppendsCurrentNode()
    {
        var decision = GatewayFederationProtocol.BuildOutbound(1, "map-formal", "cds-local", 2);

        Assert.True(decision.Allowed);
        Assert.Equal(2, decision.Trace?.Hop);
        Assert.Equal("map-formal,cds-local", decision.Trace?.Path);
    }

    [Fact]
    public void ValidateInbound_WhenCurrentNodeAlreadyExists_RejectsLoop()
    {
        var decision = GatewayFederationProtocol.ValidateInbound("2", "map-formal,cds-local", "cds-local", 2);

        Assert.False(decision.Allowed);
        Assert.Equal(508, decision.StatusCode);
        Assert.Equal("FEDERATION_LOOP_DETECTED", decision.ErrorCode);
    }

    [Fact]
    public void ValidateInbound_WhenHopExceedsLimit_RejectsRequest()
    {
        var decision = GatewayFederationProtocol.ValidateInbound("3", "a,b,c", "target", 2);

        Assert.False(decision.Allowed);
        Assert.Equal(508, decision.StatusCode);
        Assert.Equal("FEDERATION_MAX_HOPS_EXCEEDED", decision.ErrorCode);
    }

    [Theory]
    [InlineData("2", "map-formal")]
    [InlineData("1", "map-formal,map-formal")]
    [InlineData(null, "map-formal")]
    public void ValidateInbound_WhenTraceIsInconsistent_RejectsRequest(string? hop, string? path)
    {
        var decision = GatewayFederationProtocol.ValidateInbound(hop, path, "cds-local", 2);

        Assert.False(decision.Allowed);
        Assert.Equal("FEDERATION_TRACE_INVALID", decision.ErrorCode);
    }

    [Fact]
    public void ValidateInbound_WithoutFederationHeaders_AllowsOrdinaryClient()
    {
        var decision = GatewayFederationProtocol.ValidateInbound(null, null, "cds-local", 2);

        Assert.True(decision.Allowed);
        Assert.Null(decision.Trace);
    }

    [Fact]
    public void IsFederatedProvider_IsCaseInsensitiveButFailClosedForOthers()
    {
        Assert.True(GatewayFederationProtocol.IsFederatedProvider(" LLMGW "));
        Assert.False(GatewayFederationProtocol.IsFederatedProvider("openai"));
        Assert.False(GatewayFederationProtocol.IsFederatedProvider(null));
    }
}
