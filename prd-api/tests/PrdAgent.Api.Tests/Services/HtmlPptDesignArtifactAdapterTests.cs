using System.Text;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Api.Services.MdToPpt;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed class HtmlPptDesignArtifactAdapterTests
{
    [Fact]
    public void AdapterContract_ShouldNotAcceptRuntimeAuthorityConfiguration()
    {
        var constructorFields = typeof(HtmlPptDesignArtifactAdapter)
            .GetConstructors()
            .Single()
            .GetParameters()
            .Select(parameter => parameter.ParameterType.Name)
            .ToArray();
        Assert.DoesNotContain(constructorFields, field => field.Contains("Configuration", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(constructorFields, field => field.Contains("Gateway", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(constructorFields, field => field.Contains("Model", StringComparison.OrdinalIgnoreCase));

        var root = FindRepositoryRoot();
        var controller = File.ReadAllText(Path.Combine(
            root,
            "prd-api",
            "src",
            "PrdAgent.Api",
            "Controllers",
            "Api",
            "MdToPptController.cs"));
        Assert.Contains("RunId: auditRunId", controller, StringComparison.Ordinal);
        Assert.Contains("SessionId: auditRunId", controller, StringComparison.Ordinal);
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task PlanAndHtmlArtifact_ShouldUseSameIdAndExactUtf8Manifest()
    {
        await using var fixture = await AdapterMongoFixture.CreateAsync();
        var events = new InMemoryRunEventStore();
        var adapter = Adapter(fixture, events);

        var plan = Run("plan-run", "outline", "running", string.Empty, null);
        await fixture.Db.MdToPptRuns.InsertOneAsync(plan);
        await adapter.BeginAsync(plan);
        plan.Status = "done";
        plan.OutlineJson = "{\"outline\":[]}";
        plan.OutlineHash = new string('a', 64);
        plan.UserSuppliedContentHash = new string('b', 64);
        plan.UpdatedAt = DateTime.UtcNow;
        await fixture.Db.MdToPptRuns.ReplaceOneAsync(item => item.Id == plan.Id, plan);
        await adapter.CompletePlanAsync(plan);

        var plannedPublic = await fixture.Db.DesignArtifactRuns.Find(item => item.Id == plan.Id).SingleAsync();
        Assert.Equal(plan.Id, plannedPublic.Id);
        Assert.Equal(DesignArtifactOperations.Plan, plannedPublic.Operation);
        Assert.Equal(DesignArtifactWorkspaceKinds.AdapterOwned, plannedPublic.WorkspaceRef!.Kind);
        Assert.Equal(HtmlPptDesignArtifactAdapter.AdapterId, plannedPublic.WorkspaceRef.Adapter);
        Assert.Equal(RunStatuses.Done, plannedPublic.Status);
        Assert.Null(plannedPublic.Manifest);
        Assert.Equal(plan.OutlineHash, plannedPublic.PlanReceipt!.ContentHash);

        const string html = "<!doctype html><html lang=\"zh\"><head></head><body>中文 PPT</body></html>";
        var htmlHash = MdToPptController.ComputeHtmlHash(html);
        var artifact = Run("artifact-run", "convert", "running", html, htmlHash);
        await fixture.Db.MdToPptRuns.InsertOneAsync(artifact);
        await adapter.BeginAsync(artifact);
        artifact.Status = "done";
        artifact.UpdatedAt = DateTime.UtcNow;
        await fixture.Db.MdToPptRuns.ReplaceOneAsync(item => item.Id == artifact.Id, artifact);
        await adapter.CommitAndCompleteAsync(artifact);

        var publicArtifact = await fixture.Db.DesignArtifactRuns.Find(item => item.Id == artifact.Id).SingleAsync();
        Assert.Equal(RunStatuses.Done, publicArtifact.Status);
        Assert.Equal(DesignArtifactOperations.Generate, publicArtifact.Operation);
        Assert.Equal(htmlHash, publicArtifact.VersionBoundary!.EntryContentHash);
        Assert.Equal(publicArtifact.VersionBoundary.PackageHash, publicArtifact.VersionBoundary.OutputContentHash);
        var manifestFile = Assert.Single(publicArtifact.Manifest!.Files);
        Assert.Equal("index.html", publicArtifact.Manifest.EntryFile);
        Assert.Equal("index.html", manifestFile.Path);
        Assert.Equal(Encoding.UTF8.GetByteCount(html), manifestFile.ByteLength);
        Assert.Equal(htmlHash, manifestFile.Sha256);
        Assert.Equal("text/html", manifestFile.MediaType);
        Assert.NotNull(publicArtifact.ManifestValidation);

        var records = publicArtifact.LifecycleEvents;
        Assert.Contains(records, record => record.Type == DesignArtifactLifecycleEventTypes.Run);
        Assert.Contains(records, record => record.Type == DesignArtifactLifecycleEventTypes.Manifest);
        Assert.Contains(records, record => record.Type == DesignArtifactLifecycleEventTypes.Done);
        Assert.Equal(records.Select(record => record.Sequence), Enumerable.Range(1, records.Count).Select(value => (long)value));
        var serializedEvents = System.Text.Json.JsonSerializer.Serialize(records);
        Assert.DoesNotContain(html, serializedEvents, StringComparison.Ordinal);
        Assert.DoesNotContain("baseUrl", serializedEvents, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("model", serializedEvents, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("connection", serializedEvents, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task Recovery_ShouldCloseDoneFailureAndPublishBindingWindows()
    {
        await using var fixture = await AdapterMongoFixture.CreateAsync();
        var events = new InMemoryRunEventStore();
        var adapter = Adapter(fixture, events);

        const string html = "<!doctype html><html><head></head><body>recover</body></html>";
        var hash = MdToPptController.ComputeHtmlHash(html);
        var done = Run("recover-done", "patch", "running", html, hash, "parent-run", new string('a', 64));
        await fixture.Db.MdToPptRuns.InsertOneAsync(done);
        await adapter.BeginAsync(done);
        done.Status = "done";
        done.ArtifactContractSynchronizedAt = null;
        done.UpdatedAt = DateTime.UtcNow;
        await fixture.Db.MdToPptRuns.ReplaceOneAsync(item => item.Id == done.Id, done);

        Assert.Equal(1, await adapter.RecoverPendingAsync());
        var recoveredDone = await fixture.Db.DesignArtifactRuns.Find(item => item.Id == done.Id).SingleAsync();
        Assert.Equal(RunStatuses.Done, recoveredDone.Status);
        Assert.Equal(hash, recoveredDone.Manifest!.Files.Single().Sha256);

        var site = new HostedSite
        {
            Id = "owned-site",
            OwnerUserId = done.UserId,
            Title = "Recovered PPT",
            SiteUrl = "https://site.invalid/index.html",
            ContentVersion = new DateTime(2026, 9, 8, 1, 2, 3, DateTimeKind.Utc),
        };
        await fixture.Db.HostedSites.InsertOneAsync(site);
        done.PublishedSiteId = site.Id;
        done.PublishedHtmlHash = hash;
        done.PublishedVersionId = HtmlPptDesignArtifactAdapter.BuildHostedVersionId(site);
        done.ArtifactContractSynchronizedAt = null;
        done.UpdatedAt = DateTime.UtcNow;
        await fixture.Db.MdToPptRuns.ReplaceOneAsync(item => item.Id == done.Id, done);

        Assert.Equal(1, await adapter.RecoverPendingAsync());
        var bound = await fixture.Db.DesignArtifactRuns.Find(item => item.Id == done.Id).SingleAsync();
        Assert.Equal(site.Id, bound.ArtifactSiteId);
        Assert.Equal(done.PublishedVersionId, bound.ArtifactRevisionId);
        Assert.NotEqual(hash, bound.ArtifactRevisionId);

        var failed = Run("recover-error", "convert", "running", string.Empty, null);
        await fixture.Db.MdToPptRuns.InsertOneAsync(failed);
        await adapter.BeginAsync(failed);
        failed.Status = "error";
        failed.Error = "provider body must remain private";
        failed.ArtifactContractSynchronizedAt = null;
        failed.UpdatedAt = DateTime.UtcNow;
        await fixture.Db.MdToPptRuns.ReplaceOneAsync(item => item.Id == failed.Id, failed);

        Assert.Equal(1, await adapter.RecoverPendingAsync());
        var recoveredFailure = await fixture.Db.DesignArtifactRuns.Find(item => item.Id == failed.Id).SingleAsync();
        Assert.Equal(RunStatuses.Error, recoveredFailure.Status);
        Assert.Equal(HtmlPptDesignArtifactAdapter.RecoveryFailureCode, recoveredFailure.LifecycleFailureCode);
        Assert.Null(recoveredFailure.Error);
        var failureEvents = recoveredFailure.LifecycleEvents;
        Assert.Contains(failureEvents, record => record.Type == DesignArtifactLifecycleEventTypes.Run);
        Assert.Contains(failureEvents, record => record.Type == DesignArtifactLifecycleEventTypes.Error);
        Assert.DoesNotContain(
            "provider body must remain private",
            System.Text.Json.JsonSerializer.Serialize(failureEvents),
            StringComparison.Ordinal);

        await Assert.ThrowsAsync<DesignArtifactLifecycleException>(() => adapter.BindPublishedAsync(
            done,
            site.Id,
            "hosted-content-untrusted",
            CancellationToken.None));
    }

    private static HtmlPptDesignArtifactAdapter Adapter(AdapterMongoFixture fixture, IRunEventStore events) => new(
        fixture.Db,
        new DesignArtifactLifecycleService(fixture.Db, events),
        NullLogger<HtmlPptDesignArtifactAdapter>.Instance);

    private static MdToPptRun Run(
        string id,
        string op,
        string status,
        string html,
        string? htmlHash,
        string? parentRunId = null,
        string? parentHtmlHash = null) => new()
    {
        Id = id,
        UserId = "owner-user",
        Status = status,
        Runtime = DesignArtifactRuntimes.HtmlPptPipeline,
        Provider = "open-design-html-ppt",
        ArtifactContractVersion = DesignArtifactContractVersions.Current,
        Op = op,
        Title = "HTML PPT",
        SourceSurface = DesignArtifactSourceSurfaces.HtmlPpt,
        Html = html,
        HtmlHash = htmlHash,
        ParentRunId = parentRunId,
        ParentHtmlHash = parentHtmlHash,
        UpdatedAt = DateTime.UtcNow,
    };

    private static string FindRepositoryRoot()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory != null && !File.Exists(Path.Combine(directory.FullName, "prd-api", "src", "PrdAgent.Api", "Program.cs")))
            directory = directory.Parent;
        return directory?.FullName ?? throw new InvalidOperationException("找不到仓库根目录");
    }

    private sealed class AdapterMongoFixture : IAsyncDisposable
    {
        private readonly MongoClient _client;
        private readonly string _databaseName;

        private AdapterMongoFixture(MongoClient client, string connectionString, string suffix)
        {
            _client = client;
            _databaseName = $"html_ppt_adapter_{suffix}";
            Db = new MongoDbContext(connectionString, _databaseName);
        }

        internal MongoDbContext Db { get; }

        internal static async Task<AdapterMongoFixture> CreateAsync()
        {
            var connectionString = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION")
                                   ?? "mongodb://127.0.0.1:27017";
            var settings = MongoClientSettings.FromConnectionString(connectionString);
            settings.ServerSelectionTimeout = TimeSpan.FromSeconds(3);
            var client = new MongoClient(settings);
            await client.GetDatabase("admin").RunCommandAsync<BsonDocument>(new BsonDocument("ping", 1));
            return new AdapterMongoFixture(client, connectionString, Guid.NewGuid().ToString("N"));
        }

        public async ValueTask DisposeAsync()
        {
            await _client.DropDatabaseAsync(_databaseName);
        }
    }
}
