using System.IdentityModel.Tokens.Jwt;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
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

        await EnsurePermissionCatalogNoticeAsync(ct);

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

    private async Task EnsurePermissionCatalogNoticeAsync(CancellationToken ct)
    {
        var catalogHash = ComputeCatalogHash(AdminPermissionCatalog.All);
        var settings = await _db.AppSettings.Find(x => x.Id == "global").FirstOrDefaultAsync(ct)
                       ?? new AppSettings { Id = "global", EnablePromptCache = true, UpdatedAt = DateTime.UtcNow };

        if (string.Equals(settings.PermissionCatalogHash, catalogHash, StringComparison.Ordinal))
        {
            return;
        }

        var now = DateTime.UtcNow;
        var update = Builders<AppSettings>.Update
            .Set(x => x.PermissionCatalogHash, catalogHash)
            .Set(x => x.PermissionCatalogUpdatedAt, now)
            .Set(x => x.UpdatedAt, now);

        await _db.AppSettings.UpdateOneAsync(x => x.Id == "global", update, new UpdateOptions { IsUpsert = true }, ct);

        var key = "permission-catalog-updated";
        var existed = await _db.AdminNotifications
            .Find(x => x.Key == key && x.Status == "open")
            .FirstOrDefaultAsync(ct);

        if (existed != null)
        {
            return;
        }

        var notification = new AdminNotification
        {
            Key = key,
            Title = "权限目录已更新",
            Message = "检测到新增权限点。请前往“权限管理”页面检查系统角色并执行“重置内置角色”，确保新权限生效。",
            Level = "warning",
            ActionLabel = "打开权限管理",
            ActionUrl = "/authz",
            ActionKind = "navigate",
            Source = "system",
            Status = "open",
            CreatedAt = now,
            UpdatedAt = now,
            ExpiresAt = now.AddDays(7)
        };

        await _db.AdminNotifications.InsertOneAsync(notification, cancellationToken: ct);
    }

    private static string ComputeCatalogHash(IEnumerable<AdminPermissionDef> permissions)
    {
        var raw = string.Join("|", permissions
            .Select(x => $"{x.Key}:{x.Name}:{x.Description}")
            .OrderBy(x => x, StringComparer.Ordinal));
        using var sha = SHA256.Create();
        var bytes = sha.ComputeHash(Encoding.UTF8.GetBytes(raw));
        return Convert.ToHexString(bytes).ToLowerInvariant();
    }
}
