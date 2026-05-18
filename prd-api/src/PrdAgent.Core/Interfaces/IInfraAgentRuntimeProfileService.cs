using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

public interface IInfraAgentRuntimeProfileService
{
    Task<List<InfraAgentRuntimeProfileView>> ListAsync(CancellationToken ct);

    Task<List<InfraAgentRuntimeProfileTemplateView>> ListTemplatesAsync(CancellationToken ct);

    Task<List<InfraAgentRuntimeAdapterCompatibilityView>> ListAdapterCompatibilityAsync(CancellationToken ct);

    Task<InfraAgentRuntimeProfileView> CreateAsync(string userId, UpsertInfraAgentRuntimeProfileRequest request, CancellationToken ct);

    Task<InfraAgentRuntimeProfileView> CreateFromTemplateAsync(string templateId, string userId, CreateInfraAgentRuntimeProfileFromTemplateRequest request, CancellationToken ct);

    Task<InfraAgentRuntimeProfilePromotionResult> CreateDefaultFromTemplateAfterTestAsync(string templateId, string userId, CreateInfraAgentRuntimeProfileFromTemplateRequest request, CancellationToken ct);

    Task<InfraAgentRuntimeProfileView> UpdateAsync(string id, string userId, UpsertInfraAgentRuntimeProfileRequest request, CancellationToken ct);

    Task<InfraAgentRuntimeProfileView> ImportDefaultModelAsync(string userId, CancellationToken ct);

    Task<bool> DeleteAsync(string id, CancellationToken ct);

    Task<InfraAgentRuntimeProfileSecretView?> ResolveAsync(string? id, CancellationToken ct);

    Task<InfraAgentRuntimeProfileTestResult> TestAsync(string id, CancellationToken ct);
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
        if (!string.Equals(desiredRuntimeAdapter, "claude-agent-sdk", StringComparison.OrdinalIgnoreCase))
        {
            return new InfraAgentRuntimeProfileCompatibilityDecision(
                true,
                "adapter-not-claude-agent-sdk",
                "当前目标 adapter 不是 claude-agent-sdk；不套用 Claude/Anthropic profile gate。",
                Array.Empty<string>());
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
            "claude-agent-sdk 只默认支持 Anthropic/Claude-compatible profile；当前 OpenAI-compatible profile 没有 Claude/Anthropic 模型特征。",
            new[]
            {
                "使用 Anthropic 官方模板创建默认 runtime profile，并填入有效 API key。",
                "如果必须使用普通 OpenAI-compatible 模型，不要把代码审查任务路由到 claude-agent-sdk。",
                "补齐其他官方 SDK adapter contract 和 S1/S2/S3 smokes 后，再允许对应 runtime 路由。"
            });
    }

    public static string BuildIncompatibleMessage(string profileName, string model) =>
        $"Claude Agent SDK 路径需要 Claude/Anthropic 兼容 runtime profile；当前配置 {profileName} / {model} 可能只适合普通 OpenAI-compatible gateway。请切换到 Claude/Anthropic profile，或将该任务改走普通 OpenAI-compatible gateway。";
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
                    "Anthropic 官方模板需要填写 API key。");
            }

            if (!normalized.StartsWith("sk-ant-", StringComparison.Ordinal))
            {
                throw new InfraAgentRuntimeProfileException(
                    InfraAgentRuntimeProfileErrorCodes.ApiKeyFormatInvalid,
                    "Anthropic 官方模板只接受 sk-ant- 开头的 API key；不要填 OpenRouter、OpenAI-compatible 或 MAP/CDS 管理 key。");
            }
        }
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
            ["protocol=anthropic", "model contains claude", "model starts with anthropic/"],
            [InfraAgentRuntimeProfileTemplates.AnthropicOfficialClaudeSonnet4],
            ["R0", "A0", "R1", "S1", "S2", "S3", "V1", "N6"],
            [],
            ["openai-compatible model without claude/anthropic prefix, for example deepseek/*"],
            [
                "MAP/CDS 只保留 session、workspace、审批、日志、事件和产物控制面。",
                "Agent turn loop、上下文管理和 Claude Code 工具调用归官方 claude-agent-sdk。",
                "OpenAI-compatible gateway 只有在代理 Claude/Anthropic 模型时才适合该 adapter。"
            ],
            [
                "使用 Anthropic 官方模板创建带有效 API key 的 runtime profile。",
                "如果必须使用普通 OpenAI-compatible 模型，请不要把任务路由到 claude-agent-sdk。"
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
