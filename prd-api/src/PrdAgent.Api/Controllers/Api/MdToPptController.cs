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

    // PPT 系统提示词（按风格主题生成不同设计系统）。两条路径共用。
    private static string BuildPptSystemPrompt(string? theme)
    {
        var (tokens, tone) = ThemeTokens(theme);
        return
            "你是顶级演示设计师，作品对标 Apple Keynote / Stripe / Linear / Vercel 的发布会幻灯。" +
            "唯一任务：直接输出一个完整、惊艳、可直接演示的 reveal.js HTML 文件。禁止调用任何工具或执行命令，禁止输出任何解释或代码块标记。\n\n" +
            "## 硬技术规范\n" +
            "- reveal.js 4.x CDN：https://cdn.jsdelivr.net/npm/reveal.js@4/dist/reveal.js + reveal.css（不引官方主题，用下面的自定义主题）\n" +
            "- 初始化：Reveal.initialize({ hash:false, transition:'slide', slideNumber:'c/t', controls:true, progress:true, center:true, margin:0.06 })（不要写 width/height，让它自适应容器）\n" +
            "- <head> 必须在 reveal.js 之前加载 Google Fonts：<link rel=\"preconnect\" href=\"https://fonts.googleapis.com\"><link rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin><link href=\"https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap\" rel=\"stylesheet\">\n" +
            "- 全部 CSS 内联在 <head> 的 <style> 里；输出完整 <!DOCTYPE html>…</html>；不要 markdown 代码围栏\n" +
            "- 绝对禁止任何 emoji 字符（一切表情/符号图标都不许）；需要图标时只用 inline SVG 或 CSS 几何图形\n" +
            "- 绝对禁止对标题/正文用 `color:transparent` + `background-clip:text`（嵌入式渲染常常不生效，会导致文字整页消失）；标题一律用实色 var(--ink)，渐变只能用在 .orb/.bar 等非文字装饰上\n\n" +
            "## 本次风格：" + tone + "\n" +
            "严格按上面的风格走（配色、底色、气质），把下面这套 CSS 设计 token 与组件类原样落进 <style>，并在每页真正用上（这是质量下限不是参考）：\n" +
            "```\n" +
            tokens +
            ".reveal{font-family:'Inter',-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',system-ui,sans-serif;color:var(--ink);}\n" +
            ".reveal .slides section{text-align:left;padding:2vh 5vw;}\n" +
            ".eyebrow{text-transform:uppercase;letter-spacing:.24em;font-size:.78rem;font-weight:800;color:var(--a2);margin-bottom:18px;}\n" +
            ".title-xl{font-size:clamp(44px,6.6vw,86px);font-weight:850;line-height:1.06;letter-spacing:-.025em;margin:0;color:var(--ink);}\n" +
            ".title-md{font-size:clamp(30px,4vw,52px);font-weight:800;line-height:1.1;letter-spacing:-.02em;margin:0 0 6px;color:var(--ink);}\n" +
            ".lead{font-size:clamp(17px,1.6vw,22px);color:var(--muted);max-width:46ch;line-height:1.5;}\n" +
            ".grid{display:grid;gap:22px;margin-top:34px;}.g2{grid-template-columns:1fr 1fr;}.g3{grid-template-columns:repeat(3,1fr);}\n" +
            ".card{background:var(--card);border:1px solid var(--line);border-radius:20px;padding:26px 28px;box-shadow:0 2px 14px rgba(0,0,0,.06);}\n" +
            ".card h3{margin:0 0 8px;font-size:1.15rem;font-weight:800;color:var(--ink);}.card p{margin:0;color:var(--muted);font-size:.98rem;line-height:1.5;}\n" +
            ".stat{font-size:clamp(40px,5.5vw,72px);font-weight:850;letter-spacing:-.02em;color:var(--a1);}\n" +
            ".stat-l{color:var(--muted);font-size:.95rem;margin-top:4px;}\n" +
            ".chip{display:inline-flex;align-items:center;gap:8px;padding:7px 14px;border:1px solid var(--line);border-radius:999px;font-size:.85rem;color:var(--ink);}\n" +
            ".bar{width:54px;height:5px;border-radius:9px;background:linear-gradient(90deg,var(--a1),var(--a2));margin:20px 0;}\n" +
            ".quote{font-size:clamp(26px,3.2vw,42px);font-weight:700;line-height:1.3;color:var(--ink);border-left:4px solid var(--a3);padding-left:28px;}\n" +
            ".orb{position:absolute;border-radius:50%;filter:blur(80px);opacity:var(--orb-op);z-index:0;pointer-events:none;}.orb.a{width:420px;height:420px;background:var(--a1);right:-80px;top:-90px;}.orb.b{width:340px;height:340px;background:var(--a3);left:-70px;bottom:-90px;}\n" +
            ".reveal .slide-number{background:transparent;color:var(--muted);}\n" +
            "li{margin:10px 0;line-height:1.5;}ul{list-style:none;padding:0;}ul li{padding-left:26px;position:relative;}ul li::before{content:'';position:absolute;left:0;top:.6em;width:8px;height:8px;border-radius:3px;background:linear-gradient(120deg,var(--a1),var(--a2));}\n" +
            ".feat{display:flex;align-items:flex-start;gap:16px;padding:18px;background:var(--card);border:1px solid var(--line);border-radius:16px;}\n" +
            ".feat-icon{flex-shrink:0;width:40px;height:40px;border-radius:12px;background:linear-gradient(135deg,var(--a1),var(--a2));display:flex;align-items:center;justify-content:center;}\n" +
            ".feat h4{margin:0 0 4px;font-size:1rem;font-weight:700;color:var(--ink);}.feat p{margin:0;font-size:.9rem;color:var(--muted);line-height:1.5;}\n" +
            ".table{width:100%;border-collapse:collapse;font-size:.9rem;}\n" +
            ".table th{padding:10px 14px;text-align:left;font-size:.78rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--a2);border-bottom:2px solid var(--line);}\n" +
            ".table td{padding:10px 14px;color:var(--ink);border-bottom:1px solid var(--line);}\n" +
            ".table tr:last-child td{border-bottom:none;}.table tr:nth-child(even) td{background:var(--card);}\n" +
            ".callout{display:flex;gap:14px;padding:18px 20px;border-radius:14px;border:1px solid var(--a1);background:rgba(99,102,241,.08);}\n" +
            ".callout-icon{flex-shrink:0;width:22px;height:22px;border-radius:50%;background:var(--a1);margin-top:1px;}\n" +
            ".callout p{margin:0;color:var(--ink);font-size:.98rem;line-height:1.55;}\n" +
            ".step-row{display:flex;gap:0;margin-top:30px;}\n" +
            ".step-item{flex:1;position:relative;padding:0 12px;text-align:center;}\n" +
            ".step-item::before{content:'';position:absolute;top:20px;left:50%;right:-50%;height:2px;background:linear-gradient(90deg,var(--a1),var(--a2));z-index:0;}\n" +
            ".step-item:last-child::before{display:none;}\n" +
            ".step-num{width:40px;height:40px;border-radius:50%;background:linear-gradient(135deg,var(--a1),var(--a2));color:#fff;font-weight:800;font-size:1rem;display:inline-flex;align-items:center;justify-content:center;position:relative;z-index:1;margin-bottom:10px;}\n" +
            ".step-item h4{font-size:.9rem;font-weight:700;color:var(--ink);margin:0 0 4px;}\n" +
            ".step-item p{font-size:.82rem;color:var(--muted);margin:0;line-height:1.4;}\n" +
            "```\n\n" +
            "## 每页强制结构（杜绝『一行居中标题』的空洞页）\n" +
            "除封面/结语外，每一页都必须包含：① 一个 .eyebrow 小标签 → ② 一个 .title-md 标题 → ③ 结构化正文（卡片网格 / 数据 / 对比 / 列表，至少一种）→ ④ 至少一个视觉装置（.orb 光晕、.bar 强调条、卡片、或大号 .stat）。绝不允许出现只有一句话居中、四周大片空白的页。\n\n" +
            "## 版式库（按内容选用，全篇至少混用 5 种，禁止每页雷同）\n" +
            "1. 封面：.orb 光晕背景 + .eyebrow + 超大 .title-xl 标题 + .lead 副标题 + 底部 .chip 行（作者/日期/标签）\n" +
            "2. 要点卡片：.grid.g3 或 .g2，每个 .card 一个要点（标题 + 说明），禁止写成裸列表\n" +
            "3. 数据看板：.grid.g3，每格 .stat 大数字 + .stat-l 说明，纯数据页视觉震撼\n" +
            "4. 两栏对比：.grid.g2，左『现状/问题』右『方案/结果』各一张 .card，对比清晰\n" +
            "5. 功能特性列表：3-4 个 .feat 条目竖排，每条含图标方块 + 标题 + 说明，替代普通列表\n" +
            "6. 对比表格：.table 展示多列对比（功能/价格/优劣/指标），比卡片更直观\n" +
            "7. 流程步骤：.step-row 横向流程图（3-4 步），每步序号圆 + 标题 + 说明\n" +
            "8. 金句/转场：.quote 大字引用 + 左侧强调条 + .orb 背景，用于重要观点\n" +
            "9. 标注提示：.callout 高亮框 + 重要结论，搭配其他内容出现\n" +
            "10. 结语：居中 .title-xl + 一句行动号召 + .chip 联系方式\n\n" +
            "## 质量自检（输出前逐条过）\n" +
            "- 全篇是否真的用了至少 5 种不同版式？每页版式与前后页都不同？\n" +
            "- 是否至少出现了一页 .feat 功能列表、一页 .stat 数据看板或 .table 对比表？\n" +
            "- 随手翻到任意一页，是否都『信息充实 + 有设计感』，而不是只有文字列表？\n" +
            "- 所有卡片/图块/背景是否真的用了本风格的 CSS 变量（var(--card)/var(--a1) 等）？\n" +
            "- 是否严格贴合本次风格（" + tone + "）的底色与气质？留白舒展、层级分明？\n" +
            "- 逻辑连贯、节奏有起伏（数据页后跟文字页，避免视觉疲劳）？\n\n" +
            "## 输出要求（最高优先级）\n" +
            "- 仅输出完整 HTML 文件内容，第一个字符是 <，最后是 >，中间不得有任何解释、标注或 ``` 代码块标记\n" +
            "- 禁止使用工具调用，禁止执行命令，直接以纯文本形式输出 HTML";
    }

    // 按风格主题返回（CSS token 块 + 风格气质描述）。前端「风格模板」下拉的 5 个值各对应一套配色。
    private static (string tokens, string tone) ThemeTokens(string? theme)
    {
        switch ((theme ?? "dark-glass").Trim().ToLowerInvariant())
        {
            case "light-clean":
                return (
                    ":root{--bg:#f7f8fc;--bg2:#eef1f8;--ink:#0f172a;--muted:#5b6478;--line:rgba(15,23,42,.1);--card:#ffffff;--a1:#4f46e5;--a2:#0891b2;--a3:#7c3aed;--orb-op:.18;}\nhtml,body,.reveal{background:linear-gradient(180deg,#ffffff,#eef2fb);}\n",
                    "浅色简洁（Notion/文档风）——白底深字、大量留白。" +
                    "特别要求：.card 必须用白色背景 + 浅灰边框；.orb 透明度极低（仅作点缀）；" +
                    "优先用 .table 对比表和 .feat 功能列表展示信息，少用大面积深色背景块；" +
                    "封面 .title-xl 用深墨色（--ink），整体感觉干净克制");
            case "gradient-purple":
                return (
                    ":root{--bg:#1a0b2e;--bg2:#2d1b4e;--ink:#fdf4ff;--muted:#c8b6dc;--line:rgba(255,255,255,.12);--card:rgba(255,255,255,.07);--a1:#c084fc;--a2:#f472b6;--a3:#a855f7;--orb-op:.55;}\nhtml,body,.reveal{background:radial-gradient(1000px 700px at 70% 0%,#3b1d6e 0%,#1a0b2e 60%);}\n",
                    "紫色渐变（营销/发布会风）——深紫底 + 粉紫霓虹、超大光晕。" +
                    "特别要求：封面必须有巨大 .orb 光晕占整个背景右上角；" +
                    "多用 .stat 大数字页（用 --a1/#c084fc 紫色数字）；" +
                    "用 .quote 引用页做转场；.card 有明显毛玻璃感（rgba 白/7%）；" +
                    "整体视觉大胆、充满动感，如 Figma/Framer 发布会 PPT");
            case "corporate-blue":
                return (
                    ":root{--bg:#0a1628;--bg2:#0f2138;--ink:#eef6ff;--muted:#8aa0bd;--line:rgba(255,255,255,.1);--card:rgba(255,255,255,.05);--a1:#2563eb;--a2:#38bdf8;--a3:#3b82f6;--orb-op:.4;}\nhtml,body,.reveal{background:linear-gradient(160deg,#0f2138,#0a1628);}\n",
                    "商务蓝（企业汇报/方案风）——藏青深底 + 蓝色系强调色。" +
                    "特别要求：多用 .table 对比表展示数据/功能/规格；" +
                    "用 .step-row 流程图展示方案步骤；.stat 数字用蓝色（--a1/#2563eb）；" +
                    ".callout 高亮重要结论；封面用正式 .eyebrow + 标题 + 副标题结构；" +
                    "整体克制稳重，没有过度装饰，如麦肯锡/咨询公司 PPT");
            case "warm-earth":
                return (
                    ":root{--bg:#1c1410;--bg2:#2a1f17;--ink:#fdf6ee;--muted:#c8ad95;--line:rgba(255,255,255,.1);--card:rgba(255,255,255,.045);--a1:#f59e0b;--a2:#fb923c;--a3:#d97706;--orb-op:.45;}\nhtml,body,.reveal{background:radial-gradient(1000px 700px at 80% -10%,#3d2817 0%,#1c1410 60%);}\n",
                    "暖色大地（品牌/故事风）——炭褐底 + 琥珀橙/暖橙强调色。" +
                    "特别要求：多用 .quote 金句页（用橙色 --a1/#f59e0b 左侧条）；" +
                    ".feat 列表带圆角橙色图标方块；.stat 数字用暖橙色；" +
                    ".card 背景微暖（卡片有轻微暖褐色）；" +
                    "整体质感温暖有力，如餐饮/品牌/创意公司 Deck");
            default:
                return (
                    ":root{--bg:#070b18;--bg2:#0f1530;--ink:#f6f8ff;--muted:#9aa6c4;--line:rgba(255,255,255,.09);--card:rgba(255,255,255,.045);--a1:#6366f1;--a2:#22d3ee;--a3:#a855f7;--orb-op:.5;}\nhtml,body,.reveal{background:radial-gradient(1200px 800px at 80% -10%,#1b2350 0%,var(--bg) 55%);}\n",
                    "深色玻璃（科技/SaaS 风，对标 Vercel/Linear）——近黑底 + 靛蓝/青/紫霓虹、毛玻璃卡片。" +
                    "特别要求：封面 .orb 背景光晕覆盖右上 1/3；" +
                    "多用 .feat 功能列表（左侧渐变方块图标）和 .stat 数据大字（靛蓝 --a1/#6366f1）；" +
                    ".card 要有真实毛玻璃感（rgba(255,255,255,0.045)）；" +
                    ".step-row 流程图用青色（--a2/#22d3ee）连接线；整体未来感强");
        }
    }



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
    // POST /api/md-to-ppt/outline
    // ─────────────────────────────────────────────

    /// <summary>
    /// 根据内容生成 PPT 大纲（JSON，非 SSE），用于对话式「大纲先行确认」流程。
    /// 返回 { outline: [{title, bullets[]}], totalPages, summary }
    /// </summary>
    [HttpPost("outline")]
    public async Task<IActionResult> Outline([FromBody] MdToPptOutlineRequest req)
    {
        var userId = this.GetRequiredUserId();

        if (string.IsNullOrWhiteSpace(req.Content))
            return BadRequest(new { error = "内容不能为空" });

        var targetPages = req.TargetPages is > 0 ? req.TargetPages.Value : 8;
        var systemPrompt =
            "你是专业 PPT 策划师。根据用户内容，输出一份 PPT 大纲（纯 JSON，不要其他任何解释和代码围栏）。\n" +
            $"目标页数：约 {targetPages} 页（封面+结语 2 页 + 内容页，实际可根据内容增减 1-2 页）。\n" +
            "输出格式：\n" +
            "{\"totalPages\":8,\"summary\":\"一句话总结本 PPT 讲什么\",\"outline\":[{\"title\":\"封面\",\"bullets\":[\"副标题\",\"作者/日期\"]},{\"title\":\"现状分析\",\"bullets\":[\"要点1\",\"要点2\",\"要点3\"]},...,{\"title\":\"结语\",\"bullets\":[\"行动号召\",\"联系方式\"]}]}\n\n" +
            "严格规则：\n" +
            "1. 只输出 JSON，第一个字符是 {，最后一个字符是 }，不得有 markdown 代码块、前缀说明、后缀解释\n" +
            "2. 每页 bullets 2-4 条，语言精炼\n" +
            "3. 版式不重复，避免每页都是列表结构\n" +
            "4. 禁止输出任何 emoji\n" +
            "5. title 字段纯文本，不含序号（如「一、」「1.」）";

        var contextParts = new List<string>();
        if (!string.IsNullOrWhiteSpace(req.Content))
            contextParts.Add($"# 用户内容\n\n{req.Content.Trim()}");
        if (!string.IsNullOrWhiteSpace(req.AttachmentText))
            contextParts.Add($"# 附件内容\n\n{req.AttachmentText.Trim()}");
        if (!string.IsNullOrWhiteSpace(req.KbContext))
            contextParts.Add($"# 知识库内容\n\n{req.KbContext.Trim()}");
        if (!string.IsNullOrWhiteSpace(req.ChatHistory))
            contextParts.Add($"# 对话历史\n\n{req.ChatHistory.Trim()}");
        var userContent = string.Join("\n\n---\n\n", contextParts);

        using var _ = _llmRequestContext.BeginScope(new LlmRequestContext(
            RequestId: Guid.NewGuid().ToString("N"),
            GroupId: null,
            SessionId: null,
            UserId: userId,
            ViewRole: null,
            DocumentChars: userContent.Length,
            DocumentHash: null,
            SystemPromptRedacted: "[MdToPpt-Outline]",
            RequestType: "chat",
            AppCallerCode: AppCallerRegistry.MdToPptAgent.Generation.Outline));

        var gatewayRequest = new GatewayRequest
        {
            AppCallerCode = AppCallerRegistry.MdToPptAgent.Generation.Outline,
            ModelType = ModelTypes.Chat,
            Stream = true,
            TimeoutSeconds = 60,
            RequestBody = new JsonObject
            {
                ["messages"] = new JsonArray
                {
                    new JsonObject { ["role"] = "system", ["content"] = systemPrompt },
                    new JsonObject { ["role"] = "user",   ["content"] = userContent },
                },
                ["temperature"] = 0.3,
                ["max_tokens"] = 4096,
            },
        };

        var fullText = new StringBuilder();
        try
        {
            await foreach (var chunk in _gateway.StreamAsync(gatewayRequest, CancellationToken.None))
            {
                if (chunk.Type == GatewayChunkType.Text && !string.IsNullOrEmpty(chunk.Content))
                    fullText.Append(chunk.Content);
                else if (chunk.Type == GatewayChunkType.Error)
                {
                    var err = chunk.Error ?? chunk.Content ?? "大纲生成失败";
                    _logger.LogError("[MdToPpt-Outline] gateway error userId={UserId}: {Error}", userId, err);
                    return StatusCode(502, new { error = err });
                }
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[MdToPpt-Outline] unexpected error userId={UserId}", userId);
            return StatusCode(500, new { error = ex.Message });
        }

        var raw = fullText.ToString().Trim();
        // 去除可能的代码围栏
        if (raw.StartsWith("```", StringComparison.Ordinal))
        {
            var nl = raw.IndexOf('\n');
            if (nl >= 0) raw = raw[(nl + 1)..];
        }
        if (raw.EndsWith("```", StringComparison.Ordinal))
        {
            var last = raw.LastIndexOf("```", StringComparison.Ordinal);
            if (last > 0) raw = raw[..last].TrimEnd();
        }
        raw = raw.Trim();

        try
        {
            using var doc = JsonDocument.Parse(raw);
            return Ok(doc.RootElement.Clone());
        }
        catch (JsonException)
        {
            _logger.LogWarning("[MdToPpt-Outline] JSON parse failed, raw={Raw}", raw.Length > 200 ? raw[..200] : raw);
            return StatusCode(502, new { error = "大纲 JSON 解析失败，请重试", raw });
        }
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

        var engine = (req.Engine ?? "map").Trim().ToLowerInvariant();
        var run = await CreateRunAsync(userId, engine, req.Theme, "convert", req.Content);
        await WriteEventAsync("run", new { runId = run.Id });

        var systemPrompt = BuildPptSystemPrompt(req.Theme);
        var styleHint = $"目标页数约 {req.SlideCount ?? 8} 页。";
        var userContent = $"{styleHint}\n\n---\n\n# 用户内容\n\n{req.Content?.Trim()}";

        if (engine == "agent")
            await RunAgentStreamAsync(userId, systemPrompt, userContent, "PPT", run);
        else
            await RunMapStreamAsync(userId, systemPrompt, userContent, AppCallerRegistry.MdToPptAgent.Generation.HtmlGenerate, "convert", run);
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

        var engine = (req.Engine ?? "map").Trim().ToLowerInvariant();
        var run = await CreateRunAsync(userId, engine, null, "patch", req.SlideRequest);
        await WriteEventAsync("run", new { runId = run.Id });

        var systemPrompt = BuildPptSystemPrompt(null);
        // 前端的"指定第几页"输入框是 1-based(min=1)且原样下发,这里直接用,不能再 +1(否则
        // 输入 3 会被改成第 4 页);留空时 SlideIndex 为 null,语义是整份 PPT,不能写成"第 0 页"。
        var pageHint = req.SlideIndex.HasValue
            ? $"（仅修改第 {req.SlideIndex.Value} 页）"
            : "（未指定具体页，按要求修改整份 PPT）";
        var userContent = $"---\n\n# 已有 HTML\n\n```html\n{req.CurrentHtml?.Trim()}\n```\n\n# 修改要求{pageHint}\n\n{req.SlideRequest?.Trim()}";

        if (engine == "agent")
            await RunAgentStreamAsync(userId, systemPrompt, userContent, "PPT 修改", run);
        else
            await RunMapStreamAsync(userId, systemPrompt, userContent, AppCallerRegistry.MdToPptAgent.Generation.Patch, "patch", run);
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
    // 生成运行记录（server-authority：刷新可重连/查看）
    // ─────────────────────────────────────────────

    /// <summary>按 runId 拉取一次生成运行（刷新/断线后前端重连用）</summary>
    [HttpGet("runs/{id}")]
    public async Task<IActionResult> GetRun(string id)
    {
        var userId = this.GetRequiredUserId();
        var run = await _db.MdToPptRuns
            .Find(x => x.Id == id && x.UserId == userId)
            .FirstOrDefaultAsync();
        if (run == null) return NotFound(new { error = "运行记录不存在" });
        return Ok(new
        {
            id = run.Id,
            status = run.Status,
            engine = run.Engine,
            op = run.Op,
            title = run.Title,
            html = run.Html,
            error = run.Error,
            model = run.Model,
            platform = run.Platform,
            createdAt = run.CreatedAt,
            updatedAt = run.UpdatedAt,
        });
    }

    /// <summary>最近的生成历史（让用户刷新后还能找回/重开过去的结果）</summary>
    [HttpGet("runs")]
    public async Task<IActionResult> RecentRuns()
    {
        var userId = this.GetRequiredUserId();
        var runs = await _db.MdToPptRuns
            .Find(x => x.UserId == userId)
            .SortByDescending(x => x.CreatedAt)
            .Limit(20)
            .ToListAsync();
        return Ok(runs.Select(r => new
        {
            id = r.Id,
            status = r.Status,
            engine = r.Engine,
            op = r.Op,
            title = r.Title,
            contentPreview = r.ContentPreview,
            hasHtml = !string.IsNullOrEmpty(r.Html),
            createdAt = r.CreatedAt,
        }));
    }

    private async Task<MdToPptRun> CreateRunAsync(string userId, string engine, string? theme, string op, string? content)
    {
        var run = new MdToPptRun
        {
            UserId = userId,
            Status = "running",
            Engine = engine,
            Theme = theme ?? string.Empty,
            Op = op,
            Title = DeriveTitle(content, op),
            ContentPreview = (content ?? string.Empty).Trim() is { Length: > 0 } cp
                ? (cp.Length > 200 ? cp[..200] : cp)
                : string.Empty,
        };
        await _db.MdToPptRuns.InsertOneAsync(run, cancellationToken: CancellationToken.None);
        return run;
    }

    private async Task PersistRunDoneAsync(MdToPptRun run, string html, string? model, string? platform)
    {
        try
        {
            run.Status = "done";
            run.Html = html;
            run.Model = model;
            run.Platform = platform;
            run.UpdatedAt = DateTime.UtcNow;
            await _db.MdToPptRuns.ReplaceOneAsync(x => x.Id == run.Id, run, cancellationToken: CancellationToken.None);
        }
        catch (Exception ex) { _logger.LogError(ex, "[MdToPpt] persist run done failed runId={Id}", run.Id); }
    }

    private async Task PersistRunErrorAsync(MdToPptRun run, string error)
    {
        try
        {
            run.Status = "error";
            run.Error = error;
            run.UpdatedAt = DateTime.UtcNow;
            await _db.MdToPptRuns.ReplaceOneAsync(x => x.Id == run.Id, run, cancellationToken: CancellationToken.None);
        }
        catch (Exception ex) { _logger.LogError(ex, "[MdToPpt] persist run error failed runId={Id}", run.Id); }
    }

    // 取首个 Markdown 标题行或内容前缀作为运行标题
    private static string DeriveTitle(string? content, string op)
    {
        var c = (content ?? string.Empty).Trim();
        if (string.IsNullOrEmpty(c)) return op == "patch" ? "PPT 修改" : "未命名 PPT";
        foreach (var line in c.Split('\n'))
        {
            var t = line.Trim();
            if (t.StartsWith('#')) { t = t.TrimStart('#').Trim(); if (t.Length > 0) return t.Length > 40 ? t[..40] : t; }
        }
        var first = c.Split('\n')[0].Trim();
        return first.Length > 40 ? first[..40] : first;
    }

    // ─────────────────────────────────────────────
    // MAP 直调路径（快速可靠）
    // ─────────────────────────────────────────────

    private async Task RunMapStreamAsync(
        string userId,
        string systemPrompt,
        string userContent,
        string appCallerCode,
        string opLabel,
        MdToPptRun run)
    {
        var startedAt = DateTime.UtcNow;
        string? resolvedModel = null;
        string? resolvedPlatform = null;
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

        // server-authority：客户端断开/刷新不取消生成。clientGone 后仅跳过 SSE 写入，
        // 仍消费完网关流、把结果落库（刷新后前端凭 runId 重连/查看）。
        var clientGone = false;
        try
        {
            await foreach (var chunk in _gateway.StreamAsync(gatewayRequest, CancellationToken.None))
            {
                if (chunk.Type == GatewayChunkType.Start && !sentModel && chunk.Resolution != null)
                {
                    sentModel = true;
                    resolvedModel = chunk.Resolution.ActualModel;
                    resolvedPlatform = chunk.Resolution.ActualPlatformName;
                    var elapsedMs = (int)(DateTime.UtcNow - startedAt).TotalMilliseconds;
                    _logger.LogInformation(
                        "[MdToPpt-MAP] model resolved elapsedMs={Elapsed} model={Model} platform={Platform}",
                        elapsedMs, resolvedModel, resolvedPlatform);
                    if (!clientGone)
                    {
                        try { await WriteEventAsync("model", new { model = resolvedModel, platform = resolvedPlatform }); }
                        catch (ObjectDisposedException) { clientGone = true; }
                    }
                }
                else if (chunk.Type == GatewayChunkType.Text && !string.IsNullOrEmpty(chunk.Content))
                {
                    fullText.Append(chunk.Content);
                    if (!clientGone)
                    {
                        try { await WriteEventAsync("delta", new { text = chunk.Content }); }
                        catch (ObjectDisposedException) { clientGone = true; }
                    }
                }
                else if (chunk.Type == GatewayChunkType.Error)
                {
                    var err = chunk.Error ?? chunk.Content ?? "LLM 网关返回未知错误";
                    _logger.LogError("[MdToPpt-MAP] gateway error userId={UserId}: {Error}", userId, err);
                    await PersistRunErrorAsync(run, err);
                    if (!clientGone) { try { await WriteEventAsync("error", new { message = err }); } catch { } }
                    return;
                }
            }

            var html = StripCodeFences(fullText.ToString());
            var totalMs = (int)(DateTime.UtcNow - startedAt).TotalMilliseconds;
            _logger.LogInformation(
                "[MdToPpt-MAP] done userId={UserId} totalMs={TotalMs} htmlLen={HtmlLen}",
                userId, totalMs, html.Length);
            await PersistRunDoneAsync(run, html, resolvedModel, resolvedPlatform);
            if (!clientGone) { try { await WriteEventAsync("done", new { html }); } catch (ObjectDisposedException) { } }
        }
        catch (OperationCanceledException) { }
        catch (ObjectDisposedException) { }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[MdToPpt-MAP] unexpected error userId={UserId}", userId);
            await PersistRunErrorAsync(run, ex.Message);
            if (!clientGone) { try { await WriteEventAsync("error", new { message = ex.Message }); } catch { } }
        }
    }

    // ─────────────────────────────────────────────
    // CDS Agent 路径（可观测，诊断插桩）
    // ─────────────────────────────────────────────

    private async Task RunAgentStreamAsync(string userId, string systemPrompt, string userPrompt, string title, MdToPptRun run)
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
                await PersistRunErrorAsync(run, "没有可用的 active CDS 连接，请先完成系统级 CDS 授权");
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
                await PersistRunErrorAsync(run, "没有可用的模型运行配置，请先配置 baseUrl、model 和 API key");
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
            var fullPrompt = $"{systemPrompt}\n\n---\n\n{userPrompt}";
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
            // server-authority：客户端刷新/断开不取消生成。clientGone 后仅跳过 SSE 心跳写入,
            // 继续轮询 CDS Agent 会话事件并落库,客户端可凭 runId 重连拿完整结果。
            // (WriteEventAsync/WriteDiagAsync 本身已吞掉 OCE/ODE,只有这里的直写心跳要单独防护。)
            var clientGone = false;

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
                    await PersistRunErrorAsync(run, errorMessage);
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
                    await PersistRunDoneAsync(run, html, runtimeProfile?.Model ?? model, "CDS Agent");
                    await WriteEventAsync("done", new { html });
                    return;
                }

                // SSE 心跳：防止 Cloudflare ~100s 无数据超时（HTTP 524），每 ~10s 一次。
                // 客户端断开后心跳写入会抛 OCE/ODE —— 不能 break(那会提前掉进超时分支,落盘
                // 半成品并 StopAsync 掉还在跑的会话)。改为标记 clientGone 后继续轮询到真正
                // done/error/timeout,把完整结果落库,客户端再凭 runId 重连。
                if (!clientGone && round % 12 == 11)
                {
                    try
                    {
                        await Response.WriteAsync(": keepalive\n\n", CancellationToken.None);
                        await Response.Body.FlushAsync(CancellationToken.None);
                    }
                    catch (OperationCanceledException) { clientGone = true; }
                    catch (ObjectDisposedException) { clientGone = true; }
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
            {
                await PersistRunDoneAsync(run, timeoutHtml, model, "CDS Agent");
                await WriteEventAsync("done", new { html = timeoutHtml });
            }
            else
            {
                await PersistRunErrorAsync(run, "CDS Agent 响应超时，请稍后重试或切换到 MAP 直调引擎");
                await WriteEventAsync("error", new { message = "CDS Agent 响应超时，请稍后重试或切换到 MAP 直调引擎" });
            }
        }
        catch (OperationCanceledException) { }
        catch (ObjectDisposedException) { }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[MdToPpt-Agent] unexpected error userId={UserId}", userId);
            await PersistRunErrorAsync(run, ex.Message);
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

        s = InjectDeckCssFix(s);

        return s.Trim();
    }

    // 兜底修正生成 HTML 的布局 bug（预览 + 发布的网页都生效）：
    // 模型常把 `.reveal .slides section>*{position:relative}` 写进样式，其优先级高于
    // `.orb{position:absolute}`，导致装饰光晕 .orb 变成 relative 块、占掉 ~700px 流式高度，
    // 把正文整体挤到幻灯可视区之外（表现为「整页空白只剩光晕」）。这里强制 .orb 绝对定位。
    private static string InjectDeckCssFix(string html)
    {
        if (string.IsNullOrEmpty(html)) return html;
        const string fix = "<style>.reveal .slides .orb{position:absolute !important;pointer-events:none;}</style>";
        var idx = html.IndexOf("</head", StringComparison.OrdinalIgnoreCase);
        if (idx >= 0) return html[..idx] + fix + html[idx..];
        var bodyIdx = html.IndexOf("<body", StringComparison.OrdinalIgnoreCase);
        if (bodyIdx >= 0) return html[..bodyIdx] + fix + html[bodyIdx..];
        return fix + html;
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

public class MdToPptOutlineRequest
{
    /// <summary>主内容（Markdown / 文本）</summary>
    public string? Content { get; set; }

    /// <summary>附件文本（已提取的文件内容）</summary>
    public string? AttachmentText { get; set; }

    /// <summary>知识库上下文（已提取的 KB 条目内容）</summary>
    public string? KbContext { get; set; }

    /// <summary>对话历史摘要（告知 AI 用户的历史需求）</summary>
    public string? ChatHistory { get; set; }

    /// <summary>目标页数（可选，默认 8）</summary>
    public int? TargetPages { get; set; }
}
