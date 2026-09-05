using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Bson;
using MongoDB.Driver;
using Moq;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

public sealed class HostedSiteEditsControllerTests
{
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
    public async Task CreateRun_ShouldRejectSerializedRemotePackageOverOneMegabyteBeforeQueueing()
    {
        var sites = new Mock<IHostedSiteService>(MockBehavior.Strict);
        sites.Setup(service => service.GetEditableEntryHtmlAsync("site-a", "owner-user", CancellationToken.None))
            .ReturnsAsync(BuildEditableEntry(
                $"<!doctype html><html><body>{new string('a', 800_000)}</body></html>"));
        var providers = EnabledProvider(DesignArtifactRuntimes.Codex);
        var knowledge = new Mock<IDesignKnowledgeSnapshotResolver>(MockBehavior.Strict);
        knowledge.Setup(service => service.ResolveAsync(
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

    private static HostedSiteEditsController BuildController(
        MongoDbContext db,
        string userId,
        IHostedSiteService? sites = null,
        IDesignArtifactProviderCatalog? providers = null,
        IDesignKnowledgeSnapshotResolver? knowledgeSnapshots = null,
        IRunQueue? queue = null)
    {
        var controller = new HostedSiteEditsController(
            sites ?? Mock.Of<IHostedSiteService>(),
            Mock.Of<IHostedSiteRevisionService>(),
            Mock.Of<IRunEventStore>(),
            queue ?? Mock.Of<IRunQueue>(),
            db,
            NullLogger<HostedSiteEditsController>.Instance,
            providers ?? Mock.Of<IDesignArtifactProviderCatalog>(),
            knowledgeSnapshots ?? Mock.Of<IDesignKnowledgeSnapshotResolver>());
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
                Reason: null));
        return provider;
    }

    private static HostedSiteEditableEntry BuildEditableEntry(string html, int fileCount = 1)
    {
        var site = new HostedSite
        {
            Id = "site-a",
            OwnerUserId = "owner-user",
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
        return new HostedSiteEditableEntry(site, html, DateTime.UtcNow);
    }

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
