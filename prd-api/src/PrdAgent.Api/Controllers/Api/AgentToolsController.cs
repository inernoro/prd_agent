using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Options;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services.ClaudeSidecar;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// claude-sdk Sidecar 反向调用主服务工具的入口。
///
/// 调用源：Python sidecar 的 ToolBridge（`claude-sdk-sidecar/app/tool_bridge.py`）
/// 鉴权方式：X-Sidecar-Token header，明文比对任一已配置 sidecar 的 Token。
///   双向同 token 是有意为之 —— "调用方"和"被调用方"用同一对称凭据，免去额外的
///   AgentApiKey 签发/吊销心智负担，对运维更"无脑"。
/// 这个端点不对外（不在 OpenAPI 文档中宣传），属于内部基础设施层。
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

    public AgentToolsController(
        IAgentToolRegistry registry,
        IOptionsMonitor<ClaudeSidecarOptions> options,
        ILogger<AgentToolsController> logger,
        MongoDbContext db,
        IInfraConnectionService infraConnections)
    {
        _registry = registry;
        _options = options;
        _logger = logger;
        _db = db;
        _infraConnections = infraConnections;
    }

    [HttpGet("list")]
    public IActionResult List()
    {
        if (!ValidateToken(out var why))
        {
            _logger.LogWarning("[AgentTools] /list 401 reason={Reason}", why);
            return Unauthorized(new { error = why });
        }

        var tools = _registry.ListAll().Select(t => new
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

        var session = await FindSessionByRunIdAsync(req.RunId, ct);
        var connection = await ResolveSessionConnectionAsync(session, ct);
        var cdsToken = connection == null
            ? null
            : await _infraConnections.TryUnprotectLongTokenAsync(connection.Id, ct, revokeOnFailure: false);

        var inputElement = req.Input ?? JsonDocument.Parse("{}").RootElement;
        var ctx = new AgentToolInvocationContext
        {
            RunId = req.RunId ?? string.Empty,
            AppCallerCode = req.AppCallerCode,
            SidecarName = Request.Headers["X-Sidecar-Name"].FirstOrDefault(),
            InfraAgentSessionId = session?.Id,
            ApprovalId = req.ApprovalId,
            CdsBaseUrl = connection?.PartnerBaseUrl,
            CdsProjectId = connection?.ProjectId,
            CdsLongToken = cdsToken,
        };

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

        var timeoutSeconds = Math.Clamp(req?.TimeoutSeconds ?? 600, 1, 900);
        var approval = await ResolveToolApprovalAsync(
            runId,
            req?.ToolName,
            approvalId,
            TimeSpan.FromSeconds(timeoutSeconds),
            ct);

        return Ok(new
        {
            success = approval.Allowed,
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

        var session = await FindSessionByRunIdAsync(runId, ct);
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
        return await _db.InfraAgentSessions.Find(x => x.Id == sessionId).FirstOrDefaultAsync(ct);
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

        var latest = await _db.InfraAgentEvents
            .Find(x => x.SessionId == sessionId)
            .SortByDescending(x => x.Seq)
            .Limit(1)
            .FirstOrDefaultAsync(ct);

        await _db.InfraAgentEvents.InsertOneAsync(new InfraAgentEvent
        {
            SessionId = sessionId,
            Seq = (latest?.Seq ?? 0) + 1,
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

        var latest = await _db.InfraAgentEvents
            .Find(x => x.SessionId == sessionId)
            .SortByDescending(x => x.Seq)
            .Limit(1)
            .FirstOrDefaultAsync(ct);

        await _db.InfraAgentEvents.InsertOneAsync(new InfraAgentEvent
        {
            SessionId = sessionId,
            Seq = (latest?.Seq ?? 0) + 1,
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
            "kb_apply" => "write",
            "repo_write_file" or "repo_run_command" or "repo_create_pull_request" or "cds_bridge_action"
                or "bash" or "edit" or "write" => "dangerous",
            _ => "readonly"
        };
    }

    private bool ValidateToken(out string reason)
    {
        var presented = Request.Headers["X-Sidecar-Token"].FirstOrDefault();
        if (string.IsNullOrWhiteSpace(presented))
        {
            reason = "missing X-Sidecar-Token";
            return false;
        }

        var configured = _options.CurrentValue.Sidecars
            .Select(s =>
                !string.IsNullOrWhiteSpace(s.Token)
                    ? s.Token
                    : (!string.IsNullOrWhiteSpace(s.TokenEnvVar)
                        ? Environment.GetEnvironmentVariable(s.TokenEnvVar)
                        : null))
            .Where(t => !string.IsNullOrWhiteSpace(t))
            .Cast<string>()
            .ToList();

        var sharedDiscoveryToken = _options.CurrentValue.CdsDiscovery.SharedSidecarToken;
        if (!string.IsNullOrWhiteSpace(sharedDiscoveryToken)) configured.Add(sharedDiscoveryToken);

        var defaultSidecarToken = _options.CurrentValue.DefaultSidecarToken;
        if (!string.IsNullOrWhiteSpace(defaultSidecarToken)) configured.Add(defaultSidecarToken);

        // 兜底：环境变量 CLAUDE_SIDECAR_TOKEN 也作为合法凭据（与 PostConfigure 自动注入对齐）
        var envToken = Environment.GetEnvironmentVariable("CLAUDE_SIDECAR_TOKEN");
        if (!string.IsNullOrWhiteSpace(envToken)) configured.Add(envToken);

        if (configured.Count == 0)
        {
            reason = "no sidecar token configured";
            return false;
        }

        if (configured.Any(t => string.Equals(t, presented, StringComparison.Ordinal)))
        {
            reason = "ok";
            return true;
        }

        reason = "token mismatch";
        return false;
    }

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
