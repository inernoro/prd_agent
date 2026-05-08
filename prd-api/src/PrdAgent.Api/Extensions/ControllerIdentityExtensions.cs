using System.Security.Claims;
using Microsoft.AspNetCore.Mvc;
using Microsoft.IdentityModel.JsonWebTokens;

namespace PrdAgent.Api.Extensions;

/// <summary>
/// Controller 身份提取扩展方法。
/// 替代各 Controller 中分散的 GetAdminId() / GetUserId() 私有方法，
/// 统一 claim 提取顺序和异常行为：找不到身份时快速失败，杜绝 "unknown" 回退。
/// </summary>
public static class ControllerIdentityExtensions
{
    /// <summary>
    /// 从 JWT claims 中提取当前用户 ID。
    /// 找不到时抛出 <see cref="UnauthorizedAccessException"/>，
    /// 由全局 ExceptionMiddleware 转为 HTTP 401。
    /// </summary>
    public static string GetRequiredUserId(this ControllerBase controller)
    {
        var id = controller.User.FindFirst(JwtRegisteredClaimNames.Sub)?.Value
              ?? controller.User.FindFirst("sub")?.Value
              ?? controller.User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        if (string.IsNullOrWhiteSpace(id))
            throw new UnauthorizedAccessException("Missing user identity claims");
        return id;
    }

    /// <summary>
    /// 同 GetRequiredUserId 但找不到时返回 null（用于"匿名也允许的端点"场景，如
    /// /api/weekly-posters/current —— 未登录读取最新公开海报、登录读取过滤已读后的海报）。
    /// </summary>
    public static string? GetUserIdOrNull(this ControllerBase controller)
    {
        return controller.User.FindFirst(JwtRegisteredClaimNames.Sub)?.Value
            ?? controller.User.FindFirst("sub")?.Value
            ?? controller.User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
    }
}
