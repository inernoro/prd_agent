using System.Diagnostics;
using System.Security.Claims;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.AspNetCore.Mvc.Infrastructure;
using Microsoft.Extensions.Caching.Memory;
using MongoDB.Driver;
using PrdAgent.Api.Controllers;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Api.Mcp;
using PrdAgent.Api.Services.Mcp;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Filters;

/// <summary>
/// 直连工具接口（绕开 /api/mcp）时的用量闸门。
///
/// 为什么要有它：sk-ak 密钥不止能走 /api/mcp，拿着同一把钥匙直接 POST /api/open/visual/images
/// 一样能出图。闸门原先只长在 McpGatewayController 里，于是「每日 50 张」只拦得住经网关的那条路，
/// 绕过网关直连就没有上限——接入台上写着的配额，对直连是假的。所以把同一套闸门挪到两条路都会
/// 经过的位置：全局动作过滤器。
///
/// 判据刻意收窄到「这次请求命中了哪个工具」—— 内置工具走 McpBuiltinTools.MatchRequest，动态工具
/// 走 AgentOpenEndpoint 登记表 —— 而不是「凡 sk-ak 都计一笔」：sk-ak 早于本次改动就存在，把每日
/// 写入额度一把套到全部 sk-ak 流量上，等于给既有集成凭空加了一道每天 200 次的天花板。反过来，只堵
/// 内置工具那一半也不行：登记表接口在网关那条路上是扣额度的，直连不扣就等于后门还开着。
///
/// 三种请求原样放过：
///   - 没命中任何工具的路径：不归这套配额管
///   - 不带 agentApiKeyId 的（管理台 JWT、匿名读、老的开放平台 appId 密钥）：同上
///   - 网关自己的回环续跳：网关已经占过坑，这里再占一次就是一次调用扣两回
///
/// 额度是**先占坑、失败退还**（与网关同一套 McpUsageService），所以这里也必须在动作返回非 2xx
/// 或抛异常时把坑退回去，否则一次参数写错就白扣一张图。
///
/// 已知边界（都记在 doc/debt.platform.md）：直连这条路拿不到下游的幂等命中信号，也不解析产物，
/// 所以记录里产物列为空、重试命中幂等仍会扣一次额度；scope 不足的直连由 RequireScopeAttribute
/// 在授权阶段就 403 了，到不了这里，所以那类拒绝不进调用记录；动态工具的调用方白名单同样只在
/// 网关那条路上生效（这一条早于本次改动就是如此）。
/// </summary>
public sealed class AgentApiKeyUsageFilter : IAsyncActionFilter, IOrderedFilter
{
    /// <summary>
    /// 必须排在 [ApiController] 的自动模型校验之前（那个过滤器的 Order 是 -2000）。
    ///
    /// 普通动作过滤器是 Order 0，跑在它后面；于是 body 传坏的直连请求（比如给整型
    /// count 传个字符串）会被模型校验直接短路成 400，**既不过每分钟窗口、也不进调用
    /// 记录** —— 而这道闸门宣称覆盖所有直连调用，等于给刷接口留了一条不留痕的路。
    ///
    /// 排到前面之后，next() 里包着模型校验：它短路返回的 400 会被下面那段收尾逻辑
    /// 当成非 2xx 正常处理（退还已占额度 + 记一条失败审计），语义与其它失败一致。
    /// </summary>
    public int Order => -2001;

    /// <summary>动态工具登记表的缓存键与存活时间。新登记的接口最多 30 秒后进闸门。</summary>
    private const string DynamicEndpointsCacheKey = "mcp:usage-gate:active-open-endpoints";
    private static readonly TimeSpan DynamicEndpointsTtl = TimeSpan.FromSeconds(30);

    private readonly McpUsageService _usage;
    private readonly McpLoopbackSignal _loopback;
    private readonly MongoDbContext _db;
    private readonly IMemoryCache _cache;

    public AgentApiKeyUsageFilter(McpUsageService usage, McpLoopbackSignal loopback,
        MongoDbContext db, IMemoryCache cache)
    {
        _usage = usage;
        _loopback = loopback;
        _db = db;
        _cache = cache;
    }

