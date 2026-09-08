using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text;
using System.Text.RegularExpressions;
using System.Security.Cryptography;
using Microsoft.AspNetCore.Http;
using System.Net.Http.Headers;
using Microsoft.Extensions.Logging;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services.InfraConnections;
using KnowledgeBaseStore = PrdAgent.Core.Models.DocumentStore;

namespace PrdAgent.Infrastructure.Services.InfraAgentSessions;

/// <summary>
/// MAP 基础设施 Agent 会话服务。
/// P1 只负责 MAP 侧会话骨架，CDS 容器生命周期在后续阶段接入。
/// </summary>
public class InfraAgentSessionService : IInfraAgentSessionService
{
    private sealed class CdsMessageDispatchUncertainException : InfraAgentSessionException
    {
        public CdsMessageDispatchUncertainException()
            : base(
                InfraAgentSessionErrorCodes.MessageDispatchPending,
                "任务已进入 CDS 发送确认阶段，系统正在按消息标识自动对账；请刷新当前会话，勿重复提交",
                StatusCodes.Status503ServiceUnavailable)
        {
        }
    }

    private static readonly TimeSpan CdsCreateRecoveryTimeout = TimeSpan.FromSeconds(15);
    private static readonly TimeSpan[] CdsCreatePendingPollDelays =
    [
        TimeSpan.Zero,
        TimeSpan.FromMilliseconds(200),
        TimeSpan.FromMilliseconds(800)
    ];
    private static readonly string[] CdsRuntimeWritableStatuses =
    [
        InfraAgentSessionStatuses.Creating,
        InfraAgentSessionStatuses.Running,
        InfraAgentSessionStatuses.Idle
    ];
    private static readonly TimeSpan[] CdsStopRetryDelays =
    [
        TimeSpan.Zero,
        TimeSpan.FromMilliseconds(200),
        TimeSpan.FromMilliseconds(800)
    ];
    private static readonly TimeSpan CdsStopLeaseDuration = TimeSpan.FromMinutes(2);
    private const int PendingStopRecoveryBatchSize = 20;
    private const int ExpiredPrewarmRecoveryBatchSize = 100;
    private const string MdToPptPrewarmClientApp = "md-to-ppt-prewarm";
    private static readonly TimeSpan CdsStartLeaseDuration = TimeSpan.FromMinutes(2);
    private const int MaxCdsErrorMessageChars = 512;
    private readonly MongoDbContext _db;
    private readonly ILogger<InfraAgentSessionService> _logger;
    private readonly IInfraConnectionService _connections;
    private readonly IInfraAgentRuntimeProfileService _runtimeProfiles;
    private readonly IInfraAgentRuntimeAdapter? _runtimeAdapter;
    private readonly AgentRuntime.GatewayReviewRuntimeAdapter? _liteReviewAdapter;
    private readonly IInfraAgentRuntimeJobQueue _runtimeJobs;
    private readonly IAgentToolRegistry _toolRegistry;
    private readonly HttpClient _http;

    public InfraAgentSessionService(
        MongoDbContext db,
        ILogger<InfraAgentSessionService> logger,
        IInfraConnectionService connections,
        IInfraAgentRuntimeProfileService runtimeProfiles,
        IInfraAgentRuntimeAdapter? runtimeAdapter,
        IInfraAgentRuntimeJobQueue runtimeJobs,
        IAgentToolRegistry toolRegistry,
        HttpClient http,
        AgentRuntime.GatewayReviewRuntimeAdapter? liteReviewAdapter = null)
    {
        _db = db;
        _logger = logger;
        _connections = connections;
        _runtimeProfiles = runtimeProfiles;
        _runtimeAdapter = runtimeAdapter;
        _runtimeJobs = runtimeJobs;
        _toolRegistry = toolRegistry;
        _http = http;
        // CDS Agent 的 follow SSE 可持续到会话资源策略的终态（默认 15 分钟），不能被
        // HttpClient 默认 100 秒总超时截断。普通请求仍由各调用方 CancellationToken 约束。
        _http.Timeout = Timeout.InfiniteTimeSpan;
        _liteReviewAdapter = liteReviewAdapter;
    }

    public async Task<List<InfraAgentSessionView>> ListAsync(string userId, int limit, CancellationToken ct)
    {
        var take = Math.Clamp(limit <= 0 ? 50 : limit, 1, 200);
        var items = await _db.InfraAgentSessions
            .Find(x => x.UserId == userId && !x.IsArchived)
            .SortByDescending(x => x.UpdatedAt)
            .Limit(take)
            .ToListAsync(ct);
        return items.Select(ToView).ToList();
    }

