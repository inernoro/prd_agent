using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Reflection;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.Extensions.DependencyInjection;
using PrdAgent.Api.Middleware;
using PrdAgent.Api.Services.BackgroundTasks;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Infrastructure.Services.AssetStorage;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Driver;
using Moq;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services;
using PrdAgent.Infrastructure.Services.DocumentStore;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

[Trait("Category", TestCategories.Integration)]
public sealed class IndependentWritingCollectionAcceptanceTests
{
    [Theory]
    [InlineData(false, 3)]
    [InlineData(true, 4)]
    public async Task PublicStoreCountsOnlyReaderVisibleDocumentsWithoutChangingOwnerCount(bool published, int expected)
    {
        await using var f = new Fixture();
        await SeedPublicCountStoreAsync(f, published);
        var controller = PublicCountController(f);

        var listing = PublicCountData(await controller.ListPublicStores());
        Assert.Equal(expected, Assert.Single(listing.GetProperty("items").EnumerateArray()).GetProperty("documentCount").GetInt32());
        var detail = PublicCountData(await controller.GetPublicStore("store"));
        Assert.Equal(expected, detail.GetProperty("documentCount").GetInt32());
        var entries = PublicCountData(await controller.ListPublicStoreEntries("store"));
        Assert.Equal(expected, entries.GetProperty("total").GetInt32());
        Assert.Contains(entries.GetProperty("items").EnumerateArray(), entry => entry.GetProperty("id").GetString() == "source-c");
        Assert.Equal(4, (await f.Db.DocumentStores.Find(store => store.Id == "store").SingleAsync()).DocumentCount);
    }

