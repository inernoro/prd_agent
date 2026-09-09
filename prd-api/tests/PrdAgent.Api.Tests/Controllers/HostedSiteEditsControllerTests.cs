using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Bson;
using MongoDB.Driver;
using Moq;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

public sealed class HostedSiteEditsControllerTests
{
    [Theory]
    [InlineData("model")]
    [InlineData("MODELBASEURL")]
    [InlineData("baseUrl")]
    [InlineData("apiKey")]
    [InlineData("modelApiKey")]
    [InlineData("modelPoolId")]
    [InlineData("modelPolicy")]
    [InlineData("auditOwner")]
    [InlineData("appCallerCode")]
    [InlineData("sourceSystem")]
    [InlineData("authority")]
    public async Task CreateRun_ShouldRejectClientRuntimeAuthorityOverrides(string field)
    {
        var request = JsonSerializer.Deserialize<CreateHostedSiteEditRunRequest>(
            $$"""{"instruction":"调整版式","runtime":"open-design","{{field}}":"attacker-value"}""",
            new JsonSerializerOptions(JsonSerializerDefaults.Web));
        Assert.NotNull(request);

        var sites = new Mock<IHostedSiteService>(MockBehavior.Strict);
        var providers = new Mock<IDesignArtifactProviderCatalog>(MockBehavior.Strict);
        var knowledge = new Mock<IDesignKnowledgeSnapshotResolver>(MockBehavior.Strict);
        var queue = new Mock<IRunQueue>(MockBehavior.Strict);
        var controller = BuildController(
            NewLazyDb(),
            "owner-user",
            sites.Object,
            providers.Object,
            knowledge.Object,
            queue.Object);

        var result = await controller.CreateRun("site-a", request);

        var badRequest = Assert.IsType<BadRequestObjectResult>(result);
        var payload = JsonSerializer.SerializeToElement(
            badRequest.Value,
            new JsonSerializerOptions(JsonSerializerDefaults.Web));
        Assert.Equal(
            DesignArtifactRequestAuthorityGuard.ErrorCode,
            payload.GetProperty("error").GetProperty("code").GetString());
        sites.VerifyNoOtherCalls();
        providers.VerifyNoOtherCalls();
        knowledge.VerifyNoOtherCalls();
        queue.VerifyNoOtherCalls();
    }

    [Fact]
    public void GenerateRequest_ShouldCaptureProtectedRuntimeAuthorityOverrides()
    {
        var request = JsonSerializer.Deserialize<CreateDesignArtifactRunRequest>(
            """{"artifactType":"web-page","instruction":"生成网页","model":"attacker-model","baseUrl":"https://attacker.invalid/v1","auditOwner":"attacker"}""",
            new JsonSerializerOptions(JsonSerializerDefaults.Web));

        Assert.NotNull(request);
        Assert.Equal(
            ["auditOwner", "baseUrl", "model"],
            DesignArtifactRequestAuthorityGuard.FindProtectedOverrides(request.AdditionalProperties?.Keys));
    }

    [Fact]
    public async Task CreateRun_ShouldRejectMultiFileSiteBeforeResolvingKnowledgeOrQueueing()
    {
        var sites = new Mock<IHostedSiteService>(MockBehavior.Strict);
        sites.Setup(service => service.GetEditableEntryHtmlAsync("site-a", "owner-user", CancellationToken.None))
            .ReturnsAsync(BuildEditableEntry("<!doctype html><html><body>safe</body></html>", fileCount: 2));
        var providers = EnabledProvider(DesignArtifactRuntimes.OpenDesign);
        var knowledge = new Mock<IDesignKnowledgeSnapshotResolver>(MockBehavior.Strict);
        var queue = new Mock<IRunQueue>(MockBehavior.Strict);
        var controller = BuildController(
            NewLazyDb(),
            "owner-user",
            sites.Object,
            providers.Object,
            knowledge.Object,
            queue.Object);

        var result = await controller.CreateRun("site-a", new CreateHostedSiteEditRunRequest
        {
            Instruction = "调整版式",
            Runtime = DesignArtifactRuntimes.OpenDesign,
        });

        var badRequest = Assert.IsType<BadRequestObjectResult>(result);
        Assert.Contains("ZIP 或多文件资源", ResponseMessage(badRequest), StringComparison.Ordinal);
        knowledge.VerifyNoOtherCalls();
        queue.VerifyNoOtherCalls();
    }

    [Fact]
    public void ValidateEditInputCompatibility_ShouldAllowMarkdownWrapperWithSourceAsset()
    {
        var editable = BuildEditableEntry(
            "<!doctype html><html><body><h1>原始标题</h1></body></html>",
            fileCount: 2,
            wrappedAssetType: "markdown");

        var normalized = HostedSiteEditsController.ValidateEditInputCompatibility(editable);

        Assert.Contains("原始标题", normalized, StringComparison.Ordinal);
    }

    [Fact]
    public async Task CreateRun_ShouldRejectDynamicCurrentHtmlBeforeQueueing()
    {
        var sites = new Mock<IHostedSiteService>(MockBehavior.Strict);
        sites.Setup(service => service.GetEditableEntryHtmlAsync("site-a", "owner-user", CancellationToken.None))
            .ReturnsAsync(BuildEditableEntry(
                "<!doctype html><html><body><script>fetch('https://evil.example')</script></body></html>"));
        var providers = EnabledProvider(DesignArtifactRuntimes.OpenDesign);
        var knowledge = new Mock<IDesignKnowledgeSnapshotResolver>(MockBehavior.Strict);
        var queue = new Mock<IRunQueue>(MockBehavior.Strict);
        var controller = BuildController(
            NewLazyDb(),
            "owner-user",
            sites.Object,
            providers.Object,
            knowledge.Object,
            queue.Object);

        var result = await controller.CreateRun("site-a", new CreateHostedSiteEditRunRequest
        {
            Instruction = "调整版式",
            Runtime = DesignArtifactRuntimes.OpenDesign,
        });

        var badRequest = Assert.IsType<BadRequestObjectResult>(result);
        Assert.Contains("仅支持声明式、自包含 HTML", ResponseMessage(badRequest), StringComparison.Ordinal);
        knowledge.VerifyNoOtherCalls();
        queue.VerifyNoOtherCalls();
    }

