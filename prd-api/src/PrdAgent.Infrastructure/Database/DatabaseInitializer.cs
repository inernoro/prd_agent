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
        await EnsureWorkflowSkillAsync();
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
        // 启动时仅“补齐缺失的内置角色”，不覆盖用户对已有角色的编辑（覆盖应由显式“重置内置角色”触发）
        var defs = PrdAgent.Core.Security.BuiltInSystemRoles.Definitions;
        foreach (var def in defs)
        {
            var existed = await _db.SystemRoles.Find(x => x.Key == def.Key).FirstOrDefaultAsync();
            if (existed != null)
            {
                // 仅对 admin 做“增量补齐”，避免升级后管理员丢功能（只加不减，不覆盖）
                if (string.Equals(existed.Key, "admin", StringComparison.Ordinal) && existed.IsBuiltIn)
                {
                    var current = existed.Permissions ?? new List<string>();
                    var merged = current
                        .Concat(def.Permissions ?? new List<string>())
                        .Select(x => (x ?? string.Empty).Trim())
                        .Where(x => !string.IsNullOrWhiteSpace(x))
                        .Distinct(StringComparer.Ordinal)
                        .ToList();
                    if (merged.Count != current.Count)
                    {
                        var update = Builders<SystemRole>.Update
                            .Set(x => x.Permissions, merged)
                            .Set(x => x.UpdatedAt, DateTime.UtcNow)
                            .Set(x => x.UpdatedBy, "system");
                        await _db.SystemRoles.UpdateOneAsync(x => x.Id == existed.Id, update);
                    }
                }
                continue;
            }

            var role = new SystemRole
            {
                Id = await _idGenerator.GenerateIdAsync("config"),
                Key = def.Key,
                Name = def.Name,
                Permissions = (def.Permissions ?? new List<string>()).Distinct(StringComparer.Ordinal).ToList(),
                IsBuiltIn = true,
                UpdatedAt = DateTime.UtcNow,
                UpdatedBy = "system"
            };

            await _db.SystemRoles.InsertOneAsync(role);
        }
    }

    private async Task EnsureWorkflowSkillAsync()
    {
        const string skillKey = "workflow-from-code";
        var existing = await _db.Skills
            .Find(s => s.SkillKey == skillKey)
            .FirstOrDefaultAsync();

        if (existing != null)
            return;

        var skill = new Skill
        {
            Id = await _idGenerator.GenerateIdAsync("config"),
            SkillKey = skillKey,
            Title = "代码转工作流",
            Description = "将 Python/JS 代码片段或 GitHub URL 转换为自动化工作流。支持 HTTP 请求、数据提取、格式转换等舱类型的自动识别和映射。",
            Icon = "🔄",
            Category = "workflow",
            Tags = new List<string> { "工作流", "代码转换", "自动化" },
            Visibility = SkillVisibility.System,
            IsBuiltIn = true,
            IsEnabled = true,
            Order = 10,
            Input = new SkillInputConfig
            {
                ContextScope = "none",
                AcceptsUserInput = true,
                UserInputPlaceholder = "粘贴 Python/JS 代码，或输入 GitHub URL，或描述你想要的工作流",
                AcceptsAttachments = false,
                Parameters = new List<SkillParameter>
                {
                    new()
                    {
                        Key = "codeUrl",
                        Label = "代码仓库 URL（可选）",
                        Type = "text",
                        Required = false,
                    },
                },
            },
            Execution = new SkillExecutionConfig
            {
                PromptTemplate = @"请将以下内容转换为工作流配置：

{{userInput}}

{{#if codeUrl}}
代码仓库：{{codeUrl}}
{{/if}}

请分析代码中的：
1. HTTP 请求（URL、Method、Headers、Body）→ 映射为 http-request 或 smart-http 舱
2. 数据处理逻辑 → 映射为 data-extractor / data-merger / format-converter 舱
3. 文件操作 → 映射为 file-exporter 舱
4. Cookie/Token → 提取为工作流变量

返回完整的工作流 JSON 配置。",
                SystemPromptOverride = null,
                AppCallerCode = "workflow-agent.chat-assistant::chat",
                ModelType = "chat",
            },
            Output = new SkillOutputConfig
            {
                Mode = "chat",
                EchoToChat = true,
            },
        };

        await _db.Skills.InsertOneAsync(skill);
    }
}
