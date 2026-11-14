using PrdAgent.Api.Services;
using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed class VideoNarrationTimelineTests
{
    [Fact]
    public void AdoptedOrderAndTrimmedLengths_DetermineSubtitlePositions()
    {
        static VideoGenScene Scene(int index, double duration) => new()
        {
            Index = index, Narration = new() { SpeechRunId = "existing-" + index, Text = "旁白 " + index, DurationSeconds = duration },
        };
        var third = Scene(2, 1.4);
        var first = Scene(0, 2.1);
        var clips = VideoNarrationTimeline.BuildSubtitles([(third, 2), (new VideoGenScene(), 3), (first, 4), (third, 2)]);

        Assert.Equal(new[] { 2, 0, 2 }, clips.Select(x => x.SceneIndex!.Value));
        Assert.Equal(new[] { 0d, 5d, 9d }, clips.Select(x => x.StartSeconds));
        Assert.Equal(new[] { 1.4, 2.1, 1.4 }, clips.Select(x => x.DurationSeconds));
        Assert.Equal(new[] { "旁白 2", "旁白 0", "旁白 2" }, clips.Select(x => x.Text));
    }

    [Theory]
    [InlineData(5, 4)]
    [InlineData(0, 4)]
    [InlineData(double.NaN, 4)]
    [InlineData(double.PositiveInfinity, 4)]
    [InlineData(1, 0)]
    public void InvalidOrTruncatedNarration_IsRejectedBeforeComposition(double audio, double video)
        => Assert.Throws<InvalidOperationException>(() => VideoNarrationTimeline.ValidateDuration(audio, video));

    [Fact]
    public void FrameRoundingTolerance_DoesNotRejectSameLengthAudio()
        => VideoNarrationTimeline.ValidateDuration(4.02, 4);

    [Fact]
    public void LongerNarration_CannotBeHiddenByFollowingSilentShot()
    {
        var first = new VideoGenScene { Narration = new() { DurationSeconds = 4, Text = "这段不能跨到下个镜头", SpeechRunId = "existing" } };
        var exception = Assert.Throws<InvalidOperationException>(() => VideoNarrationTimeline.BuildSubtitles([(first, 2), (new(), 8)]));
        Assert.Contains("缩短本段配音", exception.Message);
    }
}
