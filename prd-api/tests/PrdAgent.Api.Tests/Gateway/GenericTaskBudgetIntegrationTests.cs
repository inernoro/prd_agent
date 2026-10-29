using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Driver;
using Moq;
using PrdAgent.Api.Services.BackgroundTasks;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.Security;
using PrdAgent.LlmGatewayHost;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

/// <summary>独占合成Mongo和假HTTP验证平台金额合同，无供应商或共享业务库。</summary>
[Trait("Category", "Integration")]
public sealed class GenericTaskBudgetIntegrationTests
{
    private const string Caller = AppCallerRegistry.Admin.Lab.Chat;
    private const string OtherCaller = AppCallerRegistry.Admin.ModelLab.Run;

    [Fact]
    public async Task RequiredContractRejectsMissingPolicyWithoutCreatingBudget()
    {
        await using var db = new Database();
        var ex = await Assert.ThrowsAsync<TaskExecutionAdmissionException>(() => TaskBudgetContracts.BindAsync(
            Permit(), Config(required: true, policy: false), db.Context, default));
        Assert.Equal("TASK_BUDGET_POLICY_REQUIRED", ex.Code);
        Assert.Equal(0, await db.Scopes.CountDocumentsAsync(FilterDefinition<GatewayRuntimeBudgetScopeRecord>.Empty));
    }

    [Fact]
    public async Task SameIntentKeepsOriginalFrozenContractAndSpentAfterPolicyChange()
    {
        await using var db = new Database();
        var permit = Permit();
        await TaskBudgetContracts.BindAsync(permit, Config(), db.Context, default);
        await db.Scopes.UpdateOneAsync(x => x.Id == permit.BudgetScopeId,
            Builders<GatewayRuntimeBudgetScopeRecord>.Update.Set(x => x.SpentUsd, 0.003m));
        var changed = Config(limit: 500m, rate: 100m);
        await TaskBudgetContracts.BindAsync(permit, changed, db.Context, default);
        var scope = await db.Scopes.Find(x => x.Id == permit.BudgetScopeId).SingleAsync();
        Assert.Equal(0.02m, scope.AuthorizedLimitUsd);
        Assert.Equal(1m, scope.InputUsdPerMillion);
        Assert.Equal(0.003m, scope.SpentUsd);
        Assert.Equal("synthetic-price-v1", scope.PriceVersion);
    }

    [Fact]
    public async Task GenericLedgerRejectsAnotherPermitBeforeReservingMoney()
    {
        await using var db = new Database();
        var permit = await db.Bind();
        var result = await new GatewayRuntimeGrantCallCounter(db.Context).TryReserveTaskAsync(
            Request(permit, "forged") with { TaskPermitId = new string('f', 32) }, default);
        Assert.False(result.Allowed);
        Assert.Equal("GATEWAY_TASK_BUDGET_BINDING_INVALID", result.ErrorCode);
        Assert.Empty((await db.Scope(permit)).Reservations);
    }

    [Fact]
    public async Task CacheSettlementUsesSharedCalculatorAndFrozenReservationPrices()
    {
        await using var db = new Database();
        var permit = await db.Bind();
        var counter = new GatewayRuntimeGrantCallCounter(db.Context);
        var request = Request(permit, "cache");
        Assert.True((await counter.TryReserveTaskAsync(request, default)).Allowed);
        await db.Scopes.UpdateOneAsync(x => x.Id == permit.BudgetScopeId,
            Builders<GatewayRuntimeBudgetScopeRecord>.Update.Set(x => x.InputUsdPerMillion, 100m)
                .Set(x => x.OutputUsdPerMillion, 100m).Set(x => x.CacheWriteUsdPerMillion, 100m));
        await counter.FinalizeTaskAsync(request, new GatewayTokenUsage
        { InputTokens = 100, OutputTokens = 20, CacheReadInputTokens = 80, CacheCreationInputTokens = 10,
            CacheCreationCountedInsideInput = true, Source = "response_body" }, "succeeded", default);
        var result = await db.Scope(permit);
        Assert.Equal(0.000078m, result.SpentUsd); // 10*1 + 80*0.1 + 10*2 + 20*2, per million.
        Assert.Equal(0m, result.ReservedUsd);
        Assert.Equal("settled", Assert.Single(result.Reservations).Status);
    }

