using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.Services.AssetStorage;

namespace PrdAgent.Api.Services;

/// <summary>
/// 视频转文档后台 Worker
/// 流程：Queued → Extracting（FFmpeg 提取音频+关键帧）→ Transcribing（Whisper STT）→ Analyzing（多模态 LLM）→ Completed
/// 遵循服务器权威性设计：核心处理使用 CancellationToken.None
/// </summary>
public class VideoToDocRunWorker : BackgroundService
{
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly ILogger<VideoToDocRunWorker> _logger;
    private readonly IConfiguration _config;

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = false
    };

    public VideoToDocRunWorker(
        IServiceScopeFactory scopeFactory,
        ILogger<VideoToDocRunWorker> logger,
        IConfiguration config)
    {
        _scopeFactory = scopeFactory;
        _logger = logger;
        _config = config;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _logger.LogInformation("VideoToDocRunWorker 已启动");

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                using var scope = _scopeFactory.CreateScope();
                var db = scope.ServiceProvider.GetRequiredService<MongoDbContext>();

                // 拾取 Queued 任务
                var queued = await ClaimQueuedRunAsync(db, stoppingToken);
                if (queued != null)
                {
                    await ProcessRunAsync(queued, scope.ServiceProvider);
                    continue;
                }
            }
            catch (OperationCanceledException) { break; }
            catch (Exception ex)
            {
                _logger.LogError(ex, "VideoToDocRunWorker 循环异常");
            }

            await Task.Delay(2000, stoppingToken);
        }

        _logger.LogInformation("VideoToDocRunWorker 已停止");
    }

    private async Task<VideoToDocRun?> ClaimQueuedRunAsync(MongoDbContext db, CancellationToken ct)
    {
        var filter = Builders<VideoToDocRun>.Filter.Eq(x => x.Status, VideoToDocRunStatus.Queued);
        var update = Builders<VideoToDocRun>.Update
            .Set(x => x.Status, VideoToDocRunStatus.Extracting)
            .Set(x => x.CurrentPhase, "extracting")
            .Set(x => x.PhaseProgress, 0)
            .Set(x => x.StartedAt, DateTime.UtcNow);

        return await db.VideoToDocRuns.FindOneAndUpdateAsync(
            filter, update,
            new FindOneAndUpdateOptions<VideoToDocRun> { ReturnDocument = ReturnDocument.After },
            ct);
    }

    private async Task ProcessRunAsync(VideoToDocRun run, IServiceProvider sp)
    {
        var db = sp.GetRequiredService<MongoDbContext>();
        var runStore = sp.GetRequiredService<IRunEventStore>();
        var gateway = sp.GetRequiredService<ILlmGateway>();
        var assetStorage = sp.GetRequiredService<IAssetStorage>();

        try
        {
            _logger.LogInformation("VideoToDoc 开始处理: runId={RunId}, videoUrl={Url}",
                run.Id, run.VideoUrl);

            // Phase 1: 提取音频 + 关键帧
            await PublishPhaseAsync(runStore, run.Id, "extracting", 5);
            var (audioPath, framePaths, duration) = await ExtractMediaAsync(run, assetStorage);

            run.DurationSeconds = duration;
            run.KeyFrameCount = framePaths.Count;

            await UpdateRunAsync(db, run.Id, Builders<VideoToDocRun>.Update
                .Set(x => x.Status, VideoToDocRunStatus.Transcribing)
                .Set(x => x.CurrentPhase, "transcribing")
                .Set(x => x.PhaseProgress, 0)
                .Set(x => x.DurationSeconds, duration)
                .Set(x => x.KeyFrameCount, framePaths.Count));

            await PublishPhaseAsync(runStore, run.Id, "transcribing", 0);

            // Phase 2: 语音转文字（Whisper API）
            var (transcript, detectedLang) = await TranscribeAudioAsync(run, audioPath, gateway);

            var plainTranscript = string.Join(" ", transcript.Select(s => s.Text));

            // 上传关键帧到 COS，获取 URL
            var frameInfos = await UploadFramesAsync(framePaths, assetStorage);
            var keyFramesJson = JsonSerializer.Serialize(frameInfos, JsonOpts);

            await UpdateRunAsync(db, run.Id, Builders<VideoToDocRun>.Update
                .Set(x => x.Status, VideoToDocRunStatus.Analyzing)
                .Set(x => x.CurrentPhase, "analyzing")
                .Set(x => x.PhaseProgress, 0)
                .Set(x => x.TranscriptJson, JsonSerializer.Serialize(transcript, JsonOpts))
                .Set(x => x.DetectedLanguage, detectedLang)
                .Set(x => x.PlainTranscript, plainTranscript)
                .Set(x => x.KeyFramesJson, keyFramesJson));

            await PublishPhaseAsync(runStore, run.Id, "analyzing", 0);

            // Phase 3: 多模态 LLM 分析（帧 + 转写文本 → 结构化文档）
            var markdown = await AnalyzeWithLlmAsync(run, transcript, frameInfos, gateway, runStore);

            // 完成
            await UpdateRunAsync(db, run.Id, Builders<VideoToDocRun>.Update
                .Set(x => x.Status, VideoToDocRunStatus.Completed)
                .Set(x => x.CurrentPhase, "completed")
                .Set(x => x.PhaseProgress, 100)
                .Set(x => x.OutputMarkdown, markdown)
                .Set(x => x.EndedAt, DateTime.UtcNow));

            await PublishEventAsync(runStore, run.Id, "run.completed", new { markdown });

            _logger.LogInformation("VideoToDoc 完成: runId={RunId}, frames={Frames}, duration={Dur}s, docLen={Len}",
                run.Id, framePaths.Count, duration, markdown.Length);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "VideoToDoc 处理失败: runId={RunId}", run.Id);

            await UpdateRunAsync(db, run.Id, Builders<VideoToDocRun>.Update
                .Set(x => x.Status, VideoToDocRunStatus.Failed)
                .Set(x => x.CurrentPhase, "failed")
                .Set(x => x.ErrorCode, "PROCESSING_ERROR")
                .Set(x => x.ErrorMessage, ex.Message)
                .Set(x => x.EndedAt, DateTime.UtcNow));

            await PublishEventAsync(runStore, run.Id, "run.error",
                new { code = "PROCESSING_ERROR", message = ex.Message });
        }
        finally
        {
            // 清理临时文件
            CleanupTempDir(run.Id);
        }
    }

    // ═══════════════════════════════════════════════════════════
    // Phase 1: FFmpeg 提取音频 + 关键帧
    // ═══════════════════════════════════════════════════════════

    private async Task<(string audioPath, List<string> framePaths, double duration)> ExtractMediaAsync(
        VideoToDocRun run, IAssetStorage assetStorage)
    {
        var workDir = GetTempDir(run.Id);
        Directory.CreateDirectory(workDir);

        // 下载视频到本地
        var videoPath = Path.Combine(workDir, "input.mp4");
        await DownloadFileAsync(run.VideoUrl, videoPath);

        // 获取视频时长
        var duration = await GetVideoDurationAsync(videoPath);

        // 提取音频（16kHz 单声道 WAV，STT 最优格式）
        var audioPath = Path.Combine(workDir, "audio.wav");
        await RunFfmpegAsync(
            $"-i \"{videoPath}\" -vn -acodec pcm_s16le -ar 16000 -ac 1 -y \"{audioPath}\"",
            workDir);

        // 提取关键帧（场景变化检测 + 定期采样保底）
        var framesDir = Path.Combine(workDir, "frames");
        Directory.CreateDirectory(framesDir);

        // 先尝试场景变化检测
        await RunFfmpegAsync(
            $"-i \"{videoPath}\" -vf \"select='gt(scene,0.35)',scale=1280:-2\" -vsync vfr -q:v 3 \"{Path.Combine(framesDir, "scene_%04d.jpg")}\"",
            workDir);

        var framePaths = Directory.GetFiles(framesDir, "*.jpg")
            .OrderBy(f => f)
            .ToList();

        // 如果场景检测提取太少帧（< 3），则用定期采样补充
        if (framePaths.Count < 3)
        {
            _logger.LogInformation("VideoToDoc 场景帧不足({Count})，使用定期采样补充: runId={RunId}",
                framePaths.Count, run.Id);

            var interval = Math.Max(3, (int)(duration / 15)); // 目标约 15 帧
            await RunFfmpegAsync(
                $"-i \"{videoPath}\" -vf \"fps=1/{interval},scale=1280:-2\" -q:v 3 \"{Path.Combine(framesDir, "periodic_%04d.jpg")}\"",
                workDir);

            framePaths = Directory.GetFiles(framesDir, "*.jpg")
                .OrderBy(f => f)
                .ToList();
        }

        // 限制最多 30 帧（控制 LLM 成本）
        if (framePaths.Count > 30)
        {
            var step = (double)framePaths.Count / 30;
            framePaths = Enumerable.Range(0, 30)
                .Select(i => framePaths[Math.Min((int)(i * step), framePaths.Count - 1)])
                .Distinct()
                .ToList();
        }

        _logger.LogInformation("VideoToDoc 提取完成: runId={RunId}, audio={AudioExists}, frames={FrameCount}, duration={Dur}s",
            run.Id, File.Exists(audioPath), framePaths.Count, duration);

        return (audioPath, framePaths, duration);
    }

    // ═══════════════════════════════════════════════════════════
    // Phase 2: 语音转文字（通过 LLM Gateway / Whisper API）
    // ═══════════════════════════════════════════════════════════

    private async Task<(List<TranscriptSegment> segments, string language)> TranscribeAudioAsync(
        VideoToDocRun run, string audioPath, ILlmGateway gateway)
    {
        // 通过 Gateway 的 SendRawWithResolutionAsync 调用 ASR 模型池（遵循 compute-then-send 原则）
        // ASR 模型池统一管理语音识别模型（Whisper / TeleSpeechASR / Qwen3-ASR 等）
        // API 兼容 OpenAI /v1/audio/transcriptions 端点
        var asrResolution = await gateway.ResolveModelAsync(
            AppCallerRegistry.VideoAgent.VideoToDoc.Transcribe, ModelTypes.Asr, null, CancellationToken.None);
        if (!asrResolution.Success)
        {
            _logger.LogWarning("VideoToDoc ASR 模型调度失败，降级为无转写模式: runId={RunId}, reason={Reason}",
                run.Id, asrResolution.ErrorMessage);
            return (new List<TranscriptSegment>(), "unknown");
        }

        var audioBytes = await File.ReadAllBytesAsync(audioPath);

        var rawRequest = new GatewayRawRequest
        {
            AppCallerCode = AppCallerRegistry.VideoAgent.VideoToDoc.Transcribe,
            ModelType = ModelTypes.Asr,
            EndpointPath = "/v1/audio/transcriptions",
            MultipartFields = new Dictionary<string, object>
            {
                // model 字段由 Gateway 根据 ASR 模型池调度结果自动替换
                ["model"] = "whisper-1",
                ["response_format"] = "verbose_json",
                ["timestamp_granularities[]"] = "segment",
                ["language"] = run.Language == "auto" ? "" : run.Language
            },
            MultipartFiles = new Dictionary<string, (string FileName, byte[] Content, string MimeType)>
            {
                ["file"] = ("audio.wav", audioBytes, "audio/wav")
            },
            TimeoutSeconds = 600 // 长音频可能需要较长时间
        };

        GatewayRawResponse? rawResp = null;
        try
        {
            rawResp = await gateway.SendRawWithResolutionAsync(rawRequest, asrResolution, CancellationToken.None);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "VideoToDoc ASR 调用失败，降级为无转写模式: runId={RunId}", run.Id);
        }

        if (rawResp?.Success == true && rawResp.Content != null)
        {
            return ParseWhisperResponse(rawResp.Content);
        }

        // 降级方案：ASR 模型池未配置或不可用时，仅依赖关键帧视觉分析
        _logger.LogWarning("VideoToDoc ASR 模型池不可用，降级为纯视觉分析模式: runId={RunId}", run.Id);
        return (new List<TranscriptSegment>(), "unknown");
    }

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
            _logger.LogWarning(ex, "VideoToDoc 解析 Whisper 响应失败");
            return (new List<TranscriptSegment>(), "unknown");
        }
    }

    // ═══════════════════════════════════════════════════════════
    // Phase 3: 多模态 LLM 分析
    // ═══════════════════════════════════════════════════════════

    private async Task<string> AnalyzeWithLlmAsync(
        VideoToDocRun run,
        List<TranscriptSegment> transcript,
        List<FrameInfo> frames,
        ILlmGateway gateway,
        IRunEventStore runStore)
    {
        var systemPrompt = BuildAnalysisSystemPrompt(run);
        var transcriptText = FormatTranscriptForLlm(transcript);

        // 构建多模态消息：文本 + 关键帧图片
        var contentArray = new JsonArray();

        // 文本部分
        var userText = $"""
            请根据以下视频内容生成结构化技术文档。

            ## 视频信息
            - 标题：{run.VideoTitle ?? "未知"}
            - 时长：{run.DurationSeconds:F0} 秒
            - 关键帧数量：{frames.Count}
            - 检测语言：{run.DetectedLanguage ?? "未知"}

            ## 语音转写内容
            {transcriptText}

            ## 关键帧
            以下 {frames.Count} 张图片是按时间顺序排列的视频关键帧截图。
            请结合视觉内容和语音文本，生成一份完整的结构化 Markdown 文档。
            """;

        contentArray.Add(new JsonObject { ["type"] = "text", ["text"] = userText });

        // 图片部分（限制最多 20 帧发给 LLM，控制成本）
        var framesToSend = frames;
        if (framesToSend.Count > 20)
        {
            var step = (double)framesToSend.Count / 20;
            framesToSend = Enumerable.Range(0, 20)
                .Select(i => framesToSend[Math.Min((int)(i * step), framesToSend.Count - 1)])
                .Distinct()
                .ToList();
        }

        foreach (var frame in framesToSend)
        {
            contentArray.Add(new JsonObject
            {
                ["type"] = "image_url",
                ["image_url"] = new JsonObject
                {
                    ["url"] = frame.Url,
                    ["detail"] = "low" // 85 tokens/image，控制成本
                }
            });
        }

        var request = new GatewayRequest
        {
            AppCallerCode = AppCallerRegistry.VideoAgent.VideoToDoc.Analyze,
            ModelType = "vision",
            RequestBody = new JsonObject
            {
                ["messages"] = new JsonArray
                {
                    new JsonObject { ["role"] = "system", ["content"] = systemPrompt },
                    new JsonObject { ["role"] = "user", ["content"] = contentArray }
                }
            },
            Stream = true,
            IncludeThinking = true,
            TimeoutSeconds = 300,
            Context = new GatewayRequestContext { UserId = run.OwnerAdminId }
        };

        var resultBuilder = new StringBuilder();

        await foreach (var chunk in gateway.StreamAsync(request, CancellationToken.None))
        {
            if (chunk.Type == GatewayChunkType.Text)
            {
                resultBuilder.Append(chunk.Content);
                await PublishEventAsync(runStore, run.Id, "text.delta", new { content = chunk.Content });
            }
            else if (chunk.Type == GatewayChunkType.Thinking)
            {
                await PublishEventAsync(runStore, run.Id, "thinking.delta", new { content = chunk.Content });
            }
            else if (chunk.Type == GatewayChunkType.Error)
            {
                throw new InvalidOperationException($"LLM 分析失败: {chunk.Error}");
            }
        }

        var rawMarkdown = resultBuilder.ToString().Trim();
        if (string.IsNullOrWhiteSpace(rawMarkdown))
        {
            throw new InvalidOperationException("LLM 返回空内容");
        }

        return rawMarkdown;
    }

    private string BuildAnalysisSystemPrompt(VideoToDocRun run)
    {
        var basePrompt = """
            你是一个专业的技术文档撰写者。你的任务是将视频内容转化为结构清晰、信息完整的 Markdown 文档。

            ## 输出要求

            1. **文档结构**：使用 Markdown 格式，包含一级标题、二级标题、三级标题的层次结构
            2. **内容完整性**：结合语音内容和视觉信息，确保不遗漏关键知识点
            3. **视觉描述**：对关键截图中的 UI 界面、代码片段、图表等进行文字描述
            4. **关键要点**：每个章节末尾可用列表总结要点
            5. **语言**：与视频语言保持一致
            6. **代码块**：如果视频中展示了代码，请用代码块标注语言
            7. **长度**：文档应当详尽但不冗余，目标是让没看过视频的人也能理解全部内容

            ## 格式模板

            ```markdown
            # [文档标题]

            ## 概述
            [视频内容的简短摘要，2-3 句话]

            ## [主题章节 1]
            [详细内容]

            ### [子主题]
            [细节说明]

            ## [主题章节 N]
            ...

            ## 总结
            [关键要点总结]
            ```
            """;

        if (!string.IsNullOrWhiteSpace(run.SystemPrompt))
        {
            basePrompt += $"\n\n## 用户额外要求\n{run.SystemPrompt}";
        }

        return basePrompt;
    }

    private static string FormatTranscriptForLlm(List<TranscriptSegment> transcript)
    {
        if (transcript.Count == 0) return "[无语音转写内容]";

        var sb = new StringBuilder();
        foreach (var seg in transcript)
        {
            var startMin = (int)(seg.Start / 60);
            var startSec = (int)(seg.Start % 60);
            sb.AppendLine($"[{startMin:D2}:{startSec:D2}] {seg.Text}");
        }
        return sb.ToString();
    }

    // ═══════════════════════════════════════════════════════════
    // 帮助方法
    // ═══════════════════════════════════════════════════════════

    private async Task<List<FrameInfo>> UploadFramesAsync(List<string> framePaths, IAssetStorage assetStorage)
    {
        var result = new List<FrameInfo>();
        foreach (var path in framePaths)
        {
            var bytes = await File.ReadAllBytesAsync(path);
            var stored = await assetStorage.SaveAsync(bytes, "image/jpeg", CancellationToken.None,
                domain: AppDomainPaths.DomainVideoAgent, type: AppDomainPaths.TypeImg);

            // 从文件名推断时间戳（scene_0001.jpg → 按顺序编号）
            var fileName = Path.GetFileNameWithoutExtension(path);
            result.Add(new FrameInfo
            {
                Url = stored.Url,
                FileName = fileName,
                Index = result.Count
            });
        }
        return result;
    }

    private async Task DownloadFileAsync(string url, string outputPath)
    {
        using var http = new HttpClient { Timeout = TimeSpan.FromMinutes(10) };
        using var response = await http.GetAsync(url, CancellationToken.None);
        response.EnsureSuccessStatusCode();

        await using var fs = File.Create(outputPath);
        await response.Content.CopyToAsync(fs);
    }

    private async Task<double> GetVideoDurationAsync(string videoPath)
    {
        var psi = new ProcessStartInfo
        {
            FileName = "ffprobe",
            Arguments = $"-v quiet -print_format json -show_format \"{videoPath}\"",
            RedirectStandardOutput = true,
            UseShellExecute = false,
            CreateNoWindow = true
        };

        using var process = Process.Start(psi);
        if (process == null) return 0;

        var output = await process.StandardOutput.ReadToEndAsync();
        await process.WaitForExitAsync();

        try
        {
            using var doc = JsonDocument.Parse(output);
            if (doc.RootElement.TryGetProperty("format", out var fmt) &&
                fmt.TryGetProperty("duration", out var dur))
            {
                return double.TryParse(dur.GetString(), out var d) ? d : 0;
            }
        }
        catch { /* ignore parse errors */ }

        return 0;
    }

    private async Task RunFfmpegAsync(string arguments, string workDir)
    {
        var psi = new ProcessStartInfo
        {
            FileName = "ffmpeg",
            Arguments = arguments,
            WorkingDirectory = workDir,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true
        };

        using var process = Process.Start(psi);
        if (process == null)
            throw new InvalidOperationException("无法启动 FFmpeg 进程");

        var stderrBuilder = new StringBuilder();
        var stderrTask = Task.Run(async () =>
        {
            while (!process.StandardError.EndOfStream)
            {
                var line = await process.StandardError.ReadLineAsync();
                if (line != null) stderrBuilder.AppendLine(line);
            }
        });

        // 消耗 stdout 避免死锁
        while (!process.StandardOutput.EndOfStream)
        {
            await process.StandardOutput.ReadLineAsync();
        }

        await stderrTask;
        await process.WaitForExitAsync();

        if (process.ExitCode != 0)
        {
            _logger.LogWarning("FFmpeg 退出码 {Code}, stderr: {Stderr}", process.ExitCode, stderrBuilder.ToString());
            // 不直接抛异常 — FFmpeg 在某些场景退出码非0但仍有输出（如帧数不足）
        }
    }

    private string GetTempDir(string runId)
    {
        return Path.Combine(Path.GetTempPath(), "video-to-doc", runId);
    }

    private void CleanupTempDir(string runId)
    {
        try
        {
            var dir = GetTempDir(runId);
            if (Directory.Exists(dir))
            {
                Directory.Delete(dir, recursive: true);
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "VideoToDoc 清理临时目录失败: runId={RunId}", runId);
        }
    }

    private static async Task UpdateRunAsync(MongoDbContext db, string runId, UpdateDefinition<VideoToDocRun> update)
    {
        await db.VideoToDocRuns.UpdateOneAsync(
            x => x.Id == runId,
            update,
            cancellationToken: CancellationToken.None);
    }

    private async Task PublishPhaseAsync(IRunEventStore runStore, string runId, string phase, int progress)
    {
        await PublishEventAsync(runStore, runId, "phase.changed", new { phase, progress });
    }

    private async Task PublishEventAsync(IRunEventStore runStore, string runId, string eventName, object payload)
    {
        try
        {
            await runStore.AppendEventAsync(RunKinds.VideoToDoc, runId, eventName, payload,
                ttl: TimeSpan.FromHours(2), ct: CancellationToken.None);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "VideoToDoc 事件发布失败: runId={RunId}, event={Event}", runId, eventName);
        }
    }

    // ─── 内部 DTO ───

    public class TranscriptSegment
    {
        public double Start { get; set; }
        public double End { get; set; }
        public string Text { get; set; } = string.Empty;
    }

    public class FrameInfo
    {
        public string Url { get; set; } = string.Empty;
        public string FileName { get; set; } = string.Empty;
        public int Index { get; set; }
    }
}
