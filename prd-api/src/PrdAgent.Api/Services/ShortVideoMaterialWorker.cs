using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services;

/// <summary>
/// 短视频素材解析后台 Worker。遵循服务器权威性：HTTP 只创建 run，实际解析和入库由 Worker 持续推进。
/// </summary>
public sealed class ShortVideoMaterialWorker : BackgroundService
{
    private static readonly TimeSpan ScanInterval = TimeSpan.FromSeconds(2);
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly ILogger<ShortVideoMaterialWorker> _logger;
    private string? _currentRunId;

    public ShortVideoMaterialWorker(IServiceScopeFactory scopeFactory, ILogger<ShortVideoMaterialWorker> logger)
    {
        _scopeFactory = scopeFactory;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _logger.LogInformation("[short-video-material] Worker started");
        await RecoverRunningRunsAsync();

        try
        {
            while (!stoppingToken.IsCancellationRequested)
            {
                try
                {
                    await ProcessNextRunAsync();
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "[short-video-material] Worker loop error");
                }
                await Task.Delay(ScanInterval, stoppingToken);
            }
        }
        finally
        {
            await MarkCurrentRunFailedAsync("Worker 关闭，短视频解析任务被中断");
        }
    }

    private async Task RecoverRunningRunsAsync()
    {
        try
        {
            using var scope = _scopeFactory.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<MongoDbContext>();
            var recovered = await db.ShortVideoMaterialRuns.UpdateManyAsync(
                r => r.Status == "running",
                Builders<ShortVideoMaterialRun>.Update
                    .Set(r => r.Status, "failed")
                    .Set(r => r.ErrorMessage, "服务重启，短视频解析任务被中断")
                    .Set(r => r.UpdatedAt, DateTime.UtcNow),
                cancellationToken: CancellationToken.None);
            if (recovered.ModifiedCount > 0)
                _logger.LogWarning("[short-video-material] 启动兜底：{Count} 个残留 running run 标记为失败", recovered.ModifiedCount);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[short-video-material] 启动兜底回收失败");
        }
    }

    private async Task MarkCurrentRunFailedAsync(string message)
    {
        if (string.IsNullOrWhiteSpace(_currentRunId)) return;
        try
        {
            using var scope = _scopeFactory.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<MongoDbContext>();
            await db.ShortVideoMaterialRuns.UpdateOneAsync(
                r => r.Id == _currentRunId && r.Status == "running",
                Builders<ShortVideoMaterialRun>.Update
                    .Set(r => r.Status, "failed")
                    .Set(r => r.ErrorMessage, message)
                    .Set(r => r.UpdatedAt, DateTime.UtcNow),
                cancellationToken: CancellationToken.None);
        }
        catch { /* ignore */ }
    }

    private async Task ProcessNextRunAsync()
    {
        using var scope = _scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MongoDbContext>();
        var processor = scope.ServiceProvider.GetRequiredService<ShortVideoMaterialProcessor>();

        var run = await db.ShortVideoMaterialRuns.FindOneAndUpdateAsync(
            Builders<ShortVideoMaterialRun>.Filter.Eq(r => r.Status, "queued"),
            Builders<ShortVideoMaterialRun>.Update
                .Set(r => r.Status, "running")
                .Set(r => r.UpdatedAt, DateTime.UtcNow),
            new FindOneAndUpdateOptions<ShortVideoMaterialRun>
            {
                Sort = Builders<ShortVideoMaterialRun>.Sort.Ascending(r => r.CreatedAt),
                ReturnDocument = ReturnDocument.After,
            },
            cancellationToken: CancellationToken.None);
        if (run == null) return;

        _currentRunId = run.Id;
        try
        {
            await processor.ProcessAsync(run.Id);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[short-video-material] Process failed run={RunId}", run.Id);
            var latest = await db.ShortVideoMaterialRuns.Find(r => r.Id == run.Id).FirstOrDefaultAsync(CancellationToken.None);
            if (latest != null)
            {
                latest.Status = "failed";
                latest.ErrorMessage = ex.Message;
                ShortVideoMaterialProcessor.MarkFirstRunningStageFailed(latest, ex.Message);
                latest.UpdatedAt = DateTime.UtcNow;
                await db.ShortVideoMaterialRuns.ReplaceOneAsync(r => r.Id == latest.Id, latest, cancellationToken: CancellationToken.None);
            }
        }
        finally
        {
            _currentRunId = null;
        }
    }
}

public sealed class ShortVideoMaterialProcessor
{
    private readonly MongoDbContext _db;
    private readonly IDocumentService _documentService;
    private readonly IConfiguration _config;
    private readonly IServiceProvider _serviceProvider;
    private readonly ILogger<ShortVideoMaterialProcessor> _logger;

    public ShortVideoMaterialProcessor(
        MongoDbContext db,
        IDocumentService documentService,
        IConfiguration config,
        IServiceProvider serviceProvider,
        ILogger<ShortVideoMaterialProcessor> logger)
    {
        _db = db;
        _documentService = documentService;
        _config = config;
        _serviceProvider = serviceProvider;
        _logger = logger;
    }

