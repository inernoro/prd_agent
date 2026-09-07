using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

public interface IDesignArtifactLifecycleService
{
    Task<DesignArtifactRun> CreateSessionAsync(
        CreateDesignArtifactSessionRequest request,
        CancellationToken ct = default);

    Task<DesignArtifactEventEnvelope> AppendEventAsync(
        AppendDesignArtifactEventRequest request,
        CancellationToken ct = default);

    Task<DesignArtifactRun> CommitManifestAsync(
        CommitDesignArtifactManifestRequest request,
        CancellationToken ct = default);

    Task<DesignArtifactRun> CompleteAsync(
        DesignArtifactLifecycleMutationRequest request,
        CancellationToken ct = default);

    Task<DesignArtifactRun> FailAsync(
        FailDesignArtifactSessionRequest request,
        CancellationToken ct = default);

    Task<DesignArtifactRun> BindPublishedArtifactAsync(
        BindPublishedDesignArtifactRequest request,
        CancellationToken ct = default);
}

public sealed record CreateDesignArtifactSessionRequest(
    string RunId,
    string UserId,
    string ArtifactType,
    string Operation,
    string SourceSurface,
    string Runtime,
    DesignArtifactWorkspaceRef WorkspaceRef,
    DesignArtifactVersionBoundary VersionBoundary,
    string? Title = null);

public sealed record AppendDesignArtifactEventRequest(
    string RunId,
    string UserId,
    string Type,
    string? Phase = null,
    int? Progress = null,
    IReadOnlyDictionary<string, object?>? Payload = null);

public sealed record DesignArtifactLifecycleExpectation(
    int LifecycleVersion,
    string? BaseRevision,
    string? BaseContentHash);

public sealed record CommitDesignArtifactManifestRequest(
    string RunId,
    string UserId,
    DesignArtifactLifecycleExpectation Expected,
    DesignArtifactContractManifest Manifest);

public sealed record DesignArtifactLifecycleMutationRequest(
    string RunId,
    string UserId,
    DesignArtifactLifecycleExpectation Expected);

public sealed record FailDesignArtifactSessionRequest(
    string RunId,
    string UserId,
    DesignArtifactLifecycleExpectation Expected,
    string FailureCode);

public sealed record BindPublishedDesignArtifactRequest(
    string RunId,
    string UserId,
    DesignArtifactLifecycleExpectation Expected,
    string ArtifactId,
    string VersionId);

public sealed class DesignArtifactLifecycleException : Exception
{
    public DesignArtifactLifecycleException(string code, string message)
        : base(message)
    {
        Code = code;
    }

    public string Code { get; }
}

public static class DesignArtifactLifecycleErrorCodes
{
    public const string InvalidContract = "DESIGN_ARTIFACT_CONTRACT_INVALID";
    public const string Conflict = "DESIGN_ARTIFACT_LIFECYCLE_CONFLICT";
    public const string NotFound = "DESIGN_ARTIFACT_NOT_FOUND";
}
