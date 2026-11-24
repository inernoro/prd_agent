using System.Text.RegularExpressions;
using MongoDB.Bson;

namespace PrdAgent.LlmGw.LogicalModels;

public static class LogicalModelAliasPolicy
{
    public static string? Validate(string identityKind, string publicId, IReadOnlyCollection<string> aliases)
    {
        if (identityKind is not ("fixed" or "stable")) return "请选择固定版本或跟随升级。";
        if (aliases.Count > 0 && identityKind != "stable") return "只有稳定模型可以登记兼容标识，固定版本保持精确语义。";
        if (aliases.Count > 32) return "兼容标识最多 32 个。";
        if (aliases.Any(x => x.Length is < 2 or > 160 || !Regex.IsMatch(x, "^[a-z0-9][a-z0-9._:/-]*$")))
            return "兼容标识格式不正确，请使用字母、数字及模型标识允许的分隔符。";
        if (aliases.Contains(publicId, StringComparer.OrdinalIgnoreCase)) return "公开标识不需要重复登记为兼容标识。";
        return null;
    }

    public static List<string> Normalize(IEnumerable<string>? aliases)
        => (aliases ?? []).Select(x => (x ?? "").Trim().ToLowerInvariant())
            .Distinct(StringComparer.Ordinal).ToList();

    public static bool Conflicts(BsonDocument other, IEnumerable<string> names)
    {
        var occupied = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            other.GetValue("PublicId", "").AsString,
        };
        foreach (var field in new[] { "Aliases", "MigratedFromPoolIds" })
            if (other.TryGetValue(field, out var raw) && raw.IsBsonArray)
                foreach (var value in raw.AsBsonArray.Where(x => x.IsString)) occupied.Add(value.AsString);
        return names.Any(occupied.Contains);
    }
}
