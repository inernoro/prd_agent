using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

namespace PrdAgent.Core.Services;

/// <summary>
/// 对话服务实现
/// </summary>
public class ChatService : IChatService
{
    private readonly ILLMClient _llmClient;
    private readonly ISessionService _sessionService;
    private readonly IDocumentService _documentService;
    private readonly ICacheManager _cache;
    private readonly IPromptManager _promptManager;
    private readonly IPromptService _promptService;
    private readonly ISystemPromptService _systemPromptService;
    private readonly IUserService _userService;
    private readonly IMessageRepository _messageRepository;
    private readonly ILLMRequestContextAccessor _llmRequestContext;
    private static readonly TimeSpan ChatHistoryExpiry = TimeSpan.FromMinutes(30);

    public ChatService(
        ILLMClient llmClient,
        ISessionService sessionService,
        IDocumentService documentService,
        ICacheManager cache,
        IPromptManager promptManager,
        IPromptService promptService,
        ISystemPromptService systemPromptService,
        IUserService userService,
        IMessageRepository messageRepository,
        ILLMRequestContextAccessor llmRequestContext)
    {
        _llmClient = llmClient;
        _sessionService = sessionService;
        _documentService = documentService;
        _cache = cache;
        _promptManager = promptManager;
        _promptService = promptService;
        _systemPromptService = systemPromptService;
        _userService = userService;
        _messageRepository = messageRepository;
        _llmRequestContext = llmRequestContext;
    }

