using Microsoft.Extensions.Caching.Memory;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// 提示词服务：默认值来自 PromptManager（硬编码模板），管理员可在 Mongo 覆盖
/// </summary>
public class PromptService : IPromptService
{
    private readonly MongoDbContext _db;
    private readonly IMemoryCache _cache;
    private readonly IPromptManager _promptManager;

    private const string CacheKey = "Prompts:Effective:Global";
    private static readonly TimeSpan CacheExpiration = TimeSpan.FromMinutes(5);

    public PromptService(MongoDbContext db, IMemoryCache cache, IPromptManager promptManager)
    {
        _db = db;
        _cache = cache;
        _promptManager = promptManager;
    }

    public async Task<PromptSettings> GetEffectiveSettingsAsync(CancellationToken ct = default)
    {
        if (_cache.TryGetValue<PromptSettings>(CacheKey, out var cached))
        {
            return cached!;
        }

        var effective = await BuildEffectiveSettingsAsync(ct);
        _cache.Set(CacheKey, effective, CacheExpiration);
        return effective;
    }

    public Task<PromptSettings> GetDefaultSettingsAsync(CancellationToken ct = default)
    {
        _ = ct; // sync：默认值来自内置 PromptManager
        return Task.FromResult(BuildDefaultSettings());
    }

    public async Task<PromptsClientResponse> GetPromptsForClientAsync(CancellationToken ct = default)
    {
        var settings = await GetEffectiveSettingsAsync(ct);

        var items = settings.Prompts
            .Where(x => x.Role is UserRole.PM or UserRole.DEV or UserRole.QA)
            .OrderBy(x => x.Role)
            .ThenBy(x => x.Order)
            .Select(s => new PromptClientItem(
                PromptKey: s.PromptKey,
                Order: s.Order,
                Role: s.Role,
                Title: s.Title))
            .ToList();

        return new PromptsClientResponse(settings.UpdatedAt, items);
    }

    public async Task<RolePrompt?> GetPromptByKeyAsync(UserRole role, string promptKey, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(promptKey)) return null;
        var key = promptKey.Trim();
        var settings = await GetEffectiveSettingsAsync(ct);

        // 新语义：promptKey 全局唯一，且对某一角色有效
        var s = settings.Prompts.FirstOrDefault(x => string.Equals(x.PromptKey, key, StringComparison.Ordinal));
        if (s != null)
        {
            if (s.Role != role) return null;
            return new RolePrompt { Title = s.Title, PromptTemplate = s.PromptTemplate };
        }

        // 兼容：旧语义可能传“共享 key”（如 legacy-step-1 / legacy-prompt-1），按 role 补后缀再查
        var roleSuffix = RoleSuffix(role);
        if (roleSuffix != null && !key.EndsWith("-" + roleSuffix, StringComparison.OrdinalIgnoreCase))
        {
            var mapped = $"{key}-{roleSuffix}";
            var s2 = settings.Prompts.FirstOrDefault(x => string.Equals(x.PromptKey, mapped, StringComparison.Ordinal));
            if (s2 != null && s2.Role == role)
                return new RolePrompt { Title = s2.Title, PromptTemplate = s2.PromptTemplate };
        }

