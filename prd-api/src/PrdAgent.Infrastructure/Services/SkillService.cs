using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.Services;

public class SkillService : ISkillService
{
    private readonly MongoDbContext _db;

    public SkillService(MongoDbContext db)
    {
        _db = db;
    }

    public async Task<List<Skill>> GetVisibleSkillsAsync(string userId, UserRole? roleFilter = null, CancellationToken ct = default)
    {
        // 系统/公共技能 + 当前用户的个人技能
        var filter = Builders<Skill>.Filter.And(
            Builders<Skill>.Filter.Eq(x => x.IsEnabled, true),
            Builders<Skill>.Filter.Or(
                Builders<Skill>.Filter.In(x => x.Visibility, new[] { SkillVisibility.System, SkillVisibility.Public }),
                Builders<Skill>.Filter.And(
                    Builders<Skill>.Filter.Eq(x => x.Visibility, SkillVisibility.Personal),
                    Builders<Skill>.Filter.Eq(x => x.OwnerUserId, userId)
                )
            )
        );

        var skills = await _db.Skills.Find(filter).SortBy(x => x.Order).ToListAsync(ct);

        // 角色过滤
        if (roleFilter.HasValue)
        {
            skills = skills
                .Where(s => s.Roles.Count == 0 || s.Roles.Contains(roleFilter.Value))
                .ToList();
        }

        return skills;
    }

    public async Task<Skill?> GetByKeyAsync(string skillKey, CancellationToken ct = default)
    {
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

        // 自动生成 skillKey（如果未提供）
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
    /// 从 prompt_stages 迁移到 skills 集合（幂等：已存在的 skillKey 不会重复插入）
    /// </summary>
    public async Task<int> MigrateFromPromptsAsync(CancellationToken ct = default)
    {
        var promptSettings = await _db.Prompts.Find(x => x.Id == "global").FirstOrDefaultAsync(ct);
        if (promptSettings == null || promptSettings.Prompts.Count == 0) return 0;

        var migrated = 0;
        foreach (var prompt in promptSettings.Prompts)
        {
            // 检查是否已迁移
            var existing = await _db.Skills.Find(x => x.SkillKey == prompt.PromptKey).FirstOrDefaultAsync(ct);
            if (existing != null) continue;

            var skill = new Skill
            {
                Id = Guid.NewGuid().ToString("N"),
                SkillKey = prompt.PromptKey,
                Title = prompt.Title,
                Description = $"由提示词阶段迁移: {prompt.Title}",
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

            await _db.Skills.InsertOneAsync(skill, cancellationToken: ct);
            migrated++;
        }

        return migrated;
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
