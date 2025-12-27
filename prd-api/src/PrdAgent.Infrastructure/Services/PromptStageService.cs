using Microsoft.Extensions.Caching.Memory;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// 阶段提示词服务：默认值来自 PromptManager（硬编码模板），管理员可在 Mongo 覆盖
/// </summary>
public class PromptStageService : IPromptStageService
{
    private readonly MongoDbContext _db;
    private readonly IMemoryCache _cache;
    private readonly IPromptManager _promptManager;

    private const string CacheKey = "PromptStages:Effective:Global";
    private static readonly TimeSpan CacheExpiration = TimeSpan.FromMinutes(5);

    public PromptStageService(MongoDbContext db, IMemoryCache cache, IPromptManager promptManager)
    {
        _db = db;
        _cache = cache;
        _promptManager = promptManager;
    }

    public async Task<PromptStageSettings> GetEffectiveSettingsAsync(CancellationToken ct = default)
    {
        if (_cache.TryGetValue<PromptStageSettings>(CacheKey, out var cached))
        {
            return cached!;
        }

        var effective = await BuildEffectiveSettingsAsync(ct);
        _cache.Set(CacheKey, effective, CacheExpiration);
        return effective;
    }

    public async Task<PromptStagesClientResponse> GetStagesForClientAsync(CancellationToken ct = default)
    {
        var settings = await GetEffectiveSettingsAsync(ct);

        var items = settings.Stages
            .OrderBy(x => x.Order)
            .Select(s => new PromptStageClientItem(
                StageKey: s.StageKey,
                Order: s.Order,
                Step: s.Step ?? s.Order,
                PmTitle: s.Pm.Title,
                DevTitle: s.Dev.Title,
                QaTitle: s.Qa.Title))
            .ToList();

        return new PromptStagesClientResponse(settings.UpdatedAt, items);
    }

    public async Task<List<GuideOutlineItem>> GetGuideOutlineAsync(UserRole role, CancellationToken ct = default)
    {
        var settings = await GetEffectiveSettingsAsync(ct);
        var stages = settings.Stages.OrderBy(x => x.Order).ToList();

        RoleStagePrompt GetRolePrompt(PromptStage s) => role switch
        {
            UserRole.DEV => s.Dev,
            UserRole.QA => s.Qa,
            _ => s.Pm
        };

        return stages.Select(s =>
        {
            var rp = GetRolePrompt(s);
            return new GuideOutlineItem
            {
                Step = s.Step ?? s.Order,
                Title = rp.Title,
                PromptTemplate = rp.PromptTemplate
            };
        }).ToList();
    }

    public async Task<RoleStagePrompt?> GetStagePromptAsync(UserRole role, int step, CancellationToken ct = default)
    {
        if (step < 1) return null;

        var settings = await GetEffectiveSettingsAsync(ct);
        var s = settings.Stages.FirstOrDefault(x => x.Order == step || x.Step == step);
        if (s == null) return null;

        return role switch
        {
            UserRole.DEV => s.Dev,
            UserRole.QA => s.Qa,
            _ => s.Pm
        };
    }

