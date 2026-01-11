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

namespace PrdAgent.Api.Controllers.Admin;

[ApiController]
[Route("api/v1/admin/authz")]
[Authorize]
public sealed class AdminAuthzController : ControllerBase
{
    private readonly IAdminPermissionService _permissionService;
    private readonly MongoDbContext _db;

    public AdminAuthzController(IAdminPermissionService permissionService, MongoDbContext db)
    {
        _permissionService = permissionService;
        _db = db;
    }

    private bool IsRoot()
        => string.Equals(User.FindFirst("isRoot")?.Value, "1", StringComparison.Ordinal);

    private string GetUserId()
        => User.FindFirst(JwtRegisteredClaimNames.Sub)?.Value ?? string.Empty;

    [HttpGet("me")]
    public async Task<IActionResult> Me(CancellationToken ct)
    {
        var uid = GetUserId();
        var isRoot = IsRoot();

        if (isRoot)
        {
            return Ok(ApiResponse<AdminAuthzMeResponse>.Ok(new AdminAuthzMeResponse
            {
                UserId = "root",
                Username = "root",
                DisplayName = "ROOT",
                Role = UserRole.ADMIN,
                IsRoot = true,
                SystemRoleKey = "root",
                EffectivePermissions = AdminPermissionCatalog.All.Select(x => x.Key).ToList()
            }));
        }

        var user = await _db.Users.Find(x => x.UserId == uid).FirstOrDefaultAsync(ct);
        if (user == null)
        {
            // 统一提示：不泄露是否存在
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "账号无效"));
        }

        var perms = await _permissionService.GetEffectivePermissionsAsync(uid, isRoot, ct);
        var roleKey = (user.SystemRoleKey ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(roleKey))
        {
            roleKey = user.Role == UserRole.ADMIN ? "admin" : "none";
        }

        return Ok(ApiResponse<AdminAuthzMeResponse>.Ok(new AdminAuthzMeResponse
        {
            UserId = user.UserId,
            Username = user.Username,
            DisplayName = user.DisplayName,
            Role = user.Role,
            IsRoot = false,
            SystemRoleKey = roleKey,
            EffectivePermissions = perms.ToList()
        }));
    }

    [HttpGet("catalog")]
    public IActionResult Catalog()
    {
        return Ok(ApiResponse<AdminPermissionCatalogResponse>.Ok(new AdminPermissionCatalogResponse
        {
            Items = AdminPermissionCatalog.All.ToList()
        }));
    }
}

