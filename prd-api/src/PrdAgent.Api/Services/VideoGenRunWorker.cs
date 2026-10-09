using System.Text.Json.Nodes;
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Globalization;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.LLM;
using PrdAgent.Infrastructure.Services;
using PrdAgent.Infrastructure.Services.AssetStorage;
using PrdAgent.Core.LlmGateway;

namespace PrdAgent.Api.Services;

/// <summary>
/// 视频生成与项目导出后台执行器。
///
/// 架构：用户提交 prompt → Worker 调 OpenRouter Veo/Kling/Wan/Sora → 拿到视频 URL →
/// 用 API Key 鉴权下载视频二进制 → 上传到 COS → 把 COS 公开 URL 写回 Run.VideoAssetUrl
///
/// storyboard 模式先经 LLM 拆镜，再逐镜调用模型池，并由 ffmpeg 按项目时间线合成音视频和字幕。
/// </summary>
public class VideoGenRunWorker : BackgroundService
{
    private static readonly TimeSpan SceneClaimTimeout = TimeSpan.FromMinutes(2);
    private static readonly TimeSpan SceneRenderLease = TimeSpan.FromMinutes(2);
    private static readonly TimeSpan WorkerLeaseDuration = TimeSpan.FromMinutes(2);
    private static readonly TimeSpan WorkerLeaseHeartbeat = TimeSpan.FromSeconds(20);
    private readonly MongoDbContext _db;
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly IRunEventStore _runStore;
    private readonly IAssetStorage _assetStorage;
    private readonly ILogger<VideoGenRunWorker> _logger;
    internal DateTime LegacyTakeoverEnabledAt { get; set; } = DateTime.UtcNow.AddMinutes(20);
    internal TimeSpan WorkerLeaseHeartbeatInterval { get; set; } = WorkerLeaseHeartbeat;

