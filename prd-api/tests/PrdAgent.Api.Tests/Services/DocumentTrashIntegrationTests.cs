using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Driver;
using Moq;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Api.Services;
using PrdAgent.Infrastructure.Services.AssetStorage;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services.DocumentStore;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

// 仅连接隔离的本机 Mongo；点名运行，不读取任何线上连接配置。
[Trait("Category", "Integration")]
public sealed class DocumentTrashIntegrationTests : IAsyncLifetime
{
    private readonly string _name = "trash_it_" + Guid.NewGuid().ToString("N");
    private MongoDbContext _db = null!;
    private DocumentTrashService _trash = null!;
    private DocumentStore _store = null!;

    public async Task InitializeAsync()
    {
        _db = new MongoDbContext("mongodb://127.0.0.1:27019/?serverSelectionTimeoutMS=3000", _name);
        _trash = new DocumentTrashService(_db);
        _store = new DocumentStore { OwnerId = "owner", Name = "隔离演练", SharedTeamIds = ["team"] };
        await _db.DocumentStores.InsertOneAsync(_store);
    }
    public Task DisposeAsync() => _db.Database.Client.DropDatabaseAsync(_name);

    [Fact]
    public async Task FolderRoundTrip_PreservesBodyAttachmentHistoryAndTree_Idempotently()
    {
        var folder = await EntryAsync(folder: true);
        var child = await EntryAsync(parent: folder.Id);
        await _db.Documents.InsertOneAsync(new ParsedPrd { Id = "body", RawContent = "完整正文" });
        await _db.Attachments.InsertOneAsync(new Attachment { AttachmentId = "attachment", FileName = "附件.pdf" });
        await _db.DocumentEntryVersions.InsertOneAsync(new DocumentEntryVersion { EntryId = child.Id, StoreId = _store.Id, Content = "历史正文" });
        await _trash.DeleteAsync(_store.Id, folder.Id, "member");
        var first = (await _db.DocumentEntriesIncludingTrash.Find(x => x.Id == folder.Id).SingleAsync()).Trash!;
        await _trash.DeleteAsync(_store.Id, folder.Id, "member");
        (await _db.DocumentEntries.CountDocumentsAsync(x => x.StoreId == _store.Id)).ShouldBe(0);
        (await _db.DocumentEntriesIncludingTrash.Find(x => x.Id == folder.Id).SingleAsync()).Trash!.DeletedAt.ShouldBe(first.DeletedAt);
        await _trash.RestoreAsync(_store.Id, folder.Id);
        await _trash.RestoreAsync(_store.Id, folder.Id);
        var restored = await _db.DocumentEntries.Find(x => x.Id == child.Id).SingleAsync();
        restored.ParentId.ShouldBe(folder.Id);
        restored.DocumentId.ShouldBe("body");
        restored.AttachmentId.ShouldBe("attachment");
        (await _db.Documents.Find(x => x.Id == "body").SingleAsync()).RawContent.ShouldBe("完整正文");
        (await _db.Attachments.Find(x => x.AttachmentId == "attachment").SingleAsync()).FileName.ShouldBe("附件.pdf");
        (await _db.DocumentEntryVersions.Find(x => x.EntryId == child.Id).SingleAsync()).Content.ShouldBe("历史正文");
        (await _db.DocumentStores.Find(x => x.Id == _store.Id).SingleAsync()).DocumentCount.ShouldBe(1);
    }

    [Fact]
    public async Task StoreRoundTrip_DoesNotRestorePreviouslyDeletedChild()
    {
        var hidden = await EntryAsync();
        var active = await EntryAsync();
        await _trash.DeleteAsync(_store.Id, hidden.Id, "member");
        await _trash.DeleteAsync(_store.Id, null, "owner");
        (await _db.DocumentStores.CountDocumentsAsync(x => x.Id == _store.Id)).ShouldBe(0);
        await _trash.RestoreAsync(_store.Id, null);
        (await _db.DocumentEntries.CountDocumentsAsync(x => x.Id == active.Id)).ShouldBe(1);
        (await _db.DocumentEntries.CountDocumentsAsync(x => x.Id == hidden.Id)).ShouldBe(0);
    }

