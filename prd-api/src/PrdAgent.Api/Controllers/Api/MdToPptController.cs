using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// MD 转网页 PPT。
///
/// SSE 事件协议（两条路径共用）：
///   event: start  — 会话开始
///   event: model  — data: {"model":"...","platform":"..."}  模型信息
///   event: diag   — data: {...}  诊断事件（agent 路径专有）
///   event: delta  — data: {"text":"..."}  增量 HTML 片段
///   event: done   — data: {"html":"..."}  完整 HTML
///   event: error  — data: {"message":"..."}
///
/// 生成引擎：
///   engine=map    — MAP 直调（ILlmGateway.StreamAsync，快速可靠）
///   engine=agent  — CDS Agent（可观测工具调用路径，toolPolicy=deny-all 避免工具循环）
/// </summary>
[ApiController]
[Route("api/md-to-ppt")]
[Authorize]
public class MdToPptController : ControllerBase
{
    private readonly IInfraAgentSessionService _sessions;
    private readonly MongoDbContext _db;
    private readonly ILlmGateway _gateway;
    private readonly ILLMRequestContextAccessor _llmRequestContext;
    private readonly ILogger<MdToPptController> _logger;

    // PPT 系统提示词（两条路径共用），强调直接输出 HTML，禁止工具调用
    private const string PptSystemPrompt =
        "你是顶级演示设计师，作品对标 Apple Keynote / Stripe / Linear / Vercel 的发布会幻灯。" +
        "唯一任务：直接输出一个完整、惊艳、可直接演示的 reveal.js HTML 文件。禁止调用任何工具或执行命令，禁止输出任何解释或代码块标记。\n\n" +
        "## 硬技术规范\n" +
        "- reveal.js 4.x CDN：https://cdn.jsdelivr.net/npm/reveal.js@4/dist/reveal.js + reveal.css（不引官方主题，用下面的自定义主题）\n" +
        "- 初始化：Reveal.initialize({ hash:false, transition:'slide', slideNumber:'c/t', controls:true, progress:true, center:true, margin:0.06 })（不要写 width/height，让它自适应容器）\n" +
        "- 全部 CSS 内联在 <head> 的 <style> 里；输出完整 <!DOCTYPE html>…</html>；不要 markdown 代码围栏\n" +
        "- 绝对禁止任何 emoji 字符（一切表情/符号图标都不许，包括大脑/尺子/键盘/循环箭头/程序员等图标 emoji）；需要图标时只用 inline SVG 或 CSS 几何图形\n" +
        "- 绝对禁止对标题/正文用 `color:transparent` + `background-clip:text`（嵌入式渲染常常不生效，会导致文字整页消失）；标题一律实色 #eef2ff，渐变只能用在 .orb/.bar 等非文字装饰上\n\n" +
        "## 设计系统（必须照此实现，这是质量下限不是参考）\n" +
        "把下面这套 CSS 设计 token 与组件类落进 <style>，并在每页真正用上：\n" +
        "```\n" +
        ":root{--bg:#070b18;--bg2:#0f1530;--ink:#f6f8ff;--muted:#9aa6c4;--line:rgba(255,255,255,.09);\n" +
        "--card:rgba(255,255,255,.045);--a1:#6366f1;--a2:#22d3ee;--a3:#a855f7;--a4:#f472b6;}\n" +
        "html,body,.reveal{background:radial-gradient(1200px 800px at 80% -10%,#1b2350 0%,var(--bg) 55%);}\n" +
        ".reveal{font-family:'Inter',-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',system-ui,sans-serif;color:var(--ink);}\n" +
        ".reveal .slides section{text-align:left;padding:2vh 5vw;}\n" +
        ".eyebrow{text-transform:uppercase;letter-spacing:.24em;font-size:.78rem;font-weight:800;color:var(--a2);margin-bottom:18px;}\n" +
        ".title-xl{font-size:clamp(44px,6.6vw,86px);font-weight:850;line-height:1.06;letter-spacing:-.025em;margin:0;color:#eef2ff;}\n" +
        ".title-md{font-size:clamp(30px,4vw,52px);font-weight:800;line-height:1.1;letter-spacing:-.02em;margin:0 0 6px;color:#f6f8ff;}\n" +
        ".lead{font-size:clamp(17px,1.6vw,22px);color:var(--muted);max-width:46ch;line-height:1.5;}\n" +
        ".grid{display:grid;gap:22px;margin-top:34px;}.g2{grid-template-columns:1fr 1fr;}.g3{grid-template-columns:repeat(3,1fr);}\n" +
        ".card{background:var(--card);border:1px solid var(--line);border-radius:20px;padding:26px 28px;backdrop-filter:blur(10px);}\n" +
        ".card h3{margin:0 0 8px;font-size:1.15rem;font-weight:800;color:#f6f8ff;}.card p{margin:0;color:var(--muted);font-size:.98rem;line-height:1.5;}\n" +
        ".stat{font-size:clamp(40px,5.5vw,72px);font-weight:850;letter-spacing:-.02em;color:#a5b4fc;}\n" +
        ".stat-l{color:var(--muted);font-size:.95rem;margin-top:4px;}\n" +
        ".chip{display:inline-flex;align-items:center;gap:8px;padding:7px 14px;border:1px solid var(--line);border-radius:999px;font-size:.85rem;color:var(--ink);background:rgba(255,255,255,.03);}\n" +
        ".bar{width:54px;height:5px;border-radius:9px;background:linear-gradient(90deg,var(--a1),var(--a2));margin:20px 0;}\n" +
        ".quote{font-size:clamp(26px,3.2vw,42px);font-weight:700;line-height:1.3;border-left:4px solid var(--a3);padding-left:28px;}\n" +
        ".orb{position:absolute;border-radius:50%;filter:blur(80px);opacity:.55;z-index:0;}.orb.a{width:420px;height:420px;background:var(--a1);right:-80px;top:-90px;}.orb.b{width:340px;height:340px;background:var(--a3);left:-70px;bottom:-90px;}\n" +
        ".reveal .slides section>*{position:relative;z-index:1;}\n" +
        ".reveal .slide-number{background:transparent;color:var(--muted);}\n" +
        "li{margin:10px 0;line-height:1.5;}ul{list-style:none;padding:0;}ul li{padding-left:26px;position:relative;}ul li::before{content:'';position:absolute;left:0;top:.6em;width:8px;height:8px;border-radius:3px;background:linear-gradient(120deg,var(--a1),var(--a2));}\n" +
        "```\n\n" +
        "## 每页强制结构（杜绝『一行居中标题』的空洞页）\n" +
        "除封面/结语外，每一页都必须包含：① 一个 .eyebrow 小标签（章节/类别）→ ② 一个 .title-md 标题 → ③ 结构化正文（卡片网格 / 数据 / 对比 / 列表，至少一种）→ ④ 至少一个视觉装置（.orb 光晕、.bar 强调条、卡片、或大号 .stat）。绝不允许出现只有一句话居中、四周大片空白的页。\n\n" +
        "## 版式库（按内容选用，全篇至少混用 4 种，禁止每页雷同）\n" +
        "1. 封面：.orb 光晕背景 + .eyebrow + 超大 .title-xl 渐变标题 + .lead 副标题 + 底部 .chip 行（作者/日期/标签）\n" +
        "2. 要点卡片：.grid.g3 或 .g2，每个 .card 一个要点（标题 + 说明），不要写成裸列表\n" +
        "3. 数据看板：.grid.g3，每格 .stat 大数字 + .stat-l 说明，凸显关键指标\n" +
        "4. 两栏对比：.grid.g2，左『现状/问题』右『方案/结果』，各用一张 .card\n" +
        "5. 金句/转场：.quote 大字引用 + 左侧 .a3 强调条 + .orb 背景\n" +
        "6. 流程/时间线：横向或纵向步骤，每步一个序号圆 + 标题 + 说明\n" +
        "7. 结语：居中 .title-xl + 一句行动号召 + .chip 联系方式\n\n" +
        "## 质量自检（输出前自问）\n" +
        "- 随手翻到任意一页，是否都『信息充实 + 有设计感』，不是空洞标题页？\n" +
        "- 是否真的用了渐变标题、卡片、光晕、强调条这些装置，而不是纯文字？\n" +
        "- 配色克制（深底 + 1-2 个霓虹强调色），留白舒展，层级分明，像一线大厂发布会？\n" +
        "- 至少 6 页，逻辑连贯，版式不重复？\n\n" +
        "## 输出要求（最高优先级）\n" +
        "- 仅输出完整 HTML 文件内容，第一个字符是 <，最后是 >，中间不得有任何解释、标注或 ``` 代码块标记\n" +
        "- 禁止使用工具调用，禁止执行命令，直接以纯文本形式输出 HTML";


