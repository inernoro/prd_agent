using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Hosting;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Deployment;

namespace PrdAgent.Infrastructure.Security;

/// <summary>
/// SDK 运行时只获得单次任务的短期网关密钥。厂商地址、命名 profile 和长效 key 不进入执行器；
/// 实际模型选择由调用方既有配置冻结，模型解析仍由 serving 的唯一发送路径完成。
/// </summary>
public sealed class TaskScopedRuntimeGrantIssuer(
    LlmGatewayDataContext data,
    ITaskExecutionAuthorizer authorizer,
    IConfiguration configuration,
    IHostEnvironment environment) : ITaskScopedRuntimeGrantIssuer
{
    public async Task<SidecarRunRequest> PrepareAsync(SidecarRunRequest request, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(request);
        var identity = TaskExecutionContext.Current;
        if (identity is null || !TaskExecutionAuthorizer.ValidPermitId(identity.PermitId)
            || string.IsNullOrWhiteSpace(identity.RunId))
            throw Denied("TASK_EXECUTION_NOT_ADMITTED",
                "本次运行没有获得任务执行许可，已停止启动；请重新明确提交操作。");
        if (string.IsNullOrWhiteSpace(request.RunId) || string.IsNullOrWhiteSpace(request.AppCallerCode)
            || string.IsNullOrWhiteSpace(request.Model))
            throw Denied("TASK_RUNTIME_SCOPE_REQUIRED",
                "本次运行缺少完整的任务配置，已停止启动；请核对配置后重新提交。");
        if (request.Protocol is { Length: > 0 } protocol
            && protocol != "anthropic" && protocol != "openai-compatible")
            throw Denied("TASK_RUNTIME_PROTOCOL_UNSUPPORTED",
                "当前运行配置不受平台支持，已停止启动；请核对运行配置后重试。");

        var baseUrl = GatewayBaseUrl();
        var context = new GatewayRequestContext
        {
            RunId = identity.RunId,
            SessionId = request.MapSessionId,
            UserId = request.SubjectUserId,
        };
        using var admissionRequest = new HttpRequestMessage(HttpMethod.Post, $"{baseUrl}/v1/responses");
        await authorizer.AuthorizeOutboundAsync(admissionRequest, request.AppCallerCode, context, ct);
        if (context.TaskPermitId != identity.PermitId || context.RunId != identity.RunId)
            throw Denied("TASK_PERMIT_SCOPE_DENIED",
                "本次运行与已批准的任务不一致，已停止启动；请重新进入正确任务。");

        GatewayTaskPermitRecord? permit;
        try
        {
            permit = await data.Database.GetCollection<GatewayTaskPermitRecord>(GatewayTaskPermitRecord.CollectionName)
                .Find(item => item.Id == identity.PermitId).FirstOrDefaultAsync(ct);
        }
        catch (Exception error) when (error is MongoException or TimeoutException)
        {
            throw new TaskExecutionAdmissionException("TASK_ADMISSION_UNAVAILABLE",
                "任务保护暂时无法核验，本次运行已停止；请稍后重试。", 503);
        }
        var now = DateTime.UtcNow;
        var tenant = configuration["LlmGateway:InternalTenantId"]?.Trim() is { Length: > 0 } configuredTenant
            ? configuredTenant : GatewayTenantDefaults.InternalTenantId;
        if (permit is null || permit.RevokedAt is not null || permit.CreatedAt > now || permit.ExpiresAt <= now
            || permit.ExpiresAt <= permit.CreatedAt || permit.ExpiresAt - permit.CreatedAt > GatewayTaskPermitRecord.MaximumLifetime
            || permit.MaxCalls is <= 0 or > GatewayTaskPermitRecord.MaximumCalls
            || permit.MaxRuns is <= 0 or > GatewayTaskPermitRecord.MaximumRuns || permit.CallCount < 0
            || !TaskExecutionOrigins.IsKnown(permit.Origin)
            || permit.Origin == TaskExecutionOrigins.Scheduled && permit.AllowDelegatedSubjects
            || string.IsNullOrWhiteSpace(permit.TriggerCredentialId) || string.IsNullOrWhiteSpace(permit.SourceTask)
            || permit.CallCount >= permit.MaxCalls || permit.TenantId != tenant
            || permit.SourceDeployment != TaskPermitDeployment.Resolve(configuration)
            || permit.BoundRunIds?.Contains(identity.RunId, StringComparer.Ordinal) != true
            || permit.AllowedAppCallerCodes?.Contains(request.AppCallerCode, StringComparer.Ordinal) != true
            || string.IsNullOrWhiteSpace(permit.ActorUserId) || context.TriggerActorUserId != permit.ActorUserId
            || string.IsNullOrWhiteSpace(context.UserId)
            || (permit.Origin == TaskExecutionOrigins.Scheduled || context.UserId != permit.ActorUserId)
                && permit.SubjectUserIds?.Contains(context.UserId, StringComparer.Ordinal) != true)
            throw Denied("TASK_PERMIT_INVALID",
                "本次任务的执行许可已失效或超出范围，已停止启动；请核对任务状态后重新提交。");

        var requestedLifetime = TimeSpan.FromSeconds(Math.Clamp(request.TimeoutSeconds, 1, 86400));
        var expiresAt = new[] { permit.ExpiresAt, now.Add(requestedLifetime), now.Add(GatewayTaskPermitRecord.MaximumLifetime) }.Min();
        var plainKey = "gwrg_" + Convert.ToBase64String(RandomNumberGenerator.GetBytes(32))
            .TrimEnd('=').Replace('+', '-').Replace('/', '_');
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(plainKey))).ToLowerInvariant();
        var record = new GatewayRuntimeGrantRecord
        {
            Purpose = "task-sidecar",
            TenantId = permit.TenantId,
            TaskPermitId = permit.Id,
            SourceDeployment = permit.SourceDeployment,
            RunId = identity.RunId,
            UserId = context.UserId,
            AppCallerCode = request.AppCallerCode,
            Environment = NormalizeEnvironment(environment.EnvironmentName),
            Model = request.Model,
            KeyHash = hash,
            KeyPrefix = hash[..12],
            MaxCalls = permit.MaxCalls - permit.CallCount,
            CreatedAt = now,
            ExpiresAt = expiresAt,
        };
        try
        {
            await data.Database.GetCollection<GatewayRuntimeGrantRecord>("llmgw_runtime_grants")
                .InsertOneAsync(record, cancellationToken: ct);
        }
        catch (Exception error) when (error is MongoException or TimeoutException)
        {
            throw new TaskExecutionAdmissionException("TASK_ADMISSION_UNAVAILABLE",
                "任务保护暂时无法登记，本次运行未启动；请稍后重试。", 503);
        }

        return CopyWithGrant(request, baseUrl, plainKey, context.UserId);
    }

    private string GatewayBaseUrl()
    {
        // 显式外部入口优先；CDS 托管时只能读取平台直接声明的控制台入口。
        // 控制台的 /v1/ 直接代理 serving；不能从服务别名、分支名称推算地址。
        // 非 CDS 同网络部署才允许使用既有内部 serving 地址。
        var external = configuration["LlmGateway:ExternalServingBaseUrl"];
        var configured = (!string.IsNullOrWhiteSpace(external) ? external
            : !string.IsNullOrWhiteSpace(configuration["CDS_PROJECT_ID"])
                ? configuration[PlatformEntrypoints.ConsoleUrlKey]
                : configuration["LlmGateway:ServeBaseUrl"])?.Trim().TrimEnd('/') ?? string.Empty;
        if (!Uri.TryCreate(configured, UriKind.Absolute, out var uri)
            || uri.Scheme is not ("http" or "https") || !string.IsNullOrEmpty(uri.UserInfo)
            || !string.IsNullOrEmpty(uri.Query) || !string.IsNullOrEmpty(uri.Fragment)
            || uri.AbsolutePath != "/")
            throw new TaskExecutionAdmissionException("TASK_RUNTIME_GATEWAY_UNAVAILABLE",
                "运行时的模型网关出口尚未配置，本次运行已停止；请联系管理员完成配置后重试。", 503);
        return configured;
    }

    private static SidecarRunRequest CopyWithGrant(SidecarRunRequest request, string baseUrl, string key, string subject) => new()
    {
        RunId = request.RunId,
        SubjectUserId = subject,
        Model = request.Model,
        SystemPrompt = request.SystemPrompt,
        Messages = request.Messages,
        Tools = request.Tools,
        MaxTokens = request.MaxTokens,
        MaxTurns = request.MaxTurns,
        TimeoutSeconds = request.TimeoutSeconds,
        CallbackBaseUrl = request.CallbackBaseUrl,
        AgentApiKey = request.AgentApiKey,
        AppCallerCode = request.AppCallerCode,
        SidecarTag = request.SidecarTag,
        StickyKey = request.StickyKey,
        Profile = null,
        BaseUrl = baseUrl,
        ApiKey = key,
        Protocol = request.Protocol,
        RuntimeAdapter = request.RuntimeAdapter,
        MapSessionId = request.MapSessionId,
        TraceId = request.TraceId,
        WorkspaceRoot = request.WorkspaceRoot,
        GitRepository = request.GitRepository,
        GitRef = request.GitRef,
        BuiltinTools = request.BuiltinTools,
    };

    private static string NormalizeEnvironment(string value) => value.Trim().ToLowerInvariant() switch
    {
        "development" => "development", "test" or "testing" => "test", "staging" => "staging", _ => "production",
    };
    private static TaskExecutionAdmissionException Denied(string code, string message) => new(code, message);
}
