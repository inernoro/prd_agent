using PrdAgent.Infrastructure.Services.AssetStorage;
using Xunit;

namespace PrdAgent.Tests;

public class GeneratedImageCleanupContractTests
{
    [Theory]
    [InlineData("visual-agent/img/abcdefghijklmnopqrstuvwxyz.png", null, true)]
    [InlineData("data/visual-agent/img/abcdefghijklmnopqrstuvwxyz.webp", "data", true)]
    [InlineData("visual-agent/img/abcdefghijklmnopqrstuvwxyz.jpg", null, true)]
    [InlineData("visual-agent/img/abcdefghijklmnopqrstuvwxyz.svg", null, false)]
    [InlineData("visual-agent/img/too-short.png", null, false)]
    [InlineData("assets/img/abcdefghijklmnopqrstuvwxyz.png", null, false)]
    [InlineData("visual-agent/img/abcdefghijklmnopqrstuvwxyz.png/extra", null, false)]
    public void DeletePolicy_ShouldOnlyAllowOneContentAddressedImageObject(
        string key,
        string? prefix,
        bool expected)
    {
        Assert.Equal(
            expected,
            AssetStorageDeletePolicy.IsContentAddressedGeneratedImageKey(key, prefix));
    }

    [Fact]
    public void RemoteStorageProviders_ShouldUseTheSameGeneratedImageDeletePolicy()
    {
        var r2 = File.ReadAllText(LocateRepoFile(
            "prd-api/src/PrdAgent.Infrastructure/Services/AssetStorage/CloudflareR2Storage.cs"));
        var cos = File.ReadAllText(LocateRepoFile(
            "prd-api/src/PrdAgent.Infrastructure/Services/AssetStorage/TencentCosStorage.cs"));

        Assert.Contains("IsContentAddressedGeneratedImageKey", r2);
        Assert.Contains("owned_generated_image", r2);
        Assert.Contains("IsContentAddressedGeneratedImageKey", cos);
        Assert.Contains("owned_generated_image", cos);
    }

    [Fact]
    public void GeneratedImageCleanup_ShouldOnlyProbeImageExtensions()
    {
        foreach (var relativePath in new[]
                 {
                     "prd-api/src/PrdAgent.Infrastructure/Services/AssetStorage/CloudflareR2Storage.cs",
                     "prd-api/src/PrdAgent.Infrastructure/Services/AssetStorage/TencentCosStorage.cs",
                 })
        {
            var source = File.ReadAllText(LocateRepoFile(relativePath));
            var visualBranch = source.IndexOf(
                "string.Equals(domain, AppDomainPaths.DomainVisualAgent",
                StringComparison.Ordinal);
            var genericBranch = source.IndexOf(
                "return [\"png\", \"jpg\", \"jpeg\", \"webp\", \"gif\", \"ttf\"",
                visualBranch,
                StringComparison.Ordinal);
            Assert.True(visualBranch >= 0 && genericBranch > visualBranch);
            var generatedImageBranch = source[visualBranch..genericBranch];
            Assert.Contains("return [\"png\", \"jpg\", \"jpeg\", \"webp\", \"gif\"]", generatedImageBranch);
            Assert.DoesNotContain("ttf", generatedImageBranch);
            Assert.DoesNotContain("txt", generatedImageBranch);
        }
    }

    [Fact]
    public void GeneratedImageWriteAndCleanup_ShouldShareTheSamePerShaLease()
    {
        var writer = File.ReadAllText(LocateRepoFile(
            "prd-api/src/PrdAgent.Infrastructure/LLM/OpenAIImageClient.cs"));
        var cleanup = File.ReadAllText(LocateRepoFile(
            "prd-api/src/PrdAgent.Api/Controllers/Api/ImageMasterController.cs"));
        var avatarCleanup = File.ReadAllText(LocateRepoFile(
            "prd-api/src/PrdAgent.Api/Services/ProfileAvatarGenerationCleanupService.cs"));

        Assert.Contains("$\"generated-image:{sha}\"", writer);
        Assert.Contains("SaveGeneratedOutputAsync", writer);
        var helper = writer[writer.IndexOf(
            "private async Task<StoredAsset> SaveGeneratedOutputAsync",
            StringComparison.Ordinal)..];
        Assert.True(
            helper.IndexOf("VideoAssetMutationLease.AcquireAsync", StringComparison.Ordinal)
            < helper.IndexOf("_assetStorage.SaveAsync", StringComparison.Ordinal));
        Assert.Contains("$\"generated-image:{sha}\"", cleanup);
        Assert.Contains("$\"generated-image:{sha}\"", avatarCleanup);
    }

    [Fact]
    public void LegacyWorkerFallback_ShouldHoldThePerShaLeaseUntilReferenceInsertion()
    {
        var worker = File.ReadAllText(LocateRepoFile(
            "prd-api/src/PrdAgent.Api/Services/ImageGenRunWorker.cs"));
        var fallbackStart = worker.IndexOf(
            "回退：下载展示图保存（兼容旧逻辑）",
            StringComparison.Ordinal);
        var helperStart = worker.IndexOf(
            "private async Task<ImageAsset> PersistImageAssetRecordAsync",
            fallbackStart,
            StringComparison.Ordinal);
        Assert.True(fallbackStart >= 0 && helperStart > fallbackStart);
        var fallback = worker[fallbackStart..helperStart];

        Assert.Contains("SHA256.HashData(bytes)", fallback);
        Assert.Contains("$\"generated-image:{assetSha256}\"", fallback);
        Assert.True(
            fallback.IndexOf("VideoAssetMutationLease.AcquireAsync", StringComparison.Ordinal)
            < fallback.IndexOf("assetStorage.SaveAsync", StringComparison.Ordinal));
        Assert.Contains("return await PersistImageAssetRecordAsync", fallback);

        var helper = worker[helperStart..];
        Assert.Contains("_db.ImageAssets.InsertOneAsync", helper);
    }

    private static string LocateRepoFile(string relativePath)
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null)
        {
            var candidate = Path.Combine(dir.FullName, relativePath);
            if (File.Exists(candidate)) return candidate;
            dir = dir.Parent;
        }

        throw new FileNotFoundException($"Cannot locate repository file: {relativePath}");
    }
}
