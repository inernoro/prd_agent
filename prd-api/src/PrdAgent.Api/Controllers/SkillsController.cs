using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers;

/// <summary>
/// 技能管理 Controller（Desktop 客户端使用）
/// - 服务端维护公共技能列表，客户端按角色筛选获取
/// </summary>
[ApiController]
[Route("api/v1/skills")]
[Authorize]
public class SkillsController : ControllerBase
{
    private readonly MongoDbContext _db;

    public SkillsController(MongoDbContext db)
    {
        _db = db;
    }

    /// <summary>
    /// 获取公共技能列表（按角色筛选）
    /// </summary>
    [HttpGet]
    public async Task<IActionResult> List([FromQuery] string? role, CancellationToken ct)
    {
        var settings = await _db.SkillSettings
            .Find(s => s.Id == "global")
            .FirstOrDefaultAsync(ct);

        var skills = settings?.Skills ?? new List<SkillEntry>();

        // 过滤已启用的技能
        skills = skills.Where(s => s.IsEnabled).ToList();

        // 按角色筛选
        if (!string.IsNullOrWhiteSpace(role) && Enum.TryParse<UserRole>(role, true, out var userRole))
        {
            skills = skills
                .Where(s => s.Roles.Count == 0 || s.Roles.Contains(userRole))
                .ToList();
        }

        skills = skills.OrderBy(s => s.Order).ToList();

        return Ok(ApiResponse<object>.Ok(new
        {
            updatedAt = settings?.UpdatedAt.ToString("O") ?? DateTime.UtcNow.ToString("O"),
            skills,
        }));
    }
}
