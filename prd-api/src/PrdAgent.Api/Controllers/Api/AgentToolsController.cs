using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Options;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Security;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services.ClaudeSidecar;
using PrdAgent.Infrastructure.Services.InfraAgentSessions;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// claude-sdk Sidecar 反向调用主服务工具的入口。
///
/// 调用源：Python sidecar 的 ToolBridge（`claude-sdk-sidecar/app/tool_bridge.py`）
/// 鉴权方式：任务续接凭据绑定主体、运行、期限、工具与运行时配置。共享 sidecar token 不授权工具。
/// </summary>
[ApiController]
[Route("api/agent-tools")]
public class AgentToolsController : ControllerBase
{
    private readonly IAgentToolRegistry _registry;
    private readonly IOptionsMonitor<ClaudeSidecarOptions> _options;
    private readonly ILogger<AgentToolsController> _logger;
    private readonly MongoDbContext _db;
    private readonly IInfraConnectionService _infraConnections;

    private readonly IChatAgentOneOffRunRegistry _oneOffRuns;

    public AgentToolsController(
        IAgentToolRegistry registry,
        IOptionsMonitor<ClaudeSidecarOptions> options,
        ILogger<AgentToolsController> logger,
        MongoDbContext db,
        IInfraConnectionService infraConnections,
        IChatAgentOneOffRunRegistry oneOffRuns)
    {
        _registry = registry;
        _options = options;
        _logger = logger;
        _db = db;
        _infraConnections = infraConnections;
        _oneOffRuns = oneOffRuns;
    }

    [HttpGet("list")]
    public async Task<IActionResult> List([FromQuery] string runId)
    {
        if (!ValidateToken(out var why))
        {
            _logger.LogWarning("[AgentTools] /list 401 reason={Reason}", why);
            return Unauthorized(new { error = why });
        }

        var grant = await Authorize(runId, "run");
        if (grant is null) return StatusCode(403);
        var tools = _registry.Filter(grant.Tools).Select(t => new
        {
            name = t.Name,
            description = t.Description,
            inputSchema = JsonSerializer.Deserialize<JsonElement>(t.InputSchemaJson),
        });
        return Ok(new { tools });
    }

    [HttpPost("invoke")]
    public async Task<IActionResult> Invoke(
        [FromBody] InvokeRequest req,
        CancellationToken ct)
    {
        if (!ValidateToken(out var why))
        {
            _logger.LogWarning("[AgentTools] /invoke 401 reason={Reason}", why);
            return Unauthorized(new { error = why });
        }

        if (req == null || string.IsNullOrWhiteSpace(req.ToolName))
            return BadRequest(new { error = "toolName required" });

        var grant = await Authorize(req.RunId ?? "", "callback", req.ToolName);
        if (grant is null) return StatusCode(403);
        var runState = await Replay.ControlRunAsync(Binding(grant, "", ""), "status", ct);
        if (runState.Result != ReplayResult.Accepted) return ReplayDenied(runState.Result);
        if (runState.State != "running") return StatusCode(403, new { error = "run_not_active" });
        var session = await FindSessionByRunIdAsync(req.RunId, ct);
        if (session is not null && session.UserId != grant.Subject
            || session is null && req.RunId?.StartsWith("infra-agent-", StringComparison.Ordinal) == true)
            return StatusCode(403);
        var connection = await ResolveSessionConnectionAsync(session, ct);
        var cdsToken = connection == null
            ? null
            : await _infraConnections.TryUnprotectLongTokenAsync(connection.Id, ct, revokeOnFailure: false);

        var inputElement = req.Input ?? JsonDocument.Parse("{}").RootElement;
        var ctx = new AgentToolInvocationContext
        {
            RunId = req.RunId ?? string.Empty,
            AppCallerCode = grant.Runtime.AppCallerCode,
            SidecarName = Request.Headers["X-Sidecar-Name"].FirstOrDefault(),
            InfraAgentSessionId = session?.Id,
            // 主体由任务签发时冻结，不能由请求或 runId 猜测。
            UserId = grant.Subject,
            ApprovalId = req.ApprovalId,
            CdsBaseUrl = connection?.PartnerBaseUrl,
            CdsProjectId = connection?.ProjectId,
            CdsLongToken = cdsToken,
        };

        var continuation = await HttpContext.RequestServices.GetRequiredService<TaskContinuationTokens>().ValidateAsync(
            Request.Headers["X-Sidecar-Token"].ToString(), req.RunId ?? "", ctx.UserId);
        if (continuation is null) return StatusCode(403, new { error = "任务工具授权已失效，未执行工具；请查看任务状态。" });
        using var taskExecution = TaskExecutionContext.Enter(continuation);
        var approval = await ResolveToolApprovalAsync(req.RunId, req.ToolName, req.ApprovalId, TimeSpan.Zero, ct);
        if (!approval.Allowed)
        {
            return Ok(new
            {
                success = false,
                content = "",
                errorCode = approval.ErrorCode,
                message = approval.Message
            });
        }

        var consumption = await Replay.ConsumeAsync(Binding(grant, req.ApprovalId ?? "", req.ToolName,
            req.Input?.GetRawText() ?? "{}"), ct);
        if (consumption != ReplayResult.Accepted) return ReplayDenied(consumption);

        var result = await _registry.InvokeAsync(req.ToolName, inputElement, ctx, ct);
        return Ok(new
        {
            success = result.Success,
            content = result.Content,
            errorCode = result.ErrorCode,
            message = result.Message,
        });
    }

