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
        // 1) 从 prompt_stages 读取提示词技能（兼容现有 admin 提示词管理）
        var promptSkills = await GetSystemSkillsFromPromptsAsync(roleFilter, ct);

        // 2) 从 skills 集合读取 admin 创建的技能（system/public）+ 用户个人技能
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
        var dbSkills = await _db.Skills.Find(dbFilter).SortBy(x => x.Order).ToListAsync(ct);

        if (roleFilter.HasValue)
        {
            dbSkills = dbSkills
                .Where(s => s.Roles.Count == 0 || s.Roles.Contains(roleFilter.Value))
                .ToList();
        }

        // 提示词技能在前，admin 技能在中，个人技能在后
        var result = new List<Skill>(promptSkills.Count + dbSkills.Count);
        result.AddRange(promptSkills);
        result.AddRange(dbSkills);
        return result;
    }

    public async Task<Skill?> GetByKeyAsync(string skillKey, CancellationToken ct = default)
    {
        // 先查 skills 集合（个人技能）
        var personal = await _db.Skills.Find(x => x.SkillKey == skillKey).FirstOrDefaultAsync(ct);
        if (personal != null) return personal;

        // 再查 prompt_stages（系统技能 = promptKey 匹配）
        var settings = await _promptService.GetEffectiveSettingsAsync(ct);
        var prompt = settings.Prompts.FirstOrDefault(p =>
            string.Equals(p.PromptKey, skillKey, StringComparison.Ordinal));

        if (prompt != null)
            return PromptEntryToSkill(prompt);

        return null;
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
        // 仅对 skills 集合中的个人技能计数；系统技能来自 prompt_stages，不计数
        var filter = Builders<Skill>.Filter.Eq(x => x.SkillKey, skillKey);
        var update = Builders<Skill>.Update.Inc(x => x.UsageCount, 1);
        await _db.Skills.UpdateOneAsync(filter, update, cancellationToken: ct);
    }

    public Task<int> MigrateFromPromptsAsync(CancellationToken ct = default)
    {
        // 不再需要迁移：系统技能直接从 prompt_stages 实时读取
        return Task.FromResult(0);
    }

    // ━━━ 内部：prompt_stages → Skill 转换 ━━━━━━━━

    private async Task<List<Skill>> GetSystemSkillsFromPromptsAsync(UserRole? roleFilter, CancellationToken ct)
    {
        var settings = await _promptService.GetEffectiveSettingsAsync(ct);

        var prompts = settings.Prompts.AsEnumerable();

        if (roleFilter.HasValue)
        {
            prompts = prompts.Where(p => p.Role == roleFilter.Value);
        }

        return prompts
            .OrderBy(p => p.Order)
            .Select(PromptEntryToSkill)
            .ToList();
    }

    private static Skill PromptEntryToSkill(PromptEntry prompt)
    {
        return new Skill
        {
            Id = prompt.PromptKey,
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
