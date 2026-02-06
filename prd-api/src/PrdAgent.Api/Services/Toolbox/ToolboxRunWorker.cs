using System.Text.Json;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models.Toolbox;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services.Toolbox;

/// <summary>
/// 百宝箱后台任务执行器
/// 从队列中获取 Run 并执行
/// </summary>
public class ToolboxRunWorker : BackgroundService
{
    private readonly IServiceProvider _serviceProvider;
    private readonly IRunQueue _runQueue;
    private readonly ILogger<ToolboxRunWorker> _logger;

    public const string RunKind = "toolbox";
    private static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(1);

    public ToolboxRunWorker(
        IServiceProvider serviceProvider,
        IRunQueue runQueue,
        ILogger<ToolboxRunWorker> logger)
    {
        _serviceProvider = serviceProvider;
        _runQueue = runQueue;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _logger.LogInformation("ToolboxRunWorker 启动");

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                // 从队列获取任务
                var runId = await _runQueue.DequeueAsync(RunKind, PollInterval, stoppingToken);

                if (string.IsNullOrEmpty(runId))
                {
                    await Task.Delay(PollInterval, stoppingToken);
                    continue;
                }

                _logger.LogInformation("ToolboxRunWorker 开始处理: {RunId}", runId);

                // 使用独立的 scope 处理任务
                using var scope = _serviceProvider.CreateScope();
                await ProcessRunAsync(scope.ServiceProvider, runId, stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "ToolboxRunWorker 处理任务异常");
                await Task.Delay(TimeSpan.FromSeconds(5), stoppingToken);
            }
        }

        _logger.LogInformation("ToolboxRunWorker 停止");
    }

    private async Task ProcessRunAsync(IServiceProvider sp, string runId, CancellationToken ct)
    {
        var db = sp.GetRequiredService<MongoDbContext>();
        var orchestrator = sp.GetRequiredService<IToolboxOrchestrator>();
        var eventStore = sp.GetRequiredService<IToolboxEventStore>();

        // 加载 Run
        var run = await db.ToolboxRuns.Find(r => r.Id == runId).FirstOrDefaultAsync(CancellationToken.None);
        if (run == null)
        {
            _logger.LogWarning("Run 不存在: {RunId}", runId);
            return;
        }

        // 更新状态为运行中
        run.Status = ToolboxRunStatus.Running;
        run.StartedAt = DateTime.UtcNow;
        await UpdateRunAsync(db, run);

        try
        {
            // 执行编排，使用 CancellationToken.None 保证服务端权威性
            await foreach (var evt in orchestrator.ExecuteRunAsync(run, CancellationToken.None))
            {
                // 保存事件到存储
                await eventStore.AppendEventAsync(runId, evt, CancellationToken.None);

                // 根据事件类型更新 Run 状态
                await UpdateRunFromEventAsync(db, run, evt);
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Run 执行异常: {RunId}", runId);
            run.Status = ToolboxRunStatus.Failed;
            run.ErrorMessage = ex.Message;
            run.CompletedAt = DateTime.UtcNow;
            await UpdateRunAsync(db, run);

            // 发送失败事件
            await eventStore.AppendEventAsync(runId, ToolboxRunEvent.RunFailed(ex.Message, run.LastSeq + 1), CancellationToken.None);
        }
    }

    private static async Task UpdateRunFromEventAsync(MongoDbContext db, ToolboxRun run, ToolboxRunEvent evt)
    {
        run.LastSeq = evt.Seq;

        switch (evt.Type)
        {
            case ToolboxRunEventType.StepCompleted:
                var completedStep = run.Steps.FirstOrDefault(s => s.StepId == evt.StepId);
                if (completedStep != null)
                {
                    completedStep.Status = ToolboxStepStatus.Completed;
                    completedStep.Output = evt.Content;
                    completedStep.CompletedAt = DateTime.UtcNow;
                }
                break;

            case ToolboxRunEventType.StepFailed:
                var failedStep = run.Steps.FirstOrDefault(s => s.StepId == evt.StepId);
                if (failedStep != null)
                {
                    failedStep.Status = ToolboxStepStatus.Failed;
                    failedStep.ErrorMessage = evt.ErrorMessage;
                    failedStep.CompletedAt = DateTime.UtcNow;
                }
                break;

            case ToolboxRunEventType.StepArtifact:
                if (evt.Artifact != null)
                {
                    run.Artifacts.Add(evt.Artifact);
                }
                break;

            case ToolboxRunEventType.RunCompleted:
                run.Status = ToolboxRunStatus.Completed;
                run.FinalResponse = evt.Content;
                run.CompletedAt = DateTime.UtcNow;
                break;

            case ToolboxRunEventType.RunFailed:
                run.Status = ToolboxRunStatus.Failed;
                run.ErrorMessage = evt.ErrorMessage;
                run.CompletedAt = DateTime.UtcNow;
                break;
        }

        await UpdateRunAsync(db, run);
    }

    private static async Task UpdateRunAsync(MongoDbContext db, ToolboxRun run)
    {
        await db.ToolboxRuns.ReplaceOneAsync(
            r => r.Id == run.Id,
            run,
            new ReplaceOptions { IsUpsert = false },
            CancellationToken.None);
    }
}