    [HttpPost("approvals/{runId}/{approvalId}/wait")]
    public async Task<IActionResult> WaitForApproval(
        string runId,
        string approvalId,
        [FromBody] ApprovalWaitRequest? req,
        CancellationToken ct)
    {
        if (!ValidateToken(out var why))
        {
            _logger.LogWarning("[AgentTools] /approvals/wait 401 reason={Reason}", why);
            return Unauthorized(new { error = why });
        }

        var grant = await Authorize(runId, "callback", req?.ToolName);
        if (grant is null) return StatusCode(403);
        var runState = await Replay.ControlRunAsync(Binding(grant, "", ""), "status", ct);
        if (runState.Result != ReplayResult.Accepted) return ReplayDenied(runState.Result);
        if (runState.State != "running") return StatusCode(403, new { error = "run_not_active" });
        var binding = Binding(grant, approvalId, req!.ToolName!);
        var claim = await Replay.ClaimWaitAsync(binding, ct);
        if (claim != ReplayResult.Accepted) return ReplayDenied(claim);
        var timeoutSeconds = Math.Clamp(req?.TimeoutSeconds ?? 600, 1, 900);
        var approval = await ResolveToolApprovalAsync(
            runId,
            req?.ToolName,
            approvalId,
            TimeSpan.FromSeconds(timeoutSeconds),
            ct);

        // Recheck the live lease after waiting, before any SDK tool can be released.
        var afterWait = await Replay.ControlRunAsync(binding with { Tool = "", InputHash = null }, "status", ct);
        if (afterWait.Result != ReplayResult.Accepted) return ReplayDenied(afterWait.Result);
        var stillAuthorized = afterWait.State == "running" && await Authorize(runId, "callback", req?.ToolName) is not null;
        var completion = await Replay.FinishWaitAsync(binding, approval.Allowed && stillAuthorized,
            grant.Runtime.Tools.Any(t => t.Name == req!.ToolName), ct);
        if (completion != ReplayResult.Accepted) return ReplayDenied(completion);
        return Ok(new
        {
            success = approval.Allowed && stillAuthorized,
            decision = approval.Decision,
            errorCode = approval.ErrorCode,
            message = approval.Message,
            risk = approval.Risk
        });
    }

