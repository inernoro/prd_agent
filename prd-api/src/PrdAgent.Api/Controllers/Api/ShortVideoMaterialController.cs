using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 短视频素材解析：短视频链接/字幕 → 知识库可编辑素材资产。
/// </summary>
[ApiController]
[Route("api/short-video-materials")]
[Authorize]
[AdminController("document-store", AdminPermissionCatalog.DocumentStoreWrite)]
public class ShortVideoMaterialController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly IDocumentService _documentService;
    private readonly IConfiguration _config;
    private readonly IServiceProvider _serviceProvider;
    private readonly ILogger<ShortVideoMaterialController> _logger;

    public ShortVideoMaterialController(
        MongoDbContext db,
        IDocumentService documentService,
        IConfiguration config,
        IServiceProvider serviceProvider,
        ILogger<ShortVideoMaterialController> logger)
    {
        _db = db;
        _documentService = documentService;
        _config = config;
        _serviceProvider = serviceProvider;
        _logger = logger;
    }

    private string GetUserId() => this.GetRequiredUserId();

    [HttpPost("runs")]
    public async Task<IActionResult> CreateRun([FromBody] CreateShortVideoMaterialRequest req)
    {
        var userId = GetUserId();
        var now = DateTime.UtcNow;
        var videoUrl = ShortVideoMaterialProcessor.ExtractUrl(req.VideoUrl);
        if (string.IsNullOrWhiteSpace(videoUrl))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请填写短视频链接"));

        var platform = ShortVideoMaterialProcessor.DetectPlatform(videoUrl);
        var title = CleanTitle(req.Title) ?? $"短视频素材 {DateTime.UtcNow:yyyyMMdd-HHmm}";
        var run = new ShortVideoMaterialRun
        {
            UserId = userId,
            VideoUrl = videoUrl,
            Platform = platform,
            Title = title,
            RequestedTitle = req.Title,
            InputSourceText = req.SourceText,
            SourceMode = "resolving",
            Status = "queued",
            StoreId = string.IsNullOrWhiteSpace(req.StoreId) ? null : req.StoreId,
            CreatedAt = now,
            UpdatedAt = now,
            Stages = ShortVideoMaterialProcessor.BuildInitialStages(),
        };
        await _db.ShortVideoMaterialRuns.InsertOneAsync(run, cancellationToken: CancellationToken.None);

        var response = new ShortVideoMaterialRunResponse
        {
            Run = run,
            StoreId = run.StoreId ?? string.Empty,
            EntryIds = new List<string>(),
        };
        return Ok(ApiResponse<ShortVideoMaterialRunResponse>.Ok(response));
    }

    [HttpGet("runs/{runId}")]
    public async Task<IActionResult> GetRun(string runId)
    {
        var userId = GetUserId();
        var run = await _db.ShortVideoMaterialRuns
            .Find(r => r.Id == runId && r.UserId == userId)
            .FirstOrDefaultAsync(CancellationToken.None);
        if (run == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "运行记录不存在"));
        return Ok(ApiResponse<ShortVideoMaterialRun>.Ok(run));
    }

    private async Task<DocumentStore> ResolveStoreAsync(string? storeId, string userId)
    {
        if (!string.IsNullOrWhiteSpace(storeId))
        {
            var existing = await _db.DocumentStores
                .Find(s => s.Id == storeId && s.OwnerId == userId)
                .FirstOrDefaultAsync(CancellationToken.None);
            if (existing == null)
                throw new InvalidOperationException("目标知识库不存在或不可写");
            return existing;
        }

        var storeName = "短视频素材库";
        var store = await _db.DocumentStores
            .Find(s => s.OwnerId == userId && s.Name == storeName)
            .FirstOrDefaultAsync(CancellationToken.None);
        if (store != null) return store;

        var now = DateTime.UtcNow;
        store = new DocumentStore
        {
            Name = storeName,
            Description = "保存短视频原始素材、字幕文稿、时间线片段与后续加工资产",
            OwnerId = userId,
            AppKey = "document-store",
            Tags = new List<string> { "短视频", "素材", "加工台" },
            CreatedAt = now,
            UpdatedAt = now,
        };
        await _db.DocumentStores.InsertOneAsync(store, cancellationToken: CancellationToken.None);
        return store;
    }

    private async Task<DocumentEntry> CreateMarkdownEntryAsync(
        DocumentStore store,
        string userId,
        string userName,
        string title,
        string markdown,
        string summary,
        List<string> tags,
        Dictionary<string, string> metadata,
        DateTime now)
    {
        var parsed = await _documentService.ParseAsync(markdown);
        parsed.Title = title;
        await _documentService.SaveAsync(parsed);

        var entry = new DocumentEntry
        {
            StoreId = store.Id,
            DocumentId = parsed.Id,
            Title = title,
            Summary = summary,
            SourceType = DocumentSourceType.Import,
            ContentType = "text/markdown",
            FileSize = Encoding.UTF8.GetByteCount(markdown),
            Tags = tags,
            Metadata = metadata,
            CreatedBy = userId,
            CreatedByName = userName,
            UpdatedBy = userId,
            UpdatedByName = userName,
            ContentIndex = markdown.Length > 2000 ? markdown[..2000] : markdown,
            LastChangedAt = now,
            CreatedAt = now,
            UpdatedAt = now,
        };
        await _db.DocumentEntries.InsertOneAsync(entry, cancellationToken: CancellationToken.None);
        await _db.DocumentStores.UpdateOneAsync(
            s => s.Id == store.Id,
            Builders<DocumentStore>.Update
                .Inc(s => s.DocumentCount, 1)
                .Set(s => s.PrimaryEntryId, string.IsNullOrEmpty(store.PrimaryEntryId) ? entry.Id : store.PrimaryEntryId)
                .Set(s => s.UpdatedAt, DateTime.UtcNow),
            cancellationToken: CancellationToken.None);
        if (string.IsNullOrEmpty(store.PrimaryEntryId))
            store.PrimaryEntryId = entry.Id;
        return entry;
    }

    private async Task SaveRunAsync(ShortVideoMaterialRun run)
    {
        await _db.ShortVideoMaterialRuns.ReplaceOneAsync(
            r => r.Id == run.Id,
            run,
            new ReplaceOptions { IsUpsert = true },
            CancellationToken.None);
    }

    private static List<ShortVideoMaterialStage> BuildInitialStages()
        => new()
        {
            Stage("parse", "解析链接", "running", "已收到链接，正在读取短视频信息"),
            Stage("source", "保存原始素材", "pending", "等待链接解析完成"),
            Stage("transcript", "生成字幕文稿", "pending", "等待原始素材保存完成"),
            Stage("timeline", "整理时间线", "pending", "等待字幕文稿生成"),
            Stage("ready", "准备继续加工", "pending", "等待默认产物入库"),
        };

    private static ShortVideoMaterialStage Stage(string key, string label, string status, string message)
        => new() { Key = key, Label = label, Status = status, Message = message, At = DateTime.UtcNow };

    private static void MarkStage(ShortVideoMaterialRun run, string key, string status, string message)
    {
        var stage = run.Stages.FirstOrDefault(s => s.Key == key);
        if (stage == null)
        {
            run.Stages.Add(Stage(key, key, status, message));
            return;
        }
        stage.Status = status;
        stage.Message = message;
        stage.At = DateTime.UtcNow;
    }

    private static void MarkFirstRunningStageFailed(ShortVideoMaterialRun run, string message)
    {
        var stage = run.Stages.FirstOrDefault(s => s.Status == "running")
                    ?? run.Stages.FirstOrDefault(s => s.Status == "pending");
        if (stage == null) return;
        stage.Status = "failed";
        stage.Message = message;
        stage.At = DateTime.UtcNow;
    }

    private static string? CleanTitle(string? title)
    {
        var t = title?.Trim();
        return string.IsNullOrWhiteSpace(t) ? null : t.Length > 80 ? t[..80] : t;
    }

    private static string ExtractUrl(string? input)
    {
        if (string.IsNullOrWhiteSpace(input)) return string.Empty;
        var match = Regex.Match(input, @"https?://[^\s""']+", RegexOptions.IgnoreCase);
        return match.Success ? match.Value.TrimEnd('。', '，', ',', '.', ')', ']') : input.Trim();
    }

    private static string DetectPlatform(string url)
    {
        var lower = url.ToLowerInvariant();
        if (lower.Contains("douyin.com") || lower.Contains("iesdouyin.com")) return "douyin";
        if (lower.Contains("tiktok.com")) return "tiktok";
        if (lower.Contains("kuaishou.com") || lower.Contains("gifshow.com")) return "kuaishou";
        if (lower.Contains("bilibili.com") || lower.Contains("b23.tv")) return "bilibili";
        if (lower.Contains("xiaohongshu.com") || lower.Contains("xhslink.com")) return "xiaohongshu";
        if (lower.Contains("youtube.com") || lower.Contains("youtu.be")) return "youtube";
        return "unknown";
    }

    private async Task<ParsedShortVideoSource> ResolveParsedSourceAsync(string videoUrl, string platform, string? manualText, string? requestedTitle)
    {
        var trimmedManual = manualText?.Trim();
        var hasManualText = !string.IsNullOrWhiteSpace(trimmedManual);
        var apiKey = ResolveTikHubApiKey();
        if (string.IsNullOrWhiteSpace(apiKey))
        {
            return new ParsedShortVideoSource(
                CleanTitle(requestedTitle),
                trimmedManual,
                hasManualText ? "manual" : "metadata-fallback",
                hasManualText ? "已使用用户提供的字幕/文案作为解析来源" : "TikHub API 密钥未配置，已生成原始素材和待补充文案骨架",
                null);
        }

        try
        {
            var parserNode = new WorkflowNode
            {
                NodeId = "short-video-parser",
                Name = "短视频解析",
                NodeType = CapsuleTypes.DouyinParser,
                Config = new Dictionary<string, object?>
                {
                    ["apiBaseUrl"] = ResolveTikHubApiBaseUrl(),
                    ["apiKey"] = apiKey,
                    ["videoUrl"] = videoUrl,
                },
            };
            var parserResult = await CapsuleExecutor.ExecuteDouyinParserAsync(
                _serviceProvider,
                parserNode,
                new Dictionary<string, string>(),
                new List<ExecutionArtifact>());
            var metadataJson = parserResult.Artifacts.FirstOrDefault()?.InlineContent;
            var metadata = ExtractParsedMetadata(metadataJson);

            string? parsedText = null;
            if (!string.IsNullOrWhiteSpace(metadataJson))
            {
                var textNode = new WorkflowNode
                {
                    NodeId = "short-video-text",
                    Name = "视频内容转文本",
                    NodeType = CapsuleTypes.VideoToText,
                    Config = new Dictionary<string, object?>
                    {
                        ["extractMode"] = "metadata",
                    },
                };
                var textResult = await CapsuleExecutor.ExecuteVideoToTextAsync(
                    _serviceProvider,
                    textNode,
                    new Dictionary<string, string>(),
                    new List<ExecutionArtifact>
                    {
                        new()
                        {
                            SlotId = "vt-in",
                            Name = "视频信息",
                            MimeType = "application/json",
                            InlineContent = metadataJson,
                        },
                    },
                    null);
                parsedText = ExtractTranscript(textResult.Artifacts.FirstOrDefault()?.InlineContent);
            }

            var source = hasManualText ? trimmedManual : parsedText;
            var mode = hasManualText ? "manual" : string.IsNullOrWhiteSpace(source) ? "metadata-fallback" : "tikhub-metadata";
            var message = mode switch
            {
                "manual" => "已调用短视频解析器获取元数据，并使用用户提供的字幕/文案作为素材来源",
                "tikhub-metadata" => "已调用短视频解析器获取标题、描述和元数据，并保存为知识库素材",
                _ => "短视频解析器未返回可用文案，已生成原始素材和待补充文案骨架",
            };
            return new ParsedShortVideoSource(metadata.Title, source, mode, message, metadataJson);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "短视频解析器降级 videoUrl={VideoUrl}", videoUrl);
            return new ParsedShortVideoSource(
                CleanTitle(requestedTitle),
                trimmedManual,
                hasManualText ? "manual" : "metadata-fallback",
                hasManualText ? "短视频解析器暂不可用，已使用用户提供的字幕/文案作为素材来源" : "短视频解析器暂不可用，已生成原始素材和待补充文案骨架",
                null);
        }
    }

    private string ResolveTikHubApiKey()
        => (_config["ShortVideo:TikHubApiKey"]
            ?? _config["TikHub:ApiKey"]
            ?? Environment.GetEnvironmentVariable("TIKHUB_API_KEY")
            ?? string.Empty).Trim();

    private string ResolveTikHubApiBaseUrl()
        => (_config["ShortVideo:TikHubApiBaseUrl"]
            ?? _config["TikHub:ApiBaseUrl"]
            ?? Environment.GetEnvironmentVariable("TIKHUB_API_BASE_URL")
            ?? "https://tikhub.io/api/douyin").TrimEnd('/');

    private static ParsedVideoMetadata ExtractParsedMetadata(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return new ParsedVideoMetadata(null);
        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            return new ParsedVideoMetadata(GetJsonString(root, "title", "desc", "description"));
        }
        catch
        {
            return new ParsedVideoMetadata(null);
        }
    }

    private static string? ExtractTranscript(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return null;
        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            return FirstNonEmpty(
                GetJsonString(root, "transcript", "body", "description", "title"),
                root.TryGetProperty("bullets", out var bullets) && bullets.ValueKind == JsonValueKind.Array
                    ? string.Join("\n", bullets.EnumerateArray().Select(x => x.GetString()).Where(x => !string.IsNullOrWhiteSpace(x)))
                    : null);
        }
        catch
        {
            return json.Trim();
        }
    }

    private static string? GetJsonString(JsonElement root, params string[] names)
    {
        foreach (var name in names)
        {
            if (root.TryGetProperty(name, out var value))
            {
                if (value.ValueKind == JsonValueKind.String)
                    return value.GetString();
                if (value.ValueKind is JsonValueKind.Number or JsonValueKind.True or JsonValueKind.False)
                    return value.ToString();
            }
        }
        return null;
    }

    private static string? FirstNonEmpty(params string?[] values)
        => values.FirstOrDefault(v => !string.IsNullOrWhiteSpace(v))?.Trim();

    private static string NormalizeSourceText(string? sourceText, string title, string videoUrl, string platform)
    {
        var text = sourceText?.Trim();
        if (!string.IsNullOrWhiteSpace(text)) return text.Length > 12000 ? text[..12000] : text;
        return $"来源链接：{videoUrl}\n平台：{platform}\n主题：{title}\n\n当前没有可用字幕或口播稿。请在本条目中补充转写、要点或片段，再继续使用知识库智能体加工。";
    }

    private static string BuildSourceMarkdown(string title, string videoUrl, string platform, ParsedShortVideoSource parsed)
    {
        var sb = new StringBuilder();
        sb.AppendLine($"# {title} · 原始视频素材");
        sb.AppendLine();
        sb.AppendLine($"> 素材类型：短视频链接");
        sb.AppendLine($"> 来源平台：{platform}");
        sb.AppendLine($"> 原始链接：{videoUrl}");
        sb.AppendLine($"> 解析来源：{SourceModeLabel(parsed.SourceMode)}");
        sb.AppendLine();
        sb.AppendLine("## 可以继续做什么");
        sb.AppendLine();
        sb.AppendLine("- 生成字幕或补充口播稿。");
        sb.AppendLine("- 把字幕文稿或时间轴片段交给智能体再加工。");
        sb.AppendLine("- 从素材生成教程、脚本、课程、网页草稿或资料包。");
        sb.AppendLine();
        if (!string.IsNullOrWhiteSpace(parsed.MetadataJson))
        {
            sb.AppendLine("## 解析元数据");
            sb.AppendLine();
            sb.AppendLine("```json");
            sb.AppendLine(parsed.MetadataJson);
            sb.AppendLine("```");
        }
        return sb.ToString();
    }

    private static string BuildTranscriptMarkdown(string title, string videoUrl, string platform, string sourceText, string sourceMode)
    {
        var sb = new StringBuilder();
        sb.AppendLine($"# {title} · 字幕文稿");
        sb.AppendLine();
        sb.AppendLine($"> 来源平台：{platform}");
        sb.AppendLine($"> 原始链接：{videoUrl}");
        sb.AppendLine($"> 生成方式：{SourceModeLabel(sourceMode)}");
        sb.AppendLine();
        sb.AppendLine("## 字幕/文案");
        sb.AppendLine();
        sb.AppendLine(sourceText);
        sb.AppendLine();
        sb.AppendLine("## 后续加工建议");
        sb.AppendLine();
        sb.AppendLine("- 选中本条目点击「智能体」，加工成教程、脚本、课程大纲或网页草稿。");
        sb.AppendLine("- 对具体段落做划词编辑、补充说明或生成配图。");
        sb.AppendLine("- 和时间轴片段一起引用，生成可跳转的视频课程页面。");
        return sb.ToString();
    }

    private static List<TimelineSegment> BuildTimeline(string sourceText)
    {
        var lines = sourceText.Replace("\r\n", "\n").Split('\n')
            .Select(x => Regex.Replace(x.Trim().Trim('-', '*', ' ', '\t'), @"\s+", " "))
            .Where(x => x.Length > 0)
            .Take(12)
            .ToList();
        if (lines.Count == 0)
        {
            lines.Add("补充字幕或口播稿后重新整理时间轴");
        }
        return lines.Select((line, idx) =>
        {
            var time = TimeSpan.FromSeconds(idx * 15);
            return new TimelineSegment($"{(int)time.TotalMinutes:00}:{time.Seconds:00}", line);
        }).ToList();
    }

    private static string BuildTimelineMarkdown(string title, string videoUrl, string platform, List<TimelineSegment> timeline)
    {
        var sb = new StringBuilder();
        sb.AppendLine($"# {title} · 时间轴片段");
        sb.AppendLine();
        sb.AppendLine($"> 来源平台：{platform}");
        sb.AppendLine($"> 原始链接：{videoUrl}");
        sb.AppendLine();
        sb.AppendLine("## 时间轴");
        sb.AppendLine();
        sb.AppendLine("| 时间 | 片段内容 | 可加工方向 |");
        sb.AppendLine("|---|---|---|");
        foreach (var item in timeline)
        {
            sb.AppendLine($"| {item.Time} | {EscapeMarkdownCell(item.Text)} | 章节、步骤、镜头或知识点 |");
        }
        sb.AppendLine();
        sb.AppendLine("## 用法");
        sb.AppendLine();
        sb.AppendLine("这不是最终教程，而是后续加工的切片素材。可以把其中几段合并成章节，也可以挑出关键片段继续生成图文、脚本或网页草稿。");
        return sb.ToString();
    }

    private static string EscapeMarkdownCell(string text)
        => text.Replace("|", "\\|").Replace("\n", " ");

    private static string SourceModeLabel(string sourceMode) => sourceMode switch
    {
        "manual" => "用户提供字幕/文案",
        "tikhub-metadata" => "短视频解析器元数据",
        _ => "链接元数据兜底",
    };

    private sealed record ParsedShortVideoSource(string? Title, string? SourceText, string SourceMode, string Message, string? MetadataJson);
    private sealed record ParsedVideoMetadata(string? Title);
    private sealed record TimelineSegment(string Time, string Text);
}

public class CreateShortVideoMaterialRequest
{
    public string VideoUrl { get; set; } = string.Empty;
    public string? SourceText { get; set; }
    public string? Title { get; set; }
    public string? StoreId { get; set; }
}

public class ShortVideoMaterialRunResponse
{
    public ShortVideoMaterialRun Run { get; set; } = new();
    public string StoreId { get; set; } = string.Empty;
    public List<string> EntryIds { get; set; } = new();
    public string SourceEntryId { get; set; } = string.Empty;
    public string TranscriptEntryId { get; set; } = string.Empty;
    public string TimelineEntryId { get; set; } = string.Empty;
    public string StoreUrl { get; set; } = string.Empty;
    public string SourceUrl { get; set; } = string.Empty;
    public string TranscriptUrl { get; set; } = string.Empty;
    public string TimelineUrl { get; set; } = string.Empty;
}
