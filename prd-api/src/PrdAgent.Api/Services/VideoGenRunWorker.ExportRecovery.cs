using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services;
using PrdAgent.Infrastructure.Services.AssetStorage;

namespace PrdAgent.Api.Services;

public partial class VideoGenRunWorker
{
    private FilterDefinition<VideoGenRun> ExportRunIdentity(VideoGenRun run)
    {
        var f = Builders<VideoGenRun>.Filter;
        return f.Eq(x => x.Id, run.Id) & f.Eq(x => x.OwnerAdminId, run.OwnerAdminId)
            & f.Eq(x => x.AppKey, run.AppKey) & f.Eq(x => x.ProjectId, run.ProjectId)
            & f.Eq(x => x.DeploymentSlug, run.DeploymentSlug)
            & f.Eq(x => x.CancelRequested, false) & f.Eq(x => x.DeletionRequestedAt, null);
    }

    private Task<UpdateResult> UpdateExportProjectAsync(VideoGenRun run, string status)
        => _db.VideoProjects.UpdateOneAsync(x => x.Id == run.ProjectId && x.OwnerAdminId == run.OwnerAdminId
            && x.AppKey == run.AppKey && x.LatestRunId == run.Id
            && x.LatestExportTaskId == run.LatestExportTaskId && x.Status == VideoProjectStatus.Rendering,
            Builders<VideoProject>.Update.Set(x => x.Status, status).Set(x => x.UpdatedAt, DateTime.UtcNow),
            cancellationToken: CancellationToken.None);

    private static UpdateDefinition<VideoGenRun> CompletedExportRunUpdate(
        string url, string sha, double? cost, DateTime endedAt) => Builders<VideoGenRun>.Update
        .Set(x => x.Status, VideoGenRunStatus.Completed).Set(x => x.VideoAssetUrl, url)
        .Set(x => x.VideoAssetSha256, sha).Set(x => x.DirectVideoCost, cost)
        .Set(x => x.ExportErrorMessage, (string?)null).Set(x => x.ExportedAt, endedAt)
        .Set(x => x.EndedAt, endedAt).Set(x => x.CurrentPhase, "completed").Set(x => x.PhaseProgress, 100);

    internal async Task<bool> RecordCompletedExportAsync(
        VideoGenRun run, VideoExportTask task, StoredAsset stored, double? cost)
    {
        // 调用方仍持有原 SHA/URL 锁；任务回执是同一存储引用系统中的有效引用。
        if (task.RunId != run.Id || task.OwnerAdminId != run.OwnerAdminId || task.AppKey != run.AppKey
            || task.ProjectId != (run.ProjectId ?? string.Empty) || task.DeploymentSlug != QueueDeploymentScope
            || run.DeploymentSlug != QueueDeploymentScope) return false;
        var endedAt = DateTime.UtcNow;
        var recorded = await _db.VideoExportTasks.UpdateOneAsync(
            OwnedExportHolder(task) & Builders<VideoExportTask>.Filter.Eq(x => x.StartedAt, task.StartedAt),
            Builders<VideoExportTask>.Update.Set(x => x.Status, VideoExportTaskStatus.Completed)
                .Set(x => x.CurrentPhase, "completed").Set(x => x.Progress, 100)
                .Set(x => x.OutputUrl, stored.Url).Set(x => x.OutputSha256, stored.Sha256)
                .Set(x => x.TotalCost, cost).Set(x => x.ErrorMessage, (string?)null)
                .Set(x => x.EndedAt, endedAt).Set(x => x.RunReconciledAt, (DateTime?)null)
                .Set(x => x.WorkerLeaseExpiresAt, (DateTime?)null),
            cancellationToken: CancellationToken.None);
        if (recorded.MatchedCount != 1) return false;
        task.Status = VideoExportTaskStatus.Completed; task.OutputUrl = stored.Url;
        task.OutputSha256 = stored.Sha256; task.TotalCost = cost; task.EndedAt = endedAt;
        return true;
    }

    internal async Task<bool> RecoverCompletedExportTaskAsync(CancellationToken ct)
    {
        var f = Builders<VideoExportTask>.Filter;
        var task = await _db.VideoExportTasks.Find(f.Eq(x => x.DeploymentSlug, QueueDeploymentScope)
            & f.Eq(x => x.Status, VideoExportTaskStatus.Completed) & f.Eq(x => x.RunReconciledAt, null)
            & f.Ne(x => x.OutputUrl, null) & f.Ne(x => x.OutputUrl, string.Empty)
            & f.Regex(x => x.OutputSha256, new MongoDB.Bson.BsonRegularExpression("^[0-9a-f]{64}$")))
            .SortBy(x => x.EndedAt).ThenBy(x => x.Id).FirstOrDefaultAsync(ct);
        return task != null && await ReconcileCompletedExportAsync(task, ct);
    }

