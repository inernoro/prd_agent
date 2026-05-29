using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Api.Services;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 项目管理智能体 — 立项、任务看板/甘特图、AI 需求拆解。
/// appKey 硬编码 pm-agent（应用身份隔离，见 .claude/rules/app-identity.md）。
/// </summary>
[ApiController]
[Route("api/pm")]
[Authorize]
[AdminController("pm-agent", AdminPermissionCatalog.PmAgentUse)]
public class PmAgentController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly PmAgentService _pmService;
    private readonly ILogger<PmAgentController> _logger;

    public PmAgentController(MongoDbContext db, PmAgentService pmService, ILogger<PmAgentController> logger)
    {
        _db = db;
        _pmService = pmService;
        _logger = logger;
    }

    private string GetUserId() => this.GetRequiredUserId();

    // ─────────────────────────────────────────────
    // 项目 CRUD（立项 / 列表 / 详情 / 更新 / 删除）
    // ─────────────────────────────────────────────

    /// <summary>立项注册 — 创建项目</summary>
    [HttpPost("projects")]
    public async Task<IActionResult> CreateProject([FromBody] CreatePmProjectRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.Title))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "项目名称不能为空"));
        if (string.IsNullOrWhiteSpace(request.BusinessGoal))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "业务目标不能为空"));
        if (!PmProjectType.All.Contains(request.ProjectType))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "无效的项目类型"));

        var userId = GetUserId();
        var leaderId = string.IsNullOrWhiteSpace(request.LeaderId) ? userId : request.LeaderId.Trim();

        // Leader 名称冗余（便于展示）
        var leader = await _db.Users.Find(u => u.Id == leaderId).FirstOrDefaultAsync();

        var project = new PmProject
        {
            ProjectNo = await GenerateProjectNoAsync(),
            Title = request.Title.Trim(),
            Description = request.Description?.Trim(),
            BusinessGoal = request.BusinessGoal.Trim(),
            ProjectType = request.ProjectType,
            OperationSubType = request.ProjectType == PmProjectType.Operation ? request.OperationSubType : null,
            Lifecycle = PmProjectLifecycle.Registered,
            LeaderId = leaderId,
            LeaderName = leader?.DisplayName,
            MemberIds = request.MemberIds ?? new(),
            StrategyAlignment = request.StrategyAlignment?.Trim(),
            PlannedStartAt = request.PlannedStartAt,
            PlannedEndAt = request.PlannedEndAt,
            Budget = request.Budget,
            OwnerId = userId,
        };

        await _db.PmProjects.InsertOneAsync(project);
        _logger.LogInformation("[pm-agent] Project created: {ProjectNo} '{Title}' by {UserId}", project.ProjectNo, project.Title, userId);
        return Ok(ApiResponse<object>.Ok(project));
    }

    /// <summary>项目列表（我创建的 + 我参与的）</summary>
    [HttpGet("projects")]
    public async Task<IActionResult> ListProjects([FromQuery] int page = 1, [FromQuery] int pageSize = 20, [FromQuery] string? type = null)
    {
        var userId = GetUserId();
        pageSize = Math.Clamp(pageSize, 1, 100);
        page = Math.Max(1, page);

        var b = Builders<PmProject>.Filter;
        var filter = b.And(
            b.Eq(p => p.IsDeleted, false),
            b.Or(b.Eq(p => p.OwnerId, userId), b.Eq(p => p.LeaderId, userId), b.AnyEq(p => p.MemberIds, userId))
        );
        if (!string.IsNullOrWhiteSpace(type) && PmProjectType.All.Contains(type))
            filter = b.And(filter, b.Eq(p => p.ProjectType, type));

        var total = await _db.PmProjects.CountDocumentsAsync(filter);
        var items = await _db.PmProjects.Find(filter)
            .SortByDescending(p => p.UpdatedAt)
            .Skip((page - 1) * pageSize)
            .Limit(pageSize)
            .ToListAsync();

        return Ok(ApiResponse<object>.Ok(new { items, total, page, pageSize }));
    }

    /// <summary>项目详情（含任务列表）</summary>
    [HttpGet("projects/{projectId}")]
    public async Task<IActionResult> GetProject(string projectId)
    {
        var userId = GetUserId();
        var project = await FindAccessibleProjectAsync(projectId, userId);
        if (project == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "项目不存在或无权访问"));

        var tasks = await _db.PmTasks.Find(t => t.ProjectId == projectId)
            .SortBy(t => t.OrderKey).ThenBy(t => t.CreatedAt)
            .ToListAsync();

        return Ok(ApiResponse<object>.Ok(new { project, tasks }));
    }

    /// <summary>更新项目（含生命周期推进）</summary>
    [HttpPut("projects/{projectId}")]
    public async Task<IActionResult> UpdateProject(string projectId, [FromBody] UpdatePmProjectRequest request)
    {
        var userId = GetUserId();
        var project = await FindAccessibleProjectAsync(projectId, userId);
        if (project == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "项目不存在或无权访问"));

        var update = Builders<PmProject>.Update.Set(p => p.UpdatedAt, DateTime.UtcNow);
        if (request.Title != null) update = update.Set(p => p.Title, request.Title.Trim());
        if (request.Description != null) update = update.Set(p => p.Description, request.Description.Trim());
        if (request.BusinessGoal != null) update = update.Set(p => p.BusinessGoal, request.BusinessGoal.Trim());
        if (request.StrategyAlignment != null) update = update.Set(p => p.StrategyAlignment, request.StrategyAlignment.Trim());
        if (request.PlannedStartAt.HasValue) update = update.Set(p => p.PlannedStartAt, request.PlannedStartAt);
        if (request.PlannedEndAt.HasValue) update = update.Set(p => p.PlannedEndAt, request.PlannedEndAt);
        if (request.Budget.HasValue) update = update.Set(p => p.Budget, request.Budget);
        if (request.MemberIds != null) update = update.Set(p => p.MemberIds, request.MemberIds);
        if (request.Lifecycle != null && PmProjectLifecycle.All.Contains(request.Lifecycle))
        {
            update = update.Set(p => p.Lifecycle, request.Lifecycle);
            if (request.Lifecycle == PmProjectLifecycle.Closing || request.Lifecycle == PmProjectLifecycle.Evaluated)
                update = update.Set(p => p.ClosedAt, DateTime.UtcNow);
        }

        await _db.PmProjects.UpdateOneAsync(p => p.Id == projectId, update);
        return Ok(ApiResponse<object>.Ok(new { updated = true }));
    }

    /// <summary>删除项目（软删除 + 级联删除任务）</summary>
    [HttpDelete("projects/{projectId}")]
    public async Task<IActionResult> DeleteProject(string projectId)
    {
        var userId = GetUserId();
        var project = await _db.PmProjects.Find(p => p.Id == projectId && (p.OwnerId == userId || p.LeaderId == userId)).FirstOrDefaultAsync();
        if (project == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "项目不存在或无权删除"));

        await _db.PmProjects.UpdateOneAsync(p => p.Id == projectId,
            Builders<PmProject>.Update.Set(p => p.IsDeleted, true).Set(p => p.UpdatedAt, DateTime.UtcNow));
        await _db.PmTasks.DeleteManyAsync(t => t.ProjectId == projectId);

        _logger.LogInformation("[pm-agent] Project deleted: {ProjectId} by {UserId}", projectId, userId);
        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    // ─────────────────────────────────────────────
    // 任务 CRUD（看板 / 列表 / 甘特图）
    // ─────────────────────────────────────────────

    /// <summary>创建单个任务</summary>
    [HttpPost("projects/{projectId}/tasks")]
    public async Task<IActionResult> CreateTask(string projectId, [FromBody] CreatePmTaskRequest request)
    {
        var userId = GetUserId();
        var project = await FindAccessibleProjectAsync(projectId, userId);
        if (project == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "项目不存在或无权访问"));
        if (string.IsNullOrWhiteSpace(request.Title))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "任务标题不能为空"));

        var task = new PmTask
        {
            ProjectId = projectId,
            Title = request.Title.Trim(),
            Description = request.Description?.Trim(),
            ParentTaskId = request.ParentTaskId,
            Status = PmTaskStatus.All.Contains(request.Status ?? "") ? request.Status! : PmTaskStatus.Backlog,
            Priority = PmTaskPriority.All.Contains(request.Priority ?? "") ? request.Priority! : PmTaskPriority.None,
            AssigneeId = request.AssigneeId,
            EstimateDays = request.EstimateDays,
            StartAt = request.StartAt,
            DueAt = request.DueAt,
            DependsOn = request.DependsOn ?? new(),
            Labels = request.Labels ?? new(),
            OrderKey = request.OrderKey ?? DateTime.UtcNow.Ticks,
            CreatedBy = userId,
        };
        await FillAssigneeNameAsync(task);
        await _db.PmTasks.InsertOneAsync(task);
        await RecalcTaskCountAsync(projectId);
        return Ok(ApiResponse<object>.Ok(task));
    }

    /// <summary>批量创建任务（确认 AI 拆解草稿 → 落库，dependsOnTitles 映射为 ID）</summary>
    [HttpPost("projects/{projectId}/tasks/batch")]
    public async Task<IActionResult> BatchCreateTasks(string projectId, [FromBody] BatchCreatePmTasksRequest request)
    {
        var userId = GetUserId();
        var project = await FindAccessibleProjectAsync(projectId, userId);
        if (project == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "项目不存在或无权访问"));
        if (request.Tasks == null || request.Tasks.Count == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "任务列表为空"));

        var baseOrder = DateTime.UtcNow.Ticks;
        var created = new List<PmTask>();
        // 第一遍：建任务并建立 标题→Id 映射（供依赖映射）
        var titleToId = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (var i = 0; i < request.Tasks.Count; i++)
        {
            var d = request.Tasks[i];
            var task = new PmTask
            {
                ProjectId = projectId,
                Title = (d.Title ?? "未命名任务").Trim(),
                Description = d.Description?.Trim(),
                Status = PmTaskStatus.Backlog,
                Priority = PmTaskPriority.All.Contains(d.Priority ?? "") ? d.Priority! : PmTaskPriority.Medium,
                EstimateDays = d.EstimateDays,
                Labels = d.Labels ?? new(),
                SourceRef = d.SourceRef,
                Source = PmTaskSource.AiDecompose,
                OrderKey = baseOrder + i,
                CreatedBy = userId,
            };
            created.Add(task);
            titleToId[task.Title] = task.Id;
        }
        // 第二遍：映射 dependsOnTitles → DependsOn(ids)
        for (var i = 0; i < request.Tasks.Count; i++)
        {
            var titles = request.Tasks[i].DependsOnTitles ?? new();
            created[i].DependsOn = titles
                .Where(t => titleToId.ContainsKey(t))
                .Select(t => titleToId[t])
                .Where(id => id != created[i].Id)
                .ToList();
        }

        await _db.PmTasks.InsertManyAsync(created);
        await RecalcTaskCountAsync(projectId);
        _logger.LogInformation("[pm-agent] Batch created {Count} tasks for project {ProjectId}", created.Count, projectId);
        return Ok(ApiResponse<object>.Ok(new { items = created, count = created.Count }));
    }

    /// <summary>更新任务（状态/优先级/负责人/时间/排序/依赖）</summary>
    [HttpPut("tasks/{taskId}")]
    public async Task<IActionResult> UpdateTask(string taskId, [FromBody] UpdatePmTaskRequest request)
    {
        var userId = GetUserId();
        var task = await _db.PmTasks.Find(t => t.Id == taskId).FirstOrDefaultAsync();
        if (task == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "任务不存在"));
        var project = await FindAccessibleProjectAsync(task.ProjectId, userId);
        if (project == null)
            return StatusCode(StatusCodes.Status403Forbidden, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权操作"));

        var update = Builders<PmTask>.Update.Set(t => t.UpdatedAt, DateTime.UtcNow);
        if (request.Title != null) update = update.Set(t => t.Title, request.Title.Trim());
        if (request.Description != null) update = update.Set(t => t.Description, request.Description.Trim());
        if (request.Status != null && PmTaskStatus.All.Contains(request.Status)) update = update.Set(t => t.Status, request.Status);
        if (request.Priority != null && PmTaskPriority.All.Contains(request.Priority)) update = update.Set(t => t.Priority, request.Priority);
        if (request.AssigneeId != null)
        {
            update = update.Set(t => t.AssigneeId, request.AssigneeId);
            var assignee = await _db.Users.Find(u => u.Id == request.AssigneeId).FirstOrDefaultAsync();
            update = update.Set(t => t.AssigneeName, assignee?.DisplayName);
        }
        if (request.EstimateDays.HasValue) update = update.Set(t => t.EstimateDays, request.EstimateDays);
        if (request.StartAt.HasValue) update = update.Set(t => t.StartAt, request.StartAt);
        if (request.DueAt.HasValue) update = update.Set(t => t.DueAt, request.DueAt);
        if (request.DependsOn != null) update = update.Set(t => t.DependsOn, request.DependsOn);
        if (request.Labels != null) update = update.Set(t => t.Labels, request.Labels);
        if (request.OrderKey.HasValue) update = update.Set(t => t.OrderKey, request.OrderKey.Value);

        await _db.PmTasks.UpdateOneAsync(t => t.Id == taskId, update);
        if (request.Status != null) await RecalcTaskCountAsync(task.ProjectId);
        return Ok(ApiResponse<object>.Ok(new { updated = true }));
    }

    /// <summary>删除任务（级联删除子任务 + 清理依赖引用）</summary>
    [HttpDelete("tasks/{taskId}")]
    public async Task<IActionResult> DeleteTask(string taskId)
    {
        var userId = GetUserId();
        var task = await _db.PmTasks.Find(t => t.Id == taskId).FirstOrDefaultAsync();
        if (task == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "任务不存在"));
        var project = await FindAccessibleProjectAsync(task.ProjectId, userId);
        if (project == null)
            return StatusCode(StatusCodes.Status403Forbidden, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权操作"));

        // 收集子任务（BFS）
        var toDelete = new List<string> { taskId };
        var queue = new Queue<string>();
        queue.Enqueue(taskId);
        while (queue.Count > 0)
        {
            var pid = queue.Dequeue();
            var children = await _db.PmTasks.Find(t => t.ProjectId == task.ProjectId && t.ParentTaskId == pid).Project(t => t.Id).ToListAsync();
            foreach (var c in children) { toDelete.Add(c); queue.Enqueue(c); }
        }
        var result = await _db.PmTasks.DeleteManyAsync(t => toDelete.Contains(t.Id));
        // 清理其余任务对被删任务的依赖引用
        await _db.PmTasks.UpdateManyAsync(
            t => t.ProjectId == task.ProjectId,
            Builders<PmTask>.Update.PullAll(t => t.DependsOn, toDelete));
        await RecalcTaskCountAsync(task.ProjectId);
        return Ok(ApiResponse<object>.Ok(new { deletedCount = result.DeletedCount }));
    }

    // ─────────────────────────────────────────────
    // AI 需求拆解（SSE 流式，提案不落库）
    // ─────────────────────────────────────────────

    /// <summary>AI 拆解需求为任务草稿（SSE 流式；用户确认后调 tasks/batch 落库）</summary>
    [HttpPost("projects/{projectId}/decompose")]
    [Produces("text/event-stream")]
    public async Task Decompose(string projectId, [FromBody] DecomposeRequest? request = null)
    {
        var userId = GetUserId();
        var project = await FindAccessibleProjectAsync(projectId, userId);
        if (project == null)
        {
            Response.StatusCode = 404;
            return;
        }

        Response.ContentType = "text/event-stream; charset=utf-8";
        Response.Headers.CacheControl = "no-cache";

        await WriteSseEvent("stage", new { stage = "decomposing", message = "正在分析业务目标，拆解任务…" });

        string? llmError = null;
        var count = 0;
        await foreach (var draft in _pmService.DecomposeAsync(
            project, request?.RequirementText, userId,
            onError: err => llmError = err,
            onContent: async text => await WriteSseEvent("typing", new { text }),
            onThinking: async text => await WriteSseEvent("thinking", new { text })))
        {
            count++;
            await WriteSseEvent("task", draft);
            await WriteSseEvent("stage", new { stage = "drafting", message = $"已拆解 {count} 个任务…" });
        }

        if (llmError != null)
            await WriteSseEvent("error", new { message = llmError });
        await WriteSseEvent("done", new { totalNew = count, error = llmError });
    }

    // ── 辅助方法 ──

    private async Task<PmProject?> FindAccessibleProjectAsync(string projectId, string userId)
    {
        var b = Builders<PmProject>.Filter;
        return await _db.PmProjects.Find(b.And(
            b.Eq(p => p.Id, projectId),
            b.Eq(p => p.IsDeleted, false),
            b.Or(b.Eq(p => p.OwnerId, userId), b.Eq(p => p.LeaderId, userId), b.AnyEq(p => p.MemberIds, userId))
        )).FirstOrDefaultAsync();
    }

    private async Task<string> GenerateProjectNoAsync()
    {
        var year = DateTime.UtcNow.Year;
        var prefix = $"PM-{year}-";
        var count = await _db.PmProjects.CountDocumentsAsync(p => p.ProjectNo.StartsWith(prefix));
        return $"{prefix}{(count + 1):D4}";
    }

    private async Task FillAssigneeNameAsync(PmTask task)
    {
        if (string.IsNullOrWhiteSpace(task.AssigneeId)) return;
        var assignee = await _db.Users.Find(u => u.Id == task.AssigneeId).FirstOrDefaultAsync();
        task.AssigneeName = assignee?.DisplayName;
    }

    private async Task RecalcTaskCountAsync(string projectId)
    {
        var total = await _db.PmTasks.CountDocumentsAsync(t => t.ProjectId == projectId);
        var done = await _db.PmTasks.CountDocumentsAsync(t => t.ProjectId == projectId && t.Status == PmTaskStatus.Done);
        await _db.PmProjects.UpdateOneAsync(p => p.Id == projectId,
            Builders<PmProject>.Update
                .Set(p => p.TaskCount, (int)total)
                .Set(p => p.DoneTaskCount, (int)done)
                .Set(p => p.UpdatedAt, DateTime.UtcNow));
    }

    private async Task WriteSseEvent(string eventName, object data)
    {
        try
        {
            var json = JsonSerializer.Serialize(data, new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase });
            await Response.WriteAsync($"event: {eventName}\ndata: {json}\n\n");
            await Response.Body.FlushAsync();
        }
        catch (ObjectDisposedException) { }
        catch (OperationCanceledException) { }
    }
}

