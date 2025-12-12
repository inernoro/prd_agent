using System.Text.RegularExpressions;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Models.Requests;

/// <summary>
/// 用户注册请求
/// </summary>
public partial class RegisterRequest
{
    /// <summary>用户名（4-32字符，字母数字下划线）</summary>
    public string Username { get; set; } = string.Empty;

    /// <summary>密码（8-64字符）</summary>
    public string Password { get; set; } = string.Empty;

    /// <summary>邀请码</summary>
    public string InviteCode { get; set; } = string.Empty;

    /// <summary>角色 (PM/DEV/QA)</summary>
    public UserRole Role { get; set; }

    /// <summary>显示名称（可选）</summary>
    public string? DisplayName { get; set; }

    /// <summary>验证请求</summary>
    public (bool IsValid, string? ErrorMessage) Validate()
    {
        if (string.IsNullOrWhiteSpace(Username))
            return (false, "用户名不能为空");
        if (Username.Length < 4 || Username.Length > 32)
            return (false, "用户名长度需在4-32字符之间");
        if (!UsernameRegex().IsMatch(Username))
            return (false, "用户名只能包含字母、数字和下划线");

        if (string.IsNullOrWhiteSpace(Password))
            return (false, "密码不能为空");
        if (Password.Length < 8 || Password.Length > 64)
            return (false, "密码长度需在8-64字符之间");

        if (string.IsNullOrWhiteSpace(InviteCode))
            return (false, "邀请码不能为空");

        if (DisplayName != null && DisplayName.Length > 50)
            return (false, "显示名称不能超过50字符");

        return (true, null);
    }

    [GeneratedRegex(@"^[a-zA-Z0-9_]+$")]
    private static partial Regex UsernameRegex();
}

/// <summary>
/// 用户登录请求
/// </summary>
public class LoginRequest
{
    /// <summary>用户名</summary>
    public string Username { get; set; } = string.Empty;

    /// <summary>密码</summary>
    public string Password { get; set; } = string.Empty;

    /// <summary>验证请求</summary>
    public (bool IsValid, string? ErrorMessage) Validate()
    {
        if (string.IsNullOrWhiteSpace(Username))
            return (false, "用户名不能为空");
        if (string.IsNullOrWhiteSpace(Password))
            return (false, "密码不能为空");
        return (true, null);
    }
}

/// <summary>
/// 刷新令牌请求
/// </summary>
public class RefreshTokenRequest
{
    /// <summary>刷新令牌</summary>
    public string RefreshToken { get; set; } = string.Empty;

    /// <summary>验证请求</summary>
    public (bool IsValid, string? ErrorMessage) Validate()
    {
        if (string.IsNullOrWhiteSpace(RefreshToken))
            return (false, "刷新令牌不能为空");
        return (true, null);
    }
}