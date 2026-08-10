using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 网页托管「向我提问」——访客对着一个托管页面提问，模型只依据该页面正文回答。
///
/// 独立于 WebPagesController 是因为这是唯一一条会烧 token 的路径：门禁、配额、
/// SSE 协议都和网页托管的 CRUD 完全不同族，混在一个 3000 行的控制器里没人找得到。
/// </summary>
[ApiController]
[Route("api/web-pages")]
[Authorize]
public class WebPageAskController : ControllerBase
{
    private readonly IHostedSiteService _siteService;
    private readonly ISiteContentSnapshotService _snapshots;
    private readonly IAskQuotaService _quota;
    private readonly ILlmGateway _gateway;
    private readonly ILLMRequestContextAccessor _llmRequestContext;
    private readonly MongoDbContext _db;
    private readonly ILogger<WebPageAskController> _logger;

    public WebPageAskController(
        IHostedSiteService siteService,
        ISiteContentSnapshotService snapshots,
        IAskQuotaService quota,
        ILlmGateway gateway,
        ILLMRequestContextAccessor llmRequestContext,
        MongoDbContext db,
        ILogger<WebPageAskController> logger)
    {
        _siteService = siteService;
        _snapshots = snapshots;
        _quota = quota;
        _gateway = gateway;
        _llmRequestContext = llmRequestContext;
        _db = db;
        _logger = logger;
    }

    // ──────────────────────────────────────────────
    // 配置：owner / editor 维护站点的提问开关与题库
    // ──────────────────────────────────────────────

    /// <summary>读站点的提问配置（owner 视角，含题库与配额）。</summary>
    [HttpGet("{siteId}/ask/config")]
    public async Task<IActionResult> GetAskConfig(string siteId)
    {
        var site = await _siteService.GetByIdAsync(siteId, this.GetRequiredUserId());
        if (site == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "站点不存在或无权访问"));