    public async IAsyncEnumerable<ChatStreamEvent> SendMessageAsync(
        string sessionId,
        string content,
        string? promptKey = null,
        string? userId = null,
        List<string>? attachmentIds = null,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        // 获取会话
        var session = await _sessionService.GetByIdAsync(sessionId);
        if (session == null)
        {
            yield return new ChatStreamEvent
            {
                Type = "error",
                ErrorCode = ErrorCodes.SESSION_NOT_FOUND,
                ErrorMessage = "会话不存在或已过期"
            };
            yield break;
        }

        // 获取文档
        var document = await _documentService.GetByIdAsync(session.DocumentId);
        if (document == null)
        {
            yield return new ChatStreamEvent
            {
                Type = "error",
                ErrorCode = ErrorCodes.DOCUMENT_NOT_FOUND,
                ErrorMessage = "文档不存在或已过期"
            };
            yield break;
        }

        // 获取发送者信息
        SenderInfo? senderInfo = null;
        if (!string.IsNullOrEmpty(userId))
        {
            var user = await _userService.GetByIdAsync(userId);
            if (user != null)
            {
                senderInfo = new SenderInfo
                {
                    UserId = user.UserId,
                    DisplayName = user.DisplayName,
                    Role = user.Role
                };
            }
        }

        // 生成消息ID
        var messageId = Guid.NewGuid().ToString();

        yield return new ChatStreamEvent
        {
            Type = "start",
            MessageId = messageId,
            Sender = senderInfo
        };

        // 构建系统Prompt
        var baseSystemPrompt = await _systemPromptService.GetSystemPromptAsync(session.CurrentRole, cancellationToken);
        var systemPromptRedacted = baseSystemPrompt;
        var docHash = Sha256Hex(document.RawContent);

        // 提示词（可选）：将提示词模板作为“聚焦指令”注入 system prompt
        string systemPrompt = baseSystemPrompt;
        string llmUserContent = content;
        var effectivePromptKey = (promptKey ?? string.Empty).Trim();
        if (!string.IsNullOrWhiteSpace(effectivePromptKey))
        {
            var prompt = await _promptService.GetPromptByKeyAsync(session.CurrentRole, effectivePromptKey, cancellationToken);
            if (prompt != null &&
                (!string.IsNullOrWhiteSpace(prompt.Title) || !string.IsNullOrWhiteSpace(prompt.PromptTemplate)))
            {
                // 关键：对 LLM 请求，优先使用 promptTemplate 作为本次“讲解指令”，避免仅发送“【讲解】标题”导致模型无法按模板输出。
                // 注意：入库的 userMessage.Content 仍保留原始 content（用于 UI 显示与回放），这里只影响发送给大模型的 messages。
                if (!string.IsNullOrWhiteSpace(prompt.PromptTemplate))
                {
                    var pt = prompt.PromptTemplate.Trim();
                    var c = (content ?? string.Empty).Trim();
                    // 保留用户的“标题/问题”，并追加模板，便于日志排查与模型对齐输出结构。
                    llmUserContent = string.IsNullOrWhiteSpace(c) ? pt : (c + "\n\n" + pt);
                }

                systemPrompt += @"

---

# 当前提示词上下文
你当前正在按提示词（promptKey=" + effectivePromptKey + @"）「" + (prompt.Title ?? string.Empty) + @"」进行讲解/解读。

## 提示词模板（作为聚焦指令）
说明：以下内容用于帮助你聚焦输出；请严格遵守其结构与约束；若 PRD 未覆盖则明确标注“PRD 未覆盖/需补充”，不得编造。

" + (prompt.PromptTemplate ?? string.Empty);

                // 日志侧的 system prompt（脱敏后）也应包含 promptKey/promptTemplate，便于排查与对照管理后台的提示词配置。
                systemPromptRedacted = systemPrompt;
            }
        }

        // 获取对话历史
        var history = await GetHistoryAsync(sessionId, 20);
        var messages = new List<LLMMessage>
        {
            // 首条 user message：PRD 资料（日志侧会按标记脱敏，不落库 PRD 原文）
            new() { Role = "user", Content = _promptManager.BuildPrdContextMessage(document.RawContent) }
        };
        messages.AddRange(history.Select(m => new LLMMessage
        {
            Role = m.Role == MessageRole.User ? "user" : "assistant",
            Content = m.Content
        }));

        // 添加当前消息
        messages.Add(new LLMMessage
        {
            Role = "user",
            Content = llmUserContent
        });

        // 调用LLM
        var fullResponse = new System.Text.StringBuilder();
        int inputTokens = 0;
        int outputTokens = 0;
        var blockTokenizer = new MarkdownBlockTokenizer();

        var llmRequestId = Guid.NewGuid().ToString();
        using var _ = _llmRequestContext.BeginScope(new LlmRequestContext(
            RequestId: llmRequestId,
            GroupId: session.GroupId,
            SessionId: sessionId,
            UserId: userId,
            ViewRole: session.CurrentRole.ToString(),
            DocumentChars: document.RawContent?.Length ?? 0,
            DocumentHash: docHash,
            SystemPromptRedacted: systemPromptRedacted,
            RequestType: "reasoning",
            RequestPurpose: "chat.sendMessage"));

        await foreach (var chunk in _llmClient.StreamGenerateAsync(systemPrompt, messages, cancellationToken))
        {
            if (chunk.Type == "delta" && !string.IsNullOrEmpty(chunk.Content))
            {
                fullResponse.Append(chunk.Content);
                foreach (var bt in blockTokenizer.Push(chunk.Content))
                {
                    yield return new ChatStreamEvent
                    {
                        Type = bt.Type,
                        MessageId = messageId,
                        Content = bt.Content,
                        BlockId = bt.BlockId,
                        BlockKind = bt.BlockKind,
                        BlockLanguage = bt.Language
                    };
                }
            }
            else if (chunk.Type == "done")
            {
                inputTokens = chunk.InputTokens ?? 0;
                outputTokens = chunk.OutputTokens ?? 0;
            }
            else if (chunk.Type == "error")
            {
                yield return new ChatStreamEvent
                {
                    Type = "error",
                    ErrorCode = ErrorCodes.LLM_ERROR,
                    ErrorMessage = chunk.ErrorMessage ?? "LLM调用失败"
                };
                yield break;
            }
        }

        // 流结束：冲刷尾部（半行/未闭合段落/代码块）
        foreach (var bt in blockTokenizer.Flush())
        {
            yield return new ChatStreamEvent
            {
                Type = bt.Type,
                MessageId = messageId,
                Content = bt.Content,
                BlockId = bt.BlockId,
                BlockKind = bt.BlockKind,
                BlockLanguage = bt.Language
            };
        }

        // 保存用户消息
        var userMessage = new Message
        {
            SessionId = sessionId,
            GroupId = session.GroupId ?? "",
            SenderId = userId,
            Role = MessageRole.User,
            Content = content,
            LlmRequestId = llmRequestId,
            ViewRole = session.CurrentRole,
            AttachmentIds = attachmentIds ?? new List<string>()
        };

        // 保存AI回复
        var assistantMessage = new Message
        {
            Id = messageId,
            SessionId = sessionId,
            GroupId = session.GroupId ?? "",
            Role = MessageRole.Assistant,
            Content = fullResponse.ToString(),
            LlmRequestId = llmRequestId,
            ViewRole = session.CurrentRole,
            TokenUsage = new TokenUsage
            {
                Input = inputTokens,
                Output = outputTokens
            }
        };

        // 引用依据（SSE 事件，仅会话内下发；不落库）
        var citations = DocCitationExtractor.Extract(document, assistantMessage.Content, maxCitations: 12);

        // 更新对话历史缓存
        await SaveMessagesToHistoryAsync(session, userMessage, assistantMessage);

        // 写入 MongoDB（用于后台追溯与统计）
        // 注意：日志中不得打印消息原文；仓储层不记录日志，这里也不记录 content
        await _messageRepository.InsertManyAsync(new[] { userMessage, assistantMessage });

        // 刷新会话活跃时间
        await _sessionService.RefreshActivityAsync(sessionId);

        if (citations.Count > 0)
        {
            yield return new ChatStreamEvent
            {
                Type = "citations",
                MessageId = messageId,
                Citations = citations
            };
        }

        yield return new ChatStreamEvent
        {
            Type = "done",
            MessageId = messageId,
            TokenUsage = assistantMessage.TokenUsage
        };
    }

