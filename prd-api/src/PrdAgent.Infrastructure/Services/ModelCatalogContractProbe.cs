using PrdAgent.Core.Interfaces;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// 业务模型选择器与运行时解析器的一致性探针。
///
/// 选择器曾从退场的 MAP 模型池读取成员展示名，而执行链路只接受 LLM Gateway
/// 的稳定 PublicId。两边各自“有数据”却无法串起来，因此这里直接验证完整契约：
/// 目录非空、默认项唯一、下发标识可被运行时按原值解析。
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
    private readonly IModelResolver _resolver;

    public ModelCatalogContractProbe(IModelPoolQueryService catalog, IModelResolver resolver)
    {
        _catalog = catalog;
        _resolver = resolver;
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

                    var selected = await _resolver.ResolveAsync(
                        target.AppCallerCode,
                        target.ModelType,
                        publicId,
                        ct: ct);
                    if (!selected.Success
                        || !string.Equals(selected.LogicalModelPublicId, publicId, StringComparison.Ordinal))
                    {
                        failures.Add($"{target.Label}:SELECTED_MODEL_UNRESOLVED");
                    }
                }

                var automatic = await _resolver.ResolveAsync(
                    target.AppCallerCode,
                    target.ModelType,
                    expectedModel: null,
                    ct: ct);
                if (!automatic.Success || string.IsNullOrWhiteSpace(automatic.LogicalModelPublicId))
                {
                    failures.Add($"{target.Label}:AUTOMATIC_MODEL_UNRESOLVED");
                }
                else if (defaults.Length == 1
                    && !string.Equals(
                        defaults[0].Code?.Trim(),
                        automatic.LogicalModelPublicId,
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
            ? $"{Targets.Length} 个业务选择器、{catalogEntries} 个对外模型均与运行时解析一致"
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
