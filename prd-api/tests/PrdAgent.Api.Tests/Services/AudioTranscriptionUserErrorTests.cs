using PrdAgent.Api.Services;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class AudioTranscriptionUserErrorTests
{
    [Theory]
    [InlineData("自动尝试 2 个 ASR 方案仍失败：多模态 chat 音频转写调用失败: HTTP 402 provider=openrouter token=secret")]
    [InlineData("Whisper endpoint returned stack trace")]
    public void FromException_HidesTechnicalDetailsAndProvidesRecovery(string rawMessage)
    {
        var result = AudioTranscriptionUserError.FromException(new InvalidOperationException(rawMessage));

        Assert.Equal(
            "语音转写暂时失败。原始音频已保留，不需要重新录制。",
            result);
        Assert.DoesNotContain("ASR", result, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("chat", result, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("HTTP", result, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("provider", result, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("token", result, StringComparison.OrdinalIgnoreCase);
    }

    [Theory]
    [InlineData("ASR_ROUTE_CONTRACT_INVALID: gpt-4o-transcribe 不能走 chat", "ASR_ROUTE_CONTRACT_INVALID")]
    [InlineData("response_format verbose_json is not compatible", "ASR_ROUTE_CONTRACT_INVALID")]
    [InlineData("This is not a chat model and thus not supported in the v1/chat/completions endpoint", "ASR_ROUTE_CONTRACT_INVALID")]
    public void Classify_RouteContractErrorsStopDeterministicAutomaticRetries(
        string message,
        string expectedCode)
    {
        var failure = AudioTranscriptionUserError.Classify(new InvalidOperationException(message));

        Assert.Equal(expectedCode, failure.Code);
        Assert.False(failure.AutomaticRetryAllowed);
        Assert.Contains("配置不兼容", failure.UserMessage);
        Assert.Contains("录音已保留", failure.UserMessage);
    }

    [Fact]
    public void FromException_ExplainsNoSpeechWithoutLosingOriginalAudio()
    {
        var result = AudioTranscriptionUserError.FromException(
            new InvalidOperationException("ASR 返回无有效语音（NO_SPEECH）"));

        Assert.Contains("没有识别到有效语音", result);
        Assert.Contains("重新上传", result);
        Assert.Contains("原始音频已保留", result);
    }

    [Fact]
    public void Classify_AllCandidatesReturnedEmptyTextStopsAutomaticRetry()
    {
        var failure = AudioTranscriptionUserError.Classify(
            new InvalidOperationException($"{AudioTranscriptionUserError.AllCandidatesNoSpeech}: 所有候选均为空"));

        Assert.Equal(AudioTranscriptionUserError.NoSpeech, failure.Code);
        Assert.False(failure.AutomaticRetryAllowed);
        Assert.Contains("没有识别到有效语音", failure.UserMessage);
        Assert.Contains("原始音频已保留", failure.UserMessage);
    }

    [Fact]
    public void RetryOutcome_DoesNotPromiseAutomaticRetryWhenRunWillStop()
    {
        var failure = AudioTranscriptionUserError.Classify(new InvalidOperationException("HTTP 503"));

        Assert.Contains("系统会自动重试", AudioTranscriptionUserError.ForRetryOutcome(failure, willRetry: true));
        Assert.Contains("请点击重试", AudioTranscriptionUserError.ForRetryOutcome(failure, willRetry: false));
        Assert.DoesNotContain("自动重试", AudioTranscriptionUserError.ForRetryOutcome(failure, willRetry: false));
    }
}
