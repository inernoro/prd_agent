namespace PrdAgent.Infrastructure.Services.Changelog;

/// <summary>
/// GitHub 提交作者名与系统用户名的「彩蛋」匹配器。
/// 匹配规则（用户 2026-06-10 提出）：
///  1. 忽略大小写，去掉数字与一切分隔符（空格 / - / _ / . 等），只保留字母（含中文）后完全相等；
///  2. 容忍姓名前后颠倒（如 zhangsan ↔ sanzhang），用「环状旋转」判定：
///     A 与 B 互为某个切分点的前后交换 ⟺ 长度相等且 B 出现在 A+A 中。
/// 纯函数、无状态，便于单元测试。
/// </summary>
public static class GitHubAuthorMatcher
{
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

    /// <summary>原始字符串直接匹配（内部各自归一化）</summary>
    public static bool IsRawMatch(string? rawA, string? rawB) =>
        IsMatch(Normalize(rawA), Normalize(rawB));
}
