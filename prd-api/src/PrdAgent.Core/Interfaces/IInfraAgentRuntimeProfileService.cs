using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

public interface IInfraAgentRuntimeProfileService
{
    Task<List<InfraAgentRuntimeProfileView>> ListAsync(string userId, CancellationToken ct);

    Task<List<InfraAgentRuntimeProfileTemplateView>> ListTemplatesAsync(CancellationToken ct);

    Task<List<InfraAgentRuntimeAdapterCompatibilityView>> ListAdapterCompatibilityAsync(CancellationToken ct);

    Task<InfraAgentRuntimeAdapterMatrixView> GetAdapterMatrixAsync(string userId, CancellationToken ct);

    Task<InfraAgentRuntimeProfileView> CreateAsync(string userId, UpsertInfraAgentRuntimeProfileRequest request, CancellationToken ct);

    Task<InfraAgentRuntimeProfileView> CreateFromTemplateAsync(string templateId, string userId, CreateInfraAgentRuntimeProfileFromTemplateRequest request, CancellationToken ct);

    Task<InfraAgentRuntimeProfilePromotionResult> CreateDefaultFromTemplateAfterTestAsync(string templateId, string userId, CreateInfraAgentRuntimeProfileFromTemplateRequest request, CancellationToken ct);

    Task<InfraAgentRuntimeProfileView> UpdateAsync(string id, string userId, UpsertInfraAgentRuntimeProfileRequest request, CancellationToken ct);

    Task<InfraAgentRuntimeProfileView> ImportDefaultModelAsync(string userId, CancellationToken ct);

    Task<bool> DeleteAsync(string id, string userId, CancellationToken ct);

    Task<InfraAgentRuntimeProfileSecretView?> ResolveAsync(string? id, string userId, CancellationToken ct);

    Task<InfraAgentRuntimeProfileTestResult> TestAsync(string id, string userId, CancellationToken ct);
}

public record UpsertInfraAgentRuntimeProfileRequest(
    string? Name,
    string? Runtime,
    string? Protocol,
    string? BaseUrl,
    string? Model,
    string? ApiKey,
    double? ResourceCpuCores = null,
    int? ResourceMemoryMb = null,
    int? TimeoutSeconds = null,
    string? NetworkPolicy = null,
    int? AutoCleanupMinutes = null,
    bool? IsDefault = null
);

public record CreateInfraAgentRuntimeProfileFromTemplateRequest(
    string? Name,
    string? ApiKey,
    bool? IsDefault = null
);

public record InfraAgentRuntimeProfilePromotionResult(
    InfraAgentRuntimeProfileView Item,
    InfraAgentRuntimeProfileTestResult Test
);

public record InfraAgentRuntimeProfileView(
    string Id,
    string Name,
    string Runtime,
    string Protocol,
    string BaseUrl,
    string Model,
    double ResourceCpuCores,
    int ResourceMemoryMb,
    int TimeoutSeconds,
    string NetworkPolicy,
    int AutoCleanupMinutes,
    bool HasApiKey,
    bool IsDefault,
    DateTime CreatedAt,
    DateTime UpdatedAt
);

public record InfraAgentRuntimeProfileTemplateView(
    string Id,
    string Name,
    string Description,
    string Runtime,
    string Protocol,
    string BaseUrl,
    string Model,
    double ResourceCpuCores,
    int ResourceMemoryMb,
    int TimeoutSeconds,
    string NetworkPolicy,
    int AutoCleanupMinutes,
    bool IsDefaultRecommended,
    IReadOnlyList<string> CompatibleRuntimeAdapters
);

public record InfraAgentRuntimeAdapterCompatibilityView(
    string Id,
    string Label,
    string Status,
    bool RoutableByDefault,
    string LoopOwner,
    string MapRole,
    string CdsRole,
    IReadOnlyList<string> SupportedTaskKinds,
    IReadOnlyList<string> SupportedProfileProtocols,
    IReadOnlyList<string> ModelHints,
    IReadOnlyList<string> CompatibleRuntimeProfileTemplateIds,
    IReadOnlyList<string> RequiredEvidenceGates,
    IReadOnlyList<string> MissingAdapterContracts,
    IReadOnlyList<string> KnownIncompatibleProfilePatterns,
    IReadOnlyList<string> Notes,
    IReadOnlyList<string> NextActions
);

