using PrdAgent.LlmGw.Governance;
using PrdAgent.Infrastructure.LlmGateway.Asr;
using PrdAgent.LlmGw.Models;
using PrdAgent.LlmGw.Provisioning;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

public sealed class AsrOfferingContractPolicyTests
{
    [Fact]
    public void PhysicalModelResolutionUsesThePersistedModelNameBeforeLegacyModelId()
    {
        Assert.Equal(
            "openai/gpt-audio",
            AsrOfferingContractPolicy.ResolvePhysicalModel(null, "openai/gpt-audio", "legacy-whisper"));
        Assert.Equal(
            "offering-override",
            AsrOfferingContractPolicy.ResolvePhysicalModel("offering-override", "openai/gpt-audio", "legacy-whisper"));
    }

    [Fact]
    public void PhysicalModelResolutionReadsTheRealProvisionedBsonShape()
    {
        Assert.True(GatewayConfigurationProvisioning.TryNormalizeModel(new CreateModelRequest
        {
            PlatformId = "platform-openrouter",
            ModelName = "openai/gpt-audio",
            Capabilities = ["asr"],
            Protocol = "openai-compatible",
        }, out var draft, out var error), error);
        var document = GatewayConfigurationProvisioning.BuildModelDocument(
            draft!, "tenant-a", "model-audio", null, DateTime.UnixEpoch);

        Assert.Equal(
            "openai/gpt-audio",
            AsrOfferingContractPolicy.ResolvePhysicalModel(
                null,
                document["ModelName"].AsString,
                document.Contains("ModelId") ? document["ModelId"].AsString : null));
    }

    [Theory]
    [InlineData("gpt-4o-transcribe", "/v1/chat/completions", true)]
    [InlineData("gpt-4o-transcribe", "/v1/chat/completions/", true)]
    [InlineData("gpt-4o-transcribe", "/v1/chat/completions/?region=cn", true)]
    [InlineData("gpt-4o-mini-transcribe", "v1/chat/completions", true)]
    [InlineData("openai/gpt-audio", "/v1/audio/transcriptions", true)]
    [InlineData("openai/gpt-audio", "/v1/audio/transcriptions/?api-version=2026-08-15", true)]
    [InlineData("gpt-4o-transcribe", "/v1/audio/transcriptions", false)]
    [InlineData("gpt-4o-transcribe", "/v1/audio/transcriptions/#region", false)]
    [InlineData("openai/gpt-audio", "/v1/chat/completions", false)]
    [InlineData("openai/gpt-audio", "/v1/chat/completions/?region=cn", false)]
    public void AsrStandardEndpointConflictsAreRejectedAtWriteTime(
        string model,
        string endpoint,
        bool shouldReject)
    {
        var error = AsrOfferingContractPolicy.Validate("asr", "model", model, endpoint);

        Assert.Equal(shouldReject, error is not null);
    }

    [Theory]
    [InlineData("chat", "model", "gpt-4o-transcribe", "/v1/chat/completions")]
    [InlineData("asr", "exchange", "doubao-asr", "/v1/chat/completions")]
    [InlineData("asr", "model", "gpt-4o-transcribe", "/custom/asr")]
    public void NonAsrExchangeAndCustomRoutesKeepExistingFlexibility(
        string modelType,
        string targetKind,
        string model,
        string endpoint)
    {
        Assert.Null(AsrOfferingContractPolicy.Validate(modelType, targetKind, model, endpoint));
    }

    [Theory]
    [InlineData("openai/gpt-audio", "openai-compatible", "openrouter", "/v1/chat/completions", false)]
    [InlineData("openai/gpt-audio", "openai-compatible", "openrouter", "/v1/audio/transcriptions", true)]
    [InlineData("gemini-audio", null, "gemini", "/v1/audio/transcriptions", false)]
    [InlineData("gemini-audio", null, "gemini", "/v1/chat/completions", true)]
    public void WriteTimePolicyMatchesRuntimeProtocolAndPlatformRouting(
        string model,
        string? protocol,
        string platformType,
        string endpoint,
        bool shouldReject)
    {
        var error = AsrOfferingContractPolicy.Validate(
            "asr",
            "model",
            model,
            endpoint,
            protocol,
            platformType);

        Assert.Equal(shouldReject, error is not null);
    }

    [Theory]
    [InlineData("openai/gpt-4o-transcribe", "openai-compatible", "openrouter")]
    [InlineData("openai/gpt-audio", "openai-compatible", "openrouter")]
    [InlineData("gemini-audio", null, "gemini")]
    [InlineData("gpt-audio", null, "google")]
    [InlineData("gpt-audio", "anthropic", "openrouter")]
    [InlineData("gpt-audio", null, null)]
    public void ConsoleWriteGateAndRuntimeUseTheSameEndpointContractMatrix(
        string model,
        string? protocol,
        string? platformType)
    {
        var runtimeUsesChat = AsrRequestContractPolicy.ShouldUseChatAudio(model, protocol, platformType);
        var expectedEndpoint = runtimeUsesChat
            ? AsrRequestContractPolicy.ChatCompletionsEndpoint
            : AsrRequestContractPolicy.TranscriptionsEndpoint;
        var oppositeEndpoint = runtimeUsesChat
            ? AsrRequestContractPolicy.TranscriptionsEndpoint
            : AsrRequestContractPolicy.ChatCompletionsEndpoint;

        Assert.Null(AsrOfferingContractPolicy.Validate(
            "asr", "model", model, expectedEndpoint, protocol, platformType));
        Assert.NotNull(AsrOfferingContractPolicy.Validate(
            "asr", "model", model, oppositeEndpoint, protocol, platformType));
    }
}