    [HttpPost("approvals/{runId}/{approvalId}/request")]
    public async Task<IActionResult> RequestApproval(
        string runId,
        string approvalId,
        [FromBody] ApprovalRequest? req,
        CancellationToken ct)
    {
        if (!ValidateToken(out var why))
        {
            _logger.LogWarning("[AgentTools] /approvals/request 401 reason={Reason}", why);
            return Unauthorized(new { error = why });
        }

        if (req == null || string.IsNullOrWhiteSpace(req.ToolName))
            return BadRequest(new { success = false, errorCode = "toolName_required", message = "toolName required" });

        var grant = await Authorize(runId, "callback", req.ToolName);
        if (grant is null || !approvalId.StartsWith(runId + ":", StringComparison.Ordinal)) return StatusCode(403);
        var runState = await Replay.ControlRunAsync(Binding(grant, "", ""), "status", ct);
        if (runState.Result != ReplayResult.Accepted) return ReplayDenied(runState.Result);
        if (runState.State != "running") return StatusCode(403, new { error = "run_not_active" });
        var registration = await Replay.RegisterApprovalAsync(Binding(grant, approvalId, req.ToolName,
            req.Input?.GetRawText() ?? "{}"), ct);
        if (registration != ReplayResult.Accepted) return ReplayDenied(registration);
        var session = await FindSessionByRunIdAsync(runId, ct);
        if (session is not null && session.UserId != grant.Subject
            || session is null && runId.StartsWith("infra-agent-", StringComparison.Ordinal)) return StatusCode(403);
        if (session == null && (ClassifyToolRisk(req.ToolName) == "readonly"
            || req.ToolName == "kb_index" && await ResolveChatAgentUserIdAsync(runId, ct) == grant.Subject))
            return Ok(new { success = true, decision = "auto_allowed", risk = "readonly" });
        if (session == null)
        {
            return Ok(new
            {
                success = false,
                errorCode = "approval_context_missing",
                message = "approval request requires an infra agent session context"
            });
        }

        var risk = ClassifyToolRisk(req.ToolName);
        if (!InfraAgentToolPolicies.AllowsToolInvocation(session.ToolPolicy, req.ToolName))
        {
            await AppendToolResultAsync(session.Id, approvalId, "denied", "tool denied by tool policy", ct);
            return Ok(new
            {
                success = false,
                errorCode = "tool_denied_by_writable_profile",
                message = "tool is not allowed by the current CDS Agent tool policy",
                risk
            });
        }

        if (risk == "readonly")
        {
            await AppendToolResultAsync(session.Id, approvalId, "auto_allowed", "readonly tool auto allowed", ct);
            return Ok(new { success = true, decision = "auto_allowed", risk });
        }

        await AppendToolCallAsync(
            session.Id,
            approvalId,
            req.ToolName,
            req.Input,
            req.Description,
            risk,
            ct);
        return Ok(new { success = true, decision = "waiting", risk });
    }

    private async Task<ToolApprovalDecision> ResolveToolApprovalAsync(
        string? runId,
        string? toolName,
        string? approvalId,
        TimeSpan waitFor,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(toolName))
        {
            return ToolApprovalDecision.Deny("tool_name_required", "toolName required", "unknown");
        }

        var risk = ClassifyToolRisk(toolName);
        var session = await FindSessionByRunIdAsync(runId, ct);
        if (session == null)
        {
            if (runId?.StartsWith("infra-agent-", StringComparison.Ordinal) == true)
                return ToolApprovalDecision.Deny("run_inactive", "run is no longer active", risk);
            // 单篇索引只在已归属的通用对话轮次内执行；基础设施只读会话仍由下方策略拒绝。
            if (toolName == "kb_index" && await ResolveChatAgentUserIdAsync(runId, ct) != null)
                return ToolApprovalDecision.Allow("chat_entry_index", risk);
            return risk == "readonly"
                ? ToolApprovalDecision.Allow("auto_allowed", risk)
                : ToolApprovalDecision.Deny("approval_context_missing", "dangerous tool requires an infra agent session approval context", risk);
        }

