using PrdAgent.Api.Tests.Gateway;
using Microsoft.Extensions.Logging.Abstractions;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Services;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Hosting;
using MongoDB.Bson;
using MongoDB.Driver;
using Moq;
using PrdAgent.Api.Services;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Security;
using PrdAgent.Infrastructure.Services;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>随机独立库核验真实准入服务和持久任务恢复；从不访问应用库或供应商。</summary>
public sealed class RunTaskProvenanceIntegrationTests : IAsyncLifetime
{
    private const string Caller = AppCallerRegistry.Admin.WebHosting.GenerateHtml;
    private string _connection = "";
    private string _databaseName = "";
    private MongoDbContext _map = null!;
    private LlmGatewayDataContext _gateway = null!;
    private IConfiguration _configuration = null!;
    private IMongoCollection<GatewayTaskPermitRecord> Permits =>
        _gateway.Database.GetCollection<GatewayTaskPermitRecord>(GatewayTaskPermitRecord.CollectionName);

    public Task InitializeAsync()
    {
        _connection = Environment.GetEnvironmentVariable("DESIGN_RUN_MONGO_TEST_CONNECTION") ?? "";
        var parsed = new MongoUrl(_connection);
        Assert.Single(parsed.Servers);
        Assert.Equal("127.0.0.1", parsed.Server.Host);
        Assert.Equal(27389, parsed.Server.Port);
        Assert.Null(parsed.Username);
        _databaseName = "phase1_run_source_synthetic_" + Guid.NewGuid().ToString("N");
        _map = new MongoDbContext(_connection, _databaseName);
        _gateway = new LlmGatewayDataContext(_connection, _databaseName);
        _configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["LlmGateway:ServeBaseUrl"] = "http://127.0.0.1:1",
        }).Build();
        return Task.CompletedTask;
    }

    [DesignScopeMongoFact]
    public async Task RecoveredTask_ReusesPersistedPermitAndOriginalOrigin_WithoutResettingBudget()
    {
        var permit = await SeedPermitAsync();
        var store = new InMemoryRunEventStore();
        await store.SetRunAsync(RunKinds.Chat, new RunMeta { RunId = "queued-task", TaskPermitId = permit.Id });
        using var unrelated = TaskExecutionContext.Enter(new TaskExecutionIdentity(Guid.NewGuid().ToString("N"), "new-request"));
        var run = (await store.GetRunAsync(RunKinds.Chat, "queued-task"))!;
        using (TaskExecutionContext.Enter(PlatformExecutionFixture.Identity(run.TaskPermitId!, run.RunId)))
        {
            var context = new GatewayRequestContext { RunId = run.RunId, UserId = "owner" };
            using var request = new HttpRequestMessage(HttpMethod.Post, "http://127.0.0.1:1/gw/v1/responses");
            await new TaskExecutionAuthorizer(_gateway, _configuration).AuthorizeOutboundAsync(request, Caller, context, default);
            Assert.Equal(permit.Id, Assert.Single(request.Headers.GetValues("X-Gateway-Task-Permit")));
            Assert.Equal(TaskExecutionOrigins.Agent, context.ExecutionOrigin);
            Assert.Equal("synthetic-agent-key", context.TriggerCredentialId);
            Assert.Equal("queued-task", context.RunId);
        }
        await Permits.UpdateOneAsync(item => item.Id == permit.Id,
            Builders<GatewayTaskPermitRecord>.Update.Set(item => item.CallCount, 2));
        // The next process reconstructs the same identity and authorizer rather than issuing a permit.
        using (TaskExecutionContext.Enter(PlatformExecutionFixture.Identity(run.TaskPermitId!, run.RunId)))
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, "http://127.0.0.1:1/gw/v1/responses");
            await new TaskExecutionAuthorizer(_gateway, _configuration).AuthorizeOutboundAsync(request, Caller,
                new GatewayRequestContext { RunId = run.RunId, UserId = "owner" }, default);
        }
        var recovered = await Permits.Find(item => item.Id == permit.Id).SingleAsync();
        Assert.Equal(2, recovered.CallCount);
        Assert.Equal(["queued-task"], recovered.BoundRunIds);
        Assert.Equal(TaskExecutionOrigins.Agent, recovered.Origin);
        Assert.Equal("synthetic-agent-key", recovered.TriggerCredentialId);
        Assert.Equal(1, await Permits.CountDocumentsAsync(FilterDefinition<GatewayTaskPermitRecord>.Empty));
        Assert.Equal("new-request", TaskExecutionContext.Current!.RunId);
    }

    [DesignScopeMongoFact]
    public async Task UnknownRecoveredTask_CannotBorrowAuthorityFromUserIdOrAdjacentRequest()
    {
        var permit = await SeedPermitAsync();
        using var surrounding = TaskExecutionContext.Enter(new TaskExecutionIdentity(permit.Id, "legitimate-other-task"));
        var legacy = MongoDB.Bson.Serialization.BsonSerializer.Deserialize<ImageGenRun>(new BsonDocument
        {
            { "_id", "legacy-task" }, { "OwnerAdminId", "owner" },
        });
        Assert.Null(legacy.TaskPermitId);
        using (TaskExecutionContext.Enter(legacy.TaskPermitId == null
            ? null : new TaskExecutionIdentity(legacy.TaskPermitId, legacy.Id)))
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, "http://127.0.0.1:1/gw/v1/responses");
            var failure = await Assert.ThrowsAsync<TaskExecutionAdmissionException>(() =>
                new TaskExecutionAuthorizer(_gateway, _configuration).AuthorizeOutboundAsync(request, Caller,
                    new GatewayRequestContext { RunId = legacy.Id, UserId = legacy.OwnerAdminId }, default));
            Assert.Equal("TASK_EXECUTION_NOT_ADMITTED", failure.Code);
            Assert.False(request.Headers.Contains("X-Gateway-Task-Permit"));
        }
        var unchanged = await Permits.Find(item => item.Id == permit.Id).SingleAsync();
        Assert.Empty(unchanged.BoundRunIds);
        Assert.Equal(0, unchanged.CallCount);
        Assert.Equal("legitimate-other-task", TaskExecutionContext.Current!.RunId);
    }

    [DesignScopeMongoFact]
    public async Task ExhaustedOrRevokedTask_CannotMintARuntimeGrant_WhenUserIdStillMatches()
    {
        var permit = await SeedPermitAsync();
        await Permits.UpdateOneAsync(item => item.Id == permit.Id,
            Builders<GatewayTaskPermitRecord>.Update.Set(item => item.CallCount, 3));
        var run = new DesignArtifactRun
        {
            Id = "design-task", UserId = permit.ActorUserId, TaskPermitId = permit.Id,
            Operation = DesignArtifactOperations.Generate,
            LlmRequestPolicy = new DesignArtifactLlmRequestPolicy { Model = "default-chat-curated" },
        };
        var environment = new Mock<IHostEnvironment>();
        environment.SetupGet(item => item.EnvironmentName).Returns("Production");
        var service = new DesignArtifactGatewayGrantService(_gateway, _map, _configuration, environment.Object,
            new TaskExecutionAuthorizer(_gateway, _configuration));
        using var activeExecution = TaskExecutionContext.Enter(PlatformExecutionFixture.Identity(permit.Id, run.Id));
        var exhausted = await Assert.ThrowsAsync<TaskExecutionAdmissionException>(() => service.IssueAsync(run,
            DateTime.UtcNow.AddMinutes(5), default));
        Assert.Equal("TASK_PERMIT_INVALID", exhausted.Code);
        await Permits.UpdateOneAsync(item => item.Id == permit.Id, Builders<GatewayTaskPermitRecord>.Update
            .Set(item => item.CallCount, 0).Set(item => item.RevokedAt, DateTime.UtcNow));
        await Assert.ThrowsAsync<TaskExecutionAdmissionException>(() => service.IssueAsync(run,
            DateTime.UtcNow.AddMinutes(5), default));
        Assert.Equal(0, await _gateway.Database.GetCollection<GatewayRuntimeGrantRecord>("llmgw_runtime_grants")
            .CountDocumentsAsync(FilterDefinition<GatewayRuntimeGrantRecord>.Empty));
        var unchanged = await Permits.Find(item => item.Id == permit.Id).SingleAsync();
        Assert.Empty(unchanged.BoundRunIds);
        Assert.NotNull(unchanged.RevokedAt);
    }

    [DesignScopeMongoTheory]
    [InlineData("stored-permit")]
    [InlineData(null)]
    public async Task ActualReprocessEntry_RestoresPersistedTaskOrClearsUnrelatedAuthorityAtModelBoundary(string? storedPermit)
    {
        var run = new DocumentStoreAgentRun
        {
            Id = "reprocess-task", TaskPermitId = storedPermit, UserId = "owner", SourceEntryId = "entry",
            Kind = DocumentStoreAgentRunKind.Reprocess,
            Messages = [new ReprocessChatMessage { Role = "user", Content = "整理正文" }],
        };
        await _map.DocumentEntries.InsertOneAsync(new DocumentEntry
        {
            Id = "entry", ContentIndex = "这是一段完整的测试正文", Title = "测试文档", CreatedBy = "owner",
        });
        await _map.DocumentStoreAgentRuns.InsertOneAsync(run);
        TaskExecutionIdentity? observed = null;
        var reachedModelBoundary = false;
        var gateway = new Mock<PrdAgent.Core.Interfaces.LlmGateway.ILlmGateway>(MockBehavior.Strict);
        gateway.Setup(item => item.CreateClient(AppCallerRegistry.DocumentStoreAgent.Reprocess.Generate,
                ModelTypes.Chat, 4096, 0.4, false, null, null, null))
            .Callback(() => { reachedModelBoundary = true; observed = TaskExecutionContext.Current; })
            .Throws(new BoundaryObservedException());
        var processor = new ContentReprocessProcessor(gateway.Object, Mock.Of<IDocumentService>(),
            new LLMRequestContextAccessor(), NullLogger<ContentReprocessProcessor>.Instance);
        using var unrelated = TaskExecutionContext.Enter(new TaskExecutionIdentity("other-request", "other-run"));
        await Assert.ThrowsAsync<BoundaryObservedException>(() => processor.ProcessAsync(run, _map, new InMemoryRunEventStore()));
        Assert.True(reachedModelBoundary);
        Assert.Equal(storedPermit, observed?.PermitId);
        Assert.Equal(storedPermit == null ? null : run.Id, observed?.RunId);
        Assert.Equal("other-request", TaskExecutionContext.Current!.PermitId);
        gateway.VerifyAll();
    }

    private sealed class BoundaryObservedException : Exception;

    private async Task<GatewayTaskPermitRecord> SeedPermitAsync()
    {
        var permit = new GatewayTaskPermitRecord
        {
            TenantId = GatewayTenantDefaults.InternalTenantId, ActorUserId = "owner",
            Origin = TaskExecutionOrigins.Agent, TriggerCredentialId = "synthetic-agent-key",
            SourceDeployment = TaskPermitDeployment.Resolve(_configuration), SourceTask = "synthetic-approved-action",
            AllowedAppCallerCodes = [Caller], MaxCalls = 3, MaxRuns = 2,
            CreatedAt = DateTime.UtcNow.AddMinutes(-1), ExpiresAt = DateTime.UtcNow.AddMinutes(20),
        };
        await Permits.InsertOneAsync(PlatformExecutionFixture.Prepare(permit));
        return permit;
    }

    public async Task DisposeAsync()
    {
        if (_databaseName.StartsWith("phase1_run_source_synthetic_", StringComparison.Ordinal))
            await new MongoClient(_connection).DropDatabaseAsync(_databaseName);
    }
}
