using PrdAgent.Infrastructure.Services.AssetStorage;
using Xunit;

namespace PrdAgent.Tests;

public sealed class DesignWorkspaceAssetCleanupContractTests
{
    [Theory]
    [InlineData("web-hosting/meta/abcdefghijklmnopqrstuvwxyz.json", null, true)]
    [InlineData("data/web-hosting/meta/abcdefghijklmnopqrstuvwxyz.json", "data", true)]
    [InlineData("web-hosting/meta/abcdefghijklmnopqrstuvwxyz.txt", null, false)]
    [InlineData("web-hosting/meta/too-short.json", null, false)]
    [InlineData("web-hosting/sites/abcdefghijklmnopqrstuvwxyz.json", null, false)]
    [InlineData("web-hosting/meta/abcdefghijklmnopqrstuvwxyz.json/extra", null, false)]
    public void DeletePolicyOnlyAllowsOneContentAddressedWorkspaceMetadataObject(
        string key,
        string? prefix,
        bool expected)
    {
        Assert.Equal(
            expected,
            AssetStorageDeletePolicy.IsContentAddressedDesignWorkspaceMetadataKey(key, prefix));
    }

    [Fact]
    public void RemoteStorageProvidersUseTheSameWorkspaceMetadataDeletePolicy()
    {
        var r2 = File.ReadAllText(LocateRepoFile(
            "prd-api/src/PrdAgent.Infrastructure/Services/AssetStorage/CloudflareR2Storage.cs"));
        var cos = File.ReadAllText(LocateRepoFile(
            "prd-api/src/PrdAgent.Infrastructure/Services/AssetStorage/TencentCosStorage.cs"));

        Assert.Contains("IsContentAddressedDesignWorkspaceMetadataKey", r2);
        Assert.Contains("owned_design_workspace_metadata", r2);
        Assert.Contains("IsContentAddressedDesignWorkspaceMetadataKey", cos);
        Assert.Contains("owned_design_workspace_metadata", cos);
    }

    private static string LocateRepoFile(string relativePath)
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory != null)
        {
            var candidate = Path.Combine(directory.FullName, relativePath);
            if (File.Exists(candidate)) return candidate;
            directory = directory.Parent;
        }
        throw new FileNotFoundException($"Could not locate repository file: {relativePath}");
    }
}
