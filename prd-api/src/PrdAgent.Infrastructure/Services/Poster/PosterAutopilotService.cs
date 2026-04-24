using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Logging;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.Services.Changelog;

namespace PrdAgent.Infrastructure.Services.Poster;

/// <summary>
/// 周报海报 AI 向导 —— 输入模板 + 数据源,输出结构化的 pages(标题 / 正文 / imagePrompt)。
/// 本服务只负责文字生成(LLM),图片由调用方在得到 pages 后异步 / 并行请求生图 API。
/// </summary>
public interface IPosterAutopilotService
{
    /// <summary>一键生成(非流式):内部合并 LoadSource + InvokeLlm。</summary>
    Task<PosterAutopilotResult> GeneratePagesAsync(
        PosterAutopilotInput input,
        string userId,
        CancellationToken ct);

    /// <summary>装载数据源(对外暴露给 SSE 控制器做阶段事件推送)。</summary>
    Task<(string markdown, string summary)> LoadSourceAsync(
        PosterAutopilotInput input,
        CancellationToken ct);

    /// <summary>根据已装载的数据源调 LLM 生成页面(非流式)。</summary>
    Task<PosterAutopilotResult> InvokeLlmAsync(
        string templateKey,
        int? forcePageCount,
        string sourceMarkdown,
        string sourceSummary,
        string userId,
        CancellationToken ct);

    /// <summary>
    /// 流式调 LLM,逐 chunk 返回。控制器直接 await foreach + 转发 SSE 即可。
    /// 首个 Start chunk 带 Resolution(模型名/平台);Text chunk 是增量文本;
    /// Done chunk 表示流结束。
    /// </summary>
    IAsyncEnumerable<GatewayStreamChunk> StreamLlmChunksAsync(
        string templateKey,
        int? forcePageCount,
        string sourceMarkdown,
        string sourceSummary,
        string userId,
        CancellationToken ct);

    /// <summary>流式跑完后,把累积的原始文本解析为 pages(给控制器在 Done 之后调)。</summary>
    PosterAutopilotResult? ParseAccumulatedContent(
        string accumulatedRawText,
        string templateKey,
        int? forcePageCount,
        string sourceSummary,
        string? model,
        string? platform);

    /// <summary>增量提取已闭合的 page(给控制器每个 chunk 后调,新 page 立即 emit)。</summary>
    List<PosterAutopilotPage> ExtractClosedPagesSoFar(string accumulatedRawText, string templateKey);
}

public sealed class PosterAutopilotInput
{
    public string TemplateKey { get; set; } = "release";
    /// <summary>数据源类型:changelog-current-week / github-commits / knowledge-base / freeform</summary>
    public string SourceType { get; set; } = "changelog-current-week";
    /// <summary>当 SourceType = freeform 时直接塞 markdown</summary>
    public string? FreeformContent { get; set; }
    /// <summary>当 SourceType = knowledge-base 时为 DocumentEntry 的 Id</summary>
    public string? SourceRef { get; set; }
    /// <summary>可选:强制页数</summary>
    public int? ForcePageCount { get; set; }
}

public sealed class PosterAutopilotResult
{
    public string Title { get; set; } = string.Empty;
    public string? Subtitle { get; set; }
    public List<PosterAutopilotPage> Pages { get; set; } = new();
    public string SourceSummary { get; set; } = string.Empty;
    public string? Model { get; set; }
    public string? Platform { get; set; }
}

public sealed class PosterAutopilotPage
{
    public int Order { get; set; }
    public string Title { get; set; } = string.Empty;
    public string Body { get; set; } = string.Empty;
    public string ImagePrompt { get; set; } = string.Empty;
    public string? AccentColor { get; set; }
}

public sealed class PosterAutopilotService : IPosterAutopilotService
{
    private static readonly string AppCallerCode = AppCallerRegistry.ReportAgent.WeeklyPoster.Autopilot;

    private readonly ILlmGateway _gateway;
    private readonly ILLMRequestContextAccessor _llmRequestContext;
    private readonly IChangelogReader _changelogReader;
    private readonly MongoDbContext _db;
    private readonly ILogger<PosterAutopilotService> _logger;