/// <summary>
/// 百宝箱事件存储接口
/// </summary>
public interface IToolboxEventStore
{
    /// <summary>
    /// 追加事件
    /// </summary>
    Task AppendEventAsync(string runId, ToolboxRunEvent evt, CancellationToken ct);

    /// <summary>
    /// 获取事件（支持 afterSeq）
    /// </summary>
    IAsyncEnumerable<ToolboxRunEvent> GetEventsAsync(string runId, long afterSeq, CancellationToken ct);

    /// <summary>
    /// 获取最新序列号
    /// </summary>
    Task<long> GetLastSeqAsync(string runId, CancellationToken ct);
}

/// <summary>
/// Redis 实现的事件存储
/// </summary>
public class RedisToolboxEventStore : IToolboxEventStore
{
    private readonly StackExchange.Redis.ConnectionMultiplexer _redis;
    private readonly ILogger<RedisToolboxEventStore> _logger;
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    private static readonly TimeSpan EventTtl = TimeSpan.FromHours(24);

    public RedisToolboxEventStore(
        StackExchange.Redis.ConnectionMultiplexer redis,
        ILogger<RedisToolboxEventStore> logger)
    {
        _redis = redis;
        _logger = logger;
    }

    private static string GetKey(string runId) => $"toolbox:events:{runId}";

    public async Task AppendEventAsync(string runId, ToolboxRunEvent evt, CancellationToken ct)
    {
        var db = _redis.GetDatabase();
        var key = GetKey(runId);
        var json = JsonSerializer.Serialize(evt, JsonOptions);

        await db.SortedSetAddAsync(key, json, evt.Seq);
        await db.KeyExpireAsync(key, EventTtl);
    }

    public async IAsyncEnumerable<ToolboxRunEvent> GetEventsAsync(
        string runId,
        long afterSeq,
        [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken ct)
    {
        var db = _redis.GetDatabase();
        var key = GetKey(runId);

        var entries = await db.SortedSetRangeByScoreAsync(key, afterSeq + 1, double.PositiveInfinity);

        foreach (var entry in entries)
        {
            if (ct.IsCancellationRequested) yield break;

            var evt = JsonSerializer.Deserialize<ToolboxRunEvent>(entry.ToString(), JsonOptions);
            if (evt != null)
            {
                yield return evt;
            }
        }
    }

    public async Task<long> GetLastSeqAsync(string runId, CancellationToken ct)
    {
        var db = _redis.GetDatabase();
        var key = GetKey(runId);

        var lastEntry = await db.SortedSetRangeByRankAsync(key, -1, -1);
        if (lastEntry.Length == 0) return 0;

        var evt = JsonSerializer.Deserialize<ToolboxRunEvent>(lastEntry[0].ToString(), JsonOptions);
        return evt?.Seq ?? 0;
    }
}
