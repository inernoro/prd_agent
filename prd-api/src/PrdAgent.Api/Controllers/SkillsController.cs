using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Controllers;

/// <summary>
/// 技能管理：内置技能 + 用户自定义技能
/// </summary>
[ApiController]
[Route("api/v1/skills")]
[Authorize]
public class SkillsController : ControllerBase
{
    private readonly ISkillService _skillService;

    public SkillsController(ISkillService skillService)
    {
        _skillService = skillService;
    }

    private static string? GetUserId(ClaimsPrincipal user)
        => user.FindFirst("sub")?.Value ?? user.FindFirst(ClaimTypes.NameIdentifier)?.Value;

    /// <summary>
    /// 获取当前用户可用的技能列表（内置 + 用户自建）
    /// </summary>
    [HttpGet]
    [AllowAnonymous]
    [ProducesResponseType(typeof(ApiResponse<SkillsListResponse>), StatusCodes.Status200OK)]
    public async Task<IActionResult> GetSkills([FromQuery] string? role, CancellationToken ct)
    {
        var userId = GetUserId(User);
        var skills = await _skillService.GetAvailableSkillsAsync(userId, role, ct);

        var items = skills.Select(s => new SkillClientItem
        {
            Id = s.Id,
            Title = s.Title,
            Description = s.Description,
            Icon = s.Icon,
            Category = s.Category,
            Order = s.Order,
            IsBuiltIn = s.IsBuiltIn,
            AllowedRoles = s.AllowedRoles,
            // 用户自建技能返回模板（用于编辑），内置技能不返回模板内容
            SystemPromptTemplate = s.IsBuiltIn ? null : s.SystemPromptTemplate,
            UserPromptTemplate = s.IsBuiltIn ? null : s.UserPromptTemplate,
        }).ToList();

        return Ok(ApiResponse<SkillsListResponse>.Ok(new SkillsListResponse { Skills = items }));
    }

    /// <summary>
    /// 获取单个技能详情
    /// </summary>
    [HttpGet("{skillId}")]
    [ProducesResponseType(typeof(ApiResponse<SkillClientItem>), StatusCodes.Status200OK)]
    public async Task<IActionResult> GetSkill(string skillId, CancellationToken ct)
    {
        var skill = await _skillService.GetByIdAsync(skillId, ct);
        if (skill == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "技能不存在"));

        var userId = GetUserId(User);
        // 内置技能不返回模板；非 owner 不返回模板
        var showTemplate = !skill.IsBuiltIn && skill.OwnerUserId == userId;

        var item = new SkillClientItem
        {
            Id = skill.Id,
            Title = skill.Title,
            Description = skill.Description,
            Icon = skill.Icon,
            Category = skill.Category,
            Order = skill.Order,
            IsBuiltIn = skill.IsBuiltIn,
            AllowedRoles = skill.AllowedRoles,
            SystemPromptTemplate = showTemplate ? skill.SystemPromptTemplate : null,
            UserPromptTemplate = showTemplate ? skill.UserPromptTemplate : null,
        };

