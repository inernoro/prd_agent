using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Logging;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.Services.Changelog;

namespace PrdAgent.Infrastructure.Services.Poster;

/// <summary>
/// 周报海报 AI 向导 —— 输入模板 + 数据源,输出结构化的 pages(标题 / 正文 / imagePrompt)。
/// 本服务只负责文字生成(LLM),图片由调用方在得到 pages 后异步 / 并行请求生图 API。
/// </summary>
public interface IPosterAutopilotService
{
    Task<PosterAutopilotResult> GeneratePagesAsync(
        PosterAutopilotInput input,
        string userId,
        CancellationToken ct);
}

public sealed class PosterAutopilotInput
{
    public string TemplateKey { get; set; } = "release";
    /// <summary>数据源类型:changelog-current-week / freeform</summary>
    public string SourceType { get; set; } = "changelog-current-week";
    /// <summary>当 SourceType = freeform 时,调用方直接塞 markdown 文本</summary>
    public string? FreeformContent { get; set; }
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
    private readonly ILogger<PosterAutopilotService> _logger;

    public PosterAutopilotService(
        ILlmGateway gateway,
        ILLMRequestContextAccessor llmRequestContext,
        IChangelogReader changelogReader,
        ILogger<PosterAutopilotService> logger)
    {
        _gateway = gateway;
        _llmRequestContext = llmRequestContext;
        _changelogReader = changelogReader;
        _logger = logger;
    }

    public async Task<PosterAutopilotResult> GeneratePagesAsync(
        PosterAutopilotInput input,
        string userId,
        CancellationToken ct)
    {
        var template = PosterTemplateRegistry.FindOrDefault(input.TemplateKey);
        var pageCount = Math.Clamp(input.ForcePageCount ?? template.DefaultPages, 3, 7);

        // ── 1. 装载数据源 ───────────────────────────────
        var (sourceMarkdown, sourceSummary) = await LoadSourceAsync(input, ct);
        if (string.IsNullOrWhiteSpace(sourceMarkdown))
        {
            throw new InvalidOperationException("数据源为空,请换一个数据源或粘贴 markdown 再试");
        }

        // ── 2. 组 system prompt + user payload ──────────
        var systemPrompt = BuildSystemPrompt(template, pageCount);
        var userContent = $"【数据源:{sourceSummary}】\n\n{Truncate(sourceMarkdown, 12_000)}";

        // ── 3. 调用 Gateway ────────────────────────────
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
            ["response_format"] = new JsonObject { ["type"] = "json_object" },
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

        // ── 4. 解析 JSON ────────────────────────────────
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

    // ────────────────────────────────────────────────────────────
    // 数据源装载
    // ────────────────────────────────────────────────────────────

    private async Task<(string markdown, string summary)> LoadSourceAsync(PosterAutopilotInput input, CancellationToken ct)
    {
        var sourceType = (input.SourceType ?? "changelog-current-week").Trim().ToLowerInvariant();
        switch (sourceType)
        {
            case "freeform":
                var freeform = (input.FreeformContent ?? string.Empty).Trim();
                return (freeform, $"自定义 markdown ({freeform.Length} 字符)");

            case "changelog-current-week":
            default:
            {
                _ = ct; // 数据源读取内部自带超时;这里仅声明为未使用
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
            $"你是 MAP 周报海报的文案设计师。用户会给你一段 markdown 数据源,你要把它加工成 {pageCount} 页主页弹窗轮播海报。\n\n" +
            $"语调:{template.Tone}\n\n" +
            $"**严格只输出一个 JSON 对象**,不要 markdown 代码块,不要解释。UTF-8。结构:\n" +
            "{\n" +
            "  \"title\": string,             // 海报总标题,≤16 个汉字\n" +
            "  \"subtitle\": string,          // 副标题,≤30 个汉字,一句话概括\n" +
            "  \"pages\": [\n" +
            "    {\n" +
            "      \"order\": number,         // 从 0 开始\n" +
            "      \"title\": string,         // 10-14 个汉字的短语,禁止「新增/修复/优化」开头\n" +
            "      \"body\": string,          // 80-120 字,用户视角,能做什么,解决什么痛点\n" +
            "      \"imagePrompt\": string,   // 英文,80-160 字,文生图用 prompt\n" +
            $"      \"accentColor\": string   // 十六进制,从 [{palette}] 中选,每页不同\n" +
            "    }\n" +
            "  ]\n" +
            "}\n\n" +
            $"imagePrompt 规则:英文,风格追加 \"{template.ImageStyleKeywords}\",不含人脸。\n" +
            $"必须恰好 {pageCount} 页,order 从 0 连续到 {pageCount - 1}。\n" +
            "最后一页负责「承接 CTA」(引导用户去看完整周报),不要在 JSON 里写 CTA 文案,只写引导性的 body。";
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