public record InfraAgentRuntimeAdapterMatrixView(
    string SchemaVersion,
    DateTime GeneratedAt,
    string DesiredRuntimeAdapter,
    InfraAgentRuntimeAdapterMatrixSummaryView Summary,
    IReadOnlyList<InfraAgentRuntimeAdapterMatrixRowView> Rows
);

public record InfraAgentRuntimeAdapterMatrixSummaryView(
    int AdapterCount,
    int RoutableAdapterCount,
    int DefaultRoutableAdapterCount,
    int BlockedAdapterCount,
    int ProfileCount,
    int TemplateCount
);

public record InfraAgentRuntimeAdapterMatrixRowView(
    string AdapterId,
    string Label,
    string Status,
    string RouteState,
    bool IsDesired,
    bool RoutableByDefault,
    string LoopOwner,
    string MapRole,
    string CdsRole,
    IReadOnlyList<InfraAgentRuntimeAdapterGateView> Gates,
    IReadOnlyList<string> MissingAdapterContracts,
    IReadOnlyList<InfraAgentRuntimeAdapterProfileCandidateView> ProfileCandidates,
    IReadOnlyList<InfraAgentRuntimeAdapterTemplateCandidateView> TemplateCandidates,
    IReadOnlyList<string> NextActions
);

public record InfraAgentRuntimeAdapterGateView(
    string Code,
    string Status,
    string Reason
);

public record InfraAgentRuntimeAdapterProfileCandidateView(
    string Id,
    string Name,
    string Runtime,
    string Protocol,
    string Model,
    bool HasApiKey,
    bool IsDefault,
    bool Compatible,
    string ReasonCode,
    string Reason,
    IReadOnlyList<string> NextActions
);

public record InfraAgentRuntimeAdapterTemplateCandidateView(
    string Id,
    string Name,
    string Runtime,
    string Protocol,
    string Model,
    bool IsDefaultRecommended,
    bool Compatible,
    string ReasonCode,
    string Reason
);

public record InfraAgentRuntimeProfileSecretView(
    string Id,
    string Name,
    string Runtime,
    string Protocol,
    string BaseUrl,
    string Model,
    double ResourceCpuCores,
    int ResourceMemoryMb,
    int TimeoutSeconds,
    string NetworkPolicy,
    int AutoCleanupMinutes,
    string ApiKey
);

public record InfraAgentRuntimeProfileTestResult(
    string Id,
    bool Success,
    string Status,
    string Message,
    string Protocol,
    string BaseUrl,
    string Model,
    int? HttpStatus,
    long ElapsedMs
);

public record InfraAgentRuntimeProfileCompatibilityDecision(
    bool Compatible,
    string ReasonCode,
    string Reason,
    IReadOnlyList<string> NextActions
);

public static class InfraAgentRuntimeProfileCompatibility
{
    public static bool IsCompatibleWithDesiredRuntimeAdapter(
        string? desiredRuntimeAdapter,
        string? protocol,
        string? model)
    {
        return AnalyzeForDesiredRuntimeAdapter(desiredRuntimeAdapter, protocol, model).Compatible;
    }

    public static InfraAgentRuntimeProfileCompatibilityDecision AnalyzeForDesiredRuntimeAdapter(
        string? desiredRuntimeAdapter,
        string? protocol,
        string? model)
    {
        return AnalyzeForDesiredRuntimeAdapter(desiredRuntimeAdapter, null, protocol, model);
    }