        if (!InfraAgentToolPolicies.AllowsToolInvocation(session.ToolPolicy, toolName))
        {
            await AppendToolResultAsync(session.Id, approvalId, "denied", "tool denied by tool policy", ct);
            return ToolApprovalDecision.Deny(
                "tool_denied_by_writable_profile",
                "tool is not allowed by the current CDS Agent tool policy",
                risk);
        }

        if (risk == "readonly")
        {
            await AppendToolResultAsync(session.Id, approvalId, "auto_allowed", "readonly tool auto allowed", ct);
            return ToolApprovalDecision.Allow("auto_allowed", risk);
        }

        if (string.IsNullOrWhiteSpace(approvalId))
        {
            return ToolApprovalDecision.Deny("approval_id_required", "dangerous tool requires approvalId", risk);
        }

        var deadline = DateTime.UtcNow + waitFor;
        while (!ct.IsCancellationRequested)
        {
            var decision = await FindApprovalDecisionAsync(session.Id, approvalId, ct);
            if (decision is "allow" or "allowed")
            {
                return ToolApprovalDecision.Allow("allowed", risk);
            }
            if (decision is "deny" or "denied")
            {
                return ToolApprovalDecision.Deny("tool_denied_by_user", "tool denied by user", risk, "denied");
            }

            if (waitFor <= TimeSpan.Zero || DateTime.UtcNow >= deadline)
            {
                await AppendToolResultAsync(session.Id, approvalId, "timed_out", "approval timed out", ct);
                return ToolApprovalDecision.Deny("tool_approval_timeout", "tool approval timed out", risk, "timed_out");
            }

            await Task.Delay(TimeSpan.FromSeconds(1), ct);
        }

