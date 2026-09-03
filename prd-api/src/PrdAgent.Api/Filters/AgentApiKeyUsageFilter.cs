using System.Diagnostics;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.AspNetCore.Mvc.Infrastructure;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Api.Mcp;
using PrdAgent.Api.Services.Mcp;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Filters;

/// <summary>
/// 直连内置工具接口时的用量闸门。
///
/// 为什么要有它：sk-ak 密钥不止能走 /api/mcp，拿着同一把钥匙直接 POST /api/open/visual/images
/// 一样能出图。闸门原先只长在 McpGatewayController 里，于是「每日 50 张」只拦得住经网关的那条路，
/// 绕过网关直连就没有上限——接入台上写着的配额，对直连是假的。所以把同一套闸门挪到两条路都会
/// 经过的位置：全局动作过滤器。
///
/// 判据刻意收窄到「这次请求命中了哪个内置工具」（McpBuiltinTools.MatchRequest），不是「凡 sk-ak
/// 都计一笔」：sk-ak 早于本次改动就存在，还承载着缺陷分享、Agent 登记表等既有集成，把每日写入额度
/// 一把套到全部 sk-ak 流量上，等于给这些既有集成凭空加了一道每天 200 次的天花板。
///
/// 三种请求原样放过：
///   - 没命中任何内置工具的路径：不归这套配额管
///   - 不带 agentApiKeyId 的（管理台 JWT、匿名读、老的开放平台 appId 密钥）：同上
///   - 网关自己的回环续跳：网关已经占过坑，这里再占一次就是一次调用扣两回
///
/// 额度是**先占坑、失败退还**（与网关同一套 McpUsageService），所以这里也必须在动作返回非 2xx
/// 或抛异常时把坑退回去，否则一次参数写错就白扣一张图。
///
/// 已知边界：直连这条路拿不到下游的幂等命中信号，也不解析产物，所以记录里产物列为空、重试命中
/// 幂等仍会扣一次额度（与网关同源的欠账，见 doc/debt.platform.md）。
/// </summary>
public sealed class AgentApiKeyUsageFilter : IAsyncActionFilter
{
    private readonly McpUsageService _usage;
    private readonly McpLoopbackSignal _loopback;

    public AgentApiKeyUsageFilter(McpUsageService usage, McpLoopbackSignal loopback)
    {
        _usage = usage;
        _loopback = loopback;
    }

    public async Task OnActionExecutionAsync(ActionExecutingContext context, ActionExecutionDelegate next)
    {
        var http = context.HttpContext;
        var keyId = http.User?.FindFirst("agentApiKeyId")?.Value;
        if (string.IsNullOrEmpty(keyId) || _loopback.IsGatewayContinuation(http.Request))
        {
            await next();
            return;
        }

        var tool = McpBuiltinTools.MatchRequest(http.Request.Method, http.Request.Path.Value ?? string.Empty);
        if (tool == null)
        {
            await next();
            return;
        }

        var ct = http.RequestAborted;
        // 判据全部取自工具定义，与网关读的是同一份：WritesData 显式声明的（如取用技能是 POST 但算读）
        // 在两条路上必须给出同一个答案，否则「同一件事，走网关扣额度、直连不扣」。
        var isWrite = McpUsageService.IsWriteTool(tool);
        var imageCount = McpUsageService.IsImageTool(tool) ? ReadImageCount(context) : 0;
        var startedAt = Stopwatch.GetTimestamp();

        var rate = await _usage.CheckRateAsync(keyId, ct);
        if (!rate.Allowed)
        {
            context.Result = Reject(rate.Reason!);
            // SuppressLog：同一分钟内已经落过一条同类拒绝，再落就是被挡住的洪水一条条进库
            if (!rate.SuppressLog)
                await LogAsync(http, keyId, tool, isWrite, imageCount, "denied", 0, rate.Reason!, startedAt);
            return;
        }

        var verdict = await _usage.CheckAsync(keyId, imageCount, isWrite, ct);
        if (!verdict.Allowed)
        {
            context.Result = Reject(verdict.Reason!);
            await LogAsync(http, keyId, tool, isWrite, imageCount, "denied", 0, verdict.Reason!, startedAt);
            return;
        }

        var executed = await next();

        var status = (executed.Result as IStatusCodeActionResult)?.StatusCode ?? StatusCodes.Status200OK;
        var ok = executed.Exception == null && status >= 200 && status < 300;
        if (!ok && verdict.ReservedKind != null)
            await _usage.ReleaseAsync(keyId, verdict.ReservedKind, verdict.ReservedAmount, verdict.ReservedDay,
                CancellationToken.None);

        await LogAsync(http, keyId, tool, isWrite, imageCount, ok ? "success" : "error", status,
            ok ? null : "直连开放接口返回了非 2xx，详情见接口自身的返回体。", startedAt);
    }

    /// <summary>
    /// 这次直连要出几张图。读的是**控制器真正会用的那个数**（同一个 ResolveImageCount），
    /// 不是自己再 clamp 一遍——两处各算各的，闸门占的坑早晚会和实际出图数对不上。
    /// </summary>
    private static int ReadImageCount(ActionExecutingContext context)
    {
        foreach (var arg in context.ActionArguments.Values)
            if (arg is VisualOpenApiController.GenerateImageRequest g)
                return VisualOpenApiController.ResolveImageCount(g);
        return VisualOpenApiController.ResolveImageCount(null);
    }

    private static IActionResult Reject(string reason) => new ObjectResult(
        ApiResponse<object>.Fail(ErrorCodes.RATE_LIMITED, reason))
    {
        StatusCode = StatusCodes.Status429TooManyRequests,
    };

    /// <summary>
    /// 直连也要落记录：接入台的「今日用量」和「调用记录」读的是两份数据，只扣数不留记录的话，
    /// 用户会看到额度在掉、列表里却什么都没发生。
    /// </summary>
    private Task LogAsync(HttpContext http, string keyId, McpToolDef tool, bool isWrite, int imageCount,
        string status, int httpStatus, string? error, long startedAt)
        => _usage.LogAsync(new McpCallLog
        {
            OwnerUserId = http.User?.FindFirst("boundUserId")?.Value ?? string.Empty,
            KeyId = keyId,
            KeyName = http.User?.FindFirst("appName")?.Value ?? string.Empty,
            // 记成工具名本身，接入台按工具聚合时直连与走网关的算同一件事；
            // 「怎么进来的」放进入参摘要，需要区分时看得见。
            ToolName = tool.Name,
            Capability = McpCapabilityCatalog.ByScope(tool.RequiredScope)?.Key,
            ArgumentsPreview = $"直连 {http.Request.Method} {http.Request.Path.Value}",
            Status = status,
            HttpStatus = httpStatus,
            ErrorMessage = error,
            IsWrite = isWrite,
            ImageCount = imageCount,
            DurationMs = (int)Stopwatch.GetElapsedTime(startedAt).TotalMilliseconds,
        }, CancellationToken.None);
}
