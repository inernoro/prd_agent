using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using System.Security.Claims;

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
    private readonly ILogger<DefectAgentController> _logger;

    public DefectAgentController(MongoDbContext db, ILogger<DefectAgentController> logger)
    {
        _db = db;
        _logger = logger;
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
        [FromQuery] bool? mine,
        [FromQuery] int page = 1,
        [FromQuery] int pageSize = 20,
        CancellationToken ct = default)
    {
        var userId = GetUserId();
        var isAdmin = HasManagePermission();

        var filterBuilder = Builders<DefectReport>.Filter;
        var filters = new List<FilterDefinition<DefectReport>>();

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
        var username = GetUsername();

        // 生成缺陷编号
        var defectNo = await GenerateDefectNo(ct);

        var defect = new DefectReport
        {
            Id = Guid.NewGuid().ToString("N"),
            DefectNo = defectNo,
            TemplateId = request.TemplateId,
            Title = request.Title?.Trim(),
            RawContent = request.Content?.Trim() ?? string.Empty,
            Status = DefectStatus.Draft,
            ReporterId = userId,
            ReporterName = username,
            CreatedAt = DateTime.UtcNow,
            UpdatedAt = DateTime.UtcNow
        };

        await _db.DefectReports.InsertOneAsync(defect, cancellationToken: ct);

        _logger.LogInformation("[{AppKey}] Defect created: {DefectNo} by {UserId}", AppKey, defectNo, userId);

        return Ok(ApiResponse<object>.Ok(new { defect }));
    }

    /// <summary>
    /// 更新缺陷
    /// </summary>
    [HttpPut("defects/{id}")]
    public async Task<IActionResult> UpdateDefect(string id, [FromBody] UpdateDefectRequest request, CancellationToken ct)
    {
        var userId = GetUserId();

        var defect = await _db.DefectReports.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (defect == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "缺陷不存在"));

        // 只有报告人可以编辑草稿/待补充状态的缺陷
        if (defect.ReporterId != userId)
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限编辑此缺陷"));

        if (defect.Status != DefectStatus.Draft && defect.Status != DefectStatus.Awaiting)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "只能编辑草稿或待补充状态的缺陷"));

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
    /// 删除缺陷（仅草稿可删除）
    /// </summary>
    [HttpDelete("defects/{id}")]
    public async Task<IActionResult> DeleteDefect(string id, CancellationToken ct)
    {
        var userId = GetUserId();

        var defect = await _db.DefectReports.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (defect == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "缺陷不存在"));

        if (defect.ReporterId != userId)
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限删除此缺陷"));

        if (defect.Status != DefectStatus.Draft)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "只能删除草稿状态的缺陷"));

        // 删除关联的消息
        await _db.DefectMessages.DeleteManyAsync(x => x.DefectId == id, ct);
        await _db.DefectReports.DeleteOneAsync(x => x.Id == id, ct);

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
        defect.AssigneeName = assignee.DisplayName ?? assignee.Username;
        defect.Status = DefectStatus.Assigned;
        defect.AssignedAt = DateTime.UtcNow;
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

        var defect = await _db.DefectReports.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (defect == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "缺陷不存在"));

        // 只有被指派人可以标记解决
        if (defect.AssigneeId != userId)
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "只有被指派人可以标记解决"));

        if (defect.Status != DefectStatus.Processing && defect.Status != DefectStatus.Assigned)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "只能解决处理中或已指派状态的缺陷"));

        defect.Status = DefectStatus.Resolved;
        defect.Resolution = request.Resolution?.Trim();
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

        var defect = await _db.DefectReports.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (defect == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "缺陷不存在"));

        // 只有被指派人可以拒绝
        if (defect.AssigneeId != userId)
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "只有被指派人可以拒绝"));

        if (defect.Status != DefectStatus.Processing && defect.Status != DefectStatus.Assigned)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "只能拒绝处理中或已指派状态的缺陷"));

        if (string.IsNullOrWhiteSpace(request.Reason))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "拒绝原因不能为空"));

        defect.Status = DefectStatus.Rejected;
        defect.RejectReason = request.Reason.Trim();
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
        if (!HasManagePermission())
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限关闭缺陷"));

        var defect = await _db.DefectReports.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (defect == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "缺陷不存在"));

        if (defect.Status != DefectStatus.Resolved && defect.Status != DefectStatus.Rejected)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "只能关闭已解决或已拒绝状态的缺陷"));

        defect.Status = DefectStatus.Closed;
        defect.ClosedAt = DateTime.UtcNow;
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

        if (defect.Status != DefectStatus.Closed && defect.Status != DefectStatus.Rejected && defect.Status != DefectStatus.Resolved)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "只能重新打开已关闭、已拒绝或已解决状态的缺陷"));

        // 如果有指派人，回到已指派状态；否则回到已提交状态
        defect.Status = string.IsNullOrEmpty(defect.AssigneeId) ? DefectStatus.Submitted : DefectStatus.Assigned;
        defect.Resolution = null;
        defect.RejectReason = null;
        defect.ResolvedAt = null;
        defect.ClosedAt = null;
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

        if (string.IsNullOrWhiteSpace(request.Content))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "消息内容不能为空"));

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
            Content = request.Content.Trim(),
            AttachmentIds = request.AttachmentIds,
            CreatedAt = DateTime.UtcNow
        };

        await _db.DefectMessages.InsertOneAsync(message, cancellationToken: ct);

        // 更新缺陷的 rawContent（追加）
        defect.RawContent = string.IsNullOrEmpty(defect.RawContent)
            ? request.Content.Trim()
            : defect.RawContent + "\n\n" + request.Content.Trim();
        defect.UpdatedAt = DateTime.UtcNow;

        await _db.DefectReports.ReplaceOneAsync(x => x.Id == id, defect, cancellationToken: ct);

        return Ok(ApiResponse<object>.Ok(new { message, defect }));
    }

    #endregion

    #region 附件上传

    /// <summary>
    /// 添加附件到缺陷
    /// </summary>
    [HttpPost("defects/{id}/attachments")]
    public async Task<IActionResult> AddAttachment(string id, [FromBody] AddAttachmentRequest request, CancellationToken ct)
    {
        var userId = GetUserId();

        var defect = await _db.DefectReports.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (defect == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "缺陷不存在"));

        if (defect.ReporterId != userId)
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限添加附件"));

        var attachment = new DefectAttachment
        {
            Id = Guid.NewGuid().ToString("N"),
            FileName = request.FileName,
            FileSize = request.FileSize,
            MimeType = request.MimeType,
            CosUrl = request.CosUrl,
            ThumbnailUrl = request.ThumbnailUrl,
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
}

public class UpdateDefectRequest
{
    public string? Title { get; set; }
    public string? Content { get; set; }
    public Dictionary<string, string>? StructuredData { get; set; }
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

public class AddAttachmentRequest
{
    public string FileName { get; set; } = string.Empty;
    public long FileSize { get; set; }
    public string MimeType { get; set; } = string.Empty;
    public string CosUrl { get; set; } = string.Empty;
    public string? ThumbnailUrl { get; set; }
}

#endregion
