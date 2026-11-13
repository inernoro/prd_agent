using System.Reflection;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Driver;
using Moq;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Api.Middleware;
using PrdAgent.Api.Models.Requests;
using PrdAgent.Api.Services;
using PrdAgent.Api.Services.BackgroundTasks;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Core.Services;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services;
using PrdAgent.Infrastructure.Services.DocumentStore;
using PrdAgent.Infrastructure.Services.AssetStorage;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed class KnowledgeIndexRefreshTests
{
    [Fact]
    public void DelayedRunningTaskRemainsPendingAndNeverPretendsFailure()
    {
        var run = new DocumentStoreAgentRun { Id = "run", Status = DocumentStoreRunStatus.Running,
            CreatedAt = DateTime.UtcNow.AddMinutes(-3) };
        var status = KnowledgeIndexRefreshQueue.Describe(run, true, false, DateTime.UtcNow);
        Assert.Equal("pending", status.Status);
        Assert.True(status.Delayed);
        Assert.True(status.PollingRecommended);
        Assert.Contains("不会自动重复调用", status.DisplayMessage);
    }

    [Fact]
    public void ReadyDescribesIndexFreshnessWithoutPromisingGatewayAvailability()
    {
        var status = KnowledgeIndexRefreshQueue.Describe(new() { Status = DocumentStoreRunStatus.Done }, true, true, DateTime.UtcNow);
        Assert.Equal("ready", status.Status);
        Assert.Equal("当前正文的检索索引已更新", status.DisplayMessage);
        Assert.False(status.PollingRecommended);
    }

    [Fact]
    public void SameContentDoesNotBecomePermanentlyStaleWhenTimestampChanges()
    {
        var run = new DocumentStoreAgentRun { SourceEntryId = "entry", StoreId = "store", SourceDocumentId = "old-doc",
            SourceUpdatedAt = DateTime.UtcNow.AddMinutes(-1), SourceContentHash = DocumentChunker.ComputeHash("正文", "") };
        var entry = new DocumentEntry { Id = "entry", StoreId = "store", DocumentId = "new-doc", UpdatedAt = DateTime.UtcNow };
        Assert.True(KnowledgeIndexRefreshQueue.MatchesSource(run, entry, "正文"));
        Assert.False(KnowledgeIndexRefreshQueue.MatchesSource(run, entry, "不同正文"));
    }

    [Fact]
    public void SaveAdmissionIsDeferredAndLimitedToOneEmbeddingCallWhileStatusIsReadOnly()
    {
        var controller = typeof(DocumentStoreController).FullName!;
        var policy = TaskAdmissionPolicies.Find(controller, nameof(DocumentStoreController.UpdateEntryContent))!;
        Assert.Equal(TaskAdmissionTiming.AuthenticatedPaidBranch, policy.Timing);
        Assert.Equal(new[] { AppCallerRegistry.Admin.KnowledgeBase.Index }, policy.AppCallers);
        Assert.Equal(1, policy.InteractiveMaxCalls);
        Assert.Equal(1, policy.AgentMaxCalls);
        Assert.Null(TaskAdmissionPolicies.Find(controller, nameof(DocumentStoreController.GetKnowledgeIndexStatus)));
    }

    [Fact]
    public async Task PersistedOldPermitWithoutLiveExecutionLeaseCannotStartRefresh()
    {
        using var execution = TaskExecutionContext.Enter(new("old-permit", "run"));
        var processor = new KnowledgeIndexRefreshProcessor(null!, null!, new LLMRequestContextAccessor(), new ConfigurationBuilder().Build());
        var error = await Assert.ThrowsAsync<KnowledgeIndexRefreshException>(() => processor.ProcessAsync(new()
        { Id = "run", TaskPermitId = "old-permit" }));
        Assert.Equal("TASK_EXECUTION_LEASE_REQUIRED", error.Code);
    }

    [DesignScopeMongoFact]
    [Trait("Category", "Integration")]
    public async Task RealSaveAdmissionWorkerReplayFailureAndConcurrentUpdateRemainBounded()
    {
        await using var fixture = new RefreshFixture(Environment.GetEnvironmentVariable("DESIGN_RUN_MONGO_TEST_CONNECTION")!);
        var db = fixture.Db;
        var store = new DocumentStore { Id = "store", OwnerId = "owner", Name = "fixture" };
        var entry = new DocumentEntry { Id = "entry", StoreId = store.Id, DocumentId = "body", Title = "正文" };
        await db.DocumentStores.InsertOneAsync(store);
        await db.DocumentEntries.InsertOneAsync(entry);
        await db.Documents.InsertOneAsync(new ParsedPrd { Id = "body", RawContent = "未选择索引的正文" });

        await fixture.SaveAsync(entry.Id, "首次保存但未选择索引", "unindexed-save");
        Assert.Equal(0, await fixture.Permits.CountDocumentsAsync(FilterDefinition<GatewayTaskPermitRecord>.Empty));
        Assert.Equal(0, await db.DocumentStoreAgentRuns.CountDocumentsAsync(FilterDefinition<DocumentStoreAgentRun>.Empty));
        Assert.Equal(0, fixture.Embedding.Calls);
        var guard = await fixture.Retrieval.IndexEntryAsync(entry.Id, "owner", CancellationToken.None,
            expectedSourceHash: DocumentChunker.ComputeHash("不是当前正文", ""));
        Assert.False(guard.Success);
        Assert.Equal("KB_INDEX_SOURCE_CHANGED", guard.ErrorCode);
        Assert.Equal(0, fixture.Embedding.Calls);
        Assert.Equal(0, fixture.Embedding.Resolves);

        entry = (await db.DocumentEntries.Find(e => e.Id == entry.Id).SingleAsync());
        await db.DocumentEmbeddings.InsertOneAsync(new DocumentEmbedding
        {
            StoreId = store.Id, EntryId = entry.Id, Text = "首次保存但未选择索引", Model = "fixture-embedding", Dimension = 2,
            Vector = EmbeddingVector.Encode(new float[] { 1, 0 }), DeploymentSlug = DeploymentScope.Current,
            ContentHash = DocumentChunker.ComputeHash("首次保存但未选择索引", "fixture-embedding")
        });
        Assert.False(await fixture.Queue.ShouldRefreshAsync(entry, store, "other-user"));
        Assert.Equal(0, await fixture.Permits.CountDocumentsAsync(FilterDefinition<GatewayTaskPermitRecord>.Empty));

        // A single model with mixed dimensions cannot claim a complete compatible index.
        var mixedContent = new string('甲', 600) + "\n\n" + new string('乙', 600);
        var mixed = new DocumentEntry { Id = "mixed", StoreId = store.Id, DocumentId = "mixed-body" };
        await db.DocumentEntries.InsertOneAsync(mixed);
        await db.Documents.InsertOneAsync(new ParsedPrd { Id = mixed.DocumentId, RawContent = mixedContent });
        var mixedChunks = DocumentChunker.Split(mixedContent);
        for (var i = 0; i < mixedChunks.Count; i++)
            await db.DocumentEmbeddings.InsertOneAsync(new DocumentEmbedding
            {
                StoreId = store.Id, EntryId = mixed.Id, Model = "fixture-embedding", Dimension = i == 0 ? 2 : 3,
                Vector = EmbeddingVector.Encode(i == 0 ? new float[] { 1, 0 } : new float[] { 1, 0, 0 }),
                ContentHash = DocumentChunker.ComputeHash(mixedChunks[i], "fixture-embedding"), Text = mixedChunks[i],
                DeploymentSlug = DeploymentScope.Current
            });
        Assert.Equal("stale", (await fixture.Queue.GetStatusAsync(mixed, "owner")).Status);
        await db.DocumentEmbeddings.UpdateManyAsync(row => row.EntryId == mixed.Id,
            Builders<DocumentEmbedding>.Update.Set(row => row.Dimension, 2).Set(row => row.Vector, EmbeddingVector.Encode(new float[] { 1, 0 })));
        Assert.Equal("ready", (await fixture.Queue.GetStatusAsync(mixed, "owner")).Status);

        var first = await fixture.SaveAsync(entry.Id, "更新后正文", "indexed-save-1");
        var run = await db.DocumentStoreAgentRuns.Find(r => r.Kind == DocumentStoreAgentRunKind.KnowledgeIndex).SingleAsync();
        var permit = await fixture.Permits.Find(p => p.Id == run.TaskPermitId).SingleAsync();
        Assert.EndsWith("DocumentStoreController.UpdateEntryContent", permit.SourceTask);
        Assert.Equal(new[] { AppCallerRegistry.Admin.KnowledgeBase.Index }, permit.AllowedAppCallerCodes);
        Assert.Equal("pending", first.GetProperty("data").GetProperty("knowledgeIndex").GetProperty("status").GetString());
        var saved = await db.DocumentEntries.Find(e => e.Id == entry.Id).SingleAsync();
        var replay = await fixture.SaveAsync(entry.Id, "更新后正文", "indexed-save-1");
        Assert.True(fixture.LastReplayed);
        Assert.Equal(saved.UpdatedAt, (await db.DocumentEntries.Find(e => e.Id == entry.Id).SingleAsync()).UpdatedAt);
        Assert.Equal(1, await db.DocumentStoreAgentRuns.CountDocumentsAsync(FilterDefinition<DocumentStoreAgentRun>.Empty));
        Assert.Equal(1, await fixture.Permits.CountDocumentsAsync(FilterDefinition<GatewayTaskPermitRecord>.Empty));
        Assert.Equal(first.GetRawText(), replay.GetRawText());

        await fixture.ProcessNextAsync();
        Assert.Equal(1, fixture.Embedding.Calls);
        Assert.Equal("ready", (await fixture.Queue.GetStatusAsync(saved, "owner")).Status);
        var reused = await fixture.Queue.EnqueueAsync(saved, saved.DocumentId!, saved.UpdatedAt.AddSeconds(1),
            "更新后正文", "owner", run.TaskPermitId!);
        Assert.Equal("ready", reused.Status);
        Assert.Equal(1, await db.DocumentStoreAgentRuns.CountDocumentsAsync(FilterDefinition<DocumentStoreAgentRun>.Empty));
        await Assert.ThrowsAsync<KnowledgeIndexRefreshException>(() => fixture.Queue.EnqueueAsync(saved,
            saved.DocumentId!, saved.UpdatedAt, "不能借同许可替换正文", "owner", run.TaskPermitId!));
        var active = Assert.IsType<OkObjectResult>(await fixture.Controller(fixture.NewHttp(entry.Id, "unused", "unused")).GetActiveReprocessRun(entry.Id));
        Assert.Null(((ApiResponse<DocumentStoreAgentRun?>)active.Value!).Data);

        fixture.Embedding.Fail = true;
        await fixture.SaveAsync(entry.Id, "供应商失败时保存的新正文", "indexed-save-2");
        Assert.Equal(2, await fixture.Permits.CountDocumentsAsync(FilterDefinition<GatewayTaskPermitRecord>.Empty));
        await fixture.ProcessNextAsync();
        var current = await db.DocumentEntries.Find(e => e.Id == entry.Id).SingleAsync();
        var failed = await fixture.Queue.GetStatusAsync(current, "owner");
        Assert.Equal("failed", failed.Status);
        Assert.Equal("UPSTREAM_ERROR", failed.FailureCode);
        Assert.False(failed.PollingRecommended);
        Assert.Equal(2, fixture.Embedding.Calls);

        fixture.Embedding.Fail = false;
        await fixture.SaveAsync(entry.Id, "并发保存前的正文", "indexed-save-3");
        fixture.Embedding.DuringCall = async () =>
        {
            await db.Documents.UpdateOneAsync(d => d.Id == current.DocumentId, Builders<ParsedPrd>.Update.Set(d => d.RawContent, "并发更新后的正文"));
        };
        await fixture.ProcessNextAsync();
        current = await db.DocumentEntries.Find(e => e.Id == entry.Id).SingleAsync();
        Assert.Equal("stale", (await fixture.Queue.GetStatusAsync(current, "owner")).Status);
        Assert.Equal(3, fixture.Embedding.Calls);
        Assert.Equal(3, await fixture.Permits.CountDocumentsAsync(FilterDefinition<GatewayTaskPermitRecord>.Empty));
    }

    private sealed class RefreshFixture : IAsyncDisposable
    {
        private readonly MongoClient _client;
        private readonly string _name = "codex_kb_refresh_" + Guid.NewGuid().ToString("N");
        private readonly IConfiguration _config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        { ["LlmGateway:InternalTenantId"] = "fixture-tenant" }).Build();
        private readonly ServiceProvider _services;
        private readonly TaskAdmissionService _admission;
        private readonly PrdAgent.Infrastructure.Security.TaskExecutionCoordinator _coordinator;
        internal MongoDbContext Db { get; }
        internal KnowledgeIndexRefreshQueue Queue { get; }
        internal RefreshEmbedding Embedding { get; } = new();
        internal KnowledgeRetrievalService Retrieval { get; }
        internal IMongoCollection<GatewayTaskPermitRecord> Permits => Db.Database.GetCollection<GatewayTaskPermitRecord>(GatewayTaskPermitRecord.CollectionName);
        internal bool LastReplayed { get; private set; }

        internal RefreshFixture(string connection)
        {
            _client = new MongoClient(connection);
            Db = new MongoDbContext(connection, _name);
            var gatewayData = new LlmGatewayDataContext(connection, _name);
            _coordinator = new(gatewayData);
            _admission = new(gatewayData, _config, executions: _coordinator);
            Queue = new(Db, _config);
            var context = new LLMRequestContextAccessor();
            Retrieval = new KnowledgeRetrievalService(Db, Embedding, context);
            _services = new ServiceCollection().AddSingleton(Db).AddSingleton(_config)
                .AddSingleton<IRunEventStore>(Mock.Of<IRunEventStore>())
                .AddSingleton(new KnowledgeIndexRefreshProcessor(Db, Retrieval, context, _config))
                .AddSingleton(_admission).BuildServiceProvider();
        }

        internal DefaultHttpContext NewHttp(string entry, string content, string key)
        {
            var http = new DefaultHttpContext { RequestServices = _services,
                User = new ClaimsPrincipal(new ClaimsIdentity(new[] { new Claim("sub", "owner"), new Claim("authType", "jwt") }, "Bearer")) };
            http.Request.Method = "PUT";
            http.Request.Path = "/api/document-store/entries/" + entry + "/content";
            http.Request.ContentType = "application/json";
            http.Request.Body = new MemoryStream(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { content })));
            http.Request.Headers["Idempotency-Key"] = key;
            http.Response.Body = new MemoryStream();
            http.SetEndpoint(new Endpoint(_ => Task.CompletedTask, new EndpointMetadataCollection(new ControllerActionDescriptor
            { ControllerTypeInfo = typeof(DocumentStoreController).GetTypeInfo(), ActionName = nameof(DocumentStoreController.UpdateEntryContent) }), "save"));
            return http;
        }

        internal async Task<JsonElement> SaveAsync(string entry, string content, string key)
        {
            var http = NewHttp(entry, content, key);
            var controller = Controller(http);
            await new TaskAdmissionMiddleware(async _ =>
            {
                var result = Assert.IsType<OkObjectResult>(await controller.UpdateEntryContent(entry, new UpdateEntryContentRequest { Content = content }));
                await http.Response.WriteAsJsonAsync(result.Value);
            }).InvokeAsync(http, _admission);
            LastReplayed = http.Response.Headers["Idempotency-Replayed"] == "true";
            http.Response.Body.Position = 0;
            using var json = await JsonDocument.ParseAsync(http.Response.Body);
            return json.RootElement.Clone();
        }

        internal DocumentStoreController Controller(HttpContext http)
        {
            var storage = Mock.Of<IAssetStorage>();
            var documents = new Mock<IDocumentService>();
            documents.Setup(d => d.ParseAsync(It.IsAny<string>())).ReturnsAsync((string text) => new ParsedPrd { RawContent = text });
            documents.Setup(d => d.SaveAsync(It.IsAny<ParsedPrd>())).Returns(async (ParsedPrd doc) => { await Db.Documents.ReplaceOneAsync(d => d.Id == doc.Id, doc, new ReplaceOptions { IsUpsert = true }); return doc; });
            var teams = new Mock<ITeamService>();
            teams.Setup(t => t.GetMyTeamIdsAsync(It.IsAny<string>(), It.IsAny<CancellationToken>())).ReturnsAsync(new List<string>());
            var mentions = new MentionService(Db);
            var versions = new DocumentVersionService(Db);
            return new DocumentStoreController(Db, storage, null!, documents.Object, Mock.Of<IRunEventStore>(), null!, null!,
                teams.Object, Mock.Of<ITeamActivityService>(), mentions, versions, Mock.Of<IAdminPermissionService>(), null!, null!,
                null!, null!, _config, new DocumentStoreAssetNormalizer(storage, NullLogger<DocumentStoreAssetNormalizer>.Instance),
                null!, null!, new EntryContentWriteService(Db, documents.Object, mentions, versions, NullLogger<EntryContentWriteService>.Instance),
                null!, NullLogger<DocumentStoreController>.Instance, Queue)
            { ControllerContext = new ControllerContext { HttpContext = http } };
        }

        internal Task ProcessNextAsync()
        {
            var worker = new DocumentStoreAgentWorker(_services.GetRequiredService<IServiceScopeFactory>(),
                NullLogger<DocumentStoreAgentWorker>.Instance, _coordinator);
            return (Task)typeof(DocumentStoreAgentWorker).GetMethod("ProcessNextRunAsync", BindingFlags.Instance | BindingFlags.NonPublic)!
                .Invoke(worker, null)!;
        }

        public async ValueTask DisposeAsync()
        {
            await _services.DisposeAsync();
            await _client.DropDatabaseAsync(_name);
        }
    }

    private sealed class RefreshEmbedding : IEmbeddingService
    {
        public int Calls { get; private set; }
        public int Resolves { get; private set; }
        public bool Fail { get; set; }
        public Func<Task>? DuringCall { get; set; }
        public Task<string?> ResolveActiveModelAsync(string appCallerCode, CancellationToken ct = default)
        {
            Resolves++;
            return Task.FromResult<string?>("fixture-embedding");
        }
        public async Task<EmbeddingBatch> EmbedAsync(IReadOnlyList<string> texts, string appCallerCode, string userId, CancellationToken ct = default)
        {
            Assert.NotNull(TaskExecutionContext.Current?.Lease);
            Assert.Equal(AppCallerRegistry.Admin.KnowledgeBase.Index, appCallerCode);
            Assert.False(ct.CanBeCanceled);
            Calls++;
            if (DuringCall is not null) await DuringCall();
            return Fail ? EmbeddingBatch.Fail("UPSTREAM_ERROR", "供应商不可用") : new EmbeddingBatch
            { Success = true, Model = "fixture-embedding", Dimension = 2, Vectors = texts.Select(_ => new float[] { 1, 0 }).ToList() };
        }
    }
}
