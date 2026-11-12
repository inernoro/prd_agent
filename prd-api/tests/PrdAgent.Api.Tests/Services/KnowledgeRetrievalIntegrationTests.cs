using System.Runtime.CompilerServices;
using System.Security.Claims;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Core.Security;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Driver;
using Moq;
using PrdAgent.Api.Services;
using PrdAgent.Api.Services.BackgroundTasks;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Core.Services;
using PrdAgent.Infrastructure.Database;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

[Trait("Category", "Integration")]
public sealed class KnowledgeRetrievalIntegrationTests
{
    [Fact]
    public async Task Worker闭环_增量复用_跨文档引用_删除更新与撤权实时失效()
    {
        await using var f = await Fixture.Create();
        await f.Seed("entry-a", "原文A：蓝鲸协议等待120秒。");
        await f.Seed("entry-b", "原文B：索引采用MongoDB。");
        await f.Db.DocumentStores.InsertOneAsync(new DocumentStore { Id = "secret-store", OwnerId = "other-user" });
        await f.Db.DocumentEntries.InsertOneAsync(new DocumentEntry { Id = "secret", StoreId = "secret-store", DocumentId = "secret-doc" });
        f.Texts["secret-doc"] = "SAPPHIRE-7391不可读机密";
        var result = await f.Service.SearchAsync("store", "reader", "蓝鲸协议与存储是什么？");
        Assert.Equal(2, result.Hits.Count);
        Assert.DoesNotContain("SAPPHIRE", f.LastPrompt);
        var answer = KnowledgeRetrieval.Answer(result.Selection, result.Hits);
        Assert.Contains("entry=entry-a", answer);
        Assert.Contains("entry=entry-b", answer);
        Assert.Equal(2, f.IndexedTexts);
        var reused = await f.Service.SearchAsync("store", "reader", "再问一次");
        Assert.Equal(2, f.IndexedTexts); // 未变正文不会重新向量化
        Assert.Equal(2, reused.Hits.Count);
        f.Texts["doc-entry-a"] = "原文A已更新，等待30秒。";
        await Assert.ThrowsAsync<KnowledgeRetrievalException>(() => f.Service.ValidateAsync("store", "reader", result.Hits));
        var updated = await f.Service.SearchAsync("store", "reader", "更新后的等待时间？");
        Assert.Contains(updated.Hits, h => h.Text.Contains("30秒"));
        Assert.DoesNotContain(updated.Hits, h => h.Text.Contains("120秒"));
        Assert.Equal(3, f.IndexedTexts);
        await f.Db.DocumentEntries.DeleteOneAsync(e => e.Id == "entry-b");
        await Assert.ThrowsAsync<KnowledgeRetrievalException>(() => f.Service.ValidateAsync("store", "reader", updated.Hits));
        var deleted = await f.Service.SearchAsync("store", "reader", "存储是什么？");
        Assert.DoesNotContain(deleted.Hits, h => h.EntryId == "entry-b");
        await f.Db.DocumentStores.UpdateOneAsync(s => s.Id == "store", Builders<DocumentStore>.Update.Set(s => s.OwnerId, "other-user"));
        await Assert.ThrowsAsync<UnauthorizedAccessException>(() => f.Service.ValidateAsync("store", "reader", deleted.Hits));
        var calls = f.QueryCalls;
        await Assert.ThrowsAsync<UnauthorizedAccessException>(() => f.Service.SearchAsync("secret-store", "reader", "机密"));
        Assert.Equal(calls, f.QueryCalls);
        Assert.DoesNotContain("SAPPHIRE", f.LastPrompt);
    }

    [Fact]
    public async Task 长文使用真实正文_无答案与模型漂移失败关闭()
    {
        await using var f = await Fixture.Create();
        await f.Seed("entry-a", new string('甲', 2200) + "正文尾部的唯一依据TAIL-937。");
        f.Selection = "[]";
        var result = await f.Service.SearchAsync("store", "reader", "库里没有的财务数据？");
        Assert.Contains(result.Hits, h => h.Text.Contains("TAIL-937"));
        Assert.Equal(KnowledgeRetrieval.Refusal, KnowledgeRetrieval.Answer(result.Selection, result.Hits));
        f.QueryModel = "different-model-same-dimension";
        var error = await Assert.ThrowsAsync<KnowledgeRetrievalException>(() => f.Service.SearchAsync("store", "reader", "问题"));
        Assert.Contains("向量模型或维度不一致", error.Message);
    }

