namespace PrdAgent.LlmGw.Costs;

public sealed record CostReconciliationDecision(
    string Status,
    decimal? Delta,
    decimal? ProviderCostInEstimatedCurrency,
    string? DeltaCurrency);

public static class CostReconciliationPolicy
{
    public static CostReconciliationDecision Evaluate(
        decimal? estimatedCost,
        string? estimatedCurrency,
        decimal providerCost,
        string providerCurrency,
        string? fxSnapshotId,
        decimal? providerToEstimatedFxRate)
    {
        var estimateCurrency = NormalizeCurrency(estimatedCurrency);
        var actualCurrency = NormalizeCurrency(providerCurrency);
        if (estimatedCost is null || estimateCurrency is null)
            return new("estimated-unavailable", null, null, null);
        if (actualCurrency is null)
            return new("actual-invalid", null, null, null);
        if (string.Equals(estimateCurrency, actualCurrency, StringComparison.Ordinal))
            return new("reconciled", providerCost - estimatedCost.Value, providerCost, estimateCurrency);
        if (string.IsNullOrWhiteSpace(fxSnapshotId) || providerToEstimatedFxRate is null or <= 0)
            return new("fx-unavailable", null, null, null);

        var converted = decimal.Round(providerCost * providerToEstimatedFxRate.Value, 12, MidpointRounding.AwayFromZero);
        return new("reconciled", converted - estimatedCost.Value, converted, estimateCurrency);
    }

    public static string? NormalizeCurrency(string? value)
    {
        var normalized = value?.Trim().ToUpperInvariant();
        return normalized is { Length: 3 } && normalized.All(char.IsLetter) ? normalized : null;
    }
}
