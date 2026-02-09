using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.Services;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 教程邮件管理：AI 生成模板、快速发送、序列配置、模板管理、用户订阅
/// </summary>
[ApiController]
[Route("api/tutorial-email")]
[Authorize]
[AdminController("tutorial-email", AdminPermissionCatalog.TutorialEmailRead, WritePermission = AdminPermissionCatalog.TutorialEmailWrite)]
public sealed class TutorialEmailController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly ITutorialEmailService _emailService;
    private readonly ILlmGateway _gateway;
    private readonly ILogger<TutorialEmailController> _logger;

    public TutorialEmailController(
        MongoDbContext db,
        ITutorialEmailService emailService,
        ILlmGateway gateway,
        ILogger<TutorialEmailController> logger)
    {
        _db = db;
        _emailService = emailService;
        _gateway = gateway;
        _logger = logger;
    }

    private string? GetUserId() => User.FindFirst("userId")?.Value ?? User.FindFirst("sub")?.Value;

    // ========== AI 生成 + 快速发送 ==========

    /// <summary>
    /// AI 生成邮件模板：输入主题描述，自动生成完整 HTML 邮件
    /// </summary>
    [HttpPost("generate")]
    public async Task<IActionResult> GenerateTemplate([FromBody] GenerateRequest req, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(req.Topic))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "topic 不能为空"));

        var systemPrompt = @"你是一名专业的邮件模板设计师。用户会给你一个邮件主题或描述，你需要生成一封精美的 HTML 邮件。

要求：
1. 生成完整的 HTML 邮件代码（可直接发送的邮件），使用内联样式（email 不支持外部 CSS）
2. 设计风格：现代、简洁、专业，渐变色头部，白色内容区
3. 移动端自适应（max-width: 600px，table 布局）
4. 包含以下变量占位符（用 {{变量名}} 格式）：
   - {{userName}} 用户名
   - {{productName}} 产品名
   - {{stepNumber}} 当前步骤
   - {{totalSteps}} 总步骤数
5. 包含 CTA 按钮（行动号召）
6. 包含截图占位区域（用灰色背景矩形 + 文字说明）
7. 底部包含退订提示
8. 只返回 HTML 代码，不要返回任何解释文字、markdown 标记或代码块标记

邮件语言：" + (req.Language ?? "中文");

        var userPrompt = req.Topic.Trim();
        if (!string.IsNullOrWhiteSpace(req.Style))
            userPrompt += $"\n\n设计风格偏好：{req.Style}";
        if (!string.IsNullOrWhiteSpace(req.ExtraRequirements))
            userPrompt += $"\n\n额外要求：{req.ExtraRequirements}";

        var gatewayRequest = new GatewayRequest
        {
            AppCallerCode = "tutorial-email.generate::chat",
            ModelType = "chat",
            RequestBody = new JsonObject
            {
                ["messages"] = new JsonArray
                {
                    new JsonObject { ["role"] = "system", ["content"] = systemPrompt },
                    new JsonObject { ["role"] = "user", ["content"] = userPrompt },
                },
                ["temperature"] = 0.7,
                ["max_tokens"] = 4096,
            },
        };

        var response = await _gateway.SendAsync(gatewayRequest, ct);
        if (!response.Success)
        {
            _logger.LogError("AI generate email failed: {Error}", response.ErrorMessage);
            return StatusCode(502, ApiResponse<object>.Fail("LLM_ERROR", response.ErrorMessage ?? "AI 生成失败"));
        }

        // response.Content 是原始 HTTP 响应体（OpenAI 格式 JSON），需要提取 choices[0].message.content
        var htmlContent = "";
        try
        {
            using var doc = System.Text.Json.JsonDocument.Parse(response.Content ?? "{}");
            htmlContent = doc.RootElement
                .GetProperty("choices")[0]
                .GetProperty("message")
                .GetProperty("content")
                .GetString() ?? "";
        }
        catch
        {
            // 如果解析失败，尝试直接使用（可能某些适配器已提取 content）
            htmlContent = (response.Content ?? "").Trim();
        }

        htmlContent = htmlContent.Trim();

        // 清理可能的 markdown 代码块包裹
        if (htmlContent.StartsWith("```"))
        {
            var firstNewline = htmlContent.IndexOf('\n');
            if (firstNewline > 0) htmlContent = htmlContent[(firstNewline + 1)..];
            if (htmlContent.EndsWith("```")) htmlContent = htmlContent[..^3].TrimEnd();
        }

        return Ok(ApiResponse<object>.Ok(new
        {
            htmlContent,
            model = response.Resolution?.ActualModel,
            tokens = response.TokenUsage?.TotalTokens,
        }));
    }

    /// <summary>
    /// 快速发送：AI 生成 → 自动保存模板 → 直接发送测试邮件，一步完成
    /// </summary>
    [HttpPost("quick-send")]
    public async Task<IActionResult> QuickSend([FromBody] QuickSendRequest req, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(req.Email))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "email 不能为空"));
        if (string.IsNullOrWhiteSpace(req.HtmlContent))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "htmlContent 不能为空"));

        // 1. 自动保存为模板
        TutorialEmailTemplate? savedTemplate = null;
        if (req.SaveAsTemplate == true)
        {
            savedTemplate = new TutorialEmailTemplate
            {
                Name = req.TemplateName?.Trim() ?? $"快速生成 - {DateTime.UtcNow:yyyy-MM-dd HH:mm}",
                HtmlContent = req.HtmlContent,
                Variables = new List<string> { "userName", "productName", "stepNumber", "totalSteps" },
                CreatedBy = GetUserId(),
            };
            await _db.TutorialEmailTemplates.InsertOneAsync(savedTemplate, cancellationToken: ct);
        }

        // 2. 发送邮件
        var subject = req.Subject?.Trim() ?? "产品教程";
        var success = await _emailService.SendEmailAsync(
            req.Email.Trim(),
            req.RecipientName?.Trim() ?? "用户",
            subject,
            req.HtmlContent,
            CancellationToken.None);

        return Ok(ApiResponse<object>.Ok(new
        {
            sent = success,
            templateId = savedTemplate?.Id,
            templateName = savedTemplate?.Name,
        }));
    }

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

    public class GenerateRequest
    {
        public string? Topic { get; set; }
        public string? Style { get; set; }
        public string? Language { get; set; }
        public string? ExtraRequirements { get; set; }
    }

    public class QuickSendRequest
    {
        public string? Email { get; set; }
        public string? RecipientName { get; set; }
        public string? Subject { get; set; }
        public string? HtmlContent { get; set; }
        public bool? SaveAsTemplate { get; set; }
        public string? TemplateName { get; set; }
    }
}
