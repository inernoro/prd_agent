using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// 模型池查询服务实现 — 三级互斥解析（专属池 > 默认池 > 传统配置）
/// </summary>
public class ModelPoolQueryService : IModelPoolQueryService
{
    private readonly MongoDbContext _db;

    public ModelPoolQueryService(MongoDbContext db)
    {
        _db = db;
    }

    public async Task<List<ModelPoolForAppResult>> GetModelPoolsAsync(
        string? appCallerCode, string modelType, CancellationToken ct = default)
    {
        var result = new List<ModelPoolForAppResult>();

        // Step 1: 查找 appCallerCode 绑定的专属模型池（最高优先级）
        if (!string.IsNullOrWhiteSpace(appCallerCode))
        {
            var app = await _db.LLMAppCallers
                .Find(a => a.AppCode == appCallerCode)
                .FirstOrDefaultAsync(ct);

            if (app != null)
            {
                var requirement = app.ModelRequirements
                    .FirstOrDefault(r => r.ModelType == modelType);

                if (requirement != null && requirement.ModelGroupIds.Count > 0)
                {
                    var dedicatedGroups = await _db.ModelGroups
                        .Find(g => requirement.ModelGroupIds.Contains(g.Id))
                        .SortBy(g => g.Priority)
                        .ThenBy(g => g.CreatedAt)
                        .ToListAsync(ct);

                    if (dedicatedGroups.Count > 0)
                    {
                        foreach (var group in dedicatedGroups)
                        {
                            result.Add(MapToResult(group, "DedicatedPool", isDedicated: true));
                        }
                        return result;
                    }
                }
            }
        }

        // Step 2: 没有专属模型池，查找该类型的默认模型池
        var defaultGroups = await _db.ModelGroups
            .Find(g => g.ModelType == modelType && g.IsDefaultForType)
            .SortBy(g => g.Priority)
            .ThenBy(g => g.CreatedAt)
            .ToListAsync(ct);

        if (defaultGroups.Count > 0)
        {
            foreach (var group in defaultGroups)
            {
                result.Add(MapToResult(group, "DefaultPool", isDefault: true));
            }
            return result;
        }

        // Step 3: 没有模型池，查找传统配置的默认生图模型（仅当 modelType 为 generation 时）
        if (modelType == "generation")
        {
            var legacyModel = await _db.LLMModels
                .Find(m => m.IsImageGen && m.Enabled)
                .FirstOrDefaultAsync(ct);

            if (legacyModel != null)
            {
                result.Add(new ModelPoolForAppResult
                {
                    Id = $"legacy-{legacyModel.Id}",
                    Name = $"默认生图 - {legacyModel.Name}",
                    Code = legacyModel.ModelName,
                    Priority = 1,
                    ModelType = modelType,
                    IsDefaultForType = false,
                    Models = new List<ModelPoolModelItem>
                    {
                        new()
                        {
                            ModelId = legacyModel.ModelName,
                            PlatformId = legacyModel.PlatformId ?? string.Empty,
                            Priority = 1,
                            HealthStatus = "Healthy"
                        }
                    },
                    ResolutionType = "DirectModel",
                    IsDedicated = false,
                    IsDefault = false,
                    IsLegacy = true
                });
            }
        }

        return result;
    }

    private static ModelPoolForAppResult MapToResult(
        ModelGroup group,
        string resolutionType,
        bool isDedicated = false,
        bool isDefault = false)
    {
        return new ModelPoolForAppResult
        {
            Id = group.Id,
            Name = group.Name,
            Code = group.Code,
            Priority = group.Priority,
            ModelType = group.ModelType,
            IsDefaultForType = group.IsDefaultForType,
            Description = group.Description,
            Models = group.Models?.Select(m => new ModelPoolModelItem
            {
                ModelId = m.ModelId,
                PlatformId = m.PlatformId,
                Priority = m.Priority,
                HealthStatus = m.HealthStatus.ToString()
            }).ToList() ?? new List<ModelPoolModelItem>(),
            ResolutionType = resolutionType,
            IsDedicated = isDedicated,
            IsDefault = isDefault,
            IsLegacy = false
        };
    }
}
