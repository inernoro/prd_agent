using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

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
                    await db.DocumentStoreAgentRuns.UpdateOneAsync(
                        r => r.Id == _currentRunId && r.Status == DocumentStoreRunStatus.Running,
                        Builders<DocumentStoreAgentRun>.Update
                            .Set(r => r.Status, DocumentStoreRunStatus.Failed)
                            .Set(r => r.ErrorMessage, "Worker 关闭，任务被中断")
                            .Set(r => r.EndedAt, DateTime.UtcNow),
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

        // 原子拾取一个 queued 任务（按创建时间）
        var filter = Builders<DocumentStoreAgentRun>.Filter.Eq(r => r.Status, DocumentStoreRunStatus.Queued);
        var update = Builders<DocumentStoreAgentRun>.Update
            .Set(r => r.Status, DocumentStoreRunStatus.Running)
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
            var kindForEvents = run.Kind == DocumentStoreAgentRunKind.Subtitle
                ? DocumentStoreRunKinds.Subtitle
                : DocumentStoreRunKinds.Reprocess;

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
                    .Set(r => r.Progress, 100)
                    .Set(r => r.EndedAt, DateTime.UtcNow),
                cancellationToken: CancellationToken.None);

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
            await db.DocumentStoreAgentRuns.UpdateOneAsync(
                r => r.Id == run.Id,
                Builders<DocumentStoreAgentRun>.Update
                    .Set(r => r.Status, DocumentStoreRunStatus.Failed)
                    .Set(r => r.ErrorMessage, msg)
                    .Set(r => r.EndedAt, DateTime.UtcNow),
                cancellationToken: CancellationToken.None);

            var kindForEvents = run.Kind == DocumentStoreAgentRunKind.Subtitle
                ? DocumentStoreRunKinds.Subtitle
                : DocumentStoreRunKinds.Reprocess;
            await EmitEventAsync(runStore, kindForEvents, run.Id, "error", new { message = msg });
        }
        finally
        {
            _currentRunId = null;
        }
    }

    private static async Task EmitEventAsync(
        IRunEventStore runStore, string kind, string runId, string eventName, object payload)
    {
        try
        {
            await runStore.AppendEventAsync(kind, runId, eventName, payload, ct: CancellationToken.None);
        }
        catch { /* 事件失败不阻塞主流程 */ }
    }
}
