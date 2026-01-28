using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services.AssetStorage;
using System.Security.Claims;
using System.Text;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 管理后台 - 缺陷管理 Agent
/// </summary>
[ApiController]
[Route("api/defect-agent")]
[Authorize]
[AdminController("defect-agent", AdminPermissionCatalog.DefectAgentUse)]
public class DefectAgentController : ControllerBase
{
    private const string AppKey = "defect-agent";
    private readonly MongoDbContext _db;
    private readonly ISmartModelScheduler _scheduler;
    private readonly ILogger<DefectAgentController> _logger;
    private readonly IAssetStorage _assetStorage;

    public DefectAgentController(MongoDbContext db, ISmartModelScheduler scheduler, ILogger<DefectAgentController> logger, IAssetStorage assetStorage)
    {
        _db = db;
        _scheduler = scheduler;
        _logger = logger;
        _assetStorage = assetStorage;
    }

    private string GetUserId()
        => User.FindFirst("sub")?.Value
           ?? User.FindFirst(ClaimTypes.NameIdentifier)?.Value
           ?? "unknown";

    private string? GetUsername()
        => User.FindFirst("name")?.Value
           ?? User.FindFirst(ClaimTypes.Name)?.Value;

    private bool HasManagePermission()
    {
        var permissions = User.FindAll("permissions").Select(c => c.Value).ToList();
        return permissions.Contains(AdminPermissionCatalog.DefectAgentManage)
               || permissions.Contains(AdminPermissionCatalog.Super);
    }

    private static string? GetUnreadRoleForUser(DefectReport defect, string userId)
    {
        if (defect.ReporterId == userId) return DefectUnreadBy.Reporter;
        if (!string.IsNullOrEmpty(defect.AssigneeId) && defect.AssigneeId == userId) return DefectUnreadBy.Assignee;
        return null;
    }

    private static string? GetOppositeUnreadRole(DefectReport defect, string userId)
    {
        if (defect.ReporterId == userId)
            return string.IsNullOrEmpty(defect.AssigneeId) ? null : DefectUnreadBy.Assignee;
        if (!string.IsNullOrEmpty(defect.AssigneeId) && defect.AssigneeId == userId)
            return DefectUnreadBy.Reporter;
        return null;
    }

    #region 模板管理

    /// <summary>
    /// 获取模板列表（个人模板 + 收到的分享）
    /// </summary>
    [HttpGet("templates")]
    public async Task<IActionResult> ListTemplates(CancellationToken ct)
    {
        var userId = GetUserId();

        // 获取自己创建的模板 + 分享给自己的模板
        var items = await _db.DefectTemplates
            .Find(x => x.CreatedBy == userId || (x.SharedWith != null && x.SharedWith.Contains(userId)))
            .SortByDescending(x => x.IsDefault)
            .ThenByDescending(x => x.CreatedAt)
            .ToListAsync(ct);

        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    /// <summary>
    /// 获取默认模板
    /// </summary>
    [HttpGet("templates/default")]
    public async Task<IActionResult> GetDefaultTemplate(CancellationToken ct)
    {
        var template = await _db.DefectTemplates
            .Find(x => x.IsDefault)
            .FirstOrDefaultAsync(ct);

        if (template == null)
        {
            // 返回系统内置默认模板
            template = CreateBuiltInTemplate();
        }

        return Ok(ApiResponse<object>.Ok(new { template }));
    }

    /// <summary>
    /// 创建模板（个人模板）
    /// </summary>
    [HttpPost("templates")]
    public async Task<IActionResult> CreateTemplate([FromBody] CreateTemplateRequest request, CancellationToken ct)
    {
        var userId = GetUserId();

        if (string.IsNullOrWhiteSpace(request.Name))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "模板名称不能为空"));

        // 如果设为默认，取消其他默认模板
        if (request.IsDefault)
        {
            await _db.DefectTemplates.UpdateManyAsync(
                x => x.IsDefault,
                Builders<DefectTemplate>.Update.Set(x => x.IsDefault, false),
                cancellationToken: ct);
        }

        var template = new DefectTemplate
        {
            Id = Guid.NewGuid().ToString("N"),
            Name = request.Name.Trim(),
            Description = request.Description?.Trim(),
            RequiredFields = request.RequiredFields ?? CreateDefaultFields(),
            AiSystemPrompt = request.AiSystemPrompt?.Trim(),
            IsDefault = request.IsDefault,
            CreatedBy = userId,
            CreatedAt = DateTime.UtcNow,
            UpdatedAt = DateTime.UtcNow
        };

        await _db.DefectTemplates.InsertOneAsync(template, cancellationToken: ct);

        _logger.LogInformation("[{AppKey}] Template created: {TemplateId} by {UserId}", AppKey, template.Id, userId);

