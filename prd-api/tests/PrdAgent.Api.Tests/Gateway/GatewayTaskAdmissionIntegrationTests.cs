using System.Collections.Concurrent;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Channels;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Configuration;
using MongoDB.Bson;
using MongoDB.Driver;
using Moq;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Services;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.LlmGateway.Asr;
using PrdAgent.Core.LlmGateway.Asr;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.LlmGatewayHost;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

/// <summary>真实Mongo与生产端点装配；上游只计数，任何测试均不会产生外部费用。</summary>
[Trait("Category", "Integration")]
public sealed class GatewayTaskAdmissionIntegrationTests
{
    private const string TransportKey = "phase1-isolated-transport-key";
    private const string Caller = "future-business.task-admission::chat";

    public static IEnumerable<object[]> PaidPaths()
    {
        foreach (var path in new[]
        {
            "/gw/v1/invoke", "/gw/v1/send", "/gw/v1/stream", "/gw/v1/raw", "/gw/v1/profile-test",
            "/gw/v1/client-stream", "/gw/v1/responses", "/gw/v1/chat/completions", "/v1/responses",
            "/v1/chat/completions", "/v1/images/generations", "/v1/images/edits", "/v1/messages",
            "/v1beta/models/future-model:generateContent", "/v1beta/models/future-model:streamGenerateContent",
            "/gemini/v1beta/models/future-model:generateContent", "/gemini/v1beta/models/future-model:streamGenerateContent",
            "/GW/V1/send/",
        }) yield return new object[] { "POST", path };
        yield return new object[] { "GET", "/gw/v1/asr/live" };
    }

    [Theory]
    [MemberData(nameof(PaidPaths))]
    public async Task EveryPaidProtocolRejectsMissingTaskProofBeforeUpstream(string method, string path)
    {
        await using var database = await TestDatabase.CreateAsync();
        await using var host = await Server(database);
        var response = await Send(host.GetTestClient(), method, path);
        response.StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        (await response.Content.ReadAsStringAsync()).ShouldContain("TASK_PERMIT_REQUIRED");
        database.PaidCalls.ShouldBe(0);
    }

    [Theory]
    [InlineData("POST", "/future-paid")]
    [InlineData("GET", "/v1/models/future-paid")]
    public async Task NewlyMappedEndpointWithoutBusinessGuardIsDeniedEvenWithValidProof(string method, string path)
    {
        await using var database = await TestDatabase.CreateAsync();
        var permit = await database.PermitAsync();
        await using var host = await Server(database);
        var response = await Send(host.GetTestClient(), method, path, permit.Id);
        response.StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        (await response.Content.ReadAsStringAsync()).ShouldContain("GATEWAY_ROUTE_NOT_ADMITTED");
        database.PaidCalls.ShouldBe(0);
        (await database.Permits.Find(x => x.Id == permit.Id).SingleAsync()).CallCount.ShouldBe(0);
    }

    [Fact]
    public async Task TaskCallsAreAtomicallyBoundedAcrossTwoServingInstances()
    {
        await using var database = await TestDatabase.CreateAsync();
        var permit = await database.PermitAsync(maxCalls: 5, origin: TaskExecutionOrigins.Agent);
        await using var first = await Server(database);
        await using var second = await Server(database);
        var responses = await Task.WhenAll(Enumerable.Range(0, 30).Select(i =>
            Send((i % 2 == 0 ? first : second).GetTestClient(), "POST", "/gw/v1/send", permit.Id)));
        responses.Count(r => r.StatusCode == HttpStatusCode.OK).ShouldBe(5);
        responses.Count(r => r.StatusCode == HttpStatusCode.TooManyRequests).ShouldBe(25);
        database.PaidCalls.ShouldBe(5);
        (await database.Permits.Find(x => x.Id == permit.Id).SingleAsync()).CallCount.ShouldBe(5);
    }

    [Fact]
    public async Task TrustedInteractiveIdentityOverridesSpoofedBodyAndHeaders()
    {
        await using var database = await TestDatabase.CreateAsync();
        var permit = await database.PermitAsync();
        await using var host = await Server(database);
        var response = await Send(host.GetTestClient(), "POST", "/gw/v1/send", permit.Id,
            context: new { UserId = "server-actor", TeamId = "forged-team", ServiceKeyId = "forged-key", ExecutionOrigin = "scheduled", SourceDeployment = "forged-deployment", SourceTask = "forged-task", IsHealthProbe = true });
        response.StatusCode.ShouldBe(HttpStatusCode.OK);
        var request = database.Requests.Single();
        request.Context!.UserId.ShouldBe("server-actor");
        request.Context.ExecutionOrigin.ShouldBe(TaskExecutionOrigins.Interactive);
        request.Context.TaskPermitId.ShouldBe(permit.Id);
        request.Context.TriggerActorUserId.ShouldBe("server-actor");
        request.Context.TriggerCredentialId.ShouldBe("server-session");
        request.Context.SourceDeployment.ShouldBe("prd-agent:production");
        request.Context.SourceTask.ShouldBe("request:fixture");
        request.Context.IsHealthProbe.ShouldBe(false);
        request.Context.TeamId.ShouldBeNull();
        request.Context.ServiceKeyId.ShouldBe("legacy-map-shared");
        request.Context.SourceSystem.ShouldBe("map");
        database.PaidCalls.ShouldBe(1);
    }

