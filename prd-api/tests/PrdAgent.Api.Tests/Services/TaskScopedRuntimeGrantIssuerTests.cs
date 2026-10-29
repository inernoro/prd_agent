using PrdAgent.Api.Tests.Gateway;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Hosting;
using MongoDB.Bson;
using MongoDB.Driver;
using Moq;
using PrdAgent.Api.Services.BackgroundTasks;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Deployment;
using PrdAgent.Infrastructure.Security;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>只用独立 loopback Mongo 与真实任务核验服务；不会发送模型或 sidecar 请求。</summary>
public sealed class TaskScopedRuntimeGrantIssuerTests : IAsyncLifetime
{
    private const string Caller = AppCallerRegistry.ChatAgent.Conversation;
    private string _connection = "";
    private string _databaseName = "";
    private LlmGatewayDataContext _data = null!;
    private IMongoCollection<GatewayTaskPermitRecord> Permits =>
        _data.Database.GetCollection<GatewayTaskPermitRecord>(GatewayTaskPermitRecord.CollectionName);
    private IMongoCollection<GatewayRuntimeGrantRecord> Grants =>
        _data.Database.GetCollection<GatewayRuntimeGrantRecord>("llmgw_runtime_grants");

    public Task InitializeAsync()
    {
        _connection = Environment.GetEnvironmentVariable("DESIGN_RUN_MONGO_TEST_CONNECTION") ?? "";
        var parsed = new MongoUrl(_connection);
        Assert.Single(parsed.Servers);
        Assert.Equal("127.0.0.1", parsed.Server.Host);
        Assert.Equal(27389, parsed.Server.Port);
        Assert.Null(parsed.Username);
        _databaseName = "phase1_runtime_grant_synthetic_" + Guid.NewGuid().ToString("N");
        _data = new LlmGatewayDataContext(_connection, _databaseName);
        return Task.CompletedTask;
    }

    [DesignScopeMongoFact]
    public async Task IssuedRequest_PreservesSelectedModelAndTrace_AndOnlyExportsShortGatewayKey()
    {
        var configuration = Configuration("http://internal-gateway:8091", "https://actual-cds-serving.example");
        var permit = await SeedPermitAsync(configuration, count: 1);
        var input = Request();
        using var task = TaskExecutionContext.Enter(PlatformExecutionFixture.Identity(permit.Id, "real-task"));
        var prepared = await Issuer(configuration).PrepareAsync(input, default);
        var stored = await Grants.Find(FilterDefinition<GatewayRuntimeGrantRecord>.Empty).SingleAsync();
        var expectedHash = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(
            System.Text.Encoding.UTF8.GetBytes(prepared.ApiKey!))).ToLowerInvariant();