    [Fact]
    public async Task ExpiryAndMissingParent_BlockRestoreWithoutLosingData()
    {
        var folder = await EntryAsync(folder: true);
        var child = await EntryAsync(parent: folder.Id);
        await _trash.DeleteAsync(_store.Id, child.Id, "member");
        await _trash.DeleteAsync(_store.Id, folder.Id, "member");
        await Should.ThrowAsync<DocumentTrashService.ConflictException>(() => _trash.RestoreAsync(_store.Id, child.Id));
        await _trash.RestoreAsync(_store.Id, folder.Id);
        await _db.DocumentEntriesIncludingTrash.UpdateOneAsync(x => x.Id == child.Id,
            Builders<DocumentEntry>.Update.Set("Trash.DeletedAt", DateTime.UtcNow.AddDays(-30)));
        await Should.ThrowAsync<DocumentTrashService.ConflictException>(() => _trash.RestoreAsync(_store.Id, child.Id));
        (await _db.DocumentEntriesIncludingTrash.CountDocumentsAsync(x => x.Id == child.Id)).ShouldBe(1);
    }

    [Fact]
    public async Task StaleEditAfterDeletion_IsRejectedBySharedCollectionGuard()
    {
        var entry = await EntryAsync();
        await _trash.DeleteAsync(_store.Id, entry.Id, "member");
        var edit = await _db.DocumentEntries.UpdateOneAsync(x => x.Id == entry.Id,
            Builders<DocumentEntry>.Update.Set(x => x.Title, "陈旧编辑"));
        edit.MatchedCount.ShouldBe(0);
        await _trash.RestoreAsync(_store.Id, entry.Id);
        (await _db.DocumentEntries.Find(x => x.Id == entry.Id).SingleAsync()).Title.ShouldBe("原文");
    }

    [Fact]
    public async Task ConcurrentEditAndDelete_PreservesEveryAcceptedEdit()
    {
        var entry = await EntryAsync();
        var edit = _db.DocumentEntries.UpdateOneAsync(x => x.Id == entry.Id,
            Builders<DocumentEntry>.Update.Set(x => x.Title, "并发修订"));
        await Task.WhenAll(edit, _trash.DeleteAsync(_store.Id, entry.Id, "member"));
        await _trash.RestoreAsync(_store.Id, entry.Id);
        (await _db.DocumentEntries.Find(x => x.Id == entry.Id).SingleAsync()).Title
            .ShouldBe((await edit).MatchedCount == 1 ? "并发修订" : "原文");
    }

    [Fact]
    public async Task ReferenceGuard_SeesDeletedEntriesAndActiveReferences()
    {
        var first = await EntryAsync();
        await EntryAsync();
        await _trash.DeleteAsync(_store.Id, first.Id, "member");
        (await _db.DocumentEntriesIncludingTrash.CountDocumentsAsync(x => x.AttachmentId == "attachment")).ShouldBe(2);
        (await _db.DocumentEntriesIncludingTrash.CountDocumentsAsync(x => x.DocumentId == "body")).ShouldBe(2);
    }

    [Fact]
    public async Task CurrentPermissions_HideRestrictedTrashAndRejectForeignRestore()
    {
        var entry = await EntryAsync();
        await _trash.DeleteAsync(_store.Id, entry.Id, "member");
        var outsider = Controller("outsider");
        (await outsider.RestoreEntry(entry.Id)).ShouldBeOfType<NotFoundObjectResult>();
        var list = (await outsider.ListTrash()).ShouldBeOfType<OkObjectResult>();
        JsonSerializer.Serialize(list.Value).ShouldNotContain(entry.Id);
        (await Controller("member").RestoreEntry(entry.Id)).ShouldBeOfType<OkObjectResult>();
        await _trash.DeleteAsync(_store.Id, null, "owner");
        (await Controller("member").RestoreStore(_store.Id)).ShouldBeOfType<NotFoundObjectResult>();
        (await Controller("owner").RestoreStore(_store.Id)).ShouldBeOfType<OkObjectResult>();
    }

