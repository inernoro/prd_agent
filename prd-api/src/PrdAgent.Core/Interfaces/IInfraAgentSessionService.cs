using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

public interface IInfraAgentSessionService
{
    Task<List<InfraAgentSessionView>> ListAsync(string userId, int limit, CancellationToken ct);

    Task<InfraAgentSlaDashboardView> GetSlaDashboardAsync(string userId, int days, CancellationToken ct);

    Task<InfraAgentScheduleDashboardView> GetScheduleDashboardAsync(string userId, int days, CancellationToken ct);

    Task<InfraAgentGovernanceDashboardView> GetGovernanceDashboardAsync(string userId, CancellationToken ct);

    Task<InfraAgentSessionView> CreateAsync(string userId, CreateInfraAgentSessionRequest request, CancellationToken ct);

    Task<InfraAgentSessionView?> StartAsync(string userId, string id, StartInfraAgentSessionRequest request, CancellationToken ct);

    Task<InfraAgentSessionView?> GetAsync(string userId, string id, CancellationToken ct);

    Task<InfraAgentSessionView?> SendMessageAsync(string userId, string id, SendInfraAgentMessageRequest request, CancellationToken ct);

    Task RunRuntimeJobAsync(string userId, string id, string content, CancellationToken ct);

    Task<InfraAgentSessionView?> StopAsync(string userId, string id, CancellationToken ct);

    Task<InfraAgentSessionView?> ArchiveAsync(string userId, string id, CancellationToken ct);

    Task<InfraAgentSessionView?> CollectArtifactsAsync(string userId, string id, CancellationToken ct);

    Task<InfraAgentTraceBundleView?> GetTraceBundleAsync(string userId, string id, CancellationToken ct);

    Task<InfraAgentSessionView?> RunReadonlyChecksAsync(string userId, string id, CancellationToken ct);

    Task<InfraAgentSessionView?> CaptureBrowserSnapshotAsync(string userId, string id, BrowserSnapshotRequest request, CancellationToken ct);

    Task<InfraAgentSessionView?> RunBrowserActionAsync(string userId, string id, BrowserActionRequest request, CancellationToken ct);

    Task<InfraAgentSessionView?> RequestToolApprovalAsync(string userId, string id, CreateToolApprovalRequest request, CancellationToken ct);

    Task<InfraAgentSessionView?> SetManualTakeoverAsync(string userId, string id, ManualTakeoverRequest request, CancellationToken ct);

    Task<InfraAgentSessionView?> AddManualInputAsync(string userId, string id, ManualInputRequest request, CancellationToken ct);

    Task<List<InfraAgentEventView>> ListEventsAsync(string userId, string sessionId, long afterSeq, int limit, CancellationToken ct);

    Task<List<InfraAgentMessageView>> ListMessagesAsync(string userId, string sessionId, int limit, CancellationToken ct);

    Task<string?> GetLogsAsync(string userId, string sessionId, CancellationToken ct);

    Task<InfraAgentSessionView?> ApproveToolAsync(string userId, string sessionId, string approvalId, ToolApprovalRequest request, CancellationToken ct);
}

public interface IInfraAgentRuntimeJobQueue
{
    ValueTask EnqueueAsync(InfraAgentRuntimeJob job, CancellationToken ct);

    IAsyncEnumerable<InfraAgentRuntimeJob> DequeueAsync(CancellationToken ct);
}

public sealed record InfraAgentRuntimeJob(
    string UserId,
    string SessionId,
    string Content,
    DateTime EnqueuedAt
);

public record CreateInfraAgentSessionRequest(
    string ConnectionId,
    string? Runtime,
    string? Model,
    string? Title,
    string? ToolPolicy,
    string? HookProfileId,
    string? RuntimeProfileId = null,
    string? TraceId = null,
    string? WorkspaceRoot = null,
    string? GitRepository = null,
    string? GitRef = null
);

public record StartInfraAgentSessionRequest(
    string? Runtime,
    string? Model
);

public record SendInfraAgentMessageRequest(
    string Content
);

public record ManualTakeoverRequest(
    bool Enabled,
    string? Reason
);

