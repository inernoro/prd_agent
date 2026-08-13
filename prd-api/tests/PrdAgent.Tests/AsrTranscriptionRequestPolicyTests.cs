using PrdAgent.Infrastructure.LlmGateway.Asr;
using Xunit;

namespace PrdAgent.Tests;

public sealed class AsrTranscriptionRequestPolicyTests
{
    [Theory]
    [InlineData("gpt-4o-transcribe")]
    [InlineData("gpt-4o-mini-transcribe")]
    public void OpenAiTranscribeModelsUseCompactJson(string model)
    {
        var fields = AsrTranscriptionRequestPolicy.BuildMultipartFields(model, "zh");

        Assert.Equal("json", fields["response_format"]);
        Assert.False(fields.ContainsKey("timestamp_granularities[]"));
        Assert.Equal("zh", fields["language"]);
    }

    [Fact]
    public void WhisperKeepsVerboseSegmentsAndDropsBlankLanguage()
    {
        var fields = AsrTranscriptionRequestPolicy.BuildMultipartFields("whisper-1", " ");

        Assert.Equal("verbose_json", fields["response_format"]);
        Assert.Equal("segment", fields["timestamp_granularities[]"]);
        Assert.False(fields.ContainsKey("language"));
    }
}
