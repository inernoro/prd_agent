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
            "语音转写暂时失败。请稍后重试或换一段清晰音频；原始音频已保留，不需要重新录制。",
            result);
        Assert.DoesNotContain("ASR", result, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("chat", result, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("HTTP", result, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("provider", result, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("token", result, StringComparison.OrdinalIgnoreCase);
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
}
