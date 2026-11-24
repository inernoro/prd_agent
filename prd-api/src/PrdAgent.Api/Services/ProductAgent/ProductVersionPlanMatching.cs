using System.Text.RegularExpressions;

namespace PrdAgent.Api.Services.ProductAgent;

public sealed record VersionPlanApplication(string Id, string Name);
public sealed record VersionPlanCandidate(string Id, string ProductId, string PlanName, string? TCode, string? LinkedProductId = null, string? ApplicationName = null);

/// <summary>只在调用方已授权的应用/立项范围内做标题清洗和候选匹配，不发号、不改历史数据。</summary>
public static class ProductVersionPlanMatching
{
    private static readonly IReadOnlyDictionary<string, string> ApplicationAliases = new Dictionary<string, string>
    {
        ["米多星球"] = "米多总平台",
    };
    public static IReadOnlyDictionary<string, string> Aliases => ApplicationAliases;

    public static string CanonicalApplicationName(string? name)
    {
        var key = PrdAgent.Core.Models.VersionRegistryCatalog.NormalizeName(name);
        var alias = ApplicationAliases.FirstOrDefault(pair => PrdAgent.Core.Models.VersionRegistryCatalog.NormalizeName(pair.Key) == key);
        return PrdAgent.Core.Models.VersionRegistryCatalog.NormalizeName(alias.Value ?? name);
    }

    private static string ApplicationPrefix(string value)
    {
        var prefix = Compact(Prefix(value));
        foreach (var (alias, application) in ApplicationAliases)
        {
            var key = Compact(alias);
            if (prefix.StartsWith(key, StringComparison.OrdinalIgnoreCase))
                return Compact(application) + prefix[key.Length..];
        }
        return prefix;
    }

    public static bool HistoricalTitlesEqual(string? left, string? right) =>
        HistoryTopic(left).Length > 0 && HistoryTopic(left) == HistoryTopic(right);

    public static bool HistoricalTitlesSimilar(string? left, string? right) => IsSimilarTopic(HistoryTopic(left), HistoryTopic(right));

    private static string HistoryTopic(string? title) => Topic(Regex.Replace(title ?? "", @"[TV]\d+\.\d+\.\d+", "", RegexOptions.IgnoreCase));

    public static IReadOnlyList<VersionPlanApplication> MatchApplications(string? title, IReadOnlyList<VersionPlanApplication> applications)
    {
        var prefix = ApplicationPrefix(title ?? string.Empty);
        var matches = applications.Where(app => !string.IsNullOrWhiteSpace(app.Name)
            && prefix.StartsWith(Compact(app.Name), StringComparison.OrdinalIgnoreCase)).ToList();
        if (matches.Count == 0) return matches;
        var longest = matches.Max(app => Compact(app.Name).Length);
        return matches.Where(app => Compact(app.Name).Length == longest).ToList();
    }

    public static string CleanTitle(string? title, string applicationName)
    {
        var raw = title?.Trim() ?? string.Empty;
        var opening = Opening(raw);
        if (opening < 0 || string.IsNullOrWhiteSpace(applicationName)
            || !ApplicationPrefix(raw).StartsWith(Compact(applicationName), StringComparison.OrdinalIgnoreCase)) return raw;
        return applicationName.Trim() + raw[opening..];
    }

