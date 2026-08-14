using Microsoft.Extensions.Configuration;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Security;

namespace PrdAgent.Api.Services;

/// <summary>
/// 知识库 Agent 后台 Worker —— 字幕生成 + 文档再加工。
///
/// 遵循 server-authority.md 规则：
/// - 处理任务使用 CancellationToken.None（不被客户端断连影响）
/// - Worker 关闭时把进行中的任务标记为失败
/// - 所有状态变更同时写 MongoDB（持久）+ IRunEventStore（实时 SSE）
/// </summary>
public class DocumentStoreAgentWorker : BackgroundService
{
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly ILogger<DocumentStoreAgentWorker> _logger;
    private string? _currentRunId;
    private string? _currentExecutionId;

    /// <summary>每 3 秒轮询一次 queued 任务</summary>
    private static readonly TimeSpan ScanInterval = TimeSpan.FromSeconds(3);
    private static readonly TimeSpan InterruptedRecoveryInterval = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan InterruptedRunStaleAfter = TimeSpan.FromMinutes(1);

    public DocumentStoreAgentWorker(
        IServiceScopeFactory scopeFactory,
        ILogger<DocumentStoreAgentWorker> logger)
    {
        _scopeFactory = scopeFactory;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _logger.LogInformation("[doc-store-agent] Worker started");

        var nextInterruptedRecoveryAt = DateTime.MinValue;
        try
        {
            while (!stoppingToken.IsCancellationRequested)
            {
                try
                {
                    if (DateTime.UtcNow >= nextInterruptedRecoveryAt)
                    {
                        nextInterruptedRecoveryAt = DateTime.UtcNow + InterruptedRecoveryInterval;
                        try
                        {
                            await RecoverInterruptedRunsAsync();
                        }
                        catch (Exception ex)
                        {
                            // 回收是维护路径，单次失败不能阻断正常 queued 任务消费。
                            _logger.LogError(ex, "[doc-store-agent] Interrupted run recovery failed");
                        }
                    }
                    await ProcessNextRunAsync();
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "[doc-store-agent] Worker loop error");
                }
                await Task.Delay(ScanInterval, stoppingToken);
            }
        }
        finally
        {
            // Worker 关闭时把进行中的任务标记为失败
            if (_currentRunId != null && _currentExecutionId != null)
            {
                try
                {
                    using var scope = _scopeFactory.CreateScope();
                    var db = scope.ServiceProvider.GetRequiredService<MongoDbContext>();
                    var interruptedAt = DateTime.UtcNow;
                    if (DocumentRecordingArchiveWorker.IsDeferredTranscriptionRunId(_currentRunId))
                    {
                        var automaticRetryBudgetFilter = DocumentRecordingArchiveWorker
                            .BuildDeferredTranscriptionAutomaticRetryBudgetFilter();
                        await db.DocumentStoreAgentRuns.UpdateOneAsync(
                            Builders<DocumentStoreAgentRun>.Filter.And(
                                Builders<DocumentStoreAgentRun>.Filter.Eq(
                                    r => r.Id,
                                    _currentRunId),
                                Builders<DocumentStoreAgentRun>.Filter.Eq(
                                    r => r.Status,
                                    DocumentStoreRunStatus.Running),
                                Builders<DocumentStoreAgentRun>.Filter.Eq(
                                    r => r.ExecutionId,
                                    _currentExecutionId),
                                automaticRetryBudgetFilter),
                            Builders<DocumentStoreAgentRun>.Update
                                .Set(r => r.Status, DocumentStoreRunStatus.Queued)
                                .Set(r => r.Phase, "Worker 关闭，正在恢复完整录音转录")
                                .Set(r => r.Progress, 0)
                                .Set(r => r.ErrorMessage, null)
                                .Set(r => r.FailureCode, null)
                                .Set(r => r.StartedAt, null)
                                .Set(r => r.HeartbeatAt, null)
                                .Set(r => r.EndedAt, null)
                                .Set(r => r.ExecutionId, string.Empty)
                                .Set(r => r.AutomaticRetryNextAt, null)
                                .Set(
                                    r => r.AutomaticRetryReason,
                                    DocumentRecordingArchiveWorker
                                        .DeferredRetryReasonRestartInterrupted)
                                .Inc(r => r.AutomaticRetryCount, 1),
                            cancellationToken: CancellationToken.None);
                    }
                    await db.DocumentStoreAgentRuns.UpdateOneAsync(
                        r => r.Id == _currentRunId
                             && r.Status == DocumentStoreRunStatus.Running
                             && r.ExecutionId == _currentExecutionId,
                        Builders<DocumentStoreAgentRun>.Update
                            .Set(r => r.Status, DocumentStoreRunStatus.Failed)
                            .Set(r => r.ErrorMessage, "Worker 关闭，任务被中断")
                            .Set(r => r.FailureCode, "WORKER_INTERRUPTED")
                            .Set(r => r.EndedAt, interruptedAt)
                            .Set(r => r.HeartbeatAt, null)
                            .Set(
                                r => r.AutomaticRetryNextAt,
                                null)
                            .Set(r => r.AutomaticRetryReason, null),
                        cancellationToken: CancellationToken.None);
                }
                catch { /* ignore */ }
            }
        }
    }

    internal async Task RecoverInterruptedRunsAsync()
    {
        using var scope = _scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MongoDbContext>();
        var configuration = scope.ServiceProvider.GetRequiredService<IConfiguration>();
        var instanceId = InstanceIdentity.Get(configuration);
        var compatibleOwnerIds = InstanceIdentity.GetCompatibleOwnerIds(configuration);
        var ownerScope = LegacyOwnerScope.Build<DocumentStoreAgentRun>(
            nameof(DocumentStoreAgentRun.OwnerInstanceId),
            compatibleOwnerIds,
            includeUnowned: true,
            retiredLegacyOwnerIds: DeploymentAuthority.GetRetiredLegacyBranchOwnerIds(configuration),
            legacyOwnerCreatedBeforeUtc: DeploymentAuthority.GetRetiredLegacyBranchOwnerCreatedBeforeUtc(configuration));
        var now = DateTime.UtcNow;
        var staleAt = now - InterruptedRunStaleAfter;
        var staleClock = Builders<DocumentStoreAgentRun>.Filter.Or(
            Builders<DocumentStoreAgentRun>.Filter.Lt(r => r.HeartbeatAt, staleAt),
            Builders<DocumentStoreAgentRun>.Filter.And(
                Builders<DocumentStoreAgentRun>.Filter.Eq(r => r.HeartbeatAt, null),
                Builders<DocumentStoreAgentRun>.Filter.Lt(r => r.StartedAt, staleAt)),
            Builders<DocumentStoreAgentRun>.Filter.And(
                Builders<DocumentStoreAgentRun>.Filter.Eq(r => r.HeartbeatAt, null),
                Builders<DocumentStoreAgentRun>.Filter.Eq(r => r.StartedAt, null),
                Builders<DocumentStoreAgentRun>.Filter.Lt(r => r.CreatedAt, staleAt)));
        var recoverFilter = Builders<DocumentStoreAgentRun>.Filter.And(
            Builders<DocumentStoreAgentRun>.Filter.Eq(
                r => r.Status,
                DocumentStoreRunStatus.Running),
            ownerScope,
            staleClock);
        var candidates = await db.DocumentStoreAgentRuns
            .Find(recoverFilter)
            .Limit(100)
            .ToListAsync(CancellationToken.None);
        var recovered = 0;
        foreach (var candidate in candidates)
        {
            IAsyncDisposable? outputLease = null;
            try
            {
                // AutoLink 等知识库级任务没有 SourceEntryId，属于合法模型，不应强行取得条目锁。
                if (!string.IsNullOrWhiteSpace(candidate.SourceEntryId))
                {
                    outputLease = await DocumentStoreRunOutputLease.AcquireAsync(
                        db,
                        candidate.SourceEntryId,
                        candidate.Kind,
                        CancellationToken.None);
                }
                var current = await db.DocumentStoreAgentRuns
                    .Find(Builders<DocumentStoreAgentRun>.Filter.And(
                        Builders<DocumentStoreAgentRun>.Filter.Eq(r => r.Id, candidate.Id),
                        recoverFilter))
                    .FirstOrDefaultAsync(CancellationToken.None);
                if (current == null) continue;

                UpdateDefinition<DocumentStoreAgentRun> update;
                if (DocumentRecordingArchiveWorker.HasDeferredTranscriptionAutomaticRetryBudget(current))
                {
                    update = Builders<DocumentStoreAgentRun>.Update
                        .Set(r => r.Status, DocumentStoreRunStatus.Queued)
                        .Set(r => r.Phase, "服务中断，正在恢复完整录音转录")
                        .Set(r => r.Progress, 0)
                        .Set(r => r.ErrorMessage, null)
                        .Set(r => r.FailureCode, null)
                        .Set(r => r.EndedAt, null)
                        .Set(r => r.StartedAt, null)
                        .Set(r => r.HeartbeatAt, null)
                        .Set(r => r.ExecutionId, string.Empty)
                        .Set(r => r.AutomaticRetryNextAt, null)
                        .Set(r => r.OwnerInstanceId, instanceId)
                        .Set(
                            r => r.AutomaticRetryReason,
                            DocumentRecordingArchiveWorker.DeferredRetryReasonRestartInterrupted)
                        .Inc(r => r.AutomaticRetryCount, 1);
                }
                else
                {
                    update = Builders<DocumentStoreAgentRun>.Update
                        .Set(r => r.Status, DocumentStoreRunStatus.Failed)
                        .Set(r => r.OwnerInstanceId, instanceId)
                        .Set(r => r.ErrorMessage, "后台任务已失联，请手动重试；原始内容仍然保留。")
                        .Set(r => r.FailureCode, "WORKER_INTERRUPTED")
                        .Set(r => r.HeartbeatAt, null)
                        .Set(r => r.ExecutionId, string.Empty)
                        .Set(r => r.EndedAt, now)
                        .Set(r => r.AutomaticRetryNextAt, null)
                        .Set(r => r.AutomaticRetryReason, null);
                }
                var result = await db.DocumentStoreAgentRuns.UpdateOneAsync(
                    Builders<DocumentStoreAgentRun>.Filter.And(
                        Builders<DocumentStoreAgentRun>.Filter.Eq(r => r.Id, current.Id),
                        Builders<DocumentStoreAgentRun>.Filter.Eq(
                            r => r.ExecutionId,
                            current.ExecutionId),
                        recoverFilter),
                    update,
                    cancellationToken: CancellationToken.None);
                if (result.ModifiedCount == 1) recovered++;
            }
            catch (Exception ex)
            {
                _logger.LogError(
                    ex,
                    "[doc-store-agent] Interrupted run recovery skipped run {RunId}",
                    candidate.Id);
            }
            finally
            {
                if (outputLease != null)
                    await outputLease.DisposeAsync();
            }
        }

        if (recovered > 0)
        {
            _logger.LogWarning(
                "[doc-store-agent] Recovered {Count} heartbeat-stalled run(s)",
                recovered);
        }
    }

    private async Task ProcessNextRunAsync()
    {
        using var scope = _scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MongoDbContext>();
        var runStore = scope.ServiceProvider.GetRequiredService<IRunEventStore>();

        // 原子拾取一个 queued 任务（按创建时间）——定向消费：只领取属于本实例的任务，
        // 外加历史无主（OwnerInstanceId 空）的任务做兼容，避免共享 Mongo 下多容器互抢（见 InstanceIdentity）。
        var configuration = scope.ServiceProvider.GetRequiredService<IConfiguration>();
        var instanceId = InstanceIdentity.Get(configuration);
        var compatibleOwnerIds = InstanceIdentity.GetCompatibleOwnerIds(configuration);
        var ownerScope = LegacyOwnerScope.Build<DocumentStoreAgentRun>(
            nameof(DocumentStoreAgentRun.OwnerInstanceId),
            compatibleOwnerIds,
            includeUnowned: true,
            retiredLegacyOwnerIds: DeploymentAuthority.GetRetiredLegacyBranchOwnerIds(configuration),
            legacyOwnerCreatedBeforeUtc: DeploymentAuthority.GetRetiredLegacyBranchOwnerCreatedBeforeUtc(configuration));
        var filter = Builders<DocumentStoreAgentRun>.Filter.And(
            Builders<DocumentStoreAgentRun>.Filter.Eq(r => r.Status, DocumentStoreRunStatus.Queued),
            Builders<DocumentStoreAgentRun>.Filter.Or(
                Builders<DocumentStoreAgentRun>.Filter.Eq(
                    r => r.AutomaticRetryNextAt,
                    null),
                Builders<DocumentStoreAgentRun>.Filter.Lte(
                    r => r.AutomaticRetryNextAt,
                    DateTime.UtcNow)),
            ownerScope);
        var claimedAt = DateTime.UtcNow;
        var executionId = Guid.NewGuid().ToString("N");
        var update = Builders<DocumentStoreAgentRun>.Update
            .Set(r => r.Status, DocumentStoreRunStatus.Running)
            // 认领时盖上本实例归属：领取历史无主任务后必须打主，否则本实例崩溃重启时
            // "只回收本实例 Running"的兜底匹配不到它，会让该任务永远卡在 running（Bugbot Medium）。
            .Set(r => r.OwnerInstanceId, instanceId)
            .Set(r => r.AutomaticRetryNextAt, null)
            .Set(r => r.ErrorMessage, null)
            .Set(r => r.FailureCode, null)
            .Set(r => r.EndedAt, null)
            .Set(r => r.StartedAt, claimedAt)
            .Set(r => r.HeartbeatAt, claimedAt)
            .Set(r => r.ExecutionId, executionId);
        var run = await db.DocumentStoreAgentRuns.FindOneAndUpdateAsync(
            filter, update,
            new FindOneAndUpdateOptions<DocumentStoreAgentRun>
            {
                Sort = Builders<DocumentStoreAgentRun>.Sort.Ascending(r => r.CreatedAt),
                ReturnDocument = ReturnDocument.After,
            });
        if (run == null) return;

        _currentRunId = run.Id;
        _currentExecutionId = run.ExecutionId;
        _logger.LogInformation("[doc-store-agent] Picked run {RunId} kind={Kind} entry={EntryId}",
            run.Id, run.Kind, run.SourceEntryId);

        using var heartbeatCts = new CancellationTokenSource();
        var heartbeatTask = MaintainRunHeartbeatAsync(
            db,
            run.Id,
            run.ExecutionId,
            heartbeatCts.Token);
        try
        {
            var kindForEvents = KindForEvents(run.Kind);

            await EmitEventAsync(runStore, kindForEvents, run.Id, "phase", new { phase = "started" });

            if (run.Kind == DocumentStoreAgentRunKind.Subtitle)
            {
                var processor = scope.ServiceProvider.GetRequiredService<SubtitleGenerationProcessor>();
                await processor.ProcessAsync(run, db, runStore);
            }
            else if (run.Kind == DocumentStoreAgentRunKind.Reprocess)
            {
                var processor = scope.ServiceProvider.GetRequiredService<ContentReprocessProcessor>();
                await processor.ProcessAsync(run, db, runStore);
            }
            else if (run.Kind == DocumentStoreAgentRunKind.AutoLink)
            {
                var processor = scope.ServiceProvider.GetRequiredService<AutoLinkProcessor>();
                await processor.ProcessAsync(run, db, runStore);
            }
            else if (run.Kind == DocumentStoreAgentRunKind.Transcribe)
            {
                // 录音转录全链路与字幕生成共用同一处理器（ASR 分发一致，产物不同）
                var processor = scope.ServiceProvider.GetRequiredService<SubtitleGenerationProcessor>();
                await processor.ProcessTranscribeAsync(run, db, runStore);
            }
            else
            {
                throw new InvalidOperationException($"未知 Run kind: {run.Kind}");
            }

            // 读最新状态（processor 可能已经更新了 OutputEntryId 等）
            var finalRun = await db.DocumentStoreAgentRuns
                .Find(CurrentExecutionFilter(run))
                .FirstOrDefaultAsync();
            var completed = await db.DocumentStoreAgentRuns.UpdateOneAsync(
                CurrentExecutionFilter(run),
                Builders<DocumentStoreAgentRun>.Update
                    .Set(r => r.Status, DocumentStoreRunStatus.Done)
                    .Set(r => r.Phase, "完成")
                    .Set(r => r.Progress, 100)
                    .Set(r => r.AutomaticRetryNextAt, null)
                    .Set(r => r.AutomaticRetryReason, null)
                    .Set(r => r.FailureCode, null)
                    .Set(r => r.HeartbeatAt, null)
                    .Set(r => r.EndedAt, DateTime.UtcNow),
                cancellationToken: CancellationToken.None);
            if (completed.ModifiedCount == 0)
            {
                _logger.LogWarning(
                    "[doc-store-agent] Run {RunId} lost its lease before completion; terminal write skipped",
                    run.Id);
                return;
            }

            if (run.Kind == DocumentStoreAgentRunKind.Transcribe)
            {
                try
                {
                    await DocumentRecordingArchiveWorker
                        .AcknowledgeDeferredTranscriptionSuccessAsync(
                            db.DocumentRecordingUploadSessions,
                            run.Id,
                            run.SourceEntryId,
                            CancellationToken.None);
                }
                catch (Exception ex)
                {
                    // run 已经是 Done，确认失败不能反向改成 Failed。录音归档 Worker
                    // 会保留 pending outbox，并在下一轮看到 Done 后补确认。
                    _logger.LogWarning(
                        ex,
                        "[doc-store-agent] Deferred transcription outbox acknowledgement deferred run={RunId}",
                        run.Id);
                }
            }

            await EmitEventAsync(runStore, kindForEvents, run.Id, "done", new
            {
                outputEntryId = finalRun?.OutputEntryId,
                generatedText = finalRun?.GeneratedText,
            });

            _logger.LogInformation("[doc-store-agent] Run {RunId} done", run.Id);
        }
        catch (DocumentStoreRunLeaseLostException)
        {
            _logger.LogWarning(
                "[doc-store-agent] Run {RunId} was superseded while processing; stale output was not written",
                run.Id);
            var supersededAt = DateTime.UtcNow;
            var superseded = await TryMarkSupersededAsync(
                db.DocumentStoreAgentRuns,
                run,
                supersededAt,
                CancellationToken.None);
            if (superseded)
            {
                await EmitEventAsync(runStore, KindForEvents(run.Kind), run.Id, "error", new
                {
                    message = "这次后台转录已由更新的任务接管，旧任务不会覆盖新结果。",
                });
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[doc-store-agent] Run {RunId} failed", run.Id);
            var transcriptionFailure = ex is SubtitleAsrException
                || run.Kind == DocumentStoreAgentRunKind.Transcribe
                || run.Kind == DocumentStoreAgentRunKind.Subtitle
                ? AudioTranscriptionUserError.Classify(ex)
                : null;
            var failedAt = DateTime.UtcNow;
            var willRetry = DocumentRecordingArchiveWorker
                .HasDeferredTranscriptionAutomaticRetryBudget(run)
                && (transcriptionFailure?.AutomaticRetryAllowed ?? true);
            var userMessage = transcriptionFailure is null
                ? "内容处理暂时失败。请稍后重试；已上传的原始内容仍会保留。"
                : AudioTranscriptionUserError.ForRetryOutcome(transcriptionFailure, willRetry);
            UpdateDefinition<DocumentStoreAgentRun> failedUpdate;
            DateTime? retryAt = null;
            if (willRetry)
            {
                retryAt = failedAt + DocumentRecordingArchiveWorker
                    .ComputeDeferredTranscriptionRetryBackoff(run.AutomaticRetryCount);
                failedUpdate = Builders<DocumentStoreAgentRun>.Update
                    .Set(r => r.Status, DocumentStoreRunStatus.Queued)
                    .Set(r => r.Phase, "转录暂时不可用，等待自动重试")
                    .Set(r => r.Progress, 0)
                    .Set(r => r.ErrorMessage, null)
                    .Set(r => r.FailureCode, null)
                    .Set(r => r.StartedAt, null)
                    .Set(r => r.HeartbeatAt, null)
                    .Set(r => r.ExecutionId, string.Empty)
                    .Set(r => r.EndedAt, null)
                    .Set(
                        r => r.AutomaticRetryNextAt,
                        retryAt)
                    .Set(
                        r => r.AutomaticRetryReason,
                        DocumentRecordingArchiveWorker.DeferredRetryReasonExecutionFailed)
                    .Inc(r => r.AutomaticRetryCount, 1);
            }
            else
            {
                failedUpdate = Builders<DocumentStoreAgentRun>.Update
                    .Set(r => r.Status, DocumentStoreRunStatus.Failed)
                    .Set(r => r.ErrorMessage, userMessage)
                    .Set(r => r.FailureCode, transcriptionFailure?.Code)
                    .Set(r => r.HeartbeatAt, null)
                    .Set(r => r.EndedAt, failedAt)
                    .Set(r => r.AutomaticRetryNextAt, null)
                    .Set(r => r.AutomaticRetryReason, null);
            }

            var failedWrite = await db.DocumentStoreAgentRuns.UpdateOneAsync(
                CurrentExecutionFilter(run),
                failedUpdate,
                cancellationToken: CancellationToken.None);
            if (failedWrite.ModifiedCount == 0)
            {
                _logger.LogWarning(
                    "[doc-store-agent] Run {RunId} lost its lease before failure persistence; stale outbox and events skipped",
                    run.Id);
                return;
            }

            if (!willRetry && run.Kind == DocumentStoreAgentRunKind.Transcribe)
            {
                try
                {
                    await DocumentRecordingArchiveWorker.CloseDeferredTranscriptionOutboxAsync(
                        db.DocumentRecordingUploadSessions,
                        run.Id,
                        run.SourceEntryId,
                        CancellationToken.None);
                }
                catch (Exception closeError)
                {
                    // run 的终态已经持久化；关闭 outbox 失败时保留 pending，归档 Worker
                    // 下一轮读取同一固定 run 后会幂等补关闭，不能反向改写 run 结果。
                    _logger.LogWarning(
                        closeError,
                        "[doc-store-agent] Terminal deferred transcription outbox closure deferred run={RunId}",
                        run.Id);
                }
            }

            if (willRetry)
            {
                await EmitEventAsync(runStore, KindForEvents(run.Kind), run.Id, "phase", new
                {
                    phase = "转录暂时不可用，等待自动重试",
                    retryAt,
                    retryCount = run.AutomaticRetryCount + 1,
                    maxRetries = DocumentRecordingArchiveWorker
                        .MaxDeferredTranscriptionAutomaticRetries,
                });
            }
            else
            {
                await EmitEventAsync(runStore, KindForEvents(run.Kind), run.Id, "error", new
                {
                    message = userMessage,
                });
            }
        }
        finally
        {
            heartbeatCts.Cancel();
            try { await heartbeatTask; }
            catch (OperationCanceledException) { }
            _currentRunId = null;
            _currentExecutionId = null;
        }
    }

    private static async Task MaintainRunHeartbeatAsync(
        MongoDbContext db,
        string runId,
        string executionId,
        CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            await Task.Delay(TimeSpan.FromSeconds(15), cancellationToken);
            try
            {
                await TryRenewHeartbeatAsync(
                    db.DocumentStoreAgentRuns,
                    runId,
                    executionId,
                    DateTime.UtcNow,
                    cancellationToken);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch
            {
                // Mongo 短暂抖动不能让心跳协程反向击穿业务任务；下一轮会继续续租。
            }
        }
    }

    internal static async Task<bool> TryRenewHeartbeatAsync(
        IMongoCollection<DocumentStoreAgentRun> runs,
        string runId,
        string executionId,
        DateTime heartbeatAt,
        CancellationToken cancellationToken)
    {
        var result = await runs.UpdateOneAsync(
            r => r.Id == runId
                 && r.Status == DocumentStoreRunStatus.Running
                 && r.ExecutionId == executionId,
            Builders<DocumentStoreAgentRun>.Update.Set(r => r.HeartbeatAt, heartbeatAt),
            cancellationToken: cancellationToken);
        return result.ModifiedCount == 1;
    }

    internal static FilterDefinition<DocumentStoreAgentRun> CurrentExecutionFilter(
        DocumentStoreAgentRun run)
        => Builders<DocumentStoreAgentRun>.Filter.And(
            Builders<DocumentStoreAgentRun>.Filter.Eq(candidate => candidate.Id, run.Id),
            Builders<DocumentStoreAgentRun>.Filter.Eq(
                candidate => candidate.Status,
                DocumentStoreRunStatus.Running),
            Builders<DocumentStoreAgentRun>.Filter.Eq(
                candidate => candidate.ExecutionId,
                run.ExecutionId));

    internal static async Task EnsureCurrentExecutionAsync(
        IMongoCollection<DocumentStoreAgentRun> runs,
        DocumentStoreAgentRun run,
        CancellationToken cancellationToken)
    {
        if (!await runs.Find(CurrentExecutionFilter(run)).AnyAsync(cancellationToken))
            throw new DocumentStoreRunLeaseLostException(run.Id);
    }

    internal static async Task<bool> TryMarkSupersededAsync(
        IMongoCollection<DocumentStoreAgentRun> runs,
        DocumentStoreAgentRun run,
        DateTime supersededAt,
        CancellationToken cancellationToken)
    {
        var result = await runs.UpdateOneAsync(
            CurrentExecutionFilter(run),
            Builders<DocumentStoreAgentRun>.Update
                .Set(r => r.Status, DocumentStoreRunStatus.Failed)
                .Set(r => r.Phase, "已有更新的录音任务接管")
                .Set(r => r.ErrorMessage, "这次后台转录已由更新的任务接管，旧任务不会覆盖新结果。")
                .Set(r => r.FailureCode, "TRANSCRIPTION_RUN_SUPERSEDED")
                .Set(r => r.HeartbeatAt, null)
                .Set(r => r.EndedAt, supersededAt)
                .Set(r => r.AutomaticRetryNextAt, null)
                .Set(r => r.AutomaticRetryReason, null),
            cancellationToken: cancellationToken);
        return result.ModifiedCount == 1;
    }

    /// <summary>Run kind → IRunEventStore 事件 kind 的映射（Controller 的 SSE 端点用同一映射）。</summary>
    internal static string KindForEvents(string kind) => kind switch
    {
        DocumentStoreAgentRunKind.Subtitle => DocumentStoreRunKinds.Subtitle,
        DocumentStoreAgentRunKind.AutoLink => DocumentStoreRunKinds.AutoLink,
        DocumentStoreAgentRunKind.Transcribe => DocumentStoreRunKinds.Transcribe,
        _ => DocumentStoreRunKinds.Reprocess,
    };

    /// <summary>
    /// 推 SSE 事件 —— 套 3 秒硬超时，杜绝 Redis 抖动让 AppendEventAsync 永久挂起
    /// 进而拖死整个 Worker 主循环（实测：当 Redis 连接 multiplexer 处于半失活时，
    /// StringIncrementAsync 不会按 SyncTimeout 抛异常而是直接 hang）。
    /// </summary>
    private static async Task EmitEventAsync(
        IRunEventStore runStore, string kind, string runId, string eventName, object payload)
    {
        try
        {
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(3));
            await runStore.AppendEventAsync(kind, runId, eventName, payload, ct: cts.Token);
        }
        catch { /* 事件失败不阻塞主流程 */ }
    }
}

internal sealed class DocumentStoreRunLeaseLostException(string runId)
    : InvalidOperationException($"Document store run lease lost: {runId}");
