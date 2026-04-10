using System.Text;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Interfaces.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
// 避免 ILlmGateway 在两个命名空间冲突：只用类型别名导入 IModelResolver
using IModelResolver = PrdAgent.Infrastructure.LlmGateway.IModelResolver;

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

        // 解析 ASR 模型（豆包流式）
        var resolution = await _modelResolver.ResolveAsync(
            AppCallerRegistry.DocumentStoreAgent.Subtitle.Audio, ModelTypes.Asr);
        if (!resolution.Success)
            throw new InvalidOperationException($"ASR 模型调度失败: {resolution.ErrorMessage}");
        if (!resolution.IsExchange || resolution.ExchangeTransformerType != "doubao-asr-stream")
            throw new InvalidOperationException("当前仅支持豆包流式 ASR，请检查模型池配置");

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

        await UpdateProgressAsync(db, runStore, run, 50, "识别中");

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
