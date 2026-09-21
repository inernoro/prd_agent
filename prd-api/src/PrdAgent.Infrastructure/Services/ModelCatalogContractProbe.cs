using PrdAgent.Core.Interfaces;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// 业务模型选择器与运行时目录、当前可用性的一致性探针。
///
/// 选择器曾从退场的 MAP 模型池读取成员展示名，而执行链路只接受 LLM Gateway
/// 的稳定 PublicId。两边各自“有数据”却无法串起来，因此这里直接验证完整契约：
/// 目录非空、默认项唯一、下发标识存在于运行时目录且至少有可用线路。
/// </summary>
public sealed class ModelCatalogContractProbe
{
    internal static readonly ModelCatalogContractTarget[] Targets =
    [
        new("文学创作对话", AppCallerRegistry.LiteraryAgent.Content.Chat, ModelTypes.Chat),
        new("文学创作文生图", AppCallerRegistry.LiteraryAgent.Illustration.Text2Img, ModelTypes.ImageGen),
        new("文学创作图生图", AppCallerRegistry.LiteraryAgent.Illustration.Img2Img, ModelTypes.ImageGen),
        new("视频直出", AppCallerRegistry.VideoAgent.VideoGen.Generate, ModelTypes.VideoGen),
        new("百宝箱视觉创作", AppCallerRegistry.AiToolbox.Agents.VisualGeneration, ModelTypes.ImageGen),
    ];

    private readonly IModelPoolQueryService _catalog;
    private readonly ILlmGateway _gateway;

    public ModelCatalogContractProbe(IModelPoolQueryService catalog, ILlmGateway gateway)
    {
        _catalog = catalog;
        _gateway = gateway;
    }

    public async Task<ModelCatalogContractProbeResult> CheckAsync(CancellationToken ct = default)
    {
        var failures = new List<string>();
        var catalogEntries = 0;

        foreach (var target in Targets)
        {
            try
            {
                var pools = await _catalog.GetModelPoolsAsync(target.AppCallerCode, target.ModelType, ct);
                catalogEntries += pools.Count;
                if (pools.Count == 0)
                {
                    failures.Add($"{target.Label}:CATALOG_EMPTY");
                    continue;
                }

                // ResolveAsync 在半开线路上会认领恢复租约，不适合只读健康探针。
                // GetAvailablePoolsAsync 内部同样经过真实 Offering 构建、调用方场景和名录门，
                // 但不会占用半开租约；不可用项仍保留健康态，供这里把故障计入监控。
                var runtimePools = await _gateway.GetAvailablePoolsAsync(
                    target.AppCallerCode,
                    target.ModelType,
                    ct);
                var runtimeByPublicId = runtimePools
                    .Where(pool => !string.IsNullOrWhiteSpace(pool.Code))
                    .GroupBy(pool => pool.Code.Trim(), StringComparer.Ordinal)
                    .ToDictionary(group => group.Key, group => group.First(), StringComparer.Ordinal);
                if (runtimeByPublicId.Count == 0)
                {
                    failures.Add($"{target.Label}:RUNTIME_CATALOG_EMPTY");
                }

                var duplicateCodes = pools
                    .Where(pool => !string.IsNullOrWhiteSpace(pool.Code))
                    .GroupBy(pool => pool.Code.Trim(), StringComparer.OrdinalIgnoreCase)
                    .Where(group => group.Count() > 1)
                    .Select(group => group.Key)
                    .ToArray();
                if (duplicateCodes.Length > 0)
                {
                    failures.Add($"{target.Label}:DUPLICATE_PUBLIC_ID");
                }

                var defaults = pools.Where(pool => pool.IsDefault).ToArray();
                if (defaults.Length != 1)
                {
                    failures.Add($"{target.Label}:DEFAULT_COUNT_{defaults.Length}");
                }

                foreach (var pool in pools)
                {
                    var publicId = pool.Code?.Trim() ?? string.Empty;
                    var member = pool.Models.Count == 1 ? pool.Models[0] : null;
                    if (publicId.Length == 0
                        || member is null
                        || !string.Equals(member.ModelId?.Trim(), publicId, StringComparison.Ordinal)
                        || !string.Equals(member.PlatformId, "logical-model", StringComparison.Ordinal))
                    {
                        failures.Add($"{target.Label}:IDENTIFIER_DRIFT");
                        continue;
                    }

                    if (!runtimeByPublicId.ContainsKey(publicId))
                    {
                        failures.Add($"{target.Label}:SELECTED_MODEL_UNRESOLVED");
                    }
                    else if (!string.Equals(member.HealthStatus, "Healthy", StringComparison.OrdinalIgnoreCase)
                        && !string.Equals(member.HealthStatus, "Degraded", StringComparison.OrdinalIgnoreCase))
                    {
                        failures.Add($"{target.Label}:MODEL_UNAVAILABLE");
                    }
                }

                var runtimeDefaults = runtimePools.Where(pool => pool.IsDefault).ToArray();
                if (runtimeDefaults.Length != 1)
                {
                    failures.Add($"{target.Label}:RUNTIME_DEFAULT_COUNT_{runtimeDefaults.Length}");
                }
                else if (defaults.Length == 1
                    && !string.Equals(
                        defaults[0].Code?.Trim(),
                        runtimeDefaults[0].Code?.Trim(),
                        StringComparison.Ordinal))
                {
                    failures.Add($"{target.Label}:DEFAULT_RUNTIME_MISMATCH");
                }
            }
            catch (Exception ex)
            {
                failures.Add($"{target.Label}:PROBE_{ex.GetType().Name.ToUpperInvariant()}");
            }
        }

        var distinctFailures = failures.Distinct(StringComparer.Ordinal).ToArray();
        var output = distinctFailures.Length == 0
            ? $"{Targets.Length} 个业务选择器、{catalogEntries} 个对外模型均与运行时目录一致且当前可用"
            : $"业务模型目录有 {distinctFailures.Length} 处契约失配：{string.Join("、", distinctFailures.Take(5))}";
        return new ModelCatalogContractProbeResult(
            distinctFailures.Length,
            Targets.Length,
            catalogEntries,
            output,
            distinctFailures);
    }
}

internal sealed record ModelCatalogContractTarget(string Label, string AppCallerCode, string ModelType);

public sealed record ModelCatalogContractProbeResult(
    int FailureCount,
    int TargetCount,
    int CatalogEntryCount,
    string Output,
    IReadOnlyList<string> Failures);