        Assert.Equal(input.Model, prepared.Model);
        Assert.Equal(input.Model, stored.Model);
        Assert.Equal(input.AppCallerCode, prepared.AppCallerCode);
        Assert.Equal(input.AppCallerCode, stored.AppCallerCode);
        Assert.Equal(input.RunId, prepared.RunId);
        Assert.Equal("real-task", stored.RunId);
        Assert.Equal("task-sidecar", stored.Purpose);
        Assert.Equal(permit.Id, stored.TaskPermitId);
        Assert.Equal(permit.TenantId, stored.TenantId);
        Assert.Equal(permit.SourceDeployment, stored.SourceDeployment);
        Assert.Equal("owner", stored.UserId);
        Assert.Equal(2, stored.MaxCalls);
        Assert.Equal(0, stored.CallCount);
        Assert.Equal("https://actual-cds-serving.example", prepared.BaseUrl);
        Assert.Null(prepared.Profile);
        Assert.StartsWith("gwrg_", prepared.ApiKey!);
        Assert.NotEqual(input.ApiKey, prepared.ApiKey);
        Assert.Equal(expectedHash, stored.KeyHash);
        Assert.Equal(expectedHash[..12], stored.KeyPrefix);
        Assert.DoesNotContain(prepared.ApiKey!, stored.ToBsonDocument().ToJson(), StringComparison.Ordinal);
        Assert.DoesNotContain(input.ApiKey!, stored.ToBsonDocument().ToJson(), StringComparison.Ordinal);
        Assert.True(stored.ExpiresAt <= permit.ExpiresAt);
        Assert.True(stored.ExpiresAt <= stored.CreatedAt.AddSeconds(input.TimeoutSeconds));
        Assert.Same(input.Messages, prepared.Messages);
        Assert.Same(input.Tools, prepared.Tools);
        Assert.Same(input.BuiltinTools, prepared.BuiltinTools);
        Assert.Equal(input.CallbackBaseUrl, prepared.CallbackBaseUrl);
        Assert.StartsWith("map-task-v2.", prepared.AgentApiKey);
        Assert.Equal(input.Protocol, prepared.Protocol);
        Assert.Equal(input.RuntimeAdapter, prepared.RuntimeAdapter);
        Assert.Equal(input.MapSessionId, prepared.MapSessionId);
        Assert.Equal(input.TraceId, prepared.TraceId);
        Assert.Equal(input.WorkspaceRoot, prepared.WorkspaceRoot);
        Assert.Equal(input.GitRepository, prepared.GitRepository);
        Assert.Equal(input.GitRef, prepared.GitRef);
        Assert.Equal(input.TimeoutSeconds, prepared.TimeoutSeconds);
        Assert.Equal(input.MaxTokens, prepared.MaxTokens);
        Assert.Equal(input.MaxTurns, prepared.MaxTurns);
        Assert.Equal(input.SystemPrompt, prepared.SystemPrompt);
        Assert.Equal(input.SidecarTag, prepared.SidecarTag);
        Assert.Equal(input.StickyKey, prepared.StickyKey);
        var unchanged = await Permits.Find(item => item.Id == permit.Id).SingleAsync();
        Assert.Equal(1, unchanged.CallCount);
        Assert.Equal(["real-task"], unchanged.BoundRunIds);
        Assert.Equal(1, await Permits.CountDocumentsAsync(FilterDefinition<GatewayTaskPermitRecord>.Empty));
    }

    [DesignScopeMongoFact]
    public async Task DelegatedSubject_RemainsDistinctFromTriggerActor()
    {
        var configuration = Configuration("http://internal-gateway:8091");
        var permit = await SeedPermitAsync(configuration);
        permit.ActorUserId = "administrator";
        permit.AllowDelegatedSubjects = true;
        await Permits.ReplaceOneAsync(item => item.Id == permit.Id, permit);
        using var task = TaskExecutionContext.Enter(PlatformExecutionFixture.Identity(permit.Id, "delegated-task"));
        var prepared = await Issuer(configuration).PrepareAsync(Request(subject: "owner"), default);
        var grant = await Grants.Find(FilterDefinition<GatewayRuntimeGrantRecord>.Empty).SingleAsync();
        var frozen = await Permits.Find(item => item.Id == permit.Id).SingleAsync();
        Assert.Equal("owner", prepared.SubjectUserId);
        Assert.Equal("owner", grant.UserId);
        Assert.Equal("administrator", frozen.ActorUserId);
        Assert.Contains("owner", frozen.SubjectUserIds);
        Assert.Equal(0, frozen.CallCount);
    }

    [DesignScopeMongoFact]
    public async Task ScheduledTask_DefaultsToSoleApprovedBusinessSubject_AndIssuesShortGrant()
    {
        var configuration = ScheduledConfiguration();
        var identity = await AdmitScheduledTaskAsync(configuration);
        var permit = await Permits.Find(item => item.Id == identity.PermitId).SingleAsync();
        Assert.Equal("platform-scheduler:WorkflowScheduleWorker", permit.ActorUserId);
        Assert.Equal(["business-owner"], permit.SubjectUserIds);
        Assert.False(permit.AllowDelegatedSubjects);
        await using var execution = await new TaskExecutionCoordinator(_data).AcquireAsync(identity.PermitId, "scheduled-job-run", default);
        using var task = TaskExecutionContext.Enter(execution.Identity);
        var prepared = await Issuer(configuration).PrepareAsync(Request(subject: null), default);
        var grant = await Grants.Find(FilterDefinition<GatewayRuntimeGrantRecord>.Empty).SingleAsync();
        Assert.StartsWith("gwrg_", prepared.ApiKey!);
        Assert.Equal("business-owner", prepared.SubjectUserId);
        Assert.Equal("business-owner", grant.UserId);
        Assert.Equal(permit.Id, grant.TaskPermitId);
        Assert.Equal("scheduled-job-run", grant.RunId);
        Assert.True(grant.ExpiresAt <= permit.ExpiresAt);
        var unchanged = await Permits.Find(item => item.Id == permit.Id).SingleAsync();
        Assert.Equal(permit.ActorUserId, unchanged.ActorUserId);
        Assert.Equal(["business-owner"], unchanged.SubjectUserIds);
        Assert.Equal(["scheduled-job-run"], unchanged.BoundRunIds);
        Assert.Equal(0, unchanged.CallCount);
    }

    [DesignScopeMongoTheory]
    [InlineData("scheduler-actor", false)]
    [InlineData("unapproved-user", false)]
    [InlineData("business-owner", true)]
    [InlineData("unapproved-user", true)]
    public async Task ScheduledTask_RejectsImplicitActorAndUnapprovedSubjects_WithoutIssuingOrExpanding(
        string subject, bool delegated)
    {
        var configuration = ScheduledConfiguration();
        var identity = await AdmitScheduledTaskAsync(configuration);
        var permit = await Permits.Find(item => item.Id == identity.PermitId).SingleAsync();
        permit.AllowDelegatedSubjects = delegated;
        await Permits.ReplaceOneAsync(item => item.Id == permit.Id, permit);
        await using var execution = await new TaskExecutionCoordinator(_data).AcquireAsync(identity.PermitId, "scheduled-job-run", default);
        using var task = TaskExecutionContext.Enter(execution.Identity);
        var error = await Assert.ThrowsAsync<TaskExecutionAdmissionException>(() => Issuer(configuration).PrepareAsync(
            Request(subject: subject == "scheduler-actor" ? permit.ActorUserId : subject), default));
        Assert.Equal(delegated ? "TASK_PERMIT_INVALID" : "TASK_PERMIT_SUBJECT_DENIED", error.Code);
        Assert.Equal(0, await Grants.CountDocumentsAsync(FilterDefinition<GatewayRuntimeGrantRecord>.Empty));
        var unchanged = await Permits.Find(item => item.Id == permit.Id).SingleAsync();
        Assert.Equal(["business-owner"], unchanged.SubjectUserIds);
        Assert.Equal(["scheduled-job-run"], unchanged.BoundRunIds);
        Assert.Equal(0, unchanged.CallCount);
    }

    [DesignScopeMongoTheory]
    [InlineData("missing-context")]
    [InlineData("missing-run")]
    [InlineData("missing-parent")]
    public async Task NoVerifiedTask_CannotBorrowAuthorityFromRequestOrVendorKey(string missing)
    {
        var configuration = Configuration("http://internal-gateway:8091");
        var permit = await SeedPermitAsync(configuration);
        var identity = missing switch
        {
            "missing-context" => null,
            "missing-run" => new TaskExecutionIdentity(permit.Id),
            _ => new TaskExecutionIdentity(Guid.NewGuid().ToString("N"), "unknown-task"),
        };
        using var task = TaskExecutionContext.Enter(identity);
        await Assert.ThrowsAsync<TaskExecutionAdmissionException>(() => Issuer(configuration).PrepareAsync(Request(), default));
        Assert.Equal(0, await Grants.CountDocumentsAsync(FilterDefinition<GatewayRuntimeGrantRecord>.Empty));
        Assert.Empty((await Permits.Find(item => item.Id == permit.Id).SingleAsync()).BoundRunIds);
    }

    [DesignScopeMongoTheory]
    [InlineData("expired")]
    [InlineData("revoked")]
    [InlineData("exhausted")]
    [InlineData("zero-limit")]
    [InlineData("wrong-deployment")]
    [InlineData("foreign-subject")]
    public async Task InvalidParent_StopsIssuanceAndNeverCreatesUnlimitedFallback(string condition)
    {
        var configuration = Configuration("http://internal-gateway:8091");
        var permit = await SeedPermitAsync(configuration);
        switch (condition)
        {
            case "expired": permit.ExpiresAt = DateTime.UtcNow.AddSeconds(-1); break;
            case "revoked": permit.RevokedAt = DateTime.UtcNow; break;
            case "exhausted": permit.CallCount = permit.MaxCalls; break;
            case "zero-limit": permit.MaxCalls = 0; break;
            case "wrong-deployment": permit.SourceDeployment = "another-deployment"; break;
        }
        await Permits.ReplaceOneAsync(item => item.Id == permit.Id, permit);
        using var task = TaskExecutionContext.Enter(PlatformExecutionFixture.Identity(permit.Id, "real-task"));
        await Assert.ThrowsAsync<TaskExecutionAdmissionException>(() => Issuer(configuration).PrepareAsync(
            Request(subject: condition == "foreign-subject" ? "unapproved-user" : "owner"), default));
        Assert.Equal(0, await Grants.CountDocumentsAsync(FilterDefinition<GatewayRuntimeGrantRecord>.Empty));
        var unchanged = await Permits.Find(item => item.Id == permit.Id).SingleAsync();
        Assert.Equal(permit.CallCount, unchanged.CallCount);
        Assert.Equal(permit.MaxCalls, unchanged.MaxCalls);
    }

    [DesignScopeMongoTheory]
    [InlineData("")]
    [InlineData("ftp://gateway.example")]
    [InlineData("https://user:password@gateway.example")]
    [InlineData("https://gateway.example?api_key=untrusted")]
    [InlineData("https://gateway.example#fragment")]
    [InlineData("https://gateway.example/vendor")]
    public async Task MissingOrInvalidTrustedBase_DoesNotUseProfileVendorOrOriginalKey(string gateway)
    {
        var configuration = Configuration(gateway);
        var permit = await SeedPermitAsync(configuration);
        using var task = TaskExecutionContext.Enter(PlatformExecutionFixture.Identity(permit.Id, "real-task"));
        var error = await Assert.ThrowsAsync<TaskExecutionAdmissionException>(() =>
            Issuer(configuration).PrepareAsync(Request(), default));
        Assert.Equal("TASK_RUNTIME_GATEWAY_UNAVAILABLE", error.Code);
        Assert.Equal(503, error.StatusCode);
        Assert.Equal(0, await Grants.CountDocumentsAsync(FilterDefinition<GatewayRuntimeGrantRecord>.Empty));
        Assert.DoesNotContain("vendor-secret", error.Message, StringComparison.Ordinal);
    }

    [DesignScopeMongoTheory]
    [InlineData(null)]
    [InlineData("{invalid-json")]
    [InlineData("{\"llmgw\":\"https://unselected-api.example\",\"llmgw-web\":\"https://unselected-console.example\"}")]
    public async Task CdsDeclaredConsole_IsTheExactSdkExit_WithoutResolvingServiceAliases(string? serviceTable)
    {
        var configuration = CdsConfiguration("https://platform-declared-gateway.example/", serviceTable);
        var permit = await SeedPermitAsync(configuration);
        using var task = TaskExecutionContext.Enter(PlatformExecutionFixture.Identity(permit.Id, "real-task"));
        var prepared = await Issuer(configuration).PrepareAsync(Request(), default);
        Assert.Equal("https://platform-declared-gateway.example", prepared.BaseUrl);
        Assert.StartsWith("gwrg_", prepared.ApiKey!);
        Assert.Equal("synthetic-project::synthetic-branch", (await Grants.Find(
            FilterDefinition<GatewayRuntimeGrantRecord>.Empty).SingleAsync()).SourceDeployment);
    }

    [DesignScopeMongoTheory]
    [InlineData(null)]
    [InlineData(" ")]
    [InlineData("ftp://platform-declared-gateway.example")]
    [InlineData("https://platform-declared-gateway.example/vendor")]
    public async Task CdsMissingOrInvalidDeclaredConsole_CannotFallBackToInternalDnsOrGuessedHost(string? console)
    {
        var configuration = CdsConfiguration(console,
            "{\"llmgw\":\"https://alias-must-not-be-used.example\",\"llmgw-web\":\"https://other-alias.example\"}");
        var permit = await SeedPermitAsync(configuration);
        using var task = TaskExecutionContext.Enter(PlatformExecutionFixture.Identity(permit.Id, "real-task"));
        var error = await Assert.ThrowsAsync<TaskExecutionAdmissionException>(() =>
            Issuer(configuration).PrepareAsync(Request(), default));
        Assert.Equal("TASK_RUNTIME_GATEWAY_UNAVAILABLE", error.Code);
        Assert.Equal(503, error.StatusCode);
        Assert.Equal(0, await Grants.CountDocumentsAsync(FilterDefinition<GatewayRuntimeGrantRecord>.Empty));
        Assert.Empty((await Permits.Find(item => item.Id == permit.Id).SingleAsync()).BoundRunIds);
    }

    [DesignScopeMongoFact]
    public async Task ExplicitExternalServing_TakesPriorityOverDeclaredConsoleAndInternalServing()
    {
        var configuration = CdsConfiguration("https://platform-declared-gateway.example",
            external: "https://administrator-configured-serving.example/");
        var permit = await SeedPermitAsync(configuration);
        using var task = TaskExecutionContext.Enter(PlatformExecutionFixture.Identity(permit.Id, "real-task"));
        var prepared = await Issuer(configuration).PrepareAsync(Request(), default);
        Assert.Equal("https://administrator-configured-serving.example", prepared.BaseUrl);
    }

    [DesignScopeMongoTheory]
    [InlineData("ftp://administrator-configured-serving.example")]
    [InlineData("https://user:password@administrator-configured-serving.example")]
    public async Task InvalidExplicitExternalServing_FailsClosedEvenWhenConsoleAndServingAreValid(string external)
    {
        var configuration = CdsConfiguration("https://platform-declared-gateway.example", external: external);
        var permit = await SeedPermitAsync(configuration);
        using var task = TaskExecutionContext.Enter(PlatformExecutionFixture.Identity(permit.Id, "real-task"));
        var error = await Assert.ThrowsAsync<TaskExecutionAdmissionException>(() =>
            Issuer(configuration).PrepareAsync(Request(), default));
        Assert.Equal("TASK_RUNTIME_GATEWAY_UNAVAILABLE", error.Code);
        Assert.Equal(0, await Grants.CountDocumentsAsync(FilterDefinition<GatewayRuntimeGrantRecord>.Empty));
    }

    [DesignScopeMongoFact]
    public async Task RepeatedPreparation_BindsOnceAndDoesNotRefillParentBudget()
    {
        var configuration = Configuration("http://internal-gateway:8091", "");
        var permit = await SeedPermitAsync(configuration, count: 2);
        using var task = TaskExecutionContext.Enter(PlatformExecutionFixture.Identity(permit.Id, "real-task"));
        var first = await Issuer(configuration).PrepareAsync(Request(), default);
        var second = await Issuer(configuration).PrepareAsync(Request(), default);
        Assert.NotEqual(first.ApiKey, second.ApiKey);
        Assert.Equal("http://internal-gateway:8091", first.BaseUrl);
        Assert.All(await Grants.Find(FilterDefinition<GatewayRuntimeGrantRecord>.Empty).ToListAsync(),
            item => Assert.Equal(1, item.MaxCalls));
        var unchanged = await Permits.Find(item => item.Id == permit.Id).SingleAsync();
        Assert.Equal(["real-task"], unchanged.BoundRunIds);
        Assert.Equal(2, unchanged.CallCount);
        Assert.Equal(1, await Permits.CountDocumentsAsync(FilterDefinition<GatewayTaskPermitRecord>.Empty));
    }

    private TaskScopedRuntimeGrantIssuer Issuer(IConfiguration configuration)
    {
        var host = new Mock<IHostEnvironment>();
        host.SetupGet(item => item.EnvironmentName).Returns("Production");
        return new(_data, new TaskExecutionAuthorizer(_data, configuration), configuration, host.Object,
            new TaskContinuationTokens(new Microsoft.AspNetCore.DataProtection.EphemeralDataProtectionProvider(), new TaskExecutionCoordinator(_data)));
    }

    private async Task<GatewayTaskPermitRecord> SeedPermitAsync(IConfiguration configuration, int count = 0)
    {
        var permit = new GatewayTaskPermitRecord
        {
            TenantId = GatewayTenantDefaults.InternalTenantId, ActorUserId = "owner",
            TriggerCredentialId = "synthetic-session", Origin = TaskExecutionOrigins.Interactive,
            SourceDeployment = TaskPermitDeployment.Resolve(configuration), SourceTask = "synthetic-sidecar-operation",
            AllowedAppCallerCodes = [Caller], MaxCalls = 3, CallCount = count, MaxRuns = 2,
            CreatedAt = DateTime.UtcNow.AddMinutes(-1), ExpiresAt = DateTime.UtcNow.AddMinutes(5),
        };
        await Permits.InsertOneAsync(PlatformExecutionFixture.Prepare(permit));
        return permit;
    }

    private static IConfiguration Configuration(string serving, string? external = null) => new ConfigurationBuilder()
        .AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["LlmGateway:ServeBaseUrl"] = serving, ["LlmGateway:ExternalServingBaseUrl"] = external,
        }).Build();

    private static IConfiguration ScheduledConfiguration() => new ConfigurationBuilder()
        .AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["LlmGateway:ServeBaseUrl"] = "http://internal-gateway:8091",
            ["Deployment:Identity"] = "synthetic-scheduler-deployment",
            ["Deployment:SharedScheduledWorkEnabled"] = "true",
        }).Build();

    private async Task<TaskExecutionIdentity> AdmitScheduledTaskAsync(IConfiguration configuration)
    {
        using var deployment = AutomaticTaskExecutionContext.Enter("synthetic/WorkflowScheduleWorker/authority");
        return await new TaskAdmissionService(_data, configuration).AdmitScheduledTaskAsync(
            "WorkflowScheduleWorker", "stored-job", "business-owner", default);
    }

    private static IConfiguration CdsConfiguration(string? console, string? serviceTable = null, string? external = null)
        => new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["LlmGateway:ServeBaseUrl"] = "http://internal-gateway:8091",
            ["LlmGateway:ExternalServingBaseUrl"] = external,
            ["CDS_PROJECT_ID"] = "synthetic-project", ["VITE_GIT_BRANCH"] = "synthetic-branch",
            [PlatformEntrypoints.ConsoleUrlKey] = console,
            [PlatformEntrypoints.ServiceUrlsKey] = serviceTable,
            [PlatformEntrypoints.PreviewUrlKey] = "https://map-main-entry-must-not-be-used.example",
        }).Build();

    private static SidecarRunRequest Request(string? subject = "owner") => new()
    {
        RunId = "sdk-trace", SubjectUserId = subject, Model = "claude-opus-4-5",
        AppCallerCode = Caller, BaseUrl = "https://vendor.example", ApiKey = "vendor-secret",
        Profile = "vendor-profile", Protocol = "anthropic", SystemPrompt = "既有系统提示词",
        Messages = [new SidecarChatMessage { Role = "user", Content = "正常任务" }],
        Tools = [new SidecarToolDef { Name = "existing-tool" }], BuiltinTools = [],
        MaxTokens = 4096, MaxTurns = 8, TimeoutSeconds = 300,
        CallbackBaseUrl = "http://map", AgentApiKey = "tool-callback-key", SidecarTag = "trusted-runtime",
        StickyKey = "sticky-session", RuntimeAdapter = "claude-agent-sdk", MapSessionId = "session",
        TraceId = "trace", WorkspaceRoot = "/workspace", GitRepository = "repository", GitRef = "branch",
    };

    public async Task DisposeAsync()
    {
        if (_databaseName.StartsWith("phase1_runtime_grant_synthetic_", StringComparison.Ordinal))
            await new MongoClient(_connection).DropDatabaseAsync(_databaseName);
    }
}
