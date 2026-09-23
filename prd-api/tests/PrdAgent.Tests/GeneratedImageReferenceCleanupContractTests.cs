using Xunit;

namespace PrdAgent.Tests;

public class GeneratedImageReferenceCleanupContractTests
{
    [Fact]
    public void ImageCleanup_MustCheckEveryPersistedShaReferenceBeforePhysicalDeletion()
    {
        var controller = File.ReadAllText(LocateRepoFile(
            "prd-api/src/PrdAgent.Api/Services/ImageMasterWorkspaceDeletionService.cs"));

        Assert.Contains("TryDeleteUnreferencedGeneratedImageAsync", controller);
        Assert.Contains("item => item.Sha256", controller);
        Assert.Contains("item => item.OriginalSha256", controller);
        Assert.Contains("item => item.DisplaySha256", controller);
        Assert.Contains("item => item.DisplaySha256 == sha", controller);
        Assert.Contains("item => item.InitImageAssetSha256", controller);
        Assert.Contains("ImageRefs.AssetSha256", controller);
        Assert.Equal(
            1,
            controller.Split("_assetStorage.DeleteByShaAsync", StringSplitOptions.None).Length - 1);
    }

    [Fact]
    public void ReferenceImageWriters_MustShareShaLeaseWithPhysicalCleanup()
    {
        var configController = File.ReadAllText(LocateRepoFile(
            "prd-api/src/PrdAgent.Api/Controllers/Api/LiteraryAgentConfigController.cs"));
        var dataTransferController = File.ReadAllText(LocateRepoFile(
            "prd-api/src/PrdAgent.Api/Controllers/Api/DataTransferController.cs"));

        Assert.Contains("SHA256.HashData(bytes)", configController);
        Assert.True(
            configController.Split("VideoAssetMutationLease.AcquireAsync", StringSplitOptions.None).Length - 1 >= 5,
            "创建、替换、删除、旧上传和 Fork 都必须与物理清理共用 SHA 租约");
        Assert.Contains("$\"generated-image:{assetSha256}\"", configController);
        Assert.Contains("x.ImageSha256 == source.ImageSha256", configController);
        Assert.Contains("VideoAssetMutationLease.AcquireAsync", dataTransferController);
        Assert.Contains("r.ImageSha256 == source.ImageSha256", dataTransferController);
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
