using System.Text;
using System.Text.Json;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;

namespace PrdAgent.Api.Services;

/// <summary>
/// 字幕生成处理器 —— 对音视频文件做 ASR 直译 / 对图片做 Vision OCR。
/// 输出格式：带时间戳的 Markdown 字幕文件。
///
/// 分派规则（按 entry.ContentType 前缀）：
///   audio/*         → DoubaoStreamAsrService（支持 mp3/wav/m4a/ogg/flac，内部走 ffmpeg 转码）
///   video/*         → 下载后 ffmpeg 抽音频 → 走 ASR（ffmpeg 由 host 挂载，见 docker-compose.yml）
///   image/*         → ILlmGateway Vision 模型 → 直译图片文字
///   其他            → 不支持，直接失败
/// </summary>
public class SubtitleGenerationProcessor
{
    private readonly DoubaoStreamAsrService _streamAsr;
    private readonly IModelResolver _modelResolver;
    private readonly ILlmGateway _llmGateway;
    private readonly IDocumentService _documentService;
    private readonly ILogger<SubtitleGenerationProcessor> _logger;
    private readonly IHttpClientFactory _httpClientFactory;

    public SubtitleGenerationProcessor(
        DoubaoStreamAsrService streamAsr,
        IModelResolver modelResolver,
        ILlmGateway llmGateway,
        IDocumentService documentService,
        IHttpClientFactory httpClientFactory,
        ILogger<SubtitleGenerationProcessor> logger)
    {
        _streamAsr = streamAsr;
        _modelResolver = modelResolver;
        _llmGateway = llmGateway;
        _documentService = documentService;
        _httpClientFactory = httpClientFactory;
        _logger = logger;
    }

    public async Task ProcessAsync(DocumentStoreAgentRun run, MongoDbContext db, IRunEventStore runStore)
    {
        // 1) 读源 entry
        var entry = await db.DocumentEntries.Find(e => e.Id == run.SourceEntryId).FirstOrDefaultAsync();
        if (entry == null)
            throw new InvalidOperationException("源文档条目不存在");
        if (entry.IsFolder)
            throw new InvalidOperationException("文件夹不支持生成字幕");

        var contentType = (entry.ContentType ?? "").ToLowerInvariant();
        var isAudio = contentType.StartsWith("audio/");
        var isVideo = contentType.StartsWith("video/");
        var isImage = contentType.StartsWith("image/");

        if (!isAudio && !isVideo && !isImage)
            throw new InvalidOperationException($"不支持的文件类型: {contentType}（仅支持音频/视频/图片）");

        // 2) 取 fileUrl：通过 Attachment 间接取
        string? fileUrl = null;
        if (!string.IsNullOrEmpty(entry.AttachmentId))
        {
            var att = await db.Attachments.Find(a => a.AttachmentId == entry.AttachmentId).FirstOrDefaultAsync();
            fileUrl = att?.Url;
        }
        if (string.IsNullOrEmpty(fileUrl))
            throw new InvalidOperationException("源文件 URL 不可用（可能未上传到 COS）");

        await UpdateProgressAsync(db, runStore, run, 10, "准备中");

        // 3) 识别
        string subtitleMd;
        if (isAudio || isVideo)
        {
            var segments = await TranscribeAudioOrVideoAsync(run, db, runStore, fileUrl, isVideo);
            subtitleMd = SubtitleFormatter.FormatAsrSegments(entry.Title, segments);
        }
        else
        {
            var text = await RecognizeImageAsync(run, db, runStore, fileUrl);
            subtitleMd = SubtitleFormatter.FormatImageText(entry.Title, text);
        }

        await UpdateProgressAsync(db, runStore, run, 85, "写入中");

        // 4) 落库：创建新 entry 承载字幕
        var parsed = await _documentService.ParseAsync(subtitleMd);
        parsed.Title = BuildSubtitleTitle(entry.Title);
        await _documentService.SaveAsync(parsed);

        var newEntry = new DocumentEntry
        {
            StoreId = entry.StoreId,
            ParentId = entry.ParentId,
            Title = BuildSubtitleTitle(entry.Title),
            Summary = subtitleMd.Length > 200 ? subtitleMd[..200] : subtitleMd,
            SourceType = DocumentSourceType.Upload,
            ContentType = "text/markdown",
            FileSize = Encoding.UTF8.GetByteCount(subtitleMd),
            DocumentId = parsed.Id,
            CreatedBy = run.UserId,
            ContentIndex = subtitleMd.Length > 2000 ? subtitleMd[..2000] : subtitleMd,
            Metadata = new Dictionary<string, string>
            {
                ["generated_kind"] = "subtitle",
                ["source_entry_id"] = entry.Id,
            },
        };
        await db.DocumentEntries.InsertOneAsync(newEntry);

        // 更新知识库文档计数
        await db.DocumentStores.UpdateOneAsync(
            s => s.Id == entry.StoreId,
            Builders<DocumentStore>.Update
                .Inc(s => s.DocumentCount, 1)
                .Set(s => s.UpdatedAt, DateTime.UtcNow),
            cancellationToken: CancellationToken.None);

        // 源 entry metadata 标记"已生成字幕"，避免重复生成（整个 Metadata 字段 replace）
        var newMeta = entry.Metadata ?? new Dictionary<string, string>();
        newMeta["subtitle_entry_id"] = newEntry.Id;
        await db.DocumentEntries.UpdateOneAsync(
            e => e.Id == entry.Id,
            Builders<DocumentEntry>.Update.Set(e => e.Metadata, newMeta),
            cancellationToken: CancellationToken.None);

        // 写回 Run 的 OutputEntryId
        await db.DocumentStoreAgentRuns.UpdateOneAsync(
            r => r.Id == run.Id,
            Builders<DocumentStoreAgentRun>.Update
                .Set(r => r.OutputEntryId, newEntry.Id)
                .Set(r => r.Progress, 95),
            cancellationToken: CancellationToken.None);

        _logger.LogInformation("[doc-store-agent] Subtitle generated for {EntryId} → {NewEntryId}, {Len} chars",
            entry.Id, newEntry.Id, subtitleMd.Length);
    }

