using System.ComponentModel.DataAnnotations;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Models.Requests;

/// <summary>
/// 用户注册请求
/// </summary>
public class RegisterRequest
{
    /// <summary>用户名（4-32字符，字母数字下划线）</summary>
    [Required(ErrorMessage = "用户名不能为空")]
    [StringLength(32, MinimumLength = 4, ErrorMessage = "用户名长度需在4-32字符之间")]
    [RegularExpression(@"^[a-zA-Z0-9_]+$", ErrorMessage = "用户名只能包含字母、数字和下划线")]
    public string Username { get; set; } = string.Empty;

    /// <summary>密码（8-64字符）</summary>
    [Required(ErrorMessage = "密码不能为空")]
    [StringLength(64, MinimumLength = 8, ErrorMessage = "密码长度需在8-64字符之间")]
    public string Password { get; set; } = string.Empty;

    /// <summary>邀请码</summary>
    [Required(ErrorMessage = "邀请码不能为空")]
    public string InviteCode { get; set; } = string.Empty;

    /// <summary>角色 (PM/DEV/QA)</summary>
    [Required(ErrorMessage = "角色不能为空")]
    public UserRole Role { get; set; }

    /// <summary>显示名称（可选）</summary>
    [StringLength(50, ErrorMessage = "显示名称不能超过50字符")]
    public string? DisplayName { get; set; }
}

/// <summary>
/// 用户登录请求
/// </summary>
public class LoginRequest
{
    /// <summary>用户名</summary>
    [Required(ErrorMessage = "用户名不能为空")]
    public string Username { get; set; } = string.Empty;

    /// <summary>密码</summary>
    [Required(ErrorMessage = "密码不能为空")]
    public string Password { get; set; } = string.Empty;
}

/// <summary>
/// 刷新令牌请求
/// </summary>
public class RefreshTokenRequest
{
    /// <summary>刷新令牌</summary>
    [Required]
    public string RefreshToken { get; set; } = string.Empty;
}

