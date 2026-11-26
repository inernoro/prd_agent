using System.Text.Json;
using MongoDB.Bson.Serialization.Attributes;

namespace PrdAgent.Core.Models;

/// <summary>内容组织与分享授权独立；同一文档可属于多个合集。</summary>
[BsonIgnoreExtraElements]
public class HostedCollection
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string OwnerUserId { get; set; } = string.Empty;
    public string Title { get; set; } = string.Empty;
    public List<string> SiteIds { get; set; } = new();
    public string MainSiteId { get; set; } = string.Empty;
    public long Version { get; set; } = 1;
    // 停止全部分享时递增，拦住与撤销并发产生的旧代链接。
    public long ShareGeneration { get; set; } = 1;
    public bool IsDissolved { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

public static class HostedCollectionRules
{
    public static string[] ParseSuggestedNames(string? response)
    {
        if (response is not { Length: > 0 and <= 2048 }) return [];

        var output = response.Trim();
        if (output.StartsWith("```", StringComparison.Ordinal) && output.EndsWith("```", StringComparison.Ordinal))
        {
            var firstLineEnd = output.IndexOf('\n');
            if (firstLineEnd < 3 || firstLineEnd >= output.Length - 3) return [];
            var language = output[3..firstLineEnd].Trim();
            if (language.Length != 0 && !language.Equals("json", StringComparison.OrdinalIgnoreCase)) return [];
            output = output[(firstLineEnd + 1)..^3];
        }

        try
        {
            var names = (JsonSerializer.Deserialize<string?[]>(output) ?? [])
                .Where(name => !string.IsNullOrWhiteSpace(name))
                .Select(name => name!.Trim())
                .Where(name => name.Length is > 2 and <= 32 && !name.Any(char.IsControl))
                .Select(name => name.EndsWith("合集", StringComparison.Ordinal) ? name : name + "合集")
                .Distinct(StringComparer.OrdinalIgnoreCase).Take(3).ToArray();
            return names.Length == 3 ? names : [];
        }
        catch (JsonException) { return []; }
    }

    public static List<string> OrderedIds(IEnumerable<string> ids, string? mainSiteId = null)
    {
        var result = ids.Where(x => !string.IsNullOrWhiteSpace(x)).Distinct(StringComparer.Ordinal).ToList();
        if (mainSiteId != null && result.Remove(mainSiteId)) result.Insert(0, mainSiteId);
        return result;
    }

    public static string? Validate(string? title, IReadOnlyCollection<string> ids, string? mainSiteId)
    {
        if (string.IsNullOrWhiteSpace(title) || title.Trim().Length > 100) return "请输入 1–100 字的合集名称";
        if (ids.Count is < 1 or > 90) return "请选择 1–90 份文档";
        if (string.IsNullOrEmpty(mainSiteId) || !ids.Contains(mainSiteId)) return "请从合集成员中明确选择一份主文档";
        return null;
    }

    public static bool AllowsShare(HostedCollection? collection, WebPageShareLink share) =>
        collection != null && !collection.IsDissolved && collection.Id == share.CollectionId
        && collection.ShareGeneration == share.CollectionShareGeneration;
}
