using Microsoft.AspNetCore.Mvc.Filters;
using PrdAgent.Infrastructure.Services;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>Share access never binds a password from a URL or a repeated request body.</summary>
public sealed class HostedShareCookieAttribute : ActionFilterAttribute
{
    public override void OnActionExecuting(ActionExecutingContext context)
    {
        if (context.ActionDescriptor.RouteValues.TryGetValue("action", out var action) && action == "UnlockShare") return;
        var token = context.RouteData.Values.GetValueOrDefault("token")?.ToString();
        if (string.IsNullOrEmpty(token)) return;
        var credential = context.HttpContext.Request.Cookies[HostedShareGrant.CookieName(token)];
        // MVC does not populate ActionArguments for an omitted optional query value.
        // The declared parameter must receive the cookie even when no query was sent.
        if (context.ActionArguments.ContainsKey("password")
            || context.ActionDescriptor.Parameters.Any(parameter => parameter.Name == "password"))
            context.ActionArguments["password"] = credential;
        foreach (var argument in context.ActionArguments.Values.ToArray())
        {
            var property = argument?.GetType().GetProperty("Password");
            if (property?.CanWrite == true && property.PropertyType == typeof(string)) property.SetValue(argument, credential);
        }
        context.HttpContext.Response.Headers["Cache-Control"] = "no-store";
        context.HttpContext.Response.Headers["Referrer-Policy"] = "no-referrer";
    }
}
