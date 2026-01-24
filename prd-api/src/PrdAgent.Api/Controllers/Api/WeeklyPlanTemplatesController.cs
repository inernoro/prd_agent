using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using System.Security.Claims;
using PrdAgent.Core.Security;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 周计划 Agent - 模板管理（Admin 专用）
/// </summary>
[ApiController]
[Route("api/weekly-plan-agent/templates")]
[Authorize]
[AdminController("weekly-plan-agent", AdminPermissionCatalog.WeeklyPlanAgentUse, WritePermission = AdminPermissionCatalog.WeeklyPlanAgentManage)]
public class WeeklyPlanTemplatesController : ControllerBase
{
    private readonly MongoDbContext _db;

    public WeeklyPlanTemplatesController(MongoDbContext db)
    {
        _db = db;
    }

    private string GetAdminId()
        => User.FindFirst("sub")?.Value
           ?? User.FindFirst(ClaimTypes.NameIdentifier)?.Value
           ?? "unknown";

    /// <summary>
    /// 获取模板列表
    /// </summary>
    [HttpGet]
    public async Task<IActionResult> List([FromQuery] bool? activeOnly, CancellationToken ct)
    {
        var filter = Builders<WeeklyPlanTemplate>.Filter.Empty;
        if (activeOnly == true)
        {
            filter = Builders<WeeklyPlanTemplate>.Filter.Eq(x => x.IsActive, true);
        }

        var items = await _db.WeeklyPlanTemplates
            .Find(filter)
            .SortByDescending(x => x.IsBuiltIn)
            .ThenByDescending(x => x.UpdatedAt)
            .ToListAsync(ct);

        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    /// <summary>
    /// 创建模板
    /// </summary>
    [HttpPost]
    public async Task<IActionResult> Create([FromBody] CreateWeeklyPlanTemplateRequest request, CancellationToken ct)
    {
        var adminId = GetAdminId();

        if (string.IsNullOrWhiteSpace(request.Name))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "模板名称不能为空"));

        if (request.Sections == null || request.Sections.Count == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "模板至少需要一个段落"));

        var template = new WeeklyPlanTemplate
        {
            Id = Guid.NewGuid().ToString("N"),
            Name = request.Name.Trim(),
            Description = request.Description?.Trim() ?? string.Empty,
            Sections = request.Sections.Select((s, i) => new TemplateSectionDef
            {
                Id = string.IsNullOrWhiteSpace(s.Id) ? Guid.NewGuid().ToString("N") : s.Id,
                Title = s.Title?.Trim() ?? string.Empty,
                Type = s.Type ?? "text",
                Required = s.Required,
                Placeholder = s.Placeholder?.Trim(),
                MaxItems = s.MaxItems,
                Columns = s.Columns?.Select(c => new TableColumnDef
                {
                    Name = c.Name?.Trim() ?? string.Empty,
                    Type = c.Type ?? "text",
                    Options = c.Options,
                    Width = c.Width
                }).ToList(),
                Order = i
            }).ToList(),
            SubmitDeadline = request.SubmitDeadline?.Trim(),
            IsBuiltIn = false,
            IsActive = true,
            CreatedBy = adminId,
            CreatedAt = DateTime.UtcNow,
            UpdatedAt = DateTime.UtcNow
        };

        await _db.WeeklyPlanTemplates.InsertOneAsync(template, cancellationToken: ct);

        return Ok(ApiResponse<object>.Ok(new { template }));
    }

    /// <summary>
    /// 更新模板
    /// </summary>
    [HttpPut("{id}")]
    public async Task<IActionResult> Update(string id, [FromBody] UpdateWeeklyPlanTemplateRequest request, CancellationToken ct)
    {
        var template = await _db.WeeklyPlanTemplates.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (template == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "模板不存在"));

        if (!string.IsNullOrWhiteSpace(request.Name))
            template.Name = request.Name.Trim();
        if (request.Description != null)
            template.Description = request.Description.Trim();
        if (request.Sections != null && request.Sections.Count > 0)
        {
            template.Sections = request.Sections.Select((s, i) => new TemplateSectionDef
            {
                Id = string.IsNullOrWhiteSpace(s.Id) ? Guid.NewGuid().ToString("N") : s.Id,
                Title = s.Title?.Trim() ?? string.Empty,
                Type = s.Type ?? "text",
                Required = s.Required,
                Placeholder = s.Placeholder?.Trim(),
                MaxItems = s.MaxItems,
                Columns = s.Columns?.Select(c => new TableColumnDef
                {
                    Name = c.Name?.Trim() ?? string.Empty,
                    Type = c.Type ?? "text",
                    Options = c.Options,
                    Width = c.Width
                }).ToList(),
                Order = i
            }).ToList();
        }
        if (request.IsActive.HasValue)
            template.IsActive = request.IsActive.Value;
        if (request.SubmitDeadline != null)
            template.SubmitDeadline = request.SubmitDeadline.Trim();

        template.UpdatedAt = DateTime.UtcNow;

        await _db.WeeklyPlanTemplates.ReplaceOneAsync(x => x.Id == id, template, cancellationToken: ct);

        return Ok(ApiResponse<object>.Ok(new { template }));
    }

    /// <summary>
    /// 删除模板
    /// </summary>
    [HttpDelete("{id}")]
    public async Task<IActionResult> Delete(string id, CancellationToken ct)
    {
        var template = await _db.WeeklyPlanTemplates.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (template == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "模板不存在"));

        if (template.IsBuiltIn)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "内置模板不可删除"));

        await _db.WeeklyPlanTemplates.DeleteOneAsync(x => x.Id == id, ct);

        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    /// <summary>
    /// 初始化内置模板（幂等：已存在则跳过）
    /// </summary>
    [HttpPost("init")]
    public async Task<IActionResult> InitBuiltInTemplates(CancellationToken ct)
    {
        var adminId = GetAdminId();
        var existingCount = await _db.WeeklyPlanTemplates
            .CountDocumentsAsync(x => x.IsBuiltIn, cancellationToken: ct);

        if (existingCount > 0)
            return Ok(ApiResponse<object>.Ok(new { message = "内置模板已存在，跳过初始化", count = existingCount }));

        var builtInTemplates = WeeklyPlanBuiltInTemplates.GetAll(adminId);
        await _db.WeeklyPlanTemplates.InsertManyAsync(builtInTemplates, cancellationToken: ct);

        return Ok(ApiResponse<object>.Ok(new { message = $"已初始化 {builtInTemplates.Count} 个内置模板", count = builtInTemplates.Count }));
    }
}

// ===== Request DTOs =====

public class CreateWeeklyPlanTemplateRequest
{
    public string Name { get; set; } = string.Empty;
    public string? Description { get; set; }
    public List<TemplateSectionInput> Sections { get; set; } = new();
    public string? SubmitDeadline { get; set; }
}

public class UpdateWeeklyPlanTemplateRequest
{
    public string? Name { get; set; }
    public string? Description { get; set; }
    public List<TemplateSectionInput>? Sections { get; set; }
    public bool? IsActive { get; set; }
    public string? SubmitDeadline { get; set; }
}

public class TemplateSectionInput
{
    public string? Id { get; set; }
    public string? Title { get; set; }
    public string? Type { get; set; }
    public bool Required { get; set; }
    public string? Placeholder { get; set; }
    public int? MaxItems { get; set; }
    public List<TableColumnInput>? Columns { get; set; }
}

public class TableColumnInput
{
    public string? Name { get; set; }
    public string? Type { get; set; }
    public List<string>? Options { get; set; }
    public string? Width { get; set; }
}
