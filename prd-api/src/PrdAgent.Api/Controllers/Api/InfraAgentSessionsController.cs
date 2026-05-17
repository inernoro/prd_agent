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
        var commercialReadiness = BuildCommercialReadiness(
            baseDiagnostics,
            desiredRuntimeAdapter,
            profileDiagnostics);
        var runtimeProfileRepairPlan = BuildRuntimeProfileRepairPlan(profileDiagnostics);
        var nextCyclePlan = BuildNextCyclePlan(profileDiagnostics, runtimeProfileRepairPlan);
        var diagnostics = baseDiagnostics with
        {
            DesiredRuntimeAdapter = desiredRuntimeAdapter,
            RuntimeTransport = _runtimeAdapter?.AdapterKind,
            DefaultRuntimeProfile = profileDiagnostics,
            CommercialReadiness = commercialReadiness,
            RuntimeProfileRepairPlan = runtimeProfileRepairPlan,
            NextCyclePlan = nextCyclePlan,
            NextActions = MergeNextActions(
                baseDiagnostics.NextActions,
                profileDiagnostics)
        };
        return Ok(ApiResponse<object>.Ok(new { diagnostics, discoveryRefreshed = refreshDiscovery && _sidecarRegistry != null }));
    }

    private static SidecarRuntimeProfileRepairPlan BuildRuntimeProfileRepairPlan(
        SidecarRuntimeProfileDiagnostics? profile)
    {
        var template = InfraAgentRuntimeProfileTemplates.All.Single(x =>
            x.Id == InfraAgentRuntimeProfileTemplates.AnthropicOfficialClaudeSonnet4);
        var r1Ready = profile is
        {
            HasApiKey: true,
            CompatibleWithDesiredRuntimeAdapter: true
        };
        var state = r1Ready
            ? "ready"
            : profile == null
                ? "missing"
                : "blocked";
        var nextActions = r1Ready
            ? new[]
            {
                "运行 SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1 smoke-cds-agent-official-sdk-run.sh 验证 S1。",
                "运行 SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1 smoke-cds-agent-official-sdk-controls.sh 验证 S2/S3。"
            }
            : new[]
            {
                "在 CDS Agent 页面点击“准备默认 Claude 配置”，用后端 Anthropic 官方模板填充表单。",
                "填入 Anthropic API key，并保存为默认 runtime profile。",
                "点击“测试模型”；成功后再运行 S1/S2/S3 provider smokes。"
            };
        return new SidecarRuntimeProfileRepairPlan(
            "R1",
            state,
            profile,
            template.Id,
            template.Protocol,
            template.BaseUrl,
            template.Model,
            template.IsDefaultRecommended,
            nextActions);
    }

    private static SidecarNextCyclePlan BuildNextCyclePlan(
        SidecarRuntimeProfileDiagnostics? profile,
        SidecarRuntimeProfileRepairPlan repairPlan)
    {
        var r1Ready = profile is
        {
            HasApiKey: true,
            CompatibleWithDesiredRuntimeAdapter: true
        };
        var state = r1Ready ? "provider-smokes-required" : "profile-blocked";
        var providerRunStatus = r1Ready ? "ready-to-run" : "blocked";
        var providerBlockedBy = r1Ready ? null : "R1";
        var providerRunActions = new[]
        {
            "SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1 SMOKE_CDS_AGENT_REQUIRE_COMPATIBLE=1 bash scripts/smoke-cds-agent-official-sdk-run.sh"
        };
        var providerControlActions = new[]
        {
            "SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1 SMOKE_CDS_AGENT_REQUIRE_COMPATIBLE=1 bash scripts/smoke-cds-agent-official-sdk-controls.sh"
        };
        var items = new List<SidecarNextCyclePlanItem>
        {
            new(
                1,
                "N1",
                "配置真实 Claude/Anthropic runtime profile",
                "用后端 Anthropic 官方模板创建默认 profile，API key 只存 MAP profile。",
                "runtime-status.defaultRuntimeProfile.compatibleWithDesiredRuntimeAdapter=true 且 hasApiKey=true。",
                r1Ready ? "pass" : "blocked",
                r1Ready ? null : "R1",
                r1Ready ? Array.Empty<string>() : repairPlan.NextActions),
            new(
                2,
                "N2",
                "S1 只读远程审查",
                "官方 SDK 在 CDS preview 中读取目标 repo/ref 并返回审查结论，不修改文件。",
                "smoke-cds-agent-official-sdk-run.sh 在 provider 模式下通过，并保留 assistant/repo/workspace 证据。",
                providerRunStatus,
                providerBlockedBy,
                r1Ready ? providerRunActions : Array.Empty<string>()),
            new(
                3,
                "N3",
                "S2 MAP 审批",
                "危险工具请求进入 MAP approval，拒绝后回写 SDK tool result。",
                "smoke-cds-agent-official-sdk-controls.sh 的 approval 分支通过，事件含 tool_result.source=map-tool-approval。",
                providerRunStatus,
                providerBlockedBy,
                r1Ready ? providerControlActions : Array.Empty<string>()),
            new(
                4,
                "N4",
                "S3 Stop / interrupt",
                "长任务 Stop 调到底层 Claude Agent SDK interrupt/cancel。",
                "controls smoke 的 Stop 分支通过，事件含 stop/cancel/interrupt 证据。",
                providerRunStatus,
                providerBlockedBy,
                r1Ready ? providerControlActions : Array.Empty<string>()),
            new(
                5,
                "N5",
                "V1 真实运行态视觉证据",
                "远程 /cds-agent 展示真实 run 的 session、trace、adapter、workspace、event/error。",
                "远程截图必须来自真实 session，不接受空态、mock 或仅登录页。",
                "blocked",
                r1Ready ? "S1/S2/S3" : "R1",
                Array.Empty<string>()),
            new(
                6,
                "N6",
                "非代码智能体兼容回归",
                "PRD/defect/literary/visual 不被 CDS sidecar pool 或 profile gate 阻断。",
                "CdsAgentRuntimeCompatibilityTests 通过，并补对应业务最小 smoke 后再放宽路由。",
                "ready-to-run",
                null,
                new[] { "dotnet test prd-api/tests/PrdAgent.Api.Tests/PrdAgent.Api.Tests.csproj --filter FullyQualifiedName~CdsAgentRuntimeCompatibilityTests" })
        };
        return new SidecarNextCyclePlan(
            "official-sdk-provider-closure",
            state,
            items,
            new[]
            {
                "N1-N5 未全部有真实证据前，不宣称 CDS Agent 商业级上手即用。",
                "其他官方 SDK 候选在未补 adapter contract 和 S1/S2/S3 smokes 前保持 planned-not-routable。",
                "视觉验收必须绑定真实 sessionId/traceId/runtimeAdapter/workspace，而不是静态页面。"
            });
    }

    private static SidecarCommercialReadinessDiagnostics BuildCommercialReadiness(
        SidecarPoolDiagnostics diagnostics,
        string desiredRuntimeAdapter,
        SidecarRuntimeProfileDiagnostics? profile)
    {
        var officialInstances = diagnostics.Instances.Count(x =>
            string.Equals(x.LoopOwner, InfraAgentRuntimeAdapterDefaults.OfficialClaudeAgentSdk, StringComparison.OrdinalIgnoreCase)
            || x.SdkLoopEnabled == true);
        var r0Ready = diagnostics.InstanceCount > 0
            && diagnostics.HealthyCount > 0
            && officialInstances > 0
            && string.Equals(desiredRuntimeAdapter, InfraAgentRuntimeAdapterDefaults.OfficialClaudeAgentSdk, StringComparison.OrdinalIgnoreCase);
        var r1Ready = profile is
        {
            HasApiKey: true,
            CompatibleWithDesiredRuntimeAdapter: true
        };
        var t1Ready = InfraAgentRuntimeProfileTemplates.All.Any(x =>
                x.CompatibleRuntimeAdapters.Contains(InfraAgentRuntimeAdapterDefaults.OfficialClaudeAgentSdk))
            && InfraAgentRuntimeAdapterCompatibility.All.Any(x =>
                string.Equals(x.Id, InfraAgentRuntimeAdapterDefaults.OfficialClaudeAgentSdk, StringComparison.OrdinalIgnoreCase)
                && string.Equals(x.Status, "default-supported", StringComparison.OrdinalIgnoreCase));
        var providerStatus = r1Ready ? "unblocked" : "pending";
        var providerMessage = r1Ready
            ? "默认 profile 已兼容并带 key；可以显式开启 provider smoke 验证真实 run。"
            : "等待 R1 通过后再运行真实 provider smoke。";

        var gates = new List<SidecarCommercialReadinessGate>
        {
            new(
                "R0",
                "MAP/CDS runtime pool official SDK loop ownership",
                r0Ready ? "pass" : "pending",
                r0Ready
                    ? $"pool={diagnostics.HealthyCount}/{diagnostics.InstanceCount} officialInstances={officialInstances}"
                    : $"instanceCount={diagnostics.InstanceCount} healthyCount={diagnostics.HealthyCount} officialInstances={officialInstances}",
                r0Ready ? Array.Empty<string>() : diagnostics.NextActions),
            new(
                "R1",
                "Default runtime profile compatibility",
                r1Ready ? "pass" : "pending",
                r1Ready
                    ? "default profile can be used by claude-agent-sdk"
                    : "create a default Anthropic/Claude-compatible runtime profile with API key",
                r1Ready ? Array.Empty<string>() : new[] { "使用 Anthropic 官方模板创建默认 profile，并填入 API key" }),
            new(
                "T1",
                "Official template and adapter compatibility APIs",
                t1Ready ? "pass" : "pending",
                t1Ready
                    ? "template and compatibility matrix are backend-owned"
                    : "backend template or adapter compatibility matrix is missing official SDK support",
                t1Ready ? Array.Empty<string>() : new[] { "检查 runtime profile templates 与 adapter compatibility API" }),
            new("S1", "Read-only provider run", providerStatus, providerMessage,
                r1Ready ? new[] { "运行 SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1 smoke-cds-agent-official-sdk-run.sh" } : Array.Empty<string>()),
            new("S2", "MAP tool approval provider run", providerStatus, providerMessage,
                r1Ready ? new[] { "运行 SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1 smoke-cds-agent-official-sdk-controls.sh" } : Array.Empty<string>()),
            new("S3", "Stop / interrupt provider run", providerStatus, providerMessage,
                r1Ready ? new[] { "运行 SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1 smoke-cds-agent-official-sdk-controls.sh" } : Array.Empty<string>())
        };
        var passed = gates.Count(x => string.Equals(x.Status, "pass", StringComparison.OrdinalIgnoreCase));
        var pending = gates
            .Where(x => !string.Equals(x.Status, "pass", StringComparison.OrdinalIgnoreCase))
            .Select(x => $"{x.Code}: {x.Message}")
            .ToArray();
        var overall = passed == gates.Count
            ? "ready-for-visual-evidence"
            : r1Ready
                ? "provider-smokes-required"
                : "profile-blocked";
        return new SidecarCommercialReadinessDiagnostics(overall, passed, gates.Count, gates, pending);
    }

    private async Task<SidecarRuntimeProfileDiagnostics?> ResolveDefaultRuntimeProfileDiagnosticsAsync(
        string desiredRuntimeAdapter,
        CancellationToken ct)
    {
        var profiles = await _runtimeProfiles!.ListAsync(ct);
        var selected = profiles.FirstOrDefault(x => x.IsDefault) ?? profiles.FirstOrDefault();
        if (selected == null) return null;

        var compatible = InfraAgentRuntimeProfileCompatibility.IsCompatibleWithDesiredRuntimeAdapter(
            desiredRuntimeAdapter,
            selected.Protocol,
            selected.Model);
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
