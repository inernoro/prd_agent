namespace PrdAgent.Core.Helpers;

/// <summary>
/// 产品域实体编号规则 SSOT。
/// <list type="bullet">
/// <item>需求 / 缺陷：全库单表 TAPD 纯数字全局递增（与产品无关）</item>
/// <item>版本 T/V 编码：全库全局递增（T{a}.{b}.{c} / V{a}.{b}.{c}）</item>
/// <item>功能：单张 Features 表；每个正式版本（OfficialReleaseId）一份功能清单，FeatureNo 在清单内递增；未绑定正式版本时按产品草稿清单递增</item>
/// </list>
/// </summary>
public static class ProductEntityNumbering
{
    /// <summary>解析 TAPD 风格纯数字 ID（如 1007157）。</summary>
    public static bool TryParseTapdNumericId(string? value, out long id)
    {
        id = 0;
        if (string.IsNullOrWhiteSpace(value)) return false;
        return long.TryParse(value.Trim(), out id) && id > 0;
    }

    /// <summary>在候选编号中取最大纯数字 + 1。</summary>
    public static string NextTapdNumericId(IEnumerable<string?> candidates)
    {
        long max = 0;
        foreach (var value in candidates)
        {
            if (TryParseTapdNumericId(value, out var parsed) && parsed > max)
                max = parsed;
        }
        return (max + 1).ToString();
    }

    /// <summary>下一工作流版本编码（T/V 前缀，全库全局递增）。</summary>
    public static string NextWorkflowCode(string prefix, string versionType, IEnumerable<string> existingCodes)
    {
        var max = new[] { 0, 0, 0 };
        foreach (var code in existingCodes)
        {
            if (string.IsNullOrWhiteSpace(code)) continue;
            var parts = code.TrimStart('T', 't', 'V', 'v').Split('.');
            if (parts.Length != 3
                || !int.TryParse(parts[0], out var a)
                || !int.TryParse(parts[1], out var b)
                || !int.TryParse(parts[2], out var c))
                continue;
            if (a > max[0] || a == max[0] && b > max[1] || a == max[0] && b == max[1] && c > max[2])
                max = new[] { a, b, c };
        }

        switch (NormalizeVersionType(versionType))
        {
            case "major":
                max = new[] { max[0] + 1, 0, 0 };
                break;
            case "medium":
                max = new[] { max[0], max[1] + 1, 0 };
                break;
            default:
                max[2]++;
                break;
        }

        return $"{prefix}{max[0]}.{max[1]}.{max[2]}";
    }

    public static string NormalizeVersionType(string? value) =>
        value?.Trim().ToLowerInvariant() switch
        {
            "major" or "大版本" => "major",
            "medium" or "中版本" => "medium",
            _ => "minor",
        };
}
