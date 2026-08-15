using System.Reflection;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using PrdAgent.Api.Services;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class VideoToDocRunWorkerTests
{
    [Theory]
    [InlineData("请提供音频")]
    [InlineData("NO_SPEECH")]
    [InlineData("\"NO_SPEECH.\"")]
    public void ChatAudioRefusalOrNoSpeech_ShouldFallBackToFrameAnalysis(string responseText)
    {
        var (segments, language) = ParseChatAudioResponse(responseText);

        segments.ShouldBeEmpty();
        language.ShouldBe("unknown");
    }

    [Theory]
    [InlineData("今天讨论后台上传")]
    [InlineData("他说请播放音频，然后会议就开始了。")]
    [InlineData("最后一句是谢谢观看")]
    public void RealShortTranscript_ShouldRemainAvailableForVideoAnalysis(string transcript)
    {
        var (segments, language) = ParseChatAudioResponse(transcript);

        segments.Count.ShouldBe(1);
        segments[0].Text.ShouldBe(transcript);
        language.ShouldBe("unknown");
    }

    private static (List<VideoToDocRunWorker.TranscriptSegment> segments, string language)
        ParseChatAudioResponse(string responseText)
    {
        var worker = new VideoToDocRunWorker(
            Mock.Of<IServiceScopeFactory>(),
            NullLogger<VideoToDocRunWorker>.Instance,
            new ConfigurationBuilder().Build());
        var method = typeof(VideoToDocRunWorker).GetMethod(
            "ParseChatAudioResponse",
            BindingFlags.Instance | BindingFlags.NonPublic);

        method.ShouldNotBeNull();
        return ((List<VideoToDocRunWorker.TranscriptSegment> segments, string language))method.Invoke(
            worker,
            new object[] { BuildChatAudioResponse(responseText) })!;
    }

    private static string BuildChatAudioResponse(string text)
        => System.Text.Json.JsonSerializer.Serialize(new
        {
            choices = new[]
            {
                new
                {
                    message = new { content = text },
                },
            },
        });
}
