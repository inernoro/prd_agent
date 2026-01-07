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
}
