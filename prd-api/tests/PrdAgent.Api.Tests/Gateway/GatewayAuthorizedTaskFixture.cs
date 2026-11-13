using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Security;
using PrdAgent.LlmGatewayHost;

namespace PrdAgent.Api.Tests.Gateway;

/// <summary>
/// 协议/序列化测试的窄授权环境。服务端预先授予有限许可，客户端必须提交同一许可，
/// 不关闭平台门；Mongo权限、隔离和竞争由GatewayTaskAdmissionIntegrationTests使用生产服务验证。
/// </summary>
internal sealed class GatewayAuthorizedTaskFixture : IGatewayTaskAdmission, ITaskExecutionAuthorizer
{
    internal static string PermitId { get; } = Guid.NewGuid().ToString("N");
    internal static ITaskExecutionAuthorizer Outbound { get; } = new GatewayAuthorizedTaskFixture();
    private readonly GatewayTaskPermitRecord _permit;
    private int _calls;

    private GatewayAuthorizedTaskFixture(GatewayRuntimeGrantRecord? runtime = null)
    {
        var actor = runtime?.UserId ?? "fixture-actor";
        _permit = new GatewayTaskPermitRecord
        {
            Id = runtime?.TaskPermitId ?? PermitId, TenantId = GatewayTenantDefaults.InternalTenantId,
            ActorUserId = actor, SubjectUserIds = [actor], TriggerCredentialId = "fixture-session",
            Origin = TaskExecutionOrigins.Interactive, SourceDeployment = "prd-agent:production",
            SourceTask = "request:protocol-fixture", MaxCalls = GatewayTaskPermitRecord.MaximumCalls,
            MaxRuns = GatewayTaskPermitRecord.MaximumRuns, ExpiresAt = DateTime.UtcNow.AddHours(1),
        };
        if (runtime is not null)
        {
            runtime.TaskPermitId = _permit.Id;
            _permit.AllowedAppCallerCodes = [runtime.AppCallerCode];
            _permit.BoundRunIds = [runtime.RunId];
        }
    }

    internal static void Register(IServiceCollection services, GatewayRuntimeGrantRecord? runtime = null)
        => services.AddSingleton<IGatewayTaskAdmission>(new GatewayAuthorizedTaskFixture(runtime));

    internal static IDisposable EnterTask() => TaskExecutionContext.Enter(new TaskExecutionIdentity(PermitId));

    internal static HttpClient Client(WebApplication app)
    {
        var client = app.GetTestClient();
        var fixture = app.Services.GetRequiredService<IGatewayTaskAdmission>() as GatewayAuthorizedTaskFixture;
        client.DefaultRequestHeaders.Add(GatewayTaskAdmission.HeaderName, fixture?._permit.Id ?? PermitId);
        return client;
    }

    public Task<GatewayTaskAdmissionDecision> AdmitAsync(HttpContext http, GatewayKeyAuthorization authorization,
        string appCallerCode, bool reserveCall, CancellationToken ct)
    {
        if (!authorization.LegacySharedKey && authorization.RuntimeGrant is null
            && !(authorization.TenantId == GatewayTenantDefaults.InternalTenantId
                && string.Equals(authorization.AuthenticatedSourceSystem, "map", StringComparison.OrdinalIgnoreCase)))
            return Task.FromResult(GatewayTaskAdmissionDecision.Allow());
        var provided = http.Request.Headers[GatewayTaskAdmission.HeaderName].ToString();
        if (provided != _permit.Id || authorization.RuntimeGrant is { } runtime && runtime.TaskPermitId != _permit.Id)
            return Task.FromResult(GatewayTaskAdmissionDecision.Deny("TASK_PERMIT_REQUIRED", "协议测试任务缺少已授权许可，请重新建立测试任务。"));
        if (reserveCall && Interlocked.Increment(ref _calls) > _permit.MaxCalls)
            return Task.FromResult(GatewayTaskAdmissionDecision.Deny("TASK_PERMIT_EXHAUSTED", "协议测试任务已达到执行上限，请重新建立测试任务。", 429));
        http.Items[GatewayTaskAdmission.HttpContextPermitKey] = _permit;
        http.Items[GatewayTaskAdmission.HttpContextLeaseKey] = new GatewayTaskLeaseFact(_permit.Id, "", "protocol-fixture", 1);
        http.Items[GatewayTaskAdmission.HttpContextSubjectKey] = _permit.ActorUserId;
        return Task.FromResult(GatewayTaskAdmissionDecision.Allow(_permit));
    }

    public Task AuthorizeOutboundAsync(HttpRequestMessage message, string appCallerCode, GatewayRequestContext? context, CancellationToken ct)
    {
        if (TaskExecutionContext.Current?.PermitId != PermitId)
            throw new TaskExecutionAdmissionException("TASK_EXECUTION_NOT_ADMITTED", "协议测试必须先进入已授权任务。");
        message.Headers.Remove(GatewayTaskAdmission.HeaderName);
        message.Headers.Add(GatewayTaskAdmission.HeaderName, PermitId);
        if (context is not null)
        {
            context.TaskPermitId = PermitId;
            context.ExecutionOrigin = _permit.Origin;
            context.TriggerActorUserId = _permit.ActorUserId;
            context.TriggerCredentialId = _permit.TriggerCredentialId;
            context.SourceDeployment = _permit.SourceDeployment;
            context.SourceTask = _permit.SourceTask;
            context.UserId = _permit.ActorUserId;
        }
        return Task.CompletedTask;
    }

    public Task<GatewayTaskAdmissionDecision> ReserveContinuationAsync(HttpContext http, GatewayKeyAuthorization authorization, string appCallerCode, CancellationToken ct)
        => AdmitAsync(http, authorization, appCallerCode, true, ct);
}