        return Ok(ApiResponse<object>.Ok(new { template }));
    }

    /// <summary>
    /// 更新模板（只能更新自己的模板）
    /// </summary>
    [HttpPut("templates/{id}")]
    public async Task<IActionResult> UpdateTemplate(string id, [FromBody] UpdateTemplateRequest request, CancellationToken ct)
    {
        var userId = GetUserId();

        var template = await _db.DefectTemplates.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (template == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "模板不存在"));

        if (template.CreatedBy != userId)
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "只能修改自己创建的模板"));

        if (!string.IsNullOrWhiteSpace(request.Name))
            template.Name = request.Name.Trim();
        if (request.Description != null)
            template.Description = request.Description.Trim();
        if (request.RequiredFields != null)
            template.RequiredFields = request.RequiredFields;
        if (request.AiSystemPrompt != null)
            template.AiSystemPrompt = request.AiSystemPrompt.Trim();
        if (request.IsDefault.HasValue)
        {
            if (request.IsDefault.Value)
            {
                // 取消其他默认模板
                await _db.DefectTemplates.UpdateManyAsync(
                    x => x.IsDefault && x.Id != id,
                    Builders<DefectTemplate>.Update.Set(x => x.IsDefault, false),
                    cancellationToken: ct);
            }
            template.IsDefault = request.IsDefault.Value;
        }

        template.UpdatedAt = DateTime.UtcNow;

        await _db.DefectTemplates.ReplaceOneAsync(x => x.Id == id, template, cancellationToken: ct);

        return Ok(ApiResponse<object>.Ok(new { template }));
    }

    /// <summary>
    /// 删除模板（只能删除自己的模板）
    /// </summary>
    [HttpDelete("templates/{id}")]
    public async Task<IActionResult> DeleteTemplate(string id, CancellationToken ct)
    {
        var userId = GetUserId();

        var template = await _db.DefectTemplates.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (template == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "模板不存在"));

        if (template.CreatedBy != userId)
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "只能删除自己创建的模板"));

        await _db.DefectTemplates.DeleteOneAsync(x => x.Id == id, ct);

        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    #endregion

    #region 缺陷管理

    /// <summary>
    /// 获取缺陷列表
    /// </summary>
    [HttpGet("defects")]
    public async Task<IActionResult> ListDefects(
        [FromQuery] string? status,
        [FromQuery] string? severity,
        [FromQuery] string? assigneeId,
        [FromQuery] string? folderId,
        [FromQuery] bool? mine,
        [FromQuery] int page = 1,
        [FromQuery] int pageSize = 20,
        CancellationToken ct = default)
    {
        var userId = GetUserId();
        var isAdmin = HasManagePermission();

        var filterBuilder = Builders<DefectReport>.Filter;
        var filters = new List<FilterDefinition<DefectReport>>();

        // 默认排除已删除的缺陷
        filters.Add(filterBuilder.Eq(x => x.IsDeleted, false));

        // 非管理员只能看到自己提交的或分配给自己的
        if (!isAdmin)
        {
            filters.Add(filterBuilder.Or(
                filterBuilder.Eq(x => x.ReporterId, userId),
                filterBuilder.Eq(x => x.AssigneeId, userId)
            ));
        }
        else if (mine == true)
        {
            // 管理员也可以筛选自己的
            filters.Add(filterBuilder.Or(
                filterBuilder.Eq(x => x.ReporterId, userId),
                filterBuilder.Eq(x => x.AssigneeId, userId)
            ));
        }

        if (!string.IsNullOrWhiteSpace(status))
            filters.Add(filterBuilder.Eq(x => x.Status, status));

        if (!string.IsNullOrWhiteSpace(severity))
            filters.Add(filterBuilder.Eq(x => x.Severity, severity));

        if (!string.IsNullOrWhiteSpace(assigneeId))
            filters.Add(filterBuilder.Eq(x => x.AssigneeId, assigneeId));

        // 文件夹筛选：folderId=root 表示只看根目录（未分类），其他值表示特定文件夹
        if (!string.IsNullOrWhiteSpace(folderId))
        {
            if (folderId == "root")
                filters.Add(filterBuilder.Eq(x => x.FolderId, (string?)null));
            else
                filters.Add(filterBuilder.Eq(x => x.FolderId, folderId));
        }

        var filter = filters.Count > 0
            ? filterBuilder.And(filters)
            : FilterDefinition<DefectReport>.Empty;

        var total = await _db.DefectReports.CountDocumentsAsync(filter, cancellationToken: ct);
        var items = await _db.DefectReports
            .Find(filter)
            .SortByDescending(x => x.CreatedAt)
            .Skip((page - 1) * pageSize)
            .Limit(pageSize)
            .ToListAsync(ct);

        return Ok(ApiResponse<object>.Ok(new { items, total, page, pageSize }));
    }

    /// <summary>
    /// 获取缺陷详情
    /// </summary>
    [HttpGet("defects/{id}")]
    public async Task<IActionResult> GetDefect(string id, CancellationToken ct)
    {
        var userId = GetUserId();
        var isAdmin = HasManagePermission();

        var defect = await _db.DefectReports.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (defect == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "缺陷不存在"));

        // 权限检查：只能查看自己提交的、分配给自己的，或管理员可查看全部
        if (!isAdmin && defect.ReporterId != userId && defect.AssigneeId != userId)
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限查看此缺陷"));

        // 获取对话消息
        var messages = await _db.DefectMessages
            .Find(x => x.DefectId == id)
            .SortBy(x => x.Seq)
            .ToListAsync(ct);

        return Ok(ApiResponse<object>.Ok(new { defect, messages }));
    }

    /// <summary>
    /// 创建缺陷（草稿）
    /// </summary>
    [HttpPost("defects")]
    public async Task<IActionResult> CreateDefect([FromBody] CreateDefectRequest request, CancellationToken ct)
    {
        var userId = GetUserId();

        // 查询报告人信息
        var reporter = await _db.Users.Find(x => x.UserId == userId).FirstOrDefaultAsync(ct);
        var reporterUsername = reporter?.Username;
        var reporterName = reporter?.DisplayName ?? reporter?.Username ?? GetUsername() ?? "未知用户";

        // 生成缺陷编号
        var defectNo = await GenerateDefectNo(ct);

        // 自动提取标题：使用提供的标题，或从内容第一行提取（限50字）
        var content = request.Content?.Trim() ?? string.Empty;
        var title = request.Title?.Trim();
        if (string.IsNullOrEmpty(title) && !string.IsNullOrEmpty(content))
        {
            var firstLine = content.Split('\n')[0].Trim();
            title = firstLine.Length > 50 ? firstLine[..50] + "..." : firstLine;
        }

        // 查询指派用户信息
        string? assigneeId = null;
        string? assigneeUsername = null;
        string? assigneeName = null;
        if (!string.IsNullOrEmpty(request.AssigneeUserId))
        {
            var assignee = await _db.Users.Find(x => x.UserId == request.AssigneeUserId).FirstOrDefaultAsync(ct);
            if (assignee != null)
            {
                assigneeId = assignee.UserId;
                assigneeUsername = assignee.Username;
                assigneeName = assignee.DisplayName ?? assignee.Username;
            }
        }

        var defect = new DefectReport
        {
            Id = Guid.NewGuid().ToString("N"),
            DefectNo = defectNo,
            TemplateId = request.TemplateId,
            Title = title,
            RawContent = content,
            Status = DefectStatus.Draft,
            Severity = request.Severity ?? DefectSeverity.Major,
            Priority = request.Priority ?? DefectPriority.Medium,
            ReporterId = userId,
            ReporterUsername = reporterUsername,
            ReporterName = reporterName,
            AssigneeId = assigneeId,
            AssigneeUsername = assigneeUsername,
            AssigneeName = assigneeName,
            CreatedAt = DateTime.UtcNow,
            UpdatedAt = DateTime.UtcNow
        };

        await _db.DefectReports.InsertOneAsync(defect, cancellationToken: ct);

        _logger.LogInformation("[{AppKey}] Defect created: {DefectNo} by {UserId}", AppKey, defectNo, userId);

        return Ok(ApiResponse<object>.Ok(new { defect }));
    }

    /// <summary>
    /// 更新缺陷（带版本历史）
    /// </summary>
    [HttpPut("defects/{id}")]
    public async Task<IActionResult> UpdateDefect(string id, [FromBody] UpdateDefectRequest request, CancellationToken ct)
    {
        var userId = GetUserId();
        var reporter = await _db.Users.Find(x => x.UserId == userId).FirstOrDefaultAsync(ct);
        var userName = reporter?.DisplayName ?? reporter?.Username ?? GetUsername() ?? "未知用户";

        var defect = await _db.DefectReports.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (defect == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "缺陷不存在"));

        // 只有报告人可以编辑草稿/待补充状态的缺陷
        if (defect.ReporterId != userId)
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限编辑此缺陷"));

        if (defect.Status != DefectStatus.Draft && defect.Status != DefectStatus.Awaiting)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "只能编辑草稿或待补充状态的缺陷"));

        // 保存当前版本到历史（如果有实质性修改）
        var hasChanges = (!string.IsNullOrWhiteSpace(request.Title) && request.Title.Trim() != defect.Title)
                      || (!string.IsNullOrWhiteSpace(request.Content) && request.Content.Trim() != defect.RawContent);

        if (hasChanges)
        {
            defect.Versions ??= new List<DefectVersion>();
            defect.Versions.Add(new DefectVersion
            {
                Version = defect.Version,
                Title = defect.Title,
                RawContent = defect.RawContent,
                StructuredData = defect.StructuredData?.ToDictionary(x => x.Key, x => x.Value),
                ModifiedBy = userId,
                ModifiedByName = userName,
                ModifiedAt = DateTime.UtcNow,
                ChangeNote = request.ChangeNote
            });
            defect.Version++;
        }

        if (!string.IsNullOrWhiteSpace(request.Title))
            defect.Title = request.Title.Trim();
        if (!string.IsNullOrWhiteSpace(request.Content))
            defect.RawContent = request.Content.Trim();
        if (request.StructuredData != null)
            defect.StructuredData = request.StructuredData;

        defect.UpdatedAt = DateTime.UtcNow;

        await _db.DefectReports.ReplaceOneAsync(x => x.Id == id, defect, cancellationToken: ct);

        return Ok(ApiResponse<object>.Ok(new { defect }));
    }

    /// <summary>
    /// 删除缺陷（软删除，移入回收站）
    /// </summary>
    [HttpDelete("defects/{id}")]
    public async Task<IActionResult> DeleteDefect(string id, CancellationToken ct)
    {
        var userId = GetUserId();
        var isAdmin = HasManagePermission();

        var defect = await _db.DefectReports.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (defect == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "缺陷不存在"));

        // 权限检查：提交者、被指派人或管理员可删除
        if (!isAdmin && defect.ReporterId != userId && defect.AssigneeId != userId)
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限删除此缺陷"));

        if (defect.IsDeleted)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "缺陷已在回收站中"));

        // 软删除
        var update = Builders<DefectReport>.Update
            .Set(x => x.IsDeleted, true)
            .Set(x => x.DeletedAt, DateTime.UtcNow)
            .Set(x => x.DeletedBy, userId);

        await _db.DefectReports.UpdateOneAsync(x => x.Id == id, update, cancellationToken: ct);

        _logger.LogInformation("[{AppKey}] Defect soft deleted: {DefectNo} by {UserId}", AppKey, defect.DefectNo, userId);

        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    /// <summary>
    /// 获取回收站列表
    /// </summary>
    [HttpGet("defects/trash")]
    public async Task<IActionResult> ListDeletedDefects(
        [FromQuery] int page = 1,
        [FromQuery] int pageSize = 20,
        CancellationToken ct = default)
    {
        var userId = GetUserId();
        var isAdmin = HasManagePermission();

        var filterBuilder = Builders<DefectReport>.Filter;
        var filters = new List<FilterDefinition<DefectReport>>
        {
            filterBuilder.Eq(x => x.IsDeleted, true)
        };

        // 非管理员只能看到自己删除的
        if (!isAdmin)
        {
            filters.Add(filterBuilder.Or(
                filterBuilder.Eq(x => x.ReporterId, userId),
                filterBuilder.Eq(x => x.AssigneeId, userId)
            ));
        }

        var filter = filterBuilder.And(filters);

        var total = await _db.DefectReports.CountDocumentsAsync(filter, cancellationToken: ct);
        var items = await _db.DefectReports
            .Find(filter)
            .SortByDescending(x => x.DeletedAt)
            .Skip((page - 1) * pageSize)
            .Limit(pageSize)
            .ToListAsync(ct);

        return Ok(ApiResponse<object>.Ok(new { items, total, page, pageSize }));
    }

    /// <summary>
    /// 从回收站恢复缺陷
    /// </summary>
    [HttpPost("defects/{id}/restore")]
    public async Task<IActionResult> RestoreDefect(string id, CancellationToken ct)
    {
        var userId = GetUserId();
        var isAdmin = HasManagePermission();

        var defect = await _db.DefectReports.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (defect == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "缺陷不存在"));

        // 权限检查
        if (!isAdmin && defect.ReporterId != userId && defect.AssigneeId != userId)
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限恢复此缺陷"));

        if (!defect.IsDeleted)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "缺陷不在回收站中"));

        // 恢复
        var update = Builders<DefectReport>.Update
            .Set(x => x.IsDeleted, false)
            .Set(x => x.DeletedAt, (DateTime?)null)
            .Set(x => x.DeletedBy, (string?)null)
            .Set(x => x.UpdatedAt, DateTime.UtcNow);

        await _db.DefectReports.UpdateOneAsync(x => x.Id == id, update, cancellationToken: ct);

        // 重新获取更新后的缺陷
        defect = await _db.DefectReports.Find(x => x.Id == id).FirstOrDefaultAsync(ct);

        _logger.LogInformation("[{AppKey}] Defect restored: {DefectNo} by {UserId}", AppKey, defect?.DefectNo, userId);

        return Ok(ApiResponse<object>.Ok(new { defect }));
    }

    /// <summary>
    /// 永久删除缺陷（从回收站彻底删除）
    /// </summary>
    [HttpDelete("defects/{id}/permanent")]
    public async Task<IActionResult> PermanentDeleteDefect(string id, CancellationToken ct)
    {
        var userId = GetUserId();
        var isAdmin = HasManagePermission();

        var defect = await _db.DefectReports.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (defect == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "缺陷不存在"));

        // 权限检查
        if (!isAdmin && defect.ReporterId != userId)
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限永久删除此缺陷"));

        if (!defect.IsDeleted)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "只能永久删除回收站中的缺陷"));

        // 永久删除关联的消息和缺陷
        await _db.DefectMessages.DeleteManyAsync(x => x.DefectId == id, ct);
        await _db.DefectReports.DeleteOneAsync(x => x.Id == id, ct);

        _logger.LogInformation("[{AppKey}] Defect permanently deleted: {DefectNo} by {UserId}", AppKey, defect.DefectNo, userId);

        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    #endregion

    #region 缺陷状态操作

    /// <summary>
    /// 提交缺陷（触发 AI 审核）
    /// </summary>
    [HttpPost("defects/{id}/submit")]
    public async Task<IActionResult> SubmitDefect(string id, CancellationToken ct)
    {
        var userId = GetUserId();

        var defect = await _db.DefectReports.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (defect == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "缺陷不存在"));

        if (defect.ReporterId != userId)
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限提交此缺陷"));

        if (defect.Status != DefectStatus.Draft && defect.Status != DefectStatus.Awaiting)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "只能提交草稿或待补充状态的缺陷"));

        if (string.IsNullOrWhiteSpace(defect.RawContent))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "缺陷描述不能为空"));

        // 简化处理：直接设为已提交（后续可改为异步 AI 审核）
        defect.Status = DefectStatus.Submitted;
        defect.SubmittedAt = DateTime.UtcNow;
        defect.ReporterUnread = false;
        defect.AssigneeUnread = !string.IsNullOrEmpty(defect.AssigneeId);
        defect.UpdatedAt = DateTime.UtcNow;

        await _db.DefectReports.ReplaceOneAsync(x => x.Id == id, defect, cancellationToken: ct);

        _logger.LogInformation("[{AppKey}] Defect submitted: {DefectNo} by {UserId}", AppKey, defect.DefectNo, userId);

        return Ok(ApiResponse<object>.Ok(new { defect }));
    }

    /// <summary>
    /// 指派处理人（需要管理权限）
    /// </summary>
    [HttpPost("defects/{id}/assign")]
    public async Task<IActionResult> AssignDefect(string id, [FromBody] AssignDefectRequest request, CancellationToken ct)
    {
        if (!HasManagePermission())
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限指派缺陷"));

        var defect = await _db.DefectReports.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (defect == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "缺陷不存在"));

        if (defect.Status != DefectStatus.Submitted && defect.Status != DefectStatus.Assigned)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "只能指派已提交或已指派状态的缺陷"));

        // 查找被指派人
        var assignee = await _db.Users.Find(x => x.UserId == request.AssigneeId).FirstOrDefaultAsync(ct);
        if (assignee == null)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "被指派人不存在"));

        defect.AssigneeId = request.AssigneeId;
        defect.AssigneeUsername = assignee.Username;
        defect.AssigneeName = assignee.DisplayName ?? assignee.Username;
        defect.Status = DefectStatus.Assigned;
        defect.AssignedAt = DateTime.UtcNow;
        defect.ReporterUnread = false;
        defect.AssigneeUnread = true;
        defect.UpdatedAt = DateTime.UtcNow;

        await _db.DefectReports.ReplaceOneAsync(x => x.Id == id, defect, cancellationToken: ct);

        _logger.LogInformation("[{AppKey}] Defect assigned: {DefectNo} to {AssigneeId}", AppKey, defect.DefectNo, request.AssigneeId);

        return Ok(ApiResponse<object>.Ok(new { defect }));
    }

    /// <summary>
    /// 开始处理
    /// </summary>
    [HttpPost("defects/{id}/process")]
    public async Task<IActionResult> ProcessDefect(string id, CancellationToken ct)
    {
        var userId = GetUserId();

        var defect = await _db.DefectReports.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (defect == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "缺陷不存在"));

        // 只有被指派人可以开始处理
        if (defect.AssigneeId != userId)
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "只有被指派人可以开始处理"));

        if (defect.Status != DefectStatus.Assigned)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "只能处理已指派状态的缺陷"));

        defect.Status = DefectStatus.Processing;
        defect.UpdatedAt = DateTime.UtcNow;

        await _db.DefectReports.ReplaceOneAsync(x => x.Id == id, defect, cancellationToken: ct);

        return Ok(ApiResponse<object>.Ok(new { defect }));
    }

    /// <summary>
    /// 标记解决
    /// </summary>
    [HttpPost("defects/{id}/resolve")]
    public async Task<IActionResult> ResolveDefect(string id, [FromBody] ResolveDefectRequest request, CancellationToken ct)
    {
        var userId = GetUserId();
        var isAdmin = HasManagePermission();

        var defect = await _db.DefectReports.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (defect == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "缺陷不存在"));

        // 允许任何可见用户标记完成
        if (!isAdmin && defect.ReporterId != userId && defect.AssigneeId != userId)
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限标记完成"));

        // 获取操作者信息
        var resolver = await _db.Users.Find(x => x.UserId == userId).FirstOrDefaultAsync(ct);
        var resolverName = resolver?.DisplayName ?? resolver?.Username ?? GetUsername() ?? "未知用户";

        defect.Status = DefectStatus.Resolved;
        defect.Resolution = request.Resolution?.Trim();
        defect.ResolvedById = userId;
        defect.ResolvedByName = resolverName;
        defect.ResolvedAt = DateTime.UtcNow;
        defect.UpdatedAt = DateTime.UtcNow;

        await _db.DefectReports.ReplaceOneAsync(x => x.Id == id, defect, cancellationToken: ct);

        _logger.LogInformation("[{AppKey}] Defect resolved: {DefectNo} by {UserId}", AppKey, defect.DefectNo, userId);

        return Ok(ApiResponse<object>.Ok(new { defect }));
    }

    /// <summary>
    /// 拒绝缺陷
    /// </summary>
    [HttpPost("defects/{id}/reject")]
    public async Task<IActionResult> RejectDefect(string id, [FromBody] RejectDefectRequest request, CancellationToken ct)
    {
        var userId = GetUserId();
        var isAdmin = HasManagePermission();

        var defect = await _db.DefectReports.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (defect == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "缺陷不存在"));

        // 允许任何可见用户拒绝
        if (!isAdmin && defect.ReporterId != userId && defect.AssigneeId != userId)
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限拒绝"));

        if (string.IsNullOrWhiteSpace(request.Reason))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "拒绝原因不能为空"));

        var rejector = await _db.Users.Find(x => x.UserId == userId).FirstOrDefaultAsync(ct);
        var rejectorName = rejector?.DisplayName ?? rejector?.Username ?? GetUsername() ?? "未知用户";

        defect.Status = DefectStatus.Rejected;
        defect.RejectReason = request.Reason.Trim();
        defect.RejectedById = userId;
        defect.RejectedByName = rejectorName;
        defect.UpdatedAt = DateTime.UtcNow;

        await _db.DefectReports.ReplaceOneAsync(x => x.Id == id, defect, cancellationToken: ct);

        return Ok(ApiResponse<object>.Ok(new { defect }));
    }

    /// <summary>
    /// 关闭缺陷
    /// </summary>
    [HttpPost("defects/{id}/close")]
    public async Task<IActionResult> CloseDefect(string id, CancellationToken ct)
    {
        var userId = GetUserId();
        var isAdmin = HasManagePermission();

        var defect = await _db.DefectReports.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (defect == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "缺陷不存在"));

        // 允许可见用户关闭
        if (!isAdmin && defect.ReporterId != userId && defect.AssigneeId != userId)
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限关闭缺陷"));

        // 完成=关闭：统一进入结束态（resolved 或 rejected）
        if (defect.Status != DefectStatus.Rejected)
        {
            var resolver = await _db.Users.Find(x => x.UserId == userId).FirstOrDefaultAsync(ct);
            var resolverName = resolver?.DisplayName ?? resolver?.Username ?? GetUsername() ?? "未知用户";
            defect.Status = DefectStatus.Resolved;
            defect.ResolvedById = userId;
            defect.ResolvedByName = resolverName;
            defect.ResolvedAt = DateTime.UtcNow;
        }

        defect.UpdatedAt = DateTime.UtcNow;

        await _db.DefectReports.ReplaceOneAsync(x => x.Id == id, defect, cancellationToken: ct);

        return Ok(ApiResponse<object>.Ok(new { defect }));
    }

    /// <summary>
    /// 重新打开缺陷
    /// </summary>
    [HttpPost("defects/{id}/reopen")]
    public async Task<IActionResult> ReopenDefect(string id, CancellationToken ct)
    {
        var userId = GetUserId();
        var isAdmin = HasManagePermission();

        var defect = await _db.DefectReports.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (defect == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "缺陷不存在"));

        // 报告人或管理员可以重新打开
        if (!isAdmin && defect.ReporterId != userId)
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限重新打开此缺陷"));

        if (defect.Status != DefectStatus.Rejected && defect.Status != DefectStatus.Resolved)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "只能重新打开已拒绝或已解决状态的缺陷"));

        // 如果有指派人，回到已指派状态；否则回到已提交状态
        defect.Status = string.IsNullOrEmpty(defect.AssigneeId) ? DefectStatus.Submitted : DefectStatus.Assigned;
        defect.Resolution = null;
        defect.RejectReason = null;
        defect.ResolvedAt = null;
        defect.ResolvedById = null;
        defect.ResolvedByName = null;
        defect.RejectedById = null;
        defect.RejectedByName = null;
        defect.UpdatedAt = DateTime.UtcNow;

        await _db.DefectReports.ReplaceOneAsync(x => x.Id == id, defect, cancellationToken: ct);

        return Ok(ApiResponse<object>.Ok(new { defect }));
    }

    #endregion

    #region 对话消息

    /// <summary>
    /// 获取对话消息
    /// </summary>
    [HttpGet("defects/{id}/messages")]
    public async Task<IActionResult> GetMessages(string id, [FromQuery] int? afterSeq, CancellationToken ct)
    {
        var userId = GetUserId();
        var isAdmin = HasManagePermission();

        var defect = await _db.DefectReports.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (defect == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "缺陷不存在"));

        if (!isAdmin && defect.ReporterId != userId && defect.AssigneeId != userId)
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限查看此缺陷的消息"));

        var filter = Builders<DefectMessage>.Filter.Eq(x => x.DefectId, id);
        if (afterSeq.HasValue)
            filter &= Builders<DefectMessage>.Filter.Gt(x => x.Seq, afterSeq.Value);

        var messages = await _db.DefectMessages
            .Find(filter)
            .SortBy(x => x.Seq)
            .ToListAsync(ct);

        var shouldUpdateRead = false;
        if (defect.ReporterId == userId && defect.ReporterUnread)
        {
            defect.ReporterUnread = false;
            shouldUpdateRead = true;
        }
        else if (defect.AssigneeId == userId && defect.AssigneeUnread)
        {
            defect.AssigneeUnread = false;
            shouldUpdateRead = true;
        }
        if (shouldUpdateRead)
        {
            defect.UpdatedAt = DateTime.UtcNow;
            await _db.DefectReports.ReplaceOneAsync(x => x.Id == id, defect, cancellationToken: ct);
        }

        return Ok(ApiResponse<object>.Ok(new { messages }));
    }

    /// <summary>
    /// 发送消息
    /// </summary>
    [HttpPost("defects/{id}/messages")]
    public async Task<IActionResult> SendMessage(string id, [FromBody] DefectSendMessageRequest request, CancellationToken ct)
    {
        var userId = GetUserId();
        var isAdmin = HasManagePermission();

        var defect = await _db.DefectReports.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (defect == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "缺陷不存在"));

        if (!isAdmin && defect.ReporterId != userId && defect.AssigneeId != userId)
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限发送消息"));

        var content = request.Content?.Trim() ?? string.Empty;
        var hasAttachments = request.AttachmentIds != null && request.AttachmentIds.Count > 0;
        if (string.IsNullOrWhiteSpace(content) && !hasAttachments)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "消息内容不能为空"));

        // 获取发送者信息
        var sender = await _db.Users.Find(x => x.UserId == userId).FirstOrDefaultAsync(ct);
        var senderName = sender?.DisplayName ?? sender?.Username ?? GetUsername() ?? "未知用户";
        var avatarFileName = sender?.AvatarFileName;

        // 获取当前最大 seq
        var maxSeq = await _db.DefectMessages
            .Find(x => x.DefectId == id)
            .SortByDescending(x => x.Seq)
            .Project(x => x.Seq)
            .FirstOrDefaultAsync(ct);

        var message = new DefectMessage
        {
            Id = Guid.NewGuid().ToString("N"),
            DefectId = id,
            Seq = maxSeq + 1,
            Role = DefectMessageRole.User,
            UserId = userId,
            UserName = senderName,
            AvatarFileName = avatarFileName,
            Content = content,
            AttachmentIds = request.AttachmentIds,
            CreatedAt = DateTime.UtcNow
        };

        await _db.DefectMessages.InsertOneAsync(message, cancellationToken: ct);

        var shouldUpdateDefect = false;

        // 更新缺陷的 rawContent（追加）
        if (!string.IsNullOrWhiteSpace(content))
        {
            defect.RawContent = string.IsNullOrEmpty(defect.RawContent)
                ? content
                : defect.RawContent + "\n\n" + content;
            shouldUpdateDefect = true;
        }

        if (defect.ReporterId == userId)
        {
            defect.ReporterUnread = false;
            defect.AssigneeUnread = true;
            defect.LastCommentBy = DefectUnreadBy.Reporter;
            shouldUpdateDefect = true;
        }
        else if (!string.IsNullOrEmpty(defect.AssigneeId) && defect.AssigneeId == userId)
        {
            defect.AssigneeUnread = false;
            defect.ReporterUnread = true;
            defect.LastCommentBy = DefectUnreadBy.Assignee;
            shouldUpdateDefect = true;
        }

        if (shouldUpdateDefect)
        {
            defect.UpdatedAt = DateTime.UtcNow;
            await _db.DefectReports.ReplaceOneAsync(x => x.Id == id, defect, cancellationToken: ct);
        }

        return Ok(ApiResponse<object>.Ok(new { message, defect }));
    }

    #endregion

    #region 附件上传

    private const long MaxAttachmentBytes = 10 * 1024 * 1024; // 10MB

    /// <summary>
    /// 添加附件到缺陷（支持文件上传）
    /// </summary>
    [HttpPost("defects/{id}/attachments")]
    [RequestSizeLimit(MaxAttachmentBytes)]
    public async Task<IActionResult> AddAttachment(string id, [FromForm] IFormFile file, CancellationToken ct)
    {
        var userId = GetUserId();

        if (file == null || file.Length <= 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.CONTENT_EMPTY, "文件不能为空"));

        if (file.Length > MaxAttachmentBytes)
            return StatusCode(StatusCodes.Status413PayloadTooLarge, ApiResponse<object>.Fail(ErrorCodes.ATTACHMENT_TOO_LARGE, "文件过大，最大 10MB"));

        var defect = await _db.DefectReports.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (defect == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "缺陷不存在"));

        var isAdmin = HasManagePermission();
        if (!isAdmin && defect.ReporterId != userId && defect.AssigneeId != userId)
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限添加附件"));

        // 读取文件内容
        byte[] bytes;
        await using (var ms = new MemoryStream())
        {
            await file.CopyToAsync(ms, ct);
            bytes = ms.ToArray();
        }

        // 上传到存储
        var mime = file.ContentType ?? "application/octet-stream";
        var stored = await _assetStorage.SaveAsync(bytes, mime, ct, domain: AppDomainPaths.DomainDefectAgent, type: "img");

        var attachment = new DefectAttachment
        {
            Id = Guid.NewGuid().ToString("N"),
            FileName = file.FileName ?? "unknown",
            FileSize = file.Length,
            MimeType = mime,
            Url = stored.Url,
            UploadedAt = DateTime.UtcNow
        };

        defect.Attachments.Add(attachment);
        defect.UpdatedAt = DateTime.UtcNow;

        await _db.DefectReports.ReplaceOneAsync(x => x.Id == id, defect, cancellationToken: ct);

        return Ok(ApiResponse<object>.Ok(new { attachment, defect }));
    }

    /// <summary>
    /// 删除附件
    /// </summary>
    [HttpDelete("defects/{defectId}/attachments/{attachmentId}")]
    public async Task<IActionResult> DeleteAttachment(string defectId, string attachmentId, CancellationToken ct)
    {
        var userId = GetUserId();

        var defect = await _db.DefectReports.Find(x => x.Id == defectId).FirstOrDefaultAsync(ct);
        if (defect == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "缺陷不存在"));

        if (defect.ReporterId != userId)
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限删除附件"));

        var attachment = defect.Attachments.FirstOrDefault(a => a.Id == attachmentId);
        if (attachment == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "附件不存在"));

        defect.Attachments.Remove(attachment);
        defect.UpdatedAt = DateTime.UtcNow;

        await _db.DefectReports.ReplaceOneAsync(x => x.Id == defectId, defect, cancellationToken: ct);

        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    #endregion

    #region 统计

    /// <summary>
    /// 获取缺陷统计
    /// </summary>
    [HttpGet("stats")]
    public async Task<IActionResult> GetStats(CancellationToken ct)
    {
        var userId = GetUserId();
        var isAdmin = HasManagePermission();

        // 构建基础过滤器
        var filterBuilder = Builders<DefectReport>.Filter;
        var baseFilter = isAdmin
            ? FilterDefinition<DefectReport>.Empty
            : filterBuilder.Or(
                filterBuilder.Eq(x => x.ReporterId, userId),
                filterBuilder.Eq(x => x.AssigneeId, userId)
            );

        var total = await _db.DefectReports.CountDocumentsAsync(baseFilter, cancellationToken: ct);

        var statusCounts = new Dictionary<string, long>();
        foreach (var status in DefectStatus.All)
        {
            var count = await _db.DefectReports.CountDocumentsAsync(
                baseFilter & filterBuilder.Eq(x => x.Status, status),
                cancellationToken: ct);
            statusCounts[status] = count;
        }

        var severityCounts = new Dictionary<string, long>();
        foreach (var severity in DefectSeverity.All)
        {
            var count = await _db.DefectReports.CountDocumentsAsync(
                baseFilter & filterBuilder.Eq(x => x.Severity, severity),
                cancellationToken: ct);
            severityCounts[severity] = count;
        }

        return Ok(ApiResponse<object>.Ok(new { total, statusCounts, severityCounts }));
    }

    #endregion

    #region 辅助方法

    private async Task<string> GenerateDefectNo(CancellationToken ct)
    {
        var year = DateTime.UtcNow.Year;
        var prefix = $"DEF-{year}-";

        // 查找当年最大编号
        var latestDefect = await _db.DefectReports
            .Find(x => x.DefectNo.StartsWith(prefix))
            .SortByDescending(x => x.DefectNo)
            .FirstOrDefaultAsync(ct);

        var nextNumber = 1;
        if (latestDefect != null && latestDefect.DefectNo.StartsWith(prefix))
        {
            var numberPart = latestDefect.DefectNo.Substring(prefix.Length);
            if (int.TryParse(numberPart, out var lastNumber))
            {
                nextNumber = lastNumber + 1;
            }
        }

        return $"{prefix}{nextNumber:D4}";
    }

    private static List<DefectTemplateField> CreateDefaultFields()
    {
        return new List<DefectTemplateField>
        {
            new() { Key = "title", Label = "问题标题", Type = "text", Required = true, AiPrompt = "请提供一个简短的问题标题" },
            new() { Key = "description", Label = "问题描述", Type = "text", Required = true, AiPrompt = "请详细描述您遇到的问题" },
            new() { Key = "steps", Label = "复现步骤", Type = "text", Required = true, AiPrompt = "请提供复现问题的具体步骤" },
            new() { Key = "expected", Label = "预期结果", Type = "text", Required = true, AiPrompt = "您期望的正确结果是什么？" },
            new() { Key = "actual", Label = "实际结果", Type = "text", Required = true, AiPrompt = "实际发生的结果是什么？" },
            new()
            {
                Key = "severity", Label = "严重程度", Type = "select", Required = true,
                Options = new List<string> { "blocker", "critical", "major", "minor", "suggestion" },
                AiPrompt = "请选择问题的严重程度"
            }
        };
    }

    private static DefectTemplate CreateBuiltInTemplate()
    {
        return new DefectTemplate
        {
            Id = "built-in-default",
            Name = "默认模板",
            Description = "系统内置的默认缺陷提交模板",
            RequiredFields = CreateDefaultFields(),
            AiSystemPrompt = @"你是一个缺陷报告审核助手。用户会用自然语言描述遇到的问题。

你的任务：
1. 从用户描述中提取结构化信息
2. 检查是否包含必填字段：标题、描述、复现步骤、预期结果、实际结果、严重程度
3. 如果信息不完整，用友好的语气询问缺失的内容
4. 如果信息完整，确认并总结

注意：
- 保持友好、简洁的语气
- 一次只询问 2-3 个问题，不要一次问太多
- 如果用户提供了截图，参考截图内容",
            IsDefault = true,
            CreatedBy = "system",
            CreatedAt = DateTime.UtcNow,
            UpdatedAt = DateTime.UtcNow
        };
    }

    #endregion

    #region 用户查询

    /// <summary>
    /// 获取用户列表（用于选择提交对象）
    /// </summary>
    [HttpGet("users")]
    public async Task<IActionResult> GetUsers(CancellationToken ct)
    {
        var users = await _db.Users
            .Find(x => x.Status == UserStatus.Active && x.UserType == UserType.Human)
            .Project(x => new
            {
                id = x.UserId,
                username = x.Username,
                displayName = x.DisplayName
            })
            .ToListAsync(ct);

        return Ok(ApiResponse<object>.Ok(new { items = users }));
    }

    #endregion

    #region AI 辅助

    /// <summary>
    /// AI 润色/填充缺陷描述
    /// </summary>
    [HttpPost("defects/polish")]
    public async Task<IActionResult> PolishDefect([FromBody] PolishDefectRequest request, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(request.Content))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "内容不能为空"));

        try
        {
            // 获取模板信息（如果有）
            DefectTemplate? template = null;
            if (!string.IsNullOrWhiteSpace(request.TemplateId))
            {
                template = await _db.DefectTemplates.Find(x => x.Id == request.TemplateId).FirstOrDefaultAsync(ct);
            }

            // 构建系统提示词
            var systemPrompt = new StringBuilder();
            systemPrompt.AppendLine("你是一个专业的缺陷描述优化助手。请帮助用户润色和完善缺陷描述。");
            systemPrompt.AppendLine();
            systemPrompt.AppendLine("要求：");
            systemPrompt.AppendLine("1. 保持原意不变，但使描述更加清晰、专业");
            systemPrompt.AppendLine("2. 如果描述不完整，补充必要的信息（如复现步骤、期望结果、实际结果）");
            systemPrompt.AppendLine("3. 使用简洁明了的语言");
            systemPrompt.AppendLine("4. 直接输出润色后的内容，不要添加额外的解释或标记");

            if (template != null)
            {
                systemPrompt.AppendLine();
                systemPrompt.AppendLine($"参考模板: {template.Name}");
                if (!string.IsNullOrWhiteSpace(template.Description))
                    systemPrompt.AppendLine($"模板说明: {template.Description}");
                if (template.RequiredFields?.Count > 0)
                {
                    systemPrompt.AppendLine("必填字段:");
                    foreach (var field in template.RequiredFields)
                    {
                        systemPrompt.AppendLine($"- {field.Label}");
                    }
                }
                if (!string.IsNullOrWhiteSpace(template.AiSystemPrompt))
                {
                    systemPrompt.AppendLine();
                    systemPrompt.AppendLine("模板特定指令:");
                    systemPrompt.AppendLine(template.AiSystemPrompt);
                }
            }

            // 获取 LLM 客户端（使用注册的 AppCallerCode）
            var client = await _scheduler.GetClientAsync(AppCallerRegistry.DefectAgent.Polish.Chat, "chat", ct);

            // 调用 LLM
            var messages = new List<LLMMessage>
            {
                new() { Role = "user", Content = $"请润色以下缺陷描述：\n\n{request.Content}" }
            };

            var resultBuilder = new StringBuilder();
            await foreach (var chunk in client.StreamGenerateAsync(systemPrompt.ToString(), messages, ct))
            {
                if (chunk.Type == "delta" && !string.IsNullOrEmpty(chunk.Content))
                {
                    resultBuilder.Append(chunk.Content);
                }
                else if (chunk.Type == "error")
                {
                    _logger.LogWarning("[{AppKey}] AI polish error: {Error}", AppKey, chunk.ErrorMessage);
                    return StatusCode(500, ApiResponse<object>.Fail(ErrorCodes.INTERNAL_ERROR, chunk.ErrorMessage ?? "AI 处理失败"));
                }
            }

            var polishedContent = resultBuilder.ToString().Trim();
            _logger.LogInformation("[{AppKey}] Defect polished successfully", AppKey);

            return Ok(ApiResponse<object>.Ok(new { content = polishedContent }));
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[{AppKey}] Failed to polish defect", AppKey);
            return StatusCode(500, ApiResponse<object>.Fail(ErrorCodes.INTERNAL_ERROR, "AI 润色失败，请稍后重试"));
        }
    }

    #endregion

    #region 文件夹管理

    /// <summary>
    /// 获取文件夹列表
    /// </summary>
    [HttpGet("folders")]
    public async Task<IActionResult> ListFolders(CancellationToken ct)
    {
        // 所有用户共享同一空间的文件夹
        var items = await _db.DefectFolders
            .Find(x => x.SpaceId == null || x.SpaceId == "default")
            .SortByDescending(x => x.SortOrder)
            .ThenBy(x => x.Name)
            .ToListAsync(ct);

        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    /// <summary>
    /// 创建文件夹
    /// </summary>
    [HttpPost("folders")]
    public async Task<IActionResult> CreateFolder([FromBody] CreateFolderRequest request, CancellationToken ct)
    {
        var userId = GetUserId();

        if (string.IsNullOrWhiteSpace(request.Name))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "文件夹名称不能为空"));

        // 检查同名文件夹
        var exists = await _db.DefectFolders.Find(x =>
            (x.SpaceId == null || x.SpaceId == "default") &&
            x.Name == request.Name.Trim()
        ).AnyAsync(ct);

        if (exists)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.DUPLICATE, "已存在同名文件夹"));

        var folder = new DefectFolder
        {
            Id = Guid.NewGuid().ToString("N"),
            Name = request.Name.Trim(),
            Description = request.Description?.Trim(),
            Color = request.Color,
            Icon = request.Icon,
            SortOrder = request.SortOrder,
            SpaceId = "default",
            CreatedBy = userId,
            CreatedAt = DateTime.UtcNow,
            UpdatedAt = DateTime.UtcNow
        };

        await _db.DefectFolders.InsertOneAsync(folder, cancellationToken: ct);

        _logger.LogInformation("[{AppKey}] Folder created: {FolderName} by {UserId}", AppKey, folder.Name, userId);

        return Ok(ApiResponse<object>.Ok(new { folder }));
    }

    /// <summary>
    /// 更新文件夹
    /// </summary>
    [HttpPut("folders/{id}")]
    public async Task<IActionResult> UpdateFolder(string id, [FromBody] UpdateFolderRequest request, CancellationToken ct)
    {
        var folder = await _db.DefectFolders.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (folder == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "文件夹不存在"));

        // 检查同名文件夹（排除自身）
        if (!string.IsNullOrWhiteSpace(request.Name) && request.Name.Trim() != folder.Name)
        {
            var exists = await _db.DefectFolders.Find(x =>
                x.Id != id &&
                (x.SpaceId == null || x.SpaceId == "default") &&
                x.Name == request.Name.Trim()
            ).AnyAsync(ct);

            if (exists)
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.DUPLICATE, "已存在同名文件夹"));
        }

        if (!string.IsNullOrWhiteSpace(request.Name))
            folder.Name = request.Name.Trim();
        if (request.Description != null)
            folder.Description = request.Description.Trim();
        if (request.Color != null)
            folder.Color = request.Color;
        if (request.Icon != null)
            folder.Icon = request.Icon;
        if (request.SortOrder.HasValue)
            folder.SortOrder = request.SortOrder.Value;

        folder.UpdatedAt = DateTime.UtcNow;

        await _db.DefectFolders.ReplaceOneAsync(x => x.Id == id, folder, cancellationToken: ct);

        return Ok(ApiResponse<object>.Ok(new { folder }));
    }

    /// <summary>
    /// 删除文件夹
    /// </summary>
    [HttpDelete("folders/{id}")]
    public async Task<IActionResult> DeleteFolder(string id, CancellationToken ct)
    {
        var folder = await _db.DefectFolders.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (folder == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "文件夹不存在"));

        // 将文件夹内的缺陷移到根目录
        var update = Builders<DefectReport>.Update
            .Set(x => x.FolderId, (string?)null)
            .Set(x => x.UpdatedAt, DateTime.UtcNow);
        await _db.DefectReports.UpdateManyAsync(x => x.FolderId == id, update, cancellationToken: ct);

        // 删除文件夹
        await _db.DefectFolders.DeleteOneAsync(x => x.Id == id, ct);

        _logger.LogInformation("[{AppKey}] Folder deleted: {FolderId}", AppKey, id);

        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    /// <summary>
    /// 移动缺陷到文件夹
    /// </summary>
    [HttpPost("defects/{id}/move")]
    public async Task<IActionResult> MoveDefectToFolder(string id, [FromBody] MoveDefectRequest request, CancellationToken ct)
    {
        var userId = GetUserId();
        var isAdmin = HasManagePermission();

        var defect = await _db.DefectReports.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (defect == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "缺陷不存在"));

        // 权限检查
        if (!isAdmin && defect.ReporterId != userId && defect.AssigneeId != userId)
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限移动此缺陷"));

        // 验证目标文件夹存在（如果指定了文件夹）
        if (!string.IsNullOrEmpty(request.FolderId))
        {
            var folderExists = await _db.DefectFolders.Find(x => x.Id == request.FolderId).AnyAsync(ct);
            if (!folderExists)
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "目标文件夹不存在"));
        }

        defect.FolderId = string.IsNullOrEmpty(request.FolderId) ? null : request.FolderId;
        defect.UpdatedAt = DateTime.UtcNow;

        await _db.DefectReports.ReplaceOneAsync(x => x.Id == id, defect, cancellationToken: ct);

        _logger.LogInformation("[{AppKey}] Defect {DefectNo} moved to folder {FolderId}", AppKey, defect.DefectNo, request.FolderId ?? "root");

        return Ok(ApiResponse<object>.Ok(new { defect }));
    }

    /// <summary>
    /// 批量移动缺陷到文件夹
    /// </summary>
    [HttpPost("defects/batch-move")]
    public async Task<IActionResult> BatchMoveDefects([FromBody] BatchMoveDefectsRequest request, CancellationToken ct)
    {
        var userId = GetUserId();
        var isAdmin = HasManagePermission();

        if (request.DefectIds == null || request.DefectIds.Count == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请选择要移动的缺陷"));

        // 验证目标文件夹存在（如果指定了文件夹）
        if (!string.IsNullOrEmpty(request.FolderId))
        {
            var folderExists = await _db.DefectFolders.Find(x => x.Id == request.FolderId).AnyAsync(ct);
            if (!folderExists)
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "目标文件夹不存在"));
        }

        var filterBuilder = Builders<DefectReport>.Filter;
        var filter = filterBuilder.In(x => x.Id, request.DefectIds);

        // 非管理员只能移动自己的缺陷
        if (!isAdmin)
        {
            filter = filterBuilder.And(filter, filterBuilder.Or(
                filterBuilder.Eq(x => x.ReporterId, userId),
                filterBuilder.Eq(x => x.AssigneeId, userId)
            ));
        }

        var update = Builders<DefectReport>.Update
            .Set(x => x.FolderId, string.IsNullOrEmpty(request.FolderId) ? null : request.FolderId)
            .Set(x => x.UpdatedAt, DateTime.UtcNow);

        var result = await _db.DefectReports.UpdateManyAsync(filter, update, cancellationToken: ct);

        _logger.LogInformation("[{AppKey}] Batch moved {Count} defects to folder {FolderId}",
            AppKey, result.ModifiedCount, request.FolderId ?? "root");

        return Ok(ApiResponse<object>.Ok(new { movedCount = result.ModifiedCount }));
    }

    #endregion
}

