using System.Net;
using System.Reflection;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
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
using PrdAgent.Infrastructure.Services.DocumentStore;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

// 仅随机本机数据库；HTTP 全部由内存 handler 提供，不访问 GitHub 或生产。
[Trait("Category", "Integration")]
public sealed class DocumentTrashReviewProofTests : IAsyncLifetime
{
    private static readonly JsonSerializerOptions JsonOptions = new() { Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping };
    private readonly string _name = "trash_review_" + Guid.NewGuid().ToString("N");
    private MongoDbContext _db = null!;
    private DocumentStore _store = null!;
    private IMongoClient _client = null!;
    public async Task InitializeAsync()
    {
        _db = new MongoDbContext("mongodb://127.0.0.1:27019/?serverSelectionTimeoutMS=3000", _name);
        _client = _db.Database.Client;
        _store = new DocumentStore { OwnerId = "owner", Name = "审查隔离库", IsPublic = true };
        await _db.DocumentStores.InsertOneAsync(_store);
    }
    public Task DisposeAsync() => _client.DropDatabaseAsync(_name);

    [Fact]
    public async Task RecentComments_ExcludeTrashBeforeLimit_AndReappearAfterRestore()
    {
        var active = await EntryAsync();
        var hidden = await EntryAsync();
        await _db.DocumentInlineComments.InsertManyAsync([
            new() { StoreId = _store.Id, EntryId = active.Id, Content = "正常评论", CreatedAt = DateTime.UtcNow.AddMinutes(-1) },
            new() { StoreId = _store.Id, EntryId = hidden.Id, Content = "回收评论不可泄露", SelectedText = "受限正文片段", CreatedAt = DateTime.UtcNow }
        ]);
        var trash = new DocumentTrashService(_db);
        await trash.DeleteAsync(_store.Id, hidden.Id, "owner");
        var result = Assert.IsType<OkObjectResult>(await Controller("reader").ListRecentStoreComments(_store.Id, limit: 1));
        var json = JsonSerializer.Serialize(result.Value, JsonOptions);
        Assert.DoesNotContain("回收评论不可泄露", json);
        Assert.DoesNotContain("受限正文片段", json);
        Assert.Contains("正常评论", json);
        Assert.Equal(2, await _db.DocumentInlineComments.CountDocumentsAsync(x => x.StoreId == _store.Id));
        await trash.RestoreAsync(_store.Id, hidden.Id);
        var restored = Assert.IsType<OkObjectResult>(await Controller("reader").ListRecentStoreComments(_store.Id, limit: 1));
        Assert.Contains("回收评论不可泄露", JsonSerializer.Serialize(restored.Value, JsonOptions));
    }

    [Fact]
    public async Task GitHubChild_RequiresItsMetadataParentBeforeRestore()
    {
        var parent = await EntryAsync();
        await _db.DocumentEntries.UpdateOneAsync(x => x.Id == parent.Id, Builders<DocumentEntry>.Update.Set(x => x.SourceType, DocumentSourceType.GithubDirectory));
        var child = await EntryAsync();
        await _db.DocumentEntries.UpdateOneAsync(x => x.Id == child.Id,
            Builders<DocumentEntry>.Update.Set("Metadata.github_parent_id", parent.Id));
        var trash = new DocumentTrashService(_db);
        await trash.DeleteAsync(_store.Id, child.Id, "owner");
        await trash.DeleteAsync(_store.Id, parent.Id, "owner");
        await Assert.ThrowsAsync<DocumentTrashService.ConflictException>(() => trash.RestoreAsync(_store.Id, child.Id));
        await trash.RestoreAsync(_store.Id, parent.Id);
        await trash.RestoreAsync(_store.Id, child.Id);
        Assert.Equal(parent.Id, (await _db.DocumentEntries.Find(x => x.Id == child.Id).SingleAsync()).Metadata["github_parent_id"]);
    }

