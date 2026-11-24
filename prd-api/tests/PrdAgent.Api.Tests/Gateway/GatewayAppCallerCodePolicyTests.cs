using PrdAgent.LlmGw.AppCallers;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

public sealed class GatewayAppCallerCodePolicyTests
{
    [Theory]
    [InlineData("external-system.summary::chat", "chat")]
    [InlineData("external-system.video.generate::video-gen", "video-gen")]
    [InlineData("external-system.audio.transcribe::asr", "asr")]
    public void SupportedGatewayType_WithCanonicalCode_IsAccepted(string appCallerCode, string requestType)
    {
        Assert.True(GatewayAppCallerCodePolicy.IsValidSelfService(appCallerCode, requestType));
    }

    [Theory]
    [InlineData("external-system.video.generate::video-gen", "chat")]
    [InlineData("External-system.video.generate::video-gen", "video-gen")]
    [InlineData("external-system.video.generate::unknown", "unknown")]
    public void MismatchedOrUnsupportedGatewayType_IsRejected(string appCallerCode, string requestType)
    {
        Assert.False(GatewayAppCallerCodePolicy.IsValidSelfService(appCallerCode, requestType));
    }
}
