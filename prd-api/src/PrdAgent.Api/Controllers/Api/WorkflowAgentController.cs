using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Core.Interfaces;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Api;

[ApiController]
[Route("api/workflow-agent")]
[Authorize]
[AdminController("workflow-agent", AdminPermissionCatalog.WorkflowAgentUse, WritePermission = AdminPermissionCatalog.WorkflowAgentManage)]
public class WorkflowAgentController : ControllerBase
{
    private const string AppKey = "workflow-agent";

    private readonly MongoDbContext _db;
    private readonly IRunQueue _runQueue;
    private readonly ILogger<WorkflowAgentController> _logger;

    public WorkflowAgentController(
        MongoDbContext db,
        IRunQueue runQueue,
        ILogger<WorkflowAgentController> logger)
    {
        _db = db;
        _runQueue = runQueue;
        _logger = logger;
    }

    // ─────────────────────────────────────────────────────────
    // 舱类型注册表
    // ─────────────────────────────────────────────────────────

    /// <summary>获取所有可用的舱类型（含元数据、配置 Schema、默认插槽）</summary>
    [HttpGet("capsule-types")]
    public IActionResult ListCapsuleTypes([FromQuery] string? category)
    {
        IEnumerable<CapsuleTypeMeta> types = CapsuleTypeRegistry.All;

        if (!string.IsNullOrWhiteSpace(category))
            types = types.Where(t => t.Category == category);

        return Ok(ApiResponse<object>.Ok(new
        {
            items = types,
            categories = new[]
            {
                new { key = CapsuleCategory.Trigger, label = "触发", description = "流水线的起点，负责产生触发信号" },
                new { key = CapsuleCategory.Processor, label = "处理", description = "数据采集、分析、转换" },
                new { key = CapsuleCategory.Output, label = "输出", description = "结果输出、通知、导出" },
            }
        }));
    }

    /// <summary>获取单个舱类型详情</summary>
    [HttpGet("capsule-types/{typeKey}")]
    public IActionResult GetCapsuleType(string typeKey)
    {
        var meta = CapsuleTypeRegistry.Get(typeKey);
        if (meta == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, $"未知的舱类型: {typeKey}"));