    [Fact]
    public async Task 缺向量模型时清楚报错_不调用回答模型()
    {
        await using var f = await Fixture.Create();
        await f.Seed("entry-a", "这是正文。");
        f.ActiveModel = null;
        var error = await Assert.ThrowsAsync<KnowledgeRetrievalException>(() => f.Service.SearchAsync("store", "reader", "问题"));
        Assert.Contains("NO_EMBEDDING_MODEL", error.Message);
        Assert.Equal("", f.LastPrompt);
    }

    [Fact]
    public void 任务准入只扩展站内问答_不扩大分享能力()
    {
        const string controller = "PrdAgent.Api.Controllers.Api.WebPageAskController";
        var site = TaskAdmissionPolicies.Find(controller, "AskStream")!;
        var share = TaskAdmissionPolicies.Find(controller, "AskStreamByShare")!;
        Assert.Contains(AppCallerRegistry.Admin.KnowledgeBase.Index, site.AppCallers);
        Assert.Contains(AppCallerRegistry.Admin.KnowledgeBase.Query, site.AppCallers);
        Assert.DoesNotContain(AppCallerRegistry.Admin.KnowledgeBase.Index, share.AppCallers);
        Assert.True(site.AgentMaxCalls >= (KnowledgeRetrievalService.MaxChunks + 63) / 64 + 2);
        Assert.Equal(DocumentStoreRunKinds.KnowledgeIndex, DocumentStoreAgentWorker.KindForEvents(DocumentStoreAgentRunKind.KnowledgeIndex));
    }

    [Fact]
    public async Task 阅读器与检索共用公开团队项目产品与识图权限判据()
    {
        await using var f = await Fixture.Create();
        async Task<bool> Read(DocumentStore store, string[]? teams = null, string[]? permissions = null) =>
            await DocumentStoreReadAccess.CanReadAsync(f.Db, store, "reader", teams ?? [], permissions ?? []);
        Assert.True(await Read(new DocumentStore { OwnerId = "reader" }));
        Assert.True(await Read(new DocumentStore { IsPublic = true }));
        Assert.True(await Read(new DocumentStore { SharedTeamIds = ["team"] }, ["team"]));
        Assert.False(await Read(new DocumentStore { SharedTeamIds = ["team"] }));
        Assert.True(await Read(new DocumentStore { ShituCategoryRef = "category" }, permissions: [AdminPermissionCatalog.ShituAgentUse]));
        Assert.False(await Read(new DocumentStore { ShituCategoryRef = "category" }));
        var project = new PmProject { Id = "project", ObserverIds = ["reader"] };
        await f.Db.PmProjects.InsertOneAsync(project);
        Assert.True(await Read(new DocumentStore { PmProjectId = "project" }));
        await f.Db.PmProjects.UpdateOneAsync(p => p.Id == "project", Builders<PmProject>.Update.Set(p => p.IsDeleted, true));
        Assert.False(await Read(new DocumentStore { PmProjectId = "project" }));
        await f.Db.Products.InsertOneAsync(new Product { Id = "product", MemberIds = ["reader"] });
        Assert.True(await Read(new DocumentStore { ProductKnowledgeRef = "product:product" }));
        Assert.False(await Read(new DocumentStore { ProductKnowledgeRef = "product:missing" }));
    }

