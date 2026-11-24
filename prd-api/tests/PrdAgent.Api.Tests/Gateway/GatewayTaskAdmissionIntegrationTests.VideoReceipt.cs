using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Driver;
using Moq;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.Security;
using PrdAgent.LlmGatewayHost;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

public sealed partial class GatewayTaskAdmissionIntegrationTests
{
    private const string VideoCaller = AppCallerRegistry.VideoAgent.VideoGen.Generate;
    private static readonly VideoReceiptTarget ReceiptTarget = new("server-actor", VideoCaller, "original-job", "original-model", "original-offering");

    private static GatewayRawRequest ReceiptRequest(string variant = "status") => new()
    {
        AppCallerCode = variant == "caller" ? Caller : VideoCaller,
        ModelType = variant == "type" ? ModelTypes.Chat : ModelTypes.VideoGen,
        EndpointPath = variant switch { "job" => "/videos/other-job", "download" => "/videos/original-job/content?index=0", _ => "/videos/original-job" },
        HttpMethod = variant == "submit" ? "POST" : "GET",
        RequiredOfferingId = variant == "offering" ? "other-offering" : "original-offering",
        RequestBody = variant == "body" ? new JsonObject { ["prompt"] = "must-not-generate" } : null,
        ExpectBinaryResponse = variant == "binary", IsMultipart = variant == "multipart",
        ExtraHeaders = variant == "headers" ? new Dictionary<string, string> { ["Authorization"] = "forged" } : null,
        Context = new GatewayRequestContext { UserId = "server-actor", RunId = "original-run", SourceSystem = "map" }
    };

    private static async Task<(GatewayTaskPermitRecord Permit, TaskExecutionCoordinator Coordinator, TaskExecutionLease Receipt)> ReceiptPermit(TestDatabase database, int maxCalls = 2)
    {
        var coordinator = new TaskExecutionCoordinator(database.Data);
        var permit = new GatewayTaskPermitRecord
        {
            Id = TaskExecutionCoordinator.BusinessId(GatewayTenantDefaults.InternalTenantId, "server-actor", "video-receipt", Guid.NewGuid().ToString("N")),
            ExecutionContractVersion = TaskExecutionCoordinator.ContractVersion,
            BusinessKeyHash = TaskExecutionCoordinator.Fingerprint(Guid.NewGuid().ToString("N")),
            RequestFingerprint = TaskExecutionCoordinator.Fingerprint("video-receipt"),
            TenantId = GatewayTenantDefaults.InternalTenantId, ActorUserId = "server-actor", SubjectUserIds = ["server-actor"],
            TriggerCredentialId = "server-session", Origin = TaskExecutionOrigins.Interactive,
            SourceDeployment = "prd-agent:production", SourceTask = "video-receipt", AllowedAppCallerCodes = [VideoCaller],
            MaxCalls = maxCalls, MaxRuns = 1, CreatedAt = DateTime.UtcNow, ExpiresAt = DateTime.UtcNow.AddMinutes(5)
        };
        await coordinator.RegisterAsync(permit, false, default);
        await using var generation = await coordinator.AcquireAsync(permit.Id, "original-run", default);
        await coordinator.BindVideoReceiptAsync(permit.Id, "original-run", ReceiptTarget, permit.TenantId, default);
        await coordinator.RevokeAsync(permit.Id, "original-run", default);
        Assert.False(await coordinator.ValidateAsync(generation.Proof, true, default));
        var receipt = await coordinator.AcquireVideoReceiptAsync(permit.Id, "original-run", default);
        await database.Data.Database.GetCollection<GatewayAppCallerRecord>("llmgw_app_callers").InsertOneAsync(new GatewayAppCallerRecord
        { TenantId = permit.TenantId, AppCallerCode = VideoCaller, RequestType = ModelTypes.VideoGen, Status = "active", RateLimitPerMinute = 1000 });
        return (permit, coordinator, receipt);
    }