    public static InfraAgentRuntimeProfileCompatibilityDecision AnalyzeForDesiredRuntimeAdapter(
        string? desiredRuntimeAdapter,
        string? runtime,
        string? protocol,
        string? model)
    {
        if (!string.Equals(desiredRuntimeAdapter, "claude-agent-sdk", StringComparison.OrdinalIgnoreCase))
        {
            return new InfraAgentRuntimeProfileCompatibilityDecision(
                true,
                "adapter-not-claude-agent-sdk",
                "当前目标 adapter 不是 claude-agent-sdk；不套用 Claude/Anthropic profile gate。",
                Array.Empty<string>());
        }

        if (!string.IsNullOrWhiteSpace(runtime)
            && !string.Equals(runtime, InfraAgentRuntimes.ClaudeSdk, StringComparison.OrdinalIgnoreCase)
            && !string.Equals(runtime, InfraAgentRuntimes.Custom, StringComparison.OrdinalIgnoreCase))
        {
            return new InfraAgentRuntimeProfileCompatibilityDecision(
                false,
                "runtime-adapter-mismatch",
                $"当前 profile runtime={runtime}，不应被路由到 claude-agent-sdk；需要选择匹配的 official SDK adapter，或只在明确使用 Claude 时切换到 Claude profile。",
                new[]
                {
                    "不要把 raw OpenAI-compatible Chat Completions endpoint 注入 Claude SDK adapter。",
                    "如果目标是 cc-switch/DeepSeek，请保存为 claude-sdk runtime + anthropic protocol + Anthropic-compatible baseUrl/provider secret。",
                    "只有 baseUrl=https://api.anthropic.com 的原生 Claude 路径才要求 Anthropic sk-ant provider secret。"
                });
        }

        var normalizedProtocol = protocol ?? string.Empty;
        var normalizedModel = model ?? string.Empty;
        if (normalizedProtocol.Equals("anthropic", StringComparison.OrdinalIgnoreCase))
        {
            return new InfraAgentRuntimeProfileCompatibilityDecision(
                true,
                "anthropic-protocol",
                "profile protocol=anthropic，可作为 claude-agent-sdk provider profile。",
                Array.Empty<string>());
        }

        if (normalizedModel.Contains("claude", StringComparison.OrdinalIgnoreCase)
            || normalizedModel.StartsWith("anthropic/", StringComparison.OrdinalIgnoreCase))
        {
            return new InfraAgentRuntimeProfileCompatibilityDecision(
                true,
                "claude-model-hint",
                "profile model 指向 Claude/Anthropic 模型，可进入 provider smoke 验证。",
                Array.Empty<string>());
        }

        return new InfraAgentRuntimeProfileCompatibilityDecision(
            false,
            "openai-compatible-non-claude-model",
            "claude-agent-sdk 需要 Anthropic-compatible Messages endpoint；当前 profile 是 raw OpenAI-compatible Chat Completions endpoint。",
            new[]
            {
                "原生 Claude 可使用 Anthropic 官方模板创建默认 runtime profile。",
                "cc-switch/DeepSeek 需使用 claude-sdk runtime + anthropic protocol，并把 baseUrl 指向 Anthropic-compatible 网关。",
                "raw OpenAI-compatible Chat Completions endpoint 不能直接当作 Claude Code SDK 上游。"
            });
    }

    public static string BuildIncompatibleMessage(string profileName, string model) =>
        $"当前运行配置 {profileName} / {model} 与所选 agent adapter 不匹配。Claude Agent SDK 路径需要 Anthropic-compatible Messages endpoint；cc-switch/DeepSeek 可以使用 claude-sdk runtime，但 profile protocol 必须是 anthropic，baseUrl 指向兼容网关。";
}

public static class InfraAgentRuntimeProfileTemplates
{
    public const string AnthropicOfficialClaudeSonnet4 = "anthropic-official-claude-sonnet-4";

    public static IReadOnlyList<InfraAgentRuntimeProfileTemplateView> All { get; } =
    [
        new(
            AnthropicOfficialClaudeSonnet4,
            "Anthropic Claude Sonnet 4",
            "官方 Anthropic Messages profile；用于 Claude Agent SDK adapter 的默认推荐模板，只需补入 Anthropic API key。",
            InfraAgentRuntimes.ClaudeSdk,
            InfraAgentRuntimeProtocols.Anthropic,
            "https://api.anthropic.com",
            "claude-sonnet-4-20250514",
            2,
            4096,
            900,
            InfraAgentRuntimeNetworkPolicies.Restricted,
            30,
            true,
            [InfraAgentRuntimeAdapterDefaults.OfficialClaudeAgentSdk])
    ];

