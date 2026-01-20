using System.IdentityModel.Tokens.Jwt;
using System.Linq;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Models.Responses;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Api;

[ApiController]
[Route("api/authz/system-roles")]
[Authorize]
[AdminController("authz", AdminPermissionCatalog.AuthzManage)]
public sealed class SystemRolesController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly ISystemRoleCacheService _roleCache;

    public SystemRolesController(MongoDbContext db, ISystemRoleCacheService roleCache)
    {
        _db = db;
        _roleCache = roleCache;
    }

    private string GetOperatorId()
        => User.FindFirst(JwtRegisteredClaimNames.Sub)?.Value ?? "unknown";

    /// <summary>
    /// 获取所有角色（内置 + 自定义）
    /// </summary>
    [HttpGet]
    public IActionResult List()
    {
        // 从缓存获取所有角色
        var list = _roleCache.GetAllRoles();

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

    /// <summary>
    /// 创建自定义角色
    /// </summary>
    [HttpPost]
    public async Task<IActionResult> Create([FromBody] UpsertSystemRoleRequest req, CancellationToken ct)
    {
        var key = (req?.Key ?? string.Empty).Trim().ToLowerInvariant();
        var name = (req?.Name ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(key) || string.IsNullOrWhiteSpace(name))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "key/name 不能为空"));

        if (key is "root")
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "key 不合法"));

        // 检查缓存中是否已存在（包括内置角色）
        var existedInCache = _roleCache.GetRoleByKey(key);
        if (existedInCache != null)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "角色 key 已存在"));

        var perms = (req?.Permissions ?? new List<string>())
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

        // 刷新缓存
        await _roleCache.RefreshCustomRolesAsync(ct);

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

    /// <summary>
    /// 更新自定义角色（内置角色不可修改）
    /// </summary>
    [HttpPut("{key}")]
    public async Task<IActionResult> Update([FromRoute] string key, [FromBody] UpsertSystemRoleRequest req, CancellationToken ct)
    {
        var k = (key ?? string.Empty).Trim().ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(k))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "key 不能为空"));

        // 先检查缓存中是否存在
        var cachedRole = _roleCache.GetRoleByKey(k);
        if (cachedRole == null)
            return NotFound(ApiResponse<object>.Fail("SYSTEM_ROLE_NOT_FOUND", "系统角色不存在"));

        // 内置角色不可修改
        if (cachedRole.IsBuiltIn)
            return StatusCode(StatusCodes.Status403Forbidden, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "内置角色不可修改"));

        // 从数据库获取自定义角色进行更新
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

        // 刷新缓存
        await _roleCache.RefreshCustomRolesAsync(ct);

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

    /// <summary>
    /// 删除自定义角色（内置角色不可删除）
    /// </summary>
    [HttpDelete("{key}")]
    public async Task<IActionResult> Delete([FromRoute] string key, CancellationToken ct)
    {
        var k = (key ?? string.Empty).Trim().ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(k))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "key 不能为空"));

        // 先检查缓存中是否存在
        var cachedRole = _roleCache.GetRoleByKey(k);
        if (cachedRole == null)
            return Ok(ApiResponse<object>.Ok(new { deleted = false }));

        // 内置角色不可删除
        if (cachedRole.IsBuiltIn)
            return StatusCode(StatusCodes.Status403Forbidden, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "内置角色不可删除"));

        // 从数据库删除
        await _db.SystemRoles.DeleteOneAsync(x => x.Key == k, cancellationToken: ct);

        // 刷新缓存
        await _roleCache.RefreshCustomRolesAsync(ct);

        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    /// <summary>
    /// 重置内置角色（已废弃，内置角色现在从代码加载，无需重置）
    /// </summary>
    [HttpPost("reset-builtins")]
    public IActionResult ResetBuiltIns()
    {
        // 内置角色现在从代码加载，返回所有角色列表
        var list = _roleCache.GetAllRoles();

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
