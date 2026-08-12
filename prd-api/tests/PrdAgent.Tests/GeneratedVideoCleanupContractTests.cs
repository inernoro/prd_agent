using PrdAgent.Infrastructure.Services.AssetStorage;
using Xunit;

namespace PrdAgent.Tests;

public class GeneratedVideoCleanupContractTests
{
    [Theory]
    [InlineData("video-agent/video/abcdefghijklmnopqrstuvwxyz.mp4", null, true)]
    [InlineData("data/video-agent/video/abcdefghijklmnopqrstuvwxyz.mp4", "data", true)]
    [InlineData("video-agent/video/abcdefghijklmnopqrstuvwxyz.webm", null, false)]
    [InlineData("video-agent/video/too-short.mp4", null, false)]
    [InlineData("visual-agent/video/abcdefghijklmnopqrstuvwxyz.mp4", null, false)]
    [InlineData("video-agent/video/abcdefghijklmnopqrstuvwxyz.mp4/extra", null, false)]
    public void DeletePolicy_ShouldOnlyAllowOneContentAddressedMp4Object(
        string key,
        string? prefix,
        bool expected)
    {
        Assert.Equal(
            expected,
            AssetStorageDeletePolicy.IsContentAddressedGeneratedVideoKey(key, prefix));
    }

    [Fact]
    public void VideoRunCleanup_ShouldPersistShaAndExposeOwnedDeleteEndpoint()
    {
        var worker = File.ReadAllText(LocateRepoFile(
            "prd-api/src/PrdAgent.Api/Services/VideoGenRunWorker.cs"));
        var controller = File.ReadAllText(LocateRepoFile(
            "prd-api/src/PrdAgent.Api/Controllers/Api/VideoAgentController.cs"));
        var service = File.ReadAllText(LocateRepoFile(
            "prd-api/src/PrdAgent.Infrastructure/Services/VideoGenService.cs"));

        Assert.Contains(".Set(x => x.VideoAssetSha256, finalSha256)", worker);
        Assert.Contains("AssetSha256 = stored.Sha256", worker);
        Assert.Contains("[HttpDelete(\"runs/{runId}\")]", controller);
        Assert.Contains("GetAdminId()", controller);
        Assert.Contains("DeleteByShaAsync", service);
        Assert.Contains("sharedReferenceCount", service);
        Assert.Contains("DeletionRequestedAt", service);
        Assert.Contains("DeletionArtifacts", service);
        Assert.Contains("VideoAssetMutationLease.AcquireAsync", service);
        Assert.Contains("VideoAssetMutationLease.AcquireAsync", worker);
        Assert.Contains("ResumePendingDeletionAsync", worker);
        Assert.Contains("DeletionCleanupAttemptedAt", worker);
        Assert.Contains("var cleanupToken = CancellationToken.None", service);
        Assert.True(
            service.IndexOf("DeletionRequestedAt", StringComparison.Ordinal)
            < service.IndexOf("DeleteByShaAsync", StringComparison.Ordinal),
            "删除生成视频对象前必须先持久化删除标记和清理清单");
        Assert.True(
            service.IndexOf("VideoExportTasks.DeleteManyAsync", StringComparison.Ordinal)
            < service.IndexOf("DeleteByShaAsync", StringComparison.Ordinal),
            "删除生成视频对象前必须先清理依赖记录，失败时保留可恢复对象");
        Assert.Contains("deleteEmptyProject", service);
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
