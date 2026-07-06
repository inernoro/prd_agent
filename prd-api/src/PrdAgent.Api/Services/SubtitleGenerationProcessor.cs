using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
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
///   audio/*         → ILlmGateway ASR（支持 mp3/wav/m4a/ogg/flac，必要时 ffmpeg 转码）
///   video/*         → 下载后 ffmpeg 抽音频 → 走 ASR（ffmpeg 由 host 挂载，见 docker-compose.yml）
///   image/*         → ILlmGateway Vision 模型 → 直译图片文字
///   其他            → 不支持，直接失败
/// </summary>
public class SubtitleGenerationProcessor
{
    private readonly IModelResolver _modelResolver;
    private readonly ILlmGateway _llmGateway;
    private readonly IDocumentService _documentService;
    private readonly ILogger<SubtitleGenerationProcessor> _logger;
    private readonly IHttpClientFactory _httpClientFactory;

    public SubtitleGenerationProcessor(
        IModelResolver modelResolver,
        ILlmGateway llmGateway,
        IDocumentService documentService,
        IHttpClientFactory httpClientFactory,
        ILogger<SubtitleGenerationProcessor> logger)
    {
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
            // 让前端 DocBrowser 自动加「最近更新（24h 以内）」角标
            LastChangedAt = DateTime.UtcNow,
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

        // 如果是视频，先用 ffmpeg 抽音频；音频直接走 LLM Gateway ASR。
        if (isVideo)
            bytes = await ExtractAudioWithFfmpegAsync(bytes);

        // 解析 ASR 模型 —— 直接走默认调度，尊重模型池优先级
        //
        // 历史血泪 (2026-05-08)：
        //   c237e6d (跑通): 默认调度 → 模型池按你配的优先级选 → 命中 vveai/whisper → 14.9s 成功
        //   2f52eb0 (失败): 我多事加了 GetAvailablePoolsAsync 预筛 + ResolveAsync(expectedModel)
        //     → 走 ResolveAsync 第 5.5 步 FindPreferredModel 跟默认排序不同的路径
        //     → 选中"另一个" whisper-large-v3 实例（baseUrl 不同 / 健康判定不同）→ 暂不支持该接口
        //   教训：用户在管理后台配的优先级已经是 source of truth，不要在代码里二次干预。
        //
        // 谁来路由：用户 → 管理后台模型池配置（绑 AppCallerCode + 排优先级）
        // 谁来执行：ResolveAsync 的默认排序（HealthStatus → ModelGroup.Priority → Model.Priority）
        // 代码层只做：拿到结果 → 按 IsExchange / ExchangeTransformerType 分发到豆包流式 / Whisper HTTP
        var resolution = await _modelResolver.ResolveAsync(
            AppCallerRegistry.DocumentStoreAgent.Subtitle.Audio, ModelTypes.Asr);

        if (!resolution.Success)
            throw new SubtitleAsrException(
                $"ASR 模型调度失败: {resolution.ErrorMessage}",
                BuildResolverDiagnostic(resolution, "调度失败"));

        _logger.LogInformation(
            "[doc-store-agent] ASR 调度命中: model={Model} platform={Platform} isExchange={IsExchange} transformerType={Tt}",
            resolution.ActualModel, resolution.ActualPlatformName,
            resolution.IsExchange, resolution.ExchangeTransformerType);

        await UpdateProgressAsync(db, runStore, run, 50, "识别中");

        // 三路分发（参考 TranscriptRunWorker.cs:159-192）
        if (resolution.IsExchange)
        {
            switch (resolution.ExchangeTransformerType)
            {
                case "doubao-asr-stream":
                    throw new SubtitleAsrException(
                        "ASR 模型命中了 doubao-asr-stream，但 MAP 生产路径已禁止在 API 进程内直连豆包 WebSocket。"
                        + "请把该 AppCallerCode 绑定到 doubao-asr HTTP Exchange 或 OpenAI 兼容 Whisper ASR；"
                        + "WebSocket 流式 ASR 只有迁入 llmgw-serve 后才能重新启用。",
                        BuildResolverDiagnostic(resolution, "MAP 禁止 WebSocket ASR 直连"));

                case "doubao-asr":
                    // doubao-asr 异步模式 ≠ Whisper multipart：DoubaoAsrTransformer.TransformRequest
                    // 只读 standardBody 的 audio_url / audio_data / url 字段，**不读 multipart 文件**。
                    // Gateway.ConsolidateMultipartToJson 会把 multipart 文件转成 image_urls，
                    // 路径不通。必须把音频以 base64 audio_data 形式塞进 RequestBody。
                    // 参考：Bugbot + Codex 双 P1 review on PR #542 commit 9253b0f
                    return await TranscribeViaDoubaoAsyncJsonAsync(run, bytes, resolution);

                default:
                    throw new SubtitleAsrException(
                        $"字幕生成未支持的 Exchange 转换器类型: '{resolution.ExchangeTransformerType}'。\n" +
                        $"  当前模型: {resolution.ActualModel ?? "未知"}（Exchange={resolution.ExchangeName}）\n" +
                        $"  支持的类型: doubao-asr（HTTP 异步）, 或非 Exchange 的 OpenAI 兼容 Whisper。\n" +
                        "  解决方案：把模型池绑到上述任一类型的 Exchange，或换用 Whisper（HTTP /v1/audio/transcriptions）。",
                        BuildResolverDiagnostic(resolution, "Exchange 类型不支持"));
            }
        }

        // 多模态 chat 音频模型（OpenRouter openai/gpt-audio、gemini 等）→ 没有 Whisper /v1/audio/transcriptions
        // 端点，只能把音频以 input_audio 发到 /v1/chat/completions 让多模态模型逐字转写。
        if (IsChatAudioModel(resolution.ActualModel, resolution.PlatformType))
        {
            _logger.LogInformation(
                "[doc-store-agent] 走多模态 chat 音频转写路径: model={Model} platform={Platform}",
                resolution.ActualModel, resolution.ActualPlatformName);
            // chat-audio 端点对 input_audio.format 严格校验：统一转成 wav。视频上面已 ffmpeg 抽成 wav；
            // 上传的 audio/m4a、audio/mp3 此处补转，否则把非 wav 字节标成 "wav" 发给严格端点会失败/乱码（Bugbot Medium）。
            var chatAudioWav = isVideo ? bytes : await ExtractAudioWithFfmpegAsync(bytes);
            return await TranscribeViaChatAudioAsync(run, chatAudioWav, resolution.ToGatewayResolution());
        }

        // 非 Exchange 模型 → 走 Whisper HTTP（OpenAI 兼容 /v1/audio/transcriptions）
        //
        // multipart 字段：保持与 c237e6d (19:22 跑通版本) 完全一致。
        // 不要画蛇添足简化掉 response_format/timestamp_granularities[] —— vveai/gpt.ge 是宽容模式
        // 会忽略未识别字段，跑通过的配置不要动。简化反而踩到「audio.m4a → audio/mp4 不支持」的坑。
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
    // Whisper / 异步豆包，统一走 LlmGateway HTTP
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

        // 文件名+MIME：精确恢复 c237e6d (19:22 跑通版本) 的 audio.wav + audio/wav。
        // 不要按"实际格式贴 mime"原则改成 audio/m4a —— 用户 vveai 平台已实测：
        //   - audio.wav + audio/wav    → 19:22:15 跑通 (返回 14.9s 转录全文)
        //   - audio.m4a + audio/m4a    → 21:21:35 报 "Unsupported audio file type: audio/mp4"
        // 平台依赖 magic bytes 解码（你传 m4a 字节 + audio/wav 标签也能转录），mime 字段等同身份证不等同实际内容。
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
    // 路径 B2：多模态 chat 音频转写（OpenRouter gpt-audio / gemini 等，无 Whisper 端点）
    // 把音频 base64 作为 input_audio 发到 /v1/chat/completions，模型直接逐字转写。
    // 无逐句时间戳 → 返回单段（StartSec=EndSec=0）。
    // ──────────────────────────────────────────────────────

    private static bool IsChatAudioModel(string? model, string? platformType)
    {
        if (string.IsNullOrWhiteSpace(model)) return false;
        // 本路径发的是 OpenAI 形态请求（/v1/chat/completions + input_audio）。原生非 OpenAI 形态的
        // 平台不能走：claude/anthropic 走 ClaudeGatewayAdapter，请求体不同；google 原生 Gemini 用
        // v1beta/models/{model}:generateContent，端点与请求体都和 OpenAI 完全不同。把 OpenAI 形态
        // 请求发到这些原生端点会直接失败而非转写，所以仅 OpenAI 兼容平台可走（Codex P2）。
        // OpenRouter 等 OpenAI 兼容平台注册为 openai，照常生效。
        // 注意排除 google 与 gemini 两种 platformType——本仓库二者都指原生 Google 平台
        // （见 ImageGenPlatformAdapterFactory），走 v1beta generateContent，与 OpenAI 形态不兼容。
        var pt = (platformType ?? "").ToLowerInvariant();
        if (pt is "google" or "gemini" or "anthropic" or "claude") return false;
        var m = model.ToLowerInvariant();
        if (m.Contains("whisper")) return false;
        // 只认确实支持音频输入的多模态模型：名字含 audio（gpt-audio / gpt-4o-audio-preview /
        // qwen*-audio 等）或 gemini（原生支持音频）。不能用裸 gpt-4o 匹配——gpt-4o / gpt-4o-mini
        // 是文本+视觉模型，不接受 input_audio，会把这类 ASR 池绑定打挂（Bugbot Medium）。
        return m.Contains("audio") || m.Contains("gemini");
    }

    private async Task<List<SubtitleSegment>> TranscribeViaChatAudioAsync(
        DocumentStoreAgentRun run,
        byte[] audioBytes,
        GatewayModelResolution gwResolution)
    {
        var base64 = Convert.ToBase64String(audioBytes);
        var requestBody = new JsonObject
        {
            ["model"] = gwResolution.ActualModel,
            ["modalities"] = new JsonArray("text"),
            ["messages"] = new JsonArray
            {
                new JsonObject
                {
                    ["role"] = "user",
                    ["content"] = new JsonArray
                    {
                        new JsonObject
                        {
                            ["type"] = "text",
                            ["text"] = "请把这段音频逐字转写成文字，尽量一字不差保留原话。只输出转写出的文字本身，不要任何解释、说明或前后缀。",
                        },
                        new JsonObject
                        {
                            ["type"] = "input_audio",
                            ["input_audio"] = new JsonObject { ["data"] = base64, ["format"] = "wav" },
                        },
                    },
                },
            },
        };

        var rawRequest = new GatewayRawRequest
        {
            AppCallerCode = AppCallerRegistry.DocumentStoreAgent.Subtitle.Audio,
            ModelType = ModelTypes.Asr,
            EndpointPath = "/v1/chat/completions",
            IsMultipart = false,
            RequestBody = requestBody,
            TimeoutSeconds = 600,
            Context = new GatewayRequestContext { UserId = run.UserId },
        };

        var rawResp = await _llmGateway.SendRawWithResolutionAsync(rawRequest, gwResolution, CancellationToken.None);
        if (rawResp?.Success != true || string.IsNullOrWhiteSpace(rawResp.Content))
        {
            var detail = rawResp?.ErrorMessage ?? rawResp?.Content ?? "无响应";
            throw new SubtitleAsrException(
                $"多模态 chat 音频转写调用失败: {detail}",
                BuildHttpDiagnostic(gwResolution, rawResp, new Dictionary<string, object> { ["model"] = gwResolution.ActualModel ?? "" }));
        }

        var text = ExtractChatCompletionContent(rawResp.Content);
        // HTTP 成功但没解析出文字（模型拒答 / 响应结构异常 / 空内容）：必须当失败抛出，
        // 否则字幕生成会拿空文本生成一个"无内容"占位文档，把失败伪装成成功（Bugbot Medium）。
        if (string.IsNullOrWhiteSpace(text))
            throw new SubtitleAsrException(
                "多模态 chat 音频转写返回为空（模型可能拒答或响应格式异常）",
                BuildHttpDiagnostic(gwResolution, rawResp, new Dictionary<string, object>
                {
                    ["model"] = gwResolution.ActualModel ?? "",
                    ["reason"] = "empty-content",
                }));
        return new List<SubtitleSegment> { new(0, 0, text.Trim()) };
    }

    private static string ExtractChatCompletionContent(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            if (root.TryGetProperty("choices", out var choices)
                && choices.ValueKind == JsonValueKind.Array
                && choices.GetArrayLength() > 0
                && choices[0].TryGetProperty("message", out var msg)
                && msg.TryGetProperty("content", out var content))
            {
                if (content.ValueKind == JsonValueKind.String)
                    return content.GetString() ?? "";
                if (content.ValueKind == JsonValueKind.Array)
                {
                    var sb = new StringBuilder();
                    foreach (var p in content.EnumerateArray())
                        if (p.TryGetProperty("text", out var t) && t.ValueKind == JsonValueKind.String)
                            sb.Append(t.GetString());
                    return sb.ToString();
                }
            }
        }
        catch { /* 解析失败返回空 */ }
        return "";
    }

