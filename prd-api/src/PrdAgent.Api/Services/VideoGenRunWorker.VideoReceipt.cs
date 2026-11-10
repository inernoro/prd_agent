using Microsoft.Extensions.DependencyInjection;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;

namespace PrdAgent.Api.Services;

public partial class VideoGenRunWorker
{
    private async Task ResumeCancelledVideoReceiptAsync(CancellationToken ct)
    {
        if (_taskExecutions is null) return;
        var now = DateTime.UtcNow;
        foreach (var key in _unavailableReceipts.Where(x => x.Value <= now).Select(x => x.Key).ToArray())
            _unavailableReceipts.Remove(key);
        var f = Builders<VideoGenRun>.Filter;
        var direct = f.Eq(x => x.Mode, VideoGenMode.Direct) & f.Eq(x => x.DirectVideoReconciledAt, null)
            & f.Ne(x => x.TaskPermitId, null) & f.Ne(x => x.DirectVideoJobId, null)
            & (f.Eq(x => x.QueueEnteredAt, null) | f.Lte(x => x.QueueEnteredAt, now));
        var sf = Builders<VideoGenScene>.Filter;
        var storyboard = f.Eq(x => x.Mode, VideoGenMode.Storyboard) & f.ElemMatch(x => x.Scenes,
            sf.Ne(x => x.TaskPermitId, null) & sf.Ne(x => x.JobId, null) & sf.Ne(x => x.Model, null)
            & sf.Ne(x => x.OfferingId, null) & sf.Eq(x => x.ReconciledAt, null)
            & (sf.Eq(x => x.ReceiptQueuedAt, null) | sf.Lte(x => x.ReceiptQueuedAt, now)));
        var query = (direct | storyboard) & (f.Eq(x => x.QueueEnteredAt, null) | f.Lte(x => x.QueueEnteredAt, now))
            & f.Eq(x => x.Status, VideoGenRunStatus.Cancelled)
            & f.Eq(x => x.CancelRequested, true) & f.Eq(x => x.DeletionRequestedAt, null);
        if (_unavailableReceipts.Count > 0) query &= f.Nin(x => x.Id, _unavailableReceipts.Keys);
        var run = await _db.VideoGenRuns.Find(query).SortBy(x => x.QueueEnteredAt).ThenBy(x => x.CreatedAt).ThenBy(x => x.Id).FirstOrDefaultAsync(ct);
        if (run is null) return;
        var scene = run.Mode == VideoGenMode.Storyboard ? PendingSceneReceipts(run)
            .Where(item => (item.ReceiptQueuedAt is null || item.ReceiptQueuedAt <= now)
                && !_unavailableReceipts.ContainsKey($"{run.Id}_scene_{item.Index}"))
            .OrderBy(x => x.ReceiptQueuedAt).ThenBy(x => x.Index).FirstOrDefault() : null;
        var receiptKey = scene is null ? run.Id : $"{run.Id}_scene_{scene.Index}";
        if (run.Mode == VideoGenMode.Storyboard && scene is null)
        {
            if (_unavailableReceipts.Count >= 1000) _unavailableReceipts.Clear();
            _unavailableReceipts[run.Id] = NextSceneReceiptAttempt(run, now);
            return;
        }
        try
        {
            if (scene is null) await ReconcileCancelledVideoAsync(run);
            else await ReconcileCancelledSceneAsync(run, scene);
        }
        catch (TaskExecutionAdmissionException)
        {
            if (_unavailableReceipts.Count >= 1000) _unavailableReceipts.Clear();
            var retryAt = DateTime.UtcNow.AddMinutes(1);
            _unavailableReceipts[receiptKey] = retryAt;
            if (scene is not null) _unavailableReceipts[run.Id] = NextSceneReceiptAttempt(run, DateTime.UtcNow);
        }
    }

    private static IEnumerable<VideoGenScene> PendingSceneReceipts(VideoGenRun run) => run.Scenes
        .Where((item, i) => item.Index == i && item.ReconciledAt is null
            && !string.IsNullOrWhiteSpace(item.TaskPermitId) && !string.IsNullOrWhiteSpace(item.JobId)
            && !string.IsNullOrWhiteSpace(item.Model) && !string.IsNullOrWhiteSpace(item.OfferingId));

