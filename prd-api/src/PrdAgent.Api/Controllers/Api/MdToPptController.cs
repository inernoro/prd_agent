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
            "- reveal.js 4.x CDN：https://cdn.jsdelivr.net/npm/reveal.js@4/dist/reveal.js + reveal.css（不引官方主题，完全用下面的自定义主题）\n" +
            "- 初始化：Reveal.initialize({ hash:false, transition:'fade', slideNumber:'c/t', controls:true, progress:true, center:true, margin:0.06 })（不要写 width/height，让它自适应容器）\n" +
            "- <head> 字体：前端会注入全套字体（Inter / JetBrains Mono / Newsreader / Hanken Grotesk / Playfair Display / Space Grotesk / Noto Sans SC），你只需按本次风格在 CSS 里引用正确字体名\n" +
            "- 全部 CSS 内联在 <head> 的 <style> 里；输出完整 <!DOCTYPE html>…</html>；不要 markdown 代码围栏\n" +
            "- 绝对禁止任何 emoji 字符（一切表情/符号图标都不许）；需要图标时只用 inline SVG 或 CSS 几何图形\n" +
            "- 绝对禁止对标题/正文用 `color:transparent` + `background-clip:text`（嵌入式渲染常常不生效，会导致文字整页消失）；标题一律用实色 var(--ink)，渐变只能用在 .orb/.bar 等非文字装饰上\n" +
            "- 你的 <style> 就是最终视觉，没有任何外部覆盖层替你纠正配色——CSS 变量与 html/body/.reveal 背景必须严格按本次风格写对，每一页的版式都要按该风格重新设计，不是同一版式换色\n\n" +
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
            "除封面/结语外，每一页都必须包含：① 一个 .eyebrow 小标签 → ② 一个 .title-md 标题 → ③ 结构化正文（卡片网格 / 数据 / 对比 / 列表，至少一种）→ ④ 至少一个视觉装置（.orb 光晕、.bar 强调条、卡片、大号 .stat、或版式独特的大字编排）。绝不允许出现只有一句话居中、四周大片空白的页。\n\n" +
            "## 版式库（按内容选用，全篇至少混用 5 种，禁止每页雷同）\n" +
            "1. 封面：（暗色主题）.orb 光晕背景 + .eyebrow + 超大 .title-xl 标题 + .lead 副标题 + 底部 .chip 行；（亮色主题）大字占满页面 2/3 + 纤细副标题 + 底部 hairline 分隔\n" +
            "2. 要点卡片：.grid.g3 或 .g2，每个 .card 一个要点（标题 + 说明），禁止写成裸列表\n" +
            "3. 数据看板（Big Numbers）：.grid.g3 或 .g4，每格顶部 kicker 标签 + 超大 .stat 数字 + 下方说明，「大数字压住版面」的视觉冲击，有边界线分隔格子\n" +
            "4. 两栏对比：.grid.g2，左『现状/问题』右『方案/结果』各一张 .card，或各一条竖线分隔的文字块，对比清晰\n" +
            "5. 功能特性列表：3-4 个 .feat 条目竖排，每条含图标方块 + 标题 + 说明，替代普通列表\n" +
            "6. 对比表格：.table 展示多列对比（功能/价格/优劣/指标），表头加 kicker 样式\n" +
            "7. 流程步骤：.step-row 横向流程图（3-4 步），每步序号圆 + 标题 + 说明，圆间连接线\n" +
            "8. 金句/章节转场：.quote 大字引用（font-size:clamp(28px,4vw,54px)）+ 左侧强调条 + 淡化引用符号，用于重要观点或章节分隔\n" +
            "9. 标注提示：.callout 高亮框 + 重要结论，搭配其他内容出现\n" +
            "10. 结语：居中 .title-xl + 一句行动号召 + .chip 联系方式，或左对齐大字 + 右侧装饰图形\n\n" +
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
    // 5 套主题借鉴 open-design 模板库，视觉各异：Tech 极黑 / 钴蓝格纸 / 纸墨编辑 / 复古 Zine / Swiss 极简
    private static (string tokens, string tone) ThemeTokens(string? theme)
    {
        switch ((theme ?? "tech-dark").Trim().ToLowerInvariant())
        {
            case "cobalt-grid":
                return (
                    ":root{--bg:#F0EBDE;--bg2:#E6E0CE;--ink:#1F2BE0;--muted:#5560E5;--line:rgba(31,43,224,.2);--card:rgba(31,43,224,.06);--a1:#1F2BE0;--a2:#5560E5;--a3:#002FA7;--orb-op:0;}\n" +
                    "html,body,.reveal{background-color:#F0EBDE;}\n",
                    "钴蓝格纸（Cobalt Grid 风）——奶油纸底（#F0EBDE）+ 电气钴蓝（#1F2BE0），前端会叠加格纸底纹。" +
                    "字体：h1/h2 用 Newsreader 斜体衬线（font-style:italic；font-weight:400）；h3/h4 用 Hanken Grotesk 全大写；正文 Inter。" +
                    "所有文字统一用钴蓝 var(--ink)；.card 用 rgba(31,43,224,.06) 极浅蓝底 + 1px 钴蓝边；" +
                    "禁止任何暗色背景块；.stat 数字用 var(--a1)；标题不渐变；整体感觉如高档设计杂志或博物馆图录");
            case "editorial-ink":
                return (
                    ":root{--bg:#f1efea;--bg2:#e8e4dc;--ink:#0a0a0b;--muted:#3a382f;--line:rgba(10,10,11,.15);--card:#ffffff;--a1:#0a0a0b;--a2:#3a382f;--a3:#6b665b;--orb-op:0;}\n" +
                    "html,body,.reveal{background:#f1efea;}\n",
                    "纸墨编辑（Magazine Editorial 风）——暖纸底（#f1efea）+ 墨黑字（#0a0a0b），如 Monocle/《卫报》杂志排版。" +
                    "字体：h1/h2 用 Playfair Display 斜体衬线（font-style:italic；font-weight:500）；h3/h4 用 Inter 全大写小字（font-size:.75em；letter-spacing:.1em）；正文 Inter。" +
                    "严禁任何彩色：文字一律 var(--ink) 黑；强调用 border-left 竖线或横向 hairline；" +
                    ".stat 大数字黑色；.card 白底浅灰边框；.quote 左侧细竖条 var(--ink)；" +
                    "整体克制纯净，排版节奏如高品质印刷杂志内文，不用任何光晕效果");
            case "warm-zine":
                return (
                    ":root{--bg:#C8B99A;--bg2:#B8A98A;--ink:#1A1A1A;--muted:#3d3830;--line:rgba(26,26,26,.25);--card:#F4EFE6;--a1:#008F4D;--a2:#00A85D;--a3:#006B3A;--orb-op:0;}\n" +
                    "html,body,.reveal{background:#C8B99A;}\n",
                    "复古 Zine（Retro Zine 风）——暖褐纸底（#C8B99A）+ 近黑字 + 墨绿强调（#008F4D），复古报纸/独立杂志气质。" +
                    "字体：h1/h2 用 Space Grotesk 超大号（font-size:clamp(44px,8vw,110px)；font-weight:700；line-height:.92）；h3/h4 绿色全大写（color:var(--a1)；letter-spacing:.16em）；正文 Space Grotesk。" +
                    "大标题占据整版 2/3 高度；用 .table 展示数据时边框用 var(--ink)；" +
                    ".stat 数字绿色 var(--a1)；.card 用 #F4EFE6 米白底 + 近黑边框；" +
                    ".quote 左侧绿色粗竖条；整体大胆朴拙，不圆滑");
            case "swiss-minimal":
                return (
                    ":root{--bg:#fafaf8;--bg2:#f0ede8;--ink:#0a0a0a;--muted:#555;--line:rgba(10,10,10,.12);--card:#ffffff;--a1:#002FA7;--a2:#4455cc;--a3:#001d85;--orb-op:0;}\n" +
                    "html,body,.reveal{background:#fafaf8;}\n",
                    "Swiss 极简（Swiss International Style）——近白底（#fafaf8）+ 极黑字 + IKB 蓝（#002FA7），如包豪斯/瑞士国际风格海报。" +
                    "字体：h1/h2 用 Inter 极黑全大写（font-weight:900；letter-spacing:-.03em；text-transform:uppercase）；h3/h4 用 IKB 蓝全大写细字（color:var(--a1)；letter-spacing:.14em；font-size:.72em）；正文 Inter。" +
                    "严格网格排版，大量留白；前端会注入顶部/底部细 hairline；" +
                    "颜色只用黑与蓝，完全禁止渐变、光晕、装饰性色块；" +
                    ".stat 数字全大写蓝色；.table 表头蓝色全大写；整体理性精准，如 Apple 发布会 keynote 的极简版");
            default: // tech-dark
                return (
                    ":root{--bg:#0d1117;--bg2:#161b22;--ink:#e6edf3;--muted:#8b949e;--line:rgba(139,148,158,.22);--card:#161b22;--a1:#7ee787;--a2:#79c0ff;--a3:#d2a8ff;--orb-op:.14;}\n" +
                    "html,body,.reveal{background:#0d1117;}\n",
                    "Tech 极黑（GitHub Dark 风，对标 GitHub/Stripe/Linear）——极深黑底（#0d1117）+ 草绿 mono 标题（#7ee787）+ 蓝色链接，代码感强。" +
                    "字体：h1/h2/h3 用 JetBrains Mono（font-family:'JetBrains Mono',monospace；font-weight:700；color:var(--a1)）；正文 Inter；kicker 用 .eyebrow class（mono 字体）。" +
                    "特别要求：封面 kicker 前加 '> ' 前缀；多用 .feat 功能列表（绿色图标方块）；" +
                    ".stat 数字用草绿 var(--a1)；.card 用深灰 #161b22 底 + 细灰边；" +
                    ".step-row 步骤连接线用青色 var(--a2)；整体终端/代码风格，不用圆润装饰");
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
            await RunMapStreamAsync(userId, systemPrompt, userContent, AppCallerRegistry.MdToPptAgent.Generation.HtmlGenerate, "convert", run, req.Model);
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
        var run = await CreateRunAsync(userId, engine, req.Theme, "patch", req.SlideRequest);
        await WriteEventAsync("run", new { runId = run.Id });

        // 风格主题随 patch 下发：换风格 = AI 参照该风格重绘整页 HTML（设计 token、
        // 字体、版式气质都在系统提示词里），不是前端套一层 CSS 换皮。
        var systemPrompt = BuildPptSystemPrompt(req.Theme);
        // 前端的"指定第几页"输入框是 1-based(min=1)且原样下发,这里直接用,不能再 +1(否则
        // 输入 3 会被改成第 4 页);留空时 SlideIndex 为 null,语义是整份 PPT,不能写成"第 0 页"。
        var pageHint = req.SlideIndex.HasValue
            ? $"（仅修改第 {req.SlideIndex.Value} 页）"
            : "（未指定具体页，按要求修改整份 PPT）";
        var userContent = $"---\n\n# 已有 HTML\n\n```html\n{req.CurrentHtml?.Trim()}\n```\n\n# 修改要求{pageHint}\n\n{req.SlideRequest?.Trim()}";

        if (engine == "agent")
            await RunAgentStreamAsync(userId, systemPrompt, userContent, "PPT 修改", run);
        else
            await RunMapStreamAsync(userId, systemPrompt, userContent, AppCallerRegistry.MdToPptAgent.Generation.Patch, "patch", run, req.Model);
    }

    // ─────────────────────────────────────────────
    // GET /api/md-to-ppt/models
    // ─────────────────────────────────────────────

    /// <summary>
    /// 列出直出引擎（engine=map）可切换的 chat 模型。
    /// 数据源：chat 类型模型池（model_groups），默认池模型排最前；前端据此渲染模型选择器，
    /// 选中值经 Convert/Patch 的 Model 字段作为 ExpectedModel 传给 Gateway（调度器优先尊重）。
    /// </summary>
    [HttpGet("models")]
    public async Task<IActionResult> GetModels()
    {
        var groups = await _db.ModelGroups
            .Find(g => g.ModelType == ModelTypes.Chat)
            .ToListAsync();

        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var items = new List<object>();
        string? defaultModel = null;
        foreach (var g in groups.OrderByDescending(x => x.IsDefaultForType).ThenByDescending(x => x.Priority))
        {
            foreach (var m in g.Models)
            {
                if (string.IsNullOrWhiteSpace(m.ModelId) || !seen.Add(m.ModelId)) continue;
                if (defaultModel == null && g.IsDefaultForType) defaultModel = m.ModelId;
                items.Add(new { model = m.ModelId, isDefault = m.ModelId == defaultModel });
            }
        }
        return Ok(new { items, defaultModel });
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
        MdToPptRun run,
        string? expectedModel = null)
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
            // 用户在前端选择的模型（可空 = 自动调度）。调度器优先尊重 expectedModel
            ExpectedModel = string.IsNullOrWhiteSpace(expectedModel) ? null : expectedModel.Trim(),
            Stream = true,
            TimeoutSeconds = 600,
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

        // 每 20s 发 keepalive 注释，防止代理因 SSE 空闲超时断连
        using var keepaliveCts = new CancellationTokenSource();
        var keepaliveTask = Task.Run(async () =>
        {
            try
            {
                while (!keepaliveCts.Token.IsCancellationRequested)
                {
                    await Task.Delay(20000, keepaliveCts.Token);
                    if (!clientGone)
                    {
                        try
                        {
                            await Response.WriteAsync(": keepalive\n\n", CancellationToken.None);
                            await Response.Body.FlushAsync(CancellationToken.None);
                        }
                        catch { clientGone = true; }
                    }
                }
            }
            catch (OperationCanceledException) { }
        });

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
        catch (OperationCanceledException)
        {
            // LLM 请求超时（TimeoutSeconds 到期）或被取消 — 必须通知前端，否则前端永久卡在"生成中"
            var timeoutMsg = "PPT 生成超时（LLM 响应超过 600s），请重试或缩短内容";
            _logger.LogWarning("[MdToPpt-MAP] LLM timeout userId={UserId} op={Op}", userId, opLabel);
            await PersistRunErrorAsync(run, timeoutMsg);
            if (!clientGone) { try { await WriteEventAsync("error", new { message = timeoutMsg }); } catch { } }
        }
        catch (ObjectDisposedException) { }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[MdToPpt-MAP] unexpected error userId={UserId}", userId);
            await PersistRunErrorAsync(run, ex.Message);
            if (!clientGone) { try { await WriteEventAsync("error", new { message = ex.Message }); } catch { } }
        }
        finally
        {
            keepaliveCts.Cancel();
            try { await keepaliveTask; } catch { }
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

    /// <summary>期望模型（可选，仅 engine=map 生效；空 = 自动调度。来自 GET models 列表）</summary>
    public string? Model { get; set; }
}

public class MdToPptPatchRequest
{
    /// <summary>当前 HTML 内容</summary>
    public string? CurrentHtml { get; set; }

    /// <summary>修改要求</summary>
    public string? SlideRequest { get; set; }

    /// <summary>目标页索引（可选）</summary>
    public int? SlideIndex { get; set; }

    /// <summary>风格主题（可选）。换风格走 patch 由 AI 按该风格重绘，前端不做 CSS 换皮</summary>
    public string? Theme { get; set; }

    /// <summary>生成引擎："map"（默认）或 "agent"</summary>
    public string? Engine { get; set; }

    /// <summary>期望模型（可选，仅 engine=map 生效；空 = 自动调度）</summary>
    public string? Model { get; set; }
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