    [Fact]
    public async Task CancelledReceipt_RealHttpClientAndServingCore_CanOnlyReadFrozenJobWithinOriginalCallCap()
    {
        await using var database = await TestDatabase.CreateAsync();
        var setup = await ReceiptPermit(database, 1);
        await using var receipt = setup.Receipt;
        var httpAccessor = new HttpContextAccessor();
        var authority = new GatewayInvocationAuthority(httpAccessor, new ConfigurationBuilder().Build(), setup.Coordinator);
        var resolver = new Mock<IModelResolver>();
        resolver.Setup(x => x.ResolveOfferingAsync(VideoCaller, ModelTypes.VideoGen, ReceiptTarget.OfferingId, It.IsAny<CancellationToken>()))
            .ReturnsAsync(new ModelResolutionResult { Success = true, ActualModel = ReceiptTarget.Model,
                ActualPlatformId = "synthetic", OfferingId = ReceiptTarget.OfferingId,
                PlatformType = "openai", Protocol = "openai", ApiUrl = "https://synthetic.invalid", ApiKey = "synthetic-unused" });
        var vendor = new ReceiptVendor();
        var outbound = new Mock<IHttpClientFactory>();
        outbound.Setup(x => x.CreateClient(It.IsAny<string>())).Returns(() => new HttpClient(vendor, false));
        var core = new LlmGateway(resolver.Object, outbound.Object, NullLogger<LlmGateway>.Instance, invocationAuthority: authority);
        await using var host = await Server(database, implementation: core, suppliedHttpAccessor: httpAccessor);
        var transport = new Mock<IHttpClientFactory>();
        transport.Setup(x => x.CreateClient(It.IsAny<string>())).Returns(() => host.GetTestClient());
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        { ["LlmGateway:ServeBaseUrl"] = "http://localhost", ["LlmGwServe:ApiKey"] = TransportKey }).Build();
        var map = new HttpLlmGatewayClient(transport.Object, config, NullLogger<HttpLlmGatewayClient>.Instance,
            taskAuthorizer: new TaskExecutionAuthorizer(database.Data, config, setup.Coordinator));
        using var scope = TaskExecutionContext.Enter(receipt.Identity);
        var resolution = new GatewayModelResolution { Success = true, ActualModel = ReceiptTarget.Model, OfferingId = ReceiptTarget.OfferingId };
        var result = await map.SendRawWithResolutionAsync(ReceiptRequest(), resolution);
        Assert.True(result.Success, result.ErrorMessage); Assert.Equal(1, vendor.Calls);
        Assert.Equal("/v1/videos/original-job", vendor.Path); Assert.Equal(HttpMethod.Get, vendor.Method);
        var capped = await map.SendRawWithResolutionAsync(ReceiptRequest(), resolution);
        Assert.False(capped.Success); Assert.Equal("TASK_PERMIT_INVALID", capped.ErrorCode); Assert.Equal(1, vendor.Calls);
        Assert.False(await setup.Coordinator.ValidateAsync(receipt.Proof, true, default));
        var stored = await database.Permits.Find(x => x.Id == setup.Permit.Id).SingleAsync();
        Assert.Equal(1, stored.CallCount); Assert.Equal(1, stored.MaxCalls); Assert.Single(stored.BoundRunIds);
        Assert.Equal(TaskExecutionLeaseStates.VideoReceipt, Assert.Single(stored.Executions).State);
    }

    [Theory]
    [InlineData("job")]
    [InlineData("download")]
    [InlineData("submit")]
    [InlineData("offering")]
    [InlineData("body")]
    [InlineData("binary")]
    [InlineData("multipart")]
    [InlineData("headers")]
    [InlineData("caller")]
    [InlineData("type")]
    [InlineData("missing-role")]
    [InlineData("forged-token")]
    public async Task CancelledReceipt_ServingRejectsChangedTargetOrUnprovenRoleBeforeAnyCall(string variant)
    {
        await using var database = await TestDatabase.CreateAsync();
        var setup = await ReceiptPermit(database);
        await using var receipt = setup.Receipt;
        var http = new DefaultHttpContext(); http.Request.Method = "POST"; http.Request.Path = "/gw/v1/raw";
        http.Request.Headers[GatewayTaskAdmission.HeaderName] = setup.Permit.Id;
        http.Request.Headers[TaskExecutionHeaders.LeaseToken] = variant == "forged-token" ? new string('a', 32) : receipt.Proof.OwnerToken;
        http.Request.Headers[TaskExecutionHeaders.LeaseFence] = receipt.Proof.Fence.ToString();
        if (variant != "missing-role") http.Request.Headers[TaskExecutionHeaders.VideoReceipt] = "status";
        http.Request.Body = new MemoryStream(System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(ReceiptRequest(variant)));
        http.Request.ContentType = "application/json";
        var admission = new GatewayTaskAdmission(database.Data, new ConfigurationBuilder().Build(), NullLogger<GatewayTaskAdmission>.Instance, setup.Coordinator);
        var auth = new GatewayKeyAuthorization(true, true, 200, "", "", TenantId: setup.Permit.TenantId, LegacySharedKey: true);
        var result = await admission.AdmitAsync(http, auth, VideoCaller, true, default);
        Assert.False(result.Allowed);
        Assert.Equal(0, (await database.Permits.Find(x => x.Id == setup.Permit.Id).SingleAsync()).CallCount);
    }

    [Fact]
    public async Task CancelledReceipt_FrozenModelAndMoneyAdmissionRemainMandatoryAtPhysicalSend()
    {
        await using var database = await TestDatabase.CreateAsync();
        var setup = await ReceiptPermit(database);
        await using var receipt = setup.Receipt;
        var config = new ConfigurationBuilder().Build();
        var http = new DefaultHttpContext(); http.Request.Method = "POST"; http.Request.Path = "/gw/v1/raw";
        http.Request.Headers[GatewayTaskAdmission.HeaderName] = setup.Permit.Id;
        http.Request.Headers[TaskExecutionHeaders.LeaseToken] = receipt.Proof.OwnerToken;
        http.Request.Headers[TaskExecutionHeaders.LeaseFence] = receipt.Proof.Fence.ToString();
        http.Request.Headers[TaskExecutionHeaders.VideoReceipt] = "status";
        http.Request.Body = new MemoryStream(System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(ReceiptRequest()));
        http.Request.ContentType = "application/json";
        await database.Permits.UpdateOneAsync(x => x.Id == setup.Permit.Id, Builders<GatewayTaskPermitRecord>.Update.Set(x => x.BudgetScopeId, "original-budget"));
        var admission = new GatewayTaskAdmission(database.Data, config, NullLogger<GatewayTaskAdmission>.Instance, setup.Coordinator);
        var auth = new GatewayKeyAuthorization(true, true, 200, "", "", TenantId: setup.Permit.TenantId, KeyId: "synthetic-map", LegacySharedKey: true);
        Assert.True((await admission.AdmitAsync(http, auth, VideoCaller, true, default)).Allowed);
        var permit = (GatewayTaskPermitRecord)http.Items[GatewayTaskAdmission.HttpContextPermitKey]!;
        var lease = (GatewayTaskLeaseFact)http.Items[GatewayTaskAdmission.HttpContextLeaseKey]!;
        var context = new GatewayRequestContext { RequestId = "original-request", TenantId = permit.TenantId, UserId = "server-actor",
            SourceSystem = "map", ServiceKeyId = auth.KeyId, TaskPermitId = permit.Id, TaskLeaseRunId = lease.RunId,
            TaskLeaseOwnerHash = lease.OwnerHash, TaskLeaseFence = lease.Fence, RunId = "original-run",
            TriggerActorUserId = permit.ActorUserId, TriggerCredentialId = permit.TriggerCredentialId,
            ExecutionOrigin = permit.Origin, SourceDeployment = permit.SourceDeployment, SourceTask = permit.SourceTask };
        http.Items["llmgw.key.authorization"] = auth; http.Items[GatewayInvocationAuthority.PaidAdmissionKey] = true;
        http.Items[GatewayInvocationAuthority.AdmittedCallerKey] = VideoCaller;
        var accessor = new HttpContextAccessor { HttpContext = http };
        var authority = new GatewayInvocationAuthority(accessor, config, setup.Coordinator);
        Assert.Throws<TaskExecutionAdmissionException>(() => authority.AssertRawTarget(ReceiptRequest(),
            new GatewayModelResolution { Success = true, ActualModel = "changed-model", OfferingId = ReceiptTarget.OfferingId }));
        authority.AssertRawTarget(ReceiptRequest(), new GatewayModelResolution { Success = true, ActualModel = ReceiptTarget.Model, OfferingId = ReceiptTarget.OfferingId });
        var denied = await Assert.ThrowsAsync<TaskExecutionAdmissionException>(() => authority.AssertCurrentAsync(VideoCaller, context, default));
        Assert.Equal("GATEWAY_TASK_BUDGET_PHYSICAL_ADMISSION_REQUIRED", denied.Code);
        http.Items[GatewayInvocationAuthority.TaskBudgetAdmissionKey] = new TaskBudgetSendFact("original-budget", permit.Id, context.RequestId);
        await authority.AssertCurrentAsync(VideoCaller, context, default);
        await Assert.ThrowsAsync<TaskExecutionAdmissionException>(() => authority.AssertCurrentAsync(VideoCaller, context, default));
    }

    private sealed class ReceiptVendor : HttpMessageHandler
    {
        internal int Calls; internal string? Path; internal HttpMethod? Method;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref Calls); Path = request.RequestUri!.AbsolutePath; Method = request.Method;
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            { Content = new StringContent("{\"status\":\"completed\",\"cost\":0.43}", Encoding.UTF8, "application/json") });
        }
    }
}