    private DateTime NextSceneReceiptAttempt(VideoGenRun run, DateTime now) => PendingSceneReceipts(run)
        .Select(item =>
        {
            var ready = item.ReceiptQueuedAt ?? now;
            return _unavailableReceipts.TryGetValue($"{run.Id}_scene_{item.Index}", out var unavailable) && unavailable > ready
                ? unavailable : ready;
        }).DefaultIfEmpty(now.AddMinutes(1)).Min();

    private async Task ReconcileCancelledSceneAsync(VideoGenRun run, VideoGenScene scene)
    {
        if (_taskExecutions is null || string.IsNullOrWhiteSpace(scene.TaskPermitId)
            || scene.Index < 0 || scene.Index >= run.Scenes.Count || run.Scenes[scene.Index].Index != scene.Index) return;
        var executionId = $"{run.Id}_scene_{scene.Index}";
        await using var lease = await _taskExecutions.AcquireVideoReceiptAsync(scene.TaskPermitId, executionId, CancellationToken.None);
        var target = lease.Identity.VideoReceipt
            ?? throw new TaskExecutionAdmissionException("TASK_VIDEO_RECEIPT_SCOPE_DENIED", "缺少原分镜作业核账目标。");
        using var receiptScope = TaskExecutionContext.Enter(lease.Identity);
        var prefix = $"Scenes.{scene.Index}.";
        var f = Builders<VideoGenRun>.Filter;
        var filter = f.Eq(x => x.Id, run.Id) & f.Eq(x => x.OwnerAdminId, target.OwnerId)
            & f.Eq(x => x.Mode, VideoGenMode.Storyboard) & f.Eq(x => x.Status, VideoGenRunStatus.Cancelled)
            & f.Eq(x => x.CancelRequested, true) & f.Eq(x => x.DeletionRequestedAt, null)
            & f.Eq(prefix + "Index", scene.Index) & f.Eq(prefix + "TaskPermitId", lease.Proof.PermitId)
            & f.Eq(prefix + "JobId", target.JobId) & f.Eq(prefix + "Model", target.Model)
            & f.Eq(prefix + "OfferingId", target.OfferingId) & f.Eq(prefix + "ReconciledAt", (DateTime?)null);
        if (await _db.VideoGenRuns.Find(filter).FirstOrDefaultAsync(CancellationToken.None) is null) return;
        using var services = _scopeFactory.CreateScope();
        var context = services.ServiceProvider.GetRequiredService<ILLMRequestContextAccessor>();
        using var requestContext = context.BeginScope(new LlmRequestContext(
            RequestId: executionId, GroupId: null, SessionId: null, UserId: target.OwnerId, ViewRole: null,
            DocumentChars: null, DocumentHash: null, SystemPromptRedacted: "[VIDEO_RECEIPT]",
            RequestType: ModelTypes.VideoGen, AppCallerCode: target.AppCallerCode, RunId: executionId,
            LogicalRequestId: executionId, ProviderTaskId: target.JobId));
        var client = services.ServiceProvider.GetRequiredService<IOpenRouterVideoClient>();
        OpenRouterVideoStatus status;
        try { status = await client.GetStatusForOfferingAsync(target.AppCallerCode, target.JobId, target.Model, target.OfferingId, CancellationToken.None); }
        catch (TaskExecutionAdmissionException) { throw; }
        catch (Exception error)
        {
            _logger.LogWarning(error, "原分镜作业核账暂不可用: runId={RunId}, scene={Scene}", run.Id, scene.Index);
            await _db.VideoGenRuns.UpdateOneAsync(filter, Builders<VideoGenRun>.Update.Set(prefix + "ReceiptQueuedAt", DateTime.UtcNow.AddSeconds(6))
                .Set(x => x.QueueEnteredAt, DateTime.UtcNow.AddSeconds(6)), cancellationToken: CancellationToken.None);
            return;
        }
        var terminal = status.Status is "completed" or "failed" or "cancelled" or "expired";
        var update = Builders<VideoGenRun>.Update.Set(prefix + "UpstreamStatus", status.Status)
            .Set(prefix + "ReceiptQueuedAt", DateTime.UtcNow.AddSeconds(6))
            .Set(x => x.QueueEnteredAt, DateTime.UtcNow.AddSeconds(6));
        if (status.Cost.HasValue) update = update.Set(prefix + "Cost", status.Cost);
        if (terminal) update = update.Set(prefix + "ReconciledAt", DateTime.UtcNow);
        var written = await _db.VideoGenRuns.UpdateOneAsync(filter, update, cancellationToken: CancellationToken.None);
        if (terminal && written.ModifiedCount == 1)
            await _taskExecutions.RevokeVideoReceiptAsync(lease.Proof.PermitId, executionId, CancellationToken.None);
    }

