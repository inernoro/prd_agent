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
[Route("api/authz")]
[Authorize]
[AdminController("authz", AdminPermissionCatalog.AuthzManage)]
public sealed class AuthzController : ControllerBase
{
    private readonly IAdminPermissionService _permissionService;
    private readonly IAdminControllerScanner _scanner;
    private readonly MongoDbContext _db;

    public AuthzController(
        IAdminPermissionService permissionService,
        IAdminControllerScanner scanner,
        MongoDbContext db)
    {
        _permissionService = permissionService;
        _scanner = scanner;
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

    /// <summary>
    /// 获取当前用户可见的菜单目录，前端用于自动生成导航菜单。
    /// 根据用户权限和 Controller 扫描结果动态计算可见菜单。
    /// </summary>
    [HttpGet("menu-catalog")]
    public async Task<IActionResult> MenuCatalog(CancellationToken ct)
    {
        var uid = GetUserId();
        var isRoot = IsRoot();

        // 获取用户有效权限
        var userPerms = await _permissionService.GetEffectivePermissionsAsync(uid, isRoot, ct);

        // 根据权限生成用户可见的菜单列表
        var menus = AdminMenuCatalog.GetMenusForUser(_scanner, userPerms);

        var items = menus
            .Select(x => new AdminMenuItemResponse
            {
                AppKey = x.AppKey,
                Path = x.Path,
                Label = x.Label,
                Description = x.Description,
                Icon = x.Icon,
                SortOrder = x.SortOrder
            })
            .ToList();

        return Ok(ApiResponse<AdminMenuCatalogResponse>.Ok(new AdminMenuCatalogResponse
        {
            Items = items
        }));
    }
}
