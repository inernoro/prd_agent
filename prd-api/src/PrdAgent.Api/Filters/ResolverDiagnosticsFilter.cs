using System.Security.Claims;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Security;

namespace PrdAgent.Api.Filters;

public sealed class ResolverDiagnosticsFilter(IAdminPermissionService permissions, ILogger<ResolverDiagnosticsFilter> logger) : IAsyncAuthorizationFilter
{
    public async Task OnAuthorizationAsync(AuthorizationFilterContext context)
    {
        var user = context.HttpContext.User;
        var id = user.FindFirst(ClaimTypes.NameIdentifier)?.Value ?? user.FindFirst("sub")?.Value;
        var allowed = false;
        // API keys must never be promoted to a human administrator here.
        if (user.Identity?.IsAuthenticated == true && id != null && user.FindFirst("authType") == null)
        {
            var grants = await permissions.GetEffectivePermissionsAsync(id, user.FindFirst("isRoot")?.Value == "1", context.HttpContext.RequestAborted);
            allowed = grants.Contains(AdminPermissionCatalog.Super) ||
                (grants.Contains(AdminPermissionCatalog.Access) && grants.Contains(AdminPermissionCatalog.ModelsRead));
        }
        // No raw query, model name, topology, credential, or exception is recorded.
        var actor = id == null ? "anonymous" : Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(id)))[..16];
        logger.LogInformation("Resolver diagnostic access actor={Actor} allowed={Allowed} trace={Trace}", actor, allowed, context.HttpContext.TraceIdentifier);
        if (!allowed) context.Result = new StatusCodeResult(user.Identity?.IsAuthenticated == true ? 403 : 401);
    }
}