    public static void ValidateApiKeyForTemplate(InfraAgentRuntimeProfileTemplateView template, string? apiKey)
    {
        var normalized = apiKey?.Trim();
        if (string.Equals(template.Id, AnthropicOfficialClaudeSonnet4, StringComparison.OrdinalIgnoreCase))
        {
            if (string.IsNullOrWhiteSpace(normalized))
            {
                throw new InfraAgentRuntimeProfileException(
                    InfraAgentRuntimeProfileErrorCodes.ApiKeyRequired,
                    "Anthropic 官方模板需要填写 provider secret。");
            }

            if (!normalized.StartsWith("sk-ant-", StringComparison.Ordinal))
            {
                throw new InfraAgentRuntimeProfileException(
                    InfraAgentRuntimeProfileErrorCodes.ApiKeyFormatInvalid,
                    "Anthropic 官方模板只接受 sk-ant- 开头的 provider secret；cc-switch/DeepSeek 请使用自定义 profile，不要套用原生 Anthropic 官方模板。");
            }
        }
    }

    public static void ValidateApiKeyForProfile(string? protocol, string? baseUrl, string? apiKey)
    {
        var normalized = apiKey?.Trim();
        if (!IsOfficialAnthropicEndpoint(protocol, baseUrl))
        {
            return;
        }

        if (string.IsNullOrWhiteSpace(normalized))
        {
            throw new InfraAgentRuntimeProfileException(
                InfraAgentRuntimeProfileErrorCodes.ApiKeyRequired,
                "Anthropic 官方 endpoint 需要填写 provider secret。");
        }

        if (!normalized.StartsWith("sk-ant-", StringComparison.Ordinal))
        {
            throw new InfraAgentRuntimeProfileException(
                InfraAgentRuntimeProfileErrorCodes.ApiKeyFormatInvalid,
                "Anthropic 官方 endpoint 只接受 sk-ant- 开头的 provider secret；cc-switch/DeepSeek 自定义 key 请使用对应 Anthropic-compatible baseUrl。");
        }
    }

