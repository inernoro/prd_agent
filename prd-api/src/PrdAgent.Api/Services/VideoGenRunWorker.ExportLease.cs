using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services;

namespace PrdAgent.Api.Services;

public partial class VideoGenRunWorker
{
    internal string? ExportDurableDeploymentScope { get; set; } = DeploymentScope.CurrentDurable;
    internal TimeSpan ExportHolderDuration { get; set; } = TimeSpan.FromMinutes(2);
    internal TimeSpan ExportHolderHeartbeat { get; set; } = TimeSpan.FromSeconds(20);

    private FilterDefinition<VideoExportTask> OwnedExportHolder(VideoExportTask task)
    {
        var f = Builders<VideoExportTask>.Filter;
        if (string.IsNullOrWhiteSpace(task.WorkerLeaseId)) return f.Exists(x => x.Id, false);
        return f.Eq(x => x.Id, task.Id) & f.Eq(x => x.RunId, task.RunId)
            & f.Eq(x => x.OwnerAdminId, task.OwnerAdminId) & f.Eq(x => x.AppKey, task.AppKey)
            & f.Eq(x => x.ProjectId, task.ProjectId) & f.Eq(x => x.DeploymentSlug, QueueDeploymentScope)
            & f.Eq(x => x.Status, VideoExportTaskStatus.Processing) & f.Eq(x => x.WorkerLeaseId, task.WorkerLeaseId)
            & new BsonDocument("$expr", new BsonDocument("$gt", new BsonArray { "$WorkerLeaseExpiresAt", "$$NOW" }));
    }

    internal async Task<bool> RecoverExpiredExportHolderAsync(CancellationToken ct)
    {
        var f = Builders<VideoExportTask>.Filter;
        var expired = f.Eq(x => x.DeploymentSlug, QueueDeploymentScope)
            & f.Eq(x => x.Status, VideoExportTaskStatus.Processing)
            & f.Ne(x => x.WorkerLeaseId, null) & f.Ne(x => x.WorkerLeaseId, string.Empty)
            & f.Ne(x => x.WorkerLeaseExpiresAt, null)
            & new BsonDocument("$expr", new BsonDocument("$lte", new BsonArray { "$WorkerLeaseExpiresAt", "$$NOW" }));
        var task = await _db.VideoExportTasks.Find(expired).SortBy(x => x.WorkerLeaseExpiresAt).FirstOrDefaultAsync(ct);
        if (task == null) return false;
        var recovered = await _db.VideoExportTasks.UpdateOneAsync(expired & f.Eq(x => x.Id, task.Id)
            & f.Eq(x => x.OwnerAdminId, task.OwnerAdminId) & f.Eq(x => x.AppKey, task.AppKey)
            & f.Eq(x => x.RunId, task.RunId) & f.Eq(x => x.ProjectId, task.ProjectId)
            & f.Eq(x => x.WorkerLeaseId, task.WorkerLeaseId),
            Builders<VideoExportTask>.Update.Set(x => x.Status, VideoExportTaskStatus.ScopedQueued)
                .Set(x => x.CurrentPhase, "export-recovering").Set(x => x.Progress, 1)
                .Set(x => x.WorkerLeaseId, (string?)null).Set(x => x.WorkerLeaseExpiresAt, (DateTime?)null)
                .Set(x => x.StartedAt, (DateTime?)null), cancellationToken: CancellationToken.None);
        return recovered.ModifiedCount == 1;
    }

    internal async Task<bool> RenewExportHolderAsync(VideoGenRun run, VideoExportTask task)
    {
        var stillCurrent = await _db.VideoGenRuns.Find(ExportRunIdentity(run, task)
            & Builders<VideoGenRun>.Filter.Eq(x => x.Status, VideoGenRunStatus.Rendering)
            & Builders<VideoGenRun>.Filter.Eq(x => x.LatestExportTaskId, task.Id)).AnyAsync(CancellationToken.None);
        if (!stillCurrent) return false;
        var update = new BsonDocument("$set", new BsonDocument("WorkerLeaseExpiresAt",
            new BsonDocument("$dateAdd", new BsonDocument { ["startDate"] = "$$NOW", ["unit"] = "millisecond",
                ["amount"] = (long)ExportHolderDuration.TotalMilliseconds })));
        var renewed = await _db.VideoExportTasks.UpdateOneAsync(OwnedExportHolder(task),
            new PipelineUpdateDefinition<VideoExportTask>(new[] { update }), cancellationToken: CancellationToken.None);
        return renewed.MatchedCount == 1;
    }

    private async Task ProcessExportWithHolderAsync(VideoGenRun run, VideoExportTask task)
    {
        if (run.CancelRequested) { await ProcessExportAsync(run, task); return; }
        if (!await RenewExportHolderAsync(run, task)) return;
        using var lost = new CancellationTokenSource();
        using var stop = new CancellationTokenSource();
        async Task Heartbeat()
        {
            try
            {
                while (true)
                {
                    await Task.Delay(ExportHolderHeartbeat, stop.Token);
                    if (!await RenewExportHolderAsync(run, task)) { lost.Cancel(); return; }
                }
            }
            catch (OperationCanceledException) when (stop.IsCancellationRequested) { }
            catch (Exception error)
            {
                _logger.LogWarning(error, "导出持有者无法续期，停止本次处理: taskId={TaskId}", task.Id);
                lost.Cancel();
            }
        }
        var heartbeat = Heartbeat();
        try { await ProcessExportAsync(run, task, lost.Token); }
        finally { stop.Cancel(); await heartbeat; }
    }
    private static async Task<(string Output,string Error)> WaitOwnedExportProcessAsync(
        System.Diagnostics.Process process,CancellationToken authorityToken,TimeSpan? timeout = null)
    {
        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        using var limit = new CancellationTokenSource();
        if (timeout.HasValue) limit.CancelAfter(timeout.Value);
        using var stop = CancellationTokenSource.CreateLinkedTokenSource(authorityToken,limit.Token);
        try { await process.WaitForExitAsync(stop.Token); }
        catch (OperationCanceledException)
        {
            try { if (!process.HasExited) process.Kill(entireProcessTree:true); } catch (InvalidOperationException) { }
            await process.WaitForExitAsync(CancellationToken.None);
            await Task.WhenAll(stdout,stderr);
            authorityToken.ThrowIfCancellationRequested();
            throw new TimeoutException("视频合成超过 15 分钟");
        }
        return (await stdout,await stderr);
    }

}