    public VideoGenRunWorker(
        MongoDbContext db,
        IServiceScopeFactory scopeFactory,
        IRunEventStore runStore,
        IAssetStorage assetStorage,
        ILogger<VideoGenRunWorker> logger)
    {
        _db = db;
        _scopeFactory = scopeFactory;
        _runStore = runStore;
        _assetStorage = assetStorage;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                if (await RecoverCompletedExportTaskAsync(
                        DeploymentScope.Current,
                        DeploymentScope.CurrentDurable,
                        stoppingToken)) continue;
                if (await AdoptPreviousRevisionWorkAsync(
                        DeploymentScope.Current,
                        DeploymentScope.CurrentDurable,
                        stoppingToken)) continue;
                if (await RecoverExpiredWorkerLeaseAsync(stoppingToken)) continue;
                if (await ResumePendingDeletionAsync(stoppingToken)) continue;

                // 路径 1: Queued → 根据 Mode 路由
                //   - direct      → 直接走 ProcessDirectVideoGenAsync (Rendering)
                //   - storyboard  → 走 ProcessScriptingAsync 拆分镜 (Scripting → Editing)
                var queued = await ClaimQueuedRunAsync(stoppingToken);
                if (queued != null)
                {
                    _logger.LogInformation("[VideoGenWorker] Claimed run: runId={RunId}, mode={Mode}",
                        queued.Id, queued.Mode);
                    try
                    {
                        await ProcessWithRunLeaseHeartbeatAsync(queued, async authorityToken =>
                        {
                            if (queued.Mode == VideoGenMode.Storyboard)
                                await ProcessStoryboardScriptingAsync(queued, authorityToken);
                            else
                                await ProcessDirectVideoGenAsync(queued, authorityToken);
                        });
                    }
                    catch (Exception ex)
                    {
                        _logger.LogError(ex, "VideoGen 任务失败: runId={RunId}", queued.Id);
                        await FailRunAsync(queued, "VIDEOGEN_ERROR", ex.Message);
                    }
                    continue;
                }

                // 路径 2: 原子领取 Editing 状态下待提交的单镜任务，再调 OpenRouter 生成
                if (await RecoverStaleSceneClaimAsync(stoppingToken)) continue;
                if (await RecoverExpiredSceneRenderLeaseAsync(stoppingToken)) continue;

                var sceneClaim = await ClaimEditingSceneRenderAsync(stoppingToken);
                if (sceneClaim != null)
                {
                    try
                    {
                        await ProcessSceneRenderAsync(
                            sceneClaim.Run,
                            sceneClaim.SceneIndex,
                            sceneClaim.ClaimId,
                            sceneClaim.ResumeExistingJob);
                    }
                    catch (Exception ex)
                    {
                        _logger.LogError(ex, "VideoGen 单镜渲染异常: runId={RunId}", sceneClaim.Run.Id);
                    }
                    continue;
                }

                // 路径 4: 独立导出任务，全部分镜已完成后合成为完整 MP4
                var exportTask = await ClaimExportTaskAsync(stoppingToken);
                if (exportTask != null)
                {
                    var taskRun = await _db.VideoGenRuns.Find(
                            x => x.Id == exportTask.RunId
                                 && x.DeploymentSlug == DeploymentScope.Current)
                        .FirstOrDefaultAsync(stoppingToken);
                    if (taskRun == null)
                    {
                        // 上一轮接管可能在“任务已迁移、run 尚未迁移”的两次写入之间退出。
                        // 先幂等补齐同分支 run，再把本次已领取的任务退回队列；下一轮只会重新执行导出，
                        // 不会把可恢复的半状态误判成永久失败。
                        if (await RecoverExportTaskRunAsync(
                                exportTask,
                                DeploymentScope.Current,
                                DeploymentScope.CurrentDurable,
                                stoppingToken))
                            continue;
                        await _db.VideoExportTasks.UpdateOneAsync(
                            x => x.Id == exportTask.Id,
                            Builders<VideoExportTask>.Update
                                .Set(x => x.Status, VideoExportTaskStatus.Failed)
                                .Set(x => x.ErrorMessage, "关联的视频生成任务不存在")
                                .Set(x => x.EndedAt, DateTime.UtcNow),
                            cancellationToken: CancellationToken.None);
                        continue;
                    }
                    try
                    {
                        await ProcessWithExportLeaseHeartbeatAsync(
                            exportTask,
                            authorityToken => ProcessExportAsync(taskRun, exportTask, authorityToken));
                    }
                    catch (Exception ex)
                    {
                        _logger.LogError(ex, "VideoGen 独立导出异常: runId={RunId}, taskId={TaskId}", taskRun.Id, exportTask.Id);
                        await FailExportAsync(taskRun, ex.Message, exportTask.Id, exportTask.WorkerLeaseId);
                    }
                    continue;
                }

                // 兼容升级前仍由 ExportRequested 标记的导出任务
                var exportRun = await ClaimExportRunAsync(stoppingToken);
                if (exportRun != null)
                {
                    try
                    {
                        await ProcessWithRunLeaseHeartbeatAsync(
                            exportRun,
                            authorityToken => ProcessExportAsync(exportRun, authorityToken: authorityToken));
                    }
                    catch (Exception ex)
                    {
                        _logger.LogError(ex, "VideoGen 合成导出异常: runId={RunId}", exportRun.Id);
                        await FailExportAsync(exportRun, ex.Message);
                    }
                    continue;
                }

                // 路径 3: Editing 状态有 scene.Status==Generating → LLM 重生成单镜 prompt
                var regenRun = await ClaimEditingRunWithSceneGeneratingAsync(stoppingToken);
                if (regenRun != null)
                {
                    try
                    {
                        await ProcessWithRunLeaseHeartbeatAsync(
                            regenRun,
                            authorityToken => ProcessSceneRegenerateAsync(regenRun, authorityToken));
                    }
                    catch (Exception ex)
                    {
                        _logger.LogError(ex, "VideoGen 单镜重生成异常: runId={RunId}", regenRun.Id);
                    }
                    continue;
                }
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "VideoGenRunWorker 主循环异常");
            }

            await Task.Delay(2000, stoppingToken);
        }
    }

    private async Task<bool> ResumePendingDeletionAsync(CancellationToken ct)
    {
        var retryBefore = DateTime.UtcNow - TimeSpan.FromMinutes(2);
        var fb = Builders<VideoGenRun>.Filter;
        var pending = await _db.VideoGenRuns.FindOneAndUpdateAsync(
            fb.Eq(x => x.DeploymentSlug, DeploymentScope.Current)
            & fb.Ne(x => x.DeletionRequestedAt, null)
            & fb.Or(
                fb.Eq(x => x.DeletionCleanupAttemptedAt, null),
                fb.Lte(x => x.DeletionCleanupAttemptedAt, retryBefore)),
            Builders<VideoGenRun>.Update.Set(x => x.DeletionCleanupAttemptedAt, DateTime.UtcNow),
            new FindOneAndUpdateOptions<VideoGenRun>
            {
                Sort = Builders<VideoGenRun>.Sort.Ascending(x => x.DeletionRequestedAt),
                ReturnDocument = ReturnDocument.After,
            },
            ct);
        if (pending == null) return false;

        try
        {
            using var scope = _scopeFactory.CreateScope();
            var service = scope.ServiceProvider.GetRequiredService<IVideoGenService>();
            await service.DeleteRunAsync(
                pending.Id,
                pending.OwnerAdminId,
                appKey: pending.AppKey,
                ct: CancellationToken.None);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "VideoGen 删除恢复失败，稍后重试: runId={RunId}", pending.Id);
        }
        return true;
    }

    /// <summary>
    /// 独立导出先持久化 task 结果，再幂等对齐 run。进程若在两次写入之间退出，
    /// 下一轮会从 task 的内容寻址结果恢复 run，不重复执行 ffmpeg 或上传对象。
    /// </summary>
    internal async Task<bool> RecoverCompletedExportTaskAsync(
        string? currentScope,
        string? durableScope,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(currentScope) || string.IsNullOrWhiteSpace(durableScope))
            return false;

        var taskFb = Builders<VideoExportTask>.Filter;
        var taskScope = VideoGenService.BuildBranchDeploymentFilter<VideoExportTask>(
            nameof(VideoExportTask.DeploymentSlug),
            currentScope,
            durableScope);
        var task = await _db.VideoExportTasks.Find(
                taskScope
                & taskFb.Eq(x => x.Status, VideoExportTaskStatus.Completed)
                & taskFb.Eq(x => x.RunReconciledAt, null)
                & taskFb.Ne(x => x.OutputUrl, null)
                & taskFb.Ne(x => x.OutputUrl, string.Empty)
                & taskFb.Ne(x => x.OutputSha256, null)
                & taskFb.Ne(x => x.OutputSha256, string.Empty))
            .SortBy(x => x.EndedAt)
            .FirstOrDefaultAsync(ct);
        if (task == null) return false;

        var runFb = Builders<VideoGenRun>.Filter;
        var runScope = VideoGenService.BuildBranchDeploymentFilter<VideoGenRun>(
            nameof(VideoGenRun.DeploymentSlug),
            currentScope,
            durableScope);
        var run = await _db.VideoGenRuns.Find(
                runScope
                & runFb.Eq(x => x.Id, task.RunId)
                & runFb.Eq(x => x.LatestExportTaskId, task.Id))
            .FirstOrDefaultAsync(ct);

        if (run?.Status == VideoGenRunStatus.Rendering)
        {
            var totalCost = task.TotalCost
                            ?? run.Scenes.Where(scene => scene.Cost.HasValue).Sum(scene => scene.Cost!.Value);
            var completed = await _db.VideoGenRuns.UpdateOneAsync(
                runScope
                & runFb.Eq(x => x.Id, run.Id)
                & runFb.Eq(x => x.Status, VideoGenRunStatus.Rendering)
                & runFb.Eq(x => x.LatestExportTaskId, task.Id),
                Builders<VideoGenRun>.Update
                    .Set(x => x.DeploymentSlug, currentScope)
                    .Set(x => x.Status, VideoGenRunStatus.Completed)
                    .Set(x => x.VideoAssetUrl, task.OutputUrl)
                    .Set(x => x.VideoAssetSha256, task.OutputSha256)
                    .Set(x => x.DirectVideoCost, totalCost)
                    .Set(x => x.ExportErrorMessage, (string?)null)
                    .Set(x => x.ExportedAt, task.EndedAt ?? DateTime.UtcNow)
                    .Set(x => x.EndedAt, task.EndedAt ?? DateTime.UtcNow)
                    .Set(x => x.CurrentPhase, "completed")
                    .Set(x => x.PhaseProgress, 100)
                    .Set(x => x.WorkerLeaseId, (string?)null)
                    .Set(x => x.WorkerLeaseExpiresAt, (DateTime?)null)
                    .Set(x => x.WorkerLeasePhase, (string?)null),
                cancellationToken: ct);
            if (completed.ModifiedCount != 1) return false;
            await UpdateProjectAsync(run, VideoProjectStatus.Completed);
            await PublishEventAsync(run.Id, "export.completed", new { videoUrl = task.OutputUrl, cost = totalCost });
        }

        // run 已完成、被取消、已删除或后续导出已成为 latest 时，都不存在“永久 Rendering”窗口。
        // task 自身仍是对象的有效引用，因此只标记已核对，不删除其输出。
        await _db.VideoExportTasks.UpdateOneAsync(
            taskFb.Eq(x => x.Id, task.Id)
            & taskFb.Eq(x => x.Status, VideoExportTaskStatus.Completed)
            & taskFb.Eq(x => x.RunReconciledAt, null),
            Builders<VideoExportTask>.Update
                .Set(x => x.DeploymentSlug, currentScope)
                .Set(x => x.RunReconciledAt, DateTime.UtcNow),
            cancellationToken: ct);
        return true;
    }

    /// <summary>
    /// 同一 CDS 项目与分支重新部署后，接管上一 revision 留下的可恢复工作。
    /// 有上游 jobId 的直出任务回到队列后只恢复轮询；提交结果不明的任务失败收口，避免重复扣费。
    /// Scripting 与分镜 prompt 生成可安全重跑；有活跃视频提交/轮询 lease 的分镜仍由原持有者收口。
    /// </summary>
    internal async Task<bool> AdoptPreviousRevisionWorkAsync(
        string? currentScope,
        string? durableScope,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(currentScope)
            || string.IsNullOrWhiteSpace(durableScope)
            || string.Equals(currentScope, durableScope, StringComparison.Ordinal))
            return false;

        var fb = Builders<VideoGenRun>.Filter;
        var sceneFb = Builders<VideoGenScene>.Filter;
        var now = DateTime.UtcNow;
        var allowLegacyTakeover = now >= LegacyTakeoverEnabledAt;
        var previousRevision = VideoGenService.BuildBranchDeploymentFilter<VideoGenRun>(
                                   nameof(VideoGenRun.DeploymentSlug),
                                   currentScope,
                                   durableScope)
                               & fb.Ne(x => x.DeploymentSlug, currentScope);

        // 独立导出任务与关联 run 必须作为一个恢复单元迁移，否则任务先被领取后会因找不到
        // 当前 revision 的 run 而被误判失败。先迁移任务，再在返回主循环前迁移关联 run。
        var exportFb = Builders<VideoExportTask>.Filter;
        var previousExportRevision = VideoGenService.BuildBranchDeploymentFilter<VideoExportTask>(
                                         nameof(VideoExportTask.DeploymentSlug),
                                         currentScope,
                                         durableScope)
                                     & exportFb.Ne(x => x.DeploymentSlug, currentScope);
        var expiredExportLease = exportFb.Ne(x => x.WorkerLeaseId, null)
                                 & exportFb.Lte(x => x.WorkerLeaseExpiresAt, now);
        var legacyExport = allowLegacyTakeover
            ? exportFb.Or(
                exportFb.Eq(x => x.WorkerLeaseId, null),
                exportFb.Eq(x => x.WorkerLeaseExpiresAt, null))
            : exportFb.Empty & exportFb.Exists(x => x.Id, false);
        var recoverableExport = exportFb.Eq(x => x.Status, VideoExportTaskStatus.Queued)
                                | (exportFb.Eq(x => x.Status, VideoExportTaskStatus.Processing)
                                   & (expiredExportLease | legacyExport));
        var adoptedExport = await _db.VideoExportTasks.FindOneAndUpdateAsync(
            previousExportRevision & recoverableExport,
            Builders<VideoExportTask>.Update
                .Set(x => x.DeploymentSlug, currentScope)
                .Set(x => x.Status, VideoExportTaskStatus.Queued)
                .Set(x => x.CurrentPhase, "queued")
                .Set(x => x.Progress, 0)
                .Set(x => x.StartedAt, (DateTime?)null)
                .Set(x => x.WorkerLeaseId, (string?)null)
                .Set(x => x.WorkerLeaseExpiresAt, (DateTime?)null),
            new FindOneAndUpdateOptions<VideoExportTask>
            {
                Sort = Builders<VideoExportTask>.Sort.Ascending(x => x.CreatedAt),
                ReturnDocument = ReturnDocument.After,
            },
            ct);
        if (adoptedExport != null)
        {
            await _db.VideoGenRuns.UpdateOneAsync(
                fb.Eq(x => x.Id, adoptedExport.RunId)
                & VideoGenService.BuildBranchDeploymentFilter<VideoGenRun>(
                    nameof(VideoGenRun.DeploymentSlug),
                    currentScope,
                    durableScope),
                Builders<VideoGenRun>.Update.Set(x => x.DeploymentSlug, currentScope),
                cancellationToken: ct);
            _logger.LogInformation(
                "[VideoGenWorker] 已接管同分支上一 revision 的导出任务: taskId={TaskId}, runId={RunId}",
                adoptedExport.Id,
                adoptedExport.RunId);
            return true;
        }

        var expiredRunLease = fb.Ne(x => x.WorkerLeaseId, null)
                              & fb.Lte(x => x.WorkerLeaseExpiresAt, now);
        var legacyRun = allowLegacyTakeover
            ? fb.Or(
                fb.Eq(x => x.WorkerLeaseId, null),
                fb.Eq(x => x.WorkerLeaseExpiresAt, null))
            : fb.Empty & fb.Exists(x => x.Id, false);
        var recoverableRunLease = expiredRunLease | legacyRun;

        // 删除已经持久化删除意图且受 run 级互斥锁保护，迁移后可由当前 worker 续作。
        var deletion = await _db.VideoGenRuns.FindOneAndUpdateAsync(
            previousRevision & fb.Ne(x => x.DeletionRequestedAt, null),
            Builders<VideoGenRun>.Update.Set(x => x.DeploymentSlug, currentScope),
            new FindOneAndUpdateOptions<VideoGenRun> { ReturnDocument = ReturnDocument.After },
            ct);
        if (deletion != null) return true;

        // LLM 拆镜没有可恢复的外部 job，旧 revision 已退出后从队列重新执行即可。
        var scripting = await _db.VideoGenRuns.FindOneAndUpdateAsync(
            previousRevision
            & fb.Eq(x => x.DeletionRequestedAt, null)
            & fb.Eq(x => x.Status, VideoGenRunStatus.Scripting)
            & recoverableRunLease,
            Builders<VideoGenRun>.Update
                .Set(x => x.DeploymentSlug, currentScope)
                .Set(x => x.Status, VideoGenRunStatus.Queued)
                .Set(x => x.CurrentPhase, "queued")
                .Set(x => x.PhaseProgress, 0)
                .Set(x => x.WorkerLeaseId, (string?)null)
                .Set(x => x.WorkerLeaseExpiresAt, (DateTime?)null)
                .Set(x => x.WorkerLeasePhase, (string?)null),
            new FindOneAndUpdateOptions<VideoGenRun> { ReturnDocument = ReturnDocument.After },
            ct);
        if (scripting != null) return true;

        // 已持久化 jobId 的直出任务只恢复轮询，ProcessDirectVideoGenAsync 不会再次提交。
        var directRendering = await _db.VideoGenRuns.FindOneAndUpdateAsync(
            previousRevision
            & fb.Eq(x => x.DeletionRequestedAt, null)
            & fb.Eq(x => x.Status, VideoGenRunStatus.Rendering)
            & fb.Eq(x => x.Mode, VideoGenMode.Direct)
            & fb.Ne(x => x.WorkerLeasePhase, "export")
            & fb.Ne(x => x.DirectVideoJobId, null)
            & fb.Ne(x => x.DirectVideoJobId, string.Empty)
            & recoverableRunLease,
            Builders<VideoGenRun>.Update
                .Set(x => x.DeploymentSlug, currentScope)
                .Set(x => x.Status, VideoGenRunStatus.Queued)
                .Set(x => x.CurrentPhase, "videogen-resuming")
                .Set(x => x.WorkerLeaseId, (string?)null)
                .Set(x => x.WorkerLeaseExpiresAt, (DateTime?)null)
                .Set(x => x.WorkerLeasePhase, (string?)null),
            new FindOneAndUpdateOptions<VideoGenRun> { ReturnDocument = ReturnDocument.After },
            ct);
        if (directRendering != null) return true;

        // Rendering 但没有 jobId 表示提交结果未能持久化。自动重提可能产生重复费用，因此明确失败收口。
        var uncertainDirect = await _db.VideoGenRuns.FindOneAndUpdateAsync(
            previousRevision
            & fb.Eq(x => x.DeletionRequestedAt, null)
            & fb.Eq(x => x.Status, VideoGenRunStatus.Rendering)
            & fb.Eq(x => x.Mode, VideoGenMode.Direct)
            & fb.Ne(x => x.WorkerLeasePhase, "export")
            & (fb.Eq(x => x.DirectVideoJobId, null) | fb.Eq(x => x.DirectVideoJobId, string.Empty))
            & recoverableRunLease,
            Builders<VideoGenRun>.Update
                .Set(x => x.DeploymentSlug, currentScope)
                .Set(x => x.Status, VideoGenRunStatus.Failed)
                .Set(x => x.CurrentPhase, "failed")
                .Set(x => x.ErrorCode, "DEPLOYMENT_INTERRUPTED_SUBMIT")
                .Set(x => x.ErrorMessage, "部署切换时视频提交结果未能确认。为避免重复扣费，系统未自动重试；请确认后手动重新生成。")
                .Set(x => x.EndedAt, DateTime.UtcNow)
                .Set(x => x.WorkerLeaseId, (string?)null)
                .Set(x => x.WorkerLeaseExpiresAt, (DateTime?)null)
                .Set(x => x.WorkerLeasePhase, (string?)null),
            new FindOneAndUpdateOptions<VideoGenRun> { ReturnDocument = ReturnDocument.After },
            ct);
        if (uncertainDirect != null) return true;

        // 独立导出与旧版 ExportRequested 均可从持久化素材重做，不存在重复上游生成费用。
        var storyboardRendering = await _db.VideoGenRuns.FindOneAndUpdateAsync(
            previousRevision
            & fb.Eq(x => x.DeletionRequestedAt, null)
            & fb.Eq(x => x.Status, VideoGenRunStatus.Rendering)
            & fb.Eq(x => x.Mode, VideoGenMode.Storyboard)
            & recoverableRunLease,
            Builders<VideoGenRun>.Update
                .Set(x => x.DeploymentSlug, currentScope)
                .Set(x => x.WorkerLeaseId, (string?)null)
                .Set(x => x.WorkerLeaseExpiresAt, (DateTime?)null)
                .Set(x => x.WorkerLeasePhase, (string?)null),
            new FindOneAndUpdateOptions<VideoGenRun> { ReturnDocument = ReturnDocument.After },
            ct);
        if (storyboardRendering != null) return true;

        // 单镜 prompt 生成没有外部 jobId；迁移后由当前 worker 重跑并写回。
        var generatingPrompt = await _db.VideoGenRuns.FindOneAndUpdateAsync(
            previousRevision
            & fb.Eq(x => x.DeletionRequestedAt, null)
            & fb.Eq(x => x.Status, VideoGenRunStatus.Editing)
            & fb.ElemMatch(x => x.Scenes, sceneFb.Eq(x => x.Status, SceneItemStatus.Generating))
            & recoverableRunLease,
            Builders<VideoGenRun>.Update
                .Set(x => x.DeploymentSlug, currentScope)
                .Set(x => x.WorkerLeaseId, (string?)null)
                .Set(x => x.WorkerLeaseExpiresAt, (DateTime?)null)
                .Set(x => x.WorkerLeasePhase, (string?)null),
            new FindOneAndUpdateOptions<VideoGenRun> { ReturnDocument = ReturnDocument.After },
            ct);
        if (generatingPrompt != null) return true;

        var staleClaimBefore = now - SceneClaimTimeout;
        var activeScene = sceneFb.Eq(x => x.Status, SceneItemStatus.Generating)
                          | sceneFb.Eq(x => x.Status, SceneItemStatus.Rendering)
                          | (sceneFb.Eq(x => x.Status, SceneItemStatus.SubmittingClaimed)
                             & ((sceneFb.Ne(x => x.RenderLeaseId, null)
                                 & sceneFb.Gt(x => x.RenderLeaseExpiresAt, now))
                                | (sceneFb.Eq(x => x.RenderLeaseId, null)
                                   & (!allowLegacyTakeover
                                      ? sceneFb.Empty
                                      : sceneFb.Eq(x => x.SubmissionStartedAt, null)
                                        | sceneFb.Gt(x => x.SubmissionStartedAt, staleClaimBefore)))))
                          | (sceneFb.Eq(x => x.Status, SceneItemStatus.PollingClaimed)
                             & (sceneFb.Eq(x => x.RenderLeaseExpiresAt, null)
                                | sceneFb.Gt(x => x.RenderLeaseExpiresAt, now)));
        var adoptableState = fb.Eq(x => x.Status, VideoGenRunStatus.Queued)
                             | (fb.Eq(x => x.Status, VideoGenRunStatus.Editing)
                                & fb.Not(fb.ElemMatch(x => x.Scenes, activeScene)));
        var adopted = await _db.VideoGenRuns.FindOneAndUpdateAsync(
            previousRevision
            & fb.Eq(x => x.DeletionRequestedAt, null)
            & adoptableState,
            Builders<VideoGenRun>.Update.Set(x => x.DeploymentSlug, currentScope),
            new FindOneAndUpdateOptions<VideoGenRun>
            {
                Sort = Builders<VideoGenRun>.Sort.Ascending(x => x.CreatedAt),
                ReturnDocument = ReturnDocument.After,
            },
            ct);
        if (adopted == null) return false;

        _logger.LogInformation(
            "[VideoGenWorker] 已接管同分支上一 revision 的安全任务: runId={RunId}, status={Status}",
            adopted.Id,
            adopted.Status);
        return true;
    }

    /// <summary>
    /// 当前 revision 的 worker 异常退出时，租约到期后恢复其未完成任务。
    /// 新版任务按 lease 到期判断；升级前无 lease 的处理中任务仅在保守等待窗口后恢复。
    /// </summary>
    internal async Task<bool> RecoverExpiredWorkerLeaseAsync(CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        var allowLegacyTakeover = now >= LegacyTakeoverEnabledAt;
        var exportFb = Builders<VideoExportTask>.Filter;
        var expiredExportLease = exportFb.Ne(x => x.WorkerLeaseId, null)
                                 & exportFb.Lte(x => x.WorkerLeaseExpiresAt, now);
        var legacyExport = allowLegacyTakeover
            ? exportFb.Or(
                exportFb.Eq(x => x.WorkerLeaseId, null),
                exportFb.Eq(x => x.WorkerLeaseExpiresAt, null))
            : exportFb.Empty & exportFb.Exists(x => x.Id, false);
        var recoveredExport = await _db.VideoExportTasks.FindOneAndUpdateAsync(
            exportFb.Eq(x => x.DeploymentSlug, DeploymentScope.Current)
            & exportFb.Eq(x => x.Status, VideoExportTaskStatus.Processing)
            & (expiredExportLease | legacyExport),
            Builders<VideoExportTask>.Update
                .Set(x => x.Status, VideoExportTaskStatus.Queued)
                .Set(x => x.CurrentPhase, "queued")
                .Set(x => x.Progress, 0)
                .Set(x => x.StartedAt, (DateTime?)null)
                .Set(x => x.WorkerLeaseId, (string?)null)
                .Set(x => x.WorkerLeaseExpiresAt, (DateTime?)null),
            new FindOneAndUpdateOptions<VideoExportTask>
            {
                Sort = Builders<VideoExportTask>.Sort.Ascending(x => x.CreatedAt),
                ReturnDocument = ReturnDocument.After,
            },
            ct);
        if (recoveredExport != null) return true;

        var fb = Builders<VideoGenRun>.Filter;
        var expiredRunLease = fb.Eq(x => x.DeploymentSlug, DeploymentScope.Current)
                              & fb.Ne(x => x.WorkerLeaseId, null)
                              & fb.Lte(x => x.WorkerLeaseExpiresAt, now);
        var recoveredScripting = await _db.VideoGenRuns.FindOneAndUpdateAsync(
            expiredRunLease & fb.Eq(x => x.Status, VideoGenRunStatus.Scripting),
            Builders<VideoGenRun>.Update
                .Set(x => x.Status, VideoGenRunStatus.Queued)
                .Set(x => x.CurrentPhase, "queued")
                .Set(x => x.PhaseProgress, 0)
                .Set(x => x.WorkerLeaseId, (string?)null)
                .Set(x => x.WorkerLeaseExpiresAt, (DateTime?)null)
                .Set(x => x.WorkerLeasePhase, (string?)null),
            new FindOneAndUpdateOptions<VideoGenRun> { ReturnDocument = ReturnDocument.After },
            ct);
        if (recoveredScripting != null) return true;

        var recoveredDirect = await _db.VideoGenRuns.FindOneAndUpdateAsync(
            expiredRunLease
            & fb.Eq(x => x.Status, VideoGenRunStatus.Rendering)
            & fb.Eq(x => x.Mode, VideoGenMode.Direct)
            & fb.Ne(x => x.WorkerLeasePhase, "export")
            & fb.Ne(x => x.DirectVideoJobId, null)
            & fb.Ne(x => x.DirectVideoJobId, string.Empty),
            Builders<VideoGenRun>.Update
                .Set(x => x.Status, VideoGenRunStatus.Queued)
                .Set(x => x.CurrentPhase, "videogen-resuming")
                .Set(x => x.WorkerLeaseId, (string?)null)
                .Set(x => x.WorkerLeaseExpiresAt, (DateTime?)null)
                .Set(x => x.WorkerLeasePhase, (string?)null),
            new FindOneAndUpdateOptions<VideoGenRun> { ReturnDocument = ReturnDocument.After },
            ct);
        if (recoveredDirect != null) return true;

        var uncertainDirect = await _db.VideoGenRuns.FindOneAndUpdateAsync(
            expiredRunLease
            & fb.Eq(x => x.Status, VideoGenRunStatus.Rendering)
            & fb.Eq(x => x.Mode, VideoGenMode.Direct)
            & fb.Ne(x => x.WorkerLeasePhase, "export")
            & (fb.Eq(x => x.DirectVideoJobId, null) | fb.Eq(x => x.DirectVideoJobId, string.Empty)),
            Builders<VideoGenRun>.Update
                .Set(x => x.Status, VideoGenRunStatus.Failed)
                .Set(x => x.CurrentPhase, "failed")
                .Set(x => x.ErrorCode, "WORKER_INTERRUPTED_SUBMIT")
                .Set(x => x.ErrorMessage, "视频提交结果未能确认。为避免重复扣费，系统未自动重试；请确认后手动重新生成。")
                .Set(x => x.EndedAt, now)
                .Set(x => x.WorkerLeaseId, (string?)null)
                .Set(x => x.WorkerLeaseExpiresAt, (DateTime?)null)
                .Set(x => x.WorkerLeasePhase, (string?)null),
            new FindOneAndUpdateOptions<VideoGenRun> { ReturnDocument = ReturnDocument.After },
            ct);
        if (uncertainDirect != null) return true;

        var recoveredLegacyExport = await _db.VideoGenRuns.FindOneAndUpdateAsync(
            expiredRunLease
            & fb.Eq(x => x.Status, VideoGenRunStatus.Rendering)
            & fb.Eq(x => x.WorkerLeasePhase, "export"),
            Builders<VideoGenRun>.Update
                .Set(x => x.ExportRequested, true)
                .Set(x => x.CurrentPhase, "export-queued")
                .Set(x => x.PhaseProgress, 1)
                .Set(x => x.WorkerLeaseId, (string?)null)
                .Set(x => x.WorkerLeaseExpiresAt, (DateTime?)null)
                .Set(x => x.WorkerLeasePhase, (string?)null),
            new FindOneAndUpdateOptions<VideoGenRun> { ReturnDocument = ReturnDocument.After },
            ct);
        if (recoveredLegacyExport != null) return true;

        var sceneFb = Builders<VideoGenScene>.Filter;
        var recoveredPrompt = await _db.VideoGenRuns.FindOneAndUpdateAsync(
            expiredRunLease
            & fb.Eq(x => x.Status, VideoGenRunStatus.Editing)
            & fb.ElemMatch(x => x.Scenes, sceneFb.Eq(x => x.Status, SceneItemStatus.Generating)),
            Builders<VideoGenRun>.Update
                .Set(x => x.WorkerLeaseId, (string?)null)
                .Set(x => x.WorkerLeaseExpiresAt, (DateTime?)null)
                .Set(x => x.WorkerLeasePhase, (string?)null),
            new FindOneAndUpdateOptions<VideoGenRun> { ReturnDocument = ReturnDocument.After },
            ct);
        return recoveredPrompt != null;
    }

    /// <summary>
    /// 拾取 Queued 任务，置为 Rendering 或 Scripting（根据 Mode）
    /// </summary>
    internal async Task<VideoGenRun?> ClaimQueuedRunAsync(CancellationToken ct)
    {
        var fb = Builders<VideoGenRun>.Filter;
        var queueScope = fb.Eq(x => x.Status, VideoGenRunStatus.Queued)
                         & fb.Eq(x => x.DeploymentSlug, DeploymentScope.Current);
        // 先 peek 看下 Mode（避免错误置 status）
        var pending = await _db.VideoGenRuns.Find(queueScope)
            .SortBy(x => x.CreatedAt)
            .FirstOrDefaultAsync(ct);
        if (pending == null) return null;

        var nextStatus = pending.Mode == VideoGenMode.Storyboard
            ? VideoGenRunStatus.Scripting
            : VideoGenRunStatus.Rendering;
        var nextPhase = pending.Mode == VideoGenMode.Storyboard
            ? "scripting"
            : "videogen-submitting";
        var leaseId = $"worker:{Guid.NewGuid():N}";

        var update = Builders<VideoGenRun>.Update
            .Set(x => x.Status, nextStatus)
            .Set(x => x.StartedAt, DateTime.UtcNow)
            .Set(x => x.CurrentPhase, nextPhase)
            .Set(x => x.PhaseProgress, 1)
            .Set(x => x.WorkerLeaseId, leaseId)
            .Set(x => x.WorkerLeaseExpiresAt, DateTime.UtcNow + WorkerLeaseDuration)
            .Set(x => x.WorkerLeasePhase, nextPhase);

        var run = await _db.VideoGenRuns.FindOneAndUpdateAsync(
            queueScope & fb.Eq(x => x.Id, pending.Id),
            update,
            new FindOneAndUpdateOptions<VideoGenRun>
            {
                ReturnDocument = ReturnDocument.After,
            },
            ct);
        return run;
    }

    /// <summary>
    /// OpenRouter 直出：提交 → 轮询 → 写回 VideoAssetUrl → Completed
    /// 使用 CancellationToken.None（服务器权威原则）
    ///
    /// AppCallerCode = "video-agent.videogen::video-gen" 决定模型池，
    /// 平台 ApiKey 从平台管理中配置的凭据自动取用，不依赖环境变量。
    /// </summary>
    private async Task ProcessDirectVideoGenAsync(VideoGenRun run, CancellationToken authorityToken)
    {
        authorityToken.ThrowIfCancellationRequested();
        // 领取前已请求取消（claim 仅过滤 Status==Queued、不看 CancelRequested）：直接置终态，不进入提交流程（Codex review）
        if (run.CancelRequested) { await CancelRunAsync(run); return; }

        // 按 run.AppKey 选 caller：视觉分镜台(visual-agent)创建的 run 归属 visual-agent 视频配额/模型池与日志归因，
        // 不再一律记到 video-agent（Codex review，配合前端改走 /api/visual-agent/video-gen）。
        var appCallerCode = run.AppKey == "visual-agent"
            ? AppCallerRegistry.VisualAgent.VideoGen.Generate
            : AppCallerRegistry.VideoAgent.VideoGen.Generate;

        _logger.LogInformation("VideoGen 直出开始: runId={RunId}, userModel={Model}, duration={Duration}s",
            run.Id, run.DirectVideoModel, run.DirectDuration);

        var resumingPersistedJob = !string.IsNullOrWhiteSpace(run.DirectVideoJobId);
        await PublishEventAsync(run.Id, "phase.changed", new
        {
            phase = resumingPersistedJob ? "videogen-polling" : "videogen-submitting",
            progress = resumingPersistedJob ? Math.Max(run.PhaseProgress, 10) : 5,
        });

        using var scope = _scopeFactory.CreateScope();
        var client = scope.ServiceProvider.GetRequiredService<IOpenRouterVideoClient>();
        var ctxAccessor = scope.ServiceProvider.GetRequiredService<ILLMRequestContextAccessor>();

        using var _ = ctxAccessor.BeginScope(new LlmRequestContext(
            RequestId: run.Id,
            GroupId: null,
            SessionId: run.Id,
            UserId: run.OwnerAdminId,
            ViewRole: null,
            DocumentChars: null,
            DocumentHash: null,
            SystemPromptRedacted: "[VIDEO_GEN_DIRECT]",
            RequestType: ModelTypes.VideoGen,
            AppCallerCode: appCallerCode,
            RunId: run.Id,
            LogicalRequestId: run.Id));

        var jobId = run.DirectVideoJobId;
        var actualModel = run.DirectVideoModel;
        var offeringId = run.DirectVideoOfferingId;
        if (string.IsNullOrWhiteSpace(jobId))
        {
            var prompt = run.DirectPrompt ?? string.Empty;
            if (string.IsNullOrWhiteSpace(prompt))
            {
                await FailRunAsync(run, "EMPTY_PROMPT", "directPrompt 为空，无法生成视频");
                return;
            }
            var directProject = await GetRunProjectAsync(run);
            prompt = AppendAssetConstraints(prompt, directProject);
            var directReferences = await SupportsReferenceAssetsAsync(run.DirectVideoModel)
                ? GetReferenceImageUrls(directProject)
                : [];
            var submitReq = new OpenRouterVideoSubmitRequest
            {
                AppCallerCode = appCallerCode,
                Model = run.DirectVideoModel,
                Prompt = prompt,
                FirstFrameImageUrl = run.DirectFirstFrameUrl,
                ReferenceImageUrls = directReferences,
                AspectRatio = run.DirectAspectRatio,
                Resolution = run.DirectResolution,
                DurationSeconds = run.DirectDuration,
                GenerateAudio = run.GenerateAudio,
                UserId = run.OwnerAdminId,
                RequestId = run.Id
            };

            // 提交前最后一道闸：领取后、提交到 OpenRouter 之前若收到取消请求，置终态不提交。
            var freshBeforeSubmit = await _db.VideoGenRuns.Find(OwnedRunFilter(run))
                .FirstOrDefaultAsync(CancellationToken.None);
            if (freshBeforeSubmit == null) return;
            if (freshBeforeSubmit?.CancelRequested == true) { await CancelRunAsync(run); return; }

            authorityToken.ThrowIfCancellationRequested();
            var submitResult = await client.SubmitAsync(submitReq, authorityToken);
            if (!submitResult.Success || string.IsNullOrWhiteSpace(submitResult.JobId))
            {
                await FailRunAsync(run, "OPENROUTER_SUBMIT_FAILED",
                    submitResult.ErrorMessage ?? "OpenRouter 提交失败");
                return;
            }
            jobId = submitResult.JobId;
            actualModel = submitResult.ActualModel ?? run.DirectVideoModel;
            offeringId = submitResult.OfferingId;

            var persistedJob = await _db.VideoGenRuns.UpdateOneAsync(
                OwnedRunFilter(run),
                Builders<VideoGenRun>.Update
                    .Set(x => x.DirectVideoModel, actualModel)
                    .Set(x => x.DirectVideoOfferingId, offeringId)
                    .Set(x => x.DirectDuration, submitResult.ActualDurationSeconds ?? run.DirectDuration)
                    .Set(x => x.TotalDurationSeconds, submitResult.ActualDurationSeconds ?? run.TotalDurationSeconds)
                    .Set(x => x.DirectVideoJobId, jobId)
                    .Set(x => x.CurrentPhase, "videogen-polling")
                    .Set(x => x.PhaseProgress, 10),
                cancellationToken: CancellationToken.None);
            if (persistedJob.MatchedCount != 1) return;
        }
        else
        {
            var resumed = await _db.VideoGenRuns.UpdateOneAsync(
                OwnedRunFilter(run),
                Builders<VideoGenRun>.Update
                    .Set(x => x.CurrentPhase, "videogen-polling")
                    .Set(x => x.PhaseProgress, Math.Max(run.PhaseProgress, 10)),
                cancellationToken: CancellationToken.None);
            if (resumed.MatchedCount != 1) return;
        }

        await PublishEventAsync(run.Id, "phase.changed",
            new { phase = "videogen-polling", progress = 10, jobId });

        // ─── 轮询 ───
        const int pollIntervalSec = 6;
        const int maxWaitMinutes = 10;
        var deadline = DateTime.UtcNow.AddMinutes(maxWaitMinutes);
        var progress = 10;

        while (DateTime.UtcNow < deadline)
        {
            // 用户取消
            var fresh = await _db.VideoGenRuns.Find(x => x.Id == run.Id).FirstOrDefaultAsync(CancellationToken.None);
            if (fresh?.CancelRequested == true)
            {
                await CancelRunAsync(run);
                return;
            }

            await Task.Delay(TimeSpan.FromSeconds(pollIntervalSec), authorityToken);

            OpenRouterVideoStatus status;
            try
            {
                status = string.IsNullOrWhiteSpace(offeringId)
                    ? await client.GetStatusAsync(
                        appCallerCode,
                        jobId!,
                        actualModel,
                        authorityToken)
                    : await client.GetStatusForOfferingAsync(
                        appCallerCode,
                        jobId!,
                        actualModel,
                        offeringId,
                        authorityToken);
            }
            catch (OperationCanceledException) when (authorityToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "VideoGen 轮询异常（继续等待）: runId={RunId}", run.Id);
                continue;
            }

            if (status.IsCompleted && !string.IsNullOrWhiteSpace(status.VideoUrl))
            {
                // 关键：OpenRouter URL 需 API Key 鉴权才能播放，浏览器无法直接 <video src>。
                // 必须下载到 COS / R2 后用公开 URL 替换。
                _logger.LogInformation("VideoGen 直出渲染完成，下载到 COS: runId={RunId}, openrouterUrl={Url}",
                    run.Id, status.VideoUrl);

                await _db.VideoGenRuns.UpdateOneAsync(
                    OwnedRunFilter(run),
                    Builders<VideoGenRun>.Update
                        .Set(x => x.CurrentPhase, "downloading")
                        .Set(x => x.PhaseProgress, 95),
                    cancellationToken: CancellationToken.None);

                await PublishEventAsync(run.Id, "phase.changed", new { phase = "downloading", progress = 95 });

                string finalUrl;
                try
                {
                    var dl = string.IsNullOrWhiteSpace(offeringId)
                        ? await client.DownloadVideoBytesAsync(
                            appCallerCode,
                            jobId!,
                            0,
                            actualModel,
                            authorityToken)
                        : await client.DownloadVideoBytesForOfferingAsync(
                            appCallerCode,
                            jobId!,
                            0,
                            actualModel,
                            offeringId,
                            authorityToken);
                    if (!dl.Success || dl.Bytes == null || dl.Bytes.Length == 0)
                    {
                        await FailRunAsync(run, "DOWNLOAD_FAILED",
                            $"OpenRouter 视频下载失败: {dl.ErrorMessage ?? "二进制为空"}");
                        return;
                    }

                    var playbackBytes = await VideoFastStartOptimizer.OptimizeAsync(dl.Bytes, _logger);
                    var expectedSha256 = Convert.ToHexString(SHA256.HashData(playbackBytes)).ToLowerInvariant();
                    await using var assetLease = await VideoAssetMutationLease.AcquireAsync(
                        _db,
                        $"generated-video:{expectedSha256}",
                        authorityToken);
                    RegistryAssetStorage.OverrideNextScope("generated");
                    var stored = await _assetStorage.SaveAsync(
                        playbackBytes, dl.ContentType ?? "video/mp4", authorityToken,
                        domain: AppDomainPaths.DomainVideoAgent, type: AppDomainPaths.TypeVideo);
                    if (!string.Equals(stored.Sha256, expectedSha256, StringComparison.OrdinalIgnoreCase))
                        throw new InvalidOperationException("视频资产摘要校验失败");
                    finalUrl = stored.Url;

                    if (!await TryCompleteDirectRunAsync(
                            run,
                            jobId!,
                            finalUrl,
                            stored.Sha256,
                            status.Cost)) return;

                    _logger.LogInformation("VideoGen 视频已上传 COS: runId={RunId}, url={Url}, size={Size}",
                        run.Id, finalUrl, stored.SizeBytes);
                }
                catch (OperationCanceledException) when (authorityToken.IsCancellationRequested)
                {
                    throw;
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "VideoGen 下载/上传失败: runId={RunId}", run.Id);
                    await FailRunAsync(run, "DOWNLOAD_FAILED", $"视频下载或上传 COS 失败: {ex.Message}");
                    return;
                }

                await UpdateProjectAsync(run, VideoProjectStatus.Completed);

                await PublishEventAsync(run.Id, "run.completed", new
                {
                    videoUrl = finalUrl,
                    cost = status.Cost
                });

                _logger.LogInformation("VideoGen 直出完成: runId={RunId}, finalUrl={Url}, cost=${Cost}",
                    run.Id, finalUrl, status.Cost);
                return;
            }

            if (status.IsFailed)
            {
                await FailRunAsync(run, "OPENROUTER_GEN_FAILED",
                    status.ErrorMessage ?? $"OpenRouter 状态 = {status.Status}");
                return;
            }

            // 递增进度（保持用户感知到"在动"）
            progress = Math.Min(90, progress + 3);
            await _db.VideoGenRuns.UpdateOneAsync(
                OwnedRunFilter(run),
                Builders<VideoGenRun>.Update.Set(x => x.PhaseProgress, progress),
                cancellationToken: CancellationToken.None);
            await PublishEventAsync(run.Id, "phase.progress",
                new { phase = "videogen-polling", progress, status = status.Status });
        }

        await FailRunAsync(run, "OPENROUTER_TIMEOUT", $"视频生成超过 {maxWaitMinutes} 分钟未完成");
    }

    internal async Task<bool> TryCompleteDirectRunAsync(
        VideoGenRun run,
        string jobId,
        string storedUrl,
        string storedSha256,
        double? cost)
    {
        try
        {
            var completed = await _db.VideoGenRuns.UpdateOneAsync(
                Builders<VideoGenRun>.Filter.Eq(x => x.Id, run.Id)
                & Builders<VideoGenRun>.Filter.Eq(x => x.DeploymentSlug, DeploymentScope.Current)
                & Builders<VideoGenRun>.Filter.Eq(x => x.Status, VideoGenRunStatus.Rendering)
                & Builders<VideoGenRun>.Filter.Eq(x => x.CancelRequested, false)
                & Builders<VideoGenRun>.Filter.Eq(x => x.DirectVideoJobId, jobId)
                & Builders<VideoGenRun>.Filter.Eq(x => x.WorkerLeaseId, run.WorkerLeaseId),
                Builders<VideoGenRun>.Update
                    .Set(x => x.Status, VideoGenRunStatus.Completed)
                    .Set(x => x.VideoAssetUrl, storedUrl)
                    .Set(x => x.VideoAssetSha256, storedSha256)
                    .Set(x => x.DirectVideoCost, cost)
                    .Set(x => x.CurrentPhase, "completed")
                    .Set(x => x.PhaseProgress, 100)
                    .Set(x => x.EndedAt, DateTime.UtcNow)
                    .Set(x => x.WorkerLeaseId, (string?)null)
                    .Set(x => x.WorkerLeaseExpiresAt, (DateTime?)null)
                    .Set(x => x.WorkerLeasePhase, (string?)null),
                cancellationToken: CancellationToken.None);
            if (completed.ModifiedCount == 1) return true;
        }
        catch
        {
            await DeleteStoredVideoIfUnreferencedAsync(storedSha256, storedUrl);
            throw;
        }

        await DeleteStoredVideoIfUnreferencedAsync(storedSha256, storedUrl);
        if (await IsRunCancellationRequestedAsync(run.Id))
            await CancelRunAsync(run);
        return false;
    }

    /// <summary>
    /// 迟到写回失去 fencing 资格时，只删除没有任何持久化引用的内容寻址对象。
    /// 调用方在生产路径中仍持有对应 SHA 的 <see cref="VideoAssetMutationLease"/>，
    /// 因而引用检查与删除不会和同一对象的新写回交错。
    /// </summary>
    internal async Task DeleteStoredVideoIfUnreferencedAsync(string sha256, string url)
    {
        if (string.IsNullOrWhiteSpace(sha256) || string.IsNullOrWhiteSpace(url)) return;

        var runFb = Builders<VideoGenRun>.Filter;
        var runReferences = await _db.VideoGenRuns.CountDocumentsAsync(
            runFb.Or(
                runFb.Eq(x => x.VideoAssetSha256, sha256),
                runFb.Eq("Scenes.Versions.AssetSha256", sha256),
                runFb.Eq(x => x.VideoAssetUrl, url),
                runFb.Eq("Scenes.Versions.VideoUrl", url)),
            cancellationToken: CancellationToken.None);
        if (runReferences > 0) return;

        var projectFb = Builders<VideoProject>.Filter;
        var projectReferences = await _db.VideoProjects.CountDocumentsAsync(
            projectFb.Or(
                projectFb.Eq("TimelineTracks.Clips.AssetUrl", url),
                projectFb.Eq("Assets.Url", url)),
            cancellationToken: CancellationToken.None);
        if (projectReferences > 0) return;

        var exportReferences = await _db.VideoExportTasks.CountDocumentsAsync(
            Builders<VideoExportTask>.Filter.Eq(x => x.OutputUrl, url),
            cancellationToken: CancellationToken.None);
        if (exportReferences > 0) return;

        await _assetStorage.DeleteByShaAsync(
            sha256,
            CancellationToken.None,
            domain: AppDomainPaths.DomainVideoAgent,
            type: AppDomainPaths.TypeVideo);
    }

    private async Task FailRunAsync(VideoGenRun run, string errorCode, string errorMessage)
    {
        var userMessage = VideoGenerationUserError.ForPersistence(errorCode, errorMessage);
        var failed = await _db.VideoGenRuns.UpdateOneAsync(
            OwnedRunFilter(run),
            Builders<VideoGenRun>.Update
                .Set(x => x.Status, VideoGenRunStatus.Failed)
                .Set(x => x.ErrorCode, errorCode)
                .Set(x => x.ErrorMessage, userMessage)
                .Set(x => x.EndedAt, DateTime.UtcNow)
                .Set(x => x.WorkerLeaseId, (string?)null)
                .Set(x => x.WorkerLeaseExpiresAt, (DateTime?)null)
                .Set(x => x.WorkerLeasePhase, (string?)null),
            cancellationToken: CancellationToken.None);
        if (failed.ModifiedCount != 1) return;
        await UpdateProjectAsync(run, VideoProjectStatus.Draft);

        await PublishEventAsync(run.Id, "run.error", new { code = errorCode, message = userMessage });
    }

    private async Task CancelRunAsync(VideoGenRun run)
    {
        var cancelled = await _db.VideoGenRuns.UpdateOneAsync(
            OwnedRunFilter(run),
            Builders<VideoGenRun>.Update
                .Set(x => x.Status, VideoGenRunStatus.Cancelled)
                .Set(x => x.EndedAt, DateTime.UtcNow)
                .Set(x => x.WorkerLeaseId, (string?)null)
                .Set(x => x.WorkerLeaseExpiresAt, (DateTime?)null)
                .Set(x => x.WorkerLeasePhase, (string?)null),
            cancellationToken: CancellationToken.None);
        if (cancelled.ModifiedCount != 1) return;

        await UpdateProjectAsync(run, VideoProjectStatus.Draft);

        await PublishEventAsync(run.Id, "run.cancelled", new { });
        _logger.LogInformation("VideoGen 已取消: runId={RunId}", run.Id);
    }

    private async Task WatchRunCancellationAsync(
        string runId,
        CancellationTokenSource requestCancellation,
        CancellationToken stopWatching)
    {
        try
        {
            while (!stopWatching.IsCancellationRequested && !requestCancellation.IsCancellationRequested)
            {
                await Task.Delay(TimeSpan.FromMilliseconds(500), stopWatching);
                var cancelRequested = await _db.VideoGenRuns
                    .Find(x => x.Id == runId)
                    .Project(x => x.CancelRequested)
                    .FirstOrDefaultAsync(stopWatching);
                if (!cancelRequested) continue;
                requestCancellation.Cancel();
                return;
            }
        }
        catch (OperationCanceledException) when (stopWatching.IsCancellationRequested)
        {
            // 外部调用已结束，停止观察即可。
        }
    }

    private async Task PublishEventAsync(string runId, string eventName, object payload)
    {
        try
        {
            await _runStore.AppendEventAsync(RunKinds.VideoGen, runId, eventName, payload,
                ttl: TimeSpan.FromHours(2), ct: CancellationToken.None);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "VideoGen 事件发布失败: runId={RunId}, event={Event}", runId, eventName);
        }
    }

    // ═══════════════════════════════════════════════════════════
    // Storyboard 模式：拆分镜 → 用户编辑 → 逐镜调 OpenRouter
    // ═══════════════════════════════════════════════════════════

    private const string StoryboardScriptingPrompt =
        @"你是视频导演。请基于用户提供的文章/PRD：
