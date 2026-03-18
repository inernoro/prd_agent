using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.Services;

public class SkillService : ISkillService
{
    private readonly MongoDbContext _db;
    private readonly IPromptService _promptService;

    public SkillService(MongoDbContext db, IPromptService promptService)
    {
        _db = db;
        _promptService = promptService;
    }

    public async Task<List<Skill>> GetVisibleSkillsAsync(string userId, UserRole? roleFilter = null, CancellationToken ct = default)
    {
        // 统一从 skills 集合读取所有技能（系统 + 公共 + 个人）
        var dbFilter = Builders<Skill>.Filter.And(
            Builders<Skill>.Filter.Eq(x => x.IsEnabled, true),
            Builders<Skill>.Filter.Or(
                Builders<Skill>.Filter.In(x => x.Visibility, new[] { SkillVisibility.System, SkillVisibility.Public }),
                Builders<Skill>.Filter.And(
                    Builders<Skill>.Filter.Eq(x => x.Visibility, SkillVisibility.Personal),
                    Builders<Skill>.Filter.Eq(x => x.OwnerUserId, userId)
                )
            )
        );
        var skills = await _db.Skills.Find(dbFilter).SortBy(x => x.Order).ToListAsync(ct);

        if (roleFilter.HasValue)
        {
            skills = skills
                .Where(s => s.Roles.Count == 0 || s.Roles.Contains(roleFilter.Value))
                .ToList();
        }

        // 排序：系统技能在前，公共技能在中，个人技能在后
        return skills
            .OrderBy(s => s.Visibility switch
            {
                SkillVisibility.System => 0,
                SkillVisibility.Public => 1,
                SkillVisibility.Personal => 2,
                _ => 3
            })
            .ThenBy(s => s.Order)
            .ToList();
    }

    public async Task<Skill?> GetByKeyAsync(string skillKey, CancellationToken ct = default)
    {
        // 统一从 skills 集合查找（迁移后所有数据都在这里）
        return await _db.Skills.Find(x => x.SkillKey == skillKey).FirstOrDefaultAsync(ct);
    }

    public async Task<Skill> CreatePersonalSkillAsync(string userId, Skill skill, CancellationToken ct = default)
    {
        skill.Id = Guid.NewGuid().ToString("N");
        skill.OwnerUserId = userId;
        skill.Visibility = SkillVisibility.Personal;
        skill.IsBuiltIn = false;
        skill.CreatedAt = DateTime.UtcNow;
        skill.UpdatedAt = DateTime.UtcNow;

        if (string.IsNullOrWhiteSpace(skill.SkillKey))
        {
            skill.SkillKey = $"personal-{skill.Id}";
        }

        await _db.Skills.InsertOneAsync(skill, cancellationToken: ct);
        return skill;
    }

    public async Task<bool> UpdatePersonalSkillAsync(string userId, string skillKey, Skill updates, CancellationToken ct = default)
    {
        var filter = Builders<Skill>.Filter.And(
            Builders<Skill>.Filter.Eq(x => x.SkillKey, skillKey),
            Builders<Skill>.Filter.Eq(x => x.OwnerUserId, userId),
            Builders<Skill>.Filter.Eq(x => x.Visibility, SkillVisibility.Personal)
        );

        var update = Builders<Skill>.Update
            .Set(x => x.Title, updates.Title)
            .Set(x => x.Description, updates.Description)
            .Set(x => x.Icon, updates.Icon)
            .Set(x => x.Category, updates.Category)
            .Set(x => x.Tags, updates.Tags)
            .Set(x => x.Roles, updates.Roles)
            .Set(x => x.Order, updates.Order)
            .Set(x => x.Input, updates.Input)
            .Set(x => x.Execution, updates.Execution)
            .Set(x => x.Output, updates.Output)
            .Set(x => x.IsEnabled, updates.IsEnabled)
            .Set(x => x.UpdatedAt, DateTime.UtcNow);

        var result = await _db.Skills.UpdateOneAsync(filter, update, cancellationToken: ct);
        return result.ModifiedCount > 0;
    }

    public async Task<bool> DeletePersonalSkillAsync(string userId, string skillKey, CancellationToken ct = default)
    {
        var filter = Builders<Skill>.Filter.And(
            Builders<Skill>.Filter.Eq(x => x.SkillKey, skillKey),
            Builders<Skill>.Filter.Eq(x => x.OwnerUserId, userId),
            Builders<Skill>.Filter.Eq(x => x.Visibility, SkillVisibility.Personal),
            Builders<Skill>.Filter.Eq(x => x.IsBuiltIn, false)
        );

        var result = await _db.Skills.DeleteOneAsync(filter, ct);
        return result.DeletedCount > 0;
    }

    public async Task IncrementUsageAsync(string skillKey, CancellationToken ct = default)
    {
        var filter = Builders<Skill>.Filter.Eq(x => x.SkillKey, skillKey);
        var update = Builders<Skill>.Update.Inc(x => x.UsageCount, 1);
        await _db.Skills.UpdateOneAsync(filter, update, cancellationToken: ct);
    }

    /// <summary>
    /// 从 promptstages 迁移提示词到 skills 集合（幂等操作：已存在的 skillKey 跳过）
    /// </summary>
    public async Task<int> MigrateFromPromptsAsync(CancellationToken ct = default)
    {
        var settings = await _promptService.GetEffectiveSettingsAsync(ct);
        if (settings.Prompts.Count == 0) return 0;

        var migrated = 0;
        foreach (var prompt in settings.Prompts)
        {
            if (string.IsNullOrWhiteSpace(prompt.PromptKey)) continue;

            // 幂等：跳过已存在的 skillKey
            var exists = await _db.Skills
                .Find(x => x.SkillKey == prompt.PromptKey)
                .AnyAsync(ct);
            if (exists) continue;

            var skill = PromptEntryToSkill(prompt);
            await _db.Skills.InsertOneAsync(skill, cancellationToken: ct);
            migrated++;
        }

        return migrated;
    }

    // ━━━ 内部：prompt_stages → Skill 转换（仅用于迁移） ━━━━━━━━

    private static Skill PromptEntryToSkill(PromptEntry prompt)
    {
        return new Skill
        {
            Id = Guid.NewGuid().ToString("N"),
            SkillKey = prompt.PromptKey,
            Title = prompt.Title,
            Description = prompt.Title,
            Icon = GetDefaultIconForRole(prompt.Role),
            Category = "analysis",
            Visibility = SkillVisibility.System,
            IsBuiltIn = true,
            IsEnabled = true,
            Roles = new List<UserRole> { prompt.Role },
            Order = prompt.Order,
            Input = new SkillInputConfig
            {
                ContextScope = "prd",
                AcceptsUserInput = false,
                AcceptsAttachments = false,
            },
            Execution = new SkillExecutionConfig
            {
                PromptTemplate = prompt.PromptTemplate,
                ModelType = "chat",
            },
            Output = new SkillOutputConfig
            {
                Mode = "chat",
            },
            CreatedAt = DateTime.UtcNow,
            UpdatedAt = DateTime.UtcNow,
        };
    }

    private static string GetDefaultIconForRole(UserRole role)
    {
        return role switch
        {
            UserRole.DEV => "💻",
            UserRole.QA => "🧪",
            UserRole.PM => "📋",
            _ => "📝"
        };
    }
}