    private async Task ReconcileCancelledVideoAsync(VideoGenRun run)
    {
        if (string.IsNullOrWhiteSpace(run.TaskPermitId) || _taskExecutions is null) return;
        await using var lease = await _taskExecutions.AcquireVideoReceiptAsync(run.TaskPermitId, run.Id, CancellationToken.None);
        var target = lease.Identity.VideoReceipt
            ?? throw new TaskExecutionAdmissionException("TASK_VIDEO_RECEIPT_SCOPE_DENIED", "缺少原作业核账目标。");
        using var receiptScope = TaskExecutionContext.Enter(lease.Identity);
        var f = Builders<VideoGenRun>.Filter;
        var filter = f.Eq(x => x.Id, run.Id) & f.Eq(x => x.TaskPermitId, lease.Proof.PermitId)
            & f.Eq(x => x.OwnerAdminId, target.OwnerId) & f.Eq(x => x.Status, VideoGenRunStatus.Cancelled)
            & f.Eq(x => x.CancelRequested, true) & f.Eq(x => x.DeletionRequestedAt, null)
            & f.Eq(x => x.DirectVideoJobId, target.JobId) & f.Eq(x => x.DirectVideoModel, target.Model)
            & f.Eq(x => x.DirectVideoOfferingId, target.OfferingId) & f.Eq(x => x.DirectVideoReconciledAt, null);
        if (await _db.VideoGenRuns.Find(filter).FirstOrDefaultAsync(CancellationToken.None) is null) return;
        using var services = _scopeFactory.CreateScope();
        var context = services.ServiceProvider.GetRequiredService<ILLMRequestContextAccessor>();
        using var requestContext = context.BeginScope(new LlmRequestContext(
            RequestId: run.Id, GroupId: null, SessionId: null, UserId: target.OwnerId, ViewRole: null,
            DocumentChars: null, DocumentHash: null, SystemPromptRedacted: "[VIDEO_RECEIPT]",
            RequestType: ModelTypes.VideoGen, AppCallerCode: target.AppCallerCode, RunId: run.Id,
            LogicalRequestId: run.Id, ProviderTaskId: target.JobId));
        var client = services.ServiceProvider.GetRequiredService<IOpenRouterVideoClient>();
        OpenRouterVideoStatus status;
        try { status = await client.GetStatusForOfferingAsync(target.AppCallerCode, target.JobId, target.Model, target.OfferingId, CancellationToken.None); }
        catch (TaskExecutionAdmissionException) { throw; }
        catch (Exception error)
        {
            _logger.LogWarning(error, "原视频作业核账暂不可用: runId={RunId}", run.Id);
            await _db.VideoGenRuns.UpdateOneAsync(filter, Builders<VideoGenRun>.Update.Set(x => x.QueueEnteredAt, DateTime.UtcNow.AddSeconds(6)), cancellationToken: CancellationToken.None);
            return;
        }
        var terminal = status.Status is "completed" or "failed" or "cancelled" or "expired";
        var update = Builders<VideoGenRun>.Update.Set(x => x.DirectVideoUpstreamStatus, status.Status)
            .Set(x => x.QueueEnteredAt, DateTime.UtcNow.AddSeconds(6));
        if (status.Cost.HasValue) update = update.Set(x => x.DirectVideoCost, status.Cost);
        if (terminal) update = update.Set(x => x.DirectVideoReconciledAt, DateTime.UtcNow);
        var written = await _db.VideoGenRuns.UpdateOneAsync(filter, update, cancellationToken: CancellationToken.None);
        if (terminal && written.ModifiedCount == 1)
            await _taskExecutions.RevokeVideoReceiptAsync(lease.Proof.PermitId, run.Id, CancellationToken.None);
    }
}