    public MdToPptController(
        IInfraAgentSessionService sessions,
        MongoDbContext db,
        ILlmGateway gateway,
        ILLMRequestContextAccessor llmRequestContext,
        ILogger<MdToPptController> logger)
    {
        _sessions = sessions;
        _db = db;
        _gateway = gateway;
        _llmRequestContext = llmRequestContext;
        _logger = logger;
    }

    // ─────────────────────────────────────────────
    // POST /api/md-to-ppt/convert
    // ─────────────────────────────────────────────

    /// <summary>将 Markdown 转换为 reveal.js HTML PPT（SSE 流式返回）</summary>
    [HttpPost("convert")]
    public async Task Convert([FromBody] MdToPptConvertRequest req)
    {
        var userId = this.GetRequiredUserId();
        SetSseHeaders();
        await WriteSsePreambleAsync();
        await WriteEventAsync("start", null);

        var styleHint = $"目标页数约 {req.SlideCount ?? 8} 页；主题风格：{(string.IsNullOrWhiteSpace(req.Theme) ? "深色现代" : req.Theme)}。";
        var userContent = $"{styleHint}\n\n---\n\n# 用户内容\n\n{req.Content?.Trim()}";

        var engine = (req.Engine ?? "map").Trim().ToLowerInvariant();
        if (engine == "agent")
            await RunAgentStreamAsync(userId, userContent, "PPT");
        else
            await RunMapStreamAsync(userId, PptSystemPrompt, userContent, AppCallerRegistry.MdToPptAgent.Generation.HtmlGenerate, "convert");
    }