        return Ok(ApiResponse<object>.Ok(new { capsuleType = meta }));
    }

    /// <summary>
    /// 单舱测试运行：传入舱类型 + 配置 + 模拟输入，返回测试结果。
    /// 每个舱可以独立调试，无需组装完整流水线。
    /// </summary>
    [HttpPost("capsules/test-run")]
    public async Task<IActionResult> TestRunCapsule(
        [FromBody] CapsuleTestRunRequest request,
        CancellationToken ct = default)
    {
        var meta = CapsuleTypeRegistry.Get(request.TypeKey);
        if (meta == null)
            return BadRequest(ApiResponse<object>.Fail("UNKNOWN_CAPSULE_TYPE", $"未知的舱类型: {request.TypeKey}"));

        if (!meta.Testable)
            return BadRequest(ApiResponse<object>.Fail("NOT_TESTABLE", $"舱类型 '{meta.Name}' 不支持单独测试运行"));

        var startedAt = DateTime.UtcNow;

        // 逐字段校验：必填 + 类型格式
        var configValidation = new List<ConfigFieldValidation>();
        var hasErrors = false;

        foreach (var field in meta.ConfigSchema)
        {
            var provided = request.Config?.ContainsKey(field.Key) == true
                           && !string.IsNullOrWhiteSpace(request.Config[field.Key]?.ToString());
            var value = provided ? request.Config![field.Key]?.ToString() : null;
            var valid = true;
            string? message = null;

            if (field.Required && !provided)
            {
                valid = false;
                message = "必填字段";
                hasErrors = true;
            }
            else if (provided && value != null)
            {
                switch (field.FieldType)
                {
                    case "number":
                        if (!double.TryParse(value, System.Globalization.NumberStyles.Any, System.Globalization.CultureInfo.InvariantCulture, out _))
                        {
                            valid = false;
                            message = "需要填写数字";
                            hasErrors = true;
                        }
                        break;
                    case "cron":
                        var parts = value.Trim().Split(' ', StringSplitOptions.RemoveEmptyEntries);
                        if (parts.Length != 5)
                        {
                            valid = false;
                            message = "Cron 表达式需要 5 个部分（分 时 日 月 周）";
                            hasErrors = true;
                        }
                        break;
                    case "json":
                        try { System.Text.Json.JsonDocument.Parse(value); }
                        catch
                        {
                            valid = false;
                            message = "JSON 格式无效";
                            hasErrors = true;
                        }
                        break;
                    case "select":
                        if (field.Options?.Count > 0 && !field.Options.Any(o => o.Value == value))
                        {
                            valid = false;
                            message = $"无效选项，可选值: {string.Join(", ", field.Options.Select(o => o.Value))}";
                            hasErrors = true;
                        }
                        break;
                }
            }

            configValidation.Add(new ConfigFieldValidation
            {
                Key = field.Key,
                Label = field.Label,
                Provided = provided,
                Required = field.Required,
                Valid = valid,
                ValidationMessage = message,
            });
        }

        // 返回完整校验结果（不提前 400，让前端看到所有字段的校验状态）
        var testResult = new CapsuleTestRunResult
        {
            TypeKey = request.TypeKey,
            TypeName = meta.Name,
            Status = hasErrors ? "validation_failed" : "completed",
            StartedAt = startedAt,
            CompletedAt = DateTime.UtcNow,
            DurationMs = (long)(DateTime.UtcNow - startedAt).TotalMilliseconds,
            ConfigValidation = configValidation,
            MockOutput = hasErrors
                ? new Dictionary<string, object?>()
                : new Dictionary<string, object?>
                {
                    ["_testMode"] = true,
                    ["_capsuleType"] = request.TypeKey,
                    ["_message"] = $"舱 '{meta.Name}' 配置验证通过，执行引擎尚未接入实际处理逻辑",
                    ["_inputPreview"] = request.MockInput,
                },
            ErrorMessage = hasErrors ? "配置验证未通过，请检查标红字段" : null,
        };

        _logger.LogInformation("[{AppKey}] Capsule test-run: type={TypeKey} by {UserId}",
            AppKey, request.TypeKey, GetUserId());

        return Ok(ApiResponse<object>.Ok(new { result = testResult }));
    }

    // ─────────────────────────────────────────────────────────
    // Workflow CRUD
    // ─────────────────────────────────────────────────────────

    /// <summary>列出当前用户的工作流</summary>
    [HttpGet("workflows")]
    public async Task<IActionResult> ListWorkflows(
        [FromQuery] string? tag,
        [FromQuery] int page = 1,
        [FromQuery] int pageSize = 20,
        CancellationToken ct = default)
    {
        var userId = GetUserId();
        var filter = Builders<Workflow>.Filter.Eq(w => w.CreatedBy, userId);

        if (!string.IsNullOrWhiteSpace(tag))
            filter &= Builders<Workflow>.Filter.AnyEq(w => w.Tags, tag);

        var total = await _db.Workflows.CountDocumentsAsync(filter, cancellationToken: ct);
        var items = await _db.Workflows
            .Find(filter)
            .SortByDescending(w => w.UpdatedAt)
            .Skip((page - 1) * pageSize)
            .Limit(pageSize)
            .ToListAsync(ct);

        return Ok(ApiResponse<object>.Ok(new { items, total }));
    }

    /// <summary>创建工作流</summary>
    [HttpPost("workflows")]
    public async Task<IActionResult> CreateWorkflow(
        [FromBody] CreateWorkflowRequest request,
        CancellationToken ct = default)
    {
        var userId = GetUserId();
        var userName = GetUsername();

        var workflow = new Workflow
        {
            Name = request.Name?.Trim() ?? "未命名工作流",
            Description = request.Description,
            Icon = request.Icon,
            Tags = request.Tags ?? new(),
            Nodes = request.Nodes ?? new(),
            Edges = request.Edges ?? new(),
            Variables = request.Variables ?? new(),
            Triggers = request.Triggers ?? new(),
            CreatedBy = userId,
            CreatedByName = userName,
            OwnerUserId = userId,
        };

        // 校验舱类型（兼容旧 NodeType 和新 CapsuleType）
        foreach (var node in workflow.Nodes)
        {
            if (!CapsuleTypes.All.Contains(node.NodeType) && !WorkflowNodeTypes.All.Contains(node.NodeType))
                return BadRequest(ApiResponse<object>.Fail("INVALID_NODE_TYPE", $"不支持的舱类型: {node.NodeType}"));
        }

        // 校验边的引用合法性
        var nodeIds = workflow.Nodes.Select(n => n.NodeId).ToHashSet();
        foreach (var edge in workflow.Edges)
        {
            if (!nodeIds.Contains(edge.SourceNodeId) || !nodeIds.Contains(edge.TargetNodeId))
                return BadRequest(ApiResponse<object>.Fail("INVALID_EDGE", "边引用了不存在的节点"));
        }

        await _db.Workflows.InsertOneAsync(workflow, cancellationToken: ct);

        _logger.LogInformation("[{AppKey}] Workflow created: {WorkflowId} by {UserId}", AppKey, workflow.Id, userId);

        return Ok(ApiResponse<object>.Ok(new { workflow }));
    }

    /// <summary>获取工作流详情</summary>
    [HttpGet("workflows/{id}")]
    public async Task<IActionResult> GetWorkflow(string id, CancellationToken ct = default)
    {
        var workflow = await _db.Workflows.Find(w => w.Id == id).FirstOrDefaultAsync(ct);
        if (workflow == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "工作流不存在"));

        // 非管理员只能看自己的
        if (workflow.CreatedBy != GetUserId() && !HasManagePermission())
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限"));

        return Ok(ApiResponse<object>.Ok(new { workflow }));
    }

    /// <summary>更新工作流定义</summary>
    [HttpPut("workflows/{id}")]
    public async Task<IActionResult> UpdateWorkflow(
        string id,
        [FromBody] UpdateWorkflowRequest request,
        CancellationToken ct = default)
    {
        var workflow = await _db.Workflows.Find(w => w.Id == id).FirstOrDefaultAsync(ct);
        if (workflow == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "工作流不存在"));

        if (workflow.CreatedBy != GetUserId() && !HasManagePermission())
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限"));

        // 校验舱类型（与 Create 保持一致）
        if (request.Nodes != null)
        {
            foreach (var node in request.Nodes)
            {
                if (!CapsuleTypes.All.Contains(node.NodeType) && !WorkflowNodeTypes.All.Contains(node.NodeType))
                    return BadRequest(ApiResponse<object>.Fail("INVALID_NODE_TYPE", $"不支持的舱类型: {node.NodeType}"));
            }

            // 校验边引用合法性
            var nodeIds = request.Nodes.Select(n => n.NodeId).ToHashSet();
            var edgesToCheck = request.Edges ?? workflow.Edges;
            foreach (var edge in edgesToCheck)
            {
                if (!nodeIds.Contains(edge.SourceNodeId) || !nodeIds.Contains(edge.TargetNodeId))
                    return BadRequest(ApiResponse<object>.Fail("INVALID_EDGE", "边引用了不存在的节点"));
            }
        }
        else if (request.Edges != null)
        {
            var nodeIds = workflow.Nodes.Select(n => n.NodeId).ToHashSet();
            foreach (var edge in request.Edges)
            {
                if (!nodeIds.Contains(edge.SourceNodeId) || !nodeIds.Contains(edge.TargetNodeId))
                    return BadRequest(ApiResponse<object>.Fail("INVALID_EDGE", "边引用了不存在的节点"));
            }
        }

        if (request.Name != null) workflow.Name = request.Name.Trim();
        if (request.Description != null) workflow.Description = request.Description;
        if (request.Icon != null) workflow.Icon = request.Icon;
        if (request.Tags != null) workflow.Tags = request.Tags;
        if (request.Nodes != null) workflow.Nodes = request.Nodes;
        if (request.Edges != null) workflow.Edges = request.Edges;
        if (request.Variables != null) workflow.Variables = request.Variables;
        if (request.Triggers != null) workflow.Triggers = request.Triggers;
        if (request.IsEnabled.HasValue) workflow.IsEnabled = request.IsEnabled.Value;
        workflow.UpdatedAt = DateTime.UtcNow;

        await _db.Workflows.ReplaceOneAsync(w => w.Id == id, workflow, cancellationToken: ct);

        _logger.LogInformation("[{AppKey}] Workflow updated: {WorkflowId}", AppKey, id);

        return Ok(ApiResponse<object>.Ok(new { workflow }));
    }

    /// <summary>删除工作流</summary>
    [HttpDelete("workflows/{id}")]
    public async Task<IActionResult> DeleteWorkflow(string id, CancellationToken ct = default)
    {
        var workflow = await _db.Workflows.Find(w => w.Id == id).FirstOrDefaultAsync(ct);
        if (workflow == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "工作流不存在"));

        if (workflow.CreatedBy != GetUserId() && !HasManagePermission())
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限"));

        await _db.Workflows.DeleteOneAsync(w => w.Id == id, ct);

        _logger.LogInformation("[{AppKey}] Workflow deleted: {WorkflowId}", AppKey, id);

        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    // ─────────────────────────────────────────────────────────
    // Execution 执行管理
    // ─────────────────────────────────────────────────────────

    /// <summary>手动触发执行</summary>
    [HttpPost("workflows/{id}/execute")]
    public async Task<IActionResult> ExecuteWorkflow(
        string id,
        [FromBody] ExecuteWorkflowRequest? request,
        CancellationToken ct = default)
    {
        var userId = GetUserId();
        var workflow = await _db.Workflows.Find(w => w.Id == id).FirstOrDefaultAsync(ct);
        if (workflow == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "工作流不存在"));

        if (workflow.Nodes.Count == 0)
            return BadRequest(ApiResponse<object>.Fail("EMPTY_WORKFLOW", "工作流没有节点，无法执行"));

        // 构建运行时变量
        var variables = new Dictionary<string, string>();
        foreach (var v in workflow.Variables)
        {
            // 优先使用请求中的值，否则使用默认值
            if (request?.Variables?.TryGetValue(v.Key, out var val) == true)
                variables[v.Key] = val;
            else if (v.DefaultValue != null)
                variables[v.Key] = ResolveDefaultValue(v.DefaultValue);
            else if (v.Required)
                return BadRequest(ApiResponse<object>.Fail("MISSING_VARIABLE", $"缺少必填变量: {v.Label} ({v.Key})"));
        }

        // 创建执行实例
        var execution = new WorkflowExecution
        {
            WorkflowId = workflow.Id,
            WorkflowName = workflow.Name,
            TriggerType = WorkflowTriggerTypes.Manual,
            TriggeredBy = userId,
            TriggeredByName = GetUsername(),
            Variables = variables,
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

        await _db.WorkflowExecutions.InsertOneAsync(execution, cancellationToken: ct);

        // 更新工作流统计
        await _db.Workflows.UpdateOneAsync(
            w => w.Id == id,
            Builders<Workflow>.Update
                .Set(w => w.LastExecutedAt, DateTime.UtcNow)
                .Inc(w => w.ExecutionCount, 1),
            cancellationToken: ct);

        // 入队（WorkflowRunWorker 会消费）
        await _runQueue.EnqueueAsync("workflow", execution.Id, ct);

        _logger.LogInformation("[{AppKey}] Workflow execution queued: {ExecutionId} for {WorkflowId} by {UserId}",
            AppKey, execution.Id, id, userId);

        return Ok(ApiResponse<object>.Ok(new { execution }));
    }

    /// <summary>从指定节点重跑</summary>
    [HttpPost("executions/{executionId}/resume-from/{nodeId}")]
    public async Task<IActionResult> ResumeFromNode(
        string executionId,
        string nodeId,
        CancellationToken ct = default)
    {
        var original = await _db.WorkflowExecutions.Find(e => e.Id == executionId).FirstOrDefaultAsync(ct);
        if (original == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "执行记录不存在"));

        if (original.TriggeredBy != GetUserId() && !HasManagePermission())
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限操作此执行记录"));

        // 验证节点存在
        if (original.NodeSnapshot.All(n => n.NodeId != nodeId))
            return BadRequest(ApiResponse<object>.Fail("INVALID_NODE", "节点不存在"));

        // 创建新执行实例，保留目标节点之前的产物
        var newExecution = new WorkflowExecution
        {
            WorkflowId = original.WorkflowId,
            WorkflowName = original.WorkflowName,
            TriggerType = "resume",
            TriggeredBy = GetUserId(),
            TriggeredByName = GetUsername(),
            Variables = original.Variables,
            NodeSnapshot = original.NodeSnapshot,
            EdgeSnapshot = original.EdgeSnapshot,
            Status = WorkflowExecutionStatus.Queued,
        };

        // 标记节点状态：目标节点之前保持 completed，之后重置为 pending
        var targetFound = false;
        foreach (var node in original.NodeSnapshot)
        {
            if (node.NodeId == nodeId) targetFound = true;

            var originalNodeExec = original.NodeExecutions.FirstOrDefault(n => n.NodeId == node.NodeId);

            if (!targetFound && originalNodeExec?.Status == NodeExecutionStatus.Completed)
            {
                // 保留已完成节点
                newExecution.NodeExecutions.Add(new NodeExecution
                {
                    NodeId = node.NodeId,
                    NodeName = node.Name,
                    NodeType = node.NodeType,
                    Status = NodeExecutionStatus.Completed,
                    OutputArtifacts = originalNodeExec.OutputArtifacts,
                    StartedAt = originalNodeExec.StartedAt,
                    CompletedAt = originalNodeExec.CompletedAt,
                    DurationMs = originalNodeExec.DurationMs,
                });
            }
            else
            {
                // 重置为 pending
                newExecution.NodeExecutions.Add(new NodeExecution
                {
                    NodeId = node.NodeId,
                    NodeName = node.Name,
                    NodeType = node.NodeType,
                    Status = NodeExecutionStatus.Pending,
                });
            }
        }

        await _db.WorkflowExecutions.InsertOneAsync(newExecution, cancellationToken: ct);

        // 入队
        await _runQueue.EnqueueAsync("workflow", newExecution.Id, ct);

        _logger.LogInformation("[{AppKey}] Execution resumed from node {NodeId}: new={NewExecId} original={OriginalExecId}",
            AppKey, nodeId, newExecution.Id, executionId);

        return Ok(ApiResponse<object>.Ok(new { execution = newExecution }));
    }

    /// <summary>取消执行</summary>
    [HttpPost("executions/{executionId}/cancel")]
    public async Task<IActionResult> CancelExecution(string executionId, CancellationToken ct = default)
    {
        var execution = await _db.WorkflowExecutions.Find(e => e.Id == executionId).FirstOrDefaultAsync(ct);
        if (execution == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "执行记录不存在"));

        if (execution.TriggeredBy != GetUserId() && !HasManagePermission())
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限取消此执行"));

        if (execution.Status is WorkflowExecutionStatus.Completed or WorkflowExecutionStatus.Failed or WorkflowExecutionStatus.Cancelled)
            return BadRequest(ApiResponse<object>.Fail("ALREADY_TERMINAL", "执行已结束，无法取消"));

        await _db.WorkflowExecutions.UpdateOneAsync(
            e => e.Id == executionId,
            Builders<WorkflowExecution>.Update
                .Set(e => e.Status, WorkflowExecutionStatus.Cancelled)
                .Set(e => e.CompletedAt, DateTime.UtcNow),
            cancellationToken: ct);

        _logger.LogInformation("[{AppKey}] Execution cancelled: {ExecutionId}", AppKey, executionId);

        return Ok(ApiResponse<object>.Ok(new { cancelled = true }));
    }

    /// <summary>查询执行历史</summary>
    [HttpGet("executions")]
    public async Task<IActionResult> ListExecutions(
        [FromQuery] string? workflowId,
        [FromQuery] string? status,
        [FromQuery] int page = 1,
        [FromQuery] int pageSize = 20,
        CancellationToken ct = default)
    {
        var userId = GetUserId();
        var filter = HasManagePermission()
            ? Builders<WorkflowExecution>.Filter.Empty
            : Builders<WorkflowExecution>.Filter.Eq(e => e.TriggeredBy, userId);

        if (!string.IsNullOrWhiteSpace(workflowId))
            filter &= Builders<WorkflowExecution>.Filter.Eq(e => e.WorkflowId, workflowId);
        if (!string.IsNullOrWhiteSpace(status))
            filter &= Builders<WorkflowExecution>.Filter.Eq(e => e.Status, status);

        var total = await _db.WorkflowExecutions.CountDocumentsAsync(filter, cancellationToken: ct);
        var items = await _db.WorkflowExecutions
            .Find(filter)
            .SortByDescending(e => e.CreatedAt)
            .Skip((page - 1) * pageSize)
            .Limit(pageSize)
            // 列表只返回摘要，不返回 NodeSnapshot/EdgeSnapshot/FinalArtifacts
            .Project(Builders<WorkflowExecution>.Projection
                .Exclude(e => e.NodeSnapshot)
                .Exclude(e => e.EdgeSnapshot)
                .Exclude(e => e.FinalArtifacts))
            .As<WorkflowExecution>()
            .ToListAsync(ct);

        return Ok(ApiResponse<object>.Ok(new { items, total }));
    }

    /// <summary>获取执行详情</summary>
    [HttpGet("executions/{executionId}")]
    public async Task<IActionResult> GetExecution(string executionId, CancellationToken ct = default)
    {
        var execution = await _db.WorkflowExecutions.Find(e => e.Id == executionId).FirstOrDefaultAsync(ct);
        if (execution == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "执行记录不存在"));

        if (execution.TriggeredBy != GetUserId() && !HasManagePermission())
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限查看此执行记录"));

        return Ok(ApiResponse<object>.Ok(new { execution }));
    }

    /// <summary>查看节点执行日志</summary>
    [HttpGet("executions/{executionId}/nodes/{nodeId}/logs")]
    public async Task<IActionResult> GetNodeLogs(
        string executionId, string nodeId, CancellationToken ct = default)
    {
        var execution = await _db.WorkflowExecutions.Find(e => e.Id == executionId).FirstOrDefaultAsync(ct);
        if (execution == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "执行记录不存在"));

        if (execution.TriggeredBy != GetUserId() && !HasManagePermission())
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限查看此执行日志"));

        var nodeExec = execution.NodeExecutions.FirstOrDefault(n => n.NodeId == nodeId);
        if (nodeExec == null)
            return NotFound(ApiResponse<object>.Fail("NODE_NOT_FOUND", "节点不存在"));

        return Ok(ApiResponse<object>.Ok(new
        {
            nodeId,
            nodeName = nodeExec.NodeName,
            status = nodeExec.Status,
            logs = nodeExec.Logs,
            errorMessage = nodeExec.ErrorMessage,
            artifacts = nodeExec.OutputArtifacts,
        }));
    }

    // ─────────────────────────────────────────────────────────
    // Share 分享
    // ─────────────────────────────────────────────────────────

    /// <summary>创建分享链接</summary>
    [HttpPost("executions/{executionId}/share")]
    public async Task<IActionResult> CreateShareLink(
        string executionId,
        [FromBody] CreateShareRequest request,
        CancellationToken ct = default)
    {
        var execution = await _db.WorkflowExecutions.Find(e => e.Id == executionId).FirstOrDefaultAsync(ct);
        if (execution == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "执行记录不存在"));

        if (execution.TriggeredBy != GetUserId() && !HasManagePermission())
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限分享此执行记录"));

        var link = new ShareLink
        {
            ResourceType = "workflow-execution",
            ResourceId = executionId,
            AccessLevel = request.AccessLevel ?? "public",
            Title = execution.WorkflowName,
            Artifacts = execution.FinalArtifacts.Select(a => new ShareArtifactRef
            {
                ArtifactId = a.ArtifactId,
                Name = a.Name,
                MimeType = a.MimeType,
                Url = a.CosUrl,
            }).ToList(),
            CreatedBy = GetUserId(),
            ExpiresAt = request.ExpiresInDays.HasValue
                ? DateTime.UtcNow.AddDays(request.ExpiresInDays.Value)
                : null,
        };

        // 如果有 HTML 产物，作为预览
        var htmlArtifact = execution.FinalArtifacts.FirstOrDefault(a => a.MimeType == "text/html");
        if (htmlArtifact?.InlineContent != null)
            link.PreviewHtml = htmlArtifact.InlineContent;

        await _db.ShareLinks.InsertOneAsync(link, cancellationToken: ct);

        // 记录到执行实例
        await _db.WorkflowExecutions.UpdateOneAsync(
            e => e.Id == executionId,
            Builders<WorkflowExecution>.Update.AddToSet(e => e.ShareLinkIds, link.Id),
            cancellationToken: ct);

        _logger.LogInformation("[{AppKey}] Share link created: {Token} for execution {ExecutionId}",
            AppKey, link.Token, executionId);

        return Ok(ApiResponse<object>.Ok(new
        {
            shareLink = link,
            url = $"/s/{link.Token}"
        }));
    }

    /// <summary>撤销分享</summary>
    [HttpDelete("shares/{shareId}")]
    public async Task<IActionResult> RevokeShare(string shareId, CancellationToken ct = default)
    {
        var link = await _db.ShareLinks.Find(l => l.Id == shareId).FirstOrDefaultAsync(ct);
        if (link == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "分享链接不存在"));

        if (link.CreatedBy != GetUserId() && !HasManagePermission())
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限"));

        await _db.ShareLinks.UpdateOneAsync(
            l => l.Id == shareId,
            Builders<ShareLink>.Update.Set(l => l.IsRevoked, true),
            cancellationToken: ct);

        return Ok(ApiResponse<object>.Ok(new { revoked = true }));
    }

    /// <summary>我的分享列表</summary>
    [HttpGet("shares")]
    public async Task<IActionResult> ListShares(CancellationToken ct = default)
    {
        var userId = GetUserId();
        var items = await _db.ShareLinks
            .Find(l => l.CreatedBy == userId && !l.IsRevoked)
            .SortByDescending(l => l.CreatedAt)
            .Limit(100)
            .ToListAsync(ct);

        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    // ─────────────────────────────────────────────────────────
    // Share 公开访问（AllowAnonymous）
    // ─────────────────────────────────────────────────────────

    /// <summary>查看分享内容</summary>
    [HttpGet("/s/{token}")]
    [AllowAnonymous]
    public async Task<IActionResult> ViewShare(string token, CancellationToken ct = default)
    {
        var link = await _db.ShareLinks
            .Find(l => l.Token == token && !l.IsRevoked)
            .FirstOrDefaultAsync(ct);

        if (link == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "链接不存在或已失效"));

        if (link.ExpiresAt.HasValue && link.ExpiresAt < DateTime.UtcNow)
            return StatusCode(410, ApiResponse<object>.Fail("EXPIRED", "链接已过期"));

        // 权限检查
        if (link.AccessLevel == "authenticated")
        {
            var userId = GetUserIdOrNull();
            if (userId == null)
                return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "需要登录后查看"));
        }

        // 更新统计
        await _db.ShareLinks.UpdateOneAsync(
            l => l.Id == link.Id,
            Builders<ShareLink>.Update
                .Inc(l => l.ViewCount, 1)
                .Set(l => l.LastViewedAt, DateTime.UtcNow),
            cancellationToken: ct);

        // HTML 产物直接返回页面
        if (link.PreviewHtml != null)
            return Content(link.PreviewHtml, "text/html");

        return Ok(ApiResponse<object>.Ok(new
        {
            title = link.Title,
            artifacts = link.Artifacts,
        }));
    }

    // ─────────────────────────────────────────────────────────
    // Helpers
    // ─────────────────────────────────────────────────────────

    private string GetUserId()
        => User.FindFirst("sub")?.Value
           ?? User.FindFirst(ClaimTypes.NameIdentifier)?.Value
           ?? "unknown";

    private string? GetUserIdOrNull()
        => User?.FindFirst("sub")?.Value
           ?? User?.FindFirst(ClaimTypes.NameIdentifier)?.Value;

    private string? GetUsername()
        => User.FindFirst("name")?.Value
           ?? User.FindFirst(ClaimTypes.Name)?.Value;

    private bool HasManagePermission()
    {
        var permissions = User.FindAll("permissions").Select(c => c.Value).ToList();
        return permissions.Contains(AdminPermissionCatalog.WorkflowAgentManage)
               || permissions.Contains(AdminPermissionCatalog.Super);
    }

    private static string ResolveDefaultValue(string template)
    {
        var now = DateTime.Now;
        return template
            .Replace("{{now.year}}", now.Year.ToString())
            .Replace("{{now.month}}", now.Month.ToString("D2"))
            .Replace("{{now.date}}", now.ToString("yyyy-MM-dd"));
    }
}