        return Ok(ApiResponse<object>.Ok(new
        {
            siteId = site.Id,
            enabled = site.AskEnabled,
            welcome = site.AskWelcome,
            suggestedQuestions = site.AskSuggestedQuestions ?? new List<string>(),
            allowAnonymous = site.AskAllowAnonymous,
            dailyLimit = site.AskDailyLimit,
            updatedAt = site.AskConfigUpdatedAt,
            // owner 在这里编辑的是**题库**（候选池），上限是存储上限；
            // 一条分享面板最多显示 maxDisplay 条，是另一回事，别混
            maxQuestions = AskOpeningQuestions.MaxLibrary,
            maxDisplay = AskOpeningQuestions.MaxDisplay,
            maxQuestionLength = AskOpeningQuestions.MaxLength,
        }));
    }

    /// <summary>写站点的提问配置（仅 owner / editor）。</summary>
    [HttpPut("{siteId}/ask/config")]
    public async Task<IActionResult> UpdateAskConfig(string siteId, [FromBody] AskConfigRequest req)
    {
        if (req == null)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.CONTENT_EMPTY, "请求体不能为空"));

        var site = await _siteService.SetAskConfigAsync(siteId, this.GetRequiredUserId(), new AskConfigUpdate
        {
            Enabled = req.Enabled,
            Welcome = req.Welcome,
            SuggestedQuestions = req.SuggestedQuestions,
            AllowAnonymous = req.AllowAnonymous,
            DailyLimit = req.DailyLimit,
        });

        if (site == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "站点不存在或无权修改"));

        return Ok(ApiResponse<object>.Ok(new
        {
            siteId = site.Id,
            enabled = site.AskEnabled,
            welcome = site.AskWelcome,
            suggestedQuestions = site.AskSuggestedQuestions,
            allowAnonymous = site.AskAllowAnonymous,
            dailyLimit = site.AskDailyLimit,
        }));
    }

    // ──────────────────────────────────────────────
    // 提问：站内（登录）与分享（可匿名）两个入口
    // ──────────────────────────────────────────────

    /// <summary>站内提问（登录用户对自己有权访问的站点）。</summary>
    [HttpPost("{siteId}/ask/stream")]
    public async Task AskStream(string siteId, [FromBody] AskStreamRequest req)
    {
        var userId = this.GetRequiredUserId();
        var site = await _siteService.GetByIdAsync(siteId, userId);

        // 门禁判定必须全部走完再写第一个 SSE 字节 —— 一旦开始写流，HTTP 状态码就已经
        // 是 200 了，前端拿不到 401/403/429，只能从流里读一条 error 事件。
        if (site == null)
        {
            await WriteJsonErrorAsync(404, ErrorCodes.NOT_FOUND, "站点不存在或无权访问");
            return;
        }
        if (!site.AskEnabled)
        {
            await WriteJsonErrorAsync(403, "ASK_DISABLED", "这个页面没有开启提问");
            return;
        }

        await RunAskAsync(site, req, userId, shareToken: null);
    }

    /// <summary>经分享链接提问（匿名或登录，取决于站点的 AllowAnonymous 开关）。</summary>
    [HttpPost("shares/view/{token}/ask/stream")]
    [AllowAnonymous]
    public async Task AskStreamByShare(string token, [FromBody] AskStreamRequest req)
    {
        var viewerUserId = User.Identity?.IsAuthenticated == true ? this.GetRequiredUserId() : null;

        // 分享门禁（撤销 / 过期 / 可见性 / 密码 + 滑动窗口限流）与站点归属校验，
        // 全部复用 ResolveShareSiteAsync —— 与正文代理、评论走同一套判定源。
        var resolved = await _siteService.ResolveShareSiteAsync(token, req?.SiteId, req?.Password, viewerUserId);
        if (resolved.Error != null)
        {
            if (resolved.HttpStatus == 429 && resolved.RetryAfterSeconds is { } ra && ra > 0)
                Response.Headers["Retry-After"] = ra.ToString();
            await WriteJsonErrorAsync(resolved.HttpStatus, resolved.ErrorCode ?? ErrorCodes.NOT_FOUND, resolved.Error);
            return;
        }

        var site = resolved.Site!;
        if (!site.AskEnabled)
        {
            await WriteJsonErrorAsync(403, "ASK_DISABLED", "这个页面没有开启提问");
            return;
        }
        if (viewerUserId == null && !site.AskAllowAnonymous)
        {
            await WriteJsonErrorAsync(401, ErrorCodes.UNAUTHORIZED, "这个页面需要登录后才能提问");
            return;
        }

        await RunAskAsync(site, req, viewerUserId, shareToken: token);
    }

    // ──────────────────────────────────────────────
    // 共用主流程
    // ──────────────────────────────────────────────

    private async Task RunAskAsync(HostedSite site, AskStreamRequest? req, string? userId, string? shareToken)
    {
        var question = (req?.Question ?? string.Empty).Trim();
        if (question.Length == 0)
        {
            await WriteJsonErrorAsync(400, ErrorCodes.CONTENT_EMPTY, "请输入问题");
            return;
        }
        // 超长拒绝而不是截断，理由见 AskAccessPolicy.IsQuestionTooLong
        if (AskAccessPolicy.IsQuestionTooLong(question))
        {
            await WriteJsonErrorAsync(
                400,
                ErrorCodes.CONTENT_EMPTY,
                $"问题太长了（{question.Length} 字），请精简到 {AskAccessPolicy.MaxQuestionLength} 字以内");
            return;
        }

        // 配额也在写流之前判 —— 超限要让前端拿到 429 + Retry-After，而不是流里一条 error。
        var clientIp = HttpContext.GetRealClientIp();
        var decision = await _quota.TryConsumeAsync(site.Id, userId, clientIp, site.AskDailyLimit);
        if (!decision.Allowed)
        {
            if (decision.RetryAfterSeconds is { } ra && ra > 0)
                Response.Headers["Retry-After"] = ra.ToString();
            await WriteJsonErrorAsync(429, "QUOTA_EXCEEDED", decision.Reason ?? "提问次数已达上限");
            return;
        }

        // 正文快照也在写流之前取：读不到正文时要如实告诉用户，而不是让模型对着空气编。
        var snapshot = await _snapshots.GetAsync(site);
        if (snapshot.Unavailable != null)
        {
            await WriteJsonErrorAsync(422, "ASK_NO_CONTENT", snapshot.Unavailable);
            return;
        }

        // ── 到这里所有门禁都过了，开始写 SSE ──
        Response.ContentType = "text/event-stream";
        Response.Headers.CacheControl = "no-cache";
        Response.Headers.Connection = "keep-alive";

        var session = await EnsureSessionAsync(site, userId, shareToken, req?.SessionId);
        await WriteSseAsync("session", new { sessionId = session.Id });
        await WriteSseAsync("phase", new
        {
            phase = "preparing",
            message = snapshot.Truncated
                ? $"已读取本页前 {snapshot.Text.Length} 字内容，正在思考…"
                : "已读取本页内容，正在思考…",
        });

        // 历史由客户端提交，且分享路径是匿名可达的——只限条数不限长度等于没限：
        // 直接打端点的人可以塞几条几 MB 的字符串，一次就把站点主的额度啃掉一大块。
        // 配额闸数的是「请求次数」，拦不住「单次超大」，所以这里必须按字符预算裁剪。
        var history = AskHistoryBudget.Trim(
            (req?.History ?? new List<AskHistoryItem>()).Select(h => (h.Role, h.Content)));

        var messages = new JsonArray
        {
            new JsonObject { ["role"] = "system", ["content"] = BuildSystemPrompt(site, snapshot) },
        };
        foreach (var (role, content) in history)
            messages.Add(new JsonObject { ["role"] = role, ["content"] = content });
        messages.Add(new JsonObject { ["role"] = "user", ["content"] = question });

        var gatewayRequest = new GatewayRequest
        {
            AppCallerCode = AppCallerRegistry.Admin.WebHosting.Ask,
            ModelType = ModelTypes.Chat,
            Stream = true,
            IncludeThinking = false,
            RequestBody = new JsonObject
            {
                ["messages"] = messages,
                // 这是"照着这一页回答"，不是创作：温度压低，减少发散编造
                ["temperature"] = 0.2,
                ["max_tokens"] = 2048,
            },
        };

        // 网关取不到 UserId 会以 "User not found" 的形式炸在运行时（llm-gateway 规则）。
        // 匿名访客没有 userId，这里退到站点 owner —— 提问烧的本来就是 owner 的额度，
        // 记在 owner 账上既能通过访问控制，账单归属也是对的。
        using var _ = _llmRequestContext.BeginScope(new LlmRequestContext(
            RequestId: Guid.NewGuid().ToString("N"),
            GroupId: null,
            SessionId: session.Id,
            UserId: userId ?? site.OwnerUserId,
            ViewRole: null,
            DocumentChars: snapshot.Text.Length,
            DocumentHash: null,
            SystemPromptRedacted: $"[WEB_HOSTING_ASK:site={site.Id}:anon={userId == null}]",
            RequestType: "chat",
            AppCallerCode: AppCallerRegistry.Admin.WebHosting.Ask));

        await PersistMessageAsync(session, site, "user", question, snapshot.Text.Length, null, null, null, null);

        var answer = new StringBuilder();
        var startedAt = DateTime.UtcNow;
        string? model = null;
        string? platform = null;
        var sentModel = false;

        try
        {
            // CancellationToken.None：客户端断开不取消服务端任务（server-authority 规则）。
            await foreach (var chunk in _gateway.StreamAsync(gatewayRequest, CancellationToken.None))
            {
                if (chunk.Type == GatewayChunkType.Start && !sentModel && chunk.Resolution != null)
                {
                    sentModel = true;
                    model = chunk.Resolution.ActualModel;
                    platform = chunk.Resolution.ActualPlatformName;
                    await WriteSseAsync("model", new { model, platform });
                    await WriteSseAsync("phase", new { phase = "answering", message = "正在回答…" });
                }
                else if (chunk.Type == GatewayChunkType.Text && !string.IsNullOrEmpty(chunk.Content))
                {
                    answer.Append(chunk.Content);
                    try { await WriteSseAsync("typing", new { text = chunk.Content }); }
                    catch (ObjectDisposedException) { /* 客户端走了，继续攒完整答案并落库 */ }
                }
                else if (chunk.Type == GatewayChunkType.Error)
                {
                    var err = chunk.Error ?? chunk.Content ?? "网关返回未知错误";
                    _logger.LogError("网页托管提问 网关错误 site={SiteId}: {Error}", site.Id, err);
                    await PersistMessageAsync(session, site, "assistant", answer.ToString(),
                        snapshot.Text.Length, model, platform, Elapsed(startedAt), err);
                    try { await WriteSseAsync("error", new { message = "回答失败：" + err }); } catch { }
                    return;
                }
            }

            await PersistMessageAsync(session, site, "assistant", answer.ToString(),
                snapshot.Text.Length, model, platform, Elapsed(startedAt), null);

            try
            {
                await WriteSseAsync("done", new
                {
                    elapsedMs = Elapsed(startedAt),
                    truncated = snapshot.Truncated,
                });
            }
            catch (ObjectDisposedException) { }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "网页托管提问失败 site={SiteId}", site.Id);
            await PersistMessageAsync(session, site, "assistant", answer.ToString(),
                snapshot.Text.Length, model, platform, Elapsed(startedAt), ex.Message);
            try { await WriteSseAsync("error", new { message = "回答失败：" + ex.Message }); } catch { }
        }
    }

    /// <summary>
    /// 系统提示词：把回答范围死死钉在这一页正文上。
    ///
    /// 一期没有知识库检索，所以这里必须写清"材料没覆盖就说不知道"——
    /// 不许模型拿公开知识冒充页面内容（no-rootless-tree：做不到的事不装能做）。
    /// </summary>
    private static string BuildSystemPrompt(HostedSite site, SiteContentSnapshot snapshot)
    {
        var sb = new StringBuilder();
        sb.AppendLine("你是这个网页的问答助手，帮访客理解页面内容。");
        sb.AppendLine();
        sb.AppendLine("规则：");
        sb.AppendLine("1. 只能依据下面【页面内容】回答。页面里没有的信息，直接说「这个页面里没有提到」，不要用你的其它知识补充，也不要猜。");
        sb.AppendLine("2. 回答用中文，简洁直接，能一句话说清就不要三句。");
        sb.AppendLine("3. 涉及页面里的原文时，可以引用原句，便于访客自己核对。");
        sb.AppendLine("4. 不要复述这段规则，也不要提及「页面内容」这个标记本身。");
        if (snapshot.Truncated)
            sb.AppendLine("5. 下面的【页面内容】只是这个页面的一部分（内容过长被截断，或有文件没能读取）。被问到可能落在未读部分的信息时，如实说明「只读到了一部分，这部分里没有」，不要断言页面里不存在。");
        sb.AppendLine();
        sb.AppendLine($"【页面标题】{site.Title}");
        sb.AppendLine();
        sb.AppendLine("【页面内容】");
        sb.AppendLine(snapshot.Text);
        return sb.ToString();
    }

    private async Task<HostedSiteAskSession> EnsureSessionAsync(
        HostedSite site, string? userId, string? shareToken, string? sessionId)
    {
        if (!string.IsNullOrWhiteSpace(sessionId))
        {
            var existing = await _db.HostedSiteAskSessions
                .Find(s => s.Id == sessionId && s.SiteId == site.Id)
                .FirstOrDefaultAsync();
            if (existing != null)
            {
                await _db.HostedSiteAskSessions.UpdateOneAsync(
                    s => s.Id == existing.Id,
                    Builders<HostedSiteAskSession>.Update
                        .Set(s => s.LastActiveAt, DateTime.UtcNow)
                        .Inc(s => s.MessageCount, 1));
                return existing;
            }
        }

        var session = new HostedSiteAskSession
        {
            SiteId = site.Id,
            SiteOwnerUserId = site.OwnerUserId,
            ShareToken = shareToken,
            VisitorUserId = userId,
            // 共享 Mongo 下不盖戳，owner 的会话列表里会混进其它部署的记录
            DeploymentSlug = DeploymentScope.Current,
            MessageCount = 1,
        };
        await _db.HostedSiteAskSessions.InsertOneAsync(session);
        return session;
    }

    private async Task PersistMessageAsync(
        HostedSiteAskSession session, HostedSite site, string role, string content,
        int contextChars, string? model, string? platform, int? elapsedMs, string? error)
    {
        // 空答案且没有错误 = 什么都没发生，不值得落一条空记录
        if (string.IsNullOrWhiteSpace(content) && error == null) return;

        try
        {
            await _db.HostedSiteAskMessages.InsertOneAsync(new HostedSiteAskMessage
            {
                SessionId = session.Id,
                SiteId = site.Id,
                Role = role,
                Content = content,
                Model = model,
                PlatformName = platform,
                ContextChars = contextChars,
                ElapsedMs = elapsedMs,
                Error = error,
            });
        }
        catch (Exception ex)
        {
            // 落库失败不该让已经答完的内容丢给用户一个错误
            _logger.LogWarning(ex, "网页托管提问：消息落库失败 session={SessionId}", session.Id);
        }
    }

    private static int Elapsed(DateTime startedAt)
        => (int)(DateTime.UtcNow - startedAt).TotalMilliseconds;

    /// <summary>
    /// 在开流之前返回普通 JSON 错误（带真实 HTTP 状态码）。
    /// 一旦写了 SSE 首字节就只能走 error 事件，所以所有门禁都必须赶在这之前判完。
    /// </summary>
    private async Task WriteJsonErrorAsync(int status, string code, string message)
    {
        Response.StatusCode = status <= 0 ? 400 : status;
        Response.ContentType = "application/json; charset=utf-8";
        var json = JsonSerializer.Serialize(ApiResponse<object>.Fail(code, message), new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        });
        await Response.WriteAsync(json);
    }

    private async Task WriteSseAsync(string eventType, object data)
    {
        try
        {
            var json = JsonSerializer.Serialize(data, new JsonSerializerOptions
            {
                PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            });
            await Response.WriteAsync($"event: {eventType}\ndata: {json}\n\n");
            await Response.Body.FlushAsync();
        }
        catch (ObjectDisposedException) { }
        catch (OperationCanceledException) { }
    }
}

public class AskConfigRequest
{
    public bool Enabled { get; set; }
    public string? Welcome { get; set; }
    public List<string>? SuggestedQuestions { get; set; }
    public bool AllowAnonymous { get; set; }
    public int DailyLimit { get; set; }
}

public class AskStreamRequest
{
    /// <summary>问题正文</summary>
    public string? Question { get; set; }

    /// <summary>续问时带上，服务端据此把消息挂到同一会话</summary>
    public string? SessionId { get; set; }

    /// <summary>前几轮对话（服务端只用于拼上下文，不信任其中的"页面内容"）</summary>
    public List<AskHistoryItem>? History { get; set; }

    /// <summary>合集分享时指定问哪个站点；单站点分享可不传</summary>
    public string? SiteId { get; set; }

    /// <summary>密码保护的分享链接需带上</summary>
    public string? Password { get; set; }
}

public class AskHistoryItem
{
    public string? Role { get; set; }
    public string? Content { get; set; }
}