    [Theory]
    [InlineData(false, true)]
    [InlineData(true, true)]
    [InlineData(false, false)]
    [InlineData(true, false)]
    public async Task DirectorySync_ConditionalCommitProtectsRestore_ForLiveAndCachedContent(bool cache, bool recycle)
    {
        var parent = await EntryAsync();
        parent.SourceType = DocumentSourceType.GithubDirectory;
        parent.Metadata = new() { ["github_owner"] = "proof", ["github_repo"] = "proof", ["github_path"] = "docs", ["github_branch"] = "main" };
        await _db.DocumentEntries.ReplaceOneAsync(x => x.Id == parent.Id, parent);
        var entry = await EntryAsync();
        entry.SourceType = DocumentSourceType.Subscription;
        entry.DocumentId = "original";
        entry.Metadata = new() { ["github_parent_id"] = parent.Id, ["github_path"] = "docs/readme.md", ["github_sha"] = "old" };
        await _db.DocumentEntries.ReplaceOneAsync(x => x.Id == entry.Id, entry);
        await _db.Documents.InsertOneAsync(new ParsedPrd { Id = "original", RawContent = "原正文" });
        if (cache)
        {
            await _db.DocumentEntries.InsertOneAsync(new DocumentEntry { StoreId = _store.Id, DocumentId = "cached", Metadata = new() { ["github_sha"] = "new" } });
            await _db.Documents.InsertOneAsync(new ParsedPrd { Id = "cached", RawContent = "上游新正文" });
        }
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var resume = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var documents = new Mock<IDocumentService>();
        documents.Setup(x => x.GetByIdAsync(It.IsAny<string>())).Returns(async (string id) => await _db.Documents.Find(x => x.Id == id).FirstOrDefaultAsync());
        documents.Setup(x => x.ParseAsync(It.IsAny<string>())).ReturnsAsync((string text) => new ParsedPrd { RawContent = text });
        documents.Setup(x => x.SaveAsync(It.IsAny<ParsedPrd>())).Returns(async (ParsedPrd doc) => {
            started.SetResult(); await resume.Task; await _db.Documents.InsertOneAsync(doc); return doc;
        });
        using var http = new HttpClient(new GitHubFixture());
        var syncing = new GitHubDirectorySyncService(NullLogger<GitHubDirectorySyncService>.Instance, http)
            .SyncDirectoryAsync(_db, documents.Object, new DocumentVersionService(_db), parent, CancellationToken.None);
        if (await Task.WhenAny(started.Task, syncing) == syncing) await syncing;
        await started.Task.WaitAsync(TimeSpan.FromSeconds(10));
        var versions = await _db.DocumentEntryVersions.CountDocumentsAsync(x => x.EntryId == entry.Id);
        long lifecycle = 0;
        try
        {
            if (recycle)
            {
                var trash = new DocumentTrashService(_db);
                await trash.DeleteAsync(_store.Id, entry.Id, "owner");
                await trash.RestoreAsync(_store.Id, entry.Id);
                lifecycle = (await _db.DocumentEntries.Find(x => x.Id == entry.Id).SingleAsync()).LifecycleVersion;
                await _db.DocumentEntries.UpdateOneAsync(x => x.Id == entry.Id,
                    Builders<DocumentEntry>.Update.Set(x => x.DocumentId, "restored-edit").Set(x => x.Title, "恢复后的新编辑"));
            }
        }
        finally { resume.TrySetResult(); }
        var diff = await syncing;
        var actual = await _db.DocumentEntries.Find(x => x.Id == entry.Id).SingleAsync();
        if (recycle)
        {
            Assert.Equal("restored-edit", actual.DocumentId);
            Assert.Equal("恢复后的新编辑", actual.Title);
            Assert.Equal(lifecycle, actual.LifecycleVersion);
            Assert.Equal(versions, await _db.DocumentEntryVersions.CountDocumentsAsync(x => x.EntryId == entry.Id));
            Assert.Equal(0, diff.UpdatedCount);
        }
        else
        {
            Assert.NotEqual("original", actual.DocumentId);
            Assert.Equal("上游新正文", (await _db.Documents.Find(x => x.Id == actual.DocumentId).SingleAsync()).RawContent);
            Assert.Equal(1, diff.UpdatedCount);
        }
    }

    [Fact]
    public async Task InterruptedLegacyStoreDeletion_PreservesBatchCountAcrossRetryAndRestore()
    {
        var first = await EntryAsync();
        await EntryAsync();
        var state = new DocumentTrashState { DeletedBy = "owner", Pending = true };
        await _db.DocumentStoresIncludingTrash.UpdateOneAsync(x => x.Id == _store.Id,
            Builders<DocumentStore>.Update.Set(x => x.Trash, state).Set(x => x.DocumentCount, 2));
        await _db.DocumentEntriesIncludingTrash.UpdateOneAsync(x => x.Id == first.Id,
            Builders<DocumentEntry>.Update.Set(x => x.Trash, state).Inc(x => x.LifecycleVersion, 1));
        var trash = new DocumentTrashService(_db);
        await trash.DeleteAsync(_store.Id, null, "owner");
        Assert.Equal(0, (await _db.DocumentStoresIncludingTrash.Find(x => x.Id == _store.Id).SingleAsync()).DocumentCount);
        await trash.RestoreAsync(_store.Id, null);
        await trash.RestoreAsync(_store.Id, null);
        var restored = await _db.DocumentStores.Find(x => x.Id == _store.Id).SingleAsync();
        Assert.Equal(2, restored.DocumentCount);
        Assert.Empty(restored.TrashCountReceipts);
    }

