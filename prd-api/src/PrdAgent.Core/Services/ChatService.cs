using System.Runtime.CompilerServices;
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

    public ChatService(
        ILLMClient llmClient,
        ISessionService sessionService,
        IDocumentService documentService,
        ICacheManager cache,
        IPromptManager promptManager,
        IUserService userService)
    {
        _llmClient = llmClient;
        _sessionService = sessionService;
        _documentService = documentService;
        _cache = cache;
        _promptManager = promptManager;
        _userService = userService;
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

        await foreach (var chunk in _llmClient.StreamGenerateAsync(systemPrompt, messages, cancellationToken))
        {
            if (chunk.Type == "delta" && !string.IsNullOrEmpty(chunk.Content))
            {
                fullResponse.Append(chunk.Content);
                yield return new ChatStreamEvent
                {
                    Type = "delta",
                    Content = chunk.Content
                };
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
        await SaveMessagesToHistoryAsync(sessionId, userMessage, assistantMessage);

        // 刷新会话活跃时间
        await _sessionService.RefreshActivityAsync(sessionId);

        yield return new ChatStreamEvent
        {
            Type = "done",
            MessageId = messageId,
            TokenUsage = assistantMessage.TokenUsage
        };
    }

    public async Task<List<Message>> GetHistoryAsync(string sessionId, int limit = 50)
    {
        var key = CacheKeys.ForChatHistory(sessionId);
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

    private async Task SaveMessagesToHistoryAsync(string sessionId, params Message[] messages)
    {
        var key = CacheKeys.ForChatHistory(sessionId);
        var history = await _cache.GetAsync<List<Message>>(key) ?? new List<Message>();
        
        history.AddRange(messages);
        
        // 保留最近100条消息
        if (history.Count > 100)
        {
            history = history.TakeLast(100).ToList();
        }

        await _cache.SetAsync(key, history);
    }
}
