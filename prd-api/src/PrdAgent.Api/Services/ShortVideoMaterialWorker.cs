using PrdAgent.Core.Security;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Configuration;
using MongoDB.Driver;
using MongoDB.Bson;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Security;
using PrdAgent.Infrastructure.Services.AssetStorage;

namespace PrdAgent.Api.Services;

/// <summary>
/// 短视频素材解析后台 Worker。遵循服务器权威性：HTTP 只创建 run，实际解析和入库由 Worker 持续推进。
/// </summary>
public sealed class ShortVideoMaterialWorker : BackgroundService
{
    private static readonly TimeSpan ScanInterval = TimeSpan.FromSeconds(2);
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly ILogger<ShortVideoMaterialWorker> _logger;
    private string? _currentRunId;
    private ShortVideoMaterialRun? _currentRun;

    public ShortVideoMaterialWorker(IServiceScopeFactory scopeFactory, ILogger<ShortVideoMaterialWorker> logger)
    {
        _scopeFactory = scopeFactory;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _logger.LogInformation("[short-video-material] Worker started");
        await RecoverRunningRunsAsync();

        var loopCount = 0;
        try
        {
            while (!stoppingToken.IsCancellationRequested)
            {
                try
                {
                    await ProcessNextRunAsync();
                    // 每约 60s 扫一次"卡死的 running"——RecoverRunningRunsAsync 只在启动时跑一次，
                    // 不重启就永远不回收。没有这道周期性兜底，任何因竞态/中途部署/默认值落进 running
                    // 却没人处理的 run 会永远卡在"处理中"，用户侧表现为"加了链接半天没反应"。
                    if (loopCount % 30 == 0) await RecoverStaleRunningRunsAsync();
                    loopCount++;
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "[short-video-material] Worker loop error");
                }
                await Task.Delay(ScanInterval, stoppingToken);
            }
        }
        finally
        {
            await MarkCurrentRunFailedAsync("Worker 关闭，短视频解析任务被中断");
        }
    }

    private async Task RecoverRunningRunsAsync()
    {
        try
        {
            using var scope = _scopeFactory.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<MongoDbContext>();
            // 回收范围 = 本实例 running + 历史无主 running（OwnerInstanceId 空）。
            // 无主 running 只可能由「定向消费上线前的旧代码」产生：旧代码不打 owner，
            // 容器退出后永远没人回收、永卡 running。一并回收是一次性过渡兜底（上线后新 run
            // 认领即打主，不再产生无主 running）。代价：若另一实例此刻在跑某个无主 running 会被
            // 误判失败——但无主 = 旧代码遗留，归属本不可分辨，过渡期代价可接受（Bugbot Medium）。
            var configuration = scope.ServiceProvider.GetRequiredService<IConfiguration>();
            var instanceId = InstanceIdentity.Get(configuration);
            var compatibleOwnerIds = InstanceIdentity.GetCompatibleOwnerIds(configuration);
            var ownerScope = LegacyOwnerScope.Build<ShortVideoMaterialRun>(
                nameof(ShortVideoMaterialRun.OwnerInstanceId),
                compatibleOwnerIds,
                includeUnowned: true,
                retiredLegacyOwnerIds: DeploymentAuthority.GetRetiredLegacyBranchOwnerIds(configuration),
                legacyOwnerCreatedBeforeUtc: DeploymentAuthority.GetRetiredLegacyBranchOwnerCreatedBeforeUtc(configuration));
            var recoverFilter = Builders<ShortVideoMaterialRun>.Filter.And(
                Builders<ShortVideoMaterialRun>.Filter.Eq(r => r.Status, "running"),
                ownerScope);
            await RecoverArtifactRunsAsync(scope.ServiceProvider, db, recoverFilter,
                ErrorCodes.SHORT_VIDEO_INTERRUPTED, "服务重启，短视频解析任务被中断", instanceId);
            var recovered = await db.ShortVideoMaterialRuns.UpdateManyAsync(
                recoverFilter & Builders<ShortVideoMaterialRun>.Filter.Ne(r => r.CancelRequested, true),
                Builders<ShortVideoMaterialRun>.Update
                    .Set(r => r.Status, "failed")
                    .Set(r => r.ProcessingToken, (string?)null)
                    .Set(r => r.OwnerInstanceId, instanceId)
                    .Set(r => r.ErrorCode, ErrorCodes.SHORT_VIDEO_INTERRUPTED)
                    .Set(r => r.ErrorMessage, "服务重启，短视频解析任务被中断")
                    .Set(r => r.UpdatedAt, DateTime.UtcNow),
                cancellationToken: CancellationToken.None);
            await AcknowledgeCancelledAsync(db, recoverFilter);
            if (recovered.ModifiedCount > 0)
                _logger.LogWarning("[short-video-material] 启动兜底：{Count} 个残留 running run 标记为失败", recovered.ModifiedCount);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[short-video-material] 启动兜底回收失败");
        }
    }

    /// <summary>
    /// 周期性兜底：把"卡死的 running"标记为失败，让前端自愈成"解析失败，可重试"。
    /// 判定 = status==running 且 updatedAt 超过阈值未推进（每个 stage 推进都会刷新 updatedAt，
    /// 正常处理不会触发；阈值取 15 分钟，长于 ASR 600s 超时 + 下载余量，避免误杀在跑的任务），
    /// 且不是本实例当前正在处理的那个，归属本实例（或历史无主）。根治"加了链接半天没反应"。
    /// </summary>
    private async Task RecoverStaleRunningRunsAsync()
    {
        try
        {
            using var scope = _scopeFactory.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<MongoDbContext>();
            var configuration = scope.ServiceProvider.GetRequiredService<IConfiguration>();
            var instanceId = InstanceIdentity.Get(configuration);
            var compatibleOwnerIds = InstanceIdentity.GetCompatibleOwnerIds(configuration);
            var ownerScope = LegacyOwnerScope.Build<ShortVideoMaterialRun>(
                nameof(ShortVideoMaterialRun.OwnerInstanceId),
                compatibleOwnerIds,
                includeUnowned: true,
                retiredLegacyOwnerIds: DeploymentAuthority.GetRetiredLegacyBranchOwnerIds(configuration),
                legacyOwnerCreatedBeforeUtc: DeploymentAuthority.GetRetiredLegacyBranchOwnerCreatedBeforeUtc(configuration));
            var cutoff = DateTime.UtcNow - TimeSpan.FromMinutes(15);
            var current = _currentRunId ?? "";
            var filter = Builders<ShortVideoMaterialRun>.Filter.And(
                Builders<ShortVideoMaterialRun>.Filter.Eq(r => r.Status, "running"),
                Builders<ShortVideoMaterialRun>.Filter.Lt(r => r.UpdatedAt, cutoff),
                Builders<ShortVideoMaterialRun>.Filter.Ne(r => r.Id, current),
                ownerScope);
            await RecoverArtifactRunsAsync(scope.ServiceProvider, db, filter,
                ErrorCodes.SHORT_VIDEO_TIMEOUT, "处理超时或中断，请重试", instanceId);
            var res = await db.ShortVideoMaterialRuns.UpdateManyAsync(
                filter & Builders<ShortVideoMaterialRun>.Filter.Ne(r => r.CancelRequested, true),
                Builders<ShortVideoMaterialRun>.Update
                    .Set(r => r.Status, "failed")
                    .Set(r => r.ProcessingToken, (string?)null)
                    .Set(r => r.OwnerInstanceId, instanceId)
                    .Set(r => r.ErrorCode, ErrorCodes.SHORT_VIDEO_TIMEOUT)
                    .Set(r => r.ErrorMessage, "处理超时或中断，请重试")
                    .Set(r => r.UpdatedAt, DateTime.UtcNow),
                cancellationToken: CancellationToken.None);
            await AcknowledgeCancelledAsync(db, filter);
            if (res.ModifiedCount > 0)
                _logger.LogWarning("[short-video-material] 周期兜底：{Count} 个卡死 running run 标记为失败", res.ModifiedCount);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[short-video-material] 周期兜底回收失败");
        }
    }

    private static async Task RecoverArtifactRunsAsync(IServiceProvider services, MongoDbContext db,
        FilterDefinition<ShortVideoMaterialRun> recoveryFilter, string code, string message, string instanceId)
    {
        var candidates = await db.ShortVideoMaterialRuns.Find(recoveryFilter
            & Builders<ShortVideoMaterialRun>.Filter.Eq(x => x.CleanupPending, true)
            & Builders<ShortVideoMaterialRun>.Filter.Ne(x => x.ArtifactReceipt, null)
            & Builders<ShortVideoMaterialRun>.Filter.Ne(x => x.ProcessingToken, null)).ToListAsync(CancellationToken.None);
        if (candidates.Count == 0) return;
        var processor = services.GetRequiredService<ShortVideoMaterialProcessor>();
        foreach (var run in candidates)
            await processor.RecoverInterruptedArtifactsAsync(run, recoveryFilter, code, message, instanceId);
    }

    private async Task MarkCurrentRunFailedAsync(string message)
    {
        var currentRun = _currentRun;
        if (currentRun is null) return;
        try
        {
            using var scope = _scopeFactory.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<MongoDbContext>();
            await AcknowledgeCancelledAsync(db, ShortVideoMaterialProcessor.ActiveRunFilter(currentRun), many: false);
            await db.ShortVideoMaterialRuns.UpdateOneAsync(
                ShortVideoMaterialProcessor.ActiveRunFilter(currentRun)
                    & Builders<ShortVideoMaterialRun>.Filter.Ne(r => r.CancelRequested, true),
                Builders<ShortVideoMaterialRun>.Update
                    .Set(r => r.Status, "failed")
                    .Set(r => r.ProcessingToken, (string?)null)
                    .Set(r => r.ErrorCode, ErrorCodes.SHORT_VIDEO_INTERRUPTED)
                    .Set(r => r.ErrorMessage, message)
                    .Set(r => r.UpdatedAt, DateTime.UtcNow),
                cancellationToken: CancellationToken.None);
        }
        catch { /* ignore */ }
    }

    private static Task<UpdateResult> AcknowledgeCancelledAsync(MongoDbContext db, FilterDefinition<ShortVideoMaterialRun> identity, bool many = true)
    {
        var filter = identity & Builders<ShortVideoMaterialRun>.Filter.Eq(r => r.CancelRequested, true);
        var update = Builders<ShortVideoMaterialRun>.Update.Set(r => r.Status, "cancelled")
            .Set(r => r.ProcessingToken, (string?)null).Set(r => r.ErrorCode, (string?)null)
            .Set(r => r.ErrorMessage, "已取消短视频素材处理").Set(r => r.UpdatedAt, DateTime.UtcNow);
        return many ? db.ShortVideoMaterialRuns.UpdateManyAsync(filter, update, cancellationToken: CancellationToken.None)
            : db.ShortVideoMaterialRuns.UpdateOneAsync(filter, update, cancellationToken: CancellationToken.None);
    }

    private async Task ProcessNextRunAsync()
    {
        using var scope = _scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MongoDbContext>();
        var processor = scope.ServiceProvider.GetRequiredService<ShortVideoMaterialProcessor>();

        // 定向消费：只领取属于本实例（或历史无主）的 queued 任务，避免共享 Mongo 下多容器互抢。
        var configuration = scope.ServiceProvider.GetRequiredService<IConfiguration>();
        var instanceId = InstanceIdentity.Get(configuration);
        var compatibleOwnerIds = InstanceIdentity.GetCompatibleOwnerIds(configuration);
        var ownerScope = LegacyOwnerScope.Build<ShortVideoMaterialRun>(
            nameof(ShortVideoMaterialRun.OwnerInstanceId),
            compatibleOwnerIds,
            includeUnowned: true,
            retiredLegacyOwnerIds: DeploymentAuthority.GetRetiredLegacyBranchOwnerIds(configuration),
            legacyOwnerCreatedBeforeUtc: DeploymentAuthority.GetRetiredLegacyBranchOwnerCreatedBeforeUtc(configuration));
        await AcknowledgeCancelledAsync(db, ownerScope
            & Builders<ShortVideoMaterialRun>.Filter.Eq(r => r.Status, "queued")
            & Builders<ShortVideoMaterialRun>.Filter.Eq(r => r.ProcessingToken, null));
        var run = await db.ShortVideoMaterialRuns.FindOneAndUpdateAsync(
            Builders<ShortVideoMaterialRun>.Filter.And(
                Builders<ShortVideoMaterialRun>.Filter.Eq(r => r.Status, "queued"),
                Builders<ShortVideoMaterialRun>.Filter.Ne(r => r.CancelRequested, true),
                Builders<ShortVideoMaterialRun>.Filter.Ne(r => r.CleanupPending, true),
                ownerScope),
            Builders<ShortVideoMaterialRun>.Update
                .Set(r => r.Status, "running")
                .Set(r => r.ProcessingToken, Guid.NewGuid().ToString("N"))
                .Set(r => r.ErrorCode, (string?)null)
                .Set(r => r.ErrorMessage, (string?)null)
                // 认领时盖上本实例归属（领取历史无主任务后必须打主，否则崩溃重启兜底匹配不到、永卡 running，Bugbot Medium）
                .Set(r => r.OwnerInstanceId, instanceId)
                .Set(r => r.UpdatedAt, DateTime.UtcNow),
            new FindOneAndUpdateOptions<ShortVideoMaterialRun>
            {
                Sort = Builders<ShortVideoMaterialRun>.Sort.Ascending(r => r.CreatedAt),
                ReturnDocument = ReturnDocument.After,
            },
            cancellationToken: CancellationToken.None);
        if (run == null) return;

        _currentRunId = run.Id;
        _currentRun = run;
        try
        {
            // 不用 WaitAsync 套超时:那只会让 await 提前返回、原 ProcessAsync 仍在后台跑(无 ct
            // 不可取消),可能稍后又把 run 写成 done 与"超时失败"冲突(Bugbot High),也违反
            // server-authority"不中途取消服务端任务"。改为依赖各外部调用自身超时(resolve 30s/
            // 下载 180s/ASR 600s 已有界)+ 周期兜底(RecoverStaleRunningRunsAsync 15min)托底。
            await processor.ProcessAsync(run.Id);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[short-video-material] Process failed run={RunId}", run.Id);
            // 取消与失败写回竞争时，只能更新刚读到的取消状态；新处理身份始终不受影响。
            for (var attempt = 0; attempt < 2; attempt++)
            {
                var latest = await db.ShortVideoMaterialRuns.Find(ShortVideoMaterialProcessor.ActiveRunFilter(run)).FirstOrDefaultAsync(CancellationToken.None);
                if (latest == null) break;
                var cancelled = latest.CancelRequested;
                latest.Status = cancelled ? "cancelled" : "failed";
                latest.ProcessingToken = null;
                latest.ErrorCode = cancelled ? null : ErrorCodes.INTERNAL_ERROR;
                latest.ErrorMessage = cancelled ? "已取消短视频素材处理" : ex.Message;
                ShortVideoMaterialProcessor.MarkFirstRunningStageFailed(latest, latest.ErrorMessage);
                latest.UpdatedAt = DateTime.UtcNow;
                var cancellationState = cancelled ? Builders<ShortVideoMaterialRun>.Filter.Eq(r => r.CancelRequested, true)
                    : Builders<ShortVideoMaterialRun>.Filter.Ne(r => r.CancelRequested, true);
                var saved = await db.ShortVideoMaterialRuns.ReplaceOneAsync(
                    ShortVideoMaterialProcessor.ActiveRunFilter(run) & cancellationState, latest, cancellationToken: CancellationToken.None);
                if (saved.MatchedCount == 1) break;
            }
        }
        finally
        {
            _currentRunId = null;
            _currentRun = null;
        }
    }
}