    private static bool IsOfficialAnthropicEndpoint(string? protocol, string? baseUrl)
    {
        if (!string.Equals(protocol?.Trim(), InfraAgentRuntimeProtocols.Anthropic, StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        if (!Uri.TryCreate(baseUrl?.Trim(), UriKind.Absolute, out var uri))
        {
            return false;
        }

        return string.Equals(uri.Host, "api.anthropic.com", StringComparison.OrdinalIgnoreCase);
    }
}

public static class InfraAgentRuntimeAdapterCompatibility
{
    public const string SidecarLegacyLoop = "legacy-sidecar";
    public const string CodexPlanned = "codex";
    public const string OpenAiAgentsSdkPlanned = "openai-agents-sdk";
    public const string GoogleAdkPlanned = "google-adk";

    public static IReadOnlyList<InfraAgentRuntimeAdapterCompatibilityView> All { get; } =
    [
        new(
            InfraAgentRuntimeAdapterDefaults.OfficialClaudeAgentSdk,
            "Official Claude Agent SDK adapter",
            "default-supported",
            true,
            "claude-agent-sdk",
            "control-plane-only",
            "workspace-runtime-host",
            ["code-review", "repo-readonly-analysis", "repo-tool-execution-with-map-approval"],
            [InfraAgentRuntimeProtocols.Anthropic, InfraAgentRuntimeProtocols.OpenAiCompatible],
            ["protocol=anthropic", "Anthropic-compatible gateway", "cc-switch/DeepSeek via ANTHROPIC_BASE_URL"],
            [InfraAgentRuntimeProfileTemplates.AnthropicOfficialClaudeSonnet4],
            ["R0", "A0", "R1", "S1", "S2", "S3", "V1", "N6"],
            [],
            ["raw openai-compatible Chat Completions endpoint without Anthropic-compatible gateway"],
            [
                "MAP/CDS 只保留 session、workspace、审批、日志、事件和产物控制面。",
                "Agent turn loop、上下文管理和 Claude Code 工具调用归官方 claude-agent-sdk。",
                "cc-switch、DeepSeek Anthropic endpoint、Kimi/GLM Anthropic-compatible endpoint 可作为 Claude Code 上游切换路径；它们不要求 Anthropic 原生 key。"
            ],
            [
                "原生 Claude 选择 Anthropic 官方模板。",
                "cc-switch/DeepSeek 选择 claude-sdk runtime + anthropic protocol，并把 baseUrl 指到兼容网关。"
            ]),
        new(
            SidecarLegacyLoop,
            "Sidecar legacy fallback",
            "explicit-fallback",
            false,
            "sidecar-legacy-loop",
            "control-plane-plus-legacy-loop",
            "workspace-runtime-host",
            ["migration-debug-fallback"],
            [InfraAgentRuntimeProtocols.Anthropic, InfraAgentRuntimeProtocols.OpenAiCompatible],
            ["legacy self-managed loop only"],
            [],
            ["explicit-operator-opt-in"],
            ["official-sdk-loop-ownership"],
            [],
            [
                "该路径保留给迁移期排障和显式 fallback。",
                "它不是目标终态；能走官方 SDK 的代码任务不应继续扩展 legacy loop。"
            ],
            [
                "仅在 INFRA_AGENT_SIDECAR_RUNTIME_ADAPTER=legacy-sidecar 显式配置时使用。",
                "新增代码任务能力优先接入官方 SDK adapter。"
            ]),
        new(
            CodexPlanned,
            "Codex-like adapter",
            "planned-not-routable",
            false,
            "external-official-runtime",
            "control-plane-only",
            "workspace-runtime-host",
            [],
            [],
            ["not implemented in current CDS Agent runtime pool"],
            [],
            ["R0", "A0", "R1", "S1", "S2", "S3", "V1", "N6"],
            ["run", "event", "tool-approval", "cancel", "workspace", "artifact"],
            ["runtime=codex currently has no official adapter implementation in this repo"],
            [
                "当前页面可保存 runtime=codex profile，但 CDS Agent 代码任务不会因此自动获得 Codex 官方能力。",
                "后续若接入官方 Codex/Agents SDK，应沿用 MAP/CDS 控制面，新增薄 adapter，而不是复制 Claude legacy loop。"
            ],
            [
                "在官方 adapter、工具审批、取消和事件映射完成前，不要把用户代码审查任务默认路由到 codex runtime。"
            ]),
        new(
            OpenAiAgentsSdkPlanned,
            "OpenAI Agents SDK adapter candidate",
            "planned-not-routable",
            false,
            "openai-agents-sdk",
            "control-plane-only",
            "workspace-runtime-host",
            ["non-code-orchestration-candidate"],
            [InfraAgentRuntimeProtocols.OpenAiCompatible],
            ["built-in tracing", "tool calls", "handoffs", "guardrails"],
            [],
            ["adapter-contract", "S1", "S2", "S3", "V1", "N6"],
            ["workspace", "map-approval-bridge", "cancel", "event-trace-to-run-bundle"],
            [
                "当前 CDS Agent 尚未实现 OpenAI Agents SDK 的 workspace、审批、取消和事件 adapter。",
                "OpenAI-compatible profile 只能说明模型协议可用，不能自动等价于代码审查 agent runtime。"
            ],
            [
                "OpenAI Agents SDK 可提供 tracing、tool call、handoff 和 guardrail 等官方能力。",
                "接入时 MAP/CDS 仍只做控制面，不复制新的自研 agent loop。"
            ],
            [
                "先定义 OpenAI Agents SDK run/event/tool approval/cancel 到 MAP/CDS 的 adapter contract。",
                "通过 S1/S2/S3 同口径 smoke 后，才允许作为代码审查任务 runtime。"
            ]),
        new(
            GoogleAdkPlanned,
            "Google ADK adapter candidate",
            "planned-not-routable",
            false,
            "google-adk",
            "control-plane-only",
            "workspace-runtime-host",
            ["non-code-orchestration-candidate", "gemini-ecosystem-candidate"],
            [],
            ["agent framework", "tool ecosystem", "deployment/runtime integrations"],
            [],
            ["adapter-contract", "S1", "S2", "S3", "V1", "N6"],
            ["session", "artifact", "tool-approval", "cancel", "event-trace-to-run-bundle"],
            [
                "当前 CDS Agent 尚未实现 Google ADK 的 session、artifact、tool approval、cancel 和 event adapter。",
                "ADK 可做智能体框架候选，但不能直接复用 Claude Agent SDK 的 provider profile。"
            ],
            [
                "Google ADK 可作为 agent framework 和工具生态候选。",
                "接入时需要先把 ADK session/artifact 语义收敛到 MAP/CDS run bundle。"
            ],
            [
                "先设计 ADK artifact/session/tool approval 到 MAP/CDS 的兼容层。",
                "在真实 provider smoke 和页面诊断都通过前，不要把代码审查任务默认路由到 google-adk。"
            ])
    ];

    public static InfraAgentRuntimeAdapterMatrixView BuildMatrix(
        string? desiredRuntimeAdapter,
        IReadOnlyList<InfraAgentRuntimeProfileView> profiles,
        IReadOnlyList<InfraAgentRuntimeProfileTemplateView> templates)
    {
        var desired = string.IsNullOrWhiteSpace(desiredRuntimeAdapter)
            ? InfraAgentRuntimeAdapterDefaults.OfficialClaudeAgentSdk
            : desiredRuntimeAdapter.Trim();
        var rows = All.Select(adapter =>
        {
            var routeState = BuildRouteState(adapter);
            var gates = adapter.RequiredEvidenceGates.Select(gate => new InfraAgentRuntimeAdapterGateView(
                gate,
                adapter.MissingAdapterContracts.Count == 0 && adapter.RoutableByDefault ? "pass" : "blocked",
                adapter.MissingAdapterContracts.Count == 0
                    ? "contract satisfied"
                    : $"missing: {string.Join(", ", adapter.MissingAdapterContracts)}")).ToList();
            var profileCandidates = profiles
                .Select(profile => BuildProfileCandidate(adapter, profile))
                .OrderByDescending(x => x.Compatible)
                .ThenByDescending(x => x.IsDefault)
                .ThenBy(x => x.Name, StringComparer.OrdinalIgnoreCase)
                .ToList();
            var templateCandidates = templates
                .Select(template => BuildTemplateCandidate(adapter, template))
                .OrderByDescending(x => x.Compatible)
                .ThenByDescending(x => x.IsDefaultRecommended)
                .ThenBy(x => x.Name, StringComparer.OrdinalIgnoreCase)
                .ToList();

            return new InfraAgentRuntimeAdapterMatrixRowView(
                adapter.Id,
                adapter.Label,
                adapter.Status,
                routeState,
                string.Equals(adapter.Id, desired, StringComparison.OrdinalIgnoreCase),
                adapter.RoutableByDefault,
                adapter.LoopOwner,
                adapter.MapRole,
                adapter.CdsRole,
                gates,
                adapter.MissingAdapterContracts,
                profileCandidates,
                templateCandidates,
                adapter.NextActions);
        }).ToList();

        return new InfraAgentRuntimeAdapterMatrixView(
            "cds-agent-runtime-adapter-matrix/v1",
            DateTime.UtcNow,
            desired,
            new InfraAgentRuntimeAdapterMatrixSummaryView(
                rows.Count,
                rows.Count(x => x.RouteState is "default-routable" or "explicit-fallback"),
                rows.Count(x => x.RouteState == "default-routable"),
                rows.Count(x => x.RouteState is "blocked" or "planned-blocked"),
                profiles.Count,
                templates.Count),
            rows);
    }

    private static string BuildRouteState(InfraAgentRuntimeAdapterCompatibilityView adapter)
    {
        if (adapter.MissingAdapterContracts.Count > 0) return "planned-blocked";
        if (adapter.RoutableByDefault) return "default-routable";
        if (adapter.Status.Contains("fallback", StringComparison.OrdinalIgnoreCase)) return "explicit-fallback";
        return "blocked";
    }

    private static InfraAgentRuntimeAdapterProfileCandidateView BuildProfileCandidate(
        InfraAgentRuntimeAdapterCompatibilityView adapter,
        InfraAgentRuntimeProfileView profile)
    {
        var decision = AnalyzeProfileForAdapter(adapter, profile.Runtime, profile.Protocol, profile.Model);
        return new InfraAgentRuntimeAdapterProfileCandidateView(
            profile.Id,
            profile.Name,
            profile.Runtime,
            profile.Protocol,
            profile.Model,
            profile.HasApiKey,
            profile.IsDefault,
            decision.Compatible,
            decision.ReasonCode,
            decision.Reason,
            decision.NextActions);
    }

    private static InfraAgentRuntimeAdapterTemplateCandidateView BuildTemplateCandidate(
        InfraAgentRuntimeAdapterCompatibilityView adapter,
        InfraAgentRuntimeProfileTemplateView template)
    {
        var decision = AnalyzeProfileForAdapter(adapter, template.Runtime, template.Protocol, template.Model);
        var explicitlyCompatible = template.CompatibleRuntimeAdapters.Contains(adapter.Id, StringComparer.OrdinalIgnoreCase);
        var compatible = decision.Compatible || explicitlyCompatible;
        return new InfraAgentRuntimeAdapterTemplateCandidateView(
            template.Id,
            template.Name,
            template.Runtime,
            template.Protocol,
            template.Model,
            template.IsDefaultRecommended,
            compatible,
            compatible ? decision.ReasonCode : "template-adapter-mismatch",
            compatible ? decision.Reason : "该模板未声明兼容当前 adapter。");
    }

    private static InfraAgentRuntimeProfileCompatibilityDecision AnalyzeProfileForAdapter(
        InfraAgentRuntimeAdapterCompatibilityView adapter,
        string? runtime,
        string? protocol,
        string? model)
    {
        if (string.Equals(adapter.Id, InfraAgentRuntimeAdapterDefaults.OfficialClaudeAgentSdk, StringComparison.OrdinalIgnoreCase))
        {
            return InfraAgentRuntimeProfileCompatibility.AnalyzeForDesiredRuntimeAdapter(adapter.Id, runtime, protocol, model);
        }

        if (adapter.SupportedProfileProtocols.Count == 0)
        {
            return new InfraAgentRuntimeProfileCompatibilityDecision(
                false,
                "adapter-profile-contract-missing",
                "该 adapter 尚未声明 profile protocol contract，不能把现有 profile 自动路由过去。",
                adapter.NextActions);
        }

        if (adapter.SupportedProfileProtocols.Contains(protocol ?? string.Empty, StringComparer.OrdinalIgnoreCase))
        {
            return new InfraAgentRuntimeProfileCompatibilityDecision(
                true,
                "profile-protocol-compatible",
                $"profile protocol={protocol} 与 adapter 支持的 profile protocol 匹配；仍需通过 adapter contract 和 smoke gate 才能路由。",
                Array.Empty<string>());
        }

        return new InfraAgentRuntimeProfileCompatibilityDecision(
            false,
            "profile-protocol-mismatch",
            $"profile protocol={protocol ?? "unknown"} 不在 adapter 支持列表：{string.Join(", ", adapter.SupportedProfileProtocols)}。",
            adapter.NextActions);
    }
}

public static class InfraAgentRuntimeProfileErrorCodes
{
    public const string NameRequired = "name_required";
    public const string BaseUrlInvalid = "base_url_invalid";
    public const string ModelRequired = "model_required";
    public const string ApiKeyRequired = "api_key_required";
    public const string ApiKeyFormatInvalid = "api_key_format_invalid";
    public const string ApiKeyUnreadable = "api_key_unreadable";
    public const string ProfileNotFound = "profile_not_found";
    public const string ModelNotConfigured = "model_not_configured";
    public const string ModelConfigIncomplete = "model_config_incomplete";
    public const string TemplateNotFound = "template_not_found";
    public const string ProfileTestFailed = "profile_test_failed";
}

public class InfraAgentRuntimeProfileException : Exception
{
    public string ErrorCode { get; }
    public int HttpStatus { get; }

    public InfraAgentRuntimeProfileException(string errorCode, string message, int httpStatus = 400)
        : base(message)
    {
        ErrorCode = errorCode;
        HttpStatus = httpStatus;
    }
}
