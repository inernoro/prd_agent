using Microsoft.Extensions.Logging;
using MongoDB.Driver;
using Moq;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services;
using PrdAgent.Infrastructure.Services.AssetStorage;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// KnowledgeBaseService 单元测试（基于内存 Mock）
/// 覆盖：上传/替换/删除/数量上限/大小校验/文件格式/文本提取
/// </summary>
public class KnowledgeBaseServiceTests
{
    private readonly Mock<IMongoCollection<KbDocument>> _collectionMock;
    private readonly Mock<IAssetStorage> _storageMock;
    private readonly Mock<ILogger<KnowledgeBaseService>> _loggerMock;
    private readonly KnowledgeBaseService _service;

    public KnowledgeBaseServiceTests()
    {
        _collectionMock = new Mock<IMongoCollection<KbDocument>>();
        _storageMock = new Mock<IAssetStorage>();
        _loggerMock = new Mock<ILogger<KnowledgeBaseService>>();

        // 默认 Storage mock：返回稳定结果
        _storageMock
            .Setup(s => s.SaveAsync(It.IsAny<byte[]>(), It.IsAny<string>(), It.IsAny<CancellationToken>(),
                It.IsAny<string?>(), It.IsAny<string?>()))
            .ReturnsAsync((byte[] bytes, string mime, CancellationToken ct, string? domain, string? type) =>
                new StoredAsset(
                    Sha256: "fakeSha256_" + Guid.NewGuid().ToString("N")[..8],
                    Url: $"https://cos.example.com/{domain}/{type}/{Guid.NewGuid():N}",
                    SizeBytes: bytes.Length,
                    Mime: mime));

        _service = new KnowledgeBaseService(_collectionMock.Object, _storageMock.Object, _loggerMock.Object);
    }

    #region Upload - Validation Tests

    [Fact]
    public async Task UploadDocumentsAsync_EmptyFile_ThrowsInvalidOperation()
    {
        SetupCountDocuments(0);
        var files = new List<KbUploadFile>
        {
            new() { FileName = "test.pdf", Content = Array.Empty<byte>(), Size = 0, MimeType = "application/pdf" }
        };

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(
            () => _service.UploadDocumentsAsync("group1", "user1", files));
        Assert.Contains("内容为空", ex.Message);
    }

    [Fact]
    public async Task UploadDocumentsAsync_FileTooLarge_ThrowsInvalidOperation()
    {
        SetupCountDocuments(0);
        var largeContent = new byte[11 * 1024 * 1024]; // 11MB > 10MB limit
        var files = new List<KbUploadFile>
        {
            new() { FileName = "huge.pdf", Content = largeContent, Size = largeContent.Length, MimeType = "application/pdf" }
        };

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(
            () => _service.UploadDocumentsAsync("group1", "user1", files));
        Assert.Contains("大小超过限制", ex.Message);
    }

    [Fact]
    public async Task UploadDocumentsAsync_UnsupportedFormat_ThrowsInvalidOperation()
    {
        SetupCountDocuments(0);
        var files = new List<KbUploadFile>
        {
            new() { FileName = "test.docx", Content = new byte[] { 1, 2, 3 }, Size = 3, MimeType = "application/vnd.openxmlformats" }
        };

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(
            () => _service.UploadDocumentsAsync("group1", "user1", files));
        Assert.Contains("格式不支持", ex.Message);
    }

    [Fact]
    public async Task UploadDocumentsAsync_TxtFormat_ThrowsInvalidOperation()
    {
        SetupCountDocuments(0);
        var files = new List<KbUploadFile>
        {
            new() { FileName = "notes.txt", Content = new byte[] { 0x48, 0x65 }, Size = 2, MimeType = "text/plain" }
        };

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(
            () => _service.UploadDocumentsAsync("group1", "user1", files));
        Assert.Contains("格式不支持", ex.Message);
    }

    #endregion

    #region Upload - Quantity Limit Tests

