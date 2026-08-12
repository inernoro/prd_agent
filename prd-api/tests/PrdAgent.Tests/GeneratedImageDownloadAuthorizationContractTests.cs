using Xunit;

namespace PrdAgent.Tests;

public class GeneratedImageDownloadAuthorizationContractTests
{
    [Fact]
    public void Download_ShouldAcceptOwnedSynchronousArtifactWithoutWeakeningUserIsolation()
    {
        var source = File.ReadAllText(LocateRepoFile(
            "prd-api/src/PrdAgent.Api/Controllers/Api/ImageGenController.cs"));
        var actionStart = source.IndexOf(
            "public async Task<IActionResult> DownloadGeneratedImage",
            StringComparison.Ordinal);
        var actionEnd = source.IndexOf(
            "[HttpGet(\"runs/{runId}/stream\")]",
            actionStart,
            StringComparison.Ordinal);
        Assert.True(actionStart >= 0 && actionEnd > actionStart);
        var action = source[actionStart..actionEnd];

        Assert.Contains("artifact.CreatedByAdminId == adminId", action);
        Assert.Contains("artifact.Kind == \"output_image\"", action);
        Assert.Contains("artifact.CosUrl == normalizedUrl", action);
        Assert.Contains("var ownedRequestId = $\"{ownedItem.RunId}-{ownedItem.ItemIndex}-{ownedItem.ImageIndex}\"", action);
        Assert.Contains("artifact.RequestId == ownedRequestId", action);
        Assert.Contains("asset.OwnerUserId == adminId", action);
        Assert.Contains("var sha256 = ownedItem?.DisplaySha256", action);
        Assert.Contains("imageAsset?.Url == normalizedUrl ? imageAsset.DisplaySha256", action);
        Assert.Contains("? AppDomainPaths.DomainWatermark", action);
        Assert.Contains("domain: assetDomain", action);
        Assert.Contains("ownedItem == null && outputArtifact == null && imageAsset == null", action);
        Assert.DoesNotContain("if (ownedItem == null)\n        {\n            return NotFound", action);

        var imageClient = File.ReadAllText(LocateRepoFile(
            "prd-api/src/PrdAgent.Infrastructure/LLM/OpenAIImageClient.cs"));
        var worker = File.ReadAllText(LocateRepoFile(
            "prd-api/src/PrdAgent.Api/Services/ImageGenRunWorker.cs"));
        Assert.Contains("displaySha256 = watermarkedStored.Sha256", imageClient);
        Assert.Contains("DisplaySha256 = string.IsNullOrWhiteSpace(displaySha256)", worker);
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
