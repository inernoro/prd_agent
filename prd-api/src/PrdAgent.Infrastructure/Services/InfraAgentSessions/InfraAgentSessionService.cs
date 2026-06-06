using System.Text.Json;
using System.Text;
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
        var session = new InfraAgentSession
        {
            Id = sessionId,
            UserId = userId,
            ConnectionId = connection.Id,
            Partner = connection.Partner,
            CdsProjectId = connection.ProjectId,
            TraceId = NormalizeOptional(request.TraceId) ?? BuildEventTraceId(sessionId),
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
            AutoCleanupMinutes = 30,
            ToolPolicy = NormalizeToolPolicy(request.ToolPolicy),
            HookProfileId = NormalizeOptional(request.HookProfileId),
            Title = NormalizeTitle(request.Title),
            Status = InfraAgentSessionStatuses.Idle,
            CreatedAt = now,
            UpdatedAt = now
        };

        await _db.InfraAgentSessions.InsertOneAsync(session, cancellationToken: ct);
        await AppendStatusEventAsync(session.Id, 1, session.Status, "session_created", ct);

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
        if (!string.IsNullOrWhiteSpace(session.CdsSessionId) && session.Status == InfraAgentSessionStatuses.Running)
        {
            return ToView(session);
        }

        var connection = await GetActiveConnectionAsync(session, ct);
        var token = await GetLongTokenAsync(connection.Id, ct);
        var now = DateTime.UtcNow;
        var hookProfile = await GetHookProfileAsync(session, ct);
        await _db.InfraAgentSessions.UpdateOneAsync(
            x => x.Id == id && x.UserId == userId,
            Builders<InfraAgentSession>.Update
                .Set(x => x.Status, InfraAgentSessionStatuses.Creating)
                .Set(x => x.UpdatedAt, now)
                .Set(x => x.LastError, null),
            cancellationToken: ct);

        try
        {
            var runtimeProfile = await ResolveRuntimeProfileForSessionAsync(userId, session.RuntimeProfileId, ct);
            var runtime = NormalizeRuntime(request.Runtime ?? runtimeProfile?.Runtime ?? session.Runtime);
            var model = NormalizeOptional(request.Model) ?? runtimeProfile?.Model ?? session.Model;
            var modelBaseUrl = runtimeProfile?.BaseUrl ?? session.ModelBaseUrl;
            var resourceCpuCores = runtimeProfile?.ResourceCpuCores ?? session.ResourceCpuCores;
            var resourceMemoryMb = runtimeProfile?.ResourceMemoryMb ?? session.ResourceMemoryMb;
            var timeoutSeconds = runtimeProfile?.TimeoutSeconds ?? session.TimeoutSeconds;
            var networkPolicy = runtimeProfile?.NetworkPolicy ?? session.NetworkPolicy;
            var autoCleanupMinutes = runtimeProfile?.AutoCleanupMinutes ?? session.AutoCleanupMinutes;
            EnsureRuntimeProfileCompatibleOrLiteFallback(runtime, runtimeProfile, ResolveSidecarRuntimeAdapter());
            await RunHookAsync(session, hookProfile, "beforeStart", hookProfile?.BeforeStart, blockOnFailure: true, ct);
            var body = new
            {
                runtime,
                model,
                modelBaseUrl,
                modelProtocol = runtimeProfile?.Protocol,
                modelApiKey = runtimeProfile?.ApiKey,
                runtimeProfileId = runtimeProfile?.Id ?? session.RuntimeProfileId,
                workspaceRoot = session.WorkspaceRoot,
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
                hookProfileId = session.HookProfileId
            };
            using var response = await SendCdsJsonAsync(
                HttpMethod.Post,
                connection,
                token,
                $"/api/projects/{Uri.EscapeDataString(session.CdsProjectId)}/agent-sessions",
                body,
                ct);
            var item = await ReadCdsItemAsync(response, ct);
            var cdsSessionId = GetString(item, "id");
            var workerId = GetString(item, "workerId");
            var containerName = GetString(item, "containerName");
            var status = MapCdsStatus(GetString(item, "status"));
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
                .Set(x => x.StartedAt, now)
                .Set(x => x.UpdatedAt, now)
                .Set(x => x.LastError, null);
            await _db.InfraAgentSessions.UpdateOneAsync(x => x.Id == id && x.UserId == userId, update, cancellationToken: ct);

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
            session.StartedAt = now;
            session.UpdatedAt = now;
            session.LastError = null;
            await AppendStatusEventAsync(session.Id, await NextEventSeqAsync(session.Id, ct), session.Status, "cds_session_started", ct);
            await RunHookAsync(session, hookProfile, "afterStart", hookProfile?.AfterStart, blockOnFailure: false, ct);
            return ToView(session);
        }
        catch (Exception ex)
        {
            await MarkFailedAsync(session, ex.Message, ct);
            if (ex is InfraAgentSessionException) throw;
            throw new InfraAgentSessionException(
                InfraAgentSessionErrorCodes.CdsRequestFailed,
                $"CDS 创建会话失败：{ex.Message}",
                StatusCodes.Status502BadGateway);
        }
    }

    public async Task<InfraAgentSessionView?> GetAsync(string userId, string id, CancellationToken ct)
    {
        var session = await FindOwnedSessionAsync(userId, id, ct);
        return session == null ? null : ToView(session);
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

        if (string.IsNullOrWhiteSpace(session.CdsSessionId))
        {
            var started = await StartAsync(userId, id, new StartInfraAgentSessionRequest(session.Runtime, session.Model), ct);
            if (started == null) return null;
            session = FromView(started);
        }

        var now = DateTime.UtcNow;
        await _db.InfraAgentMessages.InsertOneAsync(new InfraAgentMessage
        {
            SessionId = id,
            Role = InfraAgentMessageRoles.User,
            Content = request.Content.Trim(),
            Status = InfraAgentMessageStatuses.Completed,
            CreatedAt = now
        }, cancellationToken: ct);

        var connection = await GetActiveConnectionAsync(session, ct);
        var token = await GetLongTokenAsync(connection.Id, ct);
        var cdsItem = await PostMessageToCdsAsync(connection, token, session, request.Content.Trim(), ct);
        var cdsStatus = MapCdsStatus(GetString(cdsItem, "status"));

        session.UpdatedAt = DateTime.UtcNow;
        await _db.InfraAgentSessions.UpdateOneAsync(
            x => x.Id == id && x.UserId == userId,
            Builders<InfraAgentSession>.Update.Set(x => x.UpdatedAt, session.UpdatedAt).Set(x => x.Status, cdsStatus),
            cancellationToken: ct);
        session.Status = cdsStatus;
        // 关键修复：不再内联阻塞导入。旧实现 await ImportCdsStreamEventsAsync 把整段 CDS 流读完才返回，
        // 表现为「发送卡 2 秒 → 一直等 → 死掉」。改为消息 POST 到 CDS 后立即入队，由
        // InfraAgentRuntimeWorker 后台拉流落库（与 HTTP 请求生命周期解耦，server-authority），
        // 前端 GET {id}/stream 的长连 SSE 实时呈现逐字。POST 毫秒级返回。
        await _runtimeJobs.EnqueueAsync(
            new InfraAgentRuntimeJob(userId, session.Id, request.Content.Trim(), DateTime.UtcNow), ct);
        _logger.LogDebug(
            "[infra-agent] message posted to CDS, stream import dispatched to background worker (session={SessionId})",
            session.Id);
        return ToView(session);

        async Task<JsonElement> PostMessageToCdsAsync(
            InfraConnection currentConnection,
            string currentToken,
            InfraAgentSession currentSession,
            string content,
            CancellationToken cancellationToken)
        {
            try
            {
                using var postResponse = await SendCdsJsonAsync(
                    HttpMethod.Post,
                    currentConnection,
                    currentToken,
                    $"/api/projects/{Uri.EscapeDataString(currentSession.CdsProjectId)}/agent-sessions/{Uri.EscapeDataString(currentSession.CdsSessionId!)}/messages",
                    new { content },
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
                await _db.InfraAgentSessions.UpdateOneAsync(
                    x => x.Id == currentSession.Id && x.UserId == userId,
                    Builders<InfraAgentSession>.Update
                        .Set(x => x.CdsSessionId, null)
                        .Set(x => x.Status, InfraAgentSessionStatuses.Idle)
                        .Set(x => x.LastError, null),
                    cancellationToken: cancellationToken);
                currentSession.CdsSessionId = null;
                currentSession.Status = InfraAgentSessionStatuses.Idle;

                var restarted = await StartAsync(userId, currentSession.Id, new StartInfraAgentSessionRequest(currentSession.Runtime, currentSession.Model), cancellationToken);
                if (restarted == null)
                {
                    throw;
                }
                currentSession = FromView(restarted);
                currentConnection = await GetActiveConnectionAsync(currentSession, cancellationToken);
                currentToken = await GetLongTokenAsync(currentConnection.Id, cancellationToken);
                using var retryResponse = await SendCdsJsonAsync(
                    HttpMethod.Post,
                    currentConnection,
                    currentToken,
                    $"/api/projects/{Uri.EscapeDataString(currentSession.CdsProjectId)}/agent-sessions/{Uri.EscapeDataString(currentSession.CdsSessionId!)}/messages",
                    new { content },
                    cancellationToken);
                session = currentSession;
                connection = currentConnection;
                token = currentToken;
                return await ReadCdsItemAsync(retryResponse, cancellationToken);
            }
        }
    }

    public async Task RunRuntimeJobAsync(string userId, string id, string content, CancellationToken ct)
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
            try
            {
                var connection = await GetActiveConnectionAsync(session, CancellationToken.None);
                var token = await GetLongTokenAsync(connection.Id, CancellationToken.None);
                // server-authority：用 CancellationToken.None，客户端断开 / worker 调度不打断 agent 运行。
                var importResult = await ImportCdsStreamEventsAsync(connection, token, session, 0, CancellationToken.None);
                if (!string.IsNullOrWhiteSpace(importResult.SessionStatus))
                {
                    await _db.InfraAgentSessions.UpdateOneAsync(
                        x => x.Id == session.Id,
                        Builders<InfraAgentSession>.Update
                            .Set(x => x.Status, importResult.SessionStatus)
                            .Set(x => x.UpdatedAt, DateTime.UtcNow),
                        cancellationToken: CancellationToken.None);
                }
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
            x => x.Id == id && x.UserId == userId,
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

    public async Task<InfraAgentSessionView?> StopAsync(string userId, string id, CancellationToken ct)
    {
        var session = await FindOwnedSessionAsync(userId, id, ct);
        if (session == null) return null;

        if (session.Status == InfraAgentSessionStatuses.Stopped)
        {
            return ToView(session);
        }

        var stoppingAt = DateTime.UtcNow;
        await _db.InfraAgentSessions.UpdateOneAsync(
            x => x.Id == id && x.UserId == userId,
            Builders<InfraAgentSession>.Update
                .Set(x => x.Status, InfraAgentSessionStatuses.Stopping)
                .Set(x => x.UpdatedAt, stoppingAt),
            cancellationToken: ct);
        session.Status = InfraAgentSessionStatuses.Stopping;
        session.UpdatedAt = stoppingAt;
        await AppendStatusEventAsync(session.Id, await NextEventSeqAsync(session.Id, ct), session.Status, "session_stop_requested", ct);

        try
        {
            var cancelAdapter = ResolveAdapterByKind(session.RuntimeAdapter);
            if (!string.IsNullOrWhiteSpace(session.CurrentRuntimeRunId) && cancelAdapter != null)
            {
                var cancel = await cancelAdapter.CancelAsync(session.CurrentRuntimeRunId, ct);
                await AppendRawEventAsync(
                    session.Id,
                    await NextEventSeqAsync(session.Id, ct),
                    InfraAgentEventTypes.Log,
                    JsonSerializer.Serialize(new
                    {
                        level = cancel.Cancelled ? "info" : "warning",
                        source = "runtime-adapter",
                        runtimeAdapter = cancel.AdapterKind ?? session.RuntimeAdapter,
                        runtimeRunId = session.CurrentRuntimeRunId,
                        message = cancel.Cancelled
                            ? "runtime run cancel requested"
                            : $"runtime run cancel did not complete: {cancel.Reason ?? "unknown"}"
                    }),
                    ct);
            }

            if (!string.IsNullOrWhiteSpace(session.CdsSessionId))
            {
                var hookProfile = await GetHookProfileAsync(session, ct);
                await RunHookAsync(session, hookProfile, "beforeStop", hookProfile?.BeforeStop, blockOnFailure: false, ct);
                var connection = await GetActiveConnectionAsync(session, ct);
                var token = await GetLongTokenAsync(connection.Id, ct);
                try
                {
                    using var response = await SendCdsJsonAsync(
                        HttpMethod.Post,
                        connection,
                        token,
                        $"/api/projects/{Uri.EscapeDataString(session.CdsProjectId)}/agent-sessions/{Uri.EscapeDataString(session.CdsSessionId)}/stop",
                        new { },
                        ct);
                    response.EnsureSuccessStatusCode();
                }
                catch (InfraAgentSessionException ex) when (IsCdsSessionNotFound(ex))
                {
                    await AppendRawEventAsync(
                        session.Id,
                        await NextEventSeqAsync(session.Id, ct),
                        InfraAgentEventTypes.Log,
                        JsonSerializer.Serialize(new
                        {
                            level = "warning",
                            source = "cds-session-transport",
                            message = "remote CDS session was already gone; marking MAP session stopped",
                            oldCdsSessionId = session.CdsSessionId
                        }),
                        ct);
                }
                await RunHookAsync(session, hookProfile, "afterStop", hookProfile?.AfterStop, blockOnFailure: false, ct);
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            await MarkFailedAsync(session, ex.Message, ct);
            if (ex is InfraAgentSessionException) throw;
            throw new InfraAgentSessionException(
                InfraAgentSessionErrorCodes.CdsRequestFailed,
                $"停止 CDS Agent 会话失败：{ex.Message}",
                StatusCodes.Status502BadGateway);
        }

        var now = DateTime.UtcNow;
        var update = Builders<InfraAgentSession>.Update
            .Set(x => x.Status, InfraAgentSessionStatuses.Stopped)
            .Set(x => x.UpdatedAt, now)
            .Set(x => x.StoppedAt, now)
            .Set(x => x.LastError, null)
            .Set(x => x.CurrentRuntimeRunId, null);

        await _db.InfraAgentSessions.UpdateOneAsync(
            x => x.Id == id && x.UserId == userId,
            update,
            cancellationToken: ct);

        session.Status = InfraAgentSessionStatuses.Stopped;
        session.UpdatedAt = now;
        session.StoppedAt = now;
        session.LastError = null;
        session.CurrentRuntimeRunId = null;

        var nextSeq = await NextEventSeqAsync(session.Id, ct);
        await AppendStatusEventAsync(session.Id, nextSeq, session.Status, "session_stopped", ct);

        return ToView(session);
    }

    public async Task<InfraAgentSessionView?> ArchiveAsync(string userId, string id, CancellationToken ct)
    {
        var session = await FindOwnedSessionAsync(userId, id, ct);
        if (session == null) return null;

        if (session.Status is InfraAgentSessionStatuses.Running
            or InfraAgentSessionStatuses.Creating
            or InfraAgentSessionStatuses.Stopping)
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
            await AppendRawEventAsync(session.Id, seq + 1, InfraAgentEventTypes.ToolResult, JsonSerializer.Serialize(new
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
            await AppendRawEventAsync(session.Id, seq + 1, InfraAgentEventTypes.ToolResult, JsonSerializer.Serialize(new
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
        await AppendRawEventAsync(session.Id, seq + 1, InfraAgentEventTypes.ToolResult, JsonSerializer.Serialize(new
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
        await AppendRawEventAsync(session.Id, seq + 1, InfraAgentEventTypes.ToolResult, JsonSerializer.Serialize(new
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

        var take = Math.Clamp(limit <= 0 ? 100 : limit, 1, 500);
        var items = await _db.InfraAgentEvents
            .Find(x => x.SessionId == sessionId && x.Seq > afterSeq)
            .SortBy(x => x.Seq)
            .Limit(take)
            .ToListAsync(ct);
        return items.Select(ToEventView).ToList();
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

        var take = Math.Clamp(limit <= 0 ? 100 : limit, 1, 500);
        var items = await _db.InfraAgentMessages
            .Find(x => x.SessionId == sessionId)
            .SortBy(x => x.CreatedAt)
            .Limit(take)
            .ToListAsync(ct);
        return items.Select(ToMessageView).ToList();
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

    private async Task<HttpResponseMessage> SendCdsJsonAsync(
        HttpMethod method,
        InfraConnection connection,
        string token,
        string path,
        object? body,
        CancellationToken ct)
    {
        var baseUrl = connection.PartnerBaseUrl.TrimEnd('/');
        using var request = new HttpRequestMessage(method, $"{baseUrl}{path}");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        if (body != null)
        {
            request.Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");
        }
        var response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
        if (!response.IsSuccessStatusCode)
        {
            var text = await response.Content.ReadAsStringAsync(ct);
            throw new InfraAgentSessionException(
                InfraAgentSessionErrorCodes.CdsRequestFailed,
                $"CDS 请求失败：HTTP {(int)response.StatusCode} {text}",
                StatusCodes.Status502BadGateway);
        }
        return response;
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
        }
    }

    private async Task<CdsStreamImportResult> ImportCdsStreamEventsAsync(
        InfraConnection connection,
        string token,
        InfraAgentSession session,
        long afterSeq,
        CancellationToken ct)
    {
        using var response = await SendCdsJsonAsync(
            HttpMethod.Get,
            connection,
            token,
            $"/api/projects/{Uri.EscapeDataString(session.CdsProjectId)}/agent-sessions/{Uri.EscapeDataString(session.CdsSessionId!)}/stream?afterSeq={afterSeq}",
            null,
            ct);
        using var reader = new StreamReader(await response.Content.ReadAsStreamAsync(ct));
        string? sessionStatus = null;
        string? sessionError = null;
        // 增量读取：CDS 的 SSE 块以空行分隔，逐块到达即解析落库，前端 /stream SSE 立即转发，
        // 实现真流式。旧实现 ReadAsStringAsync 会阻塞到整段流读完、事件全堆到结尾，
        // 表现为「不流式 + 很久不返回」。SendCdsJsonAsync 已用 ResponseHeadersRead，可增量读。
        var blockBuilder = new System.Text.StringBuilder();
        string? line;
        while ((line = await reader.ReadLineAsync(ct)) != null)
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
            if (await HasImportedEventAsync(session.Id, type, payload, ct))
            {
                return;
            }

            await AppendRawEventAsync(session.Id, await NextEventSeqAsync(session.Id, ct), type, payload, ct);

            if (type == InfraAgentEventTypes.Done && root.TryGetProperty("payload", out var donePayload))
            {
                var finalText = GetString(donePayload, "finalText");
                if (!string.IsNullOrWhiteSpace(finalText))
                {
                    await _db.InfraAgentMessages.InsertOneAsync(new InfraAgentMessage
                    {
                        SessionId = session.Id,
                        Role = InfraAgentMessageRoles.Assistant,
                        Content = finalText,
                        Status = InfraAgentMessageStatuses.Completed,
                        CreatedAt = DateTime.UtcNow
                    }, cancellationToken: ct);
                }
            }
            else if (type == InfraAgentEventTypes.Error && root.TryGetProperty("payload", out var errorPayload))
            {
                var errorMessage = GetString(errorPayload, "message") ?? "CDS-managed runtime returned an error";
                var errorStatus = BuildRuntimeErrorStatus(
                    GetString(errorPayload, "code"),
                    errorMessage,
                    ExtractRuntimeErrorContentJson(errorPayload));
                await MarkRuntimeFailedAsync(session, errorStatus.SessionError, ct);
                sessionStatus = InfraAgentSessionStatuses.Failed;
                sessionError = errorStatus.SessionError;
            }
        }
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
        await _db.InfraAgentSessions.UpdateOneAsync(
            x => x.Id == session.Id,
            Builders<InfraAgentSession>.Update
                .Set(x => x.CurrentRuntimeRunId, runId)
                .Set(x => x.RuntimeAdapter, activeAdapterKind)
                .Set(x => x.UpdatedAt, DateTime.UtcNow),
            cancellationToken: ct);
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

        var request = new InfraAgentRuntimeRunRequest
        {
            RunId = runId,
            Model = model,
            SystemPrompt = BuildAgentSystemPrompt(),
            Messages = new List<InfraAgentRuntimeMessage>
            {
                new() { Role = "user", Content = content }
            },
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
                    await _db.InfraAgentSessions.UpdateOneAsync(
                        x => x.Id == session.Id,
                        Builders<InfraAgentSession>.Update
                            .Set(x => x.CurrentRuntimeRunId, null)
                            .Set(x => x.UpdatedAt, DateTime.UtcNow),
                        cancellationToken: ct);
                    session.CurrentRuntimeRunId = null;
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

    private async Task<long> NextEventSeqAsync(string sessionId, CancellationToken ct)
    {
        var latest = await _db.InfraAgentEvents
            .Find(x => x.SessionId == sessionId)
            .SortByDescending(x => x.Seq)
            .Limit(1)
            .FirstOrDefaultAsync(ct);
        return (latest?.Seq ?? 0) + 1;
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

    private async Task AppendRawEventAsync(
        string sessionId,
        long seq,
        string type,
        string payloadJson,
        CancellationToken ct)
    {
        var evt = new InfraAgentEvent
        {
            SessionId = sessionId,
            Seq = seq,
            TraceId = await ResolveTraceIdAsync(sessionId, ct),
            Type = InfraAgentEventTypes.IsKnown(type) ? type : InfraAgentEventTypes.Log,
            PayloadJson = string.IsNullOrWhiteSpace(payloadJson) ? "{}" : payloadJson,
            CreatedAt = DateTime.UtcNow
        };
        await _db.InfraAgentEvents.InsertOneAsync(evt, cancellationToken: ct);
    }

    private async Task<bool> HasImportedEventAsync(
        string sessionId,
        string type,
        string payloadJson,
        CancellationToken ct)
    {
        var normalizedPayload = string.IsNullOrWhiteSpace(payloadJson) ? "{}" : payloadJson;
        return await _db.InfraAgentEvents
            .Find(x => x.SessionId == sessionId && x.Type == type && x.PayloadJson == normalizedPayload)
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
            seq + 1,
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
        await _db.InfraAgentSessions.UpdateOneAsync(
            x => x.Id == session.Id,
            Builders<InfraAgentSession>.Update
                .Set(x => x.Status, InfraAgentSessionStatuses.Failed)
                .Set(x => x.LastError, error)
                .Set(x => x.UpdatedAt, now),
            cancellationToken: ct);
        await AppendRawEventAsync(session.Id, await NextEventSeqAsync(session.Id, ct), InfraAgentEventTypes.Error, JsonSerializer.Serialize(new { message = error }), ct);
    }

    private async Task MarkRuntimeFailedAsync(InfraAgentSession session, string error, CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        await _db.InfraAgentSessions.UpdateOneAsync(
            x => x.Id == session.Id,
            Builders<InfraAgentSession>.Update
                .Set(x => x.Status, InfraAgentSessionStatuses.Failed)
                .Set(x => x.LastError, error)
                .Set(x => x.CurrentRuntimeRunId, null)
                .Set(x => x.UpdatedAt, now),
            cancellationToken: ct);
        session.Status = InfraAgentSessionStatuses.Failed;
        session.LastError = error;
        session.CurrentRuntimeRunId = null;
        session.UpdatedAt = now;
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
            InfraAgentRuntimes.Custom => InfraAgentRuntimes.Custom,
            _ => InfraAgentRuntimes.ClaudeSdk
        };
    }

    private static string NormalizeToolPolicy(string? policy)
    {
        return InfraAgentToolPolicies.Normalize(policy);
    }

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
        session.ModelBaseUrl);

    private static InfraAgentEventView ToEventView(InfraAgentEvent evt) => new(
        evt.Id,
        evt.SessionId,
        evt.Seq,
        string.IsNullOrWhiteSpace(evt.TraceId) ? BuildEventTraceId(evt.SessionId) : evt.TraceId,
        evt.Type,
        evt.PayloadJson,
        evt.CreatedAt);

    private static InfraAgentMessageView ToMessageView(InfraAgentMessage msg) => new(
        msg.Id,
        msg.SessionId,
        msg.Role,
        msg.Content,
        msg.Status,
        msg.CreatedAt);

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

    private static string MapCdsStatus(string? status)
    {
        return status switch
        {
            "creating" => InfraAgentSessionStatuses.Creating,
            "running" => InfraAgentSessionStatuses.Running,
            "idle" => InfraAgentSessionStatuses.Idle,
            "stopping" => InfraAgentSessionStatuses.Stopping,
            "stopped" => InfraAgentSessionStatuses.Stopped,
            "failed" => InfraAgentSessionStatuses.Failed,
            _ => InfraAgentSessionStatuses.Idle
        };
    }

    private static string? GetString(JsonElement element, string property)
    {
        return element.TryGetProperty(property, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;
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

internal sealed record CdsStreamImportResult(string? SessionStatus, string? SessionError);

public sealed record InfraAgentRuntimeErrorStatus(
    string SessionError,
    bool Retryable,
    string RecoveryKind,
    IReadOnlyList<string> NextActions);
