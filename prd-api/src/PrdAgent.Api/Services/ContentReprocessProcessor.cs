using System.Text;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Interfaces.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services;

/// <summary>
/// 文档再加工处理器 —— 基于已有文字 entry（含字幕），按模板或自定义 prompt 流式生成新文档。
///
/// 流程：
///   1. 读源 entry 的正文（ParsedPrd.Content 或 ContentIndex 兜底）
///   2. 选模板 system prompt（或用 CustomPrompt）
///   3. ILlmGateway 流式调用 → 每个 chunk 推 SSE 事件 + 累积到 Run.GeneratedText
///   4. 完成后把 GeneratedText 落成新 DocumentEntry
/// </summary>
public class ContentReprocessProcessor
{
    private readonly ILlmGateway _llmGateway;
    private readonly IDocumentService _documentService;
    private readonly ILLMRequestContextAccessor _llmCtx;
    private readonly ILogger<ContentReprocessProcessor> _logger;

    public ContentReprocessProcessor(
        ILlmGateway llmGateway,
        IDocumentService documentService,
        ILLMRequestContextAccessor llmCtx,
        ILogger<ContentReprocessProcessor> logger)
    {
        _llmGateway = llmGateway;
        _documentService = documentService;
        _llmCtx = llmCtx;
        _logger = logger;
    }

