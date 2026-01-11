using System.IdentityModel.Tokens.Jwt;
using System.Linq;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Models.Responses;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Admin;

[ApiController]
[Route("api/v1/admin/system-roles")]
[Authorize]
public sealed class AdminSystemRolesController : ControllerBase
{
    private readonly MongoDbContext _db;

    public AdminSystemRolesController(MongoDbContext db)
    {
        _db = db;
    }

    private string GetOperatorId()
        => User.FindFirst(JwtRegisteredClaimNames.Sub)?.Value ?? "unknown";

    [HttpGet]
    public async Task<IActionResult> List(CancellationToken ct)
    {
        var list = await _db.SystemRoles.Find(_ => true)
            .SortBy(x => x.Key)
            .ToListAsync(ct);

        var items = list.Select(x => new SystemRoleDto
        {
            Id = x.Id,
            Key = x.Key,
            Name = x.Name,
            Permissions = x.Permissions ?? new List<string>(),
            IsBuiltIn = x.IsBuiltIn,
            UpdatedAt = x.UpdatedAt,
            UpdatedBy = x.UpdatedBy
        }).ToList();

        return Ok(ApiResponse<List<SystemRoleDto>>.Ok(items));
    }

    [HttpPost]
    public async Task<IActionResult> Create([FromBody] UpsertSystemRoleRequest req, CancellationToken ct)
    {
        var key = (req?.Key ?? string.Empty).Trim().ToLowerInvariant();
        var name = (req?.Name ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(key) || string.IsNullOrWhiteSpace(name))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "key/name 不能为空"));

        if (key is "root")
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "key 不合法"));

        var existed = await _db.SystemRoles.Find(x => x.Key == key).FirstOrDefaultAsync(ct);
        if (existed != null)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "角色 key 已存在"));

        var perms = (req.Permissions ?? new List<string>())
            .Select(x => (x ?? string.Empty).Trim())
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .Distinct(StringComparer.Ordinal)
            .ToList();

        var role = new SystemRole
        {
            Id = Guid.NewGuid().ToString("N"),
            Key = key,
            Name = name,
            Permissions = perms,
            IsBuiltIn = false,
            UpdatedAt = DateTime.UtcNow,
            UpdatedBy = GetOperatorId()
        };

        await _db.SystemRoles.InsertOneAsync(role, cancellationToken: ct);

        return Ok(ApiResponse<SystemRoleDto>.Ok(new SystemRoleDto
        {
            Id = role.Id,
            Key = role.Key,
            Name = role.Name,
            Permissions = role.Permissions,
            IsBuiltIn = role.IsBuiltIn,
            UpdatedAt = role.UpdatedAt,
            UpdatedBy = role.UpdatedBy
        }));
    }

    [HttpPut("{key}")]
    public async Task<IActionResult> Update([FromRoute] string key, [FromBody] UpsertSystemRoleRequest req, CancellationToken ct)
    {
        var k = (key ?? string.Empty).Trim().ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(k))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "key 不能为空"));

        var existed = await _db.SystemRoles.Find(x => x.Key == k).FirstOrDefaultAsync(ct);
        if (existed == null)
            return NotFound(ApiResponse<object>.Fail("SYSTEM_ROLE_NOT_FOUND", "系统角色不存在"));

        var name = (req?.Name ?? string.Empty).Trim();
        if (!string.IsNullOrWhiteSpace(name))
            existed.Name = name;

        existed.Permissions = (req?.Permissions ?? new List<string>())
            .Select(x => (x ?? string.Empty).Trim())
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .Distinct(StringComparer.Ordinal)
            .ToList();

        existed.UpdatedAt = DateTime.UtcNow;
        existed.UpdatedBy = GetOperatorId();

        await _db.SystemRoles.ReplaceOneAsync(x => x.Id == existed.Id, existed, cancellationToken: ct);

        return Ok(ApiResponse<SystemRoleDto>.Ok(new SystemRoleDto
        {
            Id = existed.Id,
            Key = existed.Key,
            Name = existed.Name,
            Permissions = existed.Permissions,
            IsBuiltIn = existed.IsBuiltIn,
            UpdatedAt = existed.UpdatedAt,
            UpdatedBy = existed.UpdatedBy
        }));
    }

    [HttpDelete("{key}")]
    public async Task<IActionResult> Delete([FromRoute] string key, CancellationToken ct)
    {
        var k = (key ?? string.Empty).Trim().ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(k))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "key 不能为空"));

        var existed = await _db.SystemRoles.Find(x => x.Key == k).FirstOrDefaultAsync(ct);
        if (existed == null)
            return Ok(ApiResponse<object>.Ok(new { deleted = false }));

        if (existed.IsBuiltIn)
            return StatusCode(StatusCodes.Status403Forbidden, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "内置角色不可删除"));

        await _db.SystemRoles.DeleteOneAsync(x => x.Id == existed.Id, cancellationToken: ct);
        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    /// <summary>
    /// 重置内置角色为默认定义（会覆盖内置角色的 name/permissions；不影响自定义角色）。
    /// </summary>
    [HttpPost("reset-builtins")]
    public async Task<IActionResult> ResetBuiltIns(CancellationToken ct)
    {
        var operatorId = GetOperatorId();
        var defs = BuiltInSystemRoles.Definitions;

        foreach (var def in defs)
        {
            var existed = await _db.SystemRoles.Find(x => x.Key == def.Key).FirstOrDefaultAsync(ct);
            if (existed == null)
            {
                var created = new SystemRole
                {
                    Id = Guid.NewGuid().ToString("N"),
                    Key = def.Key,
                    Name = def.Name,
                    Permissions = def.Permissions.Distinct(StringComparer.Ordinal).ToList(),
                    IsBuiltIn = true,
                    UpdatedAt = DateTime.UtcNow,
                    UpdatedBy = operatorId
                };
                await _db.SystemRoles.InsertOneAsync(created, cancellationToken: ct);
                continue;
            }

            // 仅重置内置角色；自定义角色不做覆盖
            if (!existed.IsBuiltIn) continue;

            existed.Name = def.Name;
            existed.Permissions = def.Permissions.Distinct(StringComparer.Ordinal).ToList();
            existed.IsBuiltIn = true;
            existed.UpdatedAt = DateTime.UtcNow;
            existed.UpdatedBy = operatorId;
            await _db.SystemRoles.ReplaceOneAsync(x => x.Id == existed.Id, existed, cancellationToken: ct);
        }

        var list = await _db.SystemRoles.Find(_ => true)
            .SortBy(x => x.Key)
            .ToListAsync(ct);

        var items = list.Select(x => new SystemRoleDto
        {
            Id = x.Id,
            Key = x.Key,
            Name = x.Name,
            Permissions = x.Permissions ?? new List<string>(),
            IsBuiltIn = x.IsBuiltIn,
            UpdatedAt = x.UpdatedAt,
            UpdatedBy = x.UpdatedBy
        }).ToList();

        return Ok(ApiResponse<List<SystemRoleDto>>.Ok(items));
    }
}

