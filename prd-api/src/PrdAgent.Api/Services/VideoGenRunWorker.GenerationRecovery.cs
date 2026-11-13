using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Services;

namespace PrdAgent.Api.Services;

public partial class VideoGenRunWorker
{
    private VideoGenerationRecovery? _generationRecovery;
    private readonly Dictionary<string, DateTime> _generationRetryAfter = new(StringComparer.Ordinal);

    private async Task<bool> RecoverInterruptedGenerationAsync(CancellationToken ct)
    {
        if (_generationRecovery == null) return false;
        var now = DateTime.UtcNow; // 只用于本机退避；执行资格由原协调器的服务器时钟决定。
        foreach (var key in _generationRetryAfter.Where(x => x.Value <= now).Select(x => x.Key).ToArray())
            _generationRetryAfter.Remove(key);
        var f = Builders<VideoGenRun>.Filter;
        var filter = f.Eq(x => x.DeploymentSlug, QueueDeploymentScope)
            & f.Eq(x => x.CancelRequested, false) & f.Eq(x => x.DeletionRequestedAt, null)
            & f.Or(f.Eq(x => x.Mode, VideoGenMode.Storyboard) & f.Eq(x => x.Status, VideoGenRunStatus.Scripting),
                f.Eq(x => x.Mode, VideoGenMode.Direct) & f.Eq(x => x.Status, VideoGenRunStatus.Rendering),
                f.Eq(x => x.Mode, VideoGenMode.Storyboard) & f.Eq(x => x.Status, VideoGenRunStatus.Editing)
                    & f.ElemMatch(x => x.Scenes, x => x.Status == SceneItemStatus.Generating))
            & f.Nin(x => x.Id, _generationRetryAfter.Keys);
        var candidates = await _db.VideoGenRuns.Find(filter).SortBy(x => x.CreatedAt).Limit(8).ToListAsync(ct);
        foreach (var run in candidates)
        {
            var targets = run.Status == VideoGenRunStatus.Editing
                ? run.Scenes.Select((scene, index) => (scene, index)).Where(x => x.scene.Status == SceneItemStatus.Generating)
                    .Select(x => (int?)x.index).ToArray() : new int?[] { null };
            foreach (var target in targets)
            {
                var acquired = await _generationRecovery.AcquireAsync(run, ct, target);
                if (acquired?.Lease is not { } lease)
                {
                    // 一个镜头的失效许可不能挡住同一任务的另一个可恢复镜头。
                    continue;
                }
                await using (lease)
                {
                    using var context = TaskExecutionContext.Enter(lease.Identity);
                    var finished = false;
                    try
                    {
                        var fresh = await _db.VideoGenRuns.Find(VideoGenerationRecovery.Snapshot(run, acquired.Target)).FirstOrDefaultAsync(ct);
                        if (fresh == null) continue;
                        if (acquired.Target.SceneIndex >= 0) await ProcessSceneRegenerateAtAsync(fresh, acquired.Target.SceneIndex);
                        else if (fresh.Mode == VideoGenMode.Storyboard) await ProcessStoryboardScriptingAsync(fresh);
                        else await ProcessDirectVideoGenAsync(fresh);
                        finished = !await _db.VideoGenRuns.Find(VideoGenerationRecovery.Snapshot(run, acquired.Target,
                            compareAllScenes: false)).AnyAsync(CancellationToken.None);
                    }
                    catch (TaskExecutionAdmissionException) { /* 原代次失效：迟到执行不能改写新持有者。 */ }
                    catch (OperationCanceledException) when (lease.IsLost || ct.IsCancellationRequested) { }
                    catch (Exception ex)
                    {
                        _logger.LogWarning(ex, "VideoGen 中断恢复未完成: runId={RunId}", run.Id);
                        // 不能在未知发送后制造失败/取消或重放；保留原任务与上游收据。
                        _generationRetryAfter[run.Id] = DateTime.UtcNow.AddSeconds(30);
                    }
                    finally
                    {
                        // 停机、快照读取失败或原处理跳过均不得把未发送任务记为已完成。
                        // 原协调器只接受仍由本代次独占且发送计数为零的交还。
                        if (!finished) await lease.TryReleaseForRetryAsync(CancellationToken.None);
                    }
                }
                return true;
            }
            // 不更改活跃/未知/失效任务，亦不让它持续占住原队列。
            if (_generationRetryAfter.Count < 1024) _generationRetryAfter[run.Id] = now.AddSeconds(30);
        }
        return false;
    }
}
