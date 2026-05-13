using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

public interface IInfraAgentRuntimeProfileService
{
    Task<List<InfraAgentRuntimeProfileView>> ListAsync(CancellationToken ct);

    Task<InfraAgentRuntimeProfileView> CreateAsync(string userId, UpsertInfraAgentRuntimeProfileRequest request, CancellationToken ct);

    Task<bool> DeleteAsync(string id, CancellationToken ct);

    Task<InfraAgentRuntimeProfileSecretView?> ResolveAsync(string? id, CancellationToken ct);

    Task<InfraAgentRuntimeProfileTestResult> TestAsync(string id, CancellationToken ct);
}

public record UpsertInfraAgentRuntimeProfileRequest(
    string? Name,
    string? Runtime,
    string? BaseUrl,
    string? Model,
    string? ApiKey,
    bool? IsDefault
);

public record InfraAgentRuntimeProfileView(
    string Id,
    string Name,
    string Runtime,
    string BaseUrl,
    string Model,
    bool HasApiKey,
    bool IsDefault,
    DateTime CreatedAt,
    DateTime UpdatedAt
);

public record InfraAgentRuntimeProfileSecretView(
    string Id,
    string Name,
    string Runtime,
    string BaseUrl,
    string Model,
    string ApiKey
);

public record InfraAgentRuntimeProfileTestResult(
    string Id,
    bool Success,
    string Status,
    string Message,
    string BaseUrl,
    string Model,
    int? HttpStatus,
    long ElapsedMs
);

public static class InfraAgentRuntimeProfileErrorCodes
{
    public const string NameRequired = "name_required";
    public const string BaseUrlInvalid = "base_url_invalid";
    public const string ModelRequired = "model_required";
    public const string ApiKeyRequired = "api_key_required";
    public const string ApiKeyUnreadable = "api_key_unreadable";
    public const string ProfileNotFound = "profile_not_found";
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