    internal async Task<bool> ReconcileCompletedExportAsync(VideoExportTask task, CancellationToken ct)
    {
        if (task.Status != VideoExportTaskStatus.Completed || task.DeploymentSlug != QueueDeploymentScope
            || string.IsNullOrWhiteSpace(task.OutputUrl) || string.IsNullOrWhiteSpace(task.OutputSha256)) return false;
        var f = Builders<VideoGenRun>.Filter;
        var projectIdentity = string.IsNullOrEmpty(task.ProjectId)
            ? f.Eq(x => x.ProjectId, null) | f.Eq(x => x.ProjectId, string.Empty)
            : f.Eq(x => x.ProjectId, task.ProjectId);
        var run = await _db.VideoGenRuns.Find(f.Eq(x => x.Id, task.RunId)
            & f.Eq(x => x.OwnerAdminId, task.OwnerAdminId) & f.Eq(x => x.AppKey, task.AppKey)
            & projectIdentity)
            .FirstOrDefaultAsync(ct);
        if (run != null && !run.CancelRequested && run.DeletionRequestedAt == null
            && run.LatestExportTaskId == task.Id
            && run.Status is VideoGenRunStatus.Rendering or VideoGenRunStatus.Completed
            && (run.Status != VideoGenRunStatus.Completed || string.IsNullOrWhiteSpace(run.VideoAssetUrl)
                || run.VideoAssetUrl == task.OutputUrl && run.VideoAssetSha256 == task.OutputSha256))
        {
            // 真正待交接才等待；取消、删除或已被取代的回执走下面的保留式收口。
            if (run.DeploymentSlug != QueueDeploymentScope) return false;
            // 已完成但记录了另一结果时按已取代处理，不阻塞后续回执，也不覆盖新结果。
            var completed = await _db.VideoGenRuns.UpdateOneAsync(
                ExportRunIdentity(run) & f.Eq(x => x.Status, run.Status)
                    & f.Eq(x => x.LatestExportTaskId, task.Id) & f.Eq(x => x.VideoAssetUrl, run.VideoAssetUrl)
                    & f.Eq(x => x.VideoAssetSha256, run.VideoAssetSha256),
                CompletedExportRunUpdate(task.OutputUrl, task.OutputSha256, task.TotalCost, task.EndedAt ?? DateTime.UtcNow)
                    .Set(x => x.DeploymentSlug, QueueDeploymentScope),
                cancellationToken: CancellationToken.None);
            if (completed.MatchedCount != 1) return false;
            if (!string.IsNullOrWhiteSpace(run.ProjectId))
            {
                var project = await _db.VideoProjects.Find(x => x.Id == run.ProjectId
                    && x.OwnerAdminId == run.OwnerAdminId && x.AppKey == run.AppKey
                    && x.LatestRunId == run.Id && x.LatestExportTaskId == task.Id).FirstOrDefaultAsync(ct);
                if (project?.Status is VideoProjectStatus.Rendering or VideoProjectStatus.Completed)
                {
                    var synced = await _db.VideoProjects.UpdateOneAsync(x => x.Id == project.Id
                        && x.OwnerAdminId == run.OwnerAdminId && x.AppKey == run.AppKey
                        && x.LatestRunId == run.Id && x.LatestExportTaskId == task.Id && x.Status == project.Status,
                        Builders<VideoProject>.Update.Set(x => x.Status, VideoProjectStatus.Completed)
                            .Set(x => x.UpdatedAt, DateTime.UtcNow), cancellationToken: CancellationToken.None);
                    if (synced.MatchedCount != 1) return false;
                }
            }
            await PublishEventAsync(run.Id, "export.completed", new { videoUrl = task.OutputUrl, cost = task.TotalCost });
        }
        // 取消、删除或后续导出已取代它时不改 run/project。任务仍保留为输出引用，不删对象。
        var marked = await _db.VideoExportTasks.UpdateOneAsync(x => x.Id == task.Id && x.RunId == task.RunId
            && x.OwnerAdminId == task.OwnerAdminId && x.AppKey == task.AppKey && x.ProjectId == task.ProjectId
            && x.DeploymentSlug == task.DeploymentSlug && x.Status == VideoExportTaskStatus.Completed
            && x.OutputUrl == task.OutputUrl && x.OutputSha256 == task.OutputSha256 && x.RunReconciledAt == null,
            Builders<VideoExportTask>.Update.Set(x => x.RunReconciledAt, DateTime.UtcNow).Set(x => x.DeploymentSlug, QueueDeploymentScope),
            cancellationToken: CancellationToken.None);
        return marked.MatchedCount == 1;
    }
}