    public async Task ProcessAsync(string runId)
    {
        var run = await _db.ShortVideoMaterialRuns.Find(r => r.Id == runId).FirstOrDefaultAsync(CancellationToken.None)
                  ?? throw new InvalidOperationException("短视频解析运行记录不存在");
        var user = await _db.Users.Find(u => u.UserId == run.UserId).FirstOrDefaultAsync(CancellationToken.None);
        var userName = string.IsNullOrWhiteSpace(user?.DisplayName) ? user?.Username ?? run.UserId : user.DisplayName!;
        var now = DateTime.UtcNow;

        var parsed = await ResolveParsedSourceAsync(run.VideoUrl, run.Platform, run.InputSourceText, run.RequestedTitle);
        var title = CleanTitle(run.RequestedTitle) ?? CleanTitle(parsed.Title) ?? run.Title;
        var sourceText = NormalizeSourceText(parsed.SourceText, title, run.VideoUrl, run.Platform);

        run.Title = title;
        run.SourceMode = parsed.SourceMode;
        run.ParsedMetadataJson = parsed.MetadataJson;
        run.ParserMessage = parsed.Message;
        MarkStage(run, "parse", "done", parsed.Message);
        await SaveRunAsync(run);

        var store = await ResolveStoreAsync(run.StoreId, run.UserId);
        run.StoreId = store.Id;
        MarkStage(run, "source", "running", $"正在保存到知识库「{store.Name}」");
        await SaveRunAsync(run);

        var sourceEntry = await CreateMarkdownEntryAsync(
            store,
            run.UserId,
            userName,
            $"{title} · 原始视频素材.md",
            BuildSourceMarkdown(title, run.VideoUrl, run.Platform, parsed),
            $"{title}：原始短视频素材",
            new List<string> { "短视频", "素材", run.Platform, "原始视频" },
            new Dictionary<string, string>
            {
                ["kind"] = "short-video-source",
                ["runId"] = run.Id,
                ["videoUrl"] = run.VideoUrl,
                ["platform"] = run.Platform,
                ["sourceMode"] = parsed.SourceMode,
            },
            now);
        run.SourceEntryId = sourceEntry.Id;
        MarkStage(run, "source", "done", "原始视频素材已保存到知识库");
        await SaveRunAsync(run);

        MarkStage(run, "transcript", "running", "正在生成可编辑的字幕文稿");
        await SaveRunAsync(run);
        var transcriptEntry = await CreateMarkdownEntryAsync(
            store,
            run.UserId,
            userName,
            $"{title} · 字幕文稿.md",
            BuildTranscriptMarkdown(title, run.VideoUrl, run.Platform, sourceText, parsed.SourceMode),
            $"{title}：短视频字幕与文案素材",
            new List<string> { "短视频", "字幕", "文案", run.Platform },
            new Dictionary<string, string>
            {
                ["kind"] = "short-video-transcript",
                ["runId"] = run.Id,
                ["sourceEntryId"] = sourceEntry.Id,
                ["videoUrl"] = run.VideoUrl,
                ["platform"] = run.Platform,
                ["sourceMode"] = parsed.SourceMode,
            },
            now);
        run.TranscriptEntryId = transcriptEntry.Id;
        MarkStage(run, "transcript", "done", "字幕文稿已保存到知识库，可继续编辑或再加工");
        await SaveRunAsync(run);

        MarkStage(run, "timeline", "running", "正在整理时间线片段");
        await SaveRunAsync(run);
        var timeline = BuildTimeline(sourceText);
        var timelineEntry = await CreateMarkdownEntryAsync(
            store,
            run.UserId,
            userName,
            $"{title} · 时间轴片段.md",
            BuildTimelineMarkdown(title, run.VideoUrl, run.Platform, timeline),
            $"{title}：短视频时间轴片段",
            new List<string> { "短视频", "时间轴", "片段", run.Platform },
            new Dictionary<string, string>
            {
                ["kind"] = "short-video-timeline",
                ["runId"] = run.Id,
                ["sourceEntryId"] = sourceEntry.Id,
                ["transcriptEntryId"] = transcriptEntry.Id,
                ["videoUrl"] = run.VideoUrl,
                ["platform"] = run.Platform,
            },
            now);
        run.TimelineEntryId = timelineEntry.Id;
        MarkStage(run, "timeline", "done", "时间线已保存到知识库，可作为教程、脚本或网页素材继续加工");

        MarkStage(run, "ready", "done", "已准备好继续加工：可打开字幕或时间线，再生成教程、配图或网页");
        run.EntryId = transcriptEntry.Id;
        run.Status = "done";
        run.UpdatedAt = DateTime.UtcNow;
        await SaveRunAsync(run);
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

        const string storeName = "短视频素材库";
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
        run.UpdatedAt = DateTime.UtcNow;
        await _db.ShortVideoMaterialRuns.ReplaceOneAsync(
            r => r.Id == run.Id,
            run,
            new ReplaceOptions { IsUpsert = true },
            CancellationToken.None);
    }

    public static List<ShortVideoMaterialStage> BuildInitialStages()
        => new()
        {
            Stage("parse", "解析链接", "pending", "已创建后台任务，等待开始处理"),
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

    public static void MarkFirstRunningStageFailed(ShortVideoMaterialRun run, string message)
    {
        var stage = run.Stages.FirstOrDefault(s => s.Status == "running")
                    ?? run.Stages.FirstOrDefault(s => s.Status == "pending");
        if (stage == null) return;
        stage.Status = "failed";
        stage.Message = message;
        stage.At = DateTime.UtcNow;
    }

    public static string ExtractUrl(string? input)
    {
        if (string.IsNullOrWhiteSpace(input)) return string.Empty;
        var match = Regex.Match(input, @"https?://[^\s""']+", RegexOptions.IgnoreCase);
        return match.Success ? match.Value.TrimEnd('。', '，', ',', '.', ')', ']') : input.Trim();
    }

    public static string DetectPlatform(string url)
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
            ?? "https://api.tikhub.dev").TrimEnd('/');

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

    private static string? CleanTitle(string? title)
    {
        var t = title?.Trim();
        return string.IsNullOrWhiteSpace(t) ? null : t.Length > 80 ? t[..80] : t;
    }

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
