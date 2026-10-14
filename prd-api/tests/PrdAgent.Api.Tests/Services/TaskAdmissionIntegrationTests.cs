using System.Reflection;
using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Driver;
using Moq;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Api.Middleware;
using PrdAgent.Api.Services.BackgroundTasks;
using PrdAgent.Api.Services.Mcp;
using PrdAgent.Api.Services.ReportAgent;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Security;
using PrdAgent.Infrastructure.Services.AssetStorage;
using Xunit;
using ReportCreationMode = PrdAgent.Api.Controllers.Api.ReportAgentController.ReportCreationMode;

namespace PrdAgent.Api.Tests.Services;

/// <summary>仅连接本轮启动的独立 Mongo 随机库，经过真实准入中间件与发送授权者；零供应商请求。</summary>
public sealed class TaskAdmissionIntegrationTests : IAsyncLifetime
{
    private const string Controller = "PrdAgent.Api.Controllers.Api.ModelLabController";
    private const string ReportController = "PrdAgent.Api.Controllers.Api.ReportAgentController";
    private const string Caller = "prd-agent-web.model-lab.run::chat";
    private LlmGatewayDataContext _data = null!;
    private MongoDbContext _business = null!;
    private IConfiguration _config = null!;
    private string _database = "";
    private IMongoCollection<GatewayTaskPermitRecord> Permits =>
        _data.Database.GetCollection<GatewayTaskPermitRecord>(GatewayTaskPermitRecord.CollectionName);

