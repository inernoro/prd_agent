using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Interfaces.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
// 显式区分两个 ILlmGateway：
//   ILlmGateway          = Core 接口（CreateClient）
//   GatewayInfra         = Infrastructure 接口（SendRawWithResolutionAsync）
using IModelResolver = PrdAgent.Infrastructure.LlmGateway.IModelResolver;
using GatewayInfra = PrdAgent.Infrastructure.LlmGateway.ILlmGateway;
using GatewayRawRequest = PrdAgent.Infrastructure.LlmGateway.GatewayRawRequest;

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
    private readonly GatewayInfra _gatewayInfra;
    private readonly IDocumentService _documentService;
    private readonly ILogger<SubtitleGenerationProcessor> _logger;
    private readonly IHttpClientFactory _httpClientFactory;

    public SubtitleGenerationProcessor(
        DoubaoStreamAsrService streamAsr,
        IModelResolver modelResolver,
        ILlmGateway llmGateway,
        GatewayInfra gatewayInfra,
        IDocumentService documentService,
        IHttpClientFactory httpClientFactory,
        ILogger<SubtitleGenerationProcessor> logger)
    {
        _streamAsr = streamAsr;
        _modelResolver = modelResolver;
        _llmGateway = llmGateway;
        _gatewayInfra = gatewayInfra;
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

        // 解析 ASR 模型（按模型池配置分流：豆包流式 / OpenAI 兼容多模态 chat）
        var resolution = await _modelResolver.ResolveAsync(
            AppCallerRegistry.DocumentStoreAgent.Subtitle.Audio, ModelTypes.Asr);
        if (!resolution.Success)
            throw new InvalidOperationException($"ASR 模型调度失败: {resolution.ErrorMessage}");

        await UpdateProgressAsync(db, runStore, run, 50, "识别中");

        // 路径 A：豆包流式 ASR（带时间戳逐句）
        if (resolution.IsExchange && resolution.ExchangeTransformerType == "doubao-asr-stream")
        {
            return await TranscribeViaDoubaoStreamAsync(run, db, runStore, bytes, resolution);
        }

        // 路径 B：OpenAI 兼容多模态 chat 做 ASR（OpenRouter Gemini / GPT-4o-audio 等）
        // 该路径无逐句时间戳，输出整段文字。
        return await TranscribeViaChatCompletionsAsync(run, db, runStore, bytes, resolution);
    }

    /// <summary>路径 A：豆包流式 ASR（WebSocket，逐句带时间戳）。</summary>
    private async Task<List<SubtitleSegment>> TranscribeViaDoubaoStreamAsync(
        DocumentStoreAgentRun run,
        MongoDbContext db,
        IRunEventStore runStore,
        byte[] bytes,
        PrdAgent.Infrastructure.LlmGateway.ModelResolutionResult resolution)
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
            throw new InvalidOperationException($"ASR 失败: {result.Error}");

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
                    utts.ValueKind == JsonValueKind.Array)
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

    /// <summary>
    /// 路径 B：通过 OpenAI 兼容平台的 chat/completions 端点做 ASR（多模态音频输入）。
    /// 适配 OpenRouter Gemini 2.5 Flash / GPT-4o-audio-preview 等接受 input_audio 内容块的多模态模型。
    /// 输出：整段纯文本（无逐句时间戳）。
    /// </summary>
    private async Task<List<SubtitleSegment>> TranscribeViaChatCompletionsAsync(
        DocumentStoreAgentRun run,
        MongoDbContext db,
        IRunEventStore runStore,
        byte[] bytes,
        PrdAgent.Infrastructure.LlmGateway.ModelResolutionResult resolution)
    {
        // OpenRouter / OpenAI 多模态音频普遍接受 mp3/wav，对 m4a/aac 兼容性差。
        // 统一用 ffmpeg 转成 16kHz mono mp3，体积小且全平台稳定。
        await UpdateProgressAsync(db, runStore, run, 45, "音频转码");
        var mp3Bytes = await ConvertToMp3WithFfmpegAsync(bytes);
        var base64 = Convert.ToBase64String(mp3Bytes);

        await UpdateProgressAsync(db, runStore, run, 60, "识别中");

        var systemPrompt = "你是音频转写助手。请把用户提供的音频内容完整、忠实地转写成文字。要求：" +
                           "1) 只输出转写正文，不要总结、不要解释、不要修辞；" +
                           "2) 保留原话语序，按自然语句分段（一行一句或一段）；" +
                           "3) 如有多人对话，可在每行前用「说话人 A：」「说话人 B：」标注；" +
                           "4) 如内容含中英文混合，按原文保留；" +
                           "5) 不要添加任何前言/结语/Markdown 标记。";

        // 构造 OpenAI 兼容 chat/completions 多模态 body
        var requestBody = new JsonObject
        {
            ["model"] = resolution.ActualModel,
            ["messages"] = new JsonArray
            {
                new JsonObject
                {
                    ["role"] = "system",
                    ["content"] = systemPrompt,
                },
                new JsonObject
                {
                    ["role"] = "user",
                    ["content"] = new JsonArray
                    {
                        new JsonObject
                        {
                            ["type"] = "text",
                            ["text"] = "请把这段音频转写成文字。",
                        },
                        new JsonObject
                        {
                            ["type"] = "input_audio",
                            ["input_audio"] = new JsonObject
                            {
                                ["data"] = base64,
                                ["format"] = "mp3",
                            },
                        },
                    },
                },
            },
            ["temperature"] = 0.0,
            ["stream"] = false,
        };

        var rawRequest = new GatewayRawRequest
        {
            AppCallerCode = AppCallerRegistry.DocumentStoreAgent.Subtitle.Audio,
            ModelType = ModelTypes.Asr,
            ExpectedModel = resolution.ActualModel,
            RequestBody = requestBody,
            TimeoutSeconds = 600,
        };

        var gwResolution = resolution.ToGatewayResolution();
        var response = await _gatewayInfra.SendRawWithResolutionAsync(
            rawRequest, gwResolution, CancellationToken.None);

        if (!response.Success || string.IsNullOrEmpty(response.Content))
        {
            var errMsg = response.ErrorMessage ?? "上游无响应";
            throw new InvalidOperationException($"多模态 ASR 调用失败: {errMsg}");
        }

        var text = ExtractChatText(response.Content);
        if (string.IsNullOrWhiteSpace(text))
            throw new InvalidOperationException("多模态 ASR 返回空文本，请检查模型是否支持音频输入");

        await UpdateProgressAsync(db, runStore, run, 80, "识别中");

        return new List<SubtitleSegment> { new(0, 0, text.Trim()) };
    }

    /// <summary>从 OpenAI chat/completions JSON 响应里提取 choices[0].message.content。</summary>
    private static string ExtractChatText(string responseJson)
    {
        try
        {
            using var doc = JsonDocument.Parse(responseJson);
            if (doc.RootElement.TryGetProperty("choices", out var choices) &&
                choices.ValueKind == JsonValueKind.Array &&
                choices.GetArrayLength() > 0)
            {
                var first = choices[0];
                if (first.TryGetProperty("message", out var message) &&
                    message.TryGetProperty("content", out var content))
                {
                    // content 可能是字符串，也可能是数组（多模态 content 块）
                    if (content.ValueKind == JsonValueKind.String)
                        return content.GetString() ?? "";

                    if (content.ValueKind == JsonValueKind.Array)
                    {
                        var sb = new StringBuilder();
                        foreach (var part in content.EnumerateArray())
                        {
                            if (part.TryGetProperty("text", out var t) && t.ValueKind == JsonValueKind.String)
                                sb.Append(t.GetString());
                        }
                        return sb.ToString();
                    }
                }
            }
        }
        catch
        {
            // 解析失败兜底返回原文（不抛异常）
        }
        return "";
    }

    /// <summary>用 ffmpeg 把任意音频转成 16kHz mono mp3（体积小、跨平台兼容性好）。</summary>
    private async Task<byte[]> ConvertToMp3WithFfmpegAsync(byte[] inputBytes)
    {
        var tmpIn = Path.Combine(Path.GetTempPath(), $"asr-in-{Guid.NewGuid():N}");
        var tmpOut = Path.Combine(Path.GetTempPath(), $"asr-out-{Guid.NewGuid():N}.mp3");
        await File.WriteAllBytesAsync(tmpIn, inputBytes);
        try
        {
            var psi = new System.Diagnostics.ProcessStartInfo
            {
                FileName = "ffmpeg",
                ArgumentList = { "-y", "-i", tmpIn, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k", tmpOut },
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
                throw new InvalidOperationException($"ffmpeg 转码失败 (exit={process.ExitCode}): {err}");
            }
            return await File.ReadAllBytesAsync(tmpOut);
        }
        finally
        {
            try { if (File.Exists(tmpIn)) File.Delete(tmpIn); } catch { }
            try { if (File.Exists(tmpOut)) File.Delete(tmpOut); } catch { }
        }
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