    // ──────────────────────────────────────────────────────
    // 路径 C：豆包异步 ASR (doubao-asr Exchange) —— JSON body，不走 multipart
    // DoubaoAsrTransformer 只读 standardBody.audio_url / audio_data / url
    // ──────────────────────────────────────────────────────

    private async Task<List<SubtitleSegment>> TranscribeViaDoubaoAsyncJsonAsync(
        DocumentStoreAgentRun run,
        byte[] audioBytes,
        ModelResolutionResult resolution)
    {
        var gwResolution = resolution.ToGatewayResolution();
        // 豆包异步 ASR 接受 base64 音频。模型字段 Gateway 会自动注入。
        var requestBody = new JsonObject
        {
            ["audio_data"] = Convert.ToBase64String(audioBytes),
        };

        var rawRequest = new GatewayRawRequest
        {
            AppCallerCode = AppCallerRegistry.DocumentStoreAgent.Subtitle.Audio,
            ModelType = ModelTypes.Asr,
            RequestBody = requestBody,
            IsMultipart = false,
            TimeoutSeconds = 600,
            Context = new GatewayRequestContext { UserId = run.UserId }
        };

        _logger.LogInformation(
            "[doc-store-agent] 走豆包异步 ASR JSON 路径: model={Model} bytes={Bytes}",
            resolution.ActualModel, audioBytes.Length);

        var rawResp = await _llmGateway.SendRawWithResolutionAsync(rawRequest, gwResolution, CancellationToken.None);

        if (rawResp?.Success != true || rawResp.Content == null)
        {
            var detail = rawResp?.ErrorMessage ?? rawResp?.Content ?? "无响应";
            throw new SubtitleAsrException(
                $"豆包异步 ASR 调用失败: {detail}",
                BuildHttpDiagnostic(gwResolution, rawResp, new Dictionary<string, object> { ["bodyShape"] = "audio_data(base64)" }));
        }

        // 豆包异步响应：result.utterances[] 含 start_time/end_time(毫秒) + text
        var segments = new List<SubtitleSegment>();
        try
        {
            using var jdoc = JsonDocument.Parse(rawResp.Content);
            var root = jdoc.RootElement;
            if (root.TryGetProperty("result", out var result)
                && result.TryGetProperty("utterances", out var utts)
                && utts.ValueKind == JsonValueKind.Array)
            {
                foreach (var u in utts.EnumerateArray())
                {
                    var startMs = u.TryGetProperty("start_time", out var s) ? s.GetDouble() : 0;
                    var endMs = u.TryGetProperty("end_time", out var e) ? e.GetDouble() : 0;
                    var text = (u.TryGetProperty("text", out var t) ? t.GetString() : "") ?? "";
                    if (!string.IsNullOrWhiteSpace(text))
                        segments.Add(new SubtitleSegment(startMs / 1000.0, endMs / 1000.0, text.Trim()));
                }
            }
            // 兜底：从 result.text 取整段文本（无时间戳）
            if (segments.Count == 0 && root.TryGetProperty("result", out var r2)
                && r2.TryGetProperty("text", out var ft))
            {
                var fullText = ft.GetString() ?? "";
                if (!string.IsNullOrWhiteSpace(fullText))
                    segments.Add(new SubtitleSegment(0, 0, fullText.Trim()));
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[doc-store-agent] 豆包异步 ASR 响应解析失败");
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
            // baseUrl 让用户直接看到我们打的是哪个域，方便核对模型池配置是否指向真支持 ASR 的服务
            ["baseUrl"] = gwResolution?.ApiUrl,
            ["endpoint"] = "/v1/audio/transcriptions",
            ["multipartFields"] = fields,
            ["statusCode"] = rawResp?.StatusCode,
            ["error"] = rawResp?.ErrorMessage,
            ["responseSnippet"] = (rawResp?.Content?.Length ?? 0) > 800 ? rawResp!.Content![..800] : rawResp?.Content,
            // 排查提示：当响应体含"暂不支持该接口/不支持/not supported"等字样时，多半是平台路由问题
            ["hint"] = "如错误为「暂不支持该接口」，请检查模型池的平台 baseUrl 是否指向真支持 /v1/audio/transcriptions 的服务（如 https://api.gpt.ge / api.openai.com / api.groq.com/openai）",
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
            // 必须在 WaitForExitAsync 之前并发开始读 stderr/stdout：ffmpeg 写 stderr 量大，
            // 长输入会把管道缓冲（约 64KB）写满后阻塞，而我们若先等退出再读就会与之死锁，
            // 任务卡在 running 永不返回（Codex P2，与 CapsuleExecutor ffmpeg 同模式）。
            var stderrTask = process.StandardError.ReadToEndAsync();
            var stdoutTask = process.StandardOutput.ReadToEndAsync();
            await process.WaitForExitAsync();
            var err = await stderrTask;
            await stdoutTask;
            if (process.ExitCode != 0)
                throw new InvalidOperationException($"ffmpeg 抽音频失败 (exit={process.ExitCode}): {err}");
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
