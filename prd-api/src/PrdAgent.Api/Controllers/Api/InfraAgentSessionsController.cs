using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// MAP 基础设施 Agent 工作台会话接口。
/// P1 只提供 MAP 侧会话骨架，CDS 容器生命周期后续接入。
/// </summary>
[ApiController]
[Route("api/infra-agent-sessions")]
[Authorize]
public class InfraAgentSessionsController : ControllerBase
{
    private readonly IInfraAgentSessionService _service;
    private readonly IClaudeSidecarRouter? _sidecarRouter;
    private readonly IDynamicSidecarRegistry? _sidecarRegistry;
    private readonly IInfraAgentRuntimeAdapter? _runtimeAdapter;
    private readonly IInfraAgentRuntimeProfileService? _runtimeProfiles;

    public InfraAgentSessionsController(
        IInfraAgentSessionService service,
        IClaudeSidecarRouter? sidecarRouter = null,
        IDynamicSidecarRegistry? sidecarRegistry = null,
        IInfraAgentRuntimeAdapter? runtimeAdapter = null,
        IInfraAgentRuntimeProfileService? runtimeProfiles = null)
    {
        _service = service;
        _sidecarRouter = sidecarRouter;
        _sidecarRegistry = sidecarRegistry;
        _runtimeAdapter = runtimeAdapter;
        _runtimeProfiles = runtimeProfiles;
    }

    [HttpGet("event-schema")]
    public IActionResult EventSchema()
    {
        return Ok(ApiResponse<object>.Ok(new { items = InfraAgentEventSchema.Items }));
    }

    [HttpGet("runtime-status")]
    public async Task<IActionResult> RuntimeStatus([FromQuery] bool refreshDiscovery = false, CancellationToken ct = default)
    {
        if (_sidecarRouter == null)
        {
            return Ok(ApiResponse<object>.Ok(new
            {
                isConfigured = false,
                instanceCount = 0,
                healthyCount = 0,
                instances = Array.Empty<object>(),
                error = "sidecar router not registered"
            }));
        }

        if (refreshDiscovery && _sidecarRegistry != null)
        {
            await _sidecarRegistry.RefreshAsync(ct);
        }

        var desiredRuntimeAdapter = InfraAgentRuntimeAdapterDefaults.ResolveSidecarRuntimeAdapter();
        var profileDiagnostics = _runtimeProfiles == null
            ? null
            : await ResolveDefaultRuntimeProfileDiagnosticsAsync(desiredRuntimeAdapter, ct);
        var baseDiagnostics = await _sidecarRouter.GetDiagnosticsAsync(ct);
        var diagnostics = baseDiagnostics with
        {
            DesiredRuntimeAdapter = desiredRuntimeAdapter,
            RuntimeTransport = _runtimeAdapter?.AdapterKind,
            DefaultRuntimeProfile = profileDiagnostics,
            NextActions = MergeNextActions(
                baseDiagnostics.NextActions,
                profileDiagnostics)
        };
        return Ok(ApiResponse<object>.Ok(new { diagnostics, discoveryRefreshed = refreshDiscovery && _sidecarRegistry != null }));
    }

    private async Task<SidecarRuntimeProfileDiagnostics?> ResolveDefaultRuntimeProfileDiagnosticsAsync(
        string desiredRuntimeAdapter,
        CancellationToken ct)
    {
        var profiles = await _runtimeProfiles!.ListAsync(ct);
        var selected = profiles.FirstOrDefault(x => x.IsDefault) ?? profiles.FirstOrDefault();
        if (selected == null) return null;

        var compatible = IsProfileCompatibleWithDesiredRuntimeAdapter(selected, desiredRuntimeAdapter);
        var warning = compatible
            ? null
            : "claude-agent-sdk 通常需要 Claude/Anthropic 兼容模型；当前默认模型可能只适合普通 OpenAI-compatible gateway";
        return new SidecarRuntimeProfileDiagnostics(
            selected.Id,
            selected.Name,
            selected.Runtime,
            selected.Protocol,
            selected.Model,
            selected.HasApiKey,
            selected.IsDefault,
            compatible,
            warning);
    }

