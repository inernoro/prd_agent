using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services;

/// <summary>
/// 视频生成后台执行器（纯 OpenRouter 直出模式）
///
/// 架构：用户提交 prompt → Worker 调 OpenRouter Veo/Kling/Wan/Sora → 拿到视频 URL 写回 Run.VideoAssetUrl
///
/// 历史：原本支持 Remotion 拆分镜路径（文章→脚本→分镜→Remotion 渲染→拼接），但 docker dev 模式下
/// Remotion + Chromium 部署反复踩坑（apt 安装失败、puppeteer 镜像权限问题、prd-video 源码挂载问题），
/// 2026-04-27 决定彻底砍掉 Remotion 路线，只保留 OpenRouter 直出。
/// </summary>
public class VideoGenRunWorker : BackgroundService
{
    private readonly MongoDbContext _db;
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly IRunEventStore _runStore;
    private readonly ILogger<VideoGenRunWorker> _logger;

    public VideoGenRunWorker(
        MongoDbContext db,
        IServiceScopeFactory scopeFactory,
        IRunEventStore runStore,
        ILogger<VideoGenRunWorker> logger)
    {
        _db = db;
        _scopeFactory = scopeFactory;
        _runStore = runStore;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                var queued = await ClaimQueuedRunAsync(stoppingToken);
                if (queued != null)
                {
                    _logger.LogInformation("[VideoGenWorker] Claimed run: runId={RunId}", queued.Id);
                    try
                    {
                        await ProcessDirectVideoGenAsync(queued);
                    }
                    catch (Exception ex)
                    {
                        _logger.LogError(ex, "VideoGen 直出失败: runId={RunId}", queued.Id);
                        await FailRunAsync(queued, "VIDEOGEN_ERROR", ex.Message);
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

    /// <summary>
    /// 拾取 Queued 任务并直接置为 Rendering（OpenRouter 提交准备）
    /// </summary>
    private async Task<VideoGenRun?> ClaimQueuedRunAsync(CancellationToken ct)
    {
        var fb = Builders<VideoGenRun>.Filter;
        var update = Builders<VideoGenRun>.Update
            .Set(x => x.Status, VideoGenRunStatus.Rendering)
            .Set(x => x.StartedAt, DateTime.UtcNow)
            .Set(x => x.CurrentPhase, "videogen-submitting")
            .Set(x => x.PhaseProgress, 1);

        var run = await _db.VideoGenRuns.FindOneAndUpdateAsync(
            fb.Eq(x => x.Status, VideoGenRunStatus.Queued),
            update,
            new FindOneAndUpdateOptions<VideoGenRun> { ReturnDocument = ReturnDocument.After },
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
    private async Task ProcessDirectVideoGenAsync(VideoGenRun run)
    {
        const string appCallerCode = AppCallerRegistry.VideoAgent.VideoGen.Generate;

        _logger.LogInformation("VideoGen 直出开始: runId={RunId}, userModel={Model}, duration={Duration}s",
            run.Id, run.DirectVideoModel, run.DirectDuration);

        await PublishEventAsync(run.Id, "phase.changed", new { phase = "videogen-submitting", progress = 5 });

        using var scope = _scopeFactory.CreateScope();
        var client = scope.ServiceProvider.GetRequiredService<IOpenRouterVideoClient>();

        // ─── 提交任务 ───
        var prompt = run.DirectPrompt ?? string.Empty;
        if (string.IsNullOrWhiteSpace(prompt))
        {
            await FailRunAsync(run, "EMPTY_PROMPT", "directPrompt 为空，无法生成视频");
            return;
        }

        var submitReq = new OpenRouterVideoSubmitRequest
        {
            AppCallerCode = appCallerCode,
            Model = run.DirectVideoModel, // 用户偏好（可空）；由模型池决定最终选择
            Prompt = prompt,
            AspectRatio = run.DirectAspectRatio,
            Resolution = run.DirectResolution,
            DurationSeconds = run.DirectDuration,
            GenerateAudio = true,
            UserId = run.OwnerAdminId,
            RequestId = run.Id
        };

        var submitResult = await client.SubmitAsync(submitReq, CancellationToken.None);
        if (!submitResult.Success || string.IsNullOrWhiteSpace(submitResult.JobId))
        {
            await FailRunAsync(run, "OPENROUTER_SUBMIT_FAILED",
                submitResult.ErrorMessage ?? "OpenRouter 提交失败");
            return;
        }

        // 把 Gateway 解析出来的实际模型 id 回写到 Run
        if (!string.IsNullOrWhiteSpace(submitResult.ActualModel))
        {
            await _db.VideoGenRuns.UpdateOneAsync(
                x => x.Id == run.Id,
                Builders<VideoGenRun>.Update.Set(x => x.DirectVideoModel, submitResult.ActualModel),
                cancellationToken: CancellationToken.None);
        }

        await _db.VideoGenRuns.UpdateOneAsync(
            x => x.Id == run.Id,
            Builders<VideoGenRun>.Update
                .Set(x => x.DirectVideoJobId, submitResult.JobId)
                .Set(x => x.CurrentPhase, "videogen-polling")
                .Set(x => x.PhaseProgress, 10),
            cancellationToken: CancellationToken.None);

        await PublishEventAsync(run.Id, "phase.changed",
            new { phase = "videogen-polling", progress = 10, jobId = submitResult.JobId });

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

            await Task.Delay(TimeSpan.FromSeconds(pollIntervalSec), CancellationToken.None);

            OpenRouterVideoStatus status;
            try
            {
                status = await client.GetStatusAsync(appCallerCode, submitResult.JobId!, CancellationToken.None);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "VideoGen 轮询异常（继续等待）: runId={RunId}", run.Id);
                continue;
            }

            if (status.IsCompleted && !string.IsNullOrWhiteSpace(status.VideoUrl))
            {
                await _db.VideoGenRuns.UpdateOneAsync(
                    x => x.Id == run.Id,
                    Builders<VideoGenRun>.Update
                        .Set(x => x.Status, VideoGenRunStatus.Completed)
                        .Set(x => x.VideoAssetUrl, status.VideoUrl)
                        .Set(x => x.DirectVideoCost, status.Cost)
                        .Set(x => x.CurrentPhase, "completed")
                        .Set(x => x.PhaseProgress, 100)
                        .Set(x => x.EndedAt, DateTime.UtcNow),
                    cancellationToken: CancellationToken.None);

                await PublishEventAsync(run.Id, "run.completed", new
                {
                    videoUrl = status.VideoUrl,
                    cost = status.Cost
                });

                _logger.LogInformation("VideoGen 直出完成: runId={RunId}, url={Url}, cost=${Cost}",
                    run.Id, status.VideoUrl, status.Cost);
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
                x => x.Id == run.Id,
                Builders<VideoGenRun>.Update.Set(x => x.PhaseProgress, progress),
                cancellationToken: CancellationToken.None);
            await PublishEventAsync(run.Id, "phase.progress",
                new { phase = "videogen-polling", progress, status = status.Status });
        }

        await FailRunAsync(run, "OPENROUTER_TIMEOUT", $"视频生成超过 {maxWaitMinutes} 分钟未完成");
    }

    private async Task FailRunAsync(VideoGenRun run, string errorCode, string errorMessage)
    {
        await _db.VideoGenRuns.UpdateOneAsync(
            x => x.Id == run.Id,
            Builders<VideoGenRun>.Update
                .Set(x => x.Status, VideoGenRunStatus.Failed)
                .Set(x => x.ErrorCode, errorCode)
                .Set(x => x.ErrorMessage, errorMessage)
                .Set(x => x.EndedAt, DateTime.UtcNow),
            cancellationToken: CancellationToken.None);

        await PublishEventAsync(run.Id, "run.error", new { code = errorCode, message = errorMessage });
    }

    private async Task CancelRunAsync(VideoGenRun run)
    {
        await _db.VideoGenRuns.UpdateOneAsync(
            x => x.Id == run.Id,
            Builders<VideoGenRun>.Update
                .Set(x => x.Status, VideoGenRunStatus.Cancelled)
                .Set(x => x.EndedAt, DateTime.UtcNow),
            cancellationToken: CancellationToken.None);

        await PublishEventAsync(run.Id, "run.cancelled", new { });
        _logger.LogInformation("VideoGen 已取消: runId={RunId}", run.Id);
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
}
