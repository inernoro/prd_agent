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

public sealed class VisualModelPolicyService(
    MongoDbContext db,
    HttpLlmGatewayClient gateway,
    ILogger<VisualModelPolicyService> logger) : IVisualModelPolicyService
{
    internal const string BootstrapActor = "system:visual-model-policy-bootstrap";

    public static readonly string[] AppCallers =
    [
        AppCallerRegistry.VisualAgent.Image.Text2Img,
        AppCallerRegistry.VisualAgent.Image.Img2Img,
        AppCallerRegistry.VisualAgent.Image.VisionGen,
    ];

    public async Task<VisualModelPolicy> ReadAsync(CancellationToken ct)
    {
        var stored = (await db.AppSettings.Find(x => x.Id == "global").FirstOrDefaultAsync(ct))?.VisualModelPolicy;
        if (stored is not null) return stored;

        // 旧版本没有这份业务开放策略，升级后若继续把 null 当成「明确不开放」，视觉创作会在
        // 网关目录完全健康时突然变成空列表。这里只迁移一次：从文生图目录选网关标记的默认项
        // （没有标记时取稳定排序的第一项），写入后新模型仍不会自动开放。
        VisualModelPolicy? bootstrap;
        try
        {
            bootstrap = BuildBootstrapPolicy(
                await DiscoverAsync(AppCallers[0], ct),
                DateTime.UtcNow);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or InvalidOperationException)
        {
            logger.LogWarning(ex,
                "视觉创作开放策略尚未初始化，且当前读不到网关文生图目录；保留空策略并等待下次读取重试");
            return new VisualModelPolicy();
        }

        if (bootstrap is null)
        {
            logger.LogWarning("视觉创作开放策略尚未初始化，网关当前没有可迁移的文生图模型；等待目录就绪后重试");
            return new VisualModelPolicy();
        }

        await db.AppSettings.UpdateOneAsync(
            x => x.Id == "global",
            Builders<AppSettings>.Update.SetOnInsert(x => x.Id, "global"),
            new UpdateOptions { IsUpsert = true },
            CancellationToken.None);
        var result = await db.AppSettings.UpdateOneAsync(
            x => x.Id == "global" && x.VisualModelPolicy == null,
            Builders<AppSettings>.Update
                .Set(x => x.VisualModelPolicy, bootstrap)
                .Set(x => x.UpdatedAt, bootstrap.UpdatedAt ?? DateTime.UtcNow),
            cancellationToken: CancellationToken.None);
        if (result.ModifiedCount == 1)
        {
            logger.LogWarning(
                "检测到升级前缺少视觉创作开放策略，已一次性开放网关默认文生图模型 {ModelId}；后续新增模型仍需管理员显式开放",
                bootstrap.DefaultModelId);
            return bootstrap;
        }

        // 多实例或管理员可能在上面两次写之间先完成配置；永远以数据库里的胜出版本为准。
        return (await db.AppSettings.Find(x => x.Id == "global").FirstOrDefaultAsync(CancellationToken.None))?.VisualModelPolicy
               ?? new VisualModelPolicy();
    }

    internal static VisualModelPolicy? BuildBootstrapPolicy(
        IEnumerable<GatewayImageModel> textToImageCatalog,
        DateTime now)
    {
        var candidates = textToImageCatalog
            .Where(x => !string.IsNullOrWhiteSpace(x.Model.Code))
            .GroupBy(x => x.Model.Code, StringComparer.Ordinal)
            .Select(group => group.FirstOrDefault(x => x.Model.IsDefault) ?? group.First())
            .ToList();
        var selected = candidates.FirstOrDefault(x => x.Model.IsDefault) ?? candidates.FirstOrDefault();
        if (selected is null) return null;

        return new VisualModelPolicy
        {
            Revision = 1,
            DefaultModelId = selected.Model.Code,
            Models =
            [
                new VisualModelEntry
                {
                    ModelId = selected.Model.Code,
                    DisplayName = selected.Model.Name,
                    Description = selected.Model.Description,
                }
            ],
            UpdatedAt = now,
            UpdatedBy = BootstrapActor,
        };
    }

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
