using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
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
using LifecycleManifest = PrdAgent.Core.Models.DesignArtifactContractManifest;
using LifecycleManifestFile = PrdAgent.Core.Models.DesignArtifactContractManifestFile;

namespace PrdAgent.Api.Tests.Services;

public sealed class DesignArtifactLifecycleServiceTests
{
    [Fact]
    public void LifecycleServiceAndPublicReadRoutes_ShouldRemainWired()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory != null && !System.IO.File.Exists(Path.Combine(directory.FullName, "prd-api", "src", "PrdAgent.Api", "Program.cs")))
            directory = directory.Parent;
        if (directory == null) throw new InvalidOperationException("找不到仓库根目录");
        var program = System.IO.File.ReadAllText(Path.Combine(directory.FullName, "prd-api", "src", "PrdAgent.Api", "Program.cs"));
        var controller = System.IO.File.ReadAllText(Path.Combine(
            directory.FullName,
            "prd-api",
            "src",
            "PrdAgent.Api",
            "Controllers",
            "Api",
            "DesignArtifactsController.cs"));

        Assert.Contains("AddScoped<PrdAgent.Core.Interfaces.IDesignArtifactLifecycleService", program, StringComparison.Ordinal);
        Assert.Contains("PrdAgent.Infrastructure.Services.DesignArtifactLifecycleService", program, StringComparison.Ordinal);
        Assert.Contains("[HttpGet(\"runs/{runId}/contract\")]", controller, StringComparison.Ordinal);
        Assert.Contains("[HttpGet(\"runs/{runId}/contract/events\")]", controller, StringComparison.Ordinal);
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task WebPageAndHtmlPpt_ShouldShareLifecycleShapeButKeepAdapterAndSecurityBoundaries()
    {
        await using var fixture = await LifecycleMongoFixture.CreateAsync();
        var events = new InMemoryRunEventStore();
        var service = new DesignArtifactLifecycleService(fixture.Db, events);
        var web = await service.CreateSessionAsync(Session(
            "web-run",
            DesignArtifactTypes.WebPage,
            DesignArtifactWorkspaceKinds.RemotePackage,
            "open-design"));
        var ppt = await service.CreateSessionAsync(Session(
            "ppt-run",
            DesignArtifactTypes.HtmlPpt,
            DesignArtifactWorkspaceKinds.AdapterOwned,
            "html-ppt"));

        Assert.Equal(DesignArtifactContractVersions.Current, web.ContractVersion);
        Assert.Equal(web.ContractVersion, ppt.ContractVersion);
        Assert.Equal(web.LifecycleVersion, ppt.LifecycleVersion);
        Assert.NotEqual(web.WorkspaceRef!.Kind, ppt.WorkspaceRef!.Kind);
        Assert.NotEqual(web.WorkspaceRef.Adapter, ppt.WorkspaceRef.Adapter);
        var createFields = typeof(CreateDesignArtifactSessionRequest)
            .GetProperties()
            .Select(property => property.Name)
            .ToArray();
        Assert.DoesNotContain(createFields, field => field.Contains("BaseUrl", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(createFields, field => field.Contains("Model", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(createFields, field => field.Contains("Key", StringComparison.OrdinalIgnoreCase));

        var appended = await Task.WhenAll(Enumerable.Range(0, 12).Select(index =>
            service.AppendEventAsync(new AppendDesignArtifactEventRequest(
                web.Id,
                web.UserId,
                DesignArtifactLifecycleEventTypes.Phase,
                $"阶段 {index}",
                index,
                new Dictionary<string, object?> { ["internal"] = $"delta-{index}" }))));
        Assert.Equal(Enumerable.Range(1, 12).Select(value => (long)value), appended.Select(item => item.Sequence).Order());

        var webCommitted = await service.CommitManifestAsync(new CommitDesignArtifactManifestRequest(
            web.Id,
            web.UserId,
            Expected(web),
            Manifest(DesignArtifactTypes.WebPage, DesignArtifactSecurityProfiles.WebPageRestricted, 'a')));
        var pptCommitted = await service.CommitManifestAsync(new CommitDesignArtifactManifestRequest(
            ppt.Id,
            ppt.UserId,
            Expected(ppt),
            Manifest(DesignArtifactTypes.HtmlPpt, DesignArtifactSecurityProfiles.HtmlPptInteractive, 'b')));

        Assert.Equal(RunStatuses.Committing, webCommitted.Status);
        Assert.Equal(RunStatuses.Committing, pptCommitted.Status);
        Assert.Equal(DesignArtifactSecurityProfiles.WebPageRestricted, webCommitted.Manifest!.SecurityProfile);
        Assert.Equal(DesignArtifactSecurityProfiles.HtmlPptInteractive, pptCommitted.Manifest!.SecurityProfile);
        Assert.Equal(new string('a', 64), webCommitted.VersionBoundary!.OutputContentHash);
        Assert.Equal(new string('b', 64), pptCommitted.VersionBoundary!.OutputContentHash);
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task Manifest_ShouldRejectUnsafePathsDuplicatesBadHashesMissingEntryAndFileOverflow()
    {
        await using var fixture = await LifecycleMongoFixture.CreateAsync();
        var service = new DesignArtifactLifecycleService(fixture.Db, new InMemoryRunEventStore());
        var invalidManifests = new List<LifecycleManifest>
        {
            Manifest(DesignArtifactTypes.WebPage, DesignArtifactSecurityProfiles.WebPageRestricted, 'a', "/index.html"),
            Manifest(DesignArtifactTypes.WebPage, DesignArtifactSecurityProfiles.WebPageRestricted, 'a', "../index.html"),
            new()
            {
                SchemaVersion = DesignArtifactContractVersions.ManifestV1,
                ArtifactType = DesignArtifactTypes.WebPage,
                EntryFile = "index.html",
                SecurityProfile = DesignArtifactSecurityProfiles.WebPageRestricted,
                Files =
                [
                    File("index.html", 'a'),
                    File("index.html", 'b'),
                ],
            },
            new()
            {
                SchemaVersion = DesignArtifactContractVersions.ManifestV1,
                ArtifactType = DesignArtifactTypes.WebPage,
                EntryFile = "index.html",
                SecurityProfile = DesignArtifactSecurityProfiles.WebPageRestricted,
                Files = [new LifecycleManifestFile { Path = "index.html", ByteLength = 1, Sha256 = "bad" }],
            },
            new()
            {
                SchemaVersion = DesignArtifactContractVersions.ManifestV1,
                ArtifactType = DesignArtifactTypes.WebPage,
                EntryFile = "index.html",
                SecurityProfile = DesignArtifactSecurityProfiles.WebPageRestricted,
                Files = [File("other.html", 'a')],
            },
            new()
            {
                SchemaVersion = DesignArtifactContractVersions.ManifestV1,
                ArtifactType = DesignArtifactTypes.WebPage,
                EntryFile = "index.html",
                SecurityProfile = DesignArtifactSecurityProfiles.WebPageRestricted,
                Files = Enumerable.Range(0, 257).Select(index => File($"file-{index}.html", 'a')).ToList(),
            },
            Manifest(DesignArtifactTypes.WebPage, DesignArtifactSecurityProfiles.HtmlPptInteractive, 'a'),
        };

        for (var index = 0; index < invalidManifests.Count; index++)
        {
            var run = await service.CreateSessionAsync(Session(
                $"invalid-{index}",
                DesignArtifactTypes.WebPage,
                DesignArtifactWorkspaceKinds.RemotePackage,
                "open-design"));
            var error = await Assert.ThrowsAsync<DesignArtifactLifecycleException>(() =>
                service.CommitManifestAsync(new CommitDesignArtifactManifestRequest(
                    run.Id,
                    run.UserId,
                    Expected(run),
                    invalidManifests[index])));
            Assert.Equal(DesignArtifactLifecycleErrorCodes.InvalidContract, error.Code);
            var persisted = await fixture.Db.DesignArtifactRuns.Find(item => item.Id == run.Id).SingleAsync();
            Assert.Equal(RunStatuses.Running, persisted.Status);
            Assert.Equal(1, persisted.LifecycleVersion);
            Assert.Null(persisted.Manifest);
        }
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task LifecycleMutations_ShouldUseCasAndRejectStaleVersionBoundary()
    {
        await using var fixture = await LifecycleMongoFixture.CreateAsync();
        var service = new DesignArtifactLifecycleService(fixture.Db, new InMemoryRunEventStore());
        var run = await service.CreateSessionAsync(Session(
            "cas-run",
            DesignArtifactTypes.WebPage,
            DesignArtifactWorkspaceKinds.RemotePackage,
            "open-design"));
        var commitRequest = new CommitDesignArtifactManifestRequest(
            run.Id,
            run.UserId,
            Expected(run),
            Manifest(DesignArtifactTypes.WebPage, DesignArtifactSecurityProfiles.WebPageRestricted, 'a'));

        var attempts = await Task.WhenAll(Enumerable.Range(0, 8).Select(async _ =>
        {
            try
            {
                await service.CommitManifestAsync(commitRequest);
                return true;
            }
            catch (DesignArtifactLifecycleException ex) when (ex.Code == DesignArtifactLifecycleErrorCodes.Conflict)
            {
                return false;
            }
        }));
        Assert.Single(attempts, value => value);

        var committed = await fixture.Db.DesignArtifactRuns.Find(item => item.Id == run.Id).SingleAsync();
        Assert.Equal(2, committed.LifecycleVersion);
        await AssertConflict(() => service.CompleteAsync(new DesignArtifactLifecycleMutationRequest(
            committed.Id,
            committed.UserId,
            new DesignArtifactLifecycleExpectation(2, "older-revision", committed.VersionBoundary!.BaseContentHash))));

        var completed = await service.CompleteAsync(new DesignArtifactLifecycleMutationRequest(
            committed.Id,
            committed.UserId,
            Expected(committed)));
        Assert.Equal(RunStatuses.Done, completed.Status);
        Assert.Equal(3, completed.LifecycleVersion);
        await AssertConflict(() => service.BindPublishedArtifactAsync(new BindPublishedDesignArtifactRequest(
            completed.Id,
            completed.UserId,
            new DesignArtifactLifecycleExpectation(2, "base-revision", new string('c', 64)),
            "site-old",
            "version-old")));

        var bound = await service.BindPublishedArtifactAsync(new BindPublishedDesignArtifactRequest(
            completed.Id,
            completed.UserId,
            Expected(completed),
            "site-current",
            "version-current"));
        Assert.Equal("site-current", bound.ArtifactSiteId);
        Assert.Equal("version-current", bound.ArtifactRevisionId);
        Assert.Equal(4, bound.LifecycleVersion);
        var replayedBinding = await service.BindPublishedArtifactAsync(new BindPublishedDesignArtifactRequest(
            bound.Id,
            bound.UserId,
            Expected(bound),
            "site-current",
            "version-current"));
        Assert.Equal(4, replayedBinding.LifecycleVersion);
        await AssertConflict(() => service.BindPublishedArtifactAsync(new BindPublishedDesignArtifactRequest(
            bound.Id,
            bound.UserId,
            Expected(bound),
            "site-other",
            "version-other")));

        var uncommittedGenerate = await service.CreateSessionAsync(Session(
            "uncommitted-generate",
            DesignArtifactTypes.WebPage,
            DesignArtifactWorkspaceKinds.RemotePackage,
            "open-design"));
        await AssertConflict(() => service.CompleteAsync(new DesignArtifactLifecycleMutationRequest(
            uncommittedGenerate.Id,
            uncommittedGenerate.UserId,
            Expected(uncommittedGenerate))));

        var planning = await service.CreateSessionAsync(Session(
            "planning-run",
            DesignArtifactTypes.HtmlPpt,
            DesignArtifactWorkspaceKinds.AdapterOwned,
            "html-ppt",
            DesignArtifactOperations.Plan));
        var planned = await service.CompleteAsync(new DesignArtifactLifecycleMutationRequest(
            planning.Id,
            planning.UserId,
            Expected(planning)));
        Assert.Equal(RunStatuses.Done, planned.Status);
        Assert.Null(planned.Manifest);
        Assert.Null(planned.VersionBoundary!.OutputContentHash);
        await AssertConflict(() => service.BindPublishedArtifactAsync(new BindPublishedDesignArtifactRequest(
            planned.Id,
            planned.UserId,
            Expected(planned),
            "site-invalid",
            "version-invalid")));
        var planningWithManifest = await service.CreateSessionAsync(Session(
            "planning-manifest-run",
            DesignArtifactTypes.HtmlPpt,
            DesignArtifactWorkspaceKinds.AdapterOwned,
            "html-ppt",
            DesignArtifactOperations.Plan));
        var planningManifestError = await Assert.ThrowsAsync<DesignArtifactLifecycleException>(() =>
            service.CommitManifestAsync(new CommitDesignArtifactManifestRequest(
                planningWithManifest.Id,
                planningWithManifest.UserId,
                Expected(planningWithManifest),
                Manifest(DesignArtifactTypes.HtmlPpt, DesignArtifactSecurityProfiles.HtmlPptInteractive, 'e'))));
        Assert.Equal(DesignArtifactLifecycleErrorCodes.InvalidContract, planningManifestError.Code);

        var failureRun = await service.CreateSessionAsync(Session(
            "failure-run",
            DesignArtifactTypes.HtmlPpt,
            DesignArtifactWorkspaceKinds.AdapterOwned,
            "html-ppt"));
        var invalidFailure = await Assert.ThrowsAsync<DesignArtifactLifecycleException>(() =>
            service.FailAsync(new FailDesignArtifactSessionRequest(
                failureRun.Id,
                failureRun.UserId,
                Expected(failureRun),
                "Bearer secret https://provider.example")));
        Assert.Equal(DesignArtifactLifecycleErrorCodes.InvalidContract, invalidFailure.Code);
        var failed = await service.FailAsync(new FailDesignArtifactSessionRequest(
            failureRun.Id,
            failureRun.UserId,
            Expected(failureRun),
            "adapter_failed"));
        Assert.Equal(RunStatuses.Error, failed.Status);
        Assert.Equal("adapter_failed", failed.LifecycleFailureCode);
        Assert.DoesNotContain("provider", failed.ToJson(), StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task PublicContractApi_ShouldReadLegacyV1AndNeverExposeKeysBodiesOrEventPayload()
    {
        await using var fixture = await LifecycleMongoFixture.CreateAsync();
        var events = new InMemoryRunEventStore();
        var service = new DesignArtifactLifecycleService(fixture.Db, events);
        var current = await service.CreateSessionAsync(Session(
            "public-run",
            DesignArtifactTypes.WebPage,
            DesignArtifactWorkspaceKinds.RemotePackage,
            "open-design"));
        current = await service.CommitManifestAsync(new CommitDesignArtifactManifestRequest(
            current.Id,
            current.UserId,
            Expected(current),
            Manifest(DesignArtifactTypes.WebPage, DesignArtifactSecurityProfiles.WebPageRestricted, 'f')));
        current = await service.CompleteAsync(new DesignArtifactLifecycleMutationRequest(
            current.Id,
            current.UserId,
            Expected(current)));
        current.Instruction = "private instruction body";
        current.KnowledgeReferences =
        [
            new DesignKnowledgeSnapshot
            {
                EntryId = "entry-private",
                Title = "private title",
                Content = "private knowledge body",
                ContentHash = new string('d', 64),
            },
        ];
        current.WorkspaceInputAssetKey = "private/input-object-key";
        current.WorkspaceResultAssetKey = "private/result-object-key";
        await fixture.Db.DesignArtifactRuns.ReplaceOneAsync(item => item.Id == current.Id, current);
        await service.AppendEventAsync(new AppendDesignArtifactEventRequest(
            current.Id,
            current.UserId,
            DesignArtifactLifecycleEventTypes.Delta,
            "生成页面",
            30,
            new Dictionary<string, object?>
            {
                ["content"] = "private event body",
                ["apiKey"] = "private-api-key",
            }));
        await fixture.Db.DesignArtifactRuns.InsertOneAsync(new DesignArtifactRun
        {
            Id = "legacy-run",
            UserId = current.UserId,
            ArtifactType = DesignArtifactTypes.HtmlPpt,
            Instruction = "legacy private body",
            WorkspaceInputAssetKey = "legacy/private-key",
        });

        var controller = Controller(fixture, events, current.UserId);
        var contract = Data(Assert.IsType<OkObjectResult>(await controller.GetContract(current.Id)));
        Assert.Equal(DesignArtifactContractVersions.Current, contract.GetProperty("contractVersion").GetInt32());
        Assert.True(contract.GetProperty("workspace").TryGetProperty("adapter", out _));
        Assert.True(contract.GetProperty("manifestComplete").GetBoolean());
        Assert.Equal("index.html", contract.GetProperty("manifest").GetProperty("entryFile").GetString());
        Assert.Equal(new string('f', 64), contract.GetProperty("manifest").GetProperty("files")[0].GetProperty("sha256").GetString());
        Assert.False(contract.TryGetProperty("instruction", out _));

        var eventResult = Data(Assert.IsType<OkObjectResult>(await controller.GetContractEvents(current.Id)));
        Assert.Single(eventResult.GetProperty("items").EnumerateArray());
        var serialized = JsonSerializer.Serialize(new { contract, eventResult }, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        Assert.DoesNotContain("private instruction body", serialized, StringComparison.Ordinal);
        Assert.DoesNotContain("private knowledge body", serialized, StringComparison.Ordinal);
        Assert.DoesNotContain("private event body", serialized, StringComparison.Ordinal);
        Assert.DoesNotContain("private-api-key", serialized, StringComparison.Ordinal);
        Assert.DoesNotContain("object-key", serialized, StringComparison.Ordinal);
        Assert.DoesNotContain("payload", serialized, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("baseUrl", serialized, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("apiKey", serialized, StringComparison.OrdinalIgnoreCase);

        var legacy = Data(Assert.IsType<OkObjectResult>(await controller.GetContract("legacy-run")));
        Assert.Equal(DesignArtifactContractVersions.Legacy, legacy.GetProperty("contractVersion").GetInt32());
        Assert.False(legacy.GetProperty("manifestComplete").GetBoolean());
        Assert.Equal(JsonValueKind.Null, legacy.GetProperty("manifest").ValueKind);
        Assert.IsType<NotFoundObjectResult>(
            await Controller(fixture, events, "other-user").GetContract(current.Id));
    }

    private static CreateDesignArtifactSessionRequest Session(
        string runId,
        string artifactType,
        string workspaceKind,
        string adapter,
        string operation = DesignArtifactOperations.Generate) => new(
        runId,
        "owner-user",
        artifactType,
        operation,
        artifactType == DesignArtifactTypes.HtmlPpt
            ? DesignArtifactSourceSurfaces.HtmlPpt
            : DesignArtifactSourceSurfaces.WebHosting,
        artifactType == DesignArtifactTypes.HtmlPpt
            ? DesignArtifactRuntimes.HtmlPptPipeline
            : DesignArtifactRuntimes.OpenDesign,
        new DesignArtifactWorkspaceRef
        {
            WorkspaceId = $"workspace-{runId}",
            Kind = workspaceKind,
            BaseRevision = "base-revision",
            Adapter = adapter,
        },
        new DesignArtifactVersionBoundary
        {
            BaseArtifactId = "base-artifact",
            BaseVersion = "base-version",
            BaseContentHash = new string('c', 64),
        });

    private static DesignArtifactLifecycleExpectation Expected(DesignArtifactRun run) => new(
        run.LifecycleVersion,
        run.WorkspaceRef!.BaseRevision,
        run.VersionBoundary!.BaseContentHash);

    private static LifecycleManifest Manifest(
        string artifactType,
        string securityProfile,
        char hash,
        string path = "index.html") => new()
    {
        SchemaVersion = DesignArtifactContractVersions.ManifestV1,
        ArtifactType = artifactType,
        EntryFile = path,
        SecurityProfile = securityProfile,
        Files = [File(path, hash)],
    };

    private static LifecycleManifestFile File(string path, char hash) => new()
    {
        Path = path,
        ByteLength = 128,
        Sha256 = new string(hash, 64),
    };

    private static async Task AssertConflict(Func<Task> action)
    {
        var error = await Assert.ThrowsAsync<DesignArtifactLifecycleException>(action);
        Assert.Equal(DesignArtifactLifecycleErrorCodes.Conflict, error.Code);
    }

    private static DesignArtifactsController Controller(
        LifecycleMongoFixture fixture,
        IRunEventStore events,
        string userId)
    {
        var controller = new DesignArtifactsController(
            fixture.Db,
            events,
            Mock.Of<IRunQueue>(),
            Mock.Of<IDesignArtifactProviderCatalog>(),
            Mock.Of<IDesignKnowledgeSnapshotResolver>(),
            new LlmGatewayDataContext(fixture.ConnectionString, fixture.GatewayDatabaseName));
        controller.ControllerContext = new ControllerContext
        {
            HttpContext = new DefaultHttpContext
            {
                User = new ClaimsPrincipal(new ClaimsIdentity([new Claim("sub", userId)], "test")),
            },
        };
        return controller;
    }

    private static JsonElement Data(OkObjectResult result)
        => JsonSerializer.SerializeToElement(result.Value, new JsonSerializerOptions(JsonSerializerDefaults.Web))
            .GetProperty("data");

    private sealed class LifecycleMongoFixture : IAsyncDisposable
    {
        private readonly MongoClient _client;
        private readonly string _databaseName;

        private LifecycleMongoFixture(MongoClient client, string connectionString, string suffix)
        {
            _client = client;
            ConnectionString = connectionString;
            _databaseName = $"design_lifecycle_{suffix}";
            GatewayDatabaseName = $"design_lifecycle_gw_{suffix}";
            Db = new MongoDbContext(connectionString, _databaseName);
        }

        internal string ConnectionString { get; }
        internal string GatewayDatabaseName { get; }
        internal MongoDbContext Db { get; }

        internal static async Task<LifecycleMongoFixture> CreateAsync()
        {
            var connectionString = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION")
                                   ?? "mongodb://127.0.0.1:27017";
            var settings = MongoClientSettings.FromConnectionString(connectionString);
            settings.ServerSelectionTimeout = TimeSpan.FromSeconds(3);
            var client = new MongoClient(settings);
            await client.GetDatabase("admin").RunCommandAsync<BsonDocument>(new BsonDocument("ping", 1));
            return new LifecycleMongoFixture(client, connectionString, Guid.NewGuid().ToString("N"));
        }

        public async ValueTask DisposeAsync()
        {
            await _client.DropDatabaseAsync(_databaseName);
            await _client.DropDatabaseAsync(GatewayDatabaseName);
        }
    }
}
