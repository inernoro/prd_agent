using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace PrdAgent.Infrastructure.LLM;

public static class LlmCostEvidence
{
    private static readonly string[] ProviderRequestIdHeaders =
    [
        "x-request-id",
        "request-id",
        "x-api-request-id",
        "openai-request-id",
        "anthropic-request-id",
        "x-goog-request-id",
        "x-amzn-requestid",
        "x-tt-logid",
        "x-bce-request-id",
    ];

    public static string? BuildPriceSnapshotHash(
        decimal? inputPricePerMillion,
        decimal? outputPricePerMillion,
        decimal? pricePerCall,
        string? currency)
    {
        var normalizedCurrency = string.IsNullOrWhiteSpace(currency)
            ? null
            : currency.Trim().ToUpperInvariant();
        if (inputPricePerMillion is null
            && outputPricePerMillion is null
            && pricePerCall is null
            && normalizedCurrency is null)
        {
            return null;
        }

        var canonical = string.Join('|',
            Format(inputPricePerMillion),
            Format(outputPricePerMillion),
            Format(pricePerCall),
            normalizedCurrency ?? "unknown");
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(canonical))).ToLowerInvariant();
    }

    public static string? ResolveProviderRequestId(IReadOnlyDictionary<string, string>? headers)
    {
        if (headers is null || headers.Count == 0) return null;
        foreach (var candidate in ProviderRequestIdHeaders)
        {
            var match = headers.FirstOrDefault(x => string.Equals(x.Key, candidate, StringComparison.OrdinalIgnoreCase));
            var value = match.Value?.Trim();
            if (!string.IsNullOrWhiteSpace(value)) return value.Length <= 200 ? value : value[..200];
        }
        return null;
    }

    private static string Format(decimal? value)
        => value?.ToString("G29", CultureInfo.InvariantCulture) ?? "unknown";
}