    [Theory]
    [InlineData(false, 3)]
    [InlineData(true, 1)]
    public async Task StoreShareCountUsesVisibleTokenScopeInsteadOfOwnerTotal(bool singleEntry, int expected)
    {
        await using var f = new Fixture();
        await SeedPublicCountStoreAsync(f, published: false);
        await f.Db.DocumentStoreShareLinks.InsertOneAsync(new DocumentStoreShareLink {
            Id = "share", StoreId = "store", Token = "public-count-token", CreatedBy = "owner",
            EntryId = singleEntry ? "source-c" : null,
        });
        var controller = PublicCountController(f);

        var share = PublicCountData(await controller.AccessShareLink("public-count-token"));
        Assert.Equal(expected, share.GetProperty("store").GetProperty("documentCount").GetInt32());
        var entries = PublicCountData(await controller.ListShareEntries("public-count-token"));
        Assert.Equal(expected, entries.GetProperty("total").GetInt32());
        Assert.DoesNotContain(entries.GetProperty("items").EnumerateArray(), entry => entry.GetProperty("id").GetString() == "draft");
        Assert.Equal(4, (await f.Db.DocumentStores.Find(store => store.Id == "store").SingleAsync()).DocumentCount);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task PublishedOrdinaryPublicAndShareContentUseTheSameFrozenReadProjection(bool singleEntry)
    {
        await using var f = new Fixture();
        var entry = WritingPublishedContentProjectionTests.Entry();
        entry.DocumentId = "private-original-document"; entry.AttachmentId = "private-original-file";
        await f.Db.DocumentStores.InsertOneAsync(new DocumentStore { Id = "store", OwnerId = "owner", IsPublic = true });
        await f.Db.DocumentEntries.InsertOneAsync(entry);
        await f.Db.DocumentStoreShareLinks.InsertOneAsync(new DocumentStoreShareLink {
            Id = "projection-share", StoreId = "store", Token = "projection-unit-token", EntryId = singleEntry ? "writing" : null, CreatedBy = "owner"
        });
        var documents = new Mock<IDocumentService>(MockBehavior.Strict);
        var teams = new Mock<ITeamService>(MockBehavior.Strict);
        teams.Setup(t => t.GetMyTeamIdsAsync("owner", It.IsAny<CancellationToken>())).ReturnsAsync(new List<string>());
        var controller = new DocumentStoreController(f.Db, null!, null!, documents.Object, null!, null!, null!, teams.Object,
            null!, null!, null!, null!, null!, null!, null!, null!, new ConfigurationBuilder().Build(), null!, null!, null!, null!, null!, NullLogger<DocumentStoreController>.Instance) {
            ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext {
                User = new ClaimsPrincipal(new ClaimsIdentity(new[] { new Claim("sub", "owner") }, "test")) } }
        };
        var before = JsonSerializer.Serialize((await f.Db.DocumentEntries.Find(e => e.Id == "writing").SingleAsync()).Writing);
        var ordinary = PublicCountData(await controller.GetEntryContent("writing"));
        controller.ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() };
        var published = PublicCountData(await controller.GetPublicEntryContent("writing"));
        var shared = PublicCountData(await controller.GetShareEntryContent("projection-unit-token", "writing"));
        Assert.Equal(ordinary.GetRawText(), published.GetRawText()); Assert.Equal(ordinary.GetRawText(), shared.GetRawText());
        Assert.Contains("作者确认补充", shared.GetProperty("content").GetString());
        Assert.DoesNotContain("未发布下一稿", shared.GetProperty("content").GetString());
        Assert.IsType<NotFoundObjectResult>(await controller.GetShareEntryContent("unknown-token", "writing"));
        await f.Db.DocumentEntries.InsertOneAsync(new DocumentEntry { Id = "unpublished", StoreId = "store", Writing = new WritingDocumentState() });
        Assert.IsType<NotFoundObjectResult>(await controller.GetPublicEntryContent("unpublished"));
        Assert.IsType<NotFoundObjectResult>(await controller.GetShareEntryContent("projection-unit-token", "unpublished"));
        Assert.Equal(before, JsonSerializer.Serialize((await f.Db.DocumentEntries.Find(e => e.Id == "writing").SingleAsync()).Writing));
        documents.VerifyNoOtherCalls();
    }

    private static async Task SeedPublicCountStoreAsync(Fixture fixture, bool published)
    {
        await fixture.Db.DocumentStores.InsertManyAsync(new[] {
            new DocumentStore { Id = "store", OwnerId = "owner", IsPublic = true, DocumentCount = 4 },
            new DocumentStore { Id = "private-store", OwnerId = "owner", DocumentCount = 1 },
        });
        await fixture.Db.DocumentEntries.InsertManyAsync(new[] {
            new DocumentEntry { Id = "source-a", StoreId = "store", Title = "原始规范" },
            new DocumentEntry { Id = "source-b", StoreId = "store", Title = "旧版说明" },
            // 被成文跳过的是引用关系，普通源文件仍可公开阅读，不能从可读数量中排除。
            new DocumentEntry { Id = "source-c", StoreId = "store", Title = "已跳过引用的辅助原件" },
            new DocumentEntry { Id = "draft", StoreId = "store", Title = "未发布草稿", Writing = new WritingDocumentState {
                Stage = "confirm", Published = published ? new WritingPublication { Version = 1, Title = "稳定发布版" } : null,
            } },
            new DocumentEntry { Id = "foreign", StoreId = "private-store", Title = "其他库资料" },
        });
    }

    private static JsonElement PublicCountData(IActionResult result) => JsonSerializer.SerializeToElement(
        Assert.IsType<OkObjectResult>(result).Value, new JsonSerializerOptions(JsonSerializerDefaults.Web)).GetProperty("data");

    private static DocumentStoreController PublicCountController(Fixture fixture) => new(fixture.Db, null!, null!, Mock.Of<IDocumentService>(),
        null!, null!, null!, null!, null!, null!, null!, null!, null!, null!, null!, null!, new ConfigurationBuilder().Build(),
        null!, null!, null!, null!, null!, NullLogger<DocumentStoreController>.Instance) {
            ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() }
        };

    [Fact]
    public async Task SuccessfulCollectionEntryRecordsOneVisitAndAuxiliaryReadsDoNotAddVisits()
    {
        await using var f = new Fixture();
        var collection = new HostedDocumentCollection { Id = "collection", OwnerUserId = "owner", Name = "验收合集", MainSiteId = "site", SiteIds = new() { "site" } };
        await f.Db.Database.GetCollection<HostedDocumentCollection>("hosted_document_collections").InsertOneAsync(collection);
        await f.Db.HostedSites.InsertOneAsync(new HostedSite { Id = "site", OwnerUserId = "owner", Title = "验收文档" });
        await f.Db.WebPageShareLinks.InsertOneAsync(new WebPageShareLink { Id = "share", Token = "token", CreatedBy = "owner", Visibility = "public", AccessLevel = "public", ShareType = "collection", SiteIds = new() { "site" }, CollectionSnapshot = HostedCollectionPolicy.Snapshot(collection, collection.SiteIds) });
        var service = new HostedSiteService(f.Db, null!, null!, null!, null!, null!, null!, null!, NullLogger<HostedSiteService>.Instance);
        var controller = new WebPagesController(service, null!, null!, f.Db, null!, null!) {
            ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() }
        };
        controller.HttpContext.Connection.RemoteIpAddress = System.Net.IPAddress.Loopback;
        controller.Request.Headers.UserAgent = "independent-acceptance";
        Assert.IsType<OkObjectResult>(await controller.ReadCollectionShare("token", null));
        var first = await f.Db.WebPageShareLinks.Find(s => s.Id == "share").SingleAsync();
        Assert.Equal(1L, first.ViewCount);
        Assert.NotNull(first.LastViewedAt);
        Assert.Equal(1L, await f.Db.ShareViewLogs.CountDocumentsAsync(l => l.ShareId == "share"));
        Assert.Null((await service.ResolveShareSiteAsync("token", "site", null, null)).Error);
        Assert.Equal(1L, (await f.Db.WebPageShareLinks.Find(s => s.Id == "share").SingleAsync()).ViewCount);
        Assert.IsType<OkObjectResult>(await controller.ReadCollectionShare("token", null));
        Assert.Equal(2L, (await f.Db.WebPageShareLinks.Find(s => s.Id == "share").SingleAsync()).ViewCount);
        var concurrent = Enumerable.Range(0, 8).Select(async _ => {
            var visitor = new WebPagesController(service, null!, null!, f.Db, null!, null!) {
                ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() }
            };
            return await visitor.ReadCollectionShare("token", null);
        });
        Assert.All(await Task.WhenAll(concurrent), result => Assert.IsType<OkObjectResult>(result));
        Assert.Equal(10L, (await f.Db.WebPageShareLinks.Find(s => s.Id == "share").SingleAsync()).ViewCount);
        Assert.Equal(10L, await f.Db.ShareViewLogs.CountDocumentsAsync(l => l.ShareId == "share"));
        await f.Db.WebPageShareLinks.UpdateOneAsync(s => s.Id == "share", Builders<WebPageShareLink>.Update.Set(s => s.IsRevoked, true));
        Assert.IsNotType<OkObjectResult>(await controller.ReadCollectionShare("token", null));
        Assert.Equal(10L, (await f.Db.WebPageShareLinks.Find(s => s.Id == "share").SingleAsync()).ViewCount);
    }

    [Theory]
    [InlineData("revoked")]
    [InlineData("expired")]
    [InlineData("private")]
    [InlineData("wrong-password")]
    [InlineData("dissolved")]
    [InlineData("generation-stopped")]
    public async Task RejectedCollectionEntryNeverRecordsAVisit(string rejection)
    {
        await using var f = new Fixture();
        var collection = new HostedDocumentCollection { Id = "collection", OwnerUserId = "owner", Name = "验收合集", MainSiteId = "site", SiteIds = new() { "site" } };
        await f.Db.Database.GetCollection<HostedDocumentCollection>("hosted_document_collections").InsertOneAsync(collection);
        await f.Db.HostedSites.InsertOneAsync(new HostedSite { Id = "site", OwnerUserId = "owner", Title = "验收文档" });
        await f.Db.WebPageShareLinks.InsertOneAsync(new WebPageShareLink { Id = "share", Token = "token", CreatedBy = "owner",
            Visibility = rejection == "private" ? "owner-only" : "public", AccessLevel = rejection == "wrong-password" ? "password" : "public",
            Password = "correct-test-only", IsRevoked = rejection == "revoked", ExpiresAt = rejection == "expired" ? DateTime.UtcNow.AddDays(-1) : null,
            ShareType = "collection", SiteIds = new() { "site" }, CollectionSnapshot = HostedCollectionPolicy.Snapshot(collection, collection.SiteIds) });
        if (rejection == "dissolved")
            await f.Db.Database.GetCollection<HostedDocumentCollection>("hosted_document_collections").UpdateOneAsync(c => c.Id == collection.Id,
                Builders<HostedDocumentCollection>.Update.Set(c => c.DissolvedAt, DateTime.UtcNow));
        if (rejection == "generation-stopped")
            await f.Db.Database.GetCollection<HostedDocumentCollection>("hosted_document_collections").UpdateOneAsync(c => c.Id == collection.Id,
                Builders<HostedDocumentCollection>.Update.Inc(c => c.ShareGeneration, 1));
        var service = new HostedSiteService(f.Db, null!, null!, new SharePasswordService(), null!, null!, null!, null!, NullLogger<HostedSiteService>.Instance);
        var controller = new WebPagesController(service, null!, null!, f.Db, null!, null!) {
            ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() }
        };
        Assert.IsNotType<OkObjectResult>(await controller.ReadCollectionShare("token", "wrong-test-only"));
        var stored = await f.Db.WebPageShareLinks.Find(s => s.Id == "share").SingleAsync();
        Assert.Equal(0L, stored.ViewCount); Assert.Null(stored.LastViewedAt);
        Assert.Equal(0L, await f.Db.ShareViewLogs.CountDocumentsAsync(l => l.ShareId == "share"));
    }

    [Theory]
    [InlineData("skipped")]
    [InlineData("read-changed")]
    [InlineData("read-deleted")]
    public async Task SkippedUnreadSourceDoesNotBlockApprovedDocumentOrBecomeReadEvidence(string scenario)
    {
        await using var f = new Fixture();
        var documents = new Dictionary<string, ParsedPrd> { ["source-doc"] = new() { Id = "source-doc", RawContent = "未参与生成的原文" } };
        var docService = new Mock<IDocumentService>();
        docService.Setup(d => d.GetByIdAsync(It.IsAny<string>())).ReturnsAsync((string id) => documents.GetValueOrDefault(id));
        docService.Setup(d => d.ParseAsync(It.IsAny<string>())).ReturnsAsync((string text) => new ParsedPrd { Id = "published-doc", RawContent = text });
        docService.Setup(d => d.SaveAsync(It.IsAny<ParsedPrd>())).ReturnsAsync((ParsedPrd doc) => { documents[doc.Id] = doc; return doc; });
        await f.Db.DocumentStores.InsertOneAsync(new DocumentStore { Id = "store", OwnerId = "owner" });
        await f.Db.DocumentEntries.InsertManyAsync(new[] {
            new DocumentEntry { Id = "source", StoreId = "store", DocumentId = "source-doc" },
            new DocumentEntry { Id = "writing", StoreId = "store", Writing = new WritingDocumentState {
                Revision = 1, Stage = "pending-review", Title = "确认文档", AuthorId = "owner", ReviewerId = "owner",
                Sources = new() { new() { Id = "S1", EntryId = "source", Title = "已跳过资料", Status = scenario == "skipped" ? "skipped" : "read", Hash = scenario == "skipped" ? "" : Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes("读取时的旧正文"))).ToLowerInvariant(), Content = scenario == "skipped" ? "" : "读取时的旧正文" } },
                Sections = new() { new() { Id = "section", Title = "步骤", Paragraphs = new() { new() { Id = "p", Text = "仅按作者输入执行", Status = "auth", Confirmed = true } } } }
            } }
        });
        var teams = new Mock<ITeamService>();
        teams.Setup(t => t.GetMyTeamIdsAsync(It.IsAny<string>(), It.IsAny<CancellationToken>())).ReturnsAsync(new List<string>());
        var mentions = new MentionService(f.Db); var versions = new DocumentVersionService(f.Db);
        var writer = new EntryContentWriteService(f.Db, docService.Object, mentions, versions, NullLogger<EntryContentWriteService>.Instance);
        var controller = new DocumentStoreController(f.Db, null!, null!, docService.Object, null!, null!, null!, teams.Object,
            null!, mentions, versions, null!, null!, null!, null!, null!, new ConfigurationBuilder().Build(),
            null!, null!, null!, writer, null!, NullLogger<DocumentStoreController>.Instance) {
                ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext {
                    User = new ClaimsPrincipal(new ClaimsIdentity(new[] { new Claim("sub", "owner") }, "test")) } }
            };
        if (scenario == "read-deleted") await f.Db.DocumentEntries.DeleteOneAsync(e => e.Id == "source");
        var result = await controller.CommandWritingDocument("writing", new WritingCommandRequest { Revision = 1, Action = "approve" });
        if (scenario != "skipped") {
            Assert.IsType<UnprocessableEntityObjectResult>(result);
            var pending = await f.Db.DocumentEntries.Find(e => e.Id == "writing").SingleAsync();
            Assert.Equal("pending-review", pending.Writing!.Stage); Assert.Null(pending.Writing.Published); Assert.Null(pending.DocumentId);
            docService.Verify(d => d.ParseAsync(It.IsAny<string>()), Times.Never);
            return;
        }
        Assert.IsType<OkObjectResult>(result);
        var actual = await f.Db.DocumentEntries.Find(e => e.Id == "writing").SingleAsync();
        Assert.Equal("published", actual.Writing!.Stage);
        Assert.NotNull(actual.Writing.Published);
        Assert.Equal("skipped", actual.Writing.Published!.Sources.Single().Status);
        Assert.Empty(actual.Writing.Published.Sources.Single().Content);
        Assert.Contains("仅按作者输入执行", documents[actual.DocumentId!].RawContent);
        var read = Assert.IsType<OkObjectResult>(await controller.ReadWritingPublication("writing"));
        var payload = JsonSerializer.SerializeToElement(read.Value, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        Assert.Empty(payload.GetProperty("data").GetProperty("affectedSources").EnumerateArray());
        Assert.Equal("skipped", payload.GetProperty("data").GetProperty("publication").GetProperty("sources")[0].GetProperty("status").GetString());
        actual.Writing.Published.Sources.Add(new WritingSource {
            Id = "S2", EntryId = "source", Title = "参与生成的旧快照", Status = "read", Content = "读取时的旧正文",
            Hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes("读取时的旧正文"))).ToLowerInvariant()
        });
        await f.Db.DocumentEntries.UpdateOneAsync(e => e.Id == "writing",
            Builders<DocumentEntry>.Update.Set(e => e.Writing, actual.Writing));
        foreach (var deleted in new[] { false, true }) {
            if (deleted) await f.Db.DocumentEntries.DeleteOneAsync(e => e.Id == "source");
            var changedRead = Assert.IsType<OkObjectResult>(await controller.ReadWritingPublication("writing"));
            var changedPayload = JsonSerializer.SerializeToElement(changedRead.Value, new JsonSerializerOptions(JsonSerializerDefaults.Web));
            var affected = changedPayload.GetProperty("data").GetProperty("affectedSources").EnumerateArray().Select(x => x.GetString()).ToArray();
            Assert.Equal(new[] { "S2" }, affected);
            Assert.Equal("读取时的旧正文", changedPayload.GetProperty("data").GetProperty("publication").GetProperty("sources")[1].GetProperty("content").GetString());
        }
    }

    [Theory]
    [InlineData("missing")]
    [InlineData("stale")]
    [InlineData("confirmed")]
    public async Task PermissionSyncUsesRealPrivateSourceGateAndRecordsConfirmationBeforeWidening(string confirmation)
    {
        await using var f = new Fixture();
        var storageRoot = Path.Combine(Path.GetTempPath(), "independent-sync-" + Guid.NewGuid().ToString("N"));
        try {
            var collection = new HostedDocumentCollection { Id = "collection", OwnerUserId = "owner", Name = "权限验收合集", MainSiteId = "main", SiteIds = new() { "main", "target" } };
            await f.Db.Database.GetCollection<HostedDocumentCollection>("hosted_document_collections").InsertOneAsync(collection);
            var target = new HostedSite { Id = "target", OwnerUserId = "owner", Title = "含私有来源的副文档", Visibility = "private", PublishedRevisionId = "revision" };
            await f.Db.HostedSites.InsertManyAsync(new[] { new HostedSite { Id = "main", OwnerUserId = "owner", Title = "公开主文档", Visibility = "public" }, target });
            await f.Db.DocumentStores.InsertOneAsync(new DocumentStore { Id = "private-store", OwnerId = "owner", IsPublic = false });
            await f.Db.DocumentEntries.InsertOneAsync(new DocumentEntry { Id = "private-source", StoreId = "private-store", Title = "私有预算" });
            await f.Db.HostedSiteRevisions.InsertOneAsync(new HostedSiteRevision { Id = "revision", SiteId = "target", Source = HostedSiteRevisionSources.Baseline,
                Status = HostedSiteRevisionStatuses.Published, KnowledgeEntryIds = new() { "private-source" } });
            var teams = new Mock<ITeamService>();
            teams.Setup(t => t.GetMyTeamIdsAsync(It.IsAny<string>(), It.IsAny<CancellationToken>())).ReturnsAsync(new List<string>());
            teams.Setup(t => t.GetMyWebHostingTeamRolesAsync(It.IsAny<string>(), It.IsAny<CancellationToken>())).ReturnsAsync(new Dictionary<string, string>());
            var service = new HostedSiteService(f.Db, new LocalAssetStorage(storageRoot), null!, new SharePasswordService(), teams.Object, null!, null!, null!, NullLogger<HostedSiteService>.Instance);
            var gate = new HostedSitePrivateSourceGate(new MongoHostedSitePrivateSourceStore(f.Db));
            var controller = new WebPagesController(service, null!, null!, f.Db, teams.Object, null!, gate) {
                ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext {
                    User = new ClaimsPrincipal(new ClaimsIdentity(new[] { new Claim("sub", "owner") }, "test")) } }
            };
            var permissions = Assert.IsType<OkObjectResult>(await controller.CollectionPermissions(collection.Id));
            var fingerprint = JsonSerializer.SerializeToElement(permissions.Value, new JsonSerializerOptions(JsonSerializerDefaults.Web)).GetProperty("data").GetProperty("fingerprint").GetString()!;
            var report = await gate.InspectSitesAsync(new[] { target }, CancellationToken.None);
            Assert.True(report.HasPrivateSources);
            var request = new WebPagesController.CollectionSyncRequest { Fingerprint = fingerprint, SiteIds = new() { "target" },
                ConfirmedPrivateSourceFingerprint = confirmation == "confirmed" ? report.Fingerprint : confirmation == "stale" ? "psc1:old" : null };
            var result = await controller.SyncCollectionPermissions(collection.Id, request);
            var stored = await f.Db.HostedSites.Find(site => site.Id == "target").SingleAsync();
            var revision = await f.Db.HostedSiteRevisions.Find(r => r.Id == "revision").SingleAsync();
            if (confirmation == "confirmed") {
                Assert.IsType<OkObjectResult>(result); Assert.Equal("public", stored.Visibility);
                var recorded = Assert.Single(revision.PrivateSourceConfirmations);
                Assert.Equal(report.Fingerprint, recorded.Fingerprint); Assert.Equal("owner", recorded.UserId);
                Assert.Equal(HostedSitePrivateSourceActions.SitePublic, recorded.Action);
            } else {
                Assert.IsType<ConflictObjectResult>(result); Assert.Equal("private", stored.Visibility);
                Assert.Empty(revision.PrivateSourceConfirmations);
            }
        } finally { if (Directory.Exists(storageRoot)) Directory.Delete(storageRoot, true); }
    }

    [Theory]
    [InlineData("resume")]
    [InlineData("skip-last")]
    [InlineData("confirm")]
    public async Task WritingCommandCreatesPaidPermitOnlyForActualContinuationAndPersistsItOnNewRun(string operation)
    {
        await using var f = new Fixture();
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["Deployment:Identity"] = "independent-writing-test" }).Build();
        var admission = new TaskAdmissionService(f.Governance, config);
        using var services = new ServiceCollection().AddSingleton(admission).BuildServiceProvider();
        var state = new WritingDocumentState { Stage = operation == "confirm" ? "confirm" : "generating", Revision = 1,
            ActiveRunId = "old-run", Title = "写作准入验收", AuthorId = "owner", ReviewerId = "owner",
            Sources = new() { new() { Id = "S1", EntryId = "skip", Status = "pending" } },
            Sections = new() { new() { Id = "section", Paragraphs = new() { new() { Id = "p", Text = "作者输入", Status = "auth" } } } } };
        if (operation == "resume") state.Sources.Add(new() { Id = "S2", EntryId = "keep", Status = "read", Content = "保留来源", Hash = "snapshot" });
        await f.Db.DocumentStores.InsertOneAsync(new DocumentStore { Id = "store", OwnerId = "owner" });
        await f.Db.DocumentEntries.InsertOneAsync(new DocumentEntry { Id = "writing", StoreId = "store", Writing = state });
        await f.Db.DocumentStoreAgentRuns.InsertOneAsync(new DocumentStoreAgentRun { Id = "old-run", SourceEntryId = "writing", StoreId = "store", UserId = "owner", Kind = WritingDocumentPolicy.RunKind, Status = DocumentStoreRunStatus.Running });
        var teams = new Mock<ITeamService>();
        teams.Setup(t => t.GetMyTeamIdsAsync(It.IsAny<string>(), It.IsAny<CancellationToken>())).ReturnsAsync(new List<string>());
        var controller = new DocumentStoreController(f.Db, null!, null!, Mock.Of<IDocumentService>(), null!, null!, null!, teams.Object,
            null!, null!, null!, null!, null!, null!, null!, null!, config, null!, null!, null!, null!, null!, NullLogger<DocumentStoreController>.Instance);
        var descriptor = new ControllerActionDescriptor { ControllerTypeInfo = typeof(DocumentStoreController).GetTypeInfo(),
            ActionName = nameof(DocumentStoreController.CommandWritingDocument), MethodInfo = typeof(DocumentStoreController).GetMethod(nameof(DocumentStoreController.CommandWritingDocument))! };
        var http = new DefaultHttpContext { RequestServices = services, User = new ClaimsPrincipal(new ClaimsIdentity(new[] {
            new Claim("sub", "owner"), new Claim(ClaimTypes.NameIdentifier, "owner"), new Claim("authType", "jwt"), new Claim("jti", "independent-session") }, "session")) };
        http.SetEndpoint(new Endpoint(_ => Task.CompletedTask, new EndpointMetadataCollection(descriptor), descriptor.ActionName));
        http.Request.Method = "POST"; http.Request.Path = "/api/document-store/entries/writing/writing/commands";
        http.Request.Headers["Idempotency-Key"] = Guid.NewGuid().ToString("N");
        var request = new WritingCommandRequest { Revision = 1, Action = operation == "confirm" ? "confirm" : "skip-source", SourceId = "S1", ParagraphId = "p", Confirmed = true };
        var bytes = JsonSerializer.SerializeToUtf8Bytes(request);
        http.Request.ContentType = "application/json"; http.Request.ContentLength = bytes.Length; http.Request.Body = new MemoryStream(bytes); http.Response.Body = new MemoryStream();
        controller.ControllerContext = new ControllerContext { HttpContext = http };
        IActionResult? response = null;
        await new TaskAdmissionMiddleware(async _ => response = await controller.CommandWritingDocument("writing", request)).InvokeAsync(http, admission);
        Assert.IsType<OkObjectResult>(response);
        var permits = await f.Governance.Database.GetCollection<GatewayTaskPermitRecord>(GatewayTaskPermitRecord.CollectionName).Find(FilterDefinition<GatewayTaskPermitRecord>.Empty).ToListAsync();
        var runs = await f.Db.DocumentStoreAgentRuns.Find(FilterDefinition<DocumentStoreAgentRun>.Empty).ToListAsync();
        if (operation == "resume") {
            var permit = Assert.Single(permits); var next = Assert.Single(runs, r => r.Id != "old-run");
            Assert.Equal(permit.Id, next.TaskPermitId); Assert.Equal("owner", permit.ActorUserId);
            Assert.Equal(new[] { AppCallerRegistry.DocumentStoreAgent.Writing.Generate }, permit.AllowedAppCallerCodes);
            Assert.Equal(TaskExecutionOrigins.Interactive, permit.Origin);
            Assert.Equal(typeof(DocumentStoreController).FullName + ".CommandWritingDocument", permit.SourceTask);
            var persisted = await f.Db.DocumentEntries.Find(e => e.Id == "writing").SingleAsync();
            Assert.Equal(next.Id, persisted.Writing!.ActiveRunId); Assert.Equal("generating", persisted.Writing.Stage);
            Assert.Equal(DocumentStoreRunStatus.Cancelled, runs.Single(r => r.Id == "old-run").Status);
        } else {
            Assert.Empty(permits); Assert.Single(runs);
        }
    }

    private sealed class Fixture : IAsyncDisposable
    {
        private readonly string connection = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION")
            ?? throw new InvalidOperationException("Explicit isolated MONGODB_TEST_CONNECTION required");
        private readonly string name = "independent_map_acceptance_" + Guid.NewGuid().ToString("N");
        public MongoDbContext Db { get; }
        public LlmGatewayDataContext Governance { get; }
        public Fixture() {
            if (!connection.StartsWith("mongodb://127.0.0.1:27197", StringComparison.Ordinal)) throw new InvalidOperationException("Only the isolated local acceptance Mongo is allowed");
            Db = new MongoDbContext(connection, name); Governance = new LlmGatewayDataContext(connection, name);
        }
        public async ValueTask DisposeAsync() => await new MongoClient(connection).DropDatabaseAsync(name);
    }
}

