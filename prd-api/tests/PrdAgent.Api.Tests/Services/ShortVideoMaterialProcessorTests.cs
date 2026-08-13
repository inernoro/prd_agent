using PrdAgent.Api.Services;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class ShortVideoMaterialProcessorTests
{
    [Fact]
    public void RequireResolvedVideoUrl_ShouldRejectMissingVideoUrl()
    {
        var ex = Should.Throw<InvalidOperationException>(() => ShortVideoMaterialProcessor.RequireResolvedVideoUrl(null));

        ex.Message.ShouldContain("未返回可下载的视频文件地址");
    }

    [Theory]
    [InlineData("/video.mp4")]
    [InlineData("file:///tmp/video.mp4")]
    public void RequireResolvedVideoUrl_ShouldRejectInvalidVideoUrl(string videoUrl)
    {
        var ex = Should.Throw<InvalidOperationException>(() => ShortVideoMaterialProcessor.RequireResolvedVideoUrl(videoUrl));

        ex.Message.ShouldContain("视频文件地址无效");
    }

    [Fact]
    public void RequireResolvedVideoUrl_ShouldReturnTrimmedHttpVideoUrl()
    {
        var result = ShortVideoMaterialProcessor.RequireResolvedVideoUrl(" https://cdn.example.test/video.mp4 ");

        result.ShouldBe("https://cdn.example.test/video.mp4");
    }

    [Theory]
    [InlineData("这不是链接")]
    [InlineData("/video.mp4")]
    [InlineData("file:///tmp/video.mp4")]
    [InlineData("https:///missing-host")]
    public void IsHttpUrl_ShouldRejectNonPublicUrl(string value)
    {
        ShortVideoMaterialProcessor.IsHttpUrl(value).ShouldBeFalse();
    }

    [Theory]
    [InlineData("https://www.bilibili.com/video/BV1test")]
    [InlineData(" http://example.test/video ")]
    public void IsHttpUrl_ShouldAcceptCompleteHttpUrl(string value)
    {
        ShortVideoMaterialProcessor.IsHttpUrl(value).ShouldBeTrue();
    }
}
