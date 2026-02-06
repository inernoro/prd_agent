using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 教程邮件管理：序列配置、模板管理、素材上传、用户订阅
/// </summary>
[ApiController]
[Route("api/tutorial-email")]
[Authorize]
[AdminController("tutorial-email", AdminPermissionCatalog.TutorialEmailRead, WritePermission = AdminPermissionCatalog.TutorialEmailWrite)]
public sealed class TutorialEmailController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly ITutorialEmailService _emailService;
    private readonly ILogger<TutorialEmailController> _logger;

    public TutorialEmailController(
        MongoDbContext db,
        ITutorialEmailService emailService,
        ILogger<TutorialEmailController> logger)
    {
        _db = db;
        _emailService = emailService;
        _logger = logger;
    }

    private string? GetUserId() => User.FindFirst("userId")?.Value ?? User.FindFirst("sub")?.Value;

    // ========== 序列管理 ==========

    [HttpGet("sequences")]
    public async Task<IActionResult> ListSequences(CancellationToken ct)
    {
        var items = await _db.TutorialEmailSequences
            .Find(Builders<TutorialEmailSequence>.Filter.Empty)
            .SortByDescending(x => x.CreatedAt)
            .ToListAsync(ct);

        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    [HttpGet("sequences/{id}")]
    public async Task<IActionResult> GetSequence(string id, CancellationToken ct)
    {
        var item = await _db.TutorialEmailSequences.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (item == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "序列不存在"));

        return Ok(ApiResponse<object>.Ok(item));
    }

    [HttpPost("sequences")]
    public async Task<IActionResult> CreateSequence([FromBody] CreateSequenceRequest req, CancellationToken ct)
    {
        var key = (req.SequenceKey ?? "").Trim();
        if (string.IsNullOrWhiteSpace(key))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "sequenceKey 不能为空"));

        // 检查 key 唯一性
        var existing = await _db.TutorialEmailSequences.Find(x => x.SequenceKey == key).FirstOrDefaultAsync(ct);
        if (existing != null)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, $"sequenceKey '{key}' 已存在"));

        var sequence = new TutorialEmailSequence
        {
            SequenceKey = key,
            Name = (req.Name ?? "").Trim(),
            Description = req.Description?.Trim(),
            TriggerType = (req.TriggerType ?? "manual").Trim(),
            Steps = req.Steps ?? new List<TutorialEmailStep>(),
            IsActive = req.IsActive ?? true,
            CreatedBy = GetUserId(),
        };

        await _db.TutorialEmailSequences.InsertOneAsync(sequence, cancellationToken: ct);
        return Ok(ApiResponse<object>.Ok(sequence));
    }

    [HttpPut("sequences/{id}")]
    public async Task<IActionResult> UpdateSequence(string id, [FromBody] UpdateSequenceRequest req, CancellationToken ct)
    {
        var item = await _db.TutorialEmailSequences.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (item == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "序列不存在"));

        var update = Builders<TutorialEmailSequence>.Update
            .Set(x => x.UpdatedAt, DateTime.UtcNow);

        if (req.Name != null) update = update.Set(x => x.Name, req.Name.Trim());
        if (req.Description != null) update = update.Set(x => x.Description, req.Description.Trim());
        if (req.TriggerType != null) update = update.Set(x => x.TriggerType, req.TriggerType.Trim());
        if (req.Steps != null) update = update.Set(x => x.Steps, req.Steps);
        if (req.IsActive.HasValue) update = update.Set(x => x.IsActive, req.IsActive.Value);

        await _db.TutorialEmailSequences.UpdateOneAsync(x => x.Id == id, update, cancellationToken: ct);

        var updated = await _db.TutorialEmailSequences.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        return Ok(ApiResponse<object>.Ok(updated));
    }

    [HttpDelete("sequences/{id}")]
    public async Task<IActionResult> DeleteSequence(string id, CancellationToken ct)
    {
        var result = await _db.TutorialEmailSequences.DeleteOneAsync(x => x.Id == id, ct);
        if (result.DeletedCount == 0)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "序列不存在"));

        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    // ========== 模板管理 ==========

    [HttpGet("templates")]
    public async Task<IActionResult> ListTemplates(CancellationToken ct)
    {
        var items = await _db.TutorialEmailTemplates
            .Find(Builders<TutorialEmailTemplate>.Filter.Empty)
            .SortByDescending(x => x.CreatedAt)
            .ToListAsync(ct);

        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    [HttpGet("templates/{id}")]
    public async Task<IActionResult> GetTemplate(string id, CancellationToken ct)
    {
        var item = await _db.TutorialEmailTemplates.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (item == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "模板不存在"));

        return Ok(ApiResponse<object>.Ok(item));
    }

    [HttpPost("templates")]
    public async Task<IActionResult> CreateTemplate([FromBody] CreateTemplateRequest req, CancellationToken ct)
    {
        var template = new TutorialEmailTemplate
        {
            Name = (req.Name ?? "").Trim(),
            HtmlContent = req.HtmlContent ?? "",
            Variables = req.Variables ?? new List<string>(),
            AssetIds = req.AssetIds ?? new List<string>(),
            ThumbnailUrl = req.ThumbnailUrl?.Trim(),
            CreatedBy = GetUserId(),
        };

        await _db.TutorialEmailTemplates.InsertOneAsync(template, cancellationToken: ct);
        return Ok(ApiResponse<object>.Ok(template));
    }

    [HttpPut("templates/{id}")]
    public async Task<IActionResult> UpdateTemplate(string id, [FromBody] UpdateTemplateRequest req, CancellationToken ct)
    {
        var item = await _db.TutorialEmailTemplates.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (item == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "模板不存在"));

        var update = Builders<TutorialEmailTemplate>.Update
            .Set(x => x.UpdatedAt, DateTime.UtcNow);

        if (req.Name != null) update = update.Set(x => x.Name, req.Name.Trim());
        if (req.HtmlContent != null) update = update.Set(x => x.HtmlContent, req.HtmlContent);
        if (req.Variables != null) update = update.Set(x => x.Variables, req.Variables);
        if (req.AssetIds != null) update = update.Set(x => x.AssetIds, req.AssetIds);
        if (req.ThumbnailUrl != null) update = update.Set(x => x.ThumbnailUrl, req.ThumbnailUrl.Trim());

        await _db.TutorialEmailTemplates.UpdateOneAsync(x => x.Id == id, update, cancellationToken: ct);

        var updated = await _db.TutorialEmailTemplates.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        return Ok(ApiResponse<object>.Ok(updated));
    }

    [HttpDelete("templates/{id}")]
    public async Task<IActionResult> DeleteTemplate(string id, CancellationToken ct)
    {
        var result = await _db.TutorialEmailTemplates.DeleteOneAsync(x => x.Id == id, ct);
        if (result.DeletedCount == 0)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "模板不存在"));

        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    // ========== 素材管理 ==========

    [HttpGet("assets")]
    public async Task<IActionResult> ListAssets([FromQuery] string? tag, CancellationToken ct)
    {
        var filter = Builders<TutorialEmailAsset>.Filter.Empty;
        if (!string.IsNullOrWhiteSpace(tag))
        {
            filter = Builders<TutorialEmailAsset>.Filter.AnyEq(x => x.Tags, tag.Trim());
        }

        var items = await _db.TutorialEmailAssets
            .Find(filter)
            .SortByDescending(x => x.UploadedAt)
            .Limit(200)
            .ToListAsync(ct);

        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    [HttpPost("assets")]
    public async Task<IActionResult> CreateAsset([FromBody] CreateAssetRequest req, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(req.FileUrl))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "fileUrl 不能为空"));

        var asset = new TutorialEmailAsset
        {
            FileName = (req.FileName ?? "").Trim(),
            FileUrl = req.FileUrl.Trim(),
            Tags = req.Tags ?? new List<string>(),
            FileSize = req.FileSize ?? 0,
            ContentType = req.ContentType?.Trim(),
            UploadedBy = GetUserId(),
        };

        await _db.TutorialEmailAssets.InsertOneAsync(asset, cancellationToken: ct);
        return Ok(ApiResponse<object>.Ok(asset));
    }

    [HttpDelete("assets/{id}")]
    public async Task<IActionResult> DeleteAsset(string id, CancellationToken ct)
    {
        var result = await _db.TutorialEmailAssets.DeleteOneAsync(x => x.Id == id, ct);
        if (result.DeletedCount == 0)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "素材不存在"));

        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    // ========== 订阅管理 ==========

    [HttpGet("enrollments")]
    public async Task<IActionResult> ListEnrollments(
        [FromQuery] string? sequenceKey,
        [FromQuery] string? status,
        CancellationToken ct)
    {
        var filter = Builders<TutorialEmailEnrollment>.Filter.Empty;
        if (!string.IsNullOrWhiteSpace(sequenceKey))
            filter &= Builders<TutorialEmailEnrollment>.Filter.Eq(x => x.SequenceKey, sequenceKey.Trim());
        if (!string.IsNullOrWhiteSpace(status))
            filter &= Builders<TutorialEmailEnrollment>.Filter.Eq(x => x.Status, status.Trim());

        var items = await _db.TutorialEmailEnrollments
            .Find(filter)
            .SortByDescending(x => x.EnrolledAt)
            .Limit(200)
            .ToListAsync(ct);

        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    [HttpPost("enrollments")]
    public async Task<IActionResult> EnrollUser([FromBody] EnrollUserRequest req, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(req.UserId))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "userId 不能为空"));
        if (string.IsNullOrWhiteSpace(req.Email))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "email 不能为空"));
        if (string.IsNullOrWhiteSpace(req.SequenceKey))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "sequenceKey 不能为空"));

        var enrollment = await _emailService.EnrollUserAsync(req.UserId.Trim(), req.Email.Trim(), req.SequenceKey.Trim(), ct);
        if (enrollment == null)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "序列不存在或无步骤"));

        return Ok(ApiResponse<object>.Ok(enrollment));
    }

    [HttpPost("enrollments/{id}/unsubscribe")]
    public async Task<IActionResult> Unsubscribe(string id, CancellationToken ct)
    {
        var update = Builders<TutorialEmailEnrollment>.Update
            .Set(x => x.Status, "unsubscribed")
            .Set(x => x.NextSendAt, null)
            .Set(x => x.UpdatedAt, DateTime.UtcNow);

        var result = await _db.TutorialEmailEnrollments.UpdateOneAsync(x => x.Id == id, update, cancellationToken: ct);
        if (result.MatchedCount == 0)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "订阅记录不存在"));

        return Ok(ApiResponse<object>.Ok(new { unsubscribed = true }));
    }

    /// <summary>
    /// 批量订阅：为所有有邮箱的活跃用户注册指定序列
    /// </summary>
    [HttpPost("enrollments/batch")]
    public async Task<IActionResult> BatchEnroll([FromBody] BatchEnrollRequest req, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(req.SequenceKey))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "sequenceKey 不能为空"));

        var sequenceKey = req.SequenceKey.Trim();

        // 找到所有活跃用户且有邮箱且已订阅教程邮件
        var users = await _db.Users
            .Find(u => u.Status == UserStatus.Active
                    && u.Email != null
                    && u.Email != ""
                    && u.TutorialEmailOptIn
                    && u.UserType == UserType.Human)
            .ToListAsync(ct);

        var enrolled = 0;
        var skipped = 0;

        foreach (var user in users)
        {
            var result = await _emailService.EnrollUserAsync(user.UserId, user.Email!, sequenceKey, ct);
            if (result != null) enrolled++;
            else skipped++;
        }

        return Ok(ApiResponse<object>.Ok(new { enrolled, skipped, total = users.Count }));
    }

    /// <summary>
    /// 发送测试邮件（用于预览模板效果）
    /// </summary>
    [HttpPost("test-send")]
    public async Task<IActionResult> TestSend([FromBody] TestSendRequest req, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(req.Email))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "email 不能为空"));
        if (string.IsNullOrWhiteSpace(req.TemplateId))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "templateId 不能为空"));

        var template = await _db.TutorialEmailTemplates.Find(x => x.Id == req.TemplateId.Trim()).FirstOrDefaultAsync(ct);
        if (template == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "模板不存在"));

        var success = await _emailService.SendEmailAsync(
            req.Email.Trim(),
            req.Name?.Trim() ?? "测试用户",
            req.Subject?.Trim() ?? $"[测试] {template.Name}",
            template.HtmlContent,
            ct);

        return Ok(ApiResponse<object>.Ok(new { success }));
    }

    // ========== Request DTOs ==========

    public class CreateSequenceRequest
    {
        public string? SequenceKey { get; set; }
        public string? Name { get; set; }
        public string? Description { get; set; }
        public string? TriggerType { get; set; }
        public List<TutorialEmailStep>? Steps { get; set; }
        public bool? IsActive { get; set; }
    }

    public class UpdateSequenceRequest
    {
        public string? Name { get; set; }
        public string? Description { get; set; }
        public string? TriggerType { get; set; }
        public List<TutorialEmailStep>? Steps { get; set; }
        public bool? IsActive { get; set; }
    }

    public class CreateTemplateRequest
    {
        public string? Name { get; set; }
        public string? HtmlContent { get; set; }
        public List<string>? Variables { get; set; }
        public List<string>? AssetIds { get; set; }
        public string? ThumbnailUrl { get; set; }
    }

    public class UpdateTemplateRequest
    {
        public string? Name { get; set; }
        public string? HtmlContent { get; set; }
        public List<string>? Variables { get; set; }
        public List<string>? AssetIds { get; set; }
        public string? ThumbnailUrl { get; set; }
    }

    public class CreateAssetRequest
    {
        public string? FileName { get; set; }
        public string? FileUrl { get; set; }
        public List<string>? Tags { get; set; }
        public long? FileSize { get; set; }
        public string? ContentType { get; set; }
    }

    public class EnrollUserRequest
    {
        public string? UserId { get; set; }
        public string? Email { get; set; }
        public string? SequenceKey { get; set; }
    }

    public class BatchEnrollRequest
    {
        public string? SequenceKey { get; set; }
    }

    public class TestSendRequest
    {
        public string? Email { get; set; }
        public string? Name { get; set; }
        public string? Subject { get; set; }
        public string? TemplateId { get; set; }
    }
}