    public async Task<List<InfraAgentRuntimeProviderView>> ListRuntimeProvidersAsync(
        string userId,
        string connectionId,
        CancellationToken ct)
    {
        _ = userId;
        var connection = await GetActiveConnectionAsync(connectionId, ct);
        var token = await GetLongTokenAsync(connection.Id, ct);
        using var response = await SendCdsJsonAsync(
            HttpMethod.Get,
            connection,
            token,
            $"/api/projects/{Uri.EscapeDataString(connection.ProjectId)}/agent-runtime-providers",
            body: null,
            ct);
        using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));
        if (!doc.RootElement.TryGetProperty("items", out var items) || items.ValueKind != JsonValueKind.Array)
        {
            throw new InfraAgentSessionException(
                InfraAgentSessionErrorCodes.CdsRequestFailed,
                "CDS 运行时目录响应缺少 items",
                StatusCodes.Status502BadGateway);
        }

        return items.EnumerateArray().Select(item => new InfraAgentRuntimeProviderView(
            GetString(item, "id") ?? string.Empty,
            GetString(item, "label") ?? string.Empty,
            GetString(item, "adapterKind") ?? string.Empty,
            GetString(item, "executionOwner") ?? string.Empty,
            GetString(item, "implementationStatus") ?? string.Empty,
            GetBool(item, "productEligible"),
            GetStringList(item, "workloadKinds"),
            GetStringList(item, "supportedIsolationModes"),
            GetString(item, "requiredIsolationMode") ?? string.Empty,
            GetString(item, "runtimeProtocol") ?? string.Empty,
            GetBool(item, "configured"),
            GetBool(item, "healthy"),
            GetBool(item, "selectable"),
            GetString(item, "isolationOwnedBy") ?? string.Empty,
            GetBool(item, "resourcePolicyEnforcedPerSession"),
            GetString(item, "reason"),
            GetBool(item, "verificationPending"))).ToList();
    }

    public async Task<InfraAgentSlaDashboardView> GetSlaDashboardAsync(string userId, int days, CancellationToken ct)
    {
        var windowDays = NormalizeSlaWindowDays(days);
        var windowEnd = DateTime.UtcNow;
        var windowStart = windowEnd.AddDays(-windowDays);
        var sessions = await _db.InfraAgentSessions
            .Find(x => x.UserId == userId && !x.IsArchived && x.CreatedAt >= windowStart && x.CreatedAt <= windowEnd)
            .SortByDescending(x => x.CreatedAt)
            .Limit(1000)
            .ToListAsync(ct);

        var sessionIds = sessions.Select(x => x.Id).ToList();
        var events = sessionIds.Count == 0
            ? new List<InfraAgentEvent>()
            : await _db.InfraAgentEvents
                .Find(x => sessionIds.Contains(x.SessionId) && x.CreatedAt >= windowStart && x.CreatedAt <= windowEnd)
                .SortBy(x => x.CreatedAt)
                .Limit(20000)
                .ToListAsync(ct);

        return BuildSlaDashboard(
            sessions.Select(ToView).ToList(),
            events.Select(ToEventView).ToList(),
            windowDays,
            windowStart,
            windowEnd);
    }

    public async Task<InfraAgentScheduleDashboardView> GetScheduleDashboardAsync(string userId, int days, CancellationToken ct)
    {
        var windowDays = NormalizeSlaWindowDays(days);
        var now = DateTime.UtcNow;
        var windowStart = now.AddDays(-windowDays);
        var workflows = await _db.Workflows
            .Find(x => x.CreatedBy == userId || x.OwnerUserId == userId)
            .SortByDescending(x => x.UpdatedAt)
            .Limit(500)
            .ToListAsync(ct);
        var schedules = await _db.WorkflowSchedules
            .Find(x => x.CreatedBy == userId)
            .SortByDescending(x => x.CreatedAt)
            .Limit(500)
            .ToListAsync(ct);
        var executions = await _db.WorkflowExecutions
            .Find(x => x.TriggeredBy == userId && x.CreatedAt >= windowStart)
            .SortByDescending(x => x.CreatedAt)
            .Limit(200)
            .ToListAsync(ct);

        return BuildScheduleDashboard(workflows, schedules, executions, windowDays, now);
    }

    public async Task<InfraAgentGovernanceDashboardView> GetGovernanceDashboardAsync(string userId, CancellationToken ct)
    {
        var memberships = await _db.ReportTeamMembers
            .Find(x => x.UserId == userId)
            .Limit(200)
            .ToListAsync(ct);
        var memberTeamIds = memberships
            .Select(x => x.TeamId)
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .Distinct(StringComparer.Ordinal)
            .ToList();
        var teamFilter = Builders<ReportTeam>.Filter.Eq(x => x.LeaderUserId, userId);
        if (memberTeamIds.Count > 0)
        {
            teamFilter |= Builders<ReportTeam>.Filter.In(x => x.Id, memberTeamIds);
        }

        var teams = await _db.ReportTeams
            .Find(teamFilter)
            .Limit(200)
            .ToListAsync(ct);
        var visibleTeamIds = memberTeamIds
            .Concat(teams.Select(x => x.Id))
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .Distinct(StringComparer.Ordinal)
            .ToList();
        var profileFilter = Builders<InfraAgentRuntimeProfile>.Filter.Eq(x => x.CreatedByUserId, userId);
        if (visibleTeamIds.Count > 0)
        {
            profileFilter |= Builders<InfraAgentRuntimeProfile>.Filter.AnyIn(x => x.SharedTeamIds, visibleTeamIds);
        }
        var workflows = await _db.Workflows
            .Find(x => x.CreatedBy == userId || x.OwnerUserId == userId)
            .Limit(500)
            .ToListAsync(ct);
        var knowledgeStores = await _db.DocumentStores
            .Find(x => x.OwnerId == userId || x.IsPublic)
            .Limit(500)
            .ToListAsync(ct);
        var profiles = await _db.InfraAgentRuntimeProfiles
            .Find(profileFilter)
            .Limit(500)
            .ToListAsync(ct);
        var sessions = await _db.InfraAgentSessions
            .Find(x => x.UserId == userId && !x.IsArchived)
            .SortByDescending(x => x.UpdatedAt)
            .Limit(500)
            .ToListAsync(ct);
        var executions = await _db.WorkflowExecutions
            .Find(x => x.TriggeredBy == userId && x.Status == WorkflowExecutionStatus.WaitingApproval)
            .Limit(200)
            .ToListAsync(ct);

        return BuildGovernanceDashboard(userId, teams, workflows, knowledgeStores, profiles, sessions, executions);
    }

    public async Task<InfraAgentSessionView> CreateAsync(
        string userId,
        CreateInfraAgentSessionRequest request,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(request.ConnectionId))
        {
            throw new InfraAgentSessionException(
                InfraAgentSessionErrorCodes.ConnectionIdRequired,
                "CDS 连接 ID 不能为空");
        }

        var connection = await GetActiveConnectionAsync(request.ConnectionId, ct);

        var now = DateTime.UtcNow;
        var sessionId = Guid.NewGuid().ToString("N");
        var clientApp = NormalizeOptional(request.ClientApp);
        var prewarmKey = NormalizeOptional(request.PrewarmKey);
        var prewarmExpiresAt = request.PrewarmExpiresAt;
        if ((prewarmKey != null || prewarmExpiresAt != null)
            && (!string.Equals(clientApp, MdToPptPrewarmClientApp, StringComparison.Ordinal)
                || prewarmKey == null
                || prewarmExpiresAt == null
                || prewarmExpiresAt <= now))
        {
            throw new InfraAgentSessionException(
                InfraAgentSessionErrorCodes.RuntimeProfileIncompatible,
                "预热会话缺少有效的持久身份或过期时间");
        }

        var session = new InfraAgentSession
        {
            Id = sessionId,
            UserId = userId,
            ConnectionId = connection.Id,
            Partner = connection.Partner,
            CdsProjectId = connection.ProjectId,
            TraceId = NormalizeOptional(request.TraceId) ?? BuildEventTraceId(sessionId),
            PrewarmKey = prewarmKey,
            PrewarmExpiresAt = prewarmExpiresAt,
            RuntimeProfileId = NormalizeOptional(request.RuntimeProfileId),
            WorkspaceRoot = NormalizeOptional(request.WorkspaceRoot),
            GitRepository = NormalizeOptional(request.GitRepository),
            GitRef = NormalizeOptional(request.GitRef),
            Runtime = NormalizeRuntime(request.Runtime),
            Model = NormalizeOptional(request.Model),
            ResourceCpuCores = 2,
            ResourceMemoryMb = 4096,
            TimeoutSeconds = 900,
            NetworkPolicy = InfraAgentRuntimeNetworkPolicies.Restricted,
            AutoCleanupMinutes = NormalizeAutoCleanupMinutes(request.AutoCleanupMinutes ?? 30),
            ToolPolicy = NormalizeToolPolicy(request.ToolPolicy),
            HookProfileId = NormalizeOptional(request.HookProfileId),
            Title = NormalizeTitle(request.Title),
            ClientApp = clientApp,
            WorkloadKind = NormalizeWorkloadKind(request.WorkloadKind),
            IsolationMode = NormalizeIsolationMode(request.IsolationMode),
            Status = InfraAgentSessionStatuses.Idle,
            EventSeq = 0,
            EventSeqInitialized = true,
            CreatedAt = now,
            UpdatedAt = now
        };

        await _db.InfraAgentSessions.InsertOneAsync(session, cancellationToken: ct);
        await AppendStatusEventAsync(
            session.Id,
            await NextEventSeqAsync(session.Id, ct),
            session.Status,
            "session_created",
            ct);

        _logger.LogInformation(
            "Created infra agent session {SessionId} for user {UserId} on connection {ConnectionId}",
            session.Id,
            userId,
            connection.Id);

        return ToView(session);
    }

    public async Task<InfraAgentSessionView?> StartAsync(
        string userId,
        string id,
        StartInfraAgentSessionRequest request,
        CancellationToken ct)
    {
        var session = await FindOwnedSessionAsync(userId, id, ct);
        if (session == null) return null;
        if (session.CleanupRequestedAt != null)
        {
            return ToView(session);
        }
        if (!string.IsNullOrWhiteSpace(session.CdsSessionId)
            && session.Status is InfraAgentSessionStatuses.Creating
                or InfraAgentSessionStatuses.Running
                or InfraAgentSessionStatuses.Idle)
        {
            return ToView(session);
        }
        var requiresCleanupBeforeStart = RequiresCdsCleanupBeforeStart(
            session.Status,
            session.CdsSessionId,
            session.StartAttemptId,
            session.PendingCdsSessionIds.Count);
        if (requiresCleanupBeforeStart)
        {
            var stopped = await StopAsync(userId, id, ct);
            var cleaned = await FindOwnedSessionAsync(userId, id, ct);
            if (stopped == null
                || cleaned == null
                || cleaned.Status != InfraAgentSessionStatuses.Stopped
                || cleaned.PendingCdsSessionIds.Count > 0
                || !string.IsNullOrWhiteSpace(cleaned.StartAttemptId))
            {
                return stopped;
            }
            session = cleaned;
        }
        if (session.Status == InfraAgentSessionStatuses.Stopping)
        {
            return ToView(session);
        }

        var connection = await GetActiveConnectionAsync(session, ct);
        var token = await GetLongTokenAsync(connection.Id, ct);
        var now = DateTime.UtcNow;
        if (ShouldWaitForExistingStartLease(
            session.Status,
            session.CdsSessionId,
            session.StartAttemptId,
            session.UpdatedAt,
            now))
        {
            return ToView(session);
        }
        var startAttemptId = !string.IsNullOrWhiteSpace(session.StartAttemptId)
            ? session.StartAttemptId
            : $"start_{Guid.NewGuid():N}";
        var hookProfile = await GetHookProfileAsync(session, ct);
        var startTransitionFilter = Builders<InfraAgentSession>.Filter.And(
            Builders<InfraAgentSession>.Filter.Eq(x => x.Id, id),
            Builders<InfraAgentSession>.Filter.Eq(x => x.UserId, userId),
            Builders<InfraAgentSession>.Filter.Eq(x => x.Status, session.Status),
            Builders<InfraAgentSession>.Filter.Eq(x => x.StartAttemptId, session.StartAttemptId),
            Builders<InfraAgentSession>.Filter.Eq(x => x.CleanupRequestedAt, null));
        var startTransition = await _db.InfraAgentSessions.UpdateOneAsync(
            startTransitionFilter,
            Builders<InfraAgentSession>.Update
                .Set(x => x.Status, InfraAgentSessionStatuses.Creating)
                .Set(x => x.StartAttemptId, startAttemptId)
                .Set(x => x.CdsSessionId, null)
                .Set(x => x.CdsWorkerId, null)
                .Set(x => x.CdsContainerName, null)
                .Set(x => x.StopLeaseOwner, null)
                .Set(x => x.StopLeaseExpiresAt, null)
                .Set(x => x.UpdatedAt, now)
                .Set(x => x.LastError, null),
            cancellationToken: ct);
        if (startTransition.ModifiedCount == 0)
        {
            var current = await FindOwnedSessionAsync(userId, id, ct);
            return current == null ? null : ToView(current);
        }
        session.Status = InfraAgentSessionStatuses.Creating;
        session.StartAttemptId = startAttemptId;
        session.UpdatedAt = now;
        session.LastError = null;

        try
        {
            var runtimeProfile = await ResolveRuntimeProfileForSessionAsync(userId, session.RuntimeProfileId, ct);
            var runtime = NormalizeRuntime(request.Runtime ?? runtimeProfile?.Runtime ?? session.Runtime);
            var model = NormalizeOptional(request.Model) ?? runtimeProfile?.Model ?? session.Model;
            var managedLaunch = request.ManagedLaunch;
            if (managedLaunch != null
                && (!string.Equals(runtime, InfraAgentRuntimes.OpenDesign, StringComparison.Ordinal)
                    || !string.Equals(session.WorkloadKind, InfraAgentWorkloadKinds.DesignArtifact, StringComparison.Ordinal)
                    || !string.Equals(session.IsolationMode, InfraAgentIsolationModes.SessionContainer, StringComparison.Ordinal)))
            {
                throw new InfraAgentSessionException(
                    InfraAgentSessionErrorCodes.RuntimeProfileIncompatible,
                    "MAP 托管启动参数只允许用于隔离的设计产物会话");
            }
            var modelBaseUrl = managedLaunch?.ModelBaseUrl ?? runtimeProfile?.BaseUrl ?? session.ModelBaseUrl;
            var modelProtocol = managedLaunch?.ModelProtocol ?? runtimeProfile?.Protocol;
            var modelApiKey = managedLaunch?.ModelApiKey ?? runtimeProfile?.ApiKey;
            var resourceCpuCores = runtimeProfile?.ResourceCpuCores ?? session.ResourceCpuCores;
            var resourceMemoryMb = runtimeProfile?.ResourceMemoryMb ?? session.ResourceMemoryMb;
            var timeoutSeconds = runtimeProfile?.TimeoutSeconds ?? session.TimeoutSeconds;
            // OpenDesign needs outbound access only to the MAP workspace/model endpoints. The
            // managed launch contract is server-authored, so it may narrow the generic session
            // default without exposing a caller-controlled network policy field.
            var networkPolicy = managedLaunch != null
                ? InfraAgentRuntimeNetworkPolicies.EgressOnly
                : runtimeProfile?.NetworkPolicy ?? session.NetworkPolicy;
            var autoCleanupMinutes = session.PrewarmExpiresAt != null
                ? session.AutoCleanupMinutes
                : runtimeProfile?.AutoCleanupMinutes ?? session.AutoCleanupMinutes;
            EnsureRuntimeProfileCompatibleOrLiteFallback(runtime, runtimeProfile, ResolveSidecarRuntimeAdapter());
            await RunHookAsync(session, hookProfile, "beforeStart", hookProfile?.BeforeStart, blockOnFailure: true, ct);
            var body = new
            {
                clientRequestId = startAttemptId,
                runtime,
                model,
                // 观测台标签（2026-06-11）：CDS 侧请求列表按 title/用户/应用展示与筛选
                title = session.Title,
                clientUser = session.UserId,
                clientApp = session.ClientApp ?? "map",
                modelBaseUrl,
                modelProtocol,
                modelApiKey,
                runtimeProfileId = runtimeProfile?.Id ?? session.RuntimeProfileId,
                workspaceRoot = session.WorkspaceRoot,
                workspaceTransfer = managedLaunch?.WorkspaceTransfer,
                gitRepository = session.GitRepository,
                gitRef = session.GitRef,
                resourcePolicy = new
                {
                    cpuCores = resourceCpuCores,
                    memoryMb = resourceMemoryMb,
                    timeoutSeconds,
                    networkPolicy,
                    autoCleanupMinutes
                },
                toolPolicy = session.ToolPolicy,
                hookProfileId = session.HookProfileId,
                workloadKind = session.WorkloadKind,
                isolationMode = session.IsolationMode
            };
            HttpResponseMessage createHttpResponse;
            try
            {
                createHttpResponse = await SendCdsJsonAsync(
                    HttpMethod.Post, connection, token,
                    $"/api/projects/{Uri.EscapeDataString(session.CdsProjectId)}/agent-sessions",
                    body, ct, allowErrorResponse: true);
            }
            catch (Exception ex) when (ex is HttpRequestException or IOException)
            {
                // The request may already own a CDS reservation. Preserve its attempt identity;
                // the next observation replays that same key, never a fresh resource allocation.
                throw CreateCdsCreatePendingException();
            }
            using var response = createHttpResponse;
            async Task PersistCreateResponseAsync(CdsCreateSessionResponse createResponse, CancellationToken recoveryCt)
            {
                var item = createResponse.Item!.Value;
                var cdsSessionId = GetString(item, "id")!;
                var workerId = GetString(item, "workerId");
                var containerName = GetString(item, "containerName");
                var status = (createResponse.Succeeded ?? response.IsSuccessStatusCode)
                    ? MapCdsStatus(GetString(item, "status"))
                    : InfraAgentSessionStatuses.Failed;
                now = DateTime.UtcNow;

                var update = Builders<InfraAgentSession>.Update
                    .Set(x => x.CdsSessionId, cdsSessionId)
                    .Set(x => x.CdsWorkerId, workerId)
                    .Set(x => x.CdsContainerName, containerName)
                    .Set(x => x.RuntimeProfileId, runtimeProfile?.Id ?? session.RuntimeProfileId)
                    .Set(x => x.ModelBaseUrl, modelBaseUrl)
                    .Set(x => x.Runtime, runtime)
                    .Set(x => x.Model, model)
                    .Set(x => x.ResourceCpuCores, resourceCpuCores)
                    .Set(x => x.ResourceMemoryMb, resourceMemoryMb)
                    .Set(x => x.TimeoutSeconds, timeoutSeconds)
                    .Set(x => x.NetworkPolicy, networkPolicy)
                    .Set(x => x.AutoCleanupMinutes, autoCleanupMinutes)
                    .Set(x => x.Status, status)
                    .Set(x => x.StartAttemptId, null)
                    .Set(x => x.StartedAt, now)
                    .Set(x => x.UpdatedAt, now)
                    .Set(x => x.LastError, createResponse.ErrorMessage);
                var persistenceResult = await _db.InfraAgentSessions.UpdateOneAsync(
                    x => x.Id == id
                        && x.UserId == userId
                        && x.Status == InfraAgentSessionStatuses.Creating
                        && x.StartAttemptId == startAttemptId,
                    update,
                    cancellationToken: recoveryCt);
                if (!persistenceResult.IsAcknowledged || persistenceResult.ModifiedCount != 1)
                {
                    var currentOwner = await FindOwnedSessionAsync(userId, id, CancellationToken.None);
                    if (currentOwner?.CdsSessionId == cdsSessionId)
                    {
                        return;
                    }

                    // The attempt no longer owns the primary slot. Keep the returned identity in
                    // a separate cleanup ledger so it cannot overwrite a newer start (ABA), then
                    // compensate that exact resource.
                    var tracked = await _db.InfraAgentSessions.UpdateOneAsync(
                        x => x.Id == id && x.UserId == userId,
                        Builders<InfraAgentSession>.Update
                            .AddToSet(x => x.PendingCdsSessionIds, cdsSessionId)
                            .Set(x => x.UpdatedAt, DateTime.UtcNow),
                        cancellationToken: CancellationToken.None);
                    if (!tracked.IsAcknowledged || tracked.MatchedCount != 1)
                    {
                        throw new InfraAgentSessionException(
                            InfraAgentSessionErrorCodes.CdsRequestFailed,
                            "CDS 已返回远端会话，但 MAP 无法登记其回收身份",
                            StatusCodes.Status502BadGateway);
                    }
                    try
                    {
                        await StopRemoteCdsSessionAsync(session, cdsSessionId, connection, token);
                    }
                    catch (Exception compensationError)
                    {
                        var safeCompensationError = SanitizeCdsErrorMessage(
                            compensationError.Message,
                            "CDS 新建资源回收失败");
                        await _db.InfraAgentSessions.UpdateOneAsync(
                            x => x.Id == id && x.UserId == userId,
                            Builders<InfraAgentSession>.Update
                                .Set(x => x.LastError, safeCompensationError)
                                .Set(x => x.UpdatedAt, DateTime.UtcNow),
                            cancellationToken: CancellationToken.None);
                        throw;
                    }
                    await _db.InfraAgentSessions.UpdateOneAsync(
                        x => x.Id == id && x.UserId == userId,
                        Builders<InfraAgentSession>.Update
                            .Pull(x => x.PendingCdsSessionIds, cdsSessionId)
                            .Set(x => x.UpdatedAt, DateTime.UtcNow),
                        cancellationToken: CancellationToken.None);
                    await TryFinalizeStoppingAttemptAsync(userId, id, startAttemptId, CancellationToken.None);
                    throw new InfraAgentSessionException(
                        InfraAgentSessionErrorCodes.CdsRequestFailed,
                        "会话状态已在启动期间改变，CDS 新建资源已回收",
                        StatusCodes.Status409Conflict);
                }

                session.CdsSessionId = cdsSessionId;
                session.CdsWorkerId = workerId;
                session.CdsContainerName = containerName;
                session.RuntimeProfileId = runtimeProfile?.Id ?? session.RuntimeProfileId;
                session.ModelBaseUrl = modelBaseUrl;
                session.Runtime = runtime;
                session.Model = model;
                session.ResourceCpuCores = resourceCpuCores;
                session.ResourceMemoryMb = resourceMemoryMb;
                session.TimeoutSeconds = timeoutSeconds;
                session.NetworkPolicy = networkPolicy;
                session.AutoCleanupMinutes = autoCleanupMinutes;
                session.Status = status;
                session.StartAttemptId = null;
                session.StartedAt = now;
                session.UpdatedAt = now;
                session.LastError = createResponse.ErrorMessage;
            }

            await ProcessCdsCreateResponseAsync(
                response,
                PersistCreateResponseAsync,
                recoverAsync: recoveryCt =>
                    WaitForCdsCreateReplayTerminalAsync(
                        session,
                        startAttemptId,
                        connection,
                        token,
                        recoveryCt));
            var current = await FindOwnedSessionAsync(userId, id, CancellationToken.None);
            if (current == null
                || current.CdsSessionId != session.CdsSessionId
                || !CanApplyCdsRuntimeStatus(current.Status))
            {
                return current == null ? null : ToView(current);
            }
            // CDS already emits the authoritative session-created status into the imported event
            // stream. Do not append a second MAP status event here: Stop may win immediately after
            // the ownership re-read, and that duplicate event could visually regress a terminal UI.
            await RunHookAsync(session, hookProfile, "afterStart", hookProfile?.AfterStart, blockOnFailure: false, ct);
            return ToView(session);
        }
        catch (CdsCreatePendingException)
        {
            // Pending is not a failed attempt. Keep Creating + StartAttemptId intact so both a
            // later Start and Stop can recover the same CDS reservation by clientRequestId.
            throw;
        }
        catch (Exception ex)
        {
            var safeError = SanitizeCdsErrorMessage(ex.Message, "CDS 创建会话失败");
            await RunCdsRecoveryAsync(recoveryCt => MarkStartFailedAsync(session, startAttemptId, safeError, recoveryCt));
            if (ex is InfraAgentSessionException) throw;
            throw new InfraAgentSessionException(
                InfraAgentSessionErrorCodes.CdsRequestFailed,
                $"CDS 创建会话失败：{safeError}",
                StatusCodes.Status502BadGateway);
        }
    }

    public async Task<InfraAgentSessionView?> GetAsync(string userId, string id, CancellationToken ct)
    {
        var session = await FindOwnedSessionAsync(userId, id, ct);
        return session == null ? null : ToView(session);
    }

    public async Task<InfraAgentSessionView?> ClaimPrewarmedAsync(
        string userId,
        string id,
        string expectedProfileId,
        string rootRunId,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(expectedProfileId) || string.IsNullOrWhiteSpace(rootRunId))
            return null;

        var now = DateTime.UtcNow;
        var claimed = await _db.InfraAgentSessions.FindOneAndUpdateAsync(
            Builders<InfraAgentSession>.Filter.And(
                Builders<InfraAgentSession>.Filter.Eq(x => x.Id, id),
                Builders<InfraAgentSession>.Filter.Eq(x => x.UserId, userId),
                Builders<InfraAgentSession>.Filter.Eq(x => x.ClientApp, MdToPptPrewarmClientApp),
                Builders<InfraAgentSession>.Filter.Eq(x => x.RuntimeProfileId, expectedProfileId),
                Builders<InfraAgentSession>.Filter.Ne(x => x.PrewarmKey, null),
                Builders<InfraAgentSession>.Filter.Gt(x => x.PrewarmExpiresAt, now),
                Builders<InfraAgentSession>.Filter.Eq(x => x.PrewarmClaimedRunId, null),
                Builders<InfraAgentSession>.Filter.Eq(x => x.ActiveMessageId, null),
                Builders<InfraAgentSession>.Filter.Eq(x => x.LastCompletedMessageId, null),
                Builders<InfraAgentSession>.Filter.Eq(x => x.CurrentRuntimeRunId, null),
                Builders<InfraAgentSession>.Filter.Eq(x => x.Status, InfraAgentSessionStatuses.Running)),
            Builders<InfraAgentSession>.Update
                .Set(x => x.PrewarmClaimedRunId, rootRunId.Trim())
                .Set(x => x.TraceId, rootRunId.Trim())
                .Set(x => x.PrewarmKey, null)
                .Set(x => x.PrewarmExpiresAt, null)
                .Set(x => x.ClientApp, "md-to-ppt")
                .Set(x => x.UpdatedAt, now),
            new FindOneAndUpdateOptions<InfraAgentSession>
            {
                ReturnDocument = ReturnDocument.After,
            },
            ct);
        return claimed == null ? null : ToView(claimed);
    }

    public async Task<int> RecoverExpiredPrewarmsAsync(CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        var candidates = await _db.InfraAgentSessions
            .Find(x => x.ClientApp == MdToPptPrewarmClientApp
                       && x.PrewarmClaimedRunId == null
                       && x.PrewarmExpiresAt != null
                       && x.PrewarmExpiresAt <= now
                       && x.Status != InfraAgentSessionStatuses.Stopped)
            .SortBy(x => x.PrewarmExpiresAt)
            .Limit(ExpiredPrewarmRecoveryBatchSize)
            .ToListAsync(ct);

        var stopped = 0;
        foreach (var candidate in candidates)
        {
            try
            {
                var result = await StopAsync(candidate.UserId, candidate.Id, CancellationToken.None);
                if (result?.Status == InfraAgentSessionStatuses.Stopped)
                {
                    await _db.InfraAgentSessions.UpdateOneAsync(
                        x => x.Id == candidate.Id
                             && x.UserId == candidate.UserId
                             && x.PrewarmClaimedRunId == null,
                        Builders<InfraAgentSession>.Update
                            .Set(x => x.PrewarmKey, null)
                            .Set(x => x.UpdatedAt, DateTime.UtcNow),
                        cancellationToken: CancellationToken.None);
                    stopped++;
                }
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Expired PPT prewarm cleanup remains pending session={SessionId}", candidate.Id);
            }
        }
        return stopped;
    }

    public async Task<InfraAgentSessionView?> SendMessageAsync(
        string userId,
        string id,
        SendInfraAgentMessageRequest request,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(request.Content))
        {
            throw new InfraAgentSessionException(
                InfraAgentSessionErrorCodes.MessageContentRequired,
                "消息内容不能为空");
        }

        var session = await FindOwnedSessionAsync(userId, id, ct);
        if (session == null) return null;
        if (session.ManualTakeoverEnabled)
        {
            throw new InfraAgentSessionException(
                InfraAgentSessionErrorCodes.ManualTakeoverEnabled,
                "当前会话已进入人工接管，恢复 Agent 后才能发送任务",
                StatusCodes.Status409Conflict);
        }

        var messageRuntimeProfile = await ResolveRuntimeProfileForSessionAsync(userId, session.RuntimeProfileId, ct);
        EnsureRuntimeProfileCompatibleOrLiteFallback(
            session.Runtime,
            messageRuntimeProfile,
            ResolveSidecarRuntimeAdapter());

        if (string.IsNullOrWhiteSpace(session.CdsSessionId)
            && session.Status is InfraAgentSessionStatuses.Idle or InfraAgentSessionStatuses.Creating)
        {
            var started = await StartAsync(userId, id, new StartInfraAgentSessionRequest(session.Runtime, session.Model), ct);
            if (started == null) return null;
            session = FromView(started);
        }

        var now = DateTime.UtcNow;
        var outboundMessage = PrepareOutboundUserMessage(
            session.Status,
            session.CdsSessionId,
            id,
            request.Content.Trim(),
            now);
        await _db.InfraAgentMessages.InsertOneAsync(outboundMessage, cancellationToken: ct);
        var claimedPreviousStatus = session.Status;
        try
        {
            await ClaimOutboundTurnAsync(session, outboundMessage.Id, ct);
        }
        catch
        {
            await RunCdsRecoveryAsync(recoveryCt => SetOutboundMessageStatusAsync(
                outboundMessage,
                InfraAgentMessageStatuses.Failed,
                cdsSourceSessionId: null,
                ct: recoveryCt));
            throw;
        }

        JsonElement cdsItem;
        try
        {
            var connection = await GetActiveConnectionAsync(session, ct);
            var token = await GetLongTokenAsync(connection.Id, ct);
            cdsItem = await PostMessageToCdsAsync(connection, token, session, request.Content.Trim(), ct);
        }
        catch (CdsMessageDispatchUncertainException)
        {
            await RunBestEffortRuntimeEnqueueAsync(
                enqueueCt => _runtimeJobs.EnqueueAsync(
                    new InfraAgentRuntimeJob(
                        userId,
                        session.Id,
                        outboundMessage.Id,
                        request.Content.Trim(),
                        DateTime.UtcNow),
                    enqueueCt),
                ex => _logger.LogWarning(
                    ex,
                    "[infra-agent] uncertain CDS message dispatch could not enqueue reconciliation session={SessionId}",
                    session.Id));
            throw;
        }
        catch
        {
            await RunCdsRecoveryAsync(recoveryCt => SetOutboundMessageStatusAsync(
                outboundMessage,
                InfraAgentMessageStatuses.Failed,
                cdsSourceSessionId: null,
                ct: recoveryCt));
            await RunCdsRecoveryAsync(recoveryCt => ReleaseOutboundTurnAsync(
                session,
                outboundMessage.Id,
                claimedPreviousStatus,
                recoveryCt));
            throw;
        }
        await RunCdsRecoveryAsync(recoveryCt => SetOutboundMessageStatusAsync(
            outboundMessage,
            InfraAgentMessageStatuses.Completed,
            session.CdsSessionId,
            recoveryCt));
        var cdsStatus = MapCdsStatus(GetString(cdsItem, "status"));

        session.UpdatedAt = DateTime.UtcNow;
        var statusProjection = await _db.InfraAgentSessions.UpdateOneAsync(
            Builders<InfraAgentSession>.Filter.And(
                BuildCdsActiveTurnWritableFilter(id, session.CdsSessionId!, outboundMessage.Id),
                Builders<InfraAgentSession>.Filter.Eq(x => x.UserId, userId),
                Builders<InfraAgentSession>.Filter.In(x => x.Status, CdsRuntimeWritableStatuses)),
            Builders<InfraAgentSession>.Update.Set(x => x.UpdatedAt, session.UpdatedAt),
            cancellationToken: ct);
        if (statusProjection.ModifiedCount == 0)
        {
            var current = await FindOwnedSessionAsync(userId, id, ct);
            return current == null ? null : ToView(current);
        }
        session.Status = cdsStatus;
        // 关键修复：不再内联阻塞导入。旧实现 await ImportCdsStreamEventsAsync 把整段 CDS 流读完才返回，
        // 表现为「发送卡 2 秒 → 一直等 → 死掉」。改为消息 POST 到 CDS 后立即入队，由
        // InfraAgentRuntimeWorker 后台拉流落库（与 HTTP 请求生命周期解耦，server-authority），
        // 前端 GET {id}/stream 的长连 SSE 实时呈现逐字。POST 毫秒级返回。
        var enqueued = await RunBestEffortRuntimeEnqueueAsync(
            enqueueCt => _runtimeJobs.EnqueueAsync(
                new InfraAgentRuntimeJob(
                    userId,
                    session.Id,
                    outboundMessage.Id,
                    request.Content.Trim(),
                    DateTime.UtcNow),
                enqueueCt),
            ex => _logger.LogWarning(
                ex,
                "[infra-agent] CDS accepted message but local runtime import enqueue failed; persisted event polling will recover (session={SessionId})",
                session.Id));
        if (enqueued)
        {
            _logger.LogDebug(
                "[infra-agent] message posted to CDS, stream import dispatched to background worker (session={SessionId})",
                session.Id);
        }
        var projectedSession = await FindOwnedSessionAsync(userId, id, ct);
        return projectedSession == null ? null : ToView(projectedSession);

        async Task<JsonElement> PostMessageToCdsAsync(
            InfraConnection currentConnection,
            string currentToken,
            InfraAgentSession currentSession,
            string content,
            CancellationToken cancellationToken)
        {
            var currentCdsSessionId = RequireDispatchableCdsSessionId(
                currentSession.Status,
                currentSession.CdsSessionId);
            try
            {
                using var postResponse = await SendCdsMessageIdempotentlyAsync(
                    currentConnection,
                    currentToken,
                    currentSession.CdsProjectId,
                    currentCdsSessionId,
                    content,
                    outboundMessage.Id,
                    cancellationToken);
                return await ReadCdsItemAsync(postResponse, cancellationToken);
            }
            catch (InfraAgentSessionException ex) when (IsCdsSessionNotFound(ex))
            {
                await AppendRawEventAsync(
                    currentSession.Id,
                    await NextEventSeqAsync(currentSession.Id, cancellationToken),
                    InfraAgentEventTypes.Log,
                    JsonSerializer.Serialize(new
                    {
                        level = "warning",
                        source = "cds-session-transport",
                        message = "remote CDS session was missing; recreating runtime session before dispatch",
                        oldCdsSessionId = currentSession.CdsSessionId
                    }),
                    cancellationToken);
                var resetMissingSession = await _db.InfraAgentSessions.UpdateOneAsync(
                    Builders<InfraAgentSession>.Filter.And(
                        Builders<InfraAgentSession>.Filter.Eq(x => x.Id, currentSession.Id),
                        Builders<InfraAgentSession>.Filter.Eq(x => x.UserId, userId),
                        Builders<InfraAgentSession>.Filter.Eq(x => x.CdsSessionId, currentCdsSessionId),
                        Builders<InfraAgentSession>.Filter.Eq(x => x.ActiveMessageId, outboundMessage.Id),
                        Builders<InfraAgentSession>.Filter.In(x => x.Status, CdsRuntimeWritableStatuses)),
                    Builders<InfraAgentSession>.Update
                        .Set(x => x.CdsSessionId, null)
                        .Set(x => x.ActiveMessageId, null)
                        .Set(x => x.Status, InfraAgentSessionStatuses.Idle)
                        .Set(x => x.LastError, null),
                    cancellationToken: cancellationToken);
                if (resetMissingSession.ModifiedCount == 0)
                {
                    throw new InfraAgentSessionException(
                        InfraAgentSessionErrorCodes.SessionStillRunning,
                        "会话已停止或正在停止，不能重建远端运行环境",
                        StatusCodes.Status409Conflict);
                }
                currentSession.CdsSessionId = null;
                currentSession.Status = InfraAgentSessionStatuses.Idle;

                var restarted = await StartAsync(userId, currentSession.Id, new StartInfraAgentSessionRequest(currentSession.Runtime, currentSession.Model), cancellationToken);
                if (restarted == null)
                {
                    throw;
                }
                currentSession = FromView(restarted);
                session = currentSession;
                claimedPreviousStatus = currentSession.Status;
                await ClaimOutboundTurnAsync(currentSession, outboundMessage.Id, cancellationToken);
                var restartedCdsSessionId = RequireDispatchableCdsSessionId(
                    currentSession.Status,
                    currentSession.CdsSessionId);
                currentConnection = await GetActiveConnectionAsync(currentSession, cancellationToken);
                currentToken = await GetLongTokenAsync(currentConnection.Id, cancellationToken);
                using var retryResponse = await SendCdsMessageIdempotentlyAsync(
                    currentConnection,
                    currentToken,
                    currentSession.CdsProjectId,
                    restartedCdsSessionId,
                    content,
                    outboundMessage.Id,
                    cancellationToken);
                return await ReadCdsItemAsync(retryResponse, cancellationToken);
            }
        }
    }

    public async Task<bool> InjectWorkspaceFilesAsync(
        string userId, string id, IReadOnlyList<InfraAgentWorkspaceFileInput> files, CancellationToken ct)
    {
        var session = await FindOwnedSessionAsync(userId, id, ct);
        if (session == null)
        {
            throw new InfraAgentSessionException(
                InfraAgentSessionErrorCodes.SessionNotFound, "会话不存在", StatusCodes.Status404NotFound);
        }
        if (files == null || files.Count == 0) return false;

        var connection = await GetActiveConnectionAsync(session, ct);
        var token = await GetLongTokenAsync(connection.Id, ct);
        // v1：复用 CDS 现成的 POST /projects/:id/files（写进项目分支 worktree，不改边车镜像）。
        // 探针目的：实测 agent 会话能否读到注入的文件。
        using var response = await SendCdsJsonAsync(
            HttpMethod.Post,
            connection,
            token,
            $"/api/projects/{Uri.EscapeDataString(session.CdsProjectId)}/files",
            new
            {
                files = files.Select(f => new { relativePath = f.Path, content = f.Content }).ToArray()
            },
            ct);
        response.EnsureSuccessStatusCode();
        _logger.LogInformation(
            "[infra-agent] injected {Count} file(s) into workspace project={ProjectId} session={SessionId}",
            files.Count, session.CdsProjectId, session.Id);
        return true;
    }

    public async Task RunRuntimeJobAsync(
        string userId,
        string id,
        string messageId,
        string content,
        CancellationToken ct)
    {
        var session = await FindOwnedSessionAsync(userId, id, ct);
        if (session == null) return;

        if (!IsMapDirectRuntimeFallbackEnabled())
        {
            // CDS session transport（默认路径）：在后台 worker 里拉取 CDS 流式事件落库，
            // 与 HTTP 请求解耦。消息已由 SendMessageAsync 同步 POST 到 CDS，这里只负责导入。
            if (string.IsNullOrWhiteSpace(session.CdsSessionId))
            {
                return;
            }
            var cdsSourceSessionId = session.CdsSessionId;
            var turnMessageId = messageId;
            if (string.IsNullOrWhiteSpace(turnMessageId)
                || !string.Equals(session.ActiveMessageId, turnMessageId, StringComparison.Ordinal))
            {
                // 队列任务启动前，该轮可能已经被更快的 follow/poll 投影为终态。
                // null 绝不能退化成“同 generation 任意轮”的写权限；此 job 已无所属轮次。
                return;
            }
            try
            {
                var turnStartedAt = session.UpdatedAt;
                // server-authority：客户端断开不打断 agent 运行。单条 CDS follow SSE 若被网络、代理、
                // JSON 解析或 Mongo 落库异常截断，则重新读取已持久化 CdsSeq 水位并续订，直至终态。
                var importResult = await FollowCdsStreamWithRetryAsync(
                    async retryCt =>
                    {
                        try
                        {
                            var connection = await GetActiveConnectionAsync(session, retryCt);
                            var token = await GetLongTokenAsync(connection.Id, retryCt);
                            return await ImportCdsStreamEventsAsync(
                                connection,
                                token,
                                session,
                                0,
                                retryCt,
                                followUntilTerminal: true);
                        }
                        catch (InfraAgentSessionException ex) when (IsCdsSessionNotFound(ex))
                        {
                            const string lostMessage = "CDS 会话已丢失（CDS 服务可能刚重启/自更新），请重建会话重试";
                            if (await ApplyCdsFailedTurnProjectionAsync(
                                session.Id,
                                cdsSourceSessionId,
                                turnMessageId,
                                lostMessage,
                                preserveActiveMessage: false,
                                CancellationToken.None))
                            {
                                await AppendRawEventAsync(
                                    session.Id,
                                    await NextEventSeqAsync(session.Id, CancellationToken.None),
                                    InfraAgentEventTypes.Error,
                                    JsonSerializer.Serialize(new { message = lostMessage, code = "cds_session_lost" }),
                                    CancellationToken.None,
                                    cdsSeq: null,
                                    cdsSourceSessionId: cdsSourceSessionId);
                            }
                            return new CdsStreamImportResult(
                                InfraAgentSessionStatuses.Failed,
                                lostMessage);
                        }
                    },
                    retryCt => ReadPersistedCdsTerminalStatusAsync(
                        session.Id,
                        session.CdsSessionId!,
                        turnStartedAt,
                        retryCt),
                    (attempt, exception, delay) =>
                    {
                        _logger.LogWarning(
                            exception,
                            "CDS stream ended before terminal event; reconnecting session={SessionId} attempt={Attempt} delayMs={DelayMs}",
                            session.Id,
                            attempt,
                            delay.TotalMilliseconds);
                        return Task.CompletedTask;
                    },
                    TimeSpan.FromSeconds(Math.Clamp(session.TimeoutSeconds, 1, 86_400)),
                    TimeSpan.FromSeconds(5),
                    CancellationToken.None);

                if (importResult.TimedOut)
                {
                    var timeoutSeconds = Math.Clamp(session.TimeoutSeconds, 1, 86_400);
                    var timeoutMessage = $"CDS Agent 事件同步超过任务时限（{timeoutSeconds} 秒），已停止等待";
                    if (await ApplyCdsFailedTurnProjectionAsync(
                        session.Id,
                        cdsSourceSessionId,
                        turnMessageId,
                        timeoutMessage,
                        preserveActiveMessage: false,
                        CancellationToken.None))
                    {
                        await AppendRawEventAsync(
                            session.Id,
                            await NextEventSeqAsync(session.Id, CancellationToken.None),
                            InfraAgentEventTypes.Error,
                            JsonSerializer.Serialize(new { message = timeoutMessage, code = "cds_stream_sync_timeout" }),
                            CancellationToken.None,
                            cdsSeq: null,
                            cdsSourceSessionId: cdsSourceSessionId);
                    }
                    return;
                }
                // ImportCdsStreamEventsAsync 的每个终态都在事件投影中按
                // (CDS generation, clientMessageId) 原子提交。这里不得再按 generation
                // 做第二次宽松回写，否则旧 worker 会覆盖同一 CDS 会话中的新一轮。
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "[infra-agent] background CDS stream import failed session={SessionId}", session.Id);
            }
            return;
        }

        bool runtimeOk;
        try
        {
            runtimeOk = await RunSidecarRuntimeIfAvailableAsync(session, content, ct);
        }
        catch (OperationCanceledException) { throw; }
        catch (Exception ex)
        {
            await AppendRawEventAsync(
                session.Id,
                await NextEventSeqAsync(session.Id, ct),
                InfraAgentEventTypes.Error,
                JsonSerializer.Serialize(new
                {
                    code = "runtime_job_failed",
                    message = ex.Message,
                    source = "runtime-dispatcher",
                    retryable = true
                }),
                ct);
            await MarkRuntimeFailedAsync(session, $"Runtime job failed: {ex.Message}", ct);
            return;
        }

        if (!runtimeOk) return;

        session.UpdatedAt = DateTime.UtcNow;
        await _db.InfraAgentSessions.UpdateOneAsync(
            Builders<InfraAgentSession>.Filter.And(
                Builders<InfraAgentSession>.Filter.Eq(x => x.Id, id),
                Builders<InfraAgentSession>.Filter.Eq(x => x.UserId, userId),
                Builders<InfraAgentSession>.Filter.In(x => x.Status, CdsRuntimeWritableStatuses)),
            Builders<InfraAgentSession>.Update
                .Set(x => x.UpdatedAt, session.UpdatedAt)
                .Set(x => x.Status, InfraAgentSessionStatuses.Running),
            cancellationToken: ct);
    }

    public async Task<InfraAgentSessionView?> SetManualTakeoverAsync(
        string userId,
        string id,
        ManualTakeoverRequest request,
        CancellationToken ct)
    {
        var session = await FindOwnedSessionAsync(userId, id, ct);
        if (session == null) return null;

        var now = DateTime.UtcNow;
        var reason = NormalizeOptional(request.Reason);
        var update = Builders<InfraAgentSession>.Update
            .Set(x => x.ManualTakeoverEnabled, request.Enabled)
            .Set(x => x.ManualTakeoverAt, request.Enabled ? now : null)
            .Set(x => x.ManualTakeoverReason, request.Enabled ? reason : null)
            .Set(x => x.UpdatedAt, now);

        await _db.InfraAgentSessions.UpdateOneAsync(
            x => x.Id == id && x.UserId == userId,
            update,
            cancellationToken: ct);

        session.ManualTakeoverEnabled = request.Enabled;
        session.ManualTakeoverAt = request.Enabled ? now : null;
        session.ManualTakeoverReason = request.Enabled ? reason : null;
        session.UpdatedAt = now;

        await AppendRawEventAsync(
            session.Id,
            await NextEventSeqAsync(session.Id, ct),
            InfraAgentEventTypes.Manual,
            JsonSerializer.Serialize(new
            {
                action = request.Enabled ? "takeover_enabled" : "takeover_disabled",
                reason,
                operatorId = userId
            }),
            ct);

        return ToView(session);
    }

    public async Task<InfraAgentSessionView?> AddManualInputAsync(
        string userId,
        string id,
        ManualInputRequest request,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(request.Content))
        {
            throw new InfraAgentSessionException(
                InfraAgentSessionErrorCodes.MessageContentRequired,
                "人工输入内容不能为空");
        }

        var session = await FindOwnedSessionAsync(userId, id, ct);
        if (session == null) return null;
        if (!session.ManualTakeoverEnabled)
        {
            throw new InfraAgentSessionException(
                InfraAgentSessionErrorCodes.ManualTakeoverRequired,
                "请先开启人工接管，再记录人工输入",
                StatusCodes.Status409Conflict);
        }

        var content = request.Content.Trim();
        var now = DateTime.UtcNow;
        await _db.InfraAgentMessages.InsertOneAsync(new InfraAgentMessage
        {
            SessionId = id,
            Role = InfraAgentMessageRoles.User,
            Content = $"[人工接管]\n{content}",
            Status = InfraAgentMessageStatuses.Completed,
            CreatedAt = now
        }, cancellationToken: ct);

        await AppendRawEventAsync(
            session.Id,
            await NextEventSeqAsync(session.Id, ct),
            InfraAgentEventTypes.Manual,
            JsonSerializer.Serialize(new
            {
                action = "manual_input",
                content,
                operatorId = userId
            }),
            ct);

        await _db.InfraAgentSessions.UpdateOneAsync(
            x => x.Id == id && x.UserId == userId,
            Builders<InfraAgentSession>.Update.Set(x => x.UpdatedAt, now),
            cancellationToken: ct);
        session.UpdatedAt = now;
        return ToView(session);
    }

    public async Task<InfraAgentSessionView?> ScheduleStopAsync(
        string userId,
        string id,
        string expectedCdsSessionId,
        string expectedMessageId,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(expectedCdsSessionId)
            || string.IsNullOrWhiteSpace(expectedMessageId))
        {
            throw new InfraAgentSessionException(
                InfraAgentSessionErrorCodes.CdsRequestFailed,
                "完成事件缺少稳定会话或消息身份，不能安全登记资源清理",
                StatusCodes.Status502BadGateway);
        }

        var now = DateTime.UtcNow;
        var completedTurn = Builders<InfraAgentSession>.Filter.Or(
            Builders<InfraAgentSession>.Filter.And(
                Builders<InfraAgentSession>.Filter.Eq(x => x.Status, InfraAgentSessionStatuses.Running),
                Builders<InfraAgentSession>.Filter.Eq(x => x.ActiveMessageId, expectedMessageId)),
            Builders<InfraAgentSession>.Filter.And(
                Builders<InfraAgentSession>.Filter.Eq(x => x.Status, InfraAgentSessionStatuses.Idle),
                Builders<InfraAgentSession>.Filter.Eq(x => x.ActiveMessageId, null),
                Builders<InfraAgentSession>.Filter.Eq(x => x.LastCompletedMessageId, expectedMessageId)));
        var scheduled = await _db.InfraAgentSessions.FindOneAndUpdateAsync(
            Builders<InfraAgentSession>.Filter.And(
                Builders<InfraAgentSession>.Filter.Eq(x => x.Id, id),
                Builders<InfraAgentSession>.Filter.Eq(x => x.UserId, userId),
                Builders<InfraAgentSession>.Filter.Eq(x => x.CdsSessionId, expectedCdsSessionId),
                completedTurn,
                Builders<InfraAgentSession>.Filter.Eq(x => x.CleanupRequestedAt, null)),
            Builders<InfraAgentSession>.Update
                .Set(x => x.CleanupRequestedAt, now)
                .Set(x => x.CleanupCdsSessionId, expectedCdsSessionId)
                .Set(x => x.CleanupMessageId, expectedMessageId)
                .Set(x => x.CleanupAttemptCount, 0)
                .Set(x => x.CleanupNextAttemptAt, now)
                .Set(x => x.CleanupLastError, null)
                .Set(x => x.UpdatedAt, now),
            new FindOneAndUpdateOptions<InfraAgentSession>
            {
                ReturnDocument = ReturnDocument.After,
            },
            ct);
        if (scheduled != null)
        {
            try
            {
                await AppendRawEventAsync(
                    scheduled.Id,
                    await NextEventSeqAsync(scheduled.Id, ct),
                    InfraAgentEventTypes.Log,
                    JsonSerializer.Serialize(new
                    {
                        level = "info",
                        source = "session-cleanup-worker",
                        message = "completed session cleanup scheduled"
                    }),
                    ct);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(
                    ex,
                    "Completed cleanup ledger persisted but audit append failed session={SessionId}",
                    scheduled.Id);
            }
            return ToView(scheduled);
        }

        var current = await FindOwnedSessionAsync(userId, id, ct);
        if (current == null) return null;
        if (current.Status == InfraAgentSessionStatuses.Stopped
            || current.CleanupRequestedAt != null
                && string.Equals(current.CleanupCdsSessionId, expectedCdsSessionId, StringComparison.Ordinal)
                && string.Equals(current.CleanupMessageId, expectedMessageId, StringComparison.Ordinal))
        {
            return ToView(current);
        }
        throw new InfraAgentSessionException(
            InfraAgentSessionErrorCodes.SessionStillRunning,
            "远程会话已进入其他轮次，不能把旧完成事件附着到当前资源清理",
            StatusCodes.Status409Conflict);
    }

    public async Task<int> RecoverPendingStopsAsync(CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        var leaseAvailable = Builders<InfraAgentSession>.Filter.Or(
            Builders<InfraAgentSession>.Filter.Ne(x => x.Status, InfraAgentSessionStatuses.Stopping),
            Builders<InfraAgentSession>.Filter.Eq(x => x.StopLeaseExpiresAt, null),
            Builders<InfraAgentSession>.Filter.Lte(x => x.StopLeaseExpiresAt, now));
        var candidates = await _db.InfraAgentSessions
            .Find(Builders<InfraAgentSession>.Filter.And(
                Builders<InfraAgentSession>.Filter.Ne(x => x.CleanupRequestedAt, null),
                Builders<InfraAgentSession>.Filter.Or(
                    Builders<InfraAgentSession>.Filter.Eq(x => x.CleanupNextAttemptAt, null),
                    Builders<InfraAgentSession>.Filter.Lte(x => x.CleanupNextAttemptAt, now)),
                Builders<InfraAgentSession>.Filter.Ne(x => x.Status, InfraAgentSessionStatuses.Stopped),
                Builders<InfraAgentSession>.Filter.Eq(x => x.ActiveMessageId, null),
                leaseAvailable))
            .SortBy(x => x.CleanupNextAttemptAt)
            .ThenBy(x => x.CleanupRequestedAt)
            .Limit(PendingStopRecoveryBatchSize)
            .ToListAsync(ct);

        var stoppedCount = 0;
        foreach (var candidate in candidates)
        {
            try
            {
                var result = await StopAsyncCore(
                    candidate.UserId,
                    candidate.Id,
                    ct,
                    expectedCleanup: candidate,
                    cleanupDueAt: now);
                if (result?.Status == InfraAgentSessionStatuses.Stopped)
                {
                    stoppedCount++;
                }
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(
                    ex,
                    "Persisted infra agent cleanup remains pending session={SessionId}",
                    candidate.Id);
            }
        }

        return stoppedCount;
    }

    public Task<InfraAgentSessionView?> StopAsync(string userId, string id, CancellationToken ct)
        => StopAsyncCore(userId, id, ct, expectedCleanup: null, cleanupDueAt: null);

    private async Task<InfraAgentSessionView?> StopAsyncCore(
        string userId,
        string id,
        CancellationToken ct,
        InfraAgentSession? expectedCleanup,
        DateTime? cleanupDueAt)
    {
        var session = await FindOwnedSessionAsync(userId, id, ct);
        if (session == null) return null;
        if (expectedCleanup != null
            && !CanClaimScheduledCleanup(session, expectedCleanup, cleanupDueAt!.Value))
        {
            return ToView(session);
        }

        // CleanupRequestedAt is the durable authority written only after the caller has accepted
        // a completed artifact. Historical Done events are deliberately not consulted: an old
        // terminal event must never soften failure handling for an explicit stop or a newer turn.
        var deferCompletedTurnStopFailure = ShouldDeferScheduledCleanupFailure(
            session.Status,
            session.ActiveMessageId,
            session.CleanupRequestedAt);

        if (CanReturnStoppedWithoutCleanup(
            session.Status,
            session.StartAttemptId,
            session.PendingCdsSessionIds.Count))
        {
            if (session.PrewarmKey != null || session.PrewarmExpiresAt != null)
            {
                await _db.InfraAgentSessions.UpdateOneAsync(
                    x => x.Id == id && x.UserId == userId && x.Status == InfraAgentSessionStatuses.Stopped,
                    Builders<InfraAgentSession>.Update
                        .Set(x => x.PrewarmKey, null)
                        .Set(x => x.PrewarmExpiresAt, null)
                        .Set(x => x.UpdatedAt, DateTime.UtcNow),
                    cancellationToken: CancellationToken.None);
            }
            return ToView(session);
        }

        var stoppingAt = DateTime.UtcNow;
        var stopLeaseOwner = $"stop_{Guid.NewGuid():N}";
        var stopLeaseExpiresAt = stoppingAt + CdsStopLeaseDuration;
        var transition = await _db.InfraAgentSessions.UpdateOneAsync(
            BuildCdsStopTransitionFilter(session, userId, id, stoppingAt),
            Builders<InfraAgentSession>.Update
                .Set(x => x.Status, InfraAgentSessionStatuses.Stopping)
                .Set(x => x.ActiveMessageId, null)
                .Set(x => x.StopLeaseOwner, stopLeaseOwner)
                .Set(x => x.StopLeaseExpiresAt, stopLeaseExpiresAt)
                .Set(x => x.UpdatedAt, stoppingAt),
            cancellationToken: CancellationToken.None);
        if (transition.ModifiedCount == 0)
        {
            var current = await FindOwnedSessionAsync(userId, id, ct);
            return current == null ? null : ToView(current);
        }
        session = await FindOwnedSessionAsync(userId, id, CancellationToken.None);
        if (session == null) return null;
        await AppendStatusEventAsync(
            session.Id,
            await NextEventSeqAsync(session.Id, CancellationToken.None),
            session.Status,
            "session_stop_requested",
            CancellationToken.None);

        try
        {
            var cancelAdapter = ResolveAdapterByKind(session.RuntimeAdapter);
            if (!string.IsNullOrWhiteSpace(session.CurrentRuntimeRunId) && cancelAdapter != null)
            {
                var cancel = await RunBestEffortRuntimeCancelAsync(
                    () => cancelAdapter.CancelAsync(session.CurrentRuntimeRunId, CancellationToken.None),
                    ex => _logger.LogWarning(
                        ex,
                        "Runtime cancellation failed; continuing session cleanup session={SessionId}",
                        session.Id));
                await AppendRawEventAsync(
                    session.Id,
                    await NextEventSeqAsync(session.Id, CancellationToken.None),
                    InfraAgentEventTypes.Log,
                    JsonSerializer.Serialize(new
                    {
                        level = cancel?.Cancelled == true ? "info" : "warning",
                        source = "runtime-adapter",
                        runtimeAdapter = cancel?.AdapterKind ?? session.RuntimeAdapter,
                        runtimeRunId = session.CurrentRuntimeRunId,
                        message = cancel?.Cancelled == true
                            ? "runtime run cancel requested"
                            : "runtime run cancel did not complete; continuing session cleanup"
                    }),
                    CancellationToken.None);
            }

            InfraConnection? connection = null;
            string? token = null;
            if (!string.IsNullOrWhiteSpace(session.CdsSessionId)
                || session.PendingCdsSessionIds.Count > 0
                || !string.IsNullOrWhiteSpace(session.StartAttemptId))
            {
                connection = await GetActiveConnectionAsync(session, CancellationToken.None);
                token = await GetLongTokenAsync(connection.Id, CancellationToken.None);
            }
            if (!string.IsNullOrWhiteSpace(session.StartAttemptId))
            {
                var pendingAttemptId = session.StartAttemptId;
                using var recoveryLookupCts = new CancellationTokenSource(TimeSpan.FromSeconds(30));
                var recoveredId = await FindCdsSessionIdByClientRequestIdAsync(
                    session,
                    pendingAttemptId,
                    connection!,
                    token!,
                    recoveryLookupCts.Token);
                if (!string.IsNullOrWhiteSpace(recoveredId)
                    && !string.Equals(recoveredId, session.CdsSessionId, StringComparison.Ordinal))
                {
                    await _db.InfraAgentSessions.UpdateOneAsync(
                        x => x.Id == id
                            && x.UserId == userId
                            && x.Status == InfraAgentSessionStatuses.Stopping
                            && x.StopLeaseOwner == stopLeaseOwner,
                        Builders<InfraAgentSession>.Update.AddToSet(x => x.PendingCdsSessionIds, recoveredId),
                        cancellationToken: CancellationToken.None);
                    session.PendingCdsSessionIds.Add(recoveredId);
                }
                // The persistent CDS reservation is now either ledgered or confirmed absent.
                // Retire this attempt under the stop owner. Any later response still loses the
                // attempt CAS and must publish its stable ID to PendingCdsSessionIds before cleanup.
                await _db.InfraAgentSessions.UpdateOneAsync(
                    x => x.Id == id
                        && x.UserId == userId
                        && x.Status == InfraAgentSessionStatuses.Stopping
                        && x.StopLeaseOwner == stopLeaseOwner
                        && x.StartAttemptId == pendingAttemptId,
                    Builders<InfraAgentSession>.Update.Set(x => x.StartAttemptId, null),
                    cancellationToken: CancellationToken.None);
                session.StartAttemptId = null;
            }

            var remoteSessionIds = session.PendingCdsSessionIds
                .Append(session.CdsSessionId)
                .Where(x => !string.IsNullOrWhiteSpace(x))
                .Select(x => x!)
                .Distinct(StringComparer.Ordinal)
                .ToList();
            if (remoteSessionIds.Count > 0)
            {
                var hookProfile = await GetHookProfileAsync(session, CancellationToken.None);
                await RunHookAsync(session, hookProfile, "beforeStop", hookProfile?.BeforeStop, blockOnFailure: false, CancellationToken.None);
                foreach (var remoteSessionId in remoteSessionIds)
                {
                    if (!await RenewCdsStopLeaseAsync(userId, id, stopLeaseOwner, CancellationToken.None))
                    {
                        var current = await FindOwnedSessionAsync(userId, id, CancellationToken.None);
                        return current == null ? null : ToView(current);
                    }
                    await StopRemoteCdsSessionAsync(session, remoteSessionId, connection!, token!);
                    await _db.InfraAgentSessions.UpdateOneAsync(
                        x => x.Id == id && x.UserId == userId && x.StopLeaseOwner == stopLeaseOwner,
                        Builders<InfraAgentSession>.Update.Pull(x => x.PendingCdsSessionIds, remoteSessionId),
                        cancellationToken: CancellationToken.None);
                }
                await RunHookAsync(session, hookProfile, "afterStop", hookProfile?.AfterStop, blockOnFailure: false, CancellationToken.None);
            }
        }
        catch (Exception ex)
        {
            var safeError = SanitizeCdsErrorMessage(ex.Message, "停止 CDS Agent 会话失败");
            var stopFailureRecorded = deferCompletedTurnStopFailure
                ? await MarkCompletedTurnStopRetryPendingAsync(
                    session,
                    stopLeaseOwner,
                    safeError,
                    CancellationToken.None)
                : await MarkStopFailedAsync(session, stopLeaseOwner, safeError, CancellationToken.None);
            if (!stopFailureRecorded)
            {
                var current = await FindOwnedSessionAsync(userId, id, CancellationToken.None);
                if (current?.Status == InfraAgentSessionStatuses.Stopped)
                {
                    return ToView(current);
                }
            }
            if (ex is InfraAgentSessionException) throw;
            throw new InfraAgentSessionException(
                InfraAgentSessionErrorCodes.CdsRequestFailed,
                $"停止 CDS Agent 会话失败：{safeError}",
                StatusCodes.Status502BadGateway);
        }

        session = await FindOwnedSessionAsync(userId, id, CancellationToken.None);
        if (session == null) return null;
        if (session.Status != InfraAgentSessionStatuses.Stopping
            || session.StopLeaseOwner != stopLeaseOwner)
        {
            return ToView(session);
        }
        if (!string.IsNullOrWhiteSpace(session.StartAttemptId)
            && string.IsNullOrWhiteSpace(session.CdsSessionId)
            && session.PendingCdsSessionIds.Count == 0)
        {
            // The create request still owns the only path by which CDS can return its resource
            // identity. Keep the session in a reclaimable Stopping lease; its response callback
            // will register and compensate the resource. A later Stop can take over after the
            // lease if the process dies before that callback runs.
            return ToView(session);
        }

        var now = DateTime.UtcNow;
        var update = Builders<InfraAgentSession>.Update
            .Set(x => x.Status, InfraAgentSessionStatuses.Stopped)
            .Set(x => x.UpdatedAt, now)
            .Set(x => x.StoppedAt, now)
            .Set(x => x.LastError, null)
            .Set(x => x.CurrentRuntimeRunId, null)
            .Set(x => x.ActiveMessageId, null)
            .Set(x => x.StartAttemptId, null)
            .Set(x => x.StopLeaseOwner, null)
            .Set(x => x.StopLeaseExpiresAt, null)
            .Set(x => x.CleanupRequestedAt, null)
            .Set(x => x.CleanupCdsSessionId, null)
            .Set(x => x.CleanupMessageId, null)
            .Set(x => x.CleanupAttemptCount, 0)
            .Set(x => x.CleanupNextAttemptAt, null)
            .Set(x => x.CleanupLastError, null)
            .Set(x => x.PrewarmKey, null)
            .Set(x => x.PrewarmExpiresAt, null);

        var stopped = await _db.InfraAgentSessions.UpdateOneAsync(
            x => x.Id == id
                && x.UserId == userId
                && x.Status == InfraAgentSessionStatuses.Stopping
                && x.StopLeaseOwner == stopLeaseOwner
                && x.PendingCdsSessionIds.Count == 0,
            update,
            cancellationToken: CancellationToken.None);
        if (stopped.ModifiedCount == 0)
        {
            var current = await FindOwnedSessionAsync(userId, id, CancellationToken.None);
            return current == null ? null : ToView(current);
        }

        session.Status = InfraAgentSessionStatuses.Stopped;
        session.UpdatedAt = now;
        session.StoppedAt = now;
        session.LastError = null;
        session.CurrentRuntimeRunId = null;
        session.StartAttemptId = null;
        session.StopLeaseOwner = null;
        session.StopLeaseExpiresAt = null;

        var nextSeq = await NextEventSeqAsync(session.Id, CancellationToken.None);
        await AppendStatusEventAsync(session.Id, nextSeq, session.Status, "session_stopped", CancellationToken.None);

        return ToView(session);
    }

    public async Task<InfraAgentSessionView?> ArchiveAsync(string userId, string id, CancellationToken ct)
    {
        var session = await FindOwnedSessionAsync(userId, id, ct);
        if (session == null) return null;

        if (session.Status is InfraAgentSessionStatuses.Running
            or InfraAgentSessionStatuses.Creating
            or InfraAgentSessionStatuses.Stopping
            || session.PendingCdsSessionIds.Count > 0
            || !string.IsNullOrWhiteSpace(session.StartAttemptId)
            || session.Status == InfraAgentSessionStatuses.Failed
                && !string.IsNullOrWhiteSpace(session.CdsSessionId))
        {
            throw new InfraAgentSessionException(
                InfraAgentSessionErrorCodes.SessionStillRunning,
                "运行中的远程会话需要先停止，再归档",
                StatusCodes.Status409Conflict);
        }

        var now = DateTime.UtcNow;
        await _db.InfraAgentSessions.UpdateOneAsync(
            x => x.Id == id && x.UserId == userId,
            Builders<InfraAgentSession>.Update
                .Set(x => x.IsArchived, true)
                .Set(x => x.UpdatedAt, now),
            cancellationToken: ct);

        session.IsArchived = true;
        session.UpdatedAt = now;
        await AppendStatusEventAsync(session.Id, await NextEventSeqAsync(session.Id, ct), session.Status, "session_archived", ct);
        return ToView(session);
    }

    public async Task<InfraAgentSessionView?> CollectArtifactsAsync(string userId, string id, CancellationToken ct)
    {
        var session = await FindOwnedSessionAsync(userId, id, ct);
        if (session == null) return null;

        var context = new AgentToolInvocationContext
        {
            RunId = $"infra-agent-artifacts-{session.Id}-{Guid.NewGuid():N}",
            AppCallerCode = "infra-agent-session::artifact-collector",
            SidecarName = "map-artifact-collector",
            InfraAgentSessionId = session.Id,
            CdsProjectId = session.CdsProjectId
        };

        await AppendRawEventAsync(session.Id, await NextEventSeqAsync(session.Id, ct), InfraAgentEventTypes.Log, JsonSerializer.Serialize(new
        {
            level = "info",
            source = "map-artifact-collector",
            message = "collecting readonly repository artifacts"
        }), ct);

        foreach (var request in BuildReadonlyArtifactRequests())
        {
            var seq = await NextEventSeqAsync(session.Id, ct);
            await AppendRawEventAsync(session.Id, seq, InfraAgentEventTypes.ToolCall, JsonSerializer.Serialize(new
            {
                approvalId = $"artifact-{request.ToolName}-{seq}",
                toolName = request.ToolName,
                argsSummary = request.Input.GetRawText(),
                risk = "readonly",
                status = "auto_allowed",
                source = "map-artifact-collector"
            }), ct);

            var result = await _toolRegistry.InvokeAsync(request.ToolName, request.Input, context, ct);
            await AppendRawEventAsync(session.Id, await NextEventSeqAsync(session.Id, ct), InfraAgentEventTypes.ToolResult, JsonSerializer.Serialize(new
            {
                approvalId = $"artifact-{request.ToolName}-{seq}",
                decision = result.Success ? "completed" : "failed",
                resultSummary = result.Success
                    ? result.Content
                    : JsonSerializer.Serialize(new
                    {
                        errorCode = result.ErrorCode,
                        message = result.Message
                    }),
                source = "map-artifact-collector"
            }), ct);
        }

        var now = DateTime.UtcNow;
        await _db.InfraAgentSessions.UpdateOneAsync(
            x => x.Id == session.Id && x.UserId == userId,
            Builders<InfraAgentSession>.Update.Set(x => x.UpdatedAt, now),
            cancellationToken: ct);
        session.UpdatedAt = now;

        return ToView(session);
    }

    public async Task<InfraAgentTraceBundleView?> GetTraceBundleAsync(string userId, string id, CancellationToken ct)
    {
        var session = await FindOwnedSessionAsync(userId, id, ct);
        if (session == null) return null;

        await TryImportCdsStreamEventsAsync(session, ct);

        const int maxEvents = 5000;
        const int maxMessages = 500;
        var events = await _db.InfraAgentEvents
            .Find(x => x.SessionId == id)
            .SortBy(x => x.Seq)
            .Limit(maxEvents + 1)
            .ToListAsync(ct);
        var messages = await _db.InfraAgentMessages
            .Find(x => x.SessionId == id)
            .SortBy(x => x.CreatedAt)
            .Limit(maxMessages)
            .ToListAsync(ct);
        var logs = await GetLogsAsync(userId, id, ct) ?? string.Empty;
        var truncated = events.Count > maxEvents;
        if (truncated)
        {
            events = events.Take(maxEvents).ToList();
        }

        return BuildTraceBundle(
            ToView(session),
            messages.Select(ToMessageView).ToList(),
            events.Select(ToEventView).ToList(),
            logs,
            truncated);
    }

    public async Task<InfraAgentSessionView?> RunReadonlyChecksAsync(string userId, string id, CancellationToken ct)
    {
        var session = await FindOwnedSessionAsync(userId, id, ct);
        if (session == null) return null;

        var context = new AgentToolInvocationContext
        {
            RunId = $"infra-agent-readonly-checks-{session.Id}-{Guid.NewGuid():N}",
            AppCallerCode = "infra-agent-session::readonly-checks",
            SidecarName = "map-readonly-checks",
            InfraAgentSessionId = session.Id,
            CdsProjectId = session.CdsProjectId
        };

        await AppendRawEventAsync(session.Id, await NextEventSeqAsync(session.Id, ct), InfraAgentEventTypes.Log, JsonSerializer.Serialize(new
        {
            level = "info",
            source = "map-readonly-checks",
            message = "running readonly repository checks"
        }), ct);

        foreach (var request in BuildReadonlyCheckRequests())
        {
            var seq = await NextEventSeqAsync(session.Id, ct);
            await AppendRawEventAsync(session.Id, seq, InfraAgentEventTypes.ToolCall, JsonSerializer.Serialize(new
            {
                approvalId = $"readonly-check-{seq}",
                toolName = "repo_run_command",
                argsSummary = request.Input.GetRawText(),
                risk = "readonly",
                status = "auto_allowed",
                source = "map-readonly-checks"
            }), ct);

            var result = await _toolRegistry.InvokeAsync("repo_run_command", request.Input, context, ct);
            await AppendRawEventAsync(session.Id, await NextEventSeqAsync(session.Id, ct), InfraAgentEventTypes.ToolResult, JsonSerializer.Serialize(new
            {
                approvalId = $"readonly-check-{seq}",
                decision = result.Success ? "completed" : "failed",
                resultSummary = result.Success
                    ? result.Content
                    : JsonSerializer.Serialize(new
                    {
                        errorCode = result.ErrorCode,
                        message = result.Message
                    }),
                source = "map-readonly-checks"
            }), ct);
        }

        var now = DateTime.UtcNow;
        await _db.InfraAgentSessions.UpdateOneAsync(
            x => x.Id == session.Id && x.UserId == userId,
            Builders<InfraAgentSession>.Update.Set(x => x.UpdatedAt, now),
            cancellationToken: ct);
        session.UpdatedAt = now;

        return ToView(session);
    }

    public async Task<InfraAgentSessionView?> CaptureBrowserSnapshotAsync(
        string userId,
        string id,
        BrowserSnapshotRequest request,
        CancellationToken ct)
    {
        var session = await FindOwnedSessionAsync(userId, id, ct);
        if (session == null) return null;

        var connection = await GetActiveConnectionAsync(session, ct);
        var token = await GetLongTokenAsync(connection.Id, ct);
        var branchId = string.IsNullOrWhiteSpace(request.BranchId)
            ? "prd-agent-main"
            : request.BranchId.Trim();
        var description = string.IsNullOrWhiteSpace(request.Description)
            ? "从 MAP 工作台读取远程浏览器快照"
            : request.Description.Trim();

        var context = new AgentToolInvocationContext
        {
            RunId = $"infra-agent-browser-snapshot-{session.Id}-{Guid.NewGuid():N}",
            AppCallerCode = "infra-agent-session::browser-snapshot",
            SidecarName = "map-browser-snapshot",
            InfraAgentSessionId = session.Id,
            CdsBaseUrl = connection.PartnerBaseUrl,
            CdsProjectId = connection.ProjectId,
            CdsLongToken = token
        };

        await AppendRawEventAsync(session.Id, await NextEventSeqAsync(session.Id, ct), InfraAgentEventTypes.Log, JsonSerializer.Serialize(new
        {
            level = "info",
            source = "map-browser-snapshot",
            message = $"capturing remote browser snapshot for {branchId}"
        }), ct);

        var input = JsonSerializer.SerializeToElement(new
        {
            branchId,
            description
        });
        var seq = await NextEventSeqAsync(session.Id, ct);
        await AppendRawEventAsync(session.Id, seq, InfraAgentEventTypes.ToolCall, JsonSerializer.Serialize(new
        {
            approvalId = $"browser-snapshot-{seq}",
            toolName = "cds_bridge_snapshot",
            argsSummary = input.GetRawText(),
            risk = "readonly",
            status = "auto_allowed",
            source = "map-browser-snapshot"
        }), ct);

        var result = await _toolRegistry.InvokeAsync("cds_bridge_snapshot", input, context, ct);
        await AppendRawEventAsync(session.Id, await NextEventSeqAsync(session.Id, ct), InfraAgentEventTypes.ToolResult, JsonSerializer.Serialize(new
        {
            approvalId = $"browser-snapshot-{seq}",
            decision = result.Success ? "completed" : "failed",
            toolName = "cds_bridge_snapshot",
            resultSummary = result.Success
                ? result.Content
                : JsonSerializer.Serialize(new
                {
                    errorCode = result.ErrorCode,
                    message = result.Message
                }),
            source = "map-browser-snapshot"
        }), ct);

        if (result.Success && !string.IsNullOrWhiteSpace(result.Content))
        {
            await AppendRawEventAsync(
                session.Id,
                seq + 2,
                InfraAgentEventTypes.Browser,
                BuildBrowserSnapshotPayload(branchId, result.Content),
                ct);
        }

        var now = DateTime.UtcNow;
        await _db.InfraAgentSessions.UpdateOneAsync(
            x => x.Id == session.Id && x.UserId == userId,
            Builders<InfraAgentSession>.Update.Set(x => x.UpdatedAt, now),
            cancellationToken: ct);
        session.UpdatedAt = now;

        return ToView(session);
    }

    public async Task<InfraAgentSessionView?> RunBrowserActionAsync(
        string userId,
        string id,
        BrowserActionRequest request,
        CancellationToken ct)
    {
        var session = await FindOwnedSessionAsync(userId, id, ct);
        if (session == null) return null;

        if (string.IsNullOrWhiteSpace(request.Action))
        {
            throw new InfraAgentSessionException(
                "browser_action_required",
                "远程页面动作不能为空",
                StatusCodes.Status400BadRequest);
        }

        var connection = await GetActiveConnectionAsync(session, ct);
        var token = await GetLongTokenAsync(connection.Id, ct);
        var branchId = string.IsNullOrWhiteSpace(request.BranchId)
            ? "prd-agent-main"
            : request.BranchId.Trim();
        var action = request.Action.Trim();
        var description = string.IsNullOrWhiteSpace(request.Description)
            ? $"从 MAP 工作台执行远程页面动作 {action}"
            : request.Description.Trim();
        var parameters = request.Params ?? JsonDocument.Parse("{}").RootElement;

        var context = new AgentToolInvocationContext
        {
            RunId = $"infra-agent-browser-action-{session.Id}-{Guid.NewGuid():N}",
            AppCallerCode = "infra-agent-session::browser-action",
            SidecarName = "map-browser-action",
            InfraAgentSessionId = session.Id,
            CdsBaseUrl = connection.PartnerBaseUrl,
            CdsProjectId = connection.ProjectId,
            CdsLongToken = token
        };

        await AppendRawEventAsync(session.Id, await NextEventSeqAsync(session.Id, ct), InfraAgentEventTypes.Log, JsonSerializer.Serialize(new
        {
            level = "info",
            source = "map-browser-action",
            message = $"running remote browser action {action} for {branchId}"
        }), ct);

        var input = JsonSerializer.SerializeToElement(new
        {
            branchId,
            action,
            @params = parameters,
            description
        });
        var seq = await NextEventSeqAsync(session.Id, ct);
        await AppendRawEventAsync(session.Id, seq, InfraAgentEventTypes.ToolCall, JsonSerializer.Serialize(new
        {
            approvalId = $"browser-action-{seq}",
            toolName = "cds_bridge_action",
            argsSummary = input.GetRawText(),
            risk = "dangerous",
            status = "user_initiated",
            source = "map-browser-action"
        }), ct);

        var result = await _toolRegistry.InvokeAsync("cds_bridge_action", input, context, ct);
        await AppendRawEventAsync(session.Id, await NextEventSeqAsync(session.Id, ct), InfraAgentEventTypes.ToolResult, JsonSerializer.Serialize(new
        {
            approvalId = $"browser-action-{seq}",
            decision = result.Success ? "completed" : "failed",
            toolName = "cds_bridge_action",
            resultSummary = result.Success
                ? result.Content
                : JsonSerializer.Serialize(new
                {
                    errorCode = result.ErrorCode,
                    message = result.Message
                }),
            source = "map-browser-action"
        }), ct);

        if (result.Success && !string.IsNullOrWhiteSpace(result.Content))
        {
            await AppendRawEventAsync(
                session.Id,
                seq + 2,
                InfraAgentEventTypes.Browser,
                BuildBrowserActionPayload(branchId, action, result.Content),
                ct);
        }

        var now = DateTime.UtcNow;
        await _db.InfraAgentSessions.UpdateOneAsync(
            x => x.Id == session.Id && x.UserId == userId,
            Builders<InfraAgentSession>.Update.Set(x => x.UpdatedAt, now),
            cancellationToken: ct);
        session.UpdatedAt = now;

        return ToView(session);
    }

    public async Task<InfraAgentSessionView?> RequestToolApprovalAsync(
        string userId,
        string id,
        CreateToolApprovalRequest request,
        CancellationToken ct)
    {
        var session = await FindOwnedSessionAsync(userId, id, ct);
        if (session == null) return null;

        if (string.IsNullOrWhiteSpace(request.ToolName))
        {
            throw new InfraAgentSessionException(
                "tool_name_required",
                "工具名称不能为空",
                StatusCodes.Status400BadRequest);
        }

        var seq = await NextEventSeqAsync(session.Id, ct);
        var approvalId = $"map-approval-{seq}";
        await AppendRawEventAsync(session.Id, seq, InfraAgentEventTypes.ToolCall, JsonSerializer.Serialize(new
        {
            approvalId,
            toolName = request.ToolName.Trim(),
            argsSummary = string.IsNullOrWhiteSpace(request.ArgsSummary)
                ? "{\"command\":\"git status --short\"}"
                : request.ArgsSummary.Trim(),
            risk = string.IsNullOrWhiteSpace(request.Risk) ? "dangerous" : request.Risk.Trim(),
            status = "waiting",
            source = "map-approval-test",
            createdBy = "map-user"
        }), ct);

        var now = DateTime.UtcNow;
        await _db.InfraAgentSessions.UpdateOneAsync(
            x => x.Id == session.Id && x.UserId == userId,
            Builders<InfraAgentSession>.Update.Set(x => x.UpdatedAt, now),
            cancellationToken: ct);
        session.UpdatedAt = now;

        return ToView(session);
    }

    public async Task<List<InfraAgentEventView>> ListEventsAsync(
        string userId,
        string sessionId,
        long afterSeq,
        int limit,
        CancellationToken ct)
    {
        var session = await FindOwnedSessionAsync(userId, sessionId, ct);
        if (session == null)
        {
            throw new InfraAgentSessionException(
                InfraAgentSessionErrorCodes.SessionNotFound,
                "会话不存在",
                StatusCodes.Status404NotFound);
        }

        await TryImportCdsStreamEventsAsync(session, ct);

        var currentCdsSessionId = await _db.InfraAgentSessions
            .Find(x => x.Id == sessionId && x.UserId == userId)
            .Project(x => x.CdsSessionId)
            .FirstOrDefaultAsync(ct);
        return await ReadPersistedEventsAsync(sessionId, currentCdsSessionId, afterSeq, limit, ct);
    }

    public async Task<List<InfraAgentEventView>> ListPersistedEventsAsync(
        string userId,
        string sessionId,
        long afterSeq,
        int limit,
        CancellationToken ct)
    {
        var session = await FindOwnedSessionAsync(userId, sessionId, ct);
        if (session == null)
        {
            throw new InfraAgentSessionException(
                InfraAgentSessionErrorCodes.SessionNotFound,
                "会话不存在",
                StatusCodes.Status404NotFound);
        }

        if (ShouldRecoverPersistedCdsEvents(session.Status, session.CdsSessionId))
        {
            // DesignArtifact polls this persistence-only endpoint. It must also be an independent
            // recovery trigger when the in-memory runtime job queue was lost or unavailable.
            // TryImport is non-following, so each poll performs one bounded snapshot import before
            // reading MAP's durable event ledger.
            await TryImportCdsStreamEventsAsync(session, ct);
        }

        var currentCdsSessionId = await _db.InfraAgentSessions
            .Find(x => x.Id == sessionId && x.UserId == userId)
            .Project(x => x.CdsSessionId)
            .FirstOrDefaultAsync(ct);
        return await ReadPersistedEventsAsync(sessionId, currentCdsSessionId, afterSeq, limit, ct);
    }

    private async Task<List<InfraAgentEventView>> ReadPersistedEventsAsync(
        string sessionId,
        string? currentCdsSessionId,
        long afterSeq,
        int limit,
        CancellationToken ct)
    {
        var take = Math.Clamp(limit <= 0 ? 100 : limit, 1, 500);
        var filter = BuildVisibleEventFilter(sessionId, currentCdsSessionId, afterSeq);
        var items = await _db.InfraAgentEvents
            .Find(filter)
            .SortBy(x => x.Seq)
            .Limit(take)
            .ToListAsync(ct);
        return items.Select(ToEventView).ToList();
    }

    internal static FilterDefinition<InfraAgentEvent> BuildVisibleEventFilter(
        string sessionId,
        string? currentCdsSessionId,
        long afterSeq)
    {
        var filter = Builders<InfraAgentEvent>.Filter.And(
            Builders<InfraAgentEvent>.Filter.Eq(x => x.SessionId, sessionId),
            Builders<InfraAgentEvent>.Filter.Gt(x => x.Seq, afterSeq));
        var sourceFilter = string.IsNullOrWhiteSpace(currentCdsSessionId)
            ? Builders<InfraAgentEvent>.Filter.Eq(x => x.CdsSourceSessionId, null)
            : Builders<InfraAgentEvent>.Filter.Or(
                Builders<InfraAgentEvent>.Filter.Eq(x => x.CdsSourceSessionId, null),
                Builders<InfraAgentEvent>.Filter.Eq(x => x.CdsSourceSessionId, currentCdsSessionId));
        return filter & sourceFilter;
    }

    public async Task<List<InfraAgentMessageView>> ListMessagesAsync(
        string userId,
        string sessionId,
        int limit,
        CancellationToken ct)
    {
        var session = await FindOwnedSessionAsync(userId, sessionId, ct);
        if (session == null)
        {
            throw new InfraAgentSessionException(
                InfraAgentSessionErrorCodes.SessionNotFound,
                "会话不存在",
                StatusCodes.Status404NotFound);
        }

        await TryImportCdsStreamEventsAsync(session, ct);

        var currentCdsSessionId = await _db.InfraAgentSessions
            .Find(x => x.Id == sessionId && x.UserId == userId)
            .Project(x => x.CdsSessionId)
            .FirstOrDefaultAsync(ct);
        var take = Math.Clamp(limit <= 0 ? 100 : limit, 1, 500);
        var filter = BuildVisibleMessageFilter(sessionId, currentCdsSessionId);
        var items = await _db.InfraAgentMessages
            .Find(filter)
            .SortBy(x => x.CreatedAt)
            .Limit(take)
            .ToListAsync(ct);
        return items.Select(ToMessageView).ToList();
    }

    internal static FilterDefinition<InfraAgentMessage> BuildVisibleMessageFilter(
        string sessionId,
        string? currentCdsSessionId)
    {
        var visibleRemoteReply = Builders<InfraAgentMessage>.Filter.Ne(
            x => x.ReplyToMessageId,
            null);
        if (!string.IsNullOrWhiteSpace(currentCdsSessionId))
        {
            visibleRemoteReply |= Builders<InfraAgentMessage>.Filter.Eq(
                x => x.CdsSourceSessionId,
                currentCdsSessionId);
        }

        return Builders<InfraAgentMessage>.Filter.And(
            Builders<InfraAgentMessage>.Filter.Eq(x => x.SessionId, sessionId),
            Builders<InfraAgentMessage>.Filter.Or(
                Builders<InfraAgentMessage>.Filter.Ne(x => x.Role, InfraAgentMessageRoles.Assistant),
                Builders<InfraAgentMessage>.Filter.Eq(x => x.CdsSourceSessionId, null),
                visibleRemoteReply));
    }

    public async Task<string?> GetLogsAsync(string userId, string sessionId, CancellationToken ct)
    {
        var session = await FindOwnedSessionAsync(userId, sessionId, ct);
        if (session == null) return null;
        if (string.IsNullOrWhiteSpace(session.CdsSessionId)) return string.Empty;

        try
        {
            var connection = await GetActiveConnectionAsync(session, ct);
            var token = await GetLongTokenAsync(connection.Id, ct);
            using var response = await SendCdsJsonAsync(
                HttpMethod.Get,
                connection,
                token,
                $"/api/projects/{Uri.EscapeDataString(session.CdsProjectId)}/agent-sessions/{Uri.EscapeDataString(session.CdsSessionId)}/logs",
                null,
                ct);
            using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));
            return doc.RootElement.TryGetProperty("logs", out var logs) ? logs.GetString() : string.Empty;
        }
        catch (InfraAgentSessionException ex)
        {
            _logger.LogWarning(
                ex,
                "Failed to fetch CDS logs for infra agent session {SessionId} cdsSession={CdsSessionId}",
                session.Id,
                session.CdsSessionId);
            return await BuildLogFallbackAsync(session, ex.Message, ct);
        }
    }

    public async Task<InfraAgentSessionView?> ApproveToolAsync(
        string userId,
        string sessionId,
        string approvalId,
        ToolApprovalRequest request,
        CancellationToken ct)
    {
        var session = await FindOwnedSessionAsync(userId, sessionId, ct);
        if (session == null) return null;
        if (string.IsNullOrWhiteSpace(session.CdsSessionId)) return ToView(session);

        if (await HasLocalSidecarToolCallAsync(session.Id, approvalId, ct))
        {
            var decision = NormalizeApprovalDecision(request.Decision);
            await AppendRawEventAsync(
                session.Id,
                await NextEventSeqAsync(session.Id, ct),
                InfraAgentEventTypes.ToolResult,
                JsonSerializer.Serialize(new
                {
                    approvalId,
                    decision,
                    resultSummary = decision == "allow" ? "approved by MAP user" : "denied by MAP user",
                    source = "map-tool-approval"
                }),
                ct);
            return ToView(session);
        }

        var connection = await GetActiveConnectionAsync(session, ct);
        var token = await GetLongTokenAsync(connection.Id, ct);
        using var response = await SendCdsJsonAsync(
            HttpMethod.Post,
            connection,
            token,
            $"/api/projects/{Uri.EscapeDataString(session.CdsProjectId)}/agent-sessions/{Uri.EscapeDataString(session.CdsSessionId)}/tool-approvals/{Uri.EscapeDataString(approvalId)}",
            new { decision = request.Decision },
            ct);
        response.EnsureSuccessStatusCode();
        await ImportCdsStreamEventsAsync(connection, token, session, 0, ct);
        return ToView(session);
    }

    private async Task<bool> HasLocalSidecarToolCallAsync(
        string sessionId,
        string approvalId,
        CancellationToken ct)
    {
        var events = await _db.InfraAgentEvents
            .Find(x => x.SessionId == sessionId && x.Type == InfraAgentEventTypes.ToolCall)
            .SortByDescending(x => x.Seq)
            .Limit(120)
            .ToListAsync(ct);

        foreach (var evt in events)
        {
            try
            {
                using var doc = JsonDocument.Parse(evt.PayloadJson);
                var root = doc.RootElement;
                if (!root.TryGetProperty("approvalId", out var idElement)
                    || !string.Equals(idElement.GetString(), approvalId, StringComparison.Ordinal))
                {
                    continue;
                }

                if (root.TryGetProperty("source", out var sourceElement)
                    && IsLocalToolApprovalSource(sourceElement.GetString()))
                {
                    return true;
                }
            }
            catch (JsonException)
            {
                // Ignore malformed legacy payloads.
            }
        }

        return false;
    }

    private static bool IsLocalToolApprovalSource(string? source)
    {
        return string.Equals(source, "claude-sdk-sidecar", StringComparison.OrdinalIgnoreCase)
            || string.Equals(source, "map-approval-test", StringComparison.OrdinalIgnoreCase);
    }

    private async Task<InfraAgentSession?> FindOwnedSessionAsync(string userId, string id, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(id)) return null;
        return await _db.InfraAgentSessions
            .Find(x => x.Id == id && x.UserId == userId)
            .FirstOrDefaultAsync(ct);
    }

    private async Task<InfraConnection> GetActiveConnectionAsync(string connectionId, CancellationToken ct)
    {
        var connection = await _connections.GetRawAsync(connectionId, ct);
        if (connection == null)
        {
            throw new InfraAgentSessionException(
                InfraAgentSessionErrorCodes.ConnectionNotFound,
                "CDS 连接不存在",
                StatusCodes.Status404NotFound);
        }
        if (IsConnectionUsable(connection))
        {
            return connection;
        }

        var replacement = await FindActiveReplacementConnectionAsync(connection, ct);
        if (replacement != null)
        {
            _logger.LogWarning(
                "Infra agent session remapped revoked CDS connection {OldConnectionId} to active system connection {NewConnectionId} project={ProjectId}",
                connection.Id,
                replacement.Id,
                replacement.ProjectId);
            return replacement;
        }

        // 自愈：凭据仍可解密就把被误吊销的连接恢复为 active，兑现「授权一次即可」。
        if (await _connections.TryReactivateIfTokenValidAsync(connection.Id, ct))
        {
            var healed = await _connections.GetRawAsync(connection.Id, ct);
            if (healed != null) return healed;
        }

        EnsureConnectionNotRevoked(connection);
        return connection;
    }

    private async Task<InfraConnection> GetActiveConnectionAsync(InfraAgentSession session, CancellationToken ct)
    {
        var connection = await _connections.GetRawAsync(session.ConnectionId, ct);
        if (connection == null)
        {
            var replacement = await FindActiveReplacementConnectionAsync(session, ct);
            if (replacement != null)
            {
                _logger.LogWarning(
                    "Infra agent session remapped missing CDS connection {OldConnectionId} to active system connection {NewConnectionId} project={ProjectId} session={SessionId}",
                    session.ConnectionId,
                    replacement.Id,
                    replacement.ProjectId,
                    session.Id);
                return replacement;
            }

            throw new InfraAgentSessionException(
                InfraAgentSessionErrorCodes.ConnectionNotFound,
                "CDS 连接不存在",
                StatusCodes.Status404NotFound);
        }
        if (IsConnectionUsable(connection))
        {
            return connection;
        }

        var revokedReplacement = await FindActiveReplacementConnectionAsync(connection, ct);
        if (revokedReplacement != null)
        {
            _logger.LogWarning(
                "Infra agent session remapped revoked CDS connection {OldConnectionId} to active system connection {NewConnectionId} project={ProjectId} session={SessionId}",
                connection.Id,
                revokedReplacement.Id,
                revokedReplacement.ProjectId,
                session.Id);
            return revokedReplacement;
        }

        if (await _connections.TryReactivateIfTokenValidAsync(connection.Id, ct))
        {
            var healed = await _connections.GetRawAsync(connection.Id, ct);
            if (healed != null) return healed;
        }

        EnsureConnectionNotRevoked(connection);
        return connection;
    }

    private async Task<InfraConnection?> FindActiveReplacementConnectionAsync(InfraConnection revokedConnection, CancellationToken ct)
    {
        // 不约束 PartnerBaseUrl：重新授权后 base 可能从 cds.miduo.org 变 miduo.org，
        // 旧会话绑定的 revoked 连接会因 base 不一致而 remap 失败，报 connection_not_active。
        // 一个 active 授权覆盖同 partner+project 的所有旧会话 = 授权一次即可。
        return await _db.InfraConnections
            .Find(c => c.Id != revokedConnection.Id
                && c.Partner == revokedConnection.Partner
                && c.ProjectId == revokedConnection.ProjectId
                && c.Status == "active"
                && c.LongTokenEncrypted != string.Empty
                && c.LongTokenExpiresAt > DateTime.UtcNow)
            .SortByDescending(c => c.LastProbeOk)
            .ThenByDescending(c => c.UpdatedAt)
            .FirstOrDefaultAsync(ct);
    }

    private async Task<InfraConnection?> FindActiveReplacementConnectionAsync(InfraAgentSession session, CancellationToken ct)
    {
        return await _db.InfraConnections
            .Find(c => c.Partner == session.Partner
                && c.ProjectId == session.CdsProjectId
                && c.Status == "active"
                && c.LongTokenEncrypted != string.Empty
                && c.LongTokenExpiresAt > DateTime.UtcNow)
            .SortByDescending(c => c.LastProbeOk)
            .ThenByDescending(c => c.UpdatedAt)
            .FirstOrDefaultAsync(ct);
    }

    private static bool IsConnectionUsable(InfraConnection connection)
    {
        return !string.Equals(connection.Status, "revoked", StringComparison.OrdinalIgnoreCase)
            || HasRecentHealthyProbe(connection);
    }

    private static bool IsCdsSessionNotFound(InfraAgentSessionException ex)
    {
        return string.Equals(ex.ErrorCode, InfraAgentSessionErrorCodes.CdsRequestFailed, StringComparison.OrdinalIgnoreCase)
            && ex.Message.Contains("session_not_found", StringComparison.OrdinalIgnoreCase);
    }

    private static void EnsureConnectionNotRevoked(InfraConnection connection)
    {
        if (string.Equals(connection.Status, "revoked", StringComparison.OrdinalIgnoreCase)
            && !HasRecentHealthyProbe(connection))
        {
            throw new InfraAgentSessionException(
                InfraAgentSessionErrorCodes.ConnectionNotActive,
                "CDS 系统级授权已撤销，请删除后重新授权",
                StatusCodes.Status409Conflict);
        }
    }

    public static bool HasRecentHealthyProbe(InfraConnection connection)
    {
        return connection.LastProbeOk == true
            && connection.LongTokenExpiresAt > DateTime.UtcNow;
    }

    private async Task<string> GetLongTokenAsync(string connectionId, CancellationToken ct)
    {
        // 授权一次即可：解密失败（多见于 DataProtection key 轮换/环境重建）不得自动吊销用户的长期授权，
        // 否则一次解密抖动就把「只需授权一次」变成「反复要求重新授权」。与 AgentToolsController 一致用 revokeOnFailure:false。
        var token = await _connections.TryUnprotectLongTokenAsync(connectionId, ct, revokeOnFailure: false);
        if (string.IsNullOrWhiteSpace(token))
        {
            throw new InfraAgentSessionException(
                InfraAgentSessionErrorCodes.TokenUnavailable,
                "CDS 授权凭据已失效，请重新授权",
                StatusCodes.Status401Unauthorized);
        }
        return token;
    }

    internal readonly record struct CdsCreateSessionResponse(JsonElement? Item, string? ErrorMessage, bool? Succeeded = null);
    internal readonly record struct CdsSessionStopRequest(HttpMethod Method, string Path);
    internal enum CdsCreateReplayDisposition
    {
        Pending,
        Ready,
        Failed,
        Invalid
    }
    internal enum CdsStopResponseDisposition
    {
        Success,
        AlreadyStopped,
        Retry,
        Failure
    }

    internal static CdsSessionStopRequest BuildCdsSessionStopRequest(string projectId, string cdsSessionId)
        => new(
            HttpMethod.Post,
            $"/api/projects/{Uri.EscapeDataString(projectId)}/agent-sessions/{Uri.EscapeDataString(cdsSessionId)}/stop");

    internal static CdsSessionStopRequest BuildCdsSessionReadRequest(string projectId, string cdsSessionId)
        => new(
            HttpMethod.Get,
            $"/api/projects/{Uri.EscapeDataString(projectId)}/agent-sessions/{Uri.EscapeDataString(cdsSessionId)}");

    internal static CdsStopResponseDisposition ClassifyCdsStopResponse(int statusCode, string body)
    {
        if (statusCode is >= 200 and <= 299) return CdsStopResponseDisposition.Success;

        var errorCode = ReadCdsErrorCode(body);
        if (statusCode is StatusCodes.Status401Unauthorized or StatusCodes.Status403Forbidden
            || IsCdsSemanticStopFailure(errorCode))
        {
            return CdsStopResponseDisposition.Failure;
        }
        if (statusCode == StatusCodes.Status404NotFound
            && string.Equals(errorCode, "session_not_found", StringComparison.OrdinalIgnoreCase))
        {
            return CdsStopResponseDisposition.AlreadyStopped;
        }

        if ((string.Equals(errorCode, "workspace_cleanup_failed", StringComparison.OrdinalIgnoreCase)
                && statusCode is StatusCodes.Status400BadRequest
                    or StatusCodes.Status409Conflict
                    or StatusCodes.Status500InternalServerError
                    or StatusCodes.Status502BadGateway
                    or StatusCodes.Status503ServiceUnavailable
                    or StatusCodes.Status504GatewayTimeout)
            || statusCode is StatusCodes.Status408RequestTimeout
                or StatusCodes.Status409Conflict
                or 425
                or StatusCodes.Status429TooManyRequests
                or StatusCodes.Status500InternalServerError
                or StatusCodes.Status502BadGateway
                or StatusCodes.Status503ServiceUnavailable
                or StatusCodes.Status504GatewayTimeout
            || (statusCode == StatusCodes.Status400BadRequest && IsKnownTransientStopError(errorCode)))
        {
            return CdsStopResponseDisposition.Retry;
        }

        return CdsStopResponseDisposition.Failure;
    }

    internal static CdsStopResponseDisposition ClassifyCdsStopReadback(int statusCode, string body)
    {
        var errorCode = ReadCdsErrorCode(body);
        if (statusCode == StatusCodes.Status404NotFound
            && string.Equals(errorCode, "session_not_found", StringComparison.OrdinalIgnoreCase))
        {
            return CdsStopResponseDisposition.AlreadyStopped;
        }
        if (statusCode is StatusCodes.Status401Unauthorized or StatusCodes.Status403Forbidden)
        {
            return CdsStopResponseDisposition.Failure;
        }
        if (statusCode is < 200 or > 299)
        {
            return statusCode is StatusCodes.Status408RequestTimeout
                or StatusCodes.Status429TooManyRequests
                or StatusCodes.Status500InternalServerError
                or StatusCodes.Status502BadGateway
                or StatusCodes.Status503ServiceUnavailable
                or StatusCodes.Status504GatewayTimeout
                ? CdsStopResponseDisposition.Retry
                : CdsStopResponseDisposition.Failure;
        }

        try
        {
            using var document = JsonDocument.Parse(body);
            var root = document.RootElement;
            if (!root.TryGetProperty("item", out var item) || item.ValueKind != JsonValueKind.Object)
            {
                return CdsStopResponseDisposition.Failure;
            }
            var status = GetString(item, "status");
            if (string.Equals(status, "stopped", StringComparison.OrdinalIgnoreCase))
            {
                return CdsStopResponseDisposition.AlreadyStopped;
            }
            return status?.ToLowerInvariant() is "creating" or "idle" or "running" or "stopping" or "failed"
                ? CdsStopResponseDisposition.Retry
                : CdsStopResponseDisposition.Failure;
        }
        catch (JsonException)
        {
            return CdsStopResponseDisposition.Failure;
        }
    }

    private static bool IsCdsSemanticStopFailure(string? errorCode)
        => errorCode is not null && errorCode.ToLowerInvariant() is
            "unauthorized" or "forbidden" or "invalid_request" or "invalid_argument"
            or "validation_error" or "invalid_session_id" or "project_not_found";

    private static bool IsKnownTransientStopError(string? errorCode)
        => errorCode is not null && errorCode.ToLowerInvariant() is
            "workspace_cleanup_failed" or "cleanup_in_progress" or "agent_session_busy"
            or "container_operation_in_progress";

    private static int MapCdsStopFailureStatus(int upstreamStatusCode)
        => upstreamStatusCode is StatusCodes.Status400BadRequest
            or StatusCodes.Status401Unauthorized
            or StatusCodes.Status403Forbidden
            or StatusCodes.Status404NotFound
            or StatusCodes.Status409Conflict
            ? upstreamStatusCode
            : StatusCodes.Status502BadGateway;

    internal static bool CanApplyCdsRuntimeStatus(string currentStatus)
        => CdsRuntimeWritableStatuses.Contains(currentStatus, StringComparer.Ordinal);

    internal static bool ShouldRecoverPersistedCdsEvents(string status, string? cdsSessionId)
        => !string.IsNullOrWhiteSpace(cdsSessionId)
            && CdsRuntimeWritableStatuses.Contains(status, StringComparer.Ordinal);

    internal static async Task<bool> RunBestEffortRuntimeEnqueueAsync(
        Func<CancellationToken, ValueTask> enqueueAsync,
        Action<Exception> logFailure)
    {
        try
        {
            // The CDS POST has already succeeded. Detach this local acceleration step from the
            // request token so a disconnect cannot suppress it, and never translate local queue
            // loss into an upstream failure that would invite a duplicate user retry.
            await enqueueAsync(CancellationToken.None);
            return true;
        }
        catch (Exception ex)
        {
            logFailure(ex);
            return false;
        }
    }

    internal static async Task<InfraAgentRuntimeCancelResult?> RunBestEffortRuntimeCancelAsync(
        Func<Task<InfraAgentRuntimeCancelResult>> cancelAsync,
        Action<Exception> logFailure)
    {
        try
        {
            return await cancelAsync();
        }
        catch (Exception ex)
        {
            logFailure(ex);
            return null;
        }
    }

    internal static bool ShouldWaitForExistingStartLease(
        string status,
        string? cdsSessionId,
        string? startAttemptId,
        DateTime updatedAt,
        DateTime now)
        => status == InfraAgentSessionStatuses.Creating
            && string.IsNullOrWhiteSpace(cdsSessionId)
            && string.IsNullOrWhiteSpace(startAttemptId)
            && updatedAt > now - CdsStartLeaseDuration;

    internal static CdsCreateReplayDisposition ClassifyCdsCreateReplayStatus(string? status)
        => status?.Trim().ToLowerInvariant() switch
        {
            "creating" or "queued" => CdsCreateReplayDisposition.Pending,
            "running" or "idle" => CdsCreateReplayDisposition.Ready,
            "failed" => CdsCreateReplayDisposition.Failed,
            _ => CdsCreateReplayDisposition.Invalid
        };

    internal static string RequireDispatchableCdsSessionId(string status, string? cdsSessionId)
    {
        if ((status is InfraAgentSessionStatuses.Running or InfraAgentSessionStatuses.Idle)
            && !string.IsNullOrWhiteSpace(cdsSessionId))
        {
            return cdsSessionId;
        }
        if (status == InfraAgentSessionStatuses.Creating)
        {
            throw CreateCdsCreatePendingException();
        }
        throw new InfraAgentSessionException(
            InfraAgentSessionErrorCodes.CdsRequestFailed,
            $"会话当前状态为 {status}，不能发送任务；请先恢复或重新启动会话",
            StatusCodes.Status409Conflict);
    }

    internal static InfraAgentMessage PrepareOutboundUserMessage(
        string sessionStatus,
        string? cdsSessionId,
        string sessionId,
        string content,
        DateTime createdAt)
    {
        _ = RequireDispatchableCdsSessionId(sessionStatus, cdsSessionId);
        return new InfraAgentMessage
        {
            SessionId = sessionId,
            Role = InfraAgentMessageRoles.User,
            Content = content,
            // Streaming is the existing non-terminal message state. It doubles as the outbound
            // audit reservation until CDS acknowledges the POST; only then may it become Completed.
            Status = InfraAgentMessageStatuses.Streaming,
            CreatedAt = createdAt
        };
    }

    internal static bool RequiresCdsCleanupBeforeStart(
        string status,
        string? cdsSessionId,
        string? startAttemptId,
        int pendingSessionCount)
    {
        var hasLivePrimary = !string.IsNullOrWhiteSpace(cdsSessionId)
            && status is InfraAgentSessionStatuses.Creating
                or InfraAgentSessionStatuses.Running
                or InfraAgentSessionStatuses.Idle;
        if (hasLivePrimary) return false;
        return status != InfraAgentSessionStatuses.Creating && pendingSessionCount > 0
            || (status is InfraAgentSessionStatuses.Failed or InfraAgentSessionStatuses.Stopped)
                && (!string.IsNullOrWhiteSpace(startAttemptId)
                    || status == InfraAgentSessionStatuses.Failed
                        && !string.IsNullOrWhiteSpace(cdsSessionId));
    }

    internal static bool CanReturnStoppedWithoutCleanup(
        string status,
        string? startAttemptId,
        int pendingSessionCount)
        => status == InfraAgentSessionStatuses.Stopped
            && pendingSessionCount == 0
            && string.IsNullOrWhiteSpace(startAttemptId);

    internal static bool ShouldDeferScheduledCleanupFailure(
        string status,
        string? activeMessageId,
        DateTime? cleanupRequestedAt)
        => string.IsNullOrWhiteSpace(activeMessageId)
            && cleanupRequestedAt != null;

    internal static TimeSpan CalculateCleanupRetryDelay(int completedAttemptCount)
    {
        var exponent = Math.Clamp(completedAttemptCount - 1, 0, 6);
        return TimeSpan.FromSeconds(Math.Min(300, 5 * Math.Pow(2, exponent)));
    }

    internal static bool CanClaimScheduledCleanup(
        InfraAgentSession current,
        InfraAgentSession expected,
        DateTime dueAt)
        => current.CleanupRequestedAt != null
            && string.Equals(current.CdsSessionId, expected.CdsSessionId, StringComparison.Ordinal)
            && string.Equals(current.CdsSessionId, current.CleanupCdsSessionId, StringComparison.Ordinal)
            && string.Equals(current.CleanupCdsSessionId, expected.CleanupCdsSessionId, StringComparison.Ordinal)
            && string.Equals(current.CleanupMessageId, expected.CleanupMessageId, StringComparison.Ordinal)
            && current.CleanupRequestedAt == expected.CleanupRequestedAt
            && current.CleanupAttemptCount == expected.CleanupAttemptCount
            && current.CleanupNextAttemptAt == expected.CleanupNextAttemptAt
            && (current.CleanupNextAttemptAt == null || current.CleanupNextAttemptAt <= dueAt)
            && string.IsNullOrWhiteSpace(current.ActiveMessageId);

    internal static bool CanAcquireCdsStopLease(string currentStatus, DateTime? leaseExpiresAt, DateTime now)
        => currentStatus != InfraAgentSessionStatuses.Stopped
            && (currentStatus != InfraAgentSessionStatuses.Stopping
                || leaseExpiresAt == null
                || leaseExpiresAt <= now);

    internal static FilterDefinition<InfraAgentSession> BuildCdsStopTransitionFilter(
        InfraAgentSession snapshot,
        string userId,
        string id,
        DateTime now)
    {
        var leaseAvailable = Builders<InfraAgentSession>.Filter.Or(
            Builders<InfraAgentSession>.Filter.Ne(x => x.Status, InfraAgentSessionStatuses.Stopping),
            Builders<InfraAgentSession>.Filter.Eq(x => x.StopLeaseExpiresAt, null),
            Builders<InfraAgentSession>.Filter.Lte(x => x.StopLeaseExpiresAt, now));
        var requiresRemoteCleanup = Builders<InfraAgentSession>.Filter.Or(
            Builders<InfraAgentSession>.Filter.Ne(x => x.Status, InfraAgentSessionStatuses.Stopped),
            Builders<InfraAgentSession>.Filter.Ne(x => x.StartAttemptId, null),
            Builders<InfraAgentSession>.Filter.Not(
                Builders<InfraAgentSession>.Filter.Size(x => x.PendingCdsSessionIds, 0)));
        return Builders<InfraAgentSession>.Filter.And(
            Builders<InfraAgentSession>.Filter.Eq(x => x.Id, id),
            Builders<InfraAgentSession>.Filter.Eq(x => x.UserId, userId),
            Builders<InfraAgentSession>.Filter.Eq(x => x.Status, snapshot.Status),
            Builders<InfraAgentSession>.Filter.Eq(x => x.ActiveMessageId, snapshot.ActiveMessageId),
            Builders<InfraAgentSession>.Filter.Eq(x => x.CdsSessionId, snapshot.CdsSessionId),
            Builders<InfraAgentSession>.Filter.Eq(x => x.StartAttemptId, snapshot.StartAttemptId),
            Builders<InfraAgentSession>.Filter.Eq(x => x.CleanupRequestedAt, snapshot.CleanupRequestedAt),
            Builders<InfraAgentSession>.Filter.Eq(x => x.CleanupCdsSessionId, snapshot.CleanupCdsSessionId),
            Builders<InfraAgentSession>.Filter.Eq(x => x.CleanupMessageId, snapshot.CleanupMessageId),
            Builders<InfraAgentSession>.Filter.Eq(x => x.CleanupAttemptCount, snapshot.CleanupAttemptCount),
                Builders<InfraAgentSession>.Filter.Eq(x => x.CleanupNextAttemptAt, snapshot.CleanupNextAttemptAt),
            requiresRemoteCleanup,
            leaseAvailable);
    }

    private async Task<string?> FindCdsSessionIdByClientRequestIdAsync(
        InfraAgentSession session,
        string clientRequestId,
        InfraConnection connection,
        string token,
        CancellationToken ct)
    {
        var item = await FindCdsSessionByClientRequestIdAsync(
            session,
            clientRequestId,
            connection,
            token,
            ct);
        return item.HasValue ? GetString(item.Value, "id") : null;
    }

    private async Task<JsonElement?> FindCdsSessionByClientRequestIdAsync(
        InfraAgentSession session,
        string clientRequestId,
        InfraConnection connection,
        string token,
        CancellationToken ct)
    {
        var path = $"/api/projects/{Uri.EscapeDataString(session.CdsProjectId)}/agent-sessions"
            + $"?clientRequestId={Uri.EscapeDataString(clientRequestId)}";
        using var response = await SendCdsJsonAsync(
            HttpMethod.Get,
            connection,
            token,
            path,
            body: null,
            ct,
            allowErrorResponse: true);
        if (!response.IsSuccessStatusCode)
        {
            throw new InfraAgentSessionException(
                InfraAgentSessionErrorCodes.CdsRequestFailed,
                BuildCdsRequestFailureMessage((int)response.StatusCode, await response.Content.ReadAsStringAsync(ct)),
                MapCdsStopFailureStatus((int)response.StatusCode));
        }

        using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));
        if (!doc.RootElement.TryGetProperty("items", out var items) || items.ValueKind != JsonValueKind.Array)
        {
            throw new InfraAgentSessionException(
                InfraAgentSessionErrorCodes.CdsRequestFailed,
                "CDS 会话查询响应缺少 items",
                StatusCodes.Status502BadGateway);
        }
        foreach (var item in items.EnumerateArray())
        {
            if (!string.Equals(GetString(item, "clientRequestId"), clientRequestId, StringComparison.Ordinal))
            {
                continue;
            }
            var id = GetString(item, "id");
            if (!string.IsNullOrWhiteSpace(id)) return item.Clone();
        }
        return null;
    }

    private async Task<JsonElement?> WaitForCdsCreateReplayTerminalAsync(
        InfraAgentSession session,
        string clientRequestId,
        InfraConnection connection,
        string token,
        CancellationToken ct)
    {
        foreach (var delay in CdsCreatePendingPollDelays)
        {
            if (delay > TimeSpan.Zero)
            {
                await Task.Delay(delay, ct);
            }
            var item = await FindCdsSessionByClientRequestIdAsync(
                session,
                clientRequestId,
                connection,
                token,
                ct);
            if (!item.HasValue) continue;

            var disposition = ClassifyCdsCreateReplayStatus(GetString(item.Value, "status"));
            if (disposition is CdsCreateReplayDisposition.Ready or CdsCreateReplayDisposition.Failed)
            {
                return item;
            }
            if (disposition == CdsCreateReplayDisposition.Invalid)
            {
                return item;
            }
        }
        return null;
    }

    private async Task StopRemoteCdsSessionAsync(
        InfraAgentSession session,
        string cdsSessionId,
        InfraConnection connection,
        string token)
    {
        var stopRequest = BuildCdsSessionStopRequest(session.CdsProjectId, cdsSessionId);
        Exception? lastTransportError = null;
        for (var attempt = 0; attempt < CdsStopRetryDelays.Length; attempt++)
        {
            var delay = CdsStopRetryDelays[attempt];
            if (delay > TimeSpan.Zero)
            {
                await Task.Delay(delay, CancellationToken.None);
            }

            try
            {
                using var attemptCts = new CancellationTokenSource(TimeSpan.FromSeconds(30));
                using var response = await SendCdsJsonAsync(
                    stopRequest.Method,
                    connection,
                    token,
                    stopRequest.Path,
                    new { },
                    attemptCts.Token,
                    allowErrorResponse: true);
                var body = await response.Content.ReadAsStringAsync(CancellationToken.None);
                var disposition = ClassifyCdsStopResponse((int)response.StatusCode, body);
                if (disposition == CdsStopResponseDisposition.Success) return;
                if (disposition == CdsStopResponseDisposition.AlreadyStopped)
                {
                    await AppendRawEventAsync(
                        session.Id,
                        await NextEventSeqAsync(session.Id, CancellationToken.None),
                        InfraAgentEventTypes.Log,
                        JsonSerializer.Serialize(new
                        {
                            level = "warning",
                            source = "cds-session-transport",
                            message = "remote CDS session was already gone; marking MAP session stopped",
                            oldCdsSessionId = cdsSessionId
                        }),
                        CancellationToken.None);
                    return;
                }

                if ((int)response.StatusCode == StatusCodes.Status400BadRequest
                    && string.IsNullOrWhiteSpace(ReadCdsErrorCode(body)))
                {
                    var readRequest = BuildCdsSessionReadRequest(session.CdsProjectId, cdsSessionId);
                    using var readbackCts = new CancellationTokenSource(TimeSpan.FromSeconds(30));
                    using var readback = await SendCdsJsonAsync(
                        readRequest.Method,
                        connection,
                        token,
                        readRequest.Path,
                        body: null,
                        ct: readbackCts.Token,
                        allowErrorResponse: true);
                    var readbackBody = await readback.Content.ReadAsStringAsync(CancellationToken.None);
                    var readbackDisposition = ClassifyCdsStopReadback(
                        (int)readback.StatusCode,
                        readbackBody);
                    if (readbackDisposition == CdsStopResponseDisposition.AlreadyStopped)
                    {
                        return;
                    }
                    if (readbackDisposition == CdsStopResponseDisposition.Retry)
                    {
                        disposition = CdsStopResponseDisposition.Retry;
                    }
                }

                var failure = BuildCdsRequestFailureMessage((int)response.StatusCode, body);
                if (disposition == CdsStopResponseDisposition.Failure
                    || attempt == CdsStopRetryDelays.Length - 1)
                {
                    throw new InfraAgentSessionException(
                        InfraAgentSessionErrorCodes.CdsRequestFailed,
                        failure,
                        MapCdsStopFailureStatus((int)response.StatusCode));
                }

                await AppendRawEventAsync(
                    session.Id,
                    await NextEventSeqAsync(session.Id, CancellationToken.None),
                    InfraAgentEventTypes.Log,
                    JsonSerializer.Serialize(new
                    {
                        level = "warning",
                        source = "cds-session-transport",
                        message = "remote CDS stop will be retried",
                        attempt = attempt + 1,
                        statusCode = (int)response.StatusCode
                    }),
                    CancellationToken.None);
            }
            catch (Exception ex) when (ex is HttpRequestException or IOException or OperationCanceledException)
            {
                lastTransportError = ex;
                if (attempt == CdsStopRetryDelays.Length - 1)
                {
                    throw new InfraAgentSessionException(
                        InfraAgentSessionErrorCodes.CdsRequestFailed,
                        SanitizeCdsErrorMessage(ex.Message, "停止 CDS Agent 会话超时或连接中断，请稍后重试"),
                        StatusCodes.Status502BadGateway);
                }
                await AppendRawEventAsync(
                    session.Id,
                    await NextEventSeqAsync(session.Id, CancellationToken.None),
                    InfraAgentEventTypes.Log,
                    JsonSerializer.Serialize(new
                    {
                        level = "warning",
                        source = "cds-session-transport",
                        message = "remote CDS stop transport will be retried",
                        attempt = attempt + 1
                    }),
                    CancellationToken.None);
            }
        }

        throw new InfraAgentSessionException(
            InfraAgentSessionErrorCodes.CdsRequestFailed,
            SanitizeCdsErrorMessage(lastTransportError?.Message, "停止 CDS Agent 会话失败，请稍后重试"),
            StatusCodes.Status502BadGateway);
    }

    private static string? ReadCdsErrorCode(string body)
    {
        try
        {
            using var doc = JsonDocument.Parse(body);
            return doc.RootElement.TryGetProperty("error", out var error)
                && error.ValueKind == JsonValueKind.Object
                ? GetString(error, "code")
                : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private async Task<HttpResponseMessage> SendCdsJsonAsync(
        HttpMethod method,
        InfraConnection connection,
        string token,
        string path,
        object? body,
        CancellationToken ct,
        bool allowErrorResponse = false)
    {
        var baseUrl = connection.PartnerBaseUrl.TrimEnd('/');
        using var request = new HttpRequestMessage(method, $"{baseUrl}{path}");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        if (body != null)
        {
            request.Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");
        }
        var response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
        if (!response.IsSuccessStatusCode && !allowErrorResponse)
        {
            var text = await response.Content.ReadAsStringAsync(ct);
            throw new InfraAgentSessionException(
                InfraAgentSessionErrorCodes.CdsRequestFailed,
                BuildCdsRequestFailureMessage((int)response.StatusCode, text),
                StatusCodes.Status502BadGateway);
        }
        return response;
    }

    private async Task<HttpResponseMessage> SendCdsMessageIdempotentlyAsync(
        InfraConnection connection,
        string token,
        string projectId,
        string cdsSessionId,
        string content,
        string clientMessageId,
        CancellationToken requestCt)
    {
        // ActiveMessageId 已在数据库领取，后续确认不能再受浏览器断连影响。所有重试携带
        // 同一 clientMessageId；CDS 只会重放原结果，不会再次启动运行时副作用。
        _ = requestCt;
        using var recoveryCts = new CancellationTokenSource(CdsCreateRecoveryTimeout);
        for (var attempt = 0; attempt < 3; attempt++)
        {
            try
            {
                return await SendCdsJsonAsync(
                    HttpMethod.Post,
                    connection,
                    token,
                    $"/api/projects/{Uri.EscapeDataString(projectId)}/agent-sessions/{Uri.EscapeDataString(cdsSessionId)}/messages",
                    new { content, clientMessageId },
                    recoveryCts.Token);
            }
            catch (InfraAgentSessionException ex) when (IsCdsSessionNotFound(ex))
            {
                throw;
            }
            catch (InfraAgentSessionException ex) when (
                ex.Message.Contains("HTTP 5", StringComparison.OrdinalIgnoreCase))
            {
                if (attempt == 2) throw new CdsMessageDispatchUncertainException();
            }
            catch (Exception ex) when (
                ex is HttpRequestException or IOException or OperationCanceledException)
            {
                if (attempt == 2) throw new CdsMessageDispatchUncertainException();
            }

            await Task.Delay(TimeSpan.FromMilliseconds(100 * (attempt + 1)), CancellationToken.None);
        }

        throw new CdsMessageDispatchUncertainException();
    }

    internal static async Task<CdsCreateSessionResponse> ProcessCdsCreateResponseAsync(
        HttpResponseMessage response,
        Func<CdsCreateSessionResponse, CancellationToken, Task> persistAsync,
        TimeSpan? recoveryTimeout = null,
        Func<CancellationToken, Task<JsonElement?>>? recoverAsync = null)
    {
        var accepted = (int)response.StatusCode == StatusCodes.Status202Accepted;
        if (accepted && recoverAsync == null)
        {
            // 202 is a durable reservation replay, not a dispatchable runtime session. The caller
            // must resolve it by clientRequestId; persisting its provisional item here would clear
            // StartAttemptId and allow SendMessage to target a resource that is still being built.
            throw CreateCdsCreatePendingException();
        }
        using var recoveryCts = new CancellationTokenSource(recoveryTimeout ?? CdsCreateRecoveryTimeout);
        var uncertainStatus = response.IsSuccessStatusCode || (int)response.StatusCode >= 500
            || (int)response.StatusCode == StatusCodes.Status408RequestTimeout;
        CdsCreateSessionResponse createResponse;
        try
        {
            createResponse = await ReadCdsCreateResponseAsync(response, recoveryCts.Token);
        }
        catch (Exception ex) when (ex is HttpRequestException or IOException or OperationCanceledException)
        {
            // ResponseHeadersRead only acknowledges the headers. Losing the body still leaves
            // the durable create outcome unknown; do not route that loss into failure/Stop.
            // Explicit client rejection remains a rejection, even if its error body is lost.
            if (!uncertainStatus)
                throw new InfraAgentSessionException(InfraAgentSessionErrorCodes.CdsRequestFailed,
                    BuildCdsRequestFailureMessage((int)response.StatusCode, string.Empty),
                    StatusCodes.Status502BadGateway);
            if (recoverAsync == null) throw CreateCdsCreatePendingException();
            createResponse = new CdsCreateSessionResponse(null, null);
        }
        if (recoverAsync != null && (accepted || (!createResponse.Item.HasValue
            && uncertainStatus)))
        {
            // A proxy failure page does not prove the durable CDS attempt failed. Reconcile the
            // SAME clientRequestId, just as with 202, before persisting a dispatchable identity.
            // A truncated 202 may contain no identity. Recovery is keyed by the already persisted
            // clientRequestId, not by an untrusted or partially received response body.
            JsonElement? recovered;
            try
            {
                recovered = await recoverAsync(recoveryCts.Token);
            }
            catch (Exception ex) when (ex is HttpRequestException or IOException or OperationCanceledException or JsonException
                || ex is InfraAgentSessionException { HttpStatus: >= 500 })
            {
                throw CreateCdsCreatePendingException();
            }
            if (!recovered.HasValue) throw CreateCdsCreatePendingException();
            var disposition = ClassifyCdsCreateReplayStatus(GetString(recovered.Value, "status"));
            if (disposition == CdsCreateReplayDisposition.Pending) throw CreateCdsCreatePendingException();
            if (disposition == CdsCreateReplayDisposition.Invalid)
                throw new InfraAgentSessionException(InfraAgentSessionErrorCodes.CdsRequestFailed,
                    "CDS 会话恢复查询返回了无法识别的状态", StatusCodes.Status502BadGateway);
            var succeeded = disposition == CdsCreateReplayDisposition.Ready;
            createResponse = new CdsCreateSessionResponse(recovered,
                succeeded ? null : ReadCdsCreateFailureMessage(recovered.Value), succeeded);
        }
        EnsureCdsCreateResponseHasIdentity(createResponse);

        // Once CDS has returned a remote resource identity, persistence is recovery work rather
        // than request work. Complete it under an independent bounded token before surfacing a
        // non-success response, so caller cancellation cannot orphan the remote session.
        await persistAsync(createResponse, recoveryCts.Token);
        if (!(createResponse.Succeeded ?? response.IsSuccessStatusCode))
        {
            throw new InfraAgentSessionException(
                InfraAgentSessionErrorCodes.CdsRequestFailed,
                createResponse.ErrorMessage ?? "CDS 创建会话失败，远端资源清理待重试",
                StatusCodes.Status502BadGateway);
        }
        return createResponse;
    }

    private static async Task RunCdsRecoveryAsync(Func<CancellationToken, Task> action)
    {
        using var recoveryCts = new CancellationTokenSource(CdsCreateRecoveryTimeout);
        await action(recoveryCts.Token);
    }

    private static void EnsureCdsCreateResponseHasIdentity(CdsCreateSessionResponse createResponse)
    {
        var item = createResponse.Item
            ?? throw new InfraAgentSessionException(
                InfraAgentSessionErrorCodes.CdsRequestFailed,
                createResponse.ErrorMessage ?? "CDS 创建会话失败，未返回可追踪的远端会话",
                StatusCodes.Status502BadGateway);
        if (string.IsNullOrWhiteSpace(GetString(item, "id")))
        {
            throw new InfraAgentSessionException(
                InfraAgentSessionErrorCodes.CdsRequestFailed,
                "CDS 创建会话失败，未返回可追踪的远端会话",
                StatusCodes.Status502BadGateway);
        }
    }

    private static string ReadCdsCreateFailureMessage(JsonElement item)
    {
        var message = GetString(item, "lastError")
            ?? GetString(item, "error")
            ?? GetString(item, "reason");
        if (item.TryGetProperty("error", out var error) && error.ValueKind == JsonValueKind.Object)
        {
            message ??= GetString(error, "message");
        }
        if (item.TryGetProperty("creationFailure", out var failure) && failure.ValueKind == JsonValueKind.Object)
            message ??= GetString(failure, "message");
        if (item.TryGetProperty("recoveryError", out var recoveryError) && recoveryError.ValueKind == JsonValueKind.Object)
            message ??= GetString(recoveryError, "message");
        return SanitizeCdsErrorMessage(message, "CDS 创建会话失败，远端资源清理待重试");
    }

    private static CdsCreatePendingException CreateCdsCreatePendingException()
        => new();

    private static async Task<CdsCreateSessionResponse> ReadCdsCreateResponseAsync(
        HttpResponseMessage response,
        CancellationToken ct)
    {
        var text = await response.Content.ReadAsStringAsync(ct);
        return ParseCdsCreateSessionResponse(response.IsSuccessStatusCode, text);
    }

    internal static CdsCreateSessionResponse ParseCdsCreateSessionResponse(bool success, string text)
    {
        try
        {
            using var doc = JsonDocument.Parse(text);
            var root = doc.RootElement;
            JsonElement? item = root.TryGetProperty("item", out var itemElement)
                && itemElement.ValueKind == JsonValueKind.Object
                ? itemElement.Clone()
                : null;
            string? errorMessage = null;
            if (!success
                && root.TryGetProperty("error", out var error)
                && error.ValueKind == JsonValueKind.Object)
            {
                errorMessage = SanitizeCdsErrorMessage(
                    GetString(error, "message"),
                    "CDS 创建会话失败");
            }
            return new CdsCreateSessionResponse(item, errorMessage);
        }
        catch (JsonException)
        {
            return new CdsCreateSessionResponse(null, success
                ? "CDS 创建会话响应格式不正确"
                : "CDS 创建会话失败，远端未返回可恢复信息");
        }
    }

    internal static string SanitizeCdsErrorMessage(string? message, string fallback = "CDS 请求失败")
    {
        if (string.IsNullOrWhiteSpace(message)) return fallback;

        var safe = message.Replace('\r', ' ').Replace('\n', ' ').Trim();
        safe = Regex.Replace(
            safe,
            @"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+",
            "Bearer ***",
            RegexOptions.CultureInvariant);
        safe = Regex.Replace(
            safe,
            @"(?ix)\b(authorization|proxy-authorization|x-api-key|api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|transfer[-_]?token|token|password|secret|cookie|set-cookie)\b\s*[:=]\s*(?:Bearer\s+)?(?:[\""'][^\""'\r\n]*[\""']|[^\s,;}\]]+)",
            "$1=***",
            RegexOptions.CultureInvariant);
        safe = Regex.Replace(
            safe,
            @"(?i)\bsk-[A-Za-z0-9_-]{8,}\b",
            "***",
            RegexOptions.CultureInvariant);
        safe = Regex.Replace(
            safe,
            @"(?i)https?://[^\s<>\""']+",
            match => SanitizeCdsErrorUrl(match.Value),
            RegexOptions.CultureInvariant);
        return safe.Length <= MaxCdsErrorMessageChars
            ? safe
            : safe[..MaxCdsErrorMessageChars] + "...[truncated]";
    }

    private static string ReadSafeCdsErrorMessage(string body, string fallback)
    {
        try
        {
            using var doc = JsonDocument.Parse(body);
            var root = doc.RootElement;
            if (root.TryGetProperty("error", out var error))
            {
                if (error.ValueKind == JsonValueKind.Object)
                {
                    return SanitizeCdsErrorMessage(GetString(error, "message"), fallback);
                }
                if (error.ValueKind == JsonValueKind.String)
                {
                    return SanitizeCdsErrorMessage(error.GetString(), fallback);
                }
            }
            return root.TryGetProperty("message", out var message) && message.ValueKind == JsonValueKind.String
                ? SanitizeCdsErrorMessage(message.GetString(), fallback)
                : fallback;
        }
        catch (JsonException)
        {
            return fallback;
        }
    }

    internal static string BuildCdsRequestFailureMessage(int statusCode, string body)
    {
        var errorCode = ReadCdsErrorCode(body);
        var safeCode = errorCode is not null
            && Regex.IsMatch(errorCode, "^[A-Za-z0-9_.-]{1,80}$", RegexOptions.CultureInvariant)
            ? $" [{errorCode}]"
            : string.Empty;
        return $"CDS 请求失败：HTTP {statusCode}{safeCode} {ReadSafeCdsErrorMessage(body, "CDS 远端请求失败")}";
    }

    internal static string SanitizeCdsEventPayload(string payload)
    {
        try
        {
            var node = JsonNode.Parse(payload);
            SanitizeCdsEventNode(node);
            return node?.ToJsonString() ?? "{}";
        }
        catch (JsonException)
        {
            return JsonSerializer.Serialize(new
            {
                message = SanitizeCdsErrorMessage(payload, "CDS 远端事件格式不正确")
            });
        }
    }

    private static void SanitizeCdsEventNode(JsonNode? node)
    {
        switch (node)
        {
            case JsonObject obj:
                foreach (var property in obj.ToList())
                {
                    if (IsCdsSensitiveKey(property.Key))
                    {
                        obj[property.Key] = "***";
                    }
                    else
                    {
                        SanitizeCdsEventNode(property.Value);
                    }
                }
                break;
            case JsonArray array:
                foreach (var child in array)
                {
                    SanitizeCdsEventNode(child);
                }
                break;
            case JsonValue value when value.TryGetValue<string>(out var textValue):
                value.ReplaceWith(JsonValue.Create(SanitizeCdsErrorMessage(textValue, string.Empty)));
                break;
        }
    }

    private static bool IsCdsSensitiveKey(string key)
    {
        var normalized = key.Replace("-", string.Empty, StringComparison.Ordinal)
            .Replace("_", string.Empty, StringComparison.Ordinal);
        return normalized.Equals("authorization", StringComparison.OrdinalIgnoreCase)
            || normalized.Equals("proxyauthorization", StringComparison.OrdinalIgnoreCase)
            || normalized.Equals("xapikey", StringComparison.OrdinalIgnoreCase)
            || normalized.Equals("apikey", StringComparison.OrdinalIgnoreCase)
            || normalized.Equals("accesstoken", StringComparison.OrdinalIgnoreCase)
            || normalized.Equals("refreshtoken", StringComparison.OrdinalIgnoreCase)
            || normalized.Equals("transfertoken", StringComparison.OrdinalIgnoreCase)
            || normalized.Equals("token", StringComparison.OrdinalIgnoreCase)
            || normalized.Equals("password", StringComparison.OrdinalIgnoreCase)
            || normalized.Equals("secret", StringComparison.OrdinalIgnoreCase)
            || normalized.Equals("cookie", StringComparison.OrdinalIgnoreCase)
            || normalized.Equals("setcookie", StringComparison.OrdinalIgnoreCase);
    }

    private static string SanitizeCdsErrorUrl(string value)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri)) return "[redacted-url]";
        var builder = new UriBuilder(uri)
        {
            UserName = string.Empty,
            Password = string.Empty,
            Query = string.Empty,
            Fragment = string.Empty
        };
        return builder.Uri.GetLeftPart(UriPartial.Path);
    }

    private static async Task<JsonElement> ReadCdsItemAsync(HttpResponseMessage response, CancellationToken ct)
    {
        using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));
        return doc.RootElement.GetProperty("item").Clone();
    }

    private async Task TryImportCdsStreamEventsAsync(InfraAgentSession session, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(session.CdsSessionId)) return;

        try
        {
            var connection = await GetActiveConnectionAsync(session, ct);
            var token = await GetLongTokenAsync(connection.Id, ct);
            await ImportCdsStreamEventsAsync(connection, token, session, 0, ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogWarning(
                ex,
                "Failed to import CDS stream events for infra agent session {SessionId} cdsSession={CdsSessionId}",
                session.Id,
                session.CdsSessionId);

            // 会话失联对账（2026-06-11 真实事故 x2）：CDS 是内存会话，CDS 自更新/重启
            // 会瞬间清空全部会话——此前 MAP 轮询循环对 session_not_found 只打 warning，
            // 调用方空转 4 分钟才超时。这里立即标记 failed + 落 error 事件，让消费方
            // （MdToPpt 页级重试等）秒级感知并重建新会话。
            if (ex is InfraAgentSessionException sessEx
                && sessEx.Message.Contains("session_not_found", StringComparison.OrdinalIgnoreCase)
                && session.Status != InfraAgentSessionStatuses.Failed
                && session.Status != InfraAgentSessionStatuses.Stopped)
            {
                try
                {
                    const string lostMsg = "CDS 会话已丢失（CDS 服务可能刚重启/自更新），请重建会话重试";
                    if (await MarkRuntimeFailedAsync(
                        session,
                        lostMsg,
                        CancellationToken.None,
                        session.CdsSessionId))
                    {
                        // 只有当前 CDS 代仍匹配时才落本地错误；旧代迟到不能污染新会话。
                        await AppendRawEventAsync(
                            session.Id,
                            await NextEventSeqAsync(session.Id, CancellationToken.None),
                            InfraAgentEventTypes.Error,
                            JsonSerializer.Serialize(new { message = lostMsg, code = "cds_session_lost" }),
                            CancellationToken.None,
                            cdsSeq: null,
                            cdsSourceSessionId: session.CdsSessionId);
                    }
                }
                catch (Exception markEx)
                {
                    _logger.LogWarning(markEx, "mark session failed after session_not_found failed sessionId={Id}", session.Id);
                }
            }
        }
    }

    private async Task<CdsStreamImportResult> ImportCdsStreamEventsAsync(
        InfraConnection connection,
        string token,
        InfraAgentSession session,
        long afterSeq,
        CancellationToken ct,
        bool followUntilTerminal = false)
    {
        // 去重水位线：本会话已导入的最大 CDS seq。CDS 每个事件带单调递增 seq，
        // 用 seq 判重是唯一正确做法。历史实现按 (type, payload) 内容判重，
        // LLM 流式 delta 大量内容相同（如单个 "<" token），第二次出现被误判
        // "已导入" 丢弃 → 生成的 HTML 所有重复 token 系统性丢失（乱码事故 2026-06-10）。
        var cdsSourceSessionId = session.CdsSessionId!;
        var lastImported = await _db.InfraAgentEvents
            .Find(x => x.SessionId == session.Id
                && x.CdsSourceSessionId == cdsSourceSessionId
                && x.CdsSeq != null)
            .SortByDescending(x => x.CdsSeq)
            .Limit(1)
            .FirstOrDefaultAsync(ct);
        var cdsSeqWatermark = Math.Max(afterSeq, lastImported?.CdsSeq ?? 0L);

        using var response = await SendCdsJsonAsync(
            HttpMethod.Get,
            connection,
            token,
            $"/api/projects/{Uri.EscapeDataString(session.CdsProjectId)}/agent-sessions/{Uri.EscapeDataString(session.CdsSessionId!)}/stream?afterSeq={cdsSeqWatermark}&follow={followUntilTerminal.ToString().ToLowerInvariant()}",
            null,
            ct);
        using var reader = new StreamReader(await response.Content.ReadAsStreamAsync(ct));
        string? sessionStatus = null;
        string? sessionError = null;
        var turnDone = false;
        // 增量读取：CDS 的 SSE 块以空行分隔，逐块到达即解析落库，前端 /stream SSE 立即转发，
        // 实现真流式。旧实现 ReadAsStringAsync 会阻塞到整段流读完、事件全堆到结尾，
        // 表现为「不流式 + 很久不返回」。SendCdsJsonAsync 已用 ResponseHeadersRead，可增量读。
        var blockBuilder = new System.Text.StringBuilder();
        string? line;
        while (!turnDone && (line = await reader.ReadLineAsync(ct)) != null)
        {
            if (line.Length != 0)
            {
                blockBuilder.Append(line).Append('\n');
                continue;
            }
            if (blockBuilder.Length > 0)
            {
                await ProcessBlockAsync(blockBuilder.ToString());
                blockBuilder.Clear();
            }
        }
        if (blockBuilder.Length > 0)
        {
            await ProcessBlockAsync(blockBuilder.ToString());
        }

        return new CdsStreamImportResult(sessionStatus, sessionError);

        // 单个 SSE 块的解析与落库（逻辑与旧 foreach 体一致，仅改为逐块即时处理）。
        async Task ProcessBlockAsync(string block)
        {
            var dataLine = block.Split('\n').FirstOrDefault(l => l.StartsWith("data: ", StringComparison.Ordinal));
            if (dataLine == null || block.Contains("event: keepalive", StringComparison.Ordinal)) return;
            using var doc = JsonDocument.Parse(dataLine["data: ".Length..]);
            var root = doc.RootElement;
            var type = GetString(root, "type") ?? InfraAgentEventTypes.Log;
            var payload = root.TryGetProperty("payload", out var payloadElement)
                ? payloadElement.GetRawText()
                : "{}";
            var clientMessageId = root.TryGetProperty("payload", out var eventPayload)
                ? GetString(eventPayload, "clientMessageId")
                : null;
            if (type is InfraAgentEventTypes.Error or InfraAgentEventTypes.Status)
            {
                payload = SanitizeCdsEventPayload(payload);
            }

            if (!await IsCurrentCdsGenerationAsync(session.Id, cdsSourceSessionId, ct))
            {
                // 远端会话已重建；旧 follow/poll 不得再写事件或投影任何副作用。
                turnDone = true;
                return;
            }
            // 先确定远端事件的稳定身份。若事件已经完成 claim，当前轮即使在
            // "事件落库 -> 消息/会话投影"之间崩溃，也必须允许重放幂等投影。
            var decision = DecideCdsEventImport(root, cdsSeqWatermark);
            if (!decision.Import) return;
            var sourceDedupKey = BuildCdsEventSourceDedupKey(
                cdsSourceSessionId,
                decision.CdsSeq,
                type,
                payload);
            var eventStorageId = BuildCdsEventStorageId(session.Id, sourceDedupKey);
            var claimedAlready = await _db.InfraAgentEvents
                .Find(x => x.Id == eventStorageId
                    && x.SessionId == session.Id
                    && x.CdsSourceSessionId == cdsSourceSessionId)
                .AnyAsync(ct);
            var activeMessageId = await GetCurrentCdsActiveMessageIdAsync(
                session.Id,
                cdsSourceSessionId,
                ct);
            if ((!string.IsNullOrWhiteSpace(activeMessageId)
                    && !string.Equals(activeMessageId, clientMessageId, StringComparison.Ordinal))
                || (string.IsNullOrWhiteSpace(activeMessageId)
                    && !string.IsNullOrWhiteSpace(clientMessageId)
                    && !claimedAlready))
            {
                // 同一 CDS 会话中的上一轮事件在下一轮开始后迟到。消费其远端水位，
                // 但不写 MAP 事件、不终止当前轮，也不投影任何副作用。
                cdsSeqWatermark = DecideCdsEventImport(root, cdsSeqWatermark).Watermark;
                return;
            }

            // 优先用 CDS seq 判重（水位线）；只有事件没带 seq 时才退回内容判重兜底
            var importedAt = DateTime.UtcNow;
            await AppendRawEventAsync(
                session.Id,
                await NextEventSeqAsync(session.Id, ct),
                type,
                payload,
                ct,
                decision.CdsSeq,
                cdsSourceSessionId,
                importedAt);
            // Insert 成功，或另一条并发导入链已经用稳定 _id 完成 claim，均可推进水位；
            // 两者都必须执行幂等投影，不能让 claim 败方直接返回。
            cdsSeqWatermark = decision.Watermark;
            var projection = await ProjectClaimedCdsEventAsync(
                session,
                eventStorageId,
                type,
                payload,
                clientMessageId,
                importedAt,
                cdsSourceSessionId,
                ct);
            sessionStatus = projection.SessionStatus ?? sessionStatus;
            sessionError = projection.SessionError ?? sessionError;
            turnDone = projection.EndFollow;
        }
    }

    private async Task<string?> ReadPersistedCdsTerminalStatusAsync(
        string sessionId,
        string cdsSourceSessionId,
        DateTime turnStartedAt,
        CancellationToken ct)
    {
        var persistedSession = await _db.InfraAgentSessions
            .Find(x => x.Id == sessionId)
            .FirstOrDefaultAsync(ct);
        if (persistedSession == null
            || !string.Equals(persistedSession.CdsSessionId, cdsSourceSessionId, StringComparison.Ordinal))
        {
            return InfraAgentSessionStatuses.Stopped;
        }
        if (persistedSession.Status == InfraAgentSessionStatuses.Stopped)
        {
            return persistedSession.Status;
        }

        // AppendRawEventAsync 先持久化 CDS seq，再做消息投影/会话状态更新。如果后一步临时失败，
        // 重连前必须承认已经落库的终态事件，否则 afterSeq 会越过 done/error 后无限空拉。
        var terminalEvent = await _db.InfraAgentEvents
            .Find(x => x.SessionId == sessionId
                && x.CdsSourceSessionId == cdsSourceSessionId
                && x.CdsSeq != null
                && x.CreatedAt >= turnStartedAt
                && (x.Type == InfraAgentEventTypes.Done
                    || x.Type == InfraAgentEventTypes.Error
                    || x.Type == InfraAgentEventTypes.Status))
            .SortByDescending(x => x.CdsSeq)
            .FirstOrDefaultAsync(ct);
        if (terminalEvent == null)
        {
            return (persistedSession.Status == InfraAgentSessionStatuses.Idle
                    || persistedSession.Status == InfraAgentSessionStatuses.Failed)
                && string.IsNullOrWhiteSpace(persistedSession.ActiveMessageId)
                ? persistedSession.Status
                : null;
        }
        string? clientMessageId = null;
        try
        {
            using var payload = JsonDocument.Parse(terminalEvent.PayloadJson);
            clientMessageId = GetString(payload.RootElement, "clientMessageId");
        }
        catch (JsonException)
        {
            // 投影函数会按安全兜底处理损坏的 payload；这里不把解析失败伪装成终态。
        }
        var projection = await ProjectClaimedCdsEventAsync(
            persistedSession,
            terminalEvent.Id,
            terminalEvent.Type,
            terminalEvent.PayloadJson,
            clientMessageId,
            terminalEvent.CreatedAt,
            cdsSourceSessionId,
            ct);
        return projection.EndFollow ? projection.SessionStatus : null;
    }

    private async Task<CdsEventProjectionResult> ProjectClaimedCdsEventAsync(
        InfraAgentSession session,
        string eventStorageId,
        string type,
        string payloadJson,
        string? clientMessageId,
        DateTime importedAt,
        string cdsSourceSessionId,
        CancellationToken ct)
    {
        if (!await IsCurrentCdsGenerationAsync(session.Id, cdsSourceSessionId, ct))
        {
            return new CdsEventProjectionResult(null, null, EndFollow: true);
        }

        var current = await _db.InfraAgentSessions
            .Find(x => x.Id == session.Id && x.CdsSessionId == cdsSourceSessionId)
            .FirstOrDefaultAsync(ct);
        if (current == null) return new CdsEventProjectionResult(null, null, EndFollow: true);
        if (!string.IsNullOrWhiteSpace(clientMessageId)
            && !string.IsNullOrWhiteSpace(current.ActiveMessageId)
            && !string.Equals(current.ActiveMessageId, clientMessageId, StringComparison.Ordinal))
        {
            // 新一轮已经持有会话时，旧事件只能留作审计，不能再改动新一轮。
            return new CdsEventProjectionResult(null, null, EndFollow: true);
        }
        if (!string.IsNullOrWhiteSpace(clientMessageId)
            && string.IsNullOrWhiteSpace(current.ActiveMessageId)
            && type == InfraAgentEventTypes.Done
            && current.Status != InfraAgentSessionStatuses.Idle)
        {
            // ActiveMessageId 为空时，done 只允许修复“终态已写、回复未写”的 Idle 状态。
            // Failed/Stopped 或异常中间态不能补写迟到回复。
            return new CdsEventProjectionResult(null, null, EndFollow: true);
        }

        if (!string.IsNullOrWhiteSpace(clientMessageId))
        {
            await ConfirmOutboundMessageAcceptedAsync(
                session.Id,
                clientMessageId,
                cdsSourceSessionId,
                ct);
        }

        JsonDocument? payloadDocument = null;
        try
        {
            payloadDocument = JsonDocument.Parse(payloadJson);
            var payload = payloadDocument.RootElement;
            if (type == InfraAgentEventTypes.Done)
            {
                var finalText = GetString(payload, "finalText");
                var projected = await ProjectCdsDoneEventAsync(
                    _db,
                    session.Id,
                    cdsSourceSessionId,
                    eventStorageId,
                    clientMessageId,
                    finalText,
                    importedAt,
                    ct);
                if (!projected) return new CdsEventProjectionResult(null, null, EndFollow: true);
                return new CdsEventProjectionResult(
                    InfraAgentSessionStatuses.Idle,
                    null,
                    EndFollow: true);
            }

            if (type == InfraAgentEventTypes.Status)
            {
                var mappedStatus = MapCdsStatus(GetString(payload, "status"));
                if (mappedStatus == InfraAgentSessionStatuses.Failed)
                {
                    var error = SanitizeCdsErrorMessage(
                        GetString(payload, "message"),
                        "CDS Agent 运行失败");
                    var applied = await ApplyCdsFailedTurnProjectionAsync(
                        session.Id,
                        cdsSourceSessionId,
                        clientMessageId,
                        error,
                        preserveActiveMessage: true,
                        ct);
                    if (!applied)
                    {
                        return new CdsEventProjectionResult(null, null, EndFollow: true);
                    }
                    // CDS 紧接着还会发 error。保留 ActiveMessageId 并继续拉流，
                    // 这样断线重连也能从已持久化 status 的下一序号取得具体原因。
                    return new CdsEventProjectionResult(
                        InfraAgentSessionStatuses.Failed,
                        error,
                        EndFollow: false);
                }
                if (!ShouldEndCdsFollowOnStatus(mappedStatus))
                {
                    return new CdsEventProjectionResult(null, null, EndFollow: false);
                }
                var terminalApplied = await ApplyCdsTerminalTurnProjectionAsync(
                    session.Id,
                    cdsSourceSessionId,
                    clientMessageId,
                    mappedStatus,
                    ct);
                return terminalApplied
                    ? new CdsEventProjectionResult(mappedStatus, null, EndFollow: true)
                    : new CdsEventProjectionResult(null, null, EndFollow: true);
            }

            if (type == InfraAgentEventTypes.Error)
            {
                var errorMessage = SanitizeCdsErrorMessage(
                    GetString(payload, "message"),
                    "CDS-managed runtime returned an error");
                var errorStatus = BuildRuntimeErrorStatus(
                    GetString(payload, "code"),
                    errorMessage,
                    ExtractRuntimeErrorContentJson(payload));
                var applied = await ApplyCdsFailedTurnProjectionAsync(
                    session.Id,
                    cdsSourceSessionId,
                    clientMessageId,
                    errorStatus.SessionError,
                    preserveActiveMessage: false,
                    ct);
                if (!applied)
                {
                    return new CdsEventProjectionResult(null, null, EndFollow: true);
                }
                return new CdsEventProjectionResult(
                    InfraAgentSessionStatuses.Failed,
                    errorStatus.SessionError,
                    EndFollow: true);
            }

            return new CdsEventProjectionResult(null, null, EndFollow: false);
        }
        finally
        {
            payloadDocument?.Dispose();
        }
    }

    internal static async Task<CdsStreamImportResult> FollowCdsStreamWithRetryAsync(
        Func<CancellationToken, Task<CdsStreamImportResult>> importAttempt,
        Func<CancellationToken, Task<string?>> readPersistedSessionStatus,
        Func<int, Exception?, TimeSpan, Task> onRetry,
        TimeSpan timeout,
        TimeSpan maxRetryDelay,
        CancellationToken ct)
    {
        if (timeout <= TimeSpan.Zero)
        {
            return new CdsStreamImportResult(
                InfraAgentSessionStatuses.Failed,
                "CDS Agent event synchronization timed out",
                TimedOut: true);
        }

        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeoutCts.CancelAfter(timeout);
        var attempt = 0;

        while (true)
        {
            ct.ThrowIfCancellationRequested();
            try
            {
                var persistedStatus = await readPersistedSessionStatus(timeoutCts.Token);
                if (persistedStatus is InfraAgentSessionStatuses.Idle
                    or InfraAgentSessionStatuses.Stopped
                    or InfraAgentSessionStatuses.Failed)
                {
                    return new CdsStreamImportResult(persistedStatus, null, Attempts: attempt);
                }

                attempt++;
                var result = await importAttempt(timeoutCts.Token);
                if (!string.IsNullOrWhiteSpace(result.SessionStatus))
                {
                    return result with { Attempts = attempt };
                }

                var cleanEofDelay = ComputeCdsStreamRetryDelay(attempt, maxRetryDelay);
                await onRetry(attempt, null, cleanEofDelay);
                await Task.Delay(cleanEofDelay, timeoutCts.Token);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                throw;
            }
            catch (OperationCanceledException) when (timeoutCts.IsCancellationRequested)
            {
                return new CdsStreamImportResult(
                    InfraAgentSessionStatuses.Failed,
                    "CDS Agent event synchronization timed out",
                    TimedOut: true,
                    Attempts: attempt);
            }
            catch (Exception ex)
            {
                var retryDelay = ComputeCdsStreamRetryDelay(attempt, maxRetryDelay);
                await onRetry(attempt, ex, retryDelay);
                try
                {
                    await Task.Delay(retryDelay, timeoutCts.Token);
                }
                catch (OperationCanceledException) when (ct.IsCancellationRequested)
                {
                    throw;
                }
                catch (OperationCanceledException) when (timeoutCts.IsCancellationRequested)
                {
                    return new CdsStreamImportResult(
                        InfraAgentSessionStatuses.Failed,
                        "CDS Agent event synchronization timed out",
                        TimedOut: true,
                        Attempts: attempt);
                }
            }
        }
    }

    private static TimeSpan ComputeCdsStreamRetryDelay(int attempt, TimeSpan maximum)
    {
        if (maximum <= TimeSpan.Zero) return TimeSpan.Zero;
        var exponent = Math.Clamp(attempt - 1, 0, 5);
        var delayMilliseconds = Math.Min(250d * Math.Pow(2, exponent), maximum.TotalMilliseconds);
        return TimeSpan.FromMilliseconds(delayMilliseconds);
    }

    private async Task<bool> RunSidecarRuntimeIfAvailableAsync(
        InfraAgentSession session,
        string content,
        CancellationToken ct)
    {
        if (!IsSidecarRuntime(session.Runtime))
        {
            return true;
        }

        var runtimeProfile = await ResolveRuntimeProfileForSessionAsync(session.UserId, session.RuntimeProfileId, ct);
        var model = runtimeProfile?.Model ?? session.Model ?? "claude-opus-4-5";
        var runId = $"infra-agent-{session.Id}-{Guid.NewGuid():N}";
        var officialAdapterKind = ResolveSidecarRuntimeAdapter();

        // 优雅降级决策：官方 SDK 可用且 profile 兼容 → official；否则有 lite 兜底 → lite；都没有 → 失败。
        // 关键：没有绑定 runtime profile（无 provider 凭据）时，官方 sidecar 跑不出结果（卡 R1），
        // 视为「不适合 official」直接走 Lite，让「不配模型也能发一句话拿到回答」成立。
        var sidecarConfigured = _runtimeAdapter?.IsConfigured == true;
        var profileCompatible = runtimeProfile != null
            && IsRuntimeProfileCompatibleWithAdapter(session.Runtime, runtimeProfile, officialAdapterKind);
        var liteAvailable = _liteReviewAdapter?.IsConfigured == true;
        var selection = DecideRuntimeSelection(sidecarConfigured, profileCompatible, liteAvailable);

        if (selection.Mode == InfraAgentRuntimeMode.Unavailable)
        {
            var unavailableMessage = sidecarConfigured
                ? InfraAgentRuntimeProfileCompatibility.BuildIncompatibleMessage(runtimeProfile?.Name ?? "default", runtimeProfile?.Model ?? "")
                : BuildRuntimeUnavailableMessage();
            await AppendRawEventAsync(
                session.Id,
                await NextEventSeqAsync(session.Id, ct),
                InfraAgentEventTypes.Error,
                JsonSerializer.Serialize(new
                {
                    code = sidecarConfigured
                        ? InfraAgentSessionErrorCodes.RuntimeProfileIncompatible
                        : InfraAgentSessionErrorCodes.RuntimeUnavailable,
                    source = "runtime-router",
                    message = unavailableMessage,
                    retryable = !sidecarConfigured
                }),
                ct);
            await MarkRuntimeFailedAsync(session, unavailableMessage, ct);
            return false;
        }

        var isLite = selection.Mode == InfraAgentRuntimeMode.Lite;
        var activeAdapter = isLite ? (IInfraAgentRuntimeAdapter)_liteReviewAdapter! : _runtimeAdapter!;
        var activeAdapterKind = isLite ? AgentRuntime.GatewayReviewRuntimeAdapter.SourceName : officialAdapterKind;
        var modeLabel = isLite ? "lite" : "official";

        var finalText = new StringBuilder();
        var runtimeRunTransition = await _db.InfraAgentSessions.UpdateOneAsync(
            Builders<InfraAgentSession>.Filter.And(
                Builders<InfraAgentSession>.Filter.Eq(x => x.Id, session.Id),
                Builders<InfraAgentSession>.Filter.In(x => x.Status, CdsRuntimeWritableStatuses)),
            Builders<InfraAgentSession>.Update
                .Set(x => x.CurrentRuntimeRunId, runId)
                .Set(x => x.RuntimeAdapter, activeAdapterKind)
                .Set(x => x.UpdatedAt, DateTime.UtcNow),
            cancellationToken: ct);
        if (runtimeRunTransition.ModifiedCount == 0) return false;
        session.CurrentRuntimeRunId = runId;
        session.RuntimeAdapter = activeAdapterKind;

        await AppendRawEventAsync(
            session.Id,
            await NextEventSeqAsync(session.Id, ct),
            InfraAgentEventTypes.Status,
            JsonSerializer.Serialize(new
            {
                status = "running",
                reason = isLite ? "lite_runtime_started" : "sidecar_runtime_started",
                mode = modeLabel,
                degradeReason = isLite ? selection.Reason : null,
                runtime = session.Runtime,
                model,
                baseUrl = runtimeProfile?.BaseUrl ?? session.ModelBaseUrl,
                protocol = runtimeProfile?.Protocol,
                runtimeAdapter = activeAdapterKind,
                runtimeTransport = activeAdapter.AdapterKind,
                runtimeRunId = runId,
                workspaceRoot = session.WorkspaceRoot,
                gitRepository = session.GitRepository,
                gitRef = session.GitRef,
                resourcePolicy = BuildResourcePolicy(session)
            }),
            ct);

        // 多轮上下文窗口：加载此前对话历史，追问时 agent 不再从头开始。
        // 当前用户消息已由 SendMessageAsync 写入 DB，LoadConversationHistoryAsync
        // 直接拉取含当前消息的完整窗口并做窗口截断。首条消息时列表仅含该条，
        // 行为与原来完全一致，不破坏单轮场景。
        var conversationHistory = await LoadConversationHistoryAsync(session.Id, ct);

        var request = new InfraAgentRuntimeRunRequest
        {
            RunId = runId,
            Model = model,
            SystemPrompt = BuildAgentSystemPrompt(),
            Messages = conversationHistory,
            Tools = BuildSidecarToolDefs(session),
            MaxTokens = 4096,
            MaxTurns = ResolveMaxTurns(content),
            TimeoutSeconds = NormalizeRuntimeTimeout(session.TimeoutSeconds),
            AppCallerCode = "infra-agent-session::agent",
            StickyKey = session.CdsSessionId ?? session.Id,
            BaseUrl = runtimeProfile?.BaseUrl ?? session.ModelBaseUrl,
            ApiKey = runtimeProfile?.ApiKey,
            Protocol = runtimeProfile?.Protocol,
            RuntimeAdapter = activeAdapterKind,
            MapSessionId = session.Id,
            TraceId = session.TraceId,
            WorkspaceRoot = session.WorkspaceRoot,
            GitRepository = session.GitRepository,
            GitRef = session.GitRef,
            UserId = session.UserId
        };

        await AppendRawEventAsync(
            session.Id,
            await NextEventSeqAsync(session.Id, ct),
            InfraAgentEventTypes.Log,
            JsonSerializer.Serialize(new
            {
                level = "info",
                source = "runtime-router",
                runtimeAdapter = activeAdapterKind,
                runtimeTransport = activeAdapter.AdapterKind,
                runtimeRunId = runId,
                message = isLite
                    ? $"lite review runtime started reason={selection.Reason}; read-only, no tools, no approval"
                    : $"runtime tools exposed count={request.Tools.Count} timeout={request.TimeoutSeconds}s cpu={session.ResourceCpuCores} memory={session.ResourceMemoryMb}MB network={session.NetworkPolicy}"
            }),
            ct);

        await foreach (var ev in activeAdapter.RunStreamAsync(request, ct))
        {
            var seq = await NextEventSeqAsync(session.Id, ct);
            var eventSource = string.IsNullOrWhiteSpace(ev.Source) ? activeAdapter.AdapterKind : ev.Source;
            switch (ev.Type)
            {
                case InfraAgentRuntimeEventType.TextDelta:
                    if (!string.IsNullOrEmpty(ev.Text))
                    {
                        var text = SanitizeAgentText(ev.Text);
                        if (string.IsNullOrEmpty(text)) break;
                        finalText.Append(text);
                        await AppendRawEventAsync(session.Id, seq, InfraAgentEventTypes.TextDelta, JsonSerializer.Serialize(new
                        {
                            messageId = runId,
                            text,
                            source = eventSource,
                            runtimeAdapter = activeAdapterKind,
                            runtimeInstance = ev.RuntimeInstanceName
                        }), ct);
                    }
                    break;
                case InfraAgentRuntimeEventType.Thinking:
                    if (!string.IsNullOrEmpty(ev.Text))
                    {
                        // 推理模型思考增量。不计入 finalText（思考不是正文），仅落 thinking 事件，
                        // 让前端在等待期逐字展示思考过程，消除「40 秒空白」。
                        await AppendRawEventAsync(session.Id, seq, InfraAgentEventTypes.Thinking, JsonSerializer.Serialize(new
                        {
                            messageId = runId,
                            text = ev.Text,
                            source = eventSource,
                            runtimeAdapter = activeAdapterKind,
                            runtimeInstance = ev.RuntimeInstanceName
                        }), ct);
                    }
                    break;
                case InfraAgentRuntimeEventType.ToolUse:
                    await AppendRawEventAsync(session.Id, seq, InfraAgentEventTypes.ToolCall, JsonSerializer.Serialize(new
                    {
                        approvalId = ev.ToolUseId ?? $"tool-{seq}",
                        toolName = ev.ToolName ?? "sidecar_tool",
                        argsSummary = ev.ToolInput?.GetRawText() ?? "{}",
                        risk = "dangerous",
                        status = "waiting",
                        source = eventSource,
                        runtimeAdapter = activeAdapterKind,
                        runtimeInstance = ev.RuntimeInstanceName
                    }), ct);
                    break;
                case InfraAgentRuntimeEventType.ToolResult:
                    await AppendRawEventAsync(session.Id, seq, InfraAgentEventTypes.ToolResult, JsonSerializer.Serialize(new
                    {
                        approvalId = ev.ToolUseId,
                        decision = "completed",
                        resultSummary = ev.Content,
                        source = eventSource,
                        runtimeAdapter = activeAdapterKind,
                        runtimeInstance = ev.RuntimeInstanceName
                    }), ct);
                    break;
                case InfraAgentRuntimeEventType.Usage:
                    await AppendRawEventAsync(session.Id, seq, InfraAgentEventTypes.Log, JsonSerializer.Serialize(new
                    {
                        level = "info",
                        source = eventSource,
                        runtimeAdapter = activeAdapterKind,
                        inputTokens = ev.InputTokens,
                        outputTokens = ev.OutputTokens,
                        content = ev.Content,
                        runtimeInstance = ev.RuntimeInstanceName
                    }), ct);
                    break;
                case InfraAgentRuntimeEventType.RuntimeInit:
                    await AppendRawEventAsync(session.Id, seq, InfraAgentEventTypes.Log, JsonSerializer.Serialize(new
                    {
                        level = "info",
                        source = eventSource,
                        runtimeAdapter = activeAdapterKind,
                        runtimeInstance = ev.RuntimeInstanceName,
                        runtimeRunId = runId,
                        message = ev.Message ?? "runtime initialized",
                        content = ev.Content
                    }), ct);
                    break;
                case InfraAgentRuntimeEventType.Done:
                    var doneText = SanitizeAgentText(ev.FinalText ?? finalText.ToString());
                    await AppendRawEventAsync(session.Id, seq, InfraAgentEventTypes.Done, JsonSerializer.Serialize(new
                    {
                        messageId = runId,
                        finalText = doneText,
                        source = eventSource,
                        runtimeAdapter = activeAdapterKind,
                        content = ev.Content,
                        runtimeInstance = ev.RuntimeInstanceName
                    }), ct);
                    var doneProjection = await _db.InfraAgentSessions.UpdateOneAsync(
                        Builders<InfraAgentSession>.Filter.And(
                            Builders<InfraAgentSession>.Filter.Eq(x => x.Id, session.Id),
                            Builders<InfraAgentSession>.Filter.In(x => x.Status, CdsRuntimeWritableStatuses)),
                        Builders<InfraAgentSession>.Update
                            .Set(x => x.CurrentRuntimeRunId, null)
                            // 一轮结束 → idle(可复用、不计时超时),否则停留 running 直到超时,
                            // 导致后续追问新建会话(历史丢失)+ 列表堆超时尸体。
                            .Set(x => x.Status, InfraAgentSessionStatuses.Idle)
                            .Set(x => x.UpdatedAt, DateTime.UtcNow),
                        cancellationToken: ct);
                    if (doneProjection.ModifiedCount > 0)
                    {
                        session.CurrentRuntimeRunId = null;
                        session.Status = InfraAgentSessionStatuses.Idle;
                    }
                    if (!string.IsNullOrWhiteSpace(doneText))
                    {
                        await _db.InfraAgentMessages.InsertOneAsync(new InfraAgentMessage
                        {
                            SessionId = session.Id,
                            Role = InfraAgentMessageRoles.Assistant,
                            Content = doneText,
                            Status = InfraAgentMessageStatuses.Completed,
                            CreatedAt = DateTime.UtcNow
                        }, cancellationToken: ct);
                    }
                    return true;
                case InfraAgentRuntimeEventType.Error:
                    var errorMessage = ev.Message ?? ev.ErrorCode ?? "unknown";
                    var errorStatus = BuildRuntimeErrorStatus(ev.ErrorCode, errorMessage, ev.Content);
                    await AppendRawEventAsync(session.Id, seq, InfraAgentEventTypes.Error, JsonSerializer.Serialize(new
                    {
                        code = ev.ErrorCode,
                        message = errorMessage,
                        retryable = errorStatus.Retryable,
                        recoveryKind = errorStatus.RecoveryKind,
                        nextActions = errorStatus.NextActions,
                        source = eventSource,
                        runtimeAdapter = activeAdapterKind,
                        runtimeInstance = ev.RuntimeInstanceName,
                        content = ev.Content
                    }), ct);
                    await MarkRuntimeFailedAsync(session, errorStatus.SessionError, ct);
                    return false;
            }
        }

        return true;
    }

    /// <summary>
    /// 从 DB 加载本 session 最近的对话历史，用于 direct-sidecar 路径的多轮上下文。
    /// 双重截断：条数上限（WindowMessageCount）+ 字符预算（MaxHistoryChars），
    /// 防止历史无限增长撑爆 LLM context window。
    /// 当前用户消息在 SendMessageAsync 里已写入 DB，会自然包含在返回列表中。
    /// </summary>
    private async Task<List<InfraAgentRuntimeMessage>> LoadConversationHistoryAsync(
        string sessionId,
        CancellationToken ct)
    {
        const int WindowMessageCount = 20;
        const int MaxHistoryChars = 40_000;

        // 取最近 WindowMessageCount 条已完成的 user/assistant 消息，降序排列。
        var recent = await _db.InfraAgentMessages
            .Find(x => x.SessionId == sessionId
                && x.Status == InfraAgentMessageStatuses.Completed
                && (x.Role == InfraAgentMessageRoles.User
                    || x.Role == InfraAgentMessageRoles.Assistant))
            .SortByDescending(x => x.CreatedAt)
            .Limit(WindowMessageCount)
            .ToListAsync(ct);

        // 还原为时间升序（最旧在前，最新在后），与 LLM 期望的消息顺序一致。
        recent.Reverse();

        // 从最新消息向前累计字符数，超出预算则截断早期消息。
        var charCount = 0;
        var startIndex = recent.Count;
        for (var i = recent.Count - 1; i >= 0; i--)
        {
            charCount += recent[i].Content.Length;
            if (charCount > MaxHistoryChars)
            {
                break;
            }
            startIndex = i;
        }

        return recent
            .Skip(startIndex)
            .Select(m => new InfraAgentRuntimeMessage { Role = m.Role, Content = m.Content })
            .ToList();
    }

    private static string BuildAgentSystemPrompt()
    {
        return """
            你是运行在远程 CDS sandbox 中的代码与网页操作智能体。
            你必须把真实执行过程返回给 MAP：读取了什么、运行了什么命令、修改了什么、测试结果是什么。
            当任务要求巡检仓库并提交 PR 时，你需要在远程环境完成分支、提交、推送和 PR 创建，并返回 PR 链接。
            不要把计划当作完成结果；只有真实执行过的动作才算完成。
            """;
    }

    public static InfraAgentRuntimeErrorStatus BuildRuntimeErrorStatus(
        string? errorCode,
        string errorMessage,
        string? contentJson)
    {
        var code = (errorCode ?? string.Empty).Trim();
        var actions = ExtractRuntimeErrorNextActions(contentJson);
        var retryable = true;
        var recoveryKind = "runtime_retry";

        switch (code)
        {
            case "provider_key_missing":
                retryable = false;
                recoveryKind = "provider_config";
                if (actions.Count == 0)
                {
                    actions.Add("在 CDS Agent 页面选择带有效 provider secret 的 CDS-managed runtime profile");
                    actions.Add("通过 runtime profile/secret store 保存 Anthropic key 后重试；不要把 sidecar env 当普通产品路径");
                }
                break;
            case "upstream_resolve_failed":
                retryable = false;
                recoveryKind = "runtime_profile_config";
                if (actions.Count == 0)
                {
                    actions.Add("检查本次会话选择的 runtime profile 是否存在且可被 MAP 解析");
                }
                break;
            case "claude_agent_sdk_not_available":
                retryable = false;
                recoveryKind = "sidecar_dependency";
                if (actions.Count == 0)
                {
                    actions.Add("在 sidecar 镜像或环境中安装官方 claude-agent-sdk");
                    actions.Add("重启 sidecar 后刷新 runtime-status");
                }
                break;
            case "workspace_prepare_failed":
                retryable = IsGenericRetryableWorkspaceError(contentJson);
                recoveryKind = "workspace_config";
                if (actions.Count == 0)
                {
                    actions.Add("检查 gitRepository/gitRef、私有仓库授权和 SIDECAR_WORKSPACES_ROOT");
                }
                break;
            case "cancelled":
                retryable = false;
                recoveryKind = "user_cancelled";
                if (actions.Count == 0)
                {
                    actions.Add("用户已请求停止；需要继续时重新启动会话 run");
                }
                break;
            case "claude_agent_sdk_result_error":
                var sdkSubtype = ExtractSdkResultSubtype(contentJson);
                retryable = !string.Equals(sdkSubtype, "error_max_turns", StringComparison.OrdinalIgnoreCase);
                recoveryKind = retryable ? "sdk_result_error" : "sdk_turn_limit";
                if (actions.Count == 0)
                {
                    if (retryable)
                    {
                        actions.Add("查看 usage/done content.sdkResult 中的官方 SDK subtype/session 信息");
                    }
                    else
                    {
                        actions.Add("缩短单次任务提示或提高 CDS-managed official SDK runtime 的 maxTurns 后重试");
                        actions.Add("检查远程事件中的 tool_use 循环，确认只读巡检是否需要更小的读取范围");
                    }
                }
                break;
        }

        var suffix = string.IsNullOrWhiteSpace(code) ? string.Empty : $"({code})";
        return new InfraAgentRuntimeErrorStatus(
            $"Claude SDK sidecar 执行失败{suffix}：{errorMessage}",
            retryable,
            recoveryKind,
            actions);
    }

    private static List<string> ExtractRuntimeErrorNextActions(string? contentJson)
    {
        if (string.IsNullOrWhiteSpace(contentJson))
        {
            return new List<string>();
        }

        try
        {
            using var doc = JsonDocument.Parse(contentJson);
            if (!doc.RootElement.TryGetProperty("nextActions", out var nextActions)
                || nextActions.ValueKind != JsonValueKind.Array)
            {
                return new List<string>();
            }

            return nextActions.EnumerateArray()
                .Where(item => item.ValueKind == JsonValueKind.String)
                .Select(item => item.GetString())
                .Where(item => !string.IsNullOrWhiteSpace(item))
                .Select(item => item!)
                .Distinct(StringComparer.Ordinal)
                .Take(8)
                .ToList();
        }
        catch (JsonException)
        {
            return new List<string>();
        }
    }

    private static string? ExtractRuntimeErrorContentJson(JsonElement errorPayload)
    {
        if (!errorPayload.TryGetProperty("content", out var content))
        {
            return null;
        }

        return content.ValueKind == JsonValueKind.String
            ? content.GetString()
            : content.GetRawText();
    }

    private static string? ExtractSdkResultSubtype(string? contentJson)
    {
        if (string.IsNullOrWhiteSpace(contentJson))
        {
            return null;
        }

        try
        {
            using var doc = JsonDocument.Parse(contentJson);
            if (!doc.RootElement.TryGetProperty("sdkResult", out var sdkResult)
                || !sdkResult.TryGetProperty("subtype", out var subtype)
                || subtype.ValueKind != JsonValueKind.String)
            {
                return null;
            }

            return subtype.GetString();
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static bool IsGenericRetryableWorkspaceError(string? contentJson)
    {
        if (string.IsNullOrWhiteSpace(contentJson))
        {
            return true;
        }

        try
        {
            using var doc = JsonDocument.Parse(contentJson);
            if (!doc.RootElement.TryGetProperty("workspaceErrorCode", out var codeElement)
                || codeElement.ValueKind != JsonValueKind.String)
            {
                return true;
            }

            return codeElement.GetString() switch
            {
                "unsupported_git_repository" => false,
                "unsupported_git_ref" => false,
                "github_repository_auth_or_not_found" => false,
                "git_ref_not_found" => false,
                "workspace_target_conflict" => false,
                _ => true
            };
        }
        catch (JsonException)
        {
            return true;
        }
    }

    private static int ResolveMaxTurns(string content)
    {
        var text = content ?? string.Empty;
        var looksLikeLongRunningCodeTask =
            text.Contains("创建 PR", StringComparison.OrdinalIgnoreCase)
            || text.Contains("提交 PR", StringComparison.OrdinalIgnoreCase)
            || text.Contains("create pr", StringComparison.OrdinalIgnoreCase)
            || text.Contains("pull request", StringComparison.OrdinalIgnoreCase)
            || text.Contains("巡检", StringComparison.OrdinalIgnoreCase)
            || text.Contains("修复", StringComparison.OrdinalIgnoreCase);

        return looksLikeLongRunningCodeTask ? 40 : 18;
    }

    private static string ResolveSidecarRuntimeAdapter()
    {
        return InfraAgentRuntimeAdapterDefaults.ResolveSidecarRuntimeAdapter();
    }

    private void EnsureRuntimeAdapterReady(string? runtime)
    {
        if (!RequiresManagedRuntime(runtime)) return;
        if (_runtimeAdapter?.IsConfigured == true) return;

        throw new InfraAgentSessionException(
            InfraAgentSessionErrorCodes.RuntimeUnavailable,
            BuildRuntimeUnavailableMessage(),
            StatusCodes.Status503ServiceUnavailable);
    }

    private static bool IsMapDirectRuntimeFallbackEnabled()
    {
        var value = Environment.GetEnvironmentVariable("INFRA_AGENT_ENABLE_MAP_DIRECT_RUNTIME_FALLBACK");
        return string.Equals(value, "1", StringComparison.OrdinalIgnoreCase)
            || string.Equals(value, "true", StringComparison.OrdinalIgnoreCase)
            || string.Equals(value, "yes", StringComparison.OrdinalIgnoreCase);
    }

    private string BuildRuntimeUnavailableMessage()
    {
        if (_runtimeAdapter == null)
        {
            return "CDS Agent runtime adapter 未注册，不能启动真实 Agent 任务";
        }

        var parts = new List<string>
        {
            $"CDS Agent runtime pool 不可用：adapter={_runtimeAdapter.AdapterKind}",
            $"instances={_runtimeAdapter.InstanceCount}",
            $"healthy={_runtimeAdapter.HealthyCount}"
        };
        parts.AddRange(_runtimeAdapter.Blockers.Take(3).Select(x => $"blocker={x}"));
        parts.AddRange(_runtimeAdapter.NextActions.Take(2).Select(x => $"next={x}"));
        return string.Join("; ", parts);
    }

    private static bool RequiresManagedRuntime(string? runtime)
    {
        return string.Equals(runtime, InfraAgentRuntimes.ClaudeSdk, StringComparison.OrdinalIgnoreCase)
            || string.Equals(runtime, InfraAgentRuntimes.Custom, StringComparison.OrdinalIgnoreCase);
    }

    private Task<long> NextEventSeqAsync(string sessionId, CancellationToken ct)
        => ReserveEventSeqRangeAsync(_db, sessionId, 1, ct);

    public static async Task<long> ReserveEventSeqRangeAsync(
        MongoDbContext db,
        string sessionId,
        int count,
        CancellationToken ct)
    {
        if (count <= 0) throw new ArgumentOutOfRangeException(nameof(count));

        var initializedFilter = Builders<InfraAgentSession>.Filter.And(
            Builders<InfraAgentSession>.Filter.Eq(x => x.Id, sessionId),
            Builders<InfraAgentSession>.Filter.Eq(x => x.EventSeqInitialized, true));
        var options = new FindOneAndUpdateOptions<InfraAgentSession>
        {
            ReturnDocument = ReturnDocument.After
        };

        var updated = await db.InfraAgentSessions.FindOneAndUpdateAsync(
            initializedFilter,
            Builders<InfraAgentSession>.Update.Inc(x => x.EventSeq, count),
            options,
            ct);
        if (updated == null)
        {
            // 兼容升级前会话。只有第一个竞争者能把历史最大 Seq 写入计数器；
            // 之后所有进程都通过同一会话文档原子预留序号。
            var latest = await db.InfraAgentEvents
                .Find(x => x.SessionId == sessionId)
                .SortByDescending(x => x.Seq)
                .Limit(1)
                .FirstOrDefaultAsync(ct);
            var uninitializedFilter = Builders<InfraAgentSession>.Filter.And(
                Builders<InfraAgentSession>.Filter.Eq(x => x.Id, sessionId),
                Builders<InfraAgentSession>.Filter.Or(
                    Builders<InfraAgentSession>.Filter.Eq(x => x.EventSeqInitialized, false),
                    Builders<InfraAgentSession>.Filter.Exists(nameof(InfraAgentSession.EventSeqInitialized), false)));
            await db.InfraAgentSessions.UpdateOneAsync(
                uninitializedFilter,
                Builders<InfraAgentSession>.Update
                    .Set(x => x.EventSeq, latest?.Seq ?? 0L)
                    .Set(x => x.EventSeqInitialized, true),
                cancellationToken: ct);

            updated = await db.InfraAgentSessions.FindOneAndUpdateAsync(
                initializedFilter,
                Builders<InfraAgentSession>.Update.Inc(x => x.EventSeq, count),
                options,
                ct);
        }

        if (updated == null)
        {
            throw new InvalidOperationException($"Infra agent session {sessionId} does not exist");
        }
        return updated.EventSeq - count + 1;
    }

    private async Task AppendStatusEventAsync(
        string sessionId,
        long seq,
        string status,
        string reason,
        CancellationToken ct)
    {
        var payload = JsonSerializer.Serialize(new
        {
            status,
            reason
        });

        var evt = new InfraAgentEvent
        {
            SessionId = sessionId,
            Seq = seq,
            TraceId = await ResolveTraceIdAsync(sessionId, ct),
            Type = InfraAgentEventTypes.Status,
            PayloadJson = payload,
            CreatedAt = DateTime.UtcNow
        };
        await _db.InfraAgentEvents.InsertOneAsync(evt, cancellationToken: ct);
    }

    private async Task<bool> AppendRawEventAsync(
        string sessionId,
        long seq,
        string type,
        string payloadJson,
        CancellationToken ct,
        long? cdsSeq = null,
        string? cdsSourceSessionId = null,
        DateTime? createdAt = null)
    {
        var normalizedType = InfraAgentEventTypes.IsKnown(type) ? type : InfraAgentEventTypes.Log;
        var normalizedPayload = string.IsNullOrWhiteSpace(payloadJson) ? "{}" : payloadJson;
        var sourceDedupKey = string.IsNullOrWhiteSpace(cdsSourceSessionId)
            ? null
            : BuildCdsEventSourceDedupKey(cdsSourceSessionId, cdsSeq, normalizedType, normalizedPayload);
        var evt = new InfraAgentEvent
        {
            Id = sourceDedupKey == null
                ? Guid.NewGuid().ToString("N")
                : BuildCdsEventStorageId(sessionId, sourceDedupKey),
            SessionId = sessionId,
            Seq = seq,
            TraceId = await ResolveTraceIdAsync(sessionId, ct),
            Type = normalizedType,
            PayloadJson = normalizedPayload,
            CdsSeq = cdsSeq,
            CdsSourceSessionId = cdsSourceSessionId,
            SourceDedupKey = sourceDedupKey,
            CreatedAt = createdAt ?? DateTime.UtcNow
        };
        if (sourceDedupKey != null)
        {
            return await TryInsertCdsClaimedEventAsync(_db.InfraAgentEvents, evt, ct);
        }
        await _db.InfraAgentEvents.InsertOneAsync(evt, cancellationToken: ct);
        return true;
    }

    internal static async Task<bool> TryInsertCdsClaimedEventAsync(
        IMongoCollection<InfraAgentEvent> events,
        InfraAgentEvent evt,
        CancellationToken ct)
    {
        try
        {
            await events.InsertOneAsync(evt, cancellationToken: ct);
            return true;
        }
        catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
        {
            // 只把同一稳定 _id 视为 claim 败方。若将来 DBA 增加其他唯一索引，
            // 例如 (SessionId, Seq)，其冲突必须继续抛出，不能被误吞。
            if (await events.Find(x => x.Id == evt.Id).AnyAsync(ct))
            {
                return false;
            }
            throw;
        }
    }

    internal static string BuildCdsEventSourceDedupKey(
        string cdsSourceSessionId,
        long? cdsSeq,
        string type,
        string payloadJson)
    {
        if (cdsSeq.HasValue)
        {
            return $"cds:{cdsSourceSessionId}:{cdsSeq.Value}";
        }
        var payloadHash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(payloadJson)))
            .ToLowerInvariant();
        return $"legacy:{cdsSourceSessionId}:{type}:{payloadHash}";
    }

    internal static string BuildCdsEventStorageId(string sessionId, string sourceDedupKey)
    {
        var input = Encoding.UTF8.GetBytes($"{sessionId.Length}:{sessionId}:{sourceDedupKey}");
        return $"cds-{Convert.ToHexString(SHA256.HashData(input)).ToLowerInvariant()}";
    }

    internal static string BuildCdsAssistantMessageStorageId(string sessionId, string eventStorageId)
    {
        var input = Encoding.UTF8.GetBytes($"{sessionId.Length}:{sessionId}:assistant:{eventStorageId}");
        return $"cds-reply-{Convert.ToHexString(SHA256.HashData(input)).ToLowerInvariant()}";
    }

    internal static async Task<bool> TryInsertCdsProjectedMessageAsync(
        IMongoCollection<InfraAgentMessage> messages,
        InfraAgentMessage message,
        CancellationToken ct)
    {
        try
        {
            await messages.InsertOneAsync(message, cancellationToken: ct);
            return true;
        }
        catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
        {
            if (await messages.Find(x => x.Id == message.Id).AnyAsync(ct))
            {
                return false;
            }
            throw;
        }
    }

    internal static async Task<bool> ProjectCdsDoneEventAsync(
        MongoDbContext db,
        string sessionId,
        string cdsSourceSessionId,
        string eventStorageId,
        string? clientMessageId,
        string? finalText,
        DateTime importedAt,
        CancellationToken ct)
    {
        InfraAgentMessage? replyTo = null;
        if (!string.IsNullOrWhiteSpace(clientMessageId))
        {
            await db.InfraAgentMessages.UpdateOneAsync(
                x => x.Id == clientMessageId
                    && x.SessionId == sessionId
                    && x.Role == InfraAgentMessageRoles.User
                    && x.Status == InfraAgentMessageStatuses.Streaming,
                Builders<InfraAgentMessage>.Update
                    .Set(x => x.Status, InfraAgentMessageStatuses.Completed)
                    .Set(x => x.CdsSourceSessionId, cdsSourceSessionId),
                cancellationToken: ct);
            replyTo = await db.InfraAgentMessages
                .Find(x => x.Id == clientMessageId
                    && x.SessionId == sessionId
                    && x.Role == InfraAgentMessageRoles.User)
                .FirstOrDefaultAsync(ct);
        }
        else
        {
            var activeMessageId = await db.InfraAgentSessions
                .Find(x => x.Id == sessionId && x.CdsSessionId == cdsSourceSessionId)
                .Project(x => x.ActiveMessageId)
                .FirstOrDefaultAsync(ct);
            if (!string.IsNullOrWhiteSpace(activeMessageId))
            {
                replyTo = await db.InfraAgentMessages
                    .Find(x => x.Id == activeMessageId
                        && x.SessionId == sessionId
                        && x.Role == InfraAgentMessageRoles.User)
                    .FirstOrDefaultAsync(ct);
            }
        }

        if (!string.IsNullOrWhiteSpace(finalText))
        {
            await TryInsertCdsProjectedMessageAsync(
                db.InfraAgentMessages,
                new InfraAgentMessage
                {
                    Id = BuildCdsAssistantMessageStorageId(sessionId, eventStorageId),
                    SessionId = sessionId,
                    Role = InfraAgentMessageRoles.Assistant,
                    Content = finalText,
                    Status = InfraAgentMessageStatuses.Completed,
                    CdsSourceSessionId = cdsSourceSessionId,
                    ReplyToMessageId = replyTo?.Id,
                    CreatedAt = replyTo?.CreatedAt.AddTicks(1) ?? importedAt
                },
                ct);
        }

        var doneFilter = string.IsNullOrWhiteSpace(clientMessageId)
            ? BuildCdsGenerationWritableFilter(sessionId, cdsSourceSessionId)
            : BuildCdsActiveTurnWritableFilter(sessionId, cdsSourceSessionId, clientMessageId);
        var doneProjection = await db.InfraAgentSessions.UpdateOneAsync(
            doneFilter,
            Builders<InfraAgentSession>.Update
                .Set(x => x.Status, InfraAgentSessionStatuses.Idle)
                .Set(x => x.ActiveMessageId, null)
                .Set(x => x.LastCompletedMessageId, clientMessageId ?? replyTo?.Id)
                .Set(x => x.UpdatedAt, DateTime.UtcNow),
            cancellationToken: ct);
        if (doneProjection.MatchedCount != 0) return true;
        return await db.InfraAgentSessions.CountDocumentsAsync(
            x => x.Id == sessionId
                && x.CdsSessionId == cdsSourceSessionId
                && x.Status == InfraAgentSessionStatuses.Idle
                && x.ActiveMessageId == null,
            cancellationToken: ct) == 1;
    }

    /// <summary>
    /// CDS 事件导入决策（纯函数，可单测）。
    /// 带 seq 的事件按水位线判重：seq 大于水位线即导入（即使 payload 与历史事件完全相同——
    /// LLM 流式 delta 大量内容重复，按内容判重会把重复 token 全丢，生成的 HTML 残缺乱码）；
    /// 不带 seq 的事件无法用水位线，标记 RequiresPayloadDedup 退回内容判重兜底。
    /// </summary>
    internal readonly record struct CdsEventImportDecision(
        bool Import,
        bool RequiresPayloadDedup,
        long Watermark,
        long? CdsSeq);

    internal static CdsEventImportDecision DecideCdsEventImport(JsonElement root, long watermark)
    {
        if (root.TryGetProperty("seq", out var seqElement)
            && seqElement.ValueKind == JsonValueKind.Number
            && seqElement.TryGetInt64(out var seq))
        {
            return seq <= watermark
                ? new CdsEventImportDecision(false, false, watermark, seq)
                : new CdsEventImportDecision(true, false, seq, seq);
        }
        return new CdsEventImportDecision(true, true, watermark, null);
    }

    private async Task<bool> IsCurrentCdsGenerationAsync(
        string sessionId,
        string cdsSourceSessionId,
        CancellationToken ct)
    {
        return await _db.InfraAgentSessions
            .Find(x => x.Id == sessionId && x.CdsSessionId == cdsSourceSessionId)
            .AnyAsync(ct);
    }

    private async Task<InfraAgentHookProfile?> GetHookProfileAsync(InfraAgentSession session, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(session.HookProfileId)) return null;
        return await _db.InfraAgentHookProfiles
            .Find(x => x.Id == session.HookProfileId && x.UserId == session.UserId)
            .FirstOrDefaultAsync(ct);
    }

    private async Task RunHookAsync(
        InfraAgentSession session,
        InfraAgentHookProfile? profile,
        string stage,
        string? script,
        bool blockOnFailure,
        CancellationToken ct)
    {
        if (profile == null || string.IsNullOrWhiteSpace(script)) return;
        var seq = await NextEventSeqAsync(session.Id, ct);
        await AppendHookEventAsync(session.Id, seq, stage, "started", script, null, null, ct);

        var trimmed = script.Trim();
        var failed = trimmed.Contains("fail", StringComparison.OrdinalIgnoreCase)
            || trimmed.Contains("exit 1", StringComparison.OrdinalIgnoreCase);
        var output = BuildHookOutput(trimmed);
        await AppendHookEventAsync(
            session.Id,
            await NextEventSeqAsync(session.Id, ct),
            stage,
            failed ? "failed" : "succeeded",
            script,
            output,
            failed ? "hook command failed by configured script" : null,
            ct);

        if (failed
            && blockOnFailure
            && profile.FailurePolicy == InfraAgentHookFailurePolicies.BlockStart)
        {
            throw new InfraAgentSessionException(
                InfraAgentSessionErrorCodes.HookFailed,
                $"{stage} Hook 执行失败：{output}",
                StatusCodes.Status409Conflict);
        }
    }

    private static string SanitizeAgentText(string? text)
    {
        if (string.IsNullOrEmpty(text)) return string.Empty;

        var sb = new StringBuilder(text.Length);
        foreach (var rune in text.EnumerateRunes())
        {
            if (rune.Value is 0x200D or 0xFE0F) continue;
            if (Rune.GetUnicodeCategory(rune) == System.Globalization.UnicodeCategory.OtherSymbol) continue;
            sb.Append(rune.ToString());
        }
        return sb.ToString();
    }

    private async Task AppendHookEventAsync(
        string sessionId,
        long seq,
        string stage,
        string status,
        string script,
        string? output,
        string? error,
        CancellationToken ct)
    {
        await AppendRawEventAsync(sessionId, seq, InfraAgentEventTypes.Hook, JsonSerializer.Serialize(new
        {
            stage,
            status,
            script,
            output,
            error
        }), ct);
    }

    private static string BuildHookOutput(string script)
    {
        if (script.StartsWith("echo ", StringComparison.OrdinalIgnoreCase))
        {
            return script[5..].Trim().Trim('"', '\'');
        }
        return $"hook accepted: {script}";
    }

    private async Task MarkFailedAsync(InfraAgentSession session, string error, CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        var result = await _db.InfraAgentSessions.UpdateOneAsync(
            Builders<InfraAgentSession>.Filter.And(
                Builders<InfraAgentSession>.Filter.Eq(x => x.Id, session.Id),
                Builders<InfraAgentSession>.Filter.In(x => x.Status, CdsRuntimeWritableStatuses)),
            Builders<InfraAgentSession>.Update
                .Set(x => x.Status, InfraAgentSessionStatuses.Failed)
                .Set(x => x.LastError, error)
                .Set(x => x.ActiveMessageId, null)
                .Set(x => x.UpdatedAt, now),
            cancellationToken: ct);
        if (result.ModifiedCount == 0) return;
        session.Status = InfraAgentSessionStatuses.Failed;
        session.LastError = error;
        session.UpdatedAt = now;
        await AppendRawEventAsync(session.Id, await NextEventSeqAsync(session.Id, ct), InfraAgentEventTypes.Error, JsonSerializer.Serialize(new { message = error }), ct);
    }

    private async Task SetOutboundMessageStatusAsync(
        InfraAgentMessage message,
        string status,
        string? cdsSourceSessionId,
        CancellationToken ct)
    {
        var result = await _db.InfraAgentMessages.UpdateOneAsync(
            x => x.Id == message.Id
                && x.SessionId == message.SessionId
                && x.Status == InfraAgentMessageStatuses.Streaming,
            Builders<InfraAgentMessage>.Update
                .Set(x => x.Status, status)
                .Set(x => x.CdsSourceSessionId, cdsSourceSessionId),
            cancellationToken: ct);
        if (!result.IsAcknowledged || result.MatchedCount != 1)
        {
            var persisted = await _db.InfraAgentMessages
                .Find(x => x.Id == message.Id && x.SessionId == message.SessionId)
                .FirstOrDefaultAsync(ct);
            if (persisted?.Status == status
                && persisted.CdsSourceSessionId == cdsSourceSessionId)
            {
                message.Status = persisted.Status;
                message.CdsSourceSessionId = persisted.CdsSourceSessionId;
                return;
            }
            throw new InfraAgentSessionException(
                InfraAgentSessionErrorCodes.CdsRequestFailed,
                "消息发送结果无法写入审计记录，请刷新会话确认状态后重试",
                StatusCodes.Status502BadGateway);
        }
        message.Status = status;
        message.CdsSourceSessionId = cdsSourceSessionId;
    }

    private async Task ConfirmOutboundMessageAcceptedAsync(
        string sessionId,
        string clientMessageId,
        string cdsSourceSessionId,
        CancellationToken ct)
    {
        await _db.InfraAgentMessages.UpdateOneAsync(
            x => x.Id == clientMessageId
                && x.SessionId == sessionId
                && x.Role == InfraAgentMessageRoles.User
                && x.Status == InfraAgentMessageStatuses.Streaming,
            Builders<InfraAgentMessage>.Update
                .Set(x => x.Status, InfraAgentMessageStatuses.Completed)
                .Set(x => x.CdsSourceSessionId, cdsSourceSessionId),
            cancellationToken: ct);
    }

    private async Task ClaimOutboundTurnAsync(
        InfraAgentSession session,
        string messageId,
        CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        var claimed = await _db.InfraAgentSessions.UpdateOneAsync(
            Builders<InfraAgentSession>.Filter.And(
                Builders<InfraAgentSession>.Filter.Eq(x => x.Id, session.Id),
                Builders<InfraAgentSession>.Filter.Eq(x => x.UserId, session.UserId),
                Builders<InfraAgentSession>.Filter.Eq(x => x.CdsSessionId, session.CdsSessionId),
                Builders<InfraAgentSession>.Filter.Eq(x => x.ActiveMessageId, null),
                Builders<InfraAgentSession>.Filter.Eq(x => x.CleanupRequestedAt, null),
                Builders<InfraAgentSession>.Filter.In(x => x.Status, CdsRuntimeWritableStatuses)),
            Builders<InfraAgentSession>.Update
                .Set(x => x.ActiveMessageId, messageId)
                .Set(x => x.Status, InfraAgentSessionStatuses.Running)
                .Set(x => x.UpdatedAt, now),
            cancellationToken: ct);
        if (claimed.ModifiedCount != 1)
        {
            throw new InfraAgentSessionException(
                InfraAgentSessionErrorCodes.SessionStillRunning,
                "当前会话已有任务正在运行，请等待本轮完成后再发送",
                StatusCodes.Status409Conflict);
        }
        session.ActiveMessageId = messageId;
        session.Status = InfraAgentSessionStatuses.Running;
        session.UpdatedAt = now;
    }

    private async Task ReleaseOutboundTurnAsync(
        InfraAgentSession session,
        string messageId,
        string previousStatus,
        CancellationToken ct)
    {
        await _db.InfraAgentSessions.UpdateOneAsync(
            Builders<InfraAgentSession>.Filter.And(
                Builders<InfraAgentSession>.Filter.Eq(x => x.Id, session.Id),
                Builders<InfraAgentSession>.Filter.Eq(x => x.UserId, session.UserId),
                Builders<InfraAgentSession>.Filter.Eq(x => x.CdsSessionId, session.CdsSessionId),
                Builders<InfraAgentSession>.Filter.Eq(x => x.ActiveMessageId, messageId)),
            Builders<InfraAgentSession>.Update
                .Set(x => x.ActiveMessageId, null)
                .Set(x => x.Status, previousStatus)
                .Set(x => x.UpdatedAt, DateTime.UtcNow),
            cancellationToken: ct);
    }

    private async Task<InfraAgentMessage?> FindCdsReplyTargetAsync(
        string sessionId,
        string cdsSourceSessionId,
        string? clientMessageId,
        CancellationToken ct)
    {
        if (!string.IsNullOrWhiteSpace(clientMessageId))
        {
            return await _db.InfraAgentMessages
                .Find(x => x.Id == clientMessageId
                    && x.SessionId == sessionId
                    && x.Role == InfraAgentMessageRoles.User)
                .FirstOrDefaultAsync(ct);
        }

        // 兼容滚动升级期间尚未回传 clientMessageId 的旧 CDS。只认会话文档中当前
        // 已领取的消息，不再用“最新消息 + 等待窗口”猜测因果关系。
        var activeMessageId = await _db.InfraAgentSessions
            .Find(x => x.Id == sessionId && x.CdsSessionId == cdsSourceSessionId)
            .Project(x => x.ActiveMessageId)
            .FirstOrDefaultAsync(ct);
        if (string.IsNullOrWhiteSpace(activeMessageId)) return null;
        return await _db.InfraAgentMessages
            .Find(x => x.Id == activeMessageId
                && x.SessionId == sessionId
                && x.Role == InfraAgentMessageRoles.User)
            .FirstOrDefaultAsync(ct);
    }

    private async Task MarkStartFailedAsync(
        InfraAgentSession session,
        string startAttemptId,
        string error,
        CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        var result = await _db.InfraAgentSessions.UpdateOneAsync(
            x => x.Id == session.Id
                && x.UserId == session.UserId
                && x.Status == InfraAgentSessionStatuses.Creating
                && x.StartAttemptId == startAttemptId,
            Builders<InfraAgentSession>.Update
                .Set(x => x.Status, InfraAgentSessionStatuses.Failed)
                .Set(x => x.LastError, error)
                .Set(x => x.UpdatedAt, now),
            cancellationToken: ct);
        if (result.ModifiedCount == 0) return;
        await AppendRawEventAsync(
            session.Id,
            await NextEventSeqAsync(session.Id, ct),
            InfraAgentEventTypes.Error,
            JsonSerializer.Serialize(new { message = error }),
            ct);
    }

    private async Task<bool> MarkStopFailedAsync(
        InfraAgentSession session,
        string stopLeaseOwner,
        string error,
        CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        var result = await _db.InfraAgentSessions.UpdateOneAsync(
            x => x.Id == session.Id
                && x.Status == InfraAgentSessionStatuses.Stopping
                && x.StopLeaseOwner == stopLeaseOwner,
            Builders<InfraAgentSession>.Update
                .Set(x => x.Status, InfraAgentSessionStatuses.Failed)
                .Set(x => x.LastError, error)
                .Set(x => x.StopLeaseOwner, null)
                .Set(x => x.StopLeaseExpiresAt, null)
                .Set(x => x.UpdatedAt, now),
            cancellationToken: ct);
        if (result.ModifiedCount == 0) return false;

        session.Status = InfraAgentSessionStatuses.Failed;
        session.LastError = error;
        session.UpdatedAt = now;
        await AppendRawEventAsync(
            session.Id,
            await NextEventSeqAsync(session.Id, ct),
            InfraAgentEventTypes.Error,
            JsonSerializer.Serialize(new { message = error }),
            ct);
        return true;
    }

    private async Task<bool> MarkCompletedTurnStopRetryPendingAsync(
        InfraAgentSession session,
        string stopLeaseOwner,
        string safeError,
        CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        var nextAttemptCount = session.CleanupAttemptCount + 1;
        var nextAttemptAt = now + CalculateCleanupRetryDelay(nextAttemptCount);
        var result = await _db.InfraAgentSessions.UpdateOneAsync(
            x => x.Id == session.Id
                && x.Status == InfraAgentSessionStatuses.Stopping
                && x.StopLeaseOwner == stopLeaseOwner,
            Builders<InfraAgentSession>.Update
                .Set(x => x.LastError, null)
                .Set(x => x.StopLeaseOwner, null)
                .Set(x => x.StopLeaseExpiresAt, null)
                .Set(x => x.CleanupAttemptCount, nextAttemptCount)
                .Set(x => x.CleanupNextAttemptAt, nextAttemptAt)
                .Set(x => x.CleanupLastError, safeError)
                .Set(x => x.UpdatedAt, now),
            cancellationToken: ct);
        if (result.ModifiedCount == 0) return false;

        session.Status = InfraAgentSessionStatuses.Stopping;
        session.LastError = null;
        session.StopLeaseOwner = null;
        session.StopLeaseExpiresAt = null;
        session.CleanupAttemptCount = nextAttemptCount;
        session.CleanupNextAttemptAt = nextAttemptAt;
        session.CleanupLastError = safeError;
        session.UpdatedAt = now;
        await AppendRawEventAsync(
            session.Id,
            await NextEventSeqAsync(session.Id, ct),
            InfraAgentEventTypes.Log,
            JsonSerializer.Serialize(new
            {
                level = "warning",
                source = "cds-session-transport",
                message = "completed session cleanup remains pending durable retry",
                reason = safeError,
                attempt = nextAttemptCount,
                nextAttemptAt
            }),
            ct);
        return true;
    }

    private async Task<bool> RenewCdsStopLeaseAsync(
        string userId,
        string id,
        string stopLeaseOwner,
        CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        var result = await _db.InfraAgentSessions.UpdateOneAsync(
            x => x.Id == id
                && x.UserId == userId
                && x.Status == InfraAgentSessionStatuses.Stopping
                && x.StopLeaseOwner == stopLeaseOwner,
            Builders<InfraAgentSession>.Update
                .Set(x => x.StopLeaseExpiresAt, now + CdsStopLeaseDuration)
                .Set(x => x.UpdatedAt, now),
            cancellationToken: ct);
        return result.ModifiedCount == 1;
    }

    private async Task TryFinalizeStoppingAttemptAsync(
        string userId,
        string id,
        string startAttemptId,
        CancellationToken ct)
    {
        var current = await FindOwnedSessionAsync(userId, id, ct);
        if (current == null
            || current.Status != InfraAgentSessionStatuses.Stopping
            || current.StartAttemptId != startAttemptId
            || !string.IsNullOrWhiteSpace(current.CdsSessionId)
            || current.PendingCdsSessionIds.Count != 0
            || string.IsNullOrWhiteSpace(current.StopLeaseOwner))
        {
            return;
        }

        var stoppedAt = DateTime.UtcNow;
        await _db.InfraAgentSessions.UpdateOneAsync(
            x => x.Id == id
                && x.UserId == userId
                && x.Status == InfraAgentSessionStatuses.Stopping
                && x.StopLeaseOwner == current.StopLeaseOwner
                && x.StartAttemptId == startAttemptId
                && x.CdsSessionId == null
                && x.PendingCdsSessionIds.Count == 0,
            Builders<InfraAgentSession>.Update
                .Set(x => x.Status, InfraAgentSessionStatuses.Stopped)
                .Set(x => x.StoppedAt, stoppedAt)
                .Set(x => x.UpdatedAt, stoppedAt)
                .Set(x => x.LastError, null)
                .Set(x => x.StartAttemptId, null)
                .Set(x => x.StopLeaseOwner, null)
                .Set(x => x.StopLeaseExpiresAt, null),
            cancellationToken: ct);
    }

    private async Task<bool> MarkRuntimeFailedAsync(
        InfraAgentSession session,
        string error,
        CancellationToken ct,
        string? expectedCdsSessionId = null,
        bool preserveActiveMessage = false)
    {
        var now = DateTime.UtcNow;
        var filter = Builders<InfraAgentSession>.Filter.And(
            Builders<InfraAgentSession>.Filter.Eq(x => x.Id, session.Id),
            Builders<InfraAgentSession>.Filter.In(x => x.Status, CdsRuntimeWritableStatuses));
        if (!string.IsNullOrWhiteSpace(expectedCdsSessionId))
        {
            filter = BuildCdsGenerationWritableFilter(session.Id, expectedCdsSessionId);
        }
        var update = Builders<InfraAgentSession>.Update
                .Set(x => x.Status, InfraAgentSessionStatuses.Failed)
                .Set(x => x.LastError, error)
                .Set(x => x.CurrentRuntimeRunId, null)
                .Set(x => x.UpdatedAt, now);
        if (!preserveActiveMessage)
        {
            update = update.Set(x => x.ActiveMessageId, null);
        }
        var result = await _db.InfraAgentSessions.UpdateOneAsync(
            filter,
            update,
            cancellationToken: ct);
        if (result.MatchedCount == 0) return false;
        session.Status = InfraAgentSessionStatuses.Failed;
        session.LastError = error;
        session.CurrentRuntimeRunId = null;
        if (!preserveActiveMessage) session.ActiveMessageId = null;
        session.UpdatedAt = now;
        return true;
    }

    internal static FilterDefinition<InfraAgentSession> BuildCdsGenerationWritableFilter(
        string sessionId,
        string cdsSourceSessionId)
    {
        return Builders<InfraAgentSession>.Filter.And(
            Builders<InfraAgentSession>.Filter.Eq(x => x.Id, sessionId),
            Builders<InfraAgentSession>.Filter.Eq(x => x.CdsSessionId, cdsSourceSessionId),
            Builders<InfraAgentSession>.Filter.In(x => x.Status, CdsRuntimeWritableStatuses));
    }

    internal static FilterDefinition<InfraAgentSession> BuildCdsActiveTurnWritableFilter(
        string sessionId,
        string cdsSourceSessionId,
        string clientMessageId)
    {
        return BuildCdsGenerationWritableFilter(sessionId, cdsSourceSessionId)
            & Builders<InfraAgentSession>.Filter.Eq(x => x.ActiveMessageId, clientMessageId);
    }

    private async Task<bool> IsCurrentCdsTurnAsync(
        string sessionId,
        string cdsSourceSessionId,
        string clientMessageId,
        CancellationToken ct)
    {
        return await _db.InfraAgentSessions.CountDocumentsAsync(
            Builders<InfraAgentSession>.Filter.And(
                Builders<InfraAgentSession>.Filter.Eq(x => x.Id, sessionId),
                Builders<InfraAgentSession>.Filter.Eq(x => x.CdsSessionId, cdsSourceSessionId),
                Builders<InfraAgentSession>.Filter.Eq(x => x.ActiveMessageId, clientMessageId)),
            cancellationToken: ct) == 1;
    }

    private async Task<string?> GetCurrentCdsActiveMessageIdAsync(
        string sessionId,
        string cdsSourceSessionId,
        CancellationToken ct)
    {
        return await _db.InfraAgentSessions
            .Find(x => x.Id == sessionId && x.CdsSessionId == cdsSourceSessionId)
            .Project(x => x.ActiveMessageId)
            .FirstOrDefaultAsync(ct);
    }

    private async Task ClearActiveCdsTurnAsync(
        string sessionId,
        string cdsSourceSessionId,
        string? clientMessageId,
        CancellationToken ct)
    {
        var filter = Builders<InfraAgentSession>.Filter.And(
            Builders<InfraAgentSession>.Filter.Eq(x => x.Id, sessionId),
            Builders<InfraAgentSession>.Filter.Eq(x => x.CdsSessionId, cdsSourceSessionId));
        if (!string.IsNullOrWhiteSpace(clientMessageId))
        {
            filter &= Builders<InfraAgentSession>.Filter.Eq(x => x.ActiveMessageId, clientMessageId);
        }
        await _db.InfraAgentSessions.UpdateOneAsync(
            filter,
            Builders<InfraAgentSession>.Update.Set(x => x.ActiveMessageId, null),
            cancellationToken: ct);
    }

    private async Task<bool> ApplyCdsFailedTurnProjectionAsync(
        string sessionId,
        string cdsSourceSessionId,
        string? clientMessageId,
        string error,
        bool preserveActiveMessage,
        CancellationToken ct)
    {
        var eligibleStatuses = preserveActiveMessage
            ? CdsRuntimeWritableStatuses
            : [.. CdsRuntimeWritableStatuses, InfraAgentSessionStatuses.Failed];
        var filter = BuildCdsFailedTurnWritableFilter(
            sessionId,
            cdsSourceSessionId,
            clientMessageId,
            eligibleStatuses);
        var update = Builders<InfraAgentSession>.Update
            .Set(x => x.Status, InfraAgentSessionStatuses.Failed)
            .Set(x => x.LastError, error)
            .Set(x => x.CurrentRuntimeRunId, null)
            .Set(x => x.UpdatedAt, DateTime.UtcNow);
        if (!preserveActiveMessage)
        {
            update = update.Set(x => x.ActiveMessageId, null);
        }
        var result = await _db.InfraAgentSessions.UpdateOneAsync(
            filter,
            update,
            cancellationToken: ct);
        if (result.MatchedCount != 0) return true;

        // 只承认该轮已经抵达的同一幂等终态；绝不能把“同 generation 的另一轮”
        // 当成成功，否则上层会再次执行 generation-only 回写。
        var idempotentFilter = Builders<InfraAgentSession>.Filter.And(
            Builders<InfraAgentSession>.Filter.Eq(x => x.Id, sessionId),
            Builders<InfraAgentSession>.Filter.Eq(x => x.CdsSessionId, cdsSourceSessionId),
            Builders<InfraAgentSession>.Filter.Eq(x => x.Status, InfraAgentSessionStatuses.Failed));
        if (preserveActiveMessage && !string.IsNullOrWhiteSpace(clientMessageId))
        {
            idempotentFilter &= Builders<InfraAgentSession>.Filter.Eq(x => x.ActiveMessageId, clientMessageId);
        }
        else if (!preserveActiveMessage)
        {
            idempotentFilter &= Builders<InfraAgentSession>.Filter.Eq(x => x.ActiveMessageId, null);
        }
        return await _db.InfraAgentSessions.CountDocumentsAsync(
            idempotentFilter,
            cancellationToken: ct) == 1;
    }

    private async Task<bool> ApplyCdsTerminalTurnProjectionAsync(
        string sessionId,
        string cdsSourceSessionId,
        string? clientMessageId,
        string status,
        CancellationToken ct)
    {
        var filter = string.IsNullOrWhiteSpace(clientMessageId)
            ? BuildCdsGenerationWritableFilter(sessionId, cdsSourceSessionId)
            : BuildCdsActiveTurnWritableFilter(sessionId, cdsSourceSessionId, clientMessageId);
        var result = await _db.InfraAgentSessions.UpdateOneAsync(
            filter,
            Builders<InfraAgentSession>.Update
                .Set(x => x.Status, status)
                .Set(x => x.ActiveMessageId, null)
                .Set(x => x.UpdatedAt, DateTime.UtcNow),
            cancellationToken: ct);
        if (result.MatchedCount != 0) return true;
        return await _db.InfraAgentSessions.CountDocumentsAsync(
            x => x.Id == sessionId
                && x.CdsSessionId == cdsSourceSessionId
                && x.Status == status
                && x.ActiveMessageId == null,
            cancellationToken: ct) == 1;
    }

    internal static FilterDefinition<InfraAgentSession> BuildCdsFailedTurnWritableFilter(
        string sessionId,
        string cdsSourceSessionId,
        string? clientMessageId,
        IReadOnlyCollection<string> eligibleStatuses)
    {
        var filter = Builders<InfraAgentSession>.Filter.And(
            Builders<InfraAgentSession>.Filter.Eq(x => x.Id, sessionId),
            Builders<InfraAgentSession>.Filter.Eq(x => x.CdsSessionId, cdsSourceSessionId),
            Builders<InfraAgentSession>.Filter.In(x => x.Status, eligibleStatuses));
        if (!string.IsNullOrWhiteSpace(clientMessageId))
        {
            filter &= Builders<InfraAgentSession>.Filter.Eq(x => x.ActiveMessageId, clientMessageId);
        }
        return filter;
    }

    private List<InfraAgentRuntimeToolDef> BuildSidecarToolDefs(InfraAgentSession session)
    {
        var tools = new List<InfraAgentRuntimeToolDef>();
        foreach (var descriptor in _toolRegistry.ListAll())
        {
            if (!ShouldExposeToolToRuntime(session.ToolPolicy, descriptor.Name))
                continue;

            try
            {
                using var schema = JsonDocument.Parse(descriptor.InputSchemaJson);
                tools.Add(new InfraAgentRuntimeToolDef
                {
                    Name = descriptor.Name,
                    Description = descriptor.Description,
                    InputSchema = schema.RootElement.Clone()
                });
            }
            catch (JsonException ex)
            {
                _logger.LogWarning(
                    ex,
                    "Skip invalid agent tool schema name={ToolName}",
                    descriptor.Name);
            }
        }
        return tools;
    }

    private static bool ShouldExposeToolToRuntime(string? toolPolicy, string toolName)
    {
        return InfraAgentToolPolicies.ShouldExposeToolToRuntime(toolPolicy, toolName);
    }

    private static IReadOnlyList<ReadonlyArtifactToolRequest> BuildReadonlyArtifactRequests() => new[]
    {
        new ReadonlyArtifactToolRequest(
            "repo_git_status",
            JsonSerializer.SerializeToElement(new { cwd = "." })),
        new ReadonlyArtifactToolRequest(
            "repo_git_diff",
            JsonSerializer.SerializeToElement(new { cwd = ".", maxBytes = 40000 })),
        new ReadonlyArtifactToolRequest(
            "repo_list_files",
            JsonSerializer.SerializeToElement(new { path = ".", maxFiles = 120 }))
    };

    private sealed record ReadonlyArtifactToolRequest(string ToolName, JsonElement Input);

    private static IReadOnlyList<ReadonlyCheckToolRequest> BuildReadonlyCheckRequests() => new[]
    {
        new ReadonlyCheckToolRequest(JsonSerializer.SerializeToElement(new
        {
            command = "git status --short",
            cwd = ".",
            timeoutSeconds = 30
        })),
        new ReadonlyCheckToolRequest(JsonSerializer.SerializeToElement(new
        {
            command = "git diff --stat",
            cwd = ".",
            timeoutSeconds = 30
        }))
    };

    private sealed record ReadonlyCheckToolRequest(JsonElement Input);

    private sealed class CdsCreatePendingException : InfraAgentSessionException
    {
        public CdsCreatePendingException()
            : base(
                InfraAgentSessionErrorCodes.SessionCreationPending,
                "CDS 会话仍在创建中，请稍后重试；本次启动会继续复用同一请求标识",
                StatusCodes.Status503ServiceUnavailable)
        {
        }
    }

    private static string BuildBrowserSnapshotPayload(string branchId, string content)
    {
        try
        {
            using var doc = JsonDocument.Parse(content);
            return JsonSerializer.Serialize(new
            {
                source = "map-browser-snapshot",
                branchId,
                capturedAt = DateTime.UtcNow,
                result = doc.RootElement.Clone(),
                state = doc.RootElement.TryGetProperty("state", out var state)
                    ? state.Clone()
                    : default(JsonElement?)
            });
        }
        catch (JsonException)
        {
            return JsonSerializer.Serialize(new
            {
                source = "map-browser-snapshot",
                branchId,
                capturedAt = DateTime.UtcNow,
                data = content
            });
        }
    }

    private static string BuildBrowserActionPayload(string branchId, string action, string content)
    {
        try
        {
            using var doc = JsonDocument.Parse(content);
            return JsonSerializer.Serialize(new
            {
                source = "map-browser-action",
                branchId,
                action,
                capturedAt = DateTime.UtcNow,
                result = doc.RootElement.Clone(),
                state = doc.RootElement.TryGetProperty("state", out var state)
                    ? state.Clone()
                    : default(JsonElement?)
            });
        }
        catch (JsonException)
        {
            return JsonSerializer.Serialize(new
            {
                source = "map-browser-action",
                branchId,
                action,
                capturedAt = DateTime.UtcNow,
                data = content
            });
        }
    }

    private async Task<string> BuildLogFallbackAsync(InfraAgentSession session, string reason, CancellationToken ct)
    {
        var builder = new StringBuilder();
        builder.AppendLine($"[{DateTime.UtcNow:O}] CDS logs unavailable: {reason}");
        builder.AppendLine($"session={session.Id}");
        builder.AppendLine($"cdsSession={session.CdsSessionId}");
        builder.AppendLine($"runtime={session.Runtime}");
        builder.AppendLine($"status={session.Status}");
        if (!string.IsNullOrWhiteSpace(session.CdsWorkerId))
        {
            builder.AppendLine($"worker={session.CdsWorkerId}");
        }
        if (!string.IsNullOrWhiteSpace(session.CdsContainerName))
        {
            builder.AppendLine($"container={session.CdsContainerName}");
        }
        builder.AppendLine();
        builder.AppendLine("local persisted events:");

        var events = await _db.InfraAgentEvents
            .Find(x => x.SessionId == session.Id)
            .SortBy(x => x.Seq)
            .Limit(80)
            .ToListAsync(ct);
        foreach (var evt in events)
        {
            builder.AppendLine($"#{evt.Seq} {evt.Type} {evt.PayloadJson}");
        }

        return builder.ToString();
    }

    private static string NormalizeRuntime(string? runtime)
    {
        if (string.IsNullOrWhiteSpace(runtime)) return InfraAgentRuntimes.ClaudeSdk;
        var normalized = runtime.Trim();
        return normalized switch
        {
            InfraAgentRuntimes.ClaudeSdk => InfraAgentRuntimes.ClaudeSdk,
            InfraAgentRuntimes.OpenAiCompatible => InfraAgentRuntimes.ClaudeSdk,
            InfraAgentRuntimes.Codex => InfraAgentRuntimes.Codex,
            InfraAgentRuntimes.OpenDesign => InfraAgentRuntimes.OpenDesign,
            InfraAgentRuntimes.Custom => InfraAgentRuntimes.Custom,
            _ => InfraAgentRuntimes.ClaudeSdk
        };
    }

    private static string NormalizeToolPolicy(string? policy)
    {
        return InfraAgentToolPolicies.Normalize(policy);
    }

    private static string NormalizeWorkloadKind(string? value) => NormalizeOptional(value) switch
    {
        InfraAgentWorkloadKinds.RepositoryChange => InfraAgentWorkloadKinds.RepositoryChange,
        InfraAgentWorkloadKinds.DesignArtifact => InfraAgentWorkloadKinds.DesignArtifact,
        _ => InfraAgentWorkloadKinds.General
    };

    private static string NormalizeIsolationMode(string? value) => NormalizeOptional(value) switch
    {
        InfraAgentIsolationModes.SessionContainer => InfraAgentIsolationModes.SessionContainer,
        _ => InfraAgentIsolationModes.SharedRuntime
    };

    private static object BuildResourcePolicy(InfraAgentSession session) => new
    {
        cpuCores = session.ResourceCpuCores,
        memoryMb = session.ResourceMemoryMb,
        timeoutSeconds = NormalizeRuntimeTimeout(session.TimeoutSeconds),
        networkPolicy = NormalizeNetworkPolicy(session.NetworkPolicy),
        autoCleanupMinutes = NormalizeAutoCleanupMinutes(session.AutoCleanupMinutes)
    };

    private static int NormalizeRuntimeTimeout(int value) => Math.Clamp(value <= 0 ? 900 : value, 30, 7200);

    private static int NormalizeAutoCleanupMinutes(int value) => Math.Clamp(value <= 0 ? 30 : value, 5, 1440);

    private static string NormalizeNetworkPolicy(string? policy)
    {
        var normalized = NormalizeOptional(policy);
        return normalized is InfraAgentRuntimeNetworkPolicies.Restricted
            or InfraAgentRuntimeNetworkPolicies.EgressOnly
            or InfraAgentRuntimeNetworkPolicies.Open
            ? normalized
            : InfraAgentRuntimeNetworkPolicies.Restricted;
    }

    private static string NormalizeApprovalDecision(string? decision)
    {
        return string.Equals(decision?.Trim(), "allow", StringComparison.OrdinalIgnoreCase)
            ? "allow"
            : "deny";
    }

    private static string NormalizeTitle(string? title)
    {
        var normalized = NormalizeOptional(title);
        return string.IsNullOrWhiteSpace(normalized) ? "CDS Agent 会话" : normalized;
    }

    private static string? NormalizeOptional(string? value)
    {
        var normalized = value?.Trim();
        return string.IsNullOrWhiteSpace(normalized) ? null : normalized;
    }

    private async Task<InfraAgentRuntimeProfileSecretView?> ResolveRuntimeProfileForSessionAsync(
        string userId,
        string? runtimeProfileId,
        CancellationToken ct)
    {
        try
        {
            return await _runtimeProfiles.ResolveAsync(runtimeProfileId, userId, ct);
        }
        catch (InfraAgentRuntimeProfileException ex)
        {
            throw new InfraAgentSessionException(
                InfraAgentSessionErrorCodes.RuntimeProfileInvalid,
                ex.Message,
                ex.HttpStatus);
        }
    }

    private static bool IsSidecarRuntime(string? runtime) =>
        string.Equals(runtime, InfraAgentRuntimes.ClaudeSdk, StringComparison.OrdinalIgnoreCase)
        || string.Equals(runtime, InfraAgentRuntimes.Custom, StringComparison.OrdinalIgnoreCase);

    internal enum InfraAgentRuntimeMode { Official, Lite, Unavailable }

    internal sealed record InfraAgentRuntimeSelection(InfraAgentRuntimeMode Mode, string Reason);

    /// <summary>
    /// 优雅降级决策（纯函数，可单测）：
    /// - 官方 sidecar 已配置且 profile 兼容 → official；
    /// - 否则有 lite 兜底 → lite（原因区分 sidecar 未配置 / R1 profile 不兼容）；
    /// - 都没有 → unavailable。
    /// </summary>
    internal static InfraAgentRuntimeSelection DecideRuntimeSelection(
        bool sidecarConfigured,
        bool profileCompatible,
        bool liteAvailable)
    {
        if (sidecarConfigured && profileCompatible)
        {
            return new InfraAgentRuntimeSelection(InfraAgentRuntimeMode.Official, "official_sdk_ready");
        }

        var reason = sidecarConfigured ? "r1_profile_incompatible" : "sidecar_not_configured";
        return liteAvailable
            ? new InfraAgentRuntimeSelection(InfraAgentRuntimeMode.Lite, reason)
            : new InfraAgentRuntimeSelection(InfraAgentRuntimeMode.Unavailable, reason);
    }

    private IInfraAgentRuntimeAdapter? ResolveAdapterByKind(string? adapterKind)
    {
        if (string.Equals(adapterKind, AgentRuntime.GatewayReviewRuntimeAdapter.SourceName, StringComparison.OrdinalIgnoreCase))
        {
            return _liteReviewAdapter;
        }

        return _runtimeAdapter;
    }

    private static bool IsRuntimeProfileCompatibleWithAdapter(
        string? runtime,
        InfraAgentRuntimeProfileSecretView? profile,
        string desiredRuntimeAdapter)
    {
        if (!IsSidecarRuntime(runtime) || profile == null)
        {
            return true;
        }

        return InfraAgentRuntimeProfileCompatibility.AnalyzeForDesiredRuntimeAdapter(
            desiredRuntimeAdapter,
            profile.Runtime,
            profile.Protocol,
            profile.Model).Compatible;
    }

    /// <summary>
    /// 创建期 / 发消息前的兼容校验：当 lite 兜底可用时不再硬卡，留给运行时降级；
    /// 否则维持原有「不兼容直接拒绝」行为。
    /// </summary>
    private void EnsureRuntimeProfileCompatibleOrLiteFallback(
        string? runtime,
        InfraAgentRuntimeProfileSecretView? profile,
        string desiredRuntimeAdapter)
    {
        if (_liteReviewAdapter?.IsConfigured == true)
        {
            return;
        }

        EnsureRuntimeProfileCompatibleWithAdapter(runtime, profile, desiredRuntimeAdapter);
    }

    private static void EnsureRuntimeProfileCompatibleWithAdapter(
        string? runtime,
        InfraAgentRuntimeProfileSecretView? profile,
        string desiredRuntimeAdapter)
    {
        if (!IsSidecarRuntime(runtime) || profile == null)
        {
            return;
        }

        var compatibility = InfraAgentRuntimeProfileCompatibility.AnalyzeForDesiredRuntimeAdapter(
            desiredRuntimeAdapter,
            profile.Runtime,
            profile.Protocol,
            profile.Model);
        if (compatibility.Compatible)
        {
            return;
        }

        throw new InfraAgentSessionException(
            InfraAgentSessionErrorCodes.RuntimeProfileIncompatible,
            InfraAgentRuntimeProfileCompatibility.BuildIncompatibleMessage(profile.Name, profile.Model),
            StatusCodes.Status400BadRequest);
    }

    private static InfraAgentSessionView ToView(InfraAgentSession session) => new(
        session.Id,
        session.UserId,
        session.ConnectionId,
        session.Partner,
        session.CdsProjectId,
        session.CdsSessionId,
        session.CdsWorkerId,
        session.CdsContainerName,
        string.IsNullOrWhiteSpace(session.TraceId) ? BuildEventTraceId(session.Id) : session.TraceId,
        session.Runtime,
        session.RuntimeAdapter,
        session.CurrentRuntimeRunId,
        session.Model,
        session.WorkspaceRoot,
        session.GitRepository,
        session.GitRef,
        session.ResourceCpuCores,
        session.ResourceMemoryMb,
        NormalizeRuntimeTimeout(session.TimeoutSeconds),
        NormalizeNetworkPolicy(session.NetworkPolicy),
        NormalizeAutoCleanupMinutes(session.AutoCleanupMinutes),
        session.ToolPolicy,
        session.HookProfileId,
        session.Title,
        session.Status,
        session.IsArchived,
        session.ManualTakeoverEnabled,
        session.ManualTakeoverAt,
        session.ManualTakeoverReason,
        session.LastError,
        session.CreatedAt,
        session.UpdatedAt,
        session.StartedAt,
        session.StoppedAt,
        session.RuntimeProfileId,
        session.ModelBaseUrl,
        session.WorkloadKind,
        session.IsolationMode);

    private static InfraAgentEventView ToEventView(InfraAgentEvent evt) => new(
        evt.Id,
        evt.SessionId,
        evt.Seq,
        string.IsNullOrWhiteSpace(evt.TraceId) ? BuildEventTraceId(evt.SessionId) : evt.TraceId,
        evt.Type,
        evt.PayloadJson,
        evt.CreatedAt,
        evt.CdsSourceSessionId,
        evt.CdsSeq);

    private static InfraAgentMessageView ToMessageView(InfraAgentMessage msg) => new(
        msg.Id,
        msg.SessionId,
        msg.Role,
        msg.Content,
        msg.Status,
        msg.CreatedAt,
        msg.CdsSourceSessionId,
        msg.ReplyToMessageId);

    public static InfraAgentSlaDashboardView BuildSlaDashboard(
        IReadOnlyList<InfraAgentSessionView> sessions,
        IReadOnlyList<InfraAgentEventView> events,
        int windowDays,
        DateTime? windowStart = null,
        DateTime? windowEnd = null)
    {
        var safeWindowDays = NormalizeSlaWindowDays(windowDays);
        var generatedAt = windowEnd ?? DateTime.UtcNow;
        var start = windowStart ?? generatedAt.AddDays(-safeWindowDays);
        var eventsBySession = events
            .GroupBy(x => x.SessionId)
            .ToDictionary(x => x.Key, x => x.ToList(), StringComparer.Ordinal);
        var sessionMetrics = sessions
            .Select(session =>
            {
                eventsBySession.TryGetValue(session.Id, out var sessionEvents);
                sessionEvents ??= new List<InfraAgentEventView>();
                var usage = ExtractTokenUsage(sessionEvents);
                return new
                {
                    Session = session,
                    Events = sessionEvents,
                    DurationSeconds = CalculateDurationSeconds(session, generatedAt),
                    TimedOut = IsSlaTimedOut(session, sessionEvents, generatedAt),
                    Usage = usage
                };
            })
            .ToList();
        var failedCount = sessions.Count(x => x.Status == InfraAgentSessionStatuses.Failed);
        var runningCount = sessions.Count(x => x.Status == InfraAgentSessionStatuses.Running || x.Status == InfraAgentSessionStatuses.Creating);
        var timeoutCount = sessionMetrics.Count(x => x.TimedOut);
        var durations = sessionMetrics
            .Select(x => x.DurationSeconds)
            .Where(x => x.HasValue)
            .Select(x => x!.Value)
            .ToList();
        var inputTokens = sessionMetrics.Sum(x => x.Usage.InputTokens);
        var outputTokens = sessionMetrics.Sum(x => x.Usage.OutputTokens);
        var totalTokens = sessionMetrics.Sum(x => x.Usage.TotalTokens);
        var tokenUsageObserved = sessionMetrics.Any(x => x.Usage.Observed);
        var statusCounts = sessions
            .GroupBy(x => string.IsNullOrWhiteSpace(x.Status) ? "unknown" : x.Status)
            .OrderByDescending(x => x.Count())
            .ThenBy(x => x.Key, StringComparer.Ordinal)
            .Select(x => new InfraAgentSlaStatusCountView(x.Key, x.Count()))
            .ToList();
        var runtimeBreakdown = sessionMetrics
            .GroupBy(x => new
            {
                Runtime = string.IsNullOrWhiteSpace(x.Session.Runtime) ? "unknown" : x.Session.Runtime,
                RuntimeAdapter = string.IsNullOrWhiteSpace(x.Session.RuntimeAdapter) ? "unknown" : x.Session.RuntimeAdapter!
            })
            .OrderByDescending(x => x.Count())
            .ThenBy(x => x.Key.Runtime, StringComparer.Ordinal)
            .Select(group =>
            {
                var groupDurations = group
                    .Select(x => x.DurationSeconds)
                    .Where(x => x.HasValue)
                    .Select(x => x!.Value)
                    .ToList();
                var groupCount = group.Count();
                var groupFailed = group.Count(x => x.Session.Status == InfraAgentSessionStatuses.Failed);
                var groupTimedOut = group.Count(x => x.TimedOut);
                return new InfraAgentSlaRuntimeBreakdownView(
                    group.Key.Runtime,
                    group.Key.RuntimeAdapter,
                    groupCount,
                    groupFailed,
                    groupTimedOut,
                    Rate(groupFailed, groupCount),
                    Rate(groupTimedOut, groupCount),
                    AverageOrNull(groupDurations),
                    group.Sum(x => x.Usage.TotalTokens),
                    group.Any(x => x.Usage.Observed));
            })
            .ToList();
        var daily = sessionMetrics
            .GroupBy(x => x.Session.CreatedAt.Date)
            .OrderBy(x => x.Key)
            .Select(group => new InfraAgentSlaDailyPointView(
                group.Key,
                group.Count(),
                group.Count(x => x.Session.Status == InfraAgentSessionStatuses.Failed),
                group.Count(x => x.TimedOut),
                group.Sum(x => x.Usage.TotalTokens)))
            .ToList();

        return new InfraAgentSlaDashboardView(
            "cds-agent-sla-dashboard/v1",
            generatedAt,
            safeWindowDays,
            start,
            generatedAt,
            new InfraAgentSlaSummaryView(
                sessions.Count,
                runningCount,
                Math.Max(0, sessions.Count - runningCount - failedCount),
                failedCount,
                timeoutCount,
                Rate(failedCount, sessions.Count),
                Rate(timeoutCount, sessions.Count),
                AverageOrNull(durations),
                events.Count,
                events.Count(x => x.Type == InfraAgentEventTypes.ToolCall || x.Type == InfraAgentEventTypes.ToolResult),
                events.Count(x => x.Type == InfraAgentEventTypes.Error),
                inputTokens,
                outputTokens,
                totalTokens,
                tokenUsageObserved,
                null),
            statusCounts,
            runtimeBreakdown,
            daily);
    }

    public static InfraAgentScheduleDashboardView BuildScheduleDashboard(
        IReadOnlyList<Workflow> workflows,
        IReadOnlyList<WorkflowSchedule> schedules,
        IReadOnlyList<WorkflowExecution> executions,
        int windowDays,
        DateTime? generatedAt = null)
    {
        var safeWindowDays = NormalizeSlaWindowDays(windowDays);
        var now = generatedAt ?? DateTime.UtcNow;
        var cdsWorkflows = workflows
            .Where(IsCdsAgentWorkflow)
            .OrderByDescending(x => x.UpdatedAt)
            .ToList();
        var workflowIds = cdsWorkflows.Select(x => x.Id).ToHashSet(StringComparer.Ordinal);
        var scheduleRows = schedules
            .Where(x => workflowIds.Contains(x.WorkflowId) || ContainsCdsAgentSignal(x.Name) || ContainsCdsAgentSignal(x.WorkflowName))
            .OrderBy(x => x.NextRunAt ?? DateTime.MaxValue)
            .ThenByDescending(x => x.CreatedAt)
            .Select(x => new InfraAgentScheduleView(
                x.Id,
                x.WorkflowId,
                x.WorkflowName,
                x.Name,
                x.Mode,
                x.CronExpression,
                x.Timezone,
                x.IsEnabled,
                x.NextRunAt,
                x.LastTriggeredAt,
                x.TriggerCount,
                ResolveScheduleState(x, workflowIds, now),
                WorkflowPath(x.WorkflowId)))
            .ToList();
        var executionRows = executions
            .Where(x => workflowIds.Contains(x.WorkflowId) || x.NodeSnapshot.Any(n => IsCdsAgentNode(n)) || TryExtractCdsAgentRunHandle(x) != null)
            .OrderByDescending(x => x.CreatedAt)
            .Take(50)
            .Select(x =>
            {
                var run = TryExtractCdsAgentRunHandle(x);
                return new InfraAgentScheduledExecutionView(
                    x.Id,
                    x.WorkflowId,
                    x.WorkflowName,
                    x.TraceId,
                    x.Status,
                    x.TriggerType,
                    x.CreatedAt,
                    x.DurationMs,
                    x.NodeSnapshot.Count(IsCdsAgentNode),
                    run?.SessionId,
                    run?.TraceId,
                    run?.WorkbenchPath,
                    WorkflowPath(x.WorkflowId));
            })
            .ToList();
        var workflowRows = cdsWorkflows
            .Select(x => new InfraAgentWorkflowTemplateView(
                x.Id,
                x.Name,
                x.Description,
                x.Tags,
                x.Nodes.Count(IsCdsAgentNode),
                HasKnowledgeReadonlySignal(x),
                x.Nodes.Any(n => n.NodeType == CapsuleTypes.NotificationSender),
                WorkflowPath(x.Id)))
            .ToList();
        var knowledgeWorkflowCount = workflowRows.Count(x => x.HasKnowledgeReadonlyTools);
        var knowledgeWorkflowIds = workflowRows
            .Where(x => x.HasKnowledgeReadonlyTools)
            .Select(x => x.WorkflowId)
            .ToHashSet(StringComparer.Ordinal);
        var knowledgeScheduleCount = scheduleRows.Count(x => knowledgeWorkflowIds.Contains(x.WorkflowId));

        return new InfraAgentScheduleDashboardView(
            "cds-agent-schedule-dashboard/v1",
            now,
            safeWindowDays,
            new InfraAgentScheduleSummaryView(
                workflowRows.Count(),
                workflowRows.Sum(x => x.CdsAgentNodeCount),
                scheduleRows.Count(x => x.Mode == "cron"),
                scheduleRows.Count(x => x.Mode == "cron" && x.IsEnabled),
                scheduleRows.Count(x => x.State is "due-soon" or "overdue"),
                executionRows.Count,
                executionRows.Count(x => x.Status == WorkflowExecutionStatus.Failed || x.Status == WorkflowExecutionStatus.TimedOut),
                knowledgeWorkflowCount),
            workflowRows,
            scheduleRows,
            executionRows,
            new InfraAgentKnowledgeGovernanceView(
                new[] { "kb_list", "kb_search", "kb_read" },
                knowledgeWorkflowCount,
                knowledgeScheduleCount,
                "readonly-only: Agent may list/search/read knowledge base content; write/draft/apply/commit are out of P3-4 scope"));
    }

    public static InfraAgentGovernanceDashboardView BuildGovernanceDashboard(
        string userId,
        IReadOnlyList<ReportTeam> teams,
        IReadOnlyList<Workflow> workflows,
        IReadOnlyList<KnowledgeBaseStore> knowledgeStores,
        IReadOnlyList<InfraAgentRuntimeProfile> profiles,
        IReadOnlyList<InfraAgentSession> sessions,
        IReadOnlyList<WorkflowExecution> waitingApprovalExecutions,
        DateTime? generatedAt = null)
    {
        var now = generatedAt ?? DateTime.UtcNow;
        var teamIds = teams
            .Select(x => x.Id)
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .Distinct(StringComparer.Ordinal)
            .OrderBy(x => x, StringComparer.Ordinal)
            .ToList();
        var ownedKnowledgeBaseCount = knowledgeStores.Count(x => string.Equals(x.OwnerId, userId, StringComparison.Ordinal));
        var publicKnowledgeBaseCount = knowledgeStores.Count(x => x.IsPublic && !string.Equals(x.OwnerId, userId, StringComparison.Ordinal));
        var ownedProfileCount = profiles.Count(x => string.Equals(x.CreatedByUserId, userId, StringComparison.Ordinal));
        var teamSharedProfileCount = profiles.Count(x =>
            !string.Equals(x.CreatedByUserId, userId, StringComparison.Ordinal)
            && SharesAnyTeam(x, teamIds));
        var defaultProfile = profiles.FirstOrDefault(x => x.IsDefault);
        var defaultProfileVisible = defaultProfile == null
            || string.Equals(defaultProfile.CreatedByUserId, userId, StringComparison.Ordinal)
            || SharesAnyTeam(defaultProfile, teamIds);
        var defaultProfileOwned = defaultProfile != null && string.Equals(defaultProfile.CreatedByUserId, userId, StringComparison.Ordinal);
        var allProfilesScopedToSubject = profiles.All(x =>
            string.Equals(x.CreatedByUserId, userId, StringComparison.Ordinal)
            || SharesAnyTeam(x, teamIds));
        var writablePolicySessionCount = sessions.Count(x => string.Equals(x.ToolPolicy, InfraAgentToolPolicies.CodeWritableConfirm, StringComparison.OrdinalIgnoreCase));
        var gates = new List<InfraAgentGovernanceGateView>
        {
            new(
                "GOV-REPO-OWNER",
                "Repository/workflow scope",
                workflows.All(x => string.Equals(x.CreatedBy, userId, StringComparison.Ordinal) || string.Equals(x.OwnerUserId, userId, StringComparison.Ordinal)) ? "pass" : "warn",
                "CDS Agent workflow and session queries are user-scoped before aggregation.",
                "Add repository allow-list policy before enabling cross-team writable runs."),
            new(
                "GOV-KB-READONLY",
                "KnowledgeBase readonly scope",
                "pass",
                "kb_list/kb_search/kb_read use owner-or-public filters; kb_apply requires owned store and MAP approval.",
                "Map owned/public stores to explicit team scopes before batch governance writes."),
            new(
                "GOV-PROFILE-SCOPE",
                "Runtime profile scope",
                allProfilesScopedToSubject && defaultProfileVisible ? "pass" : "warn",
                allProfilesScopedToSubject
                    ? defaultProfile == null
                        ? "No scoped default runtime profile is configured for this subject."
                        : defaultProfileOwned
                            ? "Runtime profile list/resolve is subject-scoped; default profile is owned by the current subject."
                            : "Runtime profile list/resolve is subject-scoped; default profile is shared through a team membership."
                    : "Runtime profile snapshot includes records outside the current subject scope.",
                "Keep runtime profile list/resolve/update/delete owner-or-team-scoped; define owner-only update/delete for shared profiles."),
            new(
                "GOV-APPROVAL-WRITES",
                "Approval policy for writes",
                writablePolicySessionCount == 0 || waitingApprovalExecutions.Count > 0 ? "pass" : "warn",
                writablePolicySessionCount == 0
                    ? "No active code-writable CDS Agent sessions in this subject."
                    : $"{writablePolicySessionCount} code-writable session(s); {waitingApprovalExecutions.Count} workflow execution(s) currently waiting approval.",
                "Keep code/KB writes behind MAP approval and expose stale waiting approvals in team governance.")
        };
        var scopes = new List<InfraAgentGovernanceScopeView>
        {
            new(
                "repository",
                "partial",
                "User-owned workflows and sessions are filtered; repository allow-list is not yet a first-class team policy.",
                $"{workflows.Count} owned workflow(s); {sessions.Count} active/visible CDS Agent session(s).",
                "Cross-team repository boundaries are implicit in session owner fields.",
                "Add explicit repository/team policy before scheduled writable remediation."),
            new(
                "knowledge-base",
                "enforced-readonly",
                "Readonly tools can access owned or public stores; apply requires owned store and approval.",
                $"{ownedKnowledgeBaseCount} owned store(s); {publicKnowledgeBaseCount} public store(s) visible.",
                "Public stores are readable by design; writes still require owned store.",
                "Bind stores to teams before enabling batch apply."),
            new(
                "runtime-profile",
                allProfilesScopedToSubject && defaultProfileVisible ? "enforced-team-aware" : "needs-enforcement",
                "Runtime profile list/resolve are owner-or-team-scoped; update/delete remain owner-only.",
                $"{ownedProfileCount} owned profile(s); {teamSharedProfileCount} team-shared profile(s); {profiles.Count} visible.",
                allProfilesScopedToSubject
                    ? "No profile outside owned/team membership scope is visible in the subject snapshot."
                    : "A non-owned profile without team membership is present in the runtime profile snapshot.",
                "Add repository/profile/approval owner UI before scheduled writable remediation."),
            new(
                "approval-policy",
                "enforced",
                "Dangerous code/KB write tools require MAP approval or explicit writable policy.",
                $"{writablePolicySessionCount} writable session(s); {waitingApprovalExecutions.Count} waiting approval execution(s).",
                "Long waiting approvals can block workflow runs if not surfaced to team owners.",
                "Add team-level approval owner and stale-approval SLA.")
        };
        var passed = gates.Count(x => x.Status == "pass");
        var nextActions = gates
            .Where(x => x.Status != "pass")
            .Select(x => x.NextAction)
            .Distinct(StringComparer.Ordinal)
            .ToList();
        if (nextActions.Count == 0)
        {
            nextActions.Add("Continue with explicit team policy data model for repository/profile/approval ownership.");
        }
        var ownerPolicies = new List<InfraAgentGovernanceOwnerPolicyView>
        {
            new(
                "repository",
                "Repository owner",
                workflows.Count == 0 ? "not-configured" : "user-owned",
                userId,
                teamIds.Count == 0 ? "个人上下文" : $"{teamIds.Count} team context(s)",
                $"{workflows.Count} workflow(s) and {sessions.Count} CDS Agent session(s) are visible through current subject filters.",
                "Repository allow-list is not yet a first-class team policy, so scheduled writable remediation stays blocked.",
                "Add repository/team owner policy UI before enabling cross-team writable runs.",
                "/workflow-agent"),
            new(
                "runtime-profile",
                "Runtime profile owner",
                allProfilesScopedToSubject && defaultProfileVisible ? "owner-or-team-visible" : "needs-enforcement",
                defaultProfileOwned ? userId : "team-shared profile owner",
                teamSharedProfileCount == 0 ? "owner-only" : $"{teamSharedProfileCount} team-shared profile(s)",
                $"{ownedProfileCount} owned profile(s), {teamSharedProfileCount} team-shared profile(s), {profiles.Count} visible profile(s).",
                "Team-shared profile usage is allowed, but update/delete must remain owner-only.",
                "Expose profile owner and shared-team controls before scheduled writable remediation.",
                "/cds-agent"),
            new(
                "approval",
                "Approval owner",
                writablePolicySessionCount == 0
                    ? "readonly"
                    : waitingApprovalExecutions.Count > 0
                        ? "waiting-approval"
                        : "needs-approval-owner",
                userId,
                "MAP approval",
                $"{writablePolicySessionCount} writable session(s), {waitingApprovalExecutions.Count} waiting approval execution(s).",
                "Writable code/KB runs can stall or bypass accountability if approval owner is not explicit.",
                "Add team-level approval owner and stale-approval SLA before enabling batch writes.",
                "/workflow-agent")
        };

        return new InfraAgentGovernanceDashboardView(
            "cds-agent-governance-dashboard/v1",
            now,
            new InfraAgentGovernanceSubjectView(userId, teamIds, teamIds.Count),
            new InfraAgentGovernanceSummaryView(
                workflows.Count,
                ownedKnowledgeBaseCount,
                publicKnowledgeBaseCount,
                profiles.Count,
                ownedProfileCount,
                defaultProfileOwned,
                writablePolicySessionCount,
                waitingApprovalExecutions.Count,
                passed,
                gates.Count,
                teamSharedProfileCount),
            scopes,
            gates,
            nextActions,
            ownerPolicies);
    }

    private static bool SharesAnyTeam(InfraAgentRuntimeProfile profile, IReadOnlyCollection<string> teamIds)
    {
        return profile.SharedTeamIds != null
            && teamIds.Count > 0
            && profile.SharedTeamIds.Any(teamIds.Contains);
    }

    public static InfraAgentTraceBundleView BuildTraceBundle(
        InfraAgentSessionView session,
        IReadOnlyList<InfraAgentMessageView> messages,
        IReadOnlyList<InfraAgentEventView> events,
        string? logs,
        bool eventsTruncated = false)
    {
        var safeLogs = logs ?? string.Empty;
        var eventTypeCounts = events
            .GroupBy(x => x.Type)
            .ToDictionary(x => x.Key, x => x.Count(), StringComparer.Ordinal);
        var traceEvents = events
            .Select(x => new InfraAgentTraceEventView(
                x.Id,
                x.Seq,
                x.TraceId,
                x.Type,
                ParsePayloadElement(x.PayloadJson),
                x.CreatedAt))
            .ToList();
        var lastSeq = events.Count == 0 ? 0 : events.Max(x => x.Seq);
        var timeoutAt = session.StartedAt?.AddSeconds(session.TimeoutSeconds);
        var stopOrNow = session.StoppedAt ?? DateTime.UtcNow;
        var elapsedSeconds = session.StartedAt.HasValue
            ? Math.Max(0, (stopOrNow - session.StartedAt.Value).TotalSeconds)
            : (double?)null;
        var artifacts = BuildTraceArtifacts(traceEvents, safeLogs);

        return new InfraAgentTraceBundleView(
            "cds-agent-trace-bundle/v1",
            DateTime.UtcNow,
            session,
            new InfraAgentTraceMetricsView(
                messages.Count,
                events.Count,
                lastSeq,
                artifacts.Count,
                CountLogLines(safeLogs),
                elapsedSeconds,
                timeoutAt,
                timeoutAt.HasValue && stopOrNow >= timeoutAt.Value),
            eventTypeCounts,
            messages,
            traceEvents,
            artifacts,
            safeLogs,
            new InfraAgentTraceReplayView(
                $"/cds-agent?sessionId={Uri.EscapeDataString(session.Id)}",
                $"/api/infra-agent-sessions/{Uri.EscapeDataString(session.Id)}/events?afterSeq=0&limit=500",
                lastSeq,
                eventsTruncated));
    }

    private static List<InfraAgentTraceArtifactView> BuildTraceArtifacts(
        IReadOnlyList<InfraAgentTraceEventView> events,
        string logs)
    {
        var artifacts = new List<InfraAgentTraceArtifactView>();
        foreach (var evt in events)
        {
            if (evt.Type == InfraAgentEventTypes.File)
            {
                var path = ReadString(evt.Payload, "path") ?? "file";
                artifacts.Add(new InfraAgentTraceArtifactView(
                    $"{evt.Id}-file",
                    "文件产物",
                    "file",
                    path,
                    ReadString(evt.Payload, "content") ?? evt.Payload.GetRawText(),
                    evt.Seq));
                continue;
            }

            if (evt.Type == InfraAgentEventTypes.Diff)
            {
                artifacts.Add(new InfraAgentTraceArtifactView(
                    $"{evt.Id}-diff",
                    "代码 diff",
                    "diff",
                    ReadString(evt.Payload, "path") ?? "workspace",
                    ReadString(evt.Payload, "diff") ?? evt.Payload.GetRawText(),
                    evt.Seq));
                continue;
            }

            if (evt.Type == InfraAgentEventTypes.Browser)
            {
                artifacts.Add(new InfraAgentTraceArtifactView(
                    $"{evt.Id}-browser",
                    "浏览器快照",
                    "browser",
                    ReadString(evt.Payload, "url") ?? ReadString(evt.Payload, "title") ?? "browser snapshot",
                    evt.Payload.GetRawText(),
                    evt.Seq));
                continue;
            }

            if (evt.Type != InfraAgentEventTypes.ToolResult)
            {
                continue;
            }

            var detail = ParseNestedToolResult(evt.Payload);
            if (!detail.HasValue)
            {
                continue;
            }

            if (detail.Value.TryGetProperty("files", out var files) && files.ValueKind == JsonValueKind.Array)
            {
                var body = string.Join('\n', files.EnumerateArray().Select(x => x.ToString()));
                artifacts.Add(new InfraAgentTraceArtifactView(
                    $"{evt.Id}-files",
                    "文件树",
                    "files",
                    $"{files.GetArrayLength()} 个文件",
                    body,
                    evt.Seq));
            }

            var diff = ReadString(detail.Value, "diff") ?? ReadString(detail.Value, "unifiedDiff");
            if (!string.IsNullOrWhiteSpace(diff))
            {
                artifacts.Add(new InfraAgentTraceArtifactView(
                    $"{evt.Id}-diff",
                    ReadString(detail.Value, "unifiedDiff") == null ? "代码 diff" : "知识库 diff",
                    "diff",
                    ReadString(detail.Value, "path") ?? "workspace",
                    diff,
                    evt.Seq));
            }

            if (!string.IsNullOrWhiteSpace(ReadString(detail.Value, "command")))
            {
                artifacts.Add(new InfraAgentTraceArtifactView(
                    $"{evt.Id}-command",
                    "命令结果",
                    "command",
                    $"{ReadString(detail.Value, "command")} · exit {ReadString(detail.Value, "exitCode") ?? "unknown"}",
                    detail.Value.GetRawText(),
                    evt.Seq));
            }
        }

        if (!string.IsNullOrWhiteSpace(logs))
        {
            artifacts.Add(new InfraAgentTraceArtifactView(
                "runtime-logs",
                "Runtime 日志",
                "log",
                $"{CountLogLines(logs)} 行日志",
                logs,
                null));
        }

        return artifacts;
    }

    private static JsonElement? ParseNestedToolResult(JsonElement payload)
    {
        var raw = ReadString(payload, "resultSummary")
            ?? ReadString(payload, "content")
            ?? ReadString(payload, "output");
        if (string.IsNullOrWhiteSpace(raw)) return null;
        return TryParseJsonElement(raw);
    }

    private static int NormalizeSlaWindowDays(int days) => Math.Clamp(days <= 0 ? 7 : days, 1, 90);

    private static double Rate(int part, int total) => total <= 0 ? 0 : (double)part / total;

    private static double? AverageOrNull(IReadOnlyList<double> values) =>
        values.Count == 0 ? null : values.Average();

    private static double? CalculateDurationSeconds(InfraAgentSessionView session, DateTime now)
    {
        if (!session.StartedAt.HasValue)
        {
            return null;
        }

        var end = session.StoppedAt
            ?? (session.Status == InfraAgentSessionStatuses.Running || session.Status == InfraAgentSessionStatuses.Creating
                ? now
                : session.UpdatedAt);
        return Math.Max(0, (end - session.StartedAt.Value).TotalSeconds);
    }

    private static bool IsSlaTimedOut(
        InfraAgentSessionView session,
        IReadOnlyList<InfraAgentEventView> events,
        DateTime now)
    {
        if (ContainsTimeoutSignal(session.LastError))
        {
            return true;
        }

        if (events.Any(evt => ContainsTimeoutSignal(evt.Type) || ContainsTimeoutSignal(evt.PayloadJson)))
        {
            return true;
        }

        if (!session.StartedAt.HasValue || session.TimeoutSeconds <= 0)
        {
            return false;
        }

        var timeoutAt = session.StartedAt.Value.AddSeconds(session.TimeoutSeconds);
        return (session.Status == InfraAgentSessionStatuses.Running || session.Status == InfraAgentSessionStatuses.Creating)
            && now >= timeoutAt;
    }

    private static bool ContainsTimeoutSignal(string? value) =>
        !string.IsNullOrWhiteSpace(value)
        && value.Contains("timeout", StringComparison.OrdinalIgnoreCase);

    private static SlaTokenUsage ExtractTokenUsage(IReadOnlyList<InfraAgentEventView> events)
    {
        var result = new SlaTokenUsage(0, 0, 0, false);
        foreach (var evt in events)
        {
            var payload = TryParseJsonElement(evt.PayloadJson);
            if (!payload.HasValue)
            {
                continue;
            }

            result = result.Add(ExtractTokenUsage(payload.Value));
        }

        return result;
    }

    private static bool IsCdsAgentWorkflow(Workflow workflow) =>
        workflow.Tags.Any(x => x.Equals("cds-agent", StringComparison.OrdinalIgnoreCase))
        || workflow.Nodes.Any(IsCdsAgentNode);

    private static bool IsCdsAgentNode(WorkflowNode node) =>
        node.NodeType.Equals(CapsuleTypes.CdsAgent, StringComparison.OrdinalIgnoreCase);

    private static bool HasKnowledgeReadonlySignal(Workflow workflow) =>
        workflow.Tags.Any(x => x.Contains("knowledge", StringComparison.OrdinalIgnoreCase) || x.Contains("知识", StringComparison.OrdinalIgnoreCase))
        || workflow.Nodes.Any(node =>
            node.Config.Values.Any(value =>
            {
                var text = value?.ToString() ?? string.Empty;
                return text.Contains("kb_list", StringComparison.OrdinalIgnoreCase)
                    || text.Contains("kb_search", StringComparison.OrdinalIgnoreCase)
                    || text.Contains("kb_read", StringComparison.OrdinalIgnoreCase)
                    || text.Contains("知识库", StringComparison.OrdinalIgnoreCase)
                    || text.Contains("KnowledgeBase", StringComparison.OrdinalIgnoreCase);
            }));

    private static bool ContainsCdsAgentSignal(string? value) =>
        !string.IsNullOrWhiteSpace(value)
        && (value.Contains("cds", StringComparison.OrdinalIgnoreCase)
            || value.Contains("agent", StringComparison.OrdinalIgnoreCase)
            || value.Contains("巡检", StringComparison.OrdinalIgnoreCase)
            || value.Contains("治理", StringComparison.OrdinalIgnoreCase));

    private static string ResolveScheduleState(WorkflowSchedule schedule, ISet<string> knownWorkflowIds, DateTime now)
    {
        if (!knownWorkflowIds.Contains(schedule.WorkflowId))
        {
            return "missing-workflow";
        }

        if (!schedule.IsEnabled)
        {
            return "disabled";
        }

        if (!schedule.NextRunAt.HasValue)
        {
            return "not-scheduled";
        }

        if (schedule.NextRunAt.Value <= now)
        {
            return "overdue";
        }

        return schedule.NextRunAt.Value <= now.AddHours(24) ? "due-soon" : "ready";
    }

    private static string WorkflowPath(string workflowId) =>
        string.IsNullOrWhiteSpace(workflowId)
            ? "/workflow-agent"
            : $"/workflow-agent/{Uri.EscapeDataString(workflowId)}";

    private static CdsAgentRunHandle? TryExtractCdsAgentRunHandle(WorkflowExecution execution)
    {
        foreach (var artifact in EnumerateExecutionArtifacts(execution))
        {
            var handle = TryExtractCdsAgentRunHandle(artifact);
            if (handle != null) return handle;
        }

        return null;
    }

    private static IEnumerable<ExecutionArtifact> EnumerateExecutionArtifacts(WorkflowExecution execution)
    {
        foreach (var artifact in execution.FinalArtifacts)
        {
            yield return artifact;
        }

        foreach (var node in execution.NodeExecutions)
        {
            foreach (var artifact in node.OutputArtifacts)
            {
                yield return artifact;
            }
        }
    }

    private static CdsAgentRunHandle? TryExtractCdsAgentRunHandle(ExecutionArtifact artifact)
    {
        if (artifact.SlotId != "cds-agent-run" || string.IsNullOrWhiteSpace(artifact.InlineContent))
        {
            return null;
        }

        var payload = TryParseJsonElement(artifact.InlineContent);
        if (!payload.HasValue || payload.Value.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        var root = payload.Value;
        if (ReadString(root, "kind") != "cds-agent-workflow-run")
        {
            return null;
        }

        var sessionId = ReadString(root, "sessionId");
        if (string.IsNullOrWhiteSpace(sessionId))
        {
            return null;
        }

        return new CdsAgentRunHandle(
            sessionId,
            ReadString(root, "traceId"),
            ReadString(root, "workbenchPath") ?? $"/cds-agent?sessionId={Uri.EscapeDataString(sessionId)}");
    }

    private sealed record CdsAgentRunHandle(
        string SessionId,
        string? TraceId,
        string WorkbenchPath);

    private static SlaTokenUsage ExtractTokenUsage(JsonElement payload)
    {
        var usage = ReadUsageObject(payload);
        if (!usage.HasValue)
        {
            return new SlaTokenUsage(0, 0, 0, false);
        }

        var element = usage.Value;
        var input = ReadLong(element, "input_tokens")
            ?? ReadLong(element, "inputTokens")
            ?? ReadLong(element, "prompt_tokens")
            ?? ReadLong(element, "promptTokens")
            ?? 0;
        var output = ReadLong(element, "output_tokens")
            ?? ReadLong(element, "outputTokens")
            ?? ReadLong(element, "completion_tokens")
            ?? ReadLong(element, "completionTokens")
            ?? 0;
        var total = ReadLong(element, "total_tokens")
            ?? ReadLong(element, "totalTokens")
            ?? (input + output);
        return new SlaTokenUsage(input, output, total, true);
    }

    private static JsonElement? ReadUsageObject(JsonElement payload)
    {
        if (payload.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        if (TryGetObject(payload, "usage", out var usage))
        {
            return usage;
        }

        if (TryGetObject(payload, "sdkResult", out var sdkResult) && TryGetObject(sdkResult, "usage", out usage))
        {
            return usage;
        }

        if (TryGetObject(payload, "content", out var content) && TryGetObject(content, "sdkResult", out sdkResult) && TryGetObject(sdkResult, "usage", out usage))
        {
            return usage;
        }

        return null;
    }

    private static bool TryGetObject(JsonElement element, string propertyName, out JsonElement value)
    {
        if (element.ValueKind == JsonValueKind.Object
            && element.TryGetProperty(propertyName, out value)
            && value.ValueKind == JsonValueKind.Object)
        {
            return true;
        }

        value = default;
        return false;
    }

    private static long? ReadLong(JsonElement element, string propertyName)
    {
        if (element.ValueKind != JsonValueKind.Object || !element.TryGetProperty(propertyName, out var value))
        {
            return null;
        }

        if (value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out var number))
        {
            return number;
        }

        if (value.ValueKind == JsonValueKind.String && long.TryParse(value.GetString(), out number))
        {
            return number;
        }

        return null;
    }

    private readonly record struct SlaTokenUsage(
        long InputTokens,
        long OutputTokens,
        long TotalTokens,
        bool Observed)
    {
        public SlaTokenUsage Add(SlaTokenUsage other) =>
            new(
                InputTokens + other.InputTokens,
                OutputTokens + other.OutputTokens,
                TotalTokens + other.TotalTokens,
                Observed || other.Observed);
    }

    private static JsonElement ParsePayloadElement(string? payloadJson) =>
        TryParseJsonElement(payloadJson) ?? JsonSerializer.SerializeToElement(new { raw = payloadJson ?? string.Empty });

    private static JsonElement? TryParseJsonElement(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return null;
        try
        {
            using var doc = JsonDocument.Parse(json);
            return doc.RootElement.Clone();
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static string? ReadString(JsonElement element, string propertyName)
    {
        if (element.ValueKind != JsonValueKind.Object || !element.TryGetProperty(propertyName, out var value))
        {
            return null;
        }

        return value.ValueKind == JsonValueKind.String ? value.GetString() : value.ToString();
    }

    private static int CountLogLines(string logs) =>
        string.IsNullOrWhiteSpace(logs)
            ? 0
            : logs.Split('\n', StringSplitOptions.RemoveEmptyEntries).Length;

    private static string BuildEventTraceId(string sessionId) => $"infra-agent-session-{sessionId}";

    private async Task<string> ResolveTraceIdAsync(string sessionId, CancellationToken ct)
    {
        var traceId = await _db.InfraAgentSessions
            .Find(x => x.Id == sessionId)
            .Project(x => x.TraceId)
            .FirstOrDefaultAsync(ct);
        return string.IsNullOrWhiteSpace(traceId) ? BuildEventTraceId(sessionId) : traceId;
    }

    internal static string MapCdsStatus(string? status)
    {
        return status switch
        {
            "creating" => InfraAgentSessionStatuses.Creating,
            "queued" => InfraAgentSessionStatuses.Running,
            "running" => InfraAgentSessionStatuses.Running,
            "succeeded" => InfraAgentSessionStatuses.Running,
            "idle" => InfraAgentSessionStatuses.Idle,
            "stopping" => InfraAgentSessionStatuses.Stopping,
            "stopped" => InfraAgentSessionStatuses.Stopped,
            "failed" => InfraAgentSessionStatuses.Failed,
            _ => InfraAgentSessionStatuses.Idle
        };
    }

    internal static bool ShouldEndCdsFollowOnStatus(string mappedStatus) =>
        mappedStatus is InfraAgentSessionStatuses.Idle or InfraAgentSessionStatuses.Stopped;

    private static string? GetString(JsonElement element, string property)
    {
        return element.TryGetProperty(property, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;
    }

    private static bool GetBool(JsonElement element, string property) =>
        element.TryGetProperty(property, out var value) && value.ValueKind == JsonValueKind.True;

    private static IReadOnlyList<string> GetStringList(JsonElement element, string property)
    {
        if (!element.TryGetProperty(property, out var value) || value.ValueKind != JsonValueKind.Array)
        {
            return Array.Empty<string>();
        }

        return value.EnumerateArray()
            .Where(item => item.ValueKind == JsonValueKind.String)
            .Select(item => item.GetString())
            .Where(item => !string.IsNullOrWhiteSpace(item))
            .Select(item => item!)
            .ToList();
    }

    private static InfraAgentSession FromView(InfraAgentSessionView view)
    {
        return new InfraAgentSession
        {
            Id = view.Id,
            UserId = view.UserId,
            ConnectionId = view.ConnectionId,
            Partner = view.Partner,
            CdsProjectId = view.CdsProjectId,
            CdsSessionId = view.CdsSessionId,
            CdsWorkerId = view.CdsWorkerId,
            CdsContainerName = view.CdsContainerName,
            RuntimeProfileId = view.RuntimeProfileId,
            ModelBaseUrl = view.ModelBaseUrl,
            Runtime = view.Runtime,
            RuntimeAdapter = view.RuntimeAdapter,
            CurrentRuntimeRunId = view.CurrentRuntimeRunId,
            Model = view.Model,
            WorkspaceRoot = view.WorkspaceRoot,
            GitRepository = view.GitRepository,
            GitRef = view.GitRef,
            ResourceCpuCores = view.ResourceCpuCores,
            ResourceMemoryMb = view.ResourceMemoryMb,
            TimeoutSeconds = view.TimeoutSeconds,
            NetworkPolicy = view.NetworkPolicy,
            AutoCleanupMinutes = view.AutoCleanupMinutes,
            ToolPolicy = view.ToolPolicy,
            HookProfileId = view.HookProfileId,
            Title = view.Title,
            WorkloadKind = view.WorkloadKind,
            IsolationMode = view.IsolationMode,
            Status = view.Status,
            ManualTakeoverEnabled = view.ManualTakeoverEnabled,
            ManualTakeoverAt = view.ManualTakeoverAt,
            ManualTakeoverReason = view.ManualTakeoverReason,
            LastError = view.LastError,
            CreatedAt = view.CreatedAt,
            UpdatedAt = view.UpdatedAt,
            StartedAt = view.StartedAt,
            StoppedAt = view.StoppedAt
        };
    }
}

internal sealed record CdsStreamImportResult(
    string? SessionStatus,
    string? SessionError,
    bool TimedOut = false,
    int Attempts = 1);

internal sealed record CdsEventProjectionResult(
    string? SessionStatus,
    string? SessionError,
    bool EndFollow);

public sealed record InfraAgentRuntimeErrorStatus(
    string SessionError,
    bool Retryable,
    string RecoveryKind,
    IReadOnlyList<string> NextActions);