    [Fact]
    public async Task PublicReader_IsNotGrantedTrashAccess()
    {
        await _db.DocumentStores.UpdateOneAsync(x => x.Id == _store.Id, Builders<DocumentStore>.Update.Set(x => x.IsPublic, true));
        var entry = await EntryAsync();
        await _trash.DeleteAsync(_store.Id, entry.Id, "member");
        (await Controller("outsider").RestoreEntry(entry.Id)).ShouldBeOfType<NotFoundObjectResult>();
        (await Controller("outsider").GetPublicEntryContent(entry.Id)).ShouldBeOfType<NotFoundObjectResult>();
    }

    [Fact]
    public async Task InFlightBodyEditAfterDelete_CannotMutateRestoredBodyOrHistory()
    {
        var entry = await EntryAsync();
        await _db.Documents.InsertOneAsync(new ParsedPrd { Id = "body", RawContent = "删除时正文" });
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var resume = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var documents = new Mock<IDocumentService>();
        documents.Setup(x => x.ParseAsync(It.IsAny<string>())).ReturnsAsync(new ParsedPrd { Id = "new-body", RawContent = "陈旧正文" });
        documents.Setup(x => x.GetByIdAsync("body")).Returns(async () => (ParsedPrd?)await _db.Documents.Find(x => x.Id == "body").FirstOrDefaultAsync());
        documents.Setup(x => x.SaveAsync(It.IsAny<ParsedPrd>())).Returns(async (ParsedPrd parsed) => {
            started.SetResult(); await resume.Task;
            await _db.Documents.InsertOneAsync(parsed); return parsed;
        });
        var writer = new EntryContentWriteService(_db, documents.Object, new MentionService(_db), new DocumentVersionService(_db), NullLogger<EntryContentWriteService>.Instance);
        var writing = writer.WriteAsync(entry, _store, "陈旧正文", "member", "成员", DocumentVersionSource.Edit);
        await started.Task;
        await _trash.DeleteAsync(_store.Id, entry.Id, "member");
        await _trash.RestoreAsync(_store.Id, entry.Id);
        resume.SetResult();
        (await writing).Conflicted.ShouldBeTrue();
        (await _db.Documents.Find(x => x.Id == "body").SingleAsync()).RawContent.ShouldBe("删除时正文");
        (await _db.DocumentEntries.Find(x => x.Id == entry.Id).SingleAsync()).DocumentId.ShouldBe("body");
        (await _db.DocumentEntryVersions.CountDocumentsAsync(x => x.EntryId == entry.Id)).ShouldBe(0);
    }

    [Fact]
    public async Task LegacyEntryWithoutLifecycleField_RemainsEditableWithoutMigration()
    {
        var entry = await EntryAsync();
        await _db.DocumentEntriesIncludingTrash.UpdateOneAsync(x => x.Id == entry.Id, Builders<DocumentEntry>.Update.Unset(x => x.LifecycleVersion));
        var documents = new Mock<IDocumentService>();
        documents.Setup(x => x.ParseAsync(It.IsAny<string>())).ReturnsAsync(new ParsedPrd { Id = "new-body", RawContent = "新正文" });
        documents.Setup(x => x.SaveAsync(It.IsAny<ParsedPrd>())).ReturnsAsync((ParsedPrd parsed) => parsed);
        var writer = new EntryContentWriteService(_db, documents.Object, new MentionService(_db), new DocumentVersionService(_db), NullLogger<EntryContentWriteService>.Instance);
        (await writer.WriteAsync(entry, _store, "新正文", "owner", "拥有者", DocumentVersionSource.Edit)).Conflicted.ShouldBeFalse();
        (await _db.DocumentEntries.Find(x => x.Id == entry.Id).SingleAsync()).DocumentId.ShouldBe("new-body");
    }