    public Task InitializeAsync()
    {
        var connection = Environment.GetEnvironmentVariable("DESIGN_RUN_MONGO_TEST_CONNECTION") ?? "";
        var address = new MongoUrl(connection);
        Assert.Single(address.Servers);
        Assert.Equal("127.0.0.1", address.Server.Host);
        Assert.Equal(27389, address.Server.Port);
        Assert.Null(address.Username);
        _database = "phase1_admission_" + Guid.NewGuid().ToString("N");
        _data = new(connection, _database);
        _business = new(connection, _database);
        _config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        { ["Deployment:Identity"] = "synthetic-branch" }).Build();
        return Task.CompletedTask;
    }

    [DesignScopeMongoFact]
    public async Task ExistingUserAction_ReceivesBoundedPermit_WithTrustedFactsAndNoDoubleDebit()
    {
        var http = HttpAction("RunStream");
        http.Request.Headers["X-Gateway-Execution-Origin"] = "scheduled";
        http.Request.Headers["X-Gateway-Task-Permit"] = Guid.NewGuid().ToString("N");
        var context = new GatewayRequestContext
        {
            UserId = "actor", RunId = "original-trace", TaskPermitId = "fake",
            ExecutionOrigin = "agent", TriggerActorUserId = "fake", SourceDeployment = "fake",
        };
        var sent = 0;
        var middleware = new TaskAdmissionMiddleware(async _ =>
        {
            var root = TaskExecutionContext.Current!;
            using var run = TaskExecutionContext.Enter(root with { RunId = "actual-run" });
            using var message = new HttpRequestMessage(HttpMethod.Post, "http://127.0.0.1:1/gateway/send");
            await Authorize(message, context);
            sent++;
            Assert.Equal(root.PermitId, Assert.Single(message.Headers.GetValues("X-Gateway-Task-Permit")));
        });
        await middleware.InvokeAsync(http, new TaskAdmissionService(_data, _config));
        Assert.Equal(1, sent);
        Assert.Null(TaskExecutionContext.Current);
        var permit = await Permits.Find(FilterDefinition<GatewayTaskPermitRecord>.Empty).SingleAsync();
        Assert.Equal(TaskExecutionOrigins.Interactive, context.ExecutionOrigin);
        Assert.Equal("actor", context.TriggerActorUserId);
        Assert.Equal("actor", context.UserId);
        Assert.Equal("synthetic-branch", context.SourceDeployment);
        Assert.Equal("actual-run", context.RunId);
        Assert.Equal("original-trace", context.LogicalRequestId);
        Assert.Equal(permit.Id, context.TaskPermitId);
        Assert.Equal(0, permit.CallCount); // 发送准备不扣费，网关单独原子核销。
        Assert.Equal(["actual-run"], permit.BoundRunIds);
        Assert.InRange(permit.MaxCalls, 1, 256);
        Assert.Equal(TimeSpan.FromHours(24), permit.ExpiresAt - permit.CreatedAt);
    }

    [DesignScopeMongoTheory]
    [InlineData("PrdAgent.Api.Controllers.Api.ImageMasterController", "GenerateArticleMarkers", AppCallerRegistry.LiteraryAgent.Content.Chat)]
    [InlineData("PrdAgent.Api.Controllers.Api.ImageMasterController", "DrawingBoardChat", AppCallerRegistry.VisualAgent.DrawingBoard.Chat)]
    [InlineData("PrdAgent.Api.Controllers.Api.MdToPptController", "CreateTemplate", AppCallerRegistry.MdToPptAgent.Template.Extract)]
    [InlineData("PrdAgent.Api.Controllers.IntentController", "SuggestGroupName", AppCallerRegistry.Desktop.GroupName.SuggestIntent)]
    [InlineData("PrdAgent.Api.Controllers.Api.PrReviewController", "StreamSummary", AppCallerRegistry.PrReview.Summary.Chat)]
    [InlineData("PrdAgent.Api.Controllers.Api.PrReviewController", "StreamAlignment", AppCallerRegistry.PrReview.Alignment.Chat)]
    public async Task ExistingPaidEntrypoints_MiddlewareAuthorizesTheirActualCallerWithoutGrantingOtherCapabilities(
        string controller, string action, string caller)
    {
        var http = HttpAction(action, controller: controller);
        var context = new GatewayRequestContext { UserId = "actor" };
        var authorizer = new TaskExecutionAuthorizer(_data, _config);
        await new TaskAdmissionMiddleware(async _ =>
        {
            Assert.NotNull(TaskExecutionContext.Current);
            using var run = TaskExecutionContext.Enter(TaskExecutionContext.Current! with { RunId = "user-operation" });
            using var accepted = new HttpRequestMessage(HttpMethod.Post, "http://127.0.0.1:1/gateway/send");
            await authorizer.AuthorizeOutboundAsync(accepted, caller, context, default);
            Assert.True(accepted.Headers.Contains("X-Gateway-Task-Permit"));
            using var unrelated = new HttpRequestMessage(HttpMethod.Post, "http://127.0.0.1:1/gateway/send");
            var denied = await Assert.ThrowsAsync<TaskExecutionAdmissionException>(() =>
                authorizer.AuthorizeOutboundAsync(unrelated, Caller, new GatewayRequestContext { UserId = "actor" }, default));
            Assert.Equal("TASK_PERMIT_SCOPE_DENIED", denied.Code);
            Assert.False(unrelated.Headers.Contains("X-Gateway-Task-Permit"));
        }).InvokeAsync(http, new TaskAdmissionService(_data, _config));
        Assert.Null(TaskExecutionContext.Current);
        var permit = await Permits.Find(FilterDefinition<GatewayTaskPermitRecord>.Empty).SingleAsync();
        Assert.Equal(TaskExecutionOrigins.Interactive, permit.Origin);
        Assert.Equal("actor", context.TriggerActorUserId);
        Assert.Equal([caller], permit.AllowedAppCallerCodes);
        Assert.Equal(["user-operation"], permit.BoundRunIds);
        Assert.Equal(0, permit.CallCount);
    }

    [DesignScopeMongoTheory]
    [InlineData(ReportCreationMode.Manual)]
    [InlineData(ReportCreationMode.AiDraft)]
    public async Task RealReportCreation_OfflineGovernanceKeepsManualCrudAndExistingAiFailureFallback(string mode)
    {
        var offline = new LlmGatewayDataContext(
            "mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=200&connectTimeoutMS=200", "phase1_offline");
        var admission = new TaskAdmissionService(offline, _config);
        using var services = new ServiceCollection().AddSingleton(admission).BuildServiceProvider();
        var http = HttpAction("CreateReport", controller: ReportController);
        http.RequestServices = services;
        var gateway = new Mock<ILlmGateway>(MockBehavior.Strict);
        var controller = await RealReportControllerAsync(http, gateway.Object);
        IActionResult? result = null;
        await new TaskAdmissionMiddleware(async _ =>
        {
            Assert.Null(TaskExecutionContext.Current);
            result = await controller.CreateReport(ReportRequest(mode));
        }).InvokeAsync(http, admission);
        var payload = JsonSerializer.SerializeToElement(Assert.IsType<OkObjectResult>(result).Value,
            new JsonSerializerOptions(JsonSerializerDefaults.Web));
        var error = payload.GetProperty("data").GetProperty("aiGenerationError");
        if (mode == ReportCreationMode.Manual) Assert.Equal(JsonValueKind.Null, error.ValueKind);
        else Assert.False(string.IsNullOrWhiteSpace(error.GetString()));
        Assert.Null(TaskExecutionContext.Current);
        gateway.VerifyNoOtherCalls();
        Assert.Equal(0, await Permits.CountDocumentsAsync(FilterDefinition<GatewayTaskPermitRecord>.Empty));
        var report = await _business.WeeklyReports.Find(FilterDefinition<WeeklyReport>.Empty).SingleAsync();
        Assert.Equal(WeeklyReportStatus.Draft, report.Status);
        Assert.Null(report.AutoGeneratedBy);
    }

    [DesignScopeMongoTheory]
    [InlineData("Bearer", null, TaskExecutionOrigins.Interactive, 128)]
    [InlineData("ApiKey", "agent-apikey", TaskExecutionOrigins.Agent, 16)]
    public async Task RealAiReportCreation_ReceivesFinitePermitOnlyInsideValidatedPaidBranch(
        string scheme, string? auth, string origin, int maxCalls)
    {
        var admission = new TaskAdmissionService(_data, _config);
        using var services = new ServiceCollection().AddSingleton(admission).BuildServiceProvider();
        var http = HttpAction("CreateReport", scheme, auth, ReportController);
        http.RequestServices = services;
        http.Request.Headers["X-Gateway-Execution-Origin"] = origin == TaskExecutionOrigins.Agent ? "interactive" : "agent";
        http.Request.Headers["X-Gateway-Task-Permit"] = Guid.NewGuid().ToString("N");
        var gateway = new Mock<ILlmGateway>(MockBehavior.Strict);
        var sends = 0;
        gateway.Setup(item => item.SendAsync(It.IsAny<GatewayRequest>(), It.IsAny<CancellationToken>()))
            .Returns(async (GatewayRequest request, CancellationToken ct) =>
            {
                Assert.NotNull(TaskExecutionContext.Current);
                Assert.Equal(AppCallerRegistry.ReportAgent.Generate.Draft, request.AppCallerCode);
                using var message = new HttpRequestMessage(HttpMethod.Post, "http://127.0.0.1:1/gateway/send");
                await new TaskExecutionAuthorizer(_data, _config).AuthorizeOutboundAsync(
                    message, request.AppCallerCode, request.Context, ct);
                Assert.Equal("actor", request.Context!.UserId);
                Assert.Equal("actor", request.Context.TriggerActorUserId);
                Assert.Equal(origin, request.Context.ExecutionOrigin);
                sends++;
                return new GatewayResponse
                {
                    Success = true,
                    Content = """{"sections":[{"items":["完成既有工作"]}]}""",
                };
            });
        var controller = await RealReportControllerAsync(http, gateway.Object);
        IActionResult? result = null;
        await new TaskAdmissionMiddleware(async _ =>
        {
            Assert.Null(TaskExecutionContext.Current); // 混合动作不在入口处预领付费许可。
            Assert.Equal(0, await Permits.CountDocumentsAsync(FilterDefinition<GatewayTaskPermitRecord>.Empty));
            result = await controller.CreateReport(ReportRequest(ReportCreationMode.AiDraft));
        }).InvokeAsync(http, admission);
        var payload = JsonSerializer.SerializeToElement(Assert.IsType<OkObjectResult>(result).Value,
            new JsonSerializerOptions(JsonSerializerDefaults.Web));
        Assert.Equal(JsonValueKind.Null, payload.GetProperty("data").GetProperty("aiGenerationError").ValueKind);
        Assert.Equal(1, sends);
        Assert.Null(TaskExecutionContext.Current);
        var permit = await Permits.Find(FilterDefinition<GatewayTaskPermitRecord>.Empty).SingleAsync();
        Assert.Equal(ReportController + ".CreateReport", permit.SourceTask);
        Assert.Equal(origin, permit.Origin);
        Assert.Equal("actor", permit.ActorUserId);
        Assert.Equal(["actor"], permit.SubjectUserIds);
        Assert.Equal(maxCalls, permit.MaxCalls);
        Assert.Equal(0, permit.CallCount);
        Assert.All(permit.AllowedAppCallerCodes, caller => Assert.True(
            caller.StartsWith("report-agent.", StringComparison.Ordinal)
            || caller.StartsWith("workflow-agent.", StringComparison.Ordinal)));
        var report = await _business.WeeklyReports.Find(FilterDefinition<WeeklyReport>.Empty).SingleAsync();
        Assert.Equal("llm", report.AutoGeneratedBy);
        Assert.Equal("完成既有工作", Assert.Single(Assert.Single(report.Sections).Items).Content);
    }

    [DesignScopeMongoFact]
    public async Task RealAiReportCreation_FailedBusinessCheckNeverClaimsPermitOrInvokesGeneration()
    {
        var admission = new TaskAdmissionService(_data, _config);
        using var services = new ServiceCollection().AddSingleton(admission).BuildServiceProvider();
        var http = HttpAction("CreateReport", controller: ReportController);
        http.RequestServices = services;
        var gateway = new Mock<ILlmGateway>(MockBehavior.Strict);
        var controller = await RealReportControllerAsync(http, gateway.Object, member: false);
        IActionResult? result = null;
        await new TaskAdmissionMiddleware(async _ =>
        {
            result = await controller.CreateReport(ReportRequest(ReportCreationMode.AiDraft));
        }).InvokeAsync(http, admission);
        Assert.IsType<BadRequestObjectResult>(result);
        gateway.VerifyNoOtherCalls();
        Assert.Equal(0, await Permits.CountDocumentsAsync(FilterDefinition<GatewayTaskPermitRecord>.Empty));
    }

    [DesignScopeMongoTheory]
    [InlineData("FutureUnregisteredPaidAction")]
    [InlineData("FuturePlainCrud")]
    [InlineData("GenerateReport")]
    public async Task PaidBranchAdmission_CannotBeClaimedByUnknownActionsOrDifferentIssuanceTiming(string action)
    {
        var admission = new TaskAdmissionService(_data, _config);
        var http = HttpAction(action, controller: ReportController);
        var error = await Assert.ThrowsAsync<TaskExecutionAdmissionException>(() =>
            admission.AdmitAuthenticatedPaidBranchAsync(http, default));
        Assert.Equal("TASK_SOURCE_NOT_REGISTERED", error.Code);
        Assert.Equal(0, await Permits.CountDocumentsAsync(FilterDefinition<GatewayTaskPermitRecord>.Empty));
        if (action.StartsWith("Future", StringComparison.Ordinal))
            Assert.Null(await admission.AdmitRequestAsync(http, default));
    }

    [DesignScopeMongoFact]
    public async Task PaidBranchAdmission_RequiresAuthenticationBeforeClaimingRegisteredAction()
    {
        var http = HttpAction("CreateReport", controller: ReportController);
        http.User = new ClaimsPrincipal(new ClaimsIdentity([new Claim(ClaimTypes.NameIdentifier, "actor")]));
        var admission = new TaskAdmissionService(_data, _config);
        var error = await Assert.ThrowsAsync<TaskExecutionAdmissionException>(() =>
            admission.AdmitAuthenticatedPaidBranchAsync(http, default));
        Assert.Equal("TASK_TRIGGER_IDENTITY_MISSING", error.Code);
        Assert.Null(await admission.AdmitRequestAsync(http, default));
        Assert.Equal(0, await Permits.CountDocumentsAsync(FilterDefinition<GatewayTaskPermitRecord>.Empty));
    }

    [DesignScopeMongoFact]
    public async Task VerifiedMcpPaidBranch_ReusesOriginalSourceAndBudget_WhileUnknownActionCannotClaimIt()
    {
        var signal = new McpLoopbackSignal();
        var admission = new TaskAdmissionService(_data, _config, signal);
        var root = (await admission.AdmitRequestAsync(HttpAction("Handle", "ApiKey", "agent-apikey",
            "PrdAgent.Api.Controllers.McpGatewayController"), default))!;
        await Permits.UpdateOneAsync(item => item.Id == root.PermitId,
            Builders<GatewayTaskPermitRecord>.Update.Set(item => item.CallCount, 3));
        using var scope = TaskExecutionContext.Enter(root);
        using var message = new HttpRequestMessage();
        signal.AttachTaskContinuation(message);
        var continuation = HttpAction("CreateReport", controller: ReportController);
        foreach (var header in message.Headers) continuation.Request.Headers[header.Key] = header.Value.ToArray();
        var paidBranch = await admission.AdmitAuthenticatedPaidBranchAsync(continuation, default);
        Assert.Equal(root.PermitId, paidBranch.PermitId);
        var context = new GatewayRequestContext { UserId = "actor" };
        using (TaskExecutionContext.Enter(paidBranch))
        using (var outgoing = new HttpRequestMessage(HttpMethod.Post, "http://127.0.0.1:1/gateway/send"))
            await new TaskExecutionAuthorizer(_data, _config).AuthorizeOutboundAsync(outgoing,
                AppCallerRegistry.ReportAgent.Generate.Draft, context, default);
        Assert.Equal(TaskExecutionOrigins.Agent, context.ExecutionOrigin);
        Assert.Equal("agent-apikey:actor", context.TriggerCredentialId);
        var unchanged = await Permits.Find(item => item.Id == root.PermitId).SingleAsync();
        Assert.Equal(3, unchanged.CallCount);
        Assert.Equal(1, await Permits.CountDocumentsAsync(FilterDefinition<GatewayTaskPermitRecord>.Empty));
        var unknown = HttpAction("FutureUnregisteredPaidAction", controller: ReportController);
        foreach (var header in message.Headers) unknown.Request.Headers[header.Key] = header.Value.ToArray();
        await Assert.ThrowsAsync<TaskExecutionAdmissionException>(() =>
            admission.AdmitAuthenticatedPaidBranchAsync(unknown, default));
        Assert.Equal(1, await Permits.CountDocumentsAsync(FilterDefinition<GatewayTaskPermitRecord>.Empty));
    }

    [DesignScopeMongoFact]
    public async Task NewBusinessMissingAdmission_CannotBorrowAmbientTask_WhileCrudRemainsUsable()
    {
        var known = await SeedAsync();
        using var surrounding = TaskExecutionContext.Enter(new(known.Id, "other-run"));
        var http = HttpAction("FutureUnregisteredPaidAction");
        var sends = 0;
        var middleware = new TaskAdmissionMiddleware(async _ =>
        {
            Assert.Null(TaskExecutionContext.Current);
            using var message = new HttpRequestMessage(HttpMethod.Post, "http://127.0.0.1:1/gateway/send");
            var error = await Assert.ThrowsAsync<TaskExecutionAdmissionException>(() => Authorize(message,
                new GatewayRequestContext { UserId = "actor" }));
            Assert.Equal("TASK_EXECUTION_NOT_ADMITTED", error.Code);
            Assert.False(message.Headers.Contains("X-Gateway-Task-Permit"));
            // 未调用发送函数，业务普通读取可以继续。
            Assert.Equal(0, sends);
        });
        await middleware.InvokeAsync(http, new TaskAdmissionService(_data, _config));
        Assert.Equal("other-run", TaskExecutionContext.Current!.RunId);
        Assert.Equal(1, await Permits.CountDocumentsAsync(FilterDefinition<GatewayTaskPermitRecord>.Empty));
    }

    [DesignScopeMongoFact]
    public async Task VerifiedMcpContinuation_ReusesRootPermit_ExternalForgedHeadersDoNot()
    {
        var signal = new McpLoopbackSignal();
        var admission = new TaskAdmissionService(_data, _config, signal);
        var root = await admission.AdmitRequestAsync(HttpAction("RunStream"), default);
        using var scope = TaskExecutionContext.Enter(root);
        using var message = new HttpRequestMessage();
        signal.AttachTaskContinuation(message);
        var loopback = HttpAction("RunStream");
        foreach (var header in message.Headers) loopback.Request.Headers[header.Key] = header.Value.ToArray();
        Assert.Equal(root, await admission.AdmitRequestAsync(loopback, default));
        Assert.Equal(1, await Permits.CountDocumentsAsync(FilterDefinition<GatewayTaskPermitRecord>.Empty));
        var forged = HttpAction("RunStream", "ApiKey", "agent-apikey");
        forged.Request.Headers[McpLoopbackSignal.HeaderName] = "pretend-internal";
        forged.Request.Headers[McpLoopbackSignal.TaskPermitHeaderName] = root!.PermitId;
        forged.Request.Headers["X-Gateway-Execution-Origin"] = "interactive";
        var separate = await admission.AdmitRequestAsync(forged, default);
        Assert.NotEqual(root.PermitId, separate!.PermitId);
        var permit = await Permits.Find(item => item.Id == separate.PermitId).SingleAsync();
        Assert.Equal(TaskExecutionOrigins.Agent, permit.Origin);
        Assert.Equal(16, permit.MaxCalls);
        Assert.Equal(2, permit.MaxRuns);
        var unknown = HttpAction("FutureUnregisteredPaidAction");
        foreach (var header in message.Headers) unknown.Request.Headers[header.Key] = header.Value.ToArray();
        Assert.Null(await admission.AdmitRequestAsync(unknown, default));
    }

    [DesignScopeMongoTheory]
    [InlineData("expired")]
    [InlineData("revoked")]
    [InlineData("depleted")]
    [InlineData("zero-budget")]
    [InlineData("different-deployment")]
    [InlineData("different-tenant")]
    [InlineData("different-caller")]
    [InlineData("fake-subject")]
    public async Task InvalidTask_IsStoppedBeforeAuthorizationHeaderIsWritten(string problem)
    {
        var permit = NewPermit();
        switch (problem)
        {
            case "expired": permit.CreatedAt = DateTime.UtcNow.AddHours(-2); permit.ExpiresAt = DateTime.UtcNow.AddHours(-1); break;
            case "revoked": permit.RevokedAt = DateTime.UtcNow; break;
            case "depleted": permit.CallCount = permit.MaxCalls; break;
            case "zero-budget": permit.MaxCalls = 0; break;
            case "different-deployment": permit.SourceDeployment = "foreign-branch"; break;
            case "different-tenant": permit.TenantId = "foreign-tenant"; break;
            case "different-caller": permit.AllowedAppCallerCodes = ["other.operation::chat"]; break;
        }
        await Permits.InsertOneAsync(permit);
        using var scope = TaskExecutionContext.Enter(new(permit.Id, "run"));
        using var message = new HttpRequestMessage(HttpMethod.Post, "http://127.0.0.1:1/gateway/send");
        await Assert.ThrowsAsync<TaskExecutionAdmissionException>(() => Authorize(message,
            new GatewayRequestContext { UserId = problem == "fake-subject" ? "fake-user" : "actor" }));
        Assert.False(message.Headers.Contains("X-Gateway-Task-Permit"));
    }

    [DesignScopeMongoFact]
    public async Task TwoAuthorizers_CannotExpandSameTaskBeyondRegisteredRunCount()
    {
        var permit = await SeedAsync();
        permit.MaxRuns = 2;
        await Permits.ReplaceOneAsync(item => item.Id == permit.Id, permit);
        var successes = await Task.WhenAll(Enumerable.Range(0, 20).Select(async index =>
        {
            using var scope = TaskExecutionContext.Enter(new(permit.Id, "run-" + index));
            using var message = new HttpRequestMessage(HttpMethod.Post, "http://127.0.0.1:1/gateway/send");
            try { await Authorize(message, new GatewayRequestContext { UserId = "actor" }); return true; }
            catch (TaskExecutionAdmissionException) { return false; }
        }));
        Assert.Equal(2, successes.Count(value => value));
        var after = await Permits.Find(item => item.Id == permit.Id).SingleAsync();
        Assert.Equal(2, after.BoundRunIds.Count);
        Assert.Equal(0, after.CallCount);
    }

    [DesignScopeMongoFact]
    public async Task WorkflowManagement_PreservesBusinessOwner_AndRecordsActualOperatorSeparately()
    {
        var http = HttpAction("ContinueExecution", controller: "PrdAgent.Api.Controllers.Api.WorkflowAgentController");
        var identity = (await new TaskAdmissionService(_data, _config).AdmitRequestAsync(http, default))!;
        using var scope = TaskExecutionContext.Enter(identity with { RunId = "owned-workflow-run" });
        using var message = new HttpRequestMessage(HttpMethod.Post, "http://127.0.0.1:1/gateway/send");
        var context = new GatewayRequestContext { UserId = "workflow-owner" };
        await Authorize(message, context);
        Assert.Equal("actor", context.TriggerActorUserId);
        Assert.Equal("workflow-owner", context.UserId);
        var permit = await Permits.Find(item => item.Id == identity.PermitId).SingleAsync();
        Assert.Contains("workflow-owner", permit.SubjectUserIds);
        Assert.Contains("owned-workflow-run", permit.BoundRunIds);
    }

    [DesignScopeMongoFact]
    public async Task AdmissionStoreUnavailable_StopsPaidOperation_AndLeavesUnregisteredCrudUsable()
    {
        var offline = new LlmGatewayDataContext(
            "mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=200&connectTimeoutMS=200", "phase1_offline");
        var admission = new TaskAdmissionService(offline, _config);
        var error = await Assert.ThrowsAsync<TaskExecutionAdmissionException>(() =>
            admission.AdmitRequestAsync(HttpAction("RunStream"), default));
        Assert.Equal(503, error.StatusCode);
        Assert.Equal("TASK_ADMISSION_UNAVAILABLE", error.Code);
        var continued = false;
        await new TaskAdmissionMiddleware(_ => { continued = true; return Task.CompletedTask; })
            .InvokeAsync(HttpAction("FuturePlainCrud"), admission);
        Assert.True(continued);
        using var scope = TaskExecutionContext.Enter(new(Guid.NewGuid().ToString("N")));
        using var message = new HttpRequestMessage(HttpMethod.Post, "http://127.0.0.1:1/gateway/send");
        error = await Assert.ThrowsAsync<TaskExecutionAdmissionException>(() =>
            new TaskExecutionAuthorizer(offline, _config).AuthorizeOutboundAsync(message, Caller,
                new GatewayRequestContext { UserId = "actor" }, default));
        Assert.Equal(503, error.StatusCode);
        Assert.False(message.Headers.Contains("X-Gateway-Task-Permit"));
    }

    [DesignScopeMongoFact]
    public async Task VerifiedOpsCanary_IsOneCallServiceTask_AndCannotAccessOtherModelPurposes()
    {
        var http = HttpAction("RunAsrCanary", controller: "PrdAgent.Api.Controllers.Api.LlmGatewayOpsCanaryController");
        var identity = await new TaskAdmissionService(_data, _config).AdmitVerifiedIntegrationAsync(
            http, "ops-canary", "ops-canary:gateway-transport", default);
        var permit = await Permits.Find(item => item.Id == identity.PermitId).SingleAsync();
        Assert.Equal(TaskExecutionOrigins.Agent, permit.Origin);
        Assert.Equal(1, permit.MaxCalls);
        Assert.Equal([PrdAgent.Core.Models.AppCallerRegistry.TranscriptAgent.Transcribe.Audio], permit.AllowedAppCallerCodes);
        using var scope = TaskExecutionContext.Enter(identity);
        using var message = new HttpRequestMessage(HttpMethod.Post, "http://127.0.0.1:1/gateway/send");
        var error = await Assert.ThrowsAsync<TaskExecutionAdmissionException>(() =>
            Authorize(message, new GatewayRequestContext { UserId = "ops-canary" }));
        Assert.Equal("TASK_PERMIT_SCOPE_DENIED", error.Code);
        Assert.False(message.Headers.Contains("X-Gateway-Task-Permit"));
    }

    [DesignScopeMongoFact]
    public async Task ScheduledJob_IdentifiesSchedulerSeparately_AndPreservesTheApprovedBusinessUser()
    {
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Deployment:Identity"] = "synthetic-branch",
            ["Deployment:SharedScheduledWorkEnabled"] = "true",
        }).Build();
        using var deployment = AutomaticTaskExecutionContext.Enter("synthetic/WorkflowScheduleWorker/authority");
        var identity = await new TaskAdmissionService(_data, config).AdmitScheduledTaskAsync(
            "WorkflowScheduleWorker", "stored-job", "business-owner", default);
        var permit = await Permits.Find(item => item.Id == identity.PermitId).SingleAsync();
        Assert.Equal(TaskExecutionOrigins.Scheduled, permit.Origin);
        Assert.Equal("platform-scheduler:WorkflowScheduleWorker", permit.ActorUserId);
        Assert.Equal(["business-owner"], permit.SubjectUserIds);
        Assert.False(permit.AllowDelegatedSubjects);
        Assert.Equal(8, permit.MaxCalls);
        Assert.Equal(1, permit.MaxRuns);
        using var scope = TaskExecutionContext.Enter(identity with { RunId = "job-run" });
        using var message = new HttpRequestMessage(HttpMethod.Post, "http://127.0.0.1:1/gateway/send");
        var context = new GatewayRequestContext();
        await Authorize(message, context);
        Assert.Equal("business-owner", context.UserId);
        Assert.Equal(permit.ActorUserId, context.TriggerActorUserId);
        Assert.Equal(TaskExecutionOrigins.Scheduled, context.ExecutionOrigin);
        Assert.Equal(1, await Permits.CountDocumentsAsync(FilterDefinition<GatewayTaskPermitRecord>.Empty));
        var unchanged = await Permits.Find(item => item.Id == identity.PermitId).SingleAsync();
        Assert.Equal(["business-owner"], unchanged.SubjectUserIds);
        Assert.Equal(0, unchanged.CallCount);
    }

    [DesignScopeMongoTheory]
    [InlineData("scheduler-actor", false)]
    [InlineData("unapproved-user", false)]
    [InlineData("business-owner", true)]
    [InlineData("unapproved-user", true)]
    public async Task ScheduledJob_RejectsImplicitActorOrExpandedSubjects_AndAbnormalDelegationFlag(
        string subject, bool delegated)
    {
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Deployment:Identity"] = "synthetic-branch",
            ["Deployment:SharedScheduledWorkEnabled"] = "true",
        }).Build();
        using var deployment = AutomaticTaskExecutionContext.Enter("synthetic/WorkflowScheduleWorker/authority");
        var identity = await new TaskAdmissionService(_data, config).AdmitScheduledTaskAsync(
            "WorkflowScheduleWorker", "stored-job", "business-owner", default);
        var permit = await Permits.Find(item => item.Id == identity.PermitId).SingleAsync();
        permit.AllowDelegatedSubjects = delegated;
        await Permits.ReplaceOneAsync(item => item.Id == permit.Id, permit);
        using var scope = TaskExecutionContext.Enter(identity with { RunId = "job-run" });
        using var message = new HttpRequestMessage(HttpMethod.Post, "http://127.0.0.1:1/gateway/send");
        var context = new GatewayRequestContext { UserId = subject == "scheduler-actor" ? permit.ActorUserId : subject };
        var error = await Assert.ThrowsAsync<TaskExecutionAdmissionException>(() => Authorize(message, context));
        Assert.Equal(delegated ? "TASK_PERMIT_INVALID" : "TASK_PERMIT_SUBJECT_DENIED", error.Code);
        Assert.False(message.Headers.Contains("X-Gateway-Task-Permit"));
        Assert.Null(context.TaskPermitId);
        var unchanged = await Permits.Find(item => item.Id == permit.Id).SingleAsync();
        Assert.Equal(["business-owner"], unchanged.SubjectUserIds);
        Assert.Empty(unchanged.BoundRunIds);
        Assert.Equal(0, unchanged.CallCount);
    }

    public async Task DisposeAsync() => await _data.Database.Client.DropDatabaseAsync(_database);

    private Task Authorize(HttpRequestMessage request, GatewayRequestContext context) =>
        new TaskExecutionAuthorizer(_data, _config).AuthorizeOutboundAsync(request, Caller, context, default);

    private async Task<ReportAgentController> RealReportControllerAsync(HttpContext http, ILlmGateway gateway, bool member = true)
    {
        var db = _business;
        await db.ReportTeams.InsertOneAsync(new ReportTeam { Id = "test-team", Name = "测试团队" });
        await db.ReportTemplates.InsertOneAsync(new ReportTemplate
        {
            Id = "test-template", Name = "既有模板", Sections = [new ReportTemplateSection { Title = "本周工作" }],
        });
        if (member)
            await db.ReportTeamMembers.InsertOneAsync(new ReportTeamMember { TeamId = "test-team", UserId = "actor" });
        var collector = new MapActivityCollector(db);
        var generation = new ReportGenerationService(db, gateway, collector, NullLogger<ReportGenerationService>.Instance,
            null!, null!, null!);
        return new ReportAgentController(db, Mock.Of<IAssetStorage>(), NullLogger<ReportAgentController>.Instance,
            _config, collector, generation, null!, null!, null!, null!, null!, null!)
        {
            ControllerContext = new ControllerContext { HttpContext = http },
        };
    }

    private static ReportAgentController.CreateReportRequest ReportRequest(string mode) => new()
    {
        TeamId = "test-team", TemplateId = "test-template", CreationMode = mode, WeekYear = 2026, WeekNumber = 1,
    };
    private async Task<GatewayTaskPermitRecord> SeedAsync()
    {
        var permit = NewPermit();
        await Permits.InsertOneAsync(permit);
        return permit;
    }
    private static GatewayTaskPermitRecord NewPermit() => new()
    {
        TenantId = GatewayTenantDefaults.InternalTenantId, ActorUserId = "actor", SubjectUserIds = ["actor"],
        Origin = TaskExecutionOrigins.Interactive, TriggerCredentialId = "session:synthetic",
        SourceDeployment = "synthetic-branch", SourceTask = "synthetic-user-action",
        AllowedAppCallerCodes = [Caller], MaxCalls = 3, MaxRuns = 1,
        CreatedAt = DateTime.UtcNow, ExpiresAt = DateTime.UtcNow.AddHours(1),
    };
    private static DefaultHttpContext HttpAction(string action, string scheme = "Bearer", string? auth = null,
        string controller = Controller)
    {
        var http = new DefaultHttpContext();
        var type = typeof(TaskAdmissionService).Assembly.GetType(controller)!;
        http.SetEndpoint(new Endpoint(_ => Task.CompletedTask, new EndpointMetadataCollection(
            new ControllerActionDescriptor { ControllerTypeInfo = type.GetTypeInfo(), ActionName = action }), "synthetic"));
        var claims = new List<Claim> { new(ClaimTypes.NameIdentifier, "actor") };
        if (auth is not null) claims.Add(new("authType", auth));
        http.User = new ClaimsPrincipal(new ClaimsIdentity(claims, scheme));
        return http;
    }
}