        return Ok(ApiResponse<SkillClientItem>.Ok(item));
    }

    /// <summary>
    /// 创建用户自定义技能
    /// </summary>
    [HttpPost]
    [ProducesResponseType(typeof(ApiResponse<SkillClientItem>), StatusCodes.Status200OK)]
    public async Task<IActionResult> CreateSkill([FromBody] CreateSkillRequest request, CancellationToken ct)
    {
        var userId = GetUserId(User);
        if (string.IsNullOrWhiteSpace(userId))
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "未授权"));

        if (string.IsNullOrWhiteSpace(request.Title))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "技能名称不能为空"));

        var skill = new Skill
        {
            Title = request.Title.Trim(),
            Description = (request.Description ?? "").Trim(),
            Icon = request.Icon?.Trim(),
            Category = (request.Category ?? "general").Trim(),
            Order = request.Order,
            SystemPromptTemplate = (request.SystemPromptTemplate ?? "").Trim(),
            UserPromptTemplate = (request.UserPromptTemplate ?? "").Trim(),
            AllowedRoles = request.AllowedRoles ?? new List<string>(),
            OwnerUserId = userId,
        };

        var created = await _skillService.CreateAsync(skill, ct);

        var item = new SkillClientItem
        {
            Id = created.Id,
            Title = created.Title,
            Description = created.Description,
            Icon = created.Icon,
            Category = created.Category,
            Order = created.Order,
            IsBuiltIn = false,
            AllowedRoles = created.AllowedRoles,
            SystemPromptTemplate = created.SystemPromptTemplate,
            UserPromptTemplate = created.UserPromptTemplate,
        };

        return Ok(ApiResponse<SkillClientItem>.Ok(item));
    }

    /// <summary>
    /// 更新用户自定义技能（仅 owner）
    /// </summary>
    [HttpPut("{skillId}")]
    [ProducesResponseType(typeof(ApiResponse<SkillClientItem>), StatusCodes.Status200OK)]
    public async Task<IActionResult> UpdateSkill(string skillId, [FromBody] UpdateSkillRequest request, CancellationToken ct)
    {
        var userId = GetUserId(User);
        if (string.IsNullOrWhiteSpace(userId))
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "未授权"));

        if (string.IsNullOrWhiteSpace(request.Title))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "技能名称不能为空"));

        var updates = new Skill
        {
            Title = request.Title.Trim(),
            Description = (request.Description ?? "").Trim(),
            Icon = request.Icon?.Trim(),
            Category = (request.Category ?? "general").Trim(),
            Order = request.Order,
            SystemPromptTemplate = (request.SystemPromptTemplate ?? "").Trim(),
            UserPromptTemplate = (request.UserPromptTemplate ?? "").Trim(),
            AllowedRoles = request.AllowedRoles ?? new List<string>(),
        };

        var updated = await _skillService.UpdateAsync(skillId, userId, updates, ct);
        if (updated == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "技能不存在或无权修改"));

        var item = new SkillClientItem
        {
            Id = updated.Id,
            Title = updated.Title,
            Description = updated.Description,
            Icon = updated.Icon,
            Category = updated.Category,
            Order = updated.Order,
            IsBuiltIn = false,
            AllowedRoles = updated.AllowedRoles,
            SystemPromptTemplate = updated.SystemPromptTemplate,
            UserPromptTemplate = updated.UserPromptTemplate,
        };

        return Ok(ApiResponse<SkillClientItem>.Ok(item));
    }

    /// <summary>
    /// 删除用户自定义技能（仅 owner，内置技能不可删除）
    /// </summary>
    [HttpDelete("{skillId}")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> DeleteSkill(string skillId, CancellationToken ct)
    {
        var userId = GetUserId(User);
        if (string.IsNullOrWhiteSpace(userId))
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "未授权"));

        var ok = await _skillService.DeleteAsync(skillId, userId, ct);
        if (!ok)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "技能不存在或无权删除"));

        return Ok(ApiResponse<object>.Ok(null));
    }
}

// ── DTO ──

public class SkillsListResponse
{
    public List<SkillClientItem> Skills { get; set; } = new();
}

public class SkillClientItem
{
    public string Id { get; set; } = string.Empty;
    public string Title { get; set; } = string.Empty;
    public string Description { get; set; } = string.Empty;
    public string? Icon { get; set; }
    public string Category { get; set; } = "general";
    public int Order { get; set; }
    public bool IsBuiltIn { get; set; }
    public List<string> AllowedRoles { get; set; } = new();
    public string? SystemPromptTemplate { get; set; }
    public string? UserPromptTemplate { get; set; }
}

public class CreateSkillRequest
{
    public string Title { get; set; } = string.Empty;
    public string? Description { get; set; }
    public string? Icon { get; set; }
    public string? Category { get; set; }
    public int Order { get; set; }
    public string? SystemPromptTemplate { get; set; }
    public string? UserPromptTemplate { get; set; }
    public List<string>? AllowedRoles { get; set; }
}

public class UpdateSkillRequest
{
    public string Title { get; set; } = string.Empty;
    public string? Description { get; set; }
    public string? Icon { get; set; }
    public string? Category { get; set; }
    public int Order { get; set; }
    public string? SystemPromptTemplate { get; set; }
    public string? UserPromptTemplate { get; set; }
    public List<string>? AllowedRoles { get; set; }
}
