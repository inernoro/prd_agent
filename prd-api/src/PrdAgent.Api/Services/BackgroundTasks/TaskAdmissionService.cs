using System.Security.Claims;
using Microsoft.AspNetCore.Mvc.Controllers;
using MongoDB.Driver;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Core.Interfaces;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Security;

namespace PrdAgent.Api.Services.BackgroundTasks;

/// <summary>认证与权限中间件通过后，由平台为已登记动作签发有限任务许可。</summary>
public sealed class TaskAdmissionService(LlmGatewayDataContext data, IConfiguration configuration,
    PrdAgent.Api.Services.Mcp.McpLoopbackSignal? loopback = null, ITaskExecutionCoordinator? executions = null)
{
    private readonly ITaskExecutionCoordinator _executions = executions ?? new TaskExecutionCoordinator(data);
    public Task SaveAcceptedResponseAsync(string permitId, int status, string contentType, string? body, CancellationToken ct)
        => _executions.SaveAcceptedResponseAsync(permitId, status, contentType, body, ct);
    public async Task<TaskExecutionIdentity?> AdmitRequestAsync(HttpContext http, CancellationToken ct)
    {
        var action = http.GetEndpoint()?.Metadata.GetMetadata<ControllerActionDescriptor>();
        if (action is null || http.User.Identity?.IsAuthenticated != true) return null;
        var policy = TaskAdmissionPolicies.Find(action.ControllerTypeInfo.FullName!, action.ActionName);
        if (policy is null || policy.Timing != TaskAdmissionTiming.Middleware) return null;
        if (policy.Operation == "PrdAgent.Api.Controllers.McpGatewayController.Handle"
            && !await TaskBusinessIntent.IsMcpToolCallAsync(http, ct)) return null;
        var actor = ResolveActor(http.User);
        if (actor is null || policy.AppCallers.Count == 0) return null;
        return await AdmitAuthenticatedActionAsync(http, policy, actor, ct);
    }

    /// <summary>已登记的混合 CRUD/付费动作只在业务检查通过且确实进入付费分支时领取许可。</summary>
    public async Task<TaskExecutionIdentity> AdmitAuthenticatedPaidBranchAsync(HttpContext http, CancellationToken ct)
    {
        if (http.User.Identity?.IsAuthenticated != true)
            throw new TaskExecutionAdmissionException("TASK_TRIGGER_IDENTITY_MISSING", "本次操作缺少有效登录身份，已停止付费任务；请登录后重新提交。");
        var action = http.GetEndpoint()?.Metadata.GetMetadata<ControllerActionDescriptor>();
        var policy = action is null ? null : TaskAdmissionPolicies.Find(action.ControllerTypeInfo.FullName!, action.ActionName);
        if (policy is null || policy.Timing != TaskAdmissionTiming.AuthenticatedPaidBranch || policy.AppCallers.Count == 0)
            throw new TaskExecutionAdmissionException("TASK_SOURCE_NOT_REGISTERED", "此操作尚未登记按需执行策略，已停止付费任务；请联系管理员核对入口。");
        var actor = ResolveActor(http.User);
        if (actor is null)
            throw new TaskExecutionAdmissionException("TASK_TRIGGER_IDENTITY_MISSING", "本次操作缺少可核验的登录身份，已停止付费任务；请登录后重新提交。");
        return await AdmitAuthenticatedActionAsync(http, policy, actor, ct);
    }

    private async Task<TaskExecutionIdentity> AdmitAuthenticatedActionAsync(
        HttpContext http, TaskAdmissionPolicy policy, string actor, CancellationToken ct)
    {
        if (TaskAdmissionRequestState.Get(http).Identity is { } admitted) return admitted;
        if (loopback?.IsGatewayContinuation(http.Request) == true)
        {
            // 已验证的同进程回环沿用父任务额度；外部自写相同头不能证明续跳。
            var parentId = http.Request.Headers[PrdAgent.Api.Services.Mcp.McpLoopbackSignal.TaskPermitHeaderName].ToString();
            var parent = TaskExecutionAuthorizer.ValidPermitId(parentId)
                ? await data.Database.GetCollection<GatewayTaskPermitRecord>(GatewayTaskPermitRecord.CollectionName)
                    .Find(x => x.Id == parentId).FirstOrDefaultAsync(ct) : null;
            if (parent is null || parent.ActorUserId != actor || parent.RevokedAt is not null
                || parent.ExpiresAt <= DateTime.UtcNow
                || parent.SourceDeployment != TaskPermitDeployment.Resolve(configuration))
                throw new TaskExecutionAdmissionException("TASK_CONTINUATION_NOT_ADMITTED", "任务续跳缺少有效的原始执行许可，已停止；请重新明确提交任务。");
            var token = http.Request.Headers[TaskExecutionHeaders.LeaseToken].ToString();
            var run = http.Request.Headers["X-Map-Task-Run"].ToString();
            if (token.Length != 32 || !token.All(char.IsAsciiHexDigit)
                || !long.TryParse(http.Request.Headers[TaskExecutionHeaders.LeaseFence], out var fence)
                || !await _executions.ValidateHashAsync(parent.Id, run, TaskExecutionCoordinator.OwnerHash(token), fence, false, ct))
                throw new TaskExecutionAdmissionException("TASK_EXECUTION_LEASE_INVALID", "任务续跳的执行租约已失效，已停止；请重新明确提交任务。");
            return new(parent.Id, string.IsNullOrEmpty(run) ? null : run, new(parent.Id, string.IsNullOrEmpty(run) ? null : run, token, fence));
        }
        var (origin, credential) = ResolveOrigin(http.User, actor);
        var intent = await TaskBusinessIntent.ResolveAsync(http, policy.Operation, origin, false, ct);
        return await IssueAsync(policy, actor, origin, credential, intent, http, ct);
    }

    /// <summary>只在既有分享/快捷方式门禁已验证后调用，外部触发不能升级为登录会话来源。</summary>
    public async Task<TaskExecutionIdentity> AdmitVerifiedIntegrationAsync(
        HttpContext http, string actorUserId, string credentialReference, CancellationToken ct)
    {
        var action = http.GetEndpoint()?.Metadata.GetMetadata<ControllerActionDescriptor>();
        var operation = action is null ? null : $"{action.ControllerTypeInfo.FullName}.{action.ActionName}";
        if (operation is not ("PrdAgent.Api.Controllers.Api.WebPageAskController.AskStreamByShare"
            or "PrdAgent.Api.Controllers.ShortcutsController.Collect"
            or "PrdAgent.Api.Controllers.Api.LlmGatewayOpsCanaryController.RunAsrCanary"))
            throw new TaskExecutionAdmissionException("TASK_SOURCE_NOT_REGISTERED", "此外部触发入口未登记执行策略，已停止任务；请联系管理员核对入口。");
        var policy = TaskAdmissionPolicies.Find(action!.ControllerTypeInfo.FullName!, action.ActionName)!;
        var intent = await TaskBusinessIntent.ResolveAsync(http, policy.Operation, TaskExecutionOrigins.Agent, true, ct);
        return await IssueAsync(policy, actorUserId, TaskExecutionOrigins.Agent,
            $"verified-integration:{credentialReference}", intent, http, ct);
    }

    /// <summary>平台调度每次只签发一个具体任务，后台服务启动授权不是付费通票。</summary>
    public Task<TaskExecutionIdentity> AdmitScheduledTaskAsync(
        string worker, string taskId, string subjectUserId, CancellationToken ct)
    {
        if (!DeploymentAuthority.CanRunSharedScheduledWork(configuration)
            || AutomaticTaskExecutionContext.SourceDeployment is not { } source
            || !source.Contains($"/{worker}/", StringComparison.Ordinal))
            throw new TaskExecutionAdmissionException("TASK_SCHEDULE_NOT_ADMITTED", "自动任务未获得平台调度授权，本次执行已停止；请核对部署与任务配置。");
        var prefixes = worker switch
        {
            "WorkflowScheduleWorker" => Array.Empty<string>(),
            "ReportAutoGenerateWorker" => new[] { "report-agent." },
            "EmailChannelWorker" => new[] { "channel-adapter.email.", "workflow-agent.", "defect-agent." },
            _ => throw new TaskExecutionAdmissionException("TASK_SOURCE_NOT_REGISTERED", "此自动任务尚未登记有限执行范围，已停止付费调用；请联系管理员登记任务。"),
        };
        var callers = AppCallerRegistrationService.GetAllDefinitions().Select(x => x.AppCode)
            .Where(x => prefixes.Length == 0 || prefixes.Any(p => x.StartsWith(p, StringComparison.Ordinal)))
            .Distinct().ToArray();
        // 自动调度服务是执行来源；业务归属用户不是点击发起任务的人，不能把两者混为一谈。
        var operation = $"{worker}:{taskId}";
        return IssueAsync(new(operation, callers), $"platform-scheduler:{worker}",
            TaskExecutionOrigins.Scheduled, $"schedule:{worker}:{taskId}",
            new(taskId, TaskExecutionCoordinator.Fingerprint(subjectUserId), operation), null, ct, subjectUserId);
    }

    private async Task<TaskExecutionIdentity> IssueAsync(TaskAdmissionPolicy policy, string actor,
        string origin, string credential, TaskBusinessIntent intent, HttpContext? http, CancellationToken ct, string? subjectUserId = null)
    {
        if (string.IsNullOrWhiteSpace(actor) || string.IsNullOrWhiteSpace(credential)
            || actor.Length > 200 || credential.Length > 400 || policy.AppCallers.Count == 0
            || subjectUserId is not null && (string.IsNullOrWhiteSpace(subjectUserId) || subjectUserId.Length > 200))
            throw new TaskExecutionAdmissionException("TASK_TRIGGER_IDENTITY_MISSING", "本次任务缺少可核验的触发身份或执行范围，已停止；请重新明确提交操作。");
        var now = DateTime.UtcNow;
        var permit = new GatewayTaskPermitRecord
        {
            TenantId = configuration["LlmGateway:InternalTenantId"]?.Trim() is { Length: > 0 } tenant
                ? tenant : GatewayTenantDefaults.InternalTenantId,
            ActorUserId = actor,
            SubjectUserIds = new() { subjectUserId ?? actor },
            AllowDelegatedSubjects = policy.AllowDelegatedSubjects,
            TriggerCredentialId = credential,
            Origin = origin,
            SourceDeployment = TaskPermitDeployment.Resolve(configuration),
            SourceTask = policy.Operation,
            AllowedAppCallerCodes = policy.AppCallers.ToList(),
            MaxCalls = origin == TaskExecutionOrigins.Interactive ? policy.InteractiveMaxCalls
                : origin == TaskExecutionOrigins.Scheduled ? 8 : policy.AgentMaxCalls,
            MaxRuns = origin == TaskExecutionOrigins.Interactive ? 16
                : origin == TaskExecutionOrigins.Scheduled ? 1 : 2,
            CreatedAt = now,
            ExpiresAt = now + GatewayTaskPermitRecord.MaximumLifetime,
        };
        permit.ExecutionContractVersion = TaskExecutionCoordinator.ContractVersion;
        permit.Id = TaskExecutionCoordinator.BusinessId(permit.TenantId, actor, intent.Scope, intent.Key);
        permit.BusinessKeyHash = TaskExecutionCoordinator.Fingerprint(intent.Key);
        permit.RequestFingerprint = intent.Fingerprint;
        await TaskBudgetContracts.BindAsync(permit, configuration, data, ct);
        var result = await _executions.RegisterAsync(permit, http is not null, ct);
        if (result.Replayed && origin != TaskExecutionOrigins.Scheduled) throw new TaskIntentReplayException(result.Permit);
        var identity = result.Lease?.Identity ?? new TaskExecutionIdentity(result.Permit.Id);
        if (http is not null)
        {
            var state = TaskAdmissionRequestState.Get(http);
            state.Identity = identity;
            if (result.Lease is not null) state.Leases.Add(result.Lease);
        }
        return identity;
    }

    public static string? ResolveActor(ClaimsPrincipal user)
        => user.FindFirst(ClaimTypes.NameIdentifier)?.Value ?? user.FindFirst("sub")?.Value
           ?? user.FindFirst("boundUserId")?.Value;

    public static (string Origin, string Credential) ResolveOrigin(ClaimsPrincipal user, string actor)
    {
        // 判据来自认证处理器签出的 ClaimsIdentity，不从请求头、UserId 或提示词猜人类身份。
        var auth = user.FindFirst("authType")?.Value;
        var agentId = user.FindFirst("agentApiKeyId")?.Value;
        var ai = user.HasClaim("isAiSuperAccess", "1")
                 || user.Identities.Any(x => x.AuthenticationType is "AiAccessKey" or "ApiKey" or "StableSmoke");
        if (agentId is not null || ai || auth is not (null or "jwt" or "session")
            || user.FindFirst("clientType")?.Value == "ai")
            return (TaskExecutionOrigins.Agent, $"{auth ?? "service"}:{agentId ?? user.FindFirst("stableSmokeKeyId")?.Value ?? user.FindFirst("appId")?.Value ?? actor}");
        return (TaskExecutionOrigins.Interactive, $"session:{user.FindFirst("jti")?.Value ?? actor}");
    }
}
