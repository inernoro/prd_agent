using Moq;
using PrdAgent.Api.Services;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services.AssetStorage;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed class VideoSceneMediaTests
{
    [Fact]
    public async Task ManagedRelativeUrl_ReadsAdoptedAssetByFullShaWithoutHttp()
    {
        var sha = new string('a', 64);
        var scene = new VideoGenScene { ActiveVersionId = "v1", VideoUrl = "/local-assets/scene.mp4",
            Versions = [new() { Id = "v1", VideoUrl = "/local-assets/scene.mp4", AssetSha256 = sha }] };
        var storage = new Mock<IAssetStorage>(MockBehavior.Strict);
        storage.Setup(x => x.TryOpenReadByShaAsync(sha, It.IsAny<CancellationToken>(), AppDomainPaths.DomainVideoAgent, AppDomainPaths.TypeVideo))
            .ReturnsAsync(new AssetReadHandle(new MemoryStream([1, 2, 3, 4]), "video/mp4", 4));
        using var client = new HttpClient(new RejectHttpHandler());
        var path = Path.Combine(Path.GetTempPath(), "video-scene-read-" + Guid.NewGuid().ToString("N"));
        try
        {
            await VideoSceneMedia.CopyToFileAsync(storage.Object, client, scene, path, 100, default);
            Assert.Equal(new byte[] { 1, 2, 3, 4 }, await File.ReadAllBytesAsync(path));
            storage.VerifyAll();
        }
        finally { File.Delete(path); }
    }

    [Fact]
    public async Task NarrationAdoption_RejectsLegacyRelativeOrForeignAssetBeforeHttp()
    {
        using var client = new HttpClient(new RejectHttpHandler());
        var scene = new VideoGenScene { ActiveVersionId = "v2", VideoUrl = "/local-assets/current.mp4",
            Versions = [new() { Id = "v1", VideoUrl = "/local-assets/old.mp4", AssetSha256 = new string('b', 64) }] };
        Assert.Null(VideoSceneMedia.AssetSha(scene));
        var exception = await Assert.ThrowsAsync<InvalidOperationException>(() => VideoSceneMedia.CopyToFileAsync(
            Mock.Of<IAssetStorage>(), client, scene, "unused.mp4", 100, default));
        Assert.Contains("重新导入", exception.Message);
    }

    private sealed class RejectHttpHandler : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
            => throw new InvalidOperationException("回归不应发起网络请求");
    }
}
