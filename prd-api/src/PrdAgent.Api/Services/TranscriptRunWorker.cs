using System.Text.Json;
using System.Text.Json.Nodes;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Core.Helpers;

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
        var filter = Builders<TranscriptRun>.Filter.Eq(r => r.Status, "queued");
        var update = Builders<TranscriptRun>.Update
            .Set(r => r.Status, "processing")
            .Set(r => r.UpdatedAt, DateTime.UtcNow);
        var options = new FindOneAndUpdateOptions<TranscriptRun, TranscriptRun>
        {
            ReturnDocument = ReturnDocument.After
        };
        var run = await db.TranscriptRuns.FindOneAndUpdateAsync(filter, update, options);

        if (run == null) return;

        _logger.LogInformation("[transcript-agent] Processing run {RunId}, type={Type}", run.Id, run.Type);

        try
        {
            if (run.Type == "asr")
                await ProcessAsrAsync(db, gateway, run);
            else if (run.Type == "copywrite")
                await ProcessCopywriteAsync(db, gateway, run);

            await db.TranscriptRuns.UpdateOneAsync(
                Builders<TranscriptRun>.Filter.Eq(r => r.Id, run.Id),
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
                Builders<TranscriptRun>.Filter.Eq(r => r.Id, run.Id),
                Builders<TranscriptRun>.Update
                    .Set(r => r.Status, "failed")
                    .Set(r => r.Error, ex.Message)
                    .Set(r => r.UpdatedAt, DateTime.UtcNow));

            // ASR 失败时同步更新 Item 状态
            if (run.Type == "asr")
            {
                await db.TranscriptItems.UpdateOneAsync(
                    Builders<TranscriptItem>.Filter.Eq(i => i.Id, run.ItemId),
                    Builders<TranscriptItem>.Update
                        .Set(i => i.TranscribeStatus, "failed")
                        .Set(i => i.TranscribeError, ex.Message));
            }
        }
    }

    // ═══════════════════════════════════════════════════════════
    // ASR 转写（复用 VideoToDocRunWorker 的 Whisper 调用模式）
    // ═══════════════════════════════════════════════════════════

    private async Task ProcessAsrAsync(MongoDbContext db, ILlmGateway gateway, TranscriptRun run)
    {
        using var scope2 = _scopeFactory.CreateScope();
        var modelResolver = scope2.ServiceProvider.GetRequiredService<IModelResolver>();

        var item = await db.TranscriptItems.Find(
            Builders<TranscriptItem>.Filter.Eq(i => i.Id, run.ItemId)).FirstOrDefaultAsync();
        if (item == null) throw new InvalidOperationException($"Item {run.ItemId} not found");

        // 更新进度：开始处理
        await UpdateProgress(db, run.Id, 10);
        await db.TranscriptItems.UpdateOneAsync(
            Builders<TranscriptItem>.Filter.Eq(i => i.Id, item.Id),
            Builders<TranscriptItem>.Update.Set(i => i.TranscribeStatus, "processing"));

        // 预解析模型，判断走哪条 ASR 路径
        var resolution = await modelResolver.ResolveAsync(
            AppCallerRegistry.TranscriptAgent.Transcribe.Audio, ModelTypes.Asr);

        if (!resolution.Success)
            throw new InvalidOperationException($"ASR 模型调度失败: {resolution.ErrorMessage}");

        // 根据 Exchange 转换器类型选择 ASR 路径
        if (resolution.IsExchange && resolution.ExchangeTransformerType == "doubao-asr-stream")
        {
            await ProcessAsrViaStreamAsync(db, run, item, resolution);
        }
        else
        {
            await ProcessAsrViaGatewayAsync(db, gateway, run, item);
        }
    }

    /// <summary>
    /// 通过 DoubaoStreamAsrService（WebSocket 流式）处理 ASR
    /// </summary>
    private async Task ProcessAsrViaStreamAsync(
        MongoDbContext db, TranscriptRun run, TranscriptItem item,
        ModelResolutionResult resolution)
    {
        _logger.LogInformation("[transcript-agent] 使用流式 ASR 路径: Exchange={ExchangeName}", resolution.ExchangeName);

        // 下载音频文件
        using var httpClient = new HttpClient();
        httpClient.Timeout = TimeSpan.FromSeconds(120);
        var audioBytes = await httpClient.GetByteArrayAsync(item.FileUrl);
        await UpdateProgress(db, run.Id, 30);

        // 解析 API Key
        var apiKey = resolution.ApiKey ?? "";
        string appKey = "", accessKey = apiKey;
        if (apiKey.Contains('|'))
        {
            var parts = apiKey.Split('|', 2);
            appKey = parts[0];
            accessKey = parts[1];
        }

        var wsUrl = resolution.ApiUrl ?? "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream";
        var config = resolution.ExchangeTransformerConfig ?? new Dictionary<string, object>
        {
            ["resourceId"] = "volc.bigasr.sauc.duration",
            ["enableItn"] = true,
            ["enablePunc"] = true,
            ["enableDdc"] = true
        };

        await UpdateProgress(db, run.Id, 50);

        // 调用 DoubaoStreamAsrService
        using var scope3 = _scopeFactory.CreateScope();
        var streamAsr = scope3.ServiceProvider.GetRequiredService<DoubaoStreamAsrService>();

        var result = await streamAsr.TranscribeWithCallbackAsync(
            wsUrl, appKey, accessKey, audioBytes, config,
            onStage: async (stage, msg) =>
            {
                _logger.LogInformation("[transcript-agent] StreamASR stage: {Stage} - {Msg}", stage, msg);
                await Task.CompletedTask;
            },
            onProgress: async (sent, total) =>
            {
                var pct = 50 + (int)(30.0 * sent / Math.Max(total, 1));
                await UpdateProgress(db, run.Id, Math.Min(pct, 80));
            },
            onFrame: null,
            ct: CancellationToken.None);

        if (!result.Success)
            throw new InvalidOperationException($"流式 ASR 转写失败: {result.Error}");

        await UpdateProgress(db, run.Id, 80);

        // 将流式结果转为 TranscriptSegment
        var segments = result.Segments.Select(s => new TranscriptSegment
        {
            Start = 0,
            End = s.DurationSec,
            Text = s.Text
        }).ToList();

        // 如果只有一个 segment 且包含完整文本，作为单段处理
        if (segments.Count == 0 && !string.IsNullOrEmpty(result.FullText))
        {
            segments.Add(new TranscriptSegment { Start = 0, End = 0, Text = result.FullText });
        }

        _logger.LogInformation("[transcript-agent] 流式 ASR 完成: {SegmentCount} 段, 全文={TextLen}字",
            segments.Count, result.FullText?.Length ?? 0);

        // 保存转写结果到 Item
        await db.TranscriptItems.UpdateOneAsync(
            Builders<TranscriptItem>.Filter.Eq(i => i.Id, item.Id),
            Builders<TranscriptItem>.Update
                .Set(i => i.Segments, segments)
                .Set(i => i.TranscribeStatus, "completed")
                .Set(i => i.UpdatedAt, DateTime.UtcNow));
    }

    /// <summary>
    /// 通过 LLM Gateway（Whisper 兼容 / HTTP Exchange）处理 ASR
    /// </summary>
    private async Task ProcessAsrViaGatewayAsync(
        MongoDbContext db, ILlmGateway gateway, TranscriptRun run, TranscriptItem item)
    {
        // 下载音频文件
        using var httpClient = new HttpClient();
        var audioBytes = await httpClient.GetByteArrayAsync(item.FileUrl);

        await UpdateProgress(db, run.Id, 30);

        // 调用 ASR 模型池
        var rawRequest = new GatewayRawRequest
        {
            AppCallerCode = AppCallerRegistry.TranscriptAgent.Transcribe.Audio,
            ModelType = ModelTypes.Asr,
            EndpointPath = "/v1/audio/transcriptions",
            IsMultipart = true,
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
            TimeoutSeconds = 600,
            Context = new GatewayRequestContext { UserId = run.OwnerUserId }
        };

        await UpdateProgress(db, run.Id, 50);

        var rawResp = await gateway.SendRawAsync(rawRequest, CancellationToken.None);

        if (rawResp?.Success != true || rawResp.Content == null)
        {
            var detail = rawResp?.ErrorMessage ?? rawResp?.Content ?? "无响应";
            _logger.LogWarning("[transcript-agent] ASR 失败详情: StatusCode={StatusCode}, Error={Error}, Content={Content}",
                rawResp?.StatusCode, rawResp?.ErrorMessage, rawResp?.Content?.Substring(0, Math.Min(rawResp.Content?.Length ?? 0, 500)));
            throw new InvalidOperationException($"ASR 转写失败: {detail}");
        }

        await UpdateProgress(db, run.Id, 80);

        // 解析 Whisper 响应
        var segments = ParseWhisperSegments(rawResp.Content);

        // 保存转写结果到 Item
        await db.TranscriptItems.UpdateOneAsync(
            Builders<TranscriptItem>.Filter.Eq(i => i.Id, item.Id),
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
        var item = await db.TranscriptItems.Find(
            Builders<TranscriptItem>.Filter.Eq(i => i.Id, run.ItemId)).FirstOrDefaultAsync();
        if (item?.Segments == null || item.Segments.Count == 0)
            throw new InvalidOperationException("素材未完成转写");

        // 获取模板
        TranscriptTemplate? template = null;
        if (!string.IsNullOrEmpty(run.TemplateId))
        {
            template = await db.TranscriptTemplates.Find(
                Builders<TranscriptTemplate>.Filter.Eq(t => t.Id, run.TemplateId)).FirstOrDefaultAsync();
        }

        var transcriptText = string.Join("\n",
            item.Segments.Select(s => $"[{TimeSpan.FromSeconds(s.Start):hh\\:mm\\:ss}] {s.Text}"));

        var systemPrompt = template?.Prompt ??
            "你是一个专业的内容编辑。请将以下带时间戳的转写文本整理成结构清晰的文案。保留关键信息，去除口语化表达和重复内容。";

        await UpdateProgress(db, run.Id, 30);

        // 构建 OpenAI 格式的 chat 请求体
        var requestBody = new JsonObject
        {
            ["model"] = "gpt-4",
            ["messages"] = new JsonArray
            {
                new JsonObject { ["role"] = "system", ["content"] = systemPrompt },
                new JsonObject { ["role"] = "user", ["content"] = $"以下是需要整理的转写文本：\n\n{transcriptText}" }
            },
            ["max_tokens"] = 4096
        };

        var request = new GatewayRequest
        {
            AppCallerCode = AppCallerRegistry.TranscriptAgent.Copywrite.Generate,
            ModelType = ModelTypes.Chat,
            RequestBody = requestBody,
            Context = new GatewayRequestContext { UserId = run.OwnerUserId }
        };

        await UpdateProgress(db, run.Id, 50);

        var resp = await gateway.SendAsync(request, CancellationToken.None);

        if (resp?.Success != true)
            throw new InvalidOperationException($"文案生成失败: {resp?.ErrorMessage ?? "无响应"}");

        await UpdateProgress(db, run.Id, 90);

        await db.TranscriptRuns.UpdateOneAsync(
            Builders<TranscriptRun>.Filter.Eq(r => r.Id, run.Id),
            Builders<TranscriptRun>.Update.Set(r => r.Result, resp.Content));
    }

    // ═══════════════════════════════════════════════════════════
    // 工具方法
    // ═══════════════════════════════════════════════════════════

    private List<TranscriptSegment> ParseWhisperSegments(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
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

            return segments;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[transcript-agent] 解析 Whisper 响应失败");
            return new List<TranscriptSegment>();
        }
    }

    private static async Task UpdateProgress(MongoDbContext db, string runId, int progress)
    {
        await db.TranscriptRuns.UpdateOneAsync(
            Builders<TranscriptRun>.Filter.Eq(r => r.Id, runId),
            Builders<TranscriptRun>.Update
                .Set(r => r.Progress, progress)
                .Set(r => r.UpdatedAt, DateTime.UtcNow));
    }
}