    [Fact]
    public async Task RecycleAccounting_DoesNotOverwriteConcurrentAddition_AndRetryIsIdempotent()
    {
        await EntryAsync();
        await _db.DocumentStores.UpdateOneAsync(x => x.Id == _store.Id, Builders<DocumentStore>.Update.Set(x => x.DocumentCount, 2));
        var realDatabase = _db.Database;
        var stores = _db.DocumentStoresIncludingTrash;
        var hooked = new Mock<IMongoCollection<DocumentStore>>();
        var injected = false;
        hooked.Setup(x => x.UpdateOneAsync(It.IsAny<FilterDefinition<DocumentStore>>(), It.IsAny<UpdateDefinition<DocumentStore>>(), It.IsAny<UpdateOptions>(), It.IsAny<CancellationToken>()))
            .Returns(async (FilterDefinition<DocumentStore> f, UpdateDefinition<DocumentStore> u, UpdateOptions o, CancellationToken c) => {
                if (!injected)
                {
                    injected = true;
                    await realDatabase.GetCollection<DocumentEntry>("document_entries").InsertOneAsync(new DocumentEntry { StoreId = _store.Id });
                    await stores.UpdateOneAsync(x => x.Id == _store.Id, Builders<DocumentStore>.Update.Inc(x => x.DocumentCount, 1));
                }
                return await stores.UpdateOneAsync(f, u, o, c);
            });
        var database = new Mock<IMongoDatabase>();
        database.Setup(x => x.GetCollection<DocumentStore>("document_stores", It.IsAny<MongoCollectionSettings>())).Returns(hooked.Object);
        database.Setup(x => x.GetCollection<DocumentEntry>("document_entries", It.IsAny<MongoCollectionSettings>())).Returns(realDatabase.GetCollection<DocumentEntry>("document_entries"));
        typeof(MongoDbContext).GetField("_database", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(_db, database.Object);
        var trash = new DocumentTrashService(_db);
        var oldMethod = typeof(DocumentTrashService).GetMethod("RefreshCountAsync", BindingFlags.Instance | BindingFlags.NonPublic);
        if (oldMethod != null) await (Task)oldMethod.Invoke(trash, [_store.Id])!;
        else
        {
            var method = typeof(DocumentTrashService).GetMethod("ApplyCountChangeAsync", BindingFlags.Instance | BindingFlags.NonPublic)!;
            await (Task)method.Invoke(trash, [_store.Id, "same-operation", -1])!;
            await (Task)method.Invoke(trash, [_store.Id, "same-operation", -1])!;
        }
        Assert.Equal(2, (await stores.Find(x => x.Id == _store.Id).SingleAsync()).DocumentCount);
    }

    private async Task<DocumentEntry> EntryAsync()
    {
        var entry = new DocumentEntry { StoreId = _store.Id, Title = "原文" };
        await _db.DocumentEntries.InsertOneAsync(entry);
        return entry;
    }
    private DocumentStoreController Controller(string actor)
    {
        var teams = new Mock<ITeamService>();
        teams.Setup(x => x.GetMyTeamIdsAsync(actor, It.IsAny<CancellationToken>())).ReturnsAsync([]);
        var c = new DocumentStoreController(_db, null!, null!, null!, null!, null!, null!, teams.Object, Mock.Of<ITeamActivityService>(), null!, null!, null!, null!, null!, null!, null!, null!, null!, null!, null!, null!, null!, NullLogger<DocumentStoreController>.Instance);
        c.ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext { User = new ClaimsPrincipal(new ClaimsIdentity([new Claim("sub", actor)], "test")) } };
        return c;
    }
    private sealed class GitHubFixture : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var uri = request.RequestUri!;
            var text = uri.Host == "raw.githubusercontent.com" ? "上游新正文"
                : uri.AbsolutePath.EndsWith("/commits/main") ? "{\"sha\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}"
                : uri.AbsolutePath.Contains("/contents/") ? "[{\"type\":\"file\",\"name\":\"readme.md\",\"path\":\"docs/readme.md\",\"sha\":\"new\",\"size\":24,\"download_url\":\"https://raw.githubusercontent.com/proof/proof/main/docs/readme.md\"}]" : "[]";
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(text, Encoding.UTF8) });
        }
    }
}