    [Fact]
    public async Task UploadDocumentsAsync_ExceedsMaxDocuments_ThrowsInvalidOperation()
    {
        SetupCountDocuments(8);
        var files = new List<KbUploadFile>
        {
            new() { FileName = "a.md", Content = new byte[] { 0x23, 0x20, 0x41 }, Size = 3, MimeType = "text/markdown" },
            new() { FileName = "b.md", Content = new byte[] { 0x23, 0x20, 0x42 }, Size = 3, MimeType = "text/markdown" },
            new() { FileName = "c.md", Content = new byte[] { 0x23, 0x20, 0x43 }, Size = 3, MimeType = "text/markdown" }
        };

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(
            () => _service.UploadDocumentsAsync("group1", "user1", files));
        Assert.Contains("不能超过10", ex.Message);
    }

    [Fact]
    public async Task UploadDocumentsAsync_ExactlyAtLimit_ThrowsInvalidOperation()
    {
        SetupCountDocuments(10);
        var files = new List<KbUploadFile>
        {
            new() { FileName = "a.md", Content = new byte[] { 0x23, 0x20, 0x41 }, Size = 3, MimeType = "text/markdown" }
        };

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(
            () => _service.UploadDocumentsAsync("group1", "user1", files));
        Assert.Contains("不能超过10", ex.Message);
    }

    [Fact]
    public async Task UploadDocumentsAsync_ExactlyMaxDocCount_Succeeds()
    {
        SetupCountDocuments(9);
        SetupInsertOne();
        var content = System.Text.Encoding.UTF8.GetBytes("# Test");
        var files = new List<KbUploadFile>
        {
            new() { FileName = "tenth.md", Content = content, Size = content.Length, MimeType = "text/markdown" }
        };

        var results = await _service.UploadDocumentsAsync("group1", "user1", files);
        Assert.Single(results);
    }

    #endregion

    #region Upload - Success Tests

    [Fact]
    public async Task UploadDocumentsAsync_ValidMdFile_UploadsSuccessfully()
    {
        SetupCountDocuments(0);
        SetupInsertOne();
        var mdContent = System.Text.Encoding.UTF8.GetBytes("# Hello World\n\nThis is a test document.");
        var files = new List<KbUploadFile>
        {
            new() { FileName = "test.md", Content = mdContent, Size = mdContent.Length, MimeType = "text/markdown" }
        };

        var results = await _service.UploadDocumentsAsync("group1", "user1", files);

        Assert.Single(results);
        var doc = results[0];
        Assert.Equal("group1", doc.GroupId);
        Assert.Equal("test.md", doc.FileName);
        Assert.Equal(KbFileType.Markdown, doc.FileType);
        Assert.Equal(mdContent.Length, doc.FileSize);
        Assert.Equal("# Hello World\n\nThis is a test document.", doc.TextContent);
        Assert.True(doc.CharCount > 0);
        Assert.True(doc.TokenEstimate > 0);
        Assert.Equal("user1", doc.UploadedBy);
        Assert.Equal(KbDocumentStatus.Active, doc.Status);
        Assert.Equal(1, doc.ReplaceVersion);

        _storageMock.Verify(s => s.SaveAsync(
            mdContent, "text/markdown", It.IsAny<CancellationToken>(), "kb-documents", "md"), Times.Once);
    }

    [Fact]
    public async Task UploadDocumentsAsync_MultipleFiles_UploadsAll()
    {
        SetupCountDocuments(0);
        SetupInsertOne();
        var files = new List<KbUploadFile>
        {
            new() { FileName = "a.md", Content = System.Text.Encoding.UTF8.GetBytes("# A"), Size = 3, MimeType = "text/markdown" },
            new() { FileName = "b.md", Content = System.Text.Encoding.UTF8.GetBytes("# B"), Size = 3, MimeType = "text/markdown" },
            new() { FileName = "c.md", Content = System.Text.Encoding.UTF8.GetBytes("# C"), Size = 3, MimeType = "text/markdown" }
        };

        var results = await _service.UploadDocumentsAsync("group1", "user1", files);

        Assert.Equal(3, results.Count);
        Assert.All(results, doc => Assert.Equal("group1", doc.GroupId));
        Assert.Equal("a.md", results[0].FileName);
        Assert.Equal("b.md", results[1].FileName);
        Assert.Equal("c.md", results[2].FileName);

        _storageMock.Verify(s => s.SaveAsync(
            It.IsAny<byte[]>(), It.IsAny<string>(), It.IsAny<CancellationToken>(),
            "kb-documents", "md"), Times.Exactly(3));
    }

    [Fact]
    public async Task UploadDocumentsAsync_PdfFile_CorrectStorageType()
    {
        SetupCountDocuments(0);
        SetupInsertOne();
        var pdfContent = System.Text.Encoding.UTF8.GetBytes("%PDF-1.4 fake content");
        var files = new List<KbUploadFile>
        {
            new() { FileName = "test.pdf", Content = pdfContent, Size = pdfContent.Length, MimeType = "application/pdf" }
        };

        var results = await _service.UploadDocumentsAsync("group1", "user1", files);

        Assert.Single(results);
        Assert.Equal(KbFileType.Pdf, results[0].FileType);

        _storageMock.Verify(s => s.SaveAsync(
            pdfContent, "application/pdf", It.IsAny<CancellationToken>(), "kb-documents", "pdf"), Times.Once);
    }

    [Fact]
    public async Task UploadDocumentsAsync_ExactlyMaxSize_Succeeds()
    {
        SetupCountDocuments(0);
        SetupInsertOne();
        var content = new byte[10 * 1024 * 1024];
        content[0] = 0x23;
        content[1] = 0x20;
        content[2] = 0x41;
        var files = new List<KbUploadFile>
        {
            new() { FileName = "max.md", Content = content, Size = content.Length, MimeType = "text/markdown" }
        };

        var results = await _service.UploadDocumentsAsync("group1", "user1", files);
        Assert.Single(results);
    }

    #endregion

    #region File Type Detection Tests

    [Theory]
    [InlineData("test.pdf", KbFileType.Pdf)]
    [InlineData("test.PDF", KbFileType.Pdf)]
    [InlineData("MY-DOC.Pdf", KbFileType.Pdf)]
    [InlineData("test.md", KbFileType.Markdown)]
    [InlineData("test.MD", KbFileType.Markdown)]
    [InlineData("my-doc.Md", KbFileType.Markdown)]
    public async Task UploadDocumentsAsync_DetectsFileTypeCorrectly(string fileName, KbFileType expectedType)
    {
        SetupCountDocuments(0);
        SetupInsertOne();
        var content = System.Text.Encoding.UTF8.GetBytes("# Test content");
        var files = new List<KbUploadFile>
        {
            new() { FileName = fileName, Content = content, Size = content.Length, MimeType = "application/octet-stream" }
        };

        var results = await _service.UploadDocumentsAsync("group1", "user1", files);
        Assert.Equal(expectedType, results[0].FileType);
    }

    #endregion

    #region Text Extraction Tests

    [Fact]
    public async Task UploadDocumentsAsync_MarkdownFile_ExtractsTextCorrectly()
    {
        SetupCountDocuments(0);
        SetupInsertOne();
        var markdownText = "# 产品需求文档\n\n## 1. 概述\n\n本文档描述了系统的核心需求。";
        var content = System.Text.Encoding.UTF8.GetBytes(markdownText);
        var files = new List<KbUploadFile>
        {
            new() { FileName = "prd.md", Content = content, Size = content.Length, MimeType = "text/markdown" }
        };

        var results = await _service.UploadDocumentsAsync("group1", "user1", files);

        Assert.Equal(markdownText, results[0].TextContent);
        Assert.Equal(markdownText.Length, results[0].CharCount);
    }

    [Fact]
    public async Task UploadDocumentsAsync_InvalidPdf_TextContentIsNull()
    {
        SetupCountDocuments(0);
        SetupInsertOne();
        var content = new byte[] { 0x25, 0x50, 0x44, 0x46, 0x2D };
        var files = new List<KbUploadFile>
        {
            new() { FileName = "broken.pdf", Content = content, Size = content.Length, MimeType = "application/pdf" }
        };

        var results = await _service.UploadDocumentsAsync("group1", "user1", files);
        Assert.Null(results[0].TextContent);
        Assert.Equal(0, results[0].CharCount);
    }

    #endregion

    #region Token Estimation Tests

    [Fact]
    public async Task UploadDocumentsAsync_TokenEstimation_CorrectRatio()
    {
        SetupCountDocuments(0);
        SetupInsertOne();
        var text = new string('a', 1800);
        var content = System.Text.Encoding.UTF8.GetBytes(text);
        var files = new List<KbUploadFile>
        {
            new() { FileName = "doc.md", Content = content, Size = content.Length, MimeType = "text/markdown" }
        };

        var results = await _service.UploadDocumentsAsync("group1", "user1", files);
        var expectedTokens = (int)(text.Length / 1.8);
        Assert.Equal(expectedTokens, results[0].TokenEstimate);
    }

    #endregion

    #region Delete Tests

    [Fact]
    public async Task DeleteDocumentAsync_NonexistentDoc_ThrowsInvalidOperation()
    {
        SetupFindById(null);

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(
            () => _service.DeleteDocumentAsync("nonexistent", "group1"));
        Assert.Contains("文档不存在", ex.Message);
    }

    [Fact]
    public async Task DeleteDocumentAsync_WrongGroup_ThrowsInvalidOperation()
    {
        SetupFindById(new KbDocument { DocumentId = "doc1", GroupId = "group2", Status = KbDocumentStatus.Active });

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(
            () => _service.DeleteDocumentAsync("doc1", "group1"));
        Assert.Contains("不属于该群组", ex.Message);
    }

    [Fact]
    public async Task DeleteDocumentAsync_ValidDoc_CallsUpdateOne()
    {
        var doc = new KbDocument { DocumentId = "doc1", GroupId = "group1", Status = KbDocumentStatus.Active };
        SetupFindById(doc);
        SetupUpdateOne();

        await _service.DeleteDocumentAsync("doc1", "group1");

        _collectionMock.Verify(c => c.UpdateOneAsync(
            It.IsAny<FilterDefinition<KbDocument>>(),
            It.IsAny<UpdateDefinition<KbDocument>>(),
            It.IsAny<UpdateOptions>(),
            It.IsAny<CancellationToken>()), Times.Once);
    }

    #endregion

    #region Replace Tests

    [Fact]
    public async Task ReplaceDocumentAsync_NonexistentDoc_ThrowsInvalidOperation()
    {
        SetupFindById(null);
        var file = new KbUploadFile
        {
            FileName = "new.md",
            Content = System.Text.Encoding.UTF8.GetBytes("# New"),
            Size = 5,
            MimeType = "text/markdown"
        };

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(
            () => _service.ReplaceDocumentAsync("nonexistent", "group1", file));
        Assert.Contains("文档不存在", ex.Message);
    }

    [Fact]
    public async Task ReplaceDocumentAsync_WrongGroup_ThrowsInvalidOperation()
    {
        SetupFindById(new KbDocument { DocumentId = "doc1", GroupId = "group2", Status = KbDocumentStatus.Active });
        var file = new KbUploadFile
        {
            FileName = "new.md",
            Content = System.Text.Encoding.UTF8.GetBytes("# New"),
            Size = 5,
            MimeType = "text/markdown"
        };

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(
            () => _service.ReplaceDocumentAsync("doc1", "group1", file));
        Assert.Contains("不属于该群组", ex.Message);
    }

