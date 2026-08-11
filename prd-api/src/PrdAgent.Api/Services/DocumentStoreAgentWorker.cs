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

    /// <summary>每 3 秒轮询一次 queued 任务</summary>
    private static readonly TimeSpan ScanInterval = TimeSpan.FromSeconds(3);

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

        // 启动兜底回收：上一个容器异常退出（重新部署 / 崩溃 / SIGKILL）时，正在处理的
        // run 会残留为 Running 状态——此刻已没有任何 worker 在跑它，但前端 getAgentRun
        // 永远拿到非终态、SSE 续传也收不到 done/error，进度卡片就卡死在「调用 LLM N%」。
        // 这里把所有残留 Running 标记为失败，让前端刷新后自愈为「加工失败」（server-authority #5）。
        // 注意：只回收 Running，Queued 留给正常拾取流程，不误杀未开始的任务。
        try
        {
            using var scope = _scopeFactory.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<MongoDbContext>();
            // 只回收【本实例】残留的 Running——共享 Mongo 下，不能把别的分支/主干正在处理的
            // Running 任务误判成"崩溃残留"标记失败（定向消费，见 InstanceIdentity）。
            var configuration = scope.ServiceProvider.GetRequiredService<IConfiguration>();
            var instanceId = InstanceIdentity.Get(configuration);
            var compatibleOwnerIds = InstanceIdentity.GetCompatibleOwnerIds(configuration);
            var ownerScope = LegacyOwnerScope.Build<DocumentStoreAgentRun>(
                nameof(DocumentStoreAgentRun.OwnerInstanceId),
                compatibleOwnerIds,
                includeUnowned: true,
                retiredLegacyOwnerIds: DeploymentAuthority.GetRetiredLegacyBranchOwnerIds(configuration));
            // 回收范围 = 本实例 Running + 历史无主 Running（OwnerInstanceId 空）。
            // 无主 Running 只可能由「定向消费上线前的旧代码」产生：旧代码不打 owner，
            // 这些 run 的容器一旦退出就永远没人回收、永远卡 running。把无主 Running 一并
            // 回收是一次性过渡兜底（上线后新 run 认领即打主，不再产生无主 Running）。
            // 代价：若另一实例此刻正在跑某个无主 Running，会被本实例误判失败——但无主 =
            // 旧代码遗留，归属本就不可分辨，这个过渡期代价可接受（Bugbot Medium）。
            var recoverFilter = Builders<DocumentStoreAgentRun>.Filter.And(
                Builders<DocumentStoreAgentRun>.Filter.Eq(r => r.Status, DocumentStoreRunStatus.Running),
                ownerScope);
            var automaticRetryBudgetFilter = DocumentRecordingArchiveWorker
                .BuildDeferredTranscriptionAutomaticRetryBudgetFilter();
            var deferredRecoverFilter = Builders<DocumentStoreAgentRun>.Filter.And(
                recoverFilter,
                Builders<DocumentStoreAgentRun>.Filter.Eq(
                    r => r.Kind,
                    DocumentStoreAgentRunKind.Transcribe),
                automaticRetryBudgetFilter,
                Builders<DocumentStoreAgentRun>.Filter.Regex(
                    r => r.Id,
                    new MongoDB.Bson.BsonRegularExpression("^recording-archive-transcribe-")));
            var restartAt = DateTime.UtcNow;
            var recoveredDeferred = await db.DocumentStoreAgentRuns.UpdateManyAsync(
                deferredRecoverFilter,
                Builders<DocumentStoreAgentRun>.Update
                    .Set(r => r.Status, DocumentStoreRunStatus.Queued)
                    .Set(r => r.Phase, "服务重启，正在恢复完整录音转录")
                    .Set(r => r.Progress, 0)
                    .Set(r => r.ErrorMessage, null)
                    .Set(r => r.EndedAt, null)
                    .Set(r => r.StartedAt, null)
                    .Set(r => r.AutomaticRetryNextAt, null)
                    .Set(r => r.OwnerInstanceId, instanceId)
                    .Set(
                        r => r.AutomaticRetryReason,
                        DocumentRecordingArchiveWorker.DeferredRetryReasonRestartInterrupted)
                    .Inc(r => r.AutomaticRetryCount, 1),
                cancellationToken: CancellationToken.None);
            var recoveredOther = await db.DocumentStoreAgentRuns.UpdateManyAsync(
                recoverFilter,
                Builders<DocumentStoreAgentRun>.Update
                    .Set(r => r.Status, DocumentStoreRunStatus.Failed)
                    .Set(r => r.OwnerInstanceId, instanceId)
                    .Set(r => r.ErrorMessage, "服务重启，任务被中断")
                    .Set(r => r.EndedAt, restartAt),
                cancellationToken: CancellationToken.None);
            var recoveredCount = recoveredDeferred.ModifiedCount + recoveredOther.ModifiedCount;
            if (recoveredCount > 0)
                _logger.LogWarning(
                    "[doc-store-agent] 启动兜底：回收 {Count} 个残留 Running 任务",
                    recoveredCount);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[doc-store-agent] 启动兜底回收失败");
        }

        try
        {
            while (!stoppingToken.IsCancellationRequested)
            {
                try
                {
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
            if (_currentRunId != null)
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
                                automaticRetryBudgetFilter),
                            Builders<DocumentStoreAgentRun>.Update
                                .Set(r => r.Status, DocumentStoreRunStatus.Queued)
                                .Set(r => r.Phase, "Worker 关闭，正在恢复完整录音转录")
                                .Set(r => r.Progress, 0)
                                .Set(r => r.ErrorMessage, null)
                                .Set(r => r.StartedAt, null)
                                .Set(r => r.EndedAt, null)
                                .Set(r => r.AutomaticRetryNextAt, null)
                                .Set(
                                    r => r.AutomaticRetryReason,
                                    DocumentRecordingArchiveWorker
                                        .DeferredRetryReasonRestartInterrupted)
                                .Inc(r => r.AutomaticRetryCount, 1),
                            cancellationToken: CancellationToken.None);
                    }
                    await db.DocumentStoreAgentRuns.UpdateOneAsync(
                        r => r.Id == _currentRunId && r.Status == DocumentStoreRunStatus.Running,
                        Builders<DocumentStoreAgentRun>.Update
                            .Set(r => r.Status, DocumentStoreRunStatus.Failed)
                            .Set(r => r.ErrorMessage, "Worker 关闭，任务被中断")
                            .Set(r => r.EndedAt, interruptedAt)
                            .Set(
                                r => r.AutomaticRetryNextAt,
                                null),
                        cancellationToken: CancellationToken.None);
                }
                catch { /* ignore */ }
            }
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
            retiredLegacyOwnerIds: DeploymentAuthority.GetRetiredLegacyBranchOwnerIds(configuration));
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
        var update = Builders<DocumentStoreAgentRun>.Update
            .Set(r => r.Status, DocumentStoreRunStatus.Running)
            // 认领时盖上本实例归属：领取历史无主任务后必须打主，否则本实例崩溃重启时
            // "只回收本实例 Running"的兜底匹配不到它，会让该任务永远卡在 running（Bugbot Medium）。
            .Set(r => r.OwnerInstanceId, instanceId)
            .Set(r => r.AutomaticRetryNextAt, null)
            .Set(r => r.ErrorMessage, null)
            .Set(r => r.EndedAt, null)
            .Set(r => r.StartedAt, DateTime.UtcNow);
        var run = await db.DocumentStoreAgentRuns.FindOneAndUpdateAsync(
            filter, update,
            new FindOneAndUpdateOptions<DocumentStoreAgentRun>
            {
                Sort = Builders<DocumentStoreAgentRun>.Sort.Ascending(r => r.CreatedAt),
                ReturnDocument = ReturnDocument.After,
            });
        if (run == null) return;

        _currentRunId = run.Id;
        _logger.LogInformation("[doc-store-agent] Picked run {RunId} kind={Kind} entry={EntryId}",
            run.Id, run.Kind, run.SourceEntryId);

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
            var finalRun = await db.DocumentStoreAgentRuns.Find(r => r.Id == run.Id).FirstOrDefaultAsync();
            await db.DocumentStoreAgentRuns.UpdateOneAsync(
                r => r.Id == run.Id,
                Builders<DocumentStoreAgentRun>.Update
                    .Set(r => r.Status, DocumentStoreRunStatus.Done)
                    .Set(r => r.Phase, "完成")
                    .Set(r => r.Progress, 100)
                    .Set(r => r.AutomaticRetryNextAt, null)
                    .Set(r => r.AutomaticRetryReason, null)
                    .Set(r => r.EndedAt, DateTime.UtcNow),
                cancellationToken: CancellationToken.None);

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
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[doc-store-agent] Run {RunId} failed", run.Id);
            var msg = ex.Message.Length > 500 ? ex.Message[..500] : ex.Message;

            // SubtitleAsrException 携带诊断信息，原样塞进 SSE error / run.errorMessage
            IDictionary<string, object?>? diagnostic = null;
            if (ex is PrdAgent.Api.Services.SubtitleAsrException sae)
                diagnostic = sae.Diagnostic;

            // run.errorMessage 在 UI 兜底展示（非 SSE 路径），把诊断序列化进去（截断 1500）
            string errorMessageForDb = msg;
            if (diagnostic != null)
            {
                try
                {
                    var diagJson = System.Text.Json.JsonSerializer.Serialize(diagnostic);
                    var combined = msg + "\n\n[diagnostic]\n" + diagJson;
                    errorMessageForDb = combined.Length > 1500 ? combined[..1500] : combined;
                }
                catch { /* fall back to plain msg */ }
            }

            var failedAt = DateTime.UtcNow;
            var willRetry = DocumentRecordingArchiveWorker
                .HasDeferredTranscriptionAutomaticRetryBudget(run);
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
                    .Set(r => r.StartedAt, null)
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
                    .Set(r => r.ErrorMessage, errorMessageForDb)
                    .Set(r => r.EndedAt, failedAt)
                    .Set(r => r.AutomaticRetryNextAt, null)
                    .Set(r => r.AutomaticRetryReason, null);
            }

            await db.DocumentStoreAgentRuns.UpdateOneAsync(
                r => r.Id == run.Id,
                failedUpdate,
                cancellationToken: CancellationToken.None);

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
                    message = msg,
                    diagnostic,
                });
            }
        }
        finally
        {
            _currentRunId = null;
        }
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
