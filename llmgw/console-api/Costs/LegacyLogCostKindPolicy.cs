using MongoDB.Bson;
using PrdAgent.LlmGw.Mongo;

namespace PrdAgent.LlmGw.Costs;

/// <summary>读取历史费用证据，不修改金额、价格快照或账目。</summary>
public static class LegacyLogCostKindPolicy
{
    public static string Resolve(BsonDocument document, string costStatus)
    {
        if (document.AsNullableDecimal("ProviderReportedCost") is not null)
            return GatewayCostKindNames.ProviderActual;

        var stored = document.AsNullableString("CostKind")?.Trim().ToLowerInvariant();
        if (GatewayCostKindNames.All.Contains(stored, StringComparer.Ordinal))
            return stored!;

        if (costStatus == GatewayCostStatusNames.NoUsage) return GatewayCostKindNames.NoUsage;
        if (costStatus != GatewayCostStatusNames.Priced) return GatewayCostKindNames.Unpriced;

        // 实际平台名称优先；旧记录缺字段时才采用 Provider / 平台编号。
        // 协议与 PlatformType 可被第三方兼容实现复用，不能证明官方来源。
        var provider = new[]
        {
            document.AsNullableString("PlatformName"),
            document.AsNullableString("Provider"),
            document.AsNullableString("PlatformId"),
        }.FirstOrDefault(value => !string.IsNullOrWhiteSpace(value))?.Trim() ?? string.Empty;
        if (provider.Contains("apiyi", StringComparison.OrdinalIgnoreCase)
            || provider.Equals("openai", StringComparison.OrdinalIgnoreCase))
            return GatewayCostKindNames.OfficialBaselineEstimate;

        return string.Equals(document.AsNullableString("PriceSource")?.Trim(), "upstream", StringComparison.OrdinalIgnoreCase)
            ? GatewayCostKindNames.ProviderPolicyEstimate
            : GatewayCostKindNames.OfficialBaselineEstimate;
    }
}
