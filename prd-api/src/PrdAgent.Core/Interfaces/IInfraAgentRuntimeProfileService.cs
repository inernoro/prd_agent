using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

public interface IInfraAgentRuntimeProfileService
{
    Task<List<InfraAgentRuntimeProfileView>> ListAsync(CancellationToken ct);

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
