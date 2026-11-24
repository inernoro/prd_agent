using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Driver;
using Moq;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services.InfraAgentSessions;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class InfraAgentWorkspaceVersionMongoTests
{
    [Fact]
    [Trait("Category", "Integration")]
    public async Task OpenDesignStartDistinguishesUnallocatedRetryFromContinuation()
    {
        var uri = Environment.GetEnvironmentVariable("MAP_WORKSPACE_VERSION_TEST_MONGO");
        Assert.False(string.IsNullOrWhiteSpace(uri), "请指定隔离 MongoDB");
        var databaseName = $"map_workspace_version_test_{Guid.NewGuid():N}";
        var db = new MongoDbContext(uri!, databaseName);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        var ct = timeout.Token;
        var connection = new InfraConnection
        {
            Id = "workspace-connection",
            PartnerBaseUrl = "https://cds.example.test",
            ProjectId = "workspace-project",
            WorkspaceOnly = true
        };
        var connections = new Mock<IInfraConnectionService>();
        connections.Setup(x => x.GetRawAsync(connection.Id, It.IsAny<CancellationToken>())).ReturnsAsync(connection);
        connections.Setup(x => x.TryUnprotectLongTokenAsync(connection.Id, It.IsAny<CancellationToken>(), false))
            .ReturnsAsync("test-connection-token");
        const string trace = "delivery-task";
        var digest = $"sha256:{new string('a', 64)}";
        using var cds = new WorkspaceStartResponder(digest);
        using var http = new HttpClient(cds);
        var service = new InfraAgentSessionService(db, NullLogger<InfraAgentSessionService>.Instance,
            connections.Object, Mock.Of<IInfraAgentRuntimeProfileService>(), null,
            Mock.Of<IInfraAgentRuntimeJobQueue>(), Mock.Of<IAgentToolRegistry>(), http);
        var request = new StartInfraAgentSessionRequest(InfraAgentRuntimes.OpenDesign, "map-managed",
            new InfraAgentManagedLaunchRequest("https://map.example.test/llm/v1", "openai", "test-model-token",
                new InfraAgentWorkspaceTransferRequest("map-design-workspace-v1", "https://map.example.test/input",
                    "test-input-sha", "https://map.example.test/result", "test-transfer-token", "test-revision",
                    1024, 2048, ["index.html"])));

        async Task CreateSession(string id, string owner, string task, DateTime? startedAt = null)
        {
            await db.InfraAgentSessions.InsertOneAsync(new InfraAgentSession
            {
                Id = id, UserId = owner, TraceId = task, ConnectionId = connection.Id,
                CdsProjectId = connection.ProjectId, Runtime = InfraAgentRuntimes.OpenDesign,
                WorkloadKind = InfraAgentWorkloadKinds.DesignArtifact,
                IsolationMode = InfraAgentIsolationModes.SessionContainer, StartedAt = startedAt
            }, cancellationToken: ct);
        }

        try
        {
            await CreateSession("failed-first-start", "author-a", trace);
            await Assert.ThrowsAsync<InfraAgentSessionException>(
                () => service.StartAsync("author-a", "failed-first-start", request, ct));
            var failed = await db.InfraAgentSessions.Find(row => row.Id == "failed-first-start").SingleAsync(ct);
            Assert.NotNull(failed.StartedAt);
            Assert.False(failed.CdsWorkspaceLaunchConfirmed);

            await CreateSession("retry", "author-a", trace);
            await service.StartAsync("author-a", "retry", request, ct);
            var started = await db.InfraAgentSessions.Find(row => row.Id == "retry").SingleAsync(ct);
            Assert.True(started.CdsWorkspaceLaunchConfirmed);
            Assert.Equal(digest, started.CdsWorkspaceImageDigest);

            await CreateSession("continuation", "author-a", trace);
            await service.StartAsync("author-a", "continuation", request, ct);
            await CreateSession("other-author", "author-b", trace);
            await service.StartAsync("author-b", "other-author", request, ct);

            await CreateSession("legacy-history", "author-a", "legacy-task", DateTime.UtcNow.AddHours(-1));
            await CreateSession("legacy-continuation", "author-a", "legacy-task");
            await service.StartAsync("author-a", "legacy-continuation", request, ct);

            Assert.Equal(new (bool, string?)[]
            {
                (false, null), (false, null), (true, digest), (false, null), (true, null)
            }, cds.Transfers);
        }
        finally
        {
            await db.Database.Client.DropDatabaseAsync(databaseName);
        }
    }

    private sealed class WorkspaceStartResponder(string digest) : HttpMessageHandler
    {
        public List<(bool, string?)> Transfers { get; } = [];

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Assert.Equal(HttpMethod.Post, request.Method);
            Assert.Equal("/api/projects/workspace-project/agent-sessions", request.RequestUri?.AbsolutePath);
            using var body = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(ct));
            var transfer = body.RootElement.GetProperty("workspaceTransfer");
            Transfers.Add((transfer.GetProperty("continuingRun").GetBoolean(),
                transfer.TryGetProperty("previousImageDigest", out var previous) ? previous.GetString() : null));
            var id = $"cds-start-{Transfers.Count}";
            if (Transfers.Count == 1)
                return new HttpResponseMessage(HttpStatusCode.UnprocessableEntity)
                {
                    Content = JsonContent.Create(new
                    {
                        item = new { id, status = "failed" },
                        error = new { code = "workspace_transfer_invalid", message = "input rejected before allocation" }
                    })
                };
            return new HttpResponseMessage(HttpStatusCode.Created)
            {
                Content = JsonContent.Create(new { item = new
                {
                    id, status = "idle", runtimeImage = $"ghcr.io/example/open-design@{digest}"
                } })
            };
        }
    }
}
