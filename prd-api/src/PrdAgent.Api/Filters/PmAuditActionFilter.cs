using System.IdentityModel.Tokens.Jwt;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.Mvc.Filters;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Filters;

/// <summary>
/// 项目管理操作审计过滤器 — 在写操作（POST/PUT/DELETE）成功后自动写一条 pm_audit_logs，
/// 避免在 30+ 个端点里逐个埋点。只记录 ActionLabels 白名单内的动作（自然排除读接口）。
/// 审计写入失败绝不影响主请求（全程 try/catch）。
/// </summary>
public sealed class PmAuditActionFilter : IAsyncActionFilter
{
    private readonly MongoDbContext _db;
    private readonly ILogger<PmAuditActionFilter> _logger;

    public PmAuditActionFilter(MongoDbContext db, ILogger<PmAuditActionFilter> logger)
    {
        _db = db;
        _logger = logger;
    }

    /// <summary>Action 名 → 中文标签。不在表内的动作（含所有读接口）不记审计。</summary>
    private static readonly Dictionary<string, string> ActionLabels = new(StringComparer.Ordinal)
    {
        ["CreateProject"] = "创建项目",
        ["UpdateProject"] = "更新项目",
        ["DeleteProject"] = "删除项目",
        ["SetMembers"] = "设置项目成员",
        ["SetStakeholders"] = "设置干系人",
        ["StartEvaluation"] = "发起结案评价",
        ["SubmitScore"] = "提交结案评分",
        ["FinalizeEvaluation"] = "汇总结案评价",
        ["ToggleExcellence"] = "评选/取消优秀项目",
        ["CreateTask"] = "创建任务",
        ["UpdateTask"] = "更新任务",
        ["DeleteTask"] = "删除任务",
        ["BatchCreateTasks"] = "批量创建任务",
        ["BulkTasks"] = "批量操作任务",
        ["AddComment"] = "任务评论",
        ["UploadKnowledgeFile"] = "上传知识库文件",
        ["UpdateKnowledgeFile"] = "修改知识库文件",
        ["DeleteKnowledgeFile"] = "删除知识库文件",
        ["CreateDecision"] = "新增决策",
        ["UpdateDecision"] = "更新决策",
        ["DeleteDecision"] = "删除决策",
        ["CreateWeeklyReport"] = "新增周报",
        ["UpdateWeeklyReport"] = "更新周报",
        ["DeleteWeeklyReport"] = "删除周报",
        ["UploadWeeklyReportImage"] = "上传周报图片",
        ["CreateMeeting"] = "新增会议纪要",
        ["UpdateMeeting"] = "更新会议纪要",
        ["DeleteMeeting"] = "删除会议纪要",
        ["CreateGoal"] = "新增目标",
        ["UpdateGoal"] = "更新目标",
        ["DeleteGoal"] = "删除目标",
        ["UpdateRewardConfig"] = "更新奖金配置",
    };

    /// <summary>路由里可能出现的子实体 id 键（取第一个命中的作为操作对象）</summary>
    private static readonly string[] TargetKeys =
    {
        "taskId", "goalId", "decisionId", "meetingId", "reportId", "fileId", "stakeholderId",
    };

    public async Task OnActionExecutionAsync(ActionExecutingContext context, ActionExecutionDelegate next)
    {
        var executed = await next();

        try
        {
            var method = context.HttpContext.Request.Method;
            if (HttpMethods.IsGet(method) || HttpMethods.IsHead(method) || HttpMethods.IsOptions(method))
                return;

            if (context.ActionDescriptor is not ControllerActionDescriptor cad)
                return;
            if (!ActionLabels.TryGetValue(cad.ActionName, out var label))
                return;

            // 仅记录成功结果（2xx）
            var status = (executed.Result as ObjectResult)?.StatusCode
                         ?? (executed.Result as StatusCodeResult)?.StatusCode
                         ?? context.HttpContext.Response?.StatusCode
                         ?? 200;
            if (status is < 200 or >= 300)
                return;

            var actorId = context.HttpContext.User.FindFirst(JwtRegisteredClaimNames.Sub)?.Value ?? string.Empty;
            if (string.IsNullOrEmpty(actorId))
                return;

            var route = context.RouteData.Values;
            var projectId = route.TryGetValue("projectId", out var pv) ? pv?.ToString() : null;
            string? targetId = null;
            foreach (var k in TargetKeys)
            {
                if (route.TryGetValue(k, out var tv) && tv != null) { targetId = tv.ToString(); break; }
            }

            var entry = new PmAuditLog
            {
                ProjectId = projectId,
                ActorId = actorId,
                Action = cad.ActionName,
                ActionLabel = label,
                Method = method,
                Path = context.HttpContext.Request.Path.Value ?? string.Empty,
                TargetId = targetId,
            };
            await _db.PmAuditLogs.InsertOneAsync(entry, cancellationToken: CancellationToken.None);
        }
        catch (Exception ex)
        {
            // 审计失败不得影响主流程
            _logger.LogWarning(ex, "[pm-audit] 写审计日志失败");
        }
    }
}