1. 给整段视频取一个吸引人的中文标题（不超过 14 字）
2. 拆解为 3-8 个适合短视频生成的分镜，每个 5-10 秒，能用一句话英文 prompt 喂给视频大模型（Veo / Kling / Wan / Sora）生成

输出 JSON 对象，schema：
{
  ""title"": ""整段视频中文标题"",
  ""scenes"": [
    {
      ""topic"": ""中文小标题，6 字内"",
      ""prompt"": ""英文视频生成 prompt，描述画面内容、镜头语言、风格、光影"",
      ""duration"": 5
    }
  ]
}

要求：
- 整段视频不超过 60 秒（所有 duration 之和）
- 每段 prompt 独立可读，不依赖前后文
- 风格保持一致（用户可能在 styleDescription 里指定，要融入每段 prompt）
- 不要写解释、不要包 markdown 代码块，直接输出 JSON

只输出 JSON。";

    private async Task ProcessStoryboardScriptingAsync(VideoGenRun run, CancellationToken authorityToken)
    {
        authorityToken.ThrowIfCancellationRequested();
        if (run.CancelRequested) { await CancelRunAsync(run); return; }

        if (string.IsNullOrWhiteSpace(run.ArticleMarkdown))
        {
            await FailRunAsync(run, "EMPTY_ARTICLE", "storyboard 模式需要 articleMarkdown");
            return;
        }

        await UpdatePhaseAsync(run, "scripting", 10);
        await PublishEventAsync(run.Id, "phase.changed", new { phase = "scripting", progress = 10 });

        using var scope = _scopeFactory.CreateScope();
        var gateway = scope.ServiceProvider.GetRequiredService<ILlmGateway>();
        var ctxAccessor = scope.ServiceProvider.GetRequiredService<ILLMRequestContextAccessor>();

        using var _ = ctxAccessor.BeginScope(new LlmRequestContext(
            RequestId: Guid.NewGuid().ToString("N"),
            GroupId: null,
            SessionId: null,
            UserId: run.OwnerAdminId,
            ViewRole: null,
            DocumentChars: null,
            DocumentHash: null,
            SystemPromptRedacted: null,
            RequestType: "chat",
            AppCallerCode: AppCallerRegistry.VideoAgent.Script.Chat,
            RunId: run.Id,
            LogicalRequestId: run.Id
        ));

        var storyboardProject = await GetRunProjectAsync(run);
        var userPrompt = string.IsNullOrWhiteSpace(run.StyleDescription)
            ? run.ArticleMarkdown
            : $"风格要求：{run.StyleDescription}\n\n文章内容：\n{run.ArticleMarkdown}";
        userPrompt = AppendAssetConstraints(userPrompt, storyboardProject);

        var requestBody = new System.Text.Json.Nodes.JsonObject
        {
            ["messages"] = new System.Text.Json.Nodes.JsonArray
            {
                new System.Text.Json.Nodes.JsonObject { ["role"] = "system", ["content"] = StoryboardScriptingPrompt },
                new System.Text.Json.Nodes.JsonObject { ["role"] = "user", ["content"] = userPrompt },
            },
            ["temperature"] = 0.7,
        };

        var resolution = await gateway.ResolveModelAsync(
            AppCallerRegistry.VideoAgent.Script.Chat, ModelTypes.Chat, null, ct: authorityToken);
        if (!resolution.Success)
        {
            await FailRunAsync(run, "MODEL_RESOLVE_FAILED", $"模型调度失败: {resolution.ErrorMessage}");
            return;
        }

        using var requestCancellation = CancellationTokenSource.CreateLinkedTokenSource(authorityToken);
        using var stopWatchingCancellation = new CancellationTokenSource();
        var cancellationWatcher = WatchRunCancellationAsync(
            run.Id,
            requestCancellation,
            stopWatchingCancellation.Token);
        GatewayRawResponse resp;
        try
        {
            resp = await gateway.SendRawWithResolutionAsync(new GatewayRawRequest
            {
                AppCallerCode = AppCallerRegistry.VideoAgent.Script.Chat,
                ModelType = ModelTypes.Chat,
                RequestBody = requestBody,
                TimeoutSeconds = 120,
            }, resolution, requestCancellation.Token);
        }
        catch (OperationCanceledException) when (authorityToken.IsCancellationRequested)
        {
            return;
        }
        catch (OperationCanceledException) when (requestCancellation.IsCancellationRequested)
        {
            await CancelRunAsync(run);
            return;
        }
        finally
        {
            await stopWatchingCancellation.CancelAsync();
            await cancellationWatcher;
        }

        var freshAfterScripting = await _db.VideoGenRuns
            .Find(x => x.Id == run.Id)
            .Project(x => x.CancelRequested)
            .FirstOrDefaultAsync(CancellationToken.None);
        if (freshAfterScripting)
        {
            await CancelRunAsync(run);
            return;
        }

        if (!resp.Success || string.IsNullOrWhiteSpace(resp.Content))
        {
            await FailRunAsync(run, "LLM_FAILED", $"拆分镜 LLM 调用失败: {resp.ErrorCode}");
            return;
        }

        // 解析 LLM 返回（OpenAI chat completions 格式）
        var llmText = ExtractAssistantText(resp.Content);
        var (aiTitle, scenes) = ParseScenesFromLlmResponse(llmText, run);
        if (scenes.Count == 0)
        {
            await FailRunAsync(run, "PARSE_FAILED", "LLM 返回无法解析为分镜数组");
            return;
        }

        var totalDuration = scenes.Sum(s => s.Duration ?? run.DirectDuration ?? 5);

        // 构建 update：scenes / 状态 + 仅当 LLM 给出 title 且当前 ArticleTitle 是默认截断（来自首句）时覆盖
        var update = Builders<VideoGenRun>.Update
            .Set(x => x.Scenes, scenes)
            .Set(x => x.TotalDurationSeconds, totalDuration)
            .Set(x => x.Status, VideoGenRunStatus.Editing)
            .Set(x => x.CurrentPhase, "editing")
            .Set(x => x.PhaseProgress, 100)
            .Set(x => x.WorkerLeaseId, (string?)null)
            .Set(x => x.WorkerLeaseExpiresAt, (DateTime?)null)
            .Set(x => x.WorkerLeasePhase, (string?)null);

        if (!string.IsNullOrWhiteSpace(aiTitle))
        {
            var cleanTitle = aiTitle!.Trim();
            if (cleanTitle.Length > 60) cleanTitle = cleanTitle[..60];
            update = update.Set(x => x.ArticleTitle, cleanTitle);
        }

        var persisted = await _db.VideoGenRuns.UpdateOneAsync(
            OwnedRunFilter(run)
            & Builders<VideoGenRun>.Filter.Eq(x => x.Status, VideoGenRunStatus.Scripting)
            & Builders<VideoGenRun>.Filter.Eq(x => x.CancelRequested, false),
            update,
            cancellationToken: CancellationToken.None);
        if (persisted.ModifiedCount != 1) return;

        await SyncProjectStoryboardAsync(run, scenes, aiTitle);

        await PublishEventAsync(run.Id, "scenes.generated",
            new { count = scenes.Count, totalDuration });
        _logger.LogInformation("VideoGen storyboard 拆分镜完成: runId={RunId}, scenes={Count}", run.Id, scenes.Count);
    }

    private static string ExtractAssistantText(string apiResponseJson)
    {
        try
        {
            var doc = System.Text.Json.Nodes.JsonNode.Parse(apiResponseJson)?.AsObject();
            var content = doc?["choices"]?[0]?["message"]?["content"]?.GetValue<string>();
            return content ?? string.Empty;
        }
        catch { return apiResponseJson; }
    }

    /// <summary>
    /// 解析 LLM 返回，支持两种格式：
    ///   1) 包装对象：{ "title": "...", "scenes": [...] }
    ///   2) 兼容旧格式：直接的分镜数组 [...]
    /// 返回 (title, scenes)；title 为 null 时表示 LLM 没给。
    /// </summary>
    private static (string? Title, List<VideoGenScene> Scenes) ParseScenesFromLlmResponse(string text, VideoGenRun run)
    {
        var trimmed = text.Trim();
        if (string.IsNullOrEmpty(trimmed)) return (null, new List<VideoGenScene>());

        // 优先尝试包装对象（找最外层 { ... }）
        var objStart = trimmed.IndexOf('{');
        var objEnd = trimmed.LastIndexOf('}');
        if (objStart >= 0 && objEnd > objStart)
        {
            try
            {
                var obj = System.Text.Json.Nodes.JsonNode.Parse(trimmed[objStart..(objEnd + 1)])?.AsObject();
                var arr = obj?["scenes"]?.AsArray();
                if (arr != null)
                {
                    var title = obj?["title"]?.GetValue<string>();
                    return (title, BuildScenes(arr, run));
                }
            }
            catch { /* 继续尝试数组形式 */ }
        }

        // 兼容旧格式：纯数组
        var arrStart = trimmed.IndexOf('[');
        var arrEnd = trimmed.LastIndexOf(']');
        if (arrStart < 0 || arrEnd <= arrStart) return (null, new List<VideoGenScene>());
        try
        {
            var arr = System.Text.Json.Nodes.JsonNode.Parse(trimmed[arrStart..(arrEnd + 1)])?.AsArray();
            return (null, arr == null ? new List<VideoGenScene>() : BuildScenes(arr, run));
        }
        catch
        {
            return (null, new List<VideoGenScene>());
        }
    }

    private static List<VideoGenScene> BuildScenes(System.Text.Json.Nodes.JsonArray arr, VideoGenRun run)
    {
        var result = new List<VideoGenScene>();
        for (int i = 0; i < arr.Count; i++)
        {
            var item = arr[i]?.AsObject();
            if (item == null) continue;

            var topic = item["topic"]?.GetValue<string>() ?? $"分镜 {i + 1}";
            var prompt = item["prompt"]?.GetValue<string>() ?? string.Empty;
            int? duration = null;
            if (item["duration"]?.GetValue<int>() is int d && d > 0) duration = d;

            if (string.IsNullOrWhiteSpace(prompt)) continue;

            result.Add(new VideoGenScene
            {
                Index = i,
                Topic = topic.Trim(),
                Prompt = prompt.Trim(),
                Status = SceneItemStatus.Draft,
                Duration = duration,
                Model = run.DirectVideoModel,
                AspectRatio = run.DirectAspectRatio,
                Resolution = run.DirectResolution,
            });
        }
        return result;
    }

    internal sealed record ClaimedSceneRender(
        VideoGenRun Run,
        int SceneIndex,
        string ClaimId,
        bool ResumeExistingJob);

    /// <summary>
    /// 原子领取一个待提交的单镜任务。Submitting 与 SubmittingClaimed 都是旧 worker 不识别的隔离状态，
    /// 状态迁移保证共享数据库上的多个 worker 只有一个获胜。
    /// </summary>
    internal async Task<ClaimedSceneRender?> ClaimEditingSceneRenderAsync(CancellationToken ct)
    {
        var fb = Builders<VideoGenRun>.Filter;
        var sceneFilter = Builders<VideoGenScene>.Filter;
        var now = DateTime.UtcNow;
        var expiredLease = sceneFilter.Eq(s => s.RenderLeaseExpiresAt, null)
                           | sceneFilter.Lte(s => s.RenderLeaseExpiresAt, now);
        var resumableFilter = fb.Eq(x => x.Status, VideoGenRunStatus.Editing)
                              & fb.Eq(x => x.DeploymentSlug, DeploymentScope.Current)
                              & fb.ElemMatch(x => x.Scenes,
                                  sceneFilter.In(s => s.Status, [SceneItemStatus.Submitting, SceneItemStatus.Polling])
                                  & sceneFilter.Regex(s => s.JobId, new BsonRegularExpression("^(?!claim:).+"))
                                  & expiredLease);
        var resumable = await _db.VideoGenRuns.Find(resumableFilter).FirstOrDefaultAsync(ct);
        if (resumable != null)
        {
            var resumeIdx = resumable.Scenes.FindIndex(scene =>
                scene.Status is SceneItemStatus.Submitting or SceneItemStatus.Polling
                && !string.IsNullOrWhiteSpace(scene.JobId)
                && !scene.JobId.StartsWith("claim:", StringComparison.Ordinal)
                && (!scene.RenderLeaseExpiresAt.HasValue || scene.RenderLeaseExpiresAt <= now));
            if (resumeIdx >= 0)
            {
                var jobId = resumable.Scenes[resumeIdx].JobId!;
                var resumableStatus = resumable.Scenes[resumeIdx].Status;
                var leaseId = $"lease:{Guid.NewGuid():N}";
                var exactResumeFilter = fb.Eq(x => x.Id, resumable.Id)
                                      & fb.Eq(x => x.DeploymentSlug, DeploymentScope.Current)
                                      & fb.Eq(x => x.Status, VideoGenRunStatus.Editing)
                                      & fb.Eq($"Scenes.{resumeIdx}.Status", resumableStatus)
                                      & fb.Eq($"Scenes.{resumeIdx}.JobId", jobId)
                                      & (fb.Eq<DateTime?>($"Scenes.{resumeIdx}.RenderLeaseExpiresAt", null)
                                         | fb.Lte<DateTime?>($"Scenes.{resumeIdx}.RenderLeaseExpiresAt", now));
                var resumedRun = await _db.VideoGenRuns.FindOneAndUpdateAsync(
                    exactResumeFilter,
                    Builders<VideoGenRun>.Update
                        .Set($"Scenes.{resumeIdx}.Status", SceneItemStatus.PollingClaimed)
                        .Set($"Scenes.{resumeIdx}.RenderLeaseId", leaseId)
                        .Set($"Scenes.{resumeIdx}.RenderLeaseExpiresAt", now + SceneRenderLease),
                    new FindOneAndUpdateOptions<VideoGenRun> { ReturnDocument = ReturnDocument.After },
                    ct);
                if (resumedRun != null)
                    return new ClaimedSceneRender(resumedRun, resumeIdx, leaseId, true);
            }
        }

        var filter = fb.Eq(x => x.Status, VideoGenRunStatus.Editing)
                    & fb.Eq(x => x.DeploymentSlug, DeploymentScope.Current)
                    & fb.ElemMatch(x => x.Scenes,
                        sceneFilter.Eq(s => s.Status, SceneItemStatus.Submitting)
                        & sceneFilter.Eq(s => s.JobId, null));
        var candidate = await _db.VideoGenRuns.Find(filter).FirstOrDefaultAsync(ct);
        if (candidate == null) return null;

        var sceneIdx = candidate.Scenes.FindIndex(scene =>
            scene.Status == SceneItemStatus.Submitting && string.IsNullOrWhiteSpace(scene.JobId));
        if (sceneIdx < 0) return null;

        var claimId = $"claim:{Guid.NewGuid():N}";
        var exactClaimFilter = fb.Eq(x => x.Id, candidate.Id)
                               & fb.Eq(x => x.DeploymentSlug, DeploymentScope.Current)
                               & fb.Eq(x => x.Status, VideoGenRunStatus.Editing)
                               & fb.Eq($"Scenes.{sceneIdx}.Status", SceneItemStatus.Submitting)
                               & fb.Eq<string?>($"Scenes.{sceneIdx}.JobId", null);
        var claimedRun = await _db.VideoGenRuns.FindOneAndUpdateAsync(
            exactClaimFilter,
            Builders<VideoGenRun>.Update
                .Set($"Scenes.{sceneIdx}.Status", SceneItemStatus.SubmittingClaimed)
                .Set($"Scenes.{sceneIdx}.JobId", claimId)
                .Set($"Scenes.{sceneIdx}.SubmissionStartedAt", now)
                .Set($"Scenes.{sceneIdx}.RenderLeaseId", claimId)
                .Set($"Scenes.{sceneIdx}.RenderLeaseExpiresAt", now + SceneRenderLease),
            new FindOneAndUpdateOptions<VideoGenRun> { ReturnDocument = ReturnDocument.After },
            ct);

        return claimedRun == null ? null : new ClaimedSceneRender(claimedRun, sceneIdx, claimId, false);
    }

    internal async Task<bool> RecoverExpiredSceneRenderLeaseAsync(CancellationToken ct)
    {
        var fb = Builders<VideoGenRun>.Filter;
        var now = DateTime.UtcNow;
        var candidate = await _db.VideoGenRuns.Find(
                fb.Eq(x => x.Status, VideoGenRunStatus.Editing)
                & fb.Eq(x => x.DeploymentSlug, DeploymentScope.Current)
                & fb.ElemMatch(x => x.Scenes,
                    Builders<VideoGenScene>.Filter.Eq(s => s.Status, SceneItemStatus.PollingClaimed)
                    & Builders<VideoGenScene>.Filter.Regex(s => s.JobId, new BsonRegularExpression(".+"))
                    & Builders<VideoGenScene>.Filter.Lte(s => s.RenderLeaseExpiresAt, now)))
            .FirstOrDefaultAsync(ct);
        if (candidate == null) return false;

        var sceneIdx = candidate.Scenes.FindIndex(scene =>
            scene.Status == SceneItemStatus.PollingClaimed
            && !string.IsNullOrWhiteSpace(scene.JobId)
            && scene.RenderLeaseExpiresAt <= now);
        if (sceneIdx < 0) return false;

        var jobId = candidate.Scenes[sceneIdx].JobId!;
        var leaseId = candidate.Scenes[sceneIdx].RenderLeaseId;
        var filter = fb.Eq(x => x.Id, candidate.Id)
                     & fb.Eq(x => x.DeploymentSlug, DeploymentScope.Current)
                     & fb.Eq($"Scenes.{sceneIdx}.Status", SceneItemStatus.PollingClaimed)
                     & fb.Eq($"Scenes.{sceneIdx}.JobId", jobId)
                     & fb.Lte<DateTime?>($"Scenes.{sceneIdx}.RenderLeaseExpiresAt", now);
        if (!string.IsNullOrWhiteSpace(leaseId))
            filter &= fb.Eq($"Scenes.{sceneIdx}.RenderLeaseId", leaseId);

        var recovered = await _db.VideoGenRuns.UpdateOneAsync(
            filter,
            Builders<VideoGenRun>.Update
                .Set($"Scenes.{sceneIdx}.Status", SceneItemStatus.Polling)
                .Set($"Scenes.{sceneIdx}.RenderLeaseId", (string?)null)
                .Set($"Scenes.{sceneIdx}.RenderLeaseExpiresAt", (DateTime?)null),
            cancellationToken: ct);
        return recovered.ModifiedCount == 1;
    }

    internal async Task<bool> RecoverStaleSceneClaimAsync(CancellationToken ct)
    {
        var fb = Builders<VideoGenRun>.Filter;
        var sceneFb = Builders<VideoGenScene>.Filter;
        var now = DateTime.UtcNow;
        var threshold = DateTime.UtcNow - SceneClaimTimeout;
        var expiredLease = sceneFb.Ne(s => s.RenderLeaseId, null)
                           & sceneFb.Lte(s => s.RenderLeaseExpiresAt, now);
        var legacyClaim = DateTime.UtcNow >= LegacyTakeoverEnabledAt
            ? sceneFb.Eq(s => s.RenderLeaseId, null)
              & sceneFb.Lte(s => s.SubmissionStartedAt, threshold)
            : sceneFb.Empty & sceneFb.Exists(s => s.Index, false);
        var candidate = await _db.VideoGenRuns.Find(
                fb.Eq(x => x.Status, VideoGenRunStatus.Editing)
                & fb.Eq(x => x.DeploymentSlug, DeploymentScope.Current)
                & fb.ElemMatch(x => x.Scenes,
                    sceneFb.Eq(s => s.Status, SceneItemStatus.SubmittingClaimed)
                    & sceneFb.Regex(s => s.JobId, new BsonRegularExpression("^claim:"))
                    & (expiredLease | legacyClaim)))
            .FirstOrDefaultAsync(ct);
        if (candidate == null) return false;

        var sceneIdx = candidate.Scenes.FindIndex(scene =>
            scene.Status == SceneItemStatus.SubmittingClaimed
            && scene.JobId?.StartsWith("claim:", StringComparison.Ordinal) == true
            && ((!string.IsNullOrWhiteSpace(scene.RenderLeaseId)
                 && scene.RenderLeaseExpiresAt <= now)
                || (string.IsNullOrWhiteSpace(scene.RenderLeaseId)
                    && DateTime.UtcNow >= LegacyTakeoverEnabledAt
                    && scene.SubmissionStartedAt <= threshold)));
        if (sceneIdx < 0) return false;

        var claimId = candidate.Scenes[sceneIdx].JobId!;
        var renderLeaseId = candidate.Scenes[sceneIdx].RenderLeaseId;
        var message = "生成提交进程已中断。为避免重复扣费，系统没有自动重新提交；请确认后手动重试。";
        var recoveryFilter = fb.Eq(x => x.Id, candidate.Id)
            & fb.Eq(x => x.DeploymentSlug, DeploymentScope.Current)
            & fb.Eq($"Scenes.{sceneIdx}.Status", SceneItemStatus.SubmittingClaimed)
            & fb.Eq($"Scenes.{sceneIdx}.JobId", claimId);
        recoveryFilter = !string.IsNullOrWhiteSpace(renderLeaseId)
            ? recoveryFilter
              & fb.Eq($"Scenes.{sceneIdx}.RenderLeaseId", renderLeaseId)
              & fb.Lte<DateTime?>($"Scenes.{sceneIdx}.RenderLeaseExpiresAt", now)
            : recoveryFilter
              & fb.Eq<string?>($"Scenes.{sceneIdx}.RenderLeaseId", null)
              & fb.Lte<DateTime?>($"Scenes.{sceneIdx}.SubmissionStartedAt", threshold);
        var updated = await _db.VideoGenRuns.UpdateOneAsync(
            recoveryFilter,
            Builders<VideoGenRun>.Update
                .Set($"Scenes.{sceneIdx}.Status", SceneItemStatus.Error)
                .Set($"Scenes.{sceneIdx}.ErrorMessage", message)
                .Set($"Scenes.{sceneIdx}.JobId", (string?)null)
                .Set($"Scenes.{sceneIdx}.SubmissionStartedAt", (DateTime?)null)
                .Set($"Scenes.{sceneIdx}.RenderLeaseId", (string?)null)
                .Set($"Scenes.{sceneIdx}.RenderLeaseExpiresAt", (DateTime?)null),
            cancellationToken: ct);
        if (updated.ModifiedCount != 1) return false;
        await SyncProjectSceneActivityAsync(candidate.Id);
        await PublishEventAsync(candidate.Id, "scene.render.error", new { sceneIndex = sceneIdx, message });
        return true;
    }

    /// <summary>原子领取 Editing 状态下的提示词重生成任务，并记录可续租的持有者身份。</summary>
    internal async Task<VideoGenRun?> ClaimEditingRunWithSceneGeneratingAsync(CancellationToken ct)
    {
        var fb = Builders<VideoGenRun>.Filter;
        var now = DateTime.UtcNow;
        var availableLease = fb.Eq(x => x.WorkerLeaseId, null)
                             | fb.Lte(x => x.WorkerLeaseExpiresAt, now);
        var filter = fb.Eq(x => x.Status, VideoGenRunStatus.Editing)
                     & fb.Eq(x => x.DeploymentSlug, DeploymentScope.Current)
                     & availableLease
                     & fb.ElemMatch(x => x.Scenes,
                         Builders<VideoGenScene>.Filter.Eq(s => s.Status, SceneItemStatus.Generating));
        var candidate = await _db.VideoGenRuns.Find(filter).FirstOrDefaultAsync(ct);
        if (candidate == null) return null;
        var sceneIdx = candidate.Scenes.FindIndex(scene => scene.Status == SceneItemStatus.Generating);
        if (sceneIdx < 0) return null;
        var leaseId = $"prompt:{Guid.NewGuid():N}";
        return await _db.VideoGenRuns.FindOneAndUpdateAsync(
            filter
            & fb.Eq(x => x.Id, candidate.Id)
            & fb.Eq($"Scenes.{sceneIdx}.Status", SceneItemStatus.Generating),
            Builders<VideoGenRun>.Update
                .Set(x => x.WorkerLeaseId, leaseId)
                .Set(x => x.WorkerLeaseExpiresAt, now + WorkerLeaseDuration)
                .Set(x => x.WorkerLeasePhase, $"scene-prompt:{sceneIdx}"),
            new FindOneAndUpdateOptions<VideoGenRun> { ReturnDocument = ReturnDocument.After },
            ct);
    }

    /// <summary>处理单镜渲染：调 OpenRouter，下载 mp4 到 COS，写回 Scene.VideoUrl</summary>
    internal async Task ProcessSceneRenderAsync(
        VideoGenRun run,
        int sceneIdx,
        string claimId,
        bool resumeExistingJob)
    {
        var scene = run.Scenes[sceneIdx];

        if (await IsRunCancellationRequestedAsync(run.Id))
        {
            await CancelRunAsync(run);
            return;
        }

        // 按 run.AppKey 选 caller：视觉分镜台(visual-agent)创建的 run 归属 visual-agent 视频配额/模型池与日志归因，
        // 不再一律记到 video-agent（Codex review，配合前端改走 /api/visual-agent/video-gen）。
        var appCallerCode = run.AppKey == "visual-agent"
            ? AppCallerRegistry.VisualAgent.VideoGen.Generate
            : AppCallerRegistry.VideoAgent.VideoGen.Generate;
        _logger.LogInformation("VideoGen 单镜渲染开始: runId={RunId}, scene={Idx}, prompt={Len}字",
            run.Id, sceneIdx, scene.Prompt.Length);
        await PublishEventAsync(run.Id, "scene.render.start", new { sceneIndex = sceneIdx });

        using var scope = _scopeFactory.CreateScope();
        var client = scope.ServiceProvider.GetRequiredService<IOpenRouterVideoClient>();
        var ctxAccessor = scope.ServiceProvider.GetRequiredService<ILLMRequestContextAccessor>();
        var expectedJobId = resumeExistingJob ? scene.JobId! : claimId;
        var sceneLogicalRequestId = $"{run.Id}_scene_{sceneIdx}";
        using var sceneContextScope = ctxAccessor.BeginScope(new LlmRequestContext(
            RequestId: sceneLogicalRequestId,
            GroupId: null,
            SessionId: run.Id,
            UserId: run.OwnerAdminId,
            ViewRole: null,
            DocumentChars: null,
            DocumentHash: null,
            SystemPromptRedacted: "[VIDEO_GEN_SCENE]",
            RequestType: ModelTypes.VideoGen,
            AppCallerCode: appCallerCode,
            RunId: run.Id,
            LogicalRequestId: sceneLogicalRequestId));

        try
        {
            var sceneModel = scene.Model ?? run.DirectVideoModel;
            var actualModel = sceneModel;
            var actualDuration = scene.Duration ?? run.DirectDuration;
            string submittedJobId;
            if (!resumeExistingJob)
            {
                var sceneProject = await GetRunProjectAsync(run);
                var submitReq = new OpenRouterVideoSubmitRequest
                {
                    AppCallerCode = appCallerCode,
                    Model = sceneModel,
                    Prompt = AppendAssetConstraints(scene.Prompt, sceneProject),
                    FirstFrameImageUrl = scene.FirstFrameUrl,
                    LastFrameImageUrl = scene.LastFrameUrl,
                    ReferenceImageUrls = await SupportsReferenceAssetsAsync(sceneModel)
                        ? GetReferenceImageUrls(sceneProject)
                        : [],
                    AspectRatio = scene.AspectRatio ?? run.DirectAspectRatio,
                    Resolution = scene.Resolution ?? run.DirectResolution,
                    DurationSeconds = scene.Duration ?? run.DirectDuration,
                    GenerateAudio = run.GenerateAudio,
                    UserId = run.OwnerAdminId,
                    RequestId = sceneLogicalRequestId,
                };

                OpenRouterVideoSubmitResult? submitResult = null;
                var retainedSubmissionLease = await ProcessWithSceneSubmissionLeaseHeartbeatAsync(
                    run.Id,
                    sceneIdx,
                    claimId,
                    async authorityToken =>
                    {
                        submitResult = await client.SubmitAsync(submitReq, authorityToken);
                    });
                if (!retainedSubmissionLease || submitResult == null) return;
                if (!submitResult.Success || string.IsNullOrWhiteSpace(submitResult.JobId))
                {
                    await MarkSceneErrorAsync(
                        run.Id,
                        sceneIdx,
                        submitResult.ErrorMessage ?? "OpenRouter 提交失败",
                        claimId,
                        claimId);
                    return;
                }

                if (await IsRunCancellationRequestedAsync(run.Id))
                {
                    await CancelRunAsync(run);
                    return;
                }

                var submitted = await _db.VideoGenRuns.UpdateOneAsync(
                    Builders<VideoGenRun>.Filter.Eq(x => x.Id, run.Id)
                    & Builders<VideoGenRun>.Filter.Eq(x => x.DeploymentSlug, DeploymentScope.Current)
                    & Builders<VideoGenRun>.Filter.Eq($"Scenes.{sceneIdx}.Status", SceneItemStatus.SubmittingClaimed)
                    & Builders<VideoGenRun>.Filter.Eq($"Scenes.{sceneIdx}.JobId", claimId)
                    & Builders<VideoGenRun>.Filter.Eq($"Scenes.{sceneIdx}.RenderLeaseId", claimId),
                    Builders<VideoGenRun>.Update
                        .Set($"Scenes.{sceneIdx}.Status", SceneItemStatus.PollingClaimed)
                        .Set($"Scenes.{sceneIdx}.JobId", submitResult.JobId)
                        .Set($"Scenes.{sceneIdx}.Model", submitResult.ActualModel ?? scene.Model ?? run.DirectVideoModel)
                        .Set($"Scenes.{sceneIdx}.OfferingId", submitResult.OfferingId)
                        .Set($"Scenes.{sceneIdx}.Duration", submitResult.ActualDurationSeconds ?? scene.Duration ?? run.DirectDuration)
                        .Set($"Scenes.{sceneIdx}.RenderLeaseId", claimId)
                        .Set($"Scenes.{sceneIdx}.RenderLeaseExpiresAt", DateTime.UtcNow + SceneRenderLease),
                    cancellationToken: CancellationToken.None);
                if (submitted.ModifiedCount != 1) return;
                submittedJobId = submitResult.JobId;
                actualModel = submitResult.ActualModel ?? sceneModel;
                scene.OfferingId = submitResult.OfferingId;
                actualDuration = submitResult.ActualDurationSeconds ?? actualDuration;
                expectedJobId = submittedJobId;
            }
            else
            {
                submittedJobId = scene.JobId!;
            }
            await UpdateProjectAsync(run, VideoProjectStatus.Rendering);

            // 轮询
            const int pollIntervalSec = 6;
            const int maxWaitMinutes = 10;
            var renderStartedAt = scene.SubmissionStartedAt ?? DateTime.UtcNow;
            var deadline = renderStartedAt.AddMinutes(maxWaitMinutes);

            while (DateTime.UtcNow < deadline)
            {
                if (await IsRunCancellationRequestedAsync(run.Id))
                {
                    await CancelRunAsync(run);
                    return;
                }
                if (!await RenewSceneRenderLeaseAsync(run.Id, sceneIdx, submittedJobId, claimId)) return;

                var status = string.IsNullOrWhiteSpace(scene.OfferingId)
                    ? await client.GetStatusAsync(
                        appCallerCode,
                        submittedJobId,
                        actualModel,
                        CancellationToken.None)
                    : await client.GetStatusForOfferingAsync(
                        appCallerCode,
                        submittedJobId,
                        actualModel,
                        scene.OfferingId,
                        CancellationToken.None);
                if (!await RenewSceneRenderLeaseAsync(run.Id, sceneIdx, submittedJobId, claimId)) return;

                if (await IsRunCancellationRequestedAsync(run.Id))
                {
                    await CancelRunAsync(run);
                    return;
                }

                if (status.IsCompleted && !string.IsNullOrWhiteSpace(status.VideoUrl))
                {
                    // 下载到 COS
                    var dl = string.IsNullOrWhiteSpace(scene.OfferingId)
                        ? await client.DownloadVideoBytesAsync(
                            appCallerCode,
                            submittedJobId,
                            0,
                            actualModel,
                            CancellationToken.None)
                        : await client.DownloadVideoBytesForOfferingAsync(
                            appCallerCode,
                            submittedJobId,
                            0,
                            actualModel,
                            scene.OfferingId,
                            CancellationToken.None);
                    if (!dl.Success || dl.Bytes == null)
                    {
                        await MarkSceneErrorAsync(
                            run.Id,
                            sceneIdx,
                            "下载视频失败: " + dl.ErrorMessage,
                            submittedJobId,
                            claimId);
                        return;
                    }
                    var playbackBytes = await VideoFastStartOptimizer.OptimizeAsync(dl.Bytes, _logger);
                    var expectedSha256 = Convert.ToHexString(SHA256.HashData(playbackBytes)).ToLowerInvariant();
                    await using var assetLease = await VideoAssetMutationLease.AcquireAsync(
                        _db,
                        $"generated-video:{expectedSha256}",
                        CancellationToken.None);
                    RegistryAssetStorage.OverrideNextScope("generated");
                    var stored = await _assetStorage.SaveAsync(playbackBytes, dl.ContentType ?? "video/mp4",
                        CancellationToken.None,
                        domain: AppDomainPaths.DomainVideoAgent, type: AppDomainPaths.TypeVideo);
                    if (!string.Equals(stored.Sha256, expectedSha256, StringComparison.OrdinalIgnoreCase))
                        throw new InvalidOperationException("视频资产摘要校验失败");

                    var version = new VideoGenSceneVersion
                    {
                        VideoUrl = stored.Url,
                        AssetSha256 = stored.Sha256,
                        JobId = submittedJobId,
                        Model = actualModel,
                        Prompt = scene.Prompt,
                        Duration = actualDuration,
                        FirstFrameUrl = scene.FirstFrameUrl,
                        LastFrameUrl = scene.LastFrameUrl,
                        Cost = status.Cost,
                    };

                    if (!await TryCompleteSceneRenderAsync(
                            run,
                            sceneIdx,
                            submittedJobId,
                            claimId,
                            stored.Url,
                            version,
                            status.Cost)) return;

                    await SyncProjectSceneActivityAsync(run.Id);

                    await PublishEventAsync(run.Id, "scene.render.done",
                        new { sceneIndex = sceneIdx, videoUrl = stored.Url, cost = status.Cost });

                    _logger.LogInformation("VideoGen 单镜完成: runId={RunId}, scene={Idx}, url={Url}",
                        run.Id, sceneIdx, stored.Url);
                    return;
                }

                if (status.IsFailed)
                {
                    await MarkSceneErrorAsync(run.Id, sceneIdx,
                        status.ErrorMessage ?? $"OpenRouter 状态 = {status.Status}",
                        submittedJobId,
                        claimId);
                    return;
                }

                await Task.Delay(TimeSpan.FromSeconds(pollIntervalSec), CancellationToken.None);
            }

            await MarkSceneErrorAsync(
                run.Id,
                sceneIdx,
                $"单镜生成超过 {maxWaitMinutes} 分钟未完成",
                submittedJobId,
                claimId);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "VideoGen 单镜渲染异常: runId={RunId}, scene={Idx}", run.Id, sceneIdx);
            await MarkSceneErrorAsync(run.Id, sceneIdx, ex.Message, expectedJobId, claimId);
        }
    }

    internal async Task<bool> TryCompleteSceneRenderAsync(
        VideoGenRun run,
        int sceneIdx,
        string submittedJobId,
        string claimId,
        string storedUrl,
        VideoGenSceneVersion version,
        double? cost)
    {
        var fb = Builders<VideoGenRun>.Filter;
        UpdateResult completed;
        try
        {
            completed = await _db.VideoGenRuns.UpdateOneAsync(
                fb.Eq(x => x.Id, run.Id)
                & fb.Eq(x => x.DeploymentSlug, DeploymentScope.Current)
                & fb.Eq(x => x.Status, VideoGenRunStatus.Editing)
                & fb.Eq(x => x.CancelRequested, false)
                & fb.Eq($"Scenes.{sceneIdx}.Status", SceneItemStatus.PollingClaimed)
                & fb.Eq($"Scenes.{sceneIdx}.JobId", submittedJobId)
                & fb.Eq($"Scenes.{sceneIdx}.RenderLeaseId", claimId),
                Builders<VideoGenRun>.Update
                    .Set($"Scenes.{sceneIdx}.Status", SceneItemStatus.Done)
                    .Set($"Scenes.{sceneIdx}.VideoUrl", storedUrl)
                    .Set($"Scenes.{sceneIdx}.ActiveVersionId", version.Id)
                    .Set($"Scenes.{sceneIdx}.JobId", submittedJobId)
                    .Set($"Scenes.{sceneIdx}.Model", version.Model)
                    .Set($"Scenes.{sceneIdx}.Cost", cost)
                    .Set($"Scenes.{sceneIdx}.SubmissionStartedAt", (DateTime?)null)
                    .Set($"Scenes.{sceneIdx}.RenderLeaseId", (string?)null)
                    .Set($"Scenes.{sceneIdx}.RenderLeaseExpiresAt", (DateTime?)null)
                    .Push($"Scenes.{sceneIdx}.Versions", version),
                cancellationToken: CancellationToken.None);
        }
        catch
        {
            if (!string.IsNullOrWhiteSpace(version.AssetSha256))
                await DeleteStoredVideoIfUnreferencedAsync(version.AssetSha256, storedUrl);
            throw;
        }
        if (completed.ModifiedCount == 1) return true;

        // 下载和存储期间可能收到取消请求。最终写回必须由同一条原子过滤器兜住，
        // 失去写入资格后立即把 run 收敛到 Cancelled，不能留下“取消待处理 + 分镜已完成”。
        if (!string.IsNullOrWhiteSpace(version.AssetSha256))
            await DeleteStoredVideoIfUnreferencedAsync(version.AssetSha256, storedUrl);
        if (await IsRunCancellationRequestedAsync(run.Id))
            await CancelRunAsync(run);
        return false;
    }

    private async Task<bool> RenewSceneRenderLeaseAsync(
        string runId,
        int sceneIdx,
        string jobId,
        string leaseId)
    {
        var renewed = await _db.VideoGenRuns.UpdateOneAsync(
            Builders<VideoGenRun>.Filter.Eq(x => x.Id, runId)
            & Builders<VideoGenRun>.Filter.Eq(x => x.DeploymentSlug, DeploymentScope.Current)
            & Builders<VideoGenRun>.Filter.Eq($"Scenes.{sceneIdx}.Status", SceneItemStatus.PollingClaimed)
            & Builders<VideoGenRun>.Filter.Eq($"Scenes.{sceneIdx}.JobId", jobId)
            & Builders<VideoGenRun>.Filter.Eq($"Scenes.{sceneIdx}.RenderLeaseId", leaseId),
            Builders<VideoGenRun>.Update.Set(
                $"Scenes.{sceneIdx}.RenderLeaseExpiresAt",
                DateTime.UtcNow + SceneRenderLease),
            cancellationToken: CancellationToken.None);
        // 同一毫秒内两次续租可能写入相同截止时间；匹配到所有权即有效，不能把无值变化当成失租。
        return renewed.MatchedCount == 1;
    }

    internal async Task<bool> ProcessWithSceneSubmissionLeaseHeartbeatAsync(
        string runId,
        int sceneIdx,
        string claimId,
        Func<CancellationToken, Task> action)
    {
        if (!await RenewSceneSubmissionLeaseAsync(runId, sceneIdx, claimId)) return false;

        using var stopHeartbeat = new CancellationTokenSource();
        using var authorityLost = new CancellationTokenSource();
        var heartbeat = RenewSceneSubmissionLeaseUntilStoppedAsync(
            runId,
            sceneIdx,
            claimId,
            authorityLost,
            stopHeartbeat.Token);
        try
        {
            await action(authorityLost.Token);
            return !authorityLost.IsCancellationRequested;
        }
        catch (OperationCanceledException) when (authorityLost.IsCancellationRequested)
        {
            _logger.LogInformation(
                "VideoGen 分镜提交 lease 已失效，旧持有者停止执行: runId={RunId}, scene={SceneIndex}",
                runId,
                sceneIdx);
            return false;
        }
        finally
        {
            stopHeartbeat.Cancel();
            await heartbeat;
        }
    }

    private async Task RenewSceneSubmissionLeaseUntilStoppedAsync(
        string runId,
        int sceneIdx,
        string claimId,
        CancellationTokenSource authorityLost,
        CancellationToken stopToken)
    {
        var authorityDeadline = DateTime.UtcNow + SceneRenderLease;
        while (!stopToken.IsCancellationRequested)
        {
            try
            {
                await Task.Delay(WorkerLeaseHeartbeatInterval, stopToken);
                if (!await RenewSceneSubmissionLeaseAsync(runId, sceneIdx, claimId))
                {
                    await authorityLost.CancelAsync();
                    return;
                }
                authorityDeadline = DateTime.UtcNow + SceneRenderLease;
            }
            catch (OperationCanceledException) when (stopToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(
                    ex,
                    "VideoGen 分镜提交 lease 续租失败，等待下一轮重试: runId={RunId}, scene={SceneIndex}",
                    runId,
                    sceneIdx);
                if (DateTime.UtcNow >= authorityDeadline)
                {
                    await authorityLost.CancelAsync();
                    return;
                }
            }
        }
    }

    private async Task<bool> RenewSceneSubmissionLeaseAsync(
        string runId,
        int sceneIdx,
        string claimId)
    {
        var renewed = await _db.VideoGenRuns.UpdateOneAsync(
            Builders<VideoGenRun>.Filter.Eq(x => x.Id, runId)
            & Builders<VideoGenRun>.Filter.Eq(x => x.DeploymentSlug, DeploymentScope.Current)
            & Builders<VideoGenRun>.Filter.Eq(x => x.Status, VideoGenRunStatus.Editing)
            & Builders<VideoGenRun>.Filter.Eq($"Scenes.{sceneIdx}.Status", SceneItemStatus.SubmittingClaimed)
            & Builders<VideoGenRun>.Filter.Eq($"Scenes.{sceneIdx}.JobId", claimId)
            & Builders<VideoGenRun>.Filter.Eq($"Scenes.{sceneIdx}.RenderLeaseId", claimId),
            Builders<VideoGenRun>.Update.Set(
                $"Scenes.{sceneIdx}.RenderLeaseExpiresAt",
                DateTime.UtcNow + SceneRenderLease),
            cancellationToken: CancellationToken.None);
        return renewed.MatchedCount == 1;
    }

    /// <summary>处理单镜重生成 prompt（用户点"重新设计这个分镜"）</summary>
    private async Task ProcessSceneRegenerateAsync(VideoGenRun run, CancellationToken authorityToken)
    {
        authorityToken.ThrowIfCancellationRequested();
        if (await IsRunCancellationRequestedAsync(run.Id))
        {
            await CancelRunAsync(run);
            return;
        }
        var sceneIdx = run.Scenes.FindIndex(s => s.Status == SceneItemStatus.Generating);
        if (sceneIdx < 0) return;
        var scene = run.Scenes[sceneIdx];

        using var scope = _scopeFactory.CreateScope();
        var gateway = scope.ServiceProvider.GetRequiredService<ILlmGateway>();
        var ctxAccessor = scope.ServiceProvider.GetRequiredService<ILLMRequestContextAccessor>();

        using var _ = ctxAccessor.BeginScope(new LlmRequestContext(
            RequestId: Guid.NewGuid().ToString("N"),
            GroupId: null, SessionId: null,
            UserId: run.OwnerAdminId,
            ViewRole: null, DocumentChars: null, DocumentHash: null, SystemPromptRedacted: null,
            RequestType: "chat",
            AppCallerCode: AppCallerRegistry.VideoAgent.Script.Chat,
            RunId: run.Id,
            LogicalRequestId: $"{run.Id}_scene_{sceneIdx}"));

        var systemPrompt = "你是视频导演。请重新生成一个英文 prompt 来描述同一主题的新镜头，画面要与原 prompt 不同但风格一致。直接输出 prompt 文本，不要解释、不要 JSON。";
        var userMsg = $"原主题：{scene.Topic}\n原 prompt：{scene.Prompt}\n\n请生成一个新 prompt。";
        if (!string.IsNullOrWhiteSpace(run.StyleDescription))
            userMsg = $"统一风格：{run.StyleDescription}\n\n" + userMsg;

        var resolution = await gateway.ResolveModelAsync(
            AppCallerRegistry.VideoAgent.Script.Chat, ModelTypes.Chat, null, ct: authorityToken);
        if (!resolution.Success)
        {
            await MarkSceneErrorAsync(
                run.Id,
                sceneIdx,
                "模型调度失败: " + resolution.ErrorMessage,
                expectedWorkerLeaseId: run.WorkerLeaseId);
            return;
        }

        var resp = await gateway.SendRawWithResolutionAsync(new GatewayRawRequest
        {
            AppCallerCode = AppCallerRegistry.VideoAgent.Script.Chat,
            ModelType = ModelTypes.Chat,
            RequestBody = new System.Text.Json.Nodes.JsonObject
            {
                ["messages"] = new System.Text.Json.Nodes.JsonArray
                {
                    new System.Text.Json.Nodes.JsonObject { ["role"] = "system", ["content"] = systemPrompt },
                    new System.Text.Json.Nodes.JsonObject { ["role"] = "user", ["content"] = userMsg },
                },
                ["temperature"] = 0.9,
            },
            TimeoutSeconds = 60,
        }, resolution, authorityToken);

        if (!resp.Success)
        {
            await MarkSceneErrorAsync(
                run.Id,
                sceneIdx,
                "重生成 LLM 调用失败",
                expectedWorkerLeaseId: run.WorkerLeaseId);
            return;
        }

        if (await IsRunCancellationRequestedAsync(run.Id))
        {
            await CancelRunAsync(run);
            return;
        }

        var newPrompt = ExtractAssistantText(resp.Content ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(newPrompt))
        {
            await MarkSceneErrorAsync(
                run.Id,
                sceneIdx,
                "LLM 返回为空",
                expectedWorkerLeaseId: run.WorkerLeaseId);
            return;
        }

        var completed = await _db.VideoGenRuns.UpdateOneAsync(
            OwnedRunFilter(run)
            & Builders<VideoGenRun>.Filter.Eq(x => x.Status, VideoGenRunStatus.Editing)
            & Builders<VideoGenRun>.Filter.Eq(x => x.CancelRequested, false)
            & Builders<VideoGenRun>.Filter.Eq($"Scenes.{sceneIdx}.Status", SceneItemStatus.Generating),
            Builders<VideoGenRun>.Update
                .Set($"Scenes.{sceneIdx}.Status", SceneItemStatus.Draft)
                .Set($"Scenes.{sceneIdx}.Prompt", newPrompt)
                .Set($"Scenes.{sceneIdx}.ErrorMessage", (string?)null)
                .Set(x => x.WorkerLeaseId, (string?)null)
                .Set(x => x.WorkerLeaseExpiresAt, (DateTime?)null)
                .Set(x => x.WorkerLeasePhase, (string?)null),
            cancellationToken: CancellationToken.None);
        if (completed.ModifiedCount != 1) return;

        await PublishEventAsync(run.Id, "scene.prompt.regenerated", new { sceneIndex = sceneIdx, prompt = newPrompt });
    }

    private async Task<bool> IsRunCancellationRequestedAsync(string runId)
    {
        return await _db.VideoGenRuns.Find(x => x.Id == runId)
            .Project(x => x.CancelRequested)
            .FirstOrDefaultAsync(CancellationToken.None);
    }

    private async Task MarkSceneErrorAsync(
        string runId,
        int sceneIdx,
        string errorMessage,
        string? expectedJobId = null,
        string? expectedLeaseId = null,
        string? expectedWorkerLeaseId = null)
    {
        var userMessage = VideoGenerationUserError.ForPersistence("SCENE_RENDER_FAILED", errorMessage);
        var filter = Builders<VideoGenRun>.Filter.Eq(x => x.Id, runId);
        if (!string.IsNullOrWhiteSpace(expectedJobId))
        {
            filter &= Builders<VideoGenRun>.Filter.Eq($"Scenes.{sceneIdx}.JobId", expectedJobId);
        }
        if (!string.IsNullOrWhiteSpace(expectedLeaseId))
        {
            filter &= Builders<VideoGenRun>.Filter.Eq(x => x.DeploymentSlug, DeploymentScope.Current)
                      & Builders<VideoGenRun>.Filter.Eq($"Scenes.{sceneIdx}.RenderLeaseId", expectedLeaseId);
        }
        if (!string.IsNullOrWhiteSpace(expectedWorkerLeaseId))
        {
            filter &= Builders<VideoGenRun>.Filter.Eq(x => x.DeploymentSlug, DeploymentScope.Current)
                      & Builders<VideoGenRun>.Filter.Eq(x => x.WorkerLeaseId, expectedWorkerLeaseId);
        }
        UpdateDefinition<VideoGenRun> update = Builders<VideoGenRun>.Update
                .Set($"Scenes.{sceneIdx}.Status", SceneItemStatus.Error)
                .Set($"Scenes.{sceneIdx}.ErrorMessage", userMessage)
                .Set($"Scenes.{sceneIdx}.SubmissionStartedAt", (DateTime?)null)
                .Set($"Scenes.{sceneIdx}.RenderLeaseId", (string?)null)
                .Set($"Scenes.{sceneIdx}.RenderLeaseExpiresAt", (DateTime?)null);
        if (!string.IsNullOrWhiteSpace(expectedWorkerLeaseId))
        {
            update = update
                .Set(x => x.WorkerLeaseId, (string?)null)
                .Set(x => x.WorkerLeaseExpiresAt, (DateTime?)null)
                .Set(x => x.WorkerLeasePhase, (string?)null);
        }
        var updated = await _db.VideoGenRuns.UpdateOneAsync(
            filter,
            update,
            cancellationToken: CancellationToken.None);
        if (updated.ModifiedCount != 1) return;
        await SyncProjectSceneActivityAsync(runId);
        await PublishEventAsync(runId, "scene.render.error",
            new { sceneIndex = sceneIdx, message = userMessage });
    }

    internal static string ResolveProjectStatusForScenes(IReadOnlyCollection<VideoGenScene> scenes)
    {
        var hasActiveScene = scenes.Any(scene =>
            scene.Status is SceneItemStatus.Submitting or SceneItemStatus.SubmittingClaimed or SceneItemStatus.Polling or SceneItemStatus.PollingClaimed or SceneItemStatus.Rendering or SceneItemStatus.Generating);
        return hasActiveScene ? VideoProjectStatus.Rendering : VideoProjectStatus.Editing;
    }

    private async Task SyncProjectSceneActivityAsync(string runId)
    {
        var run = await _db.VideoGenRuns.Find(x => x.Id == runId)
            .FirstOrDefaultAsync(CancellationToken.None);
        if (run == null) return;
        await UpdateProjectAsync(run, ResolveProjectStatusForScenes(run.Scenes));
    }

    private async Task<VideoGenRun?> ClaimExportRunAsync(CancellationToken ct)
    {
        var fb = Builders<VideoGenRun>.Filter;
        var leaseId = $"export-run:{Guid.NewGuid():N}";
        var filter = fb.Eq(x => x.Status, VideoGenRunStatus.Rendering)
                     & fb.Eq(x => x.DeploymentSlug, DeploymentScope.Current)
                     & fb.Eq(x => x.ExportRequested, true)
                     & (fb.Eq(x => x.WorkerLeaseId, null)
                        | fb.Lte(x => x.WorkerLeaseExpiresAt, DateTime.UtcNow));
        var update = Builders<VideoGenRun>.Update
            .Set(x => x.ExportRequested, false)
            .Set(x => x.ExportStartedAt, DateTime.UtcNow)
            .Set(x => x.CurrentPhase, "export-preparing")
            .Set(x => x.PhaseProgress, 5)
            .Set(x => x.WorkerLeaseId, leaseId)
            .Set(x => x.WorkerLeaseExpiresAt, DateTime.UtcNow + WorkerLeaseDuration)
            .Set(x => x.WorkerLeasePhase, "export");
        return await _db.VideoGenRuns.FindOneAndUpdateAsync(
            filter,
            update,
            new FindOneAndUpdateOptions<VideoGenRun> { ReturnDocument = ReturnDocument.After },
            ct);
    }

    private async Task<VideoExportTask?> ClaimExportTaskAsync(CancellationToken ct)
    {
        var leaseId = $"export:{Guid.NewGuid():N}";
        var filter = Builders<VideoExportTask>.Filter.Eq(x => x.Status, VideoExportTaskStatus.Queued)
                     & Builders<VideoExportTask>.Filter.Eq(x => x.DeploymentSlug, DeploymentScope.Current);
        return await _db.VideoExportTasks.FindOneAndUpdateAsync(
            filter,
            Builders<VideoExportTask>.Update
                .Set(x => x.Status, VideoExportTaskStatus.Processing)
                .Set(x => x.CurrentPhase, "export-preparing")
                .Set(x => x.Progress, 5)
                .Set(x => x.StartedAt, DateTime.UtcNow)
                .Set(x => x.WorkerLeaseId, leaseId)
                .Set(x => x.WorkerLeaseExpiresAt, DateTime.UtcNow + WorkerLeaseDuration),
            new FindOneAndUpdateOptions<VideoExportTask> { ReturnDocument = ReturnDocument.After },
            ct);
    }

    internal async Task<bool> RecoverExportTaskRunAsync(
        VideoExportTask task,
        string? currentScope,
        string? durableScope,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(currentScope)
            || string.IsNullOrWhiteSpace(durableScope)
            || string.IsNullOrWhiteSpace(task.WorkerLeaseId))
            return false;

        var runFilter = Builders<VideoGenRun>.Filter.Eq(x => x.Id, task.RunId)
                        & VideoGenService.BuildBranchDeploymentFilter<VideoGenRun>(
                            nameof(VideoGenRun.DeploymentSlug),
                            currentScope,
                            durableScope);
        var recoveredRun = await _db.VideoGenRuns.UpdateOneAsync(
            runFilter,
            Builders<VideoGenRun>.Update.Set(x => x.DeploymentSlug, currentScope),
            cancellationToken: ct);
        if (recoveredRun.MatchedCount != 1) return false;

        // 只有仍由本次领取持有的任务才能退回队列。若 lease 已转移，run 已完成幂等对齐，
        // 新持有者可直接继续，旧持有者不再改写任务。
        await _db.VideoExportTasks.UpdateOneAsync(
            Builders<VideoExportTask>.Filter.Eq(x => x.Id, task.Id)
            & Builders<VideoExportTask>.Filter.Eq(x => x.DeploymentSlug, currentScope)
            & Builders<VideoExportTask>.Filter.Eq(x => x.Status, VideoExportTaskStatus.Processing)
            & Builders<VideoExportTask>.Filter.Eq(x => x.WorkerLeaseId, task.WorkerLeaseId),
            Builders<VideoExportTask>.Update
                .Set(x => x.Status, VideoExportTaskStatus.Queued)
                .Set(x => x.CurrentPhase, "queued")
                .Set(x => x.Progress, 0)
                .Set(x => x.StartedAt, (DateTime?)null)
                .Set(x => x.WorkerLeaseId, (string?)null)
                .Set(x => x.WorkerLeaseExpiresAt, (DateTime?)null),
            cancellationToken: ct);
        _logger.LogInformation(
            "[VideoGenWorker] 已补齐导出任务的关联 run 接管: taskId={TaskId}, runId={RunId}",
            task.Id,
            task.RunId);
        return true;
    }

    private async Task ProcessExportAsync(
        VideoGenRun run,
        VideoExportTask? exportTask = null,
        CancellationToken authorityToken = default)
    {
        authorityToken.ThrowIfCancellationRequested();
        if (run.CancelRequested)
        {
            if (exportTask != null)
            {
                var cancelledTask = await _db.VideoExportTasks.UpdateOneAsync(
                    OwnedExportTaskFilter(exportTask),
                    Builders<VideoExportTask>.Update
                        .Set(x => x.Status, VideoExportTaskStatus.Cancelled)
                        .Set(x => x.CurrentPhase, "cancelled")
                        .Set(x => x.EndedAt, DateTime.UtcNow)
                        .Set(x => x.WorkerLeaseId, (string?)null)
                        .Set(x => x.WorkerLeaseExpiresAt, (DateTime?)null),
                    cancellationToken: CancellationToken.None);
                if (cancelledTask.ModifiedCount != 1) return;
            }
            await CancelRunAsync(run);
            return;
        }
        var project = string.IsNullOrWhiteSpace(run.ProjectId)
            ? null
            : await _db.VideoProjects.Find(x => x.Id == run.ProjectId).FirstOrDefaultAsync(CancellationToken.None);
        var videoTrack = project?.TimelineTracks.FirstOrDefault(track => track.Type == VideoTrackType.Video);
        if (videoTrack?.Muted == true)
        {
            await FailExportAsync(
                run,
                "视频轨已静音，无法导出可播放视频",
                exportTask?.Id,
                exportTask?.WorkerLeaseId);
            return;
        }
        var timelineClips = videoTrack?.Clips
            .Where(clip => clip.SceneIndex.HasValue && clip.SceneIndex.Value >= 0 && clip.SceneIndex.Value < run.Scenes.Count)
            .ToList() ?? [];
        if (timelineClips.Count == 0)
        {
            timelineClips = run.Scenes.Select((scene, index) => new VideoTimelineClip
            {
                SceneIndex = index,
                StartSeconds = run.Scenes.Take(index).Sum(item => item.Duration ?? run.DirectDuration ?? 5),
                DurationSeconds = scene.Duration ?? run.DirectDuration ?? 5,
            }).ToList();
        }
        var selectedScenes = timelineClips.Select(clip => (Clip: clip, Scene: run.Scenes[clip.SceneIndex!.Value])).ToList();
        if (selectedScenes.Count == 0 || selectedScenes.Any(item => string.IsNullOrWhiteSpace(item.Scene.VideoUrl)))
        {
            await FailExportAsync(
                run,
                "存在尚未生成的视频分镜",
                exportTask?.Id,
                exportTask?.WorkerLeaseId);
            return;
        }

        var tempDir = Path.Combine(Path.GetTempPath(), $"prd-video-export-{run.Id}");
        Directory.CreateDirectory(tempDir);
        try
        {
            using var scope = _scopeFactory.CreateScope();
            var httpClientFactory = scope.ServiceProvider.GetRequiredService<IHttpClientFactory>();
            var httpClient = httpClientFactory.CreateClient();
            using var externalHttpClient = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false })
            {
                Timeout = TimeSpan.FromMinutes(3),
            };
            var videoInputs = new List<VideoExportClipSource>();

            for (var index = 0; index < selectedScenes.Count; index++)
            {
                var inputFile = Path.Combine(tempDir, $"scene-{index:D3}.mp4");
                await DownloadToFileAsync(
                    httpClient,
                    selectedScenes[index].Scene.VideoUrl!,
                    inputFile,
                    1024L * 1024 * 1024,
                    authorityToken);
                var probe = await ProbeMediaAsync(inputFile, authorityToken);
                var timelineClip = selectedScenes[index].Clip;
                videoInputs.Add(new VideoExportClipSource(
                    inputFile,
                    probe.DurationSeconds > 0 ? probe.DurationSeconds : timelineClip.DurationSeconds,
                    probe.HasAudio,
                    timelineClip.TrimStartSeconds,
                    timelineClip.TrimEndSeconds,
                    timelineClip.Transition));

                var progress = 10 + (int)Math.Round((index + 1d) / selectedScenes.Count * 25d);
                if (!await UpdateExportProgressAsync(run, exportTask, "export-downloading", progress)) return;
            }

            var audioInputs = new List<VideoExportAudioSource>();
            var audioTimelineClips = project?.TimelineTracks
                .Where(track => !track.Muted && track.Type is VideoTrackType.Voice or VideoTrackType.Music)
                .SelectMany(track => track.Clips.Select(clip => (TrackType: track.Type, Clip: clip)))
                .Where(item => !string.IsNullOrWhiteSpace(item.Clip.AssetUrl))
                .ToList() ?? [];
            for (var index = 0; index < audioTimelineClips.Count; index++)
            {
                var item = audioTimelineClips[index];
                await EnsurePublicHttpsUrlAsync(item.Clip.AssetUrl!, authorityToken);
                var inputFile = Path.Combine(tempDir, $"audio-{index:D3}.bin");
                await DownloadToFileAsync(
                    externalHttpClient,
                    item.Clip.AssetUrl!,
                    inputFile,
                    100L * 1024 * 1024,
                    authorityToken);
                var probe = await ProbeMediaAsync(inputFile, authorityToken);
                if (!probe.HasAudio) throw new InvalidOperationException($"音频轨素材 {index + 1} 不包含可识别音轨");
                audioInputs.Add(new VideoExportAudioSource(
                    inputFile,
                    item.Clip.StartSeconds,
                    item.Clip.DurationSeconds > 0 ? item.Clip.DurationSeconds : probe.DurationSeconds,
                    item.Clip.TrimStartSeconds,
                    item.Clip.TrimEndSeconds,
                    item.TrackType == VideoTrackType.Music ? 0.35 : 1));
            }

            var subtitleFile = await WriteSubtitleFileAsync(project, tempDir, authorityToken);
            var outputFile = Path.Combine(tempDir, "export.mp4");
            var args = VideoExportCommandBuilder.Build(
                videoInputs,
                audioInputs,
                subtitleFile,
                outputFile,
                run.DirectAspectRatio);
            var startInfo = new ProcessStartInfo
            {
                FileName = "ffmpeg",
                RedirectStandardError = true,
                RedirectStandardOutput = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            foreach (var arg in args) startInfo.ArgumentList.Add(arg);

            if (!await UpdateExportProgressAsync(run, exportTask, "export-composing", 50)) return;
            using var process = Process.Start(startInfo)
                                ?? throw new InvalidOperationException("ffmpeg 进程启动失败");
            using var killOnLeaseLoss = authorityToken.Register(() =>
            {
                try
                {
                    if (!process.HasExited) process.Kill(entireProcessTree: true);
                }
                catch
                {
                    // 进程可能恰好已退出；租约失效路径只负责尽快停止外部副作用。
                }
            });
            var stderrTask = process.StandardError.ReadToEndAsync();
            var stdoutTask = process.StandardOutput.ReadToEndAsync();
            var exitTask = process.WaitForExitAsync(authorityToken);
            var completed = await Task.WhenAny(exitTask, Task.Delay(TimeSpan.FromMinutes(15), authorityToken));
            authorityToken.ThrowIfCancellationRequested();
            if (completed != exitTask)
            {
                try { process.Kill(entireProcessTree: true); } catch { }
                throw new TimeoutException("视频合成超过 15 分钟");
            }
            await exitTask;
            var stderr = await stderrTask;
            _ = await stdoutTask;
            if (process.ExitCode != 0 || !File.Exists(outputFile))
            {
                var detail = stderr.Length > 1200 ? stderr[^1200..] : stderr;
                throw new InvalidOperationException($"ffmpeg 合成失败 (exit={process.ExitCode}): {detail}");
            }

            if (!await UpdateExportProgressAsync(run, exportTask, "export-uploading", 90)) return;
            var bytes = await File.ReadAllBytesAsync(outputFile, authorityToken);
            var expectedSha256 = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
            await using var assetLease = await VideoAssetMutationLease.AcquireAsync(
                _db,
                $"generated-video:{expectedSha256}",
                authorityToken);
            RegistryAssetStorage.OverrideNextScope("generated");
            var stored = await _assetStorage.SaveAsync(
                bytes,
                "video/mp4",
                authorityToken,
                domain: AppDomainPaths.DomainVideoAgent,
                type: AppDomainPaths.TypeVideo);
            if (!string.Equals(stored.Sha256, expectedSha256, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("视频资产摘要校验失败");

            var totalCost = run.Scenes.Where(scene => scene.Cost.HasValue).Sum(scene => scene.Cost!.Value);
            if (exportTask != null)
            {
                try
                {
                    var completedTask = await _db.VideoExportTasks.UpdateOneAsync(
                        OwnedExportTaskFilter(exportTask),
                        Builders<VideoExportTask>.Update
                            .Set(x => x.Status, VideoExportTaskStatus.Completed)
                            .Set(x => x.CurrentPhase, "completed")
                            .Set(x => x.Progress, 100)
                            .Set(x => x.OutputUrl, stored.Url)
                            .Set(x => x.OutputSha256, stored.Sha256)
                            .Set(x => x.TotalCost, totalCost)
                            .Set(x => x.RunReconciledAt, (DateTime?)null)
                            .Set(x => x.ErrorMessage, (string?)null)
                            .Set(x => x.EndedAt, DateTime.UtcNow)
                            .Set(x => x.WorkerLeaseId, (string?)null)
                            .Set(x => x.WorkerLeaseExpiresAt, (DateTime?)null),
                        cancellationToken: CancellationToken.None);
                    if (completedTask.ModifiedCount != 1)
                    {
                        await DeleteStoredVideoIfUnreferencedAsync(stored.Sha256, stored.Url);
                        return;
                    }
                }
                catch
                {
                    await DeleteStoredVideoIfUnreferencedAsync(stored.Sha256, stored.Url);
                    throw;
                }
            }
            var runFilter = exportTask == null
                ? OwnedRunFilter(run)
                : Builders<VideoGenRun>.Filter.Eq(x => x.Id, run.Id)
                  & Builders<VideoGenRun>.Filter.Eq(x => x.DeploymentSlug, DeploymentScope.Current)
                  & Builders<VideoGenRun>.Filter.Eq(x => x.Status, VideoGenRunStatus.Rendering)
                  & Builders<VideoGenRun>.Filter.Eq(x => x.LatestExportTaskId, exportTask.Id);
            UpdateResult completedRun;
            try
            {
                completedRun = await _db.VideoGenRuns.UpdateOneAsync(
                    runFilter,
                    Builders<VideoGenRun>.Update
                        .Set(x => x.Status, VideoGenRunStatus.Completed)
                        .Set(x => x.VideoAssetUrl, stored.Url)
                        .Set(x => x.VideoAssetSha256, stored.Sha256)
                        .Set(x => x.DirectVideoCost, totalCost)
                        .Set(x => x.ExportErrorMessage, (string?)null)
                        .Set(x => x.ExportedAt, DateTime.UtcNow)
                        .Set(x => x.EndedAt, DateTime.UtcNow)
                        .Set(x => x.CurrentPhase, "completed")
                        .Set(x => x.PhaseProgress, 100)
                        .Set(x => x.WorkerLeaseId, (string?)null)
                        .Set(x => x.WorkerLeaseExpiresAt, (DateTime?)null)
                        .Set(x => x.WorkerLeasePhase, (string?)null),
                    cancellationToken: CancellationToken.None);
            }
            catch
            {
                await DeleteStoredVideoIfUnreferencedAsync(stored.Sha256, stored.Url);
                throw;
            }
            if (completedRun.ModifiedCount != 1)
            {
                await DeleteStoredVideoIfUnreferencedAsync(stored.Sha256, stored.Url);
                return;
            }
            if (exportTask != null)
            {
                await _db.VideoExportTasks.UpdateOneAsync(
                    Builders<VideoExportTask>.Filter.Eq(x => x.Id, exportTask.Id)
                    & Builders<VideoExportTask>.Filter.Eq(x => x.Status, VideoExportTaskStatus.Completed)
                    & Builders<VideoExportTask>.Filter.Eq(x => x.RunReconciledAt, null),
                    Builders<VideoExportTask>.Update.Set(x => x.RunReconciledAt, DateTime.UtcNow),
                    cancellationToken: CancellationToken.None);
            }
            await UpdateProjectAsync(run, VideoProjectStatus.Completed);
            await PublishEventAsync(run.Id, "export.completed", new { videoUrl = stored.Url, cost = totalCost });
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); }
            catch (Exception ex) { _logger.LogWarning(ex, "VideoGen 导出临时目录清理失败: {Path}", tempDir); }
        }
    }

    private static async Task DownloadToFileAsync(
        HttpClient client,
        string url,
        string targetPath,
        long maxBytes,
        CancellationToken authorityToken)
    {
        using var response = await client.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, authorityToken);
        response.EnsureSuccessStatusCode();
        var contentLength = response.Content.Headers.ContentLength;
        if (contentLength.HasValue && contentLength.Value > maxBytes)
            throw new InvalidOperationException($"媒体文件超过大小限制：{contentLength.Value} bytes");
        await using var source = await response.Content.ReadAsStreamAsync(authorityToken);
        await using var target = File.Create(targetPath);
        var buffer = new byte[81920];
        long total = 0;
        while (true)
        {
            var read = await source.ReadAsync(buffer, authorityToken);
            if (read == 0) break;
            total += read;
            if (total > maxBytes) throw new InvalidOperationException("媒体文件超过大小限制");
            await target.WriteAsync(buffer.AsMemory(0, read), authorityToken);
        }
    }

    private static async Task<MediaProbeResult> ProbeMediaAsync(string filePath, CancellationToken authorityToken)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = "ffprobe",
            RedirectStandardError = true,
            RedirectStandardOutput = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        foreach (var arg in new[]
                 {
                     "-v", "error", "-show_entries", "format=duration", "-show_entries", "stream=codec_type",
                     "-of", "json", filePath,
                 })
            startInfo.ArgumentList.Add(arg);
        using var process = Process.Start(startInfo)
                            ?? throw new InvalidOperationException("ffprobe 进程启动失败");
        using var killOnLeaseLoss = authorityToken.Register(() =>
        {
            try
            {
                if (!process.HasExited) process.Kill(entireProcessTree: true);
            }
            catch
            {
                // 进程可能恰好已退出。
            }
        });
        var stdoutTask = process.StandardOutput.ReadToEndAsync();
        var stderrTask = process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync(authorityToken);
        var stdout = await stdoutTask;
        var stderr = await stderrTask;
        if (process.ExitCode != 0)
            throw new InvalidOperationException($"ffprobe 读取媒体失败: {stderr}");
        var json = JsonNode.Parse(stdout) as JsonObject
                   ?? throw new InvalidOperationException("ffprobe 返回了无效 JSON");
        var durationText = json["format"]?["duration"]?.ToString().Trim('"');
        _ = double.TryParse(durationText, NumberStyles.Float, CultureInfo.InvariantCulture, out var duration);
        var hasAudio = json["streams"] is JsonArray streams && streams
            .OfType<JsonObject>()
            .Any(stream => string.Equals(stream["codec_type"]?.ToString(), "audio", StringComparison.OrdinalIgnoreCase));
        return new MediaProbeResult(duration, hasAudio);
    }

    private static async Task<string?> WriteSubtitleFileAsync(
        VideoProject? project,
        string tempDir,
        CancellationToken authorityToken)
    {
        var track = project?.TimelineTracks.FirstOrDefault(item =>
            item.Type == VideoTrackType.Subtitle && !item.Muted);
        var clips = track?.Clips
            .Where(clip => !string.IsNullOrWhiteSpace(clip.Text) && clip.DurationSeconds > 0)
            .OrderBy(clip => clip.StartSeconds)
            .ToList();
        if (clips == null || clips.Count == 0) return null;
        var content = new StringBuilder();
        for (var index = 0; index < clips.Count; index++)
        {
            var clip = clips[index];
            content.AppendLine((index + 1).ToString(CultureInfo.InvariantCulture));
            content.Append(FormatSrtTime(clip.StartSeconds));
            content.Append(" --> ");
            content.AppendLine(FormatSrtTime(clip.StartSeconds + clip.DurationSeconds));
            content.AppendLine(clip.Text!.Trim().Replace("\r\n", "\n").Replace('\r', '\n'));
            content.AppendLine();
        }
        var path = Path.Combine(tempDir, "subtitles.srt");
        await File.WriteAllTextAsync(path, content.ToString(), new UTF8Encoding(false), authorityToken);
        return path;
    }

    private static string FormatSrtTime(double seconds)
    {
        var value = TimeSpan.FromSeconds(Math.Max(0, seconds));
        return $"{(int)value.TotalHours:00}:{value.Minutes:00}:{value.Seconds:00},{value.Milliseconds:000}";
    }

    private static async Task EnsurePublicHttpsUrlAsync(string rawUrl, CancellationToken authorityToken)
    {
        if (!Uri.TryCreate(rawUrl, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps)
            throw new InvalidOperationException("音频素材必须使用公开 HTTPS URL");
        IPAddress[] addresses;
        try { addresses = await Dns.GetHostAddressesAsync(uri.DnsSafeHost, authorityToken); }
        catch (OperationCanceledException) when (authorityToken.IsCancellationRequested) { throw; }
        catch (Exception ex) { throw new InvalidOperationException("音频素材域名无法解析", ex); }
        if (addresses.Length == 0 || addresses.Any(IsPrivateAddress))
            throw new InvalidOperationException("音频素材 URL 不允许指向本机或内网地址");
    }

    private static bool IsPrivateAddress(IPAddress address)
    {
        if (IPAddress.IsLoopback(address) || address.IsIPv6LinkLocal || address.IsIPv6SiteLocal)
            return true;
        if (address.AddressFamily == AddressFamily.InterNetworkV6 && address.IsIPv4MappedToIPv6)
            address = address.MapToIPv4();
        if (address.AddressFamily != AddressFamily.InterNetwork) return false;
        var bytes = address.GetAddressBytes();
        return bytes[0] is 0 or 10 or 127 ||
               (bytes[0] == 100 && bytes[1] is >= 64 and <= 127) ||
               (bytes[0] == 169 && bytes[1] == 254) ||
               (bytes[0] == 172 && bytes[1] is >= 16 and <= 31) ||
               (bytes[0] == 192 && bytes[1] == 168) ||
               bytes[0] >= 224;
    }

    private sealed record MediaProbeResult(double DurationSeconds, bool HasAudio);

    private async Task<bool> UpdateExportProgressAsync(
        VideoGenRun run,
        VideoExportTask? exportTask,
        string phase,
        int progress)
    {
        if (exportTask != null)
        {
            var taskProgress = await _db.VideoExportTasks.UpdateOneAsync(
                OwnedExportTaskFilter(exportTask),
                Builders<VideoExportTask>.Update
                    .Set(x => x.CurrentPhase, phase)
                    .Set(x => x.Progress, progress),
                cancellationToken: CancellationToken.None);
            if (taskProgress.MatchedCount != 1) return false;
        }
        var runFilter = exportTask == null
            ? OwnedRunFilter(run)
            : Builders<VideoGenRun>.Filter.Eq(x => x.Id, run.Id)
              & Builders<VideoGenRun>.Filter.Eq(x => x.DeploymentSlug, DeploymentScope.Current)
              & Builders<VideoGenRun>.Filter.Eq(x => x.LatestExportTaskId, exportTask.Id);
        var runProgress = await _db.VideoGenRuns.UpdateOneAsync(
            runFilter,
            Builders<VideoGenRun>.Update
                .Set(x => x.CurrentPhase, phase)
                .Set(x => x.PhaseProgress, progress),
            cancellationToken: CancellationToken.None);
        if (runProgress.MatchedCount != 1) return false;
        await PublishEventAsync(run.Id, "export.progress", new { taskId = exportTask?.Id, phase, progress });
        return true;
    }

    private async Task FailExportAsync(
        VideoGenRun run,
        string errorMessage,
        string? exportTaskId = null,
        string? expectedWorkerLeaseId = null)
    {
        var userMessage = VideoGenerationUserError.ForPersistence("EXPORT_FAILED", errorMessage);
        if (!string.IsNullOrWhiteSpace(exportTaskId))
        {
            if (string.IsNullOrWhiteSpace(expectedWorkerLeaseId)) return;
            var failedTask = await _db.VideoExportTasks.UpdateOneAsync(
                Builders<VideoExportTask>.Filter.Eq(x => x.Id, exportTaskId)
                & Builders<VideoExportTask>.Filter.Eq(x => x.DeploymentSlug, DeploymentScope.Current)
                & Builders<VideoExportTask>.Filter.Eq(x => x.Status, VideoExportTaskStatus.Processing)
                & Builders<VideoExportTask>.Filter.Eq(x => x.WorkerLeaseId, expectedWorkerLeaseId),
                Builders<VideoExportTask>.Update
                    .Set(x => x.Status, VideoExportTaskStatus.Failed)
                    .Set(x => x.CurrentPhase, "export-failed")
                    .Set(x => x.Progress, 0)
                    .Set(x => x.ErrorMessage, userMessage)
                    .Set(x => x.EndedAt, DateTime.UtcNow)
                    .Set(x => x.WorkerLeaseId, (string?)null)
                    .Set(x => x.WorkerLeaseExpiresAt, (DateTime?)null),
                cancellationToken: CancellationToken.None);
            if (failedTask.ModifiedCount != 1) return;
        }
        var runFilter = string.IsNullOrWhiteSpace(exportTaskId)
            ? OwnedRunFilter(run)
            : Builders<VideoGenRun>.Filter.Eq(x => x.Id, run.Id)
              & Builders<VideoGenRun>.Filter.Eq(x => x.DeploymentSlug, DeploymentScope.Current)
              & Builders<VideoGenRun>.Filter.Eq(x => x.LatestExportTaskId, exportTaskId);
        var failedRun = await _db.VideoGenRuns.UpdateOneAsync(
            runFilter,
            Builders<VideoGenRun>.Update
                .Set(x => x.Status, VideoGenRunStatus.Editing)
                .Set(x => x.ExportRequested, false)
                .Set(x => x.ExportErrorMessage, userMessage)
                .Set(x => x.CurrentPhase, "export-failed")
                .Set(x => x.PhaseProgress, 0)
                .Set(x => x.WorkerLeaseId, (string?)null)
                .Set(x => x.WorkerLeaseExpiresAt, (DateTime?)null)
                .Set(x => x.WorkerLeasePhase, (string?)null),
            cancellationToken: CancellationToken.None);
        if (failedRun.ModifiedCount != 1) return;
        await UpdateProjectAsync(run, VideoProjectStatus.Editing);
        await PublishEventAsync(run.Id, "export.error", new { message = userMessage });
    }

    private static FilterDefinition<VideoGenRun> OwnedRunFilter(VideoGenRun run)
    {
        var fb = Builders<VideoGenRun>.Filter;
        var filter = fb.Eq(x => x.Id, run.Id)
                     & fb.Eq(x => x.DeploymentSlug, DeploymentScope.Current);
        if (!string.IsNullOrWhiteSpace(run.WorkerLeaseId))
            filter &= fb.Eq(x => x.WorkerLeaseId, run.WorkerLeaseId);
        return filter;
    }

    private static FilterDefinition<VideoExportTask> OwnedExportTaskFilter(VideoExportTask task)
    {
        var fb = Builders<VideoExportTask>.Filter;
        return fb.Eq(x => x.Id, task.Id)
               & fb.Eq(x => x.DeploymentSlug, DeploymentScope.Current)
               & fb.Eq(x => x.Status, VideoExportTaskStatus.Processing)
               & fb.Eq(x => x.WorkerLeaseId, task.WorkerLeaseId);
    }

    internal async Task ProcessWithRunLeaseHeartbeatAsync(
        VideoGenRun run,
        Func<CancellationToken, Task> action)
    {
        if (string.IsNullOrWhiteSpace(run.WorkerLeaseId))
            throw new InvalidOperationException("长任务缺少 worker lease，拒绝执行");
        if (!await RenewRunLeaseAsync(run)) return;

        using var stopHeartbeat = new CancellationTokenSource();
        using var authorityLost = new CancellationTokenSource();
        var heartbeat = RenewRunLeaseUntilStoppedAsync(run, authorityLost, stopHeartbeat.Token);
        try
        {
            await action(authorityLost.Token);
        }
        catch (OperationCanceledException) when (authorityLost.IsCancellationRequested)
        {
            _logger.LogInformation("VideoGen worker lease 已失效，旧持有者停止执行: runId={RunId}", run.Id);
        }
        finally
        {
            stopHeartbeat.Cancel();
            await heartbeat;
        }
    }

    internal async Task ProcessWithExportLeaseHeartbeatAsync(
        VideoExportTask task,
        Func<CancellationToken, Task> action)
    {
        if (string.IsNullOrWhiteSpace(task.WorkerLeaseId))
            throw new InvalidOperationException("导出任务缺少 worker lease，拒绝执行");
        if (!await RenewExportLeaseAsync(task)) return;

        using var stopHeartbeat = new CancellationTokenSource();
        using var authorityLost = new CancellationTokenSource();
        var heartbeat = RenewExportLeaseUntilStoppedAsync(task, authorityLost, stopHeartbeat.Token);
        try
        {
            await action(authorityLost.Token);
        }
        catch (OperationCanceledException) when (authorityLost.IsCancellationRequested)
        {
            _logger.LogInformation("VideoGen 导出 worker lease 已失效，旧持有者停止执行: taskId={TaskId}", task.Id);
        }
        finally
        {
            stopHeartbeat.Cancel();
            await heartbeat;
        }
    }

    private async Task RenewRunLeaseUntilStoppedAsync(
        VideoGenRun run,
        CancellationTokenSource authorityLost,
        CancellationToken stopToken)
    {
        var authorityDeadline = DateTime.UtcNow + WorkerLeaseDuration;
        while (!stopToken.IsCancellationRequested)
        {
            try
            {
                await Task.Delay(WorkerLeaseHeartbeatInterval, stopToken);
                if (!await RenewRunLeaseAsync(run))
                {
                    await authorityLost.CancelAsync();
                    return;
                }
                authorityDeadline = DateTime.UtcNow + WorkerLeaseDuration;
            }
            catch (OperationCanceledException) when (stopToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "VideoGen worker lease 续租失败，等待下一轮重试: runId={RunId}", run.Id);
                if (DateTime.UtcNow >= authorityDeadline)
                {
                    await authorityLost.CancelAsync();
                    return;
                }
            }
        }
    }

    private async Task RenewExportLeaseUntilStoppedAsync(
        VideoExportTask task,
        CancellationTokenSource authorityLost,
        CancellationToken stopToken)
    {
        var authorityDeadline = DateTime.UtcNow + WorkerLeaseDuration;
        while (!stopToken.IsCancellationRequested)
        {
            try
            {
                await Task.Delay(WorkerLeaseHeartbeatInterval, stopToken);
                if (!await RenewExportLeaseAsync(task))
                {
                    await authorityLost.CancelAsync();
                    return;
                }
                authorityDeadline = DateTime.UtcNow + WorkerLeaseDuration;
            }
            catch (OperationCanceledException) when (stopToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "VideoGen 导出 worker lease 续租失败，等待下一轮重试: taskId={TaskId}", task.Id);
                if (DateTime.UtcNow >= authorityDeadline)
                {
                    await authorityLost.CancelAsync();
                    return;
                }
            }
        }
    }

    private async Task<bool> RenewRunLeaseAsync(VideoGenRun run)
    {
        var renewed = await _db.VideoGenRuns.UpdateOneAsync(
            OwnedRunFilter(run),
            Builders<VideoGenRun>.Update.Set(x => x.WorkerLeaseExpiresAt, DateTime.UtcNow + WorkerLeaseDuration),
            cancellationToken: CancellationToken.None);
        return renewed.MatchedCount == 1;
    }

    private async Task<bool> RenewExportLeaseAsync(VideoExportTask task)
    {
        var renewed = await _db.VideoExportTasks.UpdateOneAsync(
            OwnedExportTaskFilter(task),
            Builders<VideoExportTask>.Update.Set(x => x.WorkerLeaseExpiresAt, DateTime.UtcNow + WorkerLeaseDuration),
            cancellationToken: CancellationToken.None);
        return renewed.MatchedCount == 1;
    }

    private async Task UpdatePhaseAsync(VideoGenRun run, string phase, int progress)
    {
        await _db.VideoGenRuns.UpdateOneAsync(
            OwnedRunFilter(run),
            Builders<VideoGenRun>.Update
                .Set(x => x.CurrentPhase, phase)
                .Set(x => x.PhaseProgress, progress),
            cancellationToken: CancellationToken.None);
    }

    private async Task UpdateProjectAsync(VideoGenRun run, string status)
    {
        if (string.IsNullOrWhiteSpace(run.ProjectId)) return;
        await _db.VideoProjects.UpdateOneAsync(
            x => x.Id == run.ProjectId,
            Builders<VideoProject>.Update
                .Set(x => x.Status, status)
                .Set(x => x.UpdatedAt, DateTime.UtcNow),
            cancellationToken: CancellationToken.None);
    }

    private async Task SyncProjectStoryboardAsync(
        VideoGenRun run,
        IReadOnlyList<VideoGenScene> scenes,
        string? aiTitle)
    {
        if (string.IsNullOrWhiteSpace(run.ProjectId)) return;
        var project = await _db.VideoProjects.Find(x => x.Id == run.ProjectId)
            .FirstOrDefaultAsync(CancellationToken.None);
        if (project == null) return;

        var clips = new List<VideoTimelineClip>();
        double cursor = 0;
        for (var index = 0; index < scenes.Count; index++)
        {
            var duration = scenes[index].Duration ?? run.DirectDuration ?? 5;
            clips.Add(new VideoTimelineClip
            {
                SceneIndex = index,
                StartSeconds = cursor,
                DurationSeconds = duration,
            });
            cursor += duration;
        }

        var tracks = project.TimelineTracks.Count > 0
            ? project.TimelineTracks
            : new List<VideoTimelineTrack>();
        var videoTrack = tracks.FirstOrDefault(track => track.Type == VideoTrackType.Video);
        if (videoTrack == null)
        {
            videoTrack = new VideoTimelineTrack { Type = VideoTrackType.Video, Name = "视频" };
            tracks.Insert(0, videoTrack);
        }
        videoTrack.Clips = clips;

        var update = Builders<VideoProject>.Update
            .Set(x => x.Status, VideoProjectStatus.Editing)
            .Set(x => x.TimelineTracks, tracks)
            .Set(x => x.UpdatedAt, DateTime.UtcNow);
        if (!string.IsNullOrWhiteSpace(aiTitle))
        {
            var title = aiTitle.Trim();
            update = update.Set(x => x.Title, title[..Math.Min(title.Length, 60)]);
        }
        await _db.VideoProjects.UpdateOneAsync(x => x.Id == run.ProjectId,
            update, cancellationToken: CancellationToken.None);
    }

    private async Task<VideoProject?> GetRunProjectAsync(VideoGenRun run)
    {
        if (string.IsNullOrWhiteSpace(run.ProjectId)) return null;
        return await _db.VideoProjects.Find(project => project.Id == run.ProjectId)
            .FirstOrDefaultAsync(CancellationToken.None);
    }

    private async Task<bool> SupportsReferenceAssetsAsync(string? model)
    {
        if (string.IsNullOrWhiteSpace(model)) return false;
        if (model.Contains("seedance-2", StringComparison.OrdinalIgnoreCase)) return true;
        var config = await _db.LLMModels.Find(item => item.Id == model || item.ModelName == model)
            .FirstOrDefaultAsync(CancellationToken.None);
        return config?.ModelName.Contains("seedance-2", StringComparison.OrdinalIgnoreCase) == true;
    }

    private static List<string> GetReferenceImageUrls(VideoProject? project)
        => project?.Assets
            .Where(asset => asset.Type is VideoProjectAssetType.Character or VideoProjectAssetType.Scene or VideoProjectAssetType.Prop)
            .Select(asset => asset.Url)
            .Where(url => !string.IsNullOrWhiteSpace(url))
            .Select(url => url!)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Take(9)
            .ToList() ?? [];

    private static string AppendAssetConstraints(string prompt, VideoProject? project)
    {
        var assets = project?.Assets
            .Where(asset => asset.Type is VideoProjectAssetType.Character or VideoProjectAssetType.Scene or VideoProjectAssetType.Prop)
            .Take(20)
            .ToList();
        if (assets == null || assets.Count == 0) return prompt;
        var manifest = string.Join("\n", assets.Select(asset =>
            $"- {asset.Type}: {asset.Name}" +
            (string.IsNullOrWhiteSpace(asset.Description) ? string.Empty : $"；{asset.Description}")));
        return $"{prompt}\n\n项目一致性约束：以下角色、场景和道具在所有镜头中必须保持外观、服装、色彩和比例一致。\n{manifest}";
    }
}
