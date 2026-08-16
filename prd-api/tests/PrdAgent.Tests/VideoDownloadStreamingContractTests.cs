using Xunit;
using PrdAgent.Infrastructure.Services.AssetStorage;

namespace PrdAgent.Tests;

public class VideoDownloadStreamingContractTests
{
    [Fact]
    public void VideoDownload_MustStreamWithoutMaterializingCompleteMp4()
    {
        var controller = File.ReadAllText(LocateRepoFile(
            "prd-api/src/PrdAgent.Api/Controllers/Api/VideoDownloadController.cs"));
        var storageContract = File.ReadAllText(LocateRepoFile(
            "prd-api/src/PrdAgent.Infrastructure/Services/AssetStorage/IAssetStorage.cs"));
        var localStorage = File.ReadAllText(LocateRepoFile(
            "prd-api/src/PrdAgent.Infrastructure/Services/AssetStorage/LocalAssetStorage.cs"));

        Assert.DoesNotContain("TryReadByShaAsync", controller);
        Assert.Contains("TryOpenReadByShaAsync", controller);
        Assert.Contains("HttpCompletionOption.ResponseHeadersRead", controller);
        Assert.Contains("CopyToAsync(Response.Body", controller);
        Assert.Contains("enableRangeProcessing: true", controller);
        Assert.Contains("Task<AssetReadHandle?> TryOpenReadByShaAsync", storageContract);
        Assert.Contains("FileOptions.Asynchronous | FileOptions.SequentialScan", localStorage);
    }

    [Fact]
    public void DirectVideoDownload_MustUseHeadersOnlyUpstreamAndStreamToResponse()
    {
        var controller = File.ReadAllText(LocateRepoFile(
            "prd-api/src/PrdAgent.Api/Controllers/Api/VideoAgentController.cs"));
        var client = File.ReadAllText(LocateRepoFile(
            "prd-api/src/PrdAgent.Infrastructure/Services/OpenRouterVideoClient.cs"));

        var actionStart = controller.IndexOf("DownloadDirectVideo(", StringComparison.Ordinal);
        var actionEnd = controller.IndexOf("[HttpDelete(\"videogen-direct/{jobId}\")]", actionStart, StringComparison.Ordinal);
        Assert.True(actionStart >= 0 && actionEnd > actionStart);
        var action = controller[actionStart..actionEnd];

        Assert.Contains("OpenVideoStreamForOfferingAsync", action);
        Assert.Contains("CopyToAsync(Response.Body", action);
        Assert.DoesNotContain("DownloadVideoBytes", action);
        Assert.Contains("HttpCompletionOption.ResponseHeadersRead", client);
    }

    [Fact]
    public void LegacyRunDownload_MustStreamWithoutMaterializingCompleteMp4()
    {
        var controller = File.ReadAllText(LocateRepoFile(
            "prd-api/src/PrdAgent.Api/Controllers/Api/VideoAgentController.cs"));
        var actionStart = controller.IndexOf("public async Task<IActionResult> DownloadRun", StringComparison.Ordinal);
        var actionEnd = controller.IndexOf("[HttpPost(\"runs/{runId}/download-ticket\")]", actionStart, StringComparison.Ordinal);
        Assert.True(actionStart >= 0 && actionEnd > actionStart);
        var action = controller[actionStart..actionEnd];

        Assert.Contains("TryOpenReadByShaAsync", action);
        Assert.Contains("HttpCompletionOption.ResponseHeadersRead", action);
        Assert.Contains("CopyToAsync(Response.Body", action);
        Assert.Contains("enableRangeProcessing: true", action);
        Assert.DoesNotContain("TryReadByShaAsync", action);
        Assert.DoesNotContain("File(asset.Value.bytes", action);
    }

    [Fact]
    public void VideoAgentRunEndpoints_MustPreserveApplicationBoundary()
    {
        var controller = File.ReadAllText(LocateRepoFile(
            "prd-api/src/PrdAgent.Api/Controllers/Api/VideoAgentController.cs"));
        var downloadController = File.ReadAllText(LocateRepoFile(
            "prd-api/src/PrdAgent.Api/Controllers/Api/VideoDownloadController.cs"));

        Assert.DoesNotContain("appKey: null", controller);
        Assert.DoesNotContain("GetRunAsync(runId, GetAdminId(), ct:", controller);
        Assert.DoesNotContain("GetRunAsync(runId, ownerAdminId, ct:", controller);
        Assert.DoesNotContain("GetRunAsync(runId, adminId, ct:", controller);
        Assert.DoesNotContain("CancelRunAsync(runId, GetAdminId(), ct:", controller);
        Assert.Contains("new VideoDownloadTicket(\n            run.Id,\n            ownerAdminId,\n            AppKey,", controller);
        Assert.Contains("payload.AppKey,\n            ct", downloadController);
        Assert.Contains("payload.AppKey, VideoDownloadTicket.ExpectedAppKey", downloadController);
        Assert.Contains("PrdAgent.VideoAgent.DownloadTicket.v2", downloadController);
    }

    [Fact]
    public async Task LocalAssetStorage_MustReturnFileStreamForLargeAssetReads()
    {
        var directory = Path.Combine(Path.GetTempPath(), $"video-stream-{Guid.NewGuid():N}");
        try
        {
            var storage = new LocalAssetStorage(directory);
            var bytes = new byte[2 * 1024 * 1024];
            Random.Shared.NextBytes(bytes);
            var stored = await storage.SaveAsync(
                bytes,
                "video/mp4",
                CancellationToken.None,
                domain: AppDomainPaths.DomainVideoAgent,
                type: AppDomainPaths.TypeVideo,
                extensionHint: ".mp4");

            var opened = await storage.TryOpenReadByShaAsync(
                stored.Sha256,
                CancellationToken.None,
                domain: AppDomainPaths.DomainVideoAgent,
                type: AppDomainPaths.TypeVideo);

            Assert.NotNull(opened);
            await using var content = opened.Content;
            Assert.IsType<FileStream>(content);
            Assert.Equal(bytes.LongLength, opened.Length);
            var prefix = new byte[64];
            Assert.Equal(prefix.Length, await content.ReadAsync(prefix));
            Assert.Equal(bytes.AsSpan(0, prefix.Length).ToArray(), prefix);
        }
        finally
        {
            if (Directory.Exists(directory)) Directory.Delete(directory, recursive: true);
        }
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
