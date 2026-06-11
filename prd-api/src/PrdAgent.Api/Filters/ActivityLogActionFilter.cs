using System.IdentityModel.Tokens.Jwt;
using System.Reflection;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.Mvc.Filters;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Filters;

/// <summary>
/// 团队动态过滤器（全局挂载）— 白名单（ActivityActionRegistry）内的写操作成功后
/// 自动写一条 activity_logs，支撑「团队动态」时间线。
/// 机制对照 PmAuditActionFilter：白名单外（含所有读接口）一次字典查找即逃逸；
/// 仅记录 2xx；写入失败绝不影响主请求（全程 try/catch）。
/// 差异点：TitleDb 类条目在 next() 之前预读标题，保证删除类动作仍能拿到删除前快照。
/// </summary>
public sealed class ActivityLogActionFilter : IAsyncActionFilter
{
    private const int MaxTitleLength = 200;

    private readonly MongoDbContext _db;
    private readonly ILogger<ActivityLogActionFilter> _logger;

    public ActivityLogActionFilter(MongoDbContext db, ILogger<ActivityLogActionFilter> logger)
    {
        _db = db;
        _logger = logger;
    }

    public async Task OnActionExecutionAsync(ActionExecutingContext context, ActionExecutionDelegate next)
    {
        ActivityActionDef? def = null;
        string actionKey = string.Empty;
        string? targetId = null;
        string? preloadedTitle = null;
        IDictionary<string, object?>? args = null;

        try
        {
            var method = context.HttpContext.Request.Method;
            if (!HttpMethods.IsGet(method) && !HttpMethods.IsHead(method) && !HttpMethods.IsOptions(method)
                && context.ActionDescriptor is ControllerActionDescriptor cad
                && ActivityActionRegistry.Actions.TryGetValue($"{cad.ControllerName}.{cad.ActionName}", out var found))
            {
                def = found;
                actionKey = $"{cad.ControllerName}.{cad.ActionName}";
                args = context.ActionArguments!;

                if (def.TargetRouteKey != null
                    && context.RouteData.Values.TryGetValue(def.TargetRouteKey, out var tv))
                {
                    targetId = tv?.ToString();
                }

                // 删除/状态流转类动作在执行前预读标题，拿删除前的快照
                if (def.TitleDb != null && !string.IsNullOrEmpty(targetId))
                {
                    preloadedTitle = await def.TitleDb(_db, targetId);
                }
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[team-activity] 预读动态标题失败");
        }

        var executed = await next();

        if (def == null) return;

        try
        {
            // Action 抛了未处理异常时不留痕——此时 Result 为空、响应码还停留在默认 200，不能当成功
            if (executed.Exception != null && !executed.ExceptionHandled) return;

            // 仅记录成功结果（2xx）
            var status = (executed.Result as ObjectResult)?.StatusCode
                         ?? (executed.Result as StatusCodeResult)?.StatusCode
                         ?? context.HttpContext.Response?.StatusCode
                         ?? 200;
            if (status is < 200 or >= 300) return;

            var actorId = context.HttpContext.User.FindFirst(JwtRegisteredClaimNames.Sub)?.Value ?? string.Empty;
            if (string.IsNullOrEmpty(actorId)) return;

            var title = preloadedTitle ?? ExtractTitleFromArgs(args, def.TitleArgs);
            if (title is { Length: > MaxTitleLength })
            {
                title = title[..MaxTitleLength];
            }

            var entry = new ActivityLog
            {
                ActorId = actorId,
                Module = def.Module,
                ModuleLabel = def.ModuleLabel,
                Action = actionKey,
                ActionLabel = def.ActionLabel,
                TargetId = targetId,
                TargetTitle = string.IsNullOrWhiteSpace(title) ? null : title.Trim(),
                Method = context.HttpContext.Request.Method,
                Path = context.HttpContext.Request.Path.Value ?? string.Empty,
            };
            await _db.ActivityLogs.InsertOneAsync(entry, cancellationToken: CancellationToken.None);
        }
        catch (Exception ex)
        {
            // 动态写入失败不得影响主流程
            _logger.LogWarning(ex, "[team-activity] 写团队动态失败");
        }
    }

    /// <summary>
    /// 按白名单声明的参数路径提取标题。
    /// 支持三种形式："request.Title"（DTO 属性反射）、"title"（裸 string 参数）、"file"（IFormFile 取 FileName）。
    /// </summary>
    private static string? ExtractTitleFromArgs(IDictionary<string, object?>? args, string[]? specs)
    {
        if (args == null || specs == null) return null;

        foreach (var spec in specs)
        {
            var dot = spec.IndexOf('.');
            if (dot < 0)
            {
                if (!args.TryGetValue(spec, out var v) || v == null) continue;
                switch (v)
                {
                    case string s when !string.IsNullOrWhiteSpace(s):
                        return s;
                    case IFormFile f when !string.IsNullOrWhiteSpace(f.FileName):
                        return f.FileName;
                }
            }
            else
            {
                var argName = spec[..dot];
                var propName = spec[(dot + 1)..];
                if (!args.TryGetValue(argName, out var obj) || obj == null) continue;
                var prop = obj.GetType().GetProperty(propName,
                    BindingFlags.Public | BindingFlags.Instance | BindingFlags.IgnoreCase);
                if (prop?.GetValue(obj) is string val && !string.IsNullOrWhiteSpace(val))
                {
                    return val;
                }
            }
        }
        return null;
    }
}
