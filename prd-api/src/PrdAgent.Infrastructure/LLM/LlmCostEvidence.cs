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

    /// <summary>
    /// 价格快照指纹。缓存两档价必须参与计算——它们直接决定这笔账算出多少，
    /// 漏掉的话两次口径不同的计价会得到同一个指纹，快照就证明不了复算口径了。
    /// </summary>
    public static string? BuildPriceSnapshotHash(
        decimal? inputPricePerMillion,
        decimal? outputPricePerMillion,
        decimal? cachedInputPricePerMillion,
        decimal? cacheWritePricePerMillion,
        decimal? pricePerCall,
        string? currency)
    {
        var normalizedCurrency = string.IsNullOrWhiteSpace(currency)
            ? null
            : currency.Trim().ToUpperInvariant();
        if (inputPricePerMillion is null
            && outputPricePerMillion is null
            && cachedInputPricePerMillion is null
            && cacheWritePricePerMillion is null
            && pricePerCall is null
            && normalizedCurrency is null)
        {
            return null;
        }

        var canonical = string.Join('|',
            Format(inputPricePerMillion),
            Format(outputPricePerMillion),
            Format(cachedInputPricePerMillion),
            Format(cacheWritePricePerMillion),
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

    public static Dictionary<string, string> BuildSafeResponseHeaders(
        HttpResponseMessage? response,
        string fallbackContentType)
    {
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["content-type"] = response?.Content?.Headers.ContentType?.ToString() ?? fallbackContentType,
        };
        if (response is null) return result;

        foreach (var candidate in ProviderRequestIdHeaders)
        {
            IEnumerable<string>? values = null;
            if (!response.Headers.TryGetValues(candidate, out values)
                && (response.Content is null || !response.Content.Headers.TryGetValues(candidate, out values)))
            {
                continue;
            }

            var value = string.Join(", ", values).Trim();
            if (!string.IsNullOrWhiteSpace(value))
                result[candidate] = value.Length <= 200 ? value : value[..200];
        }

        return result;
    }

    private static string Format(decimal? value)
        => value?.ToString("G29", CultureInfo.InvariantCulture) ?? "unknown";
}