// Pure read-projection tests: no Mongo, model call, publishing or business-data fixture.
public sealed class WritingPublishedContentProjectionTests
{
    [Fact]
    public async Task PublishedContentUsesOnlyFrozenParagraphsAndQuotedSourcesWithoutReadingPrivateOriginals()
    {
        var documents = new Mock<IDocumentService>(MockBehavior.Strict);
        var entry = Entry();
        entry.DocumentId = "private-original-document";
        entry.AttachmentId = "private-original-file";
        var before = JsonSerializer.Serialize(entry.Writing);
        var payload = await Payload(Controller(documents.Object), entry);
        var text = payload.GetProperty("content").GetString()!;
        Assert.Equal(new[] { "entryId", "title", "content", "contentType", "fileUrl", "hasContent" }, payload.EnumerateObject().Select(p => p.Name));
        Assert.Equal("稳定发布标题", payload.GetProperty("title").GetString());
        Assert.Equal("text/markdown", payload.GetProperty("contentType").GetString());
        Assert.True(payload.GetProperty("hasContent").GetBoolean());
        Assert.Equal(JsonValueKind.Null, payload.GetProperty("fileUrl").ValueKind);
        foreach (var paragraph in entry.Writing!.Published!.Sections.SelectMany(s => s.Paragraphs))
            Assert.Contains(paragraph.Text, text, StringComparison.Ordinal);
        Assert.Contains("作者确认补充", text);
        Assert.Contains("S1", text); Assert.Contains("原始归档规范", text);
        Assert.Contains("本版引用摘录", text); Assert.Contains("原始引用句", text);
        Assert.Contains("条件：先取得明确确认", text); Assert.Contains("关键明细", text);
        Assert.Contains("待确认事项", text); Assert.Contains("保留的开放项", text);
        foreach (var hidden in new[] { "未发布下一稿", "未引用私密正文", "被跳过的来源", "private-original", "https://private.example", "不在citations内的引句" })
            Assert.DoesNotContain(hidden, text);
        Assert.Equal(before, JsonSerializer.Serialize(entry.Writing));
        documents.VerifyNoOtherCalls();
    }

