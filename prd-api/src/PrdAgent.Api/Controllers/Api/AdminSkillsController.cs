using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 技能管理（Admin 后台 CRUD）
/// 管理 skills 集合中的系统/公共技能
/// </summary>
[ApiController]
[Route("api/skills")]
[Authorize]
[AdminController("skills", AdminPermissionCatalog.SkillsRead, WritePermission = AdminPermissionCatalog.SkillsWrite)]
public class AdminSkillsController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly ILogger<AdminSkillsController> _logger;

    public AdminSkillsController(MongoDbContext db, ILogger<AdminSkillsController> logger)
    {
        _db = db;
        _logger = logger;
    }

    /// <summary>
    /// 获取所有管理端技能（系统 + 公共，不含个人技能）
    /// </summary>
    [HttpGet]
    public async Task<IActionResult> List([FromQuery] string? visibility, CancellationToken ct)
    {
        var filter = Builders<Skill>.Filter.In(
            x => x.Visibility,
            new[] { SkillVisibility.System, SkillVisibility.Public }
        );

        if (!string.IsNullOrWhiteSpace(visibility))
        {
            filter = Builders<Skill>.Filter.Eq(x => x.Visibility, visibility.Trim());
        }

        var skills = await _db.Skills
            .Find(filter)
            .SortBy(x => x.Order)
            .ToListAsync(ct);

        return Ok(ApiResponse<object>.Ok(new { skills }));
    }

    /// <summary>
    /// 获取单个技能详情（含执行配置）
    /// </summary>
    [HttpGet("{skillKey}")]
    public async Task<IActionResult> GetByKey(string skillKey, CancellationToken ct)
    {
        var skill = await _db.Skills
            .Find(x => x.SkillKey == skillKey)
            .FirstOrDefaultAsync(ct);

        if (skill == null)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "技能不存在"));

        return Ok(ApiResponse<object>.Ok(skill));
    }

    /// <summary>
    /// 创建技能（系统或公共）
    /// </summary>
    [HttpPost]
    public async Task<IActionResult> Create([FromBody] AdminCreateSkillRequest request, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(request.Title))
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "技能名称不能为空"));

        var visibility = request.Visibility ?? SkillVisibility.System;
        if (visibility != SkillVisibility.System && visibility != SkillVisibility.Public)
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "管理端只能创建 system 或 public 技能"));

        // 检查 skillKey 唯一
        var skillKey = string.IsNullOrWhiteSpace(request.SkillKey)
            ? $"skill-{Guid.NewGuid():N}"[..20]
            : request.SkillKey.Trim();

        var existing = await _db.Skills.Find(x => x.SkillKey == skillKey).FirstOrDefaultAsync(ct);
        if (existing != null)
            return Conflict(ApiResponse<object>.Fail("DUPLICATE_KEY", $"skillKey '{skillKey}' 已存在"));

        var roles = new List<UserRole>();
        if (request.Roles != null)
        {
            foreach (var r in request.Roles)
            {
                if (Enum.TryParse<UserRole>(r, true, out var parsed))
                    roles.Add(parsed);
            }
        }

        var skill = new Skill
        {
            Id = Guid.NewGuid().ToString("N"),
            SkillKey = skillKey,
            Title = request.Title.Trim(),
            Description = (request.Description ?? "").Trim(),
            Icon = request.Icon,
            Category = request.Category ?? "general",
            Tags = request.Tags ?? new List<string>(),
            Visibility = visibility,
            IsBuiltIn = request.IsBuiltIn,
            IsEnabled = true,
            Roles = roles,
            Order = request.Order,
            Input = request.Input ?? new SkillInputConfig(),
            Execution = request.Execution ?? new SkillExecutionConfig(),
            Output = request.Output ?? new SkillOutputConfig(),
            CreatedAt = DateTime.UtcNow,
            UpdatedAt = DateTime.UtcNow,
        };

        await _db.Skills.InsertOneAsync(skill, cancellationToken: ct);

        _logger.LogInformation("Admin created skill: {SkillKey}, visibility={Visibility}", skillKey, visibility);

        return Ok(ApiResponse<object>.Ok(new { skillKey = skill.SkillKey }));
    }

    /// <summary>
    /// 更新技能
    /// </summary>
    [HttpPut("{skillKey}")]
    public async Task<IActionResult> Update(string skillKey, [FromBody] AdminCreateSkillRequest request, CancellationToken ct)
    {
        var filter = Builders<Skill>.Filter.Eq(x => x.SkillKey, skillKey);
        var existing = await _db.Skills.Find(filter).FirstOrDefaultAsync(ct);
        if (existing == null)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "技能不存在"));

        var roles = new List<UserRole>();
        if (request.Roles != null)
        {
            foreach (var r in request.Roles)
            {
                if (Enum.TryParse<UserRole>(r, true, out var parsed))
                    roles.Add(parsed);
            }
        }

        var update = Builders<Skill>.Update
            .Set(x => x.Title, (request.Title ?? existing.Title).Trim())
            .Set(x => x.Description, (request.Description ?? existing.Description).Trim())
            .Set(x => x.Icon, request.Icon ?? existing.Icon)
            .Set(x => x.Category, request.Category ?? existing.Category)
            .Set(x => x.Tags, request.Tags ?? existing.Tags)
            .Set(x => x.Roles, roles)
            .Set(x => x.Order, request.Order)
            .Set(x => x.IsEnabled, request.IsEnabled)
            .Set(x => x.IsBuiltIn, request.IsBuiltIn)
            .Set(x => x.Input, request.Input ?? existing.Input)
            .Set(x => x.Execution, request.Execution ?? existing.Execution)
            .Set(x => x.Output, request.Output ?? existing.Output)
            .Set(x => x.UpdatedAt, DateTime.UtcNow);

        if (!string.IsNullOrWhiteSpace(request.Visibility))
            update = update.Set(x => x.Visibility, request.Visibility);

        await _db.Skills.UpdateOneAsync(filter, update, cancellationToken: ct);

        _logger.LogInformation("Admin updated skill: {SkillKey}", skillKey);

        return Ok(ApiResponse<object>.Ok(new { skillKey }));
    }

    /// <summary>
    /// 删除技能
    /// </summary>
    [HttpDelete("{skillKey}")]
    public async Task<IActionResult> Delete(string skillKey, CancellationToken ct)
    {
        var filter = Builders<Skill>.Filter.Eq(x => x.SkillKey, skillKey);
        var result = await _db.Skills.DeleteOneAsync(filter, ct);

        if (result.DeletedCount == 0)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "技能不存在"));

        _logger.LogInformation("Admin deleted skill: {SkillKey}", skillKey);

        return Ok(ApiResponse<object>.Ok(new { }));
    }
}

/// <summary>Admin 技能创建/更新请求体</summary>
public class AdminCreateSkillRequest
{
    public string? SkillKey { get; set; }
    public string? Title { get; set; }
    public string? Description { get; set; }
    public string? Icon { get; set; }
    public string? Category { get; set; }
    public List<string>? Tags { get; set; }
    public List<string>? Roles { get; set; }
    public string? Visibility { get; set; }
    public int Order { get; set; }
    public bool IsEnabled { get; set; } = true;
    public bool IsBuiltIn { get; set; }
    public SkillInputConfig? Input { get; set; }
    public SkillExecutionConfig? Execution { get; set; }
    public SkillOutputConfig? Output { get; set; }
}
