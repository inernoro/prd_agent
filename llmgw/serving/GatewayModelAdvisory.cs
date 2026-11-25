using System.Globalization;
using Microsoft.Extensions.Configuration;
using PrdAgent.Core.LlmGateway;
using PrdAgent.GatewayTransport;

namespace PrdAgent.LlmGatewayHost;

/// <summary>淘汰信息只读。推荐复用当前调用方的可用目录，线上默认仍由服务路由决定。</summary>
public static class GatewayModelAdvisory
{
    public static async Task<ModelLifecycleAdvisory> ReadAsync(ILlmGateway gateway, IConfiguration configuration,
        string caller, string modelType, string? expectedModel, CancellationToken ct)
    {
        var current = await gateway.ResolveModelMetadataAsync(caller, modelType, expectedModel, ct: ct);
        var resolvedDefault = string.IsNullOrWhiteSpace(expectedModel) ? current
            : await gateway.ResolveModelMetadataAsync(caller, modelType, ct: ct);
        var pools = await gateway.GetAvailablePoolsAsync(caller, modelType, ct);
        var defaultPool = pools.FirstOrDefault(pool => pool.IsDefault);
        var currentPool = pools.FirstOrDefault(pool => string.Equals(pool.Code, current.LogicalModelPublicId, StringComparison.Ordinal));
        var notices = configuration.GetSection("LlmGateway:ModelAdvisories:Notices").GetChildren()
            .Select(item => new ModelRetirementNotice(item["ProviderId"] ?? "", item["ModelId"] ?? "",
                DateTimeOffset.TryParseExact(item["RetirementAt"], ["yyyy-MM-dd", "yyyy-MM-dd'T'HH:mm:ssK"],
                    CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var at) ? at : default,
                item["Source"] ?? ""))
            .ToArray();
        var notice = current.Success ? ModelLifecycleAdvisory.MatchNotice(notices, current.ActualPlatformId, current.ActualModel) : null;
        var suffix = ModelLifecycleAdvisory.GetSuffix(current.ActualModel);
        ModelAdvisoryRecommendation[] recommendations = currentPool is null || string.IsNullOrEmpty(suffix) ? [] :
            pools.Where(pool => pool != currentPool && currentPool.Capabilities.All(capability =>
                    pool.Capabilities.Contains(capability, StringComparer.OrdinalIgnoreCase)))
                .Select(pool => (Pool: pool, Model: pool.Models.FirstOrDefault(model =>
                    model.HealthStatus is "Healthy" or "Degraded" && !string.IsNullOrWhiteSpace(model.ActualModelId))))
                .Where(candidate => candidate.Model is { } model
                    && string.Equals(suffix, ModelLifecycleAdvisory.GetSuffix(model.ActualModelId), StringComparison.Ordinal)
                    && ModelLifecycleAdvisory.MatchNotice(notices, model.ActualPlatformId ?? "", model.ActualModelId!) is null)
                .OrderByDescending(candidate => candidate.Pool.IsDefault)
                .ThenBy(candidate => candidate.Pool.Priority).ThenBy(candidate => candidate.Pool.Code, StringComparer.Ordinal)
                .Take(5).Select(candidate => new ModelAdvisoryRecommendation(candidate.Pool.Code, candidate.Model!.ActualModelId)).ToArray();

        return new ModelLifecycleAdvisory(
            !current.Success ? "unresolved" : notice is null ? "unknown" : "announced",
            DateTimeOffset.UtcNow, current.LogicalModelPublicId,
            current.Success ? current.ActualModel : null,
            defaultPool?.Code,
            resolvedDefault.Success && defaultPool is not null
                && string.Equals(defaultPool.Code, resolvedDefault.LogicalModelPublicId, StringComparison.Ordinal),
            notice, recommendations);
    }
}