    // ──────────────────────────────────────────────────────
    // 音视频 ASR
    // ──────────────────────────────────────────────────────

    private async Task<List<SubtitleSegment>> TranscribeAudioOrVideoAsync(
        DocumentStoreAgentRun run,
        MongoDbContext db,
        IRunEventStore runStore,
        string fileUrl,
        bool isVideo)
    {
        await UpdateProgressAsync(db, runStore, run, 20, "下载素材");
        var http = _httpClientFactory.CreateClient("DocStoreAgent");
        http.Timeout = TimeSpan.FromMinutes(5);
        var bytes = await http.GetByteArrayAsync(fileUrl);

        await UpdateProgressAsync(db, runStore, run, 35, isVideo ? "提取音轨" : "解析音频");

        // 如果是视频，先用 ffmpeg 抽音频；音频直接交给 DoubaoStreamAsrService（内部会自动 ffmpeg 兜底）
        if (isVideo)
            bytes = await ExtractAudioWithFfmpegAsync(bytes);

        // 解析 ASR 模型（不再硬编码豆包流式）
        //
        // 调度策略：
        //   1) 先用 expectedModel="whisper-large-v3" 优先尝试 OpenAI 兼容 Whisper（绕开豆包 sauc 资源 401）
        //      ⇒ 命中且非 Exchange → 走 HTTP /v1/audio/transcriptions 路径
        //   2) 未命中 / Whisper 不可用 → 降级到默认调度（保留豆包 / 其他 ASR 配置）
        //
        // 历史背景（2026-05-08）：用户的豆包 access key 仅在 volc.seedasr.auc 资源开通，
        //   流式 sauc 资源未授权 → 字幕生成走豆包流式必 401。让 whisper 优先即可绕开。
        //   未来这个 preferred model 名应做成配置项（IConfiguration "Asr:PreferredModel"），
        //   现阶段先 hard-code 让用户能立刻测。
        const string preferredAsrModel = "whisper-large-v3";

        var resolution = await _modelResolver.ResolveAsync(
            AppCallerRegistry.DocumentStoreAgent.Subtitle.Audio,
            ModelTypes.Asr,
            expectedModel: preferredAsrModel);

        var preferredHit = resolution.Success
            && !resolution.IsExchange
            && string.Equals(resolution.ActualModel, preferredAsrModel, StringComparison.OrdinalIgnoreCase);

        if (preferredHit)
        {
            _logger.LogInformation(
                "[doc-store-agent] ASR 优先选 {Preferred} 命中: model={Actual} platform={Platform}",
                preferredAsrModel, resolution.ActualModel, resolution.ActualPlatformName);
        }
        else
        {
            _logger.LogInformation(
                "[doc-store-agent] ASR 优先选 {Preferred} 未命中（success={Ok} isExchange={IsX} actual={Actual}），降级默认调度",
                preferredAsrModel, resolution.Success, resolution.IsExchange, resolution.ActualModel);
            // 默认调度（不带 expectedModel） — 取回原本的优先级体系
            resolution = await _modelResolver.ResolveAsync(
                AppCallerRegistry.DocumentStoreAgent.Subtitle.Audio, ModelTypes.Asr);
        }

        if (!resolution.Success)
            throw new SubtitleAsrException(
                $"ASR 模型调度失败: {resolution.ErrorMessage}",
                BuildResolverDiagnostic(resolution, "调度失败"));

        await UpdateProgressAsync(db, runStore, run, 50, "识别中");

        // 三路分发（参考 TranscriptRunWorker.cs:159-192）
        if (resolution.IsExchange)
        {
            switch (resolution.ExchangeTransformerType)
            {
                case "doubao-asr-stream":
                    return await TranscribeViaDoubaoStreamAsync(run, db, runStore, bytes, resolution);

                case "doubao-asr":
                    return await TranscribeViaGatewayAsync(run, bytes, resolution.ToGatewayResolution(),
                        new Dictionary<string, object>
                        {
                            // doubao-asr 异步模式：Gateway 内部走 IAsyncExchangeTransformer 轮询
                        });

                default:
                    throw new SubtitleAsrException(
                        $"字幕生成未支持的 Exchange 转换器类型: '{resolution.ExchangeTransformerType}'。\n" +
                        $"  当前模型: {resolution.ActualModel ?? "未知"}（Exchange={resolution.ExchangeName}）\n" +
                        $"  支持的类型: doubao-asr-stream（WebSocket 流式）, doubao-asr（HTTP 异步）, 或非 Exchange 的 OpenAI 兼容 Whisper。\n" +
                        "  解决方案：把模型池绑到上述任一类型的 Exchange，或换用 Whisper（HTTP /v1/audio/transcriptions）。",
                        BuildResolverDiagnostic(resolution, "Exchange 类型不支持"));
            }
        }

        // 非 Exchange 模型 → 走 Whisper HTTP（OpenAI 兼容 /v1/audio/transcriptions）
        _logger.LogInformation(
            "[doc-store-agent] 走 Whisper HTTP 路径: model={Model} platform={Platform}",
            resolution.ActualModel, resolution.ActualPlatformName);
        return await TranscribeViaGatewayAsync(run, bytes, resolution.ToGatewayResolution(),
            new Dictionary<string, object>
            {
                ["model"] = resolution.ActualModel ?? "whisper-1",
                ["response_format"] = "verbose_json",
                ["timestamp_granularities[]"] = "segment",
                ["language"] = ""
            });
    }

