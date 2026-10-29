using MongoDB.Driver;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.LlmGateway.ImageGen;

namespace PrdAgent.Api.Services;

public interface IVisualModelPolicyService
{
    /// <summary>运行时策略：只包含网关目录中仍存在的公开模型；失效默认值会被清空，绝不自动替换。</summary>
    Task<VisualModelPolicy> ReadAsync(CancellationToken ct);
    /// <summary>管理端原始配置：保留失效引用，便于管理员看见并迁移。</summary>
    Task<VisualModelPolicy> ReadStoredAsync(CancellationToken ct);
    Task<List<GatewayImageModel>> DiscoverAsync(string? appCaller, CancellationToken ct);
    Task<List<AvailableModelPool>> ListAsync(string? appCaller, CancellationToken ct);
    Task<string?> SaveAsync(VisualModelPolicy proposed, string userId, CancellationToken ct);
}

public sealed class VisualModelPolicyService(MongoDbContext db, HttpLlmGatewayClient gateway) : IVisualModelPolicyService
{
    public static readonly string[] AppCallers =
    [
        AppCallerRegistry.VisualAgent.Image.Text2Img,
        AppCallerRegistry.VisualAgent.Image.Img2Img,
        AppCallerRegistry.VisualAgent.Image.VisionGen,
    ];

    public async Task<VisualModelPolicy> ReadStoredAsync(CancellationToken ct)
        => (await db.AppSettings.Find(x => x.Id == "global").FirstOrDefaultAsync(ct))?.VisualModelPolicy
           ?? new VisualModelPolicy();

    public async Task<VisualModelPolicy> ReadAsync(CancellationToken ct)
    {
        var stored = await ReadStoredAsync(ct);
        var catalog = await DiscoverAsync(null, ct);
        return ReconcileForRuntime(stored, catalog);
    }

    public async Task<List<GatewayImageModel>> DiscoverAsync(string? appCaller, CancellationToken ct)
    {
        var catalogs = await Task.WhenAll((appCaller is null ? AppCallers : [appCaller])
            .Select(code => gateway.GetImageModelsAsync(code, ct)));
        return catalogs.SelectMany(x => x).DistinctBy(x => x.Model.Code).ToList();
    }

    public async Task<List<AvailableModelPool>> ListAsync(string? appCaller, CancellationToken ct)
    {
        // 菜单要保留失效项供管理员识别，但失效项绝不能继续获得“默认”身份。
        var policy = await ReadStoredAsync(ct);
        var catalog = await DiscoverAsync(appCaller, ct);
        return Project(policy, catalog);
    }

    /// <summary>
    /// 把 MAP 保存的业务策略与网关实时目录求交集。目录是模型存在性的权威来源；MAP 只拥有
    /// “哪些模型开放、哪一个是默认”的业务意图。失效项不参与运行，也不静默替换为列表首项。
    /// 原始配置由 ReadStoredAsync 保留，管理员仍能看见并显式迁移。
    /// </summary>
    public static VisualModelPolicy ReconcileForRuntime(
        VisualModelPolicy stored,
        IEnumerable<GatewayImageModel> catalog)
    {
        var availableIds = catalog
            .Select(x => x.Model.Code?.Trim())
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .Select(x => x!)
            .ToHashSet(StringComparer.Ordinal);
        var models = (stored.Models ?? [])
            .Where(x => x is not null && availableIds.Contains(x.ModelId))
            .Select(x => new VisualModelEntry
            {
                ModelId = x.ModelId,
                DisplayName = x.DisplayName,
                Description = x.Description,
            })
            .ToList();
        var defaultModelId = availableIds.Contains(stored.DefaultModelId)
            && models.Any(x => x.ModelId == stored.DefaultModelId)
                ? stored.DefaultModelId
                : string.Empty;
        return new VisualModelPolicy
        {
            Revision = stored.Revision,
            DefaultModelId = defaultModelId,
            Models = models,
            UpdatedAt = stored.UpdatedAt,
            UpdatedBy = stored.UpdatedBy,
        };
    }

    public static List<AvailableModelPool> Project(VisualModelPolicy policy, IEnumerable<GatewayImageModel> catalog)
    {
        var indexed = catalog.ToDictionary(x => x.Model.Code, StringComparer.Ordinal);
        return policy.Models.Select((entry, index) =>
        {
            var available = indexed.GetValueOrDefault(entry.ModelId)?.Model;
            return new AvailableModelPool
            {
                Id = available?.Id ?? entry.ModelId,
                Code = entry.ModelId,
                Name = entry.ResolveDisplayName(available?.Name),
                Description = entry.Description ?? available?.Description,
                Priority = index,
                ResolutionType = "LogicalModel",
                // 旧引用可以显示出来帮助修复，但不能再对外宣称它是可执行的默认模型。
                IsDefault = available is not null && policy.DefaultModelId == entry.ModelId,
                Capabilities = available?.Capabilities ?? [],
                Models = available?.Models ?? [],
            };
        }).ToList();
    }

    public async Task<string?> SaveAsync(VisualModelPolicy proposed, string userId, CancellationToken ct)
    {
        var validation = proposed.Validate();
        if (validation is not null) return validation;
        var discovered = (await DiscoverAsync(null, ct)).ToDictionary(x => x.Model.Code, StringComparer.Ordinal);
        foreach (var entry in proposed.Models)
        {
            if (!discovered.TryGetValue(entry.ModelId, out var model))
                return "开放列表包含未授权或暂不可用的模型，请刷新目录后重试。";
            entry.DisplayName = entry.ResolveDisplayName(model.Model.Name);
        }
        // 默认必须能完成无参考图的新建流程，不能把仅支持编辑的模型设为默认。
        var textModels = await DiscoverAsync(AppCallers[0], ct);
        if (!textModels.Any(x => x.Model.Code == proposed.DefaultModelId))
            return "默认模型必须支持文生图，请选择其他模型。";
        var revision = proposed.Revision;
        proposed.Revision++;
        proposed.UpdatedAt = DateTime.UtcNow;
        proposed.UpdatedBy = userId;
        await db.AppSettings.UpdateOneAsync(x => x.Id == "global",
            Builders<AppSettings>.Update.SetOnInsert(x => x.Id, "global"),
            new UpdateOptions { IsUpsert = true }, ct);
        var filter = Builders<AppSettings>.Filter.Eq(x => x.Id, "global")
            & (revision == 0
                ? Builders<AppSettings>.Filter.Eq(x => x.VisualModelPolicy, null)
                : Builders<AppSettings>.Filter.Eq(x => x.VisualModelPolicy!.Revision, revision));
        // 保持其它全局配置不变；并发编辑不覆盖较新的策略。
        var result = await db.AppSettings.UpdateOneAsync(filter,
            Builders<AppSettings>.Update.Set(x => x.VisualModelPolicy, proposed), cancellationToken: ct);
        return result.ModifiedCount == 1 ? null : "模型配置已被更新，请刷新后重新保存。";
    }
}
