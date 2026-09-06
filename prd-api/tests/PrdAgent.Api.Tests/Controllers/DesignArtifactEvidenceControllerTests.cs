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
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

public sealed class DesignArtifactEvidenceControllerTests
{
    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task EvidenceExport_ShouldCorrelateConcurrentSessionsAndRejectCrossUserAccess()
    {
        await using var fixture = await EvidenceMongoFixture.CreateAsync();
        var createdAt = DateTime.UtcNow.AddMinutes(-2);
        var runA = Run("run-a", "owner-user", createdAt);
        runA.ArtifactSiteId = "site-a";
        runA.ArtifactRevisionId = "version-a";
        runA.WorkspaceResultAssetKey = "private/result-a.json";
        runA.WorkspaceResultSha256 = new string('a', 64);
        runA.WorkspaceManifestSha256 = new string('b', 64);
        var runB = Run("run-b", "owner-user", createdAt.AddSeconds(1));
        runB.ArtifactSiteId = "site-b";
        runB.ArtifactRevisionId = "version-target";
        runB.WorkspaceResultSha256 = new string('c', 64);
        runB.WorkspaceManifestSha256 = new string('d', 64);
        runB.WorkspacePendingResultAssetKey = "private/result-b.json";
        runB.WorkspacePendingResultAttemptId = "attempt-b";
        runB.WorkspacePendingResultWriteState = DesignWorkspaceResultWriteStates.Stored;
        await fixture.Db.DesignArtifactRuns.InsertManyAsync([runA, runB]);
        await fixture.Db.InfraAgentSessions.InsertManyAsync([
            Session("map-session-a", "cds-workspace-a", runA.Id, runA.UserId, createdAt),
            Session("map-session-b", "cds-workspace-b", runB.Id, runB.UserId, createdAt.AddSeconds(1)),
            Session("foreign-session", "foreign-workspace", runA.Id, "other-user", createdAt.AddMinutes(1)),
        ]);
        await fixture.Db.HostedSiteRevisions.InsertManyAsync([
            new HostedSiteRevision
            {
                Id = "version-a",
                SiteId = "site-a",
                CreatedByUserId = "owner-user",
                Status = HostedSiteRevisionStatuses.Published,
                Source = HostedSiteRevisionSources.AiEdit,
                PublishedAt = createdAt.AddMinutes(1),
            },
            new HostedSiteRevision
            {
                Id = "version-target",
                SiteId = "site-b",
                CreatedByUserId = "owner-user",
                Status = HostedSiteRevisionStatuses.Published,
                Source = HostedSiteRevisionSources.AiEdit,
                PublishedAt = createdAt,
            },
            new HostedSiteRevision
            {
                Id = "version-b",
                SiteId = "site-b",
                CreatedByUserId = "owner-user",
                Status = HostedSiteRevisionStatuses.Draft,
                Source = HostedSiteRevisionSources.Rollback,
                ParentRevisionId = "version-old",
                RollbackTargetRevisionId = "version-target",
                LastPublishFailureCode = "rollback_publish_failed",
                LastPublishFailedAt = createdAt.AddMinutes(1),
                CreatedAt = createdAt.AddMinutes(1),
            },
        ]);
        await fixture.Db.InfraAgentEvents.InsertManyAsync([
            new InfraAgentEvent
            {
                SessionId = "map-session-b",
                Seq = 1,
                Type = InfraAgentEventTypes.Error,
                PayloadJson = "{\"code\":\"open_design_run_timeout\",\"message\":\"secret=do-not-export\"}",
            },
            new InfraAgentEvent
            {
                SessionId = "map-session-b",
                Seq = 2,
                Type = InfraAgentEventTypes.Error,
                PayloadJson = "{\"code\":\"secretdonotexport\"}",
            },
        ]);
        var foreignAudit = Audit("foreign-audit", "foreign-request", runA.Id, "other-user", createdAt.AddMinutes(1));
        foreignAudit.Provider = "secret-provider";
        foreignAudit.ApiBase = "https://secret.example/token=value";
        foreignAudit.Error = "secret=do-not-export";
        await fixture.GatewayDb.LlmRequestLogs.InsertManyAsync([
            Audit("audit-a", "request-a", runA.Id, runA.UserId, createdAt),
            Audit("audit-b", "request-b", runB.Id, runB.UserId, createdAt.AddSeconds(1)),
            foreignAudit,
        ]);

        var controller = BuildController(fixture, "owner-user");
        var results = await Task.WhenAll(controller.GetEvidence(runA.Id), controller.GetEvidence(runB.Id));
        var evidenceA = Data(Assert.IsType<OkObjectResult>(results[0]));
        var evidenceB = Data(Assert.IsType<OkObjectResult>(results[1]));

        Assert.Equal("map-session-a", evidenceA.GetProperty("sessionId").GetString());
        Assert.Equal("cds-workspace-a", evidenceA.GetProperty("workspaceId").GetString());
        Assert.Equal("version-a", evidenceA.GetProperty("versionId").GetString());
        Assert.Equal("audit-a", evidenceA.GetProperty("llmgwAuditId").GetString());
        Assert.Equal("committed", evidenceA.GetProperty("manifestCommit").GetProperty("state").GetString());
        Assert.Equal(new string('b', 64), evidenceA.GetProperty("manifestSha256").GetString());
        Assert.Equal("https://map.example/api/design-artifacts/runtime/run-a/llm/v1",
            evidenceA.GetProperty("authority").GetProperty("baseUrl").GetString());
        Assert.Equal("map-managed", evidenceA.GetProperty("authority").GetProperty("model").GetString());
        Assert.Equal("stored", evidenceB.GetProperty("manifestCommit").GetProperty("state").GetString());
        Assert.Equal("open_design_run_timeout",
            evidenceB.GetProperty("runtimeFailure").GetProperty("code").GetString());
        Assert.Equal("rollback_publish_failed",
            evidenceB.GetProperty("version").GetProperty("latestRollback").GetProperty("publishFailureCode").GetString());
        Assert.NotEqual(evidenceA.GetProperty("sessionId").GetString(), evidenceB.GetProperty("sessionId").GetString());
        Assert.NotEqual(evidenceA.GetProperty("workspaceId").GetString(), evidenceB.GetProperty("workspaceId").GetString());

        var serialized = JsonSerializer.Serialize(results, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        Assert.DoesNotContain("secret=do-not-export", serialized, StringComparison.Ordinal);
        Assert.DoesNotContain("secret-provider", serialized, StringComparison.Ordinal);
        Assert.DoesNotContain("foreign-audit", serialized, StringComparison.Ordinal);
        Assert.IsType<NotFoundObjectResult>(
            await BuildController(fixture, "other-user").GetEvidence(runA.Id));
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task EvidenceExport_ShouldExposeOnlyStableCodesForRuntimeFailureClasses()
    {
        await using var fixture = await EvidenceMongoFixture.CreateAsync();
        var cases = new[]
        {
            (RunId: "timeout-run", Code: "open_design_run_timeout"),
            (RunId: "crash-run", Code: "open_design_execution_failed"),
            (RunId: "invalid-output-run", Code: "design_output_invalid"),
            (RunId: "unauthorized-run", Code: "workspace_transfer_invalid"),
        };
        var createdAt = DateTime.UtcNow.AddMinutes(-1);
        await fixture.Db.DesignArtifactRuns.InsertManyAsync(cases.Select((item, index) =>
            Run(item.RunId, "owner-user", createdAt.AddSeconds(index))));
        await fixture.Db.InfraAgentSessions.InsertManyAsync(cases.Select((item, index) =>
            Session($"session-{index}", $"workspace-{index}", item.RunId, "owner-user", createdAt.AddSeconds(index))));
        await fixture.Db.InfraAgentEvents.InsertManyAsync(cases.Select((item, index) => new InfraAgentEvent
        {
            SessionId = $"session-{index}",
            Seq = 1,
            Type = InfraAgentEventTypes.Error,
            PayloadJson = JsonSerializer.Serialize(new
            {
                code = item.Code,
                message = "token=must-not-be-exported https://provider.example/private",
            }),
        }));

        var controller = BuildController(fixture, "owner-user");
        var results = await Task.WhenAll(cases.Select(item => controller.GetEvidence(item.RunId)));
        for (var index = 0; index < cases.Length; index++)
        {
            var evidence = Data(Assert.IsType<OkObjectResult>(results[index]));
            Assert.Equal(cases[index].Code,
                evidence.GetProperty("runtimeFailure").GetProperty("code").GetString());
        }
        var serialized = JsonSerializer.Serialize(results, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        Assert.DoesNotContain("must-not-be-exported", serialized, StringComparison.Ordinal);
        Assert.DoesNotContain("provider.example", serialized, StringComparison.Ordinal);
    }

    private static DesignArtifactRun Run(string id, string userId, DateTime createdAt) => new()
    {
        Id = id,
        UserId = userId,
        Status = RunStatuses.Error,
        Runtime = DesignArtifactRuntimes.OpenDesign,
        CreatedAt = createdAt,
        UpdatedAt = createdAt,
    };

    private static InfraAgentSession Session(
        string id,
        string cdsSessionId,
        string runId,
        string userId,
        DateTime createdAt) => new()
    {
        Id = id,
        CdsSessionId = cdsSessionId,
        TraceId = runId,
        UserId = userId,
        ModelBaseUrl = $"https://map.example/api/design-artifacts/runtime/{runId}/llm/v1?ignored=true",
        Model = "map-managed",
        Runtime = InfraAgentRuntimes.OpenDesign,
        WorkloadKind = InfraAgentWorkloadKinds.DesignArtifact,
        IsolationMode = InfraAgentIsolationModes.SessionContainer,
        CreatedAt = createdAt,
    };

    private static LlmRequestLog Audit(
        string id,
        string requestId,
        string runId,
        string userId,
        DateTime startedAt) => new()
    {
        Id = id,
        RequestId = requestId,
        RunId = runId,
        UserId = userId,
        Status = "succeeded",
        StatusCode = 200,
        AppCallerCode = "prd-agent-api.design-artifact.remote",
        SourceSystem = "map",
        LogicalModelPublicId = "map-default",
        StartedAt = startedAt,
    };

    private static DesignArtifactsController BuildController(EvidenceMongoFixture fixture, string userId)
    {
        var controller = new DesignArtifactsController(
            fixture.Db,
            Mock.Of<IRunEventStore>(),
            Mock.Of<IRunQueue>(),
            Mock.Of<IDesignArtifactProviderCatalog>(),
            Mock.Of<IDesignKnowledgeSnapshotResolver>(),
            fixture.GatewayDb);
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

    private sealed class EvidenceMongoFixture : IAsyncDisposable
    {
        private readonly MongoClient _client;
        private readonly string _mapDatabaseName;
        private readonly string _gatewayDatabaseName;

        private EvidenceMongoFixture(MongoClient client, string connectionString, string suffix)
        {
            _client = client;
            _mapDatabaseName = $"design_evidence_map_{suffix}";
            _gatewayDatabaseName = $"design_evidence_gateway_{suffix}";
            Db = new MongoDbContext(connectionString, _mapDatabaseName);
            GatewayDb = new LlmGatewayDataContext(connectionString, _gatewayDatabaseName);
        }

        internal MongoDbContext Db { get; }
        internal LlmGatewayDataContext GatewayDb { get; }

        internal static async Task<EvidenceMongoFixture> CreateAsync()
        {
            var connectionString = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION")
                                   ?? "mongodb://127.0.0.1:27017";
            var settings = MongoClientSettings.FromConnectionString(connectionString);
            settings.ServerSelectionTimeout = TimeSpan.FromSeconds(3);
            var client = new MongoClient(settings);
            await client.GetDatabase("admin").RunCommandAsync<BsonDocument>(new BsonDocument("ping", 1));
            return new EvidenceMongoFixture(client, connectionString, Guid.NewGuid().ToString("N"));
        }

        public async ValueTask DisposeAsync()
        {
            await _client.DropDatabaseAsync(_mapDatabaseName);
            await _client.DropDatabaseAsync(_gatewayDatabaseName);
        }
    }
}
