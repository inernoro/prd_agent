using System.Text.Json;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;

namespace PrdAgent.Api.Services;

/// <summary>
/// 音视频转录后台 Worker
/// 处理两种任务：ASR 语音转写、模板转文案
/// 遵循服务器权威性设计：核心处理使用 CancellationToken.None
/// </summary>
public class TranscriptRunWorker : BackgroundService
{
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly ILogger<TranscriptRunWorker> _logger;

    public TranscriptRunWorker(IServiceScopeFactory scopeFactory, ILogger<TranscriptRunWorker> logger)
    {
        _scopeFactory = scopeFactory;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _logger.LogInformation("[transcript-agent] Worker started");

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await ProcessNextRunAsync();
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "[transcript-agent] Worker loop error");
            }

            await Task.Delay(3000, stoppingToken);
        }
    }

    private async Task ProcessNextRunAsync()
    {
        using var scope = _scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MongoDbContext>();
        var gateway = scope.ServiceProvider.GetRequiredService<ILlmGateway>();

        // 原子认领一个 queued 任务
        var run = await db.TranscriptRuns.FindOneAndUpdateAsync(
            r => r.Status == "queued",
            Builders<TranscriptRun>.Update
                .Set(r => r.Status, "processing")
                .Set(r => r.UpdatedAt, DateTime.UtcNow),
            new FindOneAndUpdateOptions<TranscriptRun> { ReturnDocument = ReturnDocument.After });

        if (run == null) return;

        _logger.LogInformation("[transcript-agent] Processing run {RunId}, type={Type}", run.Id, run.Type);

        try
        {
            if (run.Type == "asr")
                await ProcessAsrAsync(db, gateway, run);
            else if (run.Type == "copywrite")
                await ProcessCopywriteAsync(db, gateway, run);

            await db.TranscriptRuns.UpdateOneAsync(
                r => r.Id == run.Id,
                Builders<TranscriptRun>.Update
                    .Set(r => r.Status, "completed")
                    .Set(r => r.Progress, 100)
                    .Set(r => r.UpdatedAt, DateTime.UtcNow));

            _logger.LogInformation("[transcript-agent] Run {RunId} completed", run.Id);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[transcript-agent] Run {RunId} failed", run.Id);

            await db.TranscriptRuns.UpdateOneAsync(
                r => r.Id == run.Id,
                Builders<TranscriptRun>.Update
                    .Set(r => r.Status, "failed")
                    .Set(r => r.Error, ex.Message)
                    .Set(r => r.UpdatedAt, DateTime.UtcNow));
        }
    }

    // ═══════════════════════════════════════════════════════════
    // ASR 转写（复用 VideoToDocRunWorker 的 Whisper 调用模式）
    // ═══════════════════════════════════════════════════════════

    private async Task ProcessAsrAsync(MongoDbContext db, ILlmGateway gateway, TranscriptRun run)
    {
        var item = await db.TranscriptItems.Find(i => i.Id == run.ItemId).FirstOrDefaultAsync();
        if (item == null) throw new InvalidOperationException($"Item {run.ItemId} not found");

        // 更新进度：下载文件
        await UpdateProgress(db, run.Id, 10);
        await db.TranscriptItems.UpdateOneAsync(
            i => i.Id == item.Id,
            Builders<TranscriptItem>.Update.Set(i => i.TranscribeStatus, "processing"));

        // 下载音频文件
        using var httpClient = new HttpClient();
        var audioBytes = await httpClient.GetByteArrayAsync(item.FileUrl);

        // 更新进度：开始转写
        await UpdateProgress(db, run.Id, 30);

        // 调用 ASR 模型池（与 VideoToDocRunWorker 相同模式）
        var rawRequest = new GatewayRawRequest
        {
            AppCallerCode = AppCallerRegistry.TranscriptAgent.Transcribe.Audio,
            ModelType = ModelTypes.Asr,
            EndpointPath = "/v1/audio/transcriptions",
            MultipartFields = new Dictionary<string, object>
            {
                ["model"] = "whisper-1",
                ["response_format"] = "verbose_json",
                ["timestamp_granularities[]"] = "segment",
                ["language"] = ""
            },
            MultipartFiles = new Dictionary<string, (string FileName, byte[] Content, string MimeType)>
            {
                ["file"] = (item.FileName, audioBytes, item.MimeType)
            },
            TimeoutSeconds = 600
        };

        await UpdateProgress(db, run.Id, 50);

        var rawResp = await gateway.SendRawAsync(rawRequest, CancellationToken.None);

        if (rawResp?.Success != true || rawResp.Content == null)
        {
            throw new InvalidOperationException($"ASR 转写失败: {rawResp?.Error ?? "无响应"}");
        }

        await UpdateProgress(db, run.Id, 80);

        // 解析 Whisper 响应
        var (segments, _) = ParseWhisperResponse(rawResp.Content);

        // 保存转写结果到 Item
        await db.TranscriptItems.UpdateOneAsync(
            i => i.Id == item.Id,
            Builders<TranscriptItem>.Update
                .Set(i => i.Segments, segments)
                .Set(i => i.TranscribeStatus, "completed")
                .Set(i => i.UpdatedAt, DateTime.UtcNow));
    }

    // ═══════════════════════════════════════════════════════════
    // 模板转文案（通过 LLM Gateway Chat 模型）
    // ═══════════════════════════════════════════════════════════

    private async Task ProcessCopywriteAsync(MongoDbContext db, ILlmGateway gateway, TranscriptRun run)
    {
        var item = await db.TranscriptItems.Find(i => i.Id == run.ItemId).FirstOrDefaultAsync();
        if (item?.Segments == null || item.Segments.Count == 0)
            throw new InvalidOperationException("素材未完成转写");

        // 获取模板
        TranscriptTemplate? template = null;
        if (!string.IsNullOrEmpty(run.TemplateId))
        {
            template = await db.TranscriptTemplates.Find(t => t.Id == run.TemplateId).FirstOrDefaultAsync();
        }

        var transcriptText = string.Join("\n",
            item.Segments.Select(s => $"[{TimeSpan.FromSeconds(s.Start):hh\\:mm\\:ss}] {s.Text}"));

        var systemPrompt = template?.Prompt ?? "你是一个专业的内容编辑。请将以下带时间戳的转写文本整理成结构清晰的文案。保留关键信息，去除口语化表达和重复内容。";

        await UpdateProgress(db, run.Id, 30);

        var request = new GatewayRequest
        {
            AppCallerCode = AppCallerRegistry.TranscriptAgent.Copywrite.Generate,
            ModelType = ModelTypes.Chat,
            SystemPrompt = systemPrompt,
            UserMessage = $"以下是需要整理的转写文本：\n\n{transcriptText}",
            MaxTokens = 4096
        };

        await UpdateProgress(db, run.Id, 50);

        var resp = await gateway.SendAsync(request, CancellationToken.None);

        if (resp?.Success != true)
            throw new InvalidOperationException($"文案生成失败: {resp?.Error ?? "无响应"}");

        await UpdateProgress(db, run.Id, 90);

        await db.TranscriptRuns.UpdateOneAsync(
            r => r.Id == run.Id,
            Builders<TranscriptRun>.Update.Set(r => r.Result, resp.Content));
    }

    // ═══════════════════════════════════════════════════════════
    // 工具方法
    // ═══════════════════════════════════════════════════════════

    private (List<TranscriptSegment> segments, string language) ParseWhisperResponse(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;

            var lang = root.TryGetProperty("language", out var langProp) ? langProp.GetString() ?? "unknown" : "unknown";
            var segments = new List<TranscriptSegment>();

            if (root.TryGetProperty("segments", out var segsArr))
            {
                foreach (var seg in segsArr.EnumerateArray())
                {
                    segments.Add(new TranscriptSegment
                    {
                        Start = seg.TryGetProperty("start", out var s) ? s.GetDouble() : 0,
                        End = seg.TryGetProperty("end", out var e) ? e.GetDouble() : 0,
                        Text = (seg.TryGetProperty("text", out var t) ? t.GetString() : "") ?? ""
                    });
                }
            }

            return (segments, lang);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[transcript-agent] 解析 Whisper 响应失败");
            return (new List<TranscriptSegment>(), "unknown");
        }
    }

    private static async Task UpdateProgress(MongoDbContext db, string runId, int progress)
    {
        await db.TranscriptRuns.UpdateOneAsync(
            r => r.Id == runId,
            Builders<TranscriptRun>.Update
                .Set(r => r.Progress, progress)
                .Set(r => r.UpdatedAt, DateTime.UtcNow));
    }
}
