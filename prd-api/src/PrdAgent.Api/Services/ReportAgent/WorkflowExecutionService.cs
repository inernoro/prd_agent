using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services.ReportAgent;

/// <summary>
/// 内部工作流执行服务实现（v2.0）：
/// 从 DB 加载工作流定义 → 创建 WorkflowExecution → 入队 → 轮询等待完成。
/// </summary>
public class WorkflowExecutionService : IWorkflowExecutionService
{
    private readonly MongoDbContext _db;
    private readonly IRunQueue _runQueue;
    private readonly ILogger<WorkflowExecutionService> _logger;

    public WorkflowExecutionService(MongoDbContext db, IRunQueue runQueue, ILogger<WorkflowExecutionService> logger)
    {
        _db = db;
        _runQueue = runQueue;
        _logger = logger;
    }

    public async Task<WorkflowExecution> ExecuteInternalAsync(
        string workflowId,
        Dictionary<string, string>? variables = null,
        string triggeredBy = "system",
        CancellationToken ct = default)
    {
        var workflow = await _db.Workflows.Find(w => w.Id == workflowId).FirstOrDefaultAsync(ct);
        if (workflow == null)
            throw new InvalidOperationException($"工作流不存在: {workflowId}");

        if (workflow.Nodes.Count == 0)
            throw new InvalidOperationException($"工作流没有节点，无法执行: {workflowId}");

        // 构建运行时变量：请求覆盖 > 工作流默认值
        var resolvedVars = new Dictionary<string, string>();
        foreach (var v in workflow.Variables)
        {
            if (variables?.TryGetValue(v.Key, out var val) == true)
                resolvedVars[v.Key] = val;
            else if (v.DefaultValue != null)
                resolvedVars[v.Key] = v.DefaultValue;
        }

        // 额外变量（不在工作流定义里的）也合并进来
        if (variables != null)
        {
            foreach (var kv in variables)
            {
                if (!resolvedVars.ContainsKey(kv.Key))
                    resolvedVars[kv.Key] = kv.Value;
            }
        }

        var execution = new WorkflowExecution
        {
            WorkflowId = workflow.Id,
            WorkflowName = workflow.Name,
            TriggerType = "internal",
            TriggeredBy = triggeredBy,
            TriggeredByName = triggeredBy,
            Variables = resolvedVars,
            NodeSnapshot = workflow.Nodes,
            EdgeSnapshot = workflow.Edges,
            NodeExecutions = workflow.Nodes.Select(n => new NodeExecution
            {
                NodeId = n.NodeId,
                NodeName = n.Name,
                NodeType = n.NodeType,
                Status = NodeExecutionStatus.Pending
            }).ToList(),
            Status = WorkflowExecutionStatus.Queued,
        };

        await _db.WorkflowExecutions.InsertOneAsync(execution, cancellationToken: CancellationToken.None);

        // 更新工作流统计
        await _db.Workflows.UpdateOneAsync(
            w => w.Id == workflowId,
            Builders<Workflow>.Update
                .Set(w => w.LastExecutedAt, DateTime.UtcNow)
                .Inc(w => w.ExecutionCount, 1),
            cancellationToken: CancellationToken.None);

        // 入队，WorkflowRunWorker 会消费
        await _runQueue.EnqueueAsync(RunKinds.Workflow, execution.Id, CancellationToken.None);

        _logger.LogInformation("[ReportAgent] Internal workflow execution queued: {ExecutionId} for workflow {WorkflowId}, triggeredBy={TriggeredBy}",
            execution.Id, workflowId, triggeredBy);

        return execution;
    }

    public async Task<WorkflowExecution> WaitForCompletionAsync(
        string executionId,
        TimeSpan timeout,
        CancellationToken ct = default)
    {
        var deadline = DateTime.UtcNow + timeout;
        var pollInterval = TimeSpan.FromSeconds(2);

        while (DateTime.UtcNow < deadline)
        {
            ct.ThrowIfCancellationRequested();

            var execution = await _db.WorkflowExecutions
                .Find(e => e.Id == executionId)
                .FirstOrDefaultAsync(CancellationToken.None);

            if (execution == null)
                throw new InvalidOperationException($"执行记录不存在: {executionId}");

            switch (execution.Status)
            {
                case WorkflowExecutionStatus.Completed:
                    _logger.LogInformation("[ReportAgent] Workflow execution completed: {ExecutionId}, duration={DurationMs}ms, artifacts={ArtifactCount}",
                        executionId, execution.DurationMs, execution.FinalArtifacts.Count);
                    return execution;

                case WorkflowExecutionStatus.Failed:
                    _logger.LogWarning("[ReportAgent] Workflow execution failed: {ExecutionId}, error={Error}",
                        executionId, execution.ErrorMessage);
                    throw new InvalidOperationException($"工作流执行失败: {execution.ErrorMessage}");

                case WorkflowExecutionStatus.Cancelled:
                    throw new InvalidOperationException("工作流执行已被取消");
            }

            // 仍在 Queued 或 Running，继续等待
            await Task.Delay(pollInterval, ct);

            // 渐进增加轮询间隔（最大 10 秒）
            if (pollInterval < TimeSpan.FromSeconds(10))
                pollInterval += TimeSpan.FromSeconds(1);
        }

        throw new TimeoutException($"工作流执行超时（{timeout.TotalSeconds}s）: {executionId}");
    }
}