    // ──────────────────────────────────────────────────────
    // 路径 A：豆包 WebSocket 流式 ASR
    // ──────────────────────────────────────────────────────

    private async Task<List<SubtitleSegment>> TranscribeViaDoubaoStreamAsync(
        DocumentStoreAgentRun run,
        MongoDbContext db,
        IRunEventStore runStore,
        byte[] bytes,
        ModelResolutionResult resolution)
    {
        // 解析 appKey|accessKey
        var apiKey = resolution.ApiKey ?? "";
        string appKey = "", accessKey = apiKey;
        if (apiKey.Contains('|'))
        {
            var parts = apiKey.Split('|', 2);
            appKey = parts[0];
            accessKey = parts[1];
        }
        var wsUrl = resolution.ApiUrl ?? "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel";
        var config = resolution.ExchangeTransformerConfig ?? new Dictionary<string, object>
        {
            ["resourceId"] = "volc.bigasr.sauc.duration",
            ["enableItn"] = true,
            ["enablePunc"] = true,
            ["enableDdc"] = true,
        };

        var result = await _streamAsr.TranscribeWithCallbackAsync(
            wsUrl, appKey, accessKey, bytes, config,
            onStage: async (stage, msg) =>
            {
                _logger.LogInformation("[doc-store-agent] StreamASR {Stage}: {Msg}", stage, msg);
                await Task.CompletedTask;
            },
            onProgress: async (sent, total) =>
            {
                var pct = 50 + (int)(30.0 * sent / Math.Max(total, 1));
                await UpdateProgressAsync(db, runStore, run, Math.Min(pct, 80), "识别中");
            },
            onFrame: async (_, __, ___) => { await Task.CompletedTask; },
            ct: CancellationToken.None);

        if (!result.Success)
        {
            // 把 DoubaoStreamAsrService 的 AsrDiagnostic 升级为 SubtitleDiagnostic
            throw new SubtitleAsrException(
                $"ASR 失败: {result.Error}",
                BuildStreamDiagnostic(resolution, result));
        }

        // 从最后一帧提取带时间戳的 utterances
        var segments = new List<SubtitleSegment>();
        var lastResponse = result.Responses.LastOrDefault(r => r.PayloadMsg != null);
        if (lastResponse?.PayloadMsg != null)
        {
            try
            {
                var payload = lastResponse.PayloadMsg.Value;
                if (payload.TryGetProperty("result", out var res) &&
                    res.TryGetProperty("utterances", out var utts) &&
                    utts.ValueKind == System.Text.Json.JsonValueKind.Array)
                {
                    foreach (var utt in utts.EnumerateArray())
                    {
                        var text = utt.TryGetProperty("text", out var t) ? t.GetString() ?? "" : "";
                        if (string.IsNullOrWhiteSpace(text)) continue;
                        double startMs = utt.TryGetProperty("start_time", out var st) ? st.GetDouble() : 0;
                        double endMs = utt.TryGetProperty("end_time", out var et) ? et.GetDouble() : 0;
                        segments.Add(new SubtitleSegment(startMs / 1000.0, endMs / 1000.0, text.Trim()));
                    }
                }
            }
            catch { /* fall through to FullText */ }
        }
        if (segments.Count == 0 && !string.IsNullOrEmpty(result.FullText))
        {
            segments.Add(new SubtitleSegment(0, 0, result.FullText));
        }
        return segments;
    }

