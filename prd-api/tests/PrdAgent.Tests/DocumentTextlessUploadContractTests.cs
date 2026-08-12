using Xunit;

namespace PrdAgent.Tests;

public class DocumentTextlessUploadContractTests
{
    [Fact]
    public void ValidTextlessDocuments_MustRemainUploadableAsAttachments()
    {
        var source = File.ReadAllText(LocateRepoFile(
            "prd-api/src/PrdAgent.Api/Controllers/Api/DocumentStoreController.cs"));

        Assert.DoesNotContain("没有从该文件中读取到内容", source);
        Assert.Contains("if (!string.IsNullOrWhiteSpace(extractedText))", source);
        Assert.Contains("AttachmentId = attachment.AttachmentId", source);
    }

    [Fact]
    public void SyntheticUploads_MustUseTrackedTestObjectsAndDeleteTheBackingBlob()
    {
        var controller = File.ReadAllText(LocateRepoFile(
            "prd-api/src/PrdAgent.Api/Controllers/Api/DocumentStoreController.cs"));
        var attachment = File.ReadAllText(LocateRepoFile(
            "prd-api/src/PrdAgent.Core/Models/Attachment.cs"));
        var stableSmoke = File.ReadAllText(LocateRepoFile(
            "e2e/specs/stable-smoke.spec.ts"));

        Assert.Contains("FederatedConsoleSessionPolicy.IsSynthetic(User)", controller);
        Assert.Contains("_it/stable-smoke-document/", controller);
        Assert.Contains("StorageKey = storedUpload.StorageKey", controller);
        Assert.Contains("DeleteUnreferencedStoredAssetsAsync(attachments, attachmentIds", controller);
        Assert.Contains("_assetStorage.DeleteByKeyAsync(storageKey", controller);
        Assert.Contains("public string? StorageKey", attachment);
        Assert.Contains("createdFileUrls.push(uploaded.fileUrl)", stableSmoke);
        Assert.Contains("删除知识库后原始文件必须同步清理", stableSmoke);
        Assert.Contains(".toBe(404)", stableSmoke);
    }

    [Fact]
    public void AttachmentDownload_MustReadLocalRelativeUrlsThroughAssetStorage()
    {
        var controller = File.ReadAllText(LocateRepoFile(
            "prd-api/src/PrdAgent.Api/Controllers/Api/DocumentStoreController.cs"));
        var endpointStart = controller.IndexOf(
            "public async Task<IActionResult> DownloadEntryAttachment",
            StringComparison.Ordinal);
        var endpointEnd = controller.IndexOf(
            "public async Task<IActionResult> CreativePublishEntry",
            endpointStart,
            StringComparison.Ordinal);
        var endpoint = controller[endpointStart..endpointEnd];

        Assert.Contains("TryGetLocalAssetStorageKey", endpoint);
        Assert.Contains("_assetStorage.TryDownloadBytesAsync(localStorageKey", endpoint);
        Assert.Contains("EnsureSafeHttpUrlAsync", endpoint);
        Assert.True(
            endpoint.IndexOf("TryGetLocalAssetStorageKey", StringComparison.Ordinal)
            < endpoint.IndexOf("EnsureSafeHttpUrlAsync", StringComparison.Ordinal));
    }

    [Fact]
    public void StableSmoke_MustProveVisibleLiteraryProgressAndThreeImageReferences()
    {
        var imageMaster = File.ReadAllText(LocateRepoFile(
            "prd-api/src/PrdAgent.Api/Controllers/Api/ImageMasterController.cs"));
        var imageGen = File.ReadAllText(LocateRepoFile(
            "prd-api/src/PrdAgent.Api/Controllers/Api/ImageGenController.cs"));
        var literaryPage = File.ReadAllText(LocateRepoFile(
            "prd-admin/src/pages/literary-agent/ArticleIllustrationEditorPage.tsx"));
        var stableSmoke = File.ReadAllText(LocateRepoFile(
            "e2e/specs/stable-smoke.spec.ts"));

        var preparingIndex = imageMaster.IndexOf("正在准备文章配图标记", StringComparison.Ordinal);
        var gatewayIndex = imageMaster.IndexOf("_gateway.CreateClient(appCallerCode", preparingIndex, StringComparison.Ordinal);
        Assert.True(preparingIndex >= 0);
        Assert.True(gatewayIndex > preparingIndex);
        Assert.Contains("chunk.type === 'progress' && chunk.message", literaryPage);
        Assert.Contains("setRawMarkerOutput(chunk.message)", literaryPage);
        Assert.Contains("firstVisibleProgressMs", stableSmoke);
        Assert.Contains("toBeLessThan(2_000)", stableSmoke);
        Assert.Contains("refId: 3", stableSmoke);
        Assert.Contains("imageRefs = run.ImageRefs?.Select", imageGen);
        Assert.Contains("label: '红色参考', role: 'reference'", stableSmoke);
        Assert.Contains("expect(messageText).toContain('@img3')", stableSmoke);
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
