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

    private string? _currentRunId;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _logger.LogInformation("[transcript-agent] Worker started");

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
                    _logger.LogError(ex, "[transcript-agent] Worker loop error");
                }

                await Task.Delay(3000, stoppingToken);
            }
        }
        finally
        {
            // Worker 关闭时，将当前处理中的 run 标记为失败
            if (_currentRunId != null)
            {
                try
                {
                    using var scope = _scopeFactory.CreateScope();
                    var db = scope.ServiceProvider.GetRequiredService<MongoDbContext>();
                    await db.TranscriptRuns.UpdateOneAsync(
                        Builders<TranscriptRun>.Filter.Eq(r => r.Id, _currentRunId) &
                        Builders<TranscriptRun>.Filter.Eq(r => r.Status, "processing"),
                        Builders<TranscriptRun>.Update
                            .Set(r => r.Status, "failed")
                            .Set(r => r.Error, "Worker 关闭，任务被中断")
                            .Set(r => r.UpdatedAt, DateTime.UtcNow),
                        cancellationToken: CancellationToken.None);
                    _logger.LogInformation("[transcript-agent] Marked run {RunId} as failed on shutdown", _currentRunId);
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "[transcript-agent] Failed to cleanup run {RunId} on shutdown", _currentRunId);
                }
            }
        }
    }

    private async Task ProcessNextRunAsync()
    {
        using var scope = _scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MongoDbContext>();
        var gateway = scope.ServiceProvider.GetRequiredService<ILlmGateway>();
        var ctxAccessor = scope.ServiceProvider.GetRequiredService<ILLMRequestContextAccessor>();
        var instanceId = InstanceIdentity.Get(scope.ServiceProvider.GetRequiredService<IConfiguration>());

        // CDS 的所有预览分支共用 MongoDB。只领取当前部署创建的任务，禁止其他分支
        // 或主干旧版本抢走后按不同模型协议执行。
        var filter = Builders<TranscriptRun>.Filter.And(
            Builders<TranscriptRun>.Filter.Eq(r => r.Status, TranscriptRunStatuses.ScopedQueued),
            Builders<TranscriptRun>.Filter.Eq(r => r.OwnerInstanceId, instanceId));
        var update = Builders<TranscriptRun>.Update
            .Set(r => r.Status, "processing")
            .Set(r => r.OwnerInstanceId, instanceId)
            .Set(r => r.UpdatedAt, DateTime.UtcNow);
        var options = new FindOneAndUpdateOptions<TranscriptRun, TranscriptRun>
        {
            ReturnDocument = ReturnDocument.After
        };
        var run = await db.TranscriptRuns.FindOneAndUpdateAsync(filter, update, options);

        if (run == null) return;

        _currentRunId = run.Id;
        _logger.LogInformation("[transcript-agent] Processing run {RunId}, type={Type}", run.Id, run.Type);

        try
        {
            var appCallerCode = run.Type == "asr"
                ? AppCallerRegistry.TranscriptAgent.Transcribe.Audio
                : AppCallerRegistry.TranscriptAgent.Copywrite.Generate;
            using var _ = ctxAccessor.BeginScope(new LlmRequestContext(
                RequestId: run.Id,
                GroupId: null,
                SessionId: run.WorkspaceId,
                UserId: run.OwnerUserId,
                ViewRole: "ADMIN",
                DocumentChars: null,
                DocumentHash: null,
                SystemPromptRedacted: "[TRANSCRIPT_RUN]",
                RequestType: run.Type == "asr" ? ModelTypes.Asr : ModelTypes.Chat,
                AppCallerCode: appCallerCode,
                ForceFullShadowSample: run.ForceFullShadowSample));

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

            _currentRunId = null;
            _logger.LogInformation("[transcript-agent] Run {RunId} completed", run.Id);
        }
        catch (Exception ex)
        {
            _currentRunId = null;
            _logger.LogError(ex, "[transcript-agent] Run {RunId} failed", run.Id);
            var userError = run.Type == "asr"
                ? ToUserReadableAsrError(ex)
                : "文案生成暂时失败，请稍后重试；已完成的转写内容不会丢失。";

            await db.TranscriptRuns.UpdateOneAsync(
                Builders<TranscriptRun>.Filter.Eq(r => r.Id, run.Id),
                Builders<TranscriptRun>.Update
                    .Set(r => r.Status, "failed")
                    .Set(r => r.Error, userError)
                    .Set(r => r.UpdatedAt, DateTime.UtcNow));

            // ASR 失败时同步更新 Item 状态
            if (run.Type == "asr")
            {
                await db.TranscriptItems.UpdateOneAsync(
                    Builders<TranscriptItem>.Filter.Eq(i => i.Id, run.ItemId),
                    Builders<TranscriptItem>.Update
                        .Set(i => i.TranscribeStatus, "failed")
                        .Set(i => i.TranscribeError, userError));
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

        // 根据模型类型选择 ASR 路径
        if (resolution.IsExchange)
        {
            if (resolution.ExchangeTransformerType == "doubao-asr-stream")
            {
                // WebSocket 协议已迁入 LlmGateway raw 发送路径；MAP 仍只经 ILlmGateway 调用。
                _logger.LogInformation("[transcript-agent] 使用豆包 WebSocket ASR 网关路径: Exchange={ExchangeName}", resolution.ExchangeName);
                await ProcessAsrViaGatewayAsync(db, gateway, run, item, resolution);
            }
            else if (resolution.ExchangeTransformerType == "doubao-asr")
            {
                // 异步 submit+query ASR：Gateway 的 SendRawWithResolutionAsync 支持 IAsyncExchangeTransformer 轮询
                _logger.LogInformation("[transcript-agent] 使用异步 ASR 路径: Exchange={ExchangeName}", resolution.ExchangeName);
                await ProcessAsrViaGatewayAsync(db, gateway, run, item, resolution);
            }
            else
            {
                // 未知 Exchange 类型：不能贸然走 Gateway（可能是 WebSocket 等非 HTTP 协议），直接报错
                throw new InvalidOperationException(
                    $"不支持的 ASR Exchange 转换器类型: {resolution.ExchangeTransformerType}，" +
                    $"Exchange={resolution.ExchangeName}");
            }
        }
        else
        {
            // 非 Exchange 模型（Whisper 等）：走 Gateway HTTP 路径
            await ProcessAsrViaGatewayAsync(db, gateway, run, item, resolution);
        }
    }

    /// <summary>
    /// 通过 LLM Gateway（Whisper 兼容 / HTTP Exchange）处理 ASR
    /// </summary>
    private async Task ProcessAsrViaGatewayAsync(
        MongoDbContext db, ILlmGateway gateway, TranscriptRun run, TranscriptItem item,
        ModelResolutionResult resolution)
    {
        // 下载音频文件
        using var httpClient = new HttpClient();
        var sourceBytes = await httpClient.GetByteArrayAsync(item.FileUrl);
        var audioBytes = await NormalizeAudioAsync(sourceBytes);
        _logger.LogInformation(
            "[transcript-agent] ASR 音频已规范化: sourceBytes={SourceBytes} normalizedBytes={NormalizedBytes}",
            sourceBytes.Length,
            audioBytes.Length);

        await UpdateProgress(db, run.Id, 30);

        // 请求形状必须随模型协议构建：豆包异步只接受 JSON base64，多模态音频走
        // chat input_audio，Whisper 与豆包流式走标准 WAV multipart。
        var isChatAudio = AsrAudioRoutePolicy.ShouldUseChatAudio(
            resolution.ActualModel,
            resolution.Protocol,
            resolution.PlatformType);
        GatewayRawRequest BuildRawRequest(int validationAttempt)
        {
            if (resolution.IsExchange
                && string.Equals(resolution.ExchangeTransformerType, "doubao-asr", StringComparison.OrdinalIgnoreCase))
            {
                return new GatewayRawRequest
                {
                    AppCallerCode = AppCallerRegistry.TranscriptAgent.Transcribe.Audio,
                    ModelType = ModelTypes.Asr,
                    RequestBody = new JsonObject { ["audio_data"] = Convert.ToBase64String(audioBytes) },
                    IsMultipart = false,
                    TimeoutSeconds = 600,
                    Context = new GatewayRequestContext { UserId = run.OwnerUserId }
                };
            }

            if (isChatAudio)
            {
                var prompt = validationAttempt == 1
                    ? "音频已附在本消息的 input_audio 中。请逐字转写，只输出音频里真实说出的话，不要解释、确认或要求播放音频；没有人声时只输出 NO_SPEECH。"
                    : $"这是第 {validationAttempt - 1} 次结果校验。必须读取本消息 input_audio 里的 WAV 音频，只输出真实人声原文；禁止要求用户再次提供、上传或播放音频。没有人声时只输出 NO_SPEECH。";
                return new GatewayRawRequest
                {
                    AppCallerCode = AppCallerRegistry.TranscriptAgent.Transcribe.Audio,
                    ModelType = ModelTypes.Asr,
                    EndpointPath = "/v1/chat/completions",
                    RequestBody = new JsonObject
                    {
                        ["model"] = resolution.ActualModel,
                        ["modalities"] = new JsonArray("text"),
                        ["temperature"] = 0,
                        ["messages"] = new JsonArray
                        {
                            new JsonObject
                            {
                                ["role"] = "user",
                                ["content"] = new JsonArray
                                {
                                    new JsonObject { ["type"] = "text", ["text"] = prompt },
                                    new JsonObject
                                    {
                                        ["type"] = "input_audio",
                                        ["input_audio"] = new JsonObject
                                        {
                                            ["data"] = Convert.ToBase64String(audioBytes),
                                            ["format"] = "wav"
                                        }
                                    }
                                }
                            }
                        }
                    },
                    TimeoutSeconds = 600,
                    Context = new GatewayRequestContext { UserId = run.OwnerUserId }
                };
            }

            return new GatewayRawRequest
            {
                AppCallerCode = AppCallerRegistry.TranscriptAgent.Transcribe.Audio,
                ModelType = ModelTypes.Asr,
                EndpointPath = "/v1/audio/transcriptions",
                IsMultipart = true,
                MultipartFields = new Dictionary<string, object>
                {
                    ["model"] = resolution.ActualModel ?? "whisper-1",
                    ["response_format"] = "verbose_json",
                    ["timestamp_granularities[]"] = "segment"
                },
                MultipartFiles = new Dictionary<string, (string FileName, byte[] Content, string MimeType)>
                {
                    ["file"] = ("audio.wav", audioBytes, "audio/wav")
                },
                TimeoutSeconds = 600,
                Context = new GatewayRequestContext { UserId = run.OwnerUserId }
            };
        }

        var maxValidationAttempts = isChatAudio ? 4 : 1;
        GatewayRawResponse? rawResp = null;
        string? validatedChatText = null;
        for (var validationAttempt = 1; validationAttempt <= maxValidationAttempts; validationAttempt++)
        {
            var rawRequest = BuildRawRequest(validationAttempt);
            rawResp = await gateway.SendRawWithResolutionAsync(
                rawRequest,
                resolution.ToGatewayResolution(),
                CancellationToken.None);

            if (rawResp?.Success != true || rawResp.Content == null)
                break;

            if (!isChatAudio)
                break;

            var candidateText = PrdAgent.Infrastructure.LlmGateway.Asr.LiveAsrBatchFallbackService.ExtractText(rawResp.Content);
            var isNoSpeech = candidateText?.Contains("NO_SPEECH", StringComparison.OrdinalIgnoreCase) == true;
            var isAssistantReply = !string.IsNullOrWhiteSpace(candidateText)
                && PrdAgent.Infrastructure.LlmGateway.Asr.LiveAsrBatchFallbackService.LooksLikeAssistantReply(candidateText);
            if (!string.IsNullOrWhiteSpace(candidateText) && !isNoSpeech && !isAssistantReply)
            {
                validatedChatText = candidateText.Trim();
                break;
            }

            _logger.LogWarning(
                "[transcript-agent] 音频模型返回无效文本，已拒绝写入并继续校验: RunId={RunId}, Attempt={Attempt}, IsNoSpeech={IsNoSpeech}, IsAssistantReply={IsAssistantReply}",
                run.Id,
                validationAttempt,
                isNoSpeech,
                isAssistantReply);
        }

        await UpdateProgress(db, run.Id, 50);

        if (rawResp?.Success != true || rawResp.Content == null)
        {
            var detail = rawResp?.ErrorMessage ?? rawResp?.Content ?? "无响应";
            _logger.LogWarning("[transcript-agent] ASR 失败详情: StatusCode={StatusCode}, Error={Error}, Content={Content}",
                rawResp?.StatusCode, rawResp?.ErrorMessage, rawResp?.Content?.Substring(0, Math.Min(rawResp.Content?.Length ?? 0, 500)));
            throw new InvalidOperationException($"ASR 转写失败: {detail}");
        }

        await UpdateProgress(db, run.Id, 80);

        var segments = ParseWhisperSegments(rawResp.Content);
        if (!string.IsNullOrWhiteSpace(validatedChatText))
        {
            segments.Clear();
            segments.Add(new TranscriptSegment { Start = 0, End = 0, Text = validatedChatText });
        }
        else if (segments.Count == 0 && !isChatAudio)
        {
            var text = PrdAgent.Infrastructure.LlmGateway.Asr.LiveAsrBatchFallbackService.ExtractText(rawResp.Content);
            if (!string.IsNullOrWhiteSpace(text)
                && !text.Contains("NO_SPEECH", StringComparison.OrdinalIgnoreCase))
            {
                segments.Add(new TranscriptSegment { Start = 0, End = 0, Text = text.Trim() });
            }
        }
        if (segments.Count == 0)
            throw new InvalidOperationException("ASR 没有识别到有效语音");

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
            ["model"] = "gpt-5.6-terra",
            ["messages"] = new JsonArray
            {
                new JsonObject { ["role"] = "system", ["content"] = systemPrompt },
                new JsonObject { ["role"] = "user", ["content"] = $"以下是需要整理的转写文本：\n\n{transcriptText}" }
            },
            ["max_completion_tokens"] = 4096,
            ["reasoning_effort"] = "none"
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

    private static string ToUserReadableAsrError(Exception ex)
    {
        var message = ex.Message ?? string.Empty;
        if (message.Contains("没有识别到有效语音", StringComparison.OrdinalIgnoreCase)
            || message.Contains("NO_SPEECH", StringComparison.OrdinalIgnoreCase))
        {
            return "没有识别到有效语音。请确认录音中有人声且音量清晰，然后重新上传；原始音频已保留。";
        }

        return "语音转写暂时失败。请稍后重试或换一段清晰音频；原始音频已保留，不需要重新录制。";
    }

    private static async Task<byte[]> NormalizeAudioAsync(byte[] sourceBytes)
    {
        var inputPath = Path.Combine(Path.GetTempPath(), $"transcript-in-{Guid.NewGuid():N}");
        var outputPath = Path.Combine(Path.GetTempPath(), $"transcript-out-{Guid.NewGuid():N}.wav");
        await File.WriteAllBytesAsync(inputPath, sourceBytes, CancellationToken.None);
        try
        {
            var startInfo = new System.Diagnostics.ProcessStartInfo
            {
                FileName = "ffmpeg",
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            };
            AsrAudioNormalizationPolicy.ConfigureFfmpegArguments(startInfo.ArgumentList, inputPath, outputPath);
            using var process = System.Diagnostics.Process.Start(startInfo)
                ?? throw new InvalidOperationException("音频处理服务启动失败");
            var stderrTask = process.StandardError.ReadToEndAsync();
            var stdoutTask = process.StandardOutput.ReadToEndAsync();
            await process.WaitForExitAsync(CancellationToken.None);
            var stderr = await stderrTask;
            await stdoutTask;
            if (process.ExitCode != 0)
                throw new InvalidOperationException($"音频格式转换失败，退出码 {process.ExitCode}: {stderr}");
            return await File.ReadAllBytesAsync(outputPath, CancellationToken.None);
        }
        finally
        {
            try { if (File.Exists(inputPath)) File.Delete(inputPath); } catch { }
            try { if (File.Exists(outputPath)) File.Delete(outputPath); } catch { }
        }
    }
}