    public async Task<RoleStagePrompt?> GetStagePromptByKeyAsync(UserRole role, string stageKey, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(stageKey)) return null;
        var settings = await GetEffectiveSettingsAsync(ct);
        var s = settings.Stages.FirstOrDefault(x => string.Equals(x.StageKey, stageKey.Trim(), StringComparison.Ordinal));
        if (s == null) return null;
        return role switch
        {
            UserRole.DEV => s.Dev,
            UserRole.QA => s.Qa,
            _ => s.Pm
        };
    }

    public async Task<string?> MapOrderToStageKeyAsync(int order, CancellationToken ct = default)
    {
        if (order < 1) return null;
        var settings = await GetEffectiveSettingsAsync(ct);
        var s = settings.Stages.FirstOrDefault(x => x.Order == order || x.Step == order);
        return string.IsNullOrWhiteSpace(s?.StageKey) ? null : s!.StageKey;
    }

    public async Task RefreshAsync(CancellationToken ct = default)
    {
        _cache.Remove(CacheKey);
        _ = await GetEffectiveSettingsAsync(ct);
    }

    private async Task<PromptStageSettings> BuildEffectiveSettingsAsync(CancellationToken ct)
    {
        var defaults = BuildDefaultSettings();

        var overridden = await _db.PromptStages.Find(s => s.Id == "global").FirstOrDefaultAsync(ct);
        if (overridden == null || overridden.Stages.Count == 0)
        {
            return defaults;
        }

        // 迁移/归一化：兼容旧数据（Step=1..N 且无 StageKey/Order）
        var normalized = NormalizeOverridden(overridden);

        // 一次性写回迁移：避免每次运行都做兼容推导（保持 updatedAt 不变）
        if (normalized.NeedsWriteBack)
        {
            await _db.PromptStages.ReplaceOneAsync(
                s => s.Id == "global",
                normalized.Settings,
                new ReplaceOptions { IsUpsert = true },
                ct);
        }

        // 合并策略：以管理员配置为主（允许增删/排序）；字段为空则回退默认（仅对 order=1..6 有默认）
        var defaultByKey = defaults.Stages
            .Where(x => !string.IsNullOrWhiteSpace(x.StageKey))
            .ToDictionary(x => x.StageKey, StringComparer.Ordinal);
        var defaultByOrder = defaults.Stages
            .Where(x => x.Order > 0)
            .ToDictionary(x => x.Order);

        foreach (var s in normalized.Settings.Stages)
        {
            PromptStage? fallback = null;
            if (!string.IsNullOrWhiteSpace(s.StageKey) && defaultByKey.TryGetValue(s.StageKey, out var byKey))
                fallback = byKey;
            else if (s.Order > 0 && defaultByOrder.TryGetValue(s.Order, out var byOrder))
                fallback = byOrder;

            // 字段空则回退默认/兜底
            FillRoleIfEmpty(s.Pm, fallback?.Pm, s.Order);
            FillRoleIfEmpty(s.Dev, fallback?.Dev, s.Order);
            FillRoleIfEmpty(s.Qa, fallback?.Qa, s.Order);

            // 旧字段保持一致，便于旧客户端/旧接口读取
            s.Step ??= s.Order > 0 ? s.Order : null;
        }

        normalized.Settings.UpdatedAt = overridden.UpdatedAt;
        return normalized.Settings;
    }

    private static void MergeRole(RoleStagePrompt target, RoleStagePrompt? incoming)
    {
        if (incoming == null) return;
        if (!string.IsNullOrWhiteSpace(incoming.Title)) target.Title = incoming.Title;
        if (!string.IsNullOrWhiteSpace(incoming.PromptTemplate)) target.PromptTemplate = incoming.PromptTemplate;
    }

    private PromptStageSettings BuildDefaultSettings()
    {
        static Dictionary<int, GuideOutlineItem> ToMap(List<GuideOutlineItem> items)
            => items.ToDictionary(x => x.Step, x => x);

        var pm = ToMap(_promptManager.GetGuideOutline(UserRole.PM));
        var dev = ToMap(_promptManager.GetGuideOutline(UserRole.DEV));
        var qa = ToMap(_promptManager.GetGuideOutline(UserRole.QA));

        var stages = new List<PromptStage>();
        for (var step = 1; step <= 6; step++)
        {
            pm.TryGetValue(step, out var pmi);
            dev.TryGetValue(step, out var devi);
            qa.TryGetValue(step, out var qai);

            stages.Add(new PromptStage
            {
                StageKey = $"legacy-step-{step}",
                Order = step,
                Step = step,
                Pm = new RoleStagePrompt
                {
                    Title = pmi?.Title ?? $"阶段 {step}",
                    PromptTemplate = pmi?.PromptTemplate ?? string.Empty
                },
                Dev = new RoleStagePrompt
                {
                    Title = devi?.Title ?? $"阶段 {step}",
                    PromptTemplate = devi?.PromptTemplate ?? string.Empty
                },
                Qa = new RoleStagePrompt
                {
                    Title = qai?.Title ?? $"阶段 {step}",
                    PromptTemplate = qai?.PromptTemplate ?? string.Empty
                }
            });
        }

        return new PromptStageSettings
        {
            Id = "global",
            Stages = stages,
            // 默认值不落库，这里的 UpdatedAt 仅用于客户端显示；若有覆盖会替换为覆盖 UpdatedAt
            UpdatedAt = DateTime.UtcNow
        };
    }

    private static void FillRoleIfEmpty(RoleStagePrompt target, RoleStagePrompt? fallback, int order)
    {
        if (string.IsNullOrWhiteSpace(target.Title))
            target.Title = !string.IsNullOrWhiteSpace(fallback?.Title) ? fallback!.Title : $"阶段 {order}";
        if (string.IsNullOrWhiteSpace(target.PromptTemplate))
            target.PromptTemplate = !string.IsNullOrWhiteSpace(fallback?.PromptTemplate) ? fallback!.PromptTemplate : string.Empty;
    }

    private static (PromptStageSettings Settings, bool NeedsWriteBack) NormalizeOverridden(PromptStageSettings overridden)
    {
        var needs = false;
        var settings = new PromptStageSettings
        {
            Id = overridden.Id,
            UpdatedAt = overridden.UpdatedAt,
            Stages = overridden.Stages ?? new List<PromptStage>()
        };

        // 确保 list 非空
        settings.Stages ??= new List<PromptStage>();

        // 先补齐 order/stageKey，再按 order 排序
        var nextOrder = 1;
        foreach (var s in settings.Stages)
        {
            if (s == null) continue;

            if (s.Order <= 0)
            {
                if (s.Step.HasValue && s.Step.Value > 0)
                {
                    s.Order = s.Step.Value;
                }
                else
                {
                    s.Order = nextOrder;
                }
                needs = true;
            }

            if (!s.Step.HasValue || s.Step.Value <= 0)
            {
                s.Step = s.Order > 0 ? s.Order : null;
                needs = true;
            }

            if (string.IsNullOrWhiteSpace(s.StageKey))
            {
                // 兼容旧结构：按 step 生成稳定 key；避免随机 key 导致每次启动变化
                var k = s.Step.HasValue && s.Step.Value > 0 ? $"legacy-step-{s.Step.Value}" : $"legacy-order-{s.Order}";
                s.StageKey = k;
                needs = true;
            }

            nextOrder = Math.Max(nextOrder, s.Order + 1);
        }

        settings.Stages = settings.Stages
            .Where(x => x != null)
            .OrderBy(x => x.Order)
            .ToList();

        return (settings, needs);
    }
}


