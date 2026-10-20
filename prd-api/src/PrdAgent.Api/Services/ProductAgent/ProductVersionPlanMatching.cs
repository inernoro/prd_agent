using System.Text.RegularExpressions;

namespace PrdAgent.Api.Services.ProductAgent;

public sealed record VersionPlanApplication(string Id, string Name);
public sealed record VersionPlanCandidate(string Id, string ProductId, string PlanName, string? TCode, string? LinkedProductId = null);

/// <summary>只在调用方已授权的应用/立项范围内做标题清洗和候选匹配，不发号、不改历史数据。</summary>
public static class ProductVersionPlanMatching
{
    public static bool HistoricalTitlesEqual(string? left, string? right) =>
        HistoryTopic(left).Length > 0 && HistoryTopic(left) == HistoryTopic(right);

    public static bool HistoricalTitlesSimilar(string? left, string? right) => IsSimilarTopic(HistoryTopic(left), HistoryTopic(right));

    private static string HistoryTopic(string? title) => Topic(Regex.Replace(title ?? "", @"[TV]\d+\.\d+\.\d+", "", RegexOptions.IgnoreCase));

    public static IReadOnlyList<VersionPlanApplication> MatchApplications(string? title, IReadOnlyList<VersionPlanApplication> applications)
    {
        var prefix = Prefix(title ?? string.Empty);
        var matches = applications.Where(app => !string.IsNullOrWhiteSpace(app.Name)
            && Compact(prefix).StartsWith(Compact(app.Name), StringComparison.OrdinalIgnoreCase)).ToList();
        if (matches.Count == 0) return matches;
        var longest = matches.Max(app => Compact(app.Name).Length);
        return matches.Where(app => Compact(app.Name).Length == longest).ToList();
    }

    public static string CleanTitle(string? title, string applicationName)
    {
        var raw = title?.Trim() ?? string.Empty;
        var opening = Opening(raw);
        if (opening < 0 || string.IsNullOrWhiteSpace(applicationName)
            || !Compact(raw[..opening]).StartsWith(Compact(applicationName), StringComparison.OrdinalIgnoreCase)) return raw;
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
            result.PlanName = CleanTitle(raw, apps[0].Name);
        }
        if (!formal) return;
        var appIds = apps.Select(app => app.Id).ToHashSet();
        var available = plans.Where(plan => appIds.Count == 0 || appIds.Contains(plan.LinkedProductId ?? plan.ProductId)).ToList();
        var input = Topic(raw);
        var named = available.Where(plan => IsSimilarTopic(input, Topic(plan.PlanName))).ToList();
        var coded = available.Where(plan => !string.IsNullOrWhiteSpace(result.TCode)
            && string.Equals(plan.TCode, result.TCode, StringComparison.OrdinalIgnoreCase)
            // R=T... 等占位可能碰巧是有效号，有方案主题时必须与主题相符。
            && (input.Length == 0 || IsSimilarTopic(input, Topic(plan.PlanName)))).ToList();
        var exact = named.Where(plan => Topic(plan.PlanName) == input).ToList();
        var matches = (coded.Count > 0 ? coded : exact.Count > 0 ? exact : named).DistinctBy(plan => plan.Id).ToList();
        result.CandidateInitiationIds = matches.Select(plan => plan.Id).ToList();
        // 存在明确应用前缀却不在可识别目录中时，即使主题唯一也只提示候选，不猜归属。
        if (matches.Count != 1 || (apps.Count == 0 && Opening(raw ?? string.Empty) >= 0 && !string.IsNullOrWhiteSpace(Prefix(raw ?? string.Empty)))) return;
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