    // ─────────────────────────────────────────────
    // POST /api/md-to-ppt/patch
    // ─────────────────────────────────────────────

    /// <summary>根据用户指令修改已有 HTML PPT（SSE 流式返回）</summary>
    [HttpPost("patch")]
    public async Task Patch([FromBody] MdToPptPatchRequest req)
    {
        var userId = this.GetRequiredUserId();
        SetSseHeaders();
        await WriteSsePreambleAsync();
        await WriteEventAsync("start", null);

        var userContent = $"---\n\n# 已有 HTML\n\n```html\n{req.CurrentHtml?.Trim()}\n```\n\n# 修改要求（第 {(req.SlideIndex.HasValue ? req.SlideIndex.Value + 1 : 0)} 页）\n\n{req.SlideRequest?.Trim()}";

        var engine = (req.Engine ?? "map").Trim().ToLowerInvariant();
        if (engine == "agent")
            await RunAgentStreamAsync(userId, userContent, "PPT 修改");
        else
            await RunMapStreamAsync(userId, PptSystemPrompt, userContent, AppCallerRegistry.MdToPptAgent.Generation.Patch, "patch");
    }

    // ─────────────────────────────────────────────
    // POST /api/md-to-ppt/publish
    // ─────────────────────────────────────────────

    /// <summary>将生成的 HTML 发布为托管网页</summary>
    [HttpPost("publish")]
    public async Task<IActionResult> Publish([FromBody] MdToPptPublishRequest req)
    {
        var userId = this.GetRequiredUserId();

        if (string.IsNullOrWhiteSpace(req.HtmlContent))
            return BadRequest(new { error = "HTML 内容不能为空" });

        var title = string.IsNullOrWhiteSpace(req.Title) ? "PPT 幻灯片" : req.Title.Trim();
        var htmlBytes = Encoding.UTF8.GetBytes(req.HtmlContent);

        var siteService = HttpContext.RequestServices.GetRequiredService<IHostedSiteService>();
        var site = await siteService.CreateFromHtmlAsync(
            userId,
            htmlBytes,
            "index.html",
            title,
            string.IsNullOrWhiteSpace(req.Description) ? null : req.Description.Trim(),
            null,
            req.Tags?.Where(t => !string.IsNullOrWhiteSpace(t)).ToList(),
            CancellationToken.None);

        if (req.TeamIds is { Count: > 0 })
        {
            await siteService.SetSharedTeamsAsync(site.Id, userId, req.TeamIds, CancellationToken.None);
        }

        return Ok(new
        {
            siteId = site.Id,
            title = site.Title,
            siteUrl = site.SiteUrl,
        });
    }

    // ─────────────────────────────────────────────
    // MAP 直调路径（快速可靠）
    // ─────────────────────────────────────────────

