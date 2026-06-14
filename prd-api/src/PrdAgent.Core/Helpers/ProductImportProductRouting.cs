using System.Text.RegularExpressions;
using PrdAgent.Core.Models;

namespace PrdAgent.Core.Helpers;

/// <summary>
/// 历史 TAPD / 语雀导入：来源「应用」列或标题【前缀】匹配系统产品 Name/Code。
/// 匹配不到时不写入任何产品（禁止兜底落入）。
/// </summary>
public static class ProductImportProductRouting
{
    private static readonly Regex BracketPrefixRegex = new(@"^【([^】]+)】", RegexOptions.Compiled);

    /// <summary>来源字段 → 系统产品标签（「应用」优先，对应语雀/Excel 导出列）。</summary>
    private static readonly string[] ProductFieldKeys =
    {
        "应用", "产品", "所属产品", "产品名称", "产品线", "product", "productname",
    };

    public static string? ExtractTitleBracketLabel(string? title)
    {
        if (string.IsNullOrWhiteSpace(title)) return null;
        var match = BracketPrefixRegex.Match(title.Trim());
        return match.Success ? match.Groups[1].Value.Trim() : null;
    }

    public static string? ExtractProductLabelFromFields(IReadOnlyDictionary<string, string>? fields)
    {
        if (fields == null || fields.Count == 0) return null;
        foreach (var key in ProductFieldKeys)
        {
            var hit = fields.FirstOrDefault(pair =>
                string.Equals(pair.Key.Trim(), key, StringComparison.OrdinalIgnoreCase));
            if (!string.IsNullOrWhiteSpace(hit.Value))
                return hit.Value.Trim();
        }
        return null;
    }

    /// <summary>版本工作流行：优先「应用」，其次 legacy「产品」，最后「系统」。</summary>
    public static string? ResolveProductLabelFromVersionRow(
        string? appName,
        string? systemName,
        IReadOnlyDictionary<string, string>? legacyData)
    {
        if (!string.IsNullOrWhiteSpace(appName)) return appName.Trim();
        var fromLegacy = ExtractProductLabelFromFields(legacyData);
        if (!string.IsNullOrWhiteSpace(fromLegacy)) return fromLegacy;
        if (!string.IsNullOrWhiteSpace(systemName)) return systemName.Trim();
        return null;
    }

    /// <summary>
    /// 从标题【】或来源字段（含「应用」）解析标签，再匹配产品 Name/Code。
    /// 无匹配时 ProductId 为 null。
    /// </summary>
    public static (string? ProductId, string? Label, bool Matched) ResolveProductId(
        IReadOnlyList<Product> products,
        string? title,
        IReadOnlyDictionary<string, string>? sourceFields)
    {
        var label = ExtractProductLabelFromFields(sourceFields) ?? ExtractTitleBracketLabel(title);
        return ResolveProductIdByLabel(products, label);
    }

    public static (string? ProductId, string? Label, bool Matched) ResolveProductIdByLabel(
        IReadOnlyList<Product> products,
        string? label)
    {
        if (string.IsNullOrWhiteSpace(label))
            return (null, null, false);

        var matchedId = MatchProductByLabel(products, label);
        if (matchedId != null)
            return (matchedId, label.Trim(), true);

        return (null, label.Trim(), false);
    }

    public static string? MatchProductByLabel(IReadOnlyList<Product> products, string label)
    {
        var q = label.Trim();
        if (q.Length == 0) return null;

        var exact = products.FirstOrDefault(p =>
            string.Equals(p.Name.Trim(), q, StringComparison.OrdinalIgnoreCase)
            || (!string.IsNullOrWhiteSpace(p.Code) && string.Equals(p.Code.Trim(), q, StringComparison.OrdinalIgnoreCase)));
        if (exact != null) return exact.Id;

        var contains = products
            .Where(p =>
            {
                var name = p.Name.Trim();
                if (name.Length == 0) return false;
                return name.Contains(q, StringComparison.OrdinalIgnoreCase)
                    || q.Contains(name, StringComparison.OrdinalIgnoreCase);
            })
            .OrderByDescending(p => p.Name.Length)
            .FirstOrDefault();
        return contains?.Id;
    }
}