// ── 请求模型 ──

public class CreatePmProjectRequest
{
    public string Title { get; set; } = string.Empty;
    public string? Description { get; set; }
    public string BusinessGoal { get; set; } = string.Empty;
    public string ProjectType { get; set; } = PmProjectType.Operation;
    public string? OperationSubType { get; set; }
    public string? LeaderId { get; set; }
    public List<string>? MemberIds { get; set; }
    public string? StrategyAlignment { get; set; }
    public DateTime? PlannedStartAt { get; set; }
    public DateTime? PlannedEndAt { get; set; }
    public decimal? Budget { get; set; }
}

public class UpdatePmProjectRequest
{
    public string? Title { get; set; }
    public string? Description { get; set; }
    public string? BusinessGoal { get; set; }
    public string? StrategyAlignment { get; set; }
    public string? Lifecycle { get; set; }
    public DateTime? PlannedStartAt { get; set; }
    public DateTime? PlannedEndAt { get; set; }
    public decimal? Budget { get; set; }
    public List<string>? MemberIds { get; set; }
}

public class CreatePmTaskRequest
{
    public string Title { get; set; } = string.Empty;
    public string? Description { get; set; }
    public string? ParentTaskId { get; set; }
    public string? Status { get; set; }
    public string? Priority { get; set; }
    public string? AssigneeId { get; set; }
    public double? EstimateDays { get; set; }
    public DateTime? StartAt { get; set; }
    public DateTime? DueAt { get; set; }
    public List<string>? DependsOn { get; set; }
    public List<string>? Labels { get; set; }
    public double? OrderKey { get; set; }
}

public class BatchCreatePmTasksRequest
{
    public List<PmTaskDraftInput> Tasks { get; set; } = new();
}

public class PmTaskDraftInput
{
    public string? Title { get; set; }
    public string? Description { get; set; }
    public string? Priority { get; set; }
    public double? EstimateDays { get; set; }
    public List<string>? DependsOnTitles { get; set; }
    public string? SourceRef { get; set; }
    public List<string>? Labels { get; set; }
}

public class UpdatePmTaskRequest
{
    public string? Title { get; set; }
    public string? Description { get; set; }
    public string? Status { get; set; }
    public string? Priority { get; set; }
    public string? AssigneeId { get; set; }
    public double? EstimateDays { get; set; }
    public DateTime? StartAt { get; set; }
    public DateTime? DueAt { get; set; }
    public List<string>? DependsOn { get; set; }
    public List<string>? Labels { get; set; }
    public double? OrderKey { get; set; }
}

public class DecomposeRequest
{
    /// <summary>可选的需求文档/补充材料文本（零摩擦输入：粘贴/上传后传入）</summary>
    public string? RequirementText { get; set; }
}
