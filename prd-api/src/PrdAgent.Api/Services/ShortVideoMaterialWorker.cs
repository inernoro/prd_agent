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
        run.Title = title;
        run.SourceMode = parsed.SourceMode;
        run.ParsedMetadataJson = parsed.MetadataJson;
        run.ParserMessage = parsed.Message;
        MarkStage(run, "parse", "done", parsed.Message);
        await SaveRunAsync(run);

        var store = await ResolveStoreAsync(run.StoreId, run.UserId);
        run.StoreId = store.Id;
        MarkStage(run, "source", "running", $"正在把视频文件保存到知识库「{store.Name}」");
        await SaveRunAsync(run);

        var videoMaterial = await DownloadVideoMaterialAsync(parsed, run.VideoUrl);
        var sourceEntry = await CreateVideoEntryAsync(
            store,
            run.UserId,
            userName,
            title,
            videoMaterial,
            parsed,
            run.VideoUrl,
            run.Platform,
            run.Id,
            now);
        run.SourceEntryId = sourceEntry.Id;
        MarkStage(run, "source", "done", "原始视频已作为知识库文件入库");
        await SaveRunAsync(run);

        MarkStage(run, "transcript", "running", "正在从已入库视频执行 ASR 转写");
        await SaveRunAsync(run);

        var transcriptAttempt = parsed.SourceMode == "manual"
            ? new VideoTranscriptionAttempt(parsed.SourceText, null)
            : await TryTranscribeVideoAsync(videoMaterial.Url, title);
        if (!string.IsNullOrWhiteSpace(transcriptAttempt.Text))
        {
            var transcriptEntry = await CreateMarkdownEntryAsync(
                store,
                run.UserId,
                userName,
                $"{title} · 原始转写文字.md",
                BuildTranscriptMarkdown(title, run.VideoUrl, run.Platform, transcriptAttempt.Text),
                $"{title}：短视频原始转写文字",
                new List<string> { "短视频", "转写", "原始文字", run.Platform },
                new Dictionary<string, string>
                {
                    ["kind"] = "short-video-transcript",
                    ["runId"] = run.Id,
                    ["sourceEntryId"] = sourceEntry.Id,
                    ["videoUrl"] = run.VideoUrl,
                    ["assetUrl"] = videoMaterial.Url,
                    ["platform"] = run.Platform,
                    ["sourceMode"] = "asr",
                },
                now);
            run.TranscriptEntryId = transcriptEntry.Id;
            run.EntryId = transcriptEntry.Id;
            MarkStage(run, "transcript", "done", "已从视频转写出原始文字并保存到知识库");
            MarkStage(run, "ready", "done", "视频和原始文字已就绪，可继续转文案、润色或整理时间线");
        }
        else
        {
            run.EntryId = sourceEntry.Id;
            var failedMessage = string.IsNullOrWhiteSpace(transcriptAttempt.ErrorMessage)
                ? "未获得真实转写文字，已停止生成文字条目，避免把平台描述当成字幕"
                : $"真实转写失败：{transcriptAttempt.ErrorMessage}。已停止生成文字条目，避免把平台描述当成字幕";
            MarkStage(run, "transcript", "failed", failedMessage);
            MarkStage(run, "ready", "done", "视频已入库；文字、文案和时间线需要后续通过转写或人工补充继续加工");
        }

        run.Status = "done";
        run.UpdatedAt = DateTime.UtcNow;
        await SaveRunAsync(run);
    }

    private async Task<DocumentEntry> CreateVideoEntryAsync(
        DocumentStore store,
        string userId,
        string userName,
        string title,
        DownloadedVideoMaterial video,
        ParsedShortVideoSource parsed,
        string originalUrl,
        string platform,
        string runId,
        DateTime now)
    {
        var fileName = BuildVideoFileName(title);
        var attachment = new Attachment
        {
            UploaderId = userId,
            FileName = fileName,
            MimeType = string.IsNullOrWhiteSpace(video.MimeType) ? "video/mp4" : video.MimeType,
            Size = video.FileSize,
            Url = video.Url,
            Type = AttachmentType.Document,
            UploadedAt = now,
        };
        await _db.Attachments.InsertOneAsync(attachment, cancellationToken: CancellationToken.None);

        var entry = new DocumentEntry
        {
            StoreId = store.Id,
            AttachmentId = attachment.AttachmentId,
            Title = fileName,
            Summary = $"{title}：原始短视频文件",
            SourceType = DocumentSourceType.Upload,
            ContentType = attachment.MimeType,
            FileSize = attachment.Size,
            Tags = new List<string> { "短视频", "视频", "原始视频", platform },
            Metadata = new Dictionary<string, string>
            {
                ["kind"] = "short-video-video",
                ["runId"] = runId,
                ["originalShareUrl"] = originalUrl,
                ["assetUrl"] = video.Url,
                ["platform"] = platform,
                ["sourceMode"] = parsed.SourceMode,
            },
            CreatedBy = userId,
            CreatedByName = userName,
            UpdatedBy = userId,
            UpdatedByName = userName,
            ContentIndex = BuildVideoIndex(title, originalUrl, platform, parsed),
            LastChangedAt = now,
            CreatedAt = now,
            UpdatedAt = now,
        };
        if (!string.IsNullOrWhiteSpace(parsed.CoverUrl))
            entry.Metadata["coverUrl"] = parsed.CoverUrl!;

        await _db.DocumentEntries.InsertOneAsync(entry, cancellationToken: CancellationToken.None);
        await IncrementStoreDocumentCountAsync(store, entry.Id);
        return entry;
    }

    private async Task IncrementStoreDocumentCountAsync(DocumentStore store, string entryId)
    {
        await _db.DocumentStores.UpdateOneAsync(
            s => s.Id == store.Id,
            Builders<DocumentStore>.Update
                .Inc(s => s.DocumentCount, 1)
                .Set(s => s.PrimaryEntryId, string.IsNullOrEmpty(store.PrimaryEntryId) ? entryId : store.PrimaryEntryId)
                .Set(s => s.UpdatedAt, DateTime.UtcNow),
            cancellationToken: CancellationToken.None);
        if (string.IsNullOrEmpty(store.PrimaryEntryId))
            store.PrimaryEntryId = entryId;
    }

    private async Task<DownloadedVideoMaterial> DownloadVideoMaterialAsync(ParsedShortVideoSource parsed, string originalUrl)
    {
        var videoUrl = FirstNonEmpty(parsed.VideoUrl, originalUrl);
        if (string.IsNullOrWhiteSpace(videoUrl))
            throw new InvalidOperationException("短视频解析器未返回可下载的视频地址");

        var node = new WorkflowNode
        {
            NodeId = "short-video-download",
            Name = "短视频下载",
            NodeType = CapsuleTypes.VideoDownloader,
            Config = new Dictionary<string, object?>
            {
                ["videoUrl"] = videoUrl,
                ["timeoutSeconds"] = 180,
            },
        };
        var result = await CapsuleExecutor.ExecuteVideoDownloaderAsync(
            _serviceProvider,
            node,
            new Dictionary<string, string>(),
            new List<ExecutionArtifact>());
        return ExtractDownloadedVideo(result.Artifacts.FirstOrDefault()?.InlineContent);
    }

    private async Task<VideoTranscriptionAttempt> TryTranscribeVideoAsync(string videoUrl, string title)
    {
        try
        {
            var node = new WorkflowNode
            {
                NodeId = "short-video-asr",
                Name = "视频转文字",
                NodeType = CapsuleTypes.VideoToText,
                Config = new Dictionary<string, object?>
                {
                    ["extractMode"] = "asr",
                    ["videoUrlField"] = "videoUrl",
                    ["enableHookExtraction"] = false,
                    ["maxItems"] = 1,
                },
            };
            var input = JsonSerializer.Serialize(new { title, videoUrl });
            var result = await CapsuleExecutor.ExecuteVideoToTextAsync(
                _serviceProvider,
                node,
                new Dictionary<string, string>(),
                new List<ExecutionArtifact>
                {
                    new()
                    {
                        SlotId = "vt-in",
                        Name = "已入库视频",
                        MimeType = "application/json",
                        InlineContent = input,
                    },
                },
                null);
            var text = ExtractTranscript(result.Artifacts.FirstOrDefault()?.InlineContent);
            return string.IsNullOrWhiteSpace(text)
                ? new VideoTranscriptionAttempt(null, "ASR 模型未返回可用文字")
                : new VideoTranscriptionAttempt(text, null);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "短视频 ASR 转写失败 videoUrl={VideoUrl}", videoUrl);
            return new VideoTranscriptionAttempt(null, SimplifyTranscriptionError(ex.Message));
        }
    }

    private static string SimplifyTranscriptionError(string message)
    {
        if (string.IsNullOrWhiteSpace(message)) return "ASR 服务不可用";
        if (message.Contains("无法解密") || message.Contains("decrypt", StringComparison.OrdinalIgnoreCase))
            return "ASR 模型凭据不可用";
        if (message.Contains("Gateway ASR 调用失败"))
            return "ASR 模型调用失败";
        if (message.Contains("模型调度失败"))
            return "ASR 模型调度失败";
        return message.Length > 120 ? message[..120] : message;
    }

    private static DownloadedVideoMaterial ExtractDownloadedVideo(string? json)
    {
        if (string.IsNullOrWhiteSpace(json))
            throw new InvalidOperationException("视频下载器未返回入库地址");
        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            var url = GetJsonString(root, "cosUrl", "url");
            if (string.IsNullOrWhiteSpace(url))
                throw new InvalidOperationException("视频下载器未返回入库地址");
            var sizeRaw = GetJsonString(root, "fileSize", "size");
            long.TryParse(sizeRaw, out var fileSize);
            return new DownloadedVideoMaterial(
                url,
                GetJsonString(root, "mimeType") ?? "video/mp4",
                fileSize,
                GetJsonString(root, "sha256"));
        }
        catch (JsonException ex)
        {
            throw new InvalidOperationException($"视频下载器返回格式错误: {ex.Message}");
        }
    }

    private static string BuildVideoFileName(string title)
    {
        var safe = Regex.Replace(title.Trim(), @"[\\/:*?""<>|\r\n]+", " ");
        safe = Regex.Replace(safe, @"\s+", " ").Trim();
        if (string.IsNullOrWhiteSpace(safe)) safe = "短视频素材";
        if (safe.Length > 60) safe = safe[..60].Trim();
        return $"{safe}.mp4";
    }

    private static string BuildVideoIndex(string title, string originalUrl, string platform, ParsedShortVideoSource parsed)
    {
        var sb = new StringBuilder();
        sb.AppendLine(title);
        sb.AppendLine($"来源平台：{platform}");
        sb.AppendLine($"原始链接：{originalUrl}");
        sb.AppendLine("素材类型：原始短视频文件");
        if (!string.IsNullOrWhiteSpace(parsed.Title) && parsed.Title != title)
            sb.AppendLine($"解析标题：{parsed.Title}");
        return sb.ToString();
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
            Description = "保存短视频原始视频、真实转写文字与后续加工资产",
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
        await IncrementStoreDocumentCountAsync(store, entry.Id);
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
            Stage("source", "保存原始视频", "pending", "等待链接解析完成"),
            Stage("transcript", "视频转文字", "pending", "等待原始视频保存完成"),
            Stage("ready", "准备继续加工", "pending", "等待入库产物就绪"),
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
                hasManualText ? "已使用用户提供的文字作为后续加工来源" : "TikHub API 密钥未配置，无法解析真实视频文件地址",
                null,
                null,
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

            var source = hasManualText ? trimmedManual : null;
            var mode = hasManualText ? "manual" : "tikhub-video";
            var message = mode switch
            {
                "manual" => "已解析到视频元数据，并使用用户提供的文字作为后续加工来源",
                _ => "已解析到视频文件地址；默认先保存原始视频，再从视频执行真实转写",
            };
            return new ParsedShortVideoSource(metadata.Title, source, mode, message, metadataJson, metadata.VideoUrl, metadata.CoverUrl);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "短视频解析器降级 videoUrl={VideoUrl}", videoUrl);
            return new ParsedShortVideoSource(
                CleanTitle(requestedTitle),
                trimmedManual,
                hasManualText ? "manual" : "metadata-fallback",
                hasManualText ? "短视频解析器暂不可用，已使用用户提供的文字作为后续加工来源" : "短视频解析器暂不可用，无法解析真实视频文件地址",
                null,
                null,
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
        if (string.IsNullOrWhiteSpace(json)) return new ParsedVideoMetadata(null, null, null);
        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            return new ParsedVideoMetadata(
                GetJsonString(root, "title", "desc", "description"),
                GetJsonString(root, "videoUrl", "video_url", "play_addr", "nwm_video_url"),
                GetJsonString(root, "coverUrl", "cover_url", "cover", "origin_cover"));
        }
        catch
        {
            return new ParsedVideoMetadata(null, null, null);
        }
    }

    private static string? ExtractTranscript(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return null;
        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            var direct = GetJsonString(root, "transcript");
            if (!string.IsNullOrWhiteSpace(direct)) return direct.Trim();
            if (root.TryGetProperty("firstItem", out var firstItem) && firstItem.ValueKind == JsonValueKind.Object)
            {
                var firstText = GetJsonString(firstItem, "transcript");
                if (!string.IsNullOrWhiteSpace(firstText)) return firstText.Trim();
            }
            if (root.TryGetProperty("items", out var items) && items.ValueKind == JsonValueKind.Array)
            {
                var transcripts = items
                    .EnumerateArray()
                    .Select(item => item.ValueKind == JsonValueKind.Object ? GetJsonString(item, "transcript") : null)
                    .Where(text => !string.IsNullOrWhiteSpace(text))
                    .Select(text => text!.Trim())
                    .ToList();
                if (transcripts.Count > 0) return string.Join("\n", transcripts);
            }
            return null;
        }
        catch
        {
            return null;
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

    private static string BuildTranscriptMarkdown(string title, string videoUrl, string platform, string transcriptText)
    {
        var sb = new StringBuilder();
        sb.AppendLine($"# {title} · 原始转写文字");
        sb.AppendLine();
        sb.AppendLine($"> 来源平台：{platform}");
        sb.AppendLine($"> 原始链接：{videoUrl}");
        sb.AppendLine($"> 生成方式：视频 ASR 转写");
        sb.AppendLine();
        sb.AppendLine("## 原始文字");
        sb.AppendLine();
        sb.AppendLine(transcriptText);
        sb.AppendLine();
        sb.AppendLine("## 后续加工建议");
        sb.AppendLine();
        sb.AppendLine("- 选中本条目点击「智能体」，加工成文案、教程、脚本、课程大纲或网页草稿。");
        sb.AppendLine("- 对具体段落做划词编辑、补充说明或生成配图。");
        sb.AppendLine("- 需要时间线时，再基于这份原始文字生成时间线片段。");
        return sb.ToString();
    }

    private static string SourceModeLabel(string sourceMode) => sourceMode switch
    {
        "manual" => "用户提供文字",
        "tikhub-video" => "短视频解析器视频地址",
        "asr" => "视频 ASR 转写",
        _ => "链接元数据兜底",
    };

    private sealed record ParsedShortVideoSource(string? Title, string? SourceText, string SourceMode, string Message, string? MetadataJson, string? VideoUrl, string? CoverUrl);
    private sealed record ParsedVideoMetadata(string? Title, string? VideoUrl, string? CoverUrl);
    private sealed record DownloadedVideoMaterial(string Url, string MimeType, long FileSize, string? Sha256);
    private sealed record VideoTranscriptionAttempt(string? Text, string? ErrorMessage);
}
