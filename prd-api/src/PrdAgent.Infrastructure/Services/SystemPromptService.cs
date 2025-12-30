using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// 系统提示词服务：默认值来自 PromptManager.BuildSystemPrompt（硬编码模板），管理员可在 Mongo 覆盖
/// </summary>
public class SystemPromptService : ISystemPromptService
{
    private readonly MongoDbContext _db;
    private readonly IPromptManager _promptManager;

    public SystemPromptService(MongoDbContext db, IPromptManager promptManager)
    {
        _db = db;
        _promptManager = promptManager;
    }

    public async Task<SystemPromptSettings> GetEffectiveSettingsAsync(CancellationToken ct = default)
    {
        // 按要求：任何情况下均回源 MongoDB，不使用内存缓存（避免时效性与多实例一致性问题）
        return await BuildEffectiveSettingsAsync(ct);
    }

    public Task<SystemPromptSettings> GetDefaultSettingsAsync(CancellationToken ct = default)
    {
        _ = ct; // sync：默认值来自内置 PromptManager
        return Task.FromResult(BuildDefaultSettings());
    }

    public async Task<string> GetSystemPromptAsync(UserRole role, CancellationToken ct = default)
    {
        var settings = await GetEffectiveSettingsAsync(ct);
        var entry = settings.Entries.FirstOrDefault(x => x.Role == role);
        if (entry != null && !string.IsNullOrWhiteSpace(entry.SystemPrompt))
        {
            return entry.SystemPrompt.Trim();
        }

        // 兜底：默认值
        return _promptManager.BuildSystemPrompt(role, prdContent: string.Empty).Trim();
    }

    public async Task RefreshAsync(CancellationToken ct = default)
    {
        // 已禁用缓存：Refresh 无需做任何事，保留接口以兼容调用方
        _ = ct;
        await Task.CompletedTask;
    }

    private SystemPromptSettings BuildDefaultSettings()
    {
        var entries = new List<SystemPromptEntry>();
        foreach (var r in new[] { UserRole.PM, UserRole.DEV, UserRole.QA })
        {
            entries.Add(new SystemPromptEntry
            {
                Role = r,
                SystemPrompt = _promptManager.BuildSystemPrompt(r, prdContent: string.Empty).Trim()
            });
        }

        return new SystemPromptSettings
        {
            Id = "global",
            UpdatedAt = DateTime.UtcNow,
            Entries = entries
        };
    }

    private async Task<SystemPromptSettings> BuildEffectiveSettingsAsync(CancellationToken ct)
    {
        var defaults = BuildDefaultSettings();

        var doc = await _db.SystemPrompts.Find(x => x.Id == "global").FirstOrDefaultAsync(ct);
        if (doc == null)
        {
            await _db.SystemPrompts.ReplaceOneAsync(
                s => s.Id == "global",
                defaults,
                new ReplaceOptions { IsUpsert = true },
                ct);
            return defaults;
        }

        // normalize + 校验：仅允许 PM/DEV/QA
        var entries = (doc.Entries ?? new List<SystemPromptEntry>())
            .Where(x => x.Role is UserRole.PM or UserRole.DEV or UserRole.QA)
            .Select(x => new SystemPromptEntry
            {
                Role = x.Role,
                SystemPrompt = (x.SystemPrompt ?? string.Empty).Trim()
            })
            .ToList();

        if (entries.Count == 0)
        {
            await _db.SystemPrompts.ReplaceOneAsync(
                s => s.Id == "global",
                defaults,
                new ReplaceOptions { IsUpsert = true },
                ct);
            return defaults;
        }

        // 确保三角色齐全：缺失的用默认值补齐（避免部分角色 500/行为异常）
        foreach (var r in new[] { UserRole.PM, UserRole.DEV, UserRole.QA })
        {
            if (entries.All(x => x.Role != r))
            {
                entries.Add(new SystemPromptEntry
                {
                    Role = r,
                    SystemPrompt = _promptManager.BuildSystemPrompt(r, prdContent: string.Empty).Trim()
                });
            }
        }

        var effective = new SystemPromptSettings
        {
            Id = "global",
            UpdatedAt = doc.UpdatedAt == default ? DateTime.UtcNow : doc.UpdatedAt,
            Entries = entries.OrderBy(x => x.Role).ToList()
        };

        // 统一写回：补齐角色/清理非法 role 后写回（保持 updatedAt 不变）
        await _db.SystemPrompts.ReplaceOneAsync(
            s => s.Id == "global",
            effective,
            new ReplaceOptions { IsUpsert = true },
            ct);

        return effective;
    }
}