        return ToolApprovalDecision.Deny("tool_approval_cancelled", "tool approval wait cancelled", risk, "cancelled");
    }

    /// <summary>
    /// 通用对话的轮次回查归属用户。对话里 runId 就是轮次 id；
    /// 查不到就返回 null，工具会因为没有用户身份而拒绝执行——绝不放行无主调用。
    /// </summary>
    private async Task<string?> ResolveChatAgentUserIdAsync(string? runId, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(runId)) return null;

        var message = await _db.ChatAgentMessages
            .Find(Builders<ChatAgentMessage>.Filter.Eq(m => m.TurnId, runId))
            .FirstOrDefaultAsync(ct);
        if (message == null) return null;

        var session = await _db.ChatAgentSessions
            .Find(Builders<ChatAgentSession>.Filter.Eq(x => x.Id, message.SessionId))
            .FirstOrDefaultAsync(ct);
        return string.IsNullOrWhiteSpace(session?.UserId) ? null : session!.UserId;
    }

    private async Task<InfraAgentSession?> FindSessionByRunIdAsync(string? runId, CancellationToken ct)
    {
        const string prefix = "infra-agent-";
        if (string.IsNullOrWhiteSpace(runId) || !runId.StartsWith(prefix, StringComparison.Ordinal))
        {
            return null;
        }

        var rest = runId[prefix.Length..];
        var dash = rest.IndexOf('-', StringComparison.Ordinal);
        var sessionId = dash > 0 ? rest[..dash] : rest;
        if (string.IsNullOrWhiteSpace(sessionId)) return null;
        return await _db.InfraAgentSessions.Find(x => x.Id == sessionId && x.CurrentRuntimeRunId == runId).FirstOrDefaultAsync(ct);
    }

    private async Task<InfraConnection?> ResolveSessionConnectionAsync(InfraAgentSession? session, CancellationToken ct)
    {
        if (session == null || string.IsNullOrWhiteSpace(session.ConnectionId))
            return null;

        var original = await _db.InfraConnections
            .Find(x => x.Id == session.ConnectionId)
            .FirstOrDefaultAsync(ct);
        if (original == null)
            return null;

        if (!IsRetiredConnection(original))
            return original;

        var now = DateTime.UtcNow;
        var replacement = await _db.InfraConnections
            .Find(x => x.Id != original.Id
                && x.Partner == original.Partner
                && x.PartnerBaseUrl == original.PartnerBaseUrl
                && x.ProjectId == original.ProjectId
                && x.Status == "active"
                && x.LongTokenEncrypted != string.Empty
                && x.LongTokenExpiresAt > now)
            .SortByDescending(x => x.LastProbeOk)
            .ThenByDescending(x => x.UpdatedAt)
            .FirstOrDefaultAsync(ct);

        return replacement ?? original;
    }

    private static bool IsRetiredConnection(InfraConnection connection)
    {
        return string.Equals(connection.Status, "revoked", StringComparison.OrdinalIgnoreCase)
            || string.IsNullOrWhiteSpace(connection.LongTokenEncrypted);
    }

    private async Task<string?> FindApprovalDecisionAsync(string sessionId, string approvalId, CancellationToken ct)
    {
        var events = await _db.InfraAgentEvents
            .Find(x => x.SessionId == sessionId && x.Type == InfraAgentEventTypes.ToolResult)
            .SortByDescending(x => x.Seq)
            .Limit(80)
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

                if (root.TryGetProperty("decision", out var decisionElement))
                {
                    return decisionElement.GetString()?.Trim().ToLowerInvariant();
                }
                if (root.TryGetProperty("status", out var statusElement))
                {
                    return statusElement.GetString()?.Trim().ToLowerInvariant();
                }
            }
            catch (JsonException)
            {
                // Ignore malformed legacy payloads.
            }
        }

        return null;
    }

    private async Task AppendToolResultAsync(
        string sessionId,
        string? approvalId,
        string decision,
        string summary,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(approvalId)) return;
        var existing = await FindApprovalDecisionAsync(sessionId, approvalId, ct);
        if (!string.IsNullOrWhiteSpace(existing)) return;

        await _db.InfraAgentEvents.InsertOneAsync(new InfraAgentEvent
        {
            SessionId = sessionId,
            Seq = await InfraAgentSessionService.ReserveEventSeqRangeAsync(
                _db, sessionId, 1, ct),
            Type = InfraAgentEventTypes.ToolResult,
            PayloadJson = JsonSerializer.Serialize(new
            {
                approvalId,
                decision,
                resultSummary = summary,
                source = "map-tool-approval"
            }),
            CreatedAt = DateTime.UtcNow
        }, cancellationToken: ct);
    }

    private async Task AppendToolCallAsync(
        string sessionId,
        string approvalId,
        string toolName,
        JsonElement? input,
        string? description,
        string risk,
        CancellationToken ct)
    {
        var events = await _db.InfraAgentEvents
            .Find(x => x.SessionId == sessionId && x.Type == InfraAgentEventTypes.ToolCall)
            .SortByDescending(x => x.Seq)
            .Limit(80)
            .ToListAsync(ct);

        foreach (var evt in events)
        {
            try
            {
                using var doc = JsonDocument.Parse(evt.PayloadJson);
                var root = doc.RootElement;
                if (root.TryGetProperty("approvalId", out var idElement)
                    && string.Equals(idElement.GetString(), approvalId, StringComparison.Ordinal))
                {
                    return;
                }
            }
            catch (JsonException)
            {
                // Ignore malformed legacy payloads.
            }
        }

        await _db.InfraAgentEvents.InsertOneAsync(new InfraAgentEvent
        {
            SessionId = sessionId,
            Seq = await InfraAgentSessionService.ReserveEventSeqRangeAsync(
                _db, sessionId, 1, ct),
            Type = InfraAgentEventTypes.ToolCall,
            PayloadJson = JsonSerializer.Serialize(new
            {
                approvalId,
                toolName,
                argsSummary = input?.GetRawText() ?? "{}",
                description,
                risk,
                status = "waiting",
                source = "claude-agent-sdk-permission"
            }),
            CreatedAt = DateTime.UtcNow
        }, cancellationToken: ct);
    }

    private static string ClassifyToolRisk(string toolName)
    {
        var normalized = toolName.Trim().ToLowerInvariant();
        return normalized switch
        {
            "kb_apply" or "kb_index" => "write",
            "repo_write_file" or "repo_run_command" or "repo_create_pull_request" or "cds_bridge_action"
                or "bash" or "edit" or "write" => "dangerous",
            _ => "readonly"
        };
    }

    private bool ValidateToken(out string reason)
    {
        var token = Request.Headers["X-Sidecar-Token"].ToString();
        var valid = TaskContinuationTokens.IsTaskToken(token) && HttpContext.RequestServices
            .GetRequiredService<TaskContinuationTokens>().ValidateTokenAsync(token).GetAwaiter().GetResult();
        reason = valid ? "ok" : "scoped task credential required";
        return valid;
    }

    private Task<TaskContinuationTokens.RuntimeAuthorization?> Authorize(string runId, string purpose, string? tool = null) =>
        HttpContext.RequestServices.GetRequiredService<TaskContinuationTokens>().AuthorizeRuntimeAsync(
            Request.Headers["X-Sidecar-Token"].ToString(), runId, purpose, tool);

    [HttpPost("authorize")]
    public async Task<IActionResult> AuthorizeRuntime([FromBody] RuntimeAuthorizationRequest request)
    {
        if (request.Purpose is not ("run" or "cancel" or "status" or "complete" or "fail")) return Forbid();
        var grant = await Authorize(request.RunId, request.Purpose == "run" ? "run" : "cancel");
        if (grant is null) return StatusCode(403, new { error = "runtime_authorization_denied" });
        if (request.Purpose == "run")
        {
            var reservation = await Replay.ReserveRunAsync(Binding(grant, "", ""), HttpContext.RequestAborted);
            if (reservation != ReplayResult.Accepted) return ReplayDenied(reservation);
        }
        else
        {
            var state = await Replay.ControlRunAsync(Binding(grant, "", ""), request.Purpose, CancellationToken.None);
            if (state.Result != ReplayResult.Accepted) return ReplayDenied(state.Result);
            return Ok(new { grant.Subject, grant.RunId, Purpose = request.Purpose, grant.ExpiresAt, State = state.State });
        }
        return Ok(grant);
    }

    public sealed class RuntimeAuthorizationRequest
    {
        public string RunId { get; set; } = "";
        public string Purpose { get; set; } = "";
    }

    private ISidecarReplayStore Replay => HttpContext.RequestServices.GetRequiredService<ISidecarReplayStore>();
    private SidecarReplayBinding Binding(TaskContinuationTokens.RuntimeAuthorization grant, string approvalId,
        string tool, string? input = null) => new(grant.RunId, grant.Subject,
            SidecarReplayBinding.Hash(Request.Headers["X-Sidecar-Token"].ToString()), approvalId, tool,
            input is null ? null : SidecarReplayBinding.Hash(input), grant.ExpiresAt);
    private IActionResult ReplayDenied(ReplayResult result) => StatusCode(result == ReplayResult.Unavailable ? 503 : 403,
        new { error = result == ReplayResult.Unavailable ? "replay_store_unavailable" : "approval_or_run_replayed" });

    public sealed class InvokeRequest
    {
        public string? ToolName { get; set; }
        public JsonElement? Input { get; set; }
        public string? RunId { get; set; }
        public string? AppCallerCode { get; set; }
        public string? ApprovalId { get; set; }
    }

    public sealed class ApprovalWaitRequest
    {
        public string? ToolName { get; set; }
        public int? TimeoutSeconds { get; set; }
    }

    public sealed class ApprovalRequest
    {
        public string? ToolName { get; set; }
        public JsonElement? Input { get; set; }
        public string? Description { get; set; }
    }

    private sealed record ToolApprovalDecision(
        bool Allowed,
        string Decision,
        string? ErrorCode,
        string? Message,
        string Risk)
    {
        public static ToolApprovalDecision Allow(string decision, string risk) =>
            new(true, decision, null, null, risk);

        public static ToolApprovalDecision Deny(
            string code,
            string message,
            string risk,
            string decision = "denied") =>
            new(false, decision, code, message, risk);
    }
}
