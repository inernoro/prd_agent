using PrdAgent.Infrastructure.LlmGateway.Asr;
using Xunit;

namespace PrdAgent.Tests;

public sealed class AsrRequestContractPolicyTests
{
    [Theory]
    [InlineData("gpt-4o-transcribe")]
    [InlineData("gpt-4o-transcribe-api-ev3")]
    [InlineData("gpt-4o-mini-transcribe")]
    [InlineData("openai/gpt-4o-transcribe")]
    [InlineData("openai/gpt-4o-mini-transcribe")]
    public void OpenAiTranscribeModelsUseCompactJsonWithoutTimestampFields(string model)
    {
        var fields = AsrRequestContractPolicy.BuildTranscriptionFields(model, "zh");

        Assert.Equal("json", fields["response_format"]);
        Assert.False(fields.ContainsKey("timestamp_granularities[]"));
        Assert.Equal("zh", fields["language"]);
    }

    [Fact]
    public void WhisperKeepsVerboseSegmentsAndDropsBlankLanguage()
    {
        var fields = AsrRequestContractPolicy.BuildTranscriptionFields("whisper-1", " ");

        Assert.Equal("verbose_json", fields["response_format"]);
        Assert.Equal("segment", fields["timestamp_granularities[]"]);
        Assert.False(fields.ContainsKey("language"));
    }

    [Theory]
    [InlineData("gpt-4o-transcribe", "/v1/chat/completions", false)]
    [InlineData("gpt-4o-mini-transcribe", "v1/chat/completions", false)]
    [InlineData("openai/gpt-audio", "/v1/audio/transcriptions", false)]
    [InlineData("gpt-4o-transcribe", "/v1/audio/transcriptions", true)]
    [InlineData("openai/gpt-audio", "/v1/chat/completions", true)]
    [InlineData("gpt-4o-transcribe", "/custom/asr", true)]
    public void OfferingEndpointMustMatchThePhysicalModelContract(
        string model,
        string endpoint,
        bool expected)
    {
        var valid = AsrRequestContractPolicy.TryValidateOfferingEndpoint(
            model,
            "openai-compatible",
            "openai",
            endpoint,
            isExchange: false,
            out var error);

        Assert.Equal(expected, valid);
        if (expected)
            Assert.Null(error);
        else
            Assert.Contains(AsrRequestContractPolicy.InvalidRouteErrorCode, error);
    }

    [Fact]
    public void ExchangeOwnsItsCustomRouteContract()
    {
        var valid = AsrRequestContractPolicy.TryValidateOfferingEndpoint(
            "doubao-asr",
            "exchange",
            "exchange",
            "/v1/chat/completions",
            isExchange: true,
            out var error);

        Assert.True(valid);
        Assert.Null(error);
    }

    [Fact]
    public void ChatAudioBodyCarriesTheSamePhysicalModelAndWavBytes()
    {
        var body = AsrRequestContractPolicy.BuildChatAudioBody(
            "openai/gpt-audio",
            new byte[] { 1, 2, 3 },
            "逐字转写");

        Assert.Equal("openai/gpt-audio", body["model"]?.GetValue<string>());
        Assert.Equal(
            Convert.ToBase64String(new byte[] { 1, 2, 3 }),
            body["messages"]?[0]?["content"]?[1]?["input_audio"]?["data"]?.GetValue<string>());
    }

    [Theory]
    [InlineData("{\"text\":\"compact transcript\"}", "compact transcript")]
    [InlineData("{\"choices\":[{\"message\":{\"content\":\"chat transcript\"}}]}", "chat transcript")]
    [InlineData("{\"choices\":[{\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"part one\"},{\"type\":\"text\",\"text\":\"part two\"}]}}]}", "part one\npart two")]
    public void CompactAndChatResponsesExposeTranscriptText(string json, string expected)
    {
        Assert.Equal(expected, AsrResponseContractPolicy.ExtractCompactTranscript(json));
    }

    [Theory]
    [InlineData("{\"text\":\"NO_SPEECH\"}")]
    [InlineData("{\"text\":\" NO_SPEECH。 \"}")]
    public void ControlledNoSpeechSentinelReturnsNoTranscript(string json)
    {
        Assert.Null(AsrResponseContractPolicy.ExtractCompactTranscript(json));
    }

    [Fact]
    public void SpokenSentenceMentioningNoSpeechIsNotDiscarded()
    {
        const string expected = "接口返回 NO_SPEECH 时要重试";
        var json = $"{{\"text\":\"{expected}\"}}";

        Assert.Equal(expected, AsrResponseContractPolicy.ExtractCompactTranscript(json));
    }
}