    [Fact]
    public async Task CreateRun_ShouldReturnConflictForStaleKnowledgeBeforePersistingOrQueueing()
    {
        var sites = new Mock<IHostedSiteService>(MockBehavior.Strict);
        sites.Setup(service => service.GetEditableEntryHtmlAsync("site-a", "owner-user", CancellationToken.None))
            .ReturnsAsync(BuildEditableEntry("<!doctype html><html><body>safe</body></html>"));
        var knowledge = new Mock<IDesignKnowledgeSnapshotResolver>(MockBehavior.Strict);
        knowledge.Setup(service => service.ResolveForRunAsync(
                "owner-user",
                It.IsAny<IReadOnlyList<DesignKnowledgeReferenceIdentity>>(),
                CancellationToken.None))
            .ThrowsAsync(new DesignKnowledgeSnapshotException(
                DesignKnowledgeSnapshotResolver.ContentChangedCode,
                "引用内容已变化，请刷新来源后重试"));
        var events = new Mock<IRunEventStore>(MockBehavior.Strict);
        var queue = new Mock<IRunQueue>(MockBehavior.Strict);
        var controller = BuildController(
            NewLazyDb(),
            "owner-user",
            sites.Object,
            EnabledProvider(DesignArtifactRuntimes.OpenDesign).Object,
            knowledge.Object,
            queue.Object,
            events: events.Object);

        var result = await controller.CreateRun("site-a", new CreateHostedSiteEditRunRequest
        {
            Instruction = "调整版式",
            Runtime = DesignArtifactRuntimes.OpenDesign,
            KnowledgeReferences =
            [
                new HostedSiteKnowledgeReference
                {
                    EntryId = "entry-a",
                    StoreId = "store-a",
                    ContentHash = new string('a', 64),
                },
            ],
        });

        var conflict = Assert.IsType<ConflictObjectResult>(result);
        var payload = JsonSerializer.SerializeToElement(conflict.Value, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        Assert.Equal(
            DesignKnowledgeSnapshotResolver.ContentChangedCode,
            payload.GetProperty("error").GetProperty("code").GetString());
        queue.VerifyNoOtherCalls();
        events.VerifyNoOtherCalls();
    }

    [Fact]
    public async Task GenerateRun_ShouldReturnConflictForStaleKnowledgeBeforePersistingOrQueueing()
    {
        var providers = new Mock<IDesignArtifactProviderCatalog>(MockBehavior.Strict);
        providers.Setup(service => service.FindAsync(
                "owner-user",
                DesignArtifactRuntimes.MapGateway,
                CancellationToken.None))
            .ReturnsAsync(new DesignArtifactProviderCapability(
                DesignArtifactRuntimes.MapGateway,
                "MAP",
                DesignArtifactAdapterKinds.InProcess,
                DesignArtifactExecutionOwners.Map,
                DesignArtifactIsolationModes.Process,
                [DesignArtifactTypes.WebPage],
                [DesignArtifactOperations.Generate],
                [DesignArtifactSourceSurfaces.WebHosting, DesignArtifactSourceSurfaces.KnowledgeBase],
                Configured: true,
                Healthy: true,
                Enabled: true,
                Reason: null));
        var knowledge = new Mock<IDesignKnowledgeSnapshotResolver>(MockBehavior.Strict);
        knowledge.Setup(service => service.ResolveForRunAsync(
                "owner-user",
                It.IsAny<IReadOnlyList<DesignKnowledgeReferenceIdentity>>(),
                CancellationToken.None))
            .ThrowsAsync(new DesignKnowledgeSnapshotException(
                DesignKnowledgeSnapshotResolver.ContentChangedCode,
                "引用内容已变化，请刷新来源后重试"));
        var events = new Mock<IRunEventStore>(MockBehavior.Strict);
        var queue = new Mock<IRunQueue>(MockBehavior.Strict);
        var controller = new DesignArtifactsController(
            NewLazyDb(),
            events.Object,
            queue.Object,
            providers.Object,
            knowledge.Object,
            new LlmGatewayDataContext("mongodb://127.0.0.1:27017", $"design_hash_unit_{Guid.NewGuid():N}"),
            Mock.Of<IDesignArtifactCancellationCoordinator>(), new ConfigurationBuilder().Build());
        controller.ControllerContext = new ControllerContext
        {
            HttpContext = new DefaultHttpContext
            {
                User = new ClaimsPrincipal(new ClaimsIdentity([new Claim("sub", "owner-user")], "test")),
            },
        };

        var result = await controller.CreateRun(new CreateDesignArtifactRunRequest
        {
            ArtifactType = DesignArtifactTypes.WebPage,
            SourceSurface = DesignArtifactSourceSurfaces.KnowledgeBase,
            Runtime = DesignArtifactRuntimes.MapGateway,
            Instruction = "生成产品说明网页",
            KnowledgeReferences =
            [
                new DesignKnowledgeReferenceRequest
                {
                    EntryId = "entry-a",
                    StoreId = "store-a",
                    ContentHash = new string('a', 64),
                },
            ],
        });

        var conflict = Assert.IsType<ConflictObjectResult>(result);
        var payload = JsonSerializer.SerializeToElement(conflict.Value, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        Assert.Equal(
            DesignKnowledgeSnapshotResolver.ContentChangedCode,
            payload.GetProperty("error").GetProperty("code").GetString());
        queue.VerifyNoOtherCalls();
        events.VerifyNoOtherCalls();
    }

    [Fact]
    public async Task KnowledgePreflight_ShouldReturnHashMetadataWithoutAuthoritativeContent()
    {
        var knowledge = new Mock<IDesignKnowledgeSnapshotResolver>(MockBehavior.Strict);
        knowledge.Setup(service => service.ResolveAsync(
                "owner-user",
                It.IsAny<IReadOnlyList<DesignKnowledgeReferenceIdentity>>(),
                CancellationToken.None))
            .ReturnsAsync(
            [
                new DesignKnowledgeSnapshot
                {
                    EntryId = "entry-a",
                    StoreId = "store-a",
                    StoreName = "测试知识库",
                    Title = "测试条目",
                    Content = "不得返回的权威正文",
                    ContentHash = new string('a', 64),
                },
            ]);
        var controller = new DesignArtifactsController(
            NewLazyDb(),
            Mock.Of<IRunEventStore>(),
            Mock.Of<IRunQueue>(),
            Mock.Of<IDesignArtifactProviderCatalog>(),
            knowledge.Object,
            new LlmGatewayDataContext("mongodb://127.0.0.1:27017", $"design_preflight_unit_{Guid.NewGuid():N}"),
            Mock.Of<IDesignArtifactCancellationCoordinator>(), new ConfigurationBuilder().Build());
        controller.ControllerContext = new ControllerContext
        {
            HttpContext = new DefaultHttpContext
            {
                User = new ClaimsPrincipal(new ClaimsIdentity([new Claim("sub", "owner-user")], "test")),
            },
        };

        var result = await controller.ResolveKnowledgeReferences(new ResolveDesignKnowledgeReferencesRequest
        {
            KnowledgeReferences =
            [
                new DesignKnowledgeReferenceRequest { EntryId = "entry-a", StoreId = "store-a" },
            ],
        });

        var ok = Assert.IsType<OkObjectResult>(result);
        var payload = JsonSerializer.SerializeToElement(ok.Value, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        var item = payload.GetProperty("data").GetProperty("items")[0];
        Assert.Equal(new string('a', 64), item.GetProperty("contentHash").GetString());
        Assert.False(item.TryGetProperty("content", out _));
        Assert.DoesNotContain("不得返回的权威正文", payload.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task CreateRun_ShouldRejectSerializedRemotePackageOverOneMegabyteBeforeQueueing()
    {
        var sites = new Mock<IHostedSiteService>(MockBehavior.Strict);
        sites.Setup(service => service.GetEditableEntryHtmlAsync("site-a", "owner-user", CancellationToken.None))
            .ReturnsAsync(BuildEditableEntry(
                $"<!doctype html><html><body>{new string('a', 800_000)}</body></html>"));
        var providers = EnabledProvider(DesignArtifactRuntimes.Codex);
        var knowledge = new Mock<IDesignKnowledgeSnapshotResolver>(MockBehavior.Strict);
        knowledge.Setup(service => service.ResolveForRunAsync(
                "owner-user",
                It.IsAny<IReadOnlyList<DesignKnowledgeReferenceIdentity>>(),
                CancellationToken.None))
            .ReturnsAsync(Array.Empty<DesignKnowledgeSnapshot>());
        var queue = new Mock<IRunQueue>(MockBehavior.Strict);
        var controller = BuildController(
            NewLazyDb(),
            "owner-user",
            sites.Object,
            providers.Object,
            knowledge.Object,
            queue.Object);

        var result = await controller.CreateRun("site-a", new CreateHostedSiteEditRunRequest
        {
            Instruction = "调整版式",
            Runtime = DesignArtifactRuntimes.Codex,
        });

        var badRequest = Assert.IsType<BadRequestObjectResult>(result);
        Assert.Contains("打包后超过远程工作区 1MB 上限", ResponseMessage(badRequest), StringComparison.Ordinal);
        queue.VerifyNoOtherCalls();
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task GetRun_ShouldRequireMatchingOwnerAndSite()
    {
        await using var fixture = await HostedSiteEditMongoFixture.CreateAsync();
        var run = new DesignArtifactRun
        {
            UserId = "owner-user",
            TargetSiteId = "site-a",
            Operation = DesignArtifactOperations.Edit,
            Status = RunStatuses.Running,
            Progress = 42,
            Phase = "正在生成修改草稿",
        };
        await fixture.Db.DesignArtifactRuns.InsertOneAsync(run);

        var ownerResult = await BuildController(fixture.Db, "owner-user").GetRun("site-a", run.Id);
        var ok = Assert.IsType<OkObjectResult>(ownerResult);
        var payload = JsonSerializer.SerializeToElement(ok.Value, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        Assert.Equal(run.Id, payload.GetProperty("data").GetProperty("runId").GetString());
        Assert.Equal(42, payload.GetProperty("data").GetProperty("progress").GetInt32());

        var wrongSite = await BuildController(fixture.Db, "owner-user").GetRun("site-b", run.Id);
        Assert.IsType<NotFoundObjectResult>(wrongSite);

        var wrongUser = await BuildController(fixture.Db, "other-user").GetRun("site-a", run.Id);
        Assert.IsType<NotFoundObjectResult>(wrongUser);
    }

    [Theory]
    [InlineData(null, "网页修改")]
    [InlineData("", "网页修改")]
    [InlineData("   ", "网页修改")]
    [InlineData("  测试站点  ", "测试站点")]
    [Trait("Category", TestCategories.Integration)]
    public async Task CreateRun_ShouldPersistProviderConnectionAndNormalizedSiteTitle(
        string? siteTitle,
        string expectedTitle)
    {
        await using var fixture = await HostedSiteEditMongoFixture.CreateAsync();
        var sites = new Mock<IHostedSiteService>();
        sites.Setup(service => service.GetEditableEntryHtmlAsync("site-a", "owner-user", CancellationToken.None))
            .ReturnsAsync(BuildEditableEntry(
                "<!doctype html><html><body>safe</body></html>",
                siteTitle: siteTitle));
        var knowledge = new Mock<IDesignKnowledgeSnapshotResolver>();
        knowledge.Setup(service => service.ResolveForRunAsync(
                "owner-user",
                It.IsAny<IReadOnlyList<DesignKnowledgeReferenceIdentity>>(),
                CancellationToken.None))
            .ReturnsAsync(Array.Empty<DesignKnowledgeSnapshot>());
        var queue = new Mock<IRunQueue>();
        var policyConfiguration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        { ["DesignArtifactRuntime:Model"] = "server-edit-model", ["DesignArtifactRuntime:RequestPolicy:TopP"] = "0.92" }).Build();
        var controller = BuildController(
            fixture.Db,
            "owner-user",
            sites.Object,
            EnabledProvider(DesignArtifactRuntimes.OpenDesign).Object,
            knowledge.Object,
            queue.Object,
            configuration: policyConfiguration);

        var result = await controller.CreateRun("site-a", new CreateHostedSiteEditRunRequest
        {
            Instruction = "调整版式",
            Runtime = DesignArtifactRuntimes.OpenDesign,
            AdditionalProperties = new Dictionary<string, JsonElement>
            { ["llmRequestPolicy"] = JsonSerializer.SerializeToElement(new { model = "client-model", topP = 0.1 }) },
        });

        Assert.IsType<AcceptedResult>(result);
        var persisted = await fixture.Db.DesignArtifactRuns.Find(_ => true).SingleAsync();
        Assert.Equal("connection-1", persisted.RuntimeConnectionId);
        Assert.Equal(expectedTitle, persisted.Title);
        policyConfiguration["DesignArtifactRuntime:Model"] = "later-model";
        var reloaded = await fixture.Db.DesignArtifactRuns.Find(item => item.Id == persisted.Id).SingleAsync();
        Assert.Equal("server-edit-model", reloaded.LlmRequestPolicy!.Model);
        Assert.Equal(0.92, reloaded.LlmRequestPolicy.TopP);
        queue.Verify(service => service.EnqueueAsync(RunKinds.DesignArtifact, persisted.Id, CancellationToken.None), Times.Once);
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task CreateRun_ShouldReturnDurableRunWhenRedisAndImmediateQueueAreUnavailable()
    {
        await using var fixture = await HostedSiteEditMongoFixture.CreateAsync();
        var sites = new Mock<IHostedSiteService>();
        sites.Setup(service => service.GetEditableEntryHtmlAsync("site-a", "owner-user", CancellationToken.None))
            .ReturnsAsync(BuildEditableEntry("<!doctype html><html><body>safe</body></html>"));
        var knowledge = new Mock<IDesignKnowledgeSnapshotResolver>();
        knowledge.Setup(service => service.ResolveForRunAsync(
                "owner-user",
                It.IsAny<IReadOnlyList<DesignKnowledgeReferenceIdentity>>(),
                CancellationToken.None))
            .ReturnsAsync(Array.Empty<DesignKnowledgeSnapshot>());
        var events = new Mock<IRunEventStore>();
        events.Setup(store => store.SetRunAsync(
                It.IsAny<string>(),
                It.IsAny<RunMeta>(),
                It.IsAny<TimeSpan?>(),
                It.IsAny<CancellationToken>()))
            .ThrowsAsync(new InvalidOperationException("redis unavailable"));
        var queue = new Mock<IRunQueue>();
        queue.Setup(service => service.EnqueueAsync(
                RunKinds.DesignArtifact,
                It.IsAny<string>(),
                CancellationToken.None))
            .ThrowsAsync(new InvalidOperationException("queue unavailable"));
        var controller = BuildController(
            fixture.Db,
            "owner-user",
            sites.Object,
            EnabledProvider(DesignArtifactRuntimes.OpenDesign).Object,
            knowledge.Object,
            queue.Object,
            events: events.Object);

        var result = await controller.CreateRun("site-a", new CreateHostedSiteEditRunRequest
        {
            Instruction = "调整版式",
            Runtime = DesignArtifactRuntimes.OpenDesign,
        });

        Assert.IsType<AcceptedResult>(result);
        var persisted = await fixture.Db.DesignArtifactRuns.Find(_ => true).SingleAsync();
        Assert.Equal(RunStatuses.Queued, persisted.Status);
        Assert.Null(persisted.RecoveryEnqueuedAt);
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task StreamRun_ShouldReturnTerminalDraftFromMongoWhenRedisIsUnavailable()
    {
        await using var fixture = await HostedSiteEditMongoFixture.CreateAsync();
        var run = new DesignArtifactRun
        {
            Id = "run-mongo-stream-fallback",
            UserId = "owner-user",
            Status = RunStatuses.Done,
            ArtifactType = DesignArtifactTypes.WebPage,
            Operation = DesignArtifactOperations.Edit,
            SourceSurface = DesignArtifactSourceSurfaces.WebHosting,
            TargetSiteId = "site-a",
            Runtime = DesignArtifactRuntimes.OpenDesign,
            Progress = 100,
            Phase = "草稿已生成",
            ProducedArtifactSiteId = "site-a",
            ProducedArtifactRevisionId = "revision-draft",
        };
        await fixture.Db.DesignArtifactRuns.InsertOneAsync(run);
        var events = new Mock<IRunEventStore>();
        events.Setup(store => store.GetEventsAsync(
                RunKinds.DesignArtifact,
                run.Id,
                It.IsAny<long>(),
                It.IsAny<int>(),
                It.IsAny<CancellationToken>()))
            .ThrowsAsync(new InvalidOperationException("redis unavailable"));
        var controller = BuildController(fixture.Db, "owner-user", events: events.Object);
        controller.Response.Body = new MemoryStream();

        await controller.StreamRun("site-a", run.Id, ct: CancellationToken.None);

        controller.Response.Body.Position = 0;
        var stream = await new StreamReader(controller.Response.Body).ReadToEndAsync();
        Assert.Contains("event: phase", stream, StringComparison.Ordinal);
        Assert.Contains("event: done", stream, StringComparison.Ordinal);
        Assert.Contains("revision-draft", stream, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ListRevisions_ShouldReadMarkdownWrapperBaselineAndExposeRollbackTargetSeparatelyFromParentRevision()
    {
        var contentVersion = DateTime.UtcNow;
        var rollback = new HostedSiteRevision
        {
            Id = "revision-rollback",
            SiteId = "site-a",
            CreatedByUserId = "owner-user",
            Status = HostedSiteRevisionStatuses.Published,
            Source = HostedSiteRevisionSources.Rollback,
            ParentRevisionId = "revision-current-before-rollback",
            RollbackTargetRevisionId = "revision-selected-history",
            Html = "<!doctype html><html><body>restored</body></html>",
            BasedOnContentVersion = DateTime.UtcNow.AddMinutes(-1),
            PublishedContentVersion = contentVersion,
        };
        var markdownEntry = BuildEditableEntry(rollback.Html, wrappedAssetType: "markdown", contentVersion: contentVersion);
        var revisions = new Mock<IHostedSiteRevisionService>(MockBehavior.Strict);
        revisions.Setup(service => service.EnsureCurrentSnapshotAsync(
                "site-a", "owner-user", markdownEntry, CancellationToken.None))
            .ReturnsAsync(rollback);
        revisions.Setup(service => service.ListAsync("site-a", "owner-user", CancellationToken.None))
            .ReturnsAsync([rollback]);
        var sites = new Mock<IHostedSiteService>(MockBehavior.Strict);
        sites.Setup(service => service.GetRevisionEntryHtmlAsync("site-a", "owner-user", CancellationToken.None))
            .ReturnsAsync(markdownEntry);
        var controller = BuildController(
            NewLazyDb(),
            "owner-user",
            sites: sites.Object,
            revisions: revisions.Object);

        var result = await controller.ListRevisions("site-a");

        var ok = Assert.IsType<OkObjectResult>(result);
        var payload = JsonSerializer.SerializeToElement(ok.Value, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        var item = payload.GetProperty("data")[0];
        Assert.Equal("revision-current-before-rollback", item.GetProperty("parentRevisionId").GetString());
        Assert.Equal("revision-selected-history", item.GetProperty("rollbackTargetRevisionId").GetString());
        Assert.True(item.GetProperty("isCurrent").GetBoolean());
        sites.Verify(service => service.GetEditableEntryHtmlAsync(
            It.IsAny<string>(), It.IsAny<string>(), It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task ListRevisions_WhenCurrentEntryCannotBeRead_ShouldReturnStableHistoryUnavailableWithoutCreatingBaseline()
    {
        var sites = new Mock<IHostedSiteService>(MockBehavior.Strict);
        sites.Setup(service => service.GetRevisionEntryHtmlAsync(
                "site-a", "owner-user", CancellationToken.None))
            .ThrowsAsync(new InvalidOperationException("storage-specific detail must not escape"));
        var revisions = new Mock<IHostedSiteRevisionService>(MockBehavior.Strict);
        var controller = BuildController(
            NewLazyDb(),
            "owner-user",
            sites: sites.Object,
            revisions: revisions.Object);

        var result = await controller.ListRevisions("site-a");

        var badRequest = Assert.IsType<BadRequestObjectResult>(result);
        var payload = JsonSerializer.SerializeToElement(
            badRequest.Value,
            new JsonSerializerOptions(JsonSerializerDefaults.Web));
        Assert.Equal(
            ErrorCodes.HOSTED_SITE_HISTORY_UNAVAILABLE,
            payload.GetProperty("error").GetProperty("code").GetString());
        Assert.Equal(
            "版本记录暂时不可用，请检查网页文件后重试",
            payload.GetProperty("error").GetProperty("message").GetString());
        revisions.Verify(service => service.EnsureCurrentSnapshotAsync(
            It.IsAny<string>(),
            It.IsAny<string>(),
            It.IsAny<HostedSiteEditableEntry?>(),
            It.IsAny<CancellationToken>()), Times.Never);
        revisions.Verify(service => service.ListAsync(
            It.IsAny<string>(), It.IsAny<string>(), It.IsAny<CancellationToken>()), Times.Never);
        sites.VerifyAll();
        revisions.VerifyNoOtherCalls();
    }

    [Theory]
    [InlineData(null, true)]
    [InlineData("", true)]
    [InlineData("markdown", true)]
    [InlineData("MARKDOWN", true)]
    [InlineData("pdf", false)]
    [InlineData("video", false)]
    public void RevisionReadableWrapperPolicy_ShouldOnlyAllowSelfContainedMarkdown(
        string? wrappedAssetType,
        bool expected)
    {
        Assert.Equal(expected, HostedSiteService.IsRevisionReadableWrapper(wrappedAssetType));
    }

    [Fact]
    public async Task RejectRevision_ShouldCallDomainServiceAndExposeRejectionAuditFields()
    {
        var rejectedAt = DateTime.UtcNow;
        var revision = new HostedSiteRevision
        {
            Id = "revision-draft",
            SiteId = "site-a",
            Status = HostedSiteRevisionStatuses.Rejected,
            CreatedByUserId = "owner-user",
            RejectedAt = rejectedAt,
            RejectedByUserId = "owner-user",
            RejectionReason = "版式不符合要求",
        };
        var revisions = new Mock<IHostedSiteRevisionService>(MockBehavior.Strict);
        revisions.Setup(service => service.RejectAsync(
                "site-a",
                revision.Id,
                "owner-user",
                "版式不符合要求",
                CancellationToken.None))
            .ReturnsAsync((revision, true));
        var controller = BuildController(NewLazyDb(), "owner-user", revisions: revisions.Object);

        var result = await controller.RejectRevision(
            "site-a",
            revision.Id,
            new RejectHostedSiteRevisionRequest { Reason = " 版式不符合要求\n" });

        var ok = Assert.IsType<OkObjectResult>(result);
        var payload = JsonSerializer.SerializeToElement(ok.Value, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        Assert.True(payload.GetProperty("data").GetProperty("changed").GetBoolean());
        var item = payload.GetProperty("data").GetProperty("revision");
        Assert.Equal(HostedSiteRevisionStatuses.Rejected, item.GetProperty("status").GetString());
        Assert.Equal("owner-user", item.GetProperty("rejectedByUserId").GetString());
        Assert.Equal("版式不符合要求", item.GetProperty("rejectionReason").GetString());
        Assert.Equal(rejectedAt, item.GetProperty("rejectedAt").GetDateTime());
        Assert.False(controller.HttpContext.Items.ContainsKey(
            PrdAgent.Api.Filters.ActivityLogActionFilter.SuppressItemKey));
        revisions.VerifyAll();
    }

    [Fact]
    public async Task RejectRevision_WhenAlreadyRejected_ShouldSuppressDuplicateHttpActivity()
    {
        var revision = new HostedSiteRevision
        {
            Id = "revision-rejected",
            SiteId = "site-a",
            Status = HostedSiteRevisionStatuses.Rejected,
            CreatedByUserId = "owner-user",
            RejectedAt = DateTime.UtcNow,
            RejectedByUserId = "owner-user",
        };
        var revisions = new Mock<IHostedSiteRevisionService>(MockBehavior.Strict);
        revisions.Setup(service => service.RejectAsync(
                "site-a",
                revision.Id,
                "owner-user",
                null,
                CancellationToken.None))
            .ReturnsAsync((revision, false));
        var controller = BuildController(NewLazyDb(), "owner-user", revisions: revisions.Object);

        var result = await controller.RejectRevision("site-a", revision.Id, new RejectHostedSiteRevisionRequest());

        var ok = Assert.IsType<OkObjectResult>(result);
        var payload = JsonSerializer.SerializeToElement(ok.Value, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        Assert.False(payload.GetProperty("data").GetProperty("changed").GetBoolean());
        Assert.True(controller.HttpContext.Items.ContainsKey(
            PrdAgent.Api.Filters.ActivityLogActionFilter.SuppressItemKey));
        revisions.VerifyAll();
    }

    [Fact]
    public async Task RejectRevision_ShouldMapInvalidReasonAndStateConflictWithoutFalseSuccess()
    {
        var revisions = new Mock<IHostedSiteRevisionService>(MockBehavior.Strict);
        var controller = BuildController(NewLazyDb(), "owner-user", revisions: revisions.Object);

        var invalid = await controller.RejectRevision(
            "site-a",
            "revision-draft",
            new RejectHostedSiteRevisionRequest
            {
                Reason = new string('a', HostedSiteRevisionRules.MaxRejectionReasonLength + 1),
            });

        var badRequest = Assert.IsType<BadRequestObjectResult>(invalid);
        Assert.Contains("不能超过", ResponseMessage(badRequest), StringComparison.Ordinal);
        revisions.VerifyNoOtherCalls();

        revisions.Setup(service => service.RejectAsync(
                "site-a",
                "revision-published",
                "owner-user",
                null,
                CancellationToken.None))
            .ThrowsAsync(new InvalidOperationException("只有草稿可以拒绝"));
        var conflict = await controller.RejectRevision(
            "site-a",
            "revision-published",
            new RejectHostedSiteRevisionRequest());

        var conflictResult = Assert.IsType<ConflictObjectResult>(conflict);
        var payload = JsonSerializer.SerializeToElement(
            conflictResult.Value,
            new JsonSerializerOptions(JsonSerializerDefaults.Web));
        Assert.Equal("REVISION_CONFLICT", payload.GetProperty("error").GetProperty("code").GetString());
        Assert.False(controller.HttpContext.Items.ContainsKey(
            PrdAgent.Api.Filters.ActivityLogActionFilter.SuppressItemKey));
        revisions.VerifyAll();
    }

    [Fact]
    public async Task RejectRevision_WhenRevisionOrSiteIsMissing_ShouldReturnNotFound()
    {
        var revisions = new Mock<IHostedSiteRevisionService>(MockBehavior.Strict);
        revisions.Setup(service => service.RejectAsync(
                "site-a",
                "revision-missing",
                "owner-user",
                null,
                CancellationToken.None))
            .ThrowsAsync(new KeyNotFoundException("版本不存在"));
        var controller = BuildController(NewLazyDb(), "owner-user", revisions: revisions.Object);

        var result = await controller.RejectRevision(
            "site-a",
            "revision-missing",
            new RejectHostedSiteRevisionRequest());

        var notFound = Assert.IsType<NotFoundObjectResult>(result);
        var payload = JsonSerializer.SerializeToElement(
            notFound.Value,
            new JsonSerializerOptions(JsonSerializerDefaults.Web));
        Assert.Equal(ErrorCodes.NOT_FOUND, payload.GetProperty("error").GetProperty("code").GetString());
        Assert.False(controller.HttpContext.Items.ContainsKey(
            PrdAgent.Api.Filters.ActivityLogActionFilter.SuppressItemKey));
        revisions.VerifyAll();
    }

    [Fact]
    public async Task PublishRevision_WhenAlreadyCurrent_ShouldSuppressDuplicateHttpActivity()
    {
        var site = BuildEditableEntry("<!doctype html><html>current</html>").Site;
        var revision = new HostedSiteRevision
        {
            Id = "revision-current",
            SiteId = site.Id,
            Status = HostedSiteRevisionStatuses.Published,
            PublishedContentVersion = site.ContentVersion,
        };
        var revisions = new Mock<IHostedSiteRevisionService>(MockBehavior.Strict);
        revisions.Setup(service => service.PublishAsync(
                site.Id, revision.Id, "owner-user", CancellationToken.None))
            .ReturnsAsync(new HostedSiteRevisionMutationResult(revision, site, false));
        var controller = BuildController(NewLazyDb(), "owner-user", revisions: revisions.Object);

        var result = await controller.PublishRevision(site.Id, revision.Id);

        Assert.IsType<OkObjectResult>(result);
        Assert.True(controller.HttpContext.Items.ContainsKey(
            PrdAgent.Api.Filters.ActivityLogActionFilter.SuppressItemKey));
        revisions.VerifyAll();
    }

    [Fact]
    public async Task RollbackRevision_ShouldRequireAndForwardIdempotencyKey()
    {
        var revisions = new Mock<IHostedSiteRevisionService>(MockBehavior.Strict);
        var controller = BuildController(NewLazyDb(), "owner-user", revisions: revisions.Object);

        var missing = await controller.RollbackRevision("site-a", "revision-old", null);
        var badRequest = Assert.IsType<BadRequestObjectResult>(missing);
        var missingPayload = JsonSerializer.SerializeToElement(
            badRequest.Value,
            new JsonSerializerOptions(JsonSerializerDefaults.Web));
        Assert.Equal("IDEMPOTENCY_KEY_REQUIRED", missingPayload.GetProperty("error").GetProperty("code").GetString());
        revisions.VerifyNoOtherCalls();

        var site = BuildEditableEntry("<!doctype html><html>restored</html>").Site;
        var revision = new HostedSiteRevision { Id = "rollback-copy", SiteId = site.Id };
        revisions.Setup(service => service.RollbackAsync(
                "site-a", "revision-old", "owner-user", "stable-request-key", CancellationToken.None))
            .ReturnsAsync(new HostedSiteRevisionMutationResult(revision, site, true));

        var accepted = await controller.RollbackRevision("site-a", "revision-old", "stable-request-key");

        Assert.IsType<OkObjectResult>(accepted);
        revisions.VerifyAll();
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task CancelRun_MapQueued_ShouldImmediatelyBecomeCancelledAndNeverCreateArtifact()
    {
        await using var fixture = await HostedSiteEditMongoFixture.CreateAsync();
        var run = CancellableEditRun("map-queued", DesignArtifactRuntimes.MapGateway, RunStatuses.Queued);
        await fixture.Db.DesignArtifactRuns.InsertOneAsync(run);
        var events = new InMemoryRunEventStore();
        var controller = BuildController(fixture.Db, run.UserId, events: events);

        var result = await controller.CancelRun(run.TargetSiteId!, run.Id);

        Assert.IsType<OkObjectResult>(result);
        var persisted = await fixture.Db.DesignArtifactRuns.Find(item => item.Id == run.Id).SingleAsync();
        Assert.Equal(RunStatuses.Cancelled, persisted.Status);
        Assert.NotNull(persisted.CancelRequestedAt);
        Assert.NotNull(persisted.CancelledAt);
        Assert.Null(persisted.ArtifactSiteId);
        Assert.Null(persisted.ArtifactRevisionId);
        Assert.Null(persisted.ProducedArtifactSiteId);
        Assert.Null(persisted.ProducedArtifactRevisionId);
        var records = await events.GetEventsAsync(RunKinds.DesignArtifact, run.Id, 0, 10);
        Assert.Contains(records, item => item.EventName == "cancelled");
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task CancelRun_MapRunning_ShouldOnlyRequestCancellationUntilWorkerOwnsTerminal()
    {
        await using var fixture = await HostedSiteEditMongoFixture.CreateAsync();
        var run = CancellableEditRun("map-running", DesignArtifactRuntimes.MapGateway, RunStatuses.Running);
        run.LeaseOwnerId = "worker-map";
        run.LeaseExpiresAt = DateTime.UtcNow.AddMinutes(2);
        await fixture.Db.DesignArtifactRuns.InsertOneAsync(run);
        var controller = BuildController(fixture.Db, run.UserId, events: new InMemoryRunEventStore());

        Assert.IsType<OkObjectResult>(await controller.CancelRun(run.TargetSiteId!, run.Id));
        Assert.IsType<OkObjectResult>(await controller.CancelRun(run.TargetSiteId!, run.Id));

        var persisted = await fixture.Db.DesignArtifactRuns.Find(item => item.Id == run.Id).SingleAsync();
        Assert.Equal(RunStatuses.Running, persisted.Status);
        Assert.NotNull(persisted.CancelRequestedAt);
        Assert.Equal(run.UserId, persisted.CancelRequestedByUserId);
        Assert.Equal("worker-map", persisted.LeaseOwnerId);
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task CancelRun_OpenDesignV2_ShouldUseNativeAuthoritativeLifecycle()
    {
        await using var fixture = await HostedSiteEditMongoFixture.CreateAsync();
        var run = CancellableEditRun("open-design-queued", DesignArtifactRuntimes.OpenDesign, RunStatuses.Queued);
        run.ContractVersion = DesignArtifactContractVersions.Current;
        run.LifecycleVersion = 1;
        run.LifecycleEventSequence = 1;
        run.WorkspaceRef = new DesignArtifactWorkspaceRef
        {
            WorkspaceId = $"web-page-{run.Id}",
            Kind = DesignArtifactWorkspaceKinds.RemotePackage,
            BaseRevision = "base-revision",
            Adapter = WebPageDesignArtifactLifecycleAdapter.AdapterId,
        };
        run.VersionBoundary = new DesignArtifactVersionBoundary
        {
            BaseArtifactId = run.TargetSiteId,
            BaseVersion = "base-revision",
            BaseContentHash = new string('a', 64),
        };
        run.LifecycleEvents =
        [
            new DesignArtifactEventEnvelope
            {
                RunId = run.Id,
                ArtifactType = run.ArtifactType,
                Sequence = 1,
                Type = DesignArtifactLifecycleEventTypes.Run,
                Phase = run.Phase,
                Progress = run.Progress,
                Authoritative = true,
            },
        ];
        await fixture.Db.DesignArtifactRuns.InsertOneAsync(run);
        var lifecycle = new DesignArtifactLifecycleService(fixture.Db, new InMemoryRunEventStore());
        var controller = BuildController(
            fixture.Db,
            run.UserId,
            events: new InMemoryRunEventStore(),
            lifecycle: lifecycle);

        Assert.IsType<OkObjectResult>(await controller.CancelRun(run.TargetSiteId!, run.Id));

        var persisted = await fixture.Db.DesignArtifactRuns.Find(item => item.Id == run.Id).SingleAsync();
        Assert.Equal(RunStatuses.Cancelled, persisted.Status);
        Assert.Equal(DesignArtifactLifecycleEventTypes.Cancelled, persisted.LifecycleEvents[^1].Type);
        Assert.True(persisted.LifecycleEvents[^1].Authoritative);
        Assert.Null(persisted.LifecycleFailureCode);
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task CancelRun_ShouldHideOtherUsersRunAndRejectCommittingBoundary()
    {
        await using var fixture = await HostedSiteEditMongoFixture.CreateAsync();
        var run = CancellableEditRun("commit-boundary", DesignArtifactRuntimes.MapGateway, RunStatuses.Committing);
        await fixture.Db.DesignArtifactRuns.InsertOneAsync(run);

        var otherUser = BuildController(fixture.Db, "another-user", events: new InMemoryRunEventStore());
        Assert.IsType<NotFoundObjectResult>(await otherUser.CancelRun(run.TargetSiteId!, run.Id));

        var owner = BuildController(fixture.Db, run.UserId, events: new InMemoryRunEventStore());
        Assert.IsType<ConflictObjectResult>(await owner.CancelRun(run.TargetSiteId!, run.Id));
        var unchanged = await fixture.Db.DesignArtifactRuns.Find(item => item.Id == run.Id).SingleAsync();
        Assert.Equal(RunStatuses.Committing, unchanged.Status);
        Assert.Null(unchanged.CancelRequestedAt);
    }

    private static HostedSiteEditsController BuildController(
        MongoDbContext db,
        string userId,
        IHostedSiteService? sites = null,
        IDesignArtifactProviderCatalog? providers = null,
        IDesignKnowledgeSnapshotResolver? knowledgeSnapshots = null,
        IRunQueue? queue = null,
        IHostedSiteRevisionService? revisions = null,
        IRunEventStore? events = null,
        IWebPageDesignArtifactLifecycleAdapter? publicLifecycle = null,
        IDesignArtifactLifecycleService? lifecycle = null,
        IConfiguration? configuration = null)
    {
        var controller = new HostedSiteEditsController(
            sites ?? Mock.Of<IHostedSiteService>(),
            revisions ?? Mock.Of<IHostedSiteRevisionService>(),
            events ?? Mock.Of<IRunEventStore>(),
            queue ?? Mock.Of<IRunQueue>(),
            db,
            NullLogger<HostedSiteEditsController>.Instance,
            providers ?? Mock.Of<IDesignArtifactProviderCatalog>(),
            knowledgeSnapshots ?? Mock.Of<IDesignKnowledgeSnapshotResolver>(),
            publicLifecycle ?? Mock.Of<IWebPageDesignArtifactLifecycleAdapter>(),
            new DesignArtifactCancellationCoordinator(
                db,
                lifecycle ?? Mock.Of<IDesignArtifactLifecycleService>()),
            configuration ?? new ConfigurationBuilder().Build());
        controller.ControllerContext = new ControllerContext
        {
            HttpContext = new DefaultHttpContext
            {
                User = new ClaimsPrincipal(new ClaimsIdentity(new[] { new Claim("sub", userId) }, "test")),
            },
        };
        return controller;
    }

    private static MongoDbContext NewLazyDb() => new(
        "mongodb://127.0.0.1:27017",
        $"hosted_site_edit_unit_{Guid.NewGuid():N}");

    private static Mock<IDesignArtifactProviderCatalog> EnabledProvider(string runtime)
    {
        var provider = new Mock<IDesignArtifactProviderCatalog>(MockBehavior.Strict);
        provider.Setup(service => service.FindAsync("owner-user", runtime, CancellationToken.None))
            .ReturnsAsync(new DesignArtifactProviderCapability(
                runtime,
                runtime,
                DesignArtifactAdapterKinds.RemoteAgent,
                DesignArtifactExecutionOwners.CdsRemoteAgent,
                DesignArtifactIsolationModes.SessionContainer,
                [DesignArtifactTypes.WebPage],
                [DesignArtifactOperations.Edit],
                [DesignArtifactSourceSurfaces.WebHosting],
                Configured: true,
                Healthy: true,
                Enabled: true,
                Reason: null,
                ConnectionId: "connection-1"));
        return provider;
    }

    private static HostedSiteEditableEntry BuildEditableEntry(
        string html,
        int fileCount = 1,
        string? siteTitle = "测试站点",
        string? wrappedAssetType = null,
        DateTime? contentVersion = null)
    {
        var site = new HostedSite
        {
            Id = "site-a",
            OwnerUserId = "owner-user",
            Title = siteTitle ?? string.Empty,
            WrappedAssetType = wrappedAssetType,
            EntryFile = "index.html",
            Files = Enumerable.Range(0, fileCount)
                .Select(index => new HostedSiteFile
                {
                    Path = index == 0 ? "index.html" : $"assets/{index}.css",
                    CosKey = $"site-a/{index}",
                    Size = index == 0 ? System.Text.Encoding.UTF8.GetByteCount(html) : 10,
                    MimeType = index == 0 ? "text/html" : "text/css",
                })
                .ToList(),
        };
        return new HostedSiteEditableEntry(site, html, contentVersion ?? DateTime.UtcNow);
    }

    private static DesignArtifactRun CancellableEditRun(string id, string runtime, string status) => new()
    {
        Id = id,
        UserId = "owner-user",
        Status = status,
        ArtifactType = DesignArtifactTypes.WebPage,
        Operation = DesignArtifactOperations.Edit,
        SourceSurface = DesignArtifactSourceSurfaces.WebHosting,
        Runtime = runtime,
        TargetSiteId = "site-a",
        Instruction = "调整页面标题",
        Progress = status == RunStatuses.Queued ? 2 : 42,
        Phase = status == RunStatuses.Queued ? "修改任务已进入队列" : "页面正在生成",
        CreatedAt = DateTime.UtcNow,
        UpdatedAt = DateTime.UtcNow,
    };

    private static string ResponseMessage(BadRequestObjectResult result)
    {
        var payload = JsonSerializer.SerializeToElement(result.Value, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        return payload.GetProperty("error").GetProperty("message").GetString() ?? string.Empty;
    }

    private sealed class HostedSiteEditMongoFixture : IAsyncDisposable
    {
        private readonly MongoClient _client;
        private readonly string _databaseName;

        private HostedSiteEditMongoFixture(MongoClient client, string connectionString, string databaseName)
        {
            _client = client;
            _databaseName = databaseName;
            Db = new MongoDbContext(connectionString, databaseName);
        }

        internal MongoDbContext Db { get; }

        internal static async Task<HostedSiteEditMongoFixture> CreateAsync()
        {
            var connectionString = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION")
                                   ?? "mongodb://127.0.0.1:27017";
            var settings = MongoClientSettings.FromConnectionString(connectionString);
            settings.ServerSelectionTimeout = TimeSpan.FromSeconds(3);
            var client = new MongoClient(settings);
            await client.GetDatabase("admin").RunCommandAsync<BsonDocument>(new BsonDocument("ping", 1));
            return new HostedSiteEditMongoFixture(
                client,
                connectionString,
                $"hosted_site_edit_test_{Guid.NewGuid():N}");
        }

        public async ValueTask DisposeAsync() => await _client.DropDatabaseAsync(_databaseName);
    }
}
