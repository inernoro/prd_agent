using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

public interface IInfraAgentSessionService
{
    Task<List<InfraAgentSessionView>> ListAsync(string userId, int limit, CancellationToken ct);

    Task<InfraAgentSessionView> CreateAsync(string userId, CreateInfraAgentSessionRequest request, CancellationToken ct);

    Task<InfraAgentSessionView?> GetAsync(string userId, string id, CancellationToken ct);

    Task<InfraAgentSessionView?> StopAsync(string userId, string id, CancellationToken ct);

    Task<List<InfraAgentEventView>> ListEventsAsync(string userId, string sessionId, long afterSeq, int limit, CancellationToken ct);
}

public record CreateInfraAgentSessionRequest(
    string ConnectionId,
    string? Runtime,
    string? Model,
    string? Title
);

public record InfraAgentSessionView(
    string Id,
    string UserId,
    string ConnectionId,
    string Partner,
    string CdsProjectId,
    string? CdsSessionId,
    string Runtime,
    string? Model,
    string Title,
    string Status,
    string? LastError,
    DateTime CreatedAt,
    DateTime UpdatedAt,
    DateTime? StartedAt,
    DateTime? StoppedAt
);

public record InfraAgentEventView(
    string Id,
    string SessionId,
    long Seq,
    string Type,
    string PayloadJson,
    DateTime CreatedAt
);

public static class InfraAgentSessionErrorCodes
{
    public const string ConnectionIdRequired = "connection_id_required";
    public const string ConnectionNotFound = "connection_not_found";
    public const string ConnectionNotActive = "connection_not_active";
    public const string SessionNotFound = "session_not_found";
}

public class InfraAgentSessionException : Exception
{
    public string ErrorCode { get; }
    public int HttpStatus { get; }

    public InfraAgentSessionException(string errorCode, string message, int httpStatus = 400)
        : base(message)
    {
        ErrorCode = errorCode;
        HttpStatus = httpStatus;
    }
}