    public async Task OnActionExecutionAsync(ActionExecutingContext context, ActionExecutionDelegate next)
    {
        var http = context.HttpContext;
        // 主体与 keyId 必须一起取：审计行里的「谁的调用」「哪把钥匙」都从主体上读，
        // 只把 keyId 捞出来、主体还是那个空的匿名主体，记录就会写成「没有主人」，
        // 而接入台按主人过滤 —— 额度扣了，列表里查无此事。
        var principal = http.User;
        var keyId = principal?.FindFirst("agentApiKeyId")?.Value;
        if (string.IsNullOrEmpty(keyId))
        {
            var resolved = await ResolveAgentPrincipalForAnonymousEndpointAsync(http);
            if (resolved != null)
            {
                principal = resolved;
                keyId = resolved.FindFirst("agentApiKeyId")?.Value;
            }
        }

        if (string.IsNullOrEmpty(keyId) || _loopback.IsGatewayContinuation(http.Request))
        {
            await next();
            return;
        }

        var ct = http.RequestAborted;
        var method = http.Request.Method;
        var path = http.Request.Path.Value ?? string.Empty;

        string toolName;
        string? capability;
        bool isWrite;
        int imageCount;

        var tool = McpBuiltinTools.MatchRequest(method, path);
        if (tool != null)
        {
            // 判据全部取自工具定义，与网关读的是同一份：WritesData 显式声明的（如取用技能是 POST
            // 但算读）在两条路上必须给出同一个答案，否则「同一件事，走网关扣额度、直连不扣」。
            toolName = tool.Name;
            capability = McpCapabilityCatalog.ByScope(tool.RequiredScope)?.Key;
            isWrite = McpUsageService.IsWriteTool(tool);
            imageCount = McpUsageService.IsImageTool(tool) ? ReadImageCount(context) : 0;
        }
        else
        {
            // 动态工具（AgentOpenEndpoint 登记表）同样有两条路：网关的 tools/call 会扣写入额度，
            // 直接打登记的那个 Path 原先不扣 —— 只堵内置工具那一半，等于登记表接口仍是无上限的后门。
            var dyn = await MatchDynamicEndpointAsync(method, path, ct);
            if (dyn == null)
            {
                await next();
                return;
            }

            toolName = McpGatewayController.DynamicToolName(dyn);
            capability = null;  // 动态工具没有能力归属，与网关一致
            isWrite = !HttpMethods.IsGet(method);
            imageCount = 0;
        }

        var startedAt = Stopwatch.GetTimestamp();

        var rate = await _usage.CheckRateAsync(keyId, ct);
        if (!rate.Allowed)
        {
            context.Result = Reject(rate.Reason!);
            // SuppressLog：同一分钟内已经落过一条同类拒绝，再落就是被挡住的洪水一条条进库
            if (!rate.SuppressLog)
                await LogAsync(http, principal, keyId, toolName, capability, isWrite, imageCount, "denied", 0,
                    rate.Reason!, startedAt);
            return;
        }

        var verdict = await _usage.CheckAsync(keyId, imageCount, isWrite, ct);
        if (!verdict.Allowed)
        {
            context.Result = Reject(verdict.Reason!);
            await LogAsync(http, principal, keyId, toolName, capability, isWrite, imageCount, "denied", 0,
                verdict.Reason!, startedAt);
            return;
        }

        var executed = await next();

        var threw = executed.Exception != null;
        var status = ResolveLoggedStatus((executed.Result as IStatusCodeActionResult)?.StatusCode, threw);
        var ok = !threw && status >= 200 && status < 300;
        if (!ok && verdict.ReservedKind != null)
            await _usage.ReleaseAsync(keyId, verdict.ReservedKind, verdict.ReservedAmount, verdict.ReservedDay,
                CancellationToken.None);

        await LogAsync(http, principal, keyId, toolName, capability, isWrite, imageCount,
            ok ? "success" : "error", status,
            ok ? null
                : threw ? "直连开放接口抛了异常，原因见服务端日志。"
                : "直连开放接口返回了非 2xx，详情见接口自身的返回体。",
            startedAt);
    }

    /// <summary>
    /// 记进审计的那个 HTTP 状态码。
    ///
    /// 动作抛出去的时候 <c>executed.Result</c> 是 null，取默认值就会记成 HTTP 200 —— 而同一行
    /// 记录的状态是「失败」。面板上于是长出「失败 · HTTP 200」这种自相矛盾的审计，
    /// 排障的人第一件事得先怀疑记录本身。抛出去的最终由异常管道翻成 500，这里就按 500 记。
    /// </summary>
    internal static int ResolveLoggedStatus(int? resultStatus, bool threw)
        => resultStatus ?? (threw ? StatusCodes.Status500InternalServerError : StatusCodes.Status200OK);

