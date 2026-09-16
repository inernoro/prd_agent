using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 任务台 · 一键导入 —— 把一段自由文本（会议纪要、聊天记录、需求段落）拆成一条条任务。
///
/// 为什么值得存在：手上真正的输入从来不是「一行一件」，而是一段话。上一版的 paste 端点
/// 按换行切，遇到「周五前把登录页改完，另外顺手看一下张三那个 bug」就只能切出一条。
///
/// 为什么是 SSE 而不是等一坨 JSON 回来（CLAUDE.md 规则 #6）：拆十条要十几秒，
/// 那十几秒里屏幕上必须有产物在长出来，而不是一个转圈。模型按 JSONL 输出，
/// 服务端逐行解析、每成功一行立刻推一条，用户看着任务一条条冒出来。
///
/// 刻意不直接入库：拆出来的东西先给人看、可勾可改，确认了才建。
/// 机器替人做决定的地方越少，人越敢用它。
/// </summary>
[ApiController]
[Route("api/active-tasks/import")]
[Authorize]
[AdminController("active-tasks", AdminPermissionCatalog.ActiveTasksUse)]
public class ActiveTasksImportController : ControllerBase
{
    private readonly ILlmGateway _gateway;
    private readonly ILLMRequestContextAccessor _llmRequestContext;
    private readonly ILogger<ActiveTasksImportController> _logger;

    public ActiveTasksImportController(
        ILlmGateway gateway,
        ILLMRequestContextAccessor llmRequestContext,
        ILogger<ActiveTasksImportController> logger)
    {
        _gateway = gateway;
        _llmRequestContext = llmRequestContext;
        _logger = logger;
    }

