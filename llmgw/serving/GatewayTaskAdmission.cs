using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Security;

namespace PrdAgent.LlmGatewayHost;

/// <summary>付费数据面的默认门。业务端点不能靠漏写治理调用、来源头或用户归属获得执行权。</summary>
public static class GatewayTaskRoutePolicy
{
    public static string Normalize(string path) => path.TrimEnd('/');

    public static bool IsAnonymousProbe(string method, string path)
        => HttpMethods.IsGet(method) && Normalize(path).ToLowerInvariant() is
            "/gw/v1/healthz" or "/gw/v1/healthz/deep" or "/gw/v1/healthz/ready";

    public static bool IsReadOnlyOperation(string method, string path, string? routePattern = null)
    {
        path = Normalize(path).ToLowerInvariant();
        var route = Normalize(routePattern ?? path).ToLowerInvariant();
        if (HttpMethods.IsGet(method))
            return route is "/gw/v1/readyz" or "/gw/v1/route-self-test" or "/gw/v1/pools" or "/gw/v1/image-models" or "/v1/models"
                   || route == "/v1/models/{**modelid}" && path.StartsWith("/v1/models/", StringComparison.Ordinal)
                   || route == "/gw/v1/requests/{requestid}/status" && IsRequestControl(path, "status");
        return HttpMethods.IsPost(method) && (route == "/gw/v1/resolve"
            || route == "/gw/v1/requests/{requestid}/cancel" && IsRequestControl(path, "cancel"));
    }

    public static bool IsAdmittedPaidOperation(string method, string path)
    {
        path = Normalize(path).ToLowerInvariant();
        if (HttpMethods.IsGet(method)) return path == "/gw/v1/asr/live";
        if (!HttpMethods.IsPost(method)) return false;
        if (path is "/gw/v1/invoke" or "/gw/v1/send" or "/gw/v1/stream" or "/gw/v1/raw"
            or "/gw/v1/profile-test" or "/gw/v1/client-stream" or "/gw/v1/responses"
            or "/gw/v1/chat/completions" or "/v1/responses" or "/v1/chat/completions"
            or "/v1/images/generations" or "/v1/images/edits" or "/v1/messages") return true;
        var prefix = path.StartsWith("/gemini/v1beta/models/", StringComparison.Ordinal)
            ? "/gemini/v1beta/models/" : "/v1beta/models/";
        if (!path.StartsWith(prefix, StringComparison.Ordinal)) return false;
        var modelAndAction = path[prefix.Length..];
        return !modelAndAction.Contains('/') && (modelAndAction.EndsWith(":generatecontent", StringComparison.Ordinal)
            || modelAndAction.EndsWith(":streamgeneratecontent", StringComparison.Ordinal));
    }

    private static bool IsRequestControl(string path, string action)
    {
        var segments = path.Split('/', StringSplitOptions.RemoveEmptyEntries);
        return segments.Length == 5 && segments[0] == "gw" && segments[1] == "v1"
            && segments[2] == "requests" && segments[3].Length > 0 && segments[4] == action;
    }
}

public sealed record GatewayTaskAdmissionDecision(
    bool Allowed, int StatusCode, string ErrorCode, string Message, GatewayTaskPermitRecord? Permit = null)
{
    public static GatewayTaskAdmissionDecision Allow(GatewayTaskPermitRecord? permit = null)
        => new(true, 200, string.Empty, string.Empty, permit);
    public static GatewayTaskAdmissionDecision Deny(string code, string message, int status = 403)
        => new(false, status, code, message);
}

public interface IGatewayTaskAdmission
{
    Task<GatewayTaskAdmissionDecision> AdmitAsync(
        HttpContext http, GatewayKeyAuthorization authorization, string appCallerCode,
        bool reserveCall, CancellationToken ct);
    Task<GatewayTaskAdmissionDecision> ReserveContinuationAsync(
        HttpContext http, GatewayKeyAuthorization authorization, string appCallerCode, CancellationToken ct);
}

