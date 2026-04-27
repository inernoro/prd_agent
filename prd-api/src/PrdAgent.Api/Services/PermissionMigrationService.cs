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
        // PR #496 起涌现探索器从 read/write 拆分改为单一 use 权限，
        // 历史 SystemRole / User PermAllow / PermDeny 中的旧 key 自动平滑迁移过来。
        { "emergence.read", "emergence-agent.use" },
        { "emergence.write", "emergence-agent.use" },
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

    // 一次性迁移标记 —— 写入 AppSettings.CompletedOneTimeMigrations 后不再重跑。
    // 命名约定：<feature-key>-<yyyy-MM>，方便日后辨识。
    private const string EmergenceCompatMigrationKey = "emergence-agent-use-from-access-2026-04";

    private async Task MigratePermissionsAsync(MongoDbContext db, CancellationToken ct)
    {
        // 1. 迁移 SystemRole 表
        await MigrateSystemRolesAsync(db, ct);

        // 2. 迁移 User 表的 PermAllow / PermDeny
        await MigrateUserPermissionsAsync(db, ct);

        // 3. PR #496 起涌现探索器从 access 收紧为 emergence-agent.use。
        //    历史上 access 才是真正的访问门，多数用户/自定义角色根本没碰过
        //    emergence.read / emergence.write 这两个键，因此 PermissionMap 的一对一
        //    映射救不了他们 —— 这一遍单独扫一次：凡是已有 access 的，自动续上
        //    emergence-agent.use 防止升级后断网。
        //    一次性！跑完打标，下次启动跳过 —— 否则管理员手动撤回该权限后下次重启会被
        //    悄悄回填（Bugbot review 抓到的 idempotency bug）。
        if (!await HasCompletedMigrationAsync(db, EmergenceCompatMigrationKey, ct))
        {
            await GrantEmergenceAgentUseToAccessHoldersAsync(db, ct);
            await MarkMigrationCompletedAsync(db, EmergenceCompatMigrationKey, ct);
        }
    }

    private static async Task<bool> HasCompletedMigrationAsync(MongoDbContext db, string key, CancellationToken ct)
    {
        var settings = await db.AppSettings.Find(s => s.Id == "global").FirstOrDefaultAsync(ct);
        return settings?.CompletedOneTimeMigrations?.Contains(key) == true;
    }

    private async Task MarkMigrationCompletedAsync(MongoDbContext db, string key, CancellationToken ct)
    {
        var update = Builders<PrdAgent.Core.Models.AppSettings>.Update
            .AddToSet(s => s.CompletedOneTimeMigrations, key)
            .Set(s => s.UpdatedAt, DateTime.UtcNow);
        await db.AppSettings.UpdateOneAsync(
            s => s.Id == "global",
            update,
            new UpdateOptions { IsUpsert = true },
            ct);
        _logger.LogInformation("一次性迁移 {Key} 标记完成；后续启动将跳过", key);
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

    /// <summary>
    /// 涌现探索器从 access 收紧到 emergence-agent.use 的反向兼容迁移。
    /// 凡是已有 access 的自定义角色 / 用户 PermAllow，自动追加 emergence-agent.use
    /// 防止历史用户在升级后丢失访问。
    /// </summary>
    private async Task GrantEmergenceAgentUseToAccessHoldersAsync(MongoDbContext db, CancellationToken ct)
    {
        const string Access = "access";
        const string EmergenceUse = "emergence-agent.use";

        // 1. 自定义角色（IsBuiltIn=false 才查；内置角色由代码侧 BuiltInSystemRoles 兜底）
        var customRoles = await db.SystemRoles.Find(r => !r.IsBuiltIn).ToListAsync(ct);
        var rolesPatched = 0;
        foreach (var role in customRoles)
        {
            if (role.Permissions == null || role.Permissions.Count == 0) continue;
            if (!role.Permissions.Contains(Access)) continue;
            if (role.Permissions.Contains(EmergenceUse)) continue;

            role.Permissions.Add(EmergenceUse);
            role.UpdatedAt = DateTime.UtcNow;
            await db.SystemRoles.ReplaceOneAsync(r => r.Id == role.Id, role, cancellationToken: ct);
            rolesPatched++;
            _logger.LogInformation("自定义角色 {Key} 自动续上 emergence-agent.use（保留原 access 时代的涌现访问）", role.Key);
        }

        // 2. 用户级 PermAllow（只看 PermAllow；PermDeny 不动 —— 显式 deny access 的用户原本就没有涌现）
        var userFilter = Builders<PrdAgent.Core.Models.User>.Filter.Ne(u => u.PermAllow, null);
        var users = await db.Users.Find(userFilter).ToListAsync(ct);
        var usersPatched = 0;
        foreach (var user in users)
        {
            if (user.PermAllow == null || user.PermAllow.Count == 0) continue;
            if (!user.PermAllow.Contains(Access)) continue;
            if (user.PermAllow.Contains(EmergenceUse)) continue;

            user.PermAllow.Add(EmergenceUse);
            await db.Users.ReplaceOneAsync(u => u.UserId == user.UserId, user, cancellationToken: ct);
            usersPatched++;
            _logger.LogInformation("用户 {Username} PermAllow 自动续上 emergence-agent.use", user.Username);
        }

        if (rolesPatched > 0 || usersPatched > 0)
        {
            _logger.LogInformation("涌现兼容迁移完成: 自定义角色 {Roles} 个 + 用户 PermAllow {Users} 个", rolesPatched, usersPatched);
        }
    }
}