    [Fact]
    public async Task ConcurrentInstancesShareFiniteMoneyAndDuplicateRequestCannotSendTwice()
    {
        await using var db = new Database();
        var permit = await db.Bind();
        // 100 body bytes *4 +4096 envelope, max cache/input rate2, output10 *2 = .009012.
        await db.Scopes.UpdateOneAsync(x => x.Id == permit.BudgetScopeId,
            Builders<GatewayRuntimeBudgetScopeRecord>.Update.Set(x => x.AuthorizedLimitUsd, 0.018024m));
        var results = await Task.WhenAll(Enumerable.Range(0, 20).Select(i =>
            new GatewayRuntimeGrantCallCounter(db.Context).TryReserveTaskAsync(Request(permit, $"r-{i}"), default)));
        Assert.Equal(2, results.Count(x => x.Allowed));
        var scope = await db.Scope(permit);
        Assert.Equal(0.018024m, scope.ReservedUsd);
        var repeated = Request(permit, scope.Reservations[0].RequestId);
        Assert.Equal("GATEWAY_RUNTIME_TASK_REQUEST_DUPLICATE",
            (await new GatewayRuntimeGrantCallCounter(db.Context).TryReserveTaskAsync(repeated, default)).ErrorCode);
    }

    [Fact]
    public async Task PhysicalRequestEnvelopeCannotExceedSignedPermitCallLimit()
    {
        await using var db = new Database();
        var permit = Permit(); permit.MaxCalls = 1;
        await TaskBudgetContracts.BindAsync(permit, Config(limit: 1m), db.Context, default);
        var results = await Task.WhenAll(Enumerable.Range(0, 10).Select(i =>
            new GatewayRuntimeGrantCallCounter(db.Context).TryReserveTaskAsync(Request(permit, $"call-{i}"), default)));
        Assert.Equal(1, results.Count(x => x.Allowed));
        Assert.Single((await db.Scope(permit)).Reservations);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task AnyRegisteredBusinessUsesPhysicalBudgetWithoutBusinessBudgetField(bool stream)
    {
        await using var db = new Database();
        var (gateway, inner, permit, context, http, paid) = await Build(db);
        foreach (var caller in new[] { Caller, OtherCaller })
        {
            http.Items[GatewayInvocationAuthority.AdmittedCallerKey] = caller;
            var request = new GatewayRequest { AppCallerCode = caller, ModelType = ModelTypes.Chat,
                Context = CopyContext(context, Guid.NewGuid().ToString("N")),
                RequestBody = new JsonObject { ["messages"] = new JsonArray { new JsonObject { ["role"] = "user", ["content"] = "synthetic" } } } };
            if (stream)
            {
                var done = false;
                string? error = null;
                await foreach (var chunk in gateway.StreamAsync(request))
                { if (chunk.Type == GatewayChunkType.Error) error = $"{chunk.ErrorCode}: {chunk.Error}";
                    if (chunk.Type == GatewayChunkType.Done) { done = true; break; } }
                Assert.True(done, error);
            }
            else
            {
                var response = await gateway.SendAsync(request);
                Assert.True(response.Success, $"{response.ErrorCode}: {response.ErrorMessage}");
            }
        }
        var scope = await db.Scope(permit);
        Assert.Equal(2, paid.Count);
        Assert.Equal(2, scope.Reservations.Count);
        Assert.All(scope.Reservations, r => { Assert.Equal("settled", r.Status); Assert.Equal("synthetic-price-v1", r.PriceVersion); });
        Assert.Equal(0.00005m, scope.SpentUsd);
        Assert.Equal(0m, scope.ReservedUsd);
        // 漏写平台包装器也不能借同一请求的金额事实重复发送。
        var bypass = await inner.SendAsync(new GatewayRequest { AppCallerCode = OtherCaller, ModelType = ModelTypes.Chat,
            Context = CopyContext(context, "bypass"), RequestBody = new JsonObject { ["max_tokens"] = 10 } });
        Assert.False(bypass.Success);
        Assert.Equal("GATEWAY_TASK_BUDGET_PHYSICAL_ADMISSION_REQUIRED", bypass.ErrorCode);
        Assert.Equal(2, paid.Count);
    }

    [Theory]
    [InlineData("media")]
    [InlineData("n")]
    [InlineData("route")]
    public async Task UnpricedOrMismatchedPhysicalRequestHasZeroUpstream(string variant)
    {
        await using var db = new Database();
        var (gateway, _, permit, context, _, paid) = await Build(db);
        var body = new JsonObject { ["messages"] = new JsonArray() };
        if (variant == "media") body["input_audio"] = new JsonObject();
        if (variant == "n") body["n"] = 2;
        if (variant == "route") await db.Scopes.UpdateOneAsync(x => x.Id == permit.BudgetScopeId,
            Builders<GatewayRuntimeBudgetScopeRecord>.Update.Set(x => x.ExpectedModel, "different"));
        var response = await gateway.SendAsync(new GatewayRequest { AppCallerCode = Caller, ModelType = ModelTypes.Chat,
            Context = context, RequestBody = body });
        Assert.False(response.Success);
        Assert.Equal(0, paid.Count);
        Assert.Empty((await db.Scope(permit)).Reservations);
    }

    private static GatewayTaskBudgetRequest Request(GatewayTaskPermitRecord p, string requestId) => new(
        p.BudgetScopeId!, p.TenantId, p.ActorUserId, p.Id, Caller, p.Id, requestId, 100, 10,
        "synthetic-logical", "Synthetic", "synthetic-model", null, TaskPermitId: p.Id, Protocol: "openai");

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task RevocationAfterReservationReleasesMoneyWithZeroPhysicalSend(bool stream)
    {
        await using var db = new Database();
        var (gateway, _, permit, context, _, paid) = await Build(db, revokeAfterReservation: true);
        var request = new GatewayRequest { AppCallerCode = Caller, ModelType = ModelTypes.Chat,
            Context = context, RequestBody = new JsonObject { ["messages"] = new JsonArray() } };
        if (stream)
        {
            var rejected = false;
            await foreach (var chunk in gateway.StreamAsync(request))
                if (chunk is GatewayStreamRejectedBeforeSend) rejected = true;
            Assert.True(rejected);
        }
        else Assert.IsType<GatewaySendRejectedBeforeSend>(await gateway.SendAsync(request));
        var scope = await db.Scope(permit);
        Assert.Equal(0, paid.Count);
        Assert.Equal(0m, scope.ReservedUsd);
        Assert.Equal(0m, scope.SpentUsd);
        Assert.Equal("released-before-send", Assert.Single(scope.Reservations).Status);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task LostProviderOutcomeKeepsMoneyAndCannotReplaySamePhysicalRequest(bool stream)
    {
        await using var db = new Database();
        var (gateway, _, permit, context, _, paid) = await Build(db, loseOutcome: true);
        var request = new GatewayRequest { AppCallerCode = Caller, ModelType = ModelTypes.Chat,
            Context = context, RequestBody = new JsonObject { ["messages"] = new JsonArray() } };
        for (var attempt = 0; attempt < 2; attempt++)
        {
            if (stream) { await foreach (var _ in gateway.StreamAsync(request)) { } }
            else Assert.False((await gateway.SendAsync(request)).Success);
        }
        var scope = await db.Scope(permit);
        Assert.Equal(1, paid.Count);
        Assert.Equal("settled-unknown", Assert.Single(scope.Reservations).Status);
        Assert.True(scope.SpentUsd > 0);
        Assert.Equal(0m, scope.ReservedUsd);
    }

    [Fact]
    public async Task NativeResponsesUsesSameGenericLedgerAndUsageSettlement()
    {
        await using var db = new Database();
        var (gateway, _, permit, context, _, paid) = await Build(db);
        var response = await gateway.SendNativeResponsesWithResolutionAsync(new GatewayRawRequest
        {
            AppCallerCode = Caller, ModelType = ModelTypes.Chat, EndpointPath = "/v1/responses", Context = context,
            RequestBody = new JsonObject { ["input"] = "synthetic", ["stream"] = false, ["store"] = false },
        }, new GatewayModelResolution { Success = true, ActualModel = "synthetic-model", ActualPlatformId = "synthetic-platform",
            ActualPlatformName = "Synthetic", LogicalModelPublicId = "synthetic-logical", PlatformType = "openai", Protocol = "openai",
            ApiUrl = "https://upstream.invalid", ApiKey = "synthetic", ResolutionType = "PinnedModel" }, (_, _) => Task.CompletedTask);
        Assert.True(response.Success, $"{response.ErrorCode}: {response.ErrorMessage}");
        Assert.Equal(1, paid.Count);
        var scope = await db.Scope(permit);
        Assert.Equal(0.000025m, scope.SpentUsd);
        Assert.Equal("settled", Assert.Single(scope.Reservations).Status);
    }

    [Fact]
    public async Task ExistingPptCompletionContractUsesOriginalLedgerWithoutGenericDoubleReservation()
    {
        await using var db = new Database();
        var (gateway, _, permit, context, http, paid) = await Build(db);
        const string run = "synthetic-ppt-outline";
        var caller = AppCallerRegistry.MdToPptAgent.Generation.Outline;
        permit.AllowedAppCallerCodes.Add(caller); permit.BoundRunIds.Add(run);
        await db.Context.Database.GetCollection<GatewayTaskPermitRecord>(GatewayTaskPermitRecord.CollectionName)
            .UpdateOneAsync(x => x.Id == permit.Id, Builders<GatewayTaskPermitRecord>.Update
                .Set(x => x.AllowedAppCallerCodes, permit.AllowedAppCallerCodes).Set(x => x.BoundRunIds, permit.BoundRunIds));
        http.Items[GatewayInvocationAuthority.AdmittedCallerKey] = caller;
        var legacy = new GatewayRuntimeBudgetScopeRecord
        {
            Id = "synthetic-ppt-contract", TenantId = permit.TenantId, UserId = permit.ActorUserId,
            RootOutlineRunId = run, AuthorizedLimitUsd = .1m, MaxOutputTokens = 100,
            InputUsdPerMillion = 1m, OutputUsdPerMillion = 2m, LongContextThresholdTokens = long.MaxValue,
            LongContextInputUsdPerMillion = 1m, LongContextOutputUsdPerMillion = 2m,
            InputByteTokenMultiplier = 4, ExpectedLogicalModelPublicId = "synthetic-logical",
            ExpectedProvider = "Synthetic", ExpectedModel = "synthetic-model", ExpiresAt = DateTime.UtcNow.AddHours(1),
            PptCompletion = new GatewayPptCompletionBudgetRecord { Id = "synthetic-completion", FutureHeldUsd = .01m },
        };
        await db.Scopes.InsertOneAsync(legacy);
        var accessor = new Mock<IHttpContextAccessor>(); accessor.SetupGet(x => x.HttpContext).Returns(http);
        var counter = new GatewayRuntimeGrantCallCounter(db.Context, accessor.Object);
        GatewayTaskBudgetRequest? reservation = null;
        GatewayTokenUsage? usage = null;
        var request = new GatewayRequest { AppCallerCode = caller, ModelType = ModelTypes.Chat,
            Context = CopyContext(context, "ppt-physical", run, legacy.Id),
            RequestBody = new JsonObject { ["messages"] = new JsonArray(), ["max_tokens"] = 100 } };
        await foreach (var chunk in gateway.StreamWithAdmissionAsync(request, async (physical, token) =>
        {
            reservation = new GatewayTaskBudgetRequest(legacy.Id, permit.TenantId, permit.ActorUserId, run, caller,
                $"outline:{run}", physical.RequestId, physical.RequestBodyUtf8Bytes, physical.EffectiveMaxOutputTokens,
                physical.LogicalModelPublicId, physical.Provider, physical.Model, physical.OfferingId);
            var result = await counter.TryReserveTaskAsync(reservation, token);
            return result.Allowed ? null : GatewayStreamChunk.Fail(result.Detail, result.ErrorCode);
        }))
        { if (chunk.Type == GatewayChunkType.Done) { usage = chunk.TokenUsage; break; } }
        Assert.NotNull(usage);
        await counter.FinalizeTaskAsync(reservation!, usage, "succeeded", default);
        var dedicated = await db.Scopes.Find(x => x.Id == legacy.Id).SingleAsync();
        Assert.Equal(1, paid.Count);
        Assert.Equal(.000025m, dedicated.SpentUsd);
        Assert.Equal(.01m, dedicated.PptCompletion!.FutureHeldUsd);
        Assert.Single(dedicated.Reservations);
        Assert.Empty((await db.Scope(permit)).Reservations);
        // 有效PPT合同本身不是发送权；业务漏写真实预占仍在物理出口被拒。
        var rejected = false;
        await foreach (var chunk in gateway.StreamWithAdmissionAsync(new GatewayRequest
        { AppCallerCode = caller, ModelType = ModelTypes.Chat, Context = CopyContext(context, "ppt-bypass", run, legacy.Id),
            RequestBody = request.RequestBody }, (_, _) => Task.FromResult<GatewayStreamChunk?>(null)))
            if (chunk is GatewayStreamRejectedBeforeSend) rejected = true;
        Assert.True(rejected);
        Assert.Equal(1, paid.Count);
    }
    private static GatewayTaskPermitRecord Permit() => new()
    { Id = Guid.NewGuid().ToString("N"), TenantId = GatewayTenantDefaults.InternalTenantId, ActorUserId = "synthetic-owner",
        Origin = TaskExecutionOrigins.Interactive, SubjectUserIds = new() { "synthetic-owner" },
        TriggerCredentialId = "synthetic-session", SourceDeployment = "prd-agent:production", SourceTask = "synthetic-task",
        AllowedAppCallerCodes = new() { Caller, OtherCaller }, MaxCalls = 20, MaxRuns = 2,
        RequestFingerprint = new string('a', 64), BusinessKeyHash = new string('b', 64),
        ExecutionContractVersion = TaskExecutionCoordinator.ContractVersion, ExpiresAt = DateTime.UtcNow.AddHours(1) };
    private static IConfiguration Config(bool required = true, bool policy = true, decimal limit = .02m, decimal rate = 1m)
    {
        var values = new Dictionary<string, string?> { ["LlmGateway:TaskBudgets:Required"] = required.ToString() };
        if (policy)
        {
            const string root = "LlmGateway:TaskBudgets:Policies:interactive:";
            foreach (var kv in new Dictionary<string, string> { ["AuthorizedLimitUsd"] = limit.ToString(System.Globalization.CultureInfo.InvariantCulture),
                ["InputUsdPerMillion"] = rate.ToString(System.Globalization.CultureInfo.InvariantCulture), ["OutputUsdPerMillion"] = "2",
                ["CachedInputUsdPerMillion"] = "0.1", ["CacheWriteUsdPerMillion"] = "2", ["MaxOutputTokens"] = "100",
                ["LogicalModelPublicId"] = "synthetic-logical", ["Provider"] = "Synthetic", ["Model"] = "synthetic-model",
                ["Protocol"] = "openai", ["PriceVersion"] = "synthetic-price-v1" }) values[root + kv.Key] = kv.Value;
        }
        return new ConfigurationBuilder().AddInMemoryCollection(values).Build();
    }

    private static async Task<(TaskBudgetGateway Gateway, LlmGateway Inner, GatewayTaskPermitRecord Permit,
        GatewayRequestContext Context, DefaultHttpContext Http, FakeUpstream Paid)> Build(Database db,
        bool revokeAfterReservation = false, bool loseOutcome = false)
    {
        var p = await db.Bind();
        var executions = new TaskExecutionCoordinator(db.Context);
        var registered = await executions.RegisterAsync(p, true, default);
        var proof = registered.Lease!.Identity.Lease!;
        var hash = TaskExecutionCoordinator.OwnerHash(proof.OwnerToken);
        var context = new GatewayRequestContext { RequestId = "request", TenantId = p.TenantId, UserId = p.ActorUserId,
            ServiceKeyId = "synthetic-key", SourceSystem = "map", SourceDeployment = p.SourceDeployment, SourceTask = p.SourceTask,
            ExecutionOrigin = p.Origin, TriggerActorUserId = p.ActorUserId, TriggerCredentialId = p.TriggerCredentialId,
            TaskPermitId = p.Id, TaskLeaseRunId = proof.RunId ?? "", TaskLeaseOwnerHash = hash, TaskLeaseFence = proof.Fence };
        var http = new DefaultHttpContext();
        http.Items[GatewayTaskAdmission.HttpContextPermitKey] = p;
        http.Items[GatewayTaskAdmission.HttpContextLeaseKey] = new GatewayTaskLeaseFact(p.Id, proof.RunId ?? "", hash, proof.Fence);
        http.Items[GatewayTaskAdmission.HttpContextSubjectKey] = p.ActorUserId;
        http.Items[GatewayInvocationAuthority.PaidAdmissionKey] = true;
        http.Items[GatewayInvocationAuthority.AdmittedCallerKey] = Caller;
        http.Items["llmgw.key.authorization"] = new GatewayKeyAuthorization(true, true, 200, "", "", KeyId: "synthetic-key", TenantId: p.TenantId, LegacySharedKey: true);
        var accessorMock = new Mock<IHttpContextAccessor>();
        accessorMock.SetupGet(x => x.HttpContext).Returns(http);
        var accessor = accessorMock.Object;
        var resolver = new Mock<IModelResolver>();
        resolver.Setup(x => x.ResolveAsync(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<string?>(), It.IsAny<string?>(), It.IsAny<string?>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync(new ModelResolutionResult { Success = true, ActualModel = "synthetic-model", ActualPlatformId = "synthetic-platform",
                ActualPlatformName = "Synthetic", LogicalModelPublicId = "synthetic-logical", PlatformType = "openai", Protocol = "openai",
                ApiUrl = "https://upstream.invalid", ApiKey = "synthetic", ResolutionType = "PinnedModel" });
        var upstream = new FakeUpstream { LoseOutcome = loseOutcome };
        var inner = new LlmGateway(resolver.Object, upstream, NullLogger<LlmGateway>.Instance,
            invocationAuthority: new GatewayInvocationAuthority(accessor, Config(), executions));
        IGatewayRuntimeGrantCallCounter counter = new GatewayRuntimeGrantCallCounter(db.Context);
        if (revokeAfterReservation) counter = new RevokingCounter(counter, db.Context);
        return (new TaskBudgetGateway(inner, accessor, db.Context, counter), inner, p, context, http, upstream);
    }
    private static GatewayRequestContext CopyContext(GatewayRequestContext p, string requestId, string? run = null, string? budget = null) => new()
    { RequestId = requestId, TenantId = p.TenantId, UserId = p.UserId, ServiceKeyId = p.ServiceKeyId, SourceSystem = p.SourceSystem,
        SourceDeployment = p.SourceDeployment, SourceTask = p.SourceTask, ExecutionOrigin = p.ExecutionOrigin,
        TriggerActorUserId = p.TriggerActorUserId, TriggerCredentialId = p.TriggerCredentialId, TaskPermitId = p.TaskPermitId,
        TaskLeaseRunId = p.TaskLeaseRunId, TaskLeaseOwnerHash = p.TaskLeaseOwnerHash, TaskLeaseFence = p.TaskLeaseFence,
        RunId = run ?? p.RunId, TaskBudgetScopeId = budget };
    private sealed class FakeUpstream : HttpMessageHandler, IHttpClientFactory
    {
        public int Count;
        public bool LoseOutcome;
        public HttpClient CreateClient(string name) => new(this, disposeHandler: false);
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Interlocked.Increment(ref Count);
            if (LoseOutcome) throw new HttpRequestException("synthetic provider outcome lost");
            var body = JsonNode.Parse(await request.Content!.ReadAsStringAsync(ct))!;
            if (request.RequestUri!.AbsolutePath.EndsWith("/responses"))
                return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(
                    "{\"id\":\"resp_synthetic\",\"object\":\"response\",\"status\":\"completed\",\"output\":[],\"usage\":{\"input_tokens\":11,\"output_tokens\":7}}", Encoding.UTF8, "application/json") };
            var stream = body["stream"]?.GetValue<bool>() == true;
            var text = stream ? "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":11,\"completion_tokens\":7}}\n\ndata: [DONE]\n\n"
                : "{\"choices\":[{\"message\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":11,\"completion_tokens\":7}}";
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(text, Encoding.UTF8, stream ? "text/event-stream" : "application/json") };
        }
    }
    private sealed class RevokingCounter(IGatewayRuntimeGrantCallCounter inner, LlmGatewayDataContext data) : IGatewayRuntimeGrantCallCounter
    {
        public async Task<GatewayRuntimeGrantCallAdmission> TryReserveTaskAsync(GatewayTaskBudgetRequest request, CancellationToken ct)
        {
            var result = await inner.TryReserveTaskAsync(request, ct);
            if (result.Allowed) await data.Database.GetCollection<GatewayTaskPermitRecord>(GatewayTaskPermitRecord.CollectionName)
                .UpdateOneAsync(x => x.Id == request.TaskPermitId, Builders<GatewayTaskPermitRecord>.Update.Set(x => x.RevokedAt, DateTime.UtcNow), cancellationToken: ct);
            return result;
        }
        public Task FinalizeTaskAsync(GatewayTaskBudgetRequest request, GatewayTokenUsage? usage, string outcome, CancellationToken ct)
            => inner.FinalizeTaskAsync(request, usage, outcome, ct);
        public Task<GatewayTaskBudgetPolicy?> ResolveTaskPolicyAsync(string scope, string tenant, string user, string run, string caller, CancellationToken ct)
            => inner.ResolveTaskPolicyAsync(scope, tenant, user, run, caller, ct);
        public Task<GatewayRuntimeGrantCallAdmission> TryReserveAsync(GatewayRuntimeGrantRecord grant, GatewayRuntimeGrantCallRequest request, CancellationToken ct)
            => inner.TryReserveAsync(grant, request, ct);
        public Task FinalizeAsync(GatewayRuntimeGrantRecord grant, string requestId, GatewayTokenUsage? usage, string outcome, CancellationToken ct)
            => inner.FinalizeAsync(grant, requestId, usage, outcome, ct);
    }
    private sealed class Database : IAsyncDisposable
    {
        // 只取显式回归连接；未提供时使用该任务独占回环端口，不接触默认业务实例。
        private readonly MongoClient _client;
        public LlmGatewayDataContext Context { get; }
        public IMongoCollection<GatewayRuntimeBudgetScopeRecord> Scopes => Context.Database.GetCollection<GatewayRuntimeBudgetScopeRecord>("llmgw_runtime_budget_scopes");
        public Database()
        {
            var connection = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION") ?? "mongodb://127.0.0.1:27389";
            _client = new MongoClient(connection);
            Context = new LlmGatewayDataContext(connection, $"generic_task_budget_test_{Guid.NewGuid():N}");
        }
        public async Task<GatewayTaskPermitRecord> Bind()
        { var p = Permit(); await TaskBudgetContracts.BindAsync(p, Config(), Context, default); return p; }
        public Task<GatewayRuntimeBudgetScopeRecord> Scope(GatewayTaskPermitRecord p) => Scopes.Find(x => x.Id == p.BudgetScopeId).SingleAsync();
        public async ValueTask DisposeAsync() => await _client.DropDatabaseAsync(Context.DatabaseName);
    }
}
