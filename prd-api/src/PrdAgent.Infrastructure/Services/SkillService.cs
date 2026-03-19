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

}
