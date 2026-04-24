using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Authorization;

/// <summary>
/// 要求请求携带指定 scope（在 ClaimsPrincipal 的 "scope" claim 中）才放行。
///
/// 约定：scope 来自 <see cref="ApiKeyAuthenticationHandler"/>，格式 `{resource}:{action}`。
/// 任一所需 scope 匹配即可（OR 语义）。无 scope 或未认证 → 403 PERMISSION_DENIED。
///
/// 仅与 AgentApiKey 鉴权路径配合使用；JWT / AiAccessKey 不会带 scope claim，使用本属性的端点
/// 应同时加 <c>[Authorize(AuthenticationSchemes = "ApiKey")]</c>。
/// </summary>
[AttributeUsage(AttributeTargets.Method | AttributeTargets.Class, AllowMultiple = false)]
public class RequireScopeAttribute : Attribute, IAsyncAuthorizationFilter
{
    private readonly string[] _requiredScopes;

    public RequireScopeAttribute(params string[] requiredScopes)
    {
        _requiredScopes = requiredScopes ?? Array.Empty<string>();
    }

    public Task OnAuthorizationAsync(AuthorizationFilterContext context)
    {
        if (_requiredScopes.Length == 0) return Task.CompletedTask;

        var user = context.HttpContext.User;
        if (user?.Identity?.IsAuthenticated != true)
        {
            context.Result = new ObjectResult(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "未认证"))
            {
                StatusCode = StatusCodes.Status401Unauthorized
            };
            return Task.CompletedTask;
        }

        var ownedScopes = user.FindAll("scope").Select(c => c.Value).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var hit = _requiredScopes.Any(required => ownedScopes.Contains(required));
        if (!hit)
        {
            var msg = $"此接口要求 scope: {string.Join(" 或 ", _requiredScopes)}。当前 Key 未授权该范围。";
            context.Result = new ObjectResult(ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, msg))
            {
                StatusCode = StatusCodes.Status403Forbidden
            };
        }
        return Task.CompletedTask;
    }
}
