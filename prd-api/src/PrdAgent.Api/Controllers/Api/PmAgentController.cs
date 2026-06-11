using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;
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
    private readonly ILlmGateway _gateway;
    private readonly ILogger<PmAgentController> _logger;

    public PmAgentController(
        MongoDbContext db,
        PmAgentService pmService,
        IAssetStorage assetStorage,
        IHostedSiteService hostedSites,
        ILlmGateway gateway,
        ILogger<PmAgentController> logger)
    {
        _db = db;
        _pmService = pmService;
        _assetStorage = assetStorage;
        _hostedSites = hostedSites;
        _gateway = gateway;
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

    /// <summary>创建项目（立项）</summary>
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

        // 访问范围（与 FindAccessibleProjectAsync 对齐：owner/leader/member/observer/stakeholder）
        var managed = b.Eq(p => p.LeaderId, userId);
        // 我相关的：我是成员/观察者/干系人，且我不是项目经理（排除「我管理的」避免两 Tab 重复）
        var related = b.And(
            b.Or(
                b.AnyEq(p => p.MemberIds, userId),
                b.AnyEq(p => p.ObserverIds, userId),
                b.ElemMatch(p => p.Stakeholders, s => s.UserId == userId)),
            b.Ne(p => p.LeaderId, userId));
        if (scope == "managed") conds.Add(managed);
        else if (scope == "related") conds.Add(related);
        else conds.Add(b.Or(
            b.Eq(p => p.OwnerId, userId), b.Eq(p => p.LeaderId, userId),
            b.AnyEq(p => p.MemberIds, userId), b.AnyEq(p => p.ObserverIds, userId),
            b.ElemMatch(p => p.Stakeholders, s => s.UserId == userId)));

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
        // 观察者：剔除与成员/Leader 重复的（互斥兜底，兼容历史脏数据）
        var observerIds = project.ObserverIds.Where(x => !string.IsNullOrWhiteSpace(x) && !memberIds.Contains(x)).Distinct().ToList();
        var observers = await ResolveMembersAsync(observerIds);
        return Ok(ApiResponse<object>.Ok(new { members, observers, leaderId = project.LeaderId, ownerId = project.OwnerId }));
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
        // 互斥：新成员从观察者列表中剔除
        var observers = project.ObserverIds.Where(x => !members.Contains(x)).Distinct().ToList();

        await _db.PmProjects.UpdateOneAsync(p => p.Id == projectId,
            Builders<PmProject>.Update.Set(p => p.MemberIds, members).Set(p => p.ObserverIds, observers).Set(p => p.UpdatedAt, DateTime.UtcNow));

        var resolved = await ResolveMembersAsync(members);
        return Ok(ApiResponse<object>.Ok(new { members = resolved, memberIds = members }));
    }

    /// <summary>整体替换项目观察者（拥有与成员一样的权限，主要是看）。仅 owner/leader 可改。与成员/Leader 互斥。</summary>
    [HttpPut("projects/{projectId}/observers")]
    public async Task<IActionResult> SetObservers(string projectId, [FromBody] SetObserversRequest request)
    {
        var userId = GetUserId();
        var project = await FindAccessibleProjectAsync(projectId, userId);
        if (project == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "项目不存在或无权访问"));
        if (project.OwnerId != userId && project.LeaderId != userId)
            return StatusCode(StatusCodes.Status403Forbidden, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "仅立项人或负责人可管理观察者"));

        // 成员（含 Leader）不能同时是观察者：互斥剔除
        var excluded = project.MemberIds.Append(project.LeaderId).Where(x => !string.IsNullOrWhiteSpace(x)).ToHashSet();
        var ids = (request.ObserverIds ?? new()).Where(x => !string.IsNullOrWhiteSpace(x) && !excluded.Contains(x)).Distinct().ToList();
        var valid = await _db.Users.Find(u => ids.Contains(u.UserId)).Project(u => u.UserId).ToListAsync();
        var observers = ids.Where(valid.Contains).ToList();

        await _db.PmProjects.UpdateOneAsync(p => p.Id == projectId,
            Builders<PmProject>.Update.Set(p => p.ObserverIds, observers).Set(p => p.UpdatedAt, DateTime.UtcNow));

        var resolved = await ResolveMembersAsync(observers);
        return Ok(ApiResponse<object>.Ok(new { observers = resolved, observerIds = observers }));
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

    /// <summary>
    /// 解析项目知识库绑定的 DocumentStore（find-or-create）。首次创建时把旧版平铺文件尽力迁移为条目。
    /// 之后前端复用 document-store 端点 + DocBrowser 渲染（文件夹/多格式/预览/标签全继承）。
    /// </summary>
    [HttpGet("projects/{projectId}/knowledge/store")]
    public async Task<IActionResult> GetKnowledgeStore(string projectId)
    {
        var userId = GetUserId();
        var project = await FindAccessibleProjectAsync(projectId, userId);
        if (project == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "项目不存在或无权访问"));

        var canWrite = project.OwnerId == userId || project.LeaderId == userId || project.MemberIds.Contains(userId);

        DocumentStore? store = null;
        if (!string.IsNullOrEmpty(project.KnowledgeStoreId))
            store = await _db.DocumentStores.Find(s => s.Id == project.KnowledgeStoreId).FirstOrDefaultAsync();

        if (store == null)
        {
            store = new DocumentStore
            {
                Name = $"{project.Title} · 知识库",
                OwnerId = project.OwnerId,
                AppKey = "pm-agent",
                PmProjectId = projectId,
            };
            await _db.DocumentStores.InsertOneAsync(store);
            await _db.PmProjects.UpdateOneAsync(p => p.Id == projectId,
                Builders<PmProject>.Update.Set(p => p.KnowledgeStoreId, store.Id));

            // 最大努力迁移：旧版 PmKnowledgeFile → DocumentEntry（Reference + metadata.sourceUrl，前端可预览/下载）
            try
            {
                var olds = await _db.PmKnowledgeFiles.Find(f => f.ProjectId == projectId).ToListAsync();
                if (olds.Count > 0)
                {
                    var entries = olds.Select(f => new DocumentEntry
                    {
                        StoreId = store.Id,
                        Title = f.FileName,
                        ContentType = f.ContentType,
                        FileSize = f.FileSize,
                        SourceType = DocumentSourceType.Reference,
                        Tags = (!string.IsNullOrWhiteSpace(f.Category) && f.Category != "未分类")
                            ? new List<string> { f.Category } : new List<string>(),
                        Metadata = new Dictionary<string, string> { ["sourceUrl"] = f.Url, ["legacy"] = "pm-knowledge" },
                        CreatedBy = f.UploaderId,
                        CreatedByName = f.UploaderName,
                        CreatedAt = f.CreatedAt,
                    }).ToList();
                    await _db.DocumentEntries.InsertManyAsync(entries);
                    await _db.DocumentStores.UpdateOneAsync(s => s.Id == store.Id,
                        Builders<DocumentStore>.Update.Set(s => s.DocumentCount, entries.Count));
                }
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[PmKnowledge] 旧文件迁移失败 projectId={ProjectId}", projectId);
            }
        }

        return Ok(ApiResponse<object>.Ok(new { storeId = store.Id, canWrite }));
    }

    /// <summary>聚合项目相关人员（创建人 + 负责人 + 成员 + 观察者）名下的托管站点（公开 + 私有均可见可访问，
    /// 站点文件按 URL 直达，Visibility 仅控制公开页是否列出），供项目空间内免门禁查看成员作品。</summary>
    [HttpGet("projects/{projectId}/member-sites")]
    public async Task<IActionResult> GetMemberSites(string projectId)
    {
        var userId = GetUserId();
        var project = await FindAccessibleProjectAsync(projectId, userId);
        if (project == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "项目不存在或无权访问"));

        var ownerIds = new List<string> { project.OwnerId, project.LeaderId };
        ownerIds.AddRange(project.MemberIds);
        ownerIds.AddRange(project.ObserverIds);
        var distinctIds = ownerIds.Where(id => !string.IsNullOrWhiteSpace(id)).Distinct().ToList();

        var nameMap = (await _db.Users.Find(u => distinctIds.Contains(u.UserId)).ToListAsync())
            .ToDictionary(u => u.UserId, u => u.DisplayName);

        var sites = new List<object>();
        foreach (var ownerId in distinctIds)
        {
            var hosted = await _hostedSites.ListAllByUserIdAsync(ownerId, 60, CancellationToken.None);
            foreach (var s in hosted)
            {
                sites.Add(new
                {
                    userId = ownerId,
                    userName = nameMap.TryGetValue(ownerId, out var n) ? n : "—",
                    siteId = s.Id,
                    title = s.Title,
                    url = s.SiteUrl,
                    visibility = s.Visibility,
                    coverImageUrl = s.CoverImageUrl,
                    viewCount = s.ViewCount,
                    tags = s.Tags,
                    updatedAt = s.UpdatedAt,
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
            RelatedGoalIds = request.RelatedGoalIds ?? new(),
            RelatedTaskIds = request.RelatedTaskIds ?? new(),
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
        if (request.RelatedGoalIds != null) update = update.Set(x => x.RelatedGoalIds, request.RelatedGoalIds);
        if (request.RelatedTaskIds != null) update = update.Set(x => x.RelatedTaskIds, request.RelatedTaskIds);

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
            RelatedGoalIds = request.RelatedGoalIds ?? new(),
            RelatedTaskIds = request.RelatedTaskIds ?? new(),
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
        if (request.RelatedGoalIds != null) update = update.Set(x => x.RelatedGoalIds, request.RelatedGoalIds);
        if (request.RelatedTaskIds != null) update = update.Set(x => x.RelatedTaskIds, request.RelatedTaskIds);
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

    // ── 从周报Agent 个人周报导入到项目周报（含数据权限校验）──

    /// <summary>
    /// 列出当前用户【可见范围内】的个人周报（report-agent），供项目周报导入选择。
    /// 可见性：自己的 + 作为 leader/deputy 团队的 + all_members 团队其他成员已提交的 + 全局 ReportAgentViewAll。
    /// </summary>
    [HttpGet("weekly-reports/importable")]
    public async Task<IActionResult> ListImportableWeeklyReports([FromQuery] int? weekYear, [FromQuery] int? weekNumber)
    {
        var userId = GetUserId();
        var b = Builders<WeeklyReport>.Filter;
        FilterDefinition<WeeklyReport> visFilter;
        if (HasPermission(AdminPermissionCatalog.ReportAgentViewAll))
        {
            visFilter = b.Empty;
        }
        else
        {
            var orVisible = new List<FilterDefinition<WeeklyReport>> { b.Eq(r => r.UserId, userId) };
            // 我作为 leader/deputy 的团队（含 ReportTeam.LeaderUserId）
            var mgrTeamIds = await _db.ReportTeamMembers
                .Find(m => m.UserId == userId && (m.Role == ReportTeamRole.Leader || m.Role == ReportTeamRole.Deputy))
                .Project(m => m.TeamId).ToListAsync();
            var leaderTeamIds = await _db.ReportTeams.Find(t => t.LeaderUserId == userId).Project(t => t.Id).ToListAsync();
            var allMgr = mgrTeamIds.Concat(leaderTeamIds).Distinct().ToList();
            if (allMgr.Count > 0) orVisible.Add(b.In(r => r.TeamId, allMgr));
            // all_members 团队（我是成员）→ 其他成员已提交/已审阅/已查看的
            var myTeamIds = await _db.ReportTeamMembers.Find(m => m.UserId == userId).Project(m => m.TeamId).ToListAsync();
            var allMemberTeams = await _db.ReportTeams
                .Find(t => myTeamIds.Contains(t.Id) && t.ReportVisibility == ReportVisibilityMode.AllMembers)
                .Project(t => t.Id).ToListAsync();
            if (allMemberTeams.Count > 0)
                orVisible.Add(b.And(
                    b.In(r => r.TeamId, allMemberTeams),
                    b.In(r => r.Status, new[] { WeeklyReportStatus.Submitted, WeeklyReportStatus.Reviewed, WeeklyReportStatus.Viewed })));
            visFilter = b.Or(orVisible);
        }

        var conds = new List<FilterDefinition<WeeklyReport>> { visFilter };
        if (weekYear.HasValue) conds.Add(b.Eq(r => r.WeekYear, weekYear.Value));
        if (weekNumber.HasValue) conds.Add(b.Eq(r => r.WeekNumber, weekNumber.Value));

        var reports = await _db.WeeklyReports.Find(b.And(conds))
            .SortByDescending(r => r.WeekYear).ThenByDescending(r => r.WeekNumber).ThenByDescending(r => r.UpdatedAt)
            .Limit(200).ToListAsync();
        var items = reports.Select(r => new
        {
            id = r.Id, userId = r.UserId, userName = r.UserName, teamId = r.TeamId, teamName = r.TeamName,
            weekYear = r.WeekYear, weekNumber = r.WeekNumber, status = r.Status,
            periodStart = r.PeriodStart, periodEnd = r.PeriodEnd,
            isMine = r.UserId == userId, sectionCount = r.Sections.Count,
        }).ToList();
        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    /// <summary>把一份个人周报快照导入为项目周报（服务端二次校验可见性，渲染为 Markdown）</summary>
    [HttpPost("projects/{projectId}/weekly-reports/import")]
    public async Task<IActionResult> ImportWeeklyReport(string projectId, [FromBody] ImportWeeklyReportRequest request)
    {
        var userId = GetUserId();
        var project = await FindAccessibleProjectAsync(projectId, userId);
        if (project == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "项目不存在或无权访问"));
        if (string.IsNullOrWhiteSpace(request.SourceReportId))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "缺少来源周报 ID"));

        var src = await _db.WeeklyReports.Find(r => r.Id == request.SourceReportId).FirstOrDefaultAsync();
        if (src == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "来源周报不存在"));
        if (!await CanViewPersonalWeeklyReportAsync(src, userId))
            return StatusCode(StatusCodes.Status403Forbidden, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权导入该周报（超出你的可见范围）"));

        var entity = new PmWeeklyReport
        {
            ProjectId = projectId,
            Title = $"{src.UserName ?? "成员"} · {src.WeekYear} 年第 {src.WeekNumber} 周",
            WeekStart = src.PeriodStart,
            Content = RenderWeeklyReportMarkdown(src),
            AuthorId = src.UserId,        // 归属原作者（真实工作产出人），SourceReportId 提供回溯
            AuthorName = src.UserName,
            SourceType = "report-agent",
            SourceReportId = src.Id,
            RelatedGoalIds = request.RelatedGoalIds ?? new(),
            RelatedTaskIds = request.RelatedTaskIds ?? new(),
        };
        await _db.PmWeeklyReports.InsertOneAsync(entity);
        return Ok(ApiResponse<object>.Ok(entity));
    }

    /// <summary>个人周报可见性判定（与 report-agent 规则一致），用于导入授权</summary>
    private async Task<bool> CanViewPersonalWeeklyReportAsync(WeeklyReport report, string userId)
    {
        if (report.UserId == userId) return true;
        if (HasPermission(AdminPermissionCatalog.ReportAgentViewAll)) return true;
        var isManager = await _db.ReportTeamMembers
            .Find(m => m.TeamId == report.TeamId && m.UserId == userId
                && (m.Role == ReportTeamRole.Leader || m.Role == ReportTeamRole.Deputy)).AnyAsync();
        if (isManager) return true;
        var team = await _db.ReportTeams.Find(t => t.Id == report.TeamId).FirstOrDefaultAsync();
        if (team == null) return false;
        if (team.LeaderUserId == userId) return true;
        if (team.ReportVisibility == ReportVisibilityMode.AllMembers
            && report.Status != WeeklyReportStatus.Draft && report.Status != WeeklyReportStatus.NotStarted)
        {
            return await _db.ReportTeamMembers.Find(m => m.TeamId == report.TeamId && m.UserId == userId).AnyAsync();
        }
        return false;
    }

    /// <summary>把个人周报的结构化章节渲染成 Markdown（## 章节标题 + 列表条目）</summary>
    private static string RenderWeeklyReportMarkdown(WeeklyReport r)
    {
        var sb = new System.Text.StringBuilder();
        foreach (var sec in r.Sections)
        {
            var title = sec.TemplateSection?.Title;
            if (!string.IsNullOrWhiteSpace(title)) sb.AppendLine($"## {title}").AppendLine();
            foreach (var item in sec.Items)
            {
                if (string.IsNullOrWhiteSpace(item.Content)) continue;
                sb.AppendLine($"- {item.Content.Trim()}");
            }
            sb.AppendLine();
        }
        return sb.ToString().Trim();
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

        // auto 模式进度：目标的任务池 =「直接挂的任务(GoalId==目标) ∪ 其里程碑下的任务」的完成率
        var milestones = await _db.PmMilestones.Find(m => m.ProjectId == projectId).ToListAsync();
        var tasks = await _db.PmTasks.Find(t => t.ProjectId == projectId)
            .Project(t => new { t.MilestoneId, t.GoalId, t.Status }).ToListAsync();

        // 叶子目标 auto 进度：直接挂的任务 + 其里程碑下的任务，按完成率（排除已取消）
        int LeafTaskProgress(string goalId)
        {
            var goalMsIds = milestones.Where(m => m.GoalId == goalId).Select(m => m.Id).ToHashSet();
            var pool = tasks.Where(t => t.Status != PmTaskStatus.Cancelled
                && (t.GoalId == goalId || (t.MilestoneId != null && goalMsIds.Contains(t.MilestoneId)))).ToList();
            return pool.Count > 0 ? (int)Math.Round(pool.Count(t => t.Status == PmTaskStatus.Done) * 100.0 / pool.Count) : -1;
        }

        // 进度回退：有子目标→子目标 effective 均值（递归）；叶子 auto 模式→ KR 均值优先，无 KR 再→关联任务完成率；否则→手填/兜底
        var byId = goals.ToDictionary(g => g.Id);
        var childrenByParent = goals.Where(g => !string.IsNullOrEmpty(g.ParentId))
            .GroupBy(g => g.ParentId!)
            .ToDictionary(grp => grp.Key, grp => grp.ToList());
        var progressMemo = new Dictionary<string, int>();
        int EffectiveProgress(string goalId, HashSet<string> visited)
        {
            if (progressMemo.TryGetValue(goalId, out var cached)) return cached;
            if (!visited.Add(goalId)) return 0; // 防御循环引用
            if (!byId.TryGetValue(goalId, out var g)) { visited.Remove(goalId); return 0; }
            int result;
            var kids = childrenByParent.TryGetValue(goalId, out var cs) ? cs : null;
            if (kids is { Count: > 0 })
            {
                result = (int)Math.Round(kids.Average(c => EffectiveProgress(c.Id, visited)));
            }
            else if (g.ProgressMode == PmGoalProgressMode.Auto)
            {
                if (g.KeyResults.Count > 0)
                    result = (int)Math.Round(g.KeyResults.Average(k => k.ComputeProgress()));
                else
                {
                    var taskProg = LeafTaskProgress(g.Id);
                    result = taskProg >= 0 ? taskProg : g.Progress;
                }
            }
            else
            {
                result = g.Progress;
            }
            visited.Remove(goalId);
            progressMemo[goalId] = result;
            return result;
        }

        var items = goals.Select(g =>
        {
            var linked = milestones.Where(m => m.GoalId == g.Id).ToList();
            var effective = EffectiveProgress(g.Id, new HashSet<string>());
            var childCount = childrenByParent.TryGetValue(g.Id, out var cs2) ? cs2.Count : 0;
            return new
            {
                id = g.Id, projectId = g.ProjectId, scope = g.Scope, ownerId = g.OwnerId,
                parentId = g.ParentId, depth = g.Depth, childCount,
                title = g.Title, description = g.Description, metric = g.Metric, period = g.Period, cycleId = g.CycleId,
                keyResults = g.KeyResults, keyResultCount = g.KeyResults.Count,
                leadId = g.LeadId, leadName = g.LeadName, confidence = g.Confidence,
                score = g.Score, scoreNote = g.ScoreNote, scoredAt = g.ScoredAt, scoredByName = g.ScoredByName,
                progress = effective, progressMode = g.ProgressMode, linkedMilestoneCount = linked.Count,
                isMilestone = linked.Any(m => m.AutoFromGoal),
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

        // 子目标：加载父目标，强制继承 Scope，校验深度上限（ParentId 一经创建不可改，从根杜绝循环引用）
        PmGoal? parent = null;
        if (!string.IsNullOrWhiteSpace(request.ParentId))
        {
            parent = await _db.PmGoals.Find(x => x.Id == request.ParentId && x.ProjectId == projectId).FirstOrDefaultAsync();
            if (parent == null)
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "父目标不存在"));
            scope = parent.Scope; // 不信任前端传入的 scope，强制继承父
            if (parent.Depth + 1 >= PmGoal.MaxGoalDepth)
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, $"目标拆解层级已达上限（最多 {PmGoal.MaxGoalDepth} 层）"));
        }

        // 权限按（继承后的）scope 判定
        if (scope == PmGoalScope.Team && project.OwnerId != userId && project.LeaderId != userId)
            return StatusCode(StatusCodes.Status403Forbidden, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "团队目标仅立项人或负责人可创建"));
        if (scope == PmGoalScope.Personal && parent != null && parent.OwnerId != userId)
            return StatusCode(StatusCodes.Status403Forbidden, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "个人目标仅本人可拆解"));

        var creatorName = (await _db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync())?.DisplayName;
        var leadName = string.IsNullOrWhiteSpace(request.LeadId) ? null
            : (await _db.Users.Find(u => u.UserId == request.LeadId).FirstOrDefaultAsync())?.DisplayName;
        var entity = new PmGoal
        {
            ProjectId = projectId,
            Scope = scope,
            ParentId = parent?.Id,
            Depth = parent != null ? parent.Depth + 1 : 0,
            OwnerId = userId, // 个人目标=本人；团队目标记录创建人
            LeadId = string.IsNullOrWhiteSpace(request.LeadId) ? null : request.LeadId,
            LeadName = leadName,
            Title = request.Title!.Trim(),
            Description = request.Description?.Trim(),
            Metric = request.Metric?.Trim(),
            KeyResults = MapKeyResults(request.KeyResults),
            Period = request.Period?.Trim(),
            CycleId = string.IsNullOrWhiteSpace(request.CycleId) ? null : request.CycleId,
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
        if (request.CycleId != null) update = update.Set(x => x.CycleId, string.IsNullOrWhiteSpace(request.CycleId) ? null : request.CycleId);
        if (request.LeadId != null)
        {
            var lid = string.IsNullOrWhiteSpace(request.LeadId) ? null : request.LeadId;
            var lname = lid == null ? null : (await _db.Users.Find(u => u.UserId == lid).FirstOrDefaultAsync())?.DisplayName;
            update = update.Set(x => x.LeadId, lid).Set(x => x.LeadName, lname);
        }
        if (request.KeyResults != null) update = update.Set(x => x.KeyResults, MapKeyResults(request.KeyResults));
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

    /// <summary>把目标设为/取消里程碑：开 → 建一条联动里程碑(AutoFromGoal=true，GoalId 关联)；关 → 删除该联动里程碑。
    /// 团队/个人目标都支持（个人目标仅本人，团队目标 owner/leader）。</summary>
    [HttpPost("goals/{goalId}/milestone")]
    public async Task<IActionResult> ToggleGoalMilestone(string goalId, [FromBody] ToggleGoalMilestoneRequest request)
    {
        var userId = GetUserId();
        var g = await _db.PmGoals.Find(x => x.Id == goalId).FirstOrDefaultAsync();
        if (g == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "目标不存在"));
        var project = await FindAccessibleProjectAsync(g.ProjectId, userId);
        if (project == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "项目不存在或无权访问"));
        if (g.Scope == PmGoalScope.Personal && g.OwnerId != userId)
            return StatusCode(StatusCodes.Status403Forbidden, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "个人目标仅本人可操作"));
        if (g.Scope == PmGoalScope.Team && project.OwnerId != userId && project.LeaderId != userId)
            return StatusCode(StatusCodes.Status403Forbidden, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "团队目标仅立项人或负责人可操作"));

        var existing = await _db.PmMilestones.Find(m => m.GoalId == goalId && m.AutoFromGoal).FirstOrDefaultAsync();
        if (request.Enabled)
        {
            if (existing == null)
            {
                var creatorName = (await _db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync())?.DisplayName;
                await _db.PmMilestones.InsertOneAsync(new PmMilestone
                {
                    ProjectId = g.ProjectId,
                    Title = g.Title,
                    Description = g.Description,
                    GoalId = goalId,
                    OwnerId = g.LeadId,
                    OwnerName = g.LeadName,
                    AutoFromGoal = true,
                    Status = PmMilestoneStatus.Planned,
                    OrderKey = DateTime.UtcNow.Ticks,
                    CreatedBy = userId,
                    CreatedByName = creatorName,
                });
            }
            return Ok(ApiResponse<object>.Ok(new { isMilestone = true }));
        }
        await _db.PmMilestones.DeleteManyAsync(m => m.GoalId == goalId && m.AutoFromGoal);
        return Ok(ApiResponse<object>.Ok(new { isMilestone = false }));
    }

    /// <summary>调整目标层级（画布拖拽，Xmind 式）：把目标挂到新父目标下，或升为顶层(parentId 空)。
    /// 校验：同范围、不挂到自身/后代(防环)、调整后层级不超上限；级联更新整棵子树的 Depth。</summary>
    [HttpPost("goals/{goalId}/reparent")]
    public async Task<IActionResult> ReparentGoal(string goalId, [FromBody] ReparentGoalRequest request)
    {
        var userId = GetUserId();
        var g = await _db.PmGoals.Find(x => x.Id == goalId).FirstOrDefaultAsync();
        if (g == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "目标不存在"));
        var project = await FindAccessibleProjectAsync(g.ProjectId, userId);
        if (project == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "项目不存在或无权访问"));
        if (g.Scope == PmGoalScope.Personal && g.OwnerId != userId)
            return StatusCode(StatusCodes.Status403Forbidden, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "个人目标仅本人可调整"));
        if (g.Scope == PmGoalScope.Team && project.OwnerId != userId && project.LeaderId != userId)
            return StatusCode(StatusCodes.Status403Forbidden, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "团队目标仅立项人或负责人可调整"));

        var newParentId = string.IsNullOrWhiteSpace(request.ParentId) ? null : request.ParentId;
        if (newParentId == goalId)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "不能挂到自己下面"));
        if (newParentId == (g.ParentId ?? null))
            return Ok(ApiResponse<object>.Ok(new { updated = false })); // 没变化

        var all = await _db.PmGoals.Find(x => x.ProjectId == g.ProjectId).ToListAsync();
        var childrenByParent = all.GroupBy(x => x.ParentId ?? "").ToDictionary(x => x.Key, x => x.ToList());

        var newBaseDepth = 0;
        if (newParentId != null)
        {
            var parent = all.FirstOrDefault(x => x.Id == newParentId);
            if (parent == null) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "目标父级不存在"));
            if (parent.Scope != g.Scope)
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "仅可在同一范围（团队/个人）内调整层级"));
            // 防环：新父不能是本目标的后代
            var subtree = new HashSet<string>();
            var st = new Stack<string>(); st.Push(goalId);
            while (st.Count > 0) { var cur = st.Pop(); if (!subtree.Add(cur)) continue; if (childrenByParent.TryGetValue(cur, out var cs)) foreach (var c in cs) st.Push(c.Id); }
            if (subtree.Contains(newParentId))
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "不能挂到自己的子目标下（会形成循环）"));
            newBaseDepth = parent.Depth + 1;
        }

        // BFS 计算子树新深度并校验上限
        var newDepth = new Dictionary<string, int>();
        var q = new Queue<(string id, int depth)>(); q.Enqueue((goalId, newBaseDepth));
        while (q.Count > 0)
        {
            var (id, depth) = q.Dequeue();
            if (newDepth.ContainsKey(id)) continue;
            if (depth >= PmGoal.MaxGoalDepth)
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, $"调整后层级超过上限（最多 {PmGoal.MaxGoalDepth} 层）"));
            newDepth[id] = depth;
            if (childrenByParent.TryGetValue(id, out var cs)) foreach (var c in cs) q.Enqueue((c.Id, depth + 1));
        }

        var now = DateTime.UtcNow;
        foreach (var kv in newDepth)
        {
            if (kv.Key == goalId)
                await _db.PmGoals.UpdateOneAsync(x => x.Id == kv.Key,
                    Builders<PmGoal>.Update.Set(x => x.ParentId, newParentId).Set(x => x.Depth, kv.Value).Set(x => x.UpdatedAt, now));
            else
                await _db.PmGoals.UpdateOneAsync(x => x.Id == kv.Key,
                    Builders<PmGoal>.Update.Set(x => x.Depth, kv.Value).Set(x => x.UpdatedAt, now));
        }
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

        // 级联删除整棵子树（BFS，带计数上限自保防御循环引用）
        var siblings = await _db.PmGoals.Find(x => x.ProjectId == g.ProjectId)
            .Project(x => new { x.Id, x.ParentId }).ToListAsync();
        var childrenMap = siblings.Where(x => !string.IsNullOrEmpty(x.ParentId))
            .GroupBy(x => x.ParentId!).ToDictionary(grp => grp.Key, grp => grp.Select(x => x.Id).ToList());
        var toDelete = new HashSet<string>();
        var queue = new Queue<string>();
        queue.Enqueue(goalId);
        var guard = 0;
        while (queue.Count > 0 && guard++ < 10000)
        {
            var cur = queue.Dequeue();
            if (!toDelete.Add(cur)) continue;
            if (childrenMap.TryGetValue(cur, out var kids))
                foreach (var k in kids) queue.Enqueue(k);
        }
        await _db.PmGoals.DeleteManyAsync(x => toDelete.Contains(x.Id));
        await _db.PmGoalCheckIns.DeleteManyAsync(x => toDelete.Contains(x.GoalId));
        return Ok(ApiResponse<object>.Ok(new { deleted = true, count = toDelete.Count }));
    }

    /// <summary>目标进展 check-in 时间线（最新在前）。可见性同目标：个人目标仅本人。</summary>
    [HttpGet("goals/{goalId}/checkins")]
    public async Task<IActionResult> ListGoalCheckIns(string goalId)
    {
        var userId = GetUserId();
        var g = await _db.PmGoals.Find(x => x.Id == goalId).FirstOrDefaultAsync();
        if (g == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "目标不存在"));
        if (await FindAccessibleProjectAsync(g.ProjectId, userId) == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "项目不存在或无权访问"));
        if (g.Scope == PmGoalScope.Personal && g.OwnerId != userId)
            return StatusCode(StatusCodes.Status403Forbidden, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "个人目标仅本人可见"));

        var items = await _db.PmGoalCheckIns.Find(c => c.GoalId == goalId)
            .SortByDescending(c => c.CreatedAt).Limit(100).ToListAsync();
        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    /// <summary>提交一条目标进展 check-in（进度/信心/说明）。更新目标的最新信心，进度若填则同步到目标手填值。</summary>
    [HttpPost("goals/{goalId}/checkins")]
    public async Task<IActionResult> AddGoalCheckIn(string goalId, [FromBody] GoalCheckInRequest request)
    {
        var userId = GetUserId();
        var g = await _db.PmGoals.Find(x => x.Id == goalId).FirstOrDefaultAsync();
        if (g == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "目标不存在"));
        if (await FindAccessibleProjectAsync(g.ProjectId, userId) == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "项目不存在或无权访问"));
        if (g.Scope == PmGoalScope.Personal && g.OwnerId != userId)
            return StatusCode(StatusCodes.Status403Forbidden, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "个人目标仅本人可更新"));
        if (string.IsNullOrWhiteSpace(request.Note) && request.Progress == null && string.IsNullOrWhiteSpace(request.Confidence))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请至少填写进展说明、进度或信心之一"));
        if (request.Confidence != null && !PmGoalConfidence.IsValid(request.Confidence))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "无效的信心值"));

        var actorName = (await _db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync())?.DisplayName;
        var entity = new PmGoalCheckIn
        {
            GoalId = goalId,
            ProjectId = g.ProjectId,
            AuthorId = userId,
            AuthorName = actorName,
            Progress = request.Progress.HasValue ? Math.Clamp(request.Progress.Value, 0, 100) : null,
            Confidence = request.Confidence,
            Note = request.Note?.Trim() ?? string.Empty,
        };
        await _db.PmGoalCheckIns.InsertOneAsync(entity);

        // 冗余更新目标：最新信心 +（手填进度时）同步进度
        var gUpdate = Builders<PmGoal>.Update.Set(x => x.UpdatedAt, DateTime.UtcNow);
        if (!string.IsNullOrWhiteSpace(request.Confidence)) gUpdate = gUpdate.Set(x => x.Confidence, request.Confidence);
        if (entity.Progress.HasValue) gUpdate = gUpdate.Set(x => x.Progress, entity.Progress.Value);
        await _db.PmGoals.UpdateOneAsync(x => x.Id == goalId, gUpdate);

        return Ok(ApiResponse<object>.Ok(entity));
    }

    /// <summary>期末评分 / 复盘（OKR 0.0-1.0）。团队目标仅 owner/leader；个人目标仅本人。</summary>
    [HttpPost("goals/{goalId}/score")]
    public async Task<IActionResult> ScoreGoal(string goalId, [FromBody] GoalScoreRequest request)
    {
        var userId = GetUserId();
        var g = await _db.PmGoals.Find(x => x.Id == goalId).FirstOrDefaultAsync();
        if (g == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "目标不存在"));
        var project = await FindAccessibleProjectAsync(g.ProjectId, userId);
        if (project == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "项目不存在或无权访问"));
        if (g.Scope == PmGoalScope.Personal && g.OwnerId != userId)
            return StatusCode(StatusCodes.Status403Forbidden, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "个人目标仅本人可评分"));
        if (g.Scope == PmGoalScope.Team && project.OwnerId != userId && project.LeaderId != userId)
            return StatusCode(StatusCodes.Status403Forbidden, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "团队目标仅立项人或负责人可评分"));

        var actorName = (await _db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync())?.DisplayName;
        var update = Builders<PmGoal>.Update.Set(x => x.UpdatedAt, DateTime.UtcNow);
        if (request.Clear == true)
        {
            update = update.Set(x => x.Score, (double?)null).Set(x => x.ScoreNote, (string?)null)
                .Set(x => x.ScoredAt, (DateTime?)null).Set(x => x.ScoredByName, (string?)null);
        }
        else
        {
            if (request.Score == null) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请提供评分"));
            var score = Math.Clamp(request.Score.Value, 0, 1);
            update = update.Set(x => x.Score, score).Set(x => x.ScoreNote, request.Note?.Trim())
                .Set(x => x.ScoredAt, DateTime.UtcNow).Set(x => x.ScoredByName, actorName);
        }
        await _db.PmGoals.UpdateOneAsync(x => x.Id == goalId, update);
        return Ok(ApiResponse<object>.Ok(new { updated = true }));
    }

    // ── OKR 周期 ──

    /// <summary>项目 OKR 周期列表（按 OrderKey 倒序，新周期在前）</summary>
    [HttpGet("projects/{projectId}/goal-cycles")]
    public async Task<IActionResult> ListGoalCycles(string projectId)
    {
        var userId = GetUserId();
        if (await FindAccessibleProjectAsync(projectId, userId) == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "项目不存在或无权访问"));
        var items = await _db.PmGoalCycles.Find(c => c.ProjectId == projectId)
            .SortByDescending(c => c.OrderKey).ToListAsync();
        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    /// <summary>新建 OKR 周期（仅 owner/leader）</summary>
    [HttpPost("projects/{projectId}/goal-cycles")]
    public async Task<IActionResult> CreateGoalCycle(string projectId, [FromBody] GoalCycleRequest request)
    {
        var userId = GetUserId();
        var project = await FindAccessibleProjectAsync(projectId, userId);
        if (project == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "项目不存在或无权访问"));
        if (project.OwnerId != userId && project.LeaderId != userId)
            return StatusCode(StatusCodes.Status403Forbidden, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "仅立项人或负责人可管理周期"));
        if (string.IsNullOrWhiteSpace(request.Name))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "周期名称不能为空"));
        var creatorName = (await _db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync())?.DisplayName;
        var entity = new PmGoalCycle
        {
            ProjectId = projectId,
            Name = request.Name!.Trim(),
            StartAt = request.StartAt,
            EndAt = request.EndAt,
            Status = PmGoalCycleStatus.Active,
            OrderKey = DateTime.UtcNow.Ticks,
            CreatedBy = userId,
            CreatedByName = creatorName,
        };
        await _db.PmGoalCycles.InsertOneAsync(entity);
        return Ok(ApiResponse<object>.Ok(entity));
    }

    /// <summary>更新 OKR 周期（名称/起止/状态，仅 owner/leader）</summary>
    [HttpPut("goal-cycles/{cycleId}")]
    public async Task<IActionResult> UpdateGoalCycle(string cycleId, [FromBody] GoalCycleRequest request)
    {
        var userId = GetUserId();
        var c = await _db.PmGoalCycles.Find(x => x.Id == cycleId).FirstOrDefaultAsync();
        if (c == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "周期不存在"));
        var project = await FindAccessibleProjectAsync(c.ProjectId, userId);
        if (project == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "项目不存在或无权访问"));
        if (project.OwnerId != userId && project.LeaderId != userId)
            return StatusCode(StatusCodes.Status403Forbidden, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "仅立项人或负责人可管理周期"));

        var update = Builders<PmGoalCycle>.Update.Set(x => x.UpdatedAt, DateTime.UtcNow);
        if (request.Name != null)
        {
            if (string.IsNullOrWhiteSpace(request.Name)) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "周期名称不能为空"));
            update = update.Set(x => x.Name, request.Name.Trim());
        }
        if (request.StartAt.HasValue) update = update.Set(x => x.StartAt, request.StartAt);
        if (request.EndAt.HasValue) update = update.Set(x => x.EndAt, request.EndAt);
        if (request.Status != null)
        {
            if (!PmGoalCycleStatus.IsValid(request.Status))
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "无效的周期状态"));
            update = update.Set(x => x.Status, request.Status);
        }
        await _db.PmGoalCycles.UpdateOneAsync(x => x.Id == cycleId, update);
        return Ok(ApiResponse<object>.Ok(new { updated = true }));
    }

    /// <summary>删除 OKR 周期（仅 owner/leader）。不删目标，仅清空其下目标的 CycleId。</summary>
    [HttpDelete("goal-cycles/{cycleId}")]
    public async Task<IActionResult> DeleteGoalCycle(string cycleId)
    {
        var userId = GetUserId();
        var c = await _db.PmGoalCycles.Find(x => x.Id == cycleId).FirstOrDefaultAsync();
        if (c == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "周期不存在"));
        var project = await FindAccessibleProjectAsync(c.ProjectId, userId);
        if (project == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "项目不存在或无权访问"));
        if (project.OwnerId != userId && project.LeaderId != userId)
            return StatusCode(StatusCodes.Status403Forbidden, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "仅立项人或负责人可管理周期"));
        await _db.PmGoalCycles.DeleteOneAsync(x => x.Id == cycleId);
        await _db.PmGoals.UpdateManyAsync(g => g.CycleId == cycleId, Builders<PmGoal>.Update.Set(x => x.CycleId, (string?)null));
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

        // 前置门禁：未达成的前置里程碑 → 本里程碑受阻
        var titleById = milestones.ToDictionary(x => x.Id, x => x.Title);
        var reachedIds = milestones.Where(x => x.Status == PmMilestoneStatus.Reached).Select(x => x.Id).ToHashSet();

        var items = milestones.Select(m =>
        {
            var mine = tasks.Where(t => t.MilestoneId == m.Id && t.Status != PmTaskStatus.Cancelled).ToList();
            var total = mine.Count;
            var done = mine.Count(t => t.Status == PmTaskStatus.Done);
            var progress = total > 0 ? (int)Math.Round(done * 100.0 / total) : 0;
            // 计划 vs 实际偏差（slippage）：达成日 - 计划截止日（正=延期，负=提前），单位天
            int? slippageDays = (m.ReachedAt.HasValue && m.DueAt.HasValue)
                ? (int)Math.Round((m.ReachedAt.Value.Date - m.DueAt.Value.Date).TotalDays)
                : null;
            // 基线滑移：当前计划日 - 基线计划日（正=较初始计划推迟）
            int? driftDays = (m.BaselineDueAt.HasValue && m.DueAt.HasValue)
                ? (int)Math.Round((m.DueAt.Value.Date - m.BaselineDueAt.Value.Date).TotalDays)
                : null;
            var deps = m.DependsOn ?? new List<string>();
            var blockedByTitles = deps.Where(id => !reachedIds.Contains(id))
                .Select(id => titleById.GetValueOrDefault(id, "")).Where(t => t != "").ToList();
            var blocked = m.Status != PmMilestoneStatus.Reached && m.Status != PmMilestoneStatus.Cancelled && blockedByTitles.Count > 0;
            return new
            {
                id = m.Id,
                projectId = m.ProjectId,
                title = m.Title,
                description = m.Description,
                dueAt = m.DueAt,
                baselineDueAt = m.BaselineDueAt,
                driftDays,
                reachedAt = m.ReachedAt,
                goalId = m.GoalId,
                ownerId = m.OwnerId,
                ownerName = m.OwnerName,
                acceptanceCriteria = m.AcceptanceCriteria,
                criteriaTotal = m.AcceptanceCriteria.Count,
                criteriaDone = m.AcceptanceCriteria.Count(c => c.Done),
                dependsOn = deps,
                deliverables = m.Deliverables ?? new List<PmDeliverableRef>(),
                blocked,
                blockedBy = blockedByTitles,
                status = m.Status,
                orderKey = m.OrderKey,
                taskTotal = total,
                taskDone = done,
                progress,
                slippageDays,
                health = MilestoneHealth(m, total, done),
                createdAt = m.CreatedAt,
                updatedAt = m.UpdatedAt,
            };
        }).ToList();
        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    /// <summary>派生健康度（不存储）：reached/cancelled/overdue/at_risk/on_track。
    /// at_risk 采用前瞻判定：临近截止(≤3天) 或 进度落后于时间消耗(SPI&lt;0.85)，不必等逾期才报警。</summary>
    private static string MilestoneHealth(PmMilestone m, int total, int done)
    {
        if (m.Status == PmMilestoneStatus.Reached) return "reached";
        if (m.Status == PmMilestoneStatus.Cancelled) return "cancelled";
        // 有实际完成时间即视为已完成 —— 不再按"未完成"判逾期。
        // 早于/等于计划截止 = 按时达成；晚于计划截止仍算完成（滑移由 slippageDays 单独体现）。
        if (m.ReachedAt.HasValue) return "reached";
        var allDone = total > 0 && done >= total;
        var today = DateTime.UtcNow.Date;
        if (m.DueAt.HasValue && !allDone)
        {
            var due = m.DueAt.Value.Date;
            if (due < today) return "overdue";
            if (due <= today.AddDays(3)) return "at_risk";
            // 前瞻：进度% 落后于时间消耗%（SPI<0.85）即预警，给足补救窗口
            var spanDays = (due - m.CreatedAt.Date).TotalDays;
            if (spanDays > 0 && total > 0)
            {
                var elapsedFrac = Math.Min(1.0, Math.Max(0.0, (today - m.CreatedAt.Date).TotalDays / spanDays));
                var progressFrac = done / (double)total;
                if (elapsedFrac > 0.1 && progressFrac < elapsedFrac * 0.85) return "at_risk";
            }
        }
        return "on_track";
    }

    /// <summary>请求验收标准 → 模型条目；条目缺 Id 时补 Guid，文本空白的丢弃。</summary>
    private static List<PmMilestoneCriterion> MapCriteria(List<MilestoneCriterionInput>? input)
        => (input ?? new())
            .Where(c => !string.IsNullOrWhiteSpace(c.Text))
            .Select(c => new PmMilestoneCriterion
            {
                Id = string.IsNullOrWhiteSpace(c.Id) ? Guid.NewGuid().ToString("N") : c.Id!,
                Text = c.Text!.Trim(),
                Done = c.Done,
            })
            .ToList();

    /// <summary>请求 KR → 模型；标题空白的丢弃，缺 Id 补 Guid，type 归一。</summary>
    private static List<PmKeyResult> MapKeyResults(List<KeyResultInput>? input)
        => (input ?? new())
            .Where(k => !string.IsNullOrWhiteSpace(k.Title))
            .Select(k => new PmKeyResult
            {
                Id = string.IsNullOrWhiteSpace(k.Id) ? Guid.NewGuid().ToString("N") : k.Id!,
                Title = k.Title!.Trim(),
                Type = PmKeyResultType.IsValid(k.Type) ? k.Type! : PmKeyResultType.Percent,
                StartValue = k.StartValue ?? 0,
                TargetValue = k.TargetValue ?? 100,
                CurrentValue = k.CurrentValue ?? 0,
                Unit = string.IsNullOrWhiteSpace(k.Unit) ? null : k.Unit!.Trim(),
            })
            .ToList();

    /// <summary>请求交付物 → 模型；标题空白的丢弃，type 归一到 weekly/decision/link。</summary>
    private static List<PmDeliverableRef> MapDeliverables(List<DeliverableInput>? input)
        => (input ?? new())
            .Where(d => !string.IsNullOrWhiteSpace(d.Title))
            .Select(d => new PmDeliverableRef
            {
                Type = d.Type is "weekly" or "decision" or "link" ? d.Type! : "link",
                RefId = string.IsNullOrWhiteSpace(d.RefId) ? null : d.RefId,
                Title = d.Title!.Trim(),
                Url = string.IsNullOrWhiteSpace(d.Url) ? null : d.Url!.Trim(),
            })
            .ToList();

    /// <summary>把 milestoneId 的前置改为 newDeps 后，是否会形成循环依赖（DAG 守卫）。</summary>
    private static bool WouldCreateCycle(List<PmMilestone> all, string milestoneId, List<string> newDeps)
    {
        var deps = all.ToDictionary(x => x.Id, x => x.DependsOn ?? new List<string>());
        deps[milestoneId] = newDeps;
        // 从 milestoneId 沿 DependsOn 出发能否回到自身（路径≥1）→ 有环
        var visited = new HashSet<string>();
        bool ReachesSelf(string cur)
        {
            foreach (var d in deps.GetValueOrDefault(cur, new List<string>()))
            {
                if (d == milestoneId) return true;
                if (visited.Add(d) && ReachesSelf(d)) return true;
            }
            return false;
        }
        return ReachesSelf(milestoneId);
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
        var ownerName = string.IsNullOrWhiteSpace(request.OwnerId) ? null
            : (await _db.Users.Find(u => u.UserId == request.OwnerId).FirstOrDefaultAsync())?.DisplayName;
        var entity = new PmMilestone
        {
            ProjectId = projectId,
            Title = request.Title!.Trim(),
            Description = request.Description?.Trim(),
            DueAt = request.DueAt,
            BaselineDueAt = request.DueAt,   // 立项时的计划日 = 基线
            GoalId = string.IsNullOrWhiteSpace(request.GoalId) ? null : request.GoalId,
            OwnerId = string.IsNullOrWhiteSpace(request.OwnerId) ? null : request.OwnerId,
            OwnerName = ownerName,
            AcceptanceCriteria = MapCriteria(request.AcceptanceCriteria),
            Deliverables = MapDeliverables(request.Deliverables),
            Status = PmMilestoneStatus.Planned,
            OrderKey = DateTime.UtcNow.Ticks,
            CreatedBy = userId,
            CreatedByName = creatorName,
        };
        // 新建时也允许设前置（环检测：新里程碑还没 id，只需过滤掉自身/非法）
        if (request.DependsOn != null)
        {
            var validIds = (await _db.PmMilestones.Find(x => x.ProjectId == projectId).Project(x => x.Id).ToListAsync()).ToHashSet();
            entity.DependsOn = request.DependsOn.Where(id => validIds.Contains(id)).Distinct().ToList();
        }
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
        // 基线：显式重设 → 取当前计划日；旧数据(无基线)首次改期 → 回填为改前的计划日，以便后续展示滑移
        if (request.ResetBaseline == true)
            update = update.Set(x => x.BaselineDueAt, request.DueAt ?? m.DueAt);
        else if (request.DueAt.HasValue && m.BaselineDueAt == null)
            update = update.Set(x => x.BaselineDueAt, m.DueAt ?? request.DueAt);
        if (request.GoalId != null) update = update.Set(x => x.GoalId, string.IsNullOrWhiteSpace(request.GoalId) ? null : request.GoalId);
        if (request.OwnerId != null)
        {
            var oid = string.IsNullOrWhiteSpace(request.OwnerId) ? null : request.OwnerId;
            var oname = oid == null ? null : (await _db.Users.Find(u => u.UserId == oid).FirstOrDefaultAsync())?.DisplayName;
            update = update.Set(x => x.OwnerId, oid).Set(x => x.OwnerName, oname);
        }
        // 验收标准更新：以请求为准全量替换（保留传入的 Done 勾选）
        var effectiveCriteria = request.AcceptanceCriteria != null ? MapCriteria(request.AcceptanceCriteria) : m.AcceptanceCriteria;
        if (request.AcceptanceCriteria != null) update = update.Set(x => x.AcceptanceCriteria, effectiveCriteria);
        if (request.Deliverables != null) update = update.Set(x => x.Deliverables, MapDeliverables(request.Deliverables));

        // 前置里程碑更新（环检测：保持 DAG）
        var allForGraph = await _db.PmMilestones.Find(x => x.ProjectId == m.ProjectId).ToListAsync();
        var effectiveDeps = m.DependsOn;
        if (request.DependsOn != null)
        {
            var validIds = allForGraph.Select(x => x.Id).ToHashSet();
            effectiveDeps = request.DependsOn.Where(id => id != m.Id && validIds.Contains(id)).Distinct().ToList();
            if (WouldCreateCycle(allForGraph, m.Id, effectiveDeps))
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "前置里程碑会形成循环依赖，已拒绝"));
            update = update.Set(x => x.DependsOn, effectiveDeps);
        }

        if (request.OrderKey.HasValue) update = update.Set(x => x.OrderKey, request.OrderKey.Value);
        if (request.Status != null)
        {
            if (!PmMilestoneStatus.IsValid(request.Status))
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "无效的里程碑状态"));
            // 验收门禁：有验收标准且未全部勾选时，禁止标记达成（里程碑=被验收，不是到日期）
            if (request.Status == PmMilestoneStatus.Reached && m.Status != PmMilestoneStatus.Reached
                && effectiveCriteria.Count > 0 && effectiveCriteria.Any(c => !c.Done))
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT,
                    $"还有 {effectiveCriteria.Count(c => !c.Done)} 条验收标准未完成，无法标记达成"));
            // 依赖门禁：前置里程碑未全部达成时，禁止标记达成
            if (request.Status == PmMilestoneStatus.Reached && m.Status != PmMilestoneStatus.Reached && effectiveDeps.Count > 0)
            {
                var unreached = allForGraph.Where(x => effectiveDeps.Contains(x.Id) && x.Status != PmMilestoneStatus.Reached).ToList();
                if (unreached.Count > 0)
                    return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT,
                        $"前置里程碑「{string.Join("、", unreached.Take(3).Select(x => x.Title))}」尚未达成，无法标记达成"));
            }
            update = update.Set(x => x.Status, request.Status);
            if (request.Status == PmMilestoneStatus.Reached && m.Status != PmMilestoneStatus.Reached)
                update = update.Set(x => x.ReachedAt, DateTime.UtcNow);
            else if (request.Status != PmMilestoneStatus.Reached && m.Status == PmMilestoneStatus.Reached)
                update = update.Set(x => x.ReachedAt, (DateTime?)null);
        }
        // 实际完成时间（可补录，独立于状态切换）：显式设置优先于上面的状态联动
        if (request.ClearReachedAt == true)
            update = update.Set(x => x.ReachedAt, (DateTime?)null);
        else if (request.ReachedAt.HasValue)
            update = update.Set(x => x.ReachedAt, request.ReachedAt);
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
    // 风险登记册（概率×影响 + 应对策略 + 责任人）
    // ─────────────────────────────────────────────

    /// <summary>风险列表（项目成员可见，按概率×影响降序、OrderKey 兜底）</summary>
    [HttpGet("projects/{projectId}/risks")]
    public async Task<IActionResult> ListRisks(string projectId)
    {
        var userId = GetUserId();
        if (await FindAccessibleProjectAsync(projectId, userId) == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "项目不存在或无权访问"));
        var items = await _db.PmRisks.Find(r => r.ProjectId == projectId)
            .SortBy(r => r.OrderKey).ThenByDescending(r => r.CreatedAt).ToListAsync();
        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    /// <summary>新建风险（owner/leader/成员可建）</summary>
    [HttpPost("projects/{projectId}/risks")]
    public async Task<IActionResult> CreateRisk(string projectId, [FromBody] RiskRequest request)
    {
        var userId = GetUserId();
        var project = await FindAccessibleProjectAsync(projectId, userId);
        if (project == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "项目不存在或无权访问"));
        if (project.OwnerId != userId && project.LeaderId != userId && !project.MemberIds.Contains(userId))
            return StatusCode(StatusCodes.Status403Forbidden, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "仅项目成员可登记风险"));
        if (string.IsNullOrWhiteSpace(request.Title))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "风险标题不能为空"));

        var ownerName = string.IsNullOrWhiteSpace(request.OwnerId) ? null
            : (await _db.Users.Find(u => u.UserId == request.OwnerId).FirstOrDefaultAsync())?.DisplayName;
        var creatorName = (await _db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync())?.DisplayName;
        var entity = new PmRisk
        {
            ProjectId = projectId,
            Title = request.Title!.Trim(),
            Description = request.Description?.Trim(),
            Probability = PmRiskLevel.IsValid(request.Probability) ? request.Probability! : PmRiskLevel.Medium,
            Impact = PmRiskLevel.IsValid(request.Impact) ? request.Impact! : PmRiskLevel.Medium,
            Response = PmRiskResponse.IsValid(request.Response) ? request.Response! : PmRiskResponse.Open,
            Status = PmRiskStatus.IsValid(request.Status) ? request.Status! : PmRiskStatus.Open,
            OwnerId = string.IsNullOrWhiteSpace(request.OwnerId) ? null : request.OwnerId,
            OwnerName = ownerName,
            RelatedGoalId = string.IsNullOrWhiteSpace(request.RelatedGoalId) ? null : request.RelatedGoalId,
            RelatedTaskId = string.IsNullOrWhiteSpace(request.RelatedTaskId) ? null : request.RelatedTaskId,
            RelatedDecisionId = string.IsNullOrWhiteSpace(request.RelatedDecisionId) ? null : request.RelatedDecisionId,
            RelatedMilestoneId = string.IsNullOrWhiteSpace(request.RelatedMilestoneId) ? null : request.RelatedMilestoneId,
            OrderKey = DateTime.UtcNow.Ticks,
            CreatedBy = userId,
            CreatedByName = creatorName,
        };
        await _db.PmRisks.InsertOneAsync(entity);
        return Ok(ApiResponse<object>.Ok(entity));
    }

    /// <summary>更新风险（owner/leader/成员可改）</summary>
    [HttpPut("risks/{riskId}")]
    public async Task<IActionResult> UpdateRisk(string riskId, [FromBody] RiskRequest request)
    {
        var userId = GetUserId();
        var r = await _db.PmRisks.Find(x => x.Id == riskId).FirstOrDefaultAsync();
        if (r == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "风险不存在"));
        var project = await FindAccessibleProjectAsync(r.ProjectId, userId);
        if (project == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "项目不存在或无权访问"));
        if (project.OwnerId != userId && project.LeaderId != userId && !project.MemberIds.Contains(userId))
            return StatusCode(StatusCodes.Status403Forbidden, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "仅项目成员可修改风险"));

        var update = Builders<PmRisk>.Update.Set(x => x.UpdatedAt, DateTime.UtcNow);
        if (request.Title != null)
        {
            if (string.IsNullOrWhiteSpace(request.Title)) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "风险标题不能为空"));
            update = update.Set(x => x.Title, request.Title.Trim());
        }
        if (request.Description != null) update = update.Set(x => x.Description, request.Description.Trim());
        if (request.Probability != null && PmRiskLevel.IsValid(request.Probability)) update = update.Set(x => x.Probability, request.Probability);
        if (request.Impact != null && PmRiskLevel.IsValid(request.Impact)) update = update.Set(x => x.Impact, request.Impact);
        if (request.Response != null && PmRiskResponse.IsValid(request.Response)) update = update.Set(x => x.Response, request.Response);
        if (request.Status != null && PmRiskStatus.IsValid(request.Status)) update = update.Set(x => x.Status, request.Status);
        if (request.OwnerId != null)
        {
            var oid = string.IsNullOrWhiteSpace(request.OwnerId) ? null : request.OwnerId;
            var oname = oid == null ? null : (await _db.Users.Find(u => u.UserId == oid).FirstOrDefaultAsync())?.DisplayName;
            update = update.Set(x => x.OwnerId, oid).Set(x => x.OwnerName, oname);
        }
        if (request.RelatedGoalId != null) update = update.Set(x => x.RelatedGoalId, string.IsNullOrWhiteSpace(request.RelatedGoalId) ? null : request.RelatedGoalId);
        if (request.RelatedTaskId != null) update = update.Set(x => x.RelatedTaskId, string.IsNullOrWhiteSpace(request.RelatedTaskId) ? null : request.RelatedTaskId);
        if (request.RelatedDecisionId != null) update = update.Set(x => x.RelatedDecisionId, string.IsNullOrWhiteSpace(request.RelatedDecisionId) ? null : request.RelatedDecisionId);
        if (request.RelatedMilestoneId != null) update = update.Set(x => x.RelatedMilestoneId, string.IsNullOrWhiteSpace(request.RelatedMilestoneId) ? null : request.RelatedMilestoneId);
        if (request.OrderKey.HasValue) update = update.Set(x => x.OrderKey, request.OrderKey.Value);
        await _db.PmRisks.UpdateOneAsync(x => x.Id == riskId, update);
        return Ok(ApiResponse<object>.Ok(new { updated = true }));
    }

    /// <summary>删除风险（owner/leader/成员可删）</summary>
    [HttpDelete("risks/{riskId}")]
    public async Task<IActionResult> DeleteRisk(string riskId)
    {
        var userId = GetUserId();
        var r = await _db.PmRisks.Find(x => x.Id == riskId).FirstOrDefaultAsync();
        if (r == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "风险不存在"));
        var project = await FindAccessibleProjectAsync(r.ProjectId, userId);
        if (project == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "项目不存在或无权访问"));
        if (project.OwnerId != userId && project.LeaderId != userId && !project.MemberIds.Contains(userId))
            return StatusCode(StatusCodes.Status403Forbidden, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "仅项目成员可删除风险"));
        await _db.PmRisks.DeleteOneAsync(x => x.Id == riskId);
        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    /// <summary>
    /// 项目级燃尽 + 预算/挣值曲线报表（任意项目成员可看）。
    /// 燃尽：剩余任务数随时间下降 vs 理想线；挣值：计划价值(PV 线性)/挣值(EV=预算×完成率)/实际成本(AC 当前点)。
    /// 完成时间从 pm_task_activities(status→done) 重建，旧数据回退用任务 UpdatedAt。
    /// </summary>
    [HttpGet("projects/{projectId}/burndown")]
    public async Task<IActionResult> Burndown(string projectId)
    {
        var userId = GetUserId();
        var project = await FindAccessibleProjectAsync(projectId, userId);
        if (project == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "项目不存在或无权访问"));

        var tasks = await _db.PmTasks.Find(t => t.ProjectId == projectId).ToListAsync();
        var active = tasks.Where(t => t.Status != PmTaskStatus.Cancelled).ToList();
        var totalScope = active.Count;

        // 每个「当前为完成态」的任务的完成时间：优先取 status→done 的最后一次活动，回退任务 UpdatedAt
        var doneTasks = active.Where(t => t.Status == PmTaskStatus.Done).ToList();
        var doneIds = doneTasks.Select(t => t.Id).ToHashSet();
        var doneActs = await _db.PmTaskActivities.Find(a => a.ProjectId == projectId
            && a.Field == "status" && a.ToValue == PmTaskStatus.Done).ToListAsync();
        var doneAtByTask = new Dictionary<string, DateTime>();
        foreach (var a in doneActs.Where(a => doneIds.Contains(a.TaskId)))
            if (!doneAtByTask.TryGetValue(a.TaskId, out var cur) || a.CreatedAt > cur)
                doneAtByTask[a.TaskId] = a.CreatedAt;
        foreach (var t in doneTasks)
            if (!doneAtByTask.ContainsKey(t.Id)) doneAtByTask[t.Id] = t.UpdatedAt;
        var doneDates = doneAtByTask.Values.Select(d => d.Date).OrderBy(d => d).ToList();

        var today = DateTime.UtcNow.Date;
        var start = (project.PlannedStartAt?.Date)
            ?? (active.Count > 0 ? active.Min(t => t.CreatedAt).Date : project.CreatedAt.Date);
        var plannedEnd = (project.PlannedEndAt?.Date) ?? today;
        if (plannedEnd < start) plannedEnd = start;
        var end = today > plannedEnd ? today : plannedEnd;

        var totalDays = Math.Max(1, (int)(end - start).TotalDays);
        var step = Math.Max(1, (int)Math.Ceiling(totalDays / 30.0));
        var planSpanDays = Math.Max(1, (int)(plannedEnd - start).TotalDays);
        var budget = project.Budget.HasValue ? (double)project.Budget.Value : 0;
        var hasBudget = budget > 0;

        var createdDates = active.Select(t => t.CreatedAt.Date).OrderBy(d => d).ToList();
        var points = new List<object>();
        for (var d = start; ; d = d.AddDays(step))
        {
            if (d > end) d = end;
            var scope = createdDates.Count(c => c <= d);
            var done = doneDates.Count(dd => dd <= d);
            var remaining = scope - done;
            var elapsedFrac = Math.Min(1.0, Math.Max(0.0, (d - start).TotalDays / planSpanDays));
            var isFuture = d > today;
            points.Add(new
            {
                date = d.ToString("yyyy-MM-dd"),
                scope,
                done = isFuture ? (int?)null : done,
                remaining = isFuture ? (int?)null : remaining,
                ideal = (int)Math.Round(totalScope * (1 - elapsedFrac)),
                pv = hasBudget ? (int)Math.Round(budget * elapsedFrac) : (int?)null,
                ev = (hasBudget && totalScope > 0 && !isFuture) ? (int)Math.Round(budget * done / totalScope) : (int?)null,
            });
            if (d >= end) break;
        }

        var doneCount = doneTasks.Count;
        var completionRate = totalScope > 0 ? (int)Math.Round(doneCount * 100.0 / totalScope) : 0;
        var todayElapsedFrac = Math.Min(1.0, Math.Max(0.0, (today - start).TotalDays / planSpanDays));
        var spi = todayElapsedFrac > 0 && totalScope > 0
            ? Math.Round((doneCount / (double)totalScope) / todayElapsedFrac, 2) : (double?)null;

        return Ok(ApiResponse<object>.Ok(new
        {
            start = start.ToString("yyyy-MM-dd"),
            plannedEnd = plannedEnd.ToString("yyyy-MM-dd"),
            today = today.ToString("yyyy-MM-dd"),
            totalScope,
            doneCount,
            remaining = totalScope - doneCount,
            completionRate,
            overdue = today > plannedEnd,
            // 进度绩效指数 SPI：>1 超前、<1 落后（基于任务完成比 vs 时间消耗比）
            spi,
            budget = hasBudget ? budget : (double?)null,
            actualCost = project.ActualCost.HasValue ? (double)project.ActualCost.Value : (double?)null,
            // 挣值（当前）= 预算 × 完成率
            earnedValue = hasBudget ? (int)Math.Round(budget * completionRate / 100.0) : (int?)null,
            // 计划价值（当前）= 预算 × 时间消耗比
            plannedValue = hasBudget ? (int)Math.Round(budget * todayElapsedFrac) : (int?)null,
            points,
        }));
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
        // 已完成结案评价的项目不可重复发起
        if (project.Evaluation != null || project.EvaluationRound?.Status == PmEvaluationRoundStatus.Finalized)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "项目已完成结案评价，不能重复发起"));
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

        // ── 在管项目健康总览（PMO portfolio health）：统计 lifecycle=running 的项目 ──
        var running = await _db.PmProjects.Find(p => !p.IsDeleted && p.Lifecycle == PmProjectLifecycle.Running).ToListAsync();
        var nowUtc = DateTime.UtcNow;
        var runningIds = running.Select(p => p.Id).ToList();
        var overdueByProject = new Dictionary<string, int>();
        var highRiskByProject = new Dictionary<string, int>();
        if (runningIds.Count > 0)
        {
            var od = await _db.PmTasks.Find(t => runningIds.Contains(t.ProjectId) && t.DueAt < nowUtc
                && t.Status != PmTaskStatus.Done && t.Status != PmTaskStatus.Cancelled).Project(t => t.ProjectId).ToListAsync();
            foreach (var pid in od) overdueByProject[pid] = overdueByProject.GetValueOrDefault(pid) + 1;
            var hr = await _db.PmRisks.Find(r => runningIds.Contains(r.ProjectId)
                && r.Status != PmRiskStatus.Closed && r.Probability == PmRiskLevel.High && r.Impact == PmRiskLevel.High)
                .Project(r => r.ProjectId).ToListAsync();
            foreach (var pid in hr) highRiskByProject[pid] = highRiskByProject.GetValueOrDefault(pid) + 1;
        }
        var healthRows = running.Select(p =>
        {
            var overdue = overdueByProject.GetValueOrDefault(p.Id);
            var highRisk = highRiskByProject.GetValueOrDefault(p.Id);
            var progress = p.TaskCount > 0 ? p.DoneTaskCount * 100.0 / p.TaskCount : 0;
            var budgetUtil = (p.Budget.HasValue && p.Budget > 0) ? (double)(p.ActualCost ?? 0) / (double)p.Budget.Value * 100 : -1;
            var reasons = new List<string>();
            if (overdue > 0) reasons.Add($"{overdue} 个任务逾期");
            if (highRisk > 0) reasons.Add($"{highRisk} 个高风险");
            if (budgetUtil > 100) reasons.Add("超预算");
            if (p.TaskCount > 0 && progress < 50) reasons.Add("进度<50%");
            var health = (overdue > 0 || budgetUtil > 100 || highRisk > 0) ? "red"
                : ((p.TaskCount > 0 && progress < 50) || (budgetUtil >= 0 && budgetUtil > 80)) ? "yellow" : "green";
            return new
            {
                id = p.Id, projectNo = p.ProjectNo, title = p.Title, projectType = p.ProjectType,
                health, reason = string.Join("、", reasons),
                progress = (int)Math.Round(progress), taskCount = p.TaskCount, doneTaskCount = p.DoneTaskCount,
                overdueCount = overdue, highRiskCount = highRisk,
                budgetUtil = budgetUtil >= 0 ? (int)Math.Round(budgetUtil) : -1, leaderName = p.LeaderName,
            };
        }).OrderBy(r => r.health == "red" ? 0 : r.health == "yellow" ? 1 : 2)
          .ThenByDescending(r => r.overdueCount + r.highRiskCount).ToList();
        var portfolioHealth = new
        {
            activeCount = running.Count,
            redCount = healthRows.Count(r => r.health == "red"),
            yellowCount = healthRows.Count(r => r.health == "yellow"),
            greenCount = healthRows.Count(r => r.health == "green"),
            avgProgress = running.Count > 0 ? (int)Math.Round(healthRows.Average(r => r.progress)) : 0,
            projects = healthRows,
        };

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
            portfolioHealth,
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

        // 两级子任务约束：父任务必须存在、同项目，且自身不能已是子任务（否则会变三级）
        var parentId = string.IsNullOrWhiteSpace(request.ParentTaskId) ? null : request.ParentTaskId;
        if (parentId != null)
        {
            var parentErr = await ValidateParentForTwoLevelAsync(projectId, parentId, childId: null);
            if (parentErr != null)
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, parentErr));
        }

        var progress = ClampProgress(request.ProgressPercent ?? 0);
        var task = new PmTask
        {
            ProjectId = projectId,
            Title = request.Title.Trim(),
            Description = request.Description?.Trim(),
            ParentTaskId = parentId,
            MilestoneId = string.IsNullOrWhiteSpace(request.MilestoneId) ? null : request.MilestoneId,
            GoalId = string.IsNullOrWhiteSpace(request.GoalId) ? null : request.GoalId,
            Status = PmTaskStatus.All.Contains(request.Status ?? "") ? request.Status! : PmTaskStatus.Backlog,
            Priority = PmTaskPriority.All.Contains(request.Priority ?? "") ? request.Priority! : PmTaskPriority.None,
            AssigneeId = request.AssigneeId,
            EstimateDays = request.EstimateDays,
            StartAt = request.StartAt,
            DueAt = request.DueAt,
            DependsOn = request.DependsOn ?? new(),
            Labels = request.Labels ?? new(),
            OrderKey = request.OrderKey ?? DateTime.UtcNow.Ticks,
            ProgressPercent = progress,
            AutoProgress = request.ProgressPercent == null,
            CreatedBy = userId,
        };
        await FillAssigneeNameAsync(task);
        await _db.PmTasks.InsertOneAsync(task);
        // 新增子任务 → 父任务转自动汇总并重算进度
        if (parentId != null) await RecalcParentProgressAsync(parentId);
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
        // GoalId：空串=解除归属（置 null），非空=归属
        if (request.GoalId != null) update = update.Set(t => t.GoalId, string.IsNullOrWhiteSpace(request.GoalId) ? null : request.GoalId);

        // 手填进度 → 该任务转为手动进度（不再被自动汇总覆盖）
        var manualProgressSet = false;
        if (request.ProgressPercent.HasValue)
        {
            update = update.Set(t => t.ProgressPercent, ClampProgress(request.ProgressPercent.Value))
                           .Set(t => t.AutoProgress, false);
            manualProgressSet = true;
        }

        // 重设父任务（两级约束）：空串=升为顶层，非空=挂为子任务
        string? newParentId = null;
        var reparented = false;
        if (request.ParentTaskId != null)
        {
            newParentId = string.IsNullOrWhiteSpace(request.ParentTaskId) ? null : request.ParentTaskId;
            if (newParentId != (task.ParentTaskId ?? null))
            {
                if (newParentId != null)
                {
                    var parentErr = await ValidateParentForTwoLevelAsync(task.ProjectId, newParentId, childId: taskId);
                    if (parentErr != null)
                        return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, parentErr));
                }
                update = update.Set(t => t.ParentTaskId, newParentId);
                reparented = true;
            }
        }

        await _db.PmTasks.UpdateOneAsync(t => t.Id == taskId, update);
        if (request.Status != null) await RecalcTaskCountAsync(task.ProjectId);

        // 进度汇总：状态/进度/父子关系变化时，重算相关父任务
        if (request.Status != null || manualProgressSet)
        {
            if (task.ParentTaskId != null) await RecalcParentProgressAsync(task.ParentTaskId);
        }
        if (reparented)
        {
            if (task.ParentTaskId != null) await RecalcParentProgressAsync(task.ParentTaskId); // 旧父
            if (newParentId != null) await RecalcParentProgressAsync(newParentId);              // 新父
        }

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

    // ─────────────────────────────────────────────
    // 任务工作日志（处理人按天记录"做了什么、完成多少进度"，流水多条）
    // ─────────────────────────────────────────────

    /// <summary>列出某任务的工作日志（按日期 + 创建时间倒序）</summary>
    [HttpGet("tasks/{taskId}/work-logs")]
    public async Task<IActionResult> GetWorkLogs(string taskId)
    {
        var userId = GetUserId();
        var task = await _db.PmTasks.Find(t => t.Id == taskId).FirstOrDefaultAsync();
        if (task == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "任务不存在"));
        if (await FindAccessibleProjectAsync(task.ProjectId, userId) == null)
            return StatusCode(StatusCodes.Status403Forbidden, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权操作"));

        var items = await _db.PmTaskWorkLogs.Find(w => w.TaskId == taskId)
            .SortByDescending(w => w.Date).Limit(500).ToListAsync();
        items = items.OrderByDescending(w => w.Date).ThenByDescending(w => w.CreatedAt).ToList();
        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    /// <summary>新增一条工作日志（带进度时联动更新任务进度）</summary>
    [HttpPost("tasks/{taskId}/work-logs")]
    public async Task<IActionResult> CreateWorkLog(string taskId, [FromBody] CreateWorkLogRequest request)
    {
        var userId = GetUserId();
        var task = await _db.PmTasks.Find(t => t.Id == taskId).FirstOrDefaultAsync();
        if (task == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "任务不存在"));
        if (await FindAccessibleProjectAsync(task.ProjectId, userId) == null)
            return StatusCode(StatusCodes.Status403Forbidden, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权操作"));
        if (string.IsNullOrWhiteSpace(request.Content))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "工作内容不能为空"));

        var actorName = (await _db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync())?.DisplayName;
        var log = new PmTaskWorkLog
        {
            TaskId = taskId,
            ProjectId = task.ProjectId,
            UserId = userId,
            UserName = actorName,
            Date = (request.Date ?? DateTime.UtcNow).Date,
            Content = request.Content.Trim(),
            DurationMinutes = request.DurationMinutes,
            ProgressPercent = request.ProgressPercent.HasValue ? ClampProgress(request.ProgressPercent.Value) : null,
            Category = DailyLogCategory.All.Contains(request.Category ?? "") ? request.Category! : DailyLogCategory.Development,
        };
        await _db.PmTaskWorkLogs.InsertOneAsync(log);

        // 带进度 → 联动更新任务进度（仅叶子任务；父任务进度由子任务汇总，不被日志覆盖）
        if (request.ProgressPercent.HasValue)
        {
            var hasChildren = await _db.PmTasks.Find(t => t.ParentTaskId == taskId).AnyAsync();
            if (!hasChildren)
            {
                var p = ClampProgress(request.ProgressPercent.Value);
                await _db.PmTasks.UpdateOneAsync(t => t.Id == taskId,
                    Builders<PmTask>.Update
                        .Set(t => t.ProgressPercent, p)
                        .Set(t => t.AutoProgress, false)
                        .Set(t => t.UpdatedAt, DateTime.UtcNow));
                await _db.PmTaskActivities.InsertOneAsync(new PmTaskActivity
                {
                    TaskId = taskId, ProjectId = task.ProjectId, Type = PmActivityType.Change,
                    UserId = userId, UserName = actorName,
                    Field = "progress", FromValue = task.ProgressPercent.ToString(), ToValue = p.ToString(),
                });
                if (task.ParentTaskId != null) await RecalcParentProgressAsync(task.ParentTaskId);
            }
        }
        return Ok(ApiResponse<object>.Ok(log));
    }

    /// <summary>编辑工作日志（仅作者本人）</summary>
    [HttpPut("work-logs/{logId}")]
    public async Task<IActionResult> UpdateWorkLog(string logId, [FromBody] UpdateWorkLogRequest request)
    {
        var userId = GetUserId();
        var log = await _db.PmTaskWorkLogs.Find(w => w.Id == logId).FirstOrDefaultAsync();
        if (log == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "日志不存在"));
        if (log.UserId != userId)
            return StatusCode(StatusCodes.Status403Forbidden, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "只能编辑本人填写的日志"));

        var update = Builders<PmTaskWorkLog>.Update.Set(w => w.UpdatedAt, DateTime.UtcNow);
        if (request.Content != null) update = update.Set(w => w.Content, request.Content.Trim());
        if (request.Date.HasValue) update = update.Set(w => w.Date, request.Date.Value.Date);
        if (request.DurationMinutes.HasValue) update = update.Set(w => w.DurationMinutes, request.DurationMinutes);
        if (request.ProgressPercent.HasValue) update = update.Set(w => w.ProgressPercent, ClampProgress(request.ProgressPercent.Value));
        if (request.Category != null && DailyLogCategory.All.Contains(request.Category)) update = update.Set(w => w.Category, request.Category);
        await _db.PmTaskWorkLogs.UpdateOneAsync(w => w.Id == logId, update);
        return Ok(ApiResponse<object>.Ok(new { updated = true }));
    }

    /// <summary>删除工作日志（仅作者本人）</summary>
    [HttpDelete("work-logs/{logId}")]
    public async Task<IActionResult> DeleteWorkLog(string logId)
    {
        var userId = GetUserId();
        var log = await _db.PmTaskWorkLogs.Find(w => w.Id == logId).FirstOrDefaultAsync();
        if (log == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "日志不存在"));
        if (log.UserId != userId)
            return StatusCode(StatusCodes.Status403Forbidden, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "只能删除本人填写的日志"));
        await _db.PmTaskWorkLogs.DeleteOneAsync(w => w.Id == logId);
        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
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
        // 同时清理被删任务相关的工作日志
        await _db.PmTaskWorkLogs.DeleteManyAsync(w => toDelete.Contains(w.TaskId));
        // 删的是子任务 → 重算父任务进度
        if (task.ParentTaskId != null) await RecalcParentProgressAsync(task.ParentTaskId);
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

    /// <summary>
    /// AI 拆解目标（SSE 流式）。无 parentGoalId → 依据业务目标拆顶层团队 OKR（仅 owner/leader）；
    /// 有 parentGoalId → 把该目标拆为更具体的子目标，权限按父目标 scope 判定，子目标继承父 scope。
    /// </summary>
    [HttpPost("projects/{projectId}/goals/decompose")]
    [Produces("text/event-stream")]
    public async Task GoalDecompose(string projectId, [FromQuery] string? parentGoalId)
    {
        var userId = GetUserId();
        var project = await FindAccessibleProjectAsync(projectId, userId);
        if (project == null) { Response.StatusCode = 404; return; }

        PmGoal? parentGoal = null;
        var ancestorChain = new List<PmGoal>();
        var depthExceeded = false;
        if (string.IsNullOrWhiteSpace(parentGoalId))
        {
            // 项目级：拆顶层团队目标，仅 owner/leader
            if (project.OwnerId != userId && project.LeaderId != userId) { Response.StatusCode = 403; return; }
        }
        else
        {
            var allGoals = await _db.PmGoals.Find(x => x.ProjectId == projectId).ToListAsync();
            var byId = allGoals.ToDictionary(x => x.Id);
            if (!byId.TryGetValue(parentGoalId, out parentGoal)) { Response.StatusCode = 404; return; }
            // 权限按父目标 scope：team 要 owner/leader；personal 要本人
            if (parentGoal.Scope == PmGoalScope.Team)
            { if (project.OwnerId != userId && project.LeaderId != userId) { Response.StatusCode = 403; return; } }
            else
            { if (parentGoal.OwnerId != userId) { Response.StatusCode = 403; return; } }
            // 祖先链：从顶到父（不含父自身），带遍历上限防御循环引用
            var cur = parentGoal; var guard = 0; var chainRev = new List<PmGoal>();
            while (!string.IsNullOrEmpty(cur.ParentId) && byId.TryGetValue(cur.ParentId!, out var p) && guard++ < PmGoal.MaxGoalDepth)
            { chainRev.Add(p); cur = p; }
            chainRev.Reverse();
            ancestorChain = chainRev;
            depthExceeded = parentGoal.Depth + 1 >= PmGoal.MaxGoalDepth;
        }

        Response.ContentType = "text/event-stream; charset=utf-8";
        Response.Headers.CacheControl = "no-cache";

        if (depthExceeded)
        {
            await WriteSseEvent("error", new { message = $"目标拆解层级已达上限（最多 {PmGoal.MaxGoalDepth} 层）" });
            await WriteSseEvent("done", new { totalNew = 0, error = "层级已达上限" });
            return;
        }

        var stageMsg = parentGoal == null
            ? "正在依据业务目标拆解目标/关键结果…"
            : $"正在把「{parentGoal.Title}」拆解为更具体的子目标…";
        await WriteSseEvent("stage", new { stage = "decomposing", message = stageMsg });

        string? llmError = null;
        var count = 0;
        await foreach (var draft in _pmService.DecomposeGoalsAsync(
            project, parentGoal, ancestorChain, userId,
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

    /// <summary>AI 里程碑建议（SSE 流式，仅 owner/leader）。依据目标/任务/计划周期建议分阶段里程碑草稿。</summary>
    [HttpPost("projects/{projectId}/milestones/suggest")]
    [Produces("text/event-stream")]
    public async Task SuggestMilestones(string projectId)
    {
        var userId = GetUserId();
        var project = await FindAccessibleProjectAsync(projectId, userId);
        if (project == null) { Response.StatusCode = 404; return; }
        if (project.OwnerId != userId && project.LeaderId != userId) { Response.StatusCode = 403; return; }

        var goals = await _db.PmGoals.Find(g => g.ProjectId == projectId && g.Scope == PmGoalScope.Team).ToListAsync();
        var taskTitles = await _db.PmTasks.Find(t => t.ProjectId == projectId && t.Status != PmTaskStatus.Cancelled)
            .Project(t => t.Title).Limit(40).ToListAsync();

        Response.ContentType = "text/event-stream; charset=utf-8";
        Response.Headers.CacheControl = "no-cache";
        await WriteSseEvent("stage", new { stage = "suggesting", message = "正在依据目标/任务规划分阶段里程碑…" });

        string? llmError = null;
        var count = 0;
        await foreach (var draft in _pmService.SuggestMilestonesAsync(
            project, goals, taskTitles, userId,
            onError: err => llmError = err,
            onContent: async text => await WriteSseEvent("typing", new { text }),
            onThinking: async text => await WriteSseEvent("thinking", new { text })))
        {
            count++;
            await WriteSseEvent("milestone", draft);
            await WriteSseEvent("stage", new { stage = "drafting", message = $"已规划 {count} 个里程碑…" });
        }
        if (llmError != null) await WriteSseEvent("error", new { message = llmError });
        await WriteSseEvent("done", new { totalNew = count, error = llmError });
    }

    /// <summary>AI 生成结案报告（SSE 流式，仅 owner/leader）。汇总项目执行数据后让 LLM 起草 Markdown 报告。</summary>
    [HttpPost("projects/{projectId}/closure-report")]
    [Produces("text/event-stream")]
    public async Task GenerateClosureReport(string projectId)
    {
        var userId = GetUserId();
        var project = await FindAccessibleProjectAsync(projectId, userId);
        if (project == null) { Response.StatusCode = 404; return; }
        if (project.OwnerId != userId && project.LeaderId != userId) { Response.StatusCode = 403; return; }

        Response.ContentType = "text/event-stream; charset=utf-8";
        Response.Headers.CacheControl = "no-cache";
        await WriteSseEvent("stage", new { stage = "analyzing", message = "正在汇总项目数据并生成结案报告…" });

        var summary = await BuildClosureSummaryAsync(project);
        string? err = null;
        await _pmService.GenerateClosureReportAsync(project, summary, userId,
            onContent: async text => await WriteSseEvent("typing", new { text }),
            onThinking: async text => await WriteSseEvent("thinking", new { text }),
            onError: e => err = e);
        if (err != null) await WriteSseEvent("error", new { message = err });
        await WriteSseEvent("done", new { error = err });
    }

    /// <summary>汇总项目执行数据为结案报告输入文本</summary>
    private async Task<string> BuildClosureSummaryAsync(PmProject p)
    {
        var sb = new System.Text.StringBuilder();
        sb.AppendLine($"项目名称：{p.Title}（{p.ProjectNo}）");
        sb.AppendLine($"业务目标：{p.BusinessGoal}");
        if (!string.IsNullOrWhiteSpace(p.Description)) sb.AppendLine($"项目背景：{p.Description}");
        sb.AppendLine($"项目类型：{p.ProjectType}");
        if (p.PlannedStartAt.HasValue || p.PlannedEndAt.HasValue)
            sb.AppendLine($"计划周期：{p.PlannedStartAt:yyyy-MM-dd} ~ {p.PlannedEndAt:yyyy-MM-dd}");
        if (p.Budget.HasValue) sb.AppendLine($"预算：{p.Budget}，实际成本：{(p.ActualCost.HasValue ? p.ActualCost.ToString() : "未填")}");

        var tasks = await _db.PmTasks.Find(t => t.ProjectId == p.Id).ToListAsync();
        var done = tasks.Count(t => t.Status == PmTaskStatus.Done);
        var cancelled = tasks.Count(t => t.Status == PmTaskStatus.Cancelled);
        var active = tasks.Count - cancelled;
        sb.AppendLine($"任务：共 {tasks.Count}，完成 {done}，取消 {cancelled}，完成率 {(active > 0 ? (int)Math.Round(done * 100.0 / active) : 0)}%");

        var goals = await _db.PmGoals.Find(g => g.ProjectId == p.Id && g.Scope == PmGoalScope.Team).ToListAsync();
        if (goals.Count > 0)
        {
            sb.AppendLine("团队目标：");
            foreach (var g in goals.Take(20))
                sb.AppendLine($"- {g.Title}（状态 {g.Status}{(string.IsNullOrWhiteSpace(g.Metric) ? "" : $"，指标 {g.Metric}")}）");
        }
        var milestones = await _db.PmMilestones.Find(m => m.ProjectId == p.Id).ToListAsync();
        if (milestones.Count > 0)
            sb.AppendLine($"里程碑：共 {milestones.Count}，已达成 {milestones.Count(m => m.Status == PmMilestoneStatus.Reached)}");
        if (p.Evaluation != null)
            sb.AppendLine($"干系人评价 NPSS：满意度 {p.Evaluation.SatisfactionScore}，等级 {p.Evaluation.Grade}");
        var risks = await _db.PmRisks.Find(r => r.ProjectId == p.Id).ToListAsync();
        if (risks.Count > 0)
            sb.AppendLine($"风险：共 {risks.Count}，未关闭 {risks.Count(r => r.Status != PmRiskStatus.Closed)}");
        var decided = await _db.PmDecisions.Find(d => d.ProjectId == p.Id && d.Type == PmDecisionType.Decided).ToListAsync();
        if (decided.Count > 0)
        {
            sb.AppendLine("关键决策：");
            foreach (var d in decided.Take(10)) sb.AppendLine($"- {d.Title}");
        }
        sb.AppendLine("请基于以上数据撰写结案报告（Markdown 正文）。");
        return sb.ToString();
    }

    /// <summary>AI 项目健康诊断（SSE 流式，仅 owner/leader）。汇总项目实时执行信号后让 LLM 给出健康评级与纠偏建议。</summary>
    [HttpPost("projects/{projectId}/health-diagnosis")]
    [Produces("text/event-stream")]
    public async Task GenerateHealthDiagnosis(string projectId)
    {
        var userId = GetUserId();
        var project = await FindAccessibleProjectAsync(projectId, userId);
        if (project == null) { Response.StatusCode = 404; return; }
        if (project.OwnerId != userId && project.LeaderId != userId) { Response.StatusCode = 403; return; }

        Response.ContentType = "text/event-stream; charset=utf-8";
        Response.Headers.CacheControl = "no-cache";
        await WriteSseEvent("stage", new { stage = "analyzing", message = "正在扫描项目实时数据并生成健康诊断…" });

        var summary = await BuildHealthDiagnosisSummaryAsync(project);
        string? err = null;
        await _pmService.DiagnoseHealthAsync(project, summary, userId,
            onContent: async text => await WriteSseEvent("typing", new { text }),
            onThinking: async text => await WriteSseEvent("thinking", new { text }),
            onError: e => err = e);
        if (err != null) await WriteSseEvent("error", new { message = err });
        await WriteSseEvent("done", new { error = err });
    }

    /// <summary>汇总项目实时执行信号为健康诊断输入文本（与结案不同：聚焦"当下问题"而非"历史总结"）。</summary>
    private async Task<string> BuildHealthDiagnosisSummaryAsync(PmProject p)
    {
        var sb = new System.Text.StringBuilder();
        var now = DateTime.UtcNow;
        sb.AppendLine($"项目名称：{p.Title}（{p.ProjectNo}）");
        sb.AppendLine($"业务目标：{p.BusinessGoal}");
        sb.AppendLine($"项目类型：{p.ProjectType}，生命周期：{p.Lifecycle}");
        if (p.PlannedStartAt.HasValue || p.PlannedEndAt.HasValue)
        {
            sb.AppendLine($"计划周期：{p.PlannedStartAt:yyyy-MM-dd} ~ {p.PlannedEndAt:yyyy-MM-dd}");
            if (p.PlannedEndAt.HasValue)
            {
                var days = (int)Math.Round((p.PlannedEndAt.Value.Date - now.Date).TotalDays);
                sb.AppendLine(days < 0 ? $"计划结束日已过期 {-days} 天（项目尚未结案）"
                    : $"距计划结束还有 {days} 天");
            }
        }
        if (p.Budget.HasValue && p.Budget > 0)
        {
            var util = (double)(p.ActualCost ?? 0) / (double)p.Budget.Value * 100;
            sb.AppendLine($"预算：{p.Budget}，实际成本：{p.ActualCost ?? 0}，使用率 {(int)Math.Round(util)}%{(util > 100 ? "（已超预算）" : "")}");
        }

        // 任务信号
        var tasks = await _db.PmTasks.Find(t => t.ProjectId == p.Id).ToListAsync();
        var active = tasks.Where(t => t.Status != PmTaskStatus.Cancelled).ToList();
        var done = active.Count(t => t.Status == PmTaskStatus.Done);
        var inProgress = active.Count(t => t.Status == PmTaskStatus.InProgress);
        var overdue = active.Where(t => t.DueAt.HasValue && t.DueAt.Value < now
            && t.Status != PmTaskStatus.Done).ToList();
        sb.AppendLine($"任务：有效 {active.Count}，完成 {done}（完成率 {(active.Count > 0 ? (int)Math.Round(done * 100.0 / active.Count) : 0)}%），进行中 {inProgress}，逾期未完成 {overdue.Count}");
        if (overdue.Count > 0)
            foreach (var t in overdue.OrderBy(t => t.DueAt).Take(8))
                sb.AppendLine($"  - 逾期任务：{t.Title}（截止 {t.DueAt:yyyy-MM-dd}，状态 {t.Status}{(string.IsNullOrWhiteSpace(t.AssigneeName) ? "" : $"，负责人 {t.AssigneeName}")}）");

        // 里程碑信号
        var milestones = await _db.PmMilestones.Find(m => m.ProjectId == p.Id).ToListAsync();
        if (milestones.Count > 0)
        {
            var byHealth = milestones.GroupBy(m =>
            {
                var mine = active.Where(t => t.MilestoneId == m.Id).ToList();
                return MilestoneHealth(m, mine.Count, mine.Count(t => t.Status == PmTaskStatus.Done));
            }).ToDictionary(g => g.Key, g => g.Count());
            sb.AppendLine($"里程碑：共 {milestones.Count}（已达成 {byHealth.GetValueOrDefault("reached")}，逾期 {byHealth.GetValueOrDefault("overdue")}，临近风险 {byHealth.GetValueOrDefault("at_risk")}，正常 {byHealth.GetValueOrDefault("on_track")}）");
            foreach (var m in milestones.Where(m => m.Status == PmMilestoneStatus.Planned && m.DueAt.HasValue && m.DueAt.Value < now).OrderBy(m => m.DueAt).Take(5))
                sb.AppendLine($"  - 逾期里程碑：{m.Title}（截止 {m.DueAt:yyyy-MM-dd}）");
        }

        // 目标信号
        var goals = await _db.PmGoals.Find(g => g.ProjectId == p.Id && g.Scope == PmGoalScope.Team).ToListAsync();
        if (goals.Count > 0)
        {
            sb.AppendLine($"团队目标：共 {goals.Count}（进度均值约 {(int)Math.Round(goals.Average(g => g.Progress))}%）");
            foreach (var g in goals.OrderBy(g => g.Progress).Take(8))
                sb.AppendLine($"  - {g.Title}（进度 {g.Progress}%，状态 {g.Status}{(string.IsNullOrWhiteSpace(g.Metric) ? "" : $"，指标 {g.Metric}")}）");
        }

        // 风险信号
        var risks = await _db.PmRisks.Find(r => r.ProjectId == p.Id).ToListAsync();
        var openRisks = risks.Where(r => r.Status != PmRiskStatus.Closed).ToList();
        if (risks.Count > 0)
        {
            var highHigh = openRisks.Count(r => r.Probability == PmRiskLevel.High && r.Impact == PmRiskLevel.High);
            sb.AppendLine($"风险：共 {risks.Count}，未关闭 {openRisks.Count}，其中高概率×高影响 {highHigh}");
            foreach (var r in openRisks.Where(r => r.Probability == PmRiskLevel.High || r.Impact == PmRiskLevel.High).Take(8))
                sb.AppendLine($"  - 风险：{r.Title}（概率 {r.Probability}/影响 {r.Impact}，应对 {r.Response}，状态 {r.Status}）");
        }

        // 决策信号（长期未决最值得关注）
        var pending = await _db.PmDecisions.Find(d => d.ProjectId == p.Id && d.Type == PmDecisionType.Pending).ToListAsync();
        if (pending.Count > 0)
        {
            sb.AppendLine($"待决策事项：{pending.Count} 项未拍板");
            foreach (var d in pending.OrderBy(d => d.CreatedAt).Take(6))
            {
                var age = (int)Math.Round((now - d.CreatedAt).TotalDays);
                sb.AppendLine($"  - {d.Title}（已挂起 {age} 天）");
            }
        }

        // 最近周报趋势
        var recentReports = await _db.PmWeeklyReports.Find(w => w.ProjectId == p.Id)
            .SortByDescending(w => w.WeekStart).Limit(3).ToListAsync();
        if (recentReports.Count > 0)
            sb.AppendLine($"最近周报：{recentReports.Count} 篇（最新周起始 {recentReports[0].WeekStart:yyyy-MM-dd}）");
        else
            sb.AppendLine("最近周报：暂无（团队进展缺少书面同步）");

        sb.AppendLine();
        sb.AppendLine("请基于以上实时数据做项目健康诊断（Markdown 正文）。");
        return sb.ToString();
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
                // 观察者拥有与成员一样的访问权限（主要是看）
                b.AnyEq(p => p.ObserverIds, userId),
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

    private static int ClampProgress(int v) => PmTask.ClampProgress(v);

    /// <summary>
    /// 校验某任务能否作为两级层级里的父任务。返回 null 表示通过，否则返回错误文案。
    /// </summary>
    private async Task<string?> ValidateParentForTwoLevelAsync(string projectId, string parentId, string? childId)
    {
        if (childId != null && parentId == childId)
            return "父任务不能是自己";
        var parent = await _db.PmTasks.Find(t => t.Id == parentId).FirstOrDefaultAsync();
        if (parent == null || parent.ProjectId != projectId)
            return "父任务不存在或不在同一项目";
        if (parent.ParentTaskId != null)
            return "仅支持两级子任务：所选任务本身已是子任务";
        // 目标任务若已有子任务，则它是父任务，不能再被挂到别人下面（否则其子任务变三级）
        if (childId != null)
        {
            var childHasChildren = await _db.PmTasks.Find(t => t.ProjectId == projectId && t.ParentTaskId == childId).AnyAsync();
            if (childHasChildren)
                return "仅支持两级子任务：该任务已有子任务，不能再挂为他人的子任务";
        }
        return null;
    }

    /// <summary>重算父任务进度并落库（由子任务汇总，无子任务则不动）。</summary>
    private async Task RecalcParentProgressAsync(string parentTaskId)
    {
        var parent = await _db.PmTasks.Find(t => t.Id == parentTaskId).FirstOrDefaultAsync();
        if (parent == null) return;
        var children = await _db.PmTasks.Find(t => t.ParentTaskId == parentTaskId).ToListAsync();
        var progress = PmTask.ComputeParentProgress(children);
        if (progress == null) return; // 没有子任务则不动父任务进度
        var update = Builders<PmTask>.Update
            .Set(t => t.AutoProgress, true)
            .Set(t => t.ProgressPercent, progress.Value)
            .Set(t => t.UpdatedAt, DateTime.UtcNow);
        await _db.PmTasks.UpdateOneAsync(t => t.Id == parentTaskId, update);
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

    // ─────────────────────────────────────────────
    // 首页工作台（以「人」为中心，跨项目）：我的待办 / 便捷操作偏好 / AI 助手
    // ─────────────────────────────────────────────

    /// <summary>当前用户可访问的项目（与 ListProjects 的 all 口径一致），按更新时间倒序。</summary>
    private async Task<List<PmProject>> ListAccessibleProjectsAsync(string userId, int limit)
    {
        var b = Builders<PmProject>.Filter;
        var filter = b.And(
            b.Eq(p => p.IsDeleted, false),
            b.Or(
                b.Eq(p => p.OwnerId, userId),
                b.Eq(p => p.LeaderId, userId),
                b.AnyEq(p => p.MemberIds, userId),
                b.AnyEq(p => p.ObserverIds, userId),
                b.ElemMatch(p => p.Stakeholders, s => s.UserId == userId)));
        return await _db.PmProjects.Find(filter).SortByDescending(p => p.UpdatedAt).Limit(limit).ToListAsync();
    }

    /// <summary>
    /// 我的待办（跨项目）：指派给我的未完成任务（逾期优先、截止近的在前）+ 待我打分的结案评价。
    /// </summary>
    [HttpGet("my-todos")]
    public async Task<IActionResult> GetMyTodos()
    {
        var userId = GetUserId();
        var projects = await ListAccessibleProjectsAsync(userId, 100);
        var titleById = projects.ToDictionary(p => p.Id, p => p.Title);
        var projIds = projects.Select(p => p.Id).ToList();
        var tasks = projIds.Count == 0
            ? new List<PmTask>()
            : await _db.PmTasks.Find(t =>
                    projIds.Contains(t.ProjectId) && t.AssigneeId == userId
                    && t.Status != PmTaskStatus.Done && t.Status != PmTaskStatus.Cancelled)
                .ToListAsync();

        var today = DateTime.UtcNow.Date;
        var items = new List<object>();

        // 待我打分的结案评价（收集中且我未打分）
        foreach (var p in projects)
        {
            var round = p.EvaluationRound;
            if (round == null || round.Status != PmEvaluationRoundStatus.Collecting) continue;
            if (round.Participants.Any(x => x.UserId == userId && x.Score == null))
                items.Add(new
                {
                    kind = "evaluation",
                    id = p.Id,
                    projectId = p.Id,
                    projectTitle = p.Title,
                    title = "结案评价待打分",
                    dueAt = (DateTime?)null,
                    priority = (string?)null,
                    status = (string?)null,
                    overdue = false,
                });
        }

        foreach (var t in tasks
            .OrderByDescending(t => t.DueAt.HasValue && t.DueAt.Value < today)
            .ThenBy(t => t.DueAt ?? DateTime.MaxValue)
            .Take(50))
        {
            items.Add(new
            {
                kind = "task",
                id = t.Id,
                projectId = t.ProjectId,
                projectTitle = titleById.GetValueOrDefault(t.ProjectId, ""),
                title = t.Title,
                dueAt = t.DueAt,
                priority = (string?)t.Priority,
                status = (string?)t.Status,
                overdue = t.DueAt.HasValue && t.DueAt.Value < today,
            });
        }

        return Ok(ApiResponse<object>.Ok(new { items, total = items.Count }));
    }

    /// <summary>
    /// 跨项目执行数据报表（与 NPSS 看板分工：NPSS 管经营评价/奖金，本端点管执行数据）。
    /// scope: managed(我管理的) / related(我相关的) / all(默认，全部我可见的)。
    /// </summary>
    [HttpGet("reports/summary")]
    public async Task<IActionResult> GetReportsSummary([FromQuery] string? scope = null)
    {
        var userId = GetUserId();
        var b = Builders<PmProject>.Filter;
        var conds = new List<FilterDefinition<PmProject>> { b.Eq(p => p.IsDeleted, false) };
        var managed = b.Eq(p => p.LeaderId, userId);
        var related = b.And(
            b.Or(
                b.AnyEq(p => p.MemberIds, userId),
                b.AnyEq(p => p.ObserverIds, userId),
                b.ElemMatch(p => p.Stakeholders, s => s.UserId == userId)),
            b.Ne(p => p.LeaderId, userId));
        if (scope == "managed") conds.Add(managed);
        else if (scope == "related") conds.Add(related);
        else conds.Add(b.Or(
            b.Eq(p => p.OwnerId, userId), b.Eq(p => p.LeaderId, userId),
            b.AnyEq(p => p.MemberIds, userId), b.AnyEq(p => p.ObserverIds, userId),
            b.ElemMatch(p => p.Stakeholders, s => s.UserId == userId)));

        var projects = await _db.PmProjects.Find(b.And(conds)).SortByDescending(p => p.UpdatedAt).Limit(200).ToListAsync();
        var projIds = projects.Select(p => p.Id).ToList();
        var titleById = projects.ToDictionary(p => p.Id, p => p.Title);
        var today = DateTime.UtcNow.Date;

        var tasks = projIds.Count == 0 ? new List<PmTask>() : await _db.PmTasks
            .Find(t => projIds.Contains(t.ProjectId)).Limit(3000).ToListAsync();
        var milestones = projIds.Count == 0 ? new List<PmMilestone>() : await _db.PmMilestones
            .Find(m => projIds.Contains(m.ProjectId)).Limit(500).ToListAsync();
        var risks = projIds.Count == 0 ? new List<PmRisk>() : await _db.PmRisks
            .Find(r => projIds.Contains(r.ProjectId)).Limit(500).ToListAsync();

        // 项目维度：生命周期 / 类型分布
        var lifecycleDist = PmProjectLifecycle.All
            .Select(k => new { key = k, count = projects.Count(p => p.Lifecycle == k) })
            .Where(x => x.count > 0).ToList();
        var typeDist = PmProjectType.All
            .Select(k => new { key = k, count = projects.Count(p => p.ProjectType == k) })
            .Where(x => x.count > 0).ToList();

        // 任务维度：状态分布 / 完成率 / 逾期 / 负责人 Top
        bool IsOpen(PmTask t) => t.Status != PmTaskStatus.Done && t.Status != PmTaskStatus.Cancelled;
        bool IsOverdue(PmTask t) => IsOpen(t) && t.DueAt.HasValue && t.DueAt.Value < today;
        var doneCount = tasks.Count(t => t.Status == PmTaskStatus.Done);
        var effective = tasks.Count(t => t.Status != PmTaskStatus.Cancelled);
        var statusDist = PmTaskStatus.All
            .Select(k => new { key = k, count = tasks.Count(t => t.Status == k) })
            .Where(x => x.count > 0).ToList();
        var assigneeTop = tasks
            .Where(t => !string.IsNullOrWhiteSpace(t.AssigneeId))
            .GroupBy(t => t.AssigneeId!)
            .Select(g => new
            {
                name = g.Select(t => t.AssigneeName).FirstOrDefault(n => !string.IsNullOrWhiteSpace(n)) ?? "未知",
                total = g.Count(),
                done = g.Count(t => t.Status == PmTaskStatus.Done),
                overdue = g.Count(IsOverdue),
            })
            .OrderByDescending(x => x.total).Take(10).ToList();

        // 里程碑维度：达成 / 逾期未达成 / 即将到期
        var msReached = milestones.Count(m => m.Status == PmMilestoneStatus.Reached);
        var msOverdue = milestones.Count(m => m.Status == PmMilestoneStatus.Planned && m.DueAt.HasValue && m.DueAt.Value < today);
        var msUpcoming = milestones
            .Where(m => m.Status == PmMilestoneStatus.Planned && m.DueAt.HasValue && m.DueAt.Value >= today)
            .OrderBy(m => m.DueAt)
            .Take(8)
            .Select(m => new { id = m.Id, projectId = m.ProjectId, projectTitle = titleById.GetValueOrDefault(m.ProjectId, ""), title = m.Title, dueAt = m.DueAt })
            .ToList();

        // 风险维度：概率 x 影响矩阵 + 高分 Top
        int W(string level) => level == PmRiskLevel.High ? 3 : level == PmRiskLevel.Medium ? 2 : 1;
        var openRisks = risks.Where(r => r.Status != PmRiskStatus.Closed).ToList();
        var riskLevels = new[] { PmRiskLevel.High, PmRiskLevel.Medium, PmRiskLevel.Low };
        var riskMatrix = (from prob in riskLevels
                          from impact in riskLevels
                          let count = openRisks.Count(r => r.Probability == prob && r.Impact == impact)
                          where count > 0
                          select new { probability = prob, impact, count }).ToList();
        var riskTop = openRisks
            .OrderByDescending(r => W(r.Probability) * W(r.Impact))
            .Take(8)
            .Select(r => new
            {
                id = r.Id, projectId = r.ProjectId,
                projectTitle = titleById.GetValueOrDefault(r.ProjectId, ""),
                title = r.Title, probability = r.Probability, impact = r.Impact,
                status = r.Status, score = W(r.Probability) * W(r.Impact),
            })
            .ToList();

        return Ok(ApiResponse<object>.Ok(new
        {
            scope = scope == "managed" || scope == "related" ? scope : "all",
            projectTotal = projects.Count,
            lifecycleDist,
            typeDist,
            tasks = new
            {
                total = tasks.Count,
                done = doneCount,
                overdue = tasks.Count(IsOverdue),
                completionRate = effective > 0 ? Math.Round(doneCount * 100.0 / effective) : 0,
                statusDist,
                assigneeTop,
            },
            milestones = new { total = milestones.Count, reached = msReached, overdue = msOverdue, upcoming = msUpcoming },
            risks = new { open = openRisks.Count, matrix = riskMatrix, top = riskTop },
        }));
    }

    /// <summary>项目管理智能体用户偏好（quickActionIds 为 null 表示从未配置，前端走默认）。</summary>
    [HttpGet("preferences")]
    public async Task<IActionResult> GetPmPreferences()
    {
        var userId = GetUserId();
        var prefs = await _db.UserPreferences.Find(x => x.UserId == userId).FirstOrDefaultAsync();
        return Ok(ApiResponse<object>.Ok(new { quickActionIds = prefs?.PmAgentPreferences?.QuickActionIds }));
    }

    /// <summary>更新首页「便捷操作」配置。id 对应前端 pmQuickActionRegistry，后端只存有序字符串列表（上限 50）。</summary>
    [HttpPut("preferences/quick-actions")]
    public async Task<IActionResult> UpdatePmQuickActions([FromBody] UpdatePmQuickActionsRequest request)
    {
        var userId = GetUserId();
        var ids = (request.QuickActionIds ?? new List<string>())
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .Select(x => x.Trim())
            .Distinct()
            .Take(50)
            .ToList();

        var update = Builders<UserPreferences>.Update
            .Set(x => x.PmAgentPreferences, new PmAgentPreferences { QuickActionIds = ids })
            .Set(x => x.UpdatedAt, DateTime.UtcNow);
        await _db.UserPreferences.UpdateOneAsync(x => x.UserId == userId, update, new UpdateOptions { IsUpsert = true });

        return Ok(ApiResponse<object>.Ok(new { quickActionIds = ids }));
    }

    /// <summary>
    /// 首页 AI 助手（SSE：phase/typing/action/done/error）。
    /// 以当前用户为中心、跨其全部相关项目（项目/目标/里程碑/任务/风险摘要）为上下文回答问题；
    /// 可通过 &lt;&lt;&lt;ACTIONS&gt;&gt;&gt; 动作协议代用户创建项目/目标/里程碑/任务（与 product-agent 工作助手同款机制）。
    /// </summary>
    [HttpPost("assistant/ask")]
    public async Task AssistantAsk([FromBody] PmAssistantAskRequest request)
    {
        Response.ContentType = "text/event-stream; charset=utf-8";
        Response.Headers.CacheControl = "no-cache";
        Response.Headers["X-Accel-Buffering"] = "no";

        var userId = GetUserId();
        var question = (request.Question ?? "").Trim();
        if (question.Length == 0) { await WriteSseEvent("error", new { message = "请输入问题" }); return; }
        if (question.Length > 1000) question = question[..1000];

        await WriteSseEvent("phase", new { message = "正在汇总你相关的项目数据…" });

        var me = await _db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync();
        var myName = string.IsNullOrWhiteSpace(me?.DisplayName) ? (me?.Username ?? "用户") : me!.DisplayName!;
        var projects = await ListAccessibleProjectsAsync(userId, 20);
        var projIds = projects.Select(p => p.Id).ToList();

        var goals = projIds.Count == 0 ? new List<PmGoal>() : await _db.PmGoals
            .Find(g => projIds.Contains(g.ProjectId)).SortBy(g => g.OrderKey).Limit(120).ToListAsync();
        var milestones = projIds.Count == 0 ? new List<PmMilestone>() : await _db.PmMilestones
            .Find(m => projIds.Contains(m.ProjectId)).SortBy(m => m.DueAt).Limit(120).ToListAsync();
        var risks = projIds.Count == 0 ? new List<PmRisk>() : await _db.PmRisks
            .Find(r => projIds.Contains(r.ProjectId) && r.Status != PmRiskStatus.Closed).Limit(60).ToListAsync();
        var myTasks = projIds.Count == 0 ? new List<PmTask>() : await _db.PmTasks
            .Find(t => projIds.Contains(t.ProjectId) && t.AssigneeId == userId
                && t.Status != PmTaskStatus.Done && t.Status != PmTaskStatus.Cancelled)
            .Limit(80).ToListAsync();
        var today = DateTime.UtcNow.Date;
        var overdueTasks = projIds.Count == 0 ? new List<PmTask>() : await _db.PmTasks
            .Find(t => projIds.Contains(t.ProjectId) && t.DueAt < today
                && t.Status != PmTaskStatus.Done && t.Status != PmTaskStatus.Cancelled)
            .Limit(40).ToListAsync();

        string D(DateTime? t) => t.HasValue ? t.Value.ToString("yyyy-MM-dd") : "—";
        var sb = new System.Text.StringBuilder();
        sb.AppendLine($"# 当前用户：{myName}");
        sb.AppendLine($"今日：{DateTime.UtcNow:yyyy-MM-dd}（涉及本周/本月时以此为准）");
        sb.AppendLine($"\n## 我相关的项目（{projects.Count}）");
        foreach (var p in projects)
        {
            var role = p.LeaderId == userId ? "项目经理" : p.OwnerId == userId ? "立项人" : p.MemberIds.Contains(userId) ? "成员" : "观察者/干系人";
            sb.AppendLine($"- [{p.ProjectNo}] {p.Title}（类型 {p.ProjectType}，生命周期 {p.Lifecycle}，我的角色 {role}；任务 {p.DoneTaskCount}/{p.TaskCount}；计划 {D(p.PlannedStartAt)}~{D(p.PlannedEndAt)}；预算 {(p.Budget?.ToString("0") ?? "—")}，实际 {(p.ActualCost?.ToString("0") ?? "—")}）目标：{p.BusinessGoal}");
        }
        var noById = projects.ToDictionary(p => p.Id, p => $"[{p.ProjectNo}]{p.Title}");
        string PN(string projectId) => noById.GetValueOrDefault(projectId, projectId);
        if (goals.Count > 0)
        {
            sb.AppendLine($"\n## 目标（{goals.Count}）");
            foreach (var g in goals) sb.AppendLine($"- {PN(g.ProjectId)} {g.Title}（{g.Scope}，状态 {g.Status}，进度 {g.Progress}%）{(string.IsNullOrWhiteSpace(g.Metric) ? "" : $" 指标：{g.Metric}")}");
        }
        if (milestones.Count > 0)
        {
            sb.AppendLine($"\n## 里程碑（{milestones.Count}）");
            foreach (var m in milestones) sb.AppendLine($"- {PN(m.ProjectId)} {m.Title}（计划 {D(m.DueAt)}，实际达成 {D(m.ReachedAt)}，状态 {m.Status}）");
        }
        if (myTasks.Count > 0)
        {
            sb.AppendLine($"\n## 指派给我的未完成任务（{myTasks.Count}）");
            foreach (var t in myTasks) sb.AppendLine($"- {PN(t.ProjectId)} {t.Title}（状态 {t.Status}，优先级 {t.Priority}，截止 {D(t.DueAt)}）");
        }
        if (overdueTasks.Count > 0)
        {
            sb.AppendLine($"\n## 已逾期任务（{overdueTasks.Count}，全员）");
            foreach (var t in overdueTasks) sb.AppendLine($"- {PN(t.ProjectId)} {t.Title}（负责人 {t.AssigneeName ?? "未指派"}，截止 {D(t.DueAt)}，状态 {t.Status}）");
        }
        if (risks.Count > 0)
        {
            sb.AppendLine($"\n## 未关闭风险（{risks.Count}）");
            foreach (var r in risks) sb.AppendLine($"- {PN(r.ProjectId)} {r.Title}（概率 {r.Probability}，影响 {r.Impact}，状态 {r.Status}）");
        }

        var ctx = sb.ToString();
        if (ctx.Length > 14000) ctx = ctx[..14000] + "\n…（上下文过长已截断）";

        var systemPrompt =
            "你是「项目管理智能体」首页的 AI 助手，服务对象是用户「" + myName + "」。你的知识库仅限下面提供的该用户相关项目数据（项目/目标/里程碑/任务/风险）。\n" +
            "要求：\n" +
            "1. 只依据所给数据回答，不得编造；数据中没有的，明确说明「现有数据未覆盖」。可以跨项目对比分析（如哪个项目风险最高、我的任务分布）。\n" +
            "2. 涉及本周/本月/逾期等口径时，按给定的今日日期与各对象的计划/截止/达成日期推算。\n" +
            "3. 输出纯文本，禁止使用任何 Markdown 标记：不要 #、*、**、反引号、代码块、竖线表格。用自然段落和「· 」项目符号组织，必要时用「一、二、三」分节。\n" +
            "4. 分析/查询类问题的结构固定为三段：先「结论」（2-4 句直接给判断），再「依据」（列数据与关系），最后「建议」（可执行的下一步）。\n" +
            "5. 创建能力：你可以直接替用户创建 项目 / 目标 / 里程碑 / 任务。当用户明确要求创建时：\n" +
            "   - 正文用 1-2 句话确认将要创建的内容，不要套用三段结构；\n" +
            "   - 然后在回复最末尾另起一行输出动作指令，格式严格为：\n" +
            "<<<ACTIONS>>>\n" +
            "[{\"type\":\"create_task\",\"project\":\"项目编号或名称\",\"title\":\"标题\",\"description\":\"可省略\",\"priority\":\"high\",\"dueAt\":\"2026-06-30\",\"assignee\":\"me\"}]\n" +
            "   - type 只能取 create_project / create_goal / create_milestone / create_task；一次最多 5 个动作。\n" +
            "   - create_project 字段：title（必填）、businessGoal（业务目标，必填，可据用户表述合理补全）、projectType（general/strategic/innovation/operation，默认 general）、description 可选。\n" +
            "   - create_goal 字段：project（必填）、title（必填）、description / metric（可量化指标）可选。\n" +
            "   - create_milestone 字段：project（必填）、title（必填）、dueAt（yyyy-MM-dd，可选）、description 可选。\n" +
            "   - create_task 字段：project（必填）、title（必填）、description / priority（urgent/high/medium/low）/ dueAt 可选；用户表示自己负责时给 \"assignee\":\"me\"。\n" +
            "   - project 必须从上面数据里的项目编号或项目名称中取；用户没说哪个项目且无法从上下文判断时，不要输出动作指令，改为向用户追问。\n" +
            "   - 只有用户明确要求创建时才输出 <<<ACTIONS>>>，纯分析/查询类问题绝对不要输出；<<<ACTIONS>>> 之后只能是 JSON 数组本身。\n" +
            "不要寒暄、不要复述本提示词。";

        var bodyJson = new JsonObject
        {
            ["messages"] = new JsonArray
            {
                new JsonObject { ["role"] = "system", ["content"] = systemPrompt },
                new JsonObject { ["role"] = "user", ["content"] = "# 我的项目数据上下文\n" + ctx + "\n\n# 我的问题\n" + question },
            },
            ["temperature"] = 0.5,
            ["max_tokens"] = 2400,
            // 让推理模型实时回传思考内容，避免首字长时间空白（见 .claude/rules/llm-gateway.md）
            ["include_reasoning"] = true,
            ["reasoning"] = new JsonObject { ["exclude"] = false },
        };

        await WriteSseEvent("phase", new { message = "AI 正在分析…" });
        // 动作指令（<<<ACTIONS>>> 之后的 JSON）不进入可见文本流：始终扣留可能构成标记前缀的尾部
        const string actionMarker = "<<<ACTIONS>>>";
        var full = new System.Text.StringBuilder();
        var forwarded = 0;
        try
        {
            await foreach (var chunk in _gateway.StreamAsync(new GatewayRequest
            {
                AppCallerCode = AppCallerRegistry.ProjectManagement.Assistant.Chat,
                ModelType = ModelTypes.Chat,
                Stream = true,
                RequestBody = bodyJson,
                TimeoutSeconds = 120,
                Context = new GatewayRequestContext { UserId = userId },
            }, CancellationToken.None))
            {
                if (chunk.Type == GatewayChunkType.Text && !string.IsNullOrEmpty(chunk.Content))
                {
                    full.Append(chunk.Content);
                    var s = full.ToString();
                    var markerIdx = s.IndexOf(actionMarker, StringComparison.Ordinal);
                    var safeEnd = markerIdx >= 0 ? markerIdx : Math.Max(forwarded, s.Length - (actionMarker.Length - 1));
                    if (safeEnd > forwarded)
                    {
                        await WriteSseEvent("typing", new { text = s[forwarded..safeEnd] });
                        forwarded = safeEnd;
                    }
                }
                else if (chunk.Type == GatewayChunkType.Error)
                { await WriteSseEvent("error", new { message = chunk.Error ?? "AI 调用失败" }); return; }
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[pm-agent] assistant stream error");
            await WriteSseEvent("error", new { message = "AI 调用异常，请重试" });
            return;
        }

        var fullText = full.ToString();
        var actionIdx = fullText.IndexOf(actionMarker, StringComparison.Ordinal);
        var visibleEnd = actionIdx >= 0 ? actionIdx : fullText.Length;
        if (visibleEnd > forwarded)
            await WriteSseEvent("typing", new { text = fullText[forwarded..visibleEnd] });

        if (actionIdx >= 0)
        {
            var specs = ParsePmAssistantActions(fullText[(actionIdx + actionMarker.Length)..]);
            foreach (var spec in specs)
            {
                await WriteSseEvent("phase", new { message = "正在执行操作…" });
                var result = await ExecutePmAssistantActionAsync(userId, spec, projects);
                await WriteSseEvent("action", result);
            }
        }
        await WriteSseEvent("done", new { });
    }

    private sealed record PmAssistantActionSpec(
        string Type, string? Project, string Title, string? Description,
        string? Priority, string? DueAt, string? ProjectType, string? Metric, string? BusinessGoal, bool AssignToMe);

    /// <summary>解析助手动作指令 JSON（容忍代码块围栏 / json 语言标），非法输入返回空列表，最多 5 条。</summary>
    private static List<PmAssistantActionSpec> ParsePmAssistantActions(string raw)
    {
        var result = new List<PmAssistantActionSpec>();
        var json = raw.Trim().Trim('`').Trim();
        if (json.StartsWith("json", StringComparison.OrdinalIgnoreCase)) json = json[4..].Trim();
        try
        {
            if (JsonNode.Parse(json) is not JsonArray arr) return result;
            foreach (var node in arr.Take(5))
            {
                if (node is not JsonObject o) continue;
                var type = o["type"]?.GetValue<string>() ?? "";
                var title = (o["title"]?.GetValue<string>() ?? "").Trim();
                if (type.Length == 0 || title.Length == 0) continue;
                result.Add(new PmAssistantActionSpec(
                    type,
                    o["project"]?.GetValue<string>(),
                    title,
                    o["description"]?.GetValue<string>(),
                    o["priority"]?.GetValue<string>(),
                    o["dueAt"]?.GetValue<string>(),
                    o["projectType"]?.GetValue<string>(),
                    o["metric"]?.GetValue<string>(),
                    o["businessGoal"]?.GetValue<string>(),
                    string.Equals(o["assignee"]?.GetValue<string>(), "me", StringComparison.OrdinalIgnoreCase)));
            }
        }
        catch
        {
            // LLM 输出非法 JSON：忽略动作，正文已正常返回
        }
        return result;
    }

    /// <summary>
    /// 执行首页助手动作（创建项目/目标/里程碑/任务）。创建逻辑与对应 REST 端点对齐：
    /// 编号生成、权限校验、冗余名称、计数重算。返回 SSE action 事件载荷。
    /// </summary>
    private async Task<object> ExecutePmAssistantActionAsync(string userId, PmAssistantActionSpec spec, List<PmProject> accessible)
    {
        var title = spec.Title.Length > 200 ? spec.Title[..200] : spec.Title;
        var description = string.IsNullOrWhiteSpace(spec.Description) ? null : spec.Description!.Trim();
        if (description is { Length: > 4000 }) description = description[..4000];
        DateTime? dueAt = null;
        if (!string.IsNullOrWhiteSpace(spec.DueAt)
            && DateTime.TryParse(spec.DueAt, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var parsedDue))
            dueAt = parsedDue;

        PmProject? ResolveProject()
        {
            var r = spec.Project?.Trim();
            if (string.IsNullOrWhiteSpace(r)) return null;
            return accessible.FirstOrDefault(p => string.Equals(p.ProjectNo, r, StringComparison.OrdinalIgnoreCase))
                ?? accessible.FirstOrDefault(p => string.Equals(p.Title, r, StringComparison.OrdinalIgnoreCase))
                ?? (accessible.Count(p => p.Title.Contains(r!, StringComparison.OrdinalIgnoreCase)) == 1
                    ? accessible.First(p => p.Title.Contains(r!, StringComparison.OrdinalIgnoreCase))
                    : null);
        }

        object Fail(string kind, string error, PmProject? project = null) => new
        { kind, ok = false, id = (string?)null, projectId = project?.Id, projectTitle = project?.Title, title, error = (string?)error };
        object Success(string kind, string id, PmProject project) => new
        { kind, ok = true, id = (string?)id, projectId = (string?)project.Id, projectTitle = (string?)project.Title, title, error = (string?)null };

        try
        {
            switch (spec.Type)
            {
                case "create_project":
                {
                    var businessGoal = (spec.BusinessGoal ?? spec.Description ?? title).Trim();
                    var me = await _db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync();
                    var project = new PmProject
                    {
                        ProjectNo = await GenerateProjectNoAsync(),
                        Title = title,
                        Description = description,
                        BusinessGoal = businessGoal,
                        ProjectType = PmProjectType.All.Contains(spec.ProjectType ?? "") ? spec.ProjectType! : PmProjectType.General,
                        Lifecycle = PmProjectLifecycle.Registered,
                        LeaderId = userId,
                        LeaderName = me?.DisplayName,
                        MemberIds = new List<string> { userId },
                        OwnerId = userId,
                    };
                    await _db.PmProjects.InsertOneAsync(project);
                    _logger.LogInformation("[pm-agent] Assistant created project {ProjectNo} by {UserId}", project.ProjectNo, userId);
                    return new { kind = "project", ok = true, id = (string?)project.Id, projectId = (string?)project.Id, projectTitle = (string?)project.Title, title, error = (string?)null };
                }
                case "create_goal":
                {
                    var project = ResolveProject();
                    if (project == null) return Fail("goal", "未能定位项目，请说明项目编号或名称");
                    // 团队目标仅 owner/leader 可建；其他成员落为个人目标（与 REST 端点权限对齐）
                    var scope = (project.OwnerId == userId || project.LeaderId == userId) ? PmGoalScope.Team : PmGoalScope.Personal;
                    var creatorName = (await _db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync())?.DisplayName;
                    var goal = new PmGoal
                    {
                        ProjectId = project.Id,
                        Scope = scope,
                        OwnerId = userId,
                        Title = title,
                        Description = description,
                        Metric = string.IsNullOrWhiteSpace(spec.Metric) ? null : spec.Metric!.Trim(),
                        Status = PmGoalStatus.OnTrack,
                        CreatedBy = userId,
                        CreatedByName = creatorName,
                        OrderKey = DateTime.UtcNow.Ticks,
                    };
                    await _db.PmGoals.InsertOneAsync(goal);
                    return Success("goal", goal.Id, project);
                }
                case "create_milestone":
                {
                    var project = ResolveProject();
                    if (project == null) return Fail("milestone", "未能定位项目，请说明项目编号或名称");
                    if (project.OwnerId != userId && project.LeaderId != userId)
                        return Fail("milestone", "仅立项人或项目经理可创建里程碑", project);
                    var creatorName = (await _db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync())?.DisplayName;
                    var milestone = new PmMilestone
                    {
                        ProjectId = project.Id,
                        Title = title,
                        Description = description,
                        DueAt = dueAt,
                        BaselineDueAt = dueAt,
                        Status = PmMilestoneStatus.Planned,
                        OrderKey = DateTime.UtcNow.Ticks,
                        CreatedBy = userId,
                        CreatedByName = creatorName,
                    };
                    await _db.PmMilestones.InsertOneAsync(milestone);
                    return Success("milestone", milestone.Id, project);
                }
                case "create_task":
                {
                    var project = ResolveProject();
                    if (project == null) return Fail("task", "未能定位项目，请说明项目编号或名称");
                    var task = new PmTask
                    {
                        ProjectId = project.Id,
                        Title = title,
                        Description = description,
                        Status = PmTaskStatus.Backlog,
                        Priority = PmTaskPriority.All.Contains(spec.Priority ?? "") ? spec.Priority! : PmTaskPriority.Medium,
                        AssigneeId = spec.AssignToMe ? userId : null,
                        DueAt = dueAt,
                        Source = PmTaskSource.AiDecompose,
                        OrderKey = DateTime.UtcNow.Ticks,
                        CreatedBy = userId,
                    };
                    await FillAssigneeNameAsync(task);
                    await _db.PmTasks.InsertOneAsync(task);
                    await RecalcTaskCountAsync(project.Id);
                    return Success("task", task.Id, project);
                }
                default:
                    return Fail(spec.Type, "不支持的动作类型");
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[pm-agent] assistant action failed: {Type}", spec.Type);
            return Fail(spec.Type.Replace("create_", ""), "创建失败，请重试");
        }
    }
}

// ── 请求模型 ──

public class PmAssistantAskRequest
{
    public string? Question { get; set; }
}

public class UpdatePmQuickActionsRequest
{
    public List<string>? QuickActionIds { get; set; }
}

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

public class SetObserversRequest
{
    public List<string> ObserverIds { get; set; } = new();
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
    /// <summary>关联目标 ID 列表（可空）</summary>
    public List<string>? RelatedGoalIds { get; set; }
    /// <summary>关联任务 ID 列表（可空）</summary>
    public List<string>? RelatedTaskIds { get; set; }
}

public class UpdateDecisionRequest
{
    public string? Title { get; set; }
    public string? Content { get; set; }
    public string? Type { get; set; }
    public long? OrderKey { get; set; }
    /// <summary>关联目标 ID 列表（null=不变）</summary>
    public List<string>? RelatedGoalIds { get; set; }
    /// <summary>关联任务 ID 列表（null=不变）</summary>
    public List<string>? RelatedTaskIds { get; set; }
}

public class WeeklyReportRequest
{
    public string? Title { get; set; }
    public string? Content { get; set; }
    public DateTime? WeekStart { get; set; }
    /// <summary>关联目标 ID 列表（null=不变）</summary>
    public List<string>? RelatedGoalIds { get; set; }
    /// <summary>关联任务 ID 列表（null=不变）</summary>
    public List<string>? RelatedTaskIds { get; set; }
}

/// <summary>从个人周报（report-agent）导入到项目周报的请求</summary>
public class ImportWeeklyReportRequest
{
    public string SourceReportId { get; set; } = string.Empty;
    public List<string>? RelatedGoalIds { get; set; }
    public List<string>? RelatedTaskIds { get; set; }
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
    public string? ParentId { get; set; }
    public string? Title { get; set; }
    public string? Description { get; set; }
    public string? Metric { get; set; }
    public string? Period { get; set; }
    /// <summary>所属 OKR 周期 Id（null=不变；空串=清除）</summary>
    public string? CycleId { get; set; }
    public int? Progress { get; set; }
    public string? ProgressMode { get; set; }
    public string? Status { get; set; }
    /// <summary>负责人 UserId（null=不变；空串=清除）</summary>
    public string? LeadId { get; set; }
    /// <summary>关键结果 KR（null=不变）</summary>
    public List<KeyResultInput>? KeyResults { get; set; }
    public long? OrderKey { get; set; }
}

public class KeyResultInput
{
    public string? Id { get; set; }
    public string? Title { get; set; }
    public string? Type { get; set; }
    public double? StartValue { get; set; }
    public double? TargetValue { get; set; }
    public double? CurrentValue { get; set; }
    public string? Unit { get; set; }
}

public class GoalCheckInRequest
{
    public int? Progress { get; set; }
    public string? Confidence { get; set; }
    public string? Note { get; set; }
}

public class GoalScoreRequest
{
    /// <summary>0.0-1.0；Clear=true 时忽略</summary>
    public double? Score { get; set; }
    public string? Note { get; set; }
    public bool? Clear { get; set; }
}

public class GoalCycleRequest
{
    public string? Name { get; set; }
    public DateTime? StartAt { get; set; }
    public DateTime? EndAt { get; set; }
    public string? Status { get; set; }
    public long? OrderKey { get; set; }
}

public class RiskRequest
{
    public string? Title { get; set; }
    public string? Description { get; set; }
    public string? Probability { get; set; }
    public string? Impact { get; set; }
    public string? Response { get; set; }
    public string? Status { get; set; }
    public string? OwnerId { get; set; }
    public string? RelatedGoalId { get; set; }
    public string? RelatedTaskId { get; set; }
    public string? RelatedDecisionId { get; set; }
    public string? RelatedMilestoneId { get; set; }
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
    /// <summary>所属目标 ID（成果轴，可选）</summary>
    public string? GoalId { get; set; }
    public string? Status { get; set; }
    public string? Priority { get; set; }
    public string? AssigneeId { get; set; }
    public double? EstimateDays { get; set; }
    public DateTime? StartAt { get; set; }
    public DateTime? DueAt { get; set; }
    public List<string>? DependsOn { get; set; }
    public List<string>? Labels { get; set; }
    public double? OrderKey { get; set; }
    /// <summary>进度百分比 0-100（可选，叶子任务可创建即带进度）</summary>
    public int? ProgressPercent { get; set; }
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
    /// <summary>所属目标：传空串=解除归属，非空=归属，null=不变</summary>
    public string? GoalId { get; set; }
    /// <summary>进度百分比 0-100（null=不变；叶子任务手填后该任务转为手动进度）</summary>
    public int? ProgressPercent { get; set; }
    /// <summary>父任务 ID：传空串=取消父子关系（升为顶层），非空=挂为该任务的子任务，null=不变</summary>
    public string? ParentTaskId { get; set; }
}

public class CreateWorkLogRequest
{
    public string Content { get; set; } = string.Empty;
    /// <summary>工作日期（默认今天）</summary>
    public DateTime? Date { get; set; }
    /// <summary>耗时（分钟，选填）</summary>
    public int? DurationMinutes { get; set; }
    /// <summary>填报进度 0-100（选填；带入则联动任务进度）</summary>
    public int? ProgressPercent { get; set; }
    /// <summary>分类（DailyLogCategory，选填）</summary>
    public string? Category { get; set; }
}

public class UpdateWorkLogRequest
{
    public string? Content { get; set; }
    public DateTime? Date { get; set; }
    public int? DurationMinutes { get; set; }
    public int? ProgressPercent { get; set; }
    public string? Category { get; set; }
}

public class ToggleGoalMilestoneRequest
{
    public bool Enabled { get; set; }
}

public class ReparentGoalRequest
{
    /// <summary>新父目标 Id；空/缺省=升为顶层</summary>
    public string? ParentId { get; set; }
}

public class MilestoneRequest
{
    public string? Title { get; set; }
    public string? Description { get; set; }
    public DateTime? DueAt { get; set; }
    public string? GoalId { get; set; }
    public string? OwnerId { get; set; }
    /// <summary>验收标准（null=不变）。条目 Id 为空时服务端补 Guid。</summary>
    public List<MilestoneCriterionInput>? AcceptanceCriteria { get; set; }
    /// <summary>前置里程碑 Id 列表（null=不变；服务端做环检测）。</summary>
    public List<string>? DependsOn { get; set; }
    /// <summary>交付物引用（null=不变）。</summary>
    public List<DeliverableInput>? Deliverables { get; set; }
    /// <summary>true=把基线计划日重设为当前计划日（清零滑移）。</summary>
    public bool? ResetBaseline { get; set; }
    public string? Status { get; set; }
    public long? OrderKey { get; set; }
    /// <summary>实际完成时间（可补录）。非空=设置；配合 ClearReachedAt 清空。null=不变。</summary>
    public DateTime? ReachedAt { get; set; }
    /// <summary>true=清空实际完成时间。</summary>
    public bool? ClearReachedAt { get; set; }
}

public class MilestoneCriterionInput
{
    public string? Id { get; set; }
    public string? Text { get; set; }
    public bool Done { get; set; }
}

public class DeliverableInput
{
    public string? Type { get; set; }
    public string? RefId { get; set; }
    public string? Title { get; set; }
    public string? Url { get; set; }
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