    [Fact]
    public async Task PendingUploadCleanup_DoesNotDeleteAttachmentReferencedByTrash()
    {
        var entry = await EntryAsync();
        const string key = "_it/stable-smoke-document/trash-retained.pdf";
        await _db.Attachments.InsertOneAsync(new Attachment { AttachmentId = "attachment", StorageKey = key });
        var storage = new Mock<IAssetStorage>();
        using var cleaner = new DocumentAssetCleanupService(_db, storage.Object, NullLogger<DocumentAssetCleanupService>.Instance);
        await cleaner.TrackPendingUploadAsync(key, CancellationToken.None);
        await _trash.DeleteAsync(_store.Id, entry.Id, "member");
        await cleaner.CleanupPendingAsync(DateTime.UtcNow.AddHours(1), CancellationToken.None);
        (await _db.Attachments.CountDocumentsAsync(x => x.AttachmentId == "attachment")).ShouldBe(1);
        storage.Verify(x => x.DeleteByKeyAsync(It.IsAny<string>(), It.IsAny<CancellationToken>()), Times.Never);
        await _trash.RestoreAsync(_store.Id, entry.Id);
        (await _db.DocumentEntries.Find(x => x.Id == entry.Id).SingleAsync()).AttachmentId.ShouldBe("attachment");
    }

    [Fact]
    public async Task RevokedTeamMember_CannotListOrRestorePreviouslyWritableTrash()
    {
        var entry = await EntryAsync();
        (await Controller("member").DeleteEntry(entry.Id)).ShouldBeOfType<OkObjectResult>();
        var revoked = Controller("member", memberStillAuthorized: false);
        (await revoked.RestoreEntry(entry.Id)).ShouldBeOfType<NotFoundObjectResult>();
        var list = (await revoked.ListTrash()).ShouldBeOfType<OkObjectResult>();
        JsonSerializer.Serialize(list.Value).ShouldNotContain(entry.Id);
        (await _db.DocumentEntriesIncludingTrash.Find(x => x.Id == entry.Id).SingleAsync()).Trash.ShouldNotBeNull();
    }

    [Fact]
    public async Task HeldRecycleLease_RejectsWithoutDeleting_AndRetryRestoresNormally()
    {
        var entry = await EntryAsync();
        await _db.DocumentStores.UpdateOneAsync(x => x.Id == _store.Id,
            Builders<DocumentStore>.Update.Set(x => x.TrashLeaseToken, "controlled-holder").Set(x => x.TrashLeaseUntil, DateTime.UtcNow.AddMinutes(1)));
        (await Controller("owner").DeleteEntry(entry.Id)).ShouldBeOfType<ConflictObjectResult>();
        (await _db.DocumentEntries.CountDocumentsAsync(x => x.Id == entry.Id)).ShouldBe(1);
        await _db.DocumentStores.UpdateOneAsync(x => x.Id == _store.Id,
            Builders<DocumentStore>.Update.Set(x => x.TrashLeaseToken, null).Set(x => x.TrashLeaseUntil, null));
        (await Controller("owner").DeleteEntry(entry.Id)).ShouldBeOfType<OkObjectResult>();
        (await Controller("owner").RestoreEntry(entry.Id)).ShouldBeOfType<OkObjectResult>();
        (await _db.DocumentEntries.CountDocumentsAsync(x => x.Id == entry.Id)).ShouldBe(1);
    }