public sealed class ShortVideoMaterialProcessor
{
    private readonly ITaskExecutionCoordinator? _taskExecutions;
    private readonly MongoDbContext _db;
    private readonly IDocumentService _documentService;
    private readonly IConfiguration _config;
    private readonly IServiceProvider _serviceProvider;
    private readonly ILogger<ShortVideoMaterialProcessor> _logger;

    public ShortVideoMaterialProcessor(
        MongoDbContext db,
        IDocumentService documentService,
        IConfiguration config,
        IServiceProvider serviceProvider,
        ILogger<ShortVideoMaterialProcessor> logger, ITaskExecutionCoordinator? taskExecutions = null)
    {
        _db = db;
        _documentService = documentService;
        _config = config;
        _serviceProvider = serviceProvider;
        _taskExecutions = taskExecutions;
        _logger = logger;
    }

    public async Task ProcessAsync(string runId)
    {
        var run = await _db.ShortVideoMaterialRuns.Find(r => r.Id == runId).FirstOrDefaultAsync(CancellationToken.None)
                  ?? throw new InvalidOperationException("短视频解析运行记录不存在");
        var identity = new ShortVideoMaterialRun { Id = run.Id, UserId = run.UserId, OwnerInstanceId = run.OwnerInstanceId,
            TaskPermitId = run.TaskPermitId, ProcessingToken = run.ProcessingToken };
        try
        {
            await using var taskExecutionAttempt = await TaskExecutionAttempt.AcquireAsync(_taskExecutions, run.TaskPermitId, run.Id);
            // Worker 已领取并绑定处理身份；许可不可用也须走它的受控收尾，不能留下 running。
            if (taskExecutionAttempt.ShouldSkip)
                throw new InvalidOperationException("本次处理未能取得执行许可，已停止继续处理");
            using var taskExecutionScope = TaskExecutionContext.Enter(taskExecutionAttempt.Lease?.Identity
                ?? TaskExecutionContext.ForRun(run.TaskPermitId, run.Id));
            using var authorityStop = CancellationTokenSource.CreateLinkedTokenSource(taskExecutionAttempt.Lease?.LostToken ?? CancellationToken.None);
            using var monitorStop = new CancellationTokenSource();
            var monitor = WatchProcessingAuthorityAsync(run, authorityStop, monitorStop.Token);
            try { await ProcessCoreAsync(run, authorityStop.Token); }
            finally
            {
                monitorStop.Cancel();
                await monitor;
            }
        }
        catch
        {
            // 原执行作用域已经退出；补偿仍通过原数据库包装器和原任务条件，不恢复已结束的执行租约。
            try { await CleanupArtifactsAfterFailureAsync(run, identity); }
            catch (Exception ex) { _logger.LogError(ex, "短视频产物补偿未确认 run={RunId}", run.Id); }
            throw;
        }
    }

