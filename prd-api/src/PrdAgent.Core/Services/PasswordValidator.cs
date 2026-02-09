using System.Text.RegularExpressions;

namespace PrdAgent.Core.Services;

/// <summary>
/// 密码验证器
/// </summary>
public static class PasswordValidator
{
    /// <summary>
    /// 验证密码强度
    /// </summary>
    /// <returns>验证结果，null 表示通过</returns>
    public static string? Validate(string password)
    {
        if (string.IsNullOrWhiteSpace(password))
            return "密码不能为空";

        if (password.Length < 8)
            return "密码长度至少8位";

        if (password.Length > 128)
            return "密码长度不能超过128位";

        if (!Regex.IsMatch(password, @"[a-zA-Z]"))
            return "密码必须包含字母";

        if (!Regex.IsMatch(password, @"\d"))
            return "密码必须包含数字";

        return null; // 验证通过
    }

    /// <summary>
    /// 获取密码强度评分 (0-100)
    /// </summary>
    public static int GetStrengthScore(string password)
    {
        if (string.IsNullOrEmpty(password))
            return 0;

        int score = 0;

        // 长度评分
        score += Math.Min(password.Length * 4, 40);

        // 字母
        if (Regex.IsMatch(password, @"[a-zA-Z]"))
            score += 20;

        // 数字
        if (Regex.IsMatch(password, @"\d"))
            score += 20;

        // 大小写混合（加分项）
        if (Regex.IsMatch(password, @"[a-z]") && Regex.IsMatch(password, @"[A-Z]"))
            score += 10;

        // 特殊字符（加分项）
        if (Regex.IsMatch(password, @"[!@#$%^&*(),.?""':{}|<>]"))
            score += 10;

        return Math.Min(score, 100);
    }
}
