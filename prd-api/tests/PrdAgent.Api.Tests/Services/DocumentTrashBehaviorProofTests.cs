using System.Reflection;
using System.Security.Claims;
using System.Text;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Driver;
using Moq;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services;
using PrdAgent.Infrastructure.Services.AssetStorage;
using PrdAgent.Infrastructure.Services.DocumentStore;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

// 同一文件可在功能前基线和当前版本编译；只有本机随机隔离库，无线上配置或真实存储调用。
[Trait("Category", "Integration")]
public sealed class DocumentTrashBehaviorProofTests : IAsyncLifetime
{
    private readonly string _databaseName = "trash_proof_" + Guid.NewGuid().ToString("N");
    private MongoDbContext _db = null!;
    private DocumentEntry _entry = null!;
    private readonly Mock<IAssetStorage> _storage = new();
    private readonly Mock<IDocumentService> _documents = new();

    public async Task InitializeAsync()
    {
        _db = new MongoDbContext("mongodb://127.0.0.1:27019/?serverSelectionTimeoutMS=3000", _databaseName);
        var store = new DocumentStore { OwnerId = "proof-owner", Name = "回收对照隔离库" };
        _entry = new DocumentEntry { StoreId = store.Id, Title = "保留原文.txt", DocumentId = "original-body", AttachmentId = "original-attachment" };
        await _db.DocumentStores.InsertOneAsync(store);
        await _db.DocumentEntries.InsertOneAsync(_entry);
        await _db.Documents.InsertOneAsync(new ParsedPrd { Id = "original-body", RawContent = "不能丢失的原正文" });
        await _db.Attachments.InsertOneAsync(new Attachment { AttachmentId = "original-attachment", FileName = "保留原文.txt", StorageKey = "proof/original.txt" });
        await _db.DocumentEntryVersions.InsertOneAsync(new DocumentEntryVersion { EntryId = _entry.Id, StoreId = store.Id, Content = "必要历史" });
        await _db.DocumentInlineComments.InsertOneAsync(new DocumentInlineComment { EntryId = _entry.Id, StoreId = store.Id, DocumentId = "original-body", SelectedText = "原正文", Content = "保留锚点" });
        _documents.Setup(x => x.ParseAsync(It.IsAny<string>())).ReturnsAsync(new ParsedPrd { Id = "replacement-body", RawContent = "迟到的替换正文" });
        _documents.Setup(x => x.SaveAsync(It.IsAny<ParsedPrd>())).Returns(async (ParsedPrd parsed) => { await _db.Documents.InsertOneAsync(parsed); return parsed; });
    }

    public Task DisposeAsync() => _db.Database.Client.DropDatabaseAsync(_databaseName);

    [Fact]
    public async Task DeleteEntry_RetainsRecoverableBodyAttachmentAndHistory()
    {
        Assert.IsType<OkObjectResult>(await Controller().DeleteEntry(_entry.Id));
        Assert.Equal(0, await _db.DocumentEntries.CountDocumentsAsync(x => x.Id == _entry.Id));
        var retained = _db.Database.GetCollection<DocumentEntry>("document_entries");
        Assert.Equal(1, await retained.CountDocumentsAsync(x => x.Id == _entry.Id));
        Assert.Equal(1, await _db.Documents.CountDocumentsAsync(x => x.Id == "original-body"));
        Assert.Equal(1, await _db.Attachments.CountDocumentsAsync(x => x.AttachmentId == "original-attachment"));
        Assert.Equal(1, await _db.DocumentEntryVersions.CountDocumentsAsync(x => x.EntryId == _entry.Id));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task InFlightFileReplacement_CannotDestroyRecycledOrRestoredContent(bool restoreBeforeUploadFinishes)
    {
        var uploadStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var finishUpload = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        _storage.Setup(x => x.SaveAsync(It.IsAny<byte[]>(), It.IsAny<string>(), It.IsAny<CancellationToken>(), It.IsAny<string?>(), It.IsAny<string?>(), It.IsAny<string?>(), It.IsAny<string?>()))
            .Returns(async () => { uploadStarted.SetResult(); await finishUpload.Task; return new StoredAsset("replacement", "/local-assets/proof/replacement.txt", 24, "text/plain", "proof/replacement.txt"); });
        var controller = Controller();
        await using var stream = new MemoryStream(Encoding.UTF8.GetBytes("迟到的替换正文"));
        var file = new FormFile(stream, 0, stream.Length, "file", "replacement.txt") { Headers = new HeaderDictionary(), ContentType = "text/plain" };
        var replacing = controller.ReplaceEntryFile(_entry.Id, file);
        await uploadStarted.Task.WaitAsync(TimeSpan.FromSeconds(10));
        try
        {
            Assert.IsType<OkObjectResult>(await Controller().DeleteEntry(_entry.Id));
            if (restoreBeforeUploadFinishes) await RestoreThroughControllerAsync();
        }
        finally { finishUpload.TrySetResult(); }
        var result = await replacing;
        Assert.True(await _db.Documents.Find(x => x.Id == "original-body").AnyAsync(), "迟到的替换请求清理了回收或恢复仍需引用的原正文");
        Assert.IsType<ConflictObjectResult>(result);
        if (!restoreBeforeUploadFinishes) await RestoreThroughControllerAsync();
        var restored = await _db.DocumentEntries.Find(x => x.Id == _entry.Id).SingleAsync();
        Assert.Equal("original-body", restored.DocumentId);
        Assert.Equal("original-attachment", restored.AttachmentId);
        Assert.Equal(DocumentInlineCommentStatus.Active, (await _db.DocumentInlineComments.Find(x => x.EntryId == _entry.Id).SingleAsync()).Status);
        Assert.Equal(1, await _db.DocumentEntryVersions.CountDocumentsAsync(x => x.EntryId == _entry.Id));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task OrdinaryFileReplacement_RemainsWritableIncludingLegacyRows(bool legacy)
    {
        if (legacy)
            await _db.DocumentEntries.UpdateOneAsync(x => x.Id == _entry.Id, Builders<DocumentEntry>.Update.Unset("LifecycleVersion"));
        _storage.Setup(x => x.SaveAsync(It.IsAny<byte[]>(), It.IsAny<string>(), It.IsAny<CancellationToken>(), It.IsAny<string?>(), It.IsAny<string?>(), It.IsAny<string?>(), It.IsAny<string?>()))
            .ReturnsAsync(new StoredAsset("replacement", "/local-assets/proof/replacement.txt", 24, "text/plain", "proof/replacement.txt"));
        await using var stream = new MemoryStream(Encoding.UTF8.GetBytes("正常替换正文"));
        var result = await Controller().ReplaceEntryFile(_entry.Id, new FormFile(stream, 0, stream.Length, "file", "replacement.txt") { Headers = new HeaderDictionary(), ContentType = "text/plain" });
        Assert.IsType<OkObjectResult>(result);
        var updated = await _db.DocumentEntries.Find(x => x.Id == _entry.Id).SingleAsync();
        Assert.Equal("replacement-body", updated.DocumentId);
        Assert.NotEqual("original-attachment", updated.AttachmentId);
    }

    private async Task RestoreThroughControllerAsync()
    {
        var method = typeof(DocumentStoreController).GetMethod("RestoreEntry", BindingFlags.Public | BindingFlags.Instance);
        Assert.NotNull(method);
        Assert.IsType<OkObjectResult>(await (Task<IActionResult>)method.Invoke(Controller(), [_entry.Id])!);
    }

    private DocumentStoreController Controller()
    {
        var teams = new Mock<ITeamService>();
        teams.Setup(x => x.GetMyTeamIdsAsync("proof-owner", It.IsAny<CancellationToken>())).ReturnsAsync([]);
        var cleaner = new DocumentAssetCleanupService(_db, _storage.Object, NullLogger<DocumentAssetCleanupService>.Instance);
        var writer = new EntryContentWriteService(_db, _documents.Object, new MentionService(_db), new DocumentVersionService(_db), NullLogger<EntryContentWriteService>.Instance);
        var controller = new DocumentStoreController(_db, _storage.Object, Mock.Of<IFileContentExtractor>(), _documents.Object,
            null!, null!, null!, teams.Object, Mock.Of<ITeamActivityService>(), new MentionService(_db), new DocumentVersionService(_db),
            null!, null!, null!, null!, null!, null!, null!, null!, cleaner, writer, null!, NullLogger<DocumentStoreController>.Instance);
        controller.ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext { User = new ClaimsPrincipal(new ClaimsIdentity([new Claim("sub", "proof-owner")], "test")) } };
        return controller;
    }
}
