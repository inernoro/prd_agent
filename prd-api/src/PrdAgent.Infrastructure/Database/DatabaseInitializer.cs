using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

namespace PrdAgent.Infrastructure.Database;

/// <summary>
/// 数据库初始化器
/// </summary>
public class DatabaseInitializer
{
    private readonly MongoDbContext _db;
    private readonly IIdGenerator _idGenerator;

    public DatabaseInitializer(MongoDbContext db, IIdGenerator idGenerator)
    {
        _db = db;
        _idGenerator = idGenerator;
    }

    /// <summary>
    /// 初始化管理员账号和初始邀请码
    /// </summary>
    public async Task InitializeAsync()
    {
        await EnsureAdminUserAsync();
        await EnsureInitialInviteCodeAsync();
        await EnsureSystemRolesAsync();
    }

    private async Task EnsureAdminUserAsync()
    {
        // 检查是否已存在管理员
        var existingAdmin = await _db.Users
            .Find(u => u.Role == UserRole.ADMIN)
            .FirstOrDefaultAsync();

        if (existingAdmin != null)
            return;

        // 创建默认管理员账号
        var adminUser = new User
        {
            UserId = await _idGenerator.GenerateIdAsync("user"),
            Username = "admin",
            PasswordHash = BCrypt.Net.BCrypt.HashPassword("admin"),
            DisplayName = "系统管理员",
            Role = UserRole.ADMIN,
            Status = UserStatus.Active
        };

        await _db.Users.InsertOneAsync(adminUser);
        Console.WriteLine("Created default admin user: admin / admin");
        Console.WriteLine("Please change the password after first login!");
    }

    private async Task EnsureInitialInviteCodeAsync()
    {
        // 检查是否已存在可用的邀请码
        var existingCode = await _db.InviteCodes
            .Find(c => !c.IsUsed && (c.ExpiresAt == null || c.ExpiresAt > DateTime.UtcNow))
            .FirstOrDefaultAsync();

        if (existingCode != null)
            return;

        // 创建初始邀请码
        var inviteCode = new InviteCode
        {
            Id = await _idGenerator.GenerateIdAsync("config"),
            Code = "PRD-INIT-2024",
            CreatorId = "system",
            IsUsed = false,
            ExpiresAt = DateTime.UtcNow.AddDays(30)
        };

        await _db.InviteCodes.InsertOneAsync(inviteCode);
        Console.WriteLine($"Created initial invite code: {inviteCode.Code} (expires in 30 days)");
    }

    private async Task EnsureSystemRolesAsync()
    {
        // 若已经存在任意 system role，则认为已初始化（避免覆盖用户自定义）
        var any = await _db.SystemRoles.Find(_ => true).Limit(1).FirstOrDefaultAsync();
        if (any != null) return;

        // 内置角色：尽量“默认不误伤”
        // - admin：全权限（含 admin.super，兜底避免版本升级时遗漏映射导致管理员突然 403）
        // - operator：常用运维（读全 + 部分写）
        // - viewer：只读（含 logs）
        // - none：无权限（默认给非 ADMIN 用户）
        var allPerms = PrdAgent.Core.Security.AdminPermissionCatalog.All.Select(x => x.Key).ToList();

        var admin = new SystemRole
        {
            Id = await _idGenerator.GenerateIdAsync("config"),
            Key = "admin",
            Name = "管理员",
            Permissions = allPerms,
            IsBuiltIn = true,
            UpdatedAt = DateTime.UtcNow,
            UpdatedBy = "system"
        };

        var operatorRole = new SystemRole
        {
            Id = await _idGenerator.GenerateIdAsync("config"),
            Key = "operator",
            Name = "运营/运维",
            Permissions = new List<string>
            {
                PrdAgent.Core.Security.AdminPermissionCatalog.AdminAccess,
                PrdAgent.Core.Security.AdminPermissionCatalog.ModelsRead,
                PrdAgent.Core.Security.AdminPermissionCatalog.ModelsWrite,
                PrdAgent.Core.Security.AdminPermissionCatalog.GroupsRead,
                PrdAgent.Core.Security.AdminPermissionCatalog.GroupsWrite,
                PrdAgent.Core.Security.AdminPermissionCatalog.LogsRead,
                PrdAgent.Core.Security.AdminPermissionCatalog.DataRead,
                PrdAgent.Core.Security.AdminPermissionCatalog.DataWrite,
                PrdAgent.Core.Security.AdminPermissionCatalog.AssetsRead,
                PrdAgent.Core.Security.AdminPermissionCatalog.AssetsWrite,
                PrdAgent.Core.Security.AdminPermissionCatalog.OpenPlatformManage,
            },
            IsBuiltIn = true,
            UpdatedAt = DateTime.UtcNow,
            UpdatedBy = "system"
        };

        var viewer = new SystemRole
        {
            Id = await _idGenerator.GenerateIdAsync("config"),
            Key = "viewer",
            Name = "只读",
            Permissions = new List<string>
            {
                PrdAgent.Core.Security.AdminPermissionCatalog.AdminAccess,
                PrdAgent.Core.Security.AdminPermissionCatalog.UsersRead,
                PrdAgent.Core.Security.AdminPermissionCatalog.GroupsRead,
                PrdAgent.Core.Security.AdminPermissionCatalog.ModelsRead,
                PrdAgent.Core.Security.AdminPermissionCatalog.LogsRead,
                PrdAgent.Core.Security.AdminPermissionCatalog.DataRead,
                PrdAgent.Core.Security.AdminPermissionCatalog.AssetsRead,
            },
            IsBuiltIn = true,
            UpdatedAt = DateTime.UtcNow,
            UpdatedBy = "system"
        };

        var none = new SystemRole
        {
            Id = await _idGenerator.GenerateIdAsync("config"),
            Key = "none",
            Name = "无权限",
            Permissions = new List<string>(),
            IsBuiltIn = true,
            UpdatedAt = DateTime.UtcNow,
            UpdatedBy = "system"
        };

        await _db.SystemRoles.InsertManyAsync(new[] { admin, operatorRole, viewer, none });
    }
}
