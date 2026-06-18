using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Configuration;
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

        var loopCount = 0;
        try
        {
            while (!stoppingToken.IsCancellationRequested)
            {
                try
                {
                    await ProcessNextRunAsync();
                    // 每约 60s 扫一次"卡死的 running"——RecoverRunningRunsAsync 只在启动时跑一次，
                    // 不重启就永远不回收。没有这道周期性兜底，任何因竞态/中途部署/默认值落进 running
                    // 却没人处理的 run 会永远卡在"处理中"，用户侧表现为"加了链接半天没反应"。
                    if (loopCount % 30 == 0) await RecoverStaleRunningRunsAsync();
                    loopCount++;
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
            // 回收范围 = 本实例 running + 历史无主 running（OwnerInstanceId 空）。
            // 无主 running 只可能由「定向消费上线前的旧代码」产生：旧代码不打 owner，
            // 容器退出后永远没人回收、永卡 running。一并回收是一次性过渡兜底（上线后新 run
            // 认领即打主，不再产生无主 running）。代价：若另一实例此刻在跑某个无主 running 会被
            // 误判失败——但无主 = 旧代码遗留，归属本不可分辨，过渡期代价可接受（Bugbot Medium）。
            var instanceId = InstanceIdentity.Get(scope.ServiceProvider.GetRequiredService<IConfiguration>());
            var recoverFilter = Builders<ShortVideoMaterialRun>.Filter.And(
                Builders<ShortVideoMaterialRun>.Filter.Eq(r => r.Status, "running"),
                Builders<ShortVideoMaterialRun>.Filter.Or(
                    Builders<ShortVideoMaterialRun>.Filter.Eq(r => r.OwnerInstanceId, instanceId),
                    Builders<ShortVideoMaterialRun>.Filter.Eq(r => r.OwnerInstanceId, (string?)null),
                    Builders<ShortVideoMaterialRun>.Filter.Eq(r => r.OwnerInstanceId, "")));
            var recovered = await db.ShortVideoMaterialRuns.UpdateManyAsync(
                recoverFilter,
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

    /// <summary>
    /// 周期性兜底：把"卡死的 running"标记为失败，让前端自愈成"解析失败，可重试"。
    /// 判定 = status==running 且 updatedAt 超过阈值未推进（每个 stage 推进都会刷新 updatedAt，
    /// 正常处理不会触发；阈值取 15 分钟，长于 ASR 600s 超时 + 下载余量，避免误杀在跑的任务），
    /// 且不是本实例当前正在处理的那个，归属本实例（或历史无主）。根治"加了链接半天没反应"。
    /// </summary>
    private async Task RecoverStaleRunningRunsAsync()
    {
        try
        {
            using var scope = _scopeFactory.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<MongoDbContext>();
            var instanceId = InstanceIdentity.Get(scope.ServiceProvider.GetRequiredService<IConfiguration>());
            var cutoff = DateTime.UtcNow - TimeSpan.FromMinutes(15);
            var current = _currentRunId ?? "";
            var filter = Builders<ShortVideoMaterialRun>.Filter.And(
                Builders<ShortVideoMaterialRun>.Filter.Eq(r => r.Status, "running"),
                Builders<ShortVideoMaterialRun>.Filter.Lt(r => r.UpdatedAt, cutoff),
                Builders<ShortVideoMaterialRun>.Filter.Ne(r => r.Id, current),
                Builders<ShortVideoMaterialRun>.Filter.Or(
                    Builders<ShortVideoMaterialRun>.Filter.Eq(r => r.OwnerInstanceId, instanceId),
                    Builders<ShortVideoMaterialRun>.Filter.Eq(r => r.OwnerInstanceId, (string?)null),
                    Builders<ShortVideoMaterialRun>.Filter.Eq(r => r.OwnerInstanceId, "")));
            var res = await db.ShortVideoMaterialRuns.UpdateManyAsync(
                filter,
                Builders<ShortVideoMaterialRun>.Update
                    .Set(r => r.Status, "failed")
                    .Set(r => r.ErrorMessage, "处理超时或中断，请重试")
                    .Set(r => r.UpdatedAt, DateTime.UtcNow),
                cancellationToken: CancellationToken.None);
            if (res.ModifiedCount > 0)
                _logger.LogWarning("[short-video-material] 周期兜底：{Count} 个卡死 running run 标记为失败", res.ModifiedCount);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[short-video-material] 周期兜底回收失败");
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

        // 定向消费：只领取属于本实例（或历史无主）的 queued 任务，避免共享 Mongo 下多容器互抢。
        var instanceId = InstanceIdentity.Get(scope.ServiceProvider.GetRequiredService<IConfiguration>());
        var run = await db.ShortVideoMaterialRuns.FindOneAndUpdateAsync(
            Builders<ShortVideoMaterialRun>.Filter.And(
                Builders<ShortVideoMaterialRun>.Filter.Eq(r => r.Status, "queued"),
                Builders<ShortVideoMaterialRun>.Filter.Or(
                    Builders<ShortVideoMaterialRun>.Filter.Eq(r => r.OwnerInstanceId, instanceId),
                    Builders<ShortVideoMaterialRun>.Filter.Eq(r => r.OwnerInstanceId, (string?)null),
                    Builders<ShortVideoMaterialRun>.Filter.Eq(r => r.OwnerInstanceId, ""))),
            Builders<ShortVideoMaterialRun>.Update
                .Set(r => r.Status, "running")
                // 认领时盖上本实例归属（领取历史无主任务后必须打主，否则崩溃重启兜底匹配不到、永卡 running，Bugbot Medium）
                .Set(r => r.OwnerInstanceId, instanceId)
                .Set(r => r.UpdatedAt, DateTime.UtcNow),
            new FindOneAndUpdateOptions<ShortVideoMaterialRun>
            {
                Sort = Builders<ShortVideoMaterialRun>.Sort.Ascending(r => r.CreatedAt),
                ReturnDocument = ReturnDocument.After,
            },
            cancellationToken: CancellationToken.None);
        if (run == null) return;

        _currentRunId = run.Id;
        _logger.LogWarning("[svm-diag] claimed run={RunId} owner={Owner}", run.Id, run.OwnerInstanceId);
        try
        {
            // 硬性单任务超时:即便某步意外挂死(连接池耗尽/未设超时的外部调用),也在 16 分钟后
            // 抛出让本 run 失败并释放 worker,绝不让单个任务永久占住单线程 worker 饿死后续任务。
            // 16min 略高于各步超时之和(resolve 30s + 下载 180s + ASR 600s ≈ 13.5min),不误杀正常长任务。
            using var procCts = new CancellationTokenSource(TimeSpan.FromMinutes(16));
            await processor.ProcessAsync(run.Id).WaitAsync(procCts.Token);
            _logger.LogWarning("[svm-diag] ProcessAsync returned run={RunId}", run.Id);
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
        _logger.LogWarning("[svm-diag] ProcessAsync enter run={RunId}", runId);
        var run = await _db.ShortVideoMaterialRuns.Find(r => r.Id == runId).FirstOrDefaultAsync(CancellationToken.None)
                  ?? throw new InvalidOperationException("短视频解析运行记录不存在");
        _logger.LogWarning("[svm-diag] loaded run run={RunId}", runId);
        var user = await _db.Users.Find(u => u.UserId == run.UserId).FirstOrDefaultAsync(CancellationToken.None);
        var userName = string.IsNullOrWhiteSpace(user?.DisplayName) ? user?.Username ?? run.UserId : user.DisplayName!;
        var now = DateTime.UtcNow;
        _logger.LogWarning("[svm-diag] loaded user, marking parse running run={RunId}", runId);

        // 进入解析就把 parse 标成 running 并落库：一是让前端立刻看到"正在解析"而不是僵在 pending
        // （否则用户感觉"一点反应都没有"），二是刷新 updatedAt 作为心跳，配合周期兜底判活。
        MarkStage(run, "parse", "running", "正在解析短视频链接…");
        await SaveRunAsync(run);
        _logger.LogWarning("[svm-diag] parse heartbeat saved, resolving run={RunId}", runId);

        var parsed = await ResolveParsedSourceAsync(run.VideoUrl, run.Platform, run.InputSourceText, run.RequestedTitle);
        _logger.LogWarning("[svm-diag] resolve done mode={Mode} run={RunId}", parsed.SourceMode, runId);
        var title = CleanTitle(run.RequestedTitle) ?? CleanTitle(parsed.Title) ?? run.Title;
        run.Title = title;
        run.SourceMode = parsed.SourceMode;
        run.ParsedMetadataJson = parsed.MetadataJson;
        run.ParserMessage = parsed.Message;
        run.Card = BuildShortVideoCard(parsed.MetadataJson, title, run.Platform, parsed.CoverUrl);
        MarkStage(run, "parse", "done", parsed.Message);
        await SaveRunAsync(run);

        var store = await ResolveStoreAsync(run.StoreId, run.UserId);
        run.StoreId = store.Id;
        MarkStage(run, "source", "running", $"正在把视频文件保存到知识库「{store.Name}」");
        await SaveRunAsync(run);

        var videoMaterial = await DownloadVideoMaterialAsync(parsed);
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
        run.SourceVideoUrl = videoMaterial.Url;
        if (run.Card != null)
            run.Card.VideoUrl = videoMaterial.Url; // 入库后改用 COS 永久地址播放
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

    private async Task<DownloadedVideoMaterial> DownloadVideoMaterialAsync(ParsedShortVideoSource parsed)
    {
        var videoUrl = RequireResolvedVideoUrl(parsed.VideoUrl);

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

    /// <summary>
    /// 从短视频解析器返回的原始元数据中抽取一张干净的展示卡片。
    /// 解析器把 author/statistics/hashtags 透传成了嵌套 JSON 字符串，这里集中解开，
    /// 让前端直接渲染（遵循「业务数据描述由后端维护」原则）。
    /// </summary>
    private static ShortVideoCard BuildShortVideoCard(string? metadataJson, string title, string platform, string? coverUrlFallback)
    {
        var card = new ShortVideoCard
        {
            Title = title,
            Platform = platform,
            CoverUrl = coverUrlFallback,
        };
        if (string.IsNullOrWhiteSpace(metadataJson)) return card;
        try
        {
            using var doc = JsonDocument.Parse(metadataJson);
            var root = doc.RootElement;

            var cover = GetJsonString(root, "coverUrl", "cover_url", "cover", "origin_cover");
            if (!string.IsNullOrWhiteSpace(cover)) card.CoverUrl = cover;

            // 时长：不同平台透传的单位不一致——有的是毫秒，有的已是秒。用 >=1000 阈值区分：
            // 短视频秒数通常 < 1000（约 16 分钟），毫秒数 >=1000（1s=1000ms）。否则把 45（秒）
            // 当毫秒会算成 0、把已是秒的值再除 1000 显示过短（Bugbot Medium）。
            var durationRaw = GetJsonString(root, "duration", "video_duration");
            if (long.TryParse(durationRaw, out var durVal) && durVal > 0)
                card.DurationSec = durVal >= 1000
                    ? (int)Math.Round(durVal / 1000.0)  // 毫秒 → 秒
                    : (int)durVal;                       // 已是秒

            // author 可能是昵称字符串，也可能是被透传成字符串的嵌套对象
            var authorEl = ResolveMaybeNestedJson(root, "author");
            if (authorEl is { ValueKind: JsonValueKind.Object } ao)
            {
                card.AuthorName = GetJsonString(ao, "nickname", "name", "unique_id");
                card.AuthorAvatarUrl = ExtractFirstUrl(ao, "avatar_thumb", "avatar_medium", "avatar_larger", "avatar_168x168", "avatar_300x300");
            }
            else
            {
                var authorName = GetJsonString(root, "author", "author_name", "nickname");
                if (!string.IsNullOrWhiteSpace(authorName) && !authorName.TrimStart().StartsWith("{"))
                    card.AuthorName = authorName;
            }

            // statistics 同理
            var statsEl = ResolveMaybeNestedJson(root, "statistics", "stats");
            if (statsEl is { ValueKind: JsonValueKind.Object } so)
            {
                card.LikeCount = GetJsonLong(so, "digg_count", "like_count", "likes");
                card.CommentCount = GetJsonLong(so, "comment_count", "comments");
                card.ShareCount = GetJsonLong(so, "share_count", "shares");
                card.CollectCount = GetJsonLong(so, "collect_count", "favourite_count", "collects");
                card.PlayCount = GetJsonLong(so, "play_count", "view_count", "plays");
            }

            // hashtags：数组，每项含 hashtag_name
            var tagsEl = ResolveMaybeNestedJson(root, "hashtags", "text_extra");
            if (tagsEl is { ValueKind: JsonValueKind.Array } ta)
            {
                foreach (var t in ta.EnumerateArray())
                {
                    var name = t.ValueKind == JsonValueKind.String
                        ? t.GetString()
                        : GetJsonString(t, "hashtag_name", "name", "caption");
                    name = name?.TrimStart('#').Trim();
                    if (!string.IsNullOrWhiteSpace(name) && !card.Hashtags.Contains(name))
                        card.Hashtags.Add(name);
                    if (card.Hashtags.Count >= 8) break;
                }
            }
        }
        catch
        {
            // 抽取失败不影响主流程，卡片至少有封面 + 标题
        }
        return card;
    }

    /// <summary>读取某字段；若它被透传成了 JSON 字符串则二次 Parse 还原为对象/数组。</summary>
    private static JsonElement? ResolveMaybeNestedJson(JsonElement root, params string[] names)
    {
        foreach (var name in names)
        {
            if (!root.TryGetProperty(name, out var el)) continue;
            if (el.ValueKind is JsonValueKind.Object or JsonValueKind.Array) return el;
            if (el.ValueKind == JsonValueKind.String)
            {
                var s = el.GetString();
                if (!string.IsNullOrWhiteSpace(s) && (s.TrimStart().StartsWith("{") || s.TrimStart().StartsWith("[")))
                {
                    try
                    {
                        using var nested = JsonDocument.Parse(s);
                        return nested.RootElement.Clone();
                    }
                    catch { /* ignore */ }
                }
            }
        }
        return null;
    }

    private static string? ExtractFirstUrl(JsonElement obj, params string[] imageFieldNames)
    {
        foreach (var f in imageFieldNames)
        {
            if (!obj.TryGetProperty(f, out var img) || img.ValueKind != JsonValueKind.Object) continue;
            if (img.TryGetProperty("url_list", out var ul) && ul.ValueKind == JsonValueKind.Array)
            {
                foreach (var u in ul.EnumerateArray())
                {
                    var s = u.GetString();
                    if (!string.IsNullOrWhiteSpace(s)) return s;
                }
            }
        }
        return null;
    }

    private static long? GetJsonLong(JsonElement obj, params string[] names)
    {
        foreach (var n in names)
        {
            if (!obj.TryGetProperty(n, out var el)) continue;
            if (el.ValueKind == JsonValueKind.Number && el.TryGetInt64(out var v)) return v;
            if (el.ValueKind == JsonValueKind.String && long.TryParse(el.GetString(), out var sv)) return sv;
        }
        return null;
    }

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

    internal static string RequireResolvedVideoUrl(string? parsedVideoUrl)
    {
        var videoUrl = parsedVideoUrl?.Trim();
        if (string.IsNullOrWhiteSpace(videoUrl))
            throw new InvalidOperationException("短视频解析器未返回可下载的视频文件地址，已停止保存原始视频，避免把分享页当作视频入库");
        if (!Uri.TryCreate(videoUrl, UriKind.Absolute, out var uri) ||
            (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
            throw new InvalidOperationException("短视频解析器返回的视频文件地址无效，已停止保存原始视频");
        return videoUrl;
    }

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