    /// <summary>拆解一段文本，逐条流式推回。不写库。</summary>
    [HttpPost("stream")]
    public async Task SplitStream([FromBody] ActiveTaskImportRequest req)
    {
        var userId = this.GetRequiredUserId();
        SetSseHeaders();
        await WriteSsePreambleAsync();
        await WriteEventAsync("start", null);

        var text = req?.Text?.Trim() ?? string.Empty;
        if (text.Length == 0)
        {
            await WriteEventAsync("error", new { message = "先粘一段文字进来" });
            return;
        }
        if (text.Length > 20000) text = text[..20000];

        // 模型不认得「今天」是几号，把当天与本周日期表交给它，让它算得出具体日期。
        // 但**只在原文真的提到时间时才给**：2026-09-15 实测，原文一个日期都没有时，
        // 这张表会变成诱饵 —— 9 条任务被模型全部安上了本周五。不给诱饵是第一道防线，
        // 下面的 HasTimeCue 硬门是第二道。
        // 团队日历只有一个判定源（ActiveTaskConclusion.TeamUtcOffset），这里不再自己写死 8
        var now = DateTime.UtcNow + ActiveTaskConclusion.TeamUtcOffset;
        var textHasTime = HasTimeCue(text);
        var calendar = textHasTime ? BuildCalendarHint(now) : "原文没有提到任何时间，所有条目一律不要填 dueAt。\n";

        var systemPrompt =
            "你把一段自由文本拆成一条条「要做的事」，按 JSONL 输出：每行一个独立 JSON 对象，行内不得换行，输出完一行立即换行。\n" +
            "不要 markdown 围栏，不要任何前后缀解释。\n\n" +
            "每行格式：\n" +
            "{\"type\":\"task\",\"title\":\"改完登录页的错误提示\",\"dueAt\":\"2026-09-19\",\"why\":\"原文说周五前\"}\n" +
            "全部输出完，最后一行：\n" +
            "{\"type\":\"done\",\"skipped\":\"丢掉了什么，最多 30 字概括；不要抄原文；没丢就省略这个字段\"}\n\n" +
            "规则：\n" +
            "1. title 是一件可以动手做的事，8-25 字，动词开头，不要「关于…的事项」这种壳子。一句话里含两件事就拆成两条。\n" +
            "2. dueAt 只在原文真的给了时间时才填，格式 yyyy-MM-dd。原文没说时间就整个省略这个字段 —— 不许猜，不许默认填今天。\n" +
            "3. why 写「原文哪句让你认为有这个时间」，只在填了 dueAt 时给；没有 dueAt 就省略。\n" +
            "4. 不是任务的内容（寒暄、结论、背景交代、已经做完的事）一律不输出，把它们记进最后那行的 skipped。\n" +
            "5. 最多 20 条。原文里已经写成清单的，按清单条目走，不要再合并。\n" +
            "6. 禁止 emoji。title 用中文，保留原文里的专有名词与英文技术词。\n\n" +
            calendar;

        using var _ = _llmRequestContext.BeginScope(new LlmRequestContext(
            RequestId: Guid.NewGuid().ToString("N"),
            GroupId: null,
            SessionId: null,
            UserId: userId,
            ViewRole: null,
            DocumentChars: text.Length,
            DocumentHash: null,
            SystemPromptRedacted: "[ActiveTasks-Import]",
            RequestType: "chat",
            AppCallerCode: AppCallerRegistry.ActiveTasks.Import.Split));

        var gatewayRequest = new GatewayRequest
        {
            AppCallerCode = AppCallerRegistry.ActiveTasks.Import.Split,
            ModelType = ModelTypes.Chat,
            Stream = true,
            TimeoutSeconds = 90,
            RequestBody = new JsonObject
            {
                ["messages"] = new JsonArray
                {
                    new JsonObject { ["role"] = "system", ["content"] = systemPrompt },
                    new JsonObject { ["role"] = "user", ["content"] = text },
                },
                ["temperature"] = 0.2,
                ["max_tokens"] = 2048,
            },
        };

        var lineBuf = new StringBuilder();
        var pending = new StringBuilder();
        var emitted = 0;
        var sawModel = false;

        async Task TryEmitAsync(string line)
        {
            var t = line.Trim();
            if (t.Length == 0 || t.StartsWith("```", StringComparison.Ordinal)) return;
            pending.Append(t);
            JsonDocument doc;
            try { doc = JsonDocument.Parse(pending.ToString()); }
            catch (JsonException)
            {
                // 模型把一个对象拆成了几行：留着和下一行拼；拼太长就丢掉防失控
                if (pending.Length > 4000) pending.Clear();
                return;
            }
            using (doc)
            {
                pending.Clear();
                var root = doc.RootElement;
                var type = root.TryGetProperty("type", out var tp) ? tp.GetString() : null;
                if (type == "task" && emitted < 20)
                {
                    var title = root.TryGetProperty("title", out var ti) ? ti.GetString()?.Trim() : null;
                    if (string.IsNullOrWhiteSpace(title)) return;
                    emitted++;
                    // 硬门：原文里一个时间词都没有，模型给的任何日期都是编的，一律丢弃。
                    // 提示词里已经写了「不许猜」，但那是对模型的期望，不是不变量 ——
                    // 2026-09-15 实测 gpt-3.5-turbo-1106 压不住，9 条全给安上了本周五。
                    var rawDue = textHasTime ? (root.TryGetProperty("dueAt", out var d) ? d.GetString() : null) : null;
                    await WriteEventAsync("task", new
                    {
                        title,
                        dueAt = NormalizeDue(rawDue),
                        // why 是「原文哪句让你判出这个时间」，没有时间就没有 why 可言
                        why = rawDue == null ? null : (root.TryGetProperty("why", out var w) ? w.GetString() : null),
                    });
                }
                else if (type == "done")
                {
                    await WriteEventAsync("summary", new
                    {
                        count = emitted,
                        skipped = Clip(root.TryGetProperty("skipped", out var sk) ? sk.GetString() : null, 80),
                    });
                }
            }
        }

        try
        {
            await foreach (var chunk in _gateway.StreamAsync(gatewayRequest, CancellationToken.None))
            {
                if (chunk.Type == GatewayChunkType.Start && chunk.Resolution != null && !sawModel)
                {
                    // 规则 ai-model-visibility：用户看得见这次用的是哪个模型
                    sawModel = true;
                    await WriteEventAsync("model", new
                    {
                        model = chunk.Resolution.ActualModel,
                        platform = chunk.Resolution.ActualPlatformName,
                    });
                }
                else if (chunk.Type == GatewayChunkType.Text && !string.IsNullOrEmpty(chunk.Content))
                {
                    foreach (var ch in chunk.Content)
                    {
                        if (ch == '\n') { await TryEmitAsync(lineBuf.ToString()); lineBuf.Clear(); }
                        else lineBuf.Append(ch);
                    }
                }
                else if (chunk.Type == GatewayChunkType.Error)
                {
                    var err = chunk.Error ?? chunk.Content ?? "拆解失败";
                    _logger.LogError("[ActiveTasks-Import] gateway error userId={UserId}: {Error}", userId, err);
                    await WriteEventAsync("error", new { message = err });
                    return;
                }
            }
            if (lineBuf.Length > 0) await TryEmitAsync(lineBuf.ToString());

            if (emitted == 0)
            {
                await WriteEventAsync("error", new { message = "没从这段文字里读出可以动手做的事，换一段试试" });
                return;
            }
            await WriteEventAsync("done", new { count = emitted });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[ActiveTasks-Import] unexpected error userId={UserId}", userId);
            await WriteEventAsync("error", new { message = "拆解中断了，稍后再试" });
        }
    }