    [Fact]
    public async Task ReplaceDocumentAsync_FileTooLarge_ThrowsInvalidOperation()
    {
        SetupFindById(new KbDocument { DocumentId = "doc1", GroupId = "group1", Status = KbDocumentStatus.Active });
        var file = new KbUploadFile
        {
            FileName = "huge.md",
            Content = new byte[11 * 1024 * 1024],
            Size = 11 * 1024 * 1024,
            MimeType = "text/markdown"
        };

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(
            () => _service.ReplaceDocumentAsync("doc1", "group1", file));
        Assert.Contains("大小超过限制", ex.Message);
    }

    [Fact]
    public async Task ReplaceDocumentAsync_ValidFile_UploadsNewAndDeletesOld()
    {
        var oldDoc = new KbDocument
        {
            DocumentId = "doc1",
            GroupId = "group1",
            Status = KbDocumentStatus.Active,
            FileSha256 = "oldSha256",
            FileType = KbFileType.Markdown
        };
        var updatedDoc = new KbDocument
        {
            DocumentId = "doc1",
            GroupId = "group1",
            Status = KbDocumentStatus.Active,
            FileName = "replacement.md",
            TextContent = "# Replaced",
            ReplaceVersion = 2
        };
        SetupFindByIdSequence(new[] { oldDoc, updatedDoc });
        SetupUpdateOne();

        var file = new KbUploadFile
        {
            FileName = "replacement.md",
            Content = System.Text.Encoding.UTF8.GetBytes("# Replaced"),
            Size = 10,
            MimeType = "text/markdown"
        };

        await _service.ReplaceDocumentAsync("doc1", "group1", file);

        _storageMock.Verify(s => s.SaveAsync(
            It.IsAny<byte[]>(), "text/markdown", It.IsAny<CancellationToken>(), "kb-documents", "md"), Times.Once);
        _storageMock.Verify(s => s.DeleteByShaAsync(
            "oldSha256", It.IsAny<CancellationToken>(), "kb-documents", "md"), Times.Once);
    }

    [Fact]
    public async Task ReplaceDocumentAsync_OldFileDeleteFails_DoesNotThrow()
    {
        var oldDoc = new KbDocument
        {
            DocumentId = "doc1",
            GroupId = "group1",
            Status = KbDocumentStatus.Active,
            FileSha256 = "oldSha256",
            FileType = KbFileType.Pdf
        };
        var updatedDoc = new KbDocument { DocumentId = "doc1", GroupId = "group1", Status = KbDocumentStatus.Active };
        SetupFindByIdSequence(new[] { oldDoc, updatedDoc });
        SetupUpdateOne();

        _storageMock
            .Setup(s => s.DeleteByShaAsync("oldSha256", It.IsAny<CancellationToken>(), "kb-documents", "pdf"))
            .ThrowsAsync(new IOException("COS delete failed"));

        var file = new KbUploadFile
        {
            FileName = "new.md",
            Content = System.Text.Encoding.UTF8.GetBytes("# New"),
            Size = 5,
            MimeType = "text/markdown"
        };

        // Should not throw
        await _service.ReplaceDocumentAsync("doc1", "group1", file);
    }

    #endregion

    #region Edge Cases

    [Fact]
    public async Task UploadDocumentsAsync_StorageFailure_PropagatesException()
    {
        SetupCountDocuments(0);
        _storageMock
            .Setup(s => s.SaveAsync(It.IsAny<byte[]>(), It.IsAny<string>(), It.IsAny<CancellationToken>(),
                It.IsAny<string?>(), It.IsAny<string?>()))
            .ThrowsAsync(new IOException("COS upload failed"));

        var content = System.Text.Encoding.UTF8.GetBytes("# Test");
        var files = new List<KbUploadFile>
        {
            new() { FileName = "test.md", Content = content, Size = content.Length, MimeType = "text/markdown" }
        };

        await Assert.ThrowsAsync<IOException>(
            () => _service.UploadDocumentsAsync("group1", "user1", files));
    }