    [Fact]
    public async Task ForgedUserCannotChangeTheApprovedBillingSubject()
    {
        await using var database = await TestDatabase.CreateAsync();
        var permit = await database.PermitAsync();
        await using var host = await Server(database);
        var response = await Send(host.GetTestClient(), "POST", "/gw/v1/send", permit.Id, context: new { UserId = "forged-user" });
        response.StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        (await response.Content.ReadAsStringAsync()).ShouldContain("TASK_PERMIT_SUBJECT_DENIED");
        database.PaidCalls.ShouldBe(0);
        (await database.Permits.Find(x => x.Id == permit.Id).SingleAsync()).CallCount.ShouldBe(0);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task RegisteredWorkflowDelegationPreservesSubjectAndActualActor(bool delegated)
    {
        await using var database = await TestDatabase.CreateAsync();
        var permit = await database.PermitAsync();
        permit.SubjectUserIds.Add("workflow-owner"); permit.AllowDelegatedSubjects = delegated;
        permit.BoundRunIds = ["workflow-run"];
        await database.Permits.ReplaceOneAsync(x => x.Id == permit.Id, permit);
        await using var host = await Server(database);
        var response = await Send(host.GetTestClient(), "POST", "/gw/v1/send", permit.Id,
            context: new { UserId = "workflow-owner", RunId = "workflow-run" }, subject: "workflow-owner");
        response.StatusCode.ShouldBe(delegated ? HttpStatusCode.OK : HttpStatusCode.Forbidden);
        database.PaidCalls.ShouldBe(delegated ? 1 : 0);
        if (delegated)
        {
            database.Requests.Single().Context!.UserId.ShouldBe("workflow-owner");
            database.Requests.Single().Context!.TriggerActorUserId.ShouldBe("server-actor");
        }
    }

    [Fact]
    public async Task ScheduledPermitPreservesServiceActorAndPreapprovedBusinessSubject()
    {
        await using var database = await TestDatabase.CreateAsync();
        var permit = await database.ScheduledPermitAsync();
        await using var host = await Server(database);
        var response = await Send(host.GetTestClient(), "POST", "/gw/v1/send", permit.Id,
            context: new { UserId = "scheduled-owner", ExecutionOrigin = "interactive", TriggerActorUserId = "forged-actor" }, subject: "scheduled-owner");

        response.StatusCode.ShouldBe(HttpStatusCode.OK);
        var sent = database.Requests.Single().Context!;
        sent.UserId.ShouldBe("scheduled-owner");
        sent.TriggerActorUserId.ShouldBe("platform-scheduler:ReportAutoGenerateWorker");
        sent.ExecutionOrigin.ShouldBe(TaskExecutionOrigins.Scheduled);
        sent.TriggerCredentialId.ShouldBe("schedule:ReportAutoGenerateWorker:report-123");
        sent.SourceTask.ShouldBe("ReportAutoGenerateWorker:report-123");
        database.PaidCalls.ShouldBe(1);
        var persisted = await database.Permits.Find(x => x.Id == permit.Id).SingleAsync();
        persisted.CallCount.ShouldBe(1);
        persisted.AllowDelegatedSubjects.ShouldBeFalse();
        persisted.SubjectUserIds.ShouldBe(new[] { "scheduled-owner" });
    }

    [Theory]
    [InlineData("unapproved-owner")]
    [InlineData("platform-scheduler:ReportAutoGenerateWorker")]
    public async Task ScheduledPermitCannotDynamicallyBorrowAnotherBillingSubject(string subject)
    {
        await using var database = await TestDatabase.CreateAsync();
        var permit = await database.ScheduledPermitAsync();
        await using var host = await Server(database);
        var response = await Send(host.GetTestClient(), "POST", "/gw/v1/send", permit.Id,
            context: new { UserId = subject, ExecutionOrigin = "scheduled" }, subject: subject);

        response.StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        (await response.Content.ReadAsStringAsync()).ShouldContain("TASK_PERMIT_SUBJECT_DENIED");
        database.PaidCalls.ShouldBe(0);
        var persisted = await database.Permits.Find(x => x.Id == permit.Id).SingleAsync();
        persisted.CallCount.ShouldBe(0);
        persisted.SubjectUserIds.ShouldBe(new[] { "scheduled-owner" });
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ScheduledSubjectDefaultsOnlyToAnUnambiguousPreapprovedBusinessUser(bool ambiguous)
    {
        await using var database = await TestDatabase.CreateAsync();
        var permit = await database.ScheduledPermitAsync();
        if (ambiguous)
        {
            permit.SubjectUserIds.Add("another-preapproved-owner");
            await database.Permits.ReplaceOneAsync(x => x.Id == permit.Id, permit);
        }
        await using var host = await Server(database);
        using var request = new HttpRequestMessage(HttpMethod.Post, "/gw/v1/send")
        {
            Content = JsonContent.Create(new { AppCallerCode = Caller, ModelType = "chat", Context = new { SourceSystem = "map" } }),
        };
        request.Headers.Add("X-Gateway-Key", TransportKey); request.Headers.Add("X-Gateway-Source", "map");
        request.Headers.Add("X-Gateway-App-Caller", Caller); request.Headers.Add(GatewayTaskAdmission.HeaderName, permit.Id);
        var response = await host.GetTestClient().SendAsync(request);

        response.StatusCode.ShouldBe(ambiguous ? HttpStatusCode.Forbidden : HttpStatusCode.OK);
        database.PaidCalls.ShouldBe(ambiguous ? 0 : 1);
        (await database.Permits.Find(x => x.Id == permit.Id).SingleAsync()).CallCount.ShouldBe(ambiguous ? 0 : 1);
        if (!ambiguous)
        {
            database.Requests.Single().Context!.UserId.ShouldBe("scheduled-owner");
            database.Requests.Single().Context!.TriggerActorUserId.ShouldBe("platform-scheduler:ReportAutoGenerateWorker");
        }
    }

    [Theory]
    [InlineData(TaskExecutionOrigins.Interactive)]
    [InlineData(TaskExecutionOrigins.Agent)]
    public async Task SelfReportedScheduledOriginCannotRelaxOtherOriginActorChecks(string origin)
    {
        await using var database = await TestDatabase.CreateAsync();
        var permit = await database.ScheduledPermitAsync(); permit.Origin = origin;
        await database.Permits.ReplaceOneAsync(x => x.Id == permit.Id, permit);
        await using var host = await Server(database);
        using var request = new HttpRequestMessage(HttpMethod.Post, "/gw/v1/send")
        {
            Content = JsonContent.Create(new { AppCallerCode = Caller, ModelType = "chat", Context = new { UserId = "scheduled-owner", ExecutionOrigin = "scheduled" } }),
        };
        request.Headers.Add("X-Gateway-Key", TransportKey); request.Headers.Add("X-Gateway-Source", "map");
        request.Headers.Add("X-Gateway-App-Caller", Caller); request.Headers.Add("X-Gateway-Execution-Origin", "scheduled");
        request.Headers.Add(GatewayTaskAdmission.HeaderName, permit.Id);
        var response = await host.GetTestClient().SendAsync(request);

        response.StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        (await response.Content.ReadAsStringAsync()).ShouldContain("TASK_PERMIT_INVALID");
        database.PaidCalls.ShouldBe(0);
        (await database.Permits.Find(x => x.Id == permit.Id).SingleAsync()).CallCount.ShouldBe(0);
    }

    [Theory]
    [InlineData("actor")]
    [InlineData("credential")]
    [InlineData("deployment")]
    [InlineData("task")]
    [InlineData("subjects")]
    [InlineData("delegation")]
    public async Task ScheduledPermitStillRequiresCompletePlatformFacts(string missing)
    {
        await using var database = await TestDatabase.CreateAsync();
        var permit = await database.ScheduledPermitAsync();
        if (missing == "actor") permit.ActorUserId = "";
        if (missing == "credential") permit.TriggerCredentialId = "";
        if (missing == "deployment") permit.SourceDeployment = "";
        if (missing == "task") permit.SourceTask = "";
        if (missing == "subjects") permit.SubjectUserIds = [];
        if (missing == "delegation") permit.AllowDelegatedSubjects = true;
        await database.Permits.ReplaceOneAsync(x => x.Id == permit.Id, permit);
        await using var host = await Server(database);
        var response = await Send(host.GetTestClient(), "POST", "/gw/v1/send", permit.Id,
            context: new { UserId = "scheduled-owner" }, subject: "scheduled-owner");

        response.StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        (await response.Content.ReadAsStringAsync()).ShouldContain("TASK_PERMIT_INVALID");
        database.PaidCalls.ShouldBe(0);
        (await database.Permits.Find(x => x.Id == permit.Id).SingleAsync()).CallCount.ShouldBe(0);
    }

    [Theory]
    [InlineData("expired", "TASK_PERMIT_INVALID")]
    [InlineData("revoked", "TASK_PERMIT_INVALID")]
    [InlineData("zero-calls", "TASK_PERMIT_INVALID")]
    [InlineData("too-many-calls", "TASK_PERMIT_INVALID")]
    [InlineData("too-many-runs", "TASK_PERMIT_INVALID")]
    [InlineData("future-created", "TASK_PERMIT_INVALID")]
    [InlineData("long-lived", "TASK_PERMIT_INVALID")]
    [InlineData("unknown-origin", "TASK_PERMIT_INVALID")]
    [InlineData("different-deployment", "TASK_PERMIT_DEPLOYMENT_DENIED")]
    [InlineData("different-caller", "TASK_PERMIT_CALLER_DENIED")]
    [InlineData("wildcard-caller", "TASK_PERMIT_INVALID")]
    [InlineData("different-tenant", "TASK_PERMIT_INVALID")]
    public async Task InvalidAuthorityNeverConsumesOrSends(string condition, string error)
    {
        await using var database = await TestDatabase.CreateAsync();
        var permit = await database.PermitAsync();
        switch (condition)
        {
            case "expired": permit.ExpiresAt = DateTime.UtcNow.AddSeconds(-1); break;
            case "revoked": permit.RevokedAt = DateTime.UtcNow; break;
            case "zero-calls": permit.MaxCalls = 0; break;
            case "too-many-calls": permit.MaxCalls = 257; break;
            case "too-many-runs": permit.MaxRuns = 17; break;
            case "future-created": permit.CreatedAt = DateTime.UtcNow.AddMinutes(1); break;
            case "long-lived": permit.ExpiresAt = permit.CreatedAt.AddHours(25); break;
            case "unknown-origin": permit.Origin = "manual-guessed"; break;
            case "different-deployment": permit.SourceDeployment = "another:deployment"; break;
            case "different-caller": permit.AllowedAppCallerCodes = ["different.caller::chat"]; break;
            case "wildcard-caller": permit.AllowedAppCallerCodes = ["*"]; break;
            case "different-tenant": permit.TenantId = "other-tenant"; break;
        }
        await database.Permits.ReplaceOneAsync(x => x.Id == permit.Id, permit);
        await using var host = await Server(database);
        var response = await Send(host.GetTestClient(), "POST", "/gw/v1/send", permit.Id);
        response.StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        (await response.Content.ReadAsStringAsync()).ShouldContain(error);
        database.PaidCalls.ShouldBe(0);
        (await database.Permits.Find(x => x.Id == permit.Id).SingleAsync()).CallCount.ShouldBe(0);
    }

    [Fact]
    public async Task PersistedRunRequiresAValidBindingAndCannotBorrowAnotherRun()
    {
        await using var database = await TestDatabase.CreateAsync();
        var permit = await database.PermitAsync();
        permit.BoundRunIds = ["bound-run"];
        await database.Permits.ReplaceOneAsync(x => x.Id == permit.Id, permit);
        await using var host = await Server(database);
        var denied = await Send(host.GetTestClient(), "POST", "/gw/v1/send", permit.Id, context: new { RunId = "other-run" });
        denied.StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        (await denied.Content.ReadAsStringAsync()).ShouldContain("TASK_PERMIT_RUN_DENIED");
        var accepted = await Send(host.GetTestClient(), "POST", "/gw/v1/send", permit.Id, context: new { RunId = "bound-run" });
        accepted.StatusCode.ShouldBe(HttpStatusCode.OK);
        database.Requests.Single().Context!.RunId.ShouldBe("bound-run");
        database.PaidCalls.ShouldBe(1);
    }

    [Fact]
    public async Task ReadOnlyResolveDoesNotConsumeTaskCallAllowance()
    {
        await using var database = await TestDatabase.CreateAsync();
        var permit = await database.PermitAsync(maxCalls: 1);
        await using var host = await Server(database);
        var resolve = await Send(host.GetTestClient(), "POST", "/gw/v1/resolve", permit.Id);
        resolve.StatusCode.ShouldBe(HttpStatusCode.OK);
        (await database.Permits.Find(x => x.Id == permit.Id).SingleAsync()).CallCount.ShouldBe(0);
        (await Send(host.GetTestClient(), "POST", "/gw/v1/send", permit.Id)).StatusCode.ShouldBe(HttpStatusCode.OK);
        database.PaidCalls.ShouldBe(1);
    }

    [Fact]
    public async Task MissingAdmissionServiceFailsClosed()
    {
        await using var database = await TestDatabase.CreateAsync();
        var permit = await database.PermitAsync();
        await using var host = await Server(database, omitAdmissionService: true);
        var response = await Send(host.GetTestClient(), "POST", "/gw/v1/send", permit.Id);
        response.StatusCode.ShouldBe(HttpStatusCode.ServiceUnavailable);
        (await response.Content.ReadAsStringAsync()).ShouldContain("TASK_ADMISSION_UNAVAILABLE");
        database.PaidCalls.ShouldBe(0);
    }

    [Theory]
    [InlineData("/v1/messages", "Authorization")]
    [InlineData("/v1/messages", "x-api-key")]
    [InlineData("/v1/responses", "Authorization")]
    [InlineData("/v1/chat/completions", "Authorization")]
    public async Task HeaderlessSdkSidecarUsesFrozenCallerModelAndBothFiniteBudgets(string path, string credentialHeader)
    {
        await using var database = await TestDatabase.CreateAsync();
        var permit = await database.PermitAsync(maxCalls: 3);
        var (grant, key) = await database.SidecarAsync(permit);
        await using var host = await Server(database);
        using var request = SdkRequest(path, key);
        if (credentialHeader == "x-api-key")
        {
            request.Headers.Authorization = null;
            request.Headers.Add(credentialHeader, key);
        }
        var response = await host.GetTestClient().SendAsync(request);
        response.StatusCode.ShouldBe(HttpStatusCode.OK);
        var sent = database.Requests.Single();
        sent.AppCallerCode.ShouldBe(Caller); sent.GetEffectiveExpectedModel().ShouldBe(grant.Model);
        sent.Context!.RunId.ShouldBe("sdk-run"); sent.Context.UserId.ShouldBe("server-actor");
        sent.Context.TriggerActorUserId.ShouldBe("server-actor"); sent.Context.TaskPermitId.ShouldBe(permit.Id);
        sent.Context.ExecutionOrigin.ShouldBe(TaskExecutionOrigins.Interactive);
        if (path == "/v1/messages")
        {
            sent.RequestBody!["tools"]![0]!["type"]!.GetValue<string>().ShouldBe("function");
            sent.RequestBody["tools"]![0]!["function"]!["name"]!.GetValue<string>().ShouldBe("map_read_only_tool");
        }
        (await database.Permits.Find(x => x.Id == permit.Id).SingleAsync()).CallCount.ShouldBe(1);
        (await database.Grants.Find(x => x.Id == grant.Id).SingleAsync()).CallCount.ShouldBe(1);
        database.PaidCalls.ShouldBe(1);
    }

    [Theory]
    [InlineData("wrong-model", "GATEWAY_RUNTIME_GRANT_MODEL_DENIED")]
    [InlineData("wrong-caller", "GATEWAY_RUNTIME_GRANT_SCOPE_DENIED")]
    [InlineData("native-route", "GATEWAY_RUNTIME_GRANT_ROUTE_DENIED")]
    [InlineData("image-route", "GATEWAY_RUNTIME_GRANT_ROUTE_DENIED")]
    [InlineData("missing-parent", "TASK_PERMIT_REQUIRED")]
    [InlineData("expired-parent", "TASK_PERMIT_INVALID")]
    [InlineData("unsupported-purpose", "GATEWAY_RUNTIME_GRANT_ROUTE_DENIED")]
    [InlineData("old-design-compat", "GATEWAY_RUNTIME_GRANT_ROUTE_DENIED")]
    [InlineData("wrong-method", "GATEWAY_ROUTE_NOT_ADMITTED")]
    public async Task SidecarCannotExpandItsTaskOrLegacyDesignRoutes(string condition, string error)
    {
        await using var database = await TestDatabase.CreateAsync();
        var permit = await database.PermitAsync(maxCalls: 3);
        var (grant, key) = await database.SidecarAsync(permit);
        var path = condition switch { "native-route" => "/gw/v1/send", "image-route" => "/v1/images/generations", _ => "/v1/messages" };
        if (condition == "missing-parent") grant.TaskPermitId = null;
        if (condition == "unsupported-purpose") grant.Purpose = "future-unapproved-purpose";
        if (condition == "old-design-compat") grant.Purpose = "";
        if (condition == "expired-parent") { permit.ExpiresAt = DateTime.UtcNow.AddSeconds(-1); await database.Permits.ReplaceOneAsync(x => x.Id == permit.Id, permit); }
        await database.Grants.ReplaceOneAsync(x => x.Id == grant.Id, grant);
        await using var host = await Server(database);
        using var request = SdkRequest(path, key, condition == "wrong-model" ? "different-logical-model" : grant.Model);
        if (condition == "wrong-caller") request.Headers.Add("X-Gateway-App-Caller", "other.caller::chat");
        if (condition is "native-route" or "old-design-compat") { request.Headers.Add("X-Gateway-Source", "map"); request.Headers.Add("X-Gateway-App-Caller", Caller); }
        if (condition == "wrong-method") request.Method = HttpMethod.Get;
        var response = await host.GetTestClient().SendAsync(request);
        response.StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        (await response.Content.ReadAsStringAsync()).ShouldContain(error);
        database.PaidCalls.ShouldBe(0);
    }

    [Theory]
    [InlineData("Authorization")]
    [InlineData("x-api-key")]
    public async Task PrefixShapedUnknownSidecarKeyNeverAuthenticates(string credentialHeader)
    {
        await using var database = await TestDatabase.CreateAsync(); await using var host = await Server(database);
        using var request = SdkRequest("/v1/messages", "gwrg_unknown_prefix_is_not_proof");
        if (credentialHeader == "x-api-key")
        {
            request.Headers.Authorization = null;
            request.Headers.Add(credentialHeader, "gwrg_unknown_prefix_is_not_proof");
        }
        (await host.GetTestClient().SendAsync(request)).StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
        database.PaidCalls.ShouldBe(0);
    }

    [Theory]
    [InlineData("/v1/chat/completions", false)]
    [InlineData("/v1/messages", true)]
    public async Task AnthropicCredentialCannotExpandRoutesOrOverrideExplicitGatewayKey(string path, bool explicitInvalidKey)
    {
        await using var database = await TestDatabase.CreateAsync();
        var permit = await database.PermitAsync(maxCalls: 3);
        var (grant, key) = await database.SidecarAsync(permit);
        await using var host = await Server(database);
        using var request = SdkRequest(path, key);
        request.Headers.Authorization = null;
        request.Headers.Add("x-api-key", key);
        if (explicitInvalidKey) request.Headers.Add("X-Gateway-Key", "invalid-explicit-key");
        (await host.GetTestClient().SendAsync(request)).StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
        database.PaidCalls.ShouldBe(0);
        (await database.Permits.Find(x => x.Id == permit.Id).SingleAsync()).CallCount.ShouldBe(0);
        (await database.Grants.Find(x => x.Id == grant.Id).SingleAsync()).CallCount.ShouldBe(0);
    }

    [Fact]
    public async Task AsrRollingWindowsConsumeSameParentAndStopBeforeTheFirstExcessSend()
    {
        await using var database = await TestDatabase.CreateAsync();
        var caller = AppCallerRegistry.DocumentStoreAgent.Subtitle.Audio;
        var permit = await database.PermitAsync(maxCalls: 3); permit.AllowedAppCallerCodes = [caller];
        await database.Permits.ReplaceOneAsync(x => x.Id == permit.Id, permit);
        var http = new DefaultHttpContext(); http.Request.Headers[GatewayTaskAdmission.HeaderName] = permit.Id;
        var authorization = new GatewayKeyAuthorization(true, true, 200, "", "", TenantId: permit.TenantId, LegacySharedKey: true);
        var admission = new GatewayTaskAdmission(database.Data, new ConfigurationBuilder().Build(), NullLogger<GatewayTaskAdmission>.Instance);
        (await admission.AdmitAsync(http, authorization, caller, true, CancellationToken.None)).Allowed.ShouldBeTrue();
        var gateway = new Mock<PrdAgent.Core.LlmGateway.ILlmGateway>();
        var vendorCalls = 0;
        gateway.Setup(x => x.SendRawWithResolutionAsync(It.IsAny<GatewayRawRequest>(), It.IsAny<GatewayModelResolution>(), It.IsAny<CancellationToken>()))
            .Callback(() => vendorCalls++)
            .ReturnsAsync(new GatewayRawResponse { Success = true, StatusCode = 200, Content = "{\"text\":\"录音片段\"}" });
        var resolver = new Mock<IModelResolver>();
        var service = new LiveAsrBatchFallbackService(gateway.Object, resolver.Object, NullLogger<LiveAsrBatchFallbackService>.Instance);
        var frames = Channel.CreateUnbounded<LiveAsrAudioFrame>();
        for (var i = 1; i <= 3; i++) await frames.Writer.WriteAsync(new LiveAsrAudioFrame(i, Enumerable.Repeat((byte)1, LiveAsrBatchFallbackService.WindowBytes).ToArray()));
        await frames.Writer.WriteAsync(new LiveAsrAudioFrame(4, [], IsFinal: true)); frames.Writer.TryComplete();
        var candidate = new ModelResolutionResult { Success = true, ActualPlatformId = "fixture", ActualModel = "openai/gpt-audio", PlatformType = "openai", Protocol = "openrouter" };
        var denied = await Assert.ThrowsAsync<TaskExecutionAdmissionException>(() => service.TranscribeAsync([candidate], frames.Reader,
            _ => Task.CompletedTask, null, new GatewayRequestContext(), beforeFallbackSend: async token =>
            {
                var result = await admission.ReserveContinuationAsync(http, authorization, caller, token);
                if (!result.Allowed) throw new TaskExecutionAdmissionException(result.ErrorCode, result.Message, result.StatusCode);
            }));
        denied.Code.ShouldBe("TASK_PERMIT_EXHAUSTED"); vendorCalls.ShouldBe(2);
        (await database.Permits.Find(x => x.Id == permit.Id).SingleAsync()).CallCount.ShouldBe(3);
    }

    private static HttpRequestMessage SdkRequest(string path, string key, string model = "nonexistent-fixture-model")
    {
        var body = JsonSerializer.SerializeToNode(new { model, messages = new[] { new { role = "user", content = "hello" } }, input = "hello", max_tokens = 32 })!.AsObject();
        if (path == "/v1/messages")
            body["tools"] = JsonSerializer.SerializeToNode(new[] { new { name = "map_read_only_tool", input_schema = new { type = "object" } } });
        var request = new HttpRequestMessage(HttpMethod.Post, path)
        {
            Content = JsonContent.Create(body),
        };
        request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", key); return request;
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ExternalAsrWindowsRecheckServiceScopeAndAutomaticLimits(bool revokeAfterFirstWindow)
    {
        await using var database = await TestDatabase.CreateAsync();
        const string tenant = "external-asr";
        var caller = AppCallerRegistry.DocumentStoreAgent.Subtitle.Audio;
        var key = "external-asr-isolated-test-key";
        var serviceKey = new GatewayServiceKeyRecord
        {
            TenantId = tenant, SourceSystem = "external", ClientCode = "asr-client", Environment = "test", Purpose = "external-platform",
            AppCallerCodes = [caller], IngressProtocols = ["gw-native"], Scopes = ["stream:invoke"],
            KeyHash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(key))).ToLowerInvariant(),
        };
        await database.Data.Database.GetCollection<BsonDocument>("llmgw_tenants").InsertOneAsync(new BsonDocument { { "_id", tenant }, { "Status", "active" } });
        var keys = database.Data.Database.GetCollection<GatewayServiceKeyRecord>("llmgw_service_keys");
        await keys.InsertOneAsync(serviceKey);
        await database.Data.Database.GetCollection<GatewayServiceKeyDirectoryRecord>("llmgw_service_key_directory").InsertOneAsync(new GatewayServiceKeyDirectoryRecord
            { TenantId = tenant, ServiceKeyId = serviceKey.Id, KeyHash = serviceKey.KeyHash });
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
            { ["LlmGateway:MinimumProtection:AutomaticAppCallerPerHour"] = "3" }).Build();
        var authorizer = new GatewayScopedKeyAuthorizer(database.Data, configuration);
        var safety = new GatewayMinimumProtectionCoordinator(database.Data, configuration, NullLogger<GatewayMinimumProtectionCoordinator>.Instance);
        var authorization = await authorizer.AuthorizeAsync(key, "", "external", caller, "gw-native", "stream:invoke", null, CancellationToken.None,
            requestPath: "/gw/v1/asr/live");
        authorization.Allowed.ShouldBeTrue(authorization.ErrorCode + ": " + authorization.Detail);
        using var services = new ServiceCollection().AddSingleton<IGatewayScopedKeyAuthorizer>(authorizer).AddSingleton(safety).BuildServiceProvider();
        var http = new DefaultHttpContext { RequestServices = services };
        http.Request.Headers["X-Gateway-Key"] = key;
        var admission = new GatewayTaskAdmission(database.Data, configuration, NullLogger<GatewayTaskAdmission>.Instance);
        (await admission.AdmitAsync(http, authorization, caller, true, CancellationToken.None)).Allowed.ShouldBeTrue();
        (await safety.CheckAsync(tenant, caller, ModelTypes.Asr, null, "handshake", new GatewayMinimumRequestIdentity("automatic", null), null, null, CancellationToken.None)).Rejected.ShouldBeFalse();
        var vendorCalls = 0;
        var gateway = new Mock<ILlmGateway>();
        gateway.Setup(x => x.SendRawWithResolutionAsync(It.IsAny<GatewayRawRequest>(), It.IsAny<GatewayModelResolution>(), It.IsAny<CancellationToken>()))
            .Returns(async () =>
            {
                vendorCalls++;
                if (revokeAfterFirstWindow) await keys.UpdateOneAsync(x => x.Id == serviceKey.Id, Builders<GatewayServiceKeyRecord>.Update.Set(x => x.Enabled, false));
                return new GatewayRawResponse { Success = true, StatusCode = 200, Content = "{\"text\":\"录音片段\"}" };
            });
        var service = new LiveAsrBatchFallbackService(gateway.Object, new Mock<IModelResolver>().Object, NullLogger<LiveAsrBatchFallbackService>.Instance);
        var frames = Channel.CreateUnbounded<LiveAsrAudioFrame>();
        for (var i = 1; i <= 3; i++) await frames.Writer.WriteAsync(new LiveAsrAudioFrame(i, Enumerable.Repeat((byte)1, LiveAsrBatchFallbackService.WindowBytes).ToArray()));
        frames.Writer.TryComplete();
        var candidate = new ModelResolutionResult { Success = true, ActualModel = "openai/gpt-audio", ActualPlatformId = "fixture", PlatformType = "openai", Protocol = "openrouter" };
        var blocked = await Assert.ThrowsAsync<TaskExecutionAdmissionException>(() => service.TranscribeAsync([candidate], frames.Reader,
            _ => Task.CompletedTask, null, new GatewayRequestContext(), beforeFallbackSend: async token =>
            {
                var next = await admission.ReserveContinuationAsync(http, authorization, caller, token);
                if (!next.Allowed) throw new TaskExecutionAdmissionException(next.ErrorCode, next.Message, next.StatusCode);
            }));
        vendorCalls.ShouldBe(revokeAfterFirstWindow ? 1 : 2);
        blocked.Code.ShouldBe(revokeAfterFirstWindow ? "TASK_SERVICE_SCOPE_DENIED" : "AUTOMATIC_CONSUMPTION_LIMITED");
        (await database.Data.Database.GetCollection<BsonDocument>(GatewayMinimumProtectionCoordinator.WindowsCollection)
            .CountDocumentsAsync(new BsonDocument("Origin", "general"))).ShouldBe(0);
    }

