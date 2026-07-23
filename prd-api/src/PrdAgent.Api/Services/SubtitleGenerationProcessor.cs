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
///   audio/*         → ffmpeg 规范化为 16kHz mono WAV → ILlmGateway ASR
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
    private readonly ILLMRequestContextAccessor _llmCtx;
    private readonly ContentReprocessApplyService _applyService;

    public SubtitleGenerationProcessor(
        IModelResolver modelResolver,
        ILlmGateway llmGateway,
        IDocumentService documentService,
        IHttpClientFactory httpClientFactory,
        ILLMRequestContextAccessor llmCtx,
        ContentReprocessApplyService applyService,
        ILogger<SubtitleGenerationProcessor> logger)
    {
        _modelResolver = modelResolver;
        _llmGateway = llmGateway;
        _documentService = documentService;
        _httpClientFactory = httpClientFactory;
        _llmCtx = llmCtx;
        _applyService = applyService;
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

        // 源 entry metadata 标记"已生成字幕"。定点 $set 单个键而非整字典回写：
        // 与转录处理器并行时整字典回写会互相覆盖对方的键（Codex P2 lost-update）。
        var subtitleMetaUpdate = entry.Metadata == null
            ? Builders<DocumentEntry>.Update.Set(e => e.Metadata, new Dictionary<string, string> { ["subtitle_entry_id"] = newEntry.Id })
            : Builders<DocumentEntry>.Update.Set(e => e.Metadata["subtitle_entry_id"], newEntry.Id);
        await db.DocumentEntries.UpdateOneAsync(
            e => e.Id == entry.Id,
            subtitleMetaUpdate,
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

    /// <summary>
    /// 录音转录（kind = transcribe）：默认只做 ASR 并原地写回原文。
    /// 只有请求显式携带整理方式时才继续调用 LLM；录音、原文与可选整理结果始终共用同一文档。
    /// </summary>
    public async Task ProcessTranscribeAsync(DocumentStoreAgentRun run, MongoDbContext db, IRunEventStore runStore)
    {
        // 「换个整理方式」：跳过 ASR，用原 run 的转录文本按新风格重生成摘要并更新原笔记
        if (!string.IsNullOrEmpty(run.RestyleOfRunId))
        {
            await ProcessRestyleAsync(run, db, runStore);
            return;
        }

        var entry = await db.DocumentEntries.Find(e => e.Id == run.SourceEntryId).FirstOrDefaultAsync();
        if (entry == null)
            throw new InvalidOperationException("源文档条目不存在");
        if (entry.IsFolder)
            throw new InvalidOperationException("文件夹不支持转录");

        var contentType = (entry.ContentType ?? "").ToLowerInvariant();
        var isAudio = contentType.StartsWith("audio/");
        var isVideo = contentType.StartsWith("video/");
        if (!isAudio && !isVideo)
            throw new InvalidOperationException($"不支持的文件类型: {contentType}（转录仅支持音频/视频）");

        string? fileUrl = null;
        if (!string.IsNullOrEmpty(entry.AttachmentId))
        {
            var att = await db.Attachments.Find(a => a.AttachmentId == entry.AttachmentId).FirstOrDefaultAsync();
            fileUrl = att?.Url;
        }
        if (string.IsNullOrEmpty(fileUrl))
            throw new InvalidOperationException("源文件 URL 不可用（可能未上传到 COS）");

        await UpdateProgressAsync(db, runStore, run, 10, "准备中");

        // 1) ASR 转录（共用字幕生成的三路分发：豆包流式 / 豆包异步 / Whisper HTTP / chat-audio）
        var segments = await TranscribeAudioOrVideoAsync(run, db, runStore, fileUrl, isVideo);
        var transcriptPlain = string.Join("\n", segments
            .Where(s => !string.IsNullOrWhiteSpace(s.Text))
            .Select(s => s.Text.Trim()));
        if (string.IsNullOrWhiteSpace(transcriptPlain))
            throw new InvalidOperationException("转录结果为空（音频可能无人声或识别失败）");
        // 静音/拒答守卫：静音音频喂给多模态转写模型时，模型可能把转写指令当聊天回答
        // （真实事故 2026-07-12：静音录音产出"好的，请播放音频，我会逐字转写"并被存成笔记）。
        // 极短文本 + 命中拒答/寒暄模式 → 判定无有效语音，友好失败而不是落一篇垃圾笔记。
        if (TranscribeNoteText.LooksLikeNoSpeech(transcriptPlain))
            throw new InvalidOperationException(
                "未检测到有效语音内容：录音可能是静音、音量过低或没有人声。请靠近麦克风重新录制。");

        // 2) 可选整理。默认录音链路不调用 LLM，先把原文最快交给用户；
        // 只有用户显式选择了整理方式（TemplateKey 非空）才生成整理结果。
        var summary = "";
        if (!string.IsNullOrWhiteSpace(run.TemplateKey))
        {
            await UpdateProgressAsync(db, runStore, run, 70, "生成摘要");
            try
            {
                summary = await SummarizeTranscriptAsync(run, runStore, entry.Title, transcriptPlain);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[doc-store-agent] 转录整理生成失败，降级为仅保存原文 run={RunId}", run.Id);
                try
                {
                    await runStore.AppendEventAsync(
                        DocumentStoreRunKinds.Transcribe, run.Id, "summaryError",
                        new { message = ex.Message.Length > 300 ? ex.Message[..300] : ex.Message },
                        ct: CancellationToken.None);
                }
                catch { /* ignore */ }
            }
        }

        await UpdateProgressAsync(db, runStore, run, 90, "写入中");

        // 3) 落库：转录全文原地写回源音频 entry；整理结果存在时才附加。
        // DocumentEntry 允许 AttachmentId + DocumentId 并存：前者继续负责播放，后者承载正文。
        var noteMd = SubtitleFormatter.FormatTranscriptNote(entry.Title, summary, segments);
        await _applyService.SaveContentAsync(
            entry, noteMd, run.UserId, db, preserveFileIdentity: true);

        // 源音频 entry 标记「转录已写入本页」；值就是自身 Id，兼容旧前端读取同一 metadata key。
        // 定点 $set 单个键而非整字典回写：字幕/转录两个处理器可能并行更新同一 entry 的
        // Metadata，整字典回写会用加载时的旧快照覆盖掉对方刚写入的键（Codex P2 lost-update）。
        // 旧数据 Metadata 可能是 BSON null（dotted $set 会失败），此时整字典写入无并发丢失风险。
        var selectedStyleKey = string.IsNullOrWhiteSpace(run.TemplateKey)
            ? null
            : TranscribeStyleRegistry.Find(run.TemplateKey)?.Key ?? TranscribeStyleRegistry.DefaultKey;
        var metaUpdate = entry.Metadata == null
            ? Builders<DocumentEntry>.Update.Set(e => e.Metadata, new Dictionary<string, string>
            {
                ["transcribe_entry_id"] = entry.Id,
                ["generated_kind"] = "transcribe",
            })
            : Builders<DocumentEntry>.Update.Combine(
                Builders<DocumentEntry>.Update.Set(e => e.Metadata["transcribe_entry_id"], entry.Id),
                Builders<DocumentEntry>.Update.Set(e => e.Metadata["generated_kind"], "transcribe"),
                selectedStyleKey == null
                    ? Builders<DocumentEntry>.Update.Unset(e => e.Metadata["transcribe_style_key"])
                    : Builders<DocumentEntry>.Update.Set(e => e.Metadata["transcribe_style_key"], selectedStyleKey));
        await db.DocumentEntries.UpdateOneAsync(
            e => e.Id == entry.Id,
            metaUpdate,
            cancellationToken: CancellationToken.None);

        await db.DocumentStores.UpdateOneAsync(
            s => s.Id == entry.StoreId,
            Builders<DocumentStore>.Update.Set(s => s.UpdatedAt, DateTime.UtcNow),
            cancellationToken: CancellationToken.None);

        await db.DocumentStoreAgentRuns.UpdateOneAsync(
            r => r.Id == run.Id,
            Builders<DocumentStoreAgentRun>.Update
                .Set(r => r.OutputEntryId, entry.Id)
                .Set(r => r.GeneratedText, summary)
                // 存转录纯文本：「换个整理方式」免重跑 ASR 的一级数据源（超长截断防 run 文档膨胀）
                .Set(r => r.TranscriptText, transcriptPlain.Length > 60000 ? transcriptPlain[..60000] : transcriptPlain)
                .Set(r => r.Progress, 95),
            cancellationToken: CancellationToken.None);

        _logger.LogInformation(
            "[doc-store-agent] Transcript written in place for {EntryId}, transcript={TLen} chars summary={SLen} chars",
            entry.Id, transcriptPlain.Length, summary.Length);
    }

    /// <summary>
    /// 「换个整理方式」（restyle）：不重跑 ASR，用原转录文本按新风格重生成摘要，
    /// 原地更新原笔记 entry 的「摘要」小节（走版本快照，可从历史撤销），转录全文保持不动。
    /// </summary>
    private async Task ProcessRestyleAsync(DocumentStoreAgentRun run, MongoDbContext db, IRunEventStore runStore)
    {
        var prior = await db.DocumentStoreAgentRuns.Find(r => r.Id == run.RestyleOfRunId).FirstOrDefaultAsync();
        if (prior == null || string.IsNullOrEmpty(prior.OutputEntryId))
            throw new InvalidOperationException("原转录任务不存在或尚未产出笔记");

        var noteEntry = await db.DocumentEntries.Find(e => e.Id == prior.OutputEntryId).FirstOrDefaultAsync();
        if (noteEntry == null)
            throw new InvalidOperationException("转录笔记已被删除，无法重新整理");

        await UpdateProgressAsync(db, runStore, run, 20, "准备中");
        var noteMd = await _applyService.LoadContentAsync(noteEntry);

        // 笔记正文是用户可编辑的权威原文：优先读取当前「转录全文」，run 快照只做老数据兜底。
        // 否则用户刚校对的内容会在下一次一键整理时被旧 ASR 快照悄悄覆盖语义。
        var transcript = TranscribeNoteText.ExtractTranscriptFromNote(noteMd);
        if (string.IsNullOrWhiteSpace(transcript)) transcript = prior.TranscriptText;
        if (string.IsNullOrWhiteSpace(transcript))
            throw new InvalidOperationException("找不到原转录文本（笔记可能被改动过），请对源音频重新发起转录");

        await UpdateProgressAsync(db, runStore, run, 40, "生成摘要");
        var summary = await SummarizeTranscriptAsync(run, runStore, noteEntry.Title, transcript);
        if (string.IsNullOrWhiteSpace(summary))
            throw new InvalidOperationException("整理结果为空，请换个方式重试");

        await UpdateProgressAsync(db, runStore, run, 90, "写入中");
        var newNoteMd = TranscribeNoteText.ReplaceSummarySection(noteMd, summary);
        await _applyService.SaveContentAsync(
            noteEntry,
            newNoteMd,
            run.UserId,
            db,
            preserveFileIdentity: !string.IsNullOrEmpty(noteEntry.AttachmentId));

        // 播放器页签必须展示这份摘要真实使用的后端整理方式，不能在前端猜测。
        // 旧条目 Metadata 可能为 null，沿用转录写入时的兼容策略。
        var styleKey = TranscribeStyleRegistry.Find(run.TemplateKey)?.Key ?? TranscribeStyleRegistry.DefaultKey;
        var styleMetaUpdate = noteEntry.Metadata == null
            ? Builders<DocumentEntry>.Update.Set(e => e.Metadata, new Dictionary<string, string>
            {
                ["transcribe_style_key"] = styleKey,
            })
            : Builders<DocumentEntry>.Update.Set(e => e.Metadata["transcribe_style_key"], styleKey);
        await db.DocumentEntries.UpdateOneAsync(
            e => e.Id == noteEntry.Id,
            styleMetaUpdate,
            cancellationToken: CancellationToken.None);

        await db.DocumentStoreAgentRuns.UpdateOneAsync(
            r => r.Id == run.Id,
            Builders<DocumentStoreAgentRun>.Update
                .Set(r => r.OutputEntryId, noteEntry.Id)
                .Set(r => r.GeneratedText, summary)
                // 链式重整理：把转录文本继续带在新 run 上，下一次 restyle 不必回溯最初 run
                .Set(r => r.TranscriptText, transcript)
                .Set(r => r.Progress, 95),
            cancellationToken: CancellationToken.None);

        _logger.LogInformation(
            "[doc-store-agent] Transcript restyled: run={RunId} prior={PriorId} entry={EntryId} style={Style}",
            run.Id, prior.Id, noteEntry.Id, run.TemplateKey ?? "general");
    }

    // 摘要节替换 / 转录全文反解 / 静音判定 / 风格提示词组装：纯函数下沉到
    // PrdAgent.Core.Models.TranscribeNoteText（PrdAgent.Tests 单测覆盖）。

    /// <summary>对转录全文生成结构化 Markdown 摘要，流式 delta 事件推给前端。</summary>
    private async Task<string> SummarizeTranscriptAsync(
        DocumentStoreAgentRun run, IRunEventStore runStore, string title, string transcript)
    {
        using var _ = _llmCtx.BeginScope(new LlmRequestContext(
            RequestId: run.Id,
            GroupId: null,
            SessionId: run.Id,
            UserId: run.UserId,
            ViewRole: null,
            DocumentChars: transcript.Length,
            DocumentHash: null,
            SystemPromptRedacted: "[DOC_STORE_TRANSCRIBE_SUMMARY]",
            RequestType: ModelTypes.Chat,
            AppCallerCode: AppCallerRegistry.DocumentStoreAgent.Transcribe.Summary,
            ForceFullShadowSample: run.ForceFullShadowSample));

        var client = _llmGateway.CreateClient(
            AppCallerRegistry.DocumentStoreAgent.Transcribe.Summary,
            ModelTypes.Chat,
            maxTokens: 2048,
            temperature: 0.3);

        var systemPrompt = TranscribeNoteText.BuildSummarySystemPrompt(run);

        var userContent = TranscribeNoteText.BuildSummaryUserContent(run, title, transcript);
        var messages = new List<LLMMessage>
        {
            new() { Role = "user", Content = userContent },
        };

        var sb = new StringBuilder();
        await foreach (var chunk in client.StreamGenerateAsync(systemPrompt, messages, CancellationToken.None))
        {
            if (chunk.Type == "delta" && !string.IsNullOrEmpty(chunk.Content))
            {
                sb.Append(chunk.Content);
                try
                {
                    await runStore.AppendEventAsync(
                        DocumentStoreRunKinds.Transcribe, run.Id, "delta",
                        new { text = chunk.Content }, ct: CancellationToken.None);
                }
                catch { /* 事件失败不阻塞主流程 */ }
            }
            else if (chunk.Type == "error")
            {
                throw new InvalidOperationException($"摘要生成失败: {chunk.ErrorMessage}");
            }
        }
        return sb.ToString().Trim();
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

        // ASR 上游对 WebM/Opus、M4A 等容器的支持不一致，不能只依赖 multipart 的文件名和 MIME
        // 伪装。音频和视频统一先转成 16kHz、单声道 WAV，再送入任意 ASR 路径，避免清晰录音被上游
        // 当成不可解析的格式后返回空结果。
        var sourceBytes = bytes.Length;
        bytes = await ExtractAudioWithFfmpegAsync(bytes);
        _logger.LogInformation(
            "[doc-store-agent] ASR 音频已规范化: sourceBytes={SourceBytes} normalizedBytes={NormalizedBytes} isVideo={IsVideo}",
            sourceBytes, bytes.Length, isVideo);

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

        return await TranscribeWithFallbackAsync(
            run,
            bytes,
            resolution,
            (attempt, total) => UpdateProgressAsync(
                db,
                runStore,
                run,
                50,
                total > 1 ? $"识别中（方案 {attempt}/{total}）" : "识别中"));
    }

    private async Task<List<SubtitleSegment>> TranscribeWithFallbackAsync(
        DocumentStoreAgentRun run,
        byte[] audioBytes,
        ModelResolutionResult primaryResolution,
        Func<int, int, Task>? onAttempt = null)
    {
        const int maxAttempts = 3;
        var candidates = new[] { primaryResolution }
            .Concat(primaryResolution.RetryCandidates ?? [])
            .Where(candidate => candidate.Success && !string.IsNullOrWhiteSpace(candidate.ActualModel))
            .GroupBy(
                candidate => $"{candidate.ActualPlatformId}::{candidate.ActualModel}",
                StringComparer.OrdinalIgnoreCase)
            .Select(group => group.First())
            .Take(maxAttempts)
            .ToList();

        var failures = new List<Dictionary<string, object?>>();
        for (var index = 0; index < candidates.Count; index++)
        {
            var candidate = candidates[index];
            // 语义降级由本处理器按候选协议重建请求。单次发送不能继续携带候选，
            // 否则 Gateway 可能拿豆包 JSON 请求去重试 Whisper multipart，协议形状会错位。
            candidate.RetryCandidates = null;

            if (onAttempt != null)
                await onAttempt(index + 1, candidates.Count);

            try
            {
                var segments = await TranscribeWithResolutionAsync(run, audioBytes, candidate);
                if (segments.Count == 0)
                {
                    throw new SubtitleAsrException(
                        "ASR 返回为空（上游成功响应中没有可用文字）",
                        BuildResolverDiagnostic(candidate, "empty-content"));
                }

                if (index > 0)
                {
                    _logger.LogInformation(
                        "[doc-store-agent] ASR 自动降级成功: attempt={Attempt}/{Total} model={Model} platform={Platform}",
                        index + 1,
                        candidates.Count,
                        candidate.ActualModel,
                        candidate.ActualPlatformName);
                }
                return segments;
            }
            catch (SubtitleAsrException ex)
            {
                failures.Add(new Dictionary<string, object?>
                {
                    ["attempt"] = index + 1,
                    ["model"] = candidate.ActualModel,
                    ["platformId"] = candidate.ActualPlatformId,
                    ["platformName"] = candidate.ActualPlatformName,
                    ["exchangeTransformerType"] = candidate.ExchangeTransformerType,
                    ["error"] = ex.Message,
                });

                if (index == candidates.Count - 1)
                {
                    if (candidates.Count == 1)
                        throw;

                    var diagnostic = new Dictionary<string, object?>(ex.Diagnostic)
                    {
                        ["fallbackAttempts"] = failures,
                    };
                    throw new SubtitleAsrException(
                        $"自动尝试 {candidates.Count} 个 ASR 方案仍失败：{ex.Message}",
                        diagnostic);
                }

                _logger.LogWarning(
                    ex,
                    "[doc-store-agent] ASR 方案失败，自动切换: attempt={Attempt}/{Total} model={Model} nextModel={NextModel}",
                    index + 1,
                    candidates.Count,
                    candidate.ActualModel,
                    candidates[index + 1].ActualModel);
            }
        }

        throw new SubtitleAsrException(
            "ASR 模型池没有可执行的识别方案",
            BuildResolverDiagnostic(primaryResolution, "no-candidates"));
    }

    private async Task<List<SubtitleSegment>> TranscribeWithResolutionAsync(
        DocumentStoreAgentRun run,
        byte[] audioBytes,
        ModelResolutionResult resolution)
    {
        // 三路分发（参考 TranscriptRunWorker.cs:159-192）
        if (resolution.IsExchange)
        {
            switch (resolution.ExchangeTransformerType)
            {
                case "doubao-asr-stream":
                    // WebSocket 协议由 LlmGateway/llmgw-serve 执行；本处理器仍只提交 GatewayRawRequest。
                    return await TranscribeViaGatewayAsync(run, audioBytes, resolution.ToGatewayResolution(),
                        new Dictionary<string, object>
                        {
                            ["model"] = resolution.ActualModel ?? "doubao-asr-stream",
                            ["response_format"] = "verbose_json",
                            ["timestamp_granularities[]"] = "segment",
                        });

                case "doubao-asr":
                    // doubao-asr 异步模式 ≠ Whisper multipart：DoubaoAsrTransformer.TransformRequest
                    // 只读 standardBody 的 audio_url / audio_data / url 字段，**不读 multipart 文件**。
                    // Gateway.ConsolidateMultipartToJson 会把 multipart 文件转成 image_urls，
                    // 路径不通。必须把音频以 base64 audio_data 形式塞进 RequestBody。
                    // 参考：Bugbot + Codex 双 P1 review on PR #542 commit 9253b0f
                    return await TranscribeViaDoubaoAsyncJsonAsync(run, audioBytes, resolution);

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
        if (AsrAudioRoutePolicy.ShouldUseChatAudio(resolution.ActualModel, resolution.Protocol, resolution.PlatformType))
        {
            _logger.LogInformation(
                "[doc-store-agent] 走多模态 chat 音频转写路径: model={Model} platform={Platform}",
                resolution.ActualModel, resolution.ActualPlatformName);
            // 上面已统一转成 WAV，chat-audio 只接收规范化后的字节，避免重复转码。
            return await TranscribeViaChatAudioAsync(run, audioBytes, resolution.ToGatewayResolution());
        }

        // 非 Exchange 模型 → 走 Whisper HTTP（OpenAI 兼容 /v1/audio/transcriptions）
        //
        // multipart 字段：保持与 c237e6d (19:22 跑通版本) 完全一致。
        // 不要画蛇添足简化掉 response_format/timestamp_granularities[] —— vveai/gpt.ge 是宽容模式
        // 会忽略未识别字段，跑通过的配置不要动。简化反而踩到「audio.m4a → audio/mp4 不支持」的坑。
        _logger.LogInformation(
            "[doc-store-agent] 走 Whisper HTTP 路径: model={Model} platform={Platform}",
            resolution.ActualModel, resolution.ActualPlatformName);
        return await TranscribeViaGatewayAsync(run, audioBytes, resolution.ToGatewayResolution(),
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

        using var _ = _llmCtx.BeginScope(new LlmRequestContext(
            RequestId: run.Id,
            GroupId: null,
            SessionId: run.Id,
            UserId: run.UserId,
            ViewRole: null,
            DocumentChars: null,
            DocumentHash: null,
            SystemPromptRedacted: "[DOC_STORE_SUBTITLE_ASR]",
            RequestType: ModelTypes.Asr,
            AppCallerCode: AppCallerRegistry.DocumentStoreAgent.Subtitle.Audio,
            ForceFullShadowSample: run.ForceFullShadowSample));

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
                            ["text"] = "请把这段音频逐字转写成文字，尽量一字不差保留原话。只输出转写出的文字本身，不要任何解释、说明或前后缀。" +
                                       "如果音频中没有任何可识别的人声（静音、空白或纯噪音），只输出 NO_SPEECH 这一个词，不要输出其他任何文字。",
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

        using var _ = _llmCtx.BeginScope(new LlmRequestContext(
            RequestId: run.Id,
            GroupId: null,
            SessionId: run.Id,
            UserId: run.UserId,
            ViewRole: null,
            DocumentChars: null,
            DocumentHash: null,
            SystemPromptRedacted: "[DOC_STORE_SUBTITLE_AUDIO_CHAT]",
            RequestType: ModelTypes.Asr,
            AppCallerCode: AppCallerRegistry.DocumentStoreAgent.Subtitle.Audio,
            ForceFullShadowSample: run.ForceFullShadowSample));

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
        // 静音哨兵：提示词约定无人声时只输出 NO_SPEECH → 当"无有效语音"失败抛出，
        // 不能让它流进后续摘要/落库（真实事故：静音音频产出对话式回复被存成笔记）。
        if (text.Trim().Contains("NO_SPEECH", StringComparison.OrdinalIgnoreCase))
            throw new SubtitleAsrException(
                "未检测到有效语音内容：录音可能是静音、音量过低或没有人声。请靠近麦克风重新录制。",
                BuildHttpDiagnostic(gwResolution, rawResp, new Dictionary<string, object>
                {
                    ["model"] = gwResolution.ActualModel ?? "",
                    ["reason"] = "no-speech",
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

        using var _ = _llmCtx.BeginScope(new LlmRequestContext(
            RequestId: run.Id,
            GroupId: null,
            SessionId: run.Id,
            UserId: run.UserId,
            ViewRole: null,
            DocumentChars: null,
            DocumentHash: null,
            SystemPromptRedacted: "[DOC_STORE_SUBTITLE_ASR_JSON]",
            RequestType: ModelTypes.Asr,
            AppCallerCode: AppCallerRegistry.DocumentStoreAgent.Subtitle.Audio,
            ForceFullShadowSample: run.ForceFullShadowSample));

        var rawResp = await _llmGateway.SendRawWithResolutionAsync(rawRequest, gwResolution, CancellationToken.None);

        if (rawResp?.Success != true || rawResp.Content == null)
        {
            var detail = rawResp?.ErrorMessage ?? rawResp?.Content ?? "无响应";
            throw new SubtitleAsrException(
                $"豆包异步 ASR 调用失败: {detail}",
                BuildHttpDiagnostic(gwResolution, rawResp, new Dictionary<string, object> { ["bodyShape"] = "audio_data(base64)" }));
        }

        // LlmGateway 的 DoubaoAsrTransformer 已把豆包原始响应转换为 Whisper 兼容结构：
        // { text, segments: [{ start, end, text }] }。这里必须优先消费统一结构，不能继续只读
        // 豆包旧结构，否则上游实际识别成功也会被业务层误判成“转录结果为空”。
        // 旧 result.utterances 仅作为兼容兜底，便于处理历史测试桩或未经过 Transformer 的响应。
        var segments = new List<SubtitleSegment>();
        try
        {
            using var jdoc = JsonDocument.Parse(rawResp.Content);
            var root = jdoc.RootElement;
            if (root.TryGetProperty("segments", out var normalizedSegments)
                && normalizedSegments.ValueKind == JsonValueKind.Array)
            {
                foreach (var segment in normalizedSegments.EnumerateArray())
                {
                    var start = segment.TryGetProperty("start", out var s) ? s.GetDouble() : 0;
                    var end = segment.TryGetProperty("end", out var e) ? e.GetDouble() : 0;
                    var text = (segment.TryGetProperty("text", out var t) ? t.GetString() : "") ?? "";
                    if (!string.IsNullOrWhiteSpace(text))
                        segments.Add(new SubtitleSegment(start, end, text.Trim()));
                }
            }
            if (segments.Count == 0 && root.TryGetProperty("text", out var normalizedText))
            {
                var fullText = normalizedText.GetString() ?? "";
                if (!string.IsNullOrWhiteSpace(fullText))
                    segments.Add(new SubtitleSegment(0, 0, fullText.Trim()));
            }
            if (segments.Count == 0 && root.TryGetProperty("result", out var result)
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
            throw new SubtitleAsrException(
                $"豆包异步 ASR 响应解析失败: {ex.Message}",
                BuildHttpDiagnostic(gwResolution, rawResp, new Dictionary<string, object>
                {
                    ["bodyShape"] = "gateway-normalized-asr",
                    ["reason"] = "invalid-json",
                }));
        }

        if (segments.Count == 0)
        {
            throw new SubtitleAsrException(
                "豆包异步 ASR 返回为空（音频可能无人声或上游响应结构异常）",
                BuildHttpDiagnostic(gwResolution, rawResp, new Dictionary<string, object>
                {
                    ["bodyShape"] = "gateway-normalized-asr",
                    ["reason"] = "empty-content",
                }));
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
    /// 用 ffmpeg 从音视频中抽取 16kHz mono WAV；短于 15 秒时在末尾补静音，
    /// 避免 ASR 将清晰的短句稳定误判为无语音。依赖 host 的 ffmpeg。
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
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            };
            AsrAudioNormalizationPolicy.ConfigureFfmpegArguments(psi.ArgumentList, tmpIn, tmpOut);
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

        using var _ = _llmCtx.BeginScope(new LlmRequestContext(
            RequestId: run.Id,
            GroupId: null,
            SessionId: run.Id,
            UserId: run.UserId,
            ViewRole: null,
            DocumentChars: null,
            DocumentHash: null,
            SystemPromptRedacted: "[DOC_STORE_SUBTITLE_VISION]",
            RequestType: ModelTypes.Vision,
            AppCallerCode: AppCallerRegistry.DocumentStoreAgent.Subtitle.Vision,
            ForceFullShadowSample: run.ForceFullShadowSample));

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
            // 事件 kind 按 run.Kind 路由（subtitle 与 transcribe 共用本处理器的 ASR 内部方法）
            await runStore.AppendEventAsync(
                DocumentStoreAgentWorker.KindForEvents(run.Kind), run.Id, "progress",
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
