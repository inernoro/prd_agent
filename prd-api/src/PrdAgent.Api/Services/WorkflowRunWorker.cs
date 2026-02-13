using System.Diagnostics;
using System.Text.Json;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services;

/// <summary>
/// 工作流后台执行器：从 IRunQueue 消费 Workflow 执行请求，按 DAG 拓扑顺序逐节点推进。
/// 遵循服务器权威性设计：核心逻辑使用 CancellationToken.None，不受客户端断连影响。
/// </summary>
public sealed class WorkflowRunWorker : BackgroundService
{
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly IRunQueue _queue;
    private readonly ILogger<WorkflowRunWorker> _logger;

    public WorkflowRunWorker(IServiceScopeFactory scopeFactory, IRunQueue queue, ILogger<WorkflowRunWorker> logger)
    {
        _scopeFactory = scopeFactory;
        _queue = queue;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _logger.LogInformation("WorkflowRunWorker started");

        while (!stoppingToken.IsCancellationRequested)
        {
            string? executionId = null;
            try
            {
                executionId = await _queue.DequeueAsync(RunKinds.Workflow, TimeSpan.FromSeconds(1), stoppingToken);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "WorkflowRunWorker dequeue failed");
            }

            if (string.IsNullOrWhiteSpace(executionId))
            {
                try { await Task.Delay(300, stoppingToken); }
                catch (OperationCanceledException) { break; }
                continue;
            }

            try
            {
                await ProcessExecutionAsync(executionId.Trim());
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "WorkflowRunWorker process failed: {ExecutionId}", executionId);
                // 尝试标记执行失败
                try { await MarkExecutionFailedAsync(executionId.Trim(), ex.Message); }
                catch { /* ignore */ }
            }
        }

        _logger.LogInformation("WorkflowRunWorker stopped");
    }

    /// <summary>
    /// 处理单个工作流执行：拓扑排序 → 逐层推进节点 → 标记完成。
    /// </summary>
    private async Task ProcessExecutionAsync(string executionId)
    {
        using var scope = _scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MongoDbContext>();

        // 1. 加载执行记录
        var execution = await db.WorkflowExecutions.Find(e => e.Id == executionId).FirstOrDefaultAsync(CancellationToken.None);
        if (execution == null)
        {
            _logger.LogWarning("Execution not found: {ExecutionId}", executionId);
            return;
        }

        if (execution.Status is WorkflowExecutionStatus.Completed or WorkflowExecutionStatus.Failed or WorkflowExecutionStatus.Cancelled)
        {
            _logger.LogInformation("Execution already terminal: {ExecutionId} status={Status}", executionId, execution.Status);
            return;
        }

        _logger.LogInformation("Processing execution: {ExecutionId} workflow={WorkflowName}", executionId, execution.WorkflowName);

        // 2. 标记为运行中
        var sw = Stopwatch.StartNew();
        await db.WorkflowExecutions.UpdateOneAsync(
            e => e.Id == executionId,
            Builders<WorkflowExecution>.Update
                .Set(e => e.Status, WorkflowExecutionStatus.Running)
                .Set(e => e.StartedAt, DateTime.UtcNow),
            cancellationToken: CancellationToken.None);

        // 3. 构建 DAG 依赖图
        var (inDegree, downstream, nodeMap) = BuildDag(execution);

        // 4. 收集已完成节点的产物（ResumeFromNode 场景部分节点已 completed）
        var artifactStore = new Dictionary<string, List<ExecutionArtifact>>();
        foreach (var ne in execution.NodeExecutions.Where(n => n.Status == NodeExecutionStatus.Completed))
        {
            artifactStore[ne.NodeId] = ne.OutputArtifacts;
        }

        // 5. 确定初始就绪节点（入度为 0 或前驱全部已完成）
        var ready = new Queue<string>();
        foreach (var (nodeId, degree) in inDegree)
        {
            if (degree == 0 && !artifactStore.ContainsKey(nodeId))
                ready.Enqueue(nodeId);
        }

        // 6. BFS 逐层推进
        var failedAny = false;
        string? errorMsg = null;

        while (ready.Count > 0)
        {
            // 检查是否被取消
            var latestExec = await db.WorkflowExecutions.Find(e => e.Id == executionId)
                .Project(e => new { e.Status })
                .FirstOrDefaultAsync(CancellationToken.None);
            if (latestExec?.Status == WorkflowExecutionStatus.Cancelled)
            {
                _logger.LogInformation("Execution cancelled by user: {ExecutionId}", executionId);
                return;
            }

            var nodeId = ready.Dequeue();
            var nodeExec = execution.NodeExecutions.FirstOrDefault(n => n.NodeId == nodeId);
            if (nodeExec == null) continue;
            if (nodeExec.Status == NodeExecutionStatus.Completed) continue; // resume 场景

            var nodeDef = nodeMap.GetValueOrDefault(nodeId);
            if (nodeDef == null) continue;

            // 标记节点为 running
            nodeExec.Status = NodeExecutionStatus.Running;
            nodeExec.StartedAt = DateTime.UtcNow;
            nodeExec.AttemptCount++;
            await UpdateNodeExecutionAsync(db, executionId, nodeExec);

            // 执行舱逻辑
            var nodeSw = Stopwatch.StartNew();
            try
            {
                var inputArtifacts = CollectInputArtifacts(nodeId, execution.EdgeSnapshot, artifactStore);
                var result = await ExecuteCapsuleAsync(scope.ServiceProvider, nodeDef, execution.Variables, inputArtifacts);

                nodeSw.Stop();
                nodeExec.Status = NodeExecutionStatus.Completed;
                nodeExec.CompletedAt = DateTime.UtcNow;
                nodeExec.DurationMs = nodeSw.ElapsedMilliseconds;
                nodeExec.OutputArtifacts = result.Artifacts;
                nodeExec.Logs = CapsuleExecutor.TruncateLogs(result.Logs);

                artifactStore[nodeId] = result.Artifacts;
            }
            catch (Exception ex)
            {
                nodeSw.Stop();
                _logger.LogWarning(ex, "Node execution failed: {NodeId} type={NodeType}", nodeId, nodeDef.NodeType);

                // 重试逻辑
                var maxAttempts = nodeDef.Retry?.MaxAttempts ?? 1;
                if (nodeExec.AttemptCount < maxAttempts)
                {
                    var delay = nodeDef.Retry?.DelaySeconds ?? 5;
                    _logger.LogInformation("Retrying node {NodeId} (attempt {Attempt}/{Max}) in {Delay}s",
                        nodeId, nodeExec.AttemptCount + 1, maxAttempts, delay);
                    await Task.Delay(TimeSpan.FromSeconds(delay), CancellationToken.None);
                    ready.Enqueue(nodeId); // 重新入队
                    nodeExec.Status = NodeExecutionStatus.Pending;
                    await UpdateNodeExecutionAsync(db, executionId, nodeExec);
                    continue;
                }

                nodeExec.Status = NodeExecutionStatus.Failed;
                nodeExec.CompletedAt = DateTime.UtcNow;
                nodeExec.DurationMs = nodeSw.ElapsedMilliseconds;
                nodeExec.ErrorMessage = ex.Message;
                nodeExec.Logs = CapsuleExecutor.TruncateLogs($"[ERROR] {ex.Message}\n{ex.StackTrace}");
                failedAny = true;
                errorMsg = $"节点 '{nodeExec.NodeName}' 执行失败: {ex.Message}";
            }

            await UpdateNodeExecutionAsync(db, executionId, nodeExec);

            // 如果节点成功，检查下游节点是否就绪
            if (nodeExec.Status == NodeExecutionStatus.Completed && downstream.TryGetValue(nodeId, out var children))
            {
                foreach (var childId in children)
                {
                    if (inDegree.ContainsKey(childId))
                    {
                        inDegree[childId]--;
                        if (inDegree[childId] <= 0)
                            ready.Enqueue(childId);
                    }
                }
            }

            // 如果节点失败，将所有下游标记为 skipped
            if (nodeExec.Status == NodeExecutionStatus.Failed)
            {
                SkipDownstream(nodeId, downstream, execution.NodeExecutions);
                await BulkUpdateNodeExecutionsAsync(db, executionId, execution.NodeExecutions);
            }
        }

        // 7. 收集最终产物（末端节点 = 无出边的节点）
        var terminalNodeIds = execution.NodeSnapshot
            .Where(n => !execution.EdgeSnapshot.Any(e => e.SourceNodeId == n.NodeId))
            .Select(n => n.NodeId)
            .ToHashSet();

        var finalArtifacts = execution.NodeExecutions
            .Where(ne => terminalNodeIds.Contains(ne.NodeId) && ne.Status == NodeExecutionStatus.Completed)
            .SelectMany(ne => ne.OutputArtifacts)
            .ToList();

        // 8. 标记执行完成
        sw.Stop();
        var finalStatus = failedAny ? WorkflowExecutionStatus.Failed : WorkflowExecutionStatus.Completed;
        await db.WorkflowExecutions.UpdateOneAsync(
            e => e.Id == executionId,
            Builders<WorkflowExecution>.Update
                .Set(e => e.Status, finalStatus)
                .Set(e => e.CompletedAt, DateTime.UtcNow)
                .Set(e => e.DurationMs, sw.ElapsedMilliseconds)
                .Set(e => e.FinalArtifacts, finalArtifacts)
                .Set(e => e.ErrorMessage, errorMsg),
            cancellationToken: CancellationToken.None);

        _logger.LogInformation("Execution {Status}: {ExecutionId} duration={DurationMs}ms nodes={Total}",
            finalStatus, executionId, sw.ElapsedMilliseconds, execution.NodeExecutions.Count);
    }

    // ═══════════════════════════════════════════════════════════
    // DAG 构建
    // ═══════════════════════════════════════════════════════════

    private static (Dictionary<string, int> inDegree, Dictionary<string, List<string>> downstream, Dictionary<string, WorkflowNode> nodeMap)
        BuildDag(WorkflowExecution execution)
    {
        var inDegree = new Dictionary<string, int>();
        var downstream = new Dictionary<string, List<string>>();
        var nodeMap = new Dictionary<string, WorkflowNode>();

        foreach (var node in execution.NodeSnapshot)
        {
            inDegree[node.NodeId] = 0;
            downstream[node.NodeId] = new List<string>();
            nodeMap[node.NodeId] = node;
        }

        foreach (var edge in execution.EdgeSnapshot)
        {
            if (inDegree.ContainsKey(edge.TargetNodeId))
                inDegree[edge.TargetNodeId]++;
            if (downstream.ContainsKey(edge.SourceNodeId))
                downstream[edge.SourceNodeId].Add(edge.TargetNodeId);
        }

        return (inDegree, downstream, nodeMap);
    }

    // ═══════════════════════════════════════════════════════════
    // 输入产物收集
    // ═══════════════════════════════════════════════════════════

    private static List<ExecutionArtifact> CollectInputArtifacts(
        string nodeId,
        List<WorkflowEdge> edges,
        Dictionary<string, List<ExecutionArtifact>> artifactStore)
    {
        var result = new List<ExecutionArtifact>();
        var incomingEdges = edges.Where(e => e.TargetNodeId == nodeId);

        foreach (var edge in incomingEdges)
        {
            if (artifactStore.TryGetValue(edge.SourceNodeId, out var sourceArtifacts))
            {
                // 如果有插槽匹配，优先匹配；否则全部传入
                var matched = sourceArtifacts.Where(a => a.SlotId == edge.SourceSlotId).ToList();
                result.AddRange(matched.Count > 0 ? matched : sourceArtifacts);
            }
        }

        return result;
    }

    // ═══════════════════════════════════════════════════════════
    // 舱执行调度（委托给 CapsuleExecutor）
    // ═══════════════════════════════════════════════════════════

    private async Task<CapsuleExecutor.CapsuleResult> ExecuteCapsuleAsync(
        IServiceProvider sp,
        WorkflowNode node,
        Dictionary<string, string> variables,
        List<ExecutionArtifact> inputArtifacts)
    {
        return await CapsuleExecutor.ExecuteAsync(sp, _logger, node, variables, inputArtifacts);
    }

    private static void SkipDownstream(string failedNodeId, Dictionary<string, List<string>> downstream, List<NodeExecution> nodeExecutions)
    {
        var toSkip = new Queue<string>();
        if (downstream.TryGetValue(failedNodeId, out var children))
        {
            foreach (var c in children) toSkip.Enqueue(c);
        }

        var visited = new HashSet<string> { failedNodeId };
        while (toSkip.Count > 0)
        {
            var id = toSkip.Dequeue();
            if (!visited.Add(id)) continue;

            var ne = nodeExecutions.FirstOrDefault(n => n.NodeId == id);
            if (ne != null && ne.Status == NodeExecutionStatus.Pending)
            {
                ne.Status = NodeExecutionStatus.Skipped;
                ne.CompletedAt = DateTime.UtcNow;
                ne.ErrorMessage = "上游节点失败，已跳过";
            }

            if (downstream.TryGetValue(id, out var grandChildren))
            {
                foreach (var gc in grandChildren) toSkip.Enqueue(gc);
            }
        }
    }

    // ═══════════════════════════════════════════════════════════
    // MongoDB 更新
    // ═══════════════════════════════════════════════════════════

    private static async Task UpdateNodeExecutionAsync(MongoDbContext db, string executionId, NodeExecution nodeExec)
    {
        var filter = Builders<WorkflowExecution>.Filter.And(
            Builders<WorkflowExecution>.Filter.Eq(e => e.Id, executionId),
            Builders<WorkflowExecution>.Filter.ElemMatch(e => e.NodeExecutions, n => n.NodeId == nodeExec.NodeId));

        var update = Builders<WorkflowExecution>.Update
            .Set("NodeExecutions.$.Status", nodeExec.Status)
            .Set("NodeExecutions.$.AttemptCount", nodeExec.AttemptCount)
            .Set("NodeExecutions.$.StartedAt", nodeExec.StartedAt)
            .Set("NodeExecutions.$.CompletedAt", nodeExec.CompletedAt)
            .Set("NodeExecutions.$.DurationMs", nodeExec.DurationMs)
            .Set("NodeExecutions.$.ErrorMessage", nodeExec.ErrorMessage)
            .Set("NodeExecutions.$.Logs", nodeExec.Logs)
            .Set("NodeExecutions.$.OutputArtifacts", nodeExec.OutputArtifacts);

        await db.WorkflowExecutions.UpdateOneAsync(filter, update, cancellationToken: CancellationToken.None);
    }

    private static async Task BulkUpdateNodeExecutionsAsync(MongoDbContext db, string executionId, List<NodeExecution> nodeExecutions)
    {
        await db.WorkflowExecutions.UpdateOneAsync(
            e => e.Id == executionId,
            Builders<WorkflowExecution>.Update.Set(e => e.NodeExecutions, nodeExecutions),
            cancellationToken: CancellationToken.None);
    }

    private async Task MarkExecutionFailedAsync(string executionId, string errorMessage)
    {
        using var scope = _scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MongoDbContext>();

        await db.WorkflowExecutions.UpdateOneAsync(
            e => e.Id == executionId,
            Builders<WorkflowExecution>.Update
                .Set(e => e.Status, WorkflowExecutionStatus.Failed)
                .Set(e => e.CompletedAt, DateTime.UtcNow)
                .Set(e => e.ErrorMessage, errorMessage),
            cancellationToken: CancellationToken.None);
    }
}
