using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.LlmGatewayHost;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

public sealed class GatewayInvocationAuthorityTests
{
    private const string Caller = AppCallerRegistry.Admin.ModelLab.Run;

    [Fact]
    public async Task FutureBackgroundWorkerCallingRealGatewayWithoutHttpHasZeroResolveOrUpstream()
    {
        var resolver = new Mock<IModelResolver>(MockBehavior.Strict);
        var outbound = new Mock<IHttpClientFactory>(MockBehavior.Strict);
        var authority = new GatewayInvocationAuthority(new HttpContextAccessor(), new ConfigurationBuilder().Build());
        var gateway = new LlmGateway(resolver.Object, outbound.Object, NullLogger<LlmGateway>.Instance, invocationAuthority: authority);

        var rejected = await Assert.ThrowsAsync<TaskExecutionAdmissionException>(() => gateway.SendAsync(new GatewayRequest
        {
            AppCallerCode = Caller, ModelType = ModelTypes.Chat,
            Context = new GatewayRequestContext { TenantId = GatewayTenantDefaults.InternalTenantId, UserId = "owner", ExecutionOrigin = "interactive" },
        }));

        rejected.Code.ShouldBe("GATEWAY_INVOCATION_NOT_AUTHORIZED");
        resolver.VerifyNoOtherCalls(); outbound.VerifyNoOtherCalls();
    }

    [Fact]
    public async Task ReadOnlyAuthorizationCannotStartARealRawPaidSend()
    {
        var (http, context) = AdmittedContext();
        http.Items.Remove(GatewayInvocationAuthority.PaidAdmissionKey);
        http.Request.Method = "POST"; http.Request.Path = "/gw/v1/resolve";
        var resolver = new Mock<IModelResolver>(MockBehavior.Strict);
        var outbound = new Mock<IHttpClientFactory>(MockBehavior.Strict);
        var authority = new GatewayInvocationAuthority(new HttpContextAccessor { HttpContext = http }, new ConfigurationBuilder().Build());
        var gateway = new LlmGateway(resolver.Object, outbound.Object, NullLogger<LlmGateway>.Instance, invocationAuthority: authority);

        await Assert.ThrowsAsync<TaskExecutionAdmissionException>(() => gateway.SendRawWithResolutionAsync(new GatewayRawRequest
        {
            AppCallerCode = Caller, ModelType = ModelTypes.Chat, Context = context,
        }, new GatewayModelResolution()));

        resolver.VerifyNoOtherCalls(); outbound.VerifyNoOtherCalls();
    }

    [Theory]
    [InlineData("caller")]
    [InlineData("subject")]
    [InlineData("source")]
    [InlineData("run")]
    public void PaidAdmissionCannotBeReusedForDifferentBusinessFacts(string changed)
    {
        var (http, context) = AdmittedContext();
        var authority = new GatewayInvocationAuthority(new HttpContextAccessor { HttpContext = http }, new ConfigurationBuilder().Build());
        authority.AssertAuthorized(Caller, context);
        var caller = Caller;
        if (changed == "caller") caller = AppCallerRegistry.DocumentStoreAgent.Subtitle.Audio;
        if (changed == "subject") context.UserId = "another-owner";
        if (changed == "source") context.ExecutionOrigin = "scheduled";
        if (changed == "run") context.RunId = "unbound-run";

        Assert.Throws<TaskExecutionAdmissionException>(() => authority.AssertAuthorized(caller, context));
    }

    [Fact]
    public void RegisteredExternalServiceKeepsAgentScopeWithoutAcceptingUserClaims()
    {
        var (http, _) = AdmittedContext();
        http.Items["llmgw.key.authorization"] = new GatewayKeyAuthorization(true, true, 200, "", "",
            TenantId: "external", KeyId: "service-key", AuthenticatedSourceSystem: "sdk");
        http.Items.Remove(GatewayTaskAdmission.HttpContextPermitKey);
        var context = new GatewayRequestContext
        {
            TenantId = "external", ServiceKeyId = "service-key", SourceSystem = "sdk",
            ExecutionOrigin = TaskExecutionOrigins.Agent, TriggerCredentialId = "service-key", SourceTask = "service:service-key",
        };
        var authority = new GatewayInvocationAuthority(new HttpContextAccessor { HttpContext = http }, new ConfigurationBuilder().Build());
        authority.AssertAuthorized(Caller, context);
        context.UserId = "self-reported-owner";
        Assert.Throws<TaskExecutionAdmissionException>(() => authority.AssertAuthorized(Caller, context));
    }

    private static (DefaultHttpContext Http, GatewayRequestContext Context) AdmittedContext()
    {
        var permit = new GatewayTaskPermitRecord
        {
            TenantId = GatewayTenantDefaults.InternalTenantId, ActorUserId = "owner", SubjectUserIds = ["owner"],
            Origin = TaskExecutionOrigins.Interactive, TriggerCredentialId = "session", SourceDeployment = "prd-agent:production",
            SourceTask = "request:fixture", AllowedAppCallerCodes = [Caller], BoundRunIds = ["bound-run"],
        };
        var http = new DefaultHttpContext();
        http.Items["llmgw.key.authorization"] = new GatewayKeyAuthorization(true, true, 200, "", "",
            TenantId: permit.TenantId, KeyId: "map-transport", LegacySharedKey: true, AuthenticatedSourceSystem: "map");
        http.Items[GatewayInvocationAuthority.PaidAdmissionKey] = true;
        http.Items[GatewayInvocationAuthority.AdmittedCallerKey] = Caller;
        http.Items[GatewayTaskAdmission.HttpContextPermitKey] = permit;
        http.Items[GatewayTaskAdmission.HttpContextSubjectKey] = "owner";
        return (http, new GatewayRequestContext
        {
            TenantId = permit.TenantId, ServiceKeyId = "map-transport", SourceSystem = "map", TaskPermitId = permit.Id,
            UserId = "owner", TriggerActorUserId = permit.ActorUserId, TriggerCredentialId = permit.TriggerCredentialId,
            SourceDeployment = permit.SourceDeployment, SourceTask = permit.SourceTask, ExecutionOrigin = permit.Origin, RunId = "bound-run",
        });
    }
}