// ─────────────────────────────────────────────────────────────
// Request DTOs
// ─────────────────────────────────────────────────────────────

#region Request DTOs

public class CreateWorkflowRequest
{
    public string? Name { get; set; }
    public string? Description { get; set; }
    public string? Icon { get; set; }
    public List<string>? Tags { get; set; }
    public List<WorkflowNode>? Nodes { get; set; }
    public List<WorkflowEdge>? Edges { get; set; }
    public List<WorkflowVariable>? Variables { get; set; }
    public List<WorkflowTrigger>? Triggers { get; set; }
}

public class UpdateWorkflowRequest
{
    public string? Name { get; set; }
    public string? Description { get; set; }
    public string? Icon { get; set; }
    public List<string>? Tags { get; set; }
    public List<WorkflowNode>? Nodes { get; set; }
    public List<WorkflowEdge>? Edges { get; set; }
    public List<WorkflowVariable>? Variables { get; set; }
    public List<WorkflowTrigger>? Triggers { get; set; }
    public bool? IsEnabled { get; set; }
}

public class ExecuteWorkflowRequest
{
    public Dictionary<string, string>? Variables { get; set; }
}

public class CreateShareRequest
{
    /// <summary>public | authenticated</summary>
    public string? AccessLevel { get; set; }
    public int? ExpiresInDays { get; set; }
}

// ─────────────────────── 舱测试运行 ───────────────────────

public class CapsuleTestRunRequest
{
    /// <summary>舱类型 Key</summary>
    public string TypeKey { get; set; } = string.Empty;

    /// <summary>舱配置（字段由 ConfigSchema 定义）</summary>
    public Dictionary<string, object?>? Config { get; set; }

    /// <summary>模拟输入数据（用于测试）</summary>
    public object? MockInput { get; set; }
}

public class CapsuleTestRunResult
{
    public string TypeKey { get; set; } = string.Empty;
    public string TypeName { get; set; } = string.Empty;
    public string Status { get; set; } = "completed";
    public DateTime StartedAt { get; set; }
    public DateTime CompletedAt { get; set; }
    public long DurationMs { get; set; }
    public List<ConfigFieldValidation> ConfigValidation { get; set; } = new();
    public Dictionary<string, object?> MockOutput { get; set; } = new();
    public string? ErrorMessage { get; set; }
}

public class ConfigFieldValidation
{
    public string Key { get; set; } = string.Empty;
    public string Label { get; set; } = string.Empty;
    public bool Provided { get; set; }
    public bool Required { get; set; }
    public bool Valid { get; set; }
    public string? ValidationMessage { get; set; }
}

#endregion
