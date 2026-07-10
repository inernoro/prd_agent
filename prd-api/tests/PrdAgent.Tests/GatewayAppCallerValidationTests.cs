using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.LlmGateway;
using Xunit;

namespace PrdAgent.Tests;

public sealed class GatewayAppCallerValidationTests
{
    [Theory]
    [InlineData("external-system.summary::chat", "chat")]
    [InlineData("external-system.media.describe::vision", "vision")]
    [InlineData("external-system.audio.transcribe::asr", "asr")]
    [InlineData("external-system.video.generate::video-gen", "video-gen")]
    public void DynamicGatewayCaller_WithCanonicalShape_ShouldBeAccepted(string appCallerCode, string modelType)
    {
        var accepted = LlmGateway.TryValidateAppCaller(appCallerCode, modelType, out var error);

        Assert.True(accepted, error);
        Assert.Null(AppCallerRegistrationService.FindByAppCode(appCallerCode));
    }

    [Theory]
    [InlineData("external-system.summary", "chat")]
    [InlineData("external-system::chat", "chat")]
    [InlineData("External-system.summary::chat", "chat")]
    [InlineData("external_system.summary::chat", "chat")]
    [InlineData("external-system.summary::chat::vision", "chat")]
    [InlineData("external-system.summary::vision", "chat")]
    public void DynamicGatewayCaller_WithInvalidShapeOrType_ShouldBeRejected(string appCallerCode, string modelType)
    {
        var accepted = LlmGateway.TryValidateAppCaller(appCallerCode, modelType, out var error);

        Assert.False(accepted);
        Assert.NotEmpty(error);
    }

    [Fact]
    public void RegisteredMapCaller_ShouldRemainAccepted()
    {
        var accepted = LlmGateway.TryValidateAppCaller(
            AppCallerRegistry.ReportAgent.Generate.Draft,
            ModelTypes.Chat,
            out var error);

        Assert.True(accepted, error);
    }
}