    [Fact]
    public async Task 团队站点访客不能把私有知识写进站点所有者的会话审计()
    {
        await using var f = await Fixture.Create();
        var sites = new Mock<IHostedSiteService>();
        var site = new HostedSite { Id = "team-site", OwnerUserId = "site-owner", AskEnabled = true };
        sites.Setup(s => s.GetByIdAsync(site.Id, "reader", default)).ReturnsAsync(site);
        var quota = new Mock<IAskQuotaService>(MockBehavior.Strict);
        var decision = new AskQuotaDecision { Allowed = true, Consumed = true, ConsumedSiteKey = "original-site", ConsumedVisitorKey = "original-reader" };
        quota.Setup(q => q.TryConsumeAsync(site.Id, "reader", It.IsAny<string?>(), site.AskDailyLimit, default)).ReturnsAsync(decision);
        quota.Setup(q => q.RefundAsync(decision, site.Id, default)).Returns(Task.CompletedTask);
        var controller = new WebPageAskController(sites.Object, Mock.Of<ISiteContentSnapshotService>(MockBehavior.Strict),
            quota.Object, Mock.Of<IAskOpeningQuestionGenerator>(MockBehavior.Strict), Mock.Of<ILlmGateway>(MockBehavior.Strict),
            new LLMRequestContextAccessor(), f.Db, NullLogger<WebPageAskController>.Instance);
        var http = new DefaultHttpContext();
        http.User = new ClaimsPrincipal(new ClaimsIdentity(new[] { new Claim(ClaimTypes.NameIdentifier, "reader") }, "test"));
        http.Response.Body = new MemoryStream();
        controller.ControllerContext = new ControllerContext { HttpContext = http };
        await controller.AskStream(site.Id, new AskStreamRequest { Question = "机密？", KnowledgeStoreId = "store" });
        Assert.Equal(403, http.Response.StatusCode);
        Assert.Equal(0, f.IndexedTexts);
        Assert.Equal(0, await f.Db.HostedSiteAskMessages.CountDocumentsAsync(_ => true));
        quota.Verify(q => q.RefundAsync(decision, site.Id, default), Times.Once);
        await f.Db.DocumentStoreAgentRuns.InsertOneAsync(new DocumentStoreAgentRun { Id = "knowledge-run", UserId = "reader",
            Kind = DocumentStoreAgentRunKind.KnowledgeIndex, GeneratedText = "SAPPHIRE-7391过期候选" });
        var documents = new DocumentStoreController(db: f.Db, assetStorage: null!, fileContentExtractor: null!,
            documentService: null!, runEventStore: null!, urlValidator: null!, httpClientFactory: null!, teams: null!,
            teamActivity: null!, mentions: null!, versions: null!, adminPermissions: null!, shortLinks: null!,
            hostedSites: null!, gateway: null!, llmRequestContext: null!, config: null!, assetNormalizer: null!,
            liveTranscriptionRelay: null!, documentAssetCleanup: null!, entryContentWriter: null!,
            githubConnections: null!, logger: NullLogger<DocumentStoreController>.Instance)
            { ControllerContext = new ControllerContext { HttpContext = http } };
        var runResponse = Assert.IsType<OkObjectResult>(await documents.GetAgentRun("knowledge-run"));
        Assert.DoesNotContain("SAPPHIRE", System.Text.Json.JsonSerializer.Serialize(runResponse.Value));
        var retained = await f.Db.DocumentStoreAgentRuns.Find(r => r.Id == "knowledge-run").SingleAsync();
        Assert.Contains("SAPPHIRE", retained.GeneratedText); // 只是安全的状态投影，未覆盖后台数据。

    }

    private sealed class Fixture : IAsyncDisposable
    {
        public MongoDbContext Db { get; private set; } = null!;
        public KnowledgeRetrievalService Service { get; private set; } = null!;
        public Dictionary<string, string> Texts { get; } = new();
        public int IndexedTexts, QueryCalls;
        public string? ActiveModel = "test-embedding";
        public string QueryModel = "test-embedding", Selection = "[1,2]", LastPrompt = "";
        private MongoClient Client = null!;
        private string Name = "";
        private ServiceProvider Provider = null!;
        private DocumentStoreAgentWorker Worker = null!;