public sealed class GatewayTaskAdmission(
    LlmGatewayDataContext data, IConfiguration configuration, ILogger<GatewayTaskAdmission> logger)
    : IGatewayTaskAdmission
{
    public const string HeaderName = "X-Gateway-Task-Permit";
    public const string HttpContextPermitKey = "llmgw.task.permit";
    public const string HttpContextSubjectKey = "llmgw.task.subject";
    public const string HttpContextRunIdKey = "llmgw.task.run-id";

    public Task<GatewayTaskAdmissionDecision> AdmitAsync(
        HttpContext http, GatewayKeyAuthorization authorization, string appCallerCode,
        bool reserveCall, CancellationToken ct)
        => AdmitCoreAsync(http, authorization, appCallerCode, reserveCall, ct);

    private async Task<GatewayTaskAdmissionDecision> AdmitCoreAsync(
        HttpContext http, GatewayKeyAuthorization authorization, string appCallerCode,
        bool reserveCall, CancellationToken ct, GatewayTaskPermitRecord? expectedPermit = null, string? expectedSubject = null)
    {
        // 服务密钥的Source来自数据库。外部客户端永远不能用自报map/用户头获得内部人工许可。
        if (!RequiresInternalPermit(authorization, configuration)) return GatewayTaskAdmissionDecision.Allow();

        var permitId = http.Request.Headers[HeaderName].ToString().Trim();
        if (authorization.RuntimeGrant is { } runtime)
        {
            if (string.IsNullOrWhiteSpace(runtime.TaskPermitId))
                return GatewayTaskAdmissionDecision.Deny("TASK_PERMIT_REQUIRED", "当前任务尚未获准执行，已停止本次调用；请从正常业务入口重新发起任务。");
            if (permitId.Length > 0 && permitId != runtime.TaskPermitId)
                return GatewayTaskAdmissionDecision.Deny("TASK_PERMIT_MISMATCH", "当前任务授权不匹配，已停止本次调用；请重新发起任务。");
            permitId = runtime.TaskPermitId;
        }
        if (permitId.Length == 0 && !reserveCall)
            return GatewayTaskAdmissionDecision.Allow();
        if (permitId.Length != 32 || !permitId.All(Uri.IsHexDigit))
            return GatewayTaskAdmissionDecision.Deny("TASK_PERMIT_REQUIRED", "当前任务尚未获准执行，已停止本次调用；请从正常业务入口重新发起任务。");

        try
        {
            var collection = data.Database.GetCollection<GatewayTaskPermitRecord>(GatewayTaskPermitRecord.CollectionName);
            var permit = await collection.Find(x => x.Id == permitId && x.TenantId == authorization.TenantId).FirstOrDefaultAsync(ct);
            var now = DateTime.UtcNow;
            var deployment = TaskPermitDeployment.Resolve(configuration);
            if (permit is null || permit.RevokedAt is not null || permit.ExpiresAt <= now || permit.CreatedAt > now
                || permit.ExpiresAt <= permit.CreatedAt || permit.ExpiresAt - permit.CreatedAt > GatewayTaskPermitRecord.MaximumLifetime
                || permit.MaxCalls <= 0 || permit.MaxCalls > GatewayTaskPermitRecord.MaximumCalls
                || permit.MaxRuns <= 0 || permit.MaxRuns > GatewayTaskPermitRecord.MaximumRuns
                || permit.BoundRunIds.Count > permit.MaxRuns || permit.CallCount < 0 || !TaskExecutionOrigins.IsKnown(permit.Origin)
                || string.IsNullOrWhiteSpace(permit.SourceTask) || string.IsNullOrWhiteSpace(permit.SourceDeployment)
                || string.IsNullOrWhiteSpace(permit.ActorUserId)
                || string.IsNullOrWhiteSpace(permit.TriggerCredentialId)
                || !permit.SubjectUserIds.Contains(permit.ActorUserId, StringComparer.Ordinal)
                || permit.AllowedAppCallerCodes.Count == 0 || permit.AllowedAppCallerCodes.Any(x => x == "*"))
                return GatewayTaskAdmissionDecision.Deny("TASK_PERMIT_INVALID", "当前任务授权已失效，已停止本次调用；请重新发起任务。");
            if (permit.SourceDeployment != deployment)
                return GatewayTaskAdmissionDecision.Deny("TASK_PERMIT_DEPLOYMENT_DENIED", "当前任务不能在此环境执行，已停止本次调用；请回到发起任务的环境重试。");
            if (authorization.RuntimeGrant is { } scopedGrant
                && (GatewayRuntimeGrantPurposePolicy.IsTaskSidecar(scopedGrant) && scopedGrant.SourceDeployment != permit.SourceDeployment
                    || !string.IsNullOrWhiteSpace(scopedGrant.SourceDeployment) && scopedGrant.SourceDeployment != permit.SourceDeployment))
                return GatewayTaskAdmissionDecision.Deny("TASK_PERMIT_DEPLOYMENT_DENIED", "执行器授权与任务环境不匹配，已停止本次调用；请回到发起任务的环境重试。");
            if (expectedPermit is not null && (permit.Id != expectedPermit.Id || permit.ActorUserId != expectedPermit.ActorUserId
                || permit.Origin != expectedPermit.Origin || permit.SourceTask != expectedPermit.SourceTask
                || permit.TriggerCredentialId != expectedPermit.TriggerCredentialId))
                return GatewayTaskAdmissionDecision.Deny("TASK_PERMIT_MISMATCH", "当前任务授权已改变，已停止本次调用；请重新发起任务。");
            if (GatewayRuntimeGrantPurposePolicy.IsTaskSidecar(authorization.RuntimeGrant)
                && (authorization.RuntimeGrant!.MaxCalls <= 0 || authorization.RuntimeGrant.MaxCalls > permit.MaxCalls
                    || authorization.RuntimeGrant.ExpiresAt > permit.ExpiresAt || authorization.RuntimeGrant.CreatedAt > now
                    || authorization.RuntimeGrant.ExpiresAt - authorization.RuntimeGrant.CreatedAt > GatewayTaskPermitRecord.MaximumLifetime))
                return GatewayTaskAdmissionDecision.Deny("TASK_PERMIT_SCOPE_DENIED", "执行器授权超出父任务范围，已停止调用；请重新发起任务。");
            var canonicalCaller = permit.AllowedAppCallerCodes.FirstOrDefault(x => string.Equals(x, appCallerCode, StringComparison.OrdinalIgnoreCase));
            if (canonicalCaller is null)
                return GatewayTaskAdmissionDecision.Deny("TASK_PERMIT_CALLER_DENIED", "当前任务无权执行此操作，已停止本次调用；请核对任务范围后重新发起。");

            http.Items[HttpContextPermitKey] = permit;

            var declared = await ReadDeclaredIdentityAsync(http, ct);
            var runIds = declared.RunIds;
            if (authorization.RuntimeGrant is { RunId.Length: > 0 } grant) runIds.Add(grant.RunId);
            if (runIds.Any(runId => !permit.BoundRunIds.Contains(runId, StringComparer.Ordinal)))
                return GatewayTaskAdmissionDecision.Deny("TASK_PERMIT_RUN_DENIED", "当前任务授权与执行记录不匹配，已停止本次调用；请重新发起任务。");

            if (authorization.RuntimeGrant is { UserId.Length: > 0 } runtimeGrant) declared.SubjectUserIds.Add(runtimeGrant.UserId);
            var subject = authorization.RuntimeGrant?.UserId ?? declared.SubjectUserId ?? permit.ActorUserId;
            declared.SubjectUserIds.Add(subject);
            if (declared.SubjectUserIds.Count > 1 || declared.SubjectUserIds.Any(user => !permit.SubjectUserIds.Contains(user, StringComparer.Ordinal)
                || !permit.AllowDelegatedSubjects && user != permit.ActorUserId))
                return GatewayTaskAdmissionDecision.Deny("TASK_PERMIT_SUBJECT_DENIED", "当前任务授权与操作归属不匹配，已停止本次调用；请重新进入正确任务。");
            if (expectedSubject is not null && expectedSubject != subject)
                return GatewayTaskAdmissionDecision.Deny("TASK_PERMIT_SUBJECT_DENIED", "当前任务操作归属已改变，已停止本次调用；请重新进入正确任务。");

            http.Items[HttpContextPermitKey] = permit;
            http.Items[HttpContextSubjectKey] = subject;
            if (runIds.Count == 1) http.Items[HttpContextRunIdKey] = runIds.Single();

            if (reserveCall)
            {
                // 所有实例在同一条任务记录上核销。与读取时的事实精确匹配，撤销/过期/修改均不能被旧快照绕过。
                var filter = Builders<GatewayTaskPermitRecord>.Filter.And(
                    Builders<GatewayTaskPermitRecord>.Filter.Eq(x => x.Id, permit.Id),
                    Builders<GatewayTaskPermitRecord>.Filter.Eq(x => x.TenantId, permit.TenantId),
                    Builders<GatewayTaskPermitRecord>.Filter.Eq(x => x.ActorUserId, permit.ActorUserId),
                    Builders<GatewayTaskPermitRecord>.Filter.Eq(x => x.TriggerCredentialId, permit.TriggerCredentialId),
                    Builders<GatewayTaskPermitRecord>.Filter.Eq(x => x.AllowDelegatedSubjects, permit.AllowDelegatedSubjects),
                    Builders<GatewayTaskPermitRecord>.Filter.Eq(x => x.Origin, permit.Origin),
                    Builders<GatewayTaskPermitRecord>.Filter.Eq(x => x.SourceDeployment, deployment),
                    Builders<GatewayTaskPermitRecord>.Filter.Eq(x => x.SourceTask, permit.SourceTask),
                    Builders<GatewayTaskPermitRecord>.Filter.Eq(x => x.RevokedAt, null),
                    Builders<GatewayTaskPermitRecord>.Filter.Gt(x => x.ExpiresAt, now),
                    Builders<GatewayTaskPermitRecord>.Filter.Eq(x => x.ExpiresAt, permit.ExpiresAt),
                    Builders<GatewayTaskPermitRecord>.Filter.Eq(x => x.CreatedAt, permit.CreatedAt),
                    Builders<GatewayTaskPermitRecord>.Filter.AnyEq(x => x.AllowedAppCallerCodes, canonicalCaller),
                    Builders<GatewayTaskPermitRecord>.Filter.Eq(x => x.MaxRuns, permit.MaxRuns),
                    Builders<GatewayTaskPermitRecord>.Filter.Eq(x => x.MaxCalls, permit.MaxCalls),
                    Builders<GatewayTaskPermitRecord>.Filter.Lt(x => x.CallCount, permit.MaxCalls));
                foreach (var runId in runIds) filter &= Builders<GatewayTaskPermitRecord>.Filter.AnyEq(x => x.BoundRunIds, runId);
                foreach (var user in declared.SubjectUserIds) filter &= Builders<GatewayTaskPermitRecord>.Filter.AnyEq(x => x.SubjectUserIds, user);
                permit = await collection.FindOneAndUpdateAsync(filter,
                    Builders<GatewayTaskPermitRecord>.Update.Inc(x => x.CallCount, 1),
                    new FindOneAndUpdateOptions<GatewayTaskPermitRecord> { ReturnDocument = ReturnDocument.After }, ct);
                if (permit is null)
                    return GatewayTaskAdmissionDecision.Deny("TASK_PERMIT_EXHAUSTED", "当前任务已达到执行上限或授权已失效，已停止本次调用；请核对任务范围后重新发起。", 429);
            }
            http.Items[HttpContextPermitKey] = permit;
            return GatewayTaskAdmissionDecision.Allow(permit);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            // 绝不降级回共享M2M、不清空计数。诊断中不记录许可头、密钥或任意请求正文。
            logger.LogError(ex, "[GatewayTaskAdmission] task authorization storage unavailable");
            return GatewayTaskAdmissionDecision.Deny("TASK_ADMISSION_UNAVAILABLE", "任务授权服务暂时不可用，已停止本次调用；请稍后重试。", 503);
        }
    }

    public async Task<GatewayTaskAdmissionDecision> ReserveContinuationAsync(
        HttpContext http, GatewayKeyAuthorization authorization, string appCallerCode, CancellationToken ct)
    {
        var permit = http.Items[HttpContextPermitKey] as GatewayTaskPermitRecord;
        if (permit is not null)
            return await AdmitCoreAsync(http, authorization, appCallerCode, true, ct, permit,
                http.Items[HttpContextSubjectKey] as string);

        // 没有MAP许可的外部服务仍须重查原密钥作用域与有效期；不能把长会话当成永续授权。
        var authorizer = http.RequestServices.GetService<IGatewayScopedKeyAuthorizer>();
        var safety = http.RequestServices.GetService<GatewayMinimumProtectionCoordinator>();
        if (RequiresInternalPermit(authorization, configuration) || authorizer is null || safety is null)
            return GatewayTaskAdmissionDecision.Deny("TASK_ADMISSION_UNAVAILABLE", "任务授权服务暂时不可用，已停止转写；请保留录音后稍后重试。", 503);
        try
        {
            var key = http.Request.Headers["X-Gateway-Key"].FirstOrDefault();
            var bearer = http.Request.Headers.Authorization.FirstOrDefault();
            if (string.IsNullOrWhiteSpace(key) && bearer?.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase) == true)
                key = bearer["Bearer ".Length..].Trim();
            var renewed = await authorizer.AuthorizeAsync(key ?? string.Empty, string.Empty,
                authorization.AuthenticatedSourceSystem ?? "external", appCallerCode, "gw-native", "stream:invoke",
                http.Connection.RemoteIpAddress, ct, requestPath: "/gw/v1/asr/live");
            if (!renewed.Allowed || renewed.KeyId != authorization.KeyId || renewed.TenantId != authorization.TenantId)
                return GatewayTaskAdmissionDecision.Deny("TASK_SERVICE_SCOPE_DENIED", "当前转写服务授权已失效，已停止转写；请保留录音后重新发起。", renewed.Allowed ? 403 : renewed.StatusCode);
            var limited = await safety.CheckAsync(authorization.TenantId!, appCallerCode, ModelTypes.Asr,
                authorization.TeamId, Guid.NewGuid().ToString("N"), new GatewayMinimumRequestIdentity("automatic", null), null, null, ct);
            return limited.Rejected
                ? GatewayTaskAdmissionDecision.Deny(limited.ErrorCode, limited.Message, 429)
                : GatewayTaskAdmissionDecision.Allow();
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "[GatewayTaskAdmission] continuation authorization unavailable");
            return GatewayTaskAdmissionDecision.Deny("TASK_ADMISSION_UNAVAILABLE", "任务授权服务暂时不可用，已停止转写；请保留录音后稍后重试。", 503);
        }
    }

    public static bool RequiresInternalPermit(GatewayKeyAuthorization authorization, IConfiguration configuration)
    {
        var internalTenant = configuration["LlmGateway:InternalTenantId"]?.Trim() is { Length: > 0 } tenant
            ? tenant : GatewayTenantDefaults.InternalTenantId;
        return authorization.LegacySharedKey || authorization.RuntimeGrant is not null
            || authorization.TenantId == internalTenant
                && string.Equals(authorization.AuthenticatedSourceSystem, "map", StringComparison.OrdinalIgnoreCase);
    }

    private sealed record DeclaredIdentity(HashSet<string> RunIds, HashSet<string> SubjectUserIds, string? SubjectUserId);

    private static async Task<DeclaredIdentity> ReadDeclaredIdentityAsync(HttpContext http, CancellationToken ct)
    {
        var result = new HashSet<string>(StringComparer.Ordinal);
        var users = new HashSet<string>(StringComparer.Ordinal);
        string? subject = null;
        void Add(string? value) { if (!string.IsNullOrWhiteSpace(value)) result.Add(value.Trim()); }
        void AddUser(string? value) { if (!string.IsNullOrWhiteSpace(value)) { subject = value.Trim(); users.Add(subject); } }
        Add(http.Request.Headers["X-Gateway-Run-Id"].ToString());
        Add(http.Request.Headers["X-Run-Id"].ToString());
        AddUser(http.Request.Headers["X-Gateway-User-Id"].ToString());
        if (http.Request.HasFormContentType)
        {
            var form = await http.Request.ReadFormAsync(ct);
            Add(form["run_id"].ToString()); Add(form["runId"].ToString());
            return new(result, users, subject);
        }
        if (!(http.Request.ContentType?.StartsWith("application/json", StringComparison.OrdinalIgnoreCase) ?? false)) return new(result, users, subject);
        http.Request.EnableBuffering();
        try
        {
            using var json = await JsonDocument.ParseAsync(http.Request.Body, cancellationToken: ct);
            void Inspect(JsonElement element)
            {
                if (element.ValueKind != JsonValueKind.Object) return;
                foreach (var field in element.EnumerateObject())
                {
                    if (field.Name.Equals("run_id", StringComparison.OrdinalIgnoreCase) || field.Name.Equals("RunId", StringComparison.OrdinalIgnoreCase))
                    { if (field.Value.ValueKind == JsonValueKind.String) Add(field.Value.GetString()); }
                    else if (field.Name.Equals("UserId", StringComparison.OrdinalIgnoreCase))
                    { if (field.Value.ValueKind == JsonValueKind.String) AddUser(field.Value.GetString()); }
                    else if (field.Name.Equals("Context", StringComparison.OrdinalIgnoreCase) || field.Name.Equals("provider", StringComparison.OrdinalIgnoreCase)
                        || field.Name.Equals("metadata", StringComparison.OrdinalIgnoreCase)) Inspect(field.Value);
                }
            }
            Inspect(json.RootElement);
        }
        catch (JsonException) { /* 端点负责无效JSON响应；次数作为提交尝试保守核销。 */ }
        finally { http.Request.Body.Position = 0; }
        return new(result, users, subject);
    }
}
