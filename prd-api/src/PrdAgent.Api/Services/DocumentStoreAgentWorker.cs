using Microsoft.Extensions.Configuration;
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
            var instanceId = InstanceIdentity.Get(scope.ServiceProvider.GetRequiredService<IConfiguration>());
            var recovered = await db.DocumentStoreAgentRuns.UpdateManyAsync(
                r => r.Status == DocumentStoreRunStatus.Running && r.OwnerInstanceId == instanceId,
                Builders<DocumentStoreAgentRun>.Update
                    .Set(r => r.Status, DocumentStoreRunStatus.Failed)
                    .Set(r => r.ErrorMessage, "服务重启，任务被中断")
                    .Set(r => r.EndedAt, DateTime.UtcNow),
                cancellationToken: CancellationToken.None);
            if (recovered.ModifiedCount > 0)
                _logger.LogWarning(
                    "[doc-store-agent] 启动兜底：{Count} 个残留 Running 任务标记为失败",
                    recovered.ModifiedCount);
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

        // 原子拾取一个 queued 任务（按创建时间）——定向消费：只领取属于本实例的任务，
        // 外加历史无主（OwnerInstanceId 空）的任务做兼容，避免共享 Mongo 下多容器互抢（见 InstanceIdentity）。
        var instanceId = InstanceIdentity.Get(scope.ServiceProvider.GetRequiredService<IConfiguration>());
        var filter = Builders<DocumentStoreAgentRun>.Filter.And(
            Builders<DocumentStoreAgentRun>.Filter.Eq(r => r.Status, DocumentStoreRunStatus.Queued),
            Builders<DocumentStoreAgentRun>.Filter.Or(
                Builders<DocumentStoreAgentRun>.Filter.Eq(r => r.OwnerInstanceId, instanceId),
                Builders<DocumentStoreAgentRun>.Filter.Eq(r => r.OwnerInstanceId, (string?)null),
                Builders<DocumentStoreAgentRun>.Filter.Eq(r => r.OwnerInstanceId, "")));
        var update = Builders<DocumentStoreAgentRun>.Update
            .Set(r => r.Status, DocumentStoreRunStatus.Running)
            // 认领时盖上本实例归属：领取历史无主任务后必须打主，否则本实例崩溃重启时
            // "只回收本实例 Running"的兜底匹配不到它，会让该任务永远卡在 running（Bugbot Medium）。
            .Set(r => r.OwnerInstanceId, instanceId)
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

            await db.DocumentStoreAgentRuns.UpdateOneAsync(
                r => r.Id == run.Id,
                Builders<DocumentStoreAgentRun>.Update
                    .Set(r => r.Status, DocumentStoreRunStatus.Failed)
                    .Set(r => r.ErrorMessage, errorMessageForDb)
                    .Set(r => r.EndedAt, DateTime.UtcNow),
                cancellationToken: CancellationToken.None);

            var kindForEvents = run.Kind == DocumentStoreAgentRunKind.Subtitle
                ? DocumentStoreRunKinds.Subtitle
                : DocumentStoreRunKinds.Reprocess;
            await EmitEventAsync(runStore, kindForEvents, run.Id, "error", new
            {
                message = msg,
                diagnostic,
            });
        }
        finally
        {
            _currentRunId = null;
        }
    }

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