        public static async Task<Fixture> Create()
        {
            var f = new Fixture();
            f.Name = "kb_retrieval_" + Guid.NewGuid().ToString("N");
            var connection = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION") ?? "mongodb://127.0.0.1:27017";
            f.Client = new MongoClient(connection);
            f.Db = new MongoDbContext(connection, f.Name);
            await f.Db.DocumentStores.InsertOneAsync(new DocumentStore { Id = "store", OwnerId = "reader" });
            var docs = new Mock<IDocumentService>(MockBehavior.Strict);
            docs.Setup(d => d.GetByIdAsync(It.IsAny<string>())).ReturnsAsync((string id) =>
                f.Texts.TryGetValue(id, out var text) ? new ParsedPrd { Id = id, RawContent = text } : null);
            var teams = new Mock<ITeamService>();
            teams.Setup(t => t.GetMyTeamIdsAsync(It.IsAny<string>(), default)).ReturnsAsync(new List<string>());
            var perms = new Mock<IAdminPermissionService>();
            perms.Setup(p => p.GetEffectivePermissionsAsync(It.IsAny<string>(), It.IsAny<bool>(), default)).ReturnsAsync(Array.Empty<string>());
            var embed = new Mock<IEmbeddingService>();
            embed.Setup(e => e.ResolveActiveModelAsync(It.IsAny<string>(), default)).ReturnsAsync(() => f.ActiveModel);
            embed.Setup(e => e.EmbedAsync(It.IsAny<IReadOnlyList<string>>(), It.IsAny<string>(), "reader", default))
                .ReturnsAsync((IReadOnlyList<string> texts, string caller, string user, CancellationToken ct) =>
                {
                    if (caller == AppCallerRegistry.Admin.KnowledgeBase.Index) f.IndexedTexts += texts.Count;
                    else f.QueryCalls++;
                    return new EmbeddingBatch { Success = true, Model = caller == AppCallerRegistry.Admin.KnowledgeBase.Index ? "test-embedding" : f.QueryModel,
                        Dimension = 2, Vectors = texts.Select(_ => new[] { 1f, 0f }).ToList() };
                });
            var gateway = new Mock<ILlmGateway>(MockBehavior.Strict);
            gateway.Setup(g => g.StreamAsync(It.IsAny<GatewayRequest>(), default)).Returns((GatewayRequest request, CancellationToken ct) => f.Stream(request, ct));
            var config = new ConfigurationBuilder().Build();
            var contexts = new LLMRequestContextAccessor();
            f.Service = new KnowledgeRetrievalService(f.Db, docs.Object, embed.Object,
                new DocumentStoreReadAccess(f.Db, teams.Object, perms.Object), config, contexts, gateway.Object);
            f.Provider = new ServiceCollection().AddSingleton(f.Db).AddSingleton<IConfiguration>(config)
                .AddSingleton(f.Service).AddSingleton(Mock.Of<IRunEventStore>()).BuildServiceProvider();
            f.Worker = new DocumentStoreAgentWorker(f.Provider.GetRequiredService<IServiceScopeFactory>(), NullLogger<DocumentStoreAgentWorker>.Instance);
            await f.Worker.StartAsync(default);
            return f;
        }

        private async IAsyncEnumerable<GatewayStreamChunk> Stream(GatewayRequest request, [EnumeratorCancellation] CancellationToken ct)
        {
            LastPrompt = request.RequestBody!.ToJsonString();
            yield return new GatewayStreamChunk { Type = GatewayChunkType.Start,
                Resolution = new GatewayModelResolution { Success = true, ActualModel = "test-chat" } };
            await Task.Yield();
            yield return GatewayStreamChunk.Text(Selection);
        }

        public async Task Seed(string id, string text)
        {
            Texts["doc-" + id] = text;
            await Db.DocumentEntries.InsertOneAsync(new DocumentEntry { Id = id, StoreId = "store", Title = id,
                DocumentId = "doc-" + id, ContentIndex = text[..Math.Min(2000, text.Length)] });
        }

        public async ValueTask DisposeAsync()
        {
            await Worker.StopAsync(default); Worker.Dispose();
            await Client.DropDatabaseAsync(Name); await Provider.DisposeAsync();
        }
    }
}
