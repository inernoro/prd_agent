using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services;

/// <summary>
/// 调度轮询 worker：每 30 秒扫一次 workflow_schedules，将到期的调度入队执行。
///   once 模式：触发后 IsEnabled = false，NextRunAt = null
///   cron 模式：触发后重新计算 NextRunAt
/// </summary>
public sealed class WorkflowScheduleWorker : BackgroundService
{
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly IRunQueue _runQueue;
    private readonly ILogger<WorkflowScheduleWorker> _logger;
    private static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(30);

    public WorkflowScheduleWorker(IServiceScopeFactory scopeFactory, IRunQueue runQueue, ILogger<WorkflowScheduleWorker> logger)
    {
        _scopeFactory = scopeFactory;
        _runQueue = runQueue;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _logger.LogInformation("WorkflowScheduleWorker started, poll interval = {Interval}s", PollInterval.TotalSeconds);

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await TickAsync();
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "WorkflowScheduleWorker tick failed");
            }

            try { await Task.Delay(PollInterval, stoppingToken); }
            catch (OperationCanceledException) { break; }
        }

        _logger.LogInformation("WorkflowScheduleWorker stopped");
    }

    private async Task TickAsync()
    {
        using var scope = _scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MongoDbContext>();

        var now = DateTime.UtcNow;
        var due = await db.WorkflowSchedules
            .Find(s => s.IsEnabled && s.NextRunAt != null && s.NextRunAt <= now)
            .Limit(50)
            .ToListAsync(CancellationToken.None);

        if (due.Count == 0) return;

        foreach (var schedule in due)
        {
            try
            {
                await TriggerAsync(db, schedule);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Schedule trigger failed: {Id} workflow={WorkflowId}", schedule.Id, schedule.WorkflowId);
            }
        }
    }

    private async Task TriggerAsync(MongoDbContext db, WorkflowSchedule schedule)
    {
        var workflow = await db.Workflows.Find(w => w.Id == schedule.WorkflowId).FirstOrDefaultAsync(CancellationToken.None);
        if (workflow == null)
        {
            _logger.LogWarning("Schedule {Id} 关联的工作流 {WorkflowId} 不存在，禁用此调度", schedule.Id, schedule.WorkflowId);
            await db.WorkflowSchedules.UpdateOneAsync(
                s => s.Id == schedule.Id,
                Builders<WorkflowSchedule>.Update.Set(s => s.IsEnabled, false),
                cancellationToken: CancellationToken.None);
            return;
        }

        // 合并变量：工作流默认值 < 调度覆盖
        var variables = new Dictionary<string, string>();
        foreach (var v in workflow.Variables)
        {
            if (v.DefaultValue != null) variables[v.Key] = v.DefaultValue;
        }
        if (schedule.VariableOverrides != null)
        {
            foreach (var kv in schedule.VariableOverrides) variables[kv.Key] = kv.Value;
        }

        var execution = new WorkflowExecution
        {
            WorkflowId = workflow.Id,
            WorkflowName = workflow.Name,
            TriggerType = schedule.Mode == "cron" ? WorkflowTriggerTypes.Cron : "scheduled-once",
            TriggeredBy = schedule.CreatedBy,
            TriggeredByName = $"schedule:{(string.IsNullOrWhiteSpace(schedule.Name) ? schedule.Id[..6] : schedule.Name)}",
            Variables = variables,
            NodeSnapshot = workflow.Nodes,
            EdgeSnapshot = workflow.Edges,
            NodeExecutions = workflow.Nodes.Select(n => new NodeExecution
            {
                NodeId = n.NodeId,
                NodeName = n.Name,
                NodeType = n.NodeType,
                Status = NodeExecutionStatus.Pending,
            }).ToList(),
            Status = WorkflowExecutionStatus.Queued,
        };
        execution.TraceId = $"workflow-execution-{execution.Id}";

        await db.WorkflowExecutions.InsertOneAsync(execution, cancellationToken: CancellationToken.None);
        await _runQueue.EnqueueAsync(RunKinds.Workflow, execution.Id, CancellationToken.None);

        // 更新 schedule
        DateTime? nextRunAt = null;
        bool keepEnabled = schedule.IsEnabled;
        if (schedule.Mode == "cron" && !string.IsNullOrWhiteSpace(schedule.CronExpression))
        {
            try
            {
                // 重新计算下次也按 schedule.Timezone，否则 cron `0 9 * * *` 会一直按 09:00 UTC 跑
                nextRunAt = CronEvaluator.NextOccurrence(schedule.CronExpression!, DateTime.UtcNow, schedule.Timezone);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Cron 重新计算失败，禁用此调度: {Id}", schedule.Id);
                keepEnabled = false;
            }
        }
        else
        {
            // once 模式，触发后停用
            keepEnabled = false;
        }

        await db.WorkflowSchedules.UpdateOneAsync(
            s => s.Id == schedule.Id,
            Builders<WorkflowSchedule>.Update
                .Set(s => s.LastTriggeredAt, DateTime.UtcNow)
                .Set(s => s.NextRunAt, nextRunAt)
                .Set(s => s.IsEnabled, keepEnabled)
                .Inc(s => s.TriggerCount, 1),
            cancellationToken: CancellationToken.None);

        _logger.LogInformation("Schedule {Id} triggered, execution={ExecId} workflow={WorkflowId} mode={Mode} next={Next}",
            schedule.Id, execution.Id, schedule.WorkflowId, schedule.Mode, nextRunAt);
    }
}
