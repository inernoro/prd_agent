using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

public interface IInfraAgentSessionService
{
    Task<List<InfraAgentSessionView>> ListAsync(string userId, int limit, CancellationToken ct);

    Task<InfraAgentSessionView> CreateAsync(string userId, CreateInfraAgentSessionRequest request, CancellationToken ct);

    Task<InfraAgentSessionView?> StartAsync(string userId, string id, StartInfraAgentSessionRequest request, CancellationToken ct);

    Task<InfraAgentSessionView?> GetAsync(string userId, string id, CancellationToken ct);

    Task<InfraAgentSessionView?> SendMessageAsync(string userId, string id, SendInfraAgentMessageRequest request, CancellationToken ct);

    Task<InfraAgentSessionView?> StopAsync(string userId, string id, CancellationToken ct);

    Task<InfraAgentSessionView?> ArchiveAsync(string userId, string id, CancellationToken ct);

    Task<InfraAgentSessionView?> CollectArtifactsAsync(string userId, string id, CancellationToken ct);

    Task<InfraAgentSessionView?> RunReadonlyChecksAsync(string userId, string id, CancellationToken ct);

    Task<List<InfraAgentEventView>> ListEventsAsync(string userId, string sessionId, long afterSeq, int limit, CancellationToken ct);

    Task<string?> GetLogsAsync(string userId, string sessionId, CancellationToken ct);

    Task<InfraAgentSessionView?> ApproveToolAsync(string userId, string sessionId, string approvalId, ToolApprovalRequest request, CancellationToken ct);
}

public record CreateInfraAgentSessionRequest(
    string ConnectionId,
    string? Runtime,
    string? Model,
    string? Title,
    string? ToolPolicy,
    string? HookProfileId,
    string? RuntimeProfileId = null
);

public record StartInfraAgentSessionRequest(
    string? Runtime,
    string? Model
);

public record SendInfraAgentMessageRequest(
    string Content
);

public record ToolApprovalRequest(
    string Decision
);

public record InfraAgentSessionView(
    string Id,
    string UserId,
    string ConnectionId,
    string Partner,
    string CdsProjectId,
    string? CdsSessionId,
    string? CdsWorkerId,
    string? CdsContainerName,
    string TraceId,
    string Runtime,
    string? Model,
    string ToolPolicy,
    string? HookProfileId,
    string Title,
    string Status,
    bool IsArchived,
    string? LastError,
    DateTime CreatedAt,
    DateTime UpdatedAt,
    DateTime? StartedAt,
    DateTime? StoppedAt,
    string? RuntimeProfileId = null,
    string? ModelBaseUrl = null
);

public record InfraAgentEventView(
    string Id,
    string SessionId,
    long Seq,
    string TraceId,
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
    public const string TokenUnavailable = "token_unavailable";
    public const string CdsRequestFailed = "cds_request_failed";
    public const string MessageContentRequired = "message_content_required";
    public const string HookFailed = "hook_failed";
    public const string RuntimeProfileInvalid = "runtime_profile_invalid";
    public const string SessionStillRunning = "session_still_running";
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