    // ──────────────────────────────────────────────────────
    // 路径 B：Whisper / 异步豆包，统一走 LlmGateway HTTP
    // ──────────────────────────────────────────────────────

    private async Task<List<SubtitleSegment>> TranscribeViaGatewayAsync(
        DocumentStoreAgentRun run,
        byte[] audioBytes,
        GatewayModelResolution gwResolution,
        Dictionary<string, object> multipartFields)
    {
        // 不要在 multipart 里暴露空 model/language（OpenAI 严格模式会拒）
        if (multipartFields.TryGetValue("language", out var lang) && lang is string s && string.IsNullOrEmpty(s))
            multipartFields.Remove("language");

        var rawRequest = new GatewayRawRequest
        {
            AppCallerCode = AppCallerRegistry.DocumentStoreAgent.Subtitle.Audio,
            ModelType = ModelTypes.Asr,
            EndpointPath = "/v1/audio/transcriptions",
            IsMultipart = true,
            MultipartFields = multipartFields,
            MultipartFiles = new Dictionary<string, (string FileName, byte[] Content, string MimeType)>
            {
                ["file"] = ("audio.wav", audioBytes, "audio/wav")
            },
            TimeoutSeconds = 600,
            Context = new GatewayRequestContext { UserId = run.UserId }
        };

        var rawResp = await _llmGateway.SendRawWithResolutionAsync(rawRequest, gwResolution, CancellationToken.None);

        if (rawResp?.Success != true || rawResp.Content == null)
        {
            var detail = rawResp?.ErrorMessage ?? rawResp?.Content ?? "无响应";
            var rawSnippet = rawResp?.Content?.Length > 800 ? rawResp.Content[..800] : (rawResp?.Content ?? "");
            _logger.LogWarning(
                "[doc-store-agent] Whisper/HTTP ASR 失败: status={Status} err={Err} content={Content}",
                rawResp?.StatusCode, rawResp?.ErrorMessage, rawSnippet);

            throw new SubtitleAsrException(
                $"Whisper/HTTP ASR 调用失败: {detail}",
                BuildHttpDiagnostic(gwResolution, rawResp, multipartFields));
        }

        // 解析 OpenAI 兼容 verbose_json 格式
        var segments = new List<SubtitleSegment>();
        try
        {
            using var jdoc = JsonDocument.Parse(rawResp.Content);
            var root = jdoc.RootElement;
            if (root.TryGetProperty("segments", out var segsArr) && segsArr.ValueKind == JsonValueKind.Array)
            {
                foreach (var seg in segsArr.EnumerateArray())
                {
                    var start = seg.TryGetProperty("start", out var st) ? st.GetDouble() : 0;
                    var end = seg.TryGetProperty("end", out var et) ? et.GetDouble() : 0;
                    var text = (seg.TryGetProperty("text", out var t) ? t.GetString() : "") ?? "";
                    if (!string.IsNullOrWhiteSpace(text))
                        segments.Add(new SubtitleSegment(start, end, text.Trim()));
                }
            }
            // 没有 segments 数组就用 text 兜底
            if (segments.Count == 0 && root.TryGetProperty("text", out var ft))
            {
                var fullText = ft.GetString() ?? "";
                if (!string.IsNullOrWhiteSpace(fullText))
                    segments.Add(new SubtitleSegment(0, 0, fullText));
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[doc-store-agent] Whisper 响应解析失败");
        }

        return segments;
    }

    // ──────────────────────────────────────────────────────
    // 诊断构造（异常时一律附 diagnostic 给前端）
    // ──────────────────────────────────────────────────────

    private static Dictionary<string, object?> BuildResolverDiagnostic(
        ModelResolutionResult resolution, string stage)
    {
        return new Dictionary<string, object?>
        {
            ["stage"] = stage,
            ["model"] = resolution.ActualModel,
            ["platformId"] = resolution.ActualPlatformId,
            ["platformName"] = resolution.ActualPlatformName,
            ["isExchange"] = resolution.IsExchange,
            ["exchangeName"] = resolution.ExchangeName,
            ["exchangeTransformerType"] = resolution.ExchangeTransformerType,
            ["resolverError"] = resolution.ErrorMessage,
        };
    }

    private static Dictionary<string, object?> BuildStreamDiagnostic(
        ModelResolutionResult resolution, StreamAsrResult result)
    {
        return new Dictionary<string, object?>
        {
            ["stage"] = "doubao-asr-stream",
            ["model"] = resolution.ActualModel,
            ["platformId"] = resolution.ActualPlatformId,
            ["platformName"] = resolution.ActualPlatformName,
            ["exchangeName"] = resolution.ExchangeName,
            ["exchangeTransformerType"] = resolution.ExchangeTransformerType,
            ["wsUrl"] = result.Diagnostic.WsUrl,
            ["resourceId"] = result.Diagnostic.ResourceId,
            ["requestId"] = result.Diagnostic.RequestId,
            ["appKeyPreview"] = result.Diagnostic.AppKeyPreview,
            ["accessKeyPreview"] = result.Diagnostic.AccessKeyPreview,
            ["authMode"] = result.Diagnostic.AuthMode,
            ["audio"] = result.Diagnostic.Audio,
            ["handshakeStatusCode"] = result.Diagnostic.HandshakeStatusCode,
            ["rawErrorChain"] = result.Diagnostic.RawErrorChain,
            ["friendlyError"] = result.Diagnostic.FriendlyError,
            ["wscatCommand"] = result.Diagnostic.WscatCommand,
        };
    }

    private static Dictionary<string, object?> BuildHttpDiagnostic(
        GatewayModelResolution gwResolution, GatewayRawResponse? rawResp, Dictionary<string, object> fields)
    {
        return new Dictionary<string, object?>
        {
            ["stage"] = "whisper-http",
            ["model"] = gwResolution?.ActualModel,
            ["platformId"] = gwResolution?.ActualPlatformId,
            ["platformName"] = gwResolution?.ActualPlatformName,
            ["endpoint"] = "/v1/audio/transcriptions",
            ["multipartFields"] = fields,
            ["statusCode"] = rawResp?.StatusCode,
            ["error"] = rawResp?.ErrorMessage,
            ["responseSnippet"] = (rawResp?.Content?.Length ?? 0) > 800 ? rawResp!.Content![..800] : rawResp?.Content,
        };
    }

    /// <summary>
    /// 用 ffmpeg 从视频中抽音频（16kHz mono wav）。依赖 /usr/local/bin/ffmpeg（host 挂载）。
    /// </summary>
    private async Task<byte[]> ExtractAudioWithFfmpegAsync(byte[] videoBytes)
    {
        var tmpIn = Path.Combine(Path.GetTempPath(), $"dsagent-in-{Guid.NewGuid():N}");
        var tmpOut = Path.Combine(Path.GetTempPath(), $"dsagent-out-{Guid.NewGuid():N}.wav");
        await File.WriteAllBytesAsync(tmpIn, videoBytes);
        try
        {
            var psi = new System.Diagnostics.ProcessStartInfo
            {
                FileName = "ffmpeg",
                ArgumentList = { "-y", "-i", tmpIn, "-vn", "-ac", "1", "-ar", "16000", "-acodec", "pcm_s16le", tmpOut },
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            };
            using var process = System.Diagnostics.Process.Start(psi)
                ?? throw new InvalidOperationException("ffmpeg 启动失败");
            await process.WaitForExitAsync();
            if (process.ExitCode != 0)
            {
                var err = await process.StandardError.ReadToEndAsync();
                throw new InvalidOperationException($"ffmpeg 抽音频失败 (exit={process.ExitCode}): {err}");
            }
            return await File.ReadAllBytesAsync(tmpOut);
        }
        finally
        {
            try { if (File.Exists(tmpIn)) File.Delete(tmpIn); } catch { }
            try { if (File.Exists(tmpOut)) File.Delete(tmpOut); } catch { }
        }
    }

    // ──────────────────────────────────────────────────────
    // 图片 Vision 识别
    // ──────────────────────────────────────────────────────

    private async Task<string> RecognizeImageAsync(
        DocumentStoreAgentRun run,
        MongoDbContext db,
        IRunEventStore runStore,
        string fileUrl)
    {
        await UpdateProgressAsync(db, runStore, run, 30, "视觉识别中");

        var client = _llmGateway.CreateClient(
            AppCallerRegistry.DocumentStoreAgent.Subtitle.Vision,
            ModelTypes.Vision,
            maxTokens: 4096,
            temperature: 0.0);

        var systemPrompt = "你是图片直译助手。任务：把图片中的文字和视觉内容原样输出为纯文本。要求：" +
                           "1) 只做直译，不要总结、不要解释、不要修辞；" +
                           "2) 如图片中有文字（包括 OCR 识别），逐行输出；" +
                           "3) 如图片是场景图或无文字，简短客观地描述主要视觉元素；" +
                           "4) 输出纯文本，不要带任何 Markdown 标记；" +
                           "5) 不要添加任何说明性前言/结语。";

        var messages = new List<LLMMessage>
        {
            new()
            {
                Role = "user",
                Content = "请把这张图片的内容直译成文字。",
                Attachments = new List<LLMAttachment>
                {
                    new() { Type = "image", Url = fileUrl },
                },
            },
        };

        var sb = new StringBuilder();
        await foreach (var chunk in client.StreamGenerateAsync(systemPrompt, messages, CancellationToken.None))
        {
            if (chunk.Type == "delta" && !string.IsNullOrEmpty(chunk.Content))
            {
                sb.Append(chunk.Content);
            }
            else if (chunk.Type == "error")
            {
                throw new InvalidOperationException($"Vision 调用失败: {chunk.ErrorMessage}");
            }
        }
        return sb.ToString().Trim();
    }

    // ──────────────────────────────────────────────────────

    private static string BuildSubtitleTitle(string srcTitle)
    {
        var baseName = Path.GetFileNameWithoutExtension(srcTitle);
        if (string.IsNullOrWhiteSpace(baseName)) baseName = srcTitle;
        return $"{baseName}-字幕.md";
    }

    private static async Task UpdateProgressAsync(
        MongoDbContext db, IRunEventStore runStore, DocumentStoreAgentRun run,
        int progress, string phase)
    {
        await db.DocumentStoreAgentRuns.UpdateOneAsync(
            r => r.Id == run.Id,
            Builders<DocumentStoreAgentRun>.Update
                .Set(r => r.Progress, progress)
                .Set(r => r.Phase, phase),
            cancellationToken: CancellationToken.None);
        try
        {
            await runStore.AppendEventAsync(
                DocumentStoreRunKinds.Subtitle, run.Id, "progress",
                new { progress, phase }, ct: CancellationToken.None);
        }
        catch { /* ignore */ }
    }
}

public record SubtitleSegment(double StartSec, double EndSec, string Text);

/// <summary>
/// 字幕生成 ASR 阶段失败时抛出的异常，携带可观测的 diagnostic 数据，
/// 由 DocumentStoreAgentWorker.cs 的 catch 透传到 SSE error / run.errorMessage。
/// </summary>
public class SubtitleAsrException : Exception
{
    public IDictionary<string, object?> Diagnostic { get; }

    public SubtitleAsrException(string message, IDictionary<string, object?> diagnostic)
        : base(message)
    {
        Diagnostic = diagnostic;
    }
}