    [Fact]
    public async Task InterruptedFolderDeletion_ResumesSameBatchBeforeRestoring()
    {
        var folder = await EntryAsync(folder: true);
        var child = await EntryAsync(parent: folder.Id);
        var state = new DocumentTrashState { RootEntryId = folder.Id, DeletedBy = "owner", Pending = true };
        await _db.DocumentEntriesIncludingTrash.UpdateOneAsync(x => x.Id == folder.Id,
            Builders<DocumentEntry>.Update.Set(x => x.Trash, state).Inc(x => x.LifecycleVersion, 1));
        var before = (await _db.DocumentEntriesIncludingTrash.Find(x => x.Id == folder.Id).SingleAsync()).Trash!;
        (await Controller("owner").RestoreEntry(folder.Id)).ShouldBeOfType<ConflictObjectResult>();
        (await Controller("owner").DeleteEntry(folder.Id)).ShouldBeOfType<OkObjectResult>();
        var completed = (await _db.DocumentEntriesIncludingTrash.Find(x => x.Id == folder.Id).SingleAsync()).Trash!;
        completed.BatchId.ShouldBe(before.BatchId);
        completed.DeletedAt.ShouldBe(before.DeletedAt);
        completed.Pending.ShouldBeFalse();
        (await _db.DocumentEntries.CountDocumentsAsync(x => x.Id == child.Id)).ShouldBe(0);
        (await Controller("owner").RestoreEntry(folder.Id)).ShouldBeOfType<OkObjectResult>();
        (await _db.DocumentEntries.Find(x => x.Id == child.Id).SingleAsync()).ParentId.ShouldBe(folder.Id);
    }

    [Fact]
    public async Task RealLocalAttachmentBytes_RemainReadableAfterRecycleAndRestore()
    {
        var directory = Path.Combine(Path.GetTempPath(), "trash-proof-assets-" + Guid.NewGuid().ToString("N"));
        try
        {
            var storage = new LocalAssetStorage(directory);
            var bytes = System.Text.Encoding.UTF8.GetBytes("附件字节也必须原样恢复");
            var asset = await storage.SaveAsync(bytes, "text/plain", CancellationToken.None, fileName: "附件.txt");
            var entry = await EntryAsync();
            await _db.Attachments.InsertOneAsync(new Attachment { AttachmentId = "attachment", FileName = "附件.txt", Url = asset.Url, StorageKey = asset.Key });
            await _trash.DeleteAsync(_store.Id, entry.Id, "member");
            await _trash.RestoreAsync(_store.Id, entry.Id);
            var attachment = await _db.Attachments.Find(x => x.AttachmentId == "attachment").SingleAsync();
            attachment.StorageKey.ShouldBe(asset.Key);
            (await storage.TryDownloadBytesAsync(attachment.StorageKey!, CancellationToken.None)).ShouldBe(bytes);
            (await _db.DocumentEntries.Find(x => x.Id == entry.Id).SingleAsync()).AttachmentId.ShouldBe(attachment.AttachmentId);
        }
        finally { if (Directory.Exists(directory)) Directory.Delete(directory, recursive: true); }
    }

    private async Task<DocumentEntry> EntryAsync(bool folder = false, string? parent = null)
    {
        var entry = new DocumentEntry { StoreId = _store.Id, Title = "原文", ParentId = parent, IsFolder = folder,
            DocumentId = folder ? null : "body", AttachmentId = folder ? null : "attachment" };
        await _db.DocumentEntries.InsertOneAsync(entry);
        return entry;
    }

    private DocumentStoreController Controller(string actor, bool memberStillAuthorized = true)
    {
        var teams = new Mock<ITeamService>();
        teams.Setup(x => x.GetMyTeamIdsAsync(actor, It.IsAny<CancellationToken>())).ReturnsAsync(actor == "member" && memberStillAuthorized ? ["team"] : []);
        var controller = new DocumentStoreController(_db, null!, null!, null!, null!, null!, null!, teams.Object, Mock.Of<ITeamActivityService>(), null!, null!, null!, null!, null!, null!, null!, null!, null!, null!, null!, null!, null!, NullLogger<DocumentStoreController>.Instance);
        controller.ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext { User = new ClaimsPrincipal(new ClaimsIdentity([new Claim("sub", actor)], "test")) } };
        return controller;
    }
}
