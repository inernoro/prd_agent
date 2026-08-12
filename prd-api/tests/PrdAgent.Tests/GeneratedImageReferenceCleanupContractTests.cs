using Xunit;

namespace PrdAgent.Tests;

public class GeneratedImageReferenceCleanupContractTests
{
    [Fact]
    public void ImageCleanup_MustCheckEveryPersistedShaReferenceBeforePhysicalDeletion()
    {
        var controller = File.ReadAllText(LocateRepoFile(
            "prd-api/src/PrdAgent.Api/Controllers/Api/ImageMasterController.cs"));

        Assert.Contains("TryDeleteUnreferencedGeneratedImageAsync", controller);
        Assert.Contains("item => item.Sha256", controller);
        Assert.Contains("item => item.OriginalSha256", controller);
        Assert.Contains("item => item.InitImageAssetSha256", controller);
        Assert.Contains("ImageRefs.AssetSha256", controller);
        Assert.Contains("excludedRunIds", controller);
        Assert.Contains("excludedArtifactIds", controller);
        Assert.Equal(
            1,
            controller.Split("_assetStorage.DeleteByShaAsync", StringSplitOptions.None).Length - 1);
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

        throw new FileNotFoundException($"找不到仓库文件：{relativePath}");
    }
}