public record ManualInputRequest(
    string Content
);

public record BrowserSnapshotRequest(
    string? BranchId,
    string? Description
);

public record BrowserActionRequest(
    string? BranchId,
    string Action,
    System.Text.Json.JsonElement? Params,
    string? Description
);

public record CreateToolApprovalRequest(
    string ToolName,
    string? ArgsSummary,
    string? Risk
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
    string? RuntimeAdapter,
    string? CurrentRuntimeRunId,
    string? Model,
    string? WorkspaceRoot,
    string? GitRepository,
    string? GitRef,
    double ResourceCpuCores,
    int ResourceMemoryMb,
    int TimeoutSeconds,
    string NetworkPolicy,
    int AutoCleanupMinutes,
    string ToolPolicy,
    string? HookProfileId,
    string Title,
    string Status,
    bool IsArchived,
    bool ManualTakeoverEnabled,
    DateTime? ManualTakeoverAt,
    string? ManualTakeoverReason,
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

public record InfraAgentMessageView(
    string Id,
    string SessionId,
    string Role,
    string Content,
    string Status,
    DateTime CreatedAt
);

public record InfraAgentSlaDashboardView(
    string SchemaVersion,
    DateTime GeneratedAt,
    int WindowDays,
    DateTime WindowStart,
    DateTime WindowEnd,
    InfraAgentSlaSummaryView Summary,
    IReadOnlyList<InfraAgentSlaStatusCountView> StatusCounts,
    IReadOnlyList<InfraAgentSlaRuntimeBreakdownView> RuntimeBreakdown,
    IReadOnlyList<InfraAgentSlaDailyPointView> Daily
);

public record InfraAgentSlaSummaryView(
    int SessionCount,
    int RunningCount,
    int CompletedCount,
    int FailedCount,
    int TimeoutCount,
    double FailureRate,
    double TimeoutRate,
    double? AverageDurationSeconds,
    int EventCount,
    int ToolEventCount,
    int ErrorEventCount,
    long InputTokens,
    long OutputTokens,
    long TotalTokens,
    bool TokenUsageObserved,
    decimal? EstimatedCostUsd
);

public record InfraAgentSlaStatusCountView(
    string Status,
    int Count
);

public record InfraAgentSlaRuntimeBreakdownView(
    string Runtime,
    string RuntimeAdapter,
    int SessionCount,
    int FailedCount,
    int TimeoutCount,
    double FailureRate,
    double TimeoutRate,
    double? AverageDurationSeconds,
    long TotalTokens,
    bool TokenUsageObserved
);

public record InfraAgentSlaDailyPointView(
    DateTime Date,
    int SessionCount,
    int FailedCount,
    int TimeoutCount,
    long TotalTokens
);

public record InfraAgentScheduleDashboardView(
    string SchemaVersion,
    DateTime GeneratedAt,
    int WindowDays,
    InfraAgentScheduleSummaryView Summary,
    IReadOnlyList<InfraAgentWorkflowTemplateView> Workflows,
    IReadOnlyList<InfraAgentScheduleView> Schedules,
    IReadOnlyList<InfraAgentScheduledExecutionView> RecentExecutions,
    InfraAgentKnowledgeGovernanceView KnowledgeGovernance
);

public record InfraAgentScheduleSummaryView(
    int WorkflowCount,
    int CdsAgentNodeCount,
    int CronScheduleCount,
    int EnabledCronScheduleCount,
    int DueSoonScheduleCount,
    int RecentExecutionCount,
    int FailedRecentExecutionCount,
    int KnowledgeReadonlyWorkflowCount
);

public record InfraAgentWorkflowTemplateView(
    string WorkflowId,
    string Name,
    string? Description,
    IReadOnlyList<string> Tags,
    int CdsAgentNodeCount,
    bool HasKnowledgeReadonlyTools,
    bool HasNotifyNode,
    string WorkflowPath
);

public record InfraAgentScheduleView(
    string Id,
    string WorkflowId,
    string WorkflowName,
    string Name,
    string Mode,
    string? CronExpression,
    string Timezone,
    bool IsEnabled,
    DateTime? NextRunAt,
    DateTime? LastTriggeredAt,
    long TriggerCount,
    string State,
    string WorkflowPath
);

public record InfraAgentScheduledExecutionView(
    string Id,
    string WorkflowId,
    string WorkflowName,
    string TraceId,
    string Status,
    string TriggerType,
    DateTime CreatedAt,
    long? DurationMs,
    int CdsAgentNodeCount,
    string? CdsAgentSessionId,
    string? CdsAgentTraceId,
    string? WorkbenchPath,
    string WorkflowPath
);

public record InfraAgentKnowledgeGovernanceView(
    IReadOnlyList<string> ReadonlyTools,
    int WorkflowCount,
    int ScheduleCount,
    string Boundary
);

public record InfraAgentGovernanceDashboardView(
    string SchemaVersion,
    DateTime GeneratedAt,
    InfraAgentGovernanceSubjectView Subject,
    InfraAgentGovernanceSummaryView Summary,
    IReadOnlyList<InfraAgentGovernanceScopeView> Scopes,
    IReadOnlyList<InfraAgentGovernanceGateView> Gates,
    IReadOnlyList<string> NextActions,
    IReadOnlyList<InfraAgentGovernanceOwnerPolicyView>? OwnerPolicies = null
);

public record InfraAgentGovernanceSubjectView(
    string UserId,
    IReadOnlyList<string> TeamIds,
    int TeamCount
);

public record InfraAgentGovernanceSummaryView(
    int OwnedWorkflowCount,
    int OwnedKnowledgeBaseCount,
    int PublicKnowledgeBaseCount,
    int RuntimeProfileCount,
    int OwnedRuntimeProfileCount,
    bool DefaultRuntimeProfileOwned,
    int WritablePolicySessionCount,
    int WaitingApprovalExecutionCount,
    int PassedGateCount,
    int TotalGateCount,
    int TeamSharedRuntimeProfileCount = 0
);

public record InfraAgentGovernanceScopeView(
    string Area,
    string State,
    string Isolation,
    string Evidence,
    string Risk,
    string NextAction
);

public record InfraAgentGovernanceGateView(
    string Code,
    string Label,
    string Status,
    string Evidence,
    string NextAction
);

public record InfraAgentGovernanceOwnerPolicyView(
    string Area,
    string Label,
    string State,
    string Owner,
    string Subject,
    string Evidence,
    string Risk,
    string NextAction,
    string Path
);

public record InfraAgentTraceBundleView(
    string SchemaVersion,
    DateTime ExportedAt,
    InfraAgentSessionView Session,
    InfraAgentTraceMetricsView Metrics,
    IReadOnlyDictionary<string, int> EventTypeCounts,
    IReadOnlyList<InfraAgentMessageView> Messages,
    IReadOnlyList<InfraAgentTraceEventView> Events,
    IReadOnlyList<InfraAgentTraceArtifactView> Artifacts,
    string Logs,
    InfraAgentTraceReplayView Replay
);

public record InfraAgentTraceMetricsView(
    int MessageCount,
    int EventCount,
    long LastEventSeq,
    int ArtifactCount,
    int LogLineCount,
    double? ElapsedSeconds,
    DateTime? TimeoutAt,
    bool TimedOut
);

public record InfraAgentTraceEventView(
    string Id,
    long Seq,
    string TraceId,
    string Type,
    System.Text.Json.JsonElement Payload,
    DateTime CreatedAt
);

public record InfraAgentTraceArtifactView(
    string Id,
    string Title,
    string Kind,
    string Summary,
    string Body,
    long? EventSeq
);

public record InfraAgentTraceReplayView(
    string WorkbenchPath,
    string EventsApiPath,
    long EventsCursor,
    bool EventsTruncated
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
    public const string RuntimeProfileIncompatible = "runtime_profile_incompatible";
    public const string RuntimeUnavailable = "runtime_unavailable";
    public const string SessionStillRunning = "session_still_running";
    public const string ManualTakeoverEnabled = "manual_takeover_enabled";
    public const string ManualTakeoverRequired = "manual_takeover_required";
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
