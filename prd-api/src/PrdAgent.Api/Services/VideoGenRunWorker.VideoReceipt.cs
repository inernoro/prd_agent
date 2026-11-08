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
        var query = f.Eq(x => x.Mode, VideoGenMode.Direct) & f.Eq(x => x.Status, VideoGenRunStatus.Cancelled)
            & f.Eq(x => x.CancelRequested, true) & f.Eq(x => x.DirectVideoReconciledAt, null)
            & f.Eq(x => x.DeletionRequestedAt, null) & f.Ne(x => x.TaskPermitId, null)
            & f.Ne(x => x.DirectVideoJobId, null) & (f.Eq(x => x.QueueEnteredAt, null) | f.Lte(x => x.QueueEnteredAt, now));
        if (_unavailableReceipts.Count > 0) query &= f.Nin(x => x.Id, _unavailableReceipts.Keys);
        var run = await _db.VideoGenRuns.Find(query).SortBy(x => x.QueueEnteredAt).ThenBy(x => x.CreatedAt).ThenBy(x => x.Id).FirstOrDefaultAsync(ct);
        if (run is null) return;
        try { await ReconcileCancelledVideoAsync(run); }
        catch (TaskExecutionAdmissionException)
        {
            if (_unavailableReceipts.Count >= 1000) _unavailableReceipts.Clear();
            _unavailableReceipts[run.Id] = now.AddMinutes(1);
        }
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
            .Set(x => x.DirectVideoCost, status.Cost).Set(x => x.QueueEnteredAt, DateTime.UtcNow.AddSeconds(6));
        if (terminal) update = update.Set(x => x.DirectVideoReconciledAt, DateTime.UtcNow);
        var written = await _db.VideoGenRuns.UpdateOneAsync(filter, update, cancellationToken: CancellationToken.None);
        if (terminal && written.ModifiedCount == 1)
            await _taskExecutions.RevokeVideoReceiptAsync(lease.Proof.PermitId, run.Id, CancellationToken.None);
    }
}