    private async Task WatchProcessingAuthorityAsync(ShortVideoMaterialRun run, CancellationTokenSource authorityStop, CancellationToken stop)
    {
        var expectedProcessing = ContinuableRunFilter(run);
        try
        {
            while (!stop.IsCancellationRequested)
            {
                try
                {
                    if (await _db.ShortVideoMaterialRuns.Find(expectedProcessing).FirstOrDefaultAsync(CancellationToken.None) == null)
                    {
                        authorityStop.Cancel();
                        return;
                    }
                }
                catch (Exception ex)
                {
                    // 查询失败是未知状态，不是用户取消；平台 LostToken 和阶段前核对仍独立生效。
                    _logger.LogWarning(ex, "短视频处理身份暂未核对，稍后重试 run={RunId}", run.Id);
                }
                await Task.Delay(TimeSpan.FromSeconds(1), stop);
            }
        }
        catch (OperationCanceledException) when (stop.IsCancellationRequested) { }
    }

    private async Task EnsureProcessingAuthorityAsync(ShortVideoMaterialRun run, CancellationToken authorityToken)
    {
        authorityToken.ThrowIfCancellationRequested();
        if (await _db.ShortVideoMaterialRuns.Find(ContinuableRunFilter(run)).FirstOrDefaultAsync(CancellationToken.None) == null)
            throw new OperationCanceledException("短视频处理已取消或处理身份已变化", authorityToken);
    }

    private async Task ProcessCoreAsync(ShortVideoMaterialRun run, CancellationToken authorityToken)
    {
        await EnsureProcessingAuthorityAsync(run, authorityToken);
        var user = await _db.Users.Find(u => u.UserId == run.UserId).FirstOrDefaultAsync(CancellationToken.None);
        var userName = string.IsNullOrWhiteSpace(user?.DisplayName) ? user?.Username ?? run.UserId : user.DisplayName!;
        var now = DateTime.UtcNow;

        // 进入解析就把 parse 标成 running 并落库：一是让前端立刻看到"正在解析"而不是僵在 pending
        // （否则用户感觉"一点反应都没有"），二是刷新 updatedAt 作为心跳，配合周期兜底判活。
        MarkStage(run, "parse", "running", "正在解析短视频链接…");
        await SaveRunAsync(run);

        var parsed = await ResolveParsedSourceAsync(run.VideoUrl, run.Platform, run.InputSourceText, run.RequestedTitle);
        await EnsureProcessingAuthorityAsync(run, authorityToken);
        var title = CleanTitle(run.RequestedTitle) ?? CleanTitle(parsed.Title) ?? run.Title;
        run.Title = title;
        run.SourceMode = parsed.SourceMode;
        run.ParsedMetadataJson = parsed.MetadataJson;
        run.ParserMessage = parsed.Message;
        run.Card = BuildShortVideoCard(parsed.MetadataJson, title, run.Platform, parsed.CoverUrl);
        MarkStage(run, "parse", "done", parsed.Message);
        await SaveRunAsync(run);

        var store = await ResolveStoreAsync(run.StoreId, run.UserId);
        await EnsureProcessingAuthorityAsync(run, authorityToken);
        run.StoreId = store.Id;
        MarkStage(run, "source", "running", $"正在把视频文件保存到知识库「{store.Name}」");
        await SaveRunAsync(run);

        var videoMaterial = await DownloadVideoMaterialAsync(parsed, run, authorityToken);
        await EnsureProcessingAuthorityAsync(run, authorityToken);
        var sourceEntry = await CreateVideoEntryAsync(
            store,
            run.UserId,
            userName,
            title,
            videoMaterial,
            parsed,
            run.VideoUrl,
            run.Platform,
            run,
            now);
        run.SourceEntryId = sourceEntry.Id;
        await EnsureProcessingAuthorityAsync(run, authorityToken);
        run.SourceVideoUrl = videoMaterial.Url;
        if (run.Card != null)
            run.Card.VideoUrl = videoMaterial.Url; // 入库后改用 COS 永久地址播放
        MarkStage(run, "source", "done", "原始视频已作为知识库文件入库");
        await SaveRunAsync(run);

        MarkStage(run, "transcript", "running", "正在从已入库视频执行 ASR 转写");
        await SaveRunAsync(run);

        var transcriptAttempt = parsed.SourceMode == "manual"
            ? new VideoTranscriptionAttempt(parsed.SourceText, null)
            : await TryTranscribeVideoAsync(videoMaterial.Url, title, authorityToken);
        await EnsureProcessingAuthorityAsync(run, authorityToken);
        if (!string.IsNullOrWhiteSpace(transcriptAttempt.Text))
        {
            var transcriptEntry = await CreateMarkdownEntryAsync(
                store,
                run.UserId,
                userName,
                $"{title} · 原始转写文字.md",
                BuildTranscriptMarkdown(title, run.VideoUrl, run.Platform, transcriptAttempt.Text),
                $"{title}：短视频原始转写文字",
                new List<string> { "短视频", "转写", "原始文字", run.Platform },
                new Dictionary<string, string>
                {
                    ["kind"] = "short-video-transcript",
                    ["runId"] = run.Id,
                    ["sourceEntryId"] = sourceEntry.Id,
                    ["videoUrl"] = run.VideoUrl,
                    ["assetUrl"] = videoMaterial.Url,
                    ["platform"] = run.Platform,
                    ["sourceMode"] = "asr",
                },
                now,
                run);
            run.TranscriptEntryId = transcriptEntry.Id;
            await EnsureProcessingAuthorityAsync(run, authorityToken);
            run.EntryId = transcriptEntry.Id;
            MarkStage(run, "transcript", "done", "已从视频转写出原始文字并保存到知识库");
            MarkStage(run, "ready", "done", "视频和原始文字已就绪，可继续转文案、润色或整理时间线");
        }
        else
        {
            run.EntryId = sourceEntry.Id;
            var failedMessage = string.IsNullOrWhiteSpace(transcriptAttempt.ErrorMessage)
                ? "未获得真实转写文字，已停止生成文字条目，避免把平台描述当成字幕"
                : $"真实转写失败：{transcriptAttempt.ErrorMessage}。已停止生成文字条目，避免把平台描述当成字幕";
            MarkStage(run, "transcript", "failed", failedMessage);
            MarkStage(run, "ready", "done", "视频已入库；文字、文案和时间线需要后续通过转写或人工补充继续加工");
        }

        run.Status = "done";
        run.CleanupPending = false;
        if (run.ArtifactReceipt != null) run.ArtifactReceipt.PhysicalState = "linked";
        run.UpdatedAt = DateTime.UtcNow;
        await SaveRunAsync(run);
    }

    private async Task<DocumentEntry> CreateVideoEntryAsync(
        DocumentStore store,
        string userId,
        string userName,
        string title,
        DownloadedVideoMaterial video,
        ParsedShortVideoSource parsed,
        string originalUrl,
        string platform,
        ShortVideoMaterialRun run,
        DateTime now)
    {
        var fileName = BuildVideoFileName(title, video.MimeType);
        var attachment = new Attachment
        {
            UploaderId = userId,
            FileName = fileName,
            MimeType = string.IsNullOrWhiteSpace(video.MimeType) ? "video/mp4" : video.MimeType,
            Size = video.FileSize,
            Url = video.Url,
            Type = AttachmentType.Document,
            UploadedAt = now,
        };
        var entry = new DocumentEntry
        {
            StoreId = store.Id,
            AttachmentId = attachment.AttachmentId,
            Title = fileName,
            Summary = $"{title}：原始短视频文件",
            SourceType = DocumentSourceType.Upload,
            ContentType = attachment.MimeType,
            FileSize = attachment.Size,
            Tags = new List<string> { "短视频", "视频", "原始视频", platform },
            Metadata = new Dictionary<string, string>
            {
                ["kind"] = "short-video-video",
                ["runId"] = run.Id,
                ["originalShareUrl"] = originalUrl,
                ["assetUrl"] = video.Url,
                ["platform"] = platform,
                ["sourceMode"] = parsed.SourceMode,
            },
            CreatedBy = userId,
            CreatedByName = userName,
            UpdatedBy = userId,
            UpdatedByName = userName,
            ContentIndex = BuildVideoIndex(title, originalUrl, platform, parsed),
            LastChangedAt = now,
            CreatedAt = now,
            UpdatedAt = now,
        };
        if (!string.IsNullOrWhiteSpace(parsed.CoverUrl))
            entry.Metadata["coverUrl"] = parsed.CoverUrl!;

        var receipt = GetArtifactReceipt(run);
        receipt.Url ??= video.Url;
        var planned = new ShortVideoMaterialEntryReceipt { EntryId = entry.Id, StoreId = store.Id,
            EntryCreatedAt = entry.UpdatedAt, AttachmentId = attachment.AttachmentId, UnconfirmedWrite = true };
        receipt.Entries.Add(planned);
        run.CleanupPending = true;
        // 持久化写入意图；明确的 CAS 拒绝证明未开始元数据写入，未知回执则必须保留。
        await SaveRunWithIntentAsync(run, () => planned.UnconfirmedWrite = false);
        receipt.PublicationStarted = true;
        await _db.Attachments.InsertOneAsync(attachment, cancellationToken: CancellationToken.None);
        await IncrementStoreDocumentCountAsync(store, entry.Id);
        await _db.DocumentEntries.InsertOneAsync(entry, cancellationToken: CancellationToken.None);
        planned.UnconfirmedWrite = false;
        return entry;
    }

