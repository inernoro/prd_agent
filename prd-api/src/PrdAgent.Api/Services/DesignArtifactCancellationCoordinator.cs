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
    private readonly IRunEventStore? _events;

    public DesignArtifactCancellationCoordinator(
        MongoDbContext db,
        IDesignArtifactLifecycleService lifecycle,
        IRunEventStore? events = null)
    {
        _db = db;
        _lifecycle = lifecycle;
        _events = events;
    }

    public async Task<DesignArtifactCancellationResult?> RequestAsync(
        string runId,
        string userId,
        CancellationToken ct = default)
    {
        var current = await _db.DesignArtifactRuns
            .Find(run => run.DeploymentSlug == DeploymentScope.Current && (run.Id == runId && run.UserId == userId))
                .FirstOrDefaultAsync(ct)
            ?? await AdoptFromRetiredRevisionOrExplainAsync(runId, userId, ct);
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
        updated = await FinalizeIfExecutorGoneAsync(updated, ct);
        return new DesignArtifactCancellationResult(
            updated,
            current.Status != updated.Status || current.CancelRequestedAt != updated.CancelRequestedAt);
    }

    /// <summary>
    /// 本 revision 里找不到这条任务时，查它是不是「本分支上一版留下的」：
    /// 已无人执行就就地接管（之后照常记录取消意图并立即收敛）；还不能接管就说清楚为什么，
    /// 而不是回一句「设计任务不存在」——查询接口明明看得到它（#135）。
    /// 真的不存在才返回 null。
    /// </summary>
    private async Task<DesignArtifactRun?> AdoptFromRetiredRevisionOrExplainAsync(
        string runId,
        string userId,
        CancellationToken ct)
    {
        var elsewhere = await _db.DesignArtifactRuns
            .Find(run => run.Id == runId && run.UserId == userId)
            .FirstOrDefaultAsync(ct);
        if (elsewhere == null) return null;

        var adopted = await HostedSiteEditRunWorker.TryAdoptRetiredRevisionRunAsync(
            _db, elsewhere, DateTime.UtcNow, ct);
        if (adopted != null) return adopted;

        if (elsewhere.Status is RunStatuses.Done or RunStatuses.Error or RunStatuses.Cancelled)
            throw new DesignArtifactCancellationConflictException();

        if (await HostedSiteEditRunWorker.IsRetiredRevisionRunAsync(_db, elsewhere.Id, ct))
        {
            throw new DesignArtifactCancellationUnavailableException(
                DesignArtifactCancellationUnavailableException.RetiredRevisionCode,
                "分支刚重新部署，这个任务还登记在上一版服务名下；上一版退出后约 3 分钟内它会自动结束，届时可以直接重新发起");
        }
        throw new DesignArtifactCancellationUnavailableException(
            DesignArtifactCancellationUnavailableException.OtherDeploymentCode,
            "这个任务由另一个部署版本执行，当前版本不能停止它；请刷新任务状态确认结果");
    }

    /// <summary>
    /// 取消意图已记录、但执行方已经不在了（租约到期，没有 worker 会再读这份意图）：
    /// 不等恢复器下一轮，就地收敛为终态，让停止按钮一次得到结果。
    /// 判据与恢复器相同：租约到期才动；仍在租约内的交给在跑的 worker 自己停。
    /// </summary>
    private async Task<DesignArtifactRun> FinalizeIfExecutorGoneAsync(DesignArtifactRun run, CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        if (_events == null
            || run.Status != RunStatuses.Running
            || !run.CancelRequestedAt.HasValue
            || !run.LeaseExpiresAt.HasValue
            || run.LeaseExpiresAt > now)
            return run;
        await HostedSiteEditRunWorker.FinalizeRecoveredCancellationAsync(_db, _events, run, _lifecycle, now);
        return await _db.DesignArtifactRuns
                   .Find(item => item.DeploymentSlug == DeploymentScope.Current && item.Id == run.Id)
                   .FirstOrDefaultAsync(ct)
               ?? run;
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

/// <summary>任务存在，但当前部署版本不能停止它；Code/Message 直接给到调用方（409）。</summary>
public sealed class DesignArtifactCancellationUnavailableException(string code, string message)
    : InvalidOperationException(message)
{
    public const string RetiredRevisionCode = "DESIGN_ARTIFACT_CANCEL_RETIRED_REVISION";
    public const string OtherDeploymentCode = "DESIGN_ARTIFACT_CANCEL_OTHER_DEPLOYMENT";

    public string Code { get; } = code;
}
