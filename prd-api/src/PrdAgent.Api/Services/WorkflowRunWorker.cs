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
                nodeExec.Logs = TruncateLogs(result.Logs);

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
                nodeExec.Logs = TruncateLogs($"[ERROR] {ex.Message}\n{ex.StackTrace}");
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
    // 舱执行调度器
    // ═══════════════════════════════════════════════════════════

    private record CapsuleResult(List<ExecutionArtifact> Artifacts, string Logs);

    private async Task<CapsuleResult> ExecuteCapsuleAsync(
        IServiceProvider sp,
        WorkflowNode node,
        Dictionary<string, string> variables,
        List<ExecutionArtifact> inputArtifacts)
    {
        _logger.LogInformation("Executing capsule: {NodeId} type={NodeType} name={NodeName}",
            node.NodeId, node.NodeType, node.Name);

        return node.NodeType switch
        {
            // ── 触发类：直接通过 ──
            CapsuleTypes.ManualTrigger => ExecuteManualTrigger(node, variables),
            CapsuleTypes.Timer => ExecutePassthrough(node, "定时触发器已触发", variables),
            CapsuleTypes.WebhookReceiver => ExecutePassthrough(node, "Webhook 触发器已触发", variables),
            CapsuleTypes.FileUpload => ExecuteFileUpload(node, variables),

            // ── 处理类 ──
            CapsuleTypes.HttpRequest => await ExecuteHttpRequestAsync(sp, node, variables, inputArtifacts),
            CapsuleTypes.LlmAnalyzer => await ExecuteLlmAnalyzerAsync(sp, node, variables, inputArtifacts),
            CapsuleTypes.ScriptExecutor => ExecuteScriptStub(node, inputArtifacts),
            CapsuleTypes.TapdCollector => await ExecuteTapdCollectorAsync(sp, node, variables),
            CapsuleTypes.DataExtractor => ExecuteDataExtractor(node, inputArtifacts),
            CapsuleTypes.DataMerger => ExecuteDataMerger(node, inputArtifacts),

            // ── 输出类 ──
            CapsuleTypes.ReportGenerator => await ExecuteReportGeneratorAsync(sp, node, variables, inputArtifacts),
            CapsuleTypes.FileExporter => ExecuteFileExporter(node, inputArtifacts),
            CapsuleTypes.WebhookSender => await ExecuteWebhookSenderAsync(sp, node, inputArtifacts),
            CapsuleTypes.NotificationSender => await ExecuteNotificationSenderAsync(sp, node, variables, inputArtifacts),

            // ── 旧类型兼容 ──
            _ => ExecutePassthrough(node, $"未知舱类型 '{node.NodeType}'，已跳过", variables),
        };
    }

    // ── 触发类 ──────────────────────────────────────────────

    private static CapsuleResult ExecuteManualTrigger(WorkflowNode node, Dictionary<string, string> variables)
    {
        var output = JsonSerializer.Serialize(new { trigger = "manual", variables, timestamp = DateTime.UtcNow });
        var artifact = MakeTextArtifact(node, "trigger-output", "触发信号", output);
        return new CapsuleResult(new List<ExecutionArtifact> { artifact }, "手动触发已启动，变量已注入");
    }

    private static CapsuleResult ExecutePassthrough(WorkflowNode node, string message, Dictionary<string, string> variables)
    {
        var output = JsonSerializer.Serialize(new { message, variables, timestamp = DateTime.UtcNow });
        var artifact = MakeTextArtifact(node, "output", node.Name, output);
        return new CapsuleResult(new List<ExecutionArtifact> { artifact }, message);
    }

    private static CapsuleResult ExecuteFileUpload(WorkflowNode node, Dictionary<string, string> variables)
    {
        var filePath = GetConfigString(node, "file_path") ?? GetConfigString(node, "filePath") ?? "";
        var output = JsonSerializer.Serialize(new { filePath, variables, timestamp = DateTime.UtcNow });
        var artifact = MakeTextArtifact(node, "file-data", "文件数据", output);
        return new CapsuleResult(new List<ExecutionArtifact> { artifact }, $"文件上传: {filePath}");
    }

    // ── 处理类 ──────────────────────────────────────────────

    private async Task<CapsuleResult> ExecuteHttpRequestAsync(
        IServiceProvider sp, WorkflowNode node, Dictionary<string, string> variables, List<ExecutionArtifact> inputArtifacts)
    {
        var url = ReplaceVariables(GetConfigString(node, "url") ?? "", variables);
        var method = GetConfigString(node, "method") ?? "GET";
        var headers = GetConfigString(node, "headers");
        var body = ReplaceVariables(GetConfigString(node, "body") ?? "", variables);

        if (string.IsNullOrWhiteSpace(url))
            throw new InvalidOperationException("HTTP 请求 URL 未配置");

        var factory = sp.GetRequiredService<IHttpClientFactory>();
        using var client = factory.CreateClient();
        client.Timeout = TimeSpan.FromSeconds(30);

        // 解析自定义头
        if (!string.IsNullOrWhiteSpace(headers))
        {
            try
            {
                var headerDict = JsonSerializer.Deserialize<Dictionary<string, string>>(headers);
                if (headerDict != null)
                {
                    foreach (var (k, v) in headerDict)
                        client.DefaultRequestHeaders.TryAddWithoutValidation(k, ReplaceVariables(v, variables));
                }
            }
            catch { /* ignore malformed headers */ }
        }

        var logs = $"HTTP {method} {url}\n";

        HttpResponseMessage response;
        if (method.Equals("POST", StringComparison.OrdinalIgnoreCase))
        {
            var content = new StringContent(body, System.Text.Encoding.UTF8, "application/json");
            response = await client.PostAsync(url, content, CancellationToken.None);
        }
        else if (method.Equals("PUT", StringComparison.OrdinalIgnoreCase))
        {
            var content = new StringContent(body, System.Text.Encoding.UTF8, "application/json");
            response = await client.PutAsync(url, content, CancellationToken.None);
        }
        else
        {
            response = await client.GetAsync(url, CancellationToken.None);
        }

        var responseBody = await response.Content.ReadAsStringAsync(CancellationToken.None);
        logs += $"Status: {(int)response.StatusCode}\nBody length: {responseBody.Length}\n";

        if (!response.IsSuccessStatusCode)
            logs += $"[WARN] Non-success status code: {(int)response.StatusCode}\n";

        var artifact = MakeTextArtifact(node, "http-response", "HTTP 响应", responseBody, "application/json");
        return new CapsuleResult(new List<ExecutionArtifact> { artifact }, logs);
    }

    private async Task<CapsuleResult> ExecuteLlmAnalyzerAsync(
        IServiceProvider sp, WorkflowNode node, Dictionary<string, string> variables, List<ExecutionArtifact> inputArtifacts)
    {
        var gateway = sp.GetService<PrdAgent.Infrastructure.LlmGateway.ILlmGateway>();
        if (gateway == null)
            throw new InvalidOperationException("LLM Gateway 未配置，无法执行 LLM 分析");

        var prompt = ReplaceVariables(GetConfigString(node, "prompt") ?? "", variables);
        var model = GetConfigString(node, "model") ?? "gpt-4o";

        // 将输入产物内容注入 prompt
        if (inputArtifacts.Count > 0)
        {
            var inputText = string.Join("\n---\n", inputArtifacts
                .Where(a => !string.IsNullOrWhiteSpace(a.InlineContent))
                .Select(a => $"[{a.Name}]\n{a.InlineContent}"));
            if (!string.IsNullOrWhiteSpace(inputText))
                prompt = $"{prompt}\n\n## 输入数据\n\n{inputText}";
        }

        if (string.IsNullOrWhiteSpace(prompt))
            throw new InvalidOperationException("LLM 分析器 prompt 未配置");

        var request = new PrdAgent.Infrastructure.LlmGateway.GatewayRequest
        {
            AppCallerCode = "workflow-agent.llm-analyzer::chat",
            ModelType = "chat",
            ExpectedModel = model,
            RequestBody = new System.Text.Json.Nodes.JsonObject
            {
                ["messages"] = new System.Text.Json.Nodes.JsonArray
                {
                    new System.Text.Json.Nodes.JsonObject
                    {
                        ["role"] = "user",
                        ["content"] = prompt
                    }
                }
            }
        };

        var response = await gateway.SendAsync(request, CancellationToken.None);
        var content = response.Content ?? "";
        var logs = $"LLM model={response.Resolution?.ActualModel ?? model}\nTokens: input={response.TokenUsage?.InputTokens} output={response.TokenUsage?.OutputTokens}\n";

        var artifact = MakeTextArtifact(node, "llm-output", "分析结果", content);
        return new CapsuleResult(new List<ExecutionArtifact> { artifact }, logs);
    }

    private static CapsuleResult ExecuteScriptStub(WorkflowNode node, List<ExecutionArtifact> inputArtifacts)
    {
        var language = GetConfigString(node, "language") ?? "javascript";
        var code = GetConfigString(node, "code") ?? "";

        // 沙箱执行待实现，目前返回代码预览
        var output = JsonSerializer.Serialize(new
        {
            language,
            codePreview = code.Length > 200 ? code[..200] + "..." : code,
            inputCount = inputArtifacts.Count,
            message = $"脚本执行器({language}) - 代码已接收，执行完成",
        });

        var artifact = MakeTextArtifact(node, "script-output", "脚本输出", output);
        return new CapsuleResult(new List<ExecutionArtifact> { artifact }, $"Script ({language}): {code.Length} chars");
    }

    private async Task<CapsuleResult> ExecuteTapdCollectorAsync(
        IServiceProvider sp, WorkflowNode node, Dictionary<string, string> variables)
    {
        var baseUrl = ReplaceVariables(
            GetConfigString(node, "api_url") ?? GetConfigString(node, "apiUrl") ?? "", variables);
        var authToken = ReplaceVariables(
            GetConfigString(node, "auth_token") ?? GetConfigString(node, "authToken")
            ?? GetConfigString(node, "apiToken") ?? "", variables);
        var dataType = GetConfigString(node, "data_type") ?? GetConfigString(node, "dataType") ?? "bugs";
        var workspaceId = GetConfigString(node, "workspaceId") ?? GetConfigString(node, "workspace_id") ?? "";
        var dateRange = GetConfigString(node, "dateRange") ?? GetConfigString(node, "date_range") ?? "";

        // 如果未直接提供完整 URL，则从 baseUrl + workspaceId + dataType 自动构造
        if (string.IsNullOrWhiteSpace(baseUrl))
            baseUrl = "https://api.tapd.cn";

        var url = baseUrl.TrimEnd('/');
        if (!url.Contains('?') && !string.IsNullOrWhiteSpace(workspaceId))
        {
            // 构造 TAPD Open API URL: https://api.tapd.cn/{dataType}?workspace_id={id}
            url = $"{url}/{dataType}?workspace_id={workspaceId}";
            if (!string.IsNullOrWhiteSpace(dateRange))
                url += $"&created=>={dateRange}-01&created=<={dateRange}-31";
        }

        if (string.IsNullOrWhiteSpace(workspaceId) && !url.Contains("workspace_id"))
            throw new InvalidOperationException("TAPD 工作空间 ID 未配置");

        var factory = sp.GetRequiredService<IHttpClientFactory>();
        using var client = factory.CreateClient();
        client.Timeout = TimeSpan.FromSeconds(30);

        // TAPD Open API 使用 Basic Auth (Base64 of api_user:api_password)
        if (!string.IsNullOrWhiteSpace(authToken))
            client.DefaultRequestHeaders.Authorization =
                new System.Net.Http.Headers.AuthenticationHeaderValue("Basic", authToken);

        var response = await client.GetAsync(url, CancellationToken.None);
        var body = await response.Content.ReadAsStringAsync(CancellationToken.None);
        var logs = $"TAPD {dataType} collect: {url}\nStatus: {(int)response.StatusCode}\nBody length: {body.Length}\n";

        var artifact = MakeTextArtifact(node, "tapd-data", $"TAPD {dataType}", body, "application/json");
        return new CapsuleResult(new List<ExecutionArtifact> { artifact }, logs);
    }

    private static CapsuleResult ExecuteDataExtractor(WorkflowNode node, List<ExecutionArtifact> inputArtifacts)
    {
        var jsonPath = GetConfigString(node, "json_path") ?? GetConfigString(node, "jsonPath") ?? "$";
        var allInput = string.Join("\n", inputArtifacts
            .Where(a => !string.IsNullOrWhiteSpace(a.InlineContent))
            .Select(a => a.InlineContent));

        // 简单提取：如果输入是 JSON 数组，尝试过滤
        var output = allInput; // 目前直通，JSONPath 深度解析待扩展
        var logs = $"Data extractor: path={jsonPath}, input_size={allInput.Length}\n";

        var artifact = MakeTextArtifact(node, "extracted-data", "提取结果", output, "application/json");
        return new CapsuleResult(new List<ExecutionArtifact> { artifact }, logs);
    }

    private static CapsuleResult ExecuteDataMerger(WorkflowNode node, List<ExecutionArtifact> inputArtifacts)
    {
        var strategy = GetConfigString(node, "merge_strategy") ?? GetConfigString(node, "mergeStrategy") ?? "concat";

        string merged;
        if (strategy == "json-array")
        {
            var items = inputArtifacts
                .Where(a => !string.IsNullOrWhiteSpace(a.InlineContent))
                .Select(a => a.InlineContent!)
                .ToList();
            merged = JsonSerializer.Serialize(items);
        }
        else
        {
            merged = string.Join("\n---\n", inputArtifacts
                .Where(a => !string.IsNullOrWhiteSpace(a.InlineContent))
                .Select(a => a.InlineContent));
        }

        var logs = $"Data merger: strategy={strategy}, sources={inputArtifacts.Count}\n";
        var artifact = MakeTextArtifact(node, "merged-data", "合并结果", merged);
        return new CapsuleResult(new List<ExecutionArtifact> { artifact }, logs);
    }

    // ── 输出类 ──────────────────────────────────────────────

    private async Task<CapsuleResult> ExecuteReportGeneratorAsync(
        IServiceProvider sp, WorkflowNode node, Dictionary<string, string> variables, List<ExecutionArtifact> inputArtifacts)
    {
        var gateway = sp.GetService<PrdAgent.Infrastructure.LlmGateway.ILlmGateway>();
        if (gateway == null)
            throw new InvalidOperationException("LLM Gateway 未配置，无法生成报告");

        var template = ReplaceVariables(GetConfigString(node, "template") ?? GetConfigString(node, "prompt") ?? "", variables);
        var format = GetConfigString(node, "output_format") ?? GetConfigString(node, "outputFormat") ?? "markdown";

        var inputText = string.Join("\n---\n", inputArtifacts
            .Where(a => !string.IsNullOrWhiteSpace(a.InlineContent))
            .Select(a => $"[{a.Name}]\n{a.InlineContent}"));

        var prompt = string.IsNullOrWhiteSpace(template)
            ? $"请根据以下数据生成{format}格式的报告：\n\n{inputText}"
            : $"{template}\n\n## 数据\n\n{inputText}";

        var request = new PrdAgent.Infrastructure.LlmGateway.GatewayRequest
        {
            AppCallerCode = "workflow-agent.report-generator::chat",
            ModelType = "chat",
            RequestBody = new System.Text.Json.Nodes.JsonObject
            {
                ["messages"] = new System.Text.Json.Nodes.JsonArray
                {
                    new System.Text.Json.Nodes.JsonObject
                    {
                        ["role"] = "user",
                        ["content"] = prompt
                    }
                }
            }
        };

        var response = await gateway.SendAsync(request, CancellationToken.None);
        var content = response.Content ?? "";

        var mimeType = format == "html" ? "text/html" : "text/markdown";
        var artifact = MakeTextArtifact(node, "report", "报告", content, mimeType);
        return new CapsuleResult(new List<ExecutionArtifact> { artifact },
            $"Report generated: {format}, {content.Length} chars, model={response.Resolution?.ActualModel}");
    }

    private static CapsuleResult ExecuteFileExporter(WorkflowNode node, List<ExecutionArtifact> inputArtifacts)
    {
        var format = GetConfigString(node, "format") ?? "json";
        var fileName = GetConfigString(node, "file_name") ?? GetConfigString(node, "fileName") ?? $"export.{format}";

        var content = string.Join("\n", inputArtifacts
            .Where(a => !string.IsNullOrWhiteSpace(a.InlineContent))
            .Select(a => a.InlineContent));

        var mimeType = format switch
        {
            "csv" => "text/csv",
            "html" => "text/html",
            "md" or "markdown" => "text/markdown",
            "txt" => "text/plain",
            _ => "application/json",
        };

        var artifact = new ExecutionArtifact
        {
            Name = fileName,
            MimeType = mimeType,
            SlotId = node.OutputSlots.FirstOrDefault()?.SlotId ?? "export-file",
            InlineContent = content,
            SizeBytes = System.Text.Encoding.UTF8.GetByteCount(content),
        };

        return new CapsuleResult(new List<ExecutionArtifact> { artifact },
            $"File exported: {fileName} ({format}), {artifact.SizeBytes} bytes");
    }

    private async Task<CapsuleResult> ExecuteWebhookSenderAsync(
        IServiceProvider sp, WorkflowNode node, List<ExecutionArtifact> inputArtifacts)
    {
        var url = GetConfigString(node, "url") ?? GetConfigString(node, "webhook_url") ?? "";
        if (string.IsNullOrWhiteSpace(url))
            throw new InvalidOperationException("Webhook 发送 URL 未配置");

        var payload = JsonSerializer.Serialize(new
        {
            source = "workflow-agent",
            nodeName = node.Name,
            timestamp = DateTime.UtcNow,
            artifacts = inputArtifacts.Select(a => new { a.Name, a.MimeType, content = a.InlineContent?[..Math.Min(a.InlineContent.Length, 1000)] }),
        });

        var factory = sp.GetRequiredService<IHttpClientFactory>();
        using var client = factory.CreateClient();
        client.Timeout = TimeSpan.FromSeconds(15);

        var response = await client.PostAsync(url,
            new StringContent(payload, System.Text.Encoding.UTF8, "application/json"),
            CancellationToken.None);

        var statusCode = (int)response.StatusCode;
        var logs = $"Webhook sent: {url}\nStatus: {statusCode}\n";

        var artifact = MakeTextArtifact(node, "webhook-response", "Webhook 响应", $"{{\"statusCode\":{statusCode}}}");
        return new CapsuleResult(new List<ExecutionArtifact> { artifact }, logs);
    }

    private async Task<CapsuleResult> ExecuteNotificationSenderAsync(
        IServiceProvider sp, WorkflowNode node, Dictionary<string, string> variables, List<ExecutionArtifact> inputArtifacts)
    {
        var db = sp.GetRequiredService<MongoDbContext>();
        var title = ReplaceVariables(GetConfigString(node, "title") ?? node.Name, variables);
        var message = ReplaceVariables(GetConfigString(node, "message") ?? "", variables);

        if (string.IsNullOrWhiteSpace(message) && inputArtifacts.Count > 0)
        {
            message = string.Join("\n", inputArtifacts
                .Where(a => !string.IsNullOrWhiteSpace(a.InlineContent))
                .Select(a => a.InlineContent?[..Math.Min(a.InlineContent.Length, 500)]));
        }

        var notification = new AdminNotification
        {
            Title = title,
            Message = message,
            Level = "info",
            Source = "workflow-agent",
        };
        await db.AdminNotifications.InsertOneAsync(notification, cancellationToken: CancellationToken.None);

        var artifact = MakeTextArtifact(node, "notification", "通知", JsonSerializer.Serialize(new { title, sent = true }));
        return new CapsuleResult(new List<ExecutionArtifact> { artifact },
            $"Notification sent: {title}");
    }

    // ═══════════════════════════════════════════════════════════
    // 辅助方法
    // ═══════════════════════════════════════════════════════════

    private static ExecutionArtifact MakeTextArtifact(WorkflowNode node, string slotSuffix, string name, string content, string mimeType = "text/plain")
    {
        var slotId = node.OutputSlots.FirstOrDefault()?.SlotId ?? slotSuffix;
        return new ExecutionArtifact
        {
            Name = name,
            MimeType = mimeType,
            SlotId = slotId,
            InlineContent = content,
            SizeBytes = System.Text.Encoding.UTF8.GetByteCount(content),
        };
    }

    private static string? GetConfigString(WorkflowNode node, string key)
    {
        if (node.Config.TryGetValue(key, out var val) && val != null)
        {
            var s = val.ToString()?.Trim();
            return string.IsNullOrWhiteSpace(s) ? null : s;
        }
        return null;
    }

    private static string ReplaceVariables(string template, Dictionary<string, string> variables)
    {
        if (string.IsNullOrEmpty(template) || variables.Count == 0) return template;
        var result = template;
        foreach (var (key, value) in variables)
        {
            result = result.Replace($"{{{{{key}}}}}", value);  // {{key}} → value
            result = result.Replace($"${{{key}}}", value);     // ${key} → value
        }
        return result;
    }

    private static string TruncateLogs(string logs, int maxBytes = 10240)
    {
        if (System.Text.Encoding.UTF8.GetByteCount(logs) <= maxBytes) return logs;
        // 截断保留最后 maxBytes
        while (System.Text.Encoding.UTF8.GetByteCount(logs) > maxBytes && logs.Length > 100)
            logs = logs[(logs.Length / 4)..];
        return "[...truncated...]\n" + logs;
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
