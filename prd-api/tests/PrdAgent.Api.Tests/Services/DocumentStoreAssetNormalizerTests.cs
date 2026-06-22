using Microsoft.Extensions.Logging.Abstractions;
using PrdAgent.Api.Services;
using PrdAgent.Infrastructure.Services.AssetStorage;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class DocumentStoreAssetNormalizerTests
{
    [Fact]
    public async Task NormalizeAsync_ReplacesImagePlaceholdersWithStoredAssetUrls()
    {
        var storage = new FakeAssetStorage();
        var normalizer = new DocumentStoreAssetNormalizer(storage, NullLogger<DocumentStoreAssetNormalizer>.Instance);
        var bytes = Convert.ToBase64String("fake png bytes"u8.ToArray());

        var result = await normalizer.NormalizeAsync(
            "步骤\n\n{{IMG:shot-1}}",
            new[]
            {
                new DocumentStoreInlineAsset("shot-1", "图 1", "image/png", bytes, "shot-1.png", "png"),
            },
            null,
            CancellationToken.None);

        result.Content.ShouldContain("![图 1](https://assets.test/assets/img/shot-1.png)");
        result.Content.ShouldNotContain("{{IMG:");
        result.Content.ShouldNotContain("data:image");
        result.Assets.Count.ShouldBe(1);
        storage.Uploads.Count.ShouldBe(1);
    }

    [Fact]
    public async Task NormalizeAsync_RewritesLegacyMarkdownDataImages()
    {
        var storage = new FakeAssetStorage();
        var normalizer = new DocumentStoreAssetNormalizer(storage, NullLogger<DocumentStoreAssetNormalizer>.Instance);
        var bytes = Convert.ToBase64String("legacy inline image"u8.ToArray());

        var result = await normalizer.NormalizeAsync(
            $"![旧图](data:image/png;base64,{bytes})",
            null,
            null,
            CancellationToken.None);

        result.Content.ShouldContain("![旧图](https://assets.test/assets/img/inline-1.png)");
        result.Content.ShouldNotContain("data:image");
        result.Assets.Count.ShouldBe(1);
        storage.Uploads.Count.ShouldBe(1);
    }

    private sealed class FakeAssetStorage : IAssetStorage
    {
        public List<(string Domain, string Type, string FileName, byte[] Bytes)> Uploads { get; } = new();

        public Task<StoredAsset> SaveAsync(
            byte[] bytes,
            string mime,
            CancellationToken ct,
            string? domain = null,
            string? type = null,
            string? fileName = null,
            string? extensionHint = null)
        {
            var name = fileName ?? $"inline-{Uploads.Count + 1}.{extensionHint ?? "png"}";
            Uploads.Add((domain ?? "", type ?? "", name, bytes));
            var url = $"https://assets.test/{domain}/{type}/{name}";
            return Task.FromResult(new StoredAsset($"sha-{Uploads.Count}", url, bytes.Length, mime));
        }

        public Task<(byte[] bytes, string mime)?> TryReadByShaAsync(string sha256, CancellationToken ct, string? domain = null, string? type = null)
            => Task.FromResult<(byte[] bytes, string mime)?>(null);

        public Task DeleteByShaAsync(string sha256, CancellationToken ct, string? domain = null, string? type = null)
            => Task.CompletedTask;

        public string? TryBuildUrlBySha(string sha256, string mime, string? domain = null, string? type = null)
            => null;

        public Task<byte[]?> TryDownloadBytesAsync(string key, CancellationToken ct)
            => Task.FromResult<byte[]?>(null);

        public Task<bool> ExistsAsync(string key, CancellationToken ct)
            => Task.FromResult(false);

        public Task UploadToKeyAsync(string key, byte[] bytes, string? contentType, CancellationToken ct, string? cacheControl = null)
            => Task.CompletedTask;

        public string BuildUrlForKey(string key)
            => $"https://assets.test/{key}";

        public Task DeleteByKeyAsync(string key, CancellationToken ct)
            => Task.CompletedTask;

        public string BuildSiteKey(string siteId, string filePath)
            => $"{siteId}/{filePath.TrimStart('/')}";
    }
}