    private static bool IsProfileCompatibleWithDesiredRuntimeAdapter(
        InfraAgentRuntimeProfileView profile,
        string desiredRuntimeAdapter)
    {
        if (!string.Equals(desiredRuntimeAdapter, "claude-agent-sdk", StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        var model = profile.Model ?? string.Empty;
        var protocol = profile.Protocol ?? string.Empty;
        return protocol.Equals("anthropic", StringComparison.OrdinalIgnoreCase)
            || model.Contains("claude", StringComparison.OrdinalIgnoreCase)
            || model.StartsWith("anthropic/", StringComparison.OrdinalIgnoreCase);
    }

    private static IReadOnlyList<string>? MergeNextActions(
        IReadOnlyList<string>? current,
        SidecarRuntimeProfileDiagnostics? profile)
    {
        if (profile?.CompatibleWithDesiredRuntimeAdapter != false || string.IsNullOrWhiteSpace(profile.Warning))
        {
            return current;
        }

        var result = new List<string>(current ?? Array.Empty<string>());
        result.Add("为 Claude Agent SDK 路径选择 Claude/Anthropic 兼容 runtime profile，或将该任务改走普通 OpenAI-compatible gateway");
        return result.Distinct().ToArray();
    }

    [HttpGet]
    public async Task<IActionResult> List([FromQuery] int limit, CancellationToken ct)
    {
        var userId = this.GetRequiredUserId();
        var items = await _service.ListAsync(userId, limit, ct);
        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    [HttpPost]
    public async Task<IActionResult> Create([FromBody] CreateInfraAgentSessionRequest req, CancellationToken ct)
    {
        if (req == null)
        {
            return BadRequest(ApiResponse<object>.Fail(
                InfraAgentSessionErrorCodes.ConnectionIdRequired,
                "请求体不能为空"));
        }

        var userId = this.GetRequiredUserId();
        try
        {
            var item = await _service.CreateAsync(userId, req, ct);
            return StatusCode(StatusCodes.Status201Created, ApiResponse<object>.Ok(new { item }));
        }
        catch (InfraAgentSessionException ex)
        {
            return StatusCode(ex.HttpStatus, ApiResponse<object>.Fail(ex.ErrorCode, ex.Message));
        }
    }

    [HttpGet("{id}")]
    public async Task<IActionResult> Get(string id, CancellationToken ct)
    {
        var userId = this.GetRequiredUserId();
        var item = await _service.GetAsync(userId, id, ct);
        if (item == null)
        {
            return NotFound(ApiResponse<object>.Fail(
                InfraAgentSessionErrorCodes.SessionNotFound,
                "会话不存在"));
        }

        return Ok(ApiResponse<object>.Ok(new { item }));
    }

    [HttpPost("{id}/start")]
    public async Task<IActionResult> Start(string id, [FromBody] StartInfraAgentSessionRequest? req, CancellationToken ct)
    {
        var userId = this.GetRequiredUserId();
        try
        {
            var item = await _service.StartAsync(userId, id, req ?? new StartInfraAgentSessionRequest(null, null), ct);
            if (item == null)
            {
                return NotFound(ApiResponse<object>.Fail(
                    InfraAgentSessionErrorCodes.SessionNotFound,
                    "会话不存在"));
            }

            return Ok(ApiResponse<object>.Ok(new { item }));
        }
        catch (InfraAgentSessionException ex)
        {
            return StatusCode(ex.HttpStatus, ApiResponse<object>.Fail(ex.ErrorCode, ex.Message));
        }
    }

    [HttpPost("{id}/messages")]
    public async Task<IActionResult> SendMessage(string id, [FromBody] SendInfraAgentMessageRequest req, CancellationToken ct)
    {
        if (req == null)
        {
            return BadRequest(ApiResponse<object>.Fail(
                InfraAgentSessionErrorCodes.MessageContentRequired,
                "请求体不能为空"));
        }

        var userId = this.GetRequiredUserId();
        try
        {
            var item = await _service.SendMessageAsync(userId, id, req, ct);
            if (item == null)
            {
                return NotFound(ApiResponse<object>.Fail(
                    InfraAgentSessionErrorCodes.SessionNotFound,
                    "会话不存在"));
            }

            return Ok(ApiResponse<object>.Ok(new { item }));
        }
        catch (InfraAgentSessionException ex)
        {
            return StatusCode(ex.HttpStatus, ApiResponse<object>.Fail(ex.ErrorCode, ex.Message));
        }
    }

    [HttpPost("{id}/stop")]
    public async Task<IActionResult> Stop(string id, CancellationToken ct)
    {
        var userId = this.GetRequiredUserId();
        try
        {
            var item = await _service.StopAsync(userId, id, ct);
            if (item == null)
            {
                return NotFound(ApiResponse<object>.Fail(
                    InfraAgentSessionErrorCodes.SessionNotFound,
                    "会话不存在"));
            }

            return Ok(ApiResponse<object>.Ok(new { item }));
        }
        catch (InfraAgentSessionException ex)
        {
            return StatusCode(ex.HttpStatus, ApiResponse<object>.Fail(ex.ErrorCode, ex.Message));
        }
    }

    [HttpPost("{id}/archive")]
    public async Task<IActionResult> Archive(string id, CancellationToken ct)
    {
        var userId = this.GetRequiredUserId();
        try
        {
            var item = await _service.ArchiveAsync(userId, id, ct);
            if (item == null)
            {
                return NotFound(ApiResponse<object>.Fail(
                    InfraAgentSessionErrorCodes.SessionNotFound,
                    "会话不存在"));
            }

            return Ok(ApiResponse<object>.Ok(new { item }));
        }
        catch (InfraAgentSessionException ex)
        {
            return StatusCode(ex.HttpStatus, ApiResponse<object>.Fail(ex.ErrorCode, ex.Message));
        }
    }

    [HttpPost("{id}/collect-artifacts")]
    public async Task<IActionResult> CollectArtifacts(string id, CancellationToken ct)
    {
        var userId = this.GetRequiredUserId();
        try
        {
            var item = await _service.CollectArtifactsAsync(userId, id, ct);
            if (item == null)
            {
                return NotFound(ApiResponse<object>.Fail(
                    InfraAgentSessionErrorCodes.SessionNotFound,
                    "会话不存在"));
            }

            return Ok(ApiResponse<object>.Ok(new { item }));
        }
        catch (InfraAgentSessionException ex)
        {
            return StatusCode(ex.HttpStatus, ApiResponse<object>.Fail(ex.ErrorCode, ex.Message));
        }
    }

    [HttpPost("{id}/run-readonly-checks")]
    public async Task<IActionResult> RunReadonlyChecks(string id, CancellationToken ct)
    {
        var userId = this.GetRequiredUserId();
        try
        {
            var item = await _service.RunReadonlyChecksAsync(userId, id, ct);
            if (item == null)
            {
                return NotFound(ApiResponse<object>.Fail(
                    InfraAgentSessionErrorCodes.SessionNotFound,
                    "会话不存在"));
            }

            return Ok(ApiResponse<object>.Ok(new { item }));
        }
        catch (InfraAgentSessionException ex)
        {
            return StatusCode(ex.HttpStatus, ApiResponse<object>.Fail(ex.ErrorCode, ex.Message));
        }
    }

    [HttpPost("{id}/capture-browser-snapshot")]
    public async Task<IActionResult> CaptureBrowserSnapshot(string id, [FromBody] BrowserSnapshotRequest? req, CancellationToken ct)
    {
        var userId = this.GetRequiredUserId();
        try
        {
            var item = await _service.CaptureBrowserSnapshotAsync(
                userId,
                id,
                req ?? new BrowserSnapshotRequest(null, null),
                ct);
            if (item == null)
            {
                return NotFound(ApiResponse<object>.Fail(
                    InfraAgentSessionErrorCodes.SessionNotFound,
                    "会话不存在"));
            }

            return Ok(ApiResponse<object>.Ok(new { item }));
        }
        catch (InfraAgentSessionException ex)
        {
            return StatusCode(ex.HttpStatus, ApiResponse<object>.Fail(ex.ErrorCode, ex.Message));
        }
    }

    [HttpPost("{id}/browser-actions")]
    public async Task<IActionResult> RunBrowserAction(string id, [FromBody] BrowserActionRequest? req, CancellationToken ct)
    {
        if (req == null)
        {
            return BadRequest(ApiResponse<object>.Fail(
                "browser_action_required",
                "请求体不能为空"));
        }

        var userId = this.GetRequiredUserId();
        try
        {
            var item = await _service.RunBrowserActionAsync(userId, id, req, ct);
            if (item == null)
            {
                return NotFound(ApiResponse<object>.Fail(
                    InfraAgentSessionErrorCodes.SessionNotFound,
                    "会话不存在"));
            }

            return Ok(ApiResponse<object>.Ok(new { item }));
        }
        catch (InfraAgentSessionException ex)
        {
            return StatusCode(ex.HttpStatus, ApiResponse<object>.Fail(ex.ErrorCode, ex.Message));
        }
    }

    [HttpPost("{id}/tool-approval-requests")]
    public async Task<IActionResult> RequestToolApproval(string id, [FromBody] CreateToolApprovalRequest? req, CancellationToken ct)
    {
        if (req == null)
        {
            return BadRequest(ApiResponse<object>.Fail(
                "tool_approval_request_required",
                "请求体不能为空"));
        }

        var userId = this.GetRequiredUserId();
        try
        {
            var item = await _service.RequestToolApprovalAsync(userId, id, req, ct);
            if (item == null)
            {
                return NotFound(ApiResponse<object>.Fail(
                    InfraAgentSessionErrorCodes.SessionNotFound,
                    "会话不存在"));
            }

            return Ok(ApiResponse<object>.Ok(new { item }));
        }
        catch (InfraAgentSessionException ex)
        {
            return StatusCode(ex.HttpStatus, ApiResponse<object>.Fail(ex.ErrorCode, ex.Message));
        }
    }

    [HttpPost("{id}/manual-takeover")]
    public async Task<IActionResult> ManualTakeover(string id, [FromBody] ManualTakeoverRequest? req, CancellationToken ct)
    {
        var userId = this.GetRequiredUserId();
        try
        {
            var item = await _service.SetManualTakeoverAsync(userId, id, req ?? new ManualTakeoverRequest(true, null), ct);
            if (item == null)
            {
                return NotFound(ApiResponse<object>.Fail(
                    InfraAgentSessionErrorCodes.SessionNotFound,
                    "会话不存在"));
            }

            return Ok(ApiResponse<object>.Ok(new { item }));
        }
        catch (InfraAgentSessionException ex)
        {
            return StatusCode(ex.HttpStatus, ApiResponse<object>.Fail(ex.ErrorCode, ex.Message));
        }
    }

    [HttpPost("{id}/manual-inputs")]
    public async Task<IActionResult> ManualInput(string id, [FromBody] ManualInputRequest? req, CancellationToken ct)
    {
        if (req == null)
        {
            return BadRequest(ApiResponse<object>.Fail(
                InfraAgentSessionErrorCodes.MessageContentRequired,
                "请求体不能为空"));
        }

        var userId = this.GetRequiredUserId();
        try
        {
            var item = await _service.AddManualInputAsync(userId, id, req, ct);
            if (item == null)
            {
                return NotFound(ApiResponse<object>.Fail(
                    InfraAgentSessionErrorCodes.SessionNotFound,
                    "会话不存在"));
            }

            return Ok(ApiResponse<object>.Ok(new { item }));
        }
        catch (InfraAgentSessionException ex)
        {
            return StatusCode(ex.HttpStatus, ApiResponse<object>.Fail(ex.ErrorCode, ex.Message));
        }
    }

    [HttpGet("{id}/events")]
    public async Task<IActionResult> ListEvents(
        string id,
        [FromQuery] long afterSeq,
        [FromQuery] int limit,
        CancellationToken ct)
    {
        var userId = this.GetRequiredUserId();
        try
        {
            var items = await _service.ListEventsAsync(userId, id, afterSeq, limit, ct);
            return Ok(ApiResponse<object>.Ok(new { items }));
        }
        catch (InfraAgentSessionException ex)
        {
            return StatusCode(ex.HttpStatus, ApiResponse<object>.Fail(ex.ErrorCode, ex.Message));
        }
    }

    [HttpGet("{id}/messages")]
    public async Task<IActionResult> ListMessages(
        string id,
        [FromQuery] int limit,
        CancellationToken ct)
    {
        var userId = this.GetRequiredUserId();
        try
        {
            var items = await _service.ListMessagesAsync(userId, id, limit, ct);
            return Ok(ApiResponse<object>.Ok(new { items }));
        }
        catch (InfraAgentSessionException ex)
        {
            return StatusCode(ex.HttpStatus, ApiResponse<object>.Fail(ex.ErrorCode, ex.Message));
        }
    }

    [HttpGet("{id}/stream")]
    public async Task Stream(string id, [FromQuery] long afterSeq, [FromQuery] int limit, CancellationToken ct)
    {
        Response.Headers.CacheControl = "no-cache, no-transform";
        Response.Headers.Connection = "keep-alive";
        Response.ContentType = "text/event-stream; charset=utf-8";

        var userId = this.GetRequiredUserId();
        var pageLimit = Math.Clamp(limit <= 0 ? 500 : limit, 1, 500);
        var cursor = afterSeq;
        try
        {
            while (!ct.IsCancellationRequested)
            {
                var items = await _service.ListEventsAsync(userId, id, cursor, pageLimit, ct);
                if (items.Count == 0)
                {
                    await Response.WriteAsync($": keepalive {DateTimeOffset.UtcNow:O}\n\n", ct);
                    await Response.Body.FlushAsync(ct);
                    await Task.Delay(TimeSpan.FromSeconds(2), ct);
                    continue;
                }

                foreach (var evt in items)
                {
                    await Response.WriteAsync($"id: {evt.Seq}\n", ct);
                    await Response.WriteAsync($"event: {evt.Type}\n", ct);
                    await Response.WriteAsync($"data: {evt.PayloadJson}\n\n", ct);
                    cursor = Math.Max(cursor, evt.Seq);
                }

                await Response.Body.FlushAsync(ct);
                if (items.Count < pageLimit)
                {
                    await Task.Delay(TimeSpan.FromMilliseconds(500), ct);
                }
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            // Client disconnected.
        }
        catch (InfraAgentSessionException ex)
        {
            await Response.WriteAsync("event: error\n", ct);
            await Response.WriteAsync($"data: {{\"code\":\"{ex.ErrorCode}\",\"message\":\"{ex.Message}\"}}\n\n", ct);
        }
    }

    [HttpPost("{id}/tool-approvals/{approvalId}")]
    public async Task<IActionResult> ApproveTool(
        string id,
        string approvalId,
        [FromBody] ToolApprovalRequest req,
        CancellationToken ct)
    {
        var userId = this.GetRequiredUserId();
        try
        {
            var item = await _service.ApproveToolAsync(userId, id, approvalId, req ?? new ToolApprovalRequest("deny"), ct);
            if (item == null)
            {
                return NotFound(ApiResponse<object>.Fail(
                    InfraAgentSessionErrorCodes.SessionNotFound,
                    "会话不存在"));
            }

            return Ok(ApiResponse<object>.Ok(new { item }));
        }
        catch (InfraAgentSessionException ex)
        {
            return StatusCode(ex.HttpStatus, ApiResponse<object>.Fail(ex.ErrorCode, ex.Message));
        }
    }

    [HttpGet("{id}/logs")]
    public async Task<IActionResult> Logs(string id, CancellationToken ct)
    {
        var userId = this.GetRequiredUserId();
        try
        {
            var logs = await _service.GetLogsAsync(userId, id, ct);
            if (logs == null)
            {
                return NotFound(ApiResponse<object>.Fail(
                    InfraAgentSessionErrorCodes.SessionNotFound,
                    "会话不存在"));
            }

            return Ok(ApiResponse<object>.Ok(new { logs }));
        }
        catch (InfraAgentSessionException ex)
        {
            return StatusCode(ex.HttpStatus, ApiResponse<object>.Fail(ex.ErrorCode, ex.Message));
        }
    }
}