    public PosterAutopilotService(
        ILlmGateway gateway,
        ILLMRequestContextAccessor llmRequestContext,
        IChangelogReader changelogReader,
        MongoDbContext db,
        ILogger<PosterAutopilotService> logger)
    {
        _gateway = gateway;
        _llmRequestContext = llmRequestContext;
        _changelogReader = changelogReader;
        _db = db;
        _logger = logger;
    }

    public async Task<PosterAutopilotResult> GeneratePagesAsync(
        PosterAutopilotInput input,
        string userId,
        CancellationToken ct)
    {
        var (sourceMarkdown, sourceSummary) = await LoadSourceAsync(input, ct);
        return await InvokeLlmAsync(
            input.TemplateKey ?? "release",
            input.ForcePageCount,
            sourceMarkdown,
            sourceSummary,
            userId,
            ct);
    }

    public async Task<PosterAutopilotResult> InvokeLlmAsync(
        string templateKey,
        int? forcePageCount,
        string sourceMarkdown,
        string sourceSummary,
        string userId,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(sourceMarkdown))
        {
            throw new InvalidOperationException("数据源为空,请换一个数据源或粘贴 markdown 再试");
        }

        var template = PosterTemplateRegistry.FindOrDefault(templateKey);
        var pageCount = Math.Clamp(forcePageCount ?? template.DefaultPages, 3, 7);
        var systemPrompt = BuildSystemPrompt(template, pageCount);
        var userContent = $"【数据源:{sourceSummary}】\n\n{Truncate(sourceMarkdown, 12_000)}";

        using var _ = _llmRequestContext.BeginScope(new LlmRequestContext(
            RequestId: Guid.NewGuid().ToString("N"),
            GroupId: null,
            SessionId: null,
            UserId: userId,
            ViewRole: null,
            DocumentChars: userContent.Length,
            DocumentHash: null,
            SystemPromptRedacted: $"weekly-poster-autopilot/{template.Key}",
            RequestType: "chat",
            AppCallerCode: AppCallerCode));

        var body = new JsonObject
        {
            ["messages"] = new JsonArray
            {
                new JsonObject { ["role"] = "system", ["content"] = systemPrompt },
                new JsonObject { ["role"] = "user", ["content"] = userContent },
            },
            ["temperature"] = 0.5,
            ["max_tokens"] = 2400,
            // response_format 改 markdown 分段,不用 json_object 约束
        };

        var resp = await _gateway.SendAsync(new GatewayRequest
        {
            AppCallerCode = AppCallerCode,
            ModelType = "chat",
            RequestBody = body,
        }, ct).ConfigureAwait(false);

        if (!resp.Success || string.IsNullOrWhiteSpace(resp.Content))
        {
            throw new InvalidOperationException(resp.ErrorMessage ?? "模型未返回有效内容");
        }

        var parsed = TryParseAutopilotJson(resp.Content, template, pageCount);
        if (parsed == null)
        {
            _logger.LogWarning("Autopilot LLM output unparseable. first 400 chars: {Head}",
                resp.Content.Length > 400 ? resp.Content[..400] : resp.Content);
            throw new InvalidOperationException("模型输出无法解析为页面 JSON");
        }

