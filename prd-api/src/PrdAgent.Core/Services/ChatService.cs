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
        IUserService userService,
        IMessageRepository messageRepository,
        ILLMRequestContextAccessor llmRequestContext)
    {
        _llmClient = llmClient;
        _sessionService = sessionService;
        _documentService = documentService;
        _cache = cache;
        _promptManager = promptManager;
        _userService = userService;
        _messageRepository = messageRepository;
        _llmRequestContext = llmRequestContext;
    }

    public async IAsyncEnumerable<ChatStreamEvent> SendMessageAsync(
        string sessionId,
        string content,
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
        var systemPrompt = _promptManager.BuildSystemPrompt(session.CurrentRole, document.RawContent);
        var systemPromptRedacted = _promptManager.BuildSystemPrompt(session.CurrentRole, "[PRD_CONTENT_REDACTED]");
        var docHash = Sha256Hex(document.RawContent);

        // 获取对话历史
        var history = await GetHistoryAsync(sessionId, 20);
        var messages = history.Select(m => new LLMMessage
        {
            Role = m.Role == MessageRole.User ? "user" : "assistant",
            Content = m.Content
        }).ToList();

        // 添加当前消息
        messages.Add(new LLMMessage
        {
            Role = "user",
            Content = content
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
            SystemPromptRedacted: systemPromptRedacted));

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
            ViewRole = session.CurrentRole,
            TokenUsage = new TokenUsage
            {
                Input = inputTokens,
                Output = outputTokens
            }
        };

        // 更新对话历史缓存
        await SaveMessagesToHistoryAsync(session, userMessage, assistantMessage);

        // 写入 MongoDB（用于后台追溯与统计）
        // 注意：日志中不得打印消息原文；仓储层不记录日志，这里也不记录 content
        await _messageRepository.InsertManyAsync(new[] { userMessage, assistantMessage });

        // 刷新会话活跃时间
        await _sessionService.RefreshActivityAsync(sessionId);

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