    public async Task ProcessAsync(DocumentStoreAgentRun run, MongoDbContext db, IRunEventStore runStore)
    {
        // 1) 读源 entry + 正文
        var entry = await db.DocumentEntries.Find(e => e.Id == run.SourceEntryId).FirstOrDefaultAsync();
        if (entry == null) throw new InvalidOperationException("源文档条目不存在");
        if (entry.IsFolder) throw new InvalidOperationException("文件夹不支持再加工");

        string? sourceContent = null;
        if (!string.IsNullOrEmpty(entry.DocumentId))
        {
            var doc = await _documentService.GetByIdAsync(entry.DocumentId);
            sourceContent = doc?.RawContent;
        }
        if (string.IsNullOrWhiteSpace(sourceContent))
            sourceContent = entry.ContentIndex; // 兜底用索引
        if (string.IsNullOrWhiteSpace(sourceContent))
            throw new InvalidOperationException("源文档无正文可供再加工");

        await UpdateProgressAsync(db, runStore, run, 5, "准备中");

        // 2) 选 prompt
        //    - templateKey == "custom": customPrompt 是主 prompt（必填）
        //    - templateKey == 其他模板: 使用模板 systemPrompt；如果 customPrompt 非空，作为额外指令拼到末尾
        //      用户可以在选模板的同时补一句"用产品经理视角"之类的话，不必"模板 OR 自定义"二选一
        string systemPrompt;
        string templateLabel;
        if (run.TemplateKey == "custom")
        {
            if (string.IsNullOrWhiteSpace(run.CustomPrompt))
                throw new InvalidOperationException("自定义模板需要提供 prompt");
            systemPrompt = run.CustomPrompt!;
            templateLabel = "自定义";
        }
        else
        {
            var tmpl = ReprocessTemplateRegistry.FindByKey(run.TemplateKey)
                ?? throw new InvalidOperationException($"未知模板: {run.TemplateKey}");
            systemPrompt = tmpl.SystemPrompt;
            if (!string.IsNullOrWhiteSpace(run.CustomPrompt))
            {
                // 把模板基础上的额外指令显式标注，避免 LLM 误以为是源文档内容
                systemPrompt += "\n\n# 额外用户指令（在模板基础上补充）\n" + run.CustomPrompt!.Trim();
            }
            templateLabel = tmpl.Label;
        }

        await UpdateProgressAsync(db, runStore, run, 15, "调用 LLM");

        // 3) 流式调用
        // Worker 场景必须显式开 LlmRequestContext，UserId 从 run.UserId 取——否则
        // Gateway 日志/配额/账单挂不到用户头上（llm-gateway.md：日志会打 "UserId 为空"）。
        using var _ctxScope = _llmCtx.BeginScope(new LlmRequestContext(
            RequestId: Guid.NewGuid().ToString("N"),
            GroupId: null,
            SessionId: null,
            UserId: run.UserId,
            ViewRole: null,
            DocumentChars: sourceContent.Length,
            DocumentHash: null,
            SystemPromptRedacted: "doc-store-reprocess",
            RequestType: "chat",
            AppCallerCode: AppCallerRegistry.DocumentStoreAgent.Reprocess.Generate));

        var client = _llmGateway.CreateClient(
            AppCallerRegistry.DocumentStoreAgent.Reprocess.Generate,
            ModelTypes.Chat,
            maxTokens: 4096,
            temperature: 0.4);

        var userMessage = "以下是原始内容，请按你收到的系统指令处理：\n\n---\n\n" + sourceContent;
        var messages = new List<LLMMessage>
        {
            new() { Role = "user", Content = userMessage },
        };

        var sb = new StringBuilder();
        long chunkCount = 0;
        var lastFlushAt = DateTime.UtcNow;

        await foreach (var chunk in client.StreamGenerateAsync(systemPrompt, messages, CancellationToken.None))
        {
            if (chunk.Type == "delta" && !string.IsNullOrEmpty(chunk.Content))
            {
                sb.Append(chunk.Content);
                chunkCount++;

                // 推 SSE 事件（每个 chunk）
                try
                {
                    await runStore.AppendEventAsync(
                        DocumentStoreRunKinds.Reprocess, run.Id, "chunk",
                        new { text = chunk.Content }, ct: CancellationToken.None);
                }
                catch { /* ignore */ }

                // 每秒或每 20 个 chunk 同步一次到 DB（断线续传兜底）
                if ((DateTime.UtcNow - lastFlushAt).TotalSeconds >= 1 || chunkCount % 20 == 0)
                {
                    lastFlushAt = DateTime.UtcNow;
                    await db.DocumentStoreAgentRuns.UpdateOneAsync(
                        r => r.Id == run.Id,
                        Builders<DocumentStoreAgentRun>.Update.Set(r => r.GeneratedText, sb.ToString()),
                        cancellationToken: CancellationToken.None);
                }
            }
            else if (chunk.Type == "error")
            {
                throw new InvalidOperationException($"LLM 调用失败: {chunk.ErrorMessage}");
            }
        }

        var finalContent = sb.ToString().Trim();
        if (string.IsNullOrEmpty(finalContent))
            throw new InvalidOperationException("LLM 返回内容为空");

        await UpdateProgressAsync(db, runStore, run, 85, "写入中");

        // 4) 落新 entry
        var parsed = await _documentService.ParseAsync(finalContent);
        parsed.Title = BuildOutputTitle(entry.Title, templateLabel);
        await _documentService.SaveAsync(parsed);

        var newEntry = new DocumentEntry
        {
            StoreId = entry.StoreId,
            ParentId = entry.ParentId,
            Title = BuildOutputTitle(entry.Title, templateLabel),
            Summary = finalContent.Length > 200 ? finalContent[..200] : finalContent,
            SourceType = DocumentSourceType.Upload,
            ContentType = "text/markdown",
            FileSize = Encoding.UTF8.GetByteCount(finalContent),
            DocumentId = parsed.Id,
            CreatedBy = run.UserId,
            ContentIndex = finalContent.Length > 2000 ? finalContent[..2000] : finalContent,
            LastChangedAt = DateTime.UtcNow,
            Metadata = new Dictionary<string, string>
            {
                ["generated_kind"] = "reprocess",
                ["source_entry_id"] = entry.Id,
                ["template_key"] = run.TemplateKey ?? "",
                ["template_label"] = templateLabel,
            },
        };
        await db.DocumentEntries.InsertOneAsync(newEntry);

        await db.DocumentStores.UpdateOneAsync(
            s => s.Id == entry.StoreId,
            Builders<DocumentStore>.Update
                .Inc(s => s.DocumentCount, 1)
                .Set(s => s.UpdatedAt, DateTime.UtcNow),
            cancellationToken: CancellationToken.None);

        await db.DocumentStoreAgentRuns.UpdateOneAsync(
            r => r.Id == run.Id,
            Builders<DocumentStoreAgentRun>.Update
                .Set(r => r.OutputEntryId, newEntry.Id)
                .Set(r => r.GeneratedText, finalContent)
                .Set(r => r.Progress, 95),
            cancellationToken: CancellationToken.None);

        _logger.LogInformation(
            "[doc-store-agent] Reprocess done for {EntryId} → {NewEntryId}, template={Template}, {Len} chars",
            entry.Id, newEntry.Id, run.TemplateKey, finalContent.Length);
    }

    private static string BuildOutputTitle(string srcTitle, string templateLabel)
    {
        var baseName = Path.GetFileNameWithoutExtension(srcTitle);
        if (string.IsNullOrWhiteSpace(baseName)) baseName = srcTitle;
        return $"{baseName}-{templateLabel}.md";
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
                DocumentStoreRunKinds.Reprocess, run.Id, "progress",
                new { progress, phase }, ct: CancellationToken.None);
        }
        catch { /* ignore */ }
    }
}