    /// <summary>
    /// 标了 [AllowAnonymous] 的端点上，带着密钥的调用方也拿不到身份。
    ///
    /// 原因：ApiKey 是非默认 scheme，AllowAnonymous 让授权环节不去选它，于是认证中间件
    /// 不会填 HttpContext.User。海鲜市场的读端点（搜索 / 详情 / 取用）正是这一类，
    /// 而它们背后挂着三个内置工具。结果是「带钥匙直连这三个端点」既不进每分钟窗口、
    /// 也不进调用记录 —— 本 PR 宣称的「两条路同一套闸门」在这三个工具上是假的。
    ///
    /// 所以这里补跑一次认证，但**只对确实带了 sk-ak- 的请求**（别的请求一次都不多跑），
    /// 且结果只在闸门内部用、不写回 HttpContext.User：那些端点本来就允许匿名，
    /// 替它们改主体会顺手改掉下游看到的身份，属于本轮不该动的东西。
    /// </summary>
    private static async Task<ClaimsPrincipal?> ResolveAgentPrincipalForAnonymousEndpointAsync(HttpContext http)
    {
        if (!HasAgentKeyCredential(http.Request)) return null;
        var result = await http.AuthenticateAsync("ApiKey");
        // 只在闸门与审计里用，不写回 HttpContext.User：那些端点本来就允许匿名，
        // 替它们改主体会顺手改掉下游看到的身份。
        return result.Succeeded ? result.Principal : null;
    }

    /// <summary>
    /// 请求头里带的是 sk-ak- 密钥吗（JWT 会话与别的 key 形态一律不算）。
    ///
    /// 取头的顺序必须与 ApiKeyAuthenticationHandler 完全一致：先 Authorization，
    /// 它整个缺席时才退到 X-AI-Access-Key。少认一个头，等于「换个写法就绕过闸门」——
    /// 判据比它该管的范围窄，是本仓库反复栽的那个形状。
    /// </summary>
    internal static bool HasAgentKeyCredential(HttpRequest request)
    {
        if (!request.Headers.TryGetValue("Authorization", out var auth)
            && !request.Headers.TryGetValue("X-AI-Access-Key", out auth))
            return false;

        var raw = auth.ToString();
        var token = raw.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase)
            ? raw["Bearer ".Length..].Trim()
            : raw.Trim();
        return token.StartsWith("sk-ak-", StringComparison.Ordinal);
    }

    /// <summary>
    /// 反查动态工具（AgentOpenEndpoint 登记表）。登记表在 Mongo 里，每个请求都查一次太贵，
    /// 缓存 30 秒 —— 代价是新登记的接口最多晚 30 秒进闸门，这比每次直连都多一次数据库往返划算。
    /// </summary>
    private async Task<AgentOpenEndpoint?> MatchDynamicEndpointAsync(string method, string path,
        CancellationToken ct)
    {
        if (!_cache.TryGetValue(DynamicEndpointsCacheKey, out List<AgentOpenEndpoint>? endpoints)
            || endpoints == null)
        {
            endpoints = await _db.AgentOpenEndpoints.Find(e => e.IsActive).ToListAsync(ct);
            _cache.Set(DynamicEndpointsCacheKey, endpoints, DynamicEndpointsTtl);
        }

        return endpoints.FirstOrDefault(e =>
            string.Equals(e.HttpMethod, method, StringComparison.OrdinalIgnoreCase)
            && McpBuiltinTools.PathTemplateMatches(e.Path, path));
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
    private Task LogAsync(HttpContext http, ClaimsPrincipal? principal, string keyId, string toolName,
        string? capability,
        bool isWrite, int imageCount, string status, int httpStatus, string? error, long startedAt)
        => _usage.LogAsync(new McpCallLog
        {
            // 用闸门认出来的那个主体，不是 http.User —— 匿名端点上后者是空的
            OwnerUserId = principal?.FindFirst("boundUserId")?.Value ?? string.Empty,
            KeyId = keyId,
            KeyName = principal?.FindFirst("appName")?.Value ?? string.Empty,
            // 记成工具名本身，接入台按工具聚合时直连与走网关的算同一件事；
            // 「怎么进来的」放进入参摘要，需要区分时看得见。
            ToolName = toolName,
            Capability = capability,
            ArgumentsPreview = $"直连 {http.Request.Method} {http.Request.Path.Value}",
            Status = status,
            HttpStatus = httpStatus,
            ErrorMessage = error,
            IsWrite = isWrite,
            ImageCount = imageCount,
            DurationMs = (int)Stopwatch.GetElapsedTime(startedAt).TotalMilliseconds,
        }, CancellationToken.None);
}
