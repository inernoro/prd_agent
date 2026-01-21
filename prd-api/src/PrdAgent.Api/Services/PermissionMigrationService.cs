using MongoDB.Driver;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services;

/// <summary>
/// 权限字符串格式迁移服务
/// 在应用启动时自动将旧格式 (admin.xxx.yyy) 迁移到新格式 (appKey.action)
/// 注意：内置角色和权限由代码定义（AdminPermissionCatalog.All），每次启动自动生效，
/// 数据库仅存储用户自定义的角色覆盖和权限调整。
/// </summary>
public sealed class PermissionMigrationService : IHostedService
{
    private readonly IServiceProvider _serviceProvider;
    private readonly ILogger<PermissionMigrationService> _logger;

    // 权限映射表：旧格式 → 新格式（一对一）
    private static readonly Dictionary<string, string> PermissionMap = new()
    {
        { "admin.access", "access" },
        { "admin.authz.manage", "authz.manage" },
        { "admin.users.read", "users.read" },
        { "admin.users.write", "users.write" },
        { "admin.groups.read", "groups.read" },
        { "admin.groups.write", "groups.write" },
        { "admin.models.read", "mds.read" },
        { "admin.models.write", "mds.write" },
        { "admin.logs.read", "logs.read" },
        { "admin.open-platform.manage", "open-platform.manage" },
        { "admin.data.read", "data.read" },
        { "admin.data.write", "data.write" },
        { "admin.assets.read", "assets.read" },
        { "admin.assets.write", "assets.write" },
        { "admin.settings.read", "settings.read" },
        { "admin.settings.write", "settings.write" },
        { "admin.prompts.write", "prompts.write" },
        { "admin.super", "super" },
    };

    // 一对多权限迁移：旧权限 → 多个新权限（agent.use 拆分为三个独立 Agent 权限）
    private static readonly Dictionary<string, string[]> PermissionExpandMap = new()
    {
        { "agent.use", new[] { "prd-agent.use", "visual-agent.use", "literary-agent.use" } },
        { "admin.agent.use", new[] { "prd-agent.use", "visual-agent.use", "literary-agent.use" } },
    };

    public PermissionMigrationService(IServiceProvider serviceProvider, ILogger<PermissionMigrationService> logger)
    {
        _serviceProvider = serviceProvider;
        _logger = logger;
    }

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        try
        {
            using var scope = _serviceProvider.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<MongoDbContext>();

            // 仅执行旧格式权限字符串迁移（为已存在的数据库记录服务）
            await MigratePermissionsAsync(db, cancellationToken);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "权限迁移服务启动失败");
        }
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    private async Task MigratePermissionsAsync(MongoDbContext db, CancellationToken ct)
    {
        // 1. 迁移 SystemRole 表
        await MigrateSystemRolesAsync(db, ct);

        // 2. 迁移 User 表的 PermAllow / PermDeny
        await MigrateUserPermissionsAsync(db, ct);
    }

    private async Task MigrateSystemRolesAsync(MongoDbContext db, CancellationToken ct)
    {
        var updatedRoles = 0;
        var updatedPermissions = 0;

        var roles = await db.SystemRoles.Find(_ => true).ToListAsync(ct);

        foreach (var role in roles)
        {
            var changed = false;
            var newPermissions = new List<string>();

            foreach (var perm in role.Permissions)
            {
                // 一对一映射
                if (PermissionMap.TryGetValue(perm, out var newPerm))
                {
                    newPermissions.Add(newPerm);
                    changed = true;
                    updatedPermissions++;
                }
                // 一对多映射（如 agent.use → prd-agent.use, visual-agent.use, literary-agent.use）
                else if (PermissionExpandMap.TryGetValue(perm, out var expandedPerms))
                {
                    newPermissions.AddRange(expandedPerms);
                    changed = true;
                    updatedPermissions += expandedPerms.Length;
                }
                else
                {
                    newPermissions.Add(perm);
                }
            }

            if (changed)
            {
                // 去重
                role.Permissions = newPermissions.Distinct().ToList();
                role.UpdatedAt = DateTime.UtcNow;
                await db.SystemRoles.ReplaceOneAsync(r => r.Id == role.Id, role, cancellationToken: ct);
                updatedRoles++;
                _logger.LogInformation("角色 {RoleKey} 权限已迁移", role.Key);
            }
        }

        if (updatedRoles > 0)
        {
            _logger.LogInformation("SystemRole 迁移完成: 更新了 {RoleCount} 个角色，共 {PermCount} 个权限",
                updatedRoles, updatedPermissions);
        }
    }

    private async Task MigrateUserPermissionsAsync(MongoDbContext db, CancellationToken ct)
    {
        var updatedUsers = 0;

        // 查找有 PermAllow 或 PermDeny 的用户
        var filter = Builders<PrdAgent.Core.Models.User>.Filter.Or(
            Builders<PrdAgent.Core.Models.User>.Filter.Ne(u => u.PermAllow, null),
            Builders<PrdAgent.Core.Models.User>.Filter.Ne(u => u.PermDeny, null)
        );

        var users = await db.Users.Find(filter).ToListAsync(ct);

        foreach (var user in users)
        {
            var changed = false;

            // 迁移 PermAllow
            if (user.PermAllow != null && user.PermAllow.Count > 0)
            {
                var newPermAllow = new List<string>();
                foreach (var perm in user.PermAllow)
                {
                    // 一对一映射
                    if (PermissionMap.TryGetValue(perm, out var newPerm))
                    {
                        newPermAllow.Add(newPerm);
                        changed = true;
                    }
                    // 一对多映射
                    else if (PermissionExpandMap.TryGetValue(perm, out var expandedPerms))
                    {
                        newPermAllow.AddRange(expandedPerms);
                        changed = true;
                    }
                    else
                    {
                        newPermAllow.Add(perm);
                    }
                }
                user.PermAllow = newPermAllow.Distinct().ToList();
            }

            // 迁移 PermDeny
            if (user.PermDeny != null && user.PermDeny.Count > 0)
            {
                var newPermDeny = new List<string>();
                foreach (var perm in user.PermDeny)
                {
                    // 一对一映射
                    if (PermissionMap.TryGetValue(perm, out var newPerm))
                    {
                        newPermDeny.Add(newPerm);
                        changed = true;
                    }
                    // 一对多映射
                    else if (PermissionExpandMap.TryGetValue(perm, out var expandedPerms))
                    {
                        newPermDeny.AddRange(expandedPerms);
                        changed = true;
                    }
                    else
                    {
                        newPermDeny.Add(perm);
                    }
                }
                user.PermDeny = newPermDeny.Distinct().ToList();
            }

            if (changed)
            {
                await db.Users.ReplaceOneAsync(u => u.UserId == user.UserId, user, cancellationToken: ct);
                updatedUsers++;
                _logger.LogInformation("用户 {Username} 权限已迁移", user.Username);
            }
        }

        if (updatedUsers > 0)
        {
            _logger.LogInformation("User 迁移完成: 更新了 {UserCount} 个用户的 PermAllow/PermDeny", updatedUsers);
        }
    }
}
