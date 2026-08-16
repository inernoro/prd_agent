using PrdAgent.Api.Controllers.Api;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.PixelFormats;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

public class ProfileAvatarImageValidationTests
{
    [Fact]
    public void ValidateAvatarImageBytes_WhenPngBytesMatchMetadata_ShouldAcceptCanonicalFormat()
    {
        using var image = new Image<Rgba32>(2, 2);
        using var stream = new MemoryStream();
        image.SaveAsPng(stream);

        var result = ProfileController.ValidateAvatarImageBytes(
            stream.ToArray(),
            ".png",
            "image/png");

        Assert.True(result.ok);
        Assert.Equal("png", result.ext);
        Assert.Equal("image/png", result.mime);
    }

    [Theory]
    [InlineData(".jpg", "image/png")]
    [InlineData(".png", "image/jpeg")]
    [InlineData(".txt", "image/png")]
    public void ValidateAvatarImageBytes_WhenMetadataDoesNotMatchBytes_ShouldReject(
        string extension,
        string mime)
    {
        using var image = new Image<Rgba32>(2, 2);
        using var stream = new MemoryStream();
        image.SaveAsPng(stream);

        var result = ProfileController.ValidateAvatarImageBytes(stream.ToArray(), extension, mime);

        Assert.False(result.ok);
    }

    [Fact]
    public void ValidateAvatarImageBytes_WhenPayloadCannotBeDecoded_ShouldReject()
    {
        var result = ProfileController.ValidateAvatarImageBytes(
            "not-an-image"u8.ToArray(),
            ".png",
            "image/png");

        Assert.False(result.ok);
    }

    [Theory]
    [InlineData(4096, 4096, 1, true)]
    [InlineData(8193, 1, 1, false)]
    [InlineData(4097, 4097, 1, false)]
    [InlineData(1024, 1024, 65, false)]
    [InlineData(512, 512, 64, true)]
    [InlineData(512, 512, 65, false)]
    [InlineData(256, 256, 120, true)]
    [InlineData(256, 256, 121, false)]
    public void HasSafeAvatarImageDimensions_ShouldBoundDecodedMemory(
        int width,
        int height,
        int frameCount,
        bool expected)
    {
        Assert.Equal(
            expected,
            ProfileController.HasSafeAvatarImageDimensions(width, height, frameCount));
    }
}
