using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

public interface IInfraAgentHookProfileService
{
    Task<List<InfraAgentHookProfileView>> ListAsync(string userId, CancellationToken ct);

    Task<InfraAgentHookProfileView> CreateAsync(string userId, UpsertInfraAgentHookProfileRequest request, CancellationToken ct);
}

public record UpsertInfraAgentHookProfileRequest(
    string? Name,
    string? BeforeStart,
    string? AfterStart,
    string? BeforeStop,
    string? AfterStop,
    string? FailurePolicy,
    int? TimeoutSeconds
);

public record InfraAgentHookProfileView(
    string Id,
    string UserId,
    string Name,
    string? BeforeStart,
    string? AfterStart,
    string? BeforeStop,
    string? AfterStop,
    string FailurePolicy,
    int TimeoutSeconds,
    DateTime CreatedAt,
    DateTime UpdatedAt
);

public class InfraAgentHookProfileException : Exception
{
    public string ErrorCode { get; }
    public int HttpStatus { get; }

    public InfraAgentHookProfileException(string errorCode, string message, int httpStatus = 400)
        : base(message)
    {
        ErrorCode = errorCode;
        HttpStatus = httpStatus;
    }
}
