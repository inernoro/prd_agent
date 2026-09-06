using System.Text;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Api.Services;
using PrdAgent.Core.Helpers;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.Security;

using PrdAgent.Api.Services.MdToPpt;
using PrdAgent.Core.LlmGateway;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// MD 转网页 PPT。
///
/// SSE 事件协议：
///   event: start  — 会话开始
///   event: model  — data: {"model":"...","platform":"..."}  模型信息
///   event: diag   — data: {...}  诊断事件
///   event: thinking — data: {"text":"..."}  推理模型思考过程增量
///   event: delta  — data: {"text":"..."}  增量 HTML 片段
///   event: done   — data: {"html":"..."}  完整 HTML
///   event: error  — data: {"message":"..."}
///
/// 生成引擎：优先走 LLM Gateway 直出页面片段；仅对 Codex/custom/CDS Agent 运行配置保留
/// 动态容器兼容路径。大纲规划同样走 ILlmGateway。
/// </summary>
[ApiController]
[Route("api/md-to-ppt")]
[Authorize]
public class MdToPptController : ControllerBase
{
    internal const string SystemGatewayProfileId = "system-gateway-default";
    internal const int OutlineCompletionTokenBudget = 4_096;

    private readonly IInfraAgentSessionService _sessions;
    private readonly MongoDbContext _db;
    private readonly ILlmGateway _gateway;
    private readonly ILLMRequestContextAccessor _llmRequestContext;
    private readonly IInfraAgentRuntimeProfileService _runtimeProfiles;
    private readonly IDesignKnowledgeSnapshotResolver _knowledgeSnapshots;
    private readonly IConfiguration _configuration;
    private readonly ILogger<MdToPptController> _logger;