    private static string Sha256Hex(string input)
    {
        var bytes = Encoding.UTF8.GetBytes(input ?? string.Empty);
        var hash = SHA256.HashData(bytes);
        return Convert.ToHexString(hash).ToLowerInvariant();
    }

    public async Task<List<Message>> GetHistoryAsync(string sessionId, int limit = 50)
    {
        var session = await _sessionService.GetByIdAsync(sessionId);
        if (session == null)
        {
            return new List<Message>();
        }

        // 读取历史也视为“活跃”：用户可能长时间阅读/回看聊天记录，首次再提问不应因为纯阅读而过期。
        await _sessionService.RefreshActivityAsync(sessionId);

        var key = !string.IsNullOrEmpty(session.GroupId)
            ? CacheKeys.ForGroupChatHistory(session.GroupId)
            : CacheKeys.ForChatHistory(sessionId);

        var history = await _cache.GetAsync<List<Message>>(key);
        
        if (history == null)
            return new List<Message>();

        return history.TakeLast(limit).ToList();
    }

    public async Task<List<Message>> GetGroupHistoryAsync(string groupId, int limit = 100)
    {
        // TODO: 从MongoDB获取群组历史消息
        await Task.CompletedTask;
        return new List<Message>();
    }

    private async Task SaveMessagesToHistoryAsync(Session session, params Message[] messages)
    {
        var key = !string.IsNullOrEmpty(session.GroupId)
            ? CacheKeys.ForGroupChatHistory(session.GroupId)
            : CacheKeys.ForChatHistory(session.SessionId);

        var history = await _cache.GetAsync<List<Message>>(key) ?? new List<Message>();
        
        history.AddRange(messages);
        
        // 保留最近100条消息
        if (history.Count > 100)
        {
            history = history.TakeLast(100).ToList();
        }

        // 滑动过期：每次写入刷新 TTL
        await _cache.SetAsync(key, history, ChatHistoryExpiry);
    }
}
