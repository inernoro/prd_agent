using PrdAgent.Infrastructure.Services.AssetStorage;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed class LocalAssetStorageTests
{
    [Fact]
    public async Task SaveAsync_ShouldExposeExactDomainKeyThroughLocalRoute()
    {
        var root = Path.Combine(Path.GetTempPath(), $"local-assets-{Guid.NewGuid():N}");
        try
        {
            var storage = new LocalAssetStorage(root);
            var payload = new byte[] { 4, 3, 2, 1 };

            var stored = await storage.SaveAsync(
                payload,
                "audio/mp4",
                CancellationToken.None,
                domain: "prd-agent",
                type: "doc",
                fileName: "recording.m4a");

            var key = $"prd-agent/doc/{stored.Sha256}.m4a";
            stored.Url.ShouldBe($"/local-assets/{key}");
            storage.TryBuildUrlBySha(stored.Sha256, stored.Mime, "prd-agent", "doc")
                .ShouldBe(stored.Url);
            (await storage.TryDownloadBytesAsync(key, CancellationToken.None))
                .ShouldBe(payload);
        }
        finally
        {
            if (Directory.Exists(root))
                Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task KeyOperations_ShouldRoundTripNestedAssetAndExposeLocalRoute()
    {
        var root = Path.Combine(Path.GetTempPath(), $"local-assets-{Guid.NewGuid():N}");
        try
        {
            var storage = new LocalAssetStorage(root);
            var payload = new byte[] { 1, 2, 3, 4 };
            const string key = "recordings/session 1/audio.m4a";

            await storage.UploadToKeyAsync(
                key,
                payload,
                "audio/mp4",
                CancellationToken.None);

            (await storage.TryDownloadBytesAsync(key, CancellationToken.None))
                .ShouldBe(payload);
            (await storage.ExistsAsync(key, CancellationToken.None)).ShouldBeTrue();
            storage.BuildUrlForKey(key)
                .ShouldBe("/local-assets/recordings/session%201/audio.m4a");
            await storage.DeleteByKeyAsync(key, CancellationToken.None);
            (await storage.ExistsAsync(key, CancellationToken.None)).ShouldBeFalse();
        }
        finally
        {
            if (Directory.Exists(root))
                Directory.Delete(root, recursive: true);
        }
    }

    [Theory]
    [InlineData("../outside.txt")]
    [InlineData("recordings/../../outside.txt")]
    [InlineData("/absolute.txt")]
    [InlineData("recordings//audio.m4a")]
    [InlineData("recordings/./audio.m4a")]
    public async Task KeyOperations_ShouldRejectTraversalAndAmbiguousPaths(string key)
    {
        var root = Path.Combine(Path.GetTempPath(), $"local-assets-{Guid.NewGuid():N}");
        try
        {
            var storage = new LocalAssetStorage(root);
            await Should.ThrowAsync<ArgumentException>(() => storage.UploadToKeyAsync(
                key,
                new byte[] { 1 },
                "application/octet-stream",
                CancellationToken.None));
            Should.Throw<ArgumentException>(() => storage.BuildUrlForKey(key));
        }
        finally
        {
            if (Directory.Exists(root))
                Directory.Delete(root, recursive: true);
        }
    }
}
