using MongoDB.Driver;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.LlmGateway.ImageGen;

namespace PrdAgent.Api.Services;

public interface IVisualModelPolicyService
{
    Task<VisualModelPolicy> ReadAsync(CancellationToken ct);
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

    public async Task<VisualModelPolicy> ReadAsync(CancellationToken ct)
        => (await db.AppSettings.Find(x => x.Id == "global").FirstOrDefaultAsync(ct))?.VisualModelPolicy
           ?? new VisualModelPolicy();

    public async Task<List<GatewayImageModel>> DiscoverAsync(string? appCaller, CancellationToken ct)
    {
        var catalogs = await Task.WhenAll((appCaller is null ? AppCallers : [appCaller])
            .Select(code => gateway.GetImageModelsAsync(code, ct)));
        return catalogs.SelectMany(x => x).DistinctBy(x => x.Model.Code).ToList();
    }

    public async Task<List<AvailableModelPool>> ListAsync(string? appCaller, CancellationToken ct)
    {
        var policy = await ReadAsync(ct);
        var catalog = await DiscoverAsync(appCaller, ct);
        return Project(policy, catalog);
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
                Name = available?.Name ?? entry.DisplayName,
                Description = entry.Description ?? available?.Description,
                Priority = index,
                ResolutionType = "LogicalModel",
                IsDefault = policy.DefaultModelId == entry.ModelId,
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
            entry.DisplayName = model.Model.Name;
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
