using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Security;
using PrdAgent.Infrastructure.Database;
using Microsoft.Extensions.DependencyInjection;

namespace PrdAgent.LlmGatewayHost;

/// <summary>进程内付费出口也必须来自全局付费准入；新后台线程不能借用服务实例发送。</summary>
public sealed class GatewayInvocationAuthority(IHttpContextAccessor accessor, IConfiguration configuration,
    ITaskExecutionCoordinator? executions = null) : IGatewayInvocationAuthority
{
    public const string PaidAdmissionKey = "llmgw.task.paid.admitted";
    public const string AdmittedCallerKey = "llmgw.task.admitted.caller";

    public void AssertAuthorized(string appCallerCode, GatewayRequestContext? context)
    {
        var http = accessor.HttpContext;
        if (http is null || context is null || http.Items[PaidAdmissionKey] is not true
            || http.Items[AdmittedCallerKey] is not string caller
            || !string.Equals(caller, appCallerCode, StringComparison.OrdinalIgnoreCase)
            || http.Items["llmgw.key.authorization"] is not GatewayKeyAuthorization { Allowed: true, Authenticated: true } authorization
            || context.TenantId != authorization.TenantId || context.TeamId != authorization.TeamId
            || context.ServiceKeyId != authorization.KeyId)
            Deny();

        var verifiedHttp = http!;
        var verifiedContext = context!;
        var verifiedAuthorization = (GatewayKeyAuthorization)verifiedHttp.Items["llmgw.key.authorization"]!;
        var source = verifiedAuthorization.AuthenticatedSourceSystem
            ?? (verifiedAuthorization.LegacySharedKey || verifiedAuthorization.RuntimeGrant is not null ? "map" : "external");
        if (verifiedContext.SourceSystem != source || verifiedContext.IsHealthProbe == true)
            Deny();

        if (GatewayTaskAdmission.RequiresInternalPermit(verifiedAuthorization, configuration))
        {
            if (verifiedHttp.Items[GatewayTaskAdmission.HttpContextPermitKey] is not GatewayTaskPermitRecord permit
                || verifiedHttp.Items[GatewayTaskAdmission.HttpContextLeaseKey] is not GatewayTaskLeaseFact lease
                || verifiedContext.TaskLeaseRunId != lease.RunId || verifiedContext.TaskLeaseOwnerHash != lease.OwnerHash
                || verifiedContext.TaskLeaseFence != lease.Fence || lease.PermitId != permit.Id
                || verifiedHttp.Items[GatewayTaskAdmission.HttpContextSubjectKey] is not string subject
                || verifiedContext.TaskPermitId != permit.Id || verifiedContext.ExecutionOrigin != permit.Origin
                || verifiedContext.TriggerActorUserId != permit.ActorUserId || verifiedContext.TriggerCredentialId != permit.TriggerCredentialId
                || verifiedContext.SourceDeployment != permit.SourceDeployment || verifiedContext.SourceTask != permit.SourceTask
                || verifiedContext.UserId != subject || !permit.SubjectUserIds.Contains(subject, StringComparer.Ordinal)
                || !permit.AllowedAppCallerCodes.Contains(appCallerCode, StringComparer.OrdinalIgnoreCase)
                || !string.IsNullOrWhiteSpace(verifiedContext.RunId) && !permit.BoundRunIds.Contains(verifiedContext.RunId, StringComparer.Ordinal)
                || verifiedAuthorization.RuntimeGrant is { RunId.Length: > 0 } grant && verifiedContext.RunId != grant.RunId)
                Deny();
        }
        else if (verifiedContext.TaskPermitId is not null || verifiedContext.ExecutionOrigin != TaskExecutionOrigins.Agent
            || verifiedContext.UserId is not null || verifiedContext.TriggerActorUserId is not null
            || verifiedContext.TriggerCredentialId != verifiedAuthorization.KeyId
            || verifiedContext.SourceTask != "service:" + verifiedAuthorization.KeyId || verifiedContext.SourceDeployment is not null)
            Deny();
    }

    public async Task AssertCurrentAsync(string appCallerCode, GatewayRequestContext? context, CancellationToken ct)
    {
        AssertAuthorized(appCallerCode, context);
        var http = accessor.HttpContext!;
        var authorization = (GatewayKeyAuthorization)http.Items["llmgw.key.authorization"]!;
        if (!GatewayTaskAdmission.RequiresInternalPermit(authorization, configuration)) return;
        var lease = (GatewayTaskLeaseFact)http.Items[GatewayTaskAdmission.HttpContextLeaseKey]!;
        var coordinator = executions ?? http.RequestServices.GetService<ITaskExecutionCoordinator>()
            ?? new TaskExecutionCoordinator(http.RequestServices.GetRequiredService<LlmGatewayDataContext>());
        if (!await coordinator.ValidateHashAsync(lease.PermitId, lease.RunId, lease.OwnerHash, lease.Fence, true, ct, context?.RunId))
            throw new TaskExecutionAdmissionException("TASK_EXECUTION_LEASE_INVALID",
                "任务执行授权已失效，已停止后续发送；请查看任务状态后重新提交。", 403);
    }

    [System.Diagnostics.CodeAnalysis.DoesNotReturn]
    private static void Deny() => throw new TaskExecutionAdmissionException("GATEWAY_INVOCATION_NOT_AUTHORIZED",
        "此调用尚未获得平台执行许可，已停止发送；请从正常业务入口重新发起任务。", 403);
}