    private async Task IncrementStoreDocumentCountAsync(DocumentStore store, string entryId)
    {
        var counted = await _db.DocumentStores.UpdateOneAsync(
            Builders<DocumentStore>.Filter.Eq(s => s.Id, store.Id)
                & Builders<DocumentStore>.Filter.Eq(s => s.OwnerId, store.OwnerId)
                & Builders<DocumentStore>.Filter.Ne(CountedEntryIdsField, entryId),
            Builders<DocumentStore>.Update
                .Inc(s => s.DocumentCount, 1)
                .AddToSet(CountedEntryIdsField, entryId)
                .Set(s => s.PrimaryEntryId, string.IsNullOrEmpty(store.PrimaryEntryId) ? entryId : store.PrimaryEntryId)
                .Set(s => s.UpdatedAt, DateTime.UtcNow),
            cancellationToken: CancellationToken.None);
        if (counted.MatchedCount != 1 && await _db.DocumentStores.CountDocumentsAsync(
            Builders<DocumentStore>.Filter.Eq(x => x.Id, store.Id) & Builders<DocumentStore>.Filter.Eq(x => x.OwnerId, store.OwnerId)
                & Builders<DocumentStore>.Filter.Eq(CountedEntryIdsField, entryId)) != 1)
            throw new InvalidOperationException("目标文档空间状态已变化，已停止保存并保留产物责任记录");
        if (string.IsNullOrEmpty(store.PrimaryEntryId))
            store.PrimaryEntryId = entryId;
    }

    private async Task<DownloadedVideoMaterial> DownloadVideoMaterialAsync(ParsedShortVideoSource parsed, ShortVideoMaterialRun run, CancellationToken authorityToken)
    {
        var videoUrl = RequireResolvedVideoUrl(parsed.VideoUrl);

        var node = new WorkflowNode
        {
            NodeId = "short-video-download",
            Name = "短视频下载",
            NodeType = CapsuleTypes.VideoDownloader,
            Config = new Dictionary<string, object?>
            {
                ["videoUrl"] = videoUrl,
                ["timeoutSeconds"] = 180,
            },
        };
        var result = await CapsuleExecutor.ExecuteVideoDownloaderAsync(
            _serviceProvider,
            node,
            new Dictionary<string, string>(),
            new List<ExecutionArtifact>(),
            new WorkflowDesignInvocation(run.UserId, run.Id, node.NodeId, run.Id, run.UserId), authorityToken,
            (bytes, mime) => StoreAttemptVideoAsync(run, bytes, mime, authorityToken));
        return ExtractDownloadedVideo(result.Artifacts.FirstOrDefault()?.InlineContent);
    }