    [Fact]
    public async Task SourceMetadataAndQuotesArePlainTextWhileParagraphTextIsUnchanged()
    {
        var entry = Entry();
        var publication = entry.Writing!.Published!;
        publication.Sources[0].Title = "  原始归档``规范`` [链接](https://private.example) <b>标题</b>  ";
        publication.Sections[0].Paragraphs[0].Quotes["S1"] = "原始引用句 ![图](https://private.example/image)\n<script>恶意标记</script>\n   ";
        var before = JsonSerializer.Serialize(publication);
        var payload = await Payload(Controller(new Mock<IDocumentService>(MockBehavior.Strict).Object), entry);
        var text = payload.GetProperty("content").GetString()!;
        Assert.Contains(publication.Sections[0].Paragraphs[0].Text, text);
        Assert.Contains("``` " + publication.Sources[0].Title + " ```", text);
        Assert.Contains("` 原始引用句 ![图](https://private.example/image) `", text);
        Assert.Contains("\n> ` <script>恶意标记</script> `", text);
        Assert.Contains("\n> `   `", text);
        Assert.Equal(before, JsonSerializer.Serialize(publication));
    }

    [Fact]
    public async Task MissingExcerptDoesNotFallBackToSourceFullTextOrInventAuthorOrigin()
    {
        var entry = Entry();
        entry.Writing!.Published!.Sections[0].Paragraphs[0].Quotes.Clear();
        var text = (await Payload(Controller(new Mock<IDocumentService>(MockBehavior.Strict).Object), entry)).GetProperty("content").GetString()!;
        Assert.Contains("本版未保存引用摘录", text);
        Assert.DoesNotContain("未引用私密正文", text);
        Assert.Equal(1, text.Split("作者确认补充").Length - 1);
    }