    private async Task RunMapStreamAsync(
        string userId,
        string systemPrompt,
        string userContent,
        string appCallerCode,
        string opLabel)
    {
        var startedAt = DateTime.UtcNow;
        _logger.LogInformation(
            "[MdToPpt-MAP] userId={UserId} op={Op} appCaller={AppCaller} started",
            userId, opLabel, appCallerCode);

        using var _ = _llmRequestContext.BeginScope(new LlmRequestContext(
            RequestId: Guid.NewGuid().ToString("N"),
            GroupId: null,
            SessionId: null,
            UserId: userId,
            ViewRole: null,
            DocumentChars: userContent.Length,
            DocumentHash: null,
            SystemPromptRedacted: "[MdToPpt]",
            RequestType: "chat",
            AppCallerCode: appCallerCode));

        var gatewayRequest = new GatewayRequest
        {
            AppCallerCode = appCallerCode,
            ModelType = ModelTypes.Chat,
            Stream = true,
            TimeoutSeconds = 180,
            RequestBody = new JsonObject
            {
                ["messages"] = new JsonArray
                {
                    new JsonObject { ["role"] = "system", ["content"] = systemPrompt },
                    new JsonObject { ["role"] = "user",   ["content"] = userContent },
                },
                ["temperature"] = 0.4,
                ["max_tokens"] = 16384,
            },
        };

        var fullText = new StringBuilder();
        var sentModel = false;

        try
        {
            await foreach (var chunk in _gateway.StreamAsync(gatewayRequest, CancellationToken.None))
            {
                if (chunk.Type == GatewayChunkType.Start && !sentModel && chunk.Resolution != null)
                {
                    sentModel = true;
                    var elapsedMs = (int)(DateTime.UtcNow - startedAt).TotalMilliseconds;
                    _logger.LogInformation(
                        "[MdToPpt-MAP] model resolved elapsedMs={Elapsed} model={Model} platform={Platform}",
                        elapsedMs, chunk.Resolution.ActualModel, chunk.Resolution.ActualPlatformName);
                    try
                    {
                        await WriteEventAsync("model", new
                        {
                            model = chunk.Resolution.ActualModel,
                            platform = chunk.Resolution.ActualPlatformName,
                        });
                    }
                    catch (ObjectDisposedException) { return; }
                }
                else if (chunk.Type == GatewayChunkType.Text && !string.IsNullOrEmpty(chunk.Content))
                {
                    fullText.Append(chunk.Content);
                    try { await WriteEventAsync("delta", new { text = chunk.Content }); }
                    catch (ObjectDisposedException) { return; }
                }
                else if (chunk.Type == GatewayChunkType.Error)
                {
                    var err = chunk.Error ?? chunk.Content ?? "LLM 网关返回未知错误";
                    _logger.LogError("[MdToPpt-MAP] gateway error userId={UserId}: {Error}", userId, err);
                    try { await WriteEventAsync("error", new { message = err }); } catch { }
                    return;
                }
            }

            var html = StripCodeFences(fullText.ToString());
            var totalMs = (int)(DateTime.UtcNow - startedAt).TotalMilliseconds;
            _logger.LogInformation(
                "[MdToPpt-MAP] done userId={UserId} totalMs={TotalMs} htmlLen={HtmlLen}",
                userId, totalMs, html.Length);
            try { await WriteEventAsync("done", new { html }); }
            catch (ObjectDisposedException) { }
        }
        catch (OperationCanceledException) { }
        catch (ObjectDisposedException) { }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[MdToPpt-MAP] unexpected error userId={UserId}", userId);
            try { await WriteEventAsync("error", new { message = ex.Message }); } catch { }
        }
    }

    // ─────────────────────────────────────────────
    // CDS Agent 路径（可观测，诊断插桩）
    // ─────────────────────────────────────────────

    private async Task RunAgentStreamAsync(string userId, string userPrompt, string title)
    {
        var overallStart = DateTime.UtcNow;
        InfraConnection? connection = null;
        InfraAgentRuntimeProfile? runtimeProfile = null;
        InfraAgentSessionView? session = null;

        // 诊断计数器
        var totalEvents = 0;
        var textDeltaCount = 0;
        var toolCallCount = 0;
        var toolResultCount = 0;
        var statusCount = 0;
        var logCount = 0;
        var errorCount = 0;

        try
        {
            // 1. 解析 CDS 连接
            var t0 = DateTime.UtcNow;
            connection = await ResolveCdsConnectionAsync(CancellationToken.None);
            if (connection == null)
            {
                await WriteEventAsync("error", new { message = "没有可用的 active CDS 连接，请先完成系统级 CDS 授权" });
                return;
            }
            var connMs = (int)(DateTime.UtcNow - t0).TotalMilliseconds;
            _logger.LogInformation("[MdToPpt-Agent] connection resolved elapsedMs={Ms}", connMs);
            await WriteDiagAsync(new { stage = "connection", elapsedMs = connMs, connectionId = connection.Id });

            // 2. 解析运行配置
            var t1 = DateTime.UtcNow;
            runtimeProfile = await ResolveRuntimeProfileAsync(userId, CancellationToken.None);
            if (runtimeProfile == null)
            {
                await WriteEventAsync("error", new { message = "没有可用的模型运行配置，请先配置 baseUrl、model 和 API key" });
                return;
            }
            var profileMs = (int)(DateTime.UtcNow - t1).TotalMilliseconds;
            _logger.LogInformation("[MdToPpt-Agent] profile resolved elapsedMs={Ms} runtime={Runtime} model={Model}",
                profileMs, runtimeProfile.Runtime, runtimeProfile.Model);
            await WriteDiagAsync(new { stage = "profile", elapsedMs = profileMs, runtime = runtimeProfile.Runtime, model = runtimeProfile.Model });

            var runtime = runtimeProfile.Runtime;
            var model = runtimeProfile.Model;

            // 3. 创建会话 — toolPolicy=deny-all 禁止暴露任何工具，避免 agent 进入工具循环
            var t2 = DateTime.UtcNow;
            session = await _sessions.CreateAsync(userId,
                new CreateInfraAgentSessionRequest(
                    connection.Id,
                    runtime,
                    model,
                    title,
                    InfraAgentToolPolicies.DenyAll,   // 核心修复：不暴露任何工具
                    null,
                    runtimeProfile.Id,
                    null,
                    null,
                    null,
                    null),
                CancellationToken.None);
            var createMs = (int)(DateTime.UtcNow - t2).TotalMilliseconds;
            _logger.LogInformation("[MdToPpt-Agent] session created elapsedMs={Ms} sessionId={Id} toolPolicy={Policy}",
                createMs, session.Id, InfraAgentToolPolicies.DenyAll);
            await WriteDiagAsync(new { stage = "create", elapsedMs = createMs, sessionId = session.Id, toolPolicy = InfraAgentToolPolicies.DenyAll });

            // 4. 启动会话
            var t3 = DateTime.UtcNow;
            if (!string.Equals(session.Status, "running", StringComparison.OrdinalIgnoreCase))
            {
                session = await _sessions.StartAsync(userId, session.Id,
                    new StartInfraAgentSessionRequest(runtime, model),
                    CancellationToken.None) ?? session;
            }
            var startMs = (int)(DateTime.UtcNow - t3).TotalMilliseconds;
            _logger.LogInformation("[MdToPpt-Agent] session started elapsedMs={Ms} status={Status}", startMs, session.Status);
            await WriteDiagAsync(new { stage = "start", elapsedMs = startMs, status = session.Status });

            // 5. 发送消息（系统提示词 + 用户内容合并）
            var fullPrompt = $"{PptSystemPrompt}\n\n---\n\n{userPrompt}";
            var t4 = DateTime.UtcNow;
            session = await _sessions.SendMessageAsync(userId, session.Id,
                new SendInfraAgentMessageRequest(fullPrompt),
                CancellationToken.None) ?? session;
            var sendMs = (int)(DateTime.UtcNow - t4).TotalMilliseconds;
            _logger.LogInformation("[MdToPpt-Agent] message sent elapsedMs={Ms}", sendMs);
            await WriteDiagAsync(new { stage = "send", elapsedMs = sendMs });

            // 6. 轮询事件，流式推送 delta
            var afterSeq = 0L;
            var fullText = new StringBuilder();
            string? finalHtml = null;
            const int maxPollingRounds = 600; // 最多 ~8 分钟 (600 * 800ms)
            var firstEventAt = (DateTime?)null;
            var firstTextDeltaAt = (DateTime?)null;

            for (var round = 0; round < maxPollingRounds; round++)
            {
                var batch = await _sessions.ListEventsAsync(userId, session.Id, afterSeq, 50, CancellationToken.None);

                var newEventsThisRound = 0;
                var toolCallsThisRound = 0;
                var textDeltasThisRound = 0;
                var gotDone = false;
                string? errorMessage = null;

                foreach (var evt in batch.OrderBy(x => x.Seq))
                {
                    if (evt.Seq <= afterSeq) continue;
                    afterSeq = evt.Seq;
                    totalEvents++;
                    newEventsThisRound++;

                    if (firstEventAt == null)
                    {
                        firstEventAt = DateTime.UtcNow;
                        var firstMs = (int)(firstEventAt.Value - overallStart).TotalMilliseconds;
                        _logger.LogInformation("[MdToPpt-Agent] first event arrived elapsedMs={Ms} type={Type}", firstMs, evt.Type);
                        await WriteDiagAsync(new { stage = "first_event", elapsedMs = firstMs, eventType = evt.Type });
                    }

                    try
                    {
                        using var doc = JsonDocument.Parse(evt.PayloadJson ?? "{}");
                        var root = doc.RootElement;

                        switch (evt.Type)
                        {
                            case InfraAgentEventTypes.TextDelta:
                                textDeltaCount++;
                                textDeltasThisRound++;
                                if (firstTextDeltaAt == null)
                                {
                                    firstTextDeltaAt = DateTime.UtcNow;
                                    var tdMs = (int)(firstTextDeltaAt.Value - overallStart).TotalMilliseconds;
                                    _logger.LogInformation("[MdToPpt-Agent] FIRST text_delta elapsedMs={Ms}", tdMs);
                                    await WriteDiagAsync(new { stage = "first_text_delta", elapsedMs = tdMs });
                                }
                                if (root.TryGetProperty("text", out var textProp))
                                {
                                    var fragment = textProp.GetString() ?? "";
                                    if (!string.IsNullOrEmpty(fragment))
                                    {
                                        fullText.Append(fragment);
                                        await WriteEventAsync("delta", new { text = fragment });
                                    }
                                }
                                break;

                            case InfraAgentEventTypes.ToolCall:
                                toolCallCount++;
                                toolCallsThisRound++;
                                var toolName = root.TryGetProperty("toolName", out var tn) ? tn.GetString() : "?";
                                _logger.LogWarning(
                                    "[MdToPpt-Agent] TOOL_CALL detected tool={Tool} totalToolCalls={Count} textDeltasSoFar={Text}",
                                    toolName, toolCallCount, textDeltaCount);
                                await WriteDiagAsync(new
                                {
                                    stage = "tool_call",
                                    tool = toolName,
                                    totalToolCalls = toolCallCount,
                                    textDeltasSoFar = textDeltaCount,
                                    warning = "agent 正在调用工具而非直接输出 HTML",
                                });
                                break;

                            case InfraAgentEventTypes.ToolResult:
                                toolResultCount++;
                                break;

                            case InfraAgentEventTypes.Status:
                                statusCount++;
                                break;

                            case InfraAgentEventTypes.Log:
                                logCount++;
                                break;

                            case InfraAgentEventTypes.Done:
                                if (root.TryGetProperty("finalText", out var finalProp))
                                {
                                    var rawFinal = finalProp.GetString() ?? "";
                                    finalHtml = !string.IsNullOrEmpty(rawFinal) && rawFinal != fullText.ToString()
                                        ? StripCodeFences(rawFinal)
                                        : StripCodeFences(fullText.ToString());
                                }
                                else
                                {
                                    finalHtml = StripCodeFences(fullText.ToString());
                                }
                                gotDone = true;
                                break;

                            case InfraAgentEventTypes.Error:
                                errorCount++;
                                if (root.TryGetProperty("message", out var msgProp))
                                    errorMessage = msgProp.GetString() ?? "CDS Agent 发生错误";
                                break;
                        }
                    }
                    catch
                    {
                        // 解析单个事件失败不终止流
                    }

                    if (gotDone || errorMessage != null)
                        break;
                }

                // 每轮新事件时打印诊断
                if (newEventsThisRound > 0)
                {
                    var roundElapsed = (int)(DateTime.UtcNow - overallStart).TotalMilliseconds;
                    _logger.LogInformation(
                        "[MdToPpt-Agent] round={Round} newEvents={New} textDeltas={TD} toolCalls={TC} total={Total} elapsedMs={Ms}",
                        round, newEventsThisRound, textDeltasThisRound, toolCallsThisRound, totalEvents, roundElapsed);

                    // 工具循环警报
                    if (toolCallCount > 3 && textDeltaCount == 0)
                    {
                        var loopMs = (int)(DateTime.UtcNow - overallStart).TotalMilliseconds;
                        _logger.LogError(
                            "[MdToPpt-Agent] AGENT TOOL-LOOPING, no text output toolCalls={TC} elapsedMs={Ms}",
                            toolCallCount, loopMs);
                        await WriteDiagAsync(new
                        {
                            stage = "tool_loop_alarm",
                            toolCalls = toolCallCount,
                            textDeltas = textDeltaCount,
                            elapsedMs = loopMs,
                            message = "AGENT TOOL-LOOPING: agent 反复调用工具但没有输出任何 HTML 文本，疑似工具循环",
                        });
                    }
                }

                if (errorMessage != null)
                {
                    await WriteEventAsync("error", new { message = errorMessage });
                    return;
                }

                if (gotDone)
                {
                    var html = finalHtml ?? StripCodeFences(fullText.ToString());
                    var doneMs = (int)(DateTime.UtcNow - overallStart).TotalMilliseconds;
                    _logger.LogInformation(
                        "[MdToPpt-Agent] DONE elapsedMs={Ms} htmlLen={Len} textDeltas={TD} toolCalls={TC}",
                        doneMs, html.Length, textDeltaCount, toolCallCount);
                    await WriteDiagAsync(new
                    {
                        stage = "done",
                        elapsedMs = doneMs,
                        htmlLen = html.Length,
                        textDeltaCount,
                        toolCallCount,
                        toolResultCount,
                        statusCount,
                        logCount,
                        errorCount,
                    });
                    await WriteEventAsync("done", new { html });
                    return;
                }

                // SSE 心跳：防止 Cloudflare ~100s 无数据超时（HTTP 524），每 ~10s 一次
                if (round % 12 == 11)
                {
                    try
                    {
                        await Response.WriteAsync(": keepalive\n\n", CancellationToken.None);
                        await Response.Body.FlushAsync(CancellationToken.None);
                    }
                    catch (OperationCanceledException) { break; }
                    catch (ObjectDisposedException) { break; }
                }

                await Task.Delay(800);
            }

            // 超时兜底
            var timeoutHtml = StripCodeFences(fullText.ToString());
            var timeoutMs = (int)(DateTime.UtcNow - overallStart).TotalMilliseconds;
            _logger.LogWarning(
                "[MdToPpt-Agent] TIMEOUT elapsedMs={Ms} htmlLen={Len} textDeltas={TD} toolCalls={TC}",
                timeoutMs, timeoutHtml.Length, textDeltaCount, toolCallCount);
            await WriteDiagAsync(new
            {
                stage = "timeout",
                elapsedMs = timeoutMs,
                htmlLen = timeoutHtml.Length,
                textDeltaCount,
                toolCallCount,
                message = textDeltaCount == 0 && toolCallCount > 0
                    ? "TIMEOUT: 超时时零 text_delta 但有 tool_call，确认为工具循环"
                    : "TIMEOUT: 超时，agent 未发送 done 事件",
            });

            if (!string.IsNullOrWhiteSpace(timeoutHtml))
                await WriteEventAsync("done", new { html = timeoutHtml });
            else
                await WriteEventAsync("error", new { message = "CDS Agent 响应超时，请稍后重试或切换到 MAP 直调引擎" });
        }
        catch (OperationCanceledException) { }
        catch (ObjectDisposedException) { }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[MdToPpt-Agent] unexpected error userId={UserId}", userId);
            try { await WriteEventAsync("error", new { message = ex.Message }); } catch { }
        }
        finally
        {
            // 结束后停止会话（server-authority：用 CancellationToken.None）
            if (session != null)
            {
                try { await _sessions.StopAsync(userId, session.Id, CancellationToken.None); }
                catch { }
            }
        }
    }

    // ─────────────────────────────────────────────
    // 解析 CDS 连接
    // ─────────────────────────────────────────────

    private async Task<InfraConnection?> ResolveCdsConnectionAsync(CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        return await _db.InfraConnections
            .Find(x => x.Partner == "cds"
                && x.LongTokenEncrypted != string.Empty
                && (x.Status == "active"
                    || (x.LastProbeOk == true && x.LongTokenExpiresAt > now)))
            .SortByDescending(x => x.UpdatedAt)
            .FirstOrDefaultAsync(ct);
    }

    // ─────────────────────────────────────────────
    // 解析运行配置（四级优先级）
    // ─────────────────────────────────────────────

    private async Task<InfraAgentRuntimeProfile?> ResolveRuntimeProfileAsync(string userId, CancellationToken ct)
    {
        var memberTeamIds = await _db.ReportTeamMembers
            .Find(x => x.UserId == userId)
            .Limit(500)
            .ToListAsync(ct);
        var leaderTeams = await _db.ReportTeams
            .Find(x => x.LeaderUserId == userId)
            .Limit(500)
            .ToListAsync(ct);
        var visibleTeamIds = memberTeamIds
            .Select(x => x.TeamId)
            .Concat(leaderTeams.Select(x => x.Id))
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .Distinct(StringComparer.Ordinal)
            .ToList();

        var fb = Builders<InfraAgentRuntimeProfile>.Filter;
        var ownedFilter = fb.Eq(x => x.CreatedByUserId, userId);
        var sharedFilter = visibleTeamIds.Count == 0
            ? fb.Where(_ => false)
            : fb.AnyIn(x => x.SharedTeamIds, visibleTeamIds);

        var profile = await _db.InfraAgentRuntimeProfiles
            .Find(ownedFilter & fb.Eq(x => x.IsDefault, true))
            .FirstOrDefaultAsync(ct);
        if (profile != null) return profile;

        profile = await _db.InfraAgentRuntimeProfiles
            .Find(sharedFilter & fb.Eq(x => x.IsDefault, true))
            .SortByDescending(x => x.UpdatedAt)
            .FirstOrDefaultAsync(ct);
        if (profile != null) return profile;

        profile = await _db.InfraAgentRuntimeProfiles
            .Find(ownedFilter)
            .SortByDescending(x => x.UpdatedAt)
            .FirstOrDefaultAsync(ct);
        if (profile != null) return profile;

        return await _db.InfraAgentRuntimeProfiles
            .Find(sharedFilter)
            .SortByDescending(x => x.UpdatedAt)
            .FirstOrDefaultAsync(ct);
    }

    // ─────────────────────────────────────────────
    // SSE 工具方法
    // ─────────────────────────────────────────────

    private void SetSseHeaders()
    {
        // 与全仓既有 SSE 控制器（PreviewAskController 等）保持一致：
        // 不手动设置 Transfer-Encoding —— Kestrel 自己管理分块编码，手动写 "chunked"
        // 会破坏响应分帧，Cloudflare 收不到合法流而缓冲到 ~100s 后 524（两个引擎都中招）。
        Response.ContentType = "text/event-stream";
        // no-transform 告诉 Cloudflare 不要对响应做压缩/转换 —— 这是 Cloudflare 边缘
        // 缓冲 SSE 的最常见根因(预览域名走 CF)。压缩需要缓冲到响应结束才能算，加上
        // no-transform 后 CF 直接透传增量分块，逐事件到达客户端而非末尾一次性吐出。
        Response.Headers.CacheControl = "no-cache, no-transform";
        Response.Headers.Connection = "keep-alive";
        Response.Headers["X-Accel-Buffering"] = "no"; // nginx 不缓冲 SSE，保留

        // 关键：禁用 Kestrel 响应缓冲 —— 与既有 SSE 控制器(VisualAgentVideoController
        // /VideoAgentController)一致。不调这个，每次 FlushAsync 只是 flush 到 Kestrel
        // 的输出缓冲，Kestrel 仍 hold 到响应结束才上线，表现为客户端末尾一次性收到整条流。
        var bodyFeature = HttpContext.Features.Get<Microsoft.AspNetCore.Http.Features.IHttpResponseBodyFeature>();
        bodyFeature?.DisableBuffering();
    }

    // 开流后立刻写一段 2KB 注释 padding 并 flush —— 击穿部分代理/CF 的"最小缓冲
    // 阈值"，强制 headers + 首字节立即上路，让后续事件真正逐条流式到达。
    private async Task WriteSsePreambleAsync()
    {
        try
        {
            var padding = ": " + new string(' ', 2048) + "\n\n";
            await Response.WriteAsync(padding, CancellationToken.None);
            await Response.Body.FlushAsync(CancellationToken.None);
        }
        catch (OperationCanceledException) { }
        catch (ObjectDisposedException) { }
    }

    private async Task WriteEventAsync(string eventName, object? data)
    {
        try
        {
            var dataLine = data == null
                ? "null"
                : JsonSerializer.Serialize(data, new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase });
            var payload = $"event: {eventName}\ndata: {dataLine}\n\n";
            await Response.WriteAsync(payload, CancellationToken.None);
            await Response.Body.FlushAsync(CancellationToken.None);
        }
        catch (OperationCanceledException) { }
        catch (ObjectDisposedException) { }
    }

    private async Task WriteDiagAsync(object data)
    {
        await WriteEventAsync("diag", data);
    }

    // ─────────────────────────────────────────────
    // 去除代码围栏
    // ─────────────────────────────────────────────

    private static string StripCodeFences(string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return text;

        var s = text.Trim();

        if (s.StartsWith("```", StringComparison.Ordinal))
        {
            var firstNewline = s.IndexOf('\n');
            if (firstNewline >= 0)
                s = s[(firstNewline + 1)..];
        }

        if (s.EndsWith("```", StringComparison.Ordinal))
        {
            var lastFence = s.LastIndexOf("```", StringComparison.Ordinal);
            if (lastFence > 0)
                s = s[..lastFence].TrimEnd();
        }

        // 服务端兜底剥离 emoji（CLAUDE 规则 #0：本系统任何项目一律不允许 emoji）。
        // 模型偶尔会无视提示词往幻灯里塞 emoji 图标，这里统一清掉。
        s = EmojiRegex.Replace(s, string.Empty);

        return s.Trim();
    }

    // 覆盖常见 emoji 区段：BMP 符号/装饰区(U+2600-27BF Dingbats/Misc, U+2B00-2BFF) +
    // 变体选择符(U+FE00-FE0F) + ZWJ(U+200D) + 组合 keycap(U+20E3) + 星平面 emoji(高代理对)。
    // 全部用 \u 转义,源码内不出现任何 emoji 字面量(CLAUDE 规则 #0)。
    private static readonly System.Text.RegularExpressions.Regex EmojiRegex =
        new("[\u2600-\u27BF\u2B00-\u2BFF\uFE00-\uFE0F\u200D\u20E3]|[\uD83C-\uD83E][\uDC00-\uDFFF]",
            System.Text.RegularExpressions.RegexOptions.Compiled);
}