    private async Task<VideoTranscriptionAttempt> TryTranscribeVideoAsync(string videoUrl, string title, CancellationToken authorityToken)
    {
        try
        {
            var node = new WorkflowNode
            {
                NodeId = "short-video-asr",
                Name = "视频转文字",
                NodeType = CapsuleTypes.VideoToText,
                Config = new Dictionary<string, object?>
                {
                    ["extractMode"] = "asr",
                    ["videoUrlField"] = "videoUrl",
                    ["enableHookExtraction"] = false,
                    ["maxItems"] = 1,
                },
            };
            var input = JsonSerializer.Serialize(new { title, videoUrl });
            var result = await CapsuleExecutor.ExecuteVideoToTextAsync(
                _serviceProvider,
                node,
                new Dictionary<string, string>(),
                new List<ExecutionArtifact>
                {
                    new()
                    {
                        SlotId = "vt-in",
                        Name = "已入库视频",
                        MimeType = "application/json",
                        InlineContent = input,
                    },
                },
                null, authorityToken);
            var text = ExtractTranscript(result.Artifacts.FirstOrDefault()?.InlineContent);
            return string.IsNullOrWhiteSpace(text)
                ? new VideoTranscriptionAttempt(null, "ASR 模型未返回可用文字")
                : new VideoTranscriptionAttempt(text, null);
        }
        catch (OperationCanceledException) when (authorityToken.IsCancellationRequested) { throw; }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "短视频 ASR 转写失败 videoUrl={VideoUrl}", videoUrl);
            return new VideoTranscriptionAttempt(null, SimplifyTranscriptionError(ex.Message));
        }
    }

    private static string SimplifyTranscriptionError(string message)
    {
        if (string.IsNullOrWhiteSpace(message)) return "ASR 服务不可用";
        if (message.Contains("无法解密") || message.Contains("decrypt", StringComparison.OrdinalIgnoreCase))
            return "ASR 模型凭据不可用";
        if (message.Contains("Gateway ASR 调用失败"))
            return "ASR 模型调用失败";
        if (message.Contains("模型调度失败"))
            return "ASR 模型调度失败";
        return message.Length > 120 ? message[..120] : message;
    }

    private static DownloadedVideoMaterial ExtractDownloadedVideo(string? json)
    {
        if (string.IsNullOrWhiteSpace(json))
            throw new InvalidOperationException("视频下载器未返回入库地址");
        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            var url = GetJsonString(root, "cosUrl", "url");
            if (string.IsNullOrWhiteSpace(url))
                throw new InvalidOperationException("视频下载器未返回入库地址");
            var sizeRaw = GetJsonString(root, "fileSize", "size");
            long.TryParse(sizeRaw, out var fileSize);
            return new DownloadedVideoMaterial(
                url,
                GetJsonString(root, "mimeType") ?? "video/mp4",
                fileSize,
                GetJsonString(root, "sha256"));
        }
        catch (JsonException ex)
        {
            throw new InvalidOperationException($"视频下载器返回格式错误: {ex.Message}");
        }
    }

    internal static string BuildVideoFileName(string title, string? mimeType)
    {
        var safe = Regex.Replace(title.Trim(), @"[\\/:*?""<>|\r\n]+", " ");
        safe = Regex.Replace(safe, @"\s+", " ").Trim();
        if (string.IsNullOrWhiteSpace(safe)) safe = "短视频素材";
        if (safe.Length > 60) safe = safe[..60].Trim();
        var extension = (mimeType ?? string.Empty).Trim().ToLowerInvariant() switch
        {
            "video/mp4" => "mp4",
            "video/x-m4v" => "m4v",
            "video/quicktime" => "mov",
            "video/webm" => "webm",
            "video/x-matroska" => "mkv",
            "video/x-msvideo" => "avi",
            _ => throw new InvalidOperationException(
                $"下载的视频格式不受支持（{mimeType ?? "未知"}），请改用 MP4、MOV、WebM、MKV 或 AVI 文件"),
        };
        return $"{safe}.{extension}";
    }

    private static string BuildVideoIndex(string title, string originalUrl, string platform, ParsedShortVideoSource parsed)
    {
        var sb = new StringBuilder();
        sb.AppendLine(title);
        sb.AppendLine($"来源平台：{platform}");
        sb.AppendLine($"原始链接：{originalUrl}");
        sb.AppendLine("素材类型：原始短视频文件");
        if (!string.IsNullOrWhiteSpace(parsed.Title) && parsed.Title != title)
            sb.AppendLine($"解析标题：{parsed.Title}");
        return sb.ToString();
    }

    private async Task<DocumentStore> ResolveStoreAsync(string? storeId, string userId)
    {
        if (!string.IsNullOrWhiteSpace(storeId))
        {
            var existing = await _db.DocumentStores
                .Find(s => s.Id == storeId && s.OwnerId == userId)
                .FirstOrDefaultAsync(CancellationToken.None);
            if (existing == null)
                throw new InvalidOperationException("目标知识库不存在或不可写");
            return existing;
        }

        const string storeName = "短视频素材库";
        var store = await _db.DocumentStores
            .Find(s => s.OwnerId == userId && s.Name == storeName)
            .FirstOrDefaultAsync(CancellationToken.None);
        if (store != null) return store;

        var now = DateTime.UtcNow;
        store = new DocumentStore
        {
            Name = storeName,
            Description = "保存短视频原始视频、真实转写文字与后续加工资产",
            OwnerId = userId,
            AppKey = "document-store",
            Tags = new List<string> { "短视频", "素材", "加工台" },
            CreatedAt = now,
            UpdatedAt = now,
        };
        await _db.DocumentStores.InsertOneAsync(store, cancellationToken: CancellationToken.None);
        return store;
    }

    private async Task<DocumentEntry> CreateMarkdownEntryAsync(
        DocumentStore store,
        string userId,
        string userName,
        string title,
        string markdown,
        string summary,
        List<string> tags,
        Dictionary<string, string> metadata,
        DateTime now,
        ShortVideoMaterialRun run)
    {
        var parsed = await _documentService.ParseAsync(markdown);
        // 解析器的内容哈希可能属于共享正文；本次补偿只拥有独立新记录，不覆盖共享正文。
        parsed.Id = Guid.NewGuid().ToString("N");
        parsed.Title = title;
        var entry = new DocumentEntry
        {
            StoreId = store.Id,
            DocumentId = parsed.Id,
            Title = title,
            Summary = summary,
            SourceType = DocumentSourceType.Import,
            ContentType = "text/markdown",
            FileSize = Encoding.UTF8.GetByteCount(markdown),
            Tags = tags,
            Metadata = metadata,
            CreatedBy = userId,
            CreatedByName = userName,
            UpdatedBy = userId,
            UpdatedByName = userName,
            ContentIndex = markdown.Length > 2000 ? markdown[..2000] : markdown,
            LastChangedAt = now,
            CreatedAt = now,
            UpdatedAt = now,
        };
        var planned = new ShortVideoMaterialEntryReceipt { EntryId = entry.Id, StoreId = store.Id, EntryCreatedAt = entry.UpdatedAt, DocumentId = parsed.Id,
            DocumentCreatedNew = true };
        planned.UnconfirmedWrite = true;
        GetArtifactReceipt(run).Entries.Add(planned);
        run.CleanupPending = true;
        await SaveRunWithIntentAsync(run, () => planned.UnconfirmedWrite = false);
        await _documentService.SaveAsync(parsed);
        await IncrementStoreDocumentCountAsync(store, entry.Id);
        planned.DocumentPublicationStarted = true;
        await SaveRunWithIntentAsync(run, () => { planned.DocumentPublicationStarted = false; planned.UnconfirmedWrite = false; });
        await _db.DocumentEntries.InsertOneAsync(entry, cancellationToken: CancellationToken.None);
        planned.UnconfirmedWrite = false;
        return entry;
    }

    private static ShortVideoMaterialArtifactReceipt GetArtifactReceipt(ShortVideoMaterialRun run)
    {
        if (string.IsNullOrWhiteSpace(run.ProcessingToken))
            throw new InvalidOperationException("素材处理身份未确认，已停止继续保存产物");
        var receipt = run.ArtifactReceipt ??= new() { ProcessingToken = run.ProcessingToken };
        if (!string.Equals(receipt.ProcessingToken, run.ProcessingToken, StringComparison.Ordinal))
            throw new InvalidOperationException("此前产物责任尚未确认，请先查看原任务处理结果");
        return receipt;
    }

    private async Task<StoredAsset> StoreAttemptVideoAsync(ShortVideoMaterialRun run, byte[] bytes, string mime, CancellationToken authorityToken)
    {
        authorityToken.ThrowIfCancellationRequested();
        var storage = _serviceProvider.GetRequiredService<IAssetStorage>();
        // 旧处理标识或不支持精确键的兼容存储继续原路径；不能把共享 SHA 当作本次所有权。
        if (!Regex.IsMatch(run.Id, "^[a-f0-9]{32}$") || !Regex.IsMatch(run.ProcessingToken ?? "", "^[a-f0-9]{32}$"))
            return await storage.SaveAsync(bytes, mime, CancellationToken.None, "workflow-agent", "doc");
        var predicted = storage.TryBuildContentAddressedKey(bytes, mime, "workflow-agent", "doc");
        if (string.IsNullOrWhiteSpace(predicted))
            return await storage.SaveAsync(bytes, mime, CancellationToken.None, "workflow-agent", "doc");
        predicted = predicted.Replace('\\', '/');
        if (predicted.Split('/').Any(s => s is "." or "..") || !predicted.Contains('/'))
            throw new InvalidOperationException("素材存储位置未能确认，已停止保存");
        var receipt = GetArtifactReceipt(run);
        receipt.PredictedKey = predicted;
        receipt.StorageKey = predicted[..predicted.LastIndexOf('/')]
            + $"/short-video/{run.Id}/{run.ProcessingToken}/{Path.GetFileName(predicted)}";
        var url = storage.BuildUrlForKey(receipt.StorageKey);
        receipt.Url = url;
        if (!IsAttemptStorageKey(run, receipt, storage))
            throw new InvalidOperationException("素材存储归属未能确认，已停止保存");
        receipt.PhysicalState = "upload-started";
        run.CleanupPending = true;
        await SaveRunWithIntentAsync(run, () => receipt.PhysicalState = "not-started");
        // 命令发出前明确失去处理权时尚无上传；回执未知则不能这样回退。
        try { authorityToken.ThrowIfCancellationRequested(); }
        catch (OperationCanceledException) { receipt.PhysicalState = "not-started"; throw; }
        try
        {
            receipt.PhysicalState = "upload-started";
            await storage.UploadToKeyAsync(receipt.StorageKey, bytes, mime, CancellationToken.None);
            receipt.PhysicalState = "uploaded";
        }
        catch (Exception ex)
        {
            receipt.PhysicalState = "upload-outcome-unknown";
            throw new InvalidOperationException("视频产物保存结果未确认，已停止后续处理并保留责任记录，请稍后查看", ex);
        }
        await SaveRunAsync(run);
        var sha = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes)).ToLowerInvariant();
        return new StoredAsset(sha, url, bytes.LongLength, mime, receipt.StorageKey) { CreatedNew = true };
    }

    internal async Task RecoverInterruptedArtifactsAsync(ShortVideoMaterialRun run,
        FilterDefinition<ShortVideoMaterialRun> recoveryFilter, string code, string message, string instanceId)
    {
        if (TaskExecutionContext.Current != null || _taskExecutions == null || string.IsNullOrWhiteSpace(run.TaskPermitId))
            throw new InvalidOperationException("原任务停止状态未能确认，已保留产物责任记录");
        var active = ActiveRunFilter(run);
        // 先冻结同一代次，再撤销原许可；不申请新执行权、不恢复旧租约。
        var fenced = await _db.ShortVideoMaterialRuns.UpdateOneAsync(active & recoveryFilter,
            Builders<ShortVideoMaterialRun>.Update.Set(x => x.ArtifactCleanupStarted, true)
                .Set(x => x.CleanupPending, true), cancellationToken: CancellationToken.None);
        if (fenced.MatchedCount != 1) return;
        await _taskExecutions.RevokeAsync(run.TaskPermitId, run.Id, CancellationToken.None);
        await CleanupArtifactsAfterFailureAsync(run, run);
        // 补偿成功或明确保留未知责任后，才清除处理身份；失败保留原身份供原恢复路径续接。
        for (var attempt = 0; attempt < 2; attempt++)
        {
            var latest = await _db.ShortVideoMaterialRuns.Find(active).FirstOrDefaultAsync(CancellationToken.None);
            if (latest == null) return;
            var cancelled = latest.CancelRequested;
            latest.Status = cancelled ? "cancelled" : "failed";
            latest.ProcessingToken = null;
            latest.OwnerInstanceId = instanceId;
            latest.ErrorCode = cancelled ? null : code;
            latest.ErrorMessage = cancelled ? "已取消短视频素材处理" : message;
            latest.UpdatedAt = DateTime.UtcNow;
            var cancellationState = cancelled ? Builders<ShortVideoMaterialRun>.Filter.Eq(x => x.CancelRequested, true)
                : Builders<ShortVideoMaterialRun>.Filter.Ne(x => x.CancelRequested, true);
            var saved = await _db.ShortVideoMaterialRuns.ReplaceOneAsync(active & cancellationState, latest,
                cancellationToken: CancellationToken.None);
            if (saved.MatchedCount == 1) return;
        }
    }

    private async Task CleanupArtifactsAfterFailureAsync(ShortVideoMaterialRun run, ShortVideoMaterialRun identity)
    {
        var receipt = run.ArtifactReceipt;
        if (receipt == null || string.IsNullOrWhiteSpace(identity.ProcessingToken)
            || receipt.ProcessingToken != identity.ProcessingToken) return;
        var active = ActiveRunFilter(identity);
        // 与 done 保存竞争同一条 CAS；一旦进入补偿，迟到保存不能再把已解除的引用写成完成。
        var fenced = await _db.ShortVideoMaterialRuns.UpdateOneAsync(active,
            Builders<ShortVideoMaterialRun>.Update.Set(x => x.ArtifactCleanupStarted, true)
                .Set(x => x.CleanupPending, true), cancellationToken: CancellationToken.None);
        if (fenced.MatchedCount != 1) return;
        var removed = new HashSet<string>(StringComparer.Ordinal);
        var countPending = false;
        var documentPending = false;
        foreach (var item in receipt.Entries)
        {
            var own = Builders<DocumentEntry>.Filter.Eq(x => x.Id, item.EntryId)
                & Builders<DocumentEntry>.Filter.Eq(x => x.StoreId, item.StoreId)
                & Builders<DocumentEntry>.Filter.Eq(x => x.CreatedBy, identity.UserId)
                & Builders<DocumentEntry>.Filter.Eq(x => x.UpdatedAt, item.EntryCreatedAt)
                & Builders<DocumentEntry>.Filter.Eq("Metadata.runId", identity.Id);
            var deleted = await _db.DocumentEntries.DeleteOneAsync(own, CancellationToken.None);
            if (deleted.DeletedCount == 1 || await _db.DocumentEntries.CountDocumentsAsync(x => x.Id == item.EntryId) == 0)
            {
                removed.Add(item.EntryId);
                if (!await ReleaseCountedEntriesAsync(_db.DocumentStores, item.StoreId, [item.EntryId], identity.UserId)) countPending = true;
                var replacement = await _db.DocumentEntries.Find(x => x.StoreId == item.StoreId)
                    .SortBy(x => x.CreatedAt).Project(x => x.Id).FirstOrDefaultAsync(CancellationToken.None);
                await _db.DocumentStores.UpdateOneAsync(x => x.Id == item.StoreId && x.OwnerId == identity.UserId && x.PrimaryEntryId == item.EntryId,
                    Builders<DocumentStore>.Update.Set(x => x.PrimaryEntryId, replacement), cancellationToken: CancellationToken.None);
            }
            // 主表写入失败仍可能留下附件/正文；仅处理预先登记的本次 ID，其他条目仍引用则保留。
            if (item.AttachmentId != null && await _db.DocumentEntriesIncludingTrash.CountDocumentsAsync(x => x.AttachmentId == item.AttachmentId) == 0)
                await _db.Attachments.DeleteOneAsync(x => x.AttachmentId == item.AttachmentId && x.UploaderId == identity.UserId, CancellationToken.None);
            if (item.DocumentCreatedNew && item.DocumentId != null && Guid.TryParse(item.DocumentId, out _)
                && await _db.DocumentEntriesIncludingTrash.CountDocumentsAsync(x => x.DocumentId == item.DocumentId) == 0)
            {
                if (item.DocumentPublicationStarted) documentPending = true;
                else
                {
                    await _db.Documents.DeleteOneAsync(x => x.Id == item.DocumentId, CancellationToken.None);
                    var cache = _serviceProvider.GetService<ICacheManager>();
                    if (cache != null) await cache.RemoveAsync(CacheKeys.ForDocument(item.DocumentId));
                }
            }
        }
        var pending = receipt.PhysicalState is "upload-outcome-unknown" or "upload-started" or "delete-pending" or "ownership-unconfirmed"
            || receipt.Entries.Any(x => x.UnconfirmedWrite) || countPending || documentPending;
        if (receipt.PublicationStarted || receipt.Entries.Any(x => x.AttachmentId != null && x.UnconfirmedWrite))
        {
            // URL 曾进入条目写入流程，无法证明跨库/人工复制从未引用；不扩大存储删除权限。
            receipt.PhysicalState = "retained-published";
        }
        else if (receipt.PhysicalState == "uploaded" && IsAttemptStorageKey(identity, receipt, _serviceProvider.GetRequiredService<IAssetStorage>()))
        {
            var referenced = await _db.Attachments.CountDocumentsAsync(x => x.Url == receipt.Url) > 0
                || await _db.DocumentEntries.CountDocumentsAsync(Builders<DocumentEntry>.Filter.Eq("Metadata.assetUrl", receipt.Url)) > 0
                || await _db.ShortVideoMaterialRuns.CountDocumentsAsync(x => x.Id != identity.Id && x.SourceVideoUrl == receipt.Url) > 0
                || await PrdAgent.Infrastructure.Services.VideoAssetMutationLease.HasReferencesAsync(
                    _db, string.Empty, receipt.Url!, CancellationToken.None);
            if (referenced) receipt.PhysicalState = "retained-referenced";
            else
            {
                try
                {
                    await _serviceProvider.GetRequiredService<IAssetStorage>().DeleteByKeyAsync(receipt.StorageKey!, CancellationToken.None);
                    receipt.PhysicalState = "deleted";
                }
                catch (Exception ex)
                {
                    pending = true;
                    receipt.PhysicalState = "delete-pending";
                    _logger.LogWarning(ex, "短视频独立对象清理未确认，保留责任记录 run={RunId}", identity.Id);
                }
            }
        }
        else if (receipt.PhysicalState == "uploaded")
        {
            pending = true;
            receipt.PhysicalState = "ownership-unconfirmed";
        }
        var update = Builders<ShortVideoMaterialRun>.Update.Set(x => x.ArtifactReceipt, receipt)
            .Set(x => x.CleanupPending, pending).Set(x => x.UpdatedAt, DateTime.UtcNow);
        if (run.SourceEntryId != null && removed.Contains(run.SourceEntryId))
        {
            update = update.Set(x => x.SourceEntryId, null).Set(x => x.SourceVideoUrl, null);
            if (run.Card != null) update = update.Set(x => x.Card!.VideoUrl, null);
        }
        if (run.TranscriptEntryId != null && removed.Contains(run.TranscriptEntryId)) update = update.Set(x => x.TranscriptEntryId, null);
        if (run.EntryId != null && removed.Contains(run.EntryId)) update = update.Set(x => x.EntryId, null);
        await _db.ShortVideoMaterialRuns.UpdateOneAsync(active, update, cancellationToken: CancellationToken.None);
    }

    internal const string CountedEntryIdsField = "ShortVideoCountedEntryIds";

    internal static async Task<HashSet<string>> ReadCountedEntryIdsAsync(IMongoCollection<DocumentStore> stores,
        string storeId, IEnumerable<string> candidateIds)
    {
        var row = await stores.Find(x => x.Id == storeId).Project(Builders<DocumentStore>.Projection.Include(CountedEntryIdsField))
            .FirstOrDefaultAsync(CancellationToken.None);
        var candidates = candidateIds.ToHashSet(StringComparer.Ordinal);
        return row != null && row.TryGetValue(CountedEntryIdsField, out var value) && value.IsBsonArray
            ? value.AsBsonArray.Where(x => x.IsString && candidates.Contains(x.AsString)).Select(x => x.AsString).ToHashSet(StringComparer.Ordinal)
            : new(StringComparer.Ordinal);
    }

    internal static async Task<bool> ReleaseCountedEntriesAsync(IMongoCollection<DocumentStore> stores, string storeId,
        IReadOnlyCollection<string> entryIds, string? ownerId = null)
    {
        var scope = Builders<DocumentStore>.Filter.Eq(x => x.Id, storeId);
        if (ownerId != null) scope &= Builders<DocumentStore>.Filter.Eq(x => x.OwnerId, ownerId);
        foreach (var id in entryIds)
        {
            var counted = scope & Builders<DocumentStore>.Filter.Eq(CountedEntryIdsField, id);
            // 令牌和减量在同一个 store 文档原子提交。重复删除/响应丢失不再重复扣量。
            await stores.UpdateOneAsync(counted & Builders<DocumentStore>.Filter.Gt(x => x.DocumentCount, 0),
                Builders<DocumentStore>.Update.Inc(x => x.DocumentCount, -1).Pull(CountedEntryIdsField, id)
                    .Set(x => x.UpdatedAt, DateTime.UtcNow), cancellationToken: CancellationToken.None);
            await stores.UpdateOneAsync(counted & Builders<DocumentStore>.Filter.Lte(x => x.DocumentCount, 0),
                Builders<DocumentStore>.Update.Set(x => x.DocumentCount, 0).Pull(CountedEntryIdsField, id)
                    .Set(x => x.UpdatedAt, DateTime.UtcNow), cancellationToken: CancellationToken.None);
        }
        if (ownerId != null && await stores.CountDocumentsAsync(scope) != 1) return false;
        return await stores.CountDocumentsAsync(scope & Builders<DocumentStore>.Filter.AnyIn(CountedEntryIdsField, entryIds)) == 0;
    }

    private static bool IsAttemptStorageKey(ShortVideoMaterialRun identity, ShortVideoMaterialArtifactReceipt receipt, IAssetStorage storage)
    {
        var predicted = receipt.PredictedKey;
        if (string.IsNullOrWhiteSpace(predicted) || string.IsNullOrWhiteSpace(receipt.StorageKey)
            || !Regex.IsMatch(identity.Id, "^[a-f0-9]{32}$") || !Regex.IsMatch(identity.ProcessingToken ?? "", "^[a-f0-9]{32}$")
            || predicted.Contains('\\') || predicted.Split('/').Any(x => x is "." or "..") || !predicted.Contains('/')
            || !Regex.IsMatch(Path.GetFileName(predicted), "^[a-z0-9_-]+\\.[a-z0-9]+$")) return false;
        var logical = $"workflow-agent/doc/short-video/{identity.Id}/{identity.ProcessingToken}/{Path.GetFileName(predicted)}";
        return receipt.StorageKey == predicted[..predicted.LastIndexOf('/')]
            + $"/short-video/{identity.Id}/{identity.ProcessingToken}/{Path.GetFileName(predicted)}"
            && receipt.Url == storage.BuildUrlForKey(receipt.StorageKey)
            && receipt.Url == storage.BuildUrlForLogicalKey(logical);
    }

    internal static FilterDefinition<ShortVideoMaterialRun> ActiveRunFilter(ShortVideoMaterialRun run)
    {
        if (string.IsNullOrWhiteSpace(run.ProcessingToken))
            throw new InvalidOperationException("短视频任务缺少本次处理标识，已停止继续写入");
        var f = Builders<ShortVideoMaterialRun>.Filter;
        return f.Eq(x => x.Id, run.Id) & f.Eq(x => x.UserId, run.UserId)
            & f.Eq(x => x.OwnerInstanceId, run.OwnerInstanceId) & f.Eq(x => x.TaskPermitId, run.TaskPermitId)
            & f.Eq(x => x.ProcessingToken, run.ProcessingToken) & f.Eq(x => x.Status, "running");
    }

    private Task SaveRunAsync(ShortVideoMaterialRun run) => SaveRunWithIntentAsync(run, null);

    private async Task SaveRunWithIntentAsync(ShortVideoMaterialRun run, Action? onConfirmedRejection)
    {
        // 先冻结本次处理条件，再清终态标识；不允许迟到保存重建已删除或接管的记录。
        var filter = ContinuableRunFilter(run);
        run.UpdatedAt = DateTime.UtcNow;
        if (run.Status is "done" or "failed" or "cancelled") run.ProcessingToken = null;
        var saved = await _db.ShortVideoMaterialRuns.ReplaceOneAsync(
            filter, run, new ReplaceOptions { IsUpsert = false }, CancellationToken.None);
        if (saved.MatchedCount != 1)
        {
            onConfirmedRejection?.Invoke();
            throw new InvalidOperationException("短视频任务处理权已失效，已停止继续写入");
        }
    }

    private static FilterDefinition<ShortVideoMaterialRun> ContinuableRunFilter(ShortVideoMaterialRun run)
        => ActiveRunFilter(run) & Builders<ShortVideoMaterialRun>.Filter.Ne(r => r.CancelRequested, true)
            & Builders<ShortVideoMaterialRun>.Filter.Ne(r => r.ArtifactCleanupStarted, true);

    public static List<ShortVideoMaterialStage> BuildInitialStages()
        => new()
        {
            Stage("parse", "解析链接", "pending", "已创建后台任务，等待开始处理"),
            Stage("source", "保存原始视频", "pending", "等待链接解析完成"),
            Stage("transcript", "视频转文字", "pending", "等待原始视频保存完成"),
            Stage("ready", "准备继续加工", "pending", "等待入库产物就绪"),
        };

    private static ShortVideoMaterialStage Stage(string key, string label, string status, string message)
        => new() { Key = key, Label = label, Status = status, Message = message, At = DateTime.UtcNow };

    private static void MarkStage(ShortVideoMaterialRun run, string key, string status, string message)
    {
        var stage = run.Stages.FirstOrDefault(s => s.Key == key);
        if (stage == null)
        {
            run.Stages.Add(Stage(key, key, status, message));
            return;
        }
        stage.Status = status;
        stage.Message = message;
        stage.At = DateTime.UtcNow;
    }

    public static void MarkFirstRunningStageFailed(ShortVideoMaterialRun run, string message)
    {
        var stage = run.Stages.FirstOrDefault(s => s.Status == "running")
                    ?? run.Stages.FirstOrDefault(s => s.Status == "pending");
        if (stage == null) return;
        stage.Status = "failed";
        stage.Message = message;
        stage.At = DateTime.UtcNow;
    }

    public static string ExtractUrl(string? input)
    {
        if (string.IsNullOrWhiteSpace(input)) return string.Empty;
        var match = Regex.Match(input, @"https?://[^\s""']+", RegexOptions.IgnoreCase);
        return match.Success ? match.Value.TrimEnd('。', '，', ',', '.', ')', ']') : input.Trim();
    }

    public static bool IsHttpUrl(string? value)
        => Uri.TryCreate(value?.Trim(), UriKind.Absolute, out var uri)
           && (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps)
           && !string.IsNullOrWhiteSpace(uri.Host);

    public static bool IsDirectVideoUrl(string? value)
    {
        if (!Uri.TryCreate(value?.Trim(), UriKind.Absolute, out var uri)
            || (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps)
            || string.IsNullOrWhiteSpace(uri.Host))
            return false;

        return Path.GetExtension(uri.AbsolutePath).ToLowerInvariant() is
            ".mp4" or ".m4v" or ".mov" or ".webm" or ".mkv" or ".avi";
    }

    public static string DetectPlatform(string url)
    {
        var lower = url.ToLowerInvariant();
        if (lower.Contains("douyin.com") || lower.Contains("iesdouyin.com")) return "douyin";
        if (lower.Contains("tiktok.com")) return "tiktok";
        if (lower.Contains("kuaishou.com") || lower.Contains("gifshow.com")) return "kuaishou";
        if (lower.Contains("bilibili.com") || lower.Contains("b23.tv")) return "bilibili";
        if (lower.Contains("xiaohongshu.com") || lower.Contains("xhslink.com")) return "xiaohongshu";
        if (lower.Contains("youtube.com") || lower.Contains("youtu.be")) return "youtube";
        return "unknown";
    }

    private async Task<ParsedShortVideoSource> ResolveParsedSourceAsync(string videoUrl, string platform, string? manualText, string? requestedTitle)
    {
        var trimmedManual = manualText?.Trim();
        var hasManualText = !string.IsNullOrWhiteSpace(trimmedManual);
        if (Uri.TryCreate(videoUrl.Trim(), UriKind.Absolute, out var directUri)
            && string.Equals(Path.GetExtension(directUri.AbsolutePath), ".ogv", StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("当前下载与转写流水线不支持 OGV 直链，请先转换为 MP4、MOV、WebM、MKV 或 AVI");
        if (IsDirectVideoUrl(videoUrl))
        {
            return new ParsedShortVideoSource(
                CleanTitle(requestedTitle),
                trimmedManual,
                hasManualText ? "manual" : "direct-video",
                hasManualText
                    ? "已识别到直接视频文件，并使用用户提供的文字作为后续加工来源"
                    : "已识别到直接视频文件；默认先保存原始视频，再从视频执行真实转写",
                null,
                videoUrl,
                null);
        }
        var apiKey = ResolveTikHubApiKey();
        if (string.IsNullOrWhiteSpace(apiKey))
        {
            return new ParsedShortVideoSource(
                CleanTitle(requestedTitle),
                trimmedManual,
                hasManualText ? "manual" : "metadata-fallback",
                hasManualText ? "已使用用户提供的文字作为后续加工来源" : "TikHub API 密钥未配置，无法解析真实视频文件地址",
                null,
                null,
                null);
        }

        try
        {
            var parserNode = new WorkflowNode
            {
                NodeId = "short-video-parser",
                Name = "短视频解析",
                NodeType = CapsuleTypes.DouyinParser,
                Config = new Dictionary<string, object?>
                {
                    ["apiBaseUrl"] = ResolveTikHubApiBaseUrl(),
                    ["apiKey"] = apiKey,
                    ["videoUrl"] = videoUrl,
                },
            };
            var parserResult = await CapsuleExecutor.ExecuteDouyinParserAsync(
                _serviceProvider,
                parserNode,
                new Dictionary<string, string>(),
                new List<ExecutionArtifact>());
            var metadataJson = parserResult.Artifacts.FirstOrDefault()?.InlineContent;
            var metadata = ExtractParsedMetadata(metadataJson);

            var source = hasManualText ? trimmedManual : null;
            var mode = hasManualText ? "manual" : "tikhub-video";
            var message = mode switch
            {
                "manual" => "已解析到视频元数据，并使用用户提供的文字作为后续加工来源",
                _ => "已解析到视频文件地址；默认先保存原始视频，再从视频执行真实转写",
            };
            return new ParsedShortVideoSource(metadata.Title, source, mode, message, metadataJson, metadata.VideoUrl, metadata.CoverUrl);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "短视频解析器降级 videoUrl={VideoUrl}", videoUrl);
            return new ParsedShortVideoSource(
                CleanTitle(requestedTitle),
                trimmedManual,
                hasManualText ? "manual" : "metadata-fallback",
                hasManualText ? "短视频解析器暂不可用，已使用用户提供的文字作为后续加工来源" : "短视频解析器暂不可用，无法解析真实视频文件地址",
                null,
                null,
                null);
        }
    }

    private string ResolveTikHubApiKey()
        => (_config["ShortVideo:TikHubApiKey"]
            ?? _config["TikHub:ApiKey"]
            ?? Environment.GetEnvironmentVariable("TIKHUB_API_KEY")
            ?? string.Empty).Trim();

    private string ResolveTikHubApiBaseUrl()
        => (_config["ShortVideo:TikHubApiBaseUrl"]
            ?? _config["TikHub:ApiBaseUrl"]
            ?? Environment.GetEnvironmentVariable("TIKHUB_API_BASE_URL")
            ?? "https://api.tikhub.dev").TrimEnd('/');

    /// <summary>
    /// 从短视频解析器返回的原始元数据中抽取一张干净的展示卡片。
    /// 解析器把 author/statistics/hashtags 透传成了嵌套 JSON 字符串，这里集中解开，
    /// 让前端直接渲染（遵循「业务数据描述由后端维护」原则）。
    /// </summary>
    private static ShortVideoCard BuildShortVideoCard(string? metadataJson, string title, string platform, string? coverUrlFallback)
    {
        var card = new ShortVideoCard
        {
            Title = title,
            Platform = platform,
            CoverUrl = coverUrlFallback,
        };
        if (string.IsNullOrWhiteSpace(metadataJson)) return card;
        try
        {
            using var doc = JsonDocument.Parse(metadataJson);
            var root = doc.RootElement;

            var cover = GetJsonString(root, "coverUrl", "cover_url", "cover", "origin_cover");
            if (!string.IsNullOrWhiteSpace(cover)) card.CoverUrl = cover;

            // 时长：不同平台透传的单位不一致——有的是毫秒，有的已是秒。用 >=1000 阈值区分：
            // 短视频秒数通常 < 1000（约 16 分钟），毫秒数 >=1000（1s=1000ms）。否则把 45（秒）
            // 当毫秒会算成 0、把已是秒的值再除 1000 显示过短（Bugbot Medium）。
            var durationRaw = GetJsonString(root, "duration", "video_duration");
            if (long.TryParse(durationRaw, out var durVal) && durVal > 0)
                card.DurationSec = durVal >= 1000
                    ? (int)Math.Round(durVal / 1000.0)  // 毫秒 → 秒
                    : (int)durVal;                       // 已是秒

            // author 可能是昵称字符串，也可能是被透传成字符串的嵌套对象
            var authorEl = ResolveMaybeNestedJson(root, "author");
            if (authorEl is { ValueKind: JsonValueKind.Object } ao)
            {
                card.AuthorName = GetJsonString(ao, "nickname", "name", "unique_id");
                card.AuthorAvatarUrl = ExtractFirstUrl(ao, "avatar_thumb", "avatar_medium", "avatar_larger", "avatar_168x168", "avatar_300x300");
            }
            else
            {
                var authorName = GetJsonString(root, "author", "author_name", "nickname");
                if (!string.IsNullOrWhiteSpace(authorName) && !authorName.TrimStart().StartsWith("{"))
                    card.AuthorName = authorName;
            }

            // statistics 同理
            var statsEl = ResolveMaybeNestedJson(root, "statistics", "stats");
            if (statsEl is { ValueKind: JsonValueKind.Object } so)
            {
                card.LikeCount = GetJsonLong(so, "digg_count", "like_count", "likes");
                card.CommentCount = GetJsonLong(so, "comment_count", "comments");
                card.ShareCount = GetJsonLong(so, "share_count", "shares");
                card.CollectCount = GetJsonLong(so, "collect_count", "favourite_count", "collects");
                card.PlayCount = GetJsonLong(so, "play_count", "view_count", "plays");
            }

            // hashtags：数组，每项含 hashtag_name
            var tagsEl = ResolveMaybeNestedJson(root, "hashtags", "text_extra");
            if (tagsEl is { ValueKind: JsonValueKind.Array } ta)
            {
                foreach (var t in ta.EnumerateArray())
                {
                    var name = t.ValueKind == JsonValueKind.String
                        ? t.GetString()
                        : GetJsonString(t, "hashtag_name", "name", "caption");
                    name = name?.TrimStart('#').Trim();
                    if (!string.IsNullOrWhiteSpace(name) && !card.Hashtags.Contains(name))
                        card.Hashtags.Add(name);
                    if (card.Hashtags.Count >= 8) break;
                }
            }
        }
        catch
        {
            // 抽取失败不影响主流程，卡片至少有封面 + 标题
        }
        return card;
    }

    /// <summary>读取某字段；若它被透传成了 JSON 字符串则二次 Parse 还原为对象/数组。</summary>
    private static JsonElement? ResolveMaybeNestedJson(JsonElement root, params string[] names)
    {
        foreach (var name in names)
        {
            if (!root.TryGetProperty(name, out var el)) continue;
            if (el.ValueKind is JsonValueKind.Object or JsonValueKind.Array) return el;
            if (el.ValueKind == JsonValueKind.String)
            {
                var s = el.GetString();
                if (!string.IsNullOrWhiteSpace(s) && (s.TrimStart().StartsWith("{") || s.TrimStart().StartsWith("[")))
                {
                    try
                    {
                        using var nested = JsonDocument.Parse(s);
                        return nested.RootElement.Clone();
                    }
                    catch { /* ignore */ }
                }
            }
        }
        return null;
    }

    private static string? ExtractFirstUrl(JsonElement obj, params string[] imageFieldNames)
    {
        foreach (var f in imageFieldNames)
        {
            if (!obj.TryGetProperty(f, out var img) || img.ValueKind != JsonValueKind.Object) continue;
            if (img.TryGetProperty("url_list", out var ul) && ul.ValueKind == JsonValueKind.Array)
            {
                foreach (var u in ul.EnumerateArray())
                {
                    var s = u.GetString();
                    if (!string.IsNullOrWhiteSpace(s)) return s;
                }
            }
        }
        return null;
    }

    private static long? GetJsonLong(JsonElement obj, params string[] names)
    {
        foreach (var n in names)
        {
            if (!obj.TryGetProperty(n, out var el)) continue;
            if (el.ValueKind == JsonValueKind.Number && el.TryGetInt64(out var v)) return v;
            if (el.ValueKind == JsonValueKind.String && long.TryParse(el.GetString(), out var sv)) return sv;
        }
        return null;
    }

    private static ParsedVideoMetadata ExtractParsedMetadata(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return new ParsedVideoMetadata(null, null, null);
        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            return new ParsedVideoMetadata(
                GetJsonString(root, "title", "desc", "description"),
                GetJsonString(root, "videoUrl", "video_url", "play_addr", "nwm_video_url"),
                GetJsonString(root, "coverUrl", "cover_url", "cover", "origin_cover"));
        }
        catch
        {
            return new ParsedVideoMetadata(null, null, null);
        }
    }

    private static string? ExtractTranscript(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return null;
        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            var direct = GetJsonString(root, "transcript");
            if (!string.IsNullOrWhiteSpace(direct)) return direct.Trim();
            if (root.TryGetProperty("firstItem", out var firstItem) && firstItem.ValueKind == JsonValueKind.Object)
            {
                var firstText = GetJsonString(firstItem, "transcript");
                if (!string.IsNullOrWhiteSpace(firstText)) return firstText.Trim();
            }
            if (root.TryGetProperty("items", out var items) && items.ValueKind == JsonValueKind.Array)
            {
                var transcripts = items
                    .EnumerateArray()
                    .Select(item => item.ValueKind == JsonValueKind.Object ? GetJsonString(item, "transcript") : null)
                    .Where(text => !string.IsNullOrWhiteSpace(text))
                    .Select(text => text!.Trim())
                    .ToList();
                if (transcripts.Count > 0) return string.Join("\n", transcripts);
            }
            return null;
        }
        catch
        {
            return null;
        }
    }

    private static string? GetJsonString(JsonElement root, params string[] names)
    {
        foreach (var name in names)
        {
            if (root.TryGetProperty(name, out var value))
            {
                if (value.ValueKind == JsonValueKind.String)
                    return value.GetString();
                if (value.ValueKind is JsonValueKind.Number or JsonValueKind.True or JsonValueKind.False)
                    return value.ToString();
            }
        }
        return null;
    }

    internal static string RequireResolvedVideoUrl(string? parsedVideoUrl)
    {
        var videoUrl = parsedVideoUrl?.Trim();
        if (string.IsNullOrWhiteSpace(videoUrl))
            throw new InvalidOperationException("短视频解析器未返回可下载的视频文件地址，已停止保存原始视频，避免把分享页当作视频入库");
        if (!Uri.TryCreate(videoUrl, UriKind.Absolute, out var uri) ||
            (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
            throw new InvalidOperationException("短视频解析器返回的视频文件地址无效，已停止保存原始视频");
        return videoUrl;
    }

    private static string? CleanTitle(string? title)
    {
        var t = title?.Trim();
        return string.IsNullOrWhiteSpace(t) ? null : t.Length > 80 ? t[..80] : t;
    }

    private static string BuildTranscriptMarkdown(string title, string videoUrl, string platform, string transcriptText)
    {
        var sb = new StringBuilder();
        sb.AppendLine($"# {title} · 原始转写文字");
        sb.AppendLine();
        sb.AppendLine($"> 来源平台：{platform}");
        sb.AppendLine($"> 原始链接：{videoUrl}");
        sb.AppendLine($"> 生成方式：视频 ASR 转写");
        sb.AppendLine();
        sb.AppendLine("## 原始文字");
        sb.AppendLine();
        sb.AppendLine(transcriptText);
        sb.AppendLine();
        sb.AppendLine("## 后续加工建议");
        sb.AppendLine();
        sb.AppendLine("- 选中本条目点击「智能体」，加工成文案、教程、脚本、课程大纲或网页草稿。");
        sb.AppendLine("- 对具体段落做划词编辑、补充说明或生成配图。");
        sb.AppendLine("- 需要时间线时，再基于这份原始文字生成时间线片段。");
        return sb.ToString();
    }

    private static string SourceModeLabel(string sourceMode) => sourceMode switch
    {
        "manual" => "用户提供文字",
        "tikhub-video" => "短视频解析器视频地址",
        "asr" => "视频 ASR 转写",
        _ => "链接元数据兜底",
    };

    private sealed record ParsedShortVideoSource(string? Title, string? SourceText, string SourceMode, string Message, string? MetadataJson, string? VideoUrl, string? CoverUrl);
    private sealed record ParsedVideoMetadata(string? Title, string? VideoUrl, string? CoverUrl);
    private sealed record DownloadedVideoMaterial(string Url, string MimeType, long FileSize, string? Sha256);
    private sealed record VideoTranscriptionAttempt(string? Text, string? ErrorMessage);
}