    [Fact]
    public async Task UploadDocumentsAsync_DocumentIdGenerated_IsUnique()
    {
        SetupCountDocuments(0);
        SetupInsertOne();
        var content = System.Text.Encoding.UTF8.GetBytes("# Test");
        var files = new List<KbUploadFile>
        {
            new() { FileName = "a.md", Content = content, Size = content.Length, MimeType = "text/markdown" },
            new() { FileName = "b.md", Content = content, Size = content.Length, MimeType = "text/markdown" }
        };

        var results = await _service.UploadDocumentsAsync("group1", "user1", files);

        Assert.NotEqual(results[0].DocumentId, results[1].DocumentId);
        Assert.All(results, doc =>
        {
            Assert.False(string.IsNullOrWhiteSpace(doc.DocumentId));
            Assert.Equal(32, doc.DocumentId.Length);
        });
    }

    #endregion

    #region Helper Methods

    private void SetupCountDocuments(long count)
    {
        _collectionMock
            .Setup(c => c.CountDocumentsAsync(
                It.IsAny<FilterDefinition<KbDocument>>(),
                It.IsAny<CountOptions>(),
                It.IsAny<CancellationToken>()))
            .ReturnsAsync(count);
    }

    private void SetupInsertOne()
    {
        _collectionMock
            .Setup(c => c.InsertOneAsync(
                It.IsAny<KbDocument>(),
                It.IsAny<InsertOneOptions>(),
                It.IsAny<CancellationToken>()))
            .Returns(Task.CompletedTask);
    }

    private void SetupUpdateOne()
    {
        _collectionMock
            .Setup(c => c.UpdateOneAsync(
                It.IsAny<FilterDefinition<KbDocument>>(),
                It.IsAny<UpdateDefinition<KbDocument>>(),
                It.IsAny<UpdateOptions>(),
                It.IsAny<CancellationToken>()))
            .ReturnsAsync(new Mock<UpdateResult>().Object);
    }

    private void SetupFindById(KbDocument? doc)
    {
        var cursorMock = new Mock<IAsyncCursor<KbDocument>>();
        var results = doc != null ? new List<KbDocument> { doc } : new List<KbDocument>();
        cursorMock.SetupSequence(c => c.MoveNextAsync(It.IsAny<CancellationToken>()))
            .ReturnsAsync(results.Count > 0)
            .ReturnsAsync(false);
        cursorMock.Setup(c => c.Current).Returns(results);

        _collectionMock
            .Setup(c => c.FindAsync(
                It.IsAny<FilterDefinition<KbDocument>>(),
                It.IsAny<FindOptions<KbDocument, KbDocument>>(),
                It.IsAny<CancellationToken>()))
            .ReturnsAsync(cursorMock.Object);
    }

    private void SetupFindByIdSequence(KbDocument[] docs)
    {
        var callIndex = 0;
        _collectionMock
            .Setup(c => c.FindAsync(
                It.IsAny<FilterDefinition<KbDocument>>(),
                It.IsAny<FindOptions<KbDocument, KbDocument>>(),
                It.IsAny<CancellationToken>()))
            .Returns(() =>
            {
                var doc = callIndex < docs.Length ? docs[callIndex] : null;
                callIndex++;
                var cursorMock = new Mock<IAsyncCursor<KbDocument>>();
                var results = doc != null ? new List<KbDocument> { doc } : new List<KbDocument>();
                cursorMock.SetupSequence(c => c.MoveNextAsync(It.IsAny<CancellationToken>()))
                    .ReturnsAsync(results.Count > 0)
                    .ReturnsAsync(false);
                cursorMock.Setup(c => c.Current).Returns(results);
                return Task.FromResult(cursorMock.Object);
            });
    }

    #endregion
}
