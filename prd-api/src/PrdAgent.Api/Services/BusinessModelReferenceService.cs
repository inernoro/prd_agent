using PrdAgent.Core.LlmGateway;

namespace PrdAgent.Api.Services;

/// <summary>业务配置保存逻辑模型身份；读取目录不认领恢复租约，也不发起模型请求。</summary>
public sealed class BusinessModelReferenceService(ILlmGateway gateway)
{
    public async Task<IReadOnlyList<BusinessModelOption>> GetOptionsAsync(
        string appCallerCode, string modelType, CancellationToken ct)
    {
        var catalog = await gateway.GetAvailablePoolsAsync(appCallerCode, modelType, ct);
        return ProjectOptions(catalog);
    }

    public static IReadOnlyList<BusinessModelOption> ProjectOptions(IEnumerable<AvailableModelPool> catalog) =>
        catalog.Where(x => x.ResolutionType == "LogicalModel")
            .Select(x => new BusinessModelOption(x.Id, x.Code, x.Name,
                x.Models.Any(m => m.IsRecoveryProbeAvailable ||
                    string.Equals(m.HealthStatus, "Healthy", StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(m.HealthStatus, "Degraded", StringComparison.OrdinalIgnoreCase)),
                "当前模型没有可用线路，请在模型网关修复线路或选择其他模型。"))
            .Select(x => x.Available ? x with { Reason = null } : x).ToList();

    public static BusinessModelReferenceResult Resolve(IReadOnlyList<BusinessModelOption> options,
        string? logicalModelId, string? platformId, string? modelId)
    {
        var id = logicalModelId?.Trim();
        // 旧物理平台名称不能证明逻辑模型身份；禁止同名、相似型号和默认模型替换。
        var selected = !string.IsNullOrEmpty(id)
            ? options.SingleOrDefault(x => x.LogicalModelId == id)
            : platformId == "logical-model"
                ? options.SingleOrDefault(x => x.PublicId == modelId)
                : null;
        if (selected is null)
            return new(false, id ?? "", modelId ?? "", "", string.IsNullOrEmpty(id) ? "legacy" : "unavailable",
                "原模型引用已失效，请编辑模型配置并明确选择当前模型。原配置和历史记录已保留。");
        return new(selected.Available, selected.LogicalModelId, selected.PublicId, selected.Name,
            selected.Available ? "available" : "unavailable", selected.Reason);
    }
}

public sealed record BusinessModelOption(string LogicalModelId, string PublicId, string Name,
    bool Available, string? Reason);
public sealed record BusinessModelReferenceResult(bool Success, string LogicalModelId, string PublicId,
    string Name, string Status, string? Reason);
