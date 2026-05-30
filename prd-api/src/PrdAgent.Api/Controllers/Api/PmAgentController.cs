using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services.AssetStorage;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 项目管理智能体 — 立项、任务看板/甘特图、AI 需求拆解。
/// appKey 硬编码 pm-agent（应用身份隔离，见 .claude/rules/app-identity.md）。
/// </summary>
[ApiController]
[Route("api/pm")]
[Authorize]
[AdminController("pm-agent", AdminPermissionCatalog.PmAgentUse)]
[ServiceFilter(typeof(PrdAgent.Api.Filters.PmAuditActionFilter))]
public class PmAgentController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly PmAgentService _pmService;
    private readonly IAssetStorage _assetStorage;
    private readonly IHostedSiteService _hostedSites;
    private readonly ILogger<PmAgentController> _logger;

    public PmAgentController(
        MongoDbContext db,
        PmAgentService pmService,
        IAssetStorage assetStorage,
        IHostedSiteService hostedSites,
        ILogger<PmAgentController> logger)
    {
        _db = db;
        _pmService = pmService;
        _assetStorage = assetStorage;
        _hostedSites = hostedSites;
        _logger = logger;
    }

    private const long MaxKnowledgeBytes = 50 * 1024 * 1024;

    private string GetUserId() => this.GetRequiredUserId();

    /// <summary>是否具备指定权限（中间件已把有效权限注入 permissions claim）。super 视为全通过。</summary>
    private bool HasPermission(string perm)
    {
        var permissions = User.FindAll("permissions").Select(c => c.Value).ToList();
        return permissions.Contains(perm) || permissions.Contains(AdminPermissionCatalog.Super);
    }

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
        // 项目经理必填（前端默认填当前用户但可改）
        var leaderId = request.LeaderId?.Trim();
        if (string.IsNullOrWhiteSpace(leaderId))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请指定项目经理"));

        // Leader 名称冗余（便于展示）；同时校验该用户存在
        var leader = await _db.Users.Find(u => u.UserId == leaderId).FirstOrDefaultAsync();
        if (leader == null)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "项目经理不是有效用户"));

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
            // 项目经理默认加入成员（去重）
            MemberIds = (request.MemberIds ?? new()).Append(leaderId).Where(x => !string.IsNullOrWhiteSpace(x)).Distinct().ToList(),
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

    /// <summary>项目列表。scope: managed(我管理的=项目经理) / related(我相关的=创建人或干系人且非Leader) / all(默认)</summary>
    [HttpGet("projects")]
    public async Task<IActionResult> ListProjects([FromQuery] int page = 1, [FromQuery] int pageSize = 20, [FromQuery] string? type = null, [FromQuery] string? scope = null)
    {
        var userId = GetUserId();
        pageSize = Math.Clamp(pageSize, 1, 100);
        page = Math.Max(1, page);

        var b = Builders<PmProject>.Filter;
        var conds = new List<FilterDefinition<PmProject>> { b.Eq(p => p.IsDeleted, false) };

        // 访问范围（与 FindAccessibleProjectAsync 对齐：owner/leader/member/stakeholder）
        var managed = b.Eq(p => p.LeaderId, userId);
        // 我相关的：我被设为干系人的项目，且我不是项目经理
        var related = b.And(
            b.ElemMatch(p => p.Stakeholders, s => s.UserId == userId),
            b.Ne(p => p.LeaderId, userId));
        if (scope == "managed") conds.Add(managed);
        else if (scope == "related") conds.Add(related);
        else conds.Add(b.Or(
            b.Eq(p => p.OwnerId, userId), b.Eq(p => p.LeaderId, userId),
            b.AnyEq(p => p.MemberIds, userId), b.ElemMatch(p => p.Stakeholders, s => s.UserId == userId)));

        if (!string.IsNullOrWhiteSpace(type) && PmProjectType.All.Contains(type))
            conds.Add(b.Eq(p => p.ProjectType, type));

        var filter = b.And(conds);
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
        if (request.ActualCost.HasValue) update = update.Set(p => p.ActualCost, request.ActualCost);
        if (request.ValueCoefficient.HasValue) update = update.Set(p => p.ValueCoefficient, Math.Max(0, request.ValueCoefficient.Value));
        if (request.WipLimits != null) update = update.Set(p => p.WipLimits, request.WipLimits.Where(kv => PmTaskStatus.All.Contains(kv.Key) && kv.Value > 0).ToDictionary(kv => kv.Key, kv => kv.Value));
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
    // 项目成员管理（参与干活的人，区别于干系人）
    // ─────────────────────────────────────────────

    /// <summary>项目成员详情（含显示名/头像 + 项目经理/创建人标识）</summary>
    [HttpGet("projects/{projectId}/members")]
    public async Task<IActionResult> GetMembers(string projectId)
    {
        var userId = GetUserId();
        var project = await FindAccessibleProjectAsync(projectId, userId);
        if (project == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "项目不存在或无权访问"));

        // 项目经理始终视为成员（兼容历史项目：即便没存进 MemberIds 也展示）
        var memberIds = project.MemberIds.Append(project.LeaderId).Where(x => !string.IsNullOrWhiteSpace(x)).Distinct().ToList();
        var members = await ResolveMembersAsync(memberIds);
        return Ok(ApiResponse<object>.Ok(new { members, leaderId = project.LeaderId, ownerId = project.OwnerId }));
    }

    /// <summary>整体替换项目成员。仅 owner/leader 可改</summary>
    [HttpPut("projects/{projectId}/members")]
    public async Task<IActionResult> SetMembers(string projectId, [FromBody] SetMembersRequest request)
    {
        var userId = GetUserId();
        var project = await FindAccessibleProjectAsync(projectId, userId);
        if (project == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "项目不存在或无权访问"));
        if (project.OwnerId != userId && project.LeaderId != userId)
            return StatusCode(StatusCodes.Status403Forbidden, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "仅立项人或负责人可管理成员"));

        // 项目经理不可被移除，始终保留在成员中
        var ids = (request.MemberIds ?? new()).Append(project.LeaderId).Where(x => !string.IsNullOrWhiteSpace(x)).Distinct().ToList();
        var valid = await _db.Users.Find(u => ids.Contains(u.UserId)).Project(u => u.UserId).ToListAsync();
        var members = ids.Where(valid.Contains).ToList();

        await _db.PmProjects.UpdateOneAsync(p => p.Id == projectId,
            Builders<PmProject>.Update.Set(p => p.MemberIds, members).Set(p => p.UpdatedAt, DateTime.UtcNow));

        var resolved = await ResolveMembersAsync(members);
        return Ok(ApiResponse<object>.Ok(new { members = resolved, memberIds = members }));
    }

    /// <summary>把成员 UserId 列表解析为含显示名/头像的对象</summary>
    private async Task<List<object>> ResolveMembersAsync(List<string> memberIds)
    {
        var ids = memberIds.Distinct().ToList();
        if (ids.Count == 0) return new();
        var users = await _db.Users.Find(u => ids.Contains(u.UserId)).ToListAsync();
        return users.Select(u => (object)new { userId = u.UserId, displayName = u.DisplayName, avatarFileName = u.AvatarFileName }).ToList();
    }

    // ─────────────────────────────────────────────
    // 项目知识库（多格式文件 + 分类）+ 成员托管站点联动
    // ─────────────────────────────────────────────

    /// <summary>知识库文件列表（可按分类过滤）+ 全部分类聚合</summary>
    [HttpGet("projects/{projectId}/knowledge/files")]
    public async Task<IActionResult> ListKnowledgeFiles(string projectId, [FromQuery] string? category)
    {
        var userId = GetUserId();
        var project = await FindAccessibleProjectAsync(projectId, userId);
        if (project == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "项目不存在或无权访问"));

        var all = await _db.PmKnowledgeFiles.Find(f => f.ProjectId == projectId)
            .SortByDescending(f => f.CreatedAt).ToListAsync();
        var categories = all.Select(f => f.Category).Where(c => !string.IsNullOrWhiteSpace(c)).Distinct().OrderBy(c => c).ToList();
        var files = string.IsNullOrWhiteSpace(category) ? all : all.Where(f => f.Category == category).ToList();
        return Ok(ApiResponse<object>.Ok(new { files, categories }));
    }

    /// <summary>上传知识库文件（multipart）。文件本体存 IAssetStorage，元信息落 pm_knowledge_files</summary>
    [HttpPost("projects/{projectId}/knowledge/files")]
    public async Task<IActionResult> UploadKnowledgeFile(string projectId, [FromForm] IFormFile? file, [FromForm] string? category)
    {
        var userId = GetUserId();
        var project = await FindAccessibleProjectAsync(projectId, userId);
        if (project == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "项目不存在或无权访问"));
        if (file == null || file.Length == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "未选择文件"));
        if (file.Length > MaxKnowledgeBytes)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_TOO_LARGE, "单文件不能超过 50MB"));

        byte[] bytes;
        await using (var ms = new MemoryStream())
        {
            await file.CopyToAsync(ms, CancellationToken.None);
            bytes = ms.ToArray();
        }
        var mime = string.IsNullOrWhiteSpace(file.ContentType) ? "application/octet-stream" : file.ContentType;
        var storageType = mime.StartsWith("image/", StringComparison.OrdinalIgnoreCase) ? AppDomainPaths.TypeImg : AppDomainPaths.TypeDoc;
        var stored = await _assetStorage.SaveAsync(bytes, mime, CancellationToken.None, domain: "prd-agent", type: storageType, fileName: file.FileName);

        var uploaderName = (await _db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync())?.DisplayName;
        var entity = new PmKnowledgeFile
        {
            ProjectId = projectId,
            FileName = file.FileName,
            ContentType = mime,
            FileSize = file.Length,
            Url = stored.Url,
            Category = string.IsNullOrWhiteSpace(category) ? "未分类" : category!.Trim(),
            UploaderId = userId,
            UploaderName = uploaderName,
        };
        await _db.PmKnowledgeFiles.InsertOneAsync(entity);
        return Ok(ApiResponse<object>.Ok(entity));
    }

    /// <summary>改名 / 改分类</summary>
    [HttpPut("knowledge/files/{fileId}")]
    public async Task<IActionResult> UpdateKnowledgeFile(string fileId, [FromBody] UpdateKnowledgeFileRequest request)
    {
        var userId = GetUserId();
        var f = await _db.PmKnowledgeFiles.Find(x => x.Id == fileId).FirstOrDefaultAsync();
        if (f == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文件不存在"));
        if (await FindAccessibleProjectAsync(f.ProjectId, userId) == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "项目不存在或无权访问"));

        var update = Builders<PmKnowledgeFile>.Update.Set(x => x.UpdatedAt, DateTime.UtcNow);
        if (!string.IsNullOrWhiteSpace(request.FileName)) update = update.Set(x => x.FileName, request.FileName!.Trim());
        if (!string.IsNullOrWhiteSpace(request.Category)) update = update.Set(x => x.Category, request.Category!.Trim());
        await _db.PmKnowledgeFiles.UpdateOneAsync(x => x.Id == fileId, update);
        return Ok(ApiResponse<object>.Ok(new { updated = true }));
    }

    /// <summary>删除知识库文件（删元信息记录）</summary>
    [HttpDelete("knowledge/files/{fileId}")]
    public async Task<IActionResult> DeleteKnowledgeFile(string fileId)
    {
        var userId = GetUserId();
        var f = await _db.PmKnowledgeFiles.Find(x => x.Id == fileId).FirstOrDefaultAsync();
        if (f == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文件不存在"));
        if (await FindAccessibleProjectAsync(f.ProjectId, userId) == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "项目不存在或无权访问"));
        await _db.PmKnowledgeFiles.DeleteOneAsync(x => x.Id == fileId);
        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    /// <summary>聚合项目成员（创建人 + 负责人 + 成员）名下已公开的托管站点，免密查看</summary>
    [HttpGet("projects/{projectId}/member-sites")]
    public async Task<IActionResult> GetMemberSites(string projectId)
    {
        var userId = GetUserId();
        var project = await FindAccessibleProjectAsync(projectId, userId);
        if (project == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "项目不存在或无权访问"));

        var ownerIds = new List<string> { project.OwnerId, project.LeaderId };
        ownerIds.AddRange(project.MemberIds);
        var distinctIds = ownerIds.Where(id => !string.IsNullOrWhiteSpace(id)).Distinct().ToList();

        var nameMap = (await _db.Users.Find(u => distinctIds.Contains(u.UserId)).ToListAsync())
            .ToDictionary(u => u.UserId, u => u.DisplayName);

        var sites = new List<object>();
        foreach (var ownerId in distinctIds)
        {
            var hosted = await _hostedSites.ListPublicByUserIdAsync(ownerId, 60, CancellationToken.None);
            foreach (var s in hosted)
            {
                sites.Add(new
                {
                    userId = ownerId,
                    userName = nameMap.TryGetValue(ownerId, out var n) ? n : "—",
                    siteId = s.Id,
                    title = s.Title,
                    url = s.SiteUrl,
                });
            }
        }
        return Ok(ApiResponse<object>.Ok(new { sites }));
    }

    // ─────────────────────────────────────────────
    // 决策事项（待决策 / 已决策 / 备忘）
    // ─────────────────────────────────────────────

    /// <summary>项目决策列表（按状态 + OrderKey + 时间排序）</summary>
    [HttpGet("projects/{projectId}/decisions")]
    public async Task<IActionResult> ListDecisions(string projectId)
    {
        var userId = GetUserId();
        var project = await FindAccessibleProjectAsync(projectId, userId);
        if (project == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "项目不存在或无权访问"));

        var items = await _db.PmDecisions.Find(d => d.ProjectId == projectId)
            .SortBy(d => d.OrderKey).ThenByDescending(d => d.CreatedAt).ToListAsync();
        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    /// <summary>新建决策事项。type 缺省 pending</summary>
    [HttpPost("projects/{projectId}/decisions")]
    public async Task<IActionResult> CreateDecision(string projectId, [FromBody] CreateDecisionRequest request)
    {
        var userId = GetUserId();
        var project = await FindAccessibleProjectAsync(projectId, userId);
        if (project == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "项目不存在或无权访问"));
        if (string.IsNullOrWhiteSpace(request.Title))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "决策标题不能为空"));

        var type = PmDecisionType.IsValid(request.Type) ? request.Type! : PmDecisionType.Pending;
        var creatorName = (await _db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync())?.DisplayName;
        var entity = new PmDecision
        {
            ProjectId = projectId,
            Title = request.Title!.Trim(),
            Content = request.Content?.Trim(),
            Type = type,
            CreatedBy = userId,
            CreatedByName = creatorName,
            OrderKey = DateTime.UtcNow.Ticks,
        };
        if (type == PmDecisionType.Decided)
        {
            entity.DecidedBy = userId;
            entity.DecidedByName = creatorName;
            entity.DecidedAt = DateTime.UtcNow;
        }
        await _db.PmDecisions.InsertOneAsync(entity);
        return Ok(ApiResponse<object>.Ok(entity));
    }

    /// <summary>更新决策（标题 / 内容 / 状态流转）。转入 decided 落定案信息，转出 decided 清空</summary>
    [HttpPut("decisions/{decisionId}")]
    public async Task<IActionResult> UpdateDecision(string decisionId, [FromBody] UpdateDecisionRequest request)
    {
        var userId = GetUserId();
        var d = await _db.PmDecisions.Find(x => x.Id == decisionId).FirstOrDefaultAsync();
        if (d == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "决策不存在"));
        if (await FindAccessibleProjectAsync(d.ProjectId, userId) == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "项目不存在或无权访问"));

        var update = Builders<PmDecision>.Update.Set(x => x.UpdatedAt, DateTime.UtcNow);
        if (request.Title != null)
        {
            if (string.IsNullOrWhiteSpace(request.Title))
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "决策标题不能为空"));
            update = update.Set(x => x.Title, request.Title.Trim());
        }
        if (request.Content != null) update = update.Set(x => x.Content, request.Content.Trim());

        if (request.Type != null)
        {
            if (!PmDecisionType.IsValid(request.Type))
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "无效的决策状态"));
            update = update.Set(x => x.Type, request.Type);
            if (request.Type == PmDecisionType.Decided && d.Type != PmDecisionType.Decided)
            {
                var actorName = (await _db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync())?.DisplayName;
                update = update.Set(x => x.DecidedBy, userId).Set(x => x.DecidedByName, actorName).Set(x => x.DecidedAt, DateTime.UtcNow);
            }
            else if (request.Type != PmDecisionType.Decided && d.Type == PmDecisionType.Decided)
            {
                update = update.Set(x => x.DecidedBy, (string?)null).Set(x => x.DecidedByName, (string?)null).Set(x => x.DecidedAt, (DateTime?)null);
            }
        }
        if (request.OrderKey.HasValue) update = update.Set(x => x.OrderKey, request.OrderKey.Value);

        await _db.PmDecisions.UpdateOneAsync(x => x.Id == decisionId, update);
        return Ok(ApiResponse<object>.Ok(new { updated = true }));
    }

    /// <summary>删除决策事项</summary>
    [HttpDelete("decisions/{decisionId}")]
    public async Task<IActionResult> DeleteDecision(string decisionId)
    {
        var userId = GetUserId();
        var d = await _db.PmDecisions.Find(x => x.Id == decisionId).FirstOrDefaultAsync();
        if (d == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "决策不存在"));
        if (await FindAccessibleProjectAsync(d.ProjectId, userId) == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "项目不存在或无权访问"));
        await _db.PmDecisions.DeleteOneAsync(x => x.Id == decisionId);
        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    // ─────────────────────────────────────────────
    // 项目周报（Markdown，支持 md 导入 + 图片）
    // ─────────────────────────────────────────────

    /// <summary>周报列表（按周起始日 / 创建时间倒序）</summary>
    [HttpGet("projects/{projectId}/weekly-reports")]
    public async Task<IActionResult> ListWeeklyReports(string projectId)
    {
        var userId = GetUserId();
        var project = await FindAccessibleProjectAsync(projectId, userId);
        if (project == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "项目不存在或无权访问"));

        var items = await _db.PmWeeklyReports.Find(r => r.ProjectId == projectId)
            .SortByDescending(r => r.WeekStart).ThenByDescending(r => r.CreatedAt).ToListAsync();
        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    /// <summary>新建周报（content 为 Markdown，可由前端导入 md 文件后提交）</summary>
    [HttpPost("projects/{projectId}/weekly-reports")]
    public async Task<IActionResult> CreateWeeklyReport(string projectId, [FromBody] WeeklyReportRequest request)
    {
        var userId = GetUserId();
        var project = await FindAccessibleProjectAsync(projectId, userId);
        if (project == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "项目不存在或无权访问"));
        if (string.IsNullOrWhiteSpace(request.Title))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "周报标题不能为空"));

        var authorName = (await _db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync())?.DisplayName;
        var entity = new PmWeeklyReport
        {
            ProjectId = projectId,
            Title = request.Title!.Trim(),
            WeekStart = request.WeekStart,
            Content = request.Content ?? string.Empty,
            AuthorId = userId,
            AuthorName = authorName,
        };
        await _db.PmWeeklyReports.InsertOneAsync(entity);
        return Ok(ApiResponse<object>.Ok(entity));
    }

    /// <summary>更新周报</summary>
    [HttpPut("weekly-reports/{reportId}")]
    public async Task<IActionResult> UpdateWeeklyReport(string reportId, [FromBody] WeeklyReportRequest request)
    {
        var userId = GetUserId();
        var r = await _db.PmWeeklyReports.Find(x => x.Id == reportId).FirstOrDefaultAsync();
        if (r == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "周报不存在"));
        if (await FindAccessibleProjectAsync(r.ProjectId, userId) == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "项目不存在或无权访问"));

        var update = Builders<PmWeeklyReport>.Update.Set(x => x.UpdatedAt, DateTime.UtcNow);
        if (request.Title != null)
        {
            if (string.IsNullOrWhiteSpace(request.Title))
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "周报标题不能为空"));
            update = update.Set(x => x.Title, request.Title.Trim());
        }
        if (request.Content != null) update = update.Set(x => x.Content, request.Content);
        if (request.WeekStart.HasValue) update = update.Set(x => x.WeekStart, request.WeekStart);
        await _db.PmWeeklyReports.UpdateOneAsync(x => x.Id == reportId, update);
        return Ok(ApiResponse<object>.Ok(new { updated = true }));
    }

    /// <summary>删除周报</summary>
    [HttpDelete("weekly-reports/{reportId}")]
    public async Task<IActionResult> DeleteWeeklyReport(string reportId)
    {
        var userId = GetUserId();
        var r = await _db.PmWeeklyReports.Find(x => x.Id == reportId).FirstOrDefaultAsync();
        if (r == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "周报不存在"));
        if (await FindAccessibleProjectAsync(r.ProjectId, userId) == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "项目不存在或无权访问"));
        await _db.PmWeeklyReports.DeleteOneAsync(x => x.Id == reportId);
        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    /// <summary>上传周报内嵌图片（multipart），返回可访问 URL 供前端插入 Markdown</summary>
    [HttpPost("projects/{projectId}/weekly-reports/image")]
    public async Task<IActionResult> UploadWeeklyReportImage(string projectId, [FromForm] IFormFile? file)
    {
        var userId = GetUserId();
        var project = await FindAccessibleProjectAsync(projectId, userId);
        if (project == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "项目不存在或无权访问"));
        if (file == null || file.Length == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "未选择图片"));
        var mime = file.ContentType ?? "";
        if (!mime.StartsWith("image/", StringComparison.OrdinalIgnoreCase))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "仅支持图片文件"));
        if (file.Length > 10 * 1024 * 1024)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_TOO_LARGE, "单张图片不能超过 10MB"));

        byte[] bytes;
        await using (var ms = new MemoryStream())
        {
            await file.CopyToAsync(ms, CancellationToken.None);
            bytes = ms.ToArray();
        }
        var stored = await _assetStorage.SaveAsync(bytes, mime, CancellationToken.None, domain: "prd-agent", type: "img", fileName: file.FileName);
        return Ok(ApiResponse<object>.Ok(new { url = stored.Url }));
    }

    // ─────────────────────────────────────────────
    // 会议纪要（参会人 + Markdown 纪要）
    // ─────────────────────────────────────────────

    /// <summary>会议纪要列表（按会议时间倒序），附参会人显示信息</summary>
    [HttpGet("projects/{projectId}/meetings")]
    public async Task<IActionResult> ListMeetings(string projectId)
    {
        var userId = GetUserId();
        var project = await FindAccessibleProjectAsync(projectId, userId);
        if (project == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "项目不存在或无权访问"));

        var items = await _db.PmMeetings.Find(m => m.ProjectId == projectId)
            .SortByDescending(m => m.MeetingAt).ThenByDescending(m => m.CreatedAt).ToListAsync();
        var attendeeIds = items.SelectMany(m => m.AttendeeIds).Distinct().ToList();
        var attendees = await ResolveMembersAsync(attendeeIds);
        return Ok(ApiResponse<object>.Ok(new { items, attendees }));
    }

    /// <summary>新建会议纪要</summary>
    [HttpPost("projects/{projectId}/meetings")]
    public async Task<IActionResult> CreateMeeting(string projectId, [FromBody] MeetingRequest request)
    {
        var userId = GetUserId();
        var project = await FindAccessibleProjectAsync(projectId, userId);
        if (project == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "项目不存在或无权访问"));
        if (string.IsNullOrWhiteSpace(request.Title))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "会议主题不能为空"));

        var recorderName = (await _db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync())?.DisplayName;
        var entity = new PmMeeting
        {
            ProjectId = projectId,
            Title = request.Title!.Trim(),
            MeetingAt = request.MeetingAt,
            Location = request.Location?.Trim(),
            AttendeeIds = (request.AttendeeIds ?? new()).Where(x => !string.IsNullOrWhiteSpace(x)).Distinct().ToList(),
            Content = request.Content ?? string.Empty,
            RecordedBy = userId,
            RecordedByName = recorderName,
        };
        await _db.PmMeetings.InsertOneAsync(entity);
        return Ok(ApiResponse<object>.Ok(entity));
    }

    /// <summary>更新会议纪要</summary>
    [HttpPut("meetings/{meetingId}")]
    public async Task<IActionResult> UpdateMeeting(string meetingId, [FromBody] MeetingRequest request)
    {
        var userId = GetUserId();
        var m = await _db.PmMeetings.Find(x => x.Id == meetingId).FirstOrDefaultAsync();
        if (m == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "会议纪要不存在"));
        if (await FindAccessibleProjectAsync(m.ProjectId, userId) == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "项目不存在或无权访问"));

        var update = Builders<PmMeeting>.Update.Set(x => x.UpdatedAt, DateTime.UtcNow);
        if (request.Title != null)
        {
            if (string.IsNullOrWhiteSpace(request.Title))
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "会议主题不能为空"));
            update = update.Set(x => x.Title, request.Title.Trim());
        }
        if (request.Content != null) update = update.Set(x => x.Content, request.Content);
        if (request.Location != null) update = update.Set(x => x.Location, request.Location.Trim());
        if (request.MeetingAt.HasValue) update = update.Set(x => x.MeetingAt, request.MeetingAt);
        if (request.AttendeeIds != null) update = update.Set(x => x.AttendeeIds, request.AttendeeIds.Where(x => !string.IsNullOrWhiteSpace(x)).Distinct().ToList());
        await _db.PmMeetings.UpdateOneAsync(x => x.Id == meetingId, update);
        return Ok(ApiResponse<object>.Ok(new { updated = true }));
    }

    /// <summary>删除会议纪要</summary>
    [HttpDelete("meetings/{meetingId}")]
    public async Task<IActionResult> DeleteMeeting(string meetingId)
    {
        var userId = GetUserId();
        var m = await _db.PmMeetings.Find(x => x.Id == meetingId).FirstOrDefaultAsync();
        if (m == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "会议纪要不存在"));
        if (await FindAccessibleProjectAsync(m.ProjectId, userId) == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "项目不存在或无权访问"));
        await _db.PmMeetings.DeleteOneAsync(x => x.Id == meetingId);
        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    // ─────────────────────────────────────────────
    // 目标 / 计划（团队目标全员可见，个人目标仅本人）
    // ─────────────────────────────────────────────

    /// <summary>目标列表：团队目标全员可见 + 仅返回当前用户自己的个人目标（可见性后端隔离）</summary>
    [HttpGet("projects/{projectId}/goals")]
    public async Task<IActionResult> ListGoals(string projectId)
    {
        var userId = GetUserId();
        var project = await FindAccessibleProjectAsync(projectId, userId);
        if (project == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "项目不存在或无权访问"));

        var b = Builders<PmGoal>.Filter;
        var filter = b.And(
            b.Eq(g => g.ProjectId, projectId),
            b.Or(
                b.Eq(g => g.Scope, PmGoalScope.Team),
                b.And(b.Eq(g => g.Scope, PmGoalScope.Personal), b.Eq(g => g.OwnerId, userId))));
        var goals = await _db.PmGoals.Find(filter).SortBy(g => g.OrderKey).ThenByDescending(g => g.CreatedAt).ToListAsync();

        // auto 模式进度：由关联里程碑(Milestone.GoalId==目标)的任务完成度滚动平均
        var milestones = await _db.PmMilestones.Find(m => m.ProjectId == projectId).ToListAsync();
        var tasks = await _db.PmTasks.Find(t => t.ProjectId == projectId)
            .Project(t => new { t.MilestoneId, t.Status }).ToListAsync();
        int MsProgress(string msId)
        {
            var mine = tasks.Where(t => t.MilestoneId == msId && t.Status != PmTaskStatus.Cancelled).ToList();
            return mine.Count > 0 ? (int)Math.Round(mine.Count(t => t.Status == PmTaskStatus.Done) * 100.0 / mine.Count) : 0;
        }

        var items = goals.Select(g =>
        {
            var linked = milestones.Where(m => m.GoalId == g.Id).ToList();
            var effective = (g.ProgressMode == PmGoalProgressMode.Auto && linked.Count > 0)
                ? (int)Math.Round(linked.Average(m => MsProgress(m.Id)))
                : g.Progress;
            return new
            {
                id = g.Id, projectId = g.ProjectId, scope = g.Scope, ownerId = g.OwnerId,
                title = g.Title, description = g.Description, metric = g.Metric, period = g.Period,
                progress = effective, progressMode = g.ProgressMode, linkedMilestoneCount = linked.Count,
                status = g.Status, createdBy = g.CreatedBy, createdByName = g.CreatedByName,
                orderKey = g.OrderKey, createdAt = g.CreatedAt, updatedAt = g.UpdatedAt,
            };
        }).ToList();
        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    /// <summary>新建目标。个人目标 OwnerId 强制本人；团队目标仅 owner/leader 可建</summary>
    [HttpPost("projects/{projectId}/goals")]
    public async Task<IActionResult> CreateGoal(string projectId, [FromBody] GoalRequest request)
    {
        var userId = GetUserId();
        var project = await FindAccessibleProjectAsync(projectId, userId);
        if (project == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "项目不存在或无权访问"));
        if (string.IsNullOrWhiteSpace(request.Title))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "目标标题不能为空"));

        var scope = PmGoalScope.IsValid(request.Scope) ? request.Scope! : PmGoalScope.Team;
        if (scope == PmGoalScope.Team && project.OwnerId != userId && project.LeaderId != userId)
            return StatusCode(StatusCodes.Status403Forbidden, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "团队目标仅立项人或负责人可创建"));

        var creatorName = (await _db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync())?.DisplayName;
        var entity = new PmGoal
        {
            ProjectId = projectId,
            Scope = scope,
            OwnerId = userId, // 个人目标=本人；团队目标记录创建人
            Title = request.Title!.Trim(),
            Description = request.Description?.Trim(),
            Metric = request.Metric?.Trim(),
            Period = request.Period?.Trim(),
            Progress = Math.Clamp(request.Progress ?? 0, 0, 100),
            ProgressMode = PmGoalProgressMode.IsValid(request.ProgressMode) ? request.ProgressMode! : PmGoalProgressMode.Auto,
            Status = PmGoalStatus.IsValid(request.Status) ? request.Status! : PmGoalStatus.OnTrack,
            CreatedBy = userId,
            CreatedByName = creatorName,
            OrderKey = DateTime.UtcNow.Ticks,
        };
        await _db.PmGoals.InsertOneAsync(entity);
        return Ok(ApiResponse<object>.Ok(entity));
    }

    /// <summary>更新目标。个人目标仅本人可改；团队目标项目成员均可改</summary>
    [HttpPut("goals/{goalId}")]
    public async Task<IActionResult> UpdateGoal(string goalId, [FromBody] GoalRequest request)
    {
        var userId = GetUserId();
        var g = await _db.PmGoals.Find(x => x.Id == goalId).FirstOrDefaultAsync();
        if (g == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "目标不存在"));
        var project = await FindAccessibleProjectAsync(g.ProjectId, userId);
        if (project == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "项目不存在或无权访问"));
        if (g.Scope == PmGoalScope.Personal && g.OwnerId != userId)
            return StatusCode(StatusCodes.Status403Forbidden, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "个人目标仅本人可修改"));
        if (g.Scope == PmGoalScope.Team && project.OwnerId != userId && project.LeaderId != userId)
            return StatusCode(StatusCodes.Status403Forbidden, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "团队目标仅立项人或负责人可修改"));

        var update = Builders<PmGoal>.Update.Set(x => x.UpdatedAt, DateTime.UtcNow);
        if (request.ProgressMode != null)
        {
            if (!PmGoalProgressMode.IsValid(request.ProgressMode))
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "无效的进度模式"));
            update = update.Set(x => x.ProgressMode, request.ProgressMode);
        }
        if (request.Title != null)
        {
            if (string.IsNullOrWhiteSpace(request.Title))
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "目标标题不能为空"));
            update = update.Set(x => x.Title, request.Title.Trim());
        }
        if (request.Description != null) update = update.Set(x => x.Description, request.Description.Trim());
        if (request.Metric != null) update = update.Set(x => x.Metric, request.Metric.Trim());
        if (request.Period != null) update = update.Set(x => x.Period, request.Period.Trim());
        if (request.Progress.HasValue) update = update.Set(x => x.Progress, Math.Clamp(request.Progress.Value, 0, 100));
        if (request.Status != null)
        {
            if (!PmGoalStatus.IsValid(request.Status))
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "无效的目标状态"));
            update = update.Set(x => x.Status, request.Status);
        }
        if (request.OrderKey.HasValue) update = update.Set(x => x.OrderKey, request.OrderKey.Value);
        await _db.PmGoals.UpdateOneAsync(x => x.Id == goalId, update);
        return Ok(ApiResponse<object>.Ok(new { updated = true }));
    }

    /// <summary>删除目标。个人目标仅本人可删</summary>
    [HttpDelete("goals/{goalId}")]
    public async Task<IActionResult> DeleteGoal(string goalId)
    {
        var userId = GetUserId();
        var g = await _db.PmGoals.Find(x => x.Id == goalId).FirstOrDefaultAsync();
        if (g == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "目标不存在"));
        var project = await FindAccessibleProjectAsync(g.ProjectId, userId);
        if (project == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "项目不存在或无权访问"));
        if (g.Scope == PmGoalScope.Personal && g.OwnerId != userId)
            return StatusCode(StatusCodes.Status403Forbidden, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "个人目标仅本人可删除"));
        if (g.Scope == PmGoalScope.Team && project.OwnerId != userId && project.LeaderId != userId)
            return StatusCode(StatusCodes.Status403Forbidden, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "团队目标仅立项人或负责人可删除"));
        await _db.PmGoals.DeleteOneAsync(x => x.Id == goalId);
        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    // ─────────────────────────────────────────────
    // 里程碑（独立节点；进度由任务完成度读时滚动）
    // ─────────────────────────────────────────────

    /// <summary>里程碑列表，附进度滚动（任务完成度）与派生健康度</summary>
    [HttpGet("projects/{projectId}/milestones")]
    public async Task<IActionResult> ListMilestones(string projectId)
    {
        var userId = GetUserId();
        var project = await FindAccessibleProjectAsync(projectId, userId);
        if (project == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "项目不存在或无权访问"));

        var milestones = await _db.PmMilestones.Find(m => m.ProjectId == projectId)
            .SortBy(m => m.OrderKey).ThenBy(m => m.DueAt).ToListAsync();
        // 仅取计算进度所需字段
        var tasks = await _db.PmTasks.Find(t => t.ProjectId == projectId)
            .Project(t => new { t.MilestoneId, t.Status }).ToListAsync();

        var items = milestones.Select(m =>
        {
            var mine = tasks.Where(t => t.MilestoneId == m.Id && t.Status != PmTaskStatus.Cancelled).ToList();
            var total = mine.Count;
            var done = mine.Count(t => t.Status == PmTaskStatus.Done);
            var progress = total > 0 ? (int)Math.Round(done * 100.0 / total) : 0;
            return new
            {
                id = m.Id,
                projectId = m.ProjectId,
                title = m.Title,
                description = m.Description,
                dueAt = m.DueAt,
                reachedAt = m.ReachedAt,
                goalId = m.GoalId,
                status = m.Status,
                orderKey = m.OrderKey,
                taskTotal = total,
                taskDone = done,
                progress,
                health = MilestoneHealth(m, total, done),
                createdAt = m.CreatedAt,
                updatedAt = m.UpdatedAt,
            };
        }).ToList();
        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    /// <summary>派生健康度（不存储）：reached/cancelled/overdue/at_risk/on_track</summary>
    private static string MilestoneHealth(PmMilestone m, int total, int done)
    {
        if (m.Status == PmMilestoneStatus.Reached) return "reached";
        if (m.Status == PmMilestoneStatus.Cancelled) return "cancelled";
        var allDone = total > 0 && done >= total;
        var today = DateTime.UtcNow.Date;
        if (m.DueAt.HasValue && !allDone)
        {
            if (m.DueAt.Value.Date < today) return "overdue";
            if (m.DueAt.Value.Date <= today.AddDays(3)) return "at_risk";
        }
        return "on_track";
    }

    /// <summary>新建里程碑（仅 owner/leader 排计划）</summary>
    [HttpPost("projects/{projectId}/milestones")]
    public async Task<IActionResult> CreateMilestone(string projectId, [FromBody] MilestoneRequest request)
    {
        var userId = GetUserId();
        var project = await FindAccessibleProjectAsync(projectId, userId);
        if (project == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "项目不存在或无权访问"));
        if (project.OwnerId != userId && project.LeaderId != userId)
            return StatusCode(StatusCodes.Status403Forbidden, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "仅立项人或负责人可管理里程碑"));
        if (string.IsNullOrWhiteSpace(request.Title))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "里程碑名称不能为空"));

        var creatorName = (await _db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync())?.DisplayName;
        var entity = new PmMilestone
        {
            ProjectId = projectId,
            Title = request.Title!.Trim(),
            Description = request.Description?.Trim(),
            DueAt = request.DueAt,
            GoalId = string.IsNullOrWhiteSpace(request.GoalId) ? null : request.GoalId,
            Status = PmMilestoneStatus.Planned,
            OrderKey = DateTime.UtcNow.Ticks,
            CreatedBy = userId,
            CreatedByName = creatorName,
        };
        await _db.PmMilestones.InsertOneAsync(entity);
        return Ok(ApiResponse<object>.Ok(entity));
    }

    /// <summary>更新里程碑（仅 owner/leader）。转入 reached 落 ReachedAt，转出清空</summary>
    [HttpPut("milestones/{milestoneId}")]
    public async Task<IActionResult> UpdateMilestone(string milestoneId, [FromBody] MilestoneRequest request)
    {
        var userId = GetUserId();
        var m = await _db.PmMilestones.Find(x => x.Id == milestoneId).FirstOrDefaultAsync();
        if (m == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "里程碑不存在"));
        var project = await FindAccessibleProjectAsync(m.ProjectId, userId);
        if (project == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "项目不存在或无权访问"));
        if (project.OwnerId != userId && project.LeaderId != userId)
            return StatusCode(StatusCodes.Status403Forbidden, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "仅立项人或负责人可管理里程碑"));

        var update = Builders<PmMilestone>.Update.Set(x => x.UpdatedAt, DateTime.UtcNow);
        if (request.Title != null)
        {
            if (string.IsNullOrWhiteSpace(request.Title))
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "里程碑名称不能为空"));
            update = update.Set(x => x.Title, request.Title.Trim());
        }
        if (request.Description != null) update = update.Set(x => x.Description, request.Description.Trim());
        if (request.DueAt.HasValue) update = update.Set(x => x.DueAt, request.DueAt);
        if (request.GoalId != null) update = update.Set(x => x.GoalId, string.IsNullOrWhiteSpace(request.GoalId) ? null : request.GoalId);
        if (request.OrderKey.HasValue) update = update.Set(x => x.OrderKey, request.OrderKey.Value);
        if (request.Status != null)
        {
            if (!PmMilestoneStatus.IsValid(request.Status))
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "无效的里程碑状态"));
            update = update.Set(x => x.Status, request.Status);
            if (request.Status == PmMilestoneStatus.Reached && m.Status != PmMilestoneStatus.Reached)
                update = update.Set(x => x.ReachedAt, DateTime.UtcNow);
            else if (request.Status != PmMilestoneStatus.Reached && m.Status == PmMilestoneStatus.Reached)
                update = update.Set(x => x.ReachedAt, (DateTime?)null);
        }
        await _db.PmMilestones.UpdateOneAsync(x => x.Id == milestoneId, update);
        return Ok(ApiResponse<object>.Ok(new { updated = true }));
    }

    /// <summary>删除里程碑（仅 owner/leader）。同时解除其下任务的归属（MilestoneId 置空）</summary>
    [HttpDelete("milestones/{milestoneId}")]
    public async Task<IActionResult> DeleteMilestone(string milestoneId)
    {
        var userId = GetUserId();
        var m = await _db.PmMilestones.Find(x => x.Id == milestoneId).FirstOrDefaultAsync();
        if (m == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "里程碑不存在"));
        var project = await FindAccessibleProjectAsync(m.ProjectId, userId);
        if (project == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "项目不存在或无权访问"));
        if (project.OwnerId != userId && project.LeaderId != userId)
            return StatusCode(StatusCodes.Status403Forbidden, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "仅立项人或负责人可管理里程碑"));

        await _db.PmTasks.UpdateManyAsync(t => t.MilestoneId == milestoneId,
            Builders<PmTask>.Update.Set(t => t.MilestoneId, (string?)null).Set(t => t.UpdatedAt, DateTime.UtcNow));
        await _db.PmMilestones.DeleteOneAsync(x => x.Id == milestoneId);
        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    // ─────────────────────────────────────────────
    // 审计日志（操作留痕，管理层可见）
    // ─────────────────────────────────────────────

    /// <summary>审计日志列表（管理层可见）。可按 projectId 过滤；批量解析操作人名称与项目标题</summary>
    [HttpGet("audit-logs")]
    public async Task<IActionResult> ListAuditLogs([FromQuery] string? projectId = null, [FromQuery] int page = 1, [FromQuery] int pageSize = 50)
    {
        if (!HasPermission(AdminPermissionCatalog.PmAgentAudit))
            return StatusCode(StatusCodes.Status403Forbidden, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "审计日志仅对管理层开放"));

        page = Math.Max(1, page);
        pageSize = Math.Clamp(pageSize, 1, 200);
        var b = Builders<PmAuditLog>.Filter;
        var filter = string.IsNullOrWhiteSpace(projectId) ? b.Empty : b.Eq(x => x.ProjectId, projectId);
        var total = await _db.PmAuditLogs.CountDocumentsAsync(filter);
        var logs = await _db.PmAuditLogs.Find(filter).SortByDescending(x => x.CreatedAt)
            .Skip((page - 1) * pageSize).Limit(pageSize).ToListAsync();

        var actorIds = logs.Select(l => l.ActorId).Distinct().ToList();
        var actorMap = (await _db.Users.Find(u => actorIds.Contains(u.UserId)).ToListAsync())
            .ToDictionary(u => u.UserId, u => u.DisplayName);
        var projIds = logs.Where(l => l.ProjectId != null).Select(l => l.ProjectId!).Distinct().ToList();
        var projMap = (await _db.PmProjects.Find(p => projIds.Contains(p.Id)).ToListAsync())
            .ToDictionary(p => p.Id, p => new { p.ProjectNo, p.Title });

        var items = logs.Select(l =>
        {
            var hasProj = l.ProjectId != null && projMap.TryGetValue(l.ProjectId, out _);
            projMap.TryGetValue(l.ProjectId ?? "", out var proj);
            return new
            {
                id = l.Id,
                projectId = l.ProjectId,
                projectNo = hasProj ? proj!.ProjectNo : null,
                projectTitle = hasProj ? proj!.Title : null,
                actorId = l.ActorId,
                actorName = actorMap.TryGetValue(l.ActorId, out var n) ? n : null,
                action = l.Action,
                actionLabel = l.ActionLabel,
                method = l.Method,
                path = l.Path,
                targetId = l.TargetId,
                createdAt = l.CreatedAt,
            };
        }).ToList();
        return Ok(ApiResponse<object>.Ok(new { items, total, page, pageSize }));
    }

    // ─────────────────────────────────────────────
    // 干系人 + NPSS 结案评价（Phase 2）
    // ─────────────────────────────────────────────

    /// <summary>整体替换项目干系人列表（权力利益矩阵分类）</summary>
    [HttpPut("projects/{projectId}/stakeholders")]
    public async Task<IActionResult> SetStakeholders(string projectId, [FromBody] SetStakeholdersRequest request)
    {
        var userId = GetUserId();
        var project = await FindAccessibleProjectAsync(projectId, userId);
        if (project == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "项目不存在或无权访问"));

        var stakeholders = new List<PmStakeholder>();
        foreach (var s in request.Stakeholders ?? new())
        {
            // 干系人一律为 MAP 用户，UserId 必填
            if (string.IsNullOrWhiteSpace(s.UserId)) continue;
            var u = await _db.Users.Find(x => x.UserId == s.UserId).FirstOrDefaultAsync();
            if (u == null) continue;
            var isRep = s.IsRepresentative == true;
            var note = (s.Note ?? "").Trim();
            // 作代表时备注必填
            if (isRep && string.IsNullOrEmpty(note))
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, $"干系人「{u.DisplayName}」作为外部代表时必须填写备注"));

            stakeholders.Add(new PmStakeholder
            {
                Id = string.IsNullOrWhiteSpace(s.Id) ? Guid.NewGuid().ToString("N") : s.Id!,
                Name = u.DisplayName,
                UserId = s.UserId,
                IsRepresentative = isRep,
                Note = isRep ? note : (string.IsNullOrEmpty(note) ? null : note),
                Role = PmStakeholderRole.All.Contains(s.Role ?? "") ? s.Role! : PmStakeholderRole.Other,
                Power = s.Power == PmStakeholderAxis.High ? PmStakeholderAxis.High : PmStakeholderAxis.Low,
                Interest = s.Interest == PmStakeholderAxis.High ? PmStakeholderAxis.High : PmStakeholderAxis.Low,
            });
        }

        var update = Builders<PmProject>.Update.Set(p => p.Stakeholders, stakeholders).Set(p => p.UpdatedAt, DateTime.UtcNow);
        // 干系人变更后，进行中的评价轮失效（参评人集合已变），强制重新发起以保持一致
        if (project.EvaluationRound?.Status == PmEvaluationRoundStatus.Collecting)
            update = update.Set(p => p.EvaluationRound, (PmEvaluationRound?)null);

        await _db.PmProjects.UpdateOneAsync(p => p.Id == projectId, update);
        return Ok(ApiResponse<object>.Ok(new { stakeholders }));
    }

    /// <summary>发起结案评价（仅 owner/leader）：按当前干系人快照生成一轮待评分</summary>
    [HttpPost("projects/{projectId}/evaluation/start")]
    public async Task<IActionResult> StartEvaluation(string projectId)
    {
        var userId = GetUserId();
        var project = await FindAccessibleProjectAsync(projectId, userId);
        if (project == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "项目不存在或无权访问"));
        // 结案评价由项目经理发起
        if (project.LeaderId != userId)
            return StatusCode(StatusCodes.Status403Forbidden, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "结案评价仅项目经理可发起"));
        // 必须过了项目计划结束时间
        if (project.PlannedEndAt == null)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请先设置项目计划结束时间，到期后再发起结案评价"));
        if (DateTime.UtcNow < project.PlannedEndAt.Value)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, $"未到项目计划结束时间（{project.PlannedEndAt.Value:yyyy-MM-dd}），暂不能发起结案评价"));
        if (project.Stakeholders.Count == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请先维护项目干系人，再发起评价"));

        var actorName = (await _db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync())?.DisplayName;
        var round = new PmEvaluationRound
        {
            Status = PmEvaluationRoundStatus.Collecting,
            InitiatedBy = userId,
            InitiatedByName = actorName,
            Participants = project.Stakeholders.Select(s => new PmEvaluationParticipant
            {
                StakeholderId = s.Id, UserId = s.UserId, Name = s.Name, Role = s.Role,
                IsRepresentative = s.IsRepresentative, Note = s.Note,
            }).ToList(),
        };

        await _db.PmProjects.UpdateOneAsync(p => p.Id == projectId,
            Builders<PmProject>.Update.Set(p => p.EvaluationRound, round).Set(p => p.UpdatedAt, DateTime.UtcNow));
        return Ok(ApiResponse<object>.Ok(new { round }));
    }

    /// <summary>提交一位参评人的打分（仅本人；无账号的历史外部项由 owner/leader 代录）</summary>
    [HttpPost("projects/{projectId}/evaluation/score")]
    public async Task<IActionResult> SubmitScore(string projectId, [FromBody] SubmitScoreRequest request)
    {
        var userId = GetUserId();
        var project = await FindAccessibleProjectAsync(projectId, userId);
        if (project == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "项目不存在或无权访问"));
        var round = project.EvaluationRound;
        if (round == null || round.Status != PmEvaluationRoundStatus.Collecting)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "当前没有进行中的评价"));

        var p = round.Participants.FirstOrDefault(x => x.StakeholderId == request.StakeholderId);
        if (p == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "参评人不存在"));

        var isOwner = project.OwnerId == userId || project.LeaderId == userId;
        // 干系人均为 MAP 用户，只能本人打分；历史无账号参评项由 owner/leader 代录兜底
        if (p.UserId == null) { if (!isOwner) return StatusCode(StatusCodes.Status403Forbidden, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "该参评人需由立项人代录")); }
        else if (p.UserId != userId) return StatusCode(StatusCodes.Status403Forbidden, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "只能提交属于自己的评分"));

        p.Score = Math.Clamp(request.Score, 0, 10);
        p.ScoredAt = DateTime.UtcNow;
        p.ScoredBy = userId;

        await _db.PmProjects.UpdateOneAsync(p2 => p2.Id == projectId,
            Builders<PmProject>.Update.Set(p2 => p2.EvaluationRound, round).Set(p2 => p2.UpdatedAt, DateTime.UtcNow));
        var scoredCount = round.Participants.Count(x => x.Score.HasValue);
        return Ok(ApiResponse<object>.Ok(new { scored = scoredCount, total = round.Participants.Count }));
    }

    /// <summary>汇总评价（仅 owner/leader，需全部评完）：加权计算 NPSS → 落库 + 推进生命周期</summary>
    [HttpPost("projects/{projectId}/evaluation/finalize")]
    public async Task<IActionResult> FinalizeEvaluation(string projectId)
    {
        var userId = GetUserId();
        var project = await FindAccessibleProjectAsync(projectId, userId);
        if (project == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "项目不存在或无权访问"));
        if (project.OwnerId != userId && project.LeaderId != userId)
            return StatusCode(StatusCodes.Status403Forbidden, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "仅立项人或负责人可汇总评价"));
        var round = project.EvaluationRound;
        if (round == null || round.Status != PmEvaluationRoundStatus.Collecting)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "当前没有进行中的评价"));
        var pending = round.Participants.Count(x => !x.Score.HasValue);
        if (pending > 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, $"还有 {pending} 位干系人未评分，无法汇总"));

        var evaluation = ComputeNpss(round.Participants, userId);
        round.Status = PmEvaluationRoundStatus.Finalized;
        round.FinalizedAt = DateTime.UtcNow;
        round.Result = evaluation;

        await _db.PmProjects.UpdateOneAsync(p => p.Id == projectId,
            Builders<PmProject>.Update
                .Set(p => p.EvaluationRound, round)
                .Set(p => p.Evaluation, evaluation)
                .Set(p => p.Lifecycle, PmProjectLifecycle.Evaluated)
                .Set(p => p.ClosedAt, project.ClosedAt ?? DateTime.UtcNow)
                .Set(p => p.UpdatedAt, DateTime.UtcNow));

        _logger.LogInformation("[pm-agent] Project evaluation finalized: {ProjectId} satisfaction={Score} grade={Grade}",
            projectId, evaluation.SatisfactionScore, evaluation.Grade);
        return Ok(ApiResponse<object>.Ok(new { round }));
    }

    /// <summary>
    /// NPSS 加权满意度计算：按角色组求平均 → 角色权重重归一化（受益方为其他 2 倍）→ 加权汇总。
    /// </summary>
    private static PmEvaluation ComputeNpss(List<PmEvaluationParticipant> participants, string finalizedBy)
    {
        var scored = participants.Where(p => p.Score.HasValue).ToList();
        var roleAverages = scored
            .GroupBy(s => s.Role)
            .ToDictionary(g => g.Key, g => g.Average(s => (double)s.Score!.Value));

        var presentWeightSum = roleAverages.Keys.Sum(r => PmStakeholderRole.BaseWeights.GetValueOrDefault(r, 0.1));
        if (presentWeightSum <= 0) presentWeightSum = 1;

        var weighted10 = roleAverages.Sum(kv =>
            kv.Value * (PmStakeholderRole.BaseWeights.GetValueOrDefault(kv.Key, 0.1) / presentWeightSum));

        return new PmEvaluation
        {
            SatisfactionScore = Math.Round(weighted10 * 10, 1),
            Grade = PmEvaluationGrade.FromScore10(weighted10),
            RoleAverages = roleAverages.ToDictionary(kv => kv.Key, kv => Math.Round(kv.Value, 1)),
            EvaluatedAt = DateTime.UtcNow,
            EvaluatedBy = finalizedBy,
        };
    }

    // ─────────────────────────────────────────────
    // 组织级 NPSS 仪表盘 + 奖金（Phase 3）
    // ─────────────────────────────────────────────

    /// <summary>
    /// 组织级 NPSS 仪表盘（支持财年盘点）：NPSS（成功占比−失败占比）+ 奖金测算 + 等级分布
    /// + 财年/季度盘点 + 优秀项目 + 成本侧进度留痕（按时交付率 / 预算控制率）。
    /// </summary>
    [HttpGet("dashboard")]
    public async Task<IActionResult> Dashboard([FromQuery] int? fiscalYear = null)
    {
        // 组织级经营看板仅对管理层开放（pm-agent.dashboard），与普通的 pm-agent.use 区分
        if (!HasPermission(AdminPermissionCatalog.PmAgentDashboard))
            return StatusCode(StatusCodes.Status403Forbidden, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "组织 NPSS 看板仅对管理层开放"));

        var cfg = await GetOrCreateRewardConfigAsync();
        var startMonth = Math.Clamp(cfg.FiscalYearStartMonth, 1, 12);

        // 公司级 NPSS 只统计正式分级项目（战略/创新/运营），普通项目不计入
        var all = await _db.PmProjects
            .Find(p => !p.IsDeleted && p.Evaluation != null && p.ProjectType != PmProjectType.General)
            .ToListAsync();

        // 每个项目归属的财年（按评价时间）
        var availableFiscalYears = all
            .Select(p => FiscalYearOf(p.Evaluation!.EvaluatedAt, startMonth))
            .Distinct().OrderByDescending(y => y).ToList();

        // 按财年筛选（未指定则全部）
        var scope = fiscalYear.HasValue
            ? all.Where(p => FiscalYearOf(p.Evaluation!.EvaluatedAt, startMonth) == fiscalYear.Value).ToList()
            : all;

        object BuildStats(List<PmProject> list)
        {
            var s = list.Count(p => p.Evaluation!.Grade == PmEvaluationGrade.Success);
            var m = list.Count(p => p.Evaluation!.Grade == PmEvaluationGrade.Mediocre);
            var f = list.Count(p => p.Evaluation!.Grade == PmEvaluationGrade.Fail);
            var t = list.Count;
            return new
            {
                totalEvaluated = t,
                successCount = s,
                mediocreCount = m,
                failCount = f,
                npss = t > 0 ? (int)Math.Round((s - f) * 100.0 / t) : 0,
                totalBonus = list.Sum(p => ComputeBonus(p, cfg)),
            };
        }

        var rows = scope
            .OrderByDescending(p => p.Evaluation!.EvaluatedAt)
            .Select(p => new
            {
                id = p.Id,
                projectNo = p.ProjectNo,
                title = p.Title,
                projectType = p.ProjectType,
                operationSubType = p.OperationSubType,
                grade = p.Evaluation!.Grade,
                satisfactionScore = p.Evaluation!.SatisfactionScore,
                valueCoefficient = p.ValueCoefficient,
                isExcellent = p.IsExcellent,
                bonus = ComputeBonus(p, cfg),
            })
            .ToList();

        // 季度盘点（仅在选定财年时有意义）
        var quarters = fiscalYear.HasValue
            ? Enumerable.Range(1, 4).Select(q =>
            {
                var qList = scope.Where(p => FiscalQuarterOf(p.Evaluation!.EvaluatedAt, startMonth) == q).ToList();
                return new { quarter = q, stats = BuildStats(qList) };
            }).ToList<object>()
            : new List<object>();

        // 成本侧进度留痕
        var withPlan = scope.Where(p => p.PlannedEndAt.HasValue && p.ClosedAt.HasValue).ToList();
        var onTime = withPlan.Count(p => p.ClosedAt!.Value <= p.PlannedEndAt!.Value);
        var withBudget = scope.Where(p => p.Budget.HasValue && p.Budget.Value > 0 && p.ActualCost.HasValue).ToList();
        var budgetOk = withBudget.Count(p => p.ActualCost!.Value <= p.Budget!.Value);

        var scopeSuccess = scope.Count(p => p.Evaluation!.Grade == PmEvaluationGrade.Success);
        var scopeMediocre = scope.Count(p => p.Evaluation!.Grade == PmEvaluationGrade.Mediocre);
        var scopeFail = scope.Count(p => p.Evaluation!.Grade == PmEvaluationGrade.Fail);
        var scopeNpss = scope.Count > 0 ? (int)Math.Round((scopeSuccess - scopeFail) * 100.0 / scope.Count) : 0;

        return Ok(ApiResponse<object>.Ok(new
        {
            // 兼容旧字段（前端总览直接用）
            totalEvaluated = scope.Count,
            successCount = scopeSuccess,
            mediocreCount = scopeMediocre,
            failCount = scopeFail,
            npss = scopeNpss,
            baseline = 36,
            totalBonus = rows.Sum(r => r.bonus),
            projects = rows,
            rewardConfig = cfg,
            // Phase 4
            fiscalYear,
            availableFiscalYears,
            quarters,
            excellentProjects = rows.Where(r => r.isExcellent).ToList(),
            costMetrics = new
            {
                onTimeRate = withPlan.Count > 0 ? (int)Math.Round(onTime * 100.0 / withPlan.Count) : -1,
                onTimeBase = withPlan.Count,
                budgetControlRate = withBudget.Count > 0 ? (int)Math.Round(budgetOk * 100.0 / withBudget.Count) : -1,
                budgetBase = withBudget.Count,
                totalBudget = scope.Sum(p => p.Budget ?? 0),
                totalActualCost = scope.Sum(p => p.ActualCost ?? 0),
            },
        }));
    }

    private static int FiscalYearOf(DateTime d, int startMonth) => d.Month >= startMonth ? d.Year : d.Year - 1;
    private static int FiscalQuarterOf(DateTime d, int startMonth) => (((d.Month - startMonth) % 12 + 12) % 12) / 3 + 1;

    /// <summary>评选 / 取消评选优秀项目</summary>
    [HttpPost("projects/{projectId}/excellence")]
    public async Task<IActionResult> ToggleExcellence(string projectId, [FromBody] ToggleExcellenceRequest request)
    {
        var userId = GetUserId();
        var project = await FindAccessibleProjectAsync(projectId, userId);
        if (project == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "项目不存在或无权访问"));

        var update = Builders<PmProject>.Update
            .Set(p => p.IsExcellent, request.IsExcellent)
            .Set(p => p.ExcellenceAwardedAt, request.IsExcellent ? DateTime.UtcNow : (DateTime?)null)
            .Set(p => p.UpdatedAt, DateTime.UtcNow);
        await _db.PmProjects.UpdateOneAsync(p => p.Id == projectId, update);
        return Ok(ApiResponse<object>.Ok(new { id = projectId, isExcellent = request.IsExcellent }));
    }

    /// <summary>获取奖金配置（PMO 细则）</summary>
    [HttpGet("reward-config")]
    public async Task<IActionResult> GetRewardConfig()
    {
        var cfg = await GetOrCreateRewardConfigAsync();
        return Ok(ApiResponse<object>.Ok(cfg));
    }

    /// <summary>更新奖金配置 + M.O.R.E 组织自评</summary>
    [HttpPut("reward-config")]
    public async Task<IActionResult> UpdateRewardConfig([FromBody] UpdateRewardConfigRequest request)
    {
        var cfg = await GetOrCreateRewardConfigAsync();
        if (request.GeneralBase.HasValue) cfg.GeneralBase = Math.Max(0, request.GeneralBase.Value);
        if (request.StrategicBase.HasValue) cfg.StrategicBase = Math.Max(0, request.StrategicBase.Value);
        if (request.InnovationBase.HasValue) cfg.InnovationBase = Math.Max(0, request.InnovationBase.Value);
        if (request.OperationRoutineBase.HasValue) cfg.OperationRoutineBase = Math.Max(0, request.OperationRoutineBase.Value);
        if (request.MoreVision.HasValue) cfg.MoreVision = Math.Clamp(request.MoreVision.Value, 0, 100);
        if (request.MoreOutcome.HasValue) cfg.MoreOutcome = Math.Clamp(request.MoreOutcome.Value, 0, 100);
        if (request.MoreRapid.HasValue) cfg.MoreRapid = Math.Clamp(request.MoreRapid.Value, 0, 100);
        if (request.MoreEmpowered.HasValue) cfg.MoreEmpowered = Math.Clamp(request.MoreEmpowered.Value, 0, 100);
        if (request.FiscalYearStartMonth.HasValue) cfg.FiscalYearStartMonth = Math.Clamp(request.FiscalYearStartMonth.Value, 1, 12);
        if (request.ExcellenceBonusBase.HasValue) cfg.ExcellenceBonusBase = Math.Max(0, request.ExcellenceBonusBase.Value);
        cfg.UpdatedAt = DateTime.UtcNow;

        await _db.PmRewardConfigs.ReplaceOneAsync(c => c.Id == cfg.Id, cfg, new ReplaceOptions { IsUpsert = true });
        return Ok(ApiResponse<object>.Ok(cfg));
    }

    /// <summary>项目奖金计算：基数 × 价值系数 × (满意度/100)；满意度&lt;60 或 定向整改/专项督办 → 0</summary>
    private static decimal ComputeBonus(PmProject p, PmRewardConfig cfg)
    {
        if (p.Evaluation == null) return 0;
        // 定向整改 / 专项督办无奖金
        if (p.ProjectType == PmProjectType.Operation &&
            (p.OperationSubType == PmOperationSubType.Rectification || p.OperationSubType == PmOperationSubType.Supervision))
            return 0;

        var satisfaction = p.Evaluation.SatisfactionScore; // 0-100
        if (satisfaction < 60) return 0;

        var baseAmount = p.ProjectType switch
        {
            PmProjectType.Strategic => cfg.StrategicBase,
            PmProjectType.Innovation => cfg.InnovationBase,
            PmProjectType.Operation => cfg.OperationRoutineBase,
            _ => cfg.GeneralBase,
        };
        // 优秀项目额外叠加优秀奖金基数
        if (p.IsExcellent) baseAmount += cfg.ExcellenceBonusBase;
        return Math.Round(baseAmount * (decimal)p.ValueCoefficient * (decimal)(satisfaction / 100.0), 2);
    }

    private async Task<PmRewardConfig> GetOrCreateRewardConfigAsync()
    {
        var cfg = await _db.PmRewardConfigs.Find(c => c.Id == "default").FirstOrDefaultAsync();
        if (cfg == null)
        {
            cfg = new PmRewardConfig();
            await _db.PmRewardConfigs.InsertOneAsync(cfg);
        }
        return cfg;
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
            MilestoneId = string.IsNullOrWhiteSpace(request.MilestoneId) ? null : request.MilestoneId,
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
            var assignee = await _db.Users.Find(u => u.UserId == request.AssigneeId).FirstOrDefaultAsync();
            update = update.Set(t => t.AssigneeName, assignee?.DisplayName);
        }
        if (request.EstimateDays.HasValue) update = update.Set(t => t.EstimateDays, request.EstimateDays);
        if (request.StartAt.HasValue) update = update.Set(t => t.StartAt, request.StartAt);
        if (request.DueAt.HasValue) update = update.Set(t => t.DueAt, request.DueAt);
        if (request.DependsOn != null) update = update.Set(t => t.DependsOn, request.DependsOn);
        if (request.Labels != null) update = update.Set(t => t.Labels, request.Labels);
        if (request.OrderKey.HasValue) update = update.Set(t => t.OrderKey, request.OrderKey.Value);
        // MilestoneId：空串=解除归属（置 null），非空=归属
        if (request.MilestoneId != null) update = update.Set(t => t.MilestoneId, string.IsNullOrWhiteSpace(request.MilestoneId) ? null : request.MilestoneId);

        await _db.PmTasks.UpdateOneAsync(t => t.Id == taskId, update);
        if (request.Status != null) await RecalcTaskCountAsync(task.ProjectId);

        // 变更留痕（仅记录关键字段）
        var changes = new List<PmTaskActivity>();
        if (request.Status != null && PmTaskStatus.All.Contains(request.Status) && request.Status != task.Status)
            changes.Add(BuildChange(task, userId, "status", task.Status, request.Status));
        if (request.Priority != null && PmTaskPriority.All.Contains(request.Priority) && request.Priority != task.Priority)
            changes.Add(BuildChange(task, userId, "priority", task.Priority, request.Priority));
        if (request.AssigneeId != null && request.AssigneeId != (task.AssigneeId ?? ""))
            changes.Add(BuildChange(task, userId, "assignee", task.AssigneeName ?? task.AssigneeId, request.AssigneeId));
        if (changes.Count > 0)
        {
            var actorName = (await _db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync())?.DisplayName;
            foreach (var c in changes) c.UserName = actorName;
            await _db.PmTaskActivities.InsertManyAsync(changes);
        }
        return Ok(ApiResponse<object>.Ok(new { updated = true }));
    }

    private static PmTaskActivity BuildChange(PmTask task, string userId, string field, string? from, string? to) => new()
    {
        TaskId = task.Id, ProjectId = task.ProjectId, Type = PmActivityType.Change,
        UserId = userId, Field = field, FromValue = from, ToValue = to,
    };

    /// <summary>任务活动记录（评论 + 变更日志）</summary>
    [HttpGet("tasks/{taskId}/activities")]
    public async Task<IActionResult> GetActivities(string taskId)
    {
        var userId = GetUserId();
        var task = await _db.PmTasks.Find(t => t.Id == taskId).FirstOrDefaultAsync();
        if (task == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "任务不存在"));
        if (await FindAccessibleProjectAsync(task.ProjectId, userId) == null)
            return StatusCode(StatusCodes.Status403Forbidden, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权操作"));

        var items = await _db.PmTaskActivities.Find(a => a.TaskId == taskId)
            .SortByDescending(a => a.CreatedAt).Limit(200).ToListAsync();
        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    /// <summary>发表任务评论</summary>
    [HttpPost("tasks/{taskId}/comments")]
    public async Task<IActionResult> AddComment(string taskId, [FromBody] AddCommentRequest request)
    {
        var userId = GetUserId();
        var task = await _db.PmTasks.Find(t => t.Id == taskId).FirstOrDefaultAsync();
        if (task == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "任务不存在"));
        if (await FindAccessibleProjectAsync(task.ProjectId, userId) == null)
            return StatusCode(StatusCodes.Status403Forbidden, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权操作"));
        if (string.IsNullOrWhiteSpace(request.Content))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "评论内容不能为空"));

        var actorName = (await _db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync())?.DisplayName;
        var activity = new PmTaskActivity
        {
            TaskId = taskId, ProjectId = task.ProjectId, Type = PmActivityType.Comment,
            UserId = userId, UserName = actorName, Content = request.Content.Trim(),
        };
        await _db.PmTaskActivities.InsertOneAsync(activity);

        // @ 提醒：为每个被提及的用户写一条站内通知（复用 admin_notifications 通知中心）
        await NotifyMentionsAsync(request.MentionedUserIds, userId, actorName, task, activity.Content ?? "");

        return Ok(ApiResponse<object>.Ok(activity));
    }

    /// <summary>评论 @ 提醒：给被提及用户各写一条站内通知。失败不影响评论本身。</summary>
    private async Task NotifyMentionsAsync(List<string>? mentionedUserIds, string actorId, string? actorName, PmTask task, string comment)
    {
        try
        {
            var targets = (mentionedUserIds ?? new()).Where(x => !string.IsNullOrWhiteSpace(x) && x != actorId).Distinct().ToList();
            if (targets.Count == 0) return;
            // 只通知确属本项目成员/经理/创建人的用户，防止越权 @
            var project = await _db.PmProjects.Find(p => p.Id == task.ProjectId).FirstOrDefaultAsync();
            if (project == null) return;
            var allowed = project.MemberIds.Append(project.LeaderId).Append(project.OwnerId)
                .Where(x => !string.IsNullOrWhiteSpace(x)).ToHashSet();
            targets = targets.Where(allowed.Contains).ToList();
            if (targets.Count == 0) return;

            var who = string.IsNullOrWhiteSpace(actorName) ? "有人" : actorName;
            var excerpt = comment.Length > 80 ? comment[..80] + "…" : comment;
            var now = DateTime.UtcNow;
            var notifications = targets.Select(uid => new AdminNotification
            {
                Key = $"pm-mention:{task.Id}:{actorId}:{now.Ticks}:{uid}",
                TargetUserId = uid,
                Title = $"{who} 在任务「{task.Title}」中提到了你",
                Message = excerpt,
                Level = "info",
                Source = "pm-agent",
                ActionLabel = "查看任务",
                ActionUrl = "/pm-agent",
                ActionKind = "navigate",
            }).ToList();
            await _db.AdminNotifications.InsertManyAsync(notifications, cancellationToken: CancellationToken.None);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[pm-agent] 写 @ 提醒通知失败 task={TaskId}", task.Id);
        }
    }

    /// <summary>批量操作任务（改状态/优先级/负责人 或 删除）</summary>
    [HttpPost("projects/{projectId}/tasks/bulk")]
    public async Task<IActionResult> BulkTasks(string projectId, [FromBody] BulkTasksRequest request)
    {
        var userId = GetUserId();
        if (await FindAccessibleProjectAsync(projectId, userId) == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "项目不存在或无权访问"));
        var ids = (request.TaskIds ?? new()).Distinct().ToList();
        if (ids.Count == 0) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "未选择任务"));

        var filter = Builders<PmTask>.Filter.And(
            Builders<PmTask>.Filter.Eq(t => t.ProjectId, projectId),
            Builders<PmTask>.Filter.In(t => t.Id, ids));

        if (request.Delete == true)
        {
            var del = await _db.PmTasks.DeleteManyAsync(filter);
            await RecalcTaskCountAsync(projectId);
            return Ok(ApiResponse<object>.Ok(new { deletedCount = del.DeletedCount }));
        }

        var update = Builders<PmTask>.Update.Set(t => t.UpdatedAt, DateTime.UtcNow);
        var touched = false;
        if (request.Status != null && PmTaskStatus.All.Contains(request.Status)) { update = update.Set(t => t.Status, request.Status); touched = true; }
        if (request.Priority != null && PmTaskPriority.All.Contains(request.Priority)) { update = update.Set(t => t.Priority, request.Priority); touched = true; }
        if (request.AssigneeId != null)
        {
            var assignee = await _db.Users.Find(u => u.UserId == request.AssigneeId).FirstOrDefaultAsync();
            update = update.Set(t => t.AssigneeId, request.AssigneeId).Set(t => t.AssigneeName, assignee?.DisplayName);
            touched = true;
        }
        if (!touched) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "无有效变更"));

        var res = await _db.PmTasks.UpdateManyAsync(filter, update);
        if (request.Status != null) await RecalcTaskCountAsync(projectId);
        return Ok(ApiResponse<object>.Ok(new { matched = res.MatchedCount, modified = res.ModifiedCount }));
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

    /// <summary>AI 依据业务目标拆解目标/关键结果（SSE 流式，仅 owner/leader）</summary>
    [HttpPost("projects/{projectId}/goals/decompose")]
    [Produces("text/event-stream")]
    public async Task GoalDecompose(string projectId)
    {
        var userId = GetUserId();
        var project = await FindAccessibleProjectAsync(projectId, userId);
        if (project == null) { Response.StatusCode = 404; return; }
        if (project.OwnerId != userId && project.LeaderId != userId) { Response.StatusCode = 403; return; }

        Response.ContentType = "text/event-stream; charset=utf-8";
        Response.Headers.CacheControl = "no-cache";
        await WriteSseEvent("stage", new { stage = "decomposing", message = "正在依据业务目标拆解目标/关键结果…" });

        string? llmError = null;
        var count = 0;
        await foreach (var draft in _pmService.DecomposeGoalsAsync(
            project, userId,
            onError: err => llmError = err,
            onContent: async text => await WriteSseEvent("typing", new { text }),
            onThinking: async text => await WriteSseEvent("thinking", new { text })))
        {
            count++;
            await WriteSseEvent("goal", draft);
            await WriteSseEvent("stage", new { stage = "drafting", message = $"已拆解 {count} 个目标…" });
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
            b.Or(
                b.Eq(p => p.OwnerId, userId),
                b.Eq(p => p.LeaderId, userId),
                b.AnyEq(p => p.MemberIds, userId),
                // 干系人(系统用户)可访问项目以提交自己的评分
                b.ElemMatch(p => p.Stakeholders, s => s.UserId == userId))
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
        var assignee = await _db.Users.Find(u => u.UserId == task.AssigneeId).FirstOrDefaultAsync();
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

public class SetMembersRequest
{
    public List<string> MemberIds { get; set; } = new();
}

public class UpdateKnowledgeFileRequest
{
    public string? FileName { get; set; }
    public string? Category { get; set; }
}

public class CreateDecisionRequest
{
    public string? Title { get; set; }
    public string? Content { get; set; }
    public string? Type { get; set; }
}

public class UpdateDecisionRequest
{
    public string? Title { get; set; }
    public string? Content { get; set; }
    public string? Type { get; set; }
    public long? OrderKey { get; set; }
}

public class WeeklyReportRequest
{
    public string? Title { get; set; }
    public string? Content { get; set; }
    public DateTime? WeekStart { get; set; }
}

public class MeetingRequest
{
    public string? Title { get; set; }
    public DateTime? MeetingAt { get; set; }
    public string? Location { get; set; }
    public List<string>? AttendeeIds { get; set; }
    public string? Content { get; set; }
}

public class GoalRequest
{
    public string? Scope { get; set; }
    public string? Title { get; set; }
    public string? Description { get; set; }
    public string? Metric { get; set; }
    public string? Period { get; set; }
    public int? Progress { get; set; }
    public string? ProgressMode { get; set; }
    public string? Status { get; set; }
    public long? OrderKey { get; set; }
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
    public decimal? ActualCost { get; set; }
    public double? ValueCoefficient { get; set; }
    public Dictionary<string, int>? WipLimits { get; set; }
    public List<string>? MemberIds { get; set; }
}

public class AddCommentRequest
{
    public string Content { get; set; } = string.Empty;
    /// <summary>被 @ 提醒的用户 UserId 列表（前端从项目成员中选取）</summary>
    public List<string>? MentionedUserIds { get; set; }
}

public class BulkTasksRequest
{
    public List<string> TaskIds { get; set; } = new();
    public bool? Delete { get; set; }
    public string? Status { get; set; }
    public string? Priority { get; set; }
    public string? AssigneeId { get; set; }
}

public class UpdateRewardConfigRequest
{
    public decimal? GeneralBase { get; set; }
    public decimal? StrategicBase { get; set; }
    public decimal? InnovationBase { get; set; }
    public decimal? OperationRoutineBase { get; set; }
    public int? MoreVision { get; set; }
    public int? MoreOutcome { get; set; }
    public int? MoreRapid { get; set; }
    public int? MoreEmpowered { get; set; }
    public int? FiscalYearStartMonth { get; set; }
    public decimal? ExcellenceBonusBase { get; set; }
}

public class ToggleExcellenceRequest
{
    public bool IsExcellent { get; set; }
}

public class CreatePmTaskRequest
{
    public string Title { get; set; } = string.Empty;
    public string? Description { get; set; }
    public string? ParentTaskId { get; set; }
    public string? MilestoneId { get; set; }
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
    /// <summary>所属里程碑：传空串=解除归属，非空=归属，null=不变</summary>
    public string? MilestoneId { get; set; }
}

public class MilestoneRequest
{
    public string? Title { get; set; }
    public string? Description { get; set; }
    public DateTime? DueAt { get; set; }
    public string? GoalId { get; set; }
    public string? Status { get; set; }
    public long? OrderKey { get; set; }
}

public class DecomposeRequest
{
    /// <summary>可选的需求文档/补充材料文本（零摩擦输入：粘贴/上传后传入）</summary>
    public string? RequirementText { get; set; }
}

public class SetStakeholdersRequest
{
    public List<StakeholderInput> Stakeholders { get; set; } = new();
}

public class StakeholderInput
{
    public string? Id { get; set; }
    public string? UserId { get; set; }
    public bool? IsRepresentative { get; set; }
    public string? Note { get; set; }
    public string? Role { get; set; }
    public string? Power { get; set; }
    public string? Interest { get; set; }
}

public class SubmitScoreRequest
{
    public string StakeholderId { get; set; } = string.Empty;
    public int Score { get; set; }
}