    /// <summary>
    /// 原文里到底有没有提到时间。判得**宽**是对的：宁可放过几个也不要误杀 ——
    /// 它只决定「要不要信模型给的日期」，放过之后还有 NormalizeDue 的 180 天窗口兜着。
    /// 与前端 dueParse 的规则表同源（那边负责认出来是哪天，这边只负责认出来有没有）。
    /// </summary>
    private static readonly System.Text.RegularExpressions.Regex TimeCue = new(
        "今天|今日|今晚|明天|明日|后天|大后天|昨天|周[一二三四五六日天]|礼拜[一二三四五六日天]|星期[一二三四五六日天]"
        + "|本周|下周|这周|下个?月|本月|月底|月初|年底|季度末|上线前|发布前|截止|deadline|due"
        + "|\\d{1,2}\\s*[月/-]\\s*\\d{1,2}|\\d{1,2}\\s*号|\\d{1,2}\\s*日"
        + "|\\d+\\s*(?:天|周|个?月)(?:内|后|之内|以内)",
        System.Text.RegularExpressions.RegexOptions.IgnoreCase | System.Text.RegularExpressions.RegexOptions.Compiled);

    internal static bool HasTimeCue(string text) => !string.IsNullOrWhiteSpace(text) && TimeCue.IsMatch(text);

    /// <summary>截断。模型偶尔把整段原文抄进 skipped，那一段会占掉半个浮层。</summary>
    internal static string? Clip(string? s, int max)
    {
        if (string.IsNullOrWhiteSpace(s)) return null;
        var t = s.Trim();
        return t.Length <= max ? t : t[..max] + "…";
    }

    /// <summary>
    /// 模型不知道今天几号。把当天与往后两周的日期表交给它，它才算得出「周五前」是哪天。
    /// 不给这张表，它只能猜，猜出来的日期比不给日期更糟。
    /// </summary>
    private static string BuildCalendarHint(DateTime now)
    {
        var sb = new StringBuilder();
        sb.Append("今天是 ").Append(now.ToString("yyyy-MM-dd")).Append('（').Append(WeekdayCn(now.DayOfWeek)).Append("）。\n");
        sb.Append("往后两周的日期对照（原文说「周五」「下周三」时按这张表换算，取今天之后最近的那一天）：\n");
        for (var i = 1; i <= 14; i++)
        {
            var d = now.AddDays(i);
            sb.Append("  ").Append(d.ToString("yyyy-MM-dd")).Append(' ').Append(WeekdayCn(d.DayOfWeek)).Append('\n');
        }
        return sb.ToString();
    }

    private static string WeekdayCn(DayOfWeek d) => d switch
    {
        DayOfWeek.Monday => "周一",
        DayOfWeek.Tuesday => "周二",
        DayOfWeek.Wednesday => "周三",
        DayOfWeek.Thursday => "周四",
        DayOfWeek.Friday => "周五",
        DayOfWeek.Saturday => "周六",
        _ => "周日",
    };

    /// <summary>
    /// 模型给的日期必须落在「今天之后 180 天内」才收。它偶尔会吐出去年的日期或者
    /// 一个语义上不成立的年份 —— 那种日期一进来，任务建出来就是逾期红的，比没有时间更糟。
    /// </summary>
    private static string? NormalizeDue(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;
        if (!DateTime.TryParse(raw.Trim(), out var d)) return null;
        var today = ActiveTaskConclusion.TeamDate(DateTime.UtcNow);
        if (d.Date < today || d.Date > today.AddDays(180)) return null;
        // 「那天要」指那天下班前，和 DuePicker / dueParse 的口径一致
        return d.Date.AddHours(18).ToString("yyyy-MM-ddTHH:mm:ss");
    }

    private void SetSseHeaders()
    {
        Response.ContentType = "text/event-stream";
        Response.Headers.CacheControl = "no-cache, no-transform";
        Response.Headers.Connection = "keep-alive";
        Response.Headers["X-Accel-Buffering"] = "no";
        HttpContext.Features.Get<Microsoft.AspNetCore.Http.Features.IHttpResponseBodyFeature>()?.DisableBuffering();
    }

    private async Task WriteSsePreambleAsync()
    {
        try
        {
            await Response.WriteAsync(": " + new string(' ', 2048) + "\n\n", CancellationToken.None);
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
            await Response.WriteAsync($"event: {eventName}\ndata: {dataLine}\n\n", CancellationToken.None);
            await Response.Body.FlushAsync(CancellationToken.None);
        }
        catch (OperationCanceledException) { }
        catch (ObjectDisposedException) { }
    }
}

public class ActiveTaskImportRequest
{
    /// <summary>粘进来的原始文字：会议纪要、聊天记录、需求段落都行</summary>
    public string Text { get; set; } = string.Empty;
}
