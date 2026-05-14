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
    private readonly IClaudeSidecarRouter? _sidecarRouter;
    private readonly IAgentToolRegistry _toolRegistry;
    private readonly HttpClient _http;

    public InfraAgentSessionService(
        MongoDbContext db,
        ILogger<InfraAgentSessionService> logger,
        IInfraConnectionService connections,
        IInfraAgentRuntimeProfileService runtimeProfiles,
        IClaudeSidecarRouter? sidecarRouter,
        IAgentToolRegistry toolRegistry,
        HttpClient http)
    {
        _db = db;
        _logger = logger;
        _connections = connections;
        _runtimeProfiles = runtimeProfiles;
        _sidecarRouter = sidecarRouter;
        _toolRegistry = toolRegistry;
        _http = http;
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

        var connection = await _db.InfraConnections
            .Find(x => x.Id == request.ConnectionId)
            .FirstOrDefaultAsync(ct);
        if (connection == null)
        {
            throw new InfraAgentSessionException(
                InfraAgentSessionErrorCodes.ConnectionNotFound,
                "CDS 连接不存在",
                StatusCodes.Status404NotFound);
        }

        EnsureConnectionNotRevoked(connection);

        var now = DateTime.UtcNow;
        var sessionId = Guid.NewGuid().ToString("N");
        var session = new InfraAgentSession
        {
            Id = sessionId,
            UserId = userId,
            ConnectionId = connection.Id,
            Partner = connection.Partner,
            CdsProjectId = connection.ProjectId,
            TraceId = BuildEventTraceId(sessionId),
            RuntimeProfileId = NormalizeOptional(request.RuntimeProfileId),
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

        var connection = await GetActiveConnectionAsync(session.ConnectionId, ct);
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
            var runtimeProfile = await ResolveRuntimeProfileForSessionAsync(session.RuntimeProfileId, ct);
            var runtime = NormalizeRuntime(request.Runtime ?? runtimeProfile?.Runtime ?? session.Runtime);
            var model = NormalizeOptional(request.Model) ?? runtimeProfile?.Model ?? session.Model;
            var modelBaseUrl = runtimeProfile?.BaseUrl ?? session.ModelBaseUrl;
            var resourceCpuCores = runtimeProfile?.ResourceCpuCores ?? session.ResourceCpuCores;
            var resourceMemoryMb = runtimeProfile?.ResourceMemoryMb ?? session.ResourceMemoryMb;
            var timeoutSeconds = runtimeProfile?.TimeoutSeconds ?? session.TimeoutSeconds;
            var networkPolicy = runtimeProfile?.NetworkPolicy ?? session.NetworkPolicy;
            var autoCleanupMinutes = runtimeProfile?.AutoCleanupMinutes ?? session.AutoCleanupMinutes;
            await RunHookAsync(session, hookProfile, "beforeStart", hookProfile?.BeforeStart, blockOnFailure: true, ct);
            var body = new
            {
                runtime,
                model,
                modelBaseUrl,
                modelProtocol = runtimeProfile?.Protocol,
                modelApiKey = runtimeProfile?.ApiKey,
                runtimeProfileId = runtimeProfile?.Id ?? session.RuntimeProfileId,
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

        var connection = await GetActiveConnectionAsync(session.ConnectionId, ct);
        var token = await GetLongTokenAsync(connection.Id, ct);
        using var response = await SendCdsJsonAsync(
            HttpMethod.Post,
            connection,
            token,
            $"/api/projects/{Uri.EscapeDataString(session.CdsProjectId)}/agent-sessions/{Uri.EscapeDataString(session.CdsSessionId!)}/messages",
            new { content = request.Content.Trim() },
            ct);
        response.EnsureSuccessStatusCode();
        await ImportCdsStreamEventsAsync(connection, token, session, 0, ct);
        var runtimeOk = await RunSidecarRuntimeIfAvailableAsync(session, request.Content.Trim(), ct);
        if (!runtimeOk)
        {
            var failed = await FindOwnedSessionAsync(userId, id, ct);
            return failed == null ? null : ToView(failed);
        }

        session.UpdatedAt = DateTime.UtcNow;
        await _db.InfraAgentSessions.UpdateOneAsync(
            x => x.Id == id && x.UserId == userId,
            Builders<InfraAgentSession>.Update.Set(x => x.UpdatedAt, session.UpdatedAt).Set(x => x.Status, InfraAgentSessionStatuses.Running),
            cancellationToken: ct);
        session.Status = InfraAgentSessionStatuses.Running;
        return ToView(session);
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
            if (!string.IsNullOrWhiteSpace(session.CdsSessionId))
            {
                var hookProfile = await GetHookProfileAsync(session, ct);
                await RunHookAsync(session, hookProfile, "beforeStop", hookProfile?.BeforeStop, blockOnFailure: false, ct);
                var connection = await GetActiveConnectionAsync(session.ConnectionId, ct);
                var token = await GetLongTokenAsync(connection.Id, ct);
                using var response = await SendCdsJsonAsync(
                    HttpMethod.Post,
                    connection,
                    token,
                    $"/api/projects/{Uri.EscapeDataString(session.CdsProjectId)}/agent-sessions/{Uri.EscapeDataString(session.CdsSessionId)}/stop",
                    new { },
                    ct);
                response.EnsureSuccessStatusCode();
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
            .Set(x => x.LastError, null);

        await _db.InfraAgentSessions.UpdateOneAsync(
            x => x.Id == id && x.UserId == userId,
            update,
            cancellationToken: ct);

        session.Status = InfraAgentSessionStatuses.Stopped;
        session.UpdatedAt = now;
        session.StoppedAt = now;
        session.LastError = null;

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
            var connection = await GetActiveConnectionAsync(session.ConnectionId, ct);
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

        var connection = await GetActiveConnectionAsync(session.ConnectionId, ct);
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
                    && string.Equals(sourceElement.GetString(), "claude-sdk-sidecar", StringComparison.OrdinalIgnoreCase))
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
        EnsureConnectionNotRevoked(connection);
        return connection;
    }

    private static void EnsureConnectionNotRevoked(InfraConnection connection)
    {
        if (string.Equals(connection.Status, "revoked", StringComparison.OrdinalIgnoreCase))
        {
            throw new InfraAgentSessionException(
                InfraAgentSessionErrorCodes.ConnectionNotActive,
                "CDS 系统级授权已撤销，请删除后重新授权",
                StatusCodes.Status409Conflict);
        }
    }

    private async Task<string> GetLongTokenAsync(string connectionId, CancellationToken ct)
    {
        var token = await _connections.TryUnprotectLongTokenAsync(connectionId, ct);
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

    private async Task ImportCdsStreamEventsAsync(
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
        var stream = await response.Content.ReadAsStringAsync(ct);
        foreach (var block in stream.Split("\n\n", StringSplitOptions.RemoveEmptyEntries))
        {
            var dataLine = block.Split('\n').FirstOrDefault(line => line.StartsWith("data: ", StringComparison.Ordinal));
            if (dataLine == null || block.Contains("event: keepalive", StringComparison.Ordinal)) continue;
            using var doc = JsonDocument.Parse(dataLine["data: ".Length..]);
            var root = doc.RootElement;
            var type = GetString(root, "type") ?? InfraAgentEventTypes.Log;
            var payload = root.TryGetProperty("payload", out var payloadElement)
                ? payloadElement.GetRawText()
                : "{}";
            if (await HasImportedEventAsync(session.Id, type, payload, ct))
            {
                continue;
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
        }
    }

    private async Task<bool> RunSidecarRuntimeIfAvailableAsync(
        InfraAgentSession session,
        string content,
        CancellationToken ct)
    {
        if (!string.Equals(session.Runtime, InfraAgentRuntimes.ClaudeSdk, StringComparison.OrdinalIgnoreCase)
            && !string.Equals(session.Runtime, InfraAgentRuntimes.Custom, StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        if (_sidecarRouter == null || !_sidecarRouter.IsConfigured)
        {
            await AppendRawEventAsync(
                session.Id,
                await NextEventSeqAsync(session.Id, ct),
                InfraAgentEventTypes.Log,
                JsonSerializer.Serialize(new
                {
                    level = "warning",
                    source = "runtime-router",
                    message = "real sidecar is not configured; CDS fake runtime output is being used"
                }),
                ct);
            return true;
        }

        var runtimeProfile = await ResolveRuntimeProfileForSessionAsync(session.RuntimeProfileId, ct);
        var model = runtimeProfile?.Model ?? session.Model ?? "claude-opus-4-5";
        var runId = $"infra-agent-{session.Id}-{Guid.NewGuid():N}";
        var finalText = new StringBuilder();
        await AppendRawEventAsync(
            session.Id,
            await NextEventSeqAsync(session.Id, ct),
            InfraAgentEventTypes.Status,
            JsonSerializer.Serialize(new
            {
                status = "running",
                reason = "sidecar_runtime_started",
                runtime = session.Runtime,
                model,
                baseUrl = runtimeProfile?.BaseUrl ?? session.ModelBaseUrl,
                protocol = runtimeProfile?.Protocol,
                resourcePolicy = BuildResourcePolicy(session)
            }),
            ct);

        var request = new SidecarRunRequest
        {
            RunId = runId,
            Model = model,
            SystemPrompt = BuildAgentSystemPrompt(),
            Messages = new List<SidecarChatMessage>
            {
                new() { Role = "user", Content = content }
            },
            Tools = BuildSidecarToolDefs(),
            MaxTokens = 4096,
            MaxTurns = 12,
            TimeoutSeconds = NormalizeRuntimeTimeout(session.TimeoutSeconds),
            AppCallerCode = "infra-agent-session::agent",
            StickyKey = session.CdsSessionId ?? session.Id,
            BaseUrl = runtimeProfile?.BaseUrl ?? session.ModelBaseUrl,
            ApiKey = runtimeProfile?.ApiKey,
            Protocol = runtimeProfile?.Protocol
        };

        await AppendRawEventAsync(
            session.Id,
            await NextEventSeqAsync(session.Id, ct),
            InfraAgentEventTypes.Log,
            JsonSerializer.Serialize(new
            {
                level = "info",
                source = "runtime-router",
                message = $"sidecar tools exposed count={request.Tools.Count} timeout={request.TimeoutSeconds}s cpu={session.ResourceCpuCores} memory={session.ResourceMemoryMb}MB network={session.NetworkPolicy}"
            }),
            ct);

        await foreach (var ev in _sidecarRouter.RunStreamAsync(request, ct))
        {
            var seq = await NextEventSeqAsync(session.Id, ct);
            switch (ev.Type)
            {
                case SidecarEventType.TextDelta:
                    if (!string.IsNullOrEmpty(ev.Text))
                    {
                        finalText.Append(ev.Text);
                        await AppendRawEventAsync(session.Id, seq, InfraAgentEventTypes.TextDelta, JsonSerializer.Serialize(new
                        {
                            messageId = runId,
                            text = ev.Text,
                            source = "claude-sdk-sidecar",
                            sidecar = ev.SidecarName
                        }), ct);
                    }
                    break;
                case SidecarEventType.ToolUse:
                    await AppendRawEventAsync(session.Id, seq, InfraAgentEventTypes.ToolCall, JsonSerializer.Serialize(new
                    {
                        approvalId = ev.ToolUseId ?? $"tool-{seq}",
                        toolName = ev.ToolName ?? "sidecar_tool",
                        argsSummary = ev.ToolInput?.GetRawText() ?? "{}",
                        risk = "dangerous",
                        status = "waiting",
                        source = "claude-sdk-sidecar",
                        sidecar = ev.SidecarName
                    }), ct);
                    break;
                case SidecarEventType.ToolResult:
                    await AppendRawEventAsync(session.Id, seq, InfraAgentEventTypes.ToolResult, JsonSerializer.Serialize(new
                    {
                        approvalId = ev.ToolUseId,
                        decision = "completed",
                        resultSummary = ev.Content,
                        source = "claude-sdk-sidecar",
                        sidecar = ev.SidecarName
                    }), ct);
                    break;
                case SidecarEventType.Usage:
                    await AppendRawEventAsync(session.Id, seq, InfraAgentEventTypes.Log, JsonSerializer.Serialize(new
                    {
                        level = "info",
                        source = "claude-sdk-sidecar",
                        inputTokens = ev.InputTokens,
                        outputTokens = ev.OutputTokens,
                        sidecar = ev.SidecarName
                    }), ct);
                    break;
                case SidecarEventType.Done:
                    var doneText = ev.FinalText ?? finalText.ToString();
                    await AppendRawEventAsync(session.Id, seq, InfraAgentEventTypes.Done, JsonSerializer.Serialize(new
                    {
                        messageId = runId,
                        finalText = doneText,
                        source = "claude-sdk-sidecar",
                        sidecar = ev.SidecarName
                    }), ct);
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
                case SidecarEventType.Error:
                    var errorMessage = ev.Message ?? ev.ErrorCode ?? "unknown";
                    await AppendRawEventAsync(session.Id, seq, InfraAgentEventTypes.Error, JsonSerializer.Serialize(new
                    {
                        code = ev.ErrorCode,
                        message = errorMessage,
                        retryable = true,
                        source = "claude-sdk-sidecar",
                        sidecar = ev.SidecarName
                    }), ct);
                    await MarkRuntimeFailedAsync(session, $"Claude SDK sidecar 执行失败：{errorMessage}", ct);
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
            TraceId = BuildEventTraceId(sessionId),
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
            TraceId = BuildEventTraceId(sessionId),
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
                .Set(x => x.UpdatedAt, now),
            cancellationToken: ct);
        session.Status = InfraAgentSessionStatuses.Failed;
        session.LastError = error;
        session.UpdatedAt = now;
    }

    private List<SidecarToolDef> BuildSidecarToolDefs()
    {
        var tools = new List<SidecarToolDef>();
        foreach (var descriptor in _toolRegistry.ListAll())
        {
            try
            {
                using var schema = JsonDocument.Parse(descriptor.InputSchemaJson);
                tools.Add(new SidecarToolDef
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
            InfraAgentRuntimes.Codex => InfraAgentRuntimes.Codex,
            InfraAgentRuntimes.Custom => InfraAgentRuntimes.Custom,
            _ => InfraAgentRuntimes.ClaudeSdk
        };
    }

    private static string NormalizeToolPolicy(string? policy)
    {
        var normalized = NormalizeOptional(policy);
        return normalized is "auto-allow-readonly" or "confirm-dangerous" or "deny-all"
            ? normalized
            : "confirm-dangerous";
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
        string? runtimeProfileId,
        CancellationToken ct)
    {
        try
        {
            return await _runtimeProfiles.ResolveAsync(runtimeProfileId, ct);
        }
        catch (InfraAgentRuntimeProfileException ex)
        {
            throw new InfraAgentSessionException(
                InfraAgentSessionErrorCodes.RuntimeProfileInvalid,
                ex.Message,
                ex.HttpStatus);
        }
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
        session.Model,
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

    private static string BuildEventTraceId(string sessionId) => $"infra-agent-session-{sessionId}";

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
            Model = view.Model,
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
