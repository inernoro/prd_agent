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