// ─────────────────────────────────────────────
// 请求 DTO
// ─────────────────────────────────────────────

public class MdToPptConvertRequest
{
    /// <summary>要转换的内容（Markdown / 纯文本）</summary>
    public string? Content { get; set; }

    /// <summary>期望页数（可选）</summary>
    public int? SlideCount { get; set; }

    /// <summary>主题（可选）</summary>
    public string? Theme { get; set; }

    /// <summary>生成引擎："map"（默认，MAP 直调）或 "agent"（CDS Agent）</summary>
    public string? Engine { get; set; }
}

public class MdToPptPatchRequest
{
    /// <summary>当前 HTML 内容</summary>
    public string? CurrentHtml { get; set; }

    /// <summary>修改要求</summary>
    public string? SlideRequest { get; set; }

    /// <summary>目标页索引（可选）</summary>
    public int? SlideIndex { get; set; }

    /// <summary>生成引擎："map"（默认）或 "agent"</summary>
    public string? Engine { get; set; }
}

public class MdToPptPublishRequest
{
    /// <summary>要发布的 HTML 内容</summary>
    public string? HtmlContent { get; set; }

    /// <summary>发布标题</summary>
    public string? Title { get; set; }

    /// <summary>站点描述（可选）</summary>
    public string? Description { get; set; }

    /// <summary>标签（可选）</summary>
    public List<string>? Tags { get; set; }

    /// <summary>分享到的团队 ID（可选）</summary>
    public List<string>? TeamIds { get; set; }
}
