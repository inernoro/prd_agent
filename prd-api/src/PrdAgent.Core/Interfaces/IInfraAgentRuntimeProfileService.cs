using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

public interface IInfraAgentRuntimeProfileService
{
    Task<List<InfraAgentRuntimeProfileView>> ListAsync(CancellationToken ct);

    Task<List<InfraAgentRuntimeProfileTemplateView>> ListTemplatesAsync(CancellationToken ct);

    Task<List<InfraAgentRuntimeAdapterCompatibilityView>> ListAdapterCompatibilityAsync(CancellationToken ct);

    Task<InfraAgentRuntimeProfileView> CreateAsync(string userId, UpsertInfraAgentRuntimeProfileRequest request, CancellationToken ct);

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
    string LoopOwner,
    string MapRole,
    string CdsRole,
    IReadOnlyList<string> SupportedProfileProtocols,
    IReadOnlyList<string> ModelHints,
    IReadOnlyList<string> CompatibleRuntimeProfileTemplateIds,
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

public static class InfraAgentRuntimeProfileCompatibility
{
    public static bool IsCompatibleWithDesiredRuntimeAdapter(
        string? desiredRuntimeAdapter,
        string? protocol,
        string? model)
    {
        if (!string.Equals(desiredRuntimeAdapter, "claude-agent-sdk", StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        var normalizedProtocol = protocol ?? string.Empty;
        var normalizedModel = model ?? string.Empty;
        return normalizedProtocol.Equals("anthropic", StringComparison.OrdinalIgnoreCase)
            || normalizedModel.Contains("claude", StringComparison.OrdinalIgnoreCase)
            || normalizedModel.StartsWith("anthropic/", StringComparison.OrdinalIgnoreCase);
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
}

public static class InfraAgentRuntimeAdapterCompatibility
{
    public const string SidecarLegacyLoop = "legacy-sidecar";
    public const string CodexPlanned = "codex";

    public static IReadOnlyList<InfraAgentRuntimeAdapterCompatibilityView> All { get; } =
    [
        new(
            InfraAgentRuntimeAdapterDefaults.OfficialClaudeAgentSdk,
            "Official Claude Agent SDK adapter",
            "default-supported",
            "claude-agent-sdk",
            "control-plane-only",
            "workspace-runtime-host",
            [InfraAgentRuntimeProtocols.Anthropic, InfraAgentRuntimeProtocols.OpenAiCompatible],
            ["protocol=anthropic", "model contains claude", "model starts with anthropic/"],
            [InfraAgentRuntimeProfileTemplates.AnthropicOfficialClaudeSonnet4],
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
            "sidecar-legacy-loop",
            "control-plane-plus-legacy-loop",
            "workspace-runtime-host",
            [InfraAgentRuntimeProtocols.Anthropic, InfraAgentRuntimeProtocols.OpenAiCompatible],
            ["legacy self-managed loop only"],
            [],
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
            "external-official-runtime",
            "control-plane-only",
            "workspace-runtime-host",
            [],
            ["not implemented in current CDS Agent runtime pool"],
            [],
            ["runtime=codex currently has no official adapter implementation in this repo"],
            [
                "当前页面可保存 runtime=codex profile，但 CDS Agent 代码任务不会因此自动获得 Codex 官方能力。",
                "后续若接入官方 Codex/Agents SDK，应沿用 MAP/CDS 控制面，新增薄 adapter，而不是复制 Claude legacy loop。"
            ],
            [
                "在官方 adapter、工具审批、取消和事件映射完成前，不要把用户代码审查任务默认路由到 codex runtime。"
            ])
    ];
}

public static class InfraAgentRuntimeProfileErrorCodes
{
    public const string NameRequired = "name_required";
    public const string BaseUrlInvalid = "base_url_invalid";
    public const string ModelRequired = "model_required";
    public const string ApiKeyRequired = "api_key_required";
    public const string ApiKeyUnreadable = "api_key_unreadable";
    public const string ProfileNotFound = "profile_not_found";
    public const string ModelNotConfigured = "model_not_configured";
    public const string ModelConfigIncomplete = "model_config_incomplete";
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
