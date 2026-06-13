namespace PrdAgent.Core.Models;

/// <summary>
/// 缺陷处理优先级（P0–P3）。TAPD 导出列「优先级」五档（紧急/高/中/低/无关紧要）映射到 DefectReport.Grade。
/// 与 V2.6「严重程度」独立；无值时不写入。
/// </summary>
public static class DefectPriorityCatalog
{
    /// <summary>TAPD「优先级」→ p0–p3；无法识别或为空时返回 null。</summary>
    public static string? TryNormalizeTapdToGrade(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;
        var text = raw.Trim();
        var lower = text.ToLowerInvariant();
        if (ProductItemGrade.All.Contains(lower)) return lower;

        var compact = lower.Replace(" ", string.Empty);
        if (compact is "p0" or "p1" or "p2" or "p3") return compact;

        if (text.StartsWith('P', StringComparison.OrdinalIgnoreCase))
        {
            var digits = text[1..].Replace(" ", string.Empty);
            if (digits.Length == 0 || int.TryParse(digits, out var level))
            {
                level = digits.Length == 0 ? 0 : level;
                return level switch
                {
                    <= 0 => ProductItemGrade.P0,
                    1 => ProductItemGrade.P1,
                    2 => ProductItemGrade.P2,
                    _ => ProductItemGrade.P3,
                };
            }
        }

        return text switch
        {
            "紧急" => ProductItemGrade.P0,
            "高" => ProductItemGrade.P1,
            "中" => ProductItemGrade.P2,
            "低" or "无关紧要" => ProductItemGrade.P3,
            _ => null,
        };
    }
}