        parsed.SourceSummary = sourceSummary;
        parsed.Model = resp.Resolution?.ActualModel;
        parsed.Platform = resp.Resolution?.ActualPlatformName;
        return parsed;
    }

    public async IAsyncEnumerable<GatewayStreamChunk> StreamLlmChunksAsync(
        string templateKey,
        int? forcePageCount,
        string sourceMarkdown,
        string sourceSummary,
        string userId,
        [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(sourceMarkdown))
        {
            throw new InvalidOperationException("数据源为空,请换一个数据源或粘贴 markdown 再试");
        }

        var template = PosterTemplateRegistry.FindOrDefault(templateKey);
        var pageCount = Math.Clamp(forcePageCount ?? template.DefaultPages, 3, 7);
        var systemPrompt = BuildSystemPrompt(template, pageCount);
        var userContent = $"【数据源:{sourceSummary}】\n\n{Truncate(sourceMarkdown, 12_000)}";

        using var _ = _llmRequestContext.BeginScope(new LlmRequestContext(
            RequestId: Guid.NewGuid().ToString("N"),
            GroupId: null,
            SessionId: null,
            UserId: userId,
            ViewRole: null,
            DocumentChars: userContent.Length,
            DocumentHash: null,
            SystemPromptRedacted: $"weekly-poster-autopilot-stream/{template.Key}",
            RequestType: "chat",
            AppCallerCode: AppCallerCode));

        var body = new JsonObject
        {
            ["messages"] = new JsonArray
            {
                new JsonObject { ["role"] = "system", ["content"] = systemPrompt },
                new JsonObject { ["role"] = "user", ["content"] = userContent },
            },
            ["temperature"] = 0.5,
            ["max_tokens"] = 2400,
            // response_format 改 markdown 分段,不用 json_object 约束
            ["stream"] = true,
        };

        var req = new GatewayRequest
        {
            AppCallerCode = AppCallerCode,
            ModelType = "chat",
            RequestBody = body,
            Stream = true,
        };

        await foreach (var chunk in _gateway.StreamAsync(req, ct).ConfigureAwait(false))
        {
            yield return chunk;
        }
    }

    public PosterAutopilotResult? ParseAccumulatedContent(
        string accumulatedRawText,
        string templateKey,
        int? forcePageCount,
        string sourceSummary,
        string? model,
        string? platform)
    {
        var template = PosterTemplateRegistry.FindOrDefault(templateKey);
        var pageCount = Math.Clamp(forcePageCount ?? template.DefaultPages, 3, 7);

        // 首选:Markdown 分段格式(新设计,流式友好 + 人类可读 + markdown 预览)
        var md = TryParseMarkdownSections(accumulatedRawText, template, pageCount, includeOpen: true);
        if (md != null && md.Pages.Count > 0)
        {
            md.SourceSummary = sourceSummary;
            md.Model = model;
            md.Platform = platform;
            return md;
        }

        // 兜底:旧 JSON 格式(模型偶尔抽风回退到 JSON 时不至于全失败)
        var parsed = TryParseAutopilotJson(accumulatedRawText, template, pageCount);
        if (parsed == null) return null;
        parsed.SourceSummary = sourceSummary;
        parsed.Model = model;
        parsed.Platform = platform;
        return parsed;
    }

    /// <summary>
    /// 流式增量提取已"闭合"的 page:供 SSE 控制器每次 chunk 后扫一遍,
    /// 新出现的 page 立即 emit,实现「卡片一张张冒出来」的视觉。
    /// 「闭合」 = 不是最后一页(后面已有新 header),或最后一页里已经出现 `[IMG] ...`。
    /// </summary>
    public List<PosterAutopilotPage> ExtractClosedPagesSoFar(string accumulatedRawText, string templateKey)
    {
        var template = PosterTemplateRegistry.FindOrDefault(templateKey);
        var res = TryParseMarkdownSections(accumulatedRawText, template, expectedCount: 0, includeOpen: false);
        return res?.Pages ?? new List<PosterAutopilotPage>();
    }

    // ────────────────────────────────────────────────────────────
    // Markdown 分段解析
    // ────────────────────────────────────────────────────────────

    private static readonly Regex PageHeaderPattern = new(
        @"^##\s*Page\s*(?<order>\d+)\s*[·・]\s*(?<title>.+?)\s*[·・]\s*(?<accent>#[0-9A-Fa-f]{3,8})\s*$",
        RegexOptions.Compiled | RegexOptions.Multiline);

    private static readonly Regex ImgLinePattern = new(
        @"^\s*\[IMG\][:：]?\s*(?<prompt>.+?)\s*$",
        RegexOptions.Compiled | RegexOptions.Multiline);

    private static readonly Regex TopTitlePattern = new(
        @"^#\s+(?<title>[^\n]+)\s*$",
        RegexOptions.Compiled | RegexOptions.Multiline);

    private static readonly Regex TopSubtitlePattern = new(
        @"^>\s+(?<sub>[^\n]+)\s*$",
        RegexOptions.Compiled | RegexOptions.Multiline);

    private static PosterAutopilotResult? TryParseMarkdownSections(
        string raw, PosterTemplate template, int expectedCount, bool includeOpen)
    {
        var cleaned = StripCodeFence(raw.Trim());
        if (string.IsNullOrWhiteSpace(cleaned)) return null;

        var headers = PageHeaderPattern.Matches(cleaned);
        if (headers.Count == 0) return null;

        string? posterTitle = null;
        string? posterSubtitle = null;
        var headZone = cleaned[..headers[0].Index];
        var tm = TopTitlePattern.Match(headZone);
        if (tm.Success) posterTitle = tm.Groups["title"].Value.Trim();
        var sm = TopSubtitlePattern.Match(headZone);
        if (sm.Success) posterSubtitle = sm.Groups["sub"].Value.Trim();

        var pages = new List<PosterAutopilotPage>();
        for (int i = 0; i < headers.Count; i++)
        {
            var h = headers[i];
            int bodyStart = h.Index + h.Length;
            int bodyEnd = (i + 1 < headers.Count) ? headers[i + 1].Index : cleaned.Length;
            bool isLast = (i == headers.Count - 1);

            var section = cleaned[bodyStart..bodyEnd];

            var imgMatch = ImgLinePattern.Match(section);
            string imagePrompt = imgMatch.Success ? imgMatch.Groups["prompt"].Value.Trim() : string.Empty;

            // 最后一页没有 [IMG] 行且调用方不要求 includeOpen → 视为"未闭合",跳过
            if (isLast && !imgMatch.Success && !includeOpen) continue;

            string body = imgMatch.Success
                ? (section[..imgMatch.Index].TrimEnd() + "\n" + section[(imgMatch.Index + imgMatch.Length)..].TrimStart()).Trim()
                : section.Trim();

            int order = int.TryParse(h.Groups["order"].Value, out var o) ? o : pages.Count;
            string title = h.Groups["title"].Value.Trim();
            string accent = h.Groups["accent"].Value.Trim();
            if (string.IsNullOrWhiteSpace(accent))
            {
                accent = template.AccentPalette[order % template.AccentPalette.Length];
            }

            if (!string.IsNullOrWhiteSpace(imagePrompt)
                && !imagePrompt.Contains("no people", StringComparison.OrdinalIgnoreCase))
            {
                imagePrompt = $"{imagePrompt}, {template.ImageStyleKeywords}";
            }

            pages.Add(new PosterAutopilotPage
            {
                Order = order,
                Title = title,
                Body = body,
                ImagePrompt = imagePrompt,
                AccentColor = accent,
            });
        }

        if (pages.Count == 0) return null;

        if (expectedCount > 0 && pages.Count > expectedCount + 2)
        {
            pages = pages.Take(expectedCount + 2).ToList();
        }

        return new PosterAutopilotResult
        {
            Title = !string.IsNullOrWhiteSpace(posterTitle) ? posterTitle! : $"{template.Label} · 更新海报",
            Subtitle = posterSubtitle,
            Pages = pages,
        };
    }

    // ────────────────────────────────────────────────────────────
    // 数据源装载
    // ────────────────────────────────────────────────────────────

    public async Task<(string markdown, string summary)> LoadSourceAsync(PosterAutopilotInput input, CancellationToken ct)
    {
        var sourceType = (input.SourceType ?? "changelog-current-week").Trim().ToLowerInvariant();
        _ = ct;
        switch (sourceType)
        {
            case "freeform":
            {
                var freeform = (input.FreeformContent ?? string.Empty).Trim();
                return (freeform, $"自定义 markdown ({freeform.Length} 字符)");
            }

            case "github-commits":
            {
                var view = await _changelogReader.GetGitHubLogsAsync(30, false).ConfigureAwait(false);
                if (!view.DataSourceAvailable || view.Logs.Count == 0)
                {
                    throw new InvalidOperationException("GitHub 最近提交为空,换一个数据源试试");
                }
                var sb = new StringBuilder();
                sb.Append("# 最近 GitHub 提交\n\n");
                foreach (var log in view.Logs)
                {
                    sb.Append($"- [{log.ShortSha}] {log.Message.Split('\n')[0]} — {log.AuthorName} · {log.CommitTimeUtc:yyyy-MM-dd}\n");
                }
                return (sb.ToString(), $"GitHub · 最近 {view.Logs.Count} 条提交");
            }

            case "knowledge-base":
            {
                var entryId = (input.SourceRef ?? string.Empty).Trim();
                if (string.IsNullOrWhiteSpace(entryId))
                {
                    throw new InvalidOperationException("知识库数据源缺少 entryId(sourceRef)");
                }
                var entry = await _db.DocumentEntries.Find(x => x.Id == entryId).FirstOrDefaultAsync(ct).ConfigureAwait(false);
                if (entry == null)
                {
                    throw new InvalidOperationException("知识库条目不存在");
                }
                if (entry.IsFolder)
                {
                    throw new InvalidOperationException("不能选文件夹作为数据源,请选一个具体文档");
                }
                var body = (entry.ContentIndex ?? string.Empty).Trim();
                if (string.IsNullOrWhiteSpace(body))
                {
                    body = (entry.Summary ?? string.Empty).Trim();
                }
                if (string.IsNullOrWhiteSpace(body))
                {
                    throw new InvalidOperationException("该文档没有索引内容,换一个文档试试");
                }
                var sb = new StringBuilder();
                sb.Append($"# {entry.Title}\n\n");
                if (!string.IsNullOrWhiteSpace(entry.Summary)) sb.Append($"> {entry.Summary}\n\n");
                sb.Append(body);
                return (sb.ToString(), $"知识库 · {entry.Title} ({body.Length} 字符)");
            }

            case "changelog-current-week":
            default:
            {
                var view = await _changelogReader.GetCurrentWeekAsync(false).ConfigureAwait(false);
                if (!view.DataSourceAvailable || view.Fragments.Count == 0)
                {
                    throw new InvalidOperationException("本周 changelog 还没有数据,换一个数据源试试");
                }
                var sb = new StringBuilder();
                sb.Append($"# 本周更新 · {view.WeekStart:yyyy-MM-dd} ~ {view.WeekEnd:yyyy-MM-dd}\n\n");
                foreach (var frag in view.Fragments)
                {
                    sb.Append($"## {frag.Date:yyyy-MM-dd}\n");
                    foreach (var entry in frag.Entries)
                    {
                        sb.Append($"- [{entry.Type}] {entry.Module}: {entry.Description}\n");
                    }
                    sb.Append('\n');
                }
                var totalEntries = 0;
                foreach (var f in view.Fragments) totalEntries += f.Entries.Count;
                return (sb.ToString(), $"本周 changelog · {view.Fragments.Count} 天 {totalEntries} 条");
            }
        }
    }

    // ────────────────────────────────────────────────────────────
    // System prompt 构造
    // ────────────────────────────────────────────────────────────

    private static string BuildSystemPrompt(PosterTemplate template, int pageCount)
    {
        var palette = string.Join(", ", template.AccentPalette);
        return
            $"你是 MAP 主页弹窗海报的文案设计师。用户给你一段 markdown 数据源,你把它加工成 {pageCount} 页海报。\n\n" +
            $"语调:{template.Tone}\n\n" +
            "# 输出格式(极其重要!只输出下面这种 Markdown 分段,不要 JSON,不要任何代码围栏,不要额外解释)\n\n" +
            "首行:\n" +
            "`# <海报总标题,≤16 汉字>`\n\n" +
            "第二行(可选):\n" +
            "`> <副标题,≤30 汉字>`\n\n" +
            "然后是恰好 " + pageCount + " 页,每页一个段落,严格遵守下面 5 行格式:\n\n" +
            "```\n" +
            "## Page <从 0 开始> · <10-14 汉字短语标题> · <#十六进制色>\n" +
            "<80-120 字正文,用户视角,可以用 markdown:**加粗**、列表、换行。可以多行。>\n" +
            "\n" +
            "[IMG] <英文 80-160 字的生图 prompt,不含人脸>\n" +
            "```\n\n" +
            $"色板候选:[{palette}],每页不重复。\n" +
            $"imagePrompt 风格关键词:追加 \"{template.ImageStyleKeywords}\"。\n" +
            $"共 {pageCount} 页,order 从 0 连续到 {pageCount - 1}。\n" +
            "末页正文要承接 CTA(引导用户去看完整内容),但不要写 CTA 按钮文字本身。\n\n" +
            "反例(禁止):JSON、```markdown 代码围栏、缺失 `[IMG]` 行、Page 编号跳号、色值重复。";
    }

    // ────────────────────────────────────────────────────────────
    // JSON 解析
    // ────────────────────────────────────────────────────────────

    private static PosterAutopilotResult? TryParseAutopilotJson(string raw, PosterTemplate template, int expectedCount)
    {
        var cleaned = StripCodeFence(raw.Trim());
        JsonElement root;
        try
        {
            using var doc = JsonDocument.Parse(cleaned);
            root = doc.RootElement.Clone();
        }
        catch
        {
            return null;
        }

        if (root.ValueKind != JsonValueKind.Object) return null;

        var title = root.TryGetProperty("title", out var tEl) && tEl.ValueKind == JsonValueKind.String
            ? tEl.GetString() ?? string.Empty
            : string.Empty;
        var subtitle = root.TryGetProperty("subtitle", out var sEl) && sEl.ValueKind == JsonValueKind.String
            ? sEl.GetString()
            : null;
        if (!root.TryGetProperty("pages", out var pagesEl) || pagesEl.ValueKind != JsonValueKind.Array)
        {
            return null;
        }

        var pages = new List<PosterAutopilotPage>();
        var idx = 0;
        foreach (var pEl in pagesEl.EnumerateArray())
        {
            if (pEl.ValueKind != JsonValueKind.Object) continue;
            var page = new PosterAutopilotPage
            {
                Order = idx,
                Title = pEl.TryGetProperty("title", out var x1) && x1.ValueKind == JsonValueKind.String ? (x1.GetString() ?? string.Empty).Trim() : string.Empty,
                Body = pEl.TryGetProperty("body", out var x2) && x2.ValueKind == JsonValueKind.String ? (x2.GetString() ?? string.Empty).Trim() : string.Empty,
                ImagePrompt = pEl.TryGetProperty("imagePrompt", out var x3) && x3.ValueKind == JsonValueKind.String ? (x3.GetString() ?? string.Empty).Trim() : string.Empty,
                AccentColor = pEl.TryGetProperty("accentColor", out var x4) && x4.ValueKind == JsonValueKind.String ? x4.GetString() : null,
            };
            if (string.IsNullOrWhiteSpace(page.AccentColor))
            {
                page.AccentColor = template.AccentPalette[idx % template.AccentPalette.Length];
            }
            // 保证 imagePrompt 结尾带上模板风格词,即便模型漏了
            if (!string.IsNullOrWhiteSpace(page.ImagePrompt)
                && !page.ImagePrompt.Contains("no people", StringComparison.OrdinalIgnoreCase))
            {
                page.ImagePrompt = $"{page.ImagePrompt}, {template.ImageStyleKeywords}";
            }
            pages.Add(page);
            idx++;
            if (pages.Count >= expectedCount + 2) break; // 硬上限防止模型溢出
        }
        if (pages.Count == 0) return null;

        return new PosterAutopilotResult
        {
            Title = string.IsNullOrWhiteSpace(title) ? $"{template.Label} · 本周更新" : title,
            Subtitle = subtitle,
            Pages = pages,
        };
    }

    private static readonly Regex FencePattern = new(
        @"^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$",
        RegexOptions.Compiled);

    private static string StripCodeFence(string raw)
    {
        var m = FencePattern.Match(raw);
        if (m.Success) return m.Groups[1].Value.Trim();
        return raw;
    }

    private static string Truncate(string s, int max)
        => s.Length <= max ? s : string.Concat(s.AsSpan(0, max), "\n…(已截断)");
}
