namespace PrdAgent.GatewayTransport;

public sealed record ModelRetirementNotice(
    string ProviderId, string ModelId, DateTimeOffset RetirementAt, string Source);

public sealed record ModelAdvisoryRecommendation(string PublicId, string? ActualModel);

public sealed record ModelLifecycleAdvisory(
    string Status,
    DateTimeOffset CheckedAt,
    string? CurrentPublicId,
    string? ActualModel,
    string? DefaultPublicId,
    bool DefaultAvailable,
    ModelRetirementNotice? Notice,
    IReadOnlyList<ModelAdvisoryRecommendation> Recommendations)
{
    public const string Path = "/gw/v1/model-advisory";

    public static ModelRetirementNotice? MatchNotice(
        IEnumerable<ModelRetirementNotice> notices, string providerId, string modelId)
    {
        if (string.IsNullOrWhiteSpace(providerId) || string.IsNullOrWhiteSpace(modelId)) return null;
        var matches = notices.Where(notice =>
                string.Equals(notice.ProviderId, providerId, StringComparison.Ordinal)
                && string.Equals(notice.ModelId, modelId, StringComparison.Ordinal)
                && notice.RetirementAt != default
                && Uri.TryCreate(notice.Source, UriKind.Absolute, out var source)
                && source.Scheme == Uri.UriSchemeHttps && source.IsDefaultPort
                && string.IsNullOrEmpty(source.UserInfo) && string.IsNullOrEmpty(source.Query))
            .Distinct().Take(2).ToArray();
        return matches.Length == 1 ? matches[0] : null;
    }

    public static string GetSuffix(string? id)
    {
        if (string.IsNullOrWhiteSpace(id)) return string.Empty;
        var parts = id.Split(new[] { '-', '_', '.' }, StringSplitOptions.RemoveEmptyEntries);
        var index = parts.Length - 1;
        while (index > 0 && (parts[index].All(char.IsAsciiDigit)
            || string.Equals(parts[index], "latest", StringComparison.OrdinalIgnoreCase))) index--;
        return index >= 0 && parts[index].Any(char.IsAsciiLetter) ? parts[index].ToLowerInvariant() : string.Empty;
    }
}
