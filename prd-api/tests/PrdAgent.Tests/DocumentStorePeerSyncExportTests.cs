using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Sync.Resources;
using System.Security.Cryptography;
using System.Text;
using Xunit;

namespace PrdAgent.Tests;

public class DocumentStorePeerSyncExportTests
{
    [Fact]
    public void AttachmentPreloadIncludesDualShapeEntries()
    {
        var entries = new[]
        {
            new DocumentEntry { AttachmentId = "binary-attachment" },
            new DocumentEntry { DocumentId = "parsed-prd", AttachmentId = "dual-attachment" },
            new DocumentEntry { IsFolder = true, AttachmentId = "folder-attachment" },
        };

        var ids = DocumentStoreSyncResource.AttachmentIdsForExport(entries);

        Assert.Contains("binary-attachment", ids);
        Assert.Contains("dual-attachment", ids);
        Assert.DoesNotContain("folder-attachment", ids);
    }

    [Fact]
    public void DualShapeEntryFallsBackToExtractedTextWhenParsedPrdIsMissing()
    {
        var entry = new DocumentEntry
        {
            DocumentId = "missing-parsed-prd",
            AttachmentId = "attachment-1",
        };
        var attachment = new Attachment
        {
            AttachmentId = "attachment-1",
            Url = "https://assets.example.test/file.pdf",
            ExtractedText = "附件中的完整正文",
        };

        var payload = DocumentStoreSyncResource.ResolveExportPayload(entry, null, attachment);

        Assert.False(payload.TransferableFile);
        Assert.Equal("附件中的完整正文", payload.Content);
    }

    [Fact]
    public void BinaryOnlyEntryWithUrlKeepsBinaryTransferShape()
    {
        var entry = new DocumentEntry { AttachmentId = "attachment-1" };
        var attachment = new Attachment
        {
            AttachmentId = "attachment-1",
            Url = "https://assets.example.test/file.pdf",
            ExtractedText = "可检索正文",
        };

        var payload = DocumentStoreSyncResource.ResolveExportPayload(entry, null, attachment);

        Assert.True(payload.TransferableFile);
        Assert.Null(payload.Content);
    }

    [Fact]
    public void TextEntryWithoutAnyContentStillExportsNonNullContent()
    {
        var entry = new DocumentEntry { DocumentId = "missing-parsed-prd" };

        var payload = DocumentStoreSyncResource.ResolveExportPayload(entry, null, null);

        Assert.False(payload.TransferableFile);
        Assert.Equal(string.Empty, payload.Content);
    }

    [Fact]
    public void MissingParsedPrdFallsBackToVersionOnlyWhenContentHashMatchesDocumentId()
    {
        const string content = "# 完整正文\n\n来自不可变版本快照";
        var documentId = Sha256(content);
        var version = new DocumentEntryVersion
        {
            EntryId = "entry-1",
            Content = content,
            ContentHash = documentId,
            VersionNumber = 3,
        };

        var resolved = DocumentStoreSyncResource.ResolveVerifiedVersionContent(documentId, version);

        Assert.Equal(content, resolved);
    }

    [Fact]
    public void CorruptedVersionCannotReplaceMissingParsedPrd()
    {
        var version = new DocumentEntryVersion
        {
            EntryId = "entry-1",
            Content = "被篡改的正文",
            ContentHash = Sha256("原正文"),
            VersionNumber = 3,
        };

        var resolved = DocumentStoreSyncResource.ResolveVerifiedVersionContent(version.ContentHash, version);

        Assert.Null(resolved);
    }

    private static string Sha256(string value)
        => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();
}
