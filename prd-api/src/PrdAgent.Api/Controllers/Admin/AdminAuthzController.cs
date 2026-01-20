using System.IdentityModel.Tokens.Jwt;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;
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
[AdminController("admin-authz", AdminPermissionCatalog.AuthzManage)]
public sealed class AdminAuthzController : ControllerBase
{
    private readonly IAdminPermissionService _permissionService;
    private readonly IAdminControllerScanner _scanner;
    private readonly MongoDbContext _db;
    private readonly ILogger<AdminAuthzController> _logger;

    public AdminAuthzController(
        IAdminPermissionService permissionService,
        IAdminControllerScanner scanner,
        MongoDbContext db,
        ILogger<AdminAuthzController> logger)
    {
        _permissionService = permissionService;
        _scanner = scanner;
        _db = db;
        _logger = logger;
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

    private async Task EnsurePermissionCatalogNoticeAsync(CancellationToken ct)
    {
        var currentPermissions = AdminPermissionCatalog.All.ToList();
        var currentKeys = currentPermissions.Select(x => x.Key).ToHashSet();
        var catalogHash = ComputeCatalogHash(currentPermissions);

        var settings = await _db.AppSettings.Find(x => x.Id == "global").FirstOrDefaultAsync(ct)
                       ?? new AppSettings { Id = "global", EnablePromptCache = true, UpdatedAt = DateTime.UtcNow };

        // 获取之前的权限快照
        var previousKeys = settings.PermissionCatalogSnapshot?.ToHashSet() ?? new HashSet<string>();

        // 计算权限变化
        var addedKeys = currentKeys.Except(previousKeys).ToList();
        var removedKeys = previousKeys.Except(currentKeys).ToList();
        var unchangedKeys = currentKeys.Intersect(previousKeys).ToList();

        var hasChanged = !string.Equals(settings.PermissionCatalogHash, catalogHash, StringComparison.Ordinal);

        // 每次登录都输出权限目录状态日志
        LogPermissionCatalogStatus(
            currentPermissions,
            previousKeys,
            addedKeys,
            removedKeys,
            unchangedKeys,
            settings.PermissionCatalogHash,
            catalogHash,
            hasChanged);

        // 如果没有变更，直接返回
        if (!hasChanged)
        {
            return;
        }

        // 更新设置，包括新的快照
        var now = DateTime.UtcNow;
        var update = Builders<AppSettings>.Update
            .Set(x => x.PermissionCatalogHash, catalogHash)
            .Set(x => x.PermissionCatalogUpdatedAt, now)
            .Set(x => x.PermissionCatalogSnapshot, currentKeys.ToList())
            .Set(x => x.UpdatedAt, now);

        await _db.AppSettings.UpdateOneAsync(x => x.Id == "global", update, new UpdateOptions { IsUpsert = true }, ct);

        var notificationKey = "permission-catalog-updated";
        var existed = await _db.AdminNotifications
            .Find(x => x.Key == notificationKey && x.Status == "open")
            .FirstOrDefaultAsync(ct);

        if (existed != null)
        {
            return;
        }

        // 构建更详细的通知消息
        var messageParts = new List<string>();
        if (addedKeys.Count > 0)
        {
            messageParts.Add($"新增 {addedKeys.Count} 个权限点: {string.Join(", ", addedKeys)}");
        }
        if (removedKeys.Count > 0)
        {
            messageParts.Add($"移除 {removedKeys.Count} 个权限点: {string.Join(", ", removedKeys)}");
        }
        var detailMessage = messageParts.Count > 0
            ? string.Join("；", messageParts) + "。"
            : "权限定义有变更。";

        var notification = new AdminNotification
        {
            Key = notificationKey,
            Title = "权限目录已更新",
            Message = detailMessage + "请前往\"权限管理\"页面检查系统角色并执行\"重置内置角色\"，确保新权限生效。",
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

    private void LogPermissionCatalogStatus(
        List<AdminPermissionDef> currentPermissions,
        HashSet<string> previousKeys,
        List<string> addedKeys,
        List<string> removedKeys,
        List<string> unchangedKeys,
        string? oldHash,
        string newHash,
        bool hasChanged)
    {
        var statusText = hasChanged ? "【检测到变更】" : "【无变更】";

        _logger.LogInformation("========================================");
        _logger.LogInformation("【权限目录状态检查】{Status}", statusText);
        _logger.LogInformation("========================================");
        _logger.LogInformation("存储的 Hash: {OldHash}", oldHash ?? "(首次初始化)");
        _logger.LogInformation("当前代码 Hash: {NewHash}", newHash);
        _logger.LogInformation("Hash 是否匹配: {IsMatch}", !hasChanged);
        _logger.LogInformation("----------------------------------------");

        _logger.LogInformation("【当前代码中的权限目录】共 {Count} 个权限点:", currentPermissions.Count);
        foreach (var perm in currentPermissions)
        {
            _logger.LogInformation("  - {Key}: {Name} ({Description})", perm.Key, perm.Name, perm.Description ?? "无描述");
        }

        _logger.LogInformation("----------------------------------------");
        _logger.LogInformation("【数据库中存储的权限快照】共 {Count} 个权限点:", previousKeys.Count);
        if (previousKeys.Count == 0)
        {
            _logger.LogInformation("  (首次初始化，数据库无历史记录)");
        }
        else
        {
            foreach (var prevKey in previousKeys.OrderBy(x => x))
            {
                _logger.LogInformation("  - {Key}", prevKey);
            }
        }

        _logger.LogInformation("----------------------------------------");
        if (hasChanged)
        {
            if (addedKeys.Count > 0)
            {
                _logger.LogWarning("【新增权限】共 {Count} 个:", addedKeys.Count);
                foreach (var addedKey in addedKeys)
                {
                    var perm = currentPermissions.First(x => x.Key == addedKey);
                    _logger.LogWarning("  + {Key}: {Name} ({Description})", perm.Key, perm.Name, perm.Description ?? "无描述");
                }
            }
            else
            {
                _logger.LogInformation("【新增权限】无");
            }

            _logger.LogInformation("----------------------------------------");
            if (removedKeys.Count > 0)
            {
                _logger.LogWarning("【移除权限】共 {Count} 个:", removedKeys.Count);
                foreach (var removedKey in removedKeys)
                {
                    _logger.LogWarning("  - {Key}", removedKey);
                }
            }
            else
            {
                _logger.LogInformation("【移除权限】无");
            }

            _logger.LogInformation("----------------------------------------");
            _logger.LogInformation("【未变更权限】共 {Count} 个", unchangedKeys.Count);
        }
        else
        {
            _logger.LogInformation("【权限目录状态】代码与数据库一致，无需更新");
        }
        _logger.LogInformation("========================================");
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
