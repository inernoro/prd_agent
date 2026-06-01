using System.Text;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Interfaces.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services;

/// <summary>
/// 文档再加工处理器 —— 支持多轮对话。
///
/// 触发条件：worker 每次 pick 到 Status=Queued 且 Kind=reprocess 的 run 时调用 ProcessAsync。
/// 一次调用处理「队列里末尾那条 user 消息」对应的一轮 LLM 生成，把 assistant 消息追加到 run.Messages。
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
        // 1) 读源 entry + 正文（文档全文作为 system prompt 的一部分注入）
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
            sourceContent = entry.ContentIndex;
        if (string.IsNullOrWhiteSpace(sourceContent))
            throw new InvalidOperationException("源文档无正文可供再加工");

        await UpdateProgressAsync(db, runStore, run, 5, "准备中");

        // 2) 定位本轮要处理的 user 消息：messages 末尾的 user（若 role=assistant 则无新消息可处理）
        if (run.Messages.Count == 0)
            throw new InvalidOperationException("对话历史为空");

        var lastMsg = run.Messages[^1];
        if (lastMsg.Role != "user")
        {
            _logger.LogInformation("[doc-store-agent] Reprocess run {RunId} has no pending user message, skip", run.Id);
            return;
        }

        // 3) 构建 LLM messages：system = 模板/智能体 + 源文档；历史 user/assistant 交替；本轮 user 在末尾
        var (systemPrompt, templateLabel) = await BuildSystemPromptAsync(run, sourceContent, db);

        var llmMessages = new List<LLMMessage>();
        for (int i = 0; i < run.Messages.Count; i++)
        {
            var m = run.Messages[i];
            // 跳过那些纯 template chip 触发但 content 为空的伪消息（实际上 BuildSystemPrompt 已展开）
            if (string.IsNullOrWhiteSpace(m.Content)) continue;
            llmMessages.Add(new LLMMessage { Role = m.Role, Content = m.Content });
        }

        await UpdateProgressAsync(db, runStore, run, 15, "调用 LLM");

        // 4) 流式调用 LLM —— UserId 必须从 run.UserId 取（llm-gateway.md 硬规则）
        using var _ctxScope = _llmCtx.BeginScope(new LlmRequestContext(
            RequestId: Guid.NewGuid().ToString("N"),
            GroupId: null,
            SessionId: run.Id,
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

        var assistantSeq = run.Messages.Count; // 即将追加的 assistant 消息序号
        var sb = new StringBuilder();
        long chunkCount = 0;
        var lastFlushAt = DateTime.UtcNow;

        await foreach (var chunk in client.StreamGenerateAsync(systemPrompt, llmMessages, CancellationToken.None))
        {
            if (chunk.Type == "delta" && !string.IsNullOrEmpty(chunk.Content))
            {
                sb.Append(chunk.Content);
                chunkCount++;

                try
                {
                    await runStore.AppendEventAsync(
                        DocumentStoreRunKinds.Reprocess, run.Id, "chunk",
                        new { text = chunk.Content, messageSeq = assistantSeq }, ct: CancellationToken.None);
                }
                catch { /* ignore */ }

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

        await UpdateProgressAsync(db, runStore, run, 90, "整理中");

        // 5) 追加 assistant 消息到 run.Messages，并更新 GeneratedText（保留兜底语义）
        var assistantMsg = new ReprocessChatMessage
        {
            Seq = assistantSeq,
            Role = "assistant",
            Content = finalContent,
            CreatedAt = DateTime.UtcNow,
        };
        await db.DocumentStoreAgentRuns.UpdateOneAsync(
            r => r.Id == run.Id,
            Builders<DocumentStoreAgentRun>.Update
                .Push(r => r.Messages, assistantMsg)
                .Set(r => r.GeneratedText, finalContent)
                .Set(r => r.Progress, 95),
            cancellationToken: CancellationToken.None);

        // 推一条 messageDone 事件让前端知道哪一条 assistant 已完整
        try
        {
            await runStore.AppendEventAsync(
                DocumentStoreRunKinds.Reprocess, run.Id, "messageDone",
                new { messageSeq = assistantSeq, content = finalContent, templateLabel },
                ct: CancellationToken.None);
        }
        catch { /* ignore */ }

        _logger.LogInformation(
            "[doc-store-agent] Reprocess turn done for run={RunId} seq={Seq} chars={Len}",
            run.Id, assistantSeq, finalContent.Length);
    }

    /// <summary>
    /// 构建 system prompt：优先匹配 reprocess_agents 智能体，再回退到 ReprocessTemplateRegistry 内置模板，
    /// 最后兜底 generic 助理。后续轮次会沿用首条 user 消息的 templateKey 持续生效。
    /// </summary>
    private async Task<(string systemPrompt, string templateLabel)> BuildSystemPromptAsync(
        DocumentStoreAgentRun run, string sourceContent, MongoDbContext db)
    {
        var firstTemplateKey = run.Messages
            .Where(m => m.Role == "user" && !string.IsNullOrEmpty(m.TemplateKey))
            .Select(m => m.TemplateKey)
            .FirstOrDefault() ?? run.TemplateKey;

        string instruction;
        string label;
        if (firstTemplateKey == "custom" || string.IsNullOrEmpty(firstTemplateKey))
        {
            instruction = "你是知识库文档助理。基于「参考文档」回答用户问题或按用户要求改写内容。" +
                          "回答时如果涉及改写正文，输出 Markdown；如果是回答问题，可以用自然语言。";
            label = "自定义";
        }
        else
        {
            // 先查智能体（system + 任意 owner 都可命中，权限校验已在 Controller 入口层做过）
            var agent = await db.ReprocessAgents
                .Find(a => a.Key == firstTemplateKey)
                .FirstOrDefaultAsync();
            if (agent != null && !string.IsNullOrWhiteSpace(agent.SystemPrompt))
            {
                instruction = agent.SystemPrompt;
                label = agent.Label;
            }
            else
            {
                var tmpl = ReprocessTemplateRegistry.FindByKey(firstTemplateKey);
                if (tmpl == null)
                {
                    instruction = "你是知识库文档助理。基于「参考文档」按用户要求改写内容。";
                    label = "自定义";
                }
                else
                {
                    instruction = tmpl.SystemPrompt;
                    label = tmpl.Label;
                }
            }
        }

        var sb = new StringBuilder();
        sb.AppendLine(instruction);
        sb.AppendLine();
        sb.AppendLine("# 参考文档");
        sb.AppendLine("以下是用户当前讨论的源文档全文，所有改写/问答都应基于此：");
        sb.AppendLine();
        sb.AppendLine("---");
        sb.AppendLine(sourceContent);
        sb.AppendLine("---");
        sb.AppendLine();
        sb.AppendLine("用户接下来会通过对话给出处理指令。请始终用中文回答，输出尽量直接，不要重复前言。");
        return (sb.ToString(), label);
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
