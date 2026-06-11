using System.Text.RegularExpressions;

namespace PrdAgent.Infrastructure.Services.Changelog;

/// <summary>
/// GitHub 提交作者名与系统用户名的「彩蛋」匹配器。
/// 匹配规则（用户 2026-06-10 提出）：
///  1. 忽略大小写，去掉数字与一切分隔符（空格 / - / _ / . 等），只保留字母（含中文）后完全相等；
///  2. 容忍姓名前后颠倒（如 zhangsan ↔ sanzhang），用「环状旋转」判定：
///     A 与 B 互为某个切分点的前后交换 ⟺ 长度相等且 B 出现在 A+A 中；
///  3. 容忍团队通用组织后缀（如 yurenping-miduo → yurenping），剥掉后缀再试一轮。
/// 另提供 Co-authored-by 联合作者解析。纯函数、无状态，便于单元测试。
/// </summary>
public static class GitHubAuthorMatcher
{
    /// <summary>团队 GitHub 账号常见组织后缀（归一化后的形态），匹配前剥掉再试一轮</summary>
    private static readonly string[] CommonOrgSuffixes = { "miduo" };

    // Co-authored-by: Name <email>（email 可省略），逐行匹配
    private static readonly Regex CoAuthorTrailerRegex = new(
        @"^\s*co-authored-by:\s*(?<name>[^<\r\n]+?)\s*(?:<[^>]*>)?\s*$",
        RegexOptions.IgnoreCase | RegexOptions.Multiline | RegexOptions.Compiled);

    /// <summary>归一化：小写 + 仅保留字母（含 CJK），剔除数字与分隔符</summary>
    public static string Normalize(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return string.Empty;
        var lowered = raw.ToLowerInvariant();
        var buffer = new char[lowered.Length];
        var n = 0;
        foreach (var ch in lowered)
        {
            if (char.IsLetter(ch)) buffer[n++] = ch;
        }
        return new string(buffer, 0, n);
    }

    /// <summary>
    /// 归一化变体：原始归一化 + 剥掉通用组织后缀的版本（剥后剩余不足 2 字符则不产出）。
    /// 例：yurenping-miduo → [yurenpingmiduo, yurenping]
    /// </summary>
    public static List<string> NormalizedVariants(string? raw)
    {
        var variants = new List<string>();
        var norm = Normalize(raw);
        if (norm.Length < 2) return variants;
        variants.Add(norm);
        foreach (var suffix in CommonOrgSuffixes)
        {
            if (norm.Length >= suffix.Length + 2 &&
                norm.EndsWith(suffix, StringComparison.Ordinal))
            {
                variants.Add(norm[..^suffix.Length]);
            }
        }
        return variants;
    }

    /// <summary>
    /// 两个「已归一化」的名字是否匹配：相等，或互为环状旋转（姓名颠倒）。
    /// 长度小于 2 的名字一律不匹配，避免单字母误伤。
    /// </summary>
    public static bool IsMatch(string normA, string normB)
    {
        if (normA.Length < 2 || normB.Length < 2) return false;
        if (string.Equals(normA, normB, StringComparison.Ordinal)) return true;
        return normA.Length == normB.Length &&
               (normA + normA).Contains(normB, StringComparison.Ordinal);
    }

    /// <summary>原始字符串直接匹配（双方各自展开归一化变体，任一组合命中即匹配）</summary>
    public static bool IsRawMatch(string? rawA, string? rawB)
    {
        var variantsA = NormalizedVariants(rawA);
        if (variantsA.Count == 0) return false;
        var variantsB = NormalizedVariants(rawB);
        foreach (var a in variantsA)
        foreach (var b in variantsB)
        {
            if (IsMatch(a, b)) return true;
        }
        return false;
    }

    /// <summary>从完整 commit message 解析 Co-authored-by 联合作者名（去邮箱、按名去重，保持出现顺序）</summary>
    public static List<string> ParseCoAuthorNames(string? fullMessage)
    {
        var result = new List<string>();
        if (string.IsNullOrWhiteSpace(fullMessage)) return result;
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (Match m in CoAuthorTrailerRegex.Matches(fullMessage))
        {
            var name = m.Groups["name"].Value.Trim();
            if (name.Length == 0) continue;
            if (seen.Add(name)) result.Add(name);
        }
        return result;
    }

    /// <summary>从 git trailer value（"Name &lt;email&gt;" 或纯 "Name"）提取作者名</summary>
    public static string? ExtractNameFromTrailerValue(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        var idx = value.IndexOf('<');
        var name = (idx >= 0 ? value[..idx] : value).Trim();
        return name.Length == 0 ? null : name;
    }
}
