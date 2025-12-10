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

        if (!Regex.IsMatch(password, @"[a-z]"))
            return "密码必须包含小写字母";

        if (!Regex.IsMatch(password, @"[A-Z]"))
            return "密码必须包含大写字母";

        if (!Regex.IsMatch(password, @"\d"))
            return "密码必须包含数字";

        if (!Regex.IsMatch(password, @"[!@#$%^&*(),.?""':{}|<>]"))
            return "密码必须包含特殊字符";

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

        // 小写字母
        if (Regex.IsMatch(password, @"[a-z]"))
            score += 10;

        // 大写字母
        if (Regex.IsMatch(password, @"[A-Z]"))
            score += 10;

        // 数字
        if (Regex.IsMatch(password, @"\d"))
            score += 10;

        // 特殊字符
        if (Regex.IsMatch(password, @"[!@#$%^&*(),.?""':{}|<>]"))
            score += 15;

        // 多种字符类型混合
        int charTypes = 0;
        if (Regex.IsMatch(password, @"[a-z]")) charTypes++;
        if (Regex.IsMatch(password, @"[A-Z]")) charTypes++;
        if (Regex.IsMatch(password, @"\d")) charTypes++;
        if (Regex.IsMatch(password, @"[!@#$%^&*(),.?""':{}|<>]")) charTypes++;
        
        if (charTypes >= 3)
            score += 15;

        return Math.Min(score, 100);
    }
}



