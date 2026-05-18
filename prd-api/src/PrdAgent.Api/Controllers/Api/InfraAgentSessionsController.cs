using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Configuration;
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
    private const string DefaultRemoteSmokeHost = "https://cds.miduo.org";

    private readonly IInfraAgentSessionService _service;
    private readonly IClaudeSidecarRouter? _sidecarRouter;
    private readonly IDynamicSidecarRegistry? _sidecarRegistry;
    private readonly IInfraAgentRuntimeAdapter? _runtimeAdapter;
    private readonly IInfraAgentRuntimeProfileService? _runtimeProfiles;
    private readonly IConfiguration? _configuration;

    public InfraAgentSessionsController(
        IInfraAgentSessionService service,
        IClaudeSidecarRouter? sidecarRouter = null,
        IDynamicSidecarRegistry? sidecarRegistry = null,
        IInfraAgentRuntimeAdapter? runtimeAdapter = null,
        IInfraAgentRuntimeProfileService? runtimeProfiles = null,
        IConfiguration? configuration = null)
    {
        _service = service;
        _sidecarRouter = sidecarRouter;
        _sidecarRegistry = sidecarRegistry;
        _runtimeAdapter = runtimeAdapter;
        _runtimeProfiles = runtimeProfiles;
        _configuration = configuration;
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
        var profile = _runtimeProfiles == null
            ? null
            : await ResolveDefaultRuntimeProfileDiagnosticsAsync(desiredRuntimeAdapter, ct);
        var baseDiagnostics = await _sidecarRouter.GetDiagnosticsAsync(ct);
        var commercialReadiness = BuildCommercialReadiness(
            baseDiagnostics,
            desiredRuntimeAdapter,
            profile);
        var runtimeProfileRepairPlan = BuildRuntimeProfileRepairPlan(profile);
        var nextCyclePlan = BuildNextCyclePlan(profile, runtimeProfileRepairPlan);
        var debugCommands = BuildDebugCommands(
            baseDiagnostics,
            desiredRuntimeAdapter,
            profile,
            BuildRemoteSmokePrefix(_configuration));
        var executionPanel = BuildExecutionPanel(commercialReadiness, nextCyclePlan, debugCommands);
        var diagnostics = baseDiagnostics with
        {
            DesiredRuntimeAdapter = desiredRuntimeAdapter,
            RuntimeTransport = _runtimeAdapter?.AdapterKind,
            DefaultRuntimeProfile = profile,
            CommercialReadiness = commercialReadiness,
            RuntimeProfileRepairPlan = runtimeProfileRepairPlan,
            NextCyclePlan = nextCyclePlan,
            DebugCommands = debugCommands,
            ExecutionPanel = executionPanel,
            NextActions = MergeNextActions(
                baseDiagnostics.NextActions,
                profile)
        };
        return Ok(ApiResponse<object>.Ok(new { diagnostics, discoveryRefreshed = refreshDiscovery && _sidecarRegistry != null }));
    }

    private static SidecarExecutionPanel BuildExecutionPanel(
        SidecarCommercialReadinessDiagnostics readiness,
        SidecarNextCyclePlan nextCyclePlan,
        IReadOnlyList<SidecarDebugCommand> debugCommands)
    {
        var commercialComplete = readiness.Gates.All(x =>
            string.Equals(x.Status, "pass", StringComparison.OrdinalIgnoreCase));
        var blockingGate = readiness.Gates.FirstOrDefault(x =>
            !string.Equals(x.Status, "pass", StringComparison.OrdinalIgnoreCase));
        var blockedCycleItem = nextCyclePlan.Items.FirstOrDefault(x =>
            !string.Equals(x.Status, "pass", StringComparison.OrdinalIgnoreCase));
        var blockingCode = blockingGate?.Code ?? blockedCycleItem?.BlockedBy ?? blockedCycleItem?.Code ?? string.Empty;
        var command = SelectExecutionCommand(blockingCode, debugCommands);
        var deploymentAdvice = BuildDeploymentAdvice(readiness.Overall, blockingCode, commercialComplete);
        var gateCounts = readiness.Gates
            .GroupBy(x => x.Status, StringComparer.OrdinalIgnoreCase)
            .ToDictionary(x => x.Key, x => x.Count(), StringComparer.OrdinalIgnoreCase);
        var timeline = nextCyclePlan.Items
            .OrderBy(x => x.Order)
            .Select(x => new SidecarExecutionPanelStep(
                x.Order,
                x.Code,
                x.Title,
                x.Status,
                x.BlockedBy))
            .ToArray();
        var currentStep = timeline.FirstOrDefault(x =>
            !string.Equals(x.Status, "pass", StringComparison.OrdinalIgnoreCase));
        var stepTotal = timeline.Length;
        var stepIndex = currentStep?.Order ?? stepTotal;
        var passedSteps = timeline.Count(x =>
            string.Equals(x.Status, "pass", StringComparison.OrdinalIgnoreCase));
        var pendingSteps = Math.Max(0, stepTotal - passedSteps);

        return new SidecarExecutionPanel(
            readiness.Overall,
            commercialComplete,
            blockingCode,
            blockingGate?.Message
                ?? blockedCycleItem?.NextActions?.FirstOrDefault()
                ?? "商业级门禁已通过。",
            deploymentAdvice,
            command?.Command ?? string.Empty,
            gateCounts,
            stepIndex,
            stepTotal,
            passedSteps,
            pendingSteps,
            currentStep,
            timeline);
    }

    private static string BuildDeploymentAdvice(
        string readinessOverall,
        string blockingCode,
        bool commercialComplete)
    {
        if (commercialComplete)
        {
            return "商业级门禁已通过；只有新代码变更、promotion 或环境切换时才需要重新部署。";
        }

        if (string.Equals(blockingCode, "R0", StringComparison.OrdinalIgnoreCase))
        {
            return "不要靠普通 preview redeploy 解决 R0；先采集 runtime pool evidence，确认 branch-local sidecar contamination、remote host、shared pool running 状态，再按恢复 runbook 处理。";
        }

        if (string.Equals(blockingCode, "R1", StringComparison.OrdinalIgnoreCase)
            || (string.IsNullOrWhiteSpace(blockingCode)
                && string.Equals(readinessOverall, "profile-blocked", StringComparison.OrdinalIgnoreCase)))
        {
            return "不要靠重新部署解决 R1；当前阻塞是默认 runtime profile/key，需要保存 Anthropic/Claude-compatible profile 后重跑 one-cycle。";
        }

        if (blockingCode.StartsWith("S", StringComparison.OrdinalIgnoreCase)
            || string.Equals(readinessOverall, "ready_for_provider_smokes", StringComparison.OrdinalIgnoreCase)
            || string.Equals(readinessOverall, "provider-smokes-required", StringComparison.OrdinalIgnoreCase))
        {
            return "不要重复部署；下一步是显式开启 provider smoke，补齐 S1/S2/S3 的真实调用证据。";
        }

        if (string.Equals(blockingCode, "A0", StringComparison.OrdinalIgnoreCase)
            || string.Equals(blockingCode, "T1", StringComparison.OrdinalIgnoreCase)
            || string.Equals(blockingCode, "N6", StringComparison.OrdinalIgnoreCase))
        {
            return "优先本地修代码并跑对应静态 smoke；通过后再决定是否需要部署验证远程行为。";
        }

        if (string.Equals(blockingCode, "V1", StringComparison.OrdinalIgnoreCase))
        {
            return "V1 是页面/登录态/截图证据；先本地或当前 preview 截图验证，避免为了截图证据重复部署。";
        }

        return "先运行页面给出的窄口径命令并查看诊断包；部署只用于验证远程 runtime、鉴权、容器网络或已完成的代码变更。";
    }

    private static SidecarDebugCommand? SelectExecutionCommand(
        string blockingCode,
        IReadOnlyList<SidecarDebugCommand> debugCommands)
    {
        if (string.Equals(blockingCode, "R0", StringComparison.OrdinalIgnoreCase))
        {
            return debugCommands.FirstOrDefault(x => x.Code == "runtime-pool-evidence")
                ?? debugCommands.FirstOrDefault(x => x.Code == "doctor");
        }

        if (string.Equals(blockingCode, "R1", StringComparison.OrdinalIgnoreCase))
        {
            return debugCommands.FirstOrDefault(x => x.Code == "r1-dry-run")
                ?? debugCommands.FirstOrDefault(x => x.Code == "r1-apply");
        }

        if (blockingCode.StartsWith("S", StringComparison.OrdinalIgnoreCase))
        {
            return debugCommands.FirstOrDefault(x => x.Code == "provider-cycle");
        }

        return debugCommands.FirstOrDefault(x =>
                string.Equals(x.Status, "blocked", StringComparison.OrdinalIgnoreCase))
            ?? debugCommands.FirstOrDefault(x =>
                !string.Equals(x.Status, "pass", StringComparison.OrdinalIgnoreCase))
            ?? debugCommands.FirstOrDefault();
    }

    private static IReadOnlyList<SidecarDebugCommand> BuildDebugCommands(
        SidecarPoolDiagnostics diagnostics,
        string desiredRuntimeAdapter,
        SidecarRuntimeProfileDiagnostics? profile,
        string remoteSmokePrefix)
    {
        var r0Ready = IsR0Ready(diagnostics, desiredRuntimeAdapter);
        var r0Status = r0Ready ? "pass" : "blocked";
        var r1Ready = profile is
        {
            HasApiKey: true,
            CompatibleWithDesiredRuntimeAdapter: true
        };
        var r1Status = r1Ready ? "pass" : "blocked";
        var providerStatus = r1Ready ? "ready" : "blocked";
        var providerBlockedBy = r1Ready ? null : "R1";
        return new[]
        {
            new SidecarDebugCommand(
                "runtime-pool-evidence",
                "R0 runtime pool 证据",
                remoteSmokePrefix + "CDS_AGENT_RUNTIME_POOL_RUN_GOAL_AUDIT=0 CDS_AGENT_RUNTIME_POOL_UPDATE_STATUS_DOC=1 bash scripts/collect-cds-agent-runtime-pool-evidence.sh",
                "只读采集 branch-local sidecar contamination、remote host、shared-service pool running 状态和恢复顺序；当前 R0 阻塞时优先跑它。",
                r0Status,
                r0Ready ? null : "R0"),
            new SidecarDebugCommand(
                "branch-isolation-dry-run",
                "Branch sidecar 清理预检",
                remoteSmokePrefix + "bash scripts/run-cds-agent-branch-isolation-repair-with-evidence.sh",
                "默认 dry-run，生成清理前后证据目录；显式 apply 前先确认候选 BuildProfile。",
                r0Status,
                r0Ready ? null : "R0"),
            new SidecarDebugCommand(
                "remote-host-prepare",
                "Remote host 准备预检",
                remoteSmokePrefix + "bash scripts/prepare-cds-agent-remote-host-pool.sh",
                "默认只读检查 CDS remote host 是否存在、缺哪些 SSH/image 配置；不会创建主机。",
                r0Status,
                r0Ready ? null : "R0"),
            new SidecarDebugCommand(
                "doctor",
                "本地诊断",
                remoteSmokePrefix + "bash scripts/doctor-cds-agent-runtime.sh",
                "只读检查 runtime pool、默认 profile、官方模板和下一步建议。",
                "ready"),
            new SidecarDebugCommand(
                "official-sdk-boundary",
                "官方 SDK 边界",
                "bash scripts/smoke-cds-agent-official-sdk-boundary.sh",
                "本地检查默认路径仍由 claude-agent-sdk 接管 turn loop，legacy loop 只作为显式 fallback。",
                "ready"),
            new SidecarDebugCommand(
                "r1-dry-run",
                "R1 修复预检",
                remoteSmokePrefix + "bash scripts/smoke-cds-agent-r1-profile-repair.sh",
                "不写入远程状态，验证后端 R1 修复计划、模板和缺 key 保护。",
                r1Status,
                r1Ready ? null : "Anthropic API key"),
            new SidecarDebugCommand(
                "r1-apply",
                "R1 test-before-promote",
                remoteSmokePrefix + "SMOKE_CDS_AGENT_ANTHROPIC_API_KEY=<sk-ant-...> bash scripts/smoke-cds-agent-r1-profile-repair.sh",
                "创建候选 Anthropic 官方 profile，测试通过后才提升为默认。",
                r1Status,
                r1Ready ? null : "Anthropic API key"),
            new SidecarDebugCommand(
                "provider-cycle",
                "一个周期 provider smoke",
                remoteSmokePrefix + "SMOKE_CDS_AGENT_ANTHROPIC_API_KEY=<sk-ant-...> SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1 bash scripts/smoke-cds-agent-one-cycle.sh",
                "R1 通过后跑 S1/S2/S3 和视觉证据；会触发真实 provider 调用。",
                providerStatus,
                providerBlockedBy),
            new SidecarDebugCommand(
                "non-code-compat",
                "非代码智能体回归",
                "bash scripts/smoke-cds-agent-non-code-compatibility.sh",
                "验证 PRD/defect/literary/visual 等非代码智能体不被 CDS runtime pool 污染，并确认其他官方 SDK 候选仍是 planned-not-routable。",
                "ready")
        };
    }

    private static string BuildRemoteSmokePrefix(IConfiguration? configuration)
    {
        var host = configuration?["CdsAgent:SmokeCdsHost"]
            ?? configuration?["CDS_AGENT_SMOKE_CDS_HOST"]
            ?? Environment.GetEnvironmentVariable("CDS_AGENT_SMOKE_CDS_HOST")
            ?? DefaultRemoteSmokeHost;
        host = host.Trim();
        if (string.IsNullOrWhiteSpace(host))
        {
            host = DefaultRemoteSmokeHost;
        }

        return $"CDS_HOST={host.TrimEnd('/')} ";
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
                "PRD/defect/literary/visual 不被 CDS sidecar pool 或 profile gate 阻断；候选官方 SDK 不被误标为默认可路由。",
                "scripts/smoke-cds-agent-non-code-compatibility.sh 通过；它覆盖源码扫描、构造函数反射、非代码 adapter 最小业务路径，以及 codex/openai-agents-sdk/google-adk planned-not-routable 兼容矩阵。",
                "ready-to-run",
                null,
                new[] { "bash scripts/smoke-cds-agent-non-code-compatibility.sh" })
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
        var officialInstances = CountOfficialSdkInstances(diagnostics);
        var r0Ready = IsR0Ready(diagnostics, desiredRuntimeAdapter);
        var r0NextActions = r0Ready
            ? Array.Empty<string>()
            : BuildRuntimePoolRecoveryActions(diagnostics);
        var a0Ready = string.Equals(desiredRuntimeAdapter, InfraAgentRuntimeAdapterDefaults.OfficialClaudeAgentSdk, StringComparison.OrdinalIgnoreCase)
            && InfraAgentRuntimeAdapterCompatibility.All.Any(x =>
                string.Equals(x.Id, InfraAgentRuntimeAdapterDefaults.OfficialClaudeAgentSdk, StringComparison.OrdinalIgnoreCase)
                && x.RoutableByDefault
                && string.Equals(x.LoopOwner, InfraAgentRuntimeAdapterDefaults.OfficialClaudeAgentSdk, StringComparison.OrdinalIgnoreCase)
                && string.Equals(x.MapRole, "control-plane-only", StringComparison.OrdinalIgnoreCase)
                && x.MissingAdapterContracts.Count == 0);
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
        var profileBlockReasonCode = r1Ready
            ? null
            : profile?.CompatibilityReasonCode
                ?? (profile == null
                    ? "runtime-profile-missing"
                    : !profile.HasApiKey
                        ? "runtime-profile-api-key-missing"
                        : "runtime-profile-incompatible");
        var profileBlockReason = profile?.CompatibilityReason
            ?? profile?.Warning
            ?? "create a default Anthropic/Claude-compatible runtime profile with API key";
        var profileBlockNextActions = profile?.CompatibilityNextActions is { Count: > 0 } actions
            ? actions
            : new[] { "使用 Anthropic 官方模板创建默认 profile，并填入 API key" };
        var providerStatus = r1Ready ? "unblocked" : "pending";
        var providerMessage = r1Ready
            ? "默认 profile 已兼容并带 key；可以显式开启 provider smoke 验证真实 run。"
            : $"等待 R1 通过后再运行真实 provider smoke：{profileBlockReason}";

        var gates = new List<SidecarCommercialReadinessGate>
        {
            new(
                "R0",
                "MAP/CDS runtime pool official SDK loop ownership",
                r0Ready ? "pass" : "pending",
                r0Ready
                    ? $"pool={diagnostics.HealthyCount}/{diagnostics.InstanceCount} officialInstances={officialInstances}"
                    : BuildR0BlockedMessage(diagnostics, officialInstances),
                r0NextActions),
            new(
                "A0",
                "Official SDK adapter boundary",
                a0Ready ? "pass" : "pending",
                a0Ready
                    ? "default adapter contract is claude-agent-sdk control-plane-only; legacy loop is explicit fallback"
                    : "official SDK adapter boundary is missing or has unresolved contracts",
                a0Ready ? Array.Empty<string>() : new[] { "运行 bash scripts/smoke-cds-agent-official-sdk-boundary.sh 并检查 adapter compatibility API" }),
            new(
                "R1",
                "Default runtime profile compatibility",
                r1Ready ? "pass" : "pending",
                r1Ready
                    ? "default profile can be used by claude-agent-sdk"
                    : profileBlockReason,
                r1Ready ? Array.Empty<string>() : profileBlockNextActions,
                profileBlockReasonCode),
            new(
                "T1",
                "Official template and adapter compatibility APIs",
                t1Ready ? "pass" : "pending",
                t1Ready
                    ? "template and compatibility matrix are backend-owned"
                    : "backend template or adapter compatibility matrix is missing official SDK support",
                t1Ready ? Array.Empty<string>() : new[] { "检查 runtime profile templates 与 adapter compatibility API" }),
            new("S1", "Read-only provider run", providerStatus, providerMessage,
                r1Ready ? new[] { "运行 SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1 smoke-cds-agent-official-sdk-run.sh" } : profileBlockNextActions,
                profileBlockReasonCode),
            new("S2", "MAP tool approval provider run", providerStatus, providerMessage,
                r1Ready ? new[] { "运行 SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1 smoke-cds-agent-official-sdk-controls.sh" } : profileBlockNextActions,
                profileBlockReasonCode),
            new("S3", "Stop / interrupt provider run", providerStatus, providerMessage,
                r1Ready ? new[] { "运行 SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1 smoke-cds-agent-official-sdk-controls.sh" } : profileBlockNextActions,
                profileBlockReasonCode)
        };
        var passed = gates.Count(x => string.Equals(x.Status, "pass", StringComparison.OrdinalIgnoreCase));
        var pending = gates
            .Where(x => !string.Equals(x.Status, "pass", StringComparison.OrdinalIgnoreCase))
            .Select(x => $"{x.Code}: {x.Message}")
            .ToArray();
        var overall = passed == gates.Count
            ? "ready-for-visual-evidence"
            : !r0Ready
                ? "runtime-pool-blocked"
                : r1Ready
                    ? "provider-smokes-required"
                    : "profile-blocked";
        return new SidecarCommercialReadinessDiagnostics(overall, passed, gates.Count, gates, pending);
    }

    private static int CountOfficialSdkInstances(SidecarPoolDiagnostics diagnostics)
    {
        return diagnostics.Instances.Count(x =>
            string.Equals(x.LoopOwner, InfraAgentRuntimeAdapterDefaults.OfficialClaudeAgentSdk, StringComparison.OrdinalIgnoreCase)
            || x.SdkLoopEnabled == true);
    }

    private static bool IsR0Ready(SidecarPoolDiagnostics diagnostics, string desiredRuntimeAdapter)
    {
        return diagnostics.InstanceCount > 0
            && diagnostics.HealthyCount > 0
            && CountOfficialSdkInstances(diagnostics) > 0
            && string.Equals(desiredRuntimeAdapter, InfraAgentRuntimeAdapterDefaults.OfficialClaudeAgentSdk, StringComparison.OrdinalIgnoreCase);
    }

    private static string BuildR0BlockedMessage(SidecarPoolDiagnostics diagnostics, int officialInstances)
    {
        var metrics = diagnostics.DiscoveryMetrics;
        var parts = new List<string>
        {
            $"instanceCount={diagnostics.InstanceCount}",
            $"healthyCount={diagnostics.HealthyCount}",
            $"officialInstances={officialInstances}"
        };
        if (metrics?.RunningBranchServiceCount is int runningBranchServices)
        {
            parts.Add($"runningBranchServiceCount={runningBranchServices}");
        }
        if (metrics?.RuntimeBranchServiceCount is int runtimeBranchServices)
        {
            parts.Add($"runtimeBranchServiceCount={runtimeBranchServices}");
        }
        if (metrics?.EmptyEndpoints is int emptyEndpoints)
        {
            parts.Add($"emptyEndpoints={emptyEndpoints}");
        }
        parts.Add("next=collect runtime pool evidence before redeploy");
        return string.Join(" ", parts);
    }

    private static IReadOnlyList<string> BuildRuntimePoolRecoveryActions(SidecarPoolDiagnostics diagnostics)
    {
        var actions = new List<string>
        {
            "运行 CDS_AGENT_RUNTIME_POOL_RUN_GOAL_AUDIT=0 bash scripts/collect-cds-agent-runtime-pool-evidence.sh，先得到 branch-local sidecar、remote host、shared pool running 的同一份证据。",
            "如果 evidence 显示 branch-local sidecar contamination，先用 scripts/run-cds-agent-branch-isolation-repair-with-evidence.sh dry-run 确认候选 BuildProfile，再按审批执行清理。",
            "如果 evidence 显示 remote host missing，先用 scripts/prepare-cds-agent-remote-host-pool.sh 检查缺失的 SSH/image 配置；不要通过普通 preview redeploy 解决。",
            "shared-service runtime pool 恢复 running official SDK instance 后，再重跑 MAP R0/S1/S2/S3/one-cycle。"
        };
        if (diagnostics.NextActions is { Count: > 0 })
        {
            actions.AddRange(diagnostics.NextActions.Take(3));
        }
        return actions;
    }

    private async Task<SidecarRuntimeProfileDiagnostics?> ResolveDefaultRuntimeProfileDiagnosticsAsync(
        string desiredRuntimeAdapter,
        CancellationToken ct)
    {
        var profiles = await _runtimeProfiles!.ListAsync(ct);
        var selected = profiles.FirstOrDefault(x => x.IsDefault) ?? profiles.FirstOrDefault();
        if (selected == null) return null;

        var compatibility = InfraAgentRuntimeProfileCompatibility.AnalyzeForDesiredRuntimeAdapter(
            desiredRuntimeAdapter,
            selected.Protocol,
            selected.Model);
        var warning = compatibility.Compatible
            ? null
            : compatibility.Reason;
        return new SidecarRuntimeProfileDiagnostics(
            selected.Id,
            selected.Name,
            selected.Runtime,
            selected.Protocol,
            selected.Model,
            selected.HasApiKey,
            selected.IsDefault,
            compatibility.Compatible,
            warning,
            compatibility.ReasonCode,
            compatibility.Reason,
            compatibility.NextActions);
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
        result.AddRange(profile.CompatibilityNextActions ?? Array.Empty<string>());
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
