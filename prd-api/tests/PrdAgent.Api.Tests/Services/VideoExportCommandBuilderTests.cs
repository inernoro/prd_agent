using PrdAgent.Api.Services;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class VideoExportCommandBuilderTests
{
    [Fact]
    public void Build_ShouldNormalizeClipsAndConcatenateInTimelineOrder()
    {
        var args = VideoExportCommandBuilder.Build(
            ["scene-000.mp4", "scene-001.mp4"],
            "export.mp4",
            "9:16");

        args.ShouldContain("scene-000.mp4");
        args.ShouldContain("scene-001.mp4");
        args.ShouldContain("export.mp4");
        var filter = args[args.ToList().IndexOf("-filter_complex") + 1];
        filter.ShouldContain("scale=720:1280");
        filter.ShouldContain("[v0][v1]concat=n=2:v=1:a=0[outv]");
    }

    [Theory]
    [InlineData("16:9", 1280, 720)]
    [InlineData("9:16", 720, 1280)]
    [InlineData("1:1", 720, 720)]
    [InlineData("4:3", 960, 720)]
    [InlineData("3:4", 720, 960)]
    public void GetDimensions_ShouldReturnStableExportCanvas(string aspectRatio, int width, int height)
    {
        VideoExportCommandBuilder.GetDimensions(aspectRatio).ShouldBe((width, height));
    }

    [Fact]
    public void Build_ShouldRejectEmptyTimeline()
    {
        Should.Throw<ArgumentException>(() =>
            VideoExportCommandBuilder.Build([], "export.mp4", "16:9"));
    }
}
