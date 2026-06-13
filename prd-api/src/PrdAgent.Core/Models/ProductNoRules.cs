namespace PrdAgent.Core.Models;

/// <summary>
/// 产品编号规则：前缀表示层级类型，连字符后为全局递增序号（层级调整只改前缀，序号不变）。
/// </summary>
public static class ProductNoRules
{
    /// <summary>格式化完整产品编号，如 SYS-1007157。</summary>
    public static string Format(string prefix, long sequence)
    {
        var p = (prefix ?? string.Empty).Trim().ToUpperInvariant();
        if (p.Length == 0) p = "GEN";
        if (sequence <= 0) throw new ArgumentOutOfRangeException(nameof(sequence));
        return $"{p}-{sequence}";
    }

    /// <summary>从 ProductNo 解析稳定序号（支持 SYS-1007157、纯数字、PRD-2026-0001 等历史格式）。</summary>
    public static bool TryParseSequence(string? productNo, out long sequence)
    {
        sequence = 0;
        if (string.IsNullOrWhiteSpace(productNo)) return false;
        var s = productNo.Trim();

        var dash = s.LastIndexOf('-');
        if (dash >= 0 && dash < s.Length - 1)
        {
            var tail = s[(dash + 1)..].Trim();
            if (long.TryParse(tail, out sequence) && sequence > 0) return true;
        }

        return long.TryParse(s, out sequence) && sequence > 0;
    }

    /// <summary>按产品类型名称推断编号前缀（类型可在设置中自定义，未知名称用 GEN）。</summary>
    public static string PrefixForCategoryName(string? name) =>
        name?.Trim() switch
        {
            "系统" => "SYS",
            "子系统" => "SUB",
            "应用" => "APP",
            "组件" => "CMP",
            _ => "GEN",
        };

    /// <summary>替换前缀并保留原序号；无法解析序号时返回 null。</summary>
    public static string? ReapplyPrefix(string? productNo, string newPrefix)
    {
        if (!TryParseSequence(productNo, out var seq)) return null;
        return Format(newPrefix, seq);
    }
}