    // PPT 系统提示词（按风格主题生成不同设计系统）。
    private static string BuildPptSystemPrompt(string? theme, string? customStyleSpec = null)
    {
        // 自定义模板（用户参考图提取的风格规范）优先于官方主题：
        // 规范全文作为「本次风格」，:root 色值由模型按规范自定（模板 = 生成参照，不是换皮）
        var (tokens, tone) = string.IsNullOrWhiteSpace(customStyleSpec)
            ? ThemeTokens(theme)
            : (":root{/* 按下方「本次风格」规范自行定义 --bg --bg2 --ink --muted --line --card --a1 --a2 --a3 --orb-op 的具体取值，必须与规范一致 */}\n",
               "自定义模板（从用户上传的参考图提取的风格规范，必须严格执行）——" + customStyleSpec.Trim());
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
    // PPT 设计系统组件类（壳子 <style> 与提示词共用的 SSOT）。
    // 并行逐页生成模式下它进入文档 head，对子智能体是「可选工具箱」而非模板义务。
    private const string PptComponentCss =
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
        ".reveal .slides .orb{position:absolute !important;pointer-events:none;}\n";

    // 并行逐页模式的 deck 壳（head 确定 = 实况渲染从第一页就有真样式；脚本在尾部）
    private static (string head, string suffix) BuildDeckShell(string? theme, string title)
    {
        var (tokens, _) = ThemeTokens(theme);
        var head =
            "<!DOCTYPE html>\n<html lang=\"zh\">\n<head>\n<meta charset=\"utf-8\">\n" +
            "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n" +
            $"<title>{System.Net.WebUtility.HtmlEncode(title)}</title>\n" +
            "<link rel=\"stylesheet\" href=\"https://cdn.jsdelivr.net/npm/reveal.js@4/dist/reveal.css\">\n" +
            "<style>\n" + tokens + PptComponentCss +
            // pp-root：消毒后注入的统一内容包裹层（布局样式承接 + 溢出缩放目标）
            ".pp-root{width:100%;}\n" +
            "</style>\n</head>\n<body>\n<div class=\"reveal\">\n<div class=\"slides\">\n";
        var suffix =
            "\n</div>\n</div>\n<script src=\"https://cdn.jsdelivr.net/npm/reveal.js@4/dist/reveal.js\"></script>\n" +
            "<script>Reveal.initialize({ hash:false, transition:'fade', slideNumber:'c/t', controls:true, progress:true, center:true, margin:0.06 });\n" +
            // 溢出自适应守卫：内容高于 700px 设计框时对 .pp-root 等比缩小（兜底，不替代内容预算约束）
            "function ppFit(){var H=700;document.querySelectorAll('.reveal .slides > section').forEach(function(s){" +
            "var r=s.querySelector(':scope > .pp-root');if(!r)return;r.style.transform='';" +
            "var prev=s.style.display;s.style.display='block';var ch=r.scrollHeight;s.style.display=prev;" +
            "if(ch>H*0.99){var k=Math.max(0.55,(H*0.97)/ch);r.style.transform='scale('+k+')';r.style.transformOrigin='top center';}});" +
            "if(window.Reveal&&Reveal.layout)Reveal.layout();}\n" +
            "Reveal.on('ready',function(){setTimeout(ppFit,250);if(document.fonts&&document.fonts.ready){document.fonts.ready.then(function(){setTimeout(ppFit,80);});}});" +
            "</script>\n</body>\n</html>";
        return (head, suffix);
    }

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
            case "aurora-gradient":
                return (
                    ":root{--bg:#0a0e27;--bg2:#141937;--ink:#eef0ff;--muted:#9aa3d4;--line:rgba(154,163,212,.22);--card:rgba(99,102,241,.10);--a1:#818cf8;--a2:#38bdf8;--a3:#c084fc;--orb-op:.35;}\n" +
                    "html,body,.reveal{background:#0a0e27;}\n",
                    "极光渐变（Aurora，对标 Gamma 默认主题）——深夜蓝底（#0a0e27）+ 靛紫/天青极光光晕（.orb 必用且面积大）。" +
                    "字体：h1/h2 用 Inter 800 大字；kicker 用 .eyebrow 天青色。" +
                    ".card 用半透明靛紫底 + 1px 微光边；.stat 数字靛紫 var(--a1)；" +
                    "渐变只用于 .orb/.bar 装饰，标题实色；整体如现代 SaaS 发布会，光感通透");
            case "sunset-bold":
                return (
                    ":root{--bg:#1c1210;--bg2:#2a1a14;--ink:#fff3ec;--muted:#d9a994;--line:rgba(255,178,128,.25);--card:#2a1a14;--a1:#fb923c;--a2:#f43f5e;--a3:#fbbf24;--orb-op:.3;}\n" +
                    "html,body,.reveal{background:#1c1210;}\n",
                    "日落炽橙（Sunset Bold）——暖黑底（#1c1210）+ 炽橙/玫红强调，品牌营销气质，敢用大字。" +
                    "字体：h1/h2 用 Inter 850 超大号（可到 9vw），行高压紧；正文 Inter。" +
                    ".stat 数字炽橙 var(--a1)；.orb 用橙红双光晕；.bar 强调条必用；" +
                    "排版大胆有冲击力，大面积留黑衬托暖色，如 Spotify Wrapped/Stripe Sessions");
            case "forest-organic":
                return (
                    ":root{--bg:#f4f1e8;--bg2:#e8e2d2;--ink:#1d2b1f;--muted:#5a6b58;--line:rgba(29,43,31,.18);--card:#fffdf6;--a1:#2f6b3c;--a2:#7ba05b;--a3:#1d4428;--orb-op:0;}\n" +
                    "html,body,.reveal{background:#f4f1e8;}\n",
                    "森林有机（亮色自然系）——米色纸底（#f4f1e8）+ 深林绿（#2f6b3c），自然/ESG/健康主题。" +
                    "字体：h1/h2 用 'Noto Serif SC' 衬线（font-weight:700）；h3/h4 绿色全大写 Inter；正文 Inter。" +
                    ".card 用暖白底 + 大圆角（24px）+ 浅绿边；.stat 数字深绿；禁止光晕；" +
                    "强调用细横线与叶形圆角色块，整体温润安静如 Kinfolk 杂志");
            case "royal-velvet":
                return (
                    ":root{--bg:#17102b;--bg2:#221740;--ink:#f3eeff;--muted:#b3a6d9;--line:rgba(179,166,217,.22);--card:#221740;--a1:#d4af37;--a2:#a78bfa;--a3:#f0c75e;--orb-op:.25;}\n" +
                    "html,body,.reveal{background:#17102b;}\n",
                    "鎏金深紫（高端 keynote）——深紫绒底（#17102b）+ 鎏金强调（#d4af37），奢华而克制。" +
                    "字体：h1/h2 用 'Playfair Display' 衬线（font-weight:600，不斜体）；h3/h4 金色全大写细字 Inter；正文 Inter。" +
                    ".stat 数字鎏金 var(--a1)；.card 深紫绒底 + 金色细边（1px rgba(212,175,55,.35)）；" +
                    ".quote 左侧金色细竖条；光晕紫金双色低调使用；如奢侈品牌年度发布");
            case "ocean-glass":
                return (
                    ":root{--bg:#eaf4fb;--bg2:#d9eaf6;--ink:#0c2d48;--muted:#48708f;--line:rgba(12,45,72,.15);--card:rgba(255,255,255,.72);--a1:#0369a1;--a2:#0ea5e9;--a3:#075985;--orb-op:.2;}\n" +
                    "html,body,.reveal{background:#eaf4fb;}\n",
                    "海洋玻璃（亮色玻璃拟态）——浅蓝白底（#eaf4fb）+ 海蓝强调（#0369a1），清爽科技感。" +
                    "字体：h1/h2 用 Inter 800；h3/h4 海蓝全大写；正文 Inter。" +
                    ".card 用半透明白（rgba(255,255,255,.72)）+ backdrop-filter:blur(14px) + 1px 白边——玻璃卡是本风格签名；" +
                    ".stat 数字海蓝；.orb 用天青低透明度光晕；整体如 macOS 发布会的轻盈通透");
            case "atelier-zero":
                return (
                    ":root{--bg:#efe7d2;--bg2:#ece4cf;--ink:#15140f;--muted:#5a5448;--line:rgba(21,20,15,.18);--card:#f7f1de;--a1:#ed6f5c;--a2:#e9b94a;--a3:#6e7448;--orb-op:0;}\n" +
                    "html,body,.reveal{background:#efe7d2;}\n",
                    "工坊拼贴（Atelier Zero，源自 open-design.ai 的招牌设计系统）——暖手工纸底（#efe7d2）+ 珊瑚单热点（#ed6f5c），" +
                    "杂志级印刷质感（Monocle/Apartamento/IDEA 气质）。" +
                    "字体：大标题用 Inter 800 紧排（letter-spacing:-0.03em），其中 1-2 个情绪词用 'Playfair Display' Italic 500 斜体衬线混排在同一行——" +
                    "粗黑无衬线扛结构、斜体衬线带情绪，这是本风格的签名；每个标题句尾加珊瑚色句点（<span style=\"color:var(--a1)\">.</span>）。" +
                    "章节标用 Playfair Italic 罗马数字（I. II. III.，珊瑚色）；微注用 'JetBrains Mono' 10px 弱墨色（如坐标 52.5200 N · 13.4050 E、版号 FIG. 01 / OD-26、页码 004 / 008）。" +
                    "颜色铁律：珊瑚每页最多一个热点（CTA 或罗马数字二选一）；芥末黄 #e9b94a 只做首饰级点缀（一颗星/一个圆点）绝不做主强调；禁止纯黑（最深 #15140f）、禁止纯白底。" +
                    ".card 用骨白 #f7f1de + 18px 圆角 + 1px 墨色 6% 内描边；分隔一律 1px hairline 细线；" +
                    ".stat 数字配虚线圆环装饰；版式不对称、上重下轻、留白慷慨，如小型高工艺工作室的年报内页");
            case "kami-paper":
                return (
                    ":root{--bg:#f5f4ed;--bg2:#e8e6dc;--ink:#141413;--muted:#504e49;--line:#e5e3d8;--card:#faf9f5;--a1:#1B365D;--a2:#2D5A8A;--a3:#6b6a64;--orb-op:0;}\n" +
                    "html,body,.reveal{background:#f5f4ed;}\n",
                    "纸墨蓝（Kami 紙，open-design.ai 出品的印刷纸面系统）——羊皮纸底（#f5f4ed，绝不用纯白）+ 墨蓝单强调（#1B365D），" +
                    "高级白皮书/打字机信函质感，多语排版（中文用 'Source Han Serif SC'/'Noto Serif SC'）。" +
                    "字体铁律：层级全靠衬线单字重 500 撑——禁止加粗（700/900）、禁止斜体、禁止第二强调色；正文行高紧凑（1.4-1.55，印刷节奏）。" +
                    "墨蓝只占版面 ≤5%：章节编号、引文左侧竖线、关键指标数值——超了就俗。" +
                    "灰阶只用四级暖灰（#141413/#3d3d3a/#504e49/#6b6a64），禁止冷灰（slate 系）；" +
                    ".card 用米白 #faf9f5 + 1px ring 描边 + 极轻晕影（0 4px 24px rgba(0,0,0,.05)），禁止硬投影；" +
                    "tag/chip 底色用实色 #E4ECF5（不用 rgba）；数字一律 font-variant-numeric:tabular-nums；" +
                    "整体如好纸上印的好内容，安静、克制、像一份值得收藏的纸质提案");
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
        IInfraAgentRuntimeProfileService runtimeProfiles,
        IDesignKnowledgeSnapshotResolver knowledgeSnapshots,
        IConfiguration configuration,
        ILogger<MdToPptController> logger)
    {
        _sessions = sessions;
        _db = db;
        _gateway = gateway;
        _llmRequestContext = llmRequestContext;
        _runtimeProfiles = runtimeProfiles;
        _knowledgeSnapshots = knowledgeSnapshots;
        _configuration = configuration;
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

        IReadOnlyList<DesignKnowledgeSnapshot> knowledgeReferences;
        try
        {
            knowledgeReferences = await ResolveKnowledgeReferencesAsync(userId, req.KnowledgeReferences, HttpContext.RequestAborted);
        }
        catch (DesignKnowledgeSnapshotException ex)
        {
            return BadRequest(new { error = ex.Message, code = ex.Code });
        }

        if (string.IsNullOrWhiteSpace(req.Content))
            return BadRequest(new { error = "内容不能为空" });

        var targetPages = ResolveTargetPages(req);
        var systemPrompt =
            "你是专业 PPT 策划师。根据用户内容，输出一份 PPT 大纲（纯 JSON，不要其他任何解释和代码围栏）。\n" +
            $"目标页数：严格 {targetPages} 页，不得增减页数；totalPages 必须等于 {targetPages}，outline 数组长度也必须等于 {targetPages}。\n" +
            "输出格式：\n" +
            "{\"totalPages\":8,\"summary\":\"一句话总结本 PPT 讲什么\",\"outline\":[{\"title\":\"封面\",\"bullets\":[\"副标题\",\"作者/日期\"]},{\"title\":\"现状分析\",\"bullets\":[\"要点1\",\"要点2\",\"要点3\"]},...,{\"title\":\"结语\",\"bullets\":[\"行动号召\",\"联系方式\"]}],\"clarify\":[{\"id\":\"q1\",\"question\":\"面向投资人还是内部团队？\",\"type\":\"single\",\"options\":[\"投资人\",\"内部团队\"]}]}\n\n" +
            "严格规则：\n" +
            "1. 只输出 JSON，第一个字符是 {，最后一个字符是 }，不得有 markdown 代码块、前缀说明、后缀解释\n" +
            "2. 每页 bullets 3-5 条；每条 12-30 字、必须有具体落点（数字/对象/实例/动作），禁止「介绍背景」「展示优势」这类空壳短语；除封面/结语外每页至少 1 条数据或实例类要点\n" +
            "3. 版式不重复，避免每页都是列表结构\n" +
            "4. 禁止输出任何 emoji\n" +
            "5. title 字段纯文本，不含序号（如「一、」「1.」）\n" +
            "6. clarify 为可选字段：仅当用户需求存在会显著影响内容方向的真实歧义时给出，最多 3 题。典型必问情形：用户未指明受众（对外客户/管理层/全员）或正式程度，而这会显著改变内容侧重时，应给 1-2 题；需求已写明受众与重点时禁止出题；" +
            "type 取 single/multi/text，single/multi 必须给 options（2-5 个）。没有歧义时省略 clarify 字段，禁止为提问而提问\n" +
            "7. 用户内容里若已包含「澄清回答」段落，视为歧义已消除，不得再输出 clarify\n" +
            "8. 用户内容里若包含「当前大纲」段落，则本次是**调整任务**：只改动与调整要求直接相关的页；其余页的 title 与 bullets 必须逐字原样保留（一个字都不许改写/润色/增删/换序），输出时原文复制";

        var contextParts = new List<string>();
        if (!string.IsNullOrWhiteSpace(req.Content))
            contextParts.Add($"# 用户内容\n\n{req.Content.Trim()}");
        if (!string.IsNullOrWhiteSpace(req.AttachmentText))
            contextParts.Add($"# 附件内容\n\n{req.AttachmentText.Trim()}");
        if (knowledgeReferences.Count > 0)
            contextParts.Add(BuildKnowledgeContext(knowledgeReferences));
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
                ["max_tokens"] = OutlineCompletionTokenBudget,
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
            var normalized = NormalizeOutlinePayload(raw, targetPages);
            return Ok(normalized);
        }
        catch (JsonException)
        {
            _logger.LogWarning("[MdToPpt-Outline] JSON parse failed, raw={Raw}", raw.Length > 200 ? raw[..200] : raw);
            return StatusCode(502, new { error = "大纲 JSON 解析失败，请重试", raw });
        }
    }

    // ─────────────────────────────────────────────
    // POST /api/md-to-ppt/outline-stream（流式逐页大纲）
    // ─────────────────────────────────────────────

    /// <summary>
    /// 流式大纲（2026-06-11 用户反馈：整坨 JSON 等太久 + 大纲缺设计细节）。
    /// 模型按 JSONL 输出（首行 meta，随后每页一行），服务端逐行解析、每成功一行
    /// 立刻推 SSE——第一页几秒内可见。页级 design 字段（版式/视觉/排字）随大纲
    /// 定稿后直接喂给并行子智能体（设计意图闭环，不是摆设）。
    /// </summary>
    [HttpPost("outline-stream")]
    public async Task OutlineStream([FromBody] MdToPptOutlineRequest req)
    {
        var userId = this.GetRequiredUserId();

        IReadOnlyList<DesignKnowledgeSnapshot> knowledgeReferences;
        try
        {
            knowledgeReferences = await ResolveKnowledgeReferencesAsync(userId, req.KnowledgeReferences, HttpContext.RequestAborted);
        }
        catch (DesignKnowledgeSnapshotException ex)
        {
            Response.StatusCode = StatusCodes.Status400BadRequest;
            await Response.WriteAsJsonAsync(new { error = ex.Message, code = ex.Code }, HttpContext.RequestAborted);
            return;
        }
        SetSseHeaders();
        await WriteSsePreambleAsync();
        await WriteEventAsync("start", null);

        if (string.IsNullOrWhiteSpace(req.Content))
        {
            await WriteEventAsync("error", new { message = "内容不能为空" });
            return;
        }

        var targetPages = ResolveTargetPages(req);
        var systemPrompt =
            "你是顶级演示设计总监。根据用户内容输出 PPT 大纲，格式为 JSONL（每行一个独立 JSON 对象，行内禁止换行，输出完一行立即换行）。" +
            "不得有 markdown 围栏、前后缀解释。\n" +
            $"目标页数：严格 {targetPages} 页，不得增减页数；meta.totalPages 必须等于 {targetPages}，page 行总数也必须等于 {targetPages}。\n" +
            "第 1 行必须是 meta：\n" +
            "{\"type\":\"meta\",\"totalPages\":8,\"summary\":\"一句话总结\",\"design\":{\"palette\":\"整体配色策略（主色/强调色/底色气质，一句话）\",\"typography\":\"字体与排字策略（标题字重/正文密度/对齐，一句话）\",\"mood\":\"3-5 个气质关键词\"},\"clarify\":[{\"id\":\"q1\",\"question\":\"...\",\"type\":\"single\",\"options\":[\"...\"]}]}\n" +
            "随后每页一行：\n" +
            "{\"type\":\"page\",\"index\":1,\"title\":\"封面\",\"bullets\":[\"副标题\",\"作者/日期\"],\"design\":\"版式：左大题右装置；视觉装置：大数字看板；排字：标题 64px 级两行压缩、正文 16px；强调：单热点色用在数字\"}\n\n" +
            "严格规则：\n" +
            "1. 每页 bullets 3-5 条；每条 12-30 字、必须有具体落点（数字/对象/实例/动作），禁止「介绍背景」「展示优势」这类空壳；除封面/结语外每页至少 1 条数据或实例类要点\n" +
            "2. 每页 design 必填（30-60 字）：版式结构 + 视觉装置 + 排字策略 + 强调用法，相邻页版式必须差异化（两栏对比/大数字看板/时间线/表格/金句转场/卡片网格轮换）\n" +
            "3. 禁止任何 emoji；title 纯文本不含序号\n" +
            "4. clarify 为 meta 的可选字段：仅当需求存在显著影响内容方向的真实歧义时给出，最多 3 题（未指明受众或正式程度且显著影响内容时应给 1-2 题；需求明确时禁止出题）；type 取 single/multi/text，single/multi 必须给 options（2-5 个）\n" +
            "5. 用户内容含「澄清回答」段落 = 歧义已消除，不得再输出 clarify\n" +
            "6. 用户内容含「当前大纲」段落 = 调整任务：只改与调整要求直接相关的页；其余页 title 与 bullets 必须逐字原样保留（一个字不许改写/增删/换序），design 缺失的页补写 design 不算改动";

        var contextParts = new List<string>();
        if (!string.IsNullOrWhiteSpace(req.Content))
            contextParts.Add($"# 用户内容\n\n{req.Content.Trim()}");
        if (!string.IsNullOrWhiteSpace(req.AttachmentText))
            contextParts.Add($"# 附件内容\n\n{req.AttachmentText.Trim()}");
        if (knowledgeReferences.Count > 0)
            contextParts.Add(BuildKnowledgeContext(knowledgeReferences));
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
            SystemPromptRedacted: "[MdToPpt-OutlineStream]",
            RequestType: "chat",
            AppCallerCode: AppCallerRegistry.MdToPptAgent.Generation.Outline));

        var gatewayRequest = new GatewayRequest
        {
            AppCallerCode = AppCallerRegistry.MdToPptAgent.Generation.Outline,
            ModelType = ModelTypes.Chat,
            Stream = true,
            TimeoutSeconds = 90,
            RequestBody = new JsonObject
            {
                ["messages"] = new JsonArray
                {
                    new JsonObject { ["role"] = "system", ["content"] = systemPrompt },
                    new JsonObject { ["role"] = "user",   ["content"] = userContent },
                },
                ["temperature"] = 0.3,
                ["max_tokens"] = OutlineCompletionTokenBudget,
            },
        };

        // 服务器权威性（server-authority.md）：大纲也是一次 Run，结果落库。
        // gateway 用 CancellationToken.None + WriteEventAsync 吞断开异常 → 客户端
        // 刷新/断开后大纲仍在后台跑完并存库，前端按 runId 取回，不再"刷新即丢"。
        var run = await CreateRunAsync(userId, "agent", null, "outline", req.Content);
        await WriteEventAsync("run", new { runId = run.Id });

        var fullText = new StringBuilder();
        var lineBuf = new StringBuilder();   // 当前未闭合行
        var pendingLine = new StringBuilder(); // 解析失败的行（模型跨行输出 JSON 时拼接重试）
        var emittedPages = 0;
        var emittedMeta = false;
        // 累积到内存，done 时序列化进 run.OutlineJson（刷新恢复的数据源）
        JsonObject? metaObj = null;
        var pageArr = new JsonArray();

        async Task TryEmitLineAsync(string line)
        {
            var t = line.Trim();
            if (t.Length == 0 || t.StartsWith("```", StringComparison.Ordinal)) return;
            pendingLine.Append(t);
            var candidate = pendingLine.ToString();
            try
            {
                using var doc = JsonDocument.Parse(candidate);
                pendingLine.Clear();
                var root = doc.RootElement;
                var type = root.TryGetProperty("type", out var tp) ? tp.GetString() : null;
                if (type == "meta" && !emittedMeta)
                {
                    emittedMeta = true;
                    metaObj = JsonNode.Parse(root.GetRawText()) as JsonObject;
                    if (metaObj != null) metaObj["totalPages"] = targetPages;
                    if (metaObj != null) await WriteEventAsync("meta", metaObj);
                    else await WriteEventAsync("meta", root.Clone());
                }
                else if (type == "page")
                {
                    if (emittedPages >= targetPages) return;
                    emittedPages++;
                    if (JsonNode.Parse(root.GetRawText()) is JsonObject pg)
                    {
                        pg["index"] = emittedPages;
                        pageArr.Add(pg.DeepClone());
                        await WriteEventAsync("page", pg);
                    }
                }
            }
            catch (JsonException)
            {
                // 行不完整（模型跨行）：保留 pendingLine 等下一行拼接；超长则丢弃防失控
                if (pendingLine.Length > 8000) pendingLine.Clear();
            }
        }

        // 把累积的 meta + pages 组装成前端 outlineDraft 同形 JSON，落库供刷新恢复
        async Task PersistOutlineAsync()
        {
            try
            {
                var outline = new JsonArray();
                foreach (var p in pageArr)
                {
                    if (p is not JsonObject po) continue;
                    outline.Add(new JsonObject
                    {
                        ["title"] = po["title"]?.GetValue<string>() ?? "",
                        ["bullets"] = po["bullets"]?.DeepClone() ?? new JsonArray(),
                        ["design"] = po["design"]?.GetValue<string>(),
                    });
                }
                var payload = new JsonObject
                {
                    ["totalPages"] = metaObj?["totalPages"]?.DeepClone() ?? outline.Count,
                    ["summary"] = metaObj?["summary"]?.GetValue<string>(),
                    ["clarify"] = metaObj?["clarify"]?.DeepClone(),
                    ["outline"] = outline,
                };
                var update = Builders<MdToPptRun>.Update
                    .Set(x => x.Status, "done")
                    .Set(x => x.OutlineJson, payload.ToJsonString())
                    .Set(x => x.UpdatedAt, DateTime.UtcNow);
                await _db.MdToPptRuns.UpdateOneAsync(x => x.Id == run.Id, update, cancellationToken: CancellationToken.None);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[MdToPpt-OutlineStream] persist outline failed runId={RunId}", run.Id);
            }
        }

        try
        {
            await foreach (var chunk in _gateway.StreamAsync(gatewayRequest, CancellationToken.None))
            {
                if (chunk.Type == GatewayChunkType.Text && !string.IsNullOrEmpty(chunk.Content))
                {
                    fullText.Append(chunk.Content);
                    foreach (var ch in chunk.Content)
                    {
                        if (ch == '\n')
                        {
                            await TryEmitLineAsync(lineBuf.ToString());
                            lineBuf.Clear();
                        }
                        else lineBuf.Append(ch);
                    }
                }
                else if (chunk.Type == GatewayChunkType.Error)
                {
                    var err = chunk.Error ?? chunk.Content ?? "大纲生成失败";
                    _logger.LogError("[MdToPpt-OutlineStream] gateway error userId={UserId}: {Error}", userId, err);
                    await PersistRunErrorAsync(run, err);
                    await WriteEventAsync("error", new { message = err });
                    return;
                }
            }
            if (lineBuf.Length > 0) await TryEmitLineAsync(lineBuf.ToString());

            // 兜底：模型没按 JSONL 走（整坨 JSON）→ 按旧格式整体解析补发
            if (emittedPages == 0)
            {
                var raw = StripOutlineFences(fullText.ToString());
                try
                {
                    using var doc = JsonDocument.Parse(raw);
                    var root = doc.RootElement;
                    if (!emittedMeta)
                    {
                        var meta = new JsonObject
                        {
                            ["type"] = "meta",
                            ["totalPages"] = targetPages,
                            ["summary"] = root.TryGetProperty("summary", out var smEl) ? smEl.GetString() : null,
                        };
                        if (root.TryGetProperty("clarify", out var clEl)) meta["clarify"] = JsonNode.Parse(clEl.GetRawText());
                        metaObj = meta.DeepClone() as JsonObject;
                        emittedMeta = true;
                        await WriteEventAsync("meta", meta);
                    }
                    if (root.TryGetProperty("outline", out var olEl) && olEl.ValueKind == JsonValueKind.Array)
                    {
                        var idx = 0;
                        foreach (var pg in olEl.EnumerateArray().Take(targetPages))
                        {
                            idx++;
                            var page = new JsonObject
                            {
                                ["type"] = "page",
                                ["index"] = idx,
                                ["title"] = pg.TryGetProperty("title", out var ti) ? ti.GetString() : null,
                                ["bullets"] = pg.TryGetProperty("bullets", out var bu) ? JsonNode.Parse(bu.GetRawText()) : new JsonArray(),
                                ["design"] = pg.TryGetProperty("design", out var de) ? de.GetString() : null,
                            };
                            pageArr.Add(page.DeepClone());
                            await WriteEventAsync("page", page);
                            emittedPages++;
                        }
                    }
                }
                catch (JsonException)
                {
                    _logger.LogWarning("[MdToPpt-OutlineStream] fallback parse failed userId={UserId} len={Len}", userId, raw.Length);
                }
            }

            if (emittedPages == 0)
            {
                await PersistRunErrorAsync(run, "大纲解析失败，请重试");
                await WriteEventAsync("error", new { message = "大纲解析失败，请重试" });
                return;
            }
            await PersistOutlineAsync();
            await WriteEventAsync("done", new { pages = emittedPages, runId = run.Id });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[MdToPpt-OutlineStream] unexpected error userId={UserId}", userId);
            await PersistRunErrorAsync(run, ex.Message);
            await WriteEventAsync("error", new { message = ex.Message });
        }
    }

    private static string StripOutlineFences(string raw)
    {
        raw = raw.Trim();
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
        return raw.Trim();
    }

    internal static int ResolveTargetPages(MdToPptOutlineRequest req)
    {
        if (req.TargetPages is > 0)
            return Math.Clamp(req.TargetPages.Value, 1, 30);
        var text = string.Join("\n", new[] { req.Content, req.AttachmentText, req.ChatHistory }
            .Where(s => !string.IsNullOrWhiteSpace(s)));
        var explicitPages = ParseExplicitPageCount(text);
        return explicitPages.HasValue ? Math.Clamp(explicitPages.Value, 1, 30) : 8;
    }

    internal static int? ParseExplicitPageCount(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;
        var m = System.Text.RegularExpressions.Regex.Match(text,
            "(?:严格|共|生成|做|制作|输出|约|大约|总共)?\\s*(\\d{1,2}|[一二两三四五六七八九十]{1,3})\\s*(?:页|p|P)",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        if (!m.Success) return null;
        var raw = m.Groups[1].Value;
        if (int.TryParse(raw, out var n)) return n;
        return ParseChineseSmallNumber(raw);
    }

    /// <summary>
    /// 从精修要求中识别有限、明确的“第 N 页”语法。显式请求字段优先；这里只处理带“第”
    /// 的单页定位，不把“生成 5 页”这类总页数要求误判成第 5 页。
    /// </summary>
    internal static int? ResolvePatchSlideIndex(int? requestedIndex, string? instruction)
    {
        if (requestedIndex is >= 1 and <= 30) return requestedIndex;
        if (string.IsNullOrWhiteSpace(instruction)) return null;

        // 自然语言只在“恰好一个页面 + 内容精修”时归一成单页替换。删除、移动、交换、
        // 新增等结构操作仍交给整篇路径，避免把“删除第 3 页”错误变成重绘第 3 页。
        var matches = System.Text.RegularExpressions.Regex.Matches(
            instruction,
            "第\\s*(\\d{1,2}|[一二两三四五六七八九十]{1,3})\\s*页",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        if (matches.Count != 1) return null;

        const string pageRef = "第\\s*(?:\\d{1,2}|[一二两三四五六七八九十]{1,3})\\s*页";
        var structuralPageOperation =
            $"(?:删除|移除|复制)\\s*{pageRef}|" +
            $"{pageRef}\\s*(?:删除|移除|复制|移动|移到|移至|挪到|挪至|前移|后移|上移|下移)|" +
            "(?:新增|增加|插入)\\s*(?:一|1|两|2)?\\s*(?:个|张)?\\s*(?:新)?页|" +
            $"{pageRef}\\s*(?:之前|之后|前|后)\\s*(?:新增|增加|插入)|" +
            $"(?:交换|对调|调换)[\\s\\S]{{0,12}}{pageRef}|{pageRef}[\\s\\S]{{0,12}}(?:交换|对调|调换)|" +
            $"拆分\\s*{pageRef}\\s*为[\\s\\S]*页";
        if (System.Text.RegularExpressions.Regex.IsMatch(
                instruction,
                structuralPageOperation,
                System.Text.RegularExpressions.RegexOptions.IgnoreCase))
            return null;

        var match = matches[0];
        var raw = match.Groups[1].Value;
        var parsed = int.TryParse(raw, out var numeric) ? numeric : ParseChineseSmallNumber(raw);
        return parsed is >= 1 and <= 30 ? parsed : null;
    }

    private static int? ParseChineseSmallNumber(string raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;
        if (raw == "十") return 10;
        var digits = new Dictionary<char, int>
        {
            ['一'] = 1, ['二'] = 2, ['两'] = 2, ['三'] = 3, ['四'] = 4, ['五'] = 5,
            ['六'] = 6, ['七'] = 7, ['八'] = 8, ['九'] = 9,
        };
        var tenIdx = raw.IndexOf('十');
        if (tenIdx >= 0)
        {
            var tens = tenIdx == 0 ? 1 : digits.GetValueOrDefault(raw[0], 0);
            var ones = tenIdx == raw.Length - 1 ? 0 : digits.GetValueOrDefault(raw[^1], 0);
            var value = tens * 10 + ones;
            return value > 0 ? value : null;
        }
        if (raw.Length == 1 && digits.TryGetValue(raw[0], out var single)) return single;
        return null;
    }

    internal static JsonObject NormalizeOutlinePayload(string rawJson, int targetPages)
    {
        var root = JsonNode.Parse(rawJson) as JsonObject ?? throw new JsonException("outline root must be object");
        var outline = root["outline"] as JsonArray ?? new JsonArray();
        var normalized = new JsonArray();
        foreach (var item in outline.Take(Math.Clamp(targetPages, 1, 30)))
        {
            if (item is JsonObject obj) normalized.Add(obj.DeepClone());
        }
        root["totalPages"] = normalized.Count;
        root["outline"] = normalized;
        return root;
    }

    // ─────────────────────────────────────────────
    // 自定义模板（上传参考图 → 视觉模型提取风格规范 → 生成时作为 AI 设计参照）
    // ─────────────────────────────────────────────

    /// <summary>当前用户的自定义模板列表（官方模板在前端常量里，这里只返回自定义）</summary>
    [HttpGet("templates")]
    public async Task<IActionResult> ListTemplates()
    {
        var userId = this.GetRequiredUserId();
        var items = await _db.MdToPptTemplates
            .Find(x => x.UserId == userId)
            .SortByDescending(x => x.CreatedAt)
            .Limit(50)
            .ToListAsync();
        return Ok(items.Select(t => new
        {
            id = t.Id,
            name = t.Name,
            styleSpec = t.StyleSpec.Length > 160 ? t.StyleSpec[..160] + "…" : t.StyleSpec,
            bgColor = t.BgColor,
            accentColor = t.AccentColor,
            createdAt = t.CreatedAt,
        }));
    }

    /// <summary>
    /// 上传参考图创建自定义模板：视觉模型提取风格规范（配色 hex/字体气质/版式特征），
    /// 不存原图，只存规范文本 + 两个主色（UI 色点）。
    /// </summary>
    [HttpPost("templates")]
    public async Task<IActionResult> CreateTemplate([FromBody] MdToPptTemplateCreateRequest req)
    {
        var userId = this.GetRequiredUserId();
        var name = (req.Name ?? string.Empty).Trim();
        if (string.IsNullOrEmpty(name)) return BadRequest(new { error = "模板名不能为空" });
        if (string.IsNullOrWhiteSpace(req.ImageDataUrl) || !req.ImageDataUrl.StartsWith("data:image/", StringComparison.OrdinalIgnoreCase))
            return BadRequest(new { error = "请上传参考图（dataURL 格式）" });
        // base64 dataURL 上限 ~8MB，防止超大图打爆请求/视觉模型
        if (req.ImageDataUrl.Length > 8 * 1024 * 1024)
            return BadRequest(new { error = "参考图过大（限 6MB 以内）" });

        var count = await _db.MdToPptTemplates.CountDocumentsAsync(x => x.UserId == userId);
        if (count >= 20) return BadRequest(new { error = "自定义模板已达 20 个上限，请先删除不用的" });

        using var _ = _llmRequestContext.BeginScope(new LlmRequestContext(
            RequestId: Guid.NewGuid().ToString("N"),
            GroupId: null,
            SessionId: null,
            UserId: userId,
            ViewRole: null,
            DocumentChars: null,
            DocumentHash: null,
            SystemPromptRedacted: "[MdToPpt-TemplateExtract]",
            RequestType: "vision",
            AppCallerCode: AppCallerRegistry.MdToPptAgent.Template.Extract));

        var systemPrompt =
            "你是资深视觉设计师。分析用户上传的设计参考图，输出一份可供 AI 生成 reveal.js PPT 时严格执行的风格规范。\n" +
            "输出格式（纯文本，无 markdown 围栏）：\n" +
            "第一行固定：COLORS: #背景主色 #强调色（两个 hex，估算最接近的值）\n" +
            "随后 200-400 字规范正文，必须覆盖：背景与底色层次（hex）、文字主色与弱化色（hex）、强调色系（hex）、" +
            "字体气质（衬线/无衬线/等宽，粗细与字号节奏）、版式特征（留白、网格、对齐、装饰元素如线条/色块/光晕）、整体气质一句话。\n" +
            "禁止输出 emoji；颜色一律 hex。";

        var gatewayRequest = new GatewayRequest
        {
            AppCallerCode = AppCallerRegistry.MdToPptAgent.Template.Extract,
            ModelType = ModelTypes.Vision,
            Stream = true,
            TimeoutSeconds = 90,
            RequestBody = new JsonObject
            {
                ["messages"] = new JsonArray
                {
                    new JsonObject { ["role"] = "system", ["content"] = systemPrompt },
                    new JsonObject
                    {
                        ["role"] = "user",
                        ["content"] = new JsonArray
                        {
                            new JsonObject { ["type"] = "text", ["text"] = $"参考图名称：{name}。请提取风格规范。" },
                            new JsonObject
                            {
                                ["type"] = "image_url",
                                ["image_url"] = new JsonObject { ["url"] = req.ImageDataUrl },
                            },
                        },
                    },
                },
                ["temperature"] = 0.2,
                ["max_tokens"] = 1024,
            },
        };

        var fullText = new StringBuilder();
        string? extractModel = null;
        try
        {
            await foreach (var chunk in _gateway.StreamAsync(gatewayRequest, CancellationToken.None))
            {
                if (chunk.Type == GatewayChunkType.Start && chunk.Resolution != null)
                    extractModel = chunk.Resolution.ActualModel;
                else if (chunk.Type == GatewayChunkType.Text && !string.IsNullOrEmpty(chunk.Content))
                    fullText.Append(chunk.Content);
                else if (chunk.Type == GatewayChunkType.Error)
                {
                    var err = chunk.Error ?? chunk.Content ?? "风格提取失败";
                    _logger.LogError("[MdToPpt-Template] vision error userId={UserId}: {Error}", userId, err);
                    return StatusCode(502, new { error = "风格提取失败：" + err });
                }
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[MdToPpt-Template] extract failed userId={UserId}", userId);
            return StatusCode(500, new { error = ex.Message });
        }

        var spec = fullText.ToString().Trim();
        if (spec.Length < 40)
            return StatusCode(502, new { error = "风格提取结果过短，请换一张更清晰的参考图重试" });

        // 解析首行 COLORS: #xxx #yyy（解析失败用默认色，不阻塞创建）
        var bg = "#1a1a1e";
        var accent = "#a78bfa";
        var firstLineEnd = spec.IndexOf('\n');
        var firstLine = firstLineEnd > 0 ? spec[..firstLineEnd] : spec;
        var hexes = System.Text.RegularExpressions.Regex.Matches(firstLine, "#[0-9a-fA-F]{6}");
        if (hexes.Count >= 1) bg = hexes[0].Value;
        if (hexes.Count >= 2) accent = hexes[1].Value;

        var template = new MdToPptTemplate
        {
            UserId = userId,
            Name = name.Length > 30 ? name[..30] : name,
            StyleSpec = spec,
            BgColor = bg,
            AccentColor = accent,
            ExtractModel = extractModel,
        };
        await _db.MdToPptTemplates.InsertOneAsync(template, cancellationToken: CancellationToken.None);
        return Ok(new
        {
            id = template.Id,
            name = template.Name,
            styleSpec = template.StyleSpec.Length > 160 ? template.StyleSpec[..160] + "…" : template.StyleSpec,
            bgColor = template.BgColor,
            accentColor = template.AccentColor,
            createdAt = template.CreatedAt,
        });
    }

    /// <summary>删除自定义模板</summary>
    [HttpDelete("templates/{id}")]
    public async Task<IActionResult> DeleteTemplate(string id)
    {
        var userId = this.GetRequiredUserId();
        var result = await _db.MdToPptTemplates.DeleteOneAsync(x => x.Id == id && x.UserId == userId);
        if (result.DeletedCount == 0) return NotFound(new { error = "模板不存在" });
        return Ok(new { deleted = true });
    }

    /// <summary>按 ID 取当前用户的自定义模板（convert/patch 共用；空 ID 返回 null）</summary>
    private async Task<MdToPptTemplate?> ResolveTemplateAsync(string userId, string? templateId)
    {
        if (string.IsNullOrWhiteSpace(templateId)) return null;
        return await _db.MdToPptTemplates
            .Find(x => x.Id == templateId && x.UserId == userId)
            .FirstOrDefaultAsync();
    }

    // ─────────────────────────────────────────────
    // POST /api/md-to-ppt/prewarm
    // ─────────────────────────────────────────────

    // 预热会话缓存：userId → 已创建并启动的 CDS Agent 会话。
    // 大纲展示时前端预热，用户阅读/确认大纲的十几秒里把连接解析 + 会话创建 + 启动
    // 全部做完；Convert 到来直接复用，把 5-15s 的 Agent 环境启动开销藏进阅读时间。
    private static readonly System.Collections.Concurrent.ConcurrentDictionary<string, PrewarmEntry> PrewarmSessions = new();

    private sealed record PrewarmEntry(string SessionId, DateTime CreatedAt, string? ProfileId = null);

    private static readonly TimeSpan PrewarmTtl = TimeSpan.FromMinutes(8);

    /// <summary>
    /// 预创建并启动一个 CDS Agent 会话（幂等；失败静默——预热只是优化，绝不打扰用户）。
    /// 前端在大纲生成成功后 fire-and-forget 调用。
    /// </summary>
    /// <summary>
    /// 可选的模型运行配置列表（与基础设施页同一数据源）：PPT 页「模型」chip 的弹层数据。
    /// 用户随时切换模型（用户 2026-06-11 诉求 7），切换结果通过 convert/patch/prewarm 的
    /// runtimeProfileId 字段下发。
    /// </summary>
    [HttpGet("profiles")]
    public async Task<IActionResult> ListProfiles()
    {
        var userId = this.GetRequiredUserId();
        var visible = await ListVisibleRuntimeProfilesAsync(userId, CancellationToken.None);
        var def = await ResolveRuntimeProfileAsync(userId, CancellationToken.None);
        var profiles = visible
            .Append(CreateSystemGatewayProfile(userId))
            .GroupBy(x => x.Id, StringComparer.Ordinal)
            .Select(x => x.First());
        return Ok(profiles.Select(p => new
        {
            id = p.Id,
            name = p.Name,
            model = p.Model,
            runtime = p.Runtime,
            protocol = p.Protocol,
            isDefault = p.IsDefault,
            isEffectiveDefault = def != null && def.Id == p.Id,
            owned = p.CreatedByUserId == userId && p.Id != SystemGatewayProfileId,
        }));
    }

    /// <summary>
    /// 模型池候选（2026-06-11 用户提案：模型池配过的 baseUrl/key 不再手抄）。
    /// PPT 弹层「从模型池直选」数据源：启用的 chat 类模型 + 平台名 + 是否已物化为运行配置。
    /// 没有池调度概念——选中哪个就把哪个的配置原样传给 CDS，由 CDS 自行发请求。
    /// </summary>
    [HttpGet("pool-models")]
    public async Task<IActionResult> ListPoolModels()
    {
        var userId = this.GetRequiredUserId();
        var models = await _db.LLMModels
            .Find(x => x.Enabled && !x.IsImageGen)
            .SortByDescending(x => x.IsMain)
            .ThenBy(x => x.Priority)
            .Limit(400)
            .ToListAsync(CancellationToken.None);
        var platformIds = models.Select(m => m.PlatformId).Where(p => !string.IsNullOrEmpty(p)).Distinct().ToList();
        var platforms = await _db.LLMPlatforms
            .Find(Builders<LLMPlatform>.Filter.In(x => x.Id, platformIds))
            .ToListAsync(CancellationToken.None);
        var platformNames = platforms.ToDictionary(p => p.Id, p => p.Name);
        // 已物化为运行配置的池模型标记出来（弹层里直接显示「已就绪」）
        var profiles = await ListVisibleRuntimeProfilesAsync(userId, CancellationToken.None);
        var readyModels = profiles.Select(p => p.Model).ToHashSet(StringComparer.OrdinalIgnoreCase);

        // 凭据预检（2026-06-12 用户报「选 Qwen 报缺少 API key」）：物化运行配置需要解出
        // 平台/模型 key 的明文，部署环境的加密密钥若与存量密文不匹配会解密为空——
        // 这种模型在弹层里必须提前标记不可用并给出原因，不能让用户点了才撞 4xx。
        var platformById = platforms.ToDictionary(p => p.Id, p => p);
        string? UnavailableReason(LLMModel m)
        {
            // 已有运行配置的模型不依赖现解密（key 已物化），始终可选
            if (readyModels.Contains(m.ModelName.Trim())) return null;
            var cipher = m.ApiKeyEncrypted;
            if (string.IsNullOrWhiteSpace(cipher) && m.PlatformId != null
                && platformById.TryGetValue(m.PlatformId, out var plat))
                cipher = plat.ApiKeyEncrypted;
            if (string.IsNullOrWhiteSpace(cipher)) return "平台未配置 API key";
            if (!ApiKeyCryptoKeyRing.Decrypt(cipher, _configuration).Success)
                return "平台 API key 无法解密（部署环境数据加密密钥与存量配置不匹配），请在模型平台重新保存该平台的 key";
            return null;
        }

        return Ok(models.Select(m =>
        {
            var reason = UnavailableReason(m);
            return new
            {
                id = m.Id,
                name = m.Name,
                model = m.ModelName,
                platform = m.PlatformId != null && platformNames.TryGetValue(m.PlatformId, out var pn) ? pn : "",
                isMain = m.IsMain,
                ready = readyModels.Contains(m.ModelName.Trim()),
                available = reason == null,
                unavailableReason = reason,
            };
        }));
    }

    /// <summary>
    /// 把池内模型一键物化为运行配置（幂等）：复用平台 baseUrl/key，零手填。
    /// 返回与 GET /profiles 同形的条目，前端建完即选中。
    /// </summary>
    [HttpPost("profiles/from-pool")]
    public async Task<IActionResult> CreateProfileFromPool([FromBody] MdToPptFromPoolRequest req)
    {
        var userId = this.GetRequiredUserId();
        if (string.IsNullOrWhiteSpace(req.ModelId))
            return BadRequest(new { error = "modelId 不能为空" });
        try
        {
            var view = await _runtimeProfiles.ImportFromPoolAsync(userId, req.ModelId.Trim(), CancellationToken.None);
            return Ok(new
            {
                id = view.Id,
                name = view.Name,
                model = view.Model,
                runtime = view.Runtime,
                protocol = view.Protocol,
                isDefault = view.IsDefault,
                isEffectiveDefault = false,
                owned = true,
            });
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[MdToPpt] from-pool failed userId={UserId} modelId={ModelId}", userId, req.ModelId);
            return BadRequest(new { error = ex.Message });
        }
    }

    [HttpPost("prewarm")]
    public async Task<IActionResult> Prewarm([FromBody] MdToPptPrewarmRequest? req = null)
    {
        var userId = this.GetRequiredUserId();
        var requestedProfileId = req?.RuntimeProfileId;

        if (PrewarmSessions.TryGetValue(userId, out var existing)
            && DateTime.UtcNow - existing.CreatedAt < PrewarmTtl
            && (string.IsNullOrWhiteSpace(requestedProfileId) || existing.ProfileId == requestedProfileId))
        {
            return Ok(new { sessionId = existing.SessionId, reused = true });
        }

        var connection = await ResolveCdsConnectionAsync(CancellationToken.None);
        var profile = await ResolveRuntimeProfileAsync(userId, CancellationToken.None, requestedProfileId);
        if (profile == null) return Ok(new { sessionId = (string?)null, reason = "no_profile" });
        if (ShouldUseGatewayDirect(profile)) return Ok(new { sessionId = (string?)null, reason = "gateway_direct" });
        if (connection == null) return Ok(new { sessionId = (string?)null, reason = "no_connection" });

        try
        {
            var session = await _sessions.CreateAsync(userId,
                new CreateInfraAgentSessionRequest(
                    connection.Id,
                    profile.Runtime,
                    profile.Model,
                    "PPT 预热",
                    InfraAgentToolPolicies.DenyAll,
                    null,
                    profile.Id,
                    null,
                    null,
                    null,
                    null),
                CancellationToken.None);
            if (!string.Equals(session.Status, InfraAgentSessionStatuses.Running, StringComparison.OrdinalIgnoreCase))
            {
                session = await _sessions.StartAsync(userId, session.Id,
                    new StartInfraAgentSessionRequest(profile.Runtime, profile.Model),
                    CancellationToken.None) ?? session;
            }
            PrewarmSessions[userId] = new PrewarmEntry(session.Id, DateTime.UtcNow, profile.Id);
            _logger.LogInformation("[MdToPpt-Prewarm] session ready userId={UserId} sessionId={Id}", userId, session.Id);
            return Ok(new { sessionId = session.Id });
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[MdToPpt-Prewarm] failed userId={UserId}", userId);
            return Ok(new { sessionId = (string?)null, reason = "create_failed" });
        }
    }

    /// <summary>取走当前用户的预热会话（验证仍可用且模型配置匹配）；不可用返回 null 走全新创建路径</summary>
    private async Task<InfraAgentSessionView?> TakePrewarmedSessionAsync(string userId, string? expectedProfileId = null)
    {
        if (!PrewarmSessions.TryRemove(userId, out var entry)) return null;
        if (expectedProfileId != null && entry.ProfileId != null && entry.ProfileId != expectedProfileId)
        {
            // 预热用的不是用户现在选的模型：弃用，避免「选 A 跑 B」
            try { await _sessions.StopAsync(userId, entry.SessionId, CancellationToken.None); } catch { }
            return null;
        }
        if (DateTime.UtcNow - entry.CreatedAt >= PrewarmTtl)
        {
            // 过期预热：后台停掉，不阻塞本次生成
            try { await _sessions.StopAsync(userId, entry.SessionId, CancellationToken.None); } catch { }
            return null;
        }
        try
        {
            var session = await _sessions.GetAsync(userId, entry.SessionId, CancellationToken.None);
            if (session != null
                && (string.Equals(session.Status, InfraAgentSessionStatuses.Running, StringComparison.OrdinalIgnoreCase)
                    || string.Equals(session.Status, InfraAgentSessionStatuses.Idle, StringComparison.OrdinalIgnoreCase)))
            {
                return session;
            }
        }
        catch { /* 预热会话不可用就走全新创建，不能让优化路径影响主流程 */ }
        return null;
    }

    // ─────────────────────────────────────────────
    // GET /api/md-to-ppt/connection-status
    // ─────────────────────────────────────────────

    /// <summary>
    /// 当前是否存在可用的 active CDS 连接。openai-compatible 配置优先走 LLM Gateway 直出；
    /// 前端只把它作为 CDS Agent 兼容路径的状态提示。
    /// </summary>
    [HttpGet("connection-status")]
    public async Task<IActionResult> ConnectionStatus()
    {
        var connection = await ResolveCdsConnectionAsync(CancellationToken.None);
        return Ok(new { connected = connection != null });
    }

    // ─────────────────────────────────────────────
    // POST /api/md-to-ppt/convert
    // ─────────────────────────────────────────────

    /// <summary>将 Markdown 转换为 reveal.js HTML PPT（SSE 流式返回）</summary>
    [HttpPost("convert")]
    public async Task Convert([FromBody] MdToPptConvertRequest req)
    {
        var userId = this.GetRequiredUserId();

        IReadOnlyList<DesignKnowledgeSnapshot> knowledgeReferences;
        try
        {
            knowledgeReferences = await ResolveKnowledgeReferencesAsync(userId, req.KnowledgeReferences, HttpContext.RequestAborted);
        }
        catch (DesignKnowledgeSnapshotException ex)
        {
            Response.StatusCode = StatusCodes.Status400BadRequest;
            await Response.WriteAsJsonAsync(new { error = ex.Message, code = ex.Code }, HttpContext.RequestAborted);
            return;
        }

        var authoritativeContent = knowledgeReferences.Count == 0
            ? req.Content
            : string.Join("\n\n---\n\n", new[]
            {
                req.Content?.Trim(),
                BuildKnowledgeContext(knowledgeReferences),
            }.Where(part => !string.IsNullOrWhiteSpace(part)));
        req.Content = authoritativeContent;
        SetSseHeaders();
        await WriteSsePreambleAsync();
        await WriteEventAsync("start", null);

        var template = await ResolveTemplateAsync(userId, req.TemplateId);
        var run = await CreateRunAsync(
            userId,
            "agent",
            template != null ? $"custom:{template.Name}" : req.Theme,
            "convert",
            req.Content,
            knowledgeReferences.Count > 0
                ? DesignArtifactSourceSurfaces.KnowledgeBase
                : DesignArtifactSourceSurfaces.HtmlPpt,
            knowledgeReferences.ToList());
        await WriteEventAsync("run", new { runId = run.Id });

        // 并行逐页编排（用户 2026-06-11 架构提案）：大纲定稿 → 壳子确定（设计系统）→
        // 子智能体并行各画一页 → 每页完成即推 page 事件（真实进度 + 实况渲染）→ 拼装。
        // 自定义模板暂走整篇路径（壳子 token 需先从风格规范物化，记 debt）。
        if (req.OutlinePages is { Count: > 0 } && template == null)
        {
            await RunPagesGenerationAsync(userId, req, run);
            return;
        }

        var systemPrompt = BuildPptSystemPrompt(req.Theme, template?.StyleSpec);
        var styleHint = $"目标页数约 {req.SlideCount ?? 8} 页。";
        var userContent = $"{styleHint}\n\n---\n\n# 用户内容\n\n{req.Content?.Trim()}";

        await RunAgentStreamAsync(userId, systemPrompt, userContent, "PPT", run, req.RuntimeProfileId);
    }

    // ─────────────────────────────────────────────
    // POST /api/md-to-ppt/patch
    // ─────────────────────────────────────────────

    /// <summary>根据用户指令修改已有 HTML PPT（SSE 流式返回）</summary>
    [HttpPost("patch")]
    public async Task Patch([FromBody] MdToPptPatchRequest req)
    {
        var userId = this.GetRequiredUserId();

        if (string.IsNullOrWhiteSpace(req.ParentRunId))
        {
            Response.StatusCode = StatusCodes.Status400BadRequest;
            await Response.WriteAsJsonAsync(new
            {
                error = "精修来源版本为空，请恢复演示稿后重试",
                code = "parent_run_required",
            }, HttpContext.RequestAborted);
            return;
        }

        var parentRun = await _db.MdToPptRuns
            .Find(item => item.Id == req.ParentRunId.Trim() && item.UserId == userId)
            .FirstOrDefaultAsync(HttpContext.RequestAborted);
        if (parentRun == null)
        {
            Response.StatusCode = StatusCodes.Status400BadRequest;
            await Response.WriteAsJsonAsync(new
            {
                error = "精修来源任务不存在，请从当前生成结果重新发起",
                code = ErrorCodes.NOT_FOUND,
            }, HttpContext.RequestAborted);
            return;
        }
        if (parentRun.Status != "done" || !IsRunnableDeckDocument(parentRun.Html))
        {
            Response.StatusCode = StatusCodes.Status409Conflict;
            await Response.WriteAsJsonAsync(new
            {
                error = "精修来源任务尚未形成完整演示稿，请恢复完成态版本后重试",
                code = "parent_run_not_ready",
            }, HttpContext.RequestAborted);
            return;
        }
        if (string.IsNullOrWhiteSpace(req.CurrentHtml)
            || !HtmlMatchesHash(req.CurrentHtml, parentRun.HtmlHash ?? ComputeHtmlHash(parentRun.Html)))
        {
            Response.StatusCode = StatusCodes.Status409Conflict;
            await Response.WriteAsJsonAsync(new
            {
                error = "当前演示稿与精修来源版本不一致，请刷新恢复后再修改",
                code = "parent_html_mismatch",
            }, HttpContext.RequestAborted);
            return;
        }
        req.CurrentHtml = parentRun.Html;
        var provenance = InheritPatchProvenance(parentRun);
        SetSseHeaders();
        await WriteSsePreambleAsync();
        await WriteEventAsync("start", null);

        var template = await ResolveTemplateAsync(userId, req.TemplateId);
        var run = await CreateRunAsync(
            userId,
            "agent",
            template != null ? $"custom:{template.Name}" : req.Theme,
            "patch",
            req.SlideRequest,
            provenance.SourceSurface,
            provenance.KnowledgeReferences,
            parentRun?.Id,
            parentRun == null ? null : parentRun.HtmlHash ?? ComputeHtmlHash(parentRun.Html));
        await WriteEventAsync("run", new { runId = run.Id });

        // 定向单页 patch（2026-06-11 诉求 4「重绘本页」）：只把目标页交给一个子智能体
        // 重画并在服务端原位替换——不再把整份 58KB HTML 喂给模型重出（旧路径实测 7 分钟+）。
        var effectiveSlideIndex = ResolvePatchSlideIndex(req.SlideIndex, req.SlideRequest);
        if (effectiveSlideIndex.HasValue && !string.IsNullOrEmpty(req.CurrentHtml))
        {
            var handled = await TryRunSinglePagePatchAsync(userId, req, run, effectiveSlideIndex.Value, template);
            if (handled) return;
        }

        // 风格/模板随 patch 下发：换风格 = AI 参照该风格重绘整页 HTML（设计 token、
        // 字体、版式气质都在系统提示词里），不是前端套一层 CSS 换皮。
        var systemPrompt = BuildPptSystemPrompt(req.Theme, template?.StyleSpec);
        // 显式字段与“第 N 页”自然语言都归一为 1-based，不能再 +1（否则输入 3 会改成第 4 页）；
        // 未识别到明确页码时语义是整份 PPT，不能写成“第 0 页”。
        var pageHint = effectiveSlideIndex.HasValue
            ? $"（仅修改第 {effectiveSlideIndex.Value} 页）"
            : "（未指定具体页，按要求修改整份 PPT）";
        var userContent = $"---\n\n# 已有 HTML\n\n```html\n{req.CurrentHtml?.Trim()}\n```\n\n# 修改要求{pageHint}\n\n{req.SlideRequest?.Trim()}";

        await RunAgentStreamAsync(userId, systemPrompt, userContent, "PPT 修改", run, req.RuntimeProfileId);
    }

    // ─────────────────────────────────────────────
    // POST /api/md-to-ppt/runs/{parentRunId}/local-edit
    // ─────────────────────────────────────────────

    /// <summary>把浏览器内的直接编辑保存为一条新的权威运行版本。</summary>
    [HttpPost("runs/{parentRunId}/local-edit")]
    public async Task<IActionResult> PersistLocalEdit(string parentRunId, [FromBody] MdToPptLocalEditRequest req)
    {
        var userId = this.GetRequiredUserId();
        var normalizedParentRunId = parentRunId.Trim();
        if (string.IsNullOrWhiteSpace(normalizedParentRunId))
            return BadRequest(ApiResponse<object>.Fail("parent_run_required", "编辑来源版本为空，请恢复演示稿后重试"));

        var parentRun = await _db.MdToPptRuns
            .Find(item => item.Id == normalizedParentRunId && item.UserId == userId)
            .FirstOrDefaultAsync(HttpContext.RequestAborted);
        if (parentRun == null)
            return NotFound(ApiResponse<object>.Fail("ppt_run_not_found", "编辑来源版本不存在，请恢复演示稿后重试"));
        if (parentRun.Status != "done" || !IsRunnableDeckDocument(parentRun.Html))
            return Conflict(ApiResponse<object>.Fail("parent_run_not_ready", "编辑来源版本尚未完成，请恢复完成态演示稿后重试"));

        var editedHtml = req.HtmlContent?.Trim();
        if (string.IsNullOrWhiteSpace(editedHtml) || !IsRunnableDeckDocument(editedHtml))
            return BadRequest(ApiResponse<object>.Fail("incomplete_ppt_html", "编辑内容不完整，未保存。当前完成态版本仍然保留"));
        editedHtml = NormalizePresentationDocument(editedHtml);

        var parentHtmlHash = parentRun.HtmlHash ?? ComputeHtmlHash(parentRun.Html);
        var editedHtmlHash = ComputeHtmlHash(editedHtml);
        if (string.Equals(parentHtmlHash, editedHtmlHash, StringComparison.OrdinalIgnoreCase))
        {
            return Ok(new
            {
                runId = parentRun.Id,
                parentRunId = parentRun.ParentRunId,
                html = parentRun.Html,
                contentHash = parentHtmlHash,
                unchanged = true,
            });
        }

        var provenance = InheritPatchProvenance(parentRun);
        var run = await CreateRunAsync(
            userId,
            "map",
            parentRun.Theme,
            "manual-edit",
            parentRun.Title,
            provenance.SourceSurface,
            provenance.KnowledgeReferences,
            parentRun.Id,
            parentHtmlHash);
        run.Title = parentRun.Title;
        if (!await PersistRunDoneAsync(run, editedHtml, "人工编辑", "浏览器编辑器"))
        {
            return StatusCode(StatusCodes.Status500InternalServerError,
                ApiResponse<object>.Fail("local_edit_persist_failed", "编辑版本保存失败，当前完成态版本仍然保留，请重试"));
        }

        return Ok(new
        {
            runId = run.Id,
            parentRunId = run.ParentRunId,
            html = run.Html,
            contentHash = run.HtmlHash,
            unchanged = false,
        });
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
            return BadRequest(ApiResponse<object>.Fail(
                "empty_ppt_html",
                "PPT 内容为空，未发布。请先生成或恢复一份完整演示稿"));

        if (!IsRunnableDeckDocument(req.HtmlContent))
        {
            return BadRequest(ApiResponse<object>.Fail(
                "incomplete_ppt_html",
                "PPT 内容不完整，未发布。请保留当前演示稿并重新生成或精修"));
        }

        if (string.IsNullOrWhiteSpace(req.RunId))
            return BadRequest(ApiResponse<object>.Fail("ppt_run_required", "发布来源版本为空，请恢复演示稿后重试"));

        var normalizedRunId = req.RunId.Trim();
        var sourceRun = await _db.MdToPptRuns
            .Find(x => x.Id == normalizedRunId && x.UserId == userId)
            .FirstOrDefaultAsync(HttpContext.RequestAborted);
        if (sourceRun == null)
            return NotFound(ApiResponse<object>.Fail("ppt_run_not_found", "发布来源任务不存在，请从当前演示稿重新发布"));
        if (sourceRun.Status != "done" || !IsRunnableDeckDocument(sourceRun.Html))
            return Conflict(ApiResponse<object>.Fail("ppt_run_not_ready", "发布来源任务尚未完成，请等待生成结束后再发布"));

        var sourceHash = sourceRun.HtmlHash ?? ComputeHtmlHash(sourceRun.Html);
        var fontOnlySourceHtml = EnsurePresentationFontLinks(sourceRun.Html);
        var fontOnlySourceHash = ComputeHtmlHash(fontOnlySourceHtml);
        var normalizedSourceHtml = NormalizePresentationDocument(sourceRun.Html);
        if (MdToPptAnchors.HasUnresolvedRuntimeReference(normalizedSourceHtml))
        {
            return StatusCode(StatusCodes.Status500InternalServerError,
                ApiResponse<object>.Fail("ppt_runtime_unavailable", "历史版本运行时暂时不可用，原版本仍然保留，请稍后重试"));
        }
        var normalizedSourceHash = ComputeHtmlHash(normalizedSourceHtml);
        if (!HtmlMatchesHash(req.HtmlContent, sourceHash)
            && !HtmlMatchesHash(req.HtmlContent, fontOnlySourceHash)
            && !HtmlMatchesHash(req.HtmlContent, normalizedSourceHash))
            return Conflict(ApiResponse<object>.Fail("ppt_html_mismatch", "当前内容与完成态版本不一致，请先完成精修或恢复后再发布"));

        // 历史版本若缺字体，只允许这一种确定性规范化，并另存为派生运行；
        // 原版本保持不可变，任意其他 HTML 仍会被上面的哈希绑定拒绝。
        var authoritativeHtml = normalizedSourceHtml;
        if (!string.Equals(sourceHash, normalizedSourceHash, StringComparison.OrdinalIgnoreCase))
        {
            var normalizedRun = await ResolveReadableHistoricalRunAsync(userId, sourceRun);
            if (normalizedRun == null)
            {
                return StatusCode(StatusCodes.Status500InternalServerError,
                    ApiResponse<object>.Fail("ppt_normalize_failed", "历史版本运行时固化失败，原版本仍然保留，请重试"));
            }
            normalizedRunId = normalizedRun.Id;
            authoritativeHtml = normalizedRun.Html;
        }

        var publishedHtmlHash = ComputeHtmlHash(authoritativeHtml);
        var title = string.IsNullOrWhiteSpace(req.Title) ? "PPT 幻灯片" : req.Title.Trim();
        var htmlBytes = Encoding.UTF8.GetBytes(authoritativeHtml);

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

        var runFilter = Builders<MdToPptRun>.Filter.And(
            Builders<MdToPptRun>.Filter.Eq(x => x.Id, normalizedRunId),
            Builders<MdToPptRun>.Filter.Eq(x => x.UserId, userId));
        await _db.MdToPptRuns.UpdateOneAsync(
            runFilter,
            Builders<MdToPptRun>.Update
                .Set(x => x.PublishedSiteId, site.Id)
                .Set(x => x.PublishedHtmlHash, publishedHtmlHash)
                .Set(x => x.UpdatedAt, DateTime.UtcNow),
            cancellationToken: CancellationToken.None);
        await _db.DesignArtifactRuns.UpdateOneAsync(
            x => x.Id == normalizedRunId && x.UserId == userId,
            Builders<DesignArtifactRun>.Update
                .Set(x => x.ArtifactSiteId, site.Id)
                .Set(x => x.UpdatedAt, DateTime.UtcNow),
            cancellationToken: CancellationToken.None);

        return Ok(new
        {
            runId = normalizedRunId,
            siteId = site.Id,
            title = site.Title,
            siteUrl = site.SiteUrl,
            html = authoritativeHtml,
            contentHash = publishedHtmlHash,
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
        if (run.Status == "done" && IsRunnableDeckDocument(run.Html))
        {
            var readableRun = await ResolveReadableHistoricalRunAsync(userId, run);
            if (readableRun == null)
            {
                return StatusCode(StatusCodes.Status500InternalServerError, new
                {
                    error = "历史版本运行时暂时不可用，原版本仍然保留，请稍后重试",
                    code = "ppt_runtime_unavailable",
                });
            }
            run = readableRun;
        }
        var invalidSavedDeck = run.Status == "done" &&
                               run.Op is "convert" or "patch" or "manual-edit" or "normalize" &&
                               !IsRunnableDeckDocument(run.Html);
        return Ok(new
        {
            id = run.Id,
            status = invalidSavedDeck ? "error" : run.Status,
            engine = run.Engine,
            runtime = run.Runtime,
            provider = run.Provider,
            op = run.Op,
            parentRunId = run.ParentRunId,
            parentHtmlHash = run.ParentHtmlHash,
            title = run.Title,
            html = invalidSavedDeck ? null : run.Html,
            outlineJson = run.OutlineJson,
            sourceSurface = run.SourceSurface,
            knowledgeReferences = run.KnowledgeReferences.Select(x => new
            {
                x.EntryId,
                x.StoreId,
                x.StoreName,
                x.Title,
                x.ContentHash,
            }),
            publishedSiteId = run.PublishedSiteId,
            htmlHash = run.HtmlHash,
            publishedHtmlHash = run.PublishedHtmlHash,
            error = invalidSavedDeck
                ? "保存的演示稿不完整，已停止恢复。请重新生成或从上一版本继续"
                : run.Error,
            model = run.Model,
            platform = run.Platform,
            resolvedModels = run.ResolvedModels,
            resolvedPlatforms = run.ResolvedPlatforms,
            degraded = run.Degraded,
            total = run.Total,
            createdAt = run.CreatedAt,
            updatedAt = run.UpdatedAt,
        });
    }

    /// <summary>
    /// 历史记录可能仍引用已不存在的相对运行时，或缺少固化字体。
    /// 读取时复用服务端唯一规范化器并返回不可变派生版本，使预览、下载、精修和发布共享同一 runId 与哈希。
    /// </summary>
    private async Task<MdToPptRun?> ResolveReadableHistoricalRunAsync(string userId, MdToPptRun sourceRun)
    {
        var sourceHash = sourceRun.HtmlHash ?? ComputeHtmlHash(sourceRun.Html);
        var normalizedHtml = NormalizePresentationDocument(sourceRun.Html);
        if (MdToPptAnchors.HasUnresolvedRuntimeReference(normalizedHtml)) return null;

        var normalizedHash = ComputeHtmlHash(normalizedHtml);
        if (string.Equals(sourceHash, normalizedHash, StringComparison.OrdinalIgnoreCase)) return sourceRun;

        var existing = await _db.MdToPptRuns
            .Find(item => item.UserId == userId
                          && item.Status == "done"
                          && item.Op == "normalize"
                          && item.ParentRunId == sourceRun.Id
                          && item.ParentHtmlHash == sourceHash
                          && item.HtmlHash == normalizedHash)
            .SortByDescending(item => item.UpdatedAt)
            .FirstOrDefaultAsync(HttpContext.RequestAborted);
        if (existing != null) return existing;

        var provenance = InheritPatchProvenance(sourceRun);
        var normalizedRun = await CreateRunAsync(
            userId,
            "map",
            sourceRun.Theme,
            "normalize",
            sourceRun.Title,
            provenance.SourceSurface,
            provenance.KnowledgeReferences,
            sourceRun.Id,
            sourceHash);
        normalizedRun.Title = sourceRun.Title;
        normalizedRun.ResolvedModels = sourceRun.ResolvedModels.ToList();
        normalizedRun.ResolvedPlatforms = sourceRun.ResolvedPlatforms.ToList();
        return await PersistRunDoneAsync(
            normalizedRun,
            normalizedHtml,
            sourceRun.Model,
            sourceRun.Platform,
            sourceRun.Degraded,
            sourceRun.Total)
                ? normalizedRun
                : null;
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
            runtime = r.Runtime,
            provider = r.Provider,
            op = r.Op,
            title = r.Title,
            contentPreview = r.ContentPreview,
            hasHtml = !string.IsNullOrEmpty(r.Html) && IsRunnableDeckDocument(r.Html),
            sourceSurface = r.SourceSurface,
            knowledgeCount = r.KnowledgeReferences.Count,
            parentRunId = r.ParentRunId,
            publishedSiteId = r.PublishedSiteId,
            model = r.Model,
            platform = r.Platform,
            resolvedModels = r.ResolvedModels,
            resolvedPlatforms = r.ResolvedPlatforms,
            createdAt = r.CreatedAt,
        }));
    }

    private async Task<MdToPptRun> CreateRunAsync(
        string userId,
        string engine,
        string? theme,
        string op,
        string? content,
        string? sourceSurface = null,
        List<DesignKnowledgeSnapshot>? knowledgeReferences = null,
        string? parentRunId = null,
        string? parentHtmlHash = null)
    {
        var run = new MdToPptRun
        {
            UserId = userId,
            Status = "running",
            Engine = engine,
            Runtime = DesignArtifactRuntimes.HtmlPptPipeline,
            Provider = "open-design-html-ppt",
            Theme = theme ?? string.Empty,
            Op = op,
            ParentRunId = string.IsNullOrWhiteSpace(parentRunId) ? null : parentRunId.Trim(),
            ParentHtmlHash = string.IsNullOrWhiteSpace(parentHtmlHash) ? null : parentHtmlHash.Trim(),
            Title = DeriveTitle(content, op),
            ContentPreview = (content ?? string.Empty).Trim() is { Length: > 0 } cp
                ? (cp.Length > 200 ? cp[..200] : cp)
                : string.Empty,
            SourceSurface = sourceSurface == DesignArtifactSourceSurfaces.KnowledgeBase
                ? DesignArtifactSourceSurfaces.KnowledgeBase
                : DesignArtifactSourceSurfaces.HtmlPpt,
            KnowledgeReferences = knowledgeReferences ?? new List<DesignKnowledgeSnapshot>(),
        };
        await _db.MdToPptRuns.InsertOneAsync(run, cancellationToken: CancellationToken.None);
        if (op is "convert" or "patch" or "manual-edit" or "normalize")
        {
            var isGenerate = op == "convert";
            var isSavedEdit = op is "manual-edit" or "normalize";
            await _db.DesignArtifactRuns.InsertOneAsync(new DesignArtifactRun
            {
                Id = run.Id,
                UserId = userId,
                Status = RunStatuses.Running,
                ArtifactType = DesignArtifactTypes.HtmlPpt,
                Operation = isGenerate ? DesignArtifactOperations.Generate : DesignArtifactOperations.Edit,
                SourceSurface = run.SourceSurface,
                Runtime = DesignArtifactRuntimes.HtmlPptPipeline,
                // 完整正文已经由 MdToPptRun 持有；通用运行记录只保留可检索摘要，避免重复放大 Mongo 文档。
                Instruction = (content ?? string.Empty).Length > 4_000
                    ? (content ?? string.Empty)[..4_000]
                    : content ?? string.Empty,
                Title = run.Title,
                LinkedRunId = run.Id,
                KnowledgeReferences = run.KnowledgeReferences,
                Progress = isSavedEdit ? 90 : 5,
                Phase = op == "normalize" ? "HTML PPT 历史版本正在兼容固化" : op == "manual-edit" ? "HTML PPT 编辑版本正在保存" : isGenerate ? "HTML PPT 正在生成" : "HTML PPT 正在精修",
            }, cancellationToken: CancellationToken.None);
        }
        return run;
    }

    internal static (string SourceSurface, List<DesignKnowledgeSnapshot> KnowledgeReferences)
        InheritPatchProvenance(MdToPptRun? parentRun)
    {
        if (parentRun == null)
            return (DesignArtifactSourceSurfaces.HtmlPpt, new List<DesignKnowledgeSnapshot>());

        var sourceSurface = parentRun.SourceSurface == DesignArtifactSourceSurfaces.KnowledgeBase
            && parentRun.KnowledgeReferences.Count > 0
                ? DesignArtifactSourceSurfaces.KnowledgeBase
                : DesignArtifactSourceSurfaces.HtmlPpt;
        return (sourceSurface, parentRun.KnowledgeReferences.Select(item => new DesignKnowledgeSnapshot
        {
            EntryId = item.EntryId,
            StoreId = item.StoreId,
            StoreName = item.StoreName,
            Title = item.Title,
            Content = item.Content,
            ContentHash = item.ContentHash,
        }).ToList());
    }

    private async Task<bool> PersistRunDoneAsync(MdToPptRun run, string html, string? model, string? platform, int degraded = 0, int total = 0)
    {
        try
        {
            html = NormalizePresentationDocument(html);
            if (MdToPptAnchors.HasUnresolvedRuntimeReference(html))
            {
                _logger.LogError("[MdToPpt] trusted presentation runtime unavailable runId={Id}", run.Id);
                return false;
            }
            run.Status = "done";
            run.Html = html;
            run.HtmlHash = ComputeHtmlHash(html);
            run.Model = model;
            run.Platform = platform;
            if (run.Op is not ("manual-edit" or "normalize") && run.ResolvedModels.Count == 0 && !string.IsNullOrWhiteSpace(model))
                run.ResolvedModels.Add(model.Trim());
            if (run.Op is not ("manual-edit" or "normalize") && run.ResolvedPlatforms.Count == 0 && !string.IsNullOrWhiteSpace(platform))
                run.ResolvedPlatforms.Add(platform.Trim());
            run.Degraded = degraded;
            run.Total = total;
            run.UpdatedAt = DateTime.UtcNow;
            await _db.MdToPptRuns.ReplaceOneAsync(x => x.Id == run.Id, run, cancellationToken: CancellationToken.None);
            await _db.DesignArtifactRuns.UpdateOneAsync(
                x => x.Id == run.Id,
                Builders<DesignArtifactRun>.Update
                    .Set(x => x.Status, RunStatuses.Done)
                    .Set(x => x.Progress, 100)
                    .Set(x => x.Phase, run.Op == "normalize" ? "HTML PPT 历史版本已兼容固化" : run.Op == "manual-edit" ? "HTML PPT 编辑版本已保存" : run.Op == "patch" ? "HTML PPT 已精修" : "HTML PPT 已生成")
                    .Set(x => x.CompletedAt, DateTime.UtcNow)
                    .Set(x => x.UpdatedAt, DateTime.UtcNow),
                cancellationToken: CancellationToken.None);
            return true;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[MdToPpt] persist run done failed runId={Id}", run.Id);
            return false;
        }
    }

    internal static string ComputeHtmlHash(string html)
        => System.Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(html ?? string.Empty))).ToLowerInvariant();

    internal static bool HtmlMatchesHash(string html, string expectedHash)
        => !string.IsNullOrWhiteSpace(expectedHash)
           && string.Equals(ComputeHtmlHash(html), expectedHash.Trim(), StringComparison.OrdinalIgnoreCase);

    internal static string EnsurePresentationFontLinks(string html)
    {
        if (string.IsNullOrWhiteSpace(html)
            || html.Contains("data-mdppt-fonts", StringComparison.OrdinalIgnoreCase))
            return html;

        const string fontLink = "<link data-mdppt-fonts rel=\"stylesheet\" href=\"https://fonts.googleapis.com/css2?family=Bebas+Neue&amp;family=Caveat:wght@400;600&amp;family=Cormorant+Garamond:ital,wght@0,400;0,500;0,700;1,400;1,500&amp;family=Courier+Prime:wght@400;700&amp;family=DM+Mono:wght@400;500&amp;family=DM+Sans:wght@400;500;700&amp;family=Hanken+Grotesk:wght@400;500;600;700;800&amp;family=Inter:wght@400;500;600;700;800;900&amp;family=JetBrains+Mono:wght@400;500;700&amp;family=Jost:wght@300;400;500;600&amp;family=Libre+Baskerville:ital,wght@0,400;0,700;1,400&amp;family=Lora:ital,wght@0,400;0,600;1,400&amp;family=Newsreader:ital,wght@0,400;0,500;1,300;1,400&amp;family=Noto+Sans+SC:wght@400;500;700&amp;family=Noto+Serif+SC:wght@300;400;700&amp;family=Playfair+Display:ital,wght@0,400;0,700;0,800;1,400;1,600&amp;family=Shrikhand&amp;family=Space+Grotesk:wght@300;400;500;600;700&amp;family=Work+Sans:wght@400;500;600;700&amp;display=swap\">";
        var headClose = System.Text.RegularExpressions.Regex.Match(
            html,
            "</head\\s*>",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase,
            TimeSpan.FromSeconds(1));
        return headClose.Success ? html.Insert(headClose.Index, fontLink + "\n") : html;
    }

    internal static string NormalizePresentationDocument(string html) =>
        EnsurePresentationFontLinks(MdToPptAnchors.EnsureEmbeddedRuntime(html));

    private async Task PersistRunErrorAsync(MdToPptRun run, string error)
    {
        try
        {
            run.Status = "error";
            run.Error = error;
            run.UpdatedAt = DateTime.UtcNow;
            await _db.MdToPptRuns.ReplaceOneAsync(x => x.Id == run.Id, run, cancellationToken: CancellationToken.None);
            await _db.DesignArtifactRuns.UpdateOneAsync(
                x => x.Id == run.Id,
                Builders<DesignArtifactRun>.Update
                    .Set(x => x.Status, RunStatuses.Error)
                    .Set(x => x.Error, error)
                    .Set(x => x.Phase, error)
                    .Set(x => x.CompletedAt, DateTime.UtcNow)
                    .Set(x => x.UpdatedAt, DateTime.UtcNow),
                cancellationToken: CancellationToken.None);
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

    private Task<IReadOnlyList<DesignKnowledgeSnapshot>> ResolveKnowledgeReferencesAsync(
        string userId,
        List<MdToPptKnowledgeReferenceRequest>? references,
        CancellationToken ct) => _knowledgeSnapshots.ResolveAsync(
            userId,
            (references ?? new List<MdToPptKnowledgeReferenceRequest>())
                .Select(item => new DesignKnowledgeReferenceIdentity(
                    item.EntryId?.Trim() ?? string.Empty,
                    item.StoreId?.Trim() ?? string.Empty))
                .ToList(),
            ct);

    private static string BuildKnowledgeContext(IReadOnlyList<DesignKnowledgeSnapshot> references) =>
        "# 服务端校验的知识库内容\n\n" + string.Join(
            "\n\n---\n\n",
            references.Select(item =>
                $"## 知识库「{item.StoreName}」>「{item.Title}」\n\n{item.Content}"));

    // ─────────────────────────────────────────────
    // CDS Agent 路径（可观测，诊断插桩）
    // ─────────────────────────────────────────────

    // ─────────────────────────────────────────────
    // 并行逐页编排：壳子确定 → 子智能体并行各画一页 → page 事件实时进度 → 拼装
    // ─────────────────────────────────────────────

    internal static bool IsConsoleDashboardBrief(string? content, string? summary = null)
    {
        var text = ((content ?? string.Empty) + "\n" + (summary ?? string.Empty)).ToLowerInvariant();
        return text.Contains("控制台")
            || text.Contains("操作面板")
            || text.Contains("仪表盘")
            || text.Contains("dashboard")
            || text.Contains("console")
            || text.Contains("工作台");
    }

    internal static string EffectiveThemeForRequest(string? theme, string? content, string? summary = null)
    {
        var t = (theme ?? string.Empty).Trim().ToLowerInvariant();
        if (!IsConsoleDashboardBrief(content, summary)) return theme ?? "tech-dark";
        if (t is "aurora-gradient" or "tech-dark" or "cobalt-grid") return t;
        return "cobalt-grid";
    }

    internal static bool LooksLikeConsoleVisualMismatch(string fragment, string? anchorName = null)
    {
        if (string.IsNullOrWhiteSpace(fragment)) return true;
        var anchor = (anchorName ?? string.Empty).Trim().ToLowerInvariant();
        if (anchor is "soft-editorial" or "vellum" or "bold-poster" or "retro-zine" or "grove" or "coral" or "monochrome")
            return true;

        var t = fragment.ToLowerInvariant();
        if (System.Text.RegularExpressions.Regex.IsMatch(t,
                "(playfair|newsreader|cursive|calligraphy|handwriting|font-style\\s*:\\s*italic|poster|zine|vellum|editorial)"))
            return true;
        if (!System.Text.RegularExpressions.Regex.IsMatch(t, "class\\s*=\\s*['\"][^'\"]*console-dashboard[^'\"]*['\"]"))
            return true;

        var operationalTokens = System.Text.RegularExpressions.Regex.Matches(t,
            "(console-dashboard|panel|metric|kpi|queue|task|status|preview|card|grid|flow|step|progress|publish|任务队列|预览|发布状态|指标|流程)",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase).Count;
        return operationalTokens < 3;
    }

    private static string BuildConsoleDashboardGuard(string? content, string? summary)
    {
        if (!IsConsoleDashboardBrief(content, summary)) return string.Empty;
        return "控制台/操作面板硬约束：本页必须像成熟 SaaS dashboard 或产品控制台，不像海报、书法、报刊或白皮书。" +
               "可见结构至少包含两类：顶部状态栏、侧边导航、数据指标卡、任务队列、流程轨道、预览画布、发布状态、操作按钮组、日志/版本面板。" +
               "标题字体必须使用清晰无衬线或等宽产品字体语气，禁止手写感、书法感、cursive 展示字、复古报刊标题；" +
               "一级标题不许占满整页，不许使用大号斜体衬线；信息层级要适合反复操作和扫描，避免大段抒情文案。\n";
    }

    private static readonly string[] PageLayoutHints =
    {
        "数据看板 Big Numbers（.stat 大数字格 + kicker），数字压住版面",
        "两栏对比（.grid.g2 现状 vs 方案，对比清晰）",
        "功能特性列表（3-4 个 .feat 条目，图标方块+标题+说明）",
        "对比表格（.table 多列对比，表头 kicker 样式）",
        "流程步骤（.step-row 横向 3-4 步，序号圆+连接线）",
        "金句/章节转场（.quote 大字引用 + 强调条）",
        "要点卡片（.grid.g3 每卡一要点，禁止裸列表）",
    };

    internal static string BuildPageSystemPrompt(string? theme, int index, int total, string? customStyleSpec = null)
    {
        var (_, defaultTone) = ThemeTokens(theme);
        var tone = string.IsNullOrWhiteSpace(customStyleSpec)
            ? defaultTone
            : "自定义模板（从用户参考图提取，必须保持当前整份演示的视觉语言）——" + customStyleSpec.Trim();
        return
            "你是顶级演示设计师，正在与其他设计师并行完成同一份 reveal.js 演示的不同页面。" +
            "文档 <head> 已包含设计系统：CSS 变量（--bg/--bg2/--ink/--muted/--line/--card/--a1/--a2/--a3/--orb-op）" +
            "与组件类（.eyebrow/.title-xl/.title-md/.lead/.grid .g2 .g3/.card/.stat/.stat-l/.chip/.bar/.quote/.orb/.feat/.feat-icon/.table/.callout/.step-row/.step-num）。\n" +
            "## 本次风格\n" + tone + "\n\n" +
            "## 设计自由（重要，反「套模板」）\n" +
            "组件类是工具箱不是模板——为本页内容定制独特版式：可自由用内联 style 排布、混搭或完全不用组件类；" +
            "但所有颜色必须取自 CSS 变量、字体必须符合本风格。用户给出的创意方向、比喻、场景、行业感可以影响视觉装置与叙事方式，" +
            "但不能改掉整份 deck 的色板、字体和页面秩序。目标是「这一页像为内容量身设计的」，不是把内容塞进固定骨架。\n\n" +
            "## 全局一致性契约\n" +
            "- 与其他页面共用同一套色板、字体、圆角、线条粗细、页脚/页码气质；禁止每页临时发明一套新风格\n" +
            "- 每页允许有不同版式，但必须看得出属于同一份控制台级专业演示\n" +
            "- 自定义创意只作为视觉表达，不得牺牲可读性、信息密度和代码正确性\n\n" +
            HtmlPptSkillContract() + "\n" +
            "## 内容要求\n" +
            "信息充实：结构化正文（卡片/数据/对比/列表至少一种）+ 至少一个视觉装置（光晕/强调条/大数字/独特大字编排）。" +
            "绝不允许一句话居中、四周大片空白。\n\n" +
            "## 画布与版面硬约束（违反会被系统剥离或压缩，必须遵守）\n" +
            "画布是 960x700 的固定设计框（reveal.js 整体缩放适配屏幕）：\n" +
            "1. 所有尺寸只用 px / % / rem / em，禁止 vh / vw 单位（设计框内语义错误）；\n" +
            "2. <section> 根元素禁止写 style 属性（系统会剥离根上的布局样式）——版式样式全部写在内层容器上；\n" +
            "3. 内容总高度必须装进 700px：要点最多呈现 5 条；横向步骤/时间线最多 4 项，且每项必须 flex:1 1 0 + min-width:170px（否则中文逐字竖排挤压）；\n" +
            "4. 大段文字宁可精炼，不可缩字号到 12px 以下硬塞。\n\n" +
            "## 输出（最高优先级）\n" +
            $"只输出本页（第 {index + 1}/{total} 页）一个完整的 <section>...</section> HTML 片段：" +
            "首字符是 <，末字符是 >；不含 <html>/<head>/<style>/<script>，不含 markdown 围栏与任何解释；" +
            "所有标签必须闭合，禁止占位符、问号空容器、未结束属性；" +
            "禁止任何 emoji；禁止对文字使用 color:transparent + background-clip:text；禁止调用工具。";
    }

    private static string BuildPageUserPrompt(
        MdToPptConvertRequest req, int index, int total)
    {
        var pages = req.OutlinePages!;
        var page = pages[index];
        var bullets = (page.Bullets ?? new List<string>()).Where(b => !string.IsNullOrWhiteSpace(b)).ToList();
        var prev = index > 0 ? pages[index - 1].Title : null;
        var next = index < total - 1 ? pages[index + 1].Title : null;
        string hint;
        if (index == 0)
            hint = "封面：（暗色风格）.orb 光晕 + .eyebrow + 超大 .title-xl + .lead 副标题 + 底部 .chip 行；（亮色风格）大字占版面 2/3 + 纤细副标题 + hairline 分隔";
        else if (index == total - 1)
            hint = "结语：居中 .title-xl + 行动号召 + .chip 联系方式，或左对齐大字 + 装饰图形";
        else
            hint = PageLayoutHints[(index - 1) % PageLayoutHints.Length];

        var context = (req.Content ?? string.Empty).Trim();
        if (context.Length > 600) context = context[..600] + "…";

        var sb = new StringBuilder();
        sb.Append("整份 PPT 主题：").Append(req.Summary ?? "（见全局上下文）").Append('\n');
        sb.Append("全局上下文（节选）：").Append(context).Append("\n\n");
        sb.Append($"共 {total} 页；本页是第 {index + 1} 页：{page.Title}\n");
        sb.Append("本页要点（信息必须全部呈现，可润色排版不可丢失）：\n");
        foreach (var b in bullets) sb.Append("- ").Append(b).Append('\n');
        if (prev != null) sb.Append($"上一页标题：「{prev}」\n");
        if (next != null) sb.Append($"下一页标题：「{next}」\n");
        if (!string.IsNullOrWhiteSpace(page.Design))
            sb.Append("本页设计意图（大纲阶段已与用户确认，优先遵循）：").Append(page.Design.Trim()).Append('\n');
        var consoleGuard = BuildConsoleDashboardGuard(req.Content, req.Summary);
        if (!string.IsNullOrEmpty(consoleGuard)) sb.Append(consoleGuard);
        sb.Append("版式建议（可不采纳，但必须与相邻页差异化）：").Append(hint);
        return sb.ToString();
    }


    // ─────────────────────────────────────────────
    // 锚定 deck 模式（2026-06-12 质量目标）：open-design 工作流——
    // 子智能体拿"人工精调版式范本"只换内容不造布局，从根上杜绝重叠/溢出
    // ─────────────────────────────────────────────

    internal static string BuildAnchoredPageSystemPrompt(MdToPptAnchors.Anchor anchor, MdToPptAnchors.AnchorSlide layout, int index, int total)
    {
        return
            "你在一套人工精调的成品演示设计系统内工作（不允许自由发挥布局）。\n" +
            HtmlPptSkillContract() + "\n" +
            "## 铁律（违反会被系统剥离或整页重做）\n" +
            "1. 下方版式范本的类名、结构层级、装饰元素一律保留——这是设计系统的身份，禁止改类名/删装饰/换结构\n" +
            "2. 只把范本中的占位内容（标题/段落/数字/标签/列表项文字）替换为本页真实内容；标题与要点必须逐字复制输入，不得润色、改写或新增业务文案；同构列表项允许增删 1-2 个\n" +
            "3. 禁止内联布局样式：style 属性里不得出现 position/width/height/min-/max-/margin/transform/z-index/inset，禁止 vh/vw 单位\n" +
            "4. 内容必须放得下：标题不超过范本对应位置字数的 1.3 倍；每条要点不超过 40 字；放不下就精炼文字，禁止缩字号硬塞\n" +
            "5. 颜色/字体不得偏离设计系统（不要写新的颜色值）\n" +
            "6. 不得压到页脚/页眉：内容总量不超过范本原有内容量，宁可少写一条也不让正文与底部页码/页脚文字重叠；保留页脚的位置与样式，但页脚样例文字必须替换为当前主题、栏目和正确页码\n" +
            "7. 视觉装置不得留空：范本里的图表/数据可视化/SVG/统计块/大数字等装置必须填满；只能使用本页要点或全局上下文明确给出的事实，缺少数字时改用定性标签或原文短句，禁止编造人名、命令、版本、时间、token、费用、百分比或其他示意数值\n" +
            "8. 用户给出的创意方向只能转译为范本内的文案、数值、标签和已有视觉装置语义，不得破坏成品模板结构\n" +
            "9. 禁止低级兜底版式：不得输出可见标题为“封面/目录/总结/标题/本页标题”的泛化页；不得只给一个标题加 bullet 列表；每页至少保留并填实范本中的两类视觉结构（如数据块、卡片组、图表、分栏、流程、时间线、对比、引用、行动区）\n" +
            $"10. 只输出完整的 slide 块（第 {index + 1}/{total} 页）：首字符是 <，根元素与范本相同（class=\"{layout.ClassAttr}\"），" +
            "不含 <html>/<head>/<style>/<script>，无解释无代码围栏，禁止任何 emoji，禁止调用工具\n\n" +
            "## 本页版式范本（完整源码，照此结构替换内容）\n" + layout.Html;
    }

    internal static string HtmlPptSkillContract()
    {
        return
            "## GitHub html-ppt 技能契约\n" +
            "来源：nexu-io/open-design 的 plugins/_official/examples/html-ppt（上游 lewislulu/html-ppt-skill）。\n" +
            "- 始终从现有布局范本出发：把 templates/single-page 的 cover、toc、section-divider、bullets、two-column、three-column、kpi-grid、table、chart、terminal、flow、timeline、roadmap、comparison、cta、thanks 等布局映射到当前页面语义，再替换真实内容\n" +
            "- 一页只输出一个 slide 根块；根块保留 class 中的 slide 身份，能加属性时补 data-title=\"本页标题\"，方便缩略图、概览和导出链路识别\n" +
            "- 使用主题 token 与现有 CSS 变量，不写新的十六进制色值，不临时引入外部运行时，不破坏键盘预览、导出和静态托管兼容性\n" +
            "- 版式选择要覆盖文本、数据、对比、流程、代码、图表、结语等场景，连续页面避免重复同一种布局\n" +
            "- 如需要讲稿或创作说明，只能放进隐藏的 .notes 或 aside.notes，禁止把 presenter-only 文案显示在 slide 上\n";
    }

    private static string BuildAnchoredPageUserPrompt(MdToPptConvertRequest req, int index, int total)
    {
        var pages = req.OutlinePages!;
        var page = pages[index];
        var bullets = (page.Bullets ?? new List<string>()).Where(b => !string.IsNullOrWhiteSpace(b)).ToList();
        var sb = new StringBuilder();
        sb.Append("整份 PPT 主题：").Append(req.Summary ?? "（通用）").Append('\n');
        sb.Append($"本页是第 {index + 1}/{total} 页：{page.Title}\n");
        sb.Append("本页要点（必须逐字呈现，不得润色、拆义或新增事实）：\n");
        foreach (var b in bullets) sb.Append("- ").Append(b).Append('\n');
        if (!string.IsNullOrWhiteSpace(page.Design))
            sb.Append("设计意图（在范本允许范围内体现）：").Append(page.Design.Trim()).Append('\n');
        var consoleGuard = BuildConsoleDashboardGuard(req.Content, req.Summary);
        if (!string.IsNullOrEmpty(consoleGuard)) sb.Append(consoleGuard);
        sb.Append("创意与质量要求：只通过版式、层级、装饰和已有视觉装置表达用户意图，不得发明文案、数字、对比标签或流程节点；");
        sb.Append("范本同构区域只能填入上面的标题与要点原文，不得输出泛化标题“封面/目录/总结/标题”；");
        sb.Append("如果本页是封面，主标题必须是产品或主题名称，不得显示“封面”二字。");
        sb.Append("把范本占位内容替换为以上真实内容，输出整个 slide 块。");
        return sb.ToString();
    }



    /// <summary>整篇 HTML 中平衡扫描全部顶层 slide 块（锚定 deck 的拆装用）</summary>
    private static List<(int Start, int Length)> FindBalancedClassBlocks(string html, string classToken)
    {
        var result = new List<(int Start, int Length)>();
        var openRe = new System.Text.RegularExpressions.Regex(
            "<(?<tag>div|main|section|article)\\b[^>]*\\bclass\\s*=\\s*(?<quote>[\"'])(?<classes>[^\"']*)\\k<quote>[^>]*>",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        var pos = 0;
        while (true)
        {
            var open = openRe.Match(html, pos);
            if (!open.Success) break;
            // class 列表必须含独立 token（排除 slide-counter / slides-container 等近似名）。
            if (!open.Groups["classes"].Value
                    .Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries)
                    .Any(value => string.Equals(value, classToken, StringComparison.OrdinalIgnoreCase)))
            {
                pos = open.Index + open.Length;
                continue;
            }
            var tag = open.Groups["tag"].Value.ToLowerInvariant();
            var tagRe = new System.Text.RegularExpressions.Regex($"<(/?){tag}\\b[^>]*?(/?)>",
                System.Text.RegularExpressions.RegexOptions.IgnoreCase);
            var depth = 1;
            var scan = open.Index + open.Length;
            while (depth > 0)
            {
                var t = tagRe.Match(html, scan);
                if (!t.Success) return result; // 不平衡：放弃后续
                if (t.Groups[2].Value != "/")
                    depth += t.Groups[1].Value == "/" ? -1 : 1;
                scan = t.Index + t.Length;
            }
            result.Add((open.Index, scan - open.Index));
            pos = scan;
        }
        return result;
    }

    internal static List<(int Start, int Length)> FindSlideBlocks(string html) =>
        FindBalancedClassBlocks(html, "slide");

    private static List<(int Start, int Length)> FindBalancedTagBlocks(string html, string tag)
    {
        var result = new List<(int Start, int Length)>();
        var tagRe = new System.Text.RegularExpressions.Regex($"<(?<close>/?)({tag})\\b[^>]*?(?<self>/?)>",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        var stack = new List<(int Start, bool HasNested)>();
        foreach (System.Text.RegularExpressions.Match token in tagRe.Matches(html))
        {
            if (token.Groups["close"].Value == "/")
            {
                if (stack.Count == 0) return new List<(int Start, int Length)>();
                var open = stack[^1];
                stack.RemoveAt(stack.Count - 1);
                if (!open.HasNested) result.Add((open.Start, token.Index + token.Length - open.Start));
                continue;
            }
            if (token.Groups["self"].Value == "/") continue;
            if (stack.Count > 0)
            {
                var parent = stack[^1];
                stack[^1] = (parent.Start, true);
            }
            stack.Add((token.Index, false));
        }
        return stack.Count == 0 ? result.OrderBy(block => block.Start).ToList() : new List<(int Start, int Length)>();
    }

    internal static List<(int Start, int Length)> FindPatchPageBlocks(string html)
    {
        var structuralHtml = MaskNonStructuralMarkup(html);
        var blocks = FindSlideBlocks(structuralHtml);
        return blocks.Count > 0 ? blocks : FindRevealPageBlocks(structuralHtml);
    }

    internal static bool IsAnchoredPatchBlock(string block) =>
        System.Text.RegularExpressions.Regex.IsMatch(
            block,
            "^\\s*<(?:div|main|section|article)\\b[^>]*\\bclass\\s*=\\s*([\"'])(?<classes>[^\"']*)\\1",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase) &&
        System.Text.RegularExpressions.Regex.Match(
                block,
                "^\\s*<(?:div|main|section|article)\\b[^>]*\\bclass\\s*=\\s*([\"'])(?<classes>[^\"']*)\\1",
                System.Text.RegularExpressions.RegexOptions.IgnoreCase)
            .Groups["classes"].Value.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries)
            .Any(value => value.Equals("slide", StringComparison.OrdinalIgnoreCase));

    private static List<(int Start, int Length)> FindRevealPageBlocks(string structuralHtml)
    {
        var result = new List<(int Start, int Length)>();
        foreach (var reveal in FindBalancedClassBlocks(structuralHtml, "reveal"))
        {
            var revealHtml = structuralHtml.Substring(reveal.Start, reveal.Length);
            foreach (var slides in FindBalancedClassBlocks(revealHtml, "slides"))
            {
                var slidesHtml = revealHtml.Substring(slides.Start, slides.Length);
                foreach (var page in FindBalancedTagBlocks(slidesHtml, "section"))
                    result.Add((reveal.Start + slides.Start + page.Start, page.Length));
            }
        }
        return result.OrderBy(page => page.Start).ToList();
    }

    internal static bool HasRenderableSlideContent(string block)
    {
        if (string.IsNullOrWhiteSpace(block)) return false;
        var hasImage = System.Text.RegularExpressions.Regex.IsMatch(
            block, "<img\\b[^>]*\\bsrc\\s*=\\s*([\"'])[^\"']+\\1", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        var svgMatch = System.Text.RegularExpressions.Regex.Match(
            block, "<svg\\b[^>]*>(?<svg>[\\s\\S]*?)</svg\\s*>", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        var svg = svgMatch.Success
            ? System.Text.RegularExpressions.Regex.Replace(
                svgMatch.Groups["svg"].Value,
                "<defs\\b[^>]*>[\\s\\S]*?</defs\\s*>",
                string.Empty,
                System.Text.RegularExpressions.RegexOptions.IgnoreCase)
            : string.Empty;
        var hasSvgShape =
            System.Text.RegularExpressions.Regex.IsMatch(svg, "<path\\b[^>]*\\bd\\s*=\\s*([\"'])[^\"'\\s][^\"']*\\1", System.Text.RegularExpressions.RegexOptions.IgnoreCase) ||
            System.Text.RegularExpressions.Regex.IsMatch(svg, "<(?:circle|ellipse|rect)\\b[^>]*(?:\\br|\\brx|\\bry|\\bwidth|\\bheight)\\s*=\\s*([\"'])[^\"']*[1-9][^\"']*\\1", System.Text.RegularExpressions.RegexOptions.IgnoreCase) ||
            System.Text.RegularExpressions.Regex.IsMatch(svg, "<(?:polyline|polygon)\\b[^>]*\\bpoints\\s*=\\s*([\"'])[^\"'\\s][^\"']*\\1", System.Text.RegularExpressions.RegexOptions.IgnoreCase) ||
            System.Text.RegularExpressions.Regex.IsMatch(svg, "<(?:use|image)\\b[^>]*(?:href|xlink:href)\\s*=\\s*([\"'])[^\"'\\s][^\"']*\\1", System.Text.RegularExpressions.RegexOptions.IgnoreCase) ||
            System.Text.RegularExpressions.Regex.IsMatch(svg, "<text\\b[^>]*>[\\s\\S]*?\\S[\\s\\S]*?</text\\s*>", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        var hasEmbeddedMedia = System.Text.RegularExpressions.Regex.IsMatch(
            block, "<(?:video|iframe)\\b[^>]*\\bsrc\\s*=\\s*([\"'])[^\"']+\\1", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        if (hasImage || hasSvgShape || hasEmbeddedMedia)
            return true;

        var text = System.Text.RegularExpressions.Regex.Replace(
            block,
            "<(?:script|style)\\b[^>]*>[\\s\\S]*?</(?:script|style)\\s*>|<!--[\\s\\S]*?-->|<[^>]+>",
            string.Empty,
            System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        text = System.Net.WebUtility.HtmlDecode(text)
            .Replace("\u00a0", string.Empty, StringComparison.Ordinal);
        return text.Any(c => !char.IsWhiteSpace(c));
    }

    internal static string MaskNonStructuralMarkup(string html) =>
        System.Text.RegularExpressions.Regex.Replace(
            html,
            "<(?:script|style)\\b[^>]*>[\\s\\S]*?</(?:script|style)\\s*>|<!--[\\s\\S]*?-->",
            match => new string(' ', match.Length),
            System.Text.RegularExpressions.RegexOptions.IgnoreCase);

    private static bool HasBalancedRawTextElements(string html, string tag)
    {
        var openRe = new System.Text.RegularExpressions.Regex($"<{tag}\\b[^>]*>",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        var closeRe = new System.Text.RegularExpressions.Regex($"</{tag}\\s*>",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        var pos = 0;
        while (true)
        {
            var open = openRe.Match(html, pos);
            if (!open.Success) return true;
            var close = closeRe.Match(html, open.Index + open.Length);
            if (!close.Success) return false;
            pos = close.Index + close.Length;
        }
    }

    private static bool HasGloballyHiddenCanvas(string html, string bodyOpeningTag)
    {
        static bool HidesContent(string declarations) =>
            System.Text.RegularExpressions.Regex.IsMatch(
                declarations,
                "(?:display\\s*:\\s*none|visibility\\s*:\\s*hidden|opacity\\s*:\\s*0(?:\\.0+)?(?:[;!\\s]|$))",
                System.Text.RegularExpressions.RegexOptions.IgnoreCase);

        var inlineStyle = System.Text.RegularExpressions.Regex.Match(
            bodyOpeningTag,
            "\\bstyle\\s*=\\s*([\"'])(?<style>[^\"']*)\\1",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        if (inlineStyle.Success && HidesContent(inlineStyle.Groups["style"].Value)) return true;

        foreach (System.Text.RegularExpressions.Match style in System.Text.RegularExpressions.Regex.Matches(
                     html,
                     "<style\\b[^>]*>(?<css>[\\s\\S]*?)</style\\s*>",
                     System.Text.RegularExpressions.RegexOptions.IgnoreCase))
        {
            foreach (var rule in EnumerateTopLevelCssRules(style.Groups["css"].Value))
            {
                var hidesRoot = rule.Selectors
                    .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                    .Any(selector => selector.Equals("body", StringComparison.OrdinalIgnoreCase) ||
                                     selector.Equals("html", StringComparison.OrdinalIgnoreCase) ||
                                     selector.Equals("html body", StringComparison.OrdinalIgnoreCase) ||
                                     selector == "*");
                if (hidesRoot && HidesContent(rule.Declarations)) return true;
            }
        }
        return false;
    }

    private static IEnumerable<(string Selectors, string Declarations)> EnumerateTopLevelCssRules(string css)
    {
        css = System.Text.RegularExpressions.Regex.Replace(css, "/\\*[\\s\\S]*?\\*/", " ");
        var depth = 0;
        var selectorStart = 0;
        var declarationStart = -1;
        var selectors = string.Empty;
        for (var i = 0; i < css.Length; i++)
        {
            if (css[i] == '{')
            {
                if (depth == 0)
                {
                    selectors = css[selectorStart..i].Trim();
                    declarationStart = i + 1;
                }
                depth++;
            }
            else if (css[i] == '}' && depth > 0)
            {
                depth--;
                if (depth == 0 && declarationStart >= 0)
                {
                    var declarations = css[declarationStart..i];
                    if (selectors.StartsWith("@media", StringComparison.OrdinalIgnoreCase))
                    {
                        if (!System.Text.RegularExpressions.Regex.IsMatch(
                                selectors,
                                "@media\\s+(?:print|speech)(?:\\s|\\{|$)",
                                System.Text.RegularExpressions.RegexOptions.IgnoreCase))
                        {
                            foreach (var nested in EnumerateTopLevelCssRules(declarations)) yield return nested;
                        }
                    }
                    else if (selectors.StartsWith("@supports", StringComparison.OrdinalIgnoreCase) ||
                             selectors.StartsWith("@layer", StringComparison.OrdinalIgnoreCase))
                    {
                        foreach (var nested in EnumerateTopLevelCssRules(declarations)) yield return nested;
                    }
                    else if (!selectors.StartsWith('@'))
                    {
                        yield return (selectors, declarations);
                    }
                    selectorStart = i + 1;
                    declarationStart = -1;
                }
            }
        }
    }

    private static bool IsOpeningTagExplicitlyHidden(string opening)
    {
        if (System.Text.RegularExpressions.Regex.IsMatch(
                opening, "\\shidden(?:\\s*=\\s*(?:\"[^\"]*\"|'[^']*'|[^\\s>]+))?(?=\\s|>)",
                System.Text.RegularExpressions.RegexOptions.IgnoreCase) ||
            System.Text.RegularExpressions.Regex.IsMatch(
                opening, "\\baria-hidden\\s*=\\s*(?:[\"']true[\"']|true)(?:\\s|>)",
                System.Text.RegularExpressions.RegexOptions.IgnoreCase))
            return true;
        var inline = System.Text.RegularExpressions.Regex.Match(
            opening, "\\bstyle\\s*=\\s*([\"'])(?<style>[^\"']*)\\1",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        return inline.Success && System.Text.RegularExpressions.Regex.IsMatch(
            inline.Groups["style"].Value,
            "(?:display\\s*:\\s*none|visibility\\s*:\\s*hidden|opacity\\s*:\\s*0(?:\\.0+)?(?:[;!\\s]|$))",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase);
    }

    private static bool IsSlideBlockExplicitlyHidden(string structuralBody, (int Start, int Length) block)
    {
        var opening = structuralBody.Substring(block.Start, block.Length);
        opening = opening[..(opening.IndexOf('>') + 1)];
        return IsOpeningTagExplicitlyHidden(opening);
    }

    private static List<string> FindAncestorOpeningTags(string html, int childStart)
    {
        var stack = new List<(string Tag, string Opening)>();
        var tokenRe = new System.Text.RegularExpressions.Regex(
            "<(?<close>/?)\\s*(?<tag>[a-z][a-z0-9:-]*)\\b[^>]*?(?<self>/?)>",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        foreach (System.Text.RegularExpressions.Match token in tokenRe.Matches(html))
        {
            if (token.Index >= childStart) break;
            var tag = token.Groups["tag"].Value.ToLowerInvariant();
            if (token.Groups["close"].Value == "/")
            {
                var match = stack.FindLastIndex(item => item.Tag == tag);
                if (match >= 0) stack.RemoveRange(match, stack.Count - match);
                continue;
            }
            if (token.Groups["self"].Value == "/" || tag is "area" or "base" or "br" or "col" or "embed" or "hr" or "img" or "input" or "link" or "meta" or "param" or "source" or "track" or "wbr")
                continue;
            stack.Add((tag, token.Value));
        }
        return stack.Select(item => item.Opening).ToList();
    }

    private static bool SelectorSubjectMatchesOpeningTag(string subject, string opening)
    {
        var normalized = System.Text.RegularExpressions.Regex.Replace(subject, ":not\\([^)]*\\)", string.Empty).Trim();
        if (normalized == "*") return true;
        var tag = System.Text.RegularExpressions.Regex.Match(opening, "^<\\s*(?<tag>[a-z][a-z0-9:-]*)", System.Text.RegularExpressions.RegexOptions.IgnoreCase)
            .Groups["tag"].Value;
        var requestedTag = System.Text.RegularExpressions.Regex.Match(normalized, "^(?<tag>[a-z][a-z0-9:-]*)", System.Text.RegularExpressions.RegexOptions.IgnoreCase)
            .Groups["tag"].Value;
        if (!string.IsNullOrEmpty(requestedTag) && !requestedTag.Equals(tag, StringComparison.OrdinalIgnoreCase)) return false;

        var classes = System.Text.RegularExpressions.Regex.Match(opening, "\\bclass\\s*=\\s*([\"'])(?<classes>[^\"']*)\\1", System.Text.RegularExpressions.RegexOptions.IgnoreCase)
            .Groups["classes"].Value.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
        foreach (System.Text.RegularExpressions.Match requested in System.Text.RegularExpressions.Regex.Matches(normalized, "\\.(?<name>[a-z0-9_-]+)", System.Text.RegularExpressions.RegexOptions.IgnoreCase))
            if (!classes.Any(value => value.Equals(requested.Groups["name"].Value, StringComparison.OrdinalIgnoreCase))) return false;

        var requestedId = System.Text.RegularExpressions.Regex.Match(normalized, "#(?<id>[a-z0-9_-]+)", System.Text.RegularExpressions.RegexOptions.IgnoreCase).Groups["id"].Value;
        if (!string.IsNullOrEmpty(requestedId))
        {
            var id = System.Text.RegularExpressions.Regex.Match(opening, "\\bid\\s*=\\s*([\"'])(?<id>[^\"']*)\\1", System.Text.RegularExpressions.RegexOptions.IgnoreCase).Groups["id"].Value;
            if (!requestedId.Equals(id, StringComparison.OrdinalIgnoreCase)) return false;
        }
        return !string.IsNullOrEmpty(requestedTag) || normalized.Contains('.') || normalized.Contains('#');
    }

    private static bool SelectorCanApplyToPage(string selector, string opening, IReadOnlyList<string> ancestors)
    {
        // 运行时首屏不能依赖 hover/focus 等瞬时伪类；当前合同只识别 :not(.class)。
        var unsupportedPseudo = System.Text.RegularExpressions.Regex.Replace(selector, ":not\\([^)]*\\)", string.Empty);
        if (unsupportedPseudo.Contains(':')) return false;
        foreach (System.Text.RegularExpressions.Match excluded in System.Text.RegularExpressions.Regex.Matches(
                     selector, ":not\\(\\.(?<class>[a-z0-9_-]+)\\)", System.Text.RegularExpressions.RegexOptions.IgnoreCase))
        {
            var classes = System.Text.RegularExpressions.Regex.Match(opening, "\\bclass\\s*=\\s*([\"'])(?<classes>[^\"']*)\\1", System.Text.RegularExpressions.RegexOptions.IgnoreCase)
                .Groups["classes"].Value.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
            if (classes.Any(value => value.Equals(excluded.Groups["class"].Value, StringComparison.OrdinalIgnoreCase))) return false;
        }

        var parts = System.Text.RegularExpressions.Regex.Split(selector.Trim(), "[\\s>+~]+").Where(part => part.Length > 0).ToArray();
        if (parts.Length == 0 || !SelectorSubjectMatchesOpeningTag(parts[^1], opening)) return false;
        var ancestorIndex = ancestors.Count - 1;
        for (var partIndex = parts.Length - 2; partIndex >= 0; partIndex--)
        {
            var part = parts[partIndex];
            if (part.Equals("html", StringComparison.OrdinalIgnoreCase) || part.Equals("body", StringComparison.OrdinalIgnoreCase)) continue;
            var found = false;
            while (ancestorIndex >= 0)
            {
                if (SelectorSubjectMatchesOpeningTag(part, ancestors[ancestorIndex]))
                {
                    found = true;
                    ancestorIndex--;
                    break;
                }
                ancestorIndex--;
            }
            if (!found) return false;
        }
        return true;
    }

    private static List<(string Property, bool Hidden, bool Important)> ParseVisibilityDeclarations(string declarations)
    {
        var result = new List<(string, bool, bool)>();
        foreach (System.Text.RegularExpressions.Match match in System.Text.RegularExpressions.Regex.Matches(
                     declarations,
                     "(?<property>display|visibility|opacity)\\s*:\\s*(?<value>[^;!}]+?)(?<important>\\s*!important)?(?=;|}|$)",
                     System.Text.RegularExpressions.RegexOptions.IgnoreCase))
        {
            var property = match.Groups["property"].Value.ToLowerInvariant();
            var value = match.Groups["value"].Value.Trim().ToLowerInvariant();
            bool hidden;
            if (property == "display") hidden = value == "none";
            else if (property == "visibility") hidden = value is "hidden" or "collapse";
            else
            {
                if (!double.TryParse(value, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var opacity))
                    continue;
                hidden = opacity <= 0;
            }
            result.Add((property, hidden, match.Groups["important"].Success));
        }
        return result;
    }

    private static int CssSpecificity(string selector)
    {
        var ids = System.Text.RegularExpressions.Regex.Matches(selector, "#[a-z0-9_-]+", System.Text.RegularExpressions.RegexOptions.IgnoreCase).Count;
        var classes = System.Text.RegularExpressions.Regex.Matches(selector, "\\.[a-z0-9_-]+|\\[[^]]+\\]|:[a-z0-9_-]+", System.Text.RegularExpressions.RegexOptions.IgnoreCase).Count;
        var tags = System.Text.RegularExpressions.Regex.Matches(selector, "(?:^|[\\s>+~])(?:[a-z][a-z0-9:-]*)", System.Text.RegularExpressions.RegexOptions.IgnoreCase).Count;
        return ids * 100 + classes * 10 + tags;
    }

    private static bool HasHiddenSlideContract(string html, string structuralBody, IReadOnlyList<(int Start, int Length)> blocks)
    {
        if (blocks.Any(block => IsSlideBlockExplicitlyHidden(structuralBody, block))) return true;
        var ancestorOpenings = blocks
            .SelectMany(block => FindAncestorOpeningTags(structuralBody, block.Start))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();
        if (ancestorOpenings.Any(IsOpeningTagExplicitlyHidden)) return true;

        var contexts = blocks.Select(block =>
        {
            var opening = structuralBody.Substring(block.Start, block.Length);
            opening = opening[..(opening.IndexOf('>') + 1)];
            return (Opening: opening, Ancestors: (IReadOnlyList<string>)FindAncestorOpeningTags(structuralBody, block.Start));
        }).ToList();
        var rules = new List<(string Selector, string Declarations, int Order)>();
        var order = 0;
        foreach (System.Text.RegularExpressions.Match style in System.Text.RegularExpressions.Regex.Matches(
                     html, "<style\\b[^>]*>(?<css>[\\s\\S]*?)</style\\s*>",
                     System.Text.RegularExpressions.RegexOptions.IgnoreCase))
        {
            foreach (var rule in EnumerateTopLevelCssRules(style.Groups["css"].Value))
            {
                var declarations = rule.Declarations;
                foreach (var raw in rule.Selectors.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
                {
                    var selector = raw.ToLowerInvariant();
                    rules.Add((selector, declarations, order++));
                }
            }
        }

        bool ElementIsHidden((string Opening, IReadOnlyList<string> Ancestors) context)
        {
            var winners = new Dictionary<string, (bool Hidden, bool Important, int Specificity, int Order)>();
            foreach (var rule in rules)
            {
                if (!SelectorCanApplyToPage(rule.Selector, context.Opening, context.Ancestors)) continue;
                var specificity = CssSpecificity(rule.Selector);
                foreach (var declaration in ParseVisibilityDeclarations(rule.Declarations))
                {
                    if (!winners.TryGetValue(declaration.Property, out var current) ||
                        (declaration.Important && !current.Important) ||
                        (declaration.Important == current.Important &&
                         (specificity > current.Specificity || specificity == current.Specificity && rule.Order >= current.Order)))
                    {
                        winners[declaration.Property] = (declaration.Hidden, declaration.Important, specificity, rule.Order);
                    }
                }
            }
            return winners.Values.Any(value => value.Hidden);
        }

        bool PageIsHidden((string Opening, IReadOnlyList<string> Ancestors) context)
        {
            for (var index = 0; index < context.Ancestors.Count; index++)
            {
                if (ElementIsHidden((context.Ancestors[index], context.Ancestors.Take(index).ToList()))) return true;
            }
            return ElementIsHidden(context);
        }

        static bool IsActiveOpening(string opening)
        {
            var classes = System.Text.RegularExpressions.Regex.Match(
                opening, "\\bclass\\s*=\\s*([\"'])(?<classes>[^\"']*)\\1", System.Text.RegularExpressions.RegexOptions.IgnoreCase)
                .Groups["classes"].Value;
            return classes.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries)
                .Any(value => value.Equals("active", StringComparison.OrdinalIgnoreCase) ||
                              value.Equals("is-active", StringComparison.OrdinalIgnoreCase) ||
                              value.Equals("present", StringComparison.OrdinalIgnoreCase));
        }

        var activeContexts = contexts.Where(context => IsActiveOpening(context.Opening)).ToList();
        return activeContexts.Count > 0
            ? activeContexts.All(PageIsHidden)
            : contexts.Count > 0 && contexts.All(PageIsHidden);
    }

    /// <summary>锚定兜底页：范本结构保留，正文区替换为可演示的设计块，避免退化成标题加列表。</summary>
    internal static string AnchoredFallbackSlide(MdToPptAnchors.AnchorSlide layout, MdToPptOutlinePageDto page, int index, int total)
    {
        var enc = (string? t) => System.Net.WebUtility.HtmlEncode(t ?? string.Empty);
        var bullets = (page.Bullets ?? new List<string>())
            .Where(b => !string.IsNullOrWhiteSpace(b))
            .Take(4)
            .ToList();
        while (bullets.Count < 3) bullets.Add(page.Title ?? string.Empty);

        var cardHtml = string.Join("", bullets.Take(3).Select((b, n) =>
        {
            var text = b.Trim();
            var title = text.Length > 16 ? text[..16] : text;
            return "<div class=\"mdppt-fallback-card\" style=\"border:1px solid currentColor;border-radius:18px;padding:18px 20px;background:rgba(255,255,255,.08)\">" +
                   $"<div style=\"font-size:12px;letter-spacing:.18em;text-transform:uppercase;opacity:.62;margin-bottom:12px\">{(n + 1):00}</div>" +
                   $"<div style=\"font-size:20px;font-weight:800;line-height:1.18;margin-bottom:8px\">{enc(title)}</div>" +
                   $"<div style=\"font-size:14px;line-height:1.55;opacity:.76\">{enc(text)}</div>" +
                   "</div>";
        }));
        var statLabel = bullets.Count >= 4 ? enc(bullets[3]) : enc(page.Title);
        var eyebrow = $"第 {index + 1:00} 页 / {total:00}";
        string content;
        if (index == 0)
        {
            var chips = string.Join("", bullets.Take(3).Select(b =>
                $"<span style=\"border:1px solid currentColor;border-radius:999px;padding:10px 15px;background:rgba(255,255,255,.06)\">{enc(b)}</span>"));
            content =
                "<div class=\"mdppt-fallback-layout mdppt-fallback-cover\" style=\"padding:8% 8%;position:relative;z-index:2;display:flex;flex-direction:column;justify-content:center;height:100%;box-sizing:border-box\">" +
                $"<div style=\"font-size:12px;letter-spacing:.24em;text-transform:uppercase;opacity:.66;margin-bottom:24px\">{eyebrow}</div>" +
                $"<h1 style=\"font-size:clamp(64px,8vw,108px);line-height:.94;margin:0;max-width:10em;font-weight:900;letter-spacing:-.055em\">{enc(page.Title)}</h1>" +
                $"<p style=\"font-size:22px;line-height:1.5;margin:30px 0 38px;opacity:.78;max-width:34em\">{enc(bullets[0])}</p>" +
                $"<div style=\"display:flex;gap:12px;flex-wrap:wrap;font-size:13px;line-height:1.4\">{chips}</div></div>";
        }
        else if (index == total - 1)
        {
            var actions = string.Join("", bullets.Take(3).Select((b, n) =>
                $"<div style=\"display:flex;gap:16px;align-items:center;border-top:1px solid currentColor;padding:15px 0\"><span style=\"font-size:12px;opacity:.56\">{n + 1:00}</span><strong style=\"font-size:17px\">{enc(b)}</strong></div>"));
            content =
                "<div class=\"mdppt-fallback-layout mdppt-fallback-closing\" style=\"padding:7% 10%;position:relative;z-index:2;display:grid;grid-template-columns:1.15fr .85fr;gap:70px;align-items:center;height:100%;box-sizing:border-box\">" +
                $"<div><div style=\"font-size:12px;letter-spacing:.24em;opacity:.62;margin-bottom:22px\">{eyebrow}</div><h1 style=\"font-size:clamp(58px,7vw,96px);line-height:.96;margin:0;font-weight:900;letter-spacing:-.05em\">{enc(page.Title)}</h1></div>" +
                $"<div style=\"display:grid\">{actions}</div></div>";
        }
        else if ((page.Design ?? string.Empty).Contains("流程", StringComparison.OrdinalIgnoreCase))
        {
            var steps = string.Join("", bullets.Take(4).Select((b, n) =>
                $"<div class=\"mdppt-fallback-card\" style=\"border:1px solid currentColor;border-radius:18px;padding:22px 20px;background:rgba(255,255,255,.08);min-height:150px\"><div style=\"font-size:34px;font-weight:900;opacity:.34;margin-bottom:24px\">{n + 1:00}</div><div style=\"font-size:18px;font-weight:800;line-height:1.35\">{enc(b)}</div></div>"));
            content =
                "<div class=\"mdppt-fallback-layout mdppt-fallback-flow\" style=\"padding:6% 7%;position:relative;z-index:2;display:flex;flex-direction:column;justify-content:center;height:100%;box-sizing:border-box\">" +
                $"<div style=\"font-size:12px;letter-spacing:.22em;opacity:.62;margin-bottom:16px\">{eyebrow}</div><h1 style=\"font-size:54px;line-height:1;margin:0 0 42px;font-weight:900\">{enc(page.Title)}</h1>" +
                $"<div style=\"display:grid;grid-template-columns:repeat(4,1fr);gap:14px\">{steps}</div></div>";
        }
        else if ((page.Design ?? string.Empty).Contains("四象限", StringComparison.OrdinalIgnoreCase))
        {
            var tiles = string.Join("", bullets.Take(4).Select((b, n) =>
                $"<div class=\"mdppt-fallback-card\" style=\"border:1px solid currentColor;border-radius:18px;padding:20px 22px;background:rgba(255,255,255,.08);display:flex;gap:18px;align-items:flex-start\"><span style=\"font-size:28px;font-weight:900;opacity:.4\">{n + 1:00}</span><strong style=\"font-size:19px;line-height:1.4\">{enc(b)}</strong></div>"));
            content =
                "<div class=\"mdppt-fallback-layout mdppt-fallback-quadrant\" style=\"padding:6% 7%;position:relative;z-index:2;display:grid;grid-template-columns:.72fr 1.28fr;gap:48px;align-items:center;height:100%;box-sizing:border-box\">" +
                $"<div><div style=\"font-size:12px;letter-spacing:.22em;opacity:.62;margin-bottom:18px\">{eyebrow}</div><h1 style=\"font-size:58px;line-height:.98;margin:0;font-weight:900\">{enc(page.Title)}</h1></div>" +
                $"<div style=\"display:grid;grid-template-columns:1fr 1fr;gap:14px\">{tiles}</div></div>";
        }
        else
        {
            content =
                "<div class=\"mdppt-fallback-layout mdppt-fallback-split\" style=\"padding:5.5% 7%;position:relative;z-index:2;display:grid;grid-template-columns:1.05fr .95fr;gap:38px;align-items:center\">" +
                "<div>" +
                $"<div style=\"font-size:12px;letter-spacing:.22em;text-transform:uppercase;opacity:.66;margin-bottom:18px\">{eyebrow}</div>" +
                $"<h1 style=\"font-size:clamp(44px,6vw,76px);line-height:.98;margin:0 0 22px;font-weight:900;letter-spacing:-.035em\">{enc(page.Title)}</h1>" +
                $"<p style=\"font-size:20px;line-height:1.5;margin:0;opacity:.78;max-width:34em\">{enc(bullets[0])}</p>" +
                "<div style=\"width:88px;height:6px;background:currentColor;margin-top:30px;border-radius:999px;opacity:.88\"></div>" +
                "</div>" +
                "<div style=\"display:grid;gap:14px\">" + cardHtml +
                "<div style=\"display:flex;align-items:end;justify-content:space-between;border-top:1px solid currentColor;padding-top:16px;opacity:.82\">" +
                $"<div style=\"font-size:46px;line-height:1;font-weight:900\">{Math.Max(3, bullets.Count):00}</div>" +
                $"<div style=\"font-size:13px;line-height:1.45;text-align:right;max-width:18em\">{statLabel}</div>" +
                "</div></div></div>";
        }
        // 兜底页不再裸奔（2026-06-12 用户视觉验收：兜底页无模板装饰、像贴了张白纸）：
        // 从本页版式范本里继承"无文本装饰块"（网格/扫描线/窗饰/背景 SVG），页脚改写为可信的当前页信息，
        // 即使子智能体两次输出都无效，这页也穿着设计系统的衣服降级。
        var (lead, _) = ExtractAnchorDecorations(layout.Html);
        var safeFooter =
            "<div class=\"mdppt-fallback-footer\" style=\"position:absolute;left:7%;right:7%;bottom:3.5%;display:flex;justify-content:space-between;align-items:center;font-size:11px;letter-spacing:.18em;text-transform:uppercase;opacity:.58\">" +
            $"<span>{enc(page.Title)}</span><span>{index + 1:00} / {total:00}</span></div>";
        var rootOpen = System.Text.RegularExpressions.Regex.Match(layout.Html,
            "<(div|section|article)\\b[^>]*>", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        if (rootOpen.Success)
        {
            var tag = rootOpen.Groups[1].Value.ToLowerInvariant();
            return rootOpen.Value + lead + content + safeFooter + $"</{tag}>";
        }
        return $"<div class=\"{layout.ClassAttr}\">{lead}{content}{safeFooter}</div>";
    }

    /// <summary>
    /// 检测模型是否把锚点范本中的样例事实原样带进成品。
    /// 范本负责结构与风格，不是内容来源；未出现在本页输入中的长文本一律视为污染。
    /// </summary>
    internal static bool ContainsAnchorSampleResidue(
        string generated,
        MdToPptAnchors.AnchorSlide layout,
        MdToPptOutlinePageDto page,
        string? deckSummary,
        string? deckContent)
    {
        if (string.IsNullOrWhiteSpace(generated) || string.IsNullOrWhiteSpace(layout.Html)) return false;

        static string Normalize(string value) => System.Text.RegularExpressions.Regex.Replace(
            System.Net.WebUtility.HtmlDecode(value), "\\s+", " ").Trim();

        static string VisibleText(string html)
        {
            var value = System.Text.RegularExpressions.Regex.Replace(
                html, "<(style|script|svg)\\b[^>]*>[\\s\\S]*?</\\1>", " ",
                System.Text.RegularExpressions.RegexOptions.IgnoreCase);
            value = System.Text.RegularExpressions.Regex.Replace(value, "<!--[\\s\\S]*?-->", " ");
            value = System.Text.RegularExpressions.Regex.Replace(value, "<[^>]+>", "\n");
            return Normalize(value);
        }

        var allowedParts = new List<string?>
        {
            page.Title,
            string.Join("\n", page.Bullets ?? new List<string>()),
            page.Design,
            deckSummary,
            deckContent,
        };
        var allowed = Normalize(string.Join("\n", allowedParts.Where(value => !string.IsNullOrWhiteSpace(value))));
        var output = VisibleText(generated);
        var templateWithoutNonText = System.Text.RegularExpressions.Regex.Replace(
            layout.Html, "<(style|script|svg)\\b[^>]*>[\\s\\S]*?</\\1>", " ",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        templateWithoutNonText = System.Text.RegularExpressions.Regex.Replace(
            templateWithoutNonText, "<!--[\\s\\S]*?-->", " ");
        var candidates = System.Text.RegularExpressions.Regex.Matches(templateWithoutNonText, ">([^<>]+)<")
            .Select(match => Normalize(match.Groups[1].Value))
            .Where(value => value.Length >= 3)
            .Where(value => !System.Text.RegularExpressions.Regex.IsMatch(value, "^0?\\d+\\s*[/·|-]\\s*0?\\d+$"))
            .Where(value => !System.Text.RegularExpressions.Regex.IsMatch(value, "^[\\p{P}\\p{S}\\s]+$"))
            .Distinct(StringComparer.OrdinalIgnoreCase);

        return candidates.Any(sample =>
            output.Contains(sample, StringComparison.OrdinalIgnoreCase) &&
            !allowed.Contains(sample, StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>
    /// 锚点只提供视觉结构；可见业务文字必须由本页标题、要点或源内容的完整事实片段组成。
    /// 先移除允许事实，再检查剩余语义字符，因此跨多个内联标签拆分也不能绕过。
    /// </summary>
    internal static bool ContainsUnsupportedVisibleClaims(
        string generated,
        MdToPptOutlinePageDto page,
        string? deckSummary,
        string? deckContent,
        int? pageIndex = null,
        int? totalPages = null)
    {
        if (string.IsNullOrWhiteSpace(generated)) return false;

        static string Normalize(string value) => System.Text.RegularExpressions.Regex.Replace(
            System.Net.WebUtility.HtmlDecode(value), "\\s+", " ").Trim();

        var allowedParts = new List<string?>
        {
            page.Title,
            deckSummary,
        };
        allowedParts.AddRange(page.Bullets ?? new List<string>());
        if (!string.IsNullOrWhiteSpace(deckContent))
        {
            allowedParts.AddRange(System.Text.RegularExpressions.Regex
                .Split(deckContent, "[\\r\\n。！？!?；;]+")
                .Where(value => !string.IsNullOrWhiteSpace(value)));
        }
        var withoutNonText = System.Text.RegularExpressions.Regex.Replace(
            generated, "<(style|script)\\b[^>]*>[\\s\\S]*?</\\1>", " ",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        withoutNonText = System.Text.RegularExpressions.Regex.Replace(withoutNonText, "<!--[\\s\\S]*?-->", " ");
        // 仅剥离有明确结构身份的页码或流程序号。其余所有可见数字，包括 1-2 位裸 KPI，
        // 都必须在用户来源中出现，不能再用“数字较短”作为放行条件。
        withoutNonText = System.Text.RegularExpressions.Regex.Replace(
            withoutNonText,
            "(?<open><(?<tag>div|span|p)\\b[^>]*class\\s*=\\s*[\"'][^\"']*\\b(?:pagenum|gd-snum|pin-note|grove-num|flow-num|cycle-num|num-tag|p-num)\\b[^\"']*[\"'][^>]*>)(?<value>\\s*#?\\d{1,2}(?:\\s*/\\s*\\d{1,2})?\\.?\\s*)(?<close></\\k<tag>>)",
            match => match.Groups["open"].Value + match.Groups["close"].Value,
            System.Text.RegularExpressions.RegexOptions.IgnoreCase,
            TimeSpan.FromSeconds(1));
        // Vellum、Monochrome 与 Grove 的真实锚点把页码放在 slide-chrome 内的通用 label 中。
        // 只剥离该容器内“纯数字”的 label，不能全局放行 label 里的业务数字。
        var expectedPageNumber = pageIndex.HasValue && totalPages is > 0
            ? (pageIndex.Value + 1).ToString("00")
            : null;
        withoutNonText = System.Text.RegularExpressions.Regex.Replace(
            withoutNonText,
            "(?<open><(?<chrome>header|div)\\b[^>]*class\\s*=\\s*[\"'][^\"']*\\bslide-chrome\\b[^\"']*[\"'][^>]*>[\\s\\S]*?<span\\b[^>]*class\\s*=\\s*[\"'][^\"']*\\blabel\\b[^\"']*[\"'][^>]*>)(?<value>\\s*\\d{1,2}\\s*)(?<close></span>[\\s\\S]*?</\\k<chrome>>)",
            match => expectedPageNumber != null
                     && string.Equals(match.Groups["value"].Value.Trim().TrimStart('0'), expectedPageNumber.TrimStart('0'), StringComparison.Ordinal)
                ? match.Groups["open"].Value + match.Groups["close"].Value
                : match.Value,
            System.Text.RegularExpressions.RegexOptions.IgnoreCase,
            TimeSpan.FromSeconds(1));
        // Coral 的页码是 left-col 的首个 number 子节点；同样限定容器关系和纯数字内容。
        withoutNonText = System.Text.RegularExpressions.Regex.Replace(
            withoutNonText,
            "(?<open><div\\b[^>]*class\\s*=\\s*[\"'][^\"']*\\bleft-col\\b[^\"']*[\"'][^>]*>\\s*<div\\b[^>]*class\\s*=\\s*[\"'][^\"']*\\bnumber\\b[^\"']*[\"'][^>]*>)(?<value>\\s*\\d{1,2}\\s*)(?<close></div>)",
            match => expectedPageNumber != null
                     && string.Equals(match.Groups["value"].Value.Trim().TrimStart('0'), expectedPageNumber.TrimStart('0'), StringComparison.Ordinal)
                ? match.Groups["open"].Value + match.Groups["close"].Value
                : match.Value,
            System.Text.RegularExpressions.RegexOptions.IgnoreCase,
            TimeSpan.FromSeconds(1));
        withoutNonText = System.Text.RegularExpressions.Regex.Replace(
            withoutNonText,
            "(?<open><(?<tag>div|span|p)\\b[^>]*class\\s*=\\s*[\"'][^\"']*\\bsection-label\\b[^\"']*[\"'][^>]*>)\\s*\\d{1,2}\\s*/\\s*(?=[^<]*</\\k<tag>>)",
            match => match.Groups["open"].Value,
            System.Text.RegularExpressions.RegexOptions.IgnoreCase,
            TimeSpan.FromSeconds(1));
        withoutNonText = System.Text.RegularExpressions.Regex.Replace(
            withoutNonText,
            "(SECTION\\s*·\\s*)\\d{1,2}\\s*/\\s*\\d{1,2}",
            "$1",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase,
            TimeSpan.FromSeconds(1));
        withoutNonText = System.Text.RegularExpressions.Regex.Replace(
            withoutNonText,
            "(?<open><div\\b[^>]*class\\s*=\\s*[\"'][^\"']*\\bhc-footer\\b[^\"']*[\"'][^>]*>[\\s\\S]*?<span\\b[^>]*>)\\s*\\d{1,2}\\s*/\\s*\\d{1,2}(?<close>\\s*</span>[\\s\\S]*?</div>)",
            match => match.Groups["open"].Value + match.Groups["close"].Value,
            System.Text.RegularExpressions.RegexOptions.IgnoreCase,
            TimeSpan.FromSeconds(1));
        withoutNonText = System.Text.RegularExpressions.Regex.Replace(
            withoutNonText,
            "(?<open><(?<tag>div|footer)\\b[^>]*class\\s*=\\s*[\"'][^\"']*\\bslide-foot\\b[^\"']*[\"'][^>]*>[\\s\\S]*?<span\\b[^>]*>)\\s*\\d{1,2}\\s*/\\s*\\d{1,2}(?<close>\\s*</span>[\\s\\S]*?</\\k<tag>>)",
            match => match.Groups["open"].Value + match.Groups["close"].Value,
            System.Text.RegularExpressions.RegexOptions.IgnoreCase,
            TimeSpan.FromSeconds(1));
        var visible = Normalize(System.Text.RegularExpressions.Regex.Replace(withoutNonText, "<[^>]+>", string.Empty));
        // 数字事实单独校验。正文语义校验会剥掉数字以容忍页码和装饰序号，不能因此放过
        // 模型新造的百分比、金额、耗时、token 数或年份。
        static IEnumerable<string> NumericFacts(string value) =>
            System.Text.RegularExpressions.Regex.Matches(
                    Normalize(value),
                    "(?:[$¥￥€£]\\s*)?\\d+(?:[.,]\\d+)*(?:\\s*(?:%|％|ms|min|tokens?|gb|mb|[skmh]|元|万|亿|天|家|人|个|次|项|位|套|页|x|×))?",
                    System.Text.RegularExpressions.RegexOptions.IgnoreCase,
                    TimeSpan.FromSeconds(1))
                .Select(match => System.Text.RegularExpressions.Regex.Replace(
                    match.Value.ToLowerInvariant(), "\\s+", string.Empty));

        var allowedNumericFacts = allowedParts
            .Where(value => !string.IsNullOrWhiteSpace(value))
            .SelectMany(value => NumericFacts(value!))
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        if (NumericFacts(visible).Any(value => !allowedNumericFacts.Contains(value))) return true;

        static string Semantic(string value) => System.Text.RegularExpressions.Regex.Replace(
            Normalize(value).ToLowerInvariant(), "[\\p{P}\\p{S}\\s\\d]+", string.Empty);

        var remaining = Semantic(visible);
        foreach (var allowed in allowedParts
                     .Where(value => !string.IsNullOrWhiteSpace(value))
                     .Select(value => Semantic(value!))
                     .Where(value => value.Length >= 2)
                     .Distinct(StringComparer.OrdinalIgnoreCase)
                     .OrderByDescending(value => value.Length))
        {
            remaining = remaining.Replace(allowed, string.Empty, StringComparison.OrdinalIgnoreCase);
        }
        remaining = remaining
            .Replace("section", string.Empty, StringComparison.OrdinalIgnoreCase)
            .Replace("slide", string.Empty, StringComparison.OrdinalIgnoreCase)
            .Replace("page", string.Empty, StringComparison.OrdinalIgnoreCase);
        return remaining.Length >= 3;
    }

    internal static string NormalizeSlidePageIdentity(string slide, int index, int total)
    {
        if (string.IsNullOrWhiteSpace(slide) || total <= 0) return slide;
        var current = index + 1;
        var normalized = System.Text.RegularExpressions.Regex.Replace(
            slide,
            "(?<open><(?:div|span|p)\\b[^>]*class\\s*=\\s*[\"'][^\"']*\\b(?:pagenum|gd-snum|pin-note)\\b[^\"']*[\"'][^>]*>)(?<lead>\\s*)\\d{1,2}\\s*/\\s*\\d{1,2}(?<tail>\\s*)(?<close></(?:div|span|p)>)",
            match => $"{match.Groups["open"].Value}{match.Groups["lead"].Value}{current:00} / {total:00}{match.Groups["tail"].Value}{match.Groups["close"].Value}",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        normalized = System.Text.RegularExpressions.Regex.Replace(
            normalized,
            "(SECTION\\s*·\\s*)\\d{1,2}\\s*/\\s*\\d{1,2}",
            match => $"{match.Groups[1].Value}{current:00}/{total:00}",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        normalized = System.Text.RegularExpressions.Regex.Replace(
            normalized,
            "(?<open><div\\b[^>]*class\\s*=\\s*[\"'][^\"']*\\bhc-footer\\b[^\"']*[\"'][^>]*>[\\s\\S]*?<span\\b[^>]*>)(?<lead>\\s*)\\d{1,2}\\s*/\\s*\\d{1,2}(?<tail>\\s*)(?<close></span>[\\s\\S]*?</div>)",
            match => $"{match.Groups["open"].Value}{match.Groups["lead"].Value}{current:00} / {total:00}{match.Groups["tail"].Value}{match.Groups["close"].Value}",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        normalized = System.Text.RegularExpressions.Regex.Replace(
            normalized,
            "(?<open><(?<tag>div|footer)\\b[^>]*class\\s*=\\s*[\"'][^\"']*\\bslide-foot\\b[^\"']*[\"'][^>]*>[\\s\\S]*?<span\\b[^>]*>)(?<lead>\\s*)\\d{1,2}\\s*/\\s*\\d{1,2}(?<tail>\\s*)(?<close></span>[\\s\\S]*?</\\k<tag>>)",
            match => $"{match.Groups["open"].Value}{match.Groups["lead"].Value}{current:00} / {total:00}{match.Groups["tail"].Value}{match.Groups["close"].Value}",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        normalized = System.Text.RegularExpressions.Regex.Replace(
            normalized,
            "(?<open><(?<chrome>header|div)\\b[^>]*class\\s*=\\s*[\"'][^\"']*\\bslide-chrome\\b[^\"']*[\"'][^>]*>[\\s\\S]*?<span\\b[^>]*class\\s*=\\s*[\"'][^\"']*\\blabel\\b[^\"']*[\"'][^>]*>)(?<lead>\\s*)\\d{1,2}(?<tail>\\s*)(?<close></span>[\\s\\S]*?</\\k<chrome>>)",
            match => $"{match.Groups["open"].Value}{match.Groups["lead"].Value}{current:00}{match.Groups["tail"].Value}{match.Groups["close"].Value}",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        return System.Text.RegularExpressions.Regex.Replace(
            normalized,
            "(?<open><div\\b[^>]*class\\s*=\\s*[\"'][^\"']*\\bleft-col\\b[^\"']*[\"'][^>]*>\\s*<div\\b[^>]*class\\s*=\\s*[\"'][^\"']*\\bnumber\\b[^\"']*[\"'][^>]*>)(?<lead>\\s*)\\d{1,2}(?<tail>\\s*)(?<close></div>)",
            match => $"{match.Groups["open"].Value}{match.Groups["lead"].Value}{current:00}{match.Groups["tail"].Value}{match.Groups["close"].Value}",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase);
    }

    /// <summary>
    /// 将模型遗漏的范本样例文字确定性改写为当前页真实内容，保留 OpenDesign 版式结构。
    /// 仅处理标签之间的可见文本，不触碰 class、data 属性或脚本；改写后仍由残留检测再次把关。
    /// </summary>
    internal static string RewriteAnchorSampleResidue(
        string generated,
        MdToPptAnchors.AnchorSlide layout,
        MdToPptOutlinePageDto page,
        string? deckSummary,
        string? deckContent)
    {
        if (string.IsNullOrWhiteSpace(generated) || string.IsNullOrWhiteSpace(layout.Html)) return generated;

        static string Normalize(string value) => System.Text.RegularExpressions.Regex.Replace(
            System.Net.WebUtility.HtmlDecode(value), "\\s+", " ").Trim();

        var allowed = Normalize(string.Join("\n", new List<string?>
        {
            page.Title,
            string.Join("\n", page.Bullets ?? new List<string>()),
            page.Design,
            deckSummary,
            deckContent,
        }.Where(value => !string.IsNullOrWhiteSpace(value))));
        var templateWithoutNonText = System.Text.RegularExpressions.Regex.Replace(
            layout.Html, "<(style|script|svg)\\b[^>]*>[\\s\\S]*?</\\1>", " ",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        templateWithoutNonText = System.Text.RegularExpressions.Regex.Replace(
            templateWithoutNonText, "<!--[\\s\\S]*?-->", " ");
        var samples = System.Text.RegularExpressions.Regex.Matches(templateWithoutNonText, ">([^<>]+)<")
            .Select(match => Normalize(match.Groups[1].Value))
            .Where(value => value.Length >= 3)
            .Where(value => !System.Text.RegularExpressions.Regex.IsMatch(value, "^0?\\d+\\s*[/·|-]\\s*0?\\d+$"))
            .Where(value => !System.Text.RegularExpressions.Regex.IsMatch(value, "^[\\p{P}\\p{S}\\s]+$"))
            .Where(value => !allowed.Contains(value, StringComparison.OrdinalIgnoreCase))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .OrderByDescending(value => value.Length)
            .ToList();
        if (samples.Count == 0) return generated;

        var replacements = new[] { page.Title }
            .Concat(page.Bullets ?? new List<string>())
            .Where(value => !string.IsNullOrWhiteSpace(value))
            .Select(value => value!.Trim())
            .Distinct(StringComparer.Ordinal)
            .ToList();
        if (replacements.Count == 0) return generated;

        var replacementIndex = 0;
        return System.Text.RegularExpressions.Regex.Replace(generated, ">([^<>]+)<", match =>
        {
            var visible = Normalize(match.Groups[1].Value);
            if (!samples.Any(sample => visible.Contains(sample, StringComparison.OrdinalIgnoreCase)))
                return match.Value;
            var replacement = replacements[replacementIndex++ % replacements.Count];
            return $">{System.Net.WebUtility.HtmlEncode(replacement)}<";
        });
    }

    /// <summary>
    /// 从版式范本里提取可继承的装饰：顶层"无文本子块"（背景网格/扫描线/窗饰/SVG 装置）作 lead，
    /// class 含 footer 的子块作 tail。供兜底页穿上设计系统的衣服。
    /// </summary>
    internal static (string Lead, string Tail) ExtractAnchorDecorations(string exemplarHtml)
    {
        var lead = new StringBuilder();
        var tail = new StringBuilder();
        try
        {
            var rootOpen = System.Text.RegularExpressions.Regex.Match(exemplarHtml,
                "<(div|section|article)\\b[^>]*>", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
            if (!rootOpen.Success) return ("", "");
            var rootTag = rootOpen.Groups[1].Value.ToLowerInvariant();
            // 根元素的闭合：平衡扫描
            var tagRe = new System.Text.RegularExpressions.Regex($"<(/?){rootTag}\\b[^>]*?(/?)>",
                System.Text.RegularExpressions.RegexOptions.IgnoreCase);
            var depth = 1;
            var scan = rootOpen.Index + rootOpen.Length;
            var innerEnd = -1;
            while (depth > 0)
            {
                var t = tagRe.Match(exemplarHtml, scan);
                if (!t.Success) return ("", "");
                if (t.Groups[2].Value != "/")
                    depth += t.Groups[1].Value == "/" ? -1 : 1;
                if (depth == 0) innerEnd = t.Index;
                scan = t.Index + t.Length;
            }
            var inner = exemplarHtml[(rootOpen.Index + rootOpen.Length)..innerEnd];

            // 顶层子块扫描（div/section/article/footer/svg/aside）
            var childRe = new System.Text.RegularExpressions.Regex(
                "<(div|section|article|footer|svg|aside)\\b[^>]*>",
                System.Text.RegularExpressions.RegexOptions.IgnoreCase);
            var pos = 0;
            while (true)
            {
                var open = childRe.Match(inner, pos);
                if (!open.Success) break;
                var tag = open.Groups[1].Value.ToLowerInvariant();
                var cRe = new System.Text.RegularExpressions.Regex($"<(/?){tag}\\b[^>]*?(/?)>",
                    System.Text.RegularExpressions.RegexOptions.IgnoreCase);
                var d = 1;
                var s = open.Index + open.Length;
                var blockEnd = -1;
                while (d > 0)
                {
                    var t = cRe.Match(inner, s);
                    if (!t.Success) { blockEnd = -1; break; }
                    if (t.Groups[2].Value != "/")
                        d += t.Groups[1].Value == "/" ? -1 : 1;
                    if (d == 0) blockEnd = t.Index + t.Length;
                    s = t.Index + t.Length;
                }
                if (blockEnd < 0) break;
                var block = inner[open.Index..blockEnd];
                var clsM = System.Text.RegularExpressions.Regex.Match(open.Value, "class=\"([^\"]*)\"");
                var cls = clsM.Success ? clsM.Groups[1].Value : "";
                var text = System.Text.RegularExpressions.Regex.Replace(block, "<[^>]+>", " ").Trim();
                if (cls.Contains("footer", StringComparison.OrdinalIgnoreCase))
                    tail.Append(block);
                else if (text.Length == 0)
                    lead.Append(block);
                pos = blockEnd;
            }
        }
        catch
        {
            return ("", "");
        }
        return (lead.ToString(), tail.ToString());
    }

    /// <summary>模型输出中平衡提取第一个 slide 块（div/section 容器通用，支持嵌套）</summary>
    internal static string? ExtractSlideBlock(string text)
    {
        var cleaned = StripCodeFences(text);
        var open = System.Text.RegularExpressions.Regex.Match(cleaned,
            "<(div|section|article)\\b[^>]*class=\"[^\"]*\\bslide\\b[^\"]*\"[^>]*>",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        if (!open.Success) return null;
        var tag = open.Groups[1].Value.ToLowerInvariant();
        var tagRe = new System.Text.RegularExpressions.Regex($"<(/?){tag}\\b[^>]*?(/?)>",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        var depth = 1;
        var scan = open.Index + open.Length;
        while (depth > 0)
        {
            var t = tagRe.Match(cleaned, scan);
            if (!t.Success) return null;
            if (t.Groups[2].Value != "/")
                depth += t.Groups[1].Value == "/" ? -1 : 1;
            scan = t.Index + t.Length;
        }
        return cleaned[open.Index..scan];
    }

    /// <summary>锚定 slide 消毒：去 active、剥内联布局属性、防 vh/vw、复用碎片守卫</summary>
    internal static string? SanitizeAnchoredSlide(string? block)
    {
        if (string.IsNullOrWhiteSpace(block)) return null;
        if (LooksCorruptedSection(block)) return null;
        block = block.Replace(" active\"", "\"").Replace("\"slide active ", "\"slide ").Replace(" active ", " ");
        block = block.Replace("100vh", "100%").Replace("100vw", "100%");
        // 全元素内联样式剥离禁用属性（范本靠类名排版，模型加的内联布局多半就是事故源）
        block = System.Text.RegularExpressions.Regex.Replace(block, "style=\"([^\"]*)\"", m =>
        {
            var kept = new List<string>();
            foreach (var decl in m.Groups[1].Value.Split(';'))
            {
                var d = decl.Trim();
                if (d.Length == 0) continue;
                var name = d.Split(':')[0].Trim().ToLowerInvariant();
                if (name is "position" or "top" or "left" or "right" or "bottom" or "width" or "height"
                    or "margin" or "transform" or "z-index" or "inset"
                    || name.StartsWith("min-") || name.StartsWith("max-") || name.StartsWith("margin-"))
                    continue;
                kept.Add(d);
            }
            return kept.Count > 0 ? $"style=\"{string.Join(";", kept)}\"" : string.Empty;
        });
        return block;
    }

    /// <summary>给装配后的第一个 slide 块补 active（各 zhangzara 运行时以 .active 为当前页）</summary>
    internal static string AddActiveToFirstSlide(string block)
    {
        var m = System.Text.RegularExpressions.Regex.Match(block, "class=\"([^\"]*)\"");
        if (!m.Success) return block;
        var cls = m.Groups[1].Value;
        var tokens = cls.Split(' ', StringSplitOptions.RemoveEmptyEntries).ToList();
        if (!tokens.Contains("active", StringComparer.OrdinalIgnoreCase)) tokens.Add("active");
        if (!tokens.Contains("is-active", StringComparer.OrdinalIgnoreCase)) tokens.Add("is-active");
        return block[..m.Index] + $"class=\"{string.Join(" ", tokens)}\"" + block[(m.Index + m.Length)..];
    }

    private static string ExtractSection(string text)
    {
        var cleaned = StripCodeFences(text);
        var m = System.Text.RegularExpressions.Regex.Match(cleaned, "<section[\\s\\S]*?</section>",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        if (!m.Success) return string.Empty;
        // 上游输出损坏检测（2026-06-11 真实事故）：deepseek 经 OpenRouter 偶发丢字符，
        // 整页 HTML 缺 26 个 "<"，标签碎片被当正文渲染到幻灯上。检测到损坏按无效处理，
        // 让既有「重试一次 → 兜底页」链路接管，绝不把碎标签端给用户。
        if (LooksCorruptedSection(m.Value)) return string.Empty;
        return SanitizeSection(m.Value);
    }

    /// <summary>
    /// 标签碎片检测：剥掉注释与完好标签后，残余"正文"里仍出现 style="/class=" 这种
    /// 属性语法 = 某些 "&lt;" 字符丢失、标签退化成了可见文本。阈值 3 防误伤
    /// （展示代码片段的合法页可能含 1-2 处属性字样）。
    /// </summary>
    internal static bool LooksCorruptedSection(string section)
    {
        if (string.IsNullOrEmpty(section)) return false;
        var t = System.Text.RegularExpressions.Regex.Replace(section, "<!--[\\s\\S]*?-->", " ");
        t = System.Text.RegularExpressions.Regex.Replace(t, "<[^<>]*>", " ");
        var hits = System.Text.RegularExpressions.Regex.Matches(t, "(?:style|class)\\s*=\\s*\"").Count;
        return hits >= 3;
    }

    /// <summary>
    /// 完整 HTML PPT 的统一后端判据。只统计真实标签上的 class token，不让 CSS 中的
    /// “.slide”或“.reveal”形成假阳性；同时要求 body/html 正常闭合，拦住模型上限导致的
    /// 半截 CSS、半截脚本和半份 deck。
    /// </summary>
    internal static bool IsRunnableDeckDocument(string? html)
    {
        if (string.IsNullOrWhiteSpace(html) || html.Length < 200) return false;
        if (!HasBalancedRawTextElements(html, "script") || !HasBalancedRawTextElements(html, "style")) return false;
        var outsideRawText = MaskNonStructuralMarkup(html);
        if (System.Text.RegularExpressions.Regex.Matches(outsideRawText, "<!--").Count !=
            System.Text.RegularExpressions.Regex.Matches(outsideRawText, "-->").Count)
            return false;
        var structuralDocument = MaskNonStructuralMarkup(html);
        if (!System.Text.RegularExpressions.Regex.IsMatch(structuralDocument, "<html\\b[^>]*>", System.Text.RegularExpressions.RegexOptions.IgnoreCase) ||
            !System.Text.RegularExpressions.Regex.IsMatch(structuralDocument, "<head\\b[^>]*>", System.Text.RegularExpressions.RegexOptions.IgnoreCase) ||
            !System.Text.RegularExpressions.Regex.IsMatch(structuralDocument, "</head\\s*>", System.Text.RegularExpressions.RegexOptions.IgnoreCase) ||
            !System.Text.RegularExpressions.Regex.IsMatch(structuralDocument, "<body\\b[^>]*>", System.Text.RegularExpressions.RegexOptions.IgnoreCase) ||
            !System.Text.RegularExpressions.Regex.IsMatch(structuralDocument, "</body\\s*>", System.Text.RegularExpressions.RegexOptions.IgnoreCase) ||
            !System.Text.RegularExpressions.Regex.IsMatch(structuralDocument, "</html\\s*>", System.Text.RegularExpressions.RegexOptions.IgnoreCase))
            return false;

        var headClose = System.Text.RegularExpressions.Regex.Match(structuralDocument, "</head\\s*>", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        if (!headClose.Success) return false;

        var bodyMatch = new System.Text.RegularExpressions.Regex(
            "(?<opening><body\\b[^>]*>)(?<body>[\\s\\S]*?)</body\\s*>",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase)
            .Match(structuralDocument, headClose.Index + headClose.Length);
        if (!bodyMatch.Success) return false;
        if (HasGloballyHiddenCanvas(html, bodyMatch.Groups["opening"].Value)) return false;
        var structuralBody = bodyMatch.Groups["body"].Value;

        static int CountClassToken(string source, string token)
        {
            var tags = System.Text.RegularExpressions.Regex.Matches(
                source,
                "<(?:div|main|section|article)\\b[^>]*\\bclass\\s*=\\s*([\"'])(?<classes>[^\"']*)\\1[^>]*>",
                System.Text.RegularExpressions.RegexOptions.IgnoreCase);
            return tags.Count(match => match.Groups["classes"].Value
                .Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries)
                .Any(value => string.Equals(value, token, StringComparison.OrdinalIgnoreCase)));
        }

        // OpenDesign 锚定模板的外壳并不统一（deck / presentation / slides-container 等）；
        // 真正稳定的合同是正文中存在真实 class token=slide 的页面元素。
        var slideTagCount = CountClassToken(structuralBody, "slide");
        var slideBlocks = FindSlideBlocks(structuralBody);
        var anchoredDeck = slideTagCount > 0 &&
                           slideBlocks.Count == slideTagCount &&
                           !HasHiddenSlideContract(html, structuralBody, slideBlocks) &&
                           slideBlocks.All(block => HasRenderableSlideContent(
                               structuralBody.Substring(block.Start, block.Length)));
        var sectionOpenCount = System.Text.RegularExpressions.Regex.Matches(
            structuralBody, "<section\\b[^>]*>", System.Text.RegularExpressions.RegexOptions.IgnoreCase).Count;
        var sectionCloseCount = System.Text.RegularExpressions.Regex.Matches(
            structuralBody, "</section\\s*>", System.Text.RegularExpressions.RegexOptions.IgnoreCase).Count;
        var revealSections = FindRevealPageBlocks(structuralBody);
        var revealDeck =
                         sectionOpenCount > 0 && sectionOpenCount == sectionCloseCount &&
                         revealSections.Count > 0 &&
                         !HasHiddenSlideContract(html, structuralBody, revealSections) &&
                         revealSections.All(section => HasRenderableSlideContent(
                             structuralBody.Substring(section.Start, section.Length)));
        return anchoredDeck || revealDeck;
    }

    internal static bool LooksLikeLowQualitySlide(string fragment)
    {
        if (string.IsNullOrWhiteSpace(fragment)) return true;
        var heading = FirstVisibleHeading(fragment);
        if (IsGenericSlideHeading(heading)) return true;

        var strongVisualTokens = System.Text.RegularExpressions.Regex.Matches(fragment,
            "\\b(card|stat|grid|feat|table|quote|step|timeline|roadmap|compare|chart|kpi|metric|hero|panel|module|split|poster|matrix|badge|chip|donut|legend|swatch|tile|service|pillar|insight|callout|figure|diagram|node|flow|stage|bar|ring|progress|pie)\\b",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase).Count;
        if (strongVisualTokens >= 2) return false;
        if (System.Text.RegularExpressions.Regex.IsMatch(fragment, "<(svg|table)\\b",
                System.Text.RegularExpressions.RegexOptions.IgnoreCase))
            return false;

        var liCount = System.Text.RegularExpressions.Regex.Matches(fragment, "<li\\b",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase).Count;
        var containerCount = System.Text.RegularExpressions.Regex.Matches(fragment, "<(div|section|article|aside)\\b",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase).Count;
        var headingCount = System.Text.RegularExpressions.Regex.Matches(fragment, "<h[1-3]\\b",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase).Count;
        var hasPlainList = System.Text.RegularExpressions.Regex.IsMatch(fragment, "<ul\\b|<ol\\b",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        return hasPlainList && liCount >= 2 && headingCount <= 2 && containerCount <= 3;
    }

    private static string FirstVisibleHeading(string html)
    {
        var m = System.Text.RegularExpressions.Regex.Match(html, "<h[1-3]\\b[^>]*>([\\s\\S]*?)</h[1-3]>",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        if (!m.Success) return string.Empty;
        var text = System.Text.RegularExpressions.Regex.Replace(m.Groups[1].Value, "<[^>]+>", " ");
        return System.Net.WebUtility.HtmlDecode(text).Trim();
    }

    private static bool IsGenericSlideHeading(string heading)
    {
        if (string.IsNullOrWhiteSpace(heading)) return false;
        var normalized = heading.Trim().Trim('：', ':', '-', ' ', '\t', '\r', '\n');
        return normalized is "封面" or "目录" or "总结" or "标题" or "本页标题" or "概览" or "结束页";
    }

    /// <summary>
    /// 子智能体产出的 section 消毒（2026-06-11 P0：页 2 黑屏根因修复）。
    /// 根因：子智能体把 display:flex / min-height:100vh 写在 section 根元素 inline style 上——
    /// inline 优先级高于 reveal.css 的隐藏规则，非当前页藏不掉、把当前页推出视口（实测 y=836）。
    /// 处置：1) vh 单位在 reveal 960x700 设计框内语义错误，整段替换为安全值；
    /// 2) 根元素 style 拆解——布局类属性挪到内层 .pp-root 包裹层（保留设计意图），
    ///    尺寸/定位类属性直接丢弃；其余（padding/background 等）留在根上；
    /// 3) 始终注入 .pp-root 包裹层，供壳子里的溢出自适应脚本做统一缩放目标。
    /// </summary>
    internal static string SanitizeSection(string section)
    {
        if (string.IsNullOrWhiteSpace(section)) return section;
        section = section.Replace("100vh", "100%").Replace("100VH", "100%");

        var open = System.Text.RegularExpressions.Regex.Match(section, "^\\s*<section([^>]*)>",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        if (!open.Success) return section;

        var attrs = open.Groups[1].Value;
        var wrapperStyle = string.Empty;
        var styleMatch = System.Text.RegularExpressions.Regex.Match(attrs, "\\sstyle\\s*=\\s*\"([^\"]*)\"",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        if (styleMatch.Success)
        {
            // 布局类 → 挪去包裹层；尺寸/定位类 → 丢弃；其余留在 section 根
            var moveToWrapper = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
            {
                "display", "flex-direction", "flex-wrap", "justify-content", "align-items",
                "align-content", "gap", "row-gap", "column-gap", "text-align",
            };
            var drop = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
            {
                "min-height", "height", "max-height", "min-width", "width", "max-width",
                "position", "top", "left", "right", "bottom", "margin", "transform", "inset", "z-index",
            };
            var keep = new List<string>();
            var moved = new List<string>();
            foreach (var decl in styleMatch.Groups[1].Value.Split(';'))
            {
                var d = decl.Trim();
                if (d.Length == 0) continue;
                var name = d.Split(':')[0].Trim();
                if (drop.Contains(name)) continue;
                if (moveToWrapper.Contains(name)) moved.Add(d);
                else keep.Add(d);
            }
            wrapperStyle = string.Join(";", moved);
            var keepStyle = string.Join(";", keep);
            attrs = attrs.Remove(styleMatch.Index, styleMatch.Length);
            if (keepStyle.Length > 0) attrs += $" style=\"{keepStyle}\"";
        }

        var closeIdx = section.LastIndexOf("</section>", StringComparison.OrdinalIgnoreCase);
        if (closeIdx < 0) return section;
        var inner = section[open.Length..closeIdx];
        var wrapperAttr = wrapperStyle.Length > 0 ? $" style=\"{wrapperStyle}\"" : string.Empty;
        return $"<section{attrs}><div class=\"pp-root\"{wrapperAttr}>{inner}</div></section>";
    }

    private static string FallbackSection(MdToPptOutlinePageDto page, int index)
    {
        var enc = (string? t) => System.Net.WebUtility.HtmlEncode(t ?? string.Empty);
        var bullets = (page.Bullets ?? new List<string>())
            .Where(b => !string.IsNullOrWhiteSpace(b))
            .Take(4)
            .ToList();
        while (bullets.Count < 3) bullets.Add("保留核心观点，压缩次要文本，避免低密度空白页");
        var cards = string.Join("", bullets.Take(3).Select((b, n) =>
            $"<div class=\"card\"><div class=\"chip\">{(n + 1):00}</div><h3>{enc(b.Length > 16 ? b[..16] : b)}</h3><p>{enc(b)}</p></div>"));
        return "<section>" +
               $"<div class=\"eyebrow\">第 {index + 1:00} 页 / 设计兜底</div>" +
               $"<h2 class=\"title-xl\">{enc(page.Title)}</h2>" +
               $"<p class=\"lead\">{enc(bullets[0])}</p>" +
               "<div class=\"bar\"></div>" +
               $"<div class=\"grid g3\">{cards}</div>" +
               "</section>";
    }

    internal static string ConsoleDashboardFallbackSlide(MdToPptAnchors.AnchorSlide? layout, MdToPptOutlinePageDto page, int index, int total)
    {
        var enc = (string? t) => System.Net.WebUtility.HtmlEncode(t ?? string.Empty);
        var bullets = (page.Bullets ?? new List<string>())
            .Where(b => !string.IsNullOrWhiteSpace(b))
            .Take(5)
            .ToList();
        while (bullets.Count < 4) bullets.Add("把知识库内容转成可预览、可编辑、可发布的结构化产物");

        var metricCards = string.Join("", bullets.Take(3).Select((b, n) =>
            "<div class=\"panel metric\" style=\"border:1px solid currentColor;border-radius:10px;padding:16px;background:rgba(255,255,255,.08)\">" +
            $"<div style=\"font-size:11px;letter-spacing:.16em;text-transform:uppercase;opacity:.62\">STEP {(n + 1):00}</div>" +
            $"<div style=\"font-size:24px;font-weight:850;line-height:1.05;margin-top:10px\">{enc(b.Length > 12 ? b[..12] : b)}</div>" +
            $"<div style=\"font-size:12px;line-height:1.45;opacity:.68;margin-top:8px\">{enc(b)}</div>" +
            "</div>"));
        var queueRows = string.Join("", bullets.Take(4).Select((b, n) =>
            "<div style=\"display:flex;align-items:center;gap:10px;border-bottom:1px solid rgba(255,255,255,.12);padding:10px 0\">" +
            $"<span style=\"width:22px;height:22px;border-radius:7px;border:1px solid currentColor;display:grid;place-items:center;font-size:11px;opacity:.72\">{n + 1}</span>" +
            $"<span style=\"font-size:13px;line-height:1.35;opacity:.82\">{enc(b)}</span>" +
            "</div>"));
        var flow = string.Join("", new[] { "知识库引用", "内容生成", "实时预览", "人工精修", "网页发布" }.Select((b, n) =>
            "<div style=\"display:flex;align-items:center;gap:8px;min-width:0\">" +
            $"<span style=\"width:26px;height:26px;border-radius:999px;background:currentColor;color:#101624;display:grid;place-items:center;font-size:11px;font-weight:800\">{n + 1}</span>" +
            $"<span style=\"font-size:12px;white-space:nowrap;opacity:.8\">{b}</span>" +
            "</div>"));

        var dashboard =
            "<div class=\"console-dashboard\" style=\"padding:42px 50px;display:grid;grid-template-rows:auto 1fr auto;gap:24px;min-height:620px;font-family:Inter,'PingFang SC',system-ui,sans-serif\">" +
            "<div style=\"display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid rgba(255,255,255,.18);padding-bottom:16px\">" +
            $"<div><div style=\"font-size:11px;letter-spacing:.22em;text-transform:uppercase;opacity:.58\">CONTROL PANEL / {index + 1:00} OF {total:00}</div>" +
            $"<h1 style=\"margin:8px 0 0;font-size:38px;line-height:1.08;font-weight:880;letter-spacing:0;color:currentColor\">{enc(page.Title)}</h1></div>" +
            "<div style=\"display:flex;gap:8px\"><span style=\"border:1px solid currentColor;border-radius:999px;padding:7px 10px;font-size:12px;opacity:.78\">HTML 校验</span><span style=\"border:1px solid currentColor;border-radius:999px;padding:7px 10px;font-size:12px;opacity:.78\">自动发布</span></div>" +
            "</div>" +
            "<div style=\"display:grid;grid-template-columns:1fr 1.08fr;gap:22px;min-height:0\">" +
            "<div style=\"display:grid;grid-template-rows:auto 1fr;gap:16px\">" +
            $"<div style=\"display:grid;grid-template-columns:repeat(3,1fr);gap:12px\">{metricCards}</div>" +
            "<div class=\"panel queue\" style=\"border:1px solid currentColor;border-radius:12px;padding:18px 20px;background:rgba(255,255,255,.06)\">" +
            "<div style=\"font-size:13px;font-weight:800;margin-bottom:6px\">任务队列</div>" + queueRows + "</div></div>" +
            "<div class=\"panel preview\" style=\"border:1px solid currentColor;border-radius:14px;padding:18px;background:rgba(255,255,255,.05);display:grid;grid-template-rows:auto 1fr auto;gap:14px\">" +
            "<div style=\"display:flex;justify-content:space-between;align-items:center\"><strong style=\"font-size:14px\">网页托管预览</strong><span style=\"font-size:12px;opacity:.7\">ready to publish</span></div>" +
            "<div style=\"border:1px solid rgba(255,255,255,.18);border-radius:10px;background:rgba(0,0,0,.18);display:grid;place-items:center;min-height:210px\">" +
            $"<div style=\"text-align:center;max-width:26em\"><div style=\"font-size:46px;font-weight:900;line-height:1\">{Math.Max(2, total):00}</div><p style=\"font-size:14px;line-height:1.55;opacity:.76;margin:12px 0 0\">{enc(bullets[0])}</p></div></div>" +
            $"<div style=\"display:flex;justify-content:space-between;gap:10px\">{flow}</div></div></div>" +
            "<div style=\"display:flex;justify-content:space-between;align-items:center;font-size:12px;opacity:.62;border-top:1px solid rgba(255,255,255,.14);padding-top:14px\"><span>runtime: LLM Gateway</span><span>publish target: web hosting</span></div>" +
            "</div>";

        if (layout == null) return "<section>" + dashboard + "</section>";
        var rootOpen = System.Text.RegularExpressions.Regex.Match(layout.Html,
            "<(div|section|article)\\b[^>]*>", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        if (!rootOpen.Success) return "<section>" + dashboard + "</section>";
        var tag = rootOpen.Groups[1].Value.ToLowerInvariant();
        return rootOpen.Value + dashboard + $"</{tag}>";
    }

    internal static bool ShouldUseGatewayDirect(InfraAgentRuntimeProfile profile)
    {
        var runtime = string.IsNullOrWhiteSpace(profile.Runtime)
            ? InfraAgentRuntimes.ClaudeSdk
            : profile.Runtime.Trim();

        // MD 转 PPT 的页级生成只需要模型调用，不需要文件系统/工具调用 runtime。
        // 生产默认 profile 是 claude-sdk + anthropic，也应走 LLM Gateway 的可运行直出路径；
        // 只有明确依赖 Agent runtime 语义的 codex/custom 保留 CDS Agent 兼容路径。
        return !string.Equals(runtime, InfraAgentRuntimes.Codex, StringComparison.OrdinalIgnoreCase)
            && !string.Equals(runtime, InfraAgentRuntimes.Custom, StringComparison.OrdinalIgnoreCase)
            && !string.Equals(runtime, "cds-agent", StringComparison.OrdinalIgnoreCase);
    }

    private static string GenerationPlatformLabel(InfraAgentRuntimeProfile profile)
        => ShouldUseGatewayDirect(profile) ? "LLM Gateway" : "CDS Agent";

    internal static string GenerationModelLabel(InfraAgentRuntimeProfile profile)
        => string.IsNullOrWhiteSpace(profile.Model) ? "自动选择" : profile.Model.Trim();

    internal static GatewayRequest BuildGatewayPageRequest(
        InfraAgentRuntimeProfile profile,
        string systemPrompt,
        string userPrompt,
        string appCallerCode,
        string? requestId = null,
        string? userId = null,
        string? title = null,
        string? runId = null,
        bool includeThinking = false)
    {
        return new GatewayRequest
        {
            AppCallerCode = appCallerCode,
            ModelType = ModelTypes.Chat,
            ExpectedModel = string.IsNullOrWhiteSpace(profile.Model) ? null : profile.Model.Trim(),
            Stream = true,
            IncludeThinking = includeThinking,
            TimeoutSeconds = Math.Clamp(profile.TimeoutSeconds > 0 ? profile.TimeoutSeconds : 180, 60, 300),
            RequestBody = new JsonObject
            {
                ["messages"] = new JsonArray
                {
                    new JsonObject { ["role"] = "system", ["content"] = systemPrompt },
                    new JsonObject { ["role"] = "user",   ["content"] = userPrompt },
                },
                ["temperature"] = 0.48,
                // 默认模型池可能回落到 4K 输出模型；单页与两页短 deck 先保证可运行。
                // 更长输出由并行逐页生成承接，不用超限参数换取表面上的一次性长输出。
                ["max_tokens"] = 4096,
            },
            Context = new GatewayRequestContext
            {
                RequestId = requestId,
                RunId = runId,
                UserId = userId,
                SourceSystem = "map",
                IngressProtocol = "gw-native",
                AppCallerTitle = title,
                ModelPolicy = "pinned",
                ParameterPolicy = "md-to-ppt-page",
            },
        };
    }

    internal static bool IsRunnableSlideFragment(string fragment, bool anchored)
    {
        if (string.IsNullOrWhiteSpace(fragment)) return false;
        var trimmed = fragment.Trim();
        if (trimmed.StartsWith("```", StringComparison.Ordinal)) return false;
        if (trimmed.Contains("<script", StringComparison.OrdinalIgnoreCase)) return false;
        if (trimmed.Contains("<html", StringComparison.OrdinalIgnoreCase)
            || trimmed.Contains("<head", StringComparison.OrdinalIgnoreCase)
            || trimmed.Contains("<body", StringComparison.OrdinalIgnoreCase)
            || trimmed.Contains("<style", StringComparison.OrdinalIgnoreCase))
            return false;
        if (LooksCorruptedSection(trimmed)) return false;
        if (anchored)
        {
            if (!System.Text.RegularExpressions.Regex.IsMatch(trimmed, "^\\s*<(div|section|article)\\b[^>]*class\\s*=\\s*\"[^\"]*\\bslide\\b",
                    System.Text.RegularExpressions.RegexOptions.IgnoreCase))
                return false;
        }
        else if (!System.Text.RegularExpressions.Regex.IsMatch(trimmed, "^\\s*<section\\b[\\s\\S]*</section>\\s*$",
                     System.Text.RegularExpressions.RegexOptions.IgnoreCase))
        {
            return false;
        }

        return System.Text.RegularExpressions.Regex.Matches(trimmed, "<").Count >= 2
            && !LooksLikeLowQualitySlide(trimmed);
    }

    private static string NormalizeGeneratedSlideFragment(string? text, bool anchored)
    {
        if (string.IsNullOrWhiteSpace(text)) return string.Empty;
        var fragment = anchored
            ? SanitizeAnchoredSlide(ExtractSlideBlock(text)) ?? string.Empty
            : ExtractSection(text);
        return IsRunnableSlideFragment(fragment, anchored) ? fragment : string.Empty;
    }

    private sealed record PageGenerationResult(
        string? Text,
        string? Error,
        string? ActualModel,
        string? ActualPlatform);

    private async Task<PageGenerationResult> RunGatewayPageOnceAsync(
        string userId,
        InfraAgentRuntimeProfile profile,
        string systemPrompt,
        string userPrompt,
        string title,
        string runId)
    {
        try
        {
            var requestId = Guid.NewGuid().ToString("N");
            using var _ = _llmRequestContext.BeginScope(new LlmRequestContext(
                RequestId: requestId,
                GroupId: null,
                SessionId: runId,
                UserId: userId,
                ViewRole: null,
                DocumentChars: userPrompt.Length,
                DocumentHash: null,
                SystemPromptRedacted: "[MdToPpt-Page]",
                RequestType: "chat",
                AppCallerCode: AppCallerRegistry.MdToPptAgent.Generation.HtmlGenerate,
                RunId: runId));

            var request = BuildGatewayPageRequest(
                profile,
                systemPrompt,
                userPrompt,
                AppCallerRegistry.MdToPptAgent.Generation.HtmlGenerate,
                requestId,
                userId,
                title,
                runId);

            var fullText = new StringBuilder();
            string? actualModel = null;
            string? actualPlatform = null;
            await foreach (var chunk in _gateway.StreamAsync(request, CancellationToken.None))
            {
                if (chunk.Type == GatewayChunkType.Start && chunk.Resolution != null)
                {
                    actualModel = chunk.Resolution.ActualModel;
                    actualPlatform = chunk.Resolution.ActualPlatformName ?? chunk.Resolution.ActualPlatformId;
                    continue;
                }
                if (chunk.Type == GatewayChunkType.Text && !string.IsNullOrEmpty(chunk.Content))
                {
                    fullText.Append(chunk.Content);
                    continue;
                }

                if (chunk.Type == GatewayChunkType.Error)
                {
                    return new PageGenerationResult(null, chunk.Error ?? "LLM Gateway 页面生成失败", actualModel, actualPlatform);
                }
            }

            var raw = fullText.ToString();
            return string.IsNullOrWhiteSpace(raw)
                ? new PageGenerationResult(null, "LLM Gateway 未返回页面 HTML", actualModel, actualPlatform)
                : new PageGenerationResult(raw, null, actualModel, actualPlatform);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[MdToPpt-Page] gateway page generation failed: {Msg}", ex.Message);
            return new PageGenerationResult(null, ex.Message, null, null);
        }
    }

    private async Task<PageGenerationResult> RunPageOnceAsync(
        string userId,
        InfraConnection? connection,
        InfraAgentRuntimeProfile profile,
        string systemPrompt,
        string userPrompt,
        string title,
        string runId,
        InfraAgentSessionView? presession)
    {
        if (ShouldUseGatewayDirect(profile))
            return await RunGatewayPageOnceAsync(userId, profile, systemPrompt, userPrompt, title, runId);

        if (connection == null)
            return new PageGenerationResult(null, "没有可用的 active CDS 连接，请先完成系统级 CDS 授权", null, null);

        var (text, error) = await RunAgentOnceAsync(userId, connection, profile, systemPrompt, userPrompt, title, presession);
        return new PageGenerationResult(text, error, null, null);
    }

    /// <summary>单次 agent 会话往返：创建/复用 → 发送 → 轮询至 done，返回最终文本（页级子任务用）</summary>
    private async Task<(string? text, string? error)> RunAgentOnceAsync(
        string userId,
        InfraConnection connection,
        InfraAgentRuntimeProfile profile,
        string systemPrompt,
        string userPrompt,
        string title,
        InfraAgentSessionView? presession)
    {
        InfraAgentSessionView? session = presession;
        try
        {
            // 永不抛（2026-06-12 实测：单页 HttpClient 100s 超时异常逃逸炸掉整本 deck）——
            // 任何传输层异常都折叠为 (null, message)，由调用方走"重试一次 -> 兜底页"链路
            if (session == null)
            {
                session = await _sessions.CreateAsync(userId,
                    new CreateInfraAgentSessionRequest(
                        connection.Id, profile.Runtime, profile.Model, title,
                        InfraAgentToolPolicies.DenyAll, null, profile.Id, null, null, null, null, "md-to-ppt"),
                    CancellationToken.None);
                if (!string.Equals(session.Status, InfraAgentSessionStatuses.Running, StringComparison.OrdinalIgnoreCase))
                {
                    session = await _sessions.StartAsync(userId, session.Id,
                        new StartInfraAgentSessionRequest(profile.Runtime, profile.Model),
                        CancellationToken.None) ?? session;
                }
            }

            await _sessions.SendMessageAsync(userId, session.Id,
                new SendInfraAgentMessageRequest($"{systemPrompt}\n\n---\n\n{userPrompt}"),
                CancellationToken.None);

            var afterSeq = 0L;
            var fullText = new StringBuilder();
            for (var round = 0; round < 300; round++) // ~4 分钟/页
            {
                var batch = await _sessions.ListEventsAsync(userId, session.Id, afterSeq, 50, CancellationToken.None);
                foreach (var evt in batch.OrderBy(x => x.Seq))
                {
                    if (evt.Seq <= afterSeq) continue;
                    afterSeq = evt.Seq;
                    try
                    {
                        using var doc = JsonDocument.Parse(evt.PayloadJson ?? "{}");
                        var root = doc.RootElement;
                        switch (evt.Type)
                        {
                            case InfraAgentEventTypes.TextDelta:
                                if (root.TryGetProperty("text", out var tp))
                                    fullText.Append(tp.GetString() ?? "");
                                break;
                            case InfraAgentEventTypes.Done:
                                var raw = root.TryGetProperty("finalText", out var fp) ? fp.GetString() ?? "" : "";
                                return (string.IsNullOrEmpty(raw) ? fullText.ToString() : raw, null);
                            case InfraAgentEventTypes.Error:
                                var msg = root.TryGetProperty("message", out var mp) ? mp.GetString() : null;
                                return (null, msg ?? "CDS Agent 页面生成失败");
                        }
                    }
                    catch { /* 单事件解析失败不致命 */ }
                }
                await Task.Delay(800);
            }
            return (null, "页面生成超时");
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[MdToPpt-Page] transport failure folded to page error: {Msg}", ex.Message);
            return (null, ex.Message);
        }
        finally
        {
            if (session != null)
            {
                try { await _sessions.StopAsync(userId, session.Id, CancellationToken.None); } catch { }
            }
        }
    }

    /// <summary>并行逐页生成：frame（壳子）→ N 路并行 page 事件 → 拼装 done</summary>
    private async Task RunPagesGenerationAsync(string userId, MdToPptConvertRequest req, MdToPptRun run)
    {
        var startedAt = DateTime.UtcNow;
        var pages = req.OutlinePages!;
        var total = pages.Count;
        var sseLock = new SemaphoreSlim(1, 1);

        async Task EmitAsync(string evt, object payload)
        {
            await sseLock.WaitAsync();
            try { await WriteEventAsync(evt, payload); }
            finally { sseLock.Release(); }
        }

        var profile = await ResolveRuntimeProfileAsync(userId, CancellationToken.None, req.RuntimeProfileId);
        if (profile == null)
        {
            await PersistRunErrorAsync(run, "没有可用的模型运行配置");
            await EmitAsync("error", new { message = "没有可用的模型运行配置，请先配置 baseUrl、model 和 API key" });
            return;
        }
        var platform = GenerationPlatformLabel(profile);
        var connection = ShouldUseGatewayDirect(profile) ? null : await ResolveCdsConnectionAsync(CancellationToken.None);
        if (!ShouldUseGatewayDirect(profile) && connection == null)
        {
            await PersistRunErrorAsync(run, "没有可用的 active CDS 连接，请先完成系统级 CDS 授权");
            await EmitAsync("error", new { message = "没有可用的 active CDS 连接，请先完成系统级 CDS 授权" });
            return;
        }
        await EmitAsync("model", new { model = GenerationModelLabel(profile), platform });

        var deckTitle = pages[0].Title is { Length: > 0 } t ? t : (req.Summary ?? "PPT 演示");
        // 锚定 deck 模式（2026-06-12）：人工精调成品模板做壳子与版式范本；
        // 锚定资产缺失时回落旧 reveal 壳子（不应发生，保险）
        var effectiveTheme = EffectiveThemeForRequest(req.Theme, req.Content, req.Summary);
        var consoleDashboardMode = IsConsoleDashboardBrief(req.Content, req.Summary);
        var anchor = MdToPptAnchors.Resolve(effectiveTheme);
        string head, suffix;
        if (anchor != null)
        {
            head = anchor.Prefix;
            suffix = anchor.Suffix;
        }
        else
        {
            (head, suffix) = BuildDeckShell(effectiveTheme, deckTitle);
        }
        head = MdToPptAnchors.EnsureMobilePresentationGuard(head, anchor?.Name);
        head = System.Text.RegularExpressions.Regex.Replace(
            head,
            "<title\\b[^>]*>[\\s\\S]*?</title\\s*>",
            $"<title>{System.Net.WebUtility.HtmlEncode(deckTitle)}</title>",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        await EmitAsync("frame", new { head, suffix, total, anchored = anchor != null, anchor = anchor?.Name, skill = "github-html-ppt" });
        await EmitAsync("diag", new
        {
            stage = "design_contract",
            total,
            parallel = 4,
            route = ShouldUseGatewayDirect(profile) ? "gateway-direct" : "cds-agent",
            skill = "github-html-ppt",
            skillSource = "nexu-io/open-design/plugins/_official/examples/html-ppt",
            quality = "style-consistency-and-html-validation"
        });
        _logger.LogInformation("[MdToPpt-Pages] start userId={UserId} total={Total} platform={Platform}", userId, total, platform);

        // 心跳：并行期间 SSE 不断流
        var clientGone = false;
        using var kaCts = new CancellationTokenSource();
        var kaTask = Task.Run(async () =>
        {
            try
            {
                while (!kaCts.Token.IsCancellationRequested)
                {
                    await Task.Delay(10000, kaCts.Token);
                    if (clientGone) continue;
                    await sseLock.WaitAsync();
                    try
                    {
                        await Response.WriteAsync(": keepalive\n\n", CancellationToken.None);
                        await Response.Body.FlushAsync(CancellationToken.None);
                    }
                    catch { clientGone = true; }
                    finally { sseLock.Release(); }
                }
            }
            catch (OperationCanceledException) { }
        });

        var sections = new string[total];
        var gate = new SemaphoreSlim(4, 4); // 并行度：4 路页面生成
        var presession = ShouldUseGatewayDirect(profile)
            ? null
            : await TakePrewarmedSessionAsync(userId, profile.Id); // 预热会话给第 1 页（模型须匹配）
        var doneCount = 0;
        // 退化为「范本/裸要点」兜底页：按页打标（每页一个槽位，写两次仍是 true，幂等），
        // 避免用共享计数器在「retry 兜底后 EmitAsync 又抛 → 外层 catch 再加一次」时重复计数（Bugbot Medium）
        var fallbackFlags = new bool[total];
        var actualModels = new string?[total];
        var actualPlatforms = new string?[total];

        try
        {
            var tasks = Enumerable.Range(0, total).Select(async i =>
            {
                await gate.WaitAsync();
                try
                {
                  try
                  {
                    string sys, usr;
                    MdToPptAnchors.AnchorSlide? layout = null;
                    if (anchor != null)
                    {
                        layout = MdToPptAnchors.PickLayout(anchor, i, total, pages[i].Design);
                        sys = BuildAnchoredPageSystemPrompt(anchor, layout, i, total);
                        usr = BuildAnchoredPageUserPrompt(req, i, total);
                    }
                    else
                    {
                        sys = BuildPageSystemPrompt(effectiveTheme, i, total);
                        usr = BuildPageUserPrompt(req, i, total);
                    }
                    await EmitAsync("diag", new
                    {
                        stage = "page_start",
                        index = i,
                        total,
                        title = pages[i].Title,
                        elapsedMs = (int)(DateTime.UtcNow - startedAt).TotalMilliseconds
                    });
                    if (consoleDashboardMode)
                    {
                        var dashboardSection = ConsoleDashboardFallbackSlide(layout, pages[i], i, total);
                        sections[i] = dashboardSection;
                        var dashboardDone = Interlocked.Increment(ref doneCount);
                        var dashboardMs = (int)(DateTime.UtcNow - startedAt).TotalMilliseconds;
                        _logger.LogInformation("[MdToPpt-Pages] page {Idx} dashboard-rendered {N}/{Total} elapsedMs={Ms}", i, dashboardDone, total, dashboardMs);
                        await EmitAsync("page", new { index = i, total, html = dashboardSection, done = dashboardDone });
                        return;
                    }
                    var pageResult = await RunPageOnceAsync(
                        userId, connection, profile, sys, usr, $"PPT 第{i + 1}页", run.Id, i == 0 ? presession : null);
                    var section = NormalizeGeneratedSlideFragment(pageResult.Text, anchor != null);
                    if (anchor != null && layout != null && !string.IsNullOrEmpty(section))
                        section = RewriteAnchorSampleResidue(section, layout, pages[i], req.Summary, req.Content);
                    if (anchor != null && !string.IsNullOrEmpty(section))
                        section = NormalizeSlidePageIdentity(section, i, total);
                    if (anchor != null && layout != null && !string.IsNullOrEmpty(section) &&
                        ContainsAnchorSampleResidue(section, layout, pages[i], req.Summary, req.Content))
                    {
                        _logger.LogWarning("[MdToPpt-Pages] page {Idx} retained anchor sample text, retrying", i);
                        section = string.Empty;
                    }
                    if (anchor != null && !string.IsNullOrEmpty(section) &&
                        ContainsUnsupportedVisibleClaims(section, pages[i], req.Summary, req.Content, i, total))
                    {
                        _logger.LogWarning("[MdToPpt-Pages] page {Idx} contains unsupported visible claims, retrying", i);
                        section = string.Empty;
                    }
                    if (consoleDashboardMode && !string.IsNullOrEmpty(section) && LooksLikeConsoleVisualMismatch(section, anchor?.Name))
                    {
                        _logger.LogWarning("[MdToPpt-Pages] page {Idx} console visual mismatch anchor={Anchor}, retrying", i, anchor?.Name);
                        section = string.Empty;
                    }
                    string? acceptedModel = null;
                    string? acceptedPlatform = null;
                    if (!string.IsNullOrEmpty(section))
                    {
                        acceptedModel = pageResult.ActualModel;
                        acceptedPlatform = pageResult.ActualPlatform;
                    }
                    if (string.IsNullOrEmpty(section))
                    {
                        // 单页失败重试一次，再失败用范本兜底（结构不塌，内容退化为范本+标题要点）
                        if (pageResult.Error == null || pageResult.Text != null)
                            _logger.LogWarning("[MdToPpt-Pages] page {Idx} invalid block, retrying", i);
                        var retryResult = await RunPageOnceAsync(
                            userId, connection, profile, sys, usr, $"PPT 第{i + 1}页R", run.Id, null);
                        section = NormalizeGeneratedSlideFragment(retryResult.Text, anchor != null);
                        if (anchor != null && layout != null && !string.IsNullOrEmpty(section))
                            section = RewriteAnchorSampleResidue(section, layout, pages[i], req.Summary, req.Content);
                        if (anchor != null && !string.IsNullOrEmpty(section))
                            section = NormalizeSlidePageIdentity(section, i, total);
                        if (anchor != null && layout != null && !string.IsNullOrEmpty(section) &&
                            ContainsAnchorSampleResidue(section, layout, pages[i], req.Summary, req.Content))
                        {
                            _logger.LogWarning("[MdToPpt-Pages] page {Idx} retained anchor sample text after retry, using fallback", i);
                            section = string.Empty;
                        }
                        if (anchor != null && !string.IsNullOrEmpty(section) &&
                            ContainsUnsupportedVisibleClaims(section, pages[i], req.Summary, req.Content, i, total))
                        {
                            _logger.LogWarning("[MdToPpt-Pages] page {Idx} contains unsupported visible claims after retry, using fallback", i);
                            section = string.Empty;
                        }
                        if (consoleDashboardMode && !string.IsNullOrEmpty(section) && LooksLikeConsoleVisualMismatch(section, anchor?.Name))
                        {
                            _logger.LogWarning("[MdToPpt-Pages] page {Idx} console visual mismatch after retry anchor={Anchor}, using dashboard fallback", i, anchor?.Name);
                            section = string.Empty;
                        }
                        if (!string.IsNullOrEmpty(section))
                        {
                            acceptedModel = retryResult.ActualModel;
                            acceptedPlatform = retryResult.ActualPlatform;
                        }
                        if (string.IsNullOrEmpty(section))
                        {
                            fallbackFlags[i] = true;
                            section = consoleDashboardMode
                                ? ConsoleDashboardFallbackSlide(layout, pages[i], i, total)
                                : anchor != null && layout != null
                                ? AnchoredFallbackSlide(layout, pages[i], i, total)
                                : SanitizeSection(FallbackSection(pages[i], i));
                        }
                    }
                    actualModels[i] = acceptedModel;
                    actualPlatforms[i] = acceptedPlatform;
                    sections[i] = NormalizeSlidePageIdentity(section, i, total);
                    var n = Interlocked.Increment(ref doneCount);
                    var ms = (int)(DateTime.UtcNow - startedAt).TotalMilliseconds;
                    _logger.LogInformation("[MdToPpt-Pages] page {Idx} done {N}/{Total} elapsedMs={Ms}", i, n, total, ms);
                    await EmitAsync("page", new { index = i, total, html = section, done = n });
                  }
                  catch (Exception pageEx)
                  {
                      // 单页全链路兜底：任何异常都不许杀整本
                      _logger.LogError(pageEx, "[MdToPpt-Pages] page {Idx} hard-failed, fallback slide", i);
                      fallbackFlags[i] = true;
                      var fb = consoleDashboardMode
                          ? ConsoleDashboardFallbackSlide(anchor != null ? MdToPptAnchors.PickLayout(anchor, i, total, pages[i].Design) : null, pages[i], i, total)
                          : anchor != null
                          ? AnchoredFallbackSlide(MdToPptAnchors.PickLayout(anchor, i, total, pages[i].Design), pages[i], i, total)
                          : SanitizeSection(FallbackSection(pages[i], i));
                      sections[i] = NormalizeSlidePageIdentity(fb, i, total);
                      var n2 = Interlocked.Increment(ref doneCount);
                      await EmitAsync("page", new { index = i, total, html = fb, done = n2 });
                  }
                }
                finally { gate.Release(); }
            }).ToList();

            await Task.WhenAll(tasks);

            if (anchor != null && sections.Length > 0 && !string.IsNullOrEmpty(sections[0]))
                sections[0] = AddActiveToFirstSlide(sections[0]);
            var html = NormalizePresentationDocument(head + string.Join("\n", sections) + suffix);
            var totalMs = (int)(DateTime.UtcNow - startedAt).TotalMilliseconds;
            var fallbackCount = fallbackFlags.Count(b => b);
            _logger.LogInformation("[MdToPpt-Pages] DONE userId={UserId} totalMs={Ms} htmlLen={Len} degraded={Degraded}/{Total}", userId, totalMs, html.Length, fallbackCount, total);
            if (!IsRunnableDeckDocument(html))
            {
                const string message = "逐页生成结果不完整，未保存。请重新生成演示稿";
                await PersistRunErrorAsync(run, message);
                await EmitAsync("error", new { message });
                return;
            }
            run.ResolvedModels = actualModels
                .Where(value => !string.IsNullOrWhiteSpace(value))
                .Select(value => value!.Trim())
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToList();
            run.ResolvedPlatforms = actualPlatforms
                .Where(value => !string.IsNullOrWhiteSpace(value))
                .Select(value => value!.Trim())
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToList();
            var actualModel = run.ResolvedModels.Count > 0
                ? string.Join(", ", run.ResolvedModels)
                : GenerationModelLabel(profile);
            if (!await PersistRunDoneAsync(run, html, actualModel, platform, fallbackCount, total))
            {
                await EmitAsync("error", new { message = "演示稿已生成但版本保存失败，请重试" });
                return;
            }
            await EmitAsync("done", new { html, degraded = fallbackCount, total });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[MdToPpt-Pages] failed userId={UserId}", userId);
            await PersistRunErrorAsync(run, ex.Message);
            await EmitAsync("error", new { message = ex.Message });
        }
        finally
        {
            kaCts.Cancel();
            try { await kaTask; } catch { }
        }
    }

    /// <summary>
    /// 定向单页 patch：抽出目标 section → 单个子智能体按页级提示词重画 → 消毒 → 原位替换。
    /// 返回 false 表示无法走单页路径（页索引越界 / deck 结构不识别），调用方回落整篇路径。
    /// 失败（agent 不可用等）时发 error 事件并返回 true（已处理，不再二次跑整篇）。
    /// </summary>
    private async Task<bool> TryRunSinglePagePatchAsync(
        string userId,
        MdToPptPatchRequest req,
        MdToPptRun run,
        int oneBasedIndex,
        MdToPptTemplate? template)
    {
        var html = req.CurrentHtml!;
        // 锚定 deck（div.slide 嵌套）与旧 reveal（顶层 section）统一走平衡扫描
        // 先等长掩蔽 script/style/comment，保留原始 offset；不能把脚本字符串里的示例标签当成第一页。
        // Reveal 的纵向演示以外层 section 包裹多个叶子 section；精修页码必须与
        // 验证器认定的实际页面一致，不能用首个 closing tag 截断外层结构。
        var blocks = FindPatchPageBlocks(html);
        if (blocks.Count == 0 || oneBasedIndex < 1 || oneBasedIndex > blocks.Count) return false;

        var profile = await ResolveRuntimeProfileAsync(userId, CancellationToken.None, req.RuntimeProfileId);
        if (profile == null) return false; // 回落整篇路径（它有自己的错误提示）
        var connection = ShouldUseGatewayDirect(profile) ? null : await ResolveCdsConnectionAsync(CancellationToken.None);
        if (!ShouldUseGatewayDirect(profile) && connection == null) return false; // 回落整篇路径（它有自己的错误提示）

        var platform = GenerationPlatformLabel(profile);
        await WriteEventAsync("model", new { model = GenerationModelLabel(profile), platform });
        await WriteDiagAsync(new
        {
            stage = "page_patch_start",
            page = oneBasedIndex,
            total = blocks.Count,
            route = ShouldUseGatewayDirect(profile) ? "gateway-direct" : "cds-agent",
            quality = "style-consistency-and-html-validation"
        });
        _logger.LogInformation("[MdToPpt-PagePatch] start userId={UserId} page={Page}/{Total}", userId, oneBasedIndex, blocks.Count);

        // 心跳：单页重画 1-3 分钟，SSE 不能断流（Cloudflare 100s 缓冲）
        using var kaCts = new CancellationTokenSource();
        var kaTask = Task.Run(async () =>
        {
            try
            {
                while (!kaCts.Token.IsCancellationRequested)
                {
                    await Task.Delay(10000, kaCts.Token);
                    try
                    {
                        await Response.WriteAsync(": keepalive\n\n", CancellationToken.None);
                        await Response.Body.FlushAsync(CancellationToken.None);
                    }
                    catch { /* 客户端断开不影响生成（服务器权威性） */ }
                }
            }
            catch (OperationCanceledException) { }
        });

        try
        {
            var idx = oneBasedIndex - 1;
            var current = html.Substring(blocks[idx].Start, blocks[idx].Length);
            // 输出片段形态由现有 deck 决定，而不是由当前主题决定：旧 Reveal deck 必须继续
            // 返回 section，OpenDesign 锚定 deck 才能返回 class=slide 的同构块。
            var targetIsAnchored = IsAnchoredPatchBlock(current);
            var patchAnchor = targetIsAnchored && template == null ? MdToPptAnchors.Resolve(req.Theme) : null;
            var sys = patchAnchor != null
                ? BuildAnchoredPageSystemPrompt(patchAnchor,
                    MdToPptAnchors.PickLayout(patchAnchor, idx, blocks.Count, null), idx, blocks.Count)
                : BuildPageSystemPrompt(req.Theme, idx, blocks.Count, template?.StyleSpec);
            var usr =
                $"这是第 {oneBasedIndex}/{blocks.Count} 页当前的 HTML：\n{current}\n\n" +
                $"修改要求（只动这一页）：\n{req.SlideRequest?.Trim()}\n\n" +
                "硬约束：未被修改要求点名的信息内容必须逐字保留（数字、名称、要点一字不差）；" +
                "重新设计排版时严格遵守画布与版面硬约束。";

            var pageResult = await RunPageOnceAsync(
                userId, connection, profile, sys, usr, $"PPT 第{oneBasedIndex}页修改", run.Id, null);
            string? actualModel = null;
            string? actualPlatform = null;
            var section = NormalizeGeneratedSlideFragment(pageResult.Text, targetIsAnchored);
            if (!string.IsNullOrEmpty(section))
            {
                actualModel = pageResult.ActualModel;
                actualPlatform = pageResult.ActualPlatform;
            }
            if (string.IsNullOrEmpty(section))
            {
                _logger.LogWarning("[MdToPpt-PagePatch] invalid section, retrying page={Page} err={Err}", oneBasedIndex, pageResult.Error);
                var retryResult = await RunPageOnceAsync(
                    userId, connection, profile, sys, usr, $"PPT 第{oneBasedIndex}页修改R", run.Id, null);
                section = NormalizeGeneratedSlideFragment(retryResult.Text, targetIsAnchored);
                if (!string.IsNullOrEmpty(section))
                {
                    actualModel = retryResult.ActualModel;
                    actualPlatform = retryResult.ActualPlatform;
                }
                if (string.IsNullOrEmpty(section))
                {
                    var msg = retryResult.Error ?? pageResult.Error ?? "单页重绘失败，请重试";
                    await PersistRunErrorAsync(run, msg);
                    await WriteEventAsync("error", new { message = msg });
                    return true;
                }
            }

            var newHtml = NormalizePresentationDocument(
                html[..blocks[idx].Start] + section + html[(blocks[idx].Start + blocks[idx].Length)..]);
            if (!IsRunnableDeckDocument(newHtml))
            {
                const string message = "精修结果不完整，未替换当前演示稿，请重试";
                await PersistRunErrorAsync(run, message);
                await WriteEventAsync("error", new { message });
                return true;
            }
            run.ResolvedModels = string.IsNullOrWhiteSpace(actualModel) ? new List<string>() : new List<string> { actualModel };
            run.ResolvedPlatforms = string.IsNullOrWhiteSpace(actualPlatform) ? new List<string>() : new List<string> { actualPlatform };
            if (!await PersistRunDoneAsync(run, newHtml, actualModel ?? GenerationModelLabel(profile), platform))
            {
                await WriteEventAsync("error", new { message = "精修结果已生成但版本保存失败，请重试" });
                return true;
            }
            await WriteEventAsync("page", new { index = idx, total = blocks.Count, html = section, done = 1 });
            await WriteEventAsync("done", new { html = newHtml });
            _logger.LogInformation("[MdToPpt-PagePatch] DONE userId={UserId} page={Page} newLen={Len}", userId, oneBasedIndex, newHtml.Length);
            return true;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[MdToPpt-PagePatch] failed userId={UserId} page={Page}", userId, oneBasedIndex);
            await PersistRunErrorAsync(run, ex.Message);
            await WriteEventAsync("error", new { message = ex.Message });
            return true;
        }
        finally
        {
            kaCts.Cancel();
            try { await kaTask; } catch { }
        }
    }

    private async Task RunGatewayDeckStreamAsync(
        string userId,
        InfraAgentRuntimeProfile profile,
        string systemPrompt,
        string userPrompt,
        string title,
        MdToPptRun run)
    {
        var requestId = Guid.NewGuid().ToString("N");
        using var _ = _llmRequestContext.BeginScope(new LlmRequestContext(
            RequestId: requestId,
            GroupId: null,
            SessionId: run.Id,
            UserId: userId,
            ViewRole: null,
            DocumentChars: userPrompt.Length,
            DocumentHash: null,
            SystemPromptRedacted: "[MdToPpt-Deck]",
            RequestType: "chat",
            AppCallerCode: AppCallerRegistry.MdToPptAgent.Generation.HtmlGenerate,
            RunId: run.Id));

        var request = BuildGatewayPageRequest(
            profile,
            systemPrompt,
            userPrompt,
            AppCallerRegistry.MdToPptAgent.Generation.HtmlGenerate,
            requestId,
            userId,
            title,
            runId: run.Id,
            includeThinking: true);
        var fullText = new StringBuilder();
        var model = GenerationModelLabel(profile);
        var resolvedPlatform = "LLM Gateway";

        await WriteEventAsync("model", new { model, platform = "LLM Gateway" });
        await WriteDiagAsync(new { stage = "gateway_direct", route = "gateway-direct", runId = run.Id });
        try
        {
            await foreach (var chunk in _gateway.StreamAsync(request, CancellationToken.None))
            {
                if (chunk.Type == GatewayChunkType.Start && chunk.Resolution != null)
                {
                    model = chunk.Resolution.ActualModel;
                    resolvedPlatform = chunk.Resolution.ActualPlatformName
                        ?? chunk.Resolution.ActualPlatformId
                        ?? resolvedPlatform;
                    await WriteEventAsync("model", new { model, platform = "LLM Gateway" });
                }
                else if (chunk.Type == GatewayChunkType.Thinking && !string.IsNullOrEmpty(chunk.Content))
                {
                    await WriteEventAsync("thinking", new { text = chunk.Content });
                }
                else if (chunk.Type == GatewayChunkType.Text && !string.IsNullOrEmpty(chunk.Content))
                {
                    fullText.Append(chunk.Content);
                    await WriteEventAsync("delta", new { text = chunk.Content });
                }
                else if (chunk.Type == GatewayChunkType.Error)
                {
                    var message = chunk.Error ?? chunk.Content ?? "LLM Gateway 生成失败";
                    await PersistRunErrorAsync(run, message);
                    await WriteEventAsync("error", new { message });
                    return;
                }
            }

            var html = NormalizePresentationDocument(StripCodeFences(fullText.ToString()));
            if (!IsRunnableDeckDocument(html))
            {
                const string message = "生成结果不完整，未替换当前演示稿，请重试";
                await PersistRunErrorAsync(run, message);
                await WriteEventAsync("error", new { message });
                return;
            }

            run.ResolvedModels = string.IsNullOrWhiteSpace(model) ? new List<string>() : new List<string> { model };
            run.ResolvedPlatforms = new List<string> { resolvedPlatform };
            if (!await PersistRunDoneAsync(run, html, model, "LLM Gateway"))
            {
                await WriteEventAsync("error", new { message = "演示稿已生成但版本保存失败，请重试" });
                return;
            }
            await WriteEventAsync("done", new { html });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[MdToPpt-Gateway] generation failed userId={UserId}", userId);
            await PersistRunErrorAsync(run, ex.Message);
            await WriteEventAsync("error", new { message = ex.Message });
        }
    }

    private async Task RunAgentStreamAsync(string userId, string systemPrompt, string userPrompt, string title, MdToPptRun run, string? runtimeProfileId = null)
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
            // 1. 先解析运行配置；系统默认配置走 LLM Gateway，不要求用户额外绑定 CDS。
            var t0 = DateTime.UtcNow;
            runtimeProfile = await ResolveRuntimeProfileAsync(userId, CancellationToken.None, runtimeProfileId);
            if (runtimeProfile == null)
            {
                await PersistRunErrorAsync(run, "没有可用的模型运行配置，请先配置 baseUrl、model 和 API key");
                await WriteEventAsync("error", new { message = "没有可用的模型运行配置，请先配置 baseUrl、model 和 API key" });
                return;
            }
            var profileMs = (int)(DateTime.UtcNow - t0).TotalMilliseconds;
            _logger.LogInformation("[MdToPpt-Agent] profile resolved elapsedMs={Ms} runtime={Runtime} model={Model}",
                profileMs, runtimeProfile.Runtime, runtimeProfile.Model);
            await WriteDiagAsync(new { stage = "profile", elapsedMs = profileMs, runtime = runtimeProfile.Runtime, model = runtimeProfile.Model });

            if (ShouldUseGatewayDirect(runtimeProfile))
            {
                await RunGatewayDeckStreamAsync(userId, runtimeProfile, systemPrompt, userPrompt, title, run);
                return;
            }

            // 2. 只有明确选择 Codex/custom/CDS Agent runtime 时才需要 CDS 连接。
            var t1 = DateTime.UtcNow;
            connection = await ResolveCdsConnectionAsync(CancellationToken.None);
            if (connection == null)
            {
                await PersistRunErrorAsync(run, "没有可用的 active CDS 连接，请先完成系统级 CDS 授权");
                await WriteEventAsync("error", new { message = "没有可用的 active CDS 连接，请先完成系统级 CDS 授权" });
                return;
            }
            var connMs = (int)(DateTime.UtcNow - t1).TotalMilliseconds;
            _logger.LogInformation("[MdToPpt-Agent] connection resolved elapsedMs={Ms}", connMs);
            await WriteDiagAsync(new { stage = "connection", elapsedMs = connMs, connectionId = connection.Id });

            var runtime = runtimeProfile.Runtime;
            var model = runtimeProfile.Model;
            // 模型可见性：Agent 路径也要第一时间把模型名推给前端（ai-model-visibility 规则）
            await WriteEventAsync("model", new { model, platform = "CDS Agent" });

            // 3. 会话：优先复用大纲期间预热好的会话（启动开销已藏进用户阅读大纲的时间）
            var t2 = DateTime.UtcNow;
            session = await TakePrewarmedSessionAsync(userId, runtimeProfile.Id);
            if (session != null)
            {
                var hitMs = (int)(DateTime.UtcNow - t2).TotalMilliseconds;
                _logger.LogInformation("[MdToPpt-Agent] prewarmed session reused sessionId={Id} status={Status}", session.Id, session.Status);
                await WriteDiagAsync(new { stage = "prewarm_hit", elapsedMs = hitMs, sessionId = session.Id });
            }
            else
            {
                // 预热未命中 → 全新创建。toolPolicy=deny-all 禁止暴露任何工具，避免 agent 进入工具循环
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
                        null,
                        "md-to-ppt"),
                    CancellationToken.None);
                var createMs = (int)(DateTime.UtcNow - t2).TotalMilliseconds;
                _logger.LogInformation("[MdToPpt-Agent] session created elapsedMs={Ms} sessionId={Id} toolPolicy={Policy}",
                    createMs, session.Id, InfraAgentToolPolicies.DenyAll);
                await WriteDiagAsync(new { stage = "create", elapsedMs = createMs, sessionId = session.Id, toolPolicy = InfraAgentToolPolicies.DenyAll });

                // 4. 启动会话
                var t3 = DateTime.UtcNow;
                if (!string.Equals(session.Status, InfraAgentSessionStatuses.Running, StringComparison.OrdinalIgnoreCase))
                {
                    session = await _sessions.StartAsync(userId, session.Id,
                        new StartInfraAgentSessionRequest(runtime, model),
                        CancellationToken.None) ?? session;
                }
                var startMs = (int)(DateTime.UtcNow - t3).TotalMilliseconds;
                _logger.LogInformation("[MdToPpt-Agent] session started elapsedMs={Ms} status={Status}", startMs, session.Status);
                await WriteDiagAsync(new { stage = "start", elapsedMs = startMs, status = session.Status });
            }

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

                            case InfraAgentEventTypes.Thinking:
                                // 推理模型（deepseek-v3.2 等）先想后写：思考可长达数分钟，正文集中尾部爆发。
                                // 必须把思考过程透传给前端展示（CLAUDE §6），否则等待期实况预览无内容可渲染，
                                // 用户面对骨架空等（2026-06-10 预览环境验收实测 331s 中前 300s 全在思考）。
                                if (root.TryGetProperty("text", out var thinkProp))
                                {
                                    var thinkFrag = thinkProp.GetString() ?? "";
                                    if (!string.IsNullOrEmpty(thinkFrag))
                                        await WriteEventAsync("thinking", new { text = thinkFrag });
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
                    var html = NormalizePresentationDocument(finalHtml ?? StripCodeFences(fullText.ToString()));
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
                    if (!IsRunnableDeckDocument(html))
                    {
                        const string message = "生成结果不完整，未替换当前演示稿，请重试";
                        await PersistRunErrorAsync(run, message);
                        await WriteEventAsync("error", new { message });
                        return;
                    }
                    if (!await PersistRunDoneAsync(run, html, runtimeProfile?.Model ?? model, "CDS Agent"))
                    {
                        await WriteEventAsync("error", new { message = "演示稿已生成但版本保存失败，请重试" });
                        return;
                    }
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
            var timeoutHtml = NormalizePresentationDocument(StripCodeFences(fullText.ToString()));
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

            if (IsRunnableDeckDocument(timeoutHtml))
            {
                if (await PersistRunDoneAsync(run, timeoutHtml, model, "CDS Agent"))
                    await WriteEventAsync("done", new { html = timeoutHtml });
                else
                    await WriteEventAsync("error", new { message = "演示稿已生成但版本保存失败，请重试" });
            }
            else
            {
                const string message = "CDS Agent 响应超时且结果不完整，未替换当前演示稿，请重试";
                await PersistRunErrorAsync(run, message);
                await WriteEventAsync("error", new { message });
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

    /// <summary>当前用户可见的全部运行配置（own + 团队共享），own 在前、默认在前、新改的在前</summary>
    private async Task<List<InfraAgentRuntimeProfile>> ListVisibleRuntimeProfilesAsync(string userId, CancellationToken ct)
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
        var filter = fb.Eq(x => x.CreatedByUserId, userId);
        if (visibleTeamIds.Count > 0)
            filter |= fb.AnyIn(x => x.SharedTeamIds, visibleTeamIds);

        var all = await _db.InfraAgentRuntimeProfiles
            .Find(filter)
            .Limit(200)
            .ToListAsync(ct);
        return all
            .OrderByDescending(x => x.CreatedByUserId == userId)
            .ThenByDescending(x => x.IsDefault)
            .ThenByDescending(x => x.UpdatedAt)
            .ToList();
    }

    /// <summary>
    /// 解析运行配置。requestedProfileId 优先（用户在 PPT 页随时切换的模型，必须在可见集合内）；
    /// 未指定时按四级优先：own 默认 → 共享默认 → own 最近 → 共享最近。
    /// </summary>
    private async Task<InfraAgentRuntimeProfile?> ResolveRuntimeProfileAsync(
        string userId, CancellationToken ct, string? requestedProfileId = null)
    {
        var visible = await ListVisibleRuntimeProfilesAsync(userId, ct);
        if (!string.IsNullOrWhiteSpace(requestedProfileId))
        {
            if (requestedProfileId == SystemGatewayProfileId)
                return CreateSystemGatewayProfile(userId);
            var requested = visible.FirstOrDefault(x => x.Id == requestedProfileId);
            if (requested != null) return requested;
            // 指定的配置不可见/已删除：按默认链兜底，不让请求直接失败
        }

        return visible.FirstOrDefault(x => x.CreatedByUserId == userId && x.IsDefault)
            ?? visible.FirstOrDefault(x => x.IsDefault)
            ?? visible.FirstOrDefault(x => x.CreatedByUserId == userId)
            ?? visible.FirstOrDefault()
            ?? CreateSystemGatewayProfile(userId);
    }

    internal static InfraAgentRuntimeProfile CreateSystemGatewayProfile(string userId) => new()
    {
        Id = SystemGatewayProfileId,
        Name = "MAP 默认模型",
        Runtime = InfraAgentRuntimes.ClaudeSdk,
        Protocol = InfraAgentRuntimeProtocols.OpenAiCompatible,
        Model = string.Empty,
        TimeoutSeconds = 180,
        IsDefault = true,
        CreatedByUserId = userId,
    };

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

    /// <summary>自定义模板 ID（可选；优先于 Theme 生效）</summary>
    public string? TemplateId { get; set; }

    /// <summary>结构化大纲（并行逐页生成模式；来自右侧大纲编辑器工作稿）</summary>
    public List<MdToPptOutlinePageDto>? OutlinePages { get; set; }

    /// <summary>PPT 一句话主题（并行逐页模式给子智能体的全局语境）</summary>
    public string? Summary { get; set; }

    /// <summary>模型运行配置 ID（可选；用户在 PPT 页随时切换模型，缺省走默认链）</summary>
    public string? RuntimeProfileId { get; set; }

    /// <summary>html-ppt | knowledge-base，标记本次生成入口。</summary>
    public string? SourceSurface { get; set; }

    /// <summary>用户明确选择的知识快照及其来源标识。</summary>
    public List<MdToPptKnowledgeReferenceRequest>? KnowledgeReferences { get; set; }
}

public class MdToPptOutlinePageDto
{
    public string? Title { get; set; }
    public List<string>? Bullets { get; set; }
    /// <summary>页级设计意图（来自流式大纲：版式/视觉装置/排字/强调），直接喂给并行子智能体</summary>
    public string? Design { get; set; }
}

public class MdToPptPatchRequest
{
    /// <summary>当前精修所依据的服务端 run；来源与知识快照只能从该 run 继承。</summary>
    public string? ParentRunId { get; set; }

    /// <summary>当前 HTML 内容</summary>
    public string? CurrentHtml { get; set; }

    /// <summary>修改要求</summary>
    public string? SlideRequest { get; set; }

    /// <summary>目标页索引（可选）</summary>
    public int? SlideIndex { get; set; }

    /// <summary>风格主题（可选）。换风格走 patch 由 AI 按该风格重绘，前端不做 CSS 换皮</summary>
    public string? Theme { get; set; }

    /// <summary>自定义模板 ID（可选；优先于 Theme 生效）</summary>
    public string? TemplateId { get; set; }

    /// <summary>模型运行配置 ID（可选；用户在 PPT 页随时切换模型，缺省走默认链）</summary>
    public string? RuntimeProfileId { get; set; }
}

public class MdToPptFromPoolRequest
{
    /// <summary>模型池里的 LLMModel.Id</summary>
    public string? ModelId { get; set; }
}

public class MdToPptPrewarmRequest
{
    /// <summary>模型运行配置 ID（可选；预热会话必须与用户当前所选模型匹配）</summary>
    public string? RuntimeProfileId { get; set; }
}

public class MdToPptTemplateCreateRequest
{
    /// <summary>模板名（默认取参考图文件名，可改）</summary>
    public string? Name { get; set; }

    /// <summary>参考图 dataURL（data:image/...;base64,...，限 6MB）</summary>
    public string? ImageDataUrl { get; set; }
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

    /// <summary>对应的 HTML PPT 运行 ID，用于回写统一产物链。</summary>
    public string? RunId { get; set; }
}

public class MdToPptLocalEditRequest
{
    /// <summary>浏览器编辑器清洗后回传的完整 HTML。</summary>
    public string? HtmlContent { get; set; }
}

public class MdToPptKnowledgeReferenceRequest
{
    public string? EntryId { get; set; }
    public string? StoreId { get; set; }
}

public class MdToPptOutlineRequest
{
    /// <summary>主内容（Markdown / 文本）</summary>
    public string? Content { get; set; }

    /// <summary>附件文本（已提取的文件内容）</summary>
    public string? AttachmentText { get; set; }

    /// <summary>知识条目身份；正文、标题与归属由服务端重新解析。</summary>
    public List<MdToPptKnowledgeReferenceRequest>? KnowledgeReferences { get; set; }

    /// <summary>对话历史摘要（告知 AI 用户的历史需求）</summary>
    public string? ChatHistory { get; set; }

    /// <summary>目标页数（可选，默认 8）</summary>
    public int? TargetPages { get; set; }
}
