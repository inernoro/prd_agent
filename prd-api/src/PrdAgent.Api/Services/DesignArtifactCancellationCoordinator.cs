using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services;

/// <summary>
/// 设计任务显式取消的唯一写入口。浏览器断开不调用本服务；v1 由 Mongo CAS 写事实，
/// v2 由公共生命周期追加权威事件。
/// </summary>
public interface IDesignArtifactCancellationCoordinator
{
    Task<DesignArtifactCancellationResult?> RequestAsync(
        string runId,
        string userId,
        CancellationToken ct = default);
}

public sealed record DesignArtifactCancellationResult(DesignArtifactRun Run, bool Changed);

public sealed class DesignArtifactCancellationCoordinator : IDesignArtifactCancellationCoordinator
{
    private readonly MongoDbContext _db;
    private readonly IDesignArtifactLifecycleService _lifecycle;

    public DesignArtifactCancellationCoordinator(
        MongoDbContext db,
        IDesignArtifactLifecycleService lifecycle)
    {
        _db = db;
        _lifecycle = lifecycle;
    }

    public async Task<DesignArtifactCancellationResult?> RequestAsync(
        string runId,
        string userId,
        CancellationToken ct = default)
    {
        var current = await _db.DesignArtifactRuns
            .Find(run => run.DeploymentSlug == DeploymentScope.Current && (run.Id == runId && run.UserId == userId))
            .FirstOrDefaultAsync(ct);
        if (current == null) return null;

        var updated = current.ContractVersion == DesignArtifactContractVersions.Current
            ? await _lifecycle.RequestCancellationAsync(
                new RequestDesignArtifactCancellationRequest(
                    current.Id,
                    current.UserId,
                    current.LifecycleVersion,
                    current.WorkspaceRef?.BaseRevision,
                    current.VersionBoundary?.BaseContentHash),
                ct)
            : await RequestLegacyAsync(_db, current, DateTime.UtcNow, ct);
        return new DesignArtifactCancellationResult(
            updated,
            current.Status != updated.Status || current.CancelRequestedAt != updated.CancelRequestedAt);
    }

    internal static async Task<DesignArtifactRun> RequestLegacyAsync(
        MongoDbContext db,
        DesignArtifactRun current,
        DateTime requestedAt,
        CancellationToken ct = default)
    {
        if (current.Status == RunStatuses.Cancelled)
            return current;
        if (current.Status == RunStatuses.Running && current.CancelRequestedAt.HasValue)
            return current;
        if (current.Status is not (RunStatuses.Queued or RunStatuses.Running)
            || !string.IsNullOrWhiteSpace(current.ProducedArtifactSiteId)
            || !string.IsNullOrWhiteSpace(current.ProducedArtifactRevisionId))
            throw new DesignArtifactCancellationConflictException();

        var terminal = current.Status == RunStatuses.Queued;
        var filter = Builders<DesignArtifactRun>.Filter.And(
            Builders<DesignArtifactRun>.Filter.Eq(item => item.Id, current.Id),
            Builders<DesignArtifactRun>.Filter.Eq(item => item.UserId, current.UserId),
            Builders<DesignArtifactRun>.Filter.Eq(item => item.Status, current.Status),
            Builders<DesignArtifactRun>.Filter.Eq(item => item.CancelRequestedAt, null),
            Builders<DesignArtifactRun>.Filter.Eq(item => item.LeaseOwnerId, current.LeaseOwnerId),
            Builders<DesignArtifactRun>.Filter.Eq(item => item.LeaseExpiresAt, current.LeaseExpiresAt),
            Builders<DesignArtifactRun>.Filter.Eq(item => item.ProducedArtifactSiteId, null),
            Builders<DesignArtifactRun>.Filter.Eq(item => item.ProducedArtifactRevisionId, null));
        var update = Builders<DesignArtifactRun>.Update
            .Set(item => item.CancelRequestedAt, requestedAt)
            .Set(item => item.CancelRequestedByUserId, current.UserId)
            .Set(item => item.Phase, terminal ? "设计任务已取消" : "正在停止设计任务")
            .Set(item => item.UpdatedAt, requestedAt);
        if (terminal)
        {
            update = update
                .Set(item => item.Status, RunStatuses.Cancelled)
                .Set(item => item.CancelledAt, requestedAt)
                .Set(item => item.CompletedAt, requestedAt)
                .Set(item => item.LeaseOwnerId, null)
                .Set(item => item.LeaseExpiresAt, null);
        }

        var updated = await db.DesignArtifactRuns.FindOneAndUpdateAsync(
            Builders<DesignArtifactRun>.Filter.Eq(item => item.DeploymentSlug, DeploymentScope.Current) & (filter),
            update,
            new FindOneAndUpdateOptions<DesignArtifactRun, DesignArtifactRun>
            {
                ReturnDocument = ReturnDocument.After,
            },
            ct);
        if (updated != null) return updated;

        var concurrent = await db.DesignArtifactRuns
            .Find(run => run.DeploymentSlug == DeploymentScope.Current && (run.Id == current.Id && run.UserId == current.UserId))
            .FirstOrDefaultAsync(ct);
        if (concurrent?.Status == RunStatuses.Cancelled
            || concurrent?.Status == RunStatuses.Running && concurrent.CancelRequestedAt.HasValue)
            return concurrent;
        throw new DesignArtifactCancellationConflictException();
    }
}

public sealed class DesignArtifactCancellationConflictException : InvalidOperationException;
