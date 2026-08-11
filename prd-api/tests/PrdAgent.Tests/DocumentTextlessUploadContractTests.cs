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