    [Fact]
    public async Task RealClientStreamRetainsVerifiedScopeThroughCoreClientAndPaidAuthority()
    {
        await using var database = await TestDatabase.CreateAsync();
        var caller = AppCallerRegistry.Admin.ModelLab.Run;
        var permit = await database.PermitAsync(); permit.AllowedAppCallerCodes = [caller];
        await database.Permits.ReplaceOneAsync(x => x.Id == permit.Id, permit);
        await database.Data.Database.GetCollection<GatewayAppCallerRecord>("llmgw_app_callers").InsertOneAsync(new GatewayAppCallerRecord
            { TenantId = permit.TenantId, AppCallerCode = caller, RequestType = ModelTypes.Chat, Status = "active", RateLimitPerMinute = 1000 });
        var httpAccessor = new HttpContextAccessor(); var accessor = new LLMRequestContextAccessor();
        var authority = new GatewayInvocationAuthority(httpAccessor, new ConfigurationBuilder().Build());
        var resolver = new Mock<IModelResolver>();
        resolver.Setup(x => x.ResolveAsync(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<string?>(), It.IsAny<string?>(), It.IsAny<string?>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync(new ModelResolutionResult
            {
                Success = true, ActualPlatformId = "fixture", ActualModel = "fixture-model", PlatformType = "openai", Protocol = "openai",
                ApiUrl = "https://paid-fixture.invalid", ApiKey = "isolated-test-key",
            });
        var vendor = new ClientStreamVendor();
        var outbound = new Mock<IHttpClientFactory>(); outbound.Setup(x => x.CreateClient(It.IsAny<string>())).Returns(new HttpClient(vendor));
        var gateway = new LlmGateway(resolver.Object, outbound.Object, NullLogger<LlmGateway>.Instance,
            contextAccessor: accessor, invocationAuthority: authority);
        await using var host = await Server(database, implementation: gateway, suppliedAccessor: accessor, suppliedHttpAccessor: httpAccessor);
        using var request = new HttpRequestMessage(HttpMethod.Post, "/gw/v1/client-stream")
        {
            Content = JsonContent.Create(new
            {
                AppCallerCode = caller, ModelType = ModelTypes.Chat, SystemPrompt = "测试",
                Messages = new[] { new { Role = "user", Content = "测试" } },
                Context = new { UserId = "server-actor", TeamId = "forged-team", ServiceKeyId = "forged-key", IsHealthProbe = true },
            }),
        };
        request.Headers.Add("X-Gateway-Key", TransportKey); request.Headers.Add("X-Gateway-Source", "map");
        request.Headers.Add("X-Gateway-App-Caller", caller); request.Headers.Add(GatewayTaskAdmission.HeaderName, permit.Id);
        var response = await host.GetTestClient().SendAsync(request);
        response.StatusCode.ShouldBe(HttpStatusCode.OK);
        var chunks = (await response.Content.ReadAsStringAsync()).Split('\n')
            .Where(line => line.StartsWith("data: "))
            .Select(line => JsonSerializer.Deserialize<LLMStreamChunk>(line["data: ".Length..]));
        chunks.ShouldContain(chunk => chunk != null && chunk.Content == "有界调用");
        vendor.Calls.ShouldBe(1);
        (await database.Permits.Find(x => x.Id == permit.Id).SingleAsync()).CallCount.ShouldBe(1);
    }

    private sealed class ClientStreamVendor : HttpMessageHandler
    {
        internal int Calls;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref Calls);
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"有界调用\"}}]}\n\ndata: [DONE]\n\n", Encoding.UTF8, "text/event-stream"),
            });
        }
    }

    private static async Task<HttpResponseMessage> Send(HttpClient client, string method, string path,
        string? permitId = null, object? context = null, string subject = "server-actor")
    {
        using var request = new HttpRequestMessage(new HttpMethod(method), path);
        if (method == "POST") request.Content = JsonContent.Create(new
        {
            AppCallerCode = Caller, ModelType = "chat", model = "nonexistent-fixture-model",
            Context = context ?? new { SourceSystem = "map" },
        });
        request.Headers.Add("X-Gateway-Key", TransportKey);
        request.Headers.Add("X-Gateway-Source", "map");
        request.Headers.Add("X-Gateway-App-Caller", Caller);
        request.Headers.Add("X-Gateway-Execution-Origin", "interactive");
        request.Headers.Add("X-Gateway-Source-Deployment", "forged-deployment");
        request.Headers.Add("X-Gateway-User-Id", subject);
        if (permitId is not null) request.Headers.Add(GatewayTaskAdmission.HeaderName, permitId);
        return await client.SendAsync(request);
    }

    private static async Task<WebApplication> Server(TestDatabase database, bool omitAdmissionService = false,
        ILlmGateway? implementation = null, ILLMRequestContextAccessor? suppliedAccessor = null, IHttpContextAccessor? suppliedHttpAccessor = null)
    {
        var builder = WebApplication.CreateBuilder();
        builder.WebHost.UseTestServer(); builder.Logging.ClearProviders();
        builder.Services.AddSingleton(database.Data);
        builder.Services.AddSingleton<IGatewayScopedKeyAuthorizer, GatewayScopedKeyAuthorizer>();
        builder.Services.AddSingleton<IGatewayRuntimeGrantCallCounter, GatewayRuntimeGrantCallCounter>();
        var httpAccessor = suppliedHttpAccessor ?? new HttpContextAccessor();
        builder.Services.AddSingleton<IHttpContextAccessor>(httpAccessor);
        builder.Services.AddSingleton<IGatewayInvocationAuthority, GatewayInvocationAuthority>();
        if (!omitAdmissionService) builder.Services.AddSingleton<IGatewayTaskAdmission, GatewayTaskAdmission>();
        builder.Services.AddSingleton(suppliedAccessor ?? new LLMRequestContextAccessor());
        var gateway = new Mock<PrdAgent.Core.LlmGateway.ILlmGateway>();
        gateway.Setup(g => g.SendAsync(It.IsAny<GatewayRequest>(), It.IsAny<CancellationToken>()))
            .Callback<GatewayRequest, CancellationToken>((request, _) =>
            {
                var authority = new GatewayInvocationAuthority(httpAccessor, builder.Configuration);
                authority.AssertAuthorized(request.AppCallerCode, request.Context);
                database.Requests.Enqueue(request); Interlocked.Increment(ref database.PaidCalls);
            })
            .ReturnsAsync(new GatewayResponse { Success = true, StatusCode = 200, Content = "fixture upstream" });
        gateway.Setup(g => g.ResolveModelAsync(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<string?>(), It.IsAny<string?>(), It.IsAny<string?>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync(new GatewayModelResolution { Success = false, ErrorMessage = "fixture model unavailable" });
        builder.Services.AddSingleton(implementation ?? gateway.Object);
        var app = builder.Build(); app.UseWebSockets();
        app.MapGatewayServingEndpoints(new JsonSerializerOptions(), TransportKey, "phase1-fixture");
        app.MapLiveAsrGatewayEndpoint();
        app.MapPost("/future-paid", () => { Interlocked.Increment(ref database.PaidCalls); return Results.Ok(); });
        app.MapGet("/v1/models/future-paid", () => { Interlocked.Increment(ref database.PaidCalls); return Results.Ok(); });
        await app.StartAsync(); return app;
    }

    private sealed class TestDatabase : IAsyncDisposable
    {
        public LlmGatewayDataContext Data { get; }
        public IMongoCollection<GatewayTaskPermitRecord> Permits => Data.Database.GetCollection<GatewayTaskPermitRecord>(GatewayTaskPermitRecord.CollectionName);
        public IMongoCollection<GatewayRuntimeGrantRecord> Grants => Data.Database.GetCollection<GatewayRuntimeGrantRecord>("llmgw_runtime_grants");
        public ConcurrentQueue<GatewayRequest> Requests { get; } = new();
        public int PaidCalls;
        private readonly MongoClient _client;
        private TestDatabase(string connection)
        {
            _client = new MongoClient(connection);
            Data = new LlmGatewayDataContext(connection, "phase1_task_admission_" + Guid.NewGuid().ToString("N"));
        }
        public static async Task<TestDatabase> CreateAsync()
        {
            var connection = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION");
            if (string.IsNullOrWhiteSpace(connection)) throw new InvalidOperationException("任务准入行为测试必须提供隔离Mongo，不能静默跳过。");
            BsonClassMapRegistration.RegisterConventionsOnly();
            var database = new TestDatabase(connection);
            await database.Data.Database.RunCommandAsync<BsonDocument>(new BsonDocument("ping", 1));
            await database.Data.Database.GetCollection<BsonDocument>("llmgw_tenants").InsertOneAsync(new BsonDocument
                { { "_id", GatewayTenantDefaults.InternalTenantId }, { "Status", "active" }, { "RateLimitPerMinute", 1000 } });
            await database.Data.Database.GetCollection<GatewayAppCallerRecord>("llmgw_app_callers").InsertOneAsync(new GatewayAppCallerRecord
                { TenantId = GatewayTenantDefaults.InternalTenantId, AppCallerCode = Caller, RequestType = "chat", Status = "active", RateLimitPerMinute = 1000 });
            return database;
        }
        public async Task<GatewayTaskPermitRecord> PermitAsync(int maxCalls = 64, string origin = TaskExecutionOrigins.Interactive)
        {
            var permit = new GatewayTaskPermitRecord
            {
                TenantId = GatewayTenantDefaults.InternalTenantId, ActorUserId = "server-actor", TriggerCredentialId = "server-session",
                SubjectUserIds = ["server-actor"],
                Origin = origin, SourceDeployment = "prd-agent:production", SourceTask = "request:fixture",
                AllowedAppCallerCodes = [Caller], MaxCalls = maxCalls, MaxRuns = 1, ExpiresAt = DateTime.UtcNow.AddMinutes(5),
            };
            await Permits.InsertOneAsync(permit); return permit;
        }
        public ValueTask DisposeAsync() => new(_client.DropDatabaseAsync(Data.DatabaseName));
        public async Task<(GatewayRuntimeGrantRecord Grant, string Key)> SidecarAsync(GatewayTaskPermitRecord permit)
        {
            permit.BoundRunIds = ["sdk-run"]; await Permits.ReplaceOneAsync(x => x.Id == permit.Id, permit);
            var key = "gwrg_" + Guid.NewGuid().ToString("N");
            var grant = new GatewayRuntimeGrantRecord
            {
                Purpose = GatewayRuntimeGrantPurposePolicy.TaskSidecar, TenantId = permit.TenantId, UserId = "server-actor",
                AppCallerCode = Caller, RunId = "sdk-run", TaskPermitId = permit.Id, SourceDeployment = permit.SourceDeployment, Model = "nonexistent-fixture-model",
                KeyHash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(key))).ToLowerInvariant(),
                MaxCalls = permit.MaxCalls, ExpiresAt = DateTime.UtcNow.AddMinutes(1),
            };
            await Grants.InsertOneAsync(grant); return (grant, key);
        }

        public async Task<GatewayTaskPermitRecord> ScheduledPermitAsync()
        {
            var permit = await PermitAsync(maxCalls: 8, origin: TaskExecutionOrigins.Scheduled);
            permit.ActorUserId = "platform-scheduler:ReportAutoGenerateWorker";
            permit.SubjectUserIds = ["scheduled-owner"];
            permit.AllowDelegatedSubjects = false;
            permit.TriggerCredentialId = "schedule:ReportAutoGenerateWorker:report-123";
            permit.SourceTask = "ReportAutoGenerateWorker:report-123";
            await Permits.ReplaceOneAsync(x => x.Id == permit.Id, permit);
            return permit;
        }
    }
}
