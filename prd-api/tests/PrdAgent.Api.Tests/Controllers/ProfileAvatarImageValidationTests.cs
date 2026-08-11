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
}