    [Fact]
    public async Task NonWritingContentKeepsExistingPayloadAndDocumentRead()
    {
        var documents = new Mock<IDocumentService>(MockBehavior.Strict);
        documents.Setup(s => s.GetByIdAsync("plain")).ReturnsAsync(new ParsedPrd { Title = "普通文件标题", RawContent = "普通正文" });
        var payload = await Payload(Controller(documents.Object), new DocumentEntry { Id = "plain-entry", DocumentId = "plain", Title = "条目标题", ContentType = "text/plain" });
        Assert.Equal("plain-entry", payload.GetProperty("entryId").GetString());
        Assert.Equal("普通文件标题", payload.GetProperty("title").GetString());
        Assert.Equal("普通正文", payload.GetProperty("content").GetString());
        Assert.Equal("text/plain", payload.GetProperty("contentType").GetString());
        Assert.Equal(JsonValueKind.Null, payload.GetProperty("fileUrl").ValueKind);
        Assert.True(payload.GetProperty("hasContent").GetBoolean());
        documents.Verify(s => s.GetByIdAsync("plain"), Times.Once); documents.VerifyNoOtherCalls();
    }

    internal static DocumentEntry Entry() => new() { Id = "writing", StoreId = "store", Title = "未发布下一稿条目标题", ContentType = "text/markdown", Writing = new() {
        Stage = "confirm", Revision = 7, Title = "未发布下一稿", Sources = new() { new() { Id = "S1", Content = "未发布下一稿私源" } },
        Sections = new() { new() { Paragraphs = new() { new() { Text = "未发布下一稿" } } } },
        Published = new() { Version = 2, Title = "稳定发布标题", Summary = "稳定摘要", Sources = new() {
            new() { Id = "S1", EntryId = "private-original", Title = "原始归档规范", Content = "原始引用句\n未引用私密正文", Status = "read" },
            new() { Id = "S2", Title = "被跳过的来源", Content = "被跳过的来源正文", Status = "skipped" }
        }, Sections = new() { new() { Id = "s", Title = "数量边界", Condition = "先取得明确确认", Detail = new() { Label = "关键明细", Rows = new() { new() { "每包", "严格少于200" } } }, Paragraphs = new() {
            new() { Id = "p1", Text = "  少于200份可单包。\n数字与空格  不改。", Status = "src", Citations = new() { "S1" }, Quotes = new() { ["S1"] = "原始引用句", ["S2"] = "不在citations内的引句" } },
            new() { Id = "p2", Text = "恰好200份也分包，每包严格少于200份。<作者原文保持>", Status = "auth" }
        } } }, OpenQuestions = new() { new() { Title = "保留的开放项", Answer = "确认后再执行", Status = "open" } } }
    } };

    internal static DocumentStoreController Controller(IDocumentService documents) => new(null!, null!, null!, documents, null!, null!, null!, null!, null!, null!, null!, null!, null!, null!, null!, null!, new ConfigurationBuilder().Build(), null!, null!, null!, null!, null!, NullLogger<DocumentStoreController>.Instance);
    internal static async Task<JsonElement> Payload(DocumentStoreController controller, DocumentEntry entry)
    {
        var method = typeof(DocumentStoreController).GetMethod("BuildEntryContentPayloadAsync", BindingFlags.Instance | BindingFlags.NonPublic)!;
        var payload = await (Task<object>)method.Invoke(controller, new object[] { entry })!;
        return JsonSerializer.SerializeToElement(payload, new JsonSerializerOptions(JsonSerializerDefaults.Web));
    }
}
