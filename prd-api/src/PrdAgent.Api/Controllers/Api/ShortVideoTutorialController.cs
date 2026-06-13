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
/// 短视频教程流水线：短视频链接/文案 → 知识库教程文档 → 网页托管 → 公开分享 → 访问统计入口。
/// </summary>
[ApiController]
[Route("api/short-video-tutorial")]
[Authorize]
[AdminController("document-store", AdminPermissionCatalog.DocumentStoreWrite)]
public class ShortVideoTutorialController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly IDocumentService _documentService;
    private readonly IHostedSiteService _hostedSiteService;
    private readonly IConfiguration _config;
    private readonly IServiceProvider _serviceProvider;
    private readonly ILogger<ShortVideoTutorialController> _logger;

    public ShortVideoTutorialController(
        MongoDbContext db,
        IDocumentService documentService,
        IHostedSiteService hostedSiteService,
        IConfiguration config,
        IServiceProvider serviceProvider,
        ILogger<ShortVideoTutorialController> logger)
    {
        _db = db;
        _documentService = documentService;
        _hostedSiteService = hostedSiteService;
        _config = config;
        _serviceProvider = serviceProvider;
        _logger = logger;
    }

    private string GetUserId() => this.GetRequiredUserId();

    [HttpPost("runs")]
    public async Task<IActionResult> CreateRun([FromBody] CreateShortVideoTutorialRequest req)
    {
        var userId = GetUserId();
        var now = DateTime.UtcNow;
        var title = CleanTitle(req.Title) ?? $"短视频教程 {DateTime.UtcNow:yyyyMMdd-HHmm}";
        var videoUrl = ExtractUrl(req.VideoUrl);
        if (string.IsNullOrWhiteSpace(videoUrl))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请填写短视频链接"));

        var user = await _db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync(CancellationToken.None);
        var userName = string.IsNullOrWhiteSpace(user?.DisplayName) ? user?.Username ?? userId : user.DisplayName!;
        var platform = DetectPlatform(videoUrl);

        var run = new ShortVideoTutorialRun
        {
            UserId = userId,
            VideoUrl = videoUrl,
            Platform = platform,
            Title = title,
            SourceMode = "resolving",
            Status = "running",
            CreatedAt = now,
            UpdatedAt = now,
            Stages = BuildInitialStages(),
        };
        await _db.ShortVideoTutorialRuns.InsertOneAsync(run, cancellationToken: CancellationToken.None);

        try
        {
            var parsedSource = await ResolveParsedSourceAsync(videoUrl, platform, req.SourceText, req.Title);
            title = CleanTitle(req.Title) ?? CleanTitle(parsedSource.Title) ?? title;
            var sourceText = NormalizeSourceText(parsedSource.SourceText, title, videoUrl, platform);
            var sourceMode = parsedSource.SourceMode;
            run.Title = title;
            run.SourceMode = sourceMode;
            run.ParsedMetadataJson = parsedSource.MetadataJson;
            run.ParserMessage = parsedSource.Message;
            MarkStage(run, "parse", "done", parsedSource.Message);
            await SaveRunAsync(run);

            var store = await ResolveStoreAsync(req.StoreId, title, userId);
            run.StoreId = store.Id;
            MarkStage(run, "kb", "running", $"正在写入知识库「{store.Name}」");

            var tutorial = BuildTutorialMarkdown(title, videoUrl, platform, sourceText, req.Style ?? "guide", sourceMode);
            var parsed = await _documentService.ParseAsync(tutorial.Markdown);
            parsed.Title = title;
            await _documentService.SaveAsync(parsed);

            var entry = new DocumentEntry
            {
                StoreId = store.Id,
                DocumentId = parsed.Id,
                Title = $"{title}.md",
                Summary = tutorial.Summary,
                SourceType = DocumentSourceType.Import,
                ContentType = "text/markdown",
                FileSize = Encoding.UTF8.GetByteCount(tutorial.Markdown),
                Tags = new List<string> { "短视频", "教程", platform },
                Metadata = new Dictionary<string, string>
                {
                    ["kind"] = "short-video-tutorial",
                    ["runId"] = run.Id,
                    ["videoUrl"] = videoUrl,
                    ["platform"] = platform,
                    ["sourceMode"] = sourceMode,
                },
                CreatedBy = userId,
                CreatedByName = userName,
                UpdatedBy = userId,
                UpdatedByName = userName,
                ContentIndex = tutorial.Markdown.Length > 2000 ? tutorial.Markdown[..2000] : tutorial.Markdown,
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

            run.EntryId = entry.Id;
            MarkStage(run, "kb", "done", "教程文档已写入知识库");

            MarkStage(run, "image", "running", "正在按教程步骤生成网页配图");
            var html = BuildTutorialHtml(title, videoUrl, platform, sourceText, req.Style ?? "guide", run.Id);
            MarkStage(run, "image", "done", "已生成封面图与步骤配图");

            MarkStage(run, "site", "running", "正在发布到网页托管");
            var site = await _hostedSiteService.CreateFromContentAsync(
                userId,
                html,
                title,
                $"由短视频链接自动生成的网页教程，来源平台：{platform}",
                "short-video-tutorial",
                run.Id,
                new List<string> { "短视频教程", platform, "知识库" },
                "短视频教程",
                CancellationToken.None);
            run.SiteId = site.Id;
            MarkStage(run, "site", "done", "网页教程已发布到网页托管");

            MarkStage(run, "share", "running", "正在生成公开分享链接");
            var share = await _hostedSiteService.CreateShareAsync(
                userId: userId,
                displayName: userName,
                siteId: site.Id,
                siteIds: null,
                shareType: "single",
                title: title,
                description: $"短视频教程分享：{title}",
                password: null,
                expiresInDays: 0,
                ct: CancellationToken.None,
                purpose: "share",
                forceNew: true,
                visibility: "public");
            run.ShareId = share.Id;
            run.ShareToken = share.Token;
            MarkStage(run, "share", "done", "公开分享链接已生成");

            MarkStage(run, "analytics", "done", "访问人数将在分享页访问后写入网页托管统计");
            run.Status = "done";
            run.UpdatedAt = DateTime.UtcNow;
            await SaveRunAsync(run);

            var baseUrl = Request.ResolveServerUrl(_config);
            var response = new ShortVideoTutorialRunResponse
            {
                Run = run,
                StoreId = store.Id,
                EntryId = entry.Id,
                SiteId = site.Id,
                SiteUrl = site.SiteUrl,
                ShareUrl = $"{baseUrl}/s/wp/{share.Token}",
                AnalyticsUrl = $"{baseUrl}/web-pages",
                DocumentUrl = $"{baseUrl}/document-store?storeId={store.Id}&entryId={entry.Id}",
                ShareViewCount = share.ViewCount,
            };
            return Ok(ApiResponse<ShortVideoTutorialRunResponse>.Ok(response));
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "短视频教程流水线失败 run={RunId}", run.Id);
            run.Status = "failed";
            run.ErrorMessage = ex.Message;
            MarkFirstRunningStageFailed(run, ex.Message);
            run.UpdatedAt = DateTime.UtcNow;
            await SaveRunAsync(run);
            return StatusCode(500, ApiResponse<ShortVideoTutorialRunResponse>.Fail(ErrorCodes.INTERNAL_ERROR, $"短视频教程生成失败：{ex.Message}"));
        }
    }

    [HttpGet("runs/{runId}")]
    public async Task<IActionResult> GetRun(string runId)
    {
        var userId = GetUserId();
        var run = await _db.ShortVideoTutorialRuns
            .Find(r => r.Id == runId && r.UserId == userId)
            .FirstOrDefaultAsync(CancellationToken.None);
        if (run == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "运行记录不存在"));
        return Ok(ApiResponse<ShortVideoTutorialRun>.Ok(run));
    }

    private async Task<DocumentStore> ResolveStoreAsync(string? storeId, string title, string userId)
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

        var storeName = $"短视频教程库";
        var store = await _db.DocumentStores
            .Find(s => s.OwnerId == userId && s.Name == storeName)
            .FirstOrDefaultAsync(CancellationToken.None);
        if (store != null) return store;

        var now = DateTime.UtcNow;
        store = new DocumentStore
        {
            Name = storeName,
            Description = "由短视频链接自动沉淀的教程文档",
            OwnerId = userId,
            AppKey = "document-store",
            Tags = new List<string> { "短视频", "教程", "自动生成" },
            CreatedAt = now,
            UpdatedAt = now,
        };
        await _db.DocumentStores.InsertOneAsync(store, cancellationToken: CancellationToken.None);
        return store;
    }

    private async Task SaveRunAsync(ShortVideoTutorialRun run)
    {
        await _db.ShortVideoTutorialRuns.ReplaceOneAsync(
            r => r.Id == run.Id,
            run,
            new ReplaceOptions { IsUpsert = true },
            CancellationToken.None);
    }

    private static List<ShortVideoTutorialStage> BuildInitialStages()
        => new()
        {
            Stage("parse", "解析短视频文案", "running", "服务端已接收链接，正在准备解析来源"),
            Stage("kb", "写入知识库", "pending", "等待教程文档生成"),
            Stage("image", "自动配图", "pending", "等待教程结构生成"),
            Stage("site", "生成网页教程", "pending", "等待网页内容生成"),
            Stage("share", "发布分享", "pending", "等待站点发布"),
            Stage("analytics", "访问统计", "pending", "等待分享链接生成"),
        };

    private static ShortVideoTutorialStage Stage(string key, string label, string status, string message)
        => new() { Key = key, Label = label, Status = status, Message = message, At = DateTime.UtcNow };

    private static void MarkStage(ShortVideoTutorialRun run, string key, string status, string message)
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

    private static void MarkFirstRunningStageFailed(ShortVideoTutorialRun run, string message)
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
                hasManualText ? "已使用用户提供的字幕/文案作为解析来源" : "TikHub API 密钥未配置，已使用链接元数据生成教程骨架",
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
                "manual" => "已调用短视频解析器获取元数据，并使用用户提供的字幕/文案作为教程来源",
                "tikhub-metadata" => "已调用短视频解析器获取标题、描述和元数据，并加工为教程来源",
                _ => "短视频解析器未返回可用文案，已使用链接元数据生成教程骨架",
            };
            return new ParsedShortVideoSource(metadata.Title, source, mode, message, metadataJson);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "短视频解析器降级 runSource videoUrl={VideoUrl}", videoUrl);
            return new ParsedShortVideoSource(
                CleanTitle(requestedTitle),
                trimmedManual,
                hasManualText ? "manual" : "metadata-fallback",
                hasManualText ? "短视频解析器暂不可用，已使用用户提供的字幕/文案作为解析来源" : "短视频解析器暂不可用，已使用链接元数据生成教程骨架",
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
        return $"来源链接：{videoUrl}\n平台：{platform}\n主题：{title}\n\n当前没有外部转写文本，系统已根据标题和链接生成教程骨架。建议在页面中补充视频字幕、口播稿或要点后重新生成，以获得完整教程。";
    }

    private static TutorialContent BuildTutorialMarkdown(string title, string videoUrl, string platform, string sourceText, string style, string sourceMode)
    {
        var bullets = ExtractBullets(sourceText);
        var styleLabel = StyleLabel(style);
        var summary = $"{title}：基于 {platform} 短视频生成的 {styleLabel} 教程";
        var sb = new StringBuilder();
        sb.AppendLine($"# {title}");
        sb.AppendLine();
        sb.AppendLine($"> 来源平台：{platform}");
        sb.AppendLine($"> 原始链接：{videoUrl}");
        sb.AppendLine($"> 生成方式：{SourceModeLabel(sourceMode)}");
        sb.AppendLine();
        sb.AppendLine("## 教程目标");
        sb.AppendLine();
        sb.AppendLine($"让读者按照本文步骤复现视频中的核心方法，并能继续编辑、配图、发布为网页教程。");
        sb.AppendLine();
        sb.AppendLine("## 核心步骤");
        sb.AppendLine();
        for (var i = 0; i < bullets.Count; i++)
        {
            sb.AppendLine($"### 步骤 {i + 1}：{bullets[i].Title}");
            sb.AppendLine();
            sb.AppendLine(bullets[i].Body);
            sb.AppendLine();
            sb.AppendLine($"配图建议：用「步骤 {i + 1}」场景图展示动作前后对比，突出关键对象和结果状态。");
            sb.AppendLine();
        }
        sb.AppendLine("## 常见问题");
        sb.AppendLine();
        sb.AppendLine("- 如果短视频没有字幕，先补充口播稿或关键要点，再重新生成。");
        sb.AppendLine("- 如果教程需要换风格，回到短视频教程流水线页面选择新的网页风格后重新发布。");
        sb.AppendLine("- 如果需要查看访问人数，打开网页托管的分享统计面板。");
        sb.AppendLine();
        sb.AppendLine("## 原始文案");
        sb.AppendLine();
        sb.AppendLine(sourceText);
        return new TutorialContent(summary, sb.ToString());
    }

    private static string BuildTutorialHtml(string title, string videoUrl, string platform, string sourceText, string style, string runId)
    {
        var bullets = ExtractBullets(sourceText);
        var palette = style switch
        {
            "studio" => ("#141414", "#f2f2f2", "#f6c453", "#2a2a2a"),
            "fresh" => ("#f7faf8", "#173b35", "#2f9e80", "#ffffff"),
            "paper" => ("#fbfaf5", "#242424", "#7a5c2e", "#ffffff"),
            _ => ("#f6f7fb", "#20222a", "#4f6bed", "#ffffff"),
        };
        var safeTitle = WebUtility.HtmlEncode(title);
        var safeUrl = WebUtility.HtmlEncode(videoUrl);
        var safePlatform = WebUtility.HtmlEncode(platform);
        var stepCards = string.Join("\n", bullets.Select((b, i) => $"""
        <section class="step">
          <div class="art">
            <svg viewBox="0 0 420 260" role="img" aria-label="步骤 {i + 1} 配图">
              <rect width="420" height="260" rx="18" fill="{palette.Item4}"/>
              <path d="M38 180 C112 58, 186 64, 242 128 S336 217, 382 76" fill="none" stroke="{palette.Item3}" stroke-width="13" stroke-linecap="round"/>
              <circle cx="{90 + i * 42}" cy="{72 + i * 18}" r="30" fill="{palette.Item3}" opacity=".18"/>
              <rect x="54" y="182" width="312" height="16" rx="8" fill="{palette.Item3}" opacity=".22"/>
              <rect x="54" y="210" width="220" height="10" rx="5" fill="{palette.Item3}" opacity=".14"/>
              <text x="54" y="74" font-size="34" font-weight="700" fill="{palette.Item2}">Step {i + 1}</text>
            </svg>
          </div>
          <div>
            <p class="kicker">步骤 {i + 1}</p>
            <h2>{WebUtility.HtmlEncode(b.Title)}</h2>
            <p>{WebUtility.HtmlEncode(b.Body)}</p>
          </div>
        </section>
        """));
        var sourcePreview = WebUtility.HtmlEncode(sourceText.Length > 900 ? sourceText[..900] + "..." : sourceText);

        return $$$"""
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{{{safeTitle}}}</title>
  <style>
    :root{--bg:{{{palette.Item1}}};--text:{{{palette.Item2}}};--accent:{{{palette.Item3}}};--panel:{{{palette.Item4}}}}
    *{box-sizing:border-box}
    body{margin:0;background:var(--bg);color:var(--text);font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.65}
    header{min-height:78vh;display:grid;align-items:end;padding:6vw 7vw 8vw;background:linear-gradient(135deg,color-mix(in srgb,var(--accent) 18%,transparent),transparent 60%)}
    .eyebrow{font-size:13px;letter-spacing:0;text-transform:none;color:var(--accent);font-weight:700}
    h1{font-size:clamp(36px,7vw,82px);line-height:1.04;margin:12px 0 18px;max-width:960px;letter-spacing:0}
    .lead{font-size:clamp(16px,2vw,22px);max-width:780px;opacity:.78}
    .meta{display:flex;flex-wrap:wrap;gap:10px;margin-top:28px}
    .chip{border:1px solid color-mix(in srgb,var(--accent) 35%,transparent);border-radius:999px;padding:8px 12px;background:color-mix(in srgb,var(--panel) 76%,transparent);font-size:13px}
    main{padding:0 7vw 8vw}
    .step{display:grid;grid-template-columns:minmax(280px,420px) minmax(0,1fr);gap:42px;align-items:center;border-top:1px solid color-mix(in srgb,var(--text) 14%,transparent);padding:56px 0}
    .art svg{width:100%;display:block;border:1px solid color-mix(in srgb,var(--text) 10%,transparent);border-radius:18px}
    .kicker{color:var(--accent);font-weight:700;margin:0 0 8px}
    h2{font-size:clamp(24px,3.2vw,42px);line-height:1.15;margin:0 0 14px;letter-spacing:0}
    .source{white-space:pre-wrap;background:var(--panel);border:1px solid color-mix(in srgb,var(--text) 12%,transparent);border-radius:18px;padding:24px;overflow:auto}
    footer{padding:28px 7vw;border-top:1px solid color-mix(in srgb,var(--text) 12%,transparent);opacity:.68;font-size:13px}
    a{color:var(--accent)}
    @media(max-width:780px){header{min-height:70vh;padding:28px 20px 48px}main{padding:0 20px 48px}.step{grid-template-columns:1fr;gap:20px;padding:38px 0}}
  </style>
</head>
<body>
  <header>
    <div>
      <p class="eyebrow">短视频网页教程</p>
      <h1>{{{safeTitle}}}</h1>
      <p class="lead">从短视频链接沉淀为可编辑知识库教程，并发布成可分享网页。页面中的配图由流水线根据步骤自动生成。</p>
      <div class="meta">
        <span class="chip">平台：{{{safePlatform}}}</span>
        <span class="chip">Run：{{{WebUtility.HtmlEncode(runId)}}}</span>
        <span class="chip"><a href="{{{safeUrl}}}" target="_blank" rel="noreferrer">查看原始链接</a></span>
      </div>
    </div>
  </header>
  <main>
    {{{stepCards}}}
    <section class="step">
      <div>
        <p class="kicker">原始文案</p>
        <h2>可继续编辑与再生成</h2>
        <p>回到知识库文档可改正文，回到流水线页面可选择新风格并重新发布。</p>
      </div>
      <div class="source">{{{sourcePreview}}}</div>
    </section>
  </main>
  <footer>由 MAP 短视频教程流水线生成。访问数据以网页托管分享统计为准。</footer>
</body>
</html>
""";
    }

    private static List<TutorialStep> ExtractBullets(string text)
    {
        var normalized = text.Replace("\r\n", "\n").Trim();
        var lines = normalized.Split('\n')
            .Select(x => Regex.Replace(x.Trim().Trim('-', '•', '*', ' ', '\t'), @"\s+", " "))
            .Where(x => x.Length > 0)
            .Take(6)
            .ToList();
        if (lines.Count == 0)
        {
            lines.Add("明确目标和适用场景");
            lines.Add("拆解关键步骤并准备材料");
            lines.Add("执行操作并检查结果");
        }
        while (lines.Count < 3)
        {
            lines.Add(lines.Count == 1 ? "补充执行细节和注意事项" : "复盘结果并沉淀到知识库");
        }

        return lines.Take(5).Select((line, i) =>
        {
            var title = line.Length > 28 ? line[..28] : line;
            var body = line.Length > 28 ? line : $"围绕“{line}”展开操作，先确认输入材料，再执行动作，最后检查是否得到可复用结果。";
            return new TutorialStep(title, body);
        }).ToList();
    }

    private static string StyleLabel(string style) => style switch
    {
        "studio" => "工作室风格",
        "fresh" => "清爽实操风格",
        "paper" => "文档教程风格",
        _ => "网页教程风格",
    };

    private static string SourceModeLabel(string sourceMode) => sourceMode switch
    {
        "manual" => "用户提供文案/字幕，服务端加工",
        "tikhub-metadata" => "短视频解析器提取元数据，服务端加工",
        _ => "链接元数据兜底，等待补充转写",
    };

    private sealed record TutorialStep(string Title, string Body);
    private sealed record TutorialContent(string Summary, string Markdown);
    private sealed record ParsedShortVideoSource(string? Title, string? SourceText, string SourceMode, string Message, string? MetadataJson);
    private sealed record ParsedVideoMetadata(string? Title);
}

public class CreateShortVideoTutorialRequest
{
    public string VideoUrl { get; set; } = string.Empty;
    public string? SourceText { get; set; }
    public string? Title { get; set; }
    public string? StoreId { get; set; }
    public string? Style { get; set; }
}

public class ShortVideoTutorialRunResponse
{
    public ShortVideoTutorialRun Run { get; set; } = new();
    public string StoreId { get; set; } = string.Empty;
    public string EntryId { get; set; } = string.Empty;
    public string SiteId { get; set; } = string.Empty;
    public string SiteUrl { get; set; } = string.Empty;
    public string ShareUrl { get; set; } = string.Empty;
    public string AnalyticsUrl { get; set; } = string.Empty;
    public string DocumentUrl { get; set; } = string.Empty;
    public long ShareViewCount { get; set; }
}