        return null;
    }

    public async Task RefreshAsync(CancellationToken ct = default)
    {
        _cache.Remove(CacheKey);
        _ = await GetEffectiveSettingsAsync(ct);
    }

    private async Task<PromptSettings> BuildEffectiveSettingsAsync(CancellationToken ct)
    {
        var defaults = BuildDefaultSettings();

        // 用 raw 读取，便于兼容旧结构迁移（旧结构含 pm/dev/qa 子对象）
        var raw = await _db.PromptsRaw.Find(Builders<BsonDocument>.Filter.Eq("_id", "global")).FirstOrDefaultAsync(ct);
        if (raw == null)
        {
            // DB 缺失：自动初始化为系统内置默认（写入 DB，保证后续“所有交互都走数据库”）
            await _db.Prompts.ReplaceOneAsync(
                s => s.Id == "global",
                defaults,
                new ReplaceOptions { IsUpsert = true },
                ct);
            return defaults;
        }

        var parsed = ParsePrompts(raw);
        if (parsed.Entries.Count == 0)
        {
            // DB 存在但无有效 stages：视为缺失，重置为默认并写回
            await _db.Prompts.ReplaceOneAsync(
                s => s.Id == "global",
                defaults,
                new ReplaceOptions { IsUpsert = true },
                ct);
            return defaults;
        }

        var effective = new PromptSettings
        {
            Id = "global",
            UpdatedAt = parsed.UpdatedAt ?? DateTime.UtcNow,
            Prompts = parsed.Entries
        };

        // 一次性写回迁移：将旧结构/混合结构统一写回新结构（保持 updatedAt 不变）
        if (parsed.NeedsWriteBack)
        {
            await _db.Prompts.ReplaceOneAsync(
                s => s.Id == "global",
                effective,
                new ReplaceOptions { IsUpsert = true },
                ct);
        }

        return effective;
    }

    private PromptSettings BuildDefaultSettings()
    {
        var prompts = new List<PromptEntry>();
        foreach (var r in new[] { UserRole.PM, UserRole.DEV, UserRole.QA })
        {
            var outline = _promptManager.GetGuideOutline(r) ?? new List<GuideOutlineItem>();
            foreach (var item in outline.OrderBy(x => x.Step))
            {
                var suffix = RoleSuffix(r) ?? "pm";
                prompts.Add(new PromptEntry
                {
                    Role = r,
                    Order = item.Step,
                    PromptKey = $"legacy-prompt-{item.Step}-{suffix}",
                    Title = item.Title ?? $"提示词 {item.Step}",
                    PromptTemplate = item.PromptTemplate ?? string.Empty
                });
            }
        }

        return new PromptSettings
        {
            Id = "global",
            Prompts = prompts
                .OrderBy(x => x.Role)
                .ThenBy(x => x.Order)
                .ToList(),
            // 默认值会在 DB 缺失时自动写入；UpdatedAt 用于 UI 显示与客户端缓存刷新
            UpdatedAt = DateTime.UtcNow
        };
    }

    private static string? RoleSuffix(UserRole role)
        => role switch
        {
            UserRole.PM => "pm",
            UserRole.DEV => "dev",
            UserRole.QA => "qa",
            _ => null
        };

    private static UserRole? ParseRole(BsonValue v)
    {
        try
        {
            if (v == null || v.IsBsonNull) return null;
            if (v.IsInt32) return (UserRole)v.AsInt32;
            if (v.IsString)
            {
                var s = v.AsString.Trim();
                if (Enum.TryParse<UserRole>(s, ignoreCase: true, out var r)) return r;
            }
        }
        catch
        {
            // ignore
        }
        return null;
    }

    private static string ReadString(BsonDocument doc, string name)
        => doc.TryGetValue(name, out var v) && v.IsString ? v.AsString : string.Empty;

    private static int? ReadInt(BsonDocument doc, string name)
        => doc.TryGetValue(name, out var v) && v.IsInt32 ? v.AsInt32 : (v.IsInt64 ? (int)v.AsInt64 : null);

    private static DateTime? ReadDateTime(BsonDocument doc, string name)
    {
        if (!doc.TryGetValue(name, out var v) || v.IsBsonNull) return null;
        try
        {
            if (v.IsValidDateTime) return v.ToUniversalTime();
        }
        catch
        {
            // ignore
        }
        return null;
    }

    private static (List<PromptEntry> Entries, DateTime? UpdatedAt, bool NeedsWriteBack) ParsePrompts(BsonDocument raw)
    {
        var updatedAt = ReadDateTime(raw, "updatedAt");
        var needsWriteBack = false;

        BsonArray? arr = null;
        if (raw.TryGetValue("prompts", out var promptsVal) && promptsVal.IsBsonArray)
        {
            arr = promptsVal.AsBsonArray;
        }
        else if (raw.TryGetValue("stages", out var stagesVal) && stagesVal.IsBsonArray)
        {
            // 兼容旧结构：stages
            arr = stagesVal.AsBsonArray;
            needsWriteBack = true;
        }

        if (arr == null)
        {
            return (new List<PromptEntry>(), updatedAt, false);
        }

        var entries = new List<PromptEntry>();

        foreach (var it in arr)
        {
            if (!it.IsBsonDocument) continue;
            var d = it.AsBsonDocument;

            // 新结构：包含 role/title/promptTemplate
            if (d.Contains("role"))
            {
                var role = ParseRole(d["role"]);
                if (role is not (UserRole.PM or UserRole.DEV or UserRole.QA)) continue;
                var promptKey = ReadString(d, "promptKey").Trim();
                if (string.IsNullOrWhiteSpace(promptKey))
                {
                    // 兼容：旧字段 stageKey
                    promptKey = ReadString(d, "stageKey").Trim();
                    if (!string.IsNullOrWhiteSpace(promptKey)) needsWriteBack = true;
                }
                if (string.IsNullOrWhiteSpace(promptKey)) continue;
                var order = ReadInt(d, "order") ?? 0;
                if (order <= 0) continue;
                entries.Add(new PromptEntry
                {
                    PromptKey = promptKey,
                    Role = role.Value,
                    Order = order,
                    Title = ReadString(d, "title"),
                    PromptTemplate = ReadString(d, "promptTemplate")
                });
                continue;
            }

            // 旧结构：包含 pm/dev/qa 子对象（每个阶段一条）
            if (d.Contains("pm") || d.Contains("dev") || d.Contains("qa"))
            {
                needsWriteBack = true;
                var baseKey = ReadString(d, "promptKey").Trim();
                if (string.IsNullOrWhiteSpace(baseKey))
                {
                    baseKey = ReadString(d, "stageKey").Trim();
                }
                var order = ReadInt(d, "order") ?? ReadInt(d, "step") ?? 0;
                if (order <= 0) continue;
                if (string.IsNullOrWhiteSpace(baseKey)) baseKey = $"legacy-prompt-{order}";

                foreach (var (role, suffix, field) in new[]
                         {
                             (UserRole.PM, "pm", "pm"),
                             (UserRole.DEV, "dev", "dev"),
                             (UserRole.QA, "qa", "qa"),
                         })
                {
                    if (!d.TryGetValue(field, out var rv) || !rv.IsBsonDocument) continue;
                    var rd = rv.AsBsonDocument;
                    var title = ReadString(rd, "title");
                    var prompt = ReadString(rd, "promptTemplate");
                    entries.Add(new PromptEntry
                    {
                        Role = role,
                        Order = order,
                        PromptKey = $"{baseKey}-{suffix}",
                        Title = title,
                        PromptTemplate = prompt
                    });
                }
                continue;
            }

            // 更早的旧结构：{ step, role, title, promptTemplate }
            if (d.Contains("step") && d.Contains("title") && d.Contains("promptTemplate"))
            {
                needsWriteBack = true;
                var role = d.Contains("role") ? ParseRole(d["role"]) : null;
                if (role is not (UserRole.PM or UserRole.DEV or UserRole.QA)) role = UserRole.PM;
                var order = ReadInt(d, "order") ?? ReadInt(d, "step") ?? 0;
                if (order <= 0) continue;
                var promptKey = ReadString(d, "promptKey").Trim();
                if (string.IsNullOrWhiteSpace(promptKey))
                {
                    promptKey = ReadString(d, "stageKey").Trim();
                }
                if (string.IsNullOrWhiteSpace(promptKey))
                    promptKey = $"legacy-prompt-{order}-{RoleSuffix(role.Value) ?? "pm"}";
                entries.Add(new PromptEntry
                {
                    Role = role.Value,
                    Order = order,
                    PromptKey = promptKey,
                    Title = ReadString(d, "title"),
                    PromptTemplate = ReadString(d, "promptTemplate")
                });
            }
        }

        // 归一化：只保留 PM/DEV/QA，promptKey 唯一；order 在 role 内排序
        entries = entries
            .Where(e => e.Role is UserRole.PM or UserRole.DEV or UserRole.QA)
            .Where(e => !string.IsNullOrWhiteSpace(e.PromptKey))
            .Where(e => e.Order > 0)
            .GroupBy(e => e.PromptKey, StringComparer.Ordinal)
            .Select(g => g.First())
            .OrderBy(e => e.Role)
            .ThenBy(e => e.Order)
            .ToList();

        // 如果存在 role 内 order 重复，仍写回时由后端/前端再修正；这里保持原样
        return (entries, updatedAt, needsWriteBack);
    }
}