#region Request DTOs

public class CreateTemplateRequest
{
    public string Name { get; set; } = string.Empty;
    public string? Description { get; set; }
    public List<DefectTemplateField>? RequiredFields { get; set; }
    public string? AiSystemPrompt { get; set; }
    public bool IsDefault { get; set; }
}

public class UpdateTemplateRequest
{
    public string? Name { get; set; }
    public string? Description { get; set; }
    public List<DefectTemplateField>? RequiredFields { get; set; }
    public string? AiSystemPrompt { get; set; }
    public bool? IsDefault { get; set; }
}

public class CreateDefectRequest
{
    public string? TemplateId { get; set; }
    public string? Title { get; set; }
    public string? Content { get; set; }
    public string? AssigneeUserId { get; set; }
    public string? Severity { get; set; }
    public string? Priority { get; set; }
}

public class UpdateDefectRequest
{
    public string? Title { get; set; }
    public string? Content { get; set; }
    public Dictionary<string, string>? StructuredData { get; set; }
    public string? ChangeNote { get; set; }
}

public class PolishDefectRequest
{
    public string Content { get; set; } = string.Empty;
    public string? TemplateId { get; set; }
}

public class AssignDefectRequest
{
    public string AssigneeId { get; set; } = string.Empty;
}

public class ResolveDefectRequest
{
    public string? Resolution { get; set; }
}

public class RejectDefectRequest
{
    public string Reason { get; set; } = string.Empty;
}

public class DefectSendMessageRequest
{
    public string Content { get; set; } = string.Empty;
    public List<string>? AttachmentIds { get; set; }
}

public class CreateFolderRequest
{
    public string Name { get; set; } = string.Empty;
    public string? Description { get; set; }
    public string? Color { get; set; }
    public string? Icon { get; set; }
    public int SortOrder { get; set; } = 0;
}

public class UpdateFolderRequest
{
    public string? Name { get; set; }
    public string? Description { get; set; }
    public string? Color { get; set; }
    public string? Icon { get; set; }
    public int? SortOrder { get; set; }
}

public class MoveDefectRequest
{
    /// <summary>目标文件夹 ID（null 或空字符串表示移到根目录）</summary>
    public string? FolderId { get; set; }
}

public class BatchMoveDefectsRequest
{
    public List<string> DefectIds { get; set; } = new();
    /// <summary>目标文件夹 ID（null 或空字符串表示移到根目录）</summary>
    public string? FolderId { get; set; }
}

#endregion