    public static void Match(VersionRegistrationMessageParseResult result, IReadOnlyList<VersionPlanApplication> applications,
        IReadOnlyList<VersionPlanCandidate> plans, bool formal)
    {
        var raw = result.PlanName;
        var apps = MatchApplications(raw, applications);
        if (apps.Count == 1)
        {
            result.MatchedApplicationId = apps[0].Id;
            if (!formal) result.PlanName = PrdAgent.Core.Helpers.ProductVersionPlanName.Format(apps[0].Name,
                result.TCode ?? VersionRegistrationMessageParser.Parse(raw, "formal").TCode, raw ?? string.Empty);
        }
        if (!formal) return;
        var appIds = apps.Select(app => app.Id).ToHashSet();
        var available = plans.Where(plan => appIds.Count == 0 || appIds.Contains(plan.LinkedProductId ?? plan.ProductId)).ToList();
        var prefix = ApplicationPrefix(raw ?? string.Empty);
        var alias = ApplicationAliases.Values.FirstOrDefault(name => prefix == Compact(name)
            || (!string.IsNullOrWhiteSpace(result.TCode) && prefix == Compact(name + result.TCode)));
        if (apps.Count == 0 && alias != null)
            available = available.Where(plan => !string.IsNullOrWhiteSpace(plan.ApplicationName)
                ? CanonicalApplicationName(plan.ApplicationName) == CanonicalApplicationName(alias)
                : ApplicationPrefix(plan.PlanName) == Compact(alias) || ApplicationPrefix(plan.PlanName) == Compact(alias + plan.TCode)).ToList();
        var input = Topic(raw);
        var named = available.Where(plan => IsSimilarTopic(input, Topic(plan.PlanName))).ToList();
        var coded = available.Where(plan => !string.IsNullOrWhiteSpace(result.TCode)
            && string.Equals(plan.TCode, result.TCode, StringComparison.OrdinalIgnoreCase)).ToList();
        var exact = named.Where(plan => Topic(plan.PlanName) == input).ToList();
        // 明确T号按应用+T号定位；无号或占位沿用原主题候选与歧义保护。
        var hasExplicitCode = !string.IsNullOrWhiteSpace(result.TCode)
            && !(raw ?? string.Empty).Contains("R=", StringComparison.OrdinalIgnoreCase);
        var matches = (hasExplicitCode ? coded : exact.Count > 0 ? exact : named).DistinctBy(plan => plan.Id).ToList();
        result.CandidateInitiationIds = matches.Select(plan => plan.Id).ToList();
        if (matches.Count != 1 || (apps.Count != 1 && (alias == null || !hasExplicitCode))) return;
        if (hasExplicitCode && apps.Count == 1 && prefix != Compact(apps[0].Name)
            && prefix != Compact(apps[0].Name + result.TCode)) return;
        result.MatchedInitiationId = matches[0].Id;
        result.MatchedApplicationId = matches[0].ProductId;
        result.PlanName = matches[0].PlanName;
    }

    private static int Opening(string value)
    {
        var chinese = value.IndexOf('（');
        var english = value.IndexOf('(');
        return chinese < 0 ? english : english < 0 ? chinese : Math.Min(chinese, english);
    }

    private static string Prefix(string value)
    {
        var opening = Opening(value);
        return opening < 0 ? value : value[..opening];
    }

    private static string Topic(string? title)
    {
        var raw = title?.Trim() ?? string.Empty;
        var opening = Opening(raw);
        var closing = Math.Max(raw.LastIndexOf('）'), raw.LastIndexOf(')'));
        if (opening >= 0 && closing > opening) raw = raw[(opening + 1)..closing];
        else raw = Regex.Replace(raw, @"[-—_\s]*AI文档$", string.Empty, RegexOptions.IgnoreCase);
        return Compact(raw);
    }

    private static string Compact(string value) => Regex.Replace(value, @"[\s\p{P}\p{S}]", string.Empty).ToLowerInvariant();

    private static bool IsSimilarTopic(string left, string right)
    {
        if (left.Length == 0 || right.Length == 0) return false;
        if (left == right) return true;
        if (Math.Min(left.Length, right.Length) < 8) return false;
        var ratio = (double)Math.Min(left.Length, right.Length) / Math.Max(left.Length, right.Length);
        if (ratio >= 0.85 && (left.Contains(right, StringComparison.Ordinal) || right.Contains(left, StringComparison.Ordinal))) return true;
        var leftPairs = Enumerable.Range(0, left.Length - 1).Select(index => left.Substring(index, 2)).ToHashSet();
        var rightPairs = Enumerable.Range(0, right.Length - 1).Select(index => right.Substring(index, 2)).ToHashSet();
        return 2d * leftPairs.Intersect(rightPairs).Count() / (leftPairs.Count + rightPairs.Count) >= 0.9;
    }
}
