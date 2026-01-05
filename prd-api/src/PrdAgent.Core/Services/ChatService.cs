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
    private readonly IGroupMessageSeqService _groupMessageSeqService;
    private readonly IGroupMessageStreamHub _groupMessageStreamHub;
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
        IGroupMessageSeqService groupMessageSeqService,
        IGroupMessageStreamHub groupMessageStreamHub,
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
        _groupMessageSeqService = groupMessageSeqService;
        _groupMessageStreamHub = groupMessageStreamHub;
        _llmRequestContext = llmRequestContext;
    }

    public async IAsyncEnumerable<ChatStreamEvent> SendMessageAsync(
        string sessionId,
        string content,
        string? resendOfMessageId = null,
        string? promptKey = null,
        string? userId = null,
        List<string>? attachmentIds = null,
        string? runId = null,
        string? fixedUserMessageId = null,
        string? fixedAssistantMessageId = null,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        // 真实“用户输入时间”：以服务端收到请求并进入业务处理的时间为准（UTC）
        var userInputAtUtc = DateTime.UtcNow;
        var startAtUtc = DateTime.UtcNow;
        DateTime? firstTokenAtUtc = null;
        var firstTokenMetricsEmitted = false;
        long? assistantSeqAtFirstToken = null;

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

        var effectiveRunId = string.IsNullOrWhiteSpace(runId) ? Guid.NewGuid().ToString("N") : runId.Trim();
        var userMessageId = string.IsNullOrWhiteSpace(fixedUserMessageId) ? Guid.NewGuid().ToString("N") : fixedUserMessageId.Trim();

        // 生成（或固定）assistant 消息ID
        var messageId = string.IsNullOrWhiteSpace(fixedAssistantMessageId) ? Guid.NewGuid().ToString("N") : fixedAssistantMessageId.Trim();

        startAtUtc = DateTime.UtcNow;
        yield return new ChatStreamEvent
        {
            Type = "start",
            MessageId = messageId,
            Sender = senderInfo,
            RequestReceivedAtUtc = userInputAtUtc,
            StartAtUtc = startAtUtc
        };

        // 群消息顺序键：新逻辑
        // - User：请求到达服务器即分配一次 seq，并立即落库+广播
        // - Assistant：首字到达时再分配一次 seq，落库+广播在最终完成时统一执行
        var gidForSeq = (session.GroupId ?? string.Empty).Trim();

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
        var terminatedWithError = false;
        string? terminatedErrorMessage = null;

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

        // 先保存/广播用户消息（避免等 AI 结束才看到用户消息；并与 seq 分配语义一致）
        var userMessage = new Message
        {
            Id = userMessageId,
            SessionId = sessionId,
            GroupId = session.GroupId ?? "",
            RunId = effectiveRunId,
            SenderId = userId,
            Role = MessageRole.User,
            Content = content,
            LlmRequestId = llmRequestId,
            ViewRole = session.CurrentRole,
            AttachmentIds = attachmentIds ?? new List<string>(),
            ResendOfMessageId = string.IsNullOrWhiteSpace(resendOfMessageId) ? null : resendOfMessageId!.Trim(),
            Timestamp = userInputAtUtc
        };
        if (!string.IsNullOrEmpty(gidForSeq))
        {
            // groupSeq 分配不应受 HTTP RequestAborted 影响（避免“客户端断线导致服务端闭环失败”）
            userMessage.GroupSeq = await _groupMessageSeqService.NextAsync(gidForSeq, CancellationToken.None);
        }
        await _messageRepository.InsertManyAsync(new[] { userMessage });
        if (!string.IsNullOrEmpty(gidForSeq))
        {
            _groupMessageStreamHub.Publish(userMessage);
        }

        var enumerator = _llmClient.StreamGenerateAsync(systemPrompt, messages, cancellationToken).GetAsyncEnumerator(cancellationToken);
        try
        {
            while (true)
            {
                bool moved;
                try
                {
                    moved = await enumerator.MoveNextAsync();
                }
                catch (OperationCanceledException)
                {
                    terminatedWithError = true;
                    terminatedErrorMessage = "请求已取消";
                    break;
                }
                catch
                {
                    terminatedWithError = true;
                    terminatedErrorMessage = "LLM调用失败";
                    break;
                }

                if (!moved) break;

                var chunk = enumerator.Current;
                if (chunk.Type == "delta" && !string.IsNullOrEmpty(chunk.Content))
                {
                    if (!firstTokenAtUtc.HasValue)
                    {
                        firstTokenAtUtc = DateTime.UtcNow;
                        // AI 首字到达：分配 assistant seq（仅一次）
                        if (!string.IsNullOrEmpty(gidForSeq) && !assistantSeqAtFirstToken.HasValue)
                        {
                            assistantSeqAtFirstToken = await _groupMessageSeqService.NextAsync(gidForSeq, CancellationToken.None);
                        }
                    }
                    fullResponse.Append(chunk.Content);
                    foreach (var bt in blockTokenizer.Push(chunk.Content))
                    {
                        var ev = new ChatStreamEvent
                        {
                            Type = bt.Type,
                            MessageId = messageId,
                            Content = bt.Content,
                            BlockId = bt.BlockId,
                            BlockKind = bt.BlockKind,
                            BlockLanguage = bt.Language
                        };
                        if (!firstTokenMetricsEmitted && firstTokenAtUtc.HasValue)
                        {
                            // 只在“首个可见输出事件”上附带一次 TTFT 指标，便于前端直接消费
                            var ttftMs = (int)Math.Max(0, Math.Round((firstTokenAtUtc.Value - userInputAtUtc).TotalMilliseconds));
                            ev.RequestReceivedAtUtc = userInputAtUtc;
                            ev.StartAtUtc = startAtUtc;
                            ev.FirstTokenAtUtc = firstTokenAtUtc;
                            ev.TtftMs = ttftMs;
                            firstTokenMetricsEmitted = true;
                        }
                        yield return ev;
                    }
                }
                else if (chunk.Type == "done")
                {
                    inputTokens = chunk.InputTokens ?? 0;
                    outputTokens = chunk.OutputTokens ?? 0;
                }
                else if (chunk.Type == "error")
                {
                    terminatedWithError = true;
                    terminatedErrorMessage = chunk.ErrorMessage ?? "LLM调用失败";
                    break;
                }
            }
        }
        finally
        {
            await enumerator.DisposeAsync();
        }

        if (terminatedWithError)
        {
            yield return new ChatStreamEvent
            {
                Type = "error",
                ErrorCode = ErrorCodes.LLM_ERROR,
                ErrorMessage = terminatedErrorMessage ?? "LLM调用失败"
            };
        }

        // 流结束：冲刷尾部（半行/未闭合段落/代码块）
        if (!terminatedWithError)
        {
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
        }

        // 真实“AI 完成时间”：用于耗时统计/SSE doneAt（不用于落库 Timestamp）
        var assistantDoneAtUtc = DateTime.UtcNow;
        if (assistantDoneAtUtc <= userInputAtUtc)
        {
            assistantDoneAtUtc = userInputAtUtc.AddTicks(1);
        }

        // 你的规约：落库时间以“首字时间（TTFT 对齐的 firstTokenAtUtc）”为准，不使用最终完成时间。
        // - 若模型未产出任何可见 token（firstTokenAtUtc=null），退化为 startAtUtc（仍保证 >= userInputAtUtc）。
        var assistantStoreAtUtc = firstTokenAtUtc ?? startAtUtc;
        if (assistantStoreAtUtc <= userInputAtUtc)
        {
            assistantStoreAtUtc = userInputAtUtc.AddTicks(1);
        }

        // 保存用户消息
        // userMessage 已在请求开始阶段落库/广播，这里仅复用变量参与缓存拼接与关联

        // 保存AI回复
        var assistantMessage = new Message
        {
            Id = messageId,
            SessionId = sessionId,
            GroupId = session.GroupId ?? "",
            RunId = effectiveRunId,
            Role = MessageRole.Assistant,
            Content = terminatedWithError
                ? (string.IsNullOrWhiteSpace(terminatedErrorMessage) ? "LLM调用失败" : $"请求失败：{terminatedErrorMessage}")
                : fullResponse.ToString(),
            LlmRequestId = llmRequestId,
            ReplyToMessageId = userMessage.Id,
            ViewRole = session.CurrentRole,
            TokenUsage = new TokenUsage
            {
                Input = inputTokens,
                Output = outputTokens
            },
            Timestamp = assistantStoreAtUtc
        };

        // 引用依据（SSE 事件，仅会话内下发；不落库）
        var citations = DocCitationExtractor.Extract(document, assistantMessage.Content, maxCitations: 12);

        // 更新对话历史缓存
        await SaveMessagesToHistoryAsync(session, userMessage, assistantMessage);

        // 写入 MongoDB（用于后台追溯与统计）
        // 注意：日志中不得打印消息原文；仓储层不记录日志，这里也不记录 content

        if (!string.IsNullOrEmpty(gidForSeq))
        {
            // 若全程没有产生可见 token，则 assistantSeq 可能未分配；此时在落库前兜底分配一次
            assistantMessage.GroupSeq = assistantSeqAtFirstToken
                ?? await _groupMessageSeqService.NextAsync(gidForSeq, CancellationToken.None);
        }

        await _messageRepository.InsertManyAsync(new[] { assistantMessage });

        // 群广播：只广播“消息级别”事件（user + assistant final），token/delta 不广播
        if (!string.IsNullOrEmpty(gidForSeq))
        {
            _groupMessageStreamHub.Publish(assistantMessage);
        }

        // 刷新会话活跃时间
        await _sessionService.RefreshActivityAsync(sessionId);

        // 失败也要占位：此处已完成 user+assistant（错误消息）落库与群广播；不再下发 citations/done
        if (terminatedWithError)
        {
            yield return new ChatStreamEvent
            {
                Type = "error",
                MessageId = messageId,
                ErrorCode = ErrorCodes.LLM_ERROR,
                ErrorMessage = string.IsNullOrWhiteSpace(terminatedErrorMessage) ? "LLM调用失败" : terminatedErrorMessage
            };
            yield break;
        }

        if (citations.Count > 0)
        {
            yield return new ChatStreamEvent
            {
                Type = "citations",
                MessageId = messageId,
                Citations = citations,
                RequestReceivedAtUtc = userInputAtUtc,
                StartAtUtc = startAtUtc,
                FirstTokenAtUtc = firstTokenAtUtc,
                DoneAtUtc = assistantDoneAtUtc,
                TtftMs = firstTokenAtUtc.HasValue
                    ? (int)Math.Max(0, Math.Round((firstTokenAtUtc.Value - userInputAtUtc).TotalMilliseconds))
                    : null
            };
        }

        yield return new ChatStreamEvent
        {
            Type = "done",
            MessageId = messageId,
            TokenUsage = assistantMessage.TokenUsage,
            RequestReceivedAtUtc = userInputAtUtc,
            StartAtUtc = startAtUtc,
            FirstTokenAtUtc = firstTokenAtUtc,
            DoneAtUtc = assistantDoneAtUtc,
            TtftMs = firstTokenAtUtc.HasValue
                ? (int)Math.Max(0, Math.Round((firstTokenAtUtc.Value - userInputAtUtc).TotalMilliseconds))
                : null
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
        var sid = (sessionId ?? string.Empty).Trim();
        if (string.IsNullOrEmpty(sid)) return new List<Message>();

        var take = Math.Clamp(limit, 1, 200);

        var session = await _sessionService.GetByIdAsync(sid);
        if (session == null)
        {
            // 兼容：session 元数据可能因 TTL/重启丢失，但消息已持久化在 Mongo。
            // 这里尽最大努力返回 session 维度历史（用于回放/诊断/后台工具），避免“数据看似丢失”。
            return await _messageRepository.FindBySessionAsync(sid, before: null, limit: take);
        }

        // 读取历史也视为“活跃”：用户可能长时间阅读/回看聊天记录，首次再提问不应因为纯阅读而过期。
        await _sessionService.RefreshActivityAsync(sid);

        var key = !string.IsNullOrEmpty(session.GroupId)
            ? CacheKeys.ForGroupChatHistory(session.GroupId)
            : CacheKeys.ForChatHistory(sid);

        // 群组上下文“重置点”：用于截断 LLM 上下文拼接（不影响消息历史回放接口）
        // 注意：仅删除缓存并不能真正重置，因为 cache miss 会回源 Mongo；所以这里必须按 reset marker 过滤。
        DateTime? groupResetAtUtc = null;
        if (!string.IsNullOrEmpty(session.GroupId))
        {
            var ticks = await _cache.GetAsync<long?>(CacheKeys.ForGroupContextReset(session.GroupId));
            if (ticks.HasValue && ticks.Value > 0)
            {
                try { groupResetAtUtc = new DateTime(ticks.Value, DateTimeKind.Utc); } catch { groupResetAtUtc = null; }
            }
        }

        var history = await _cache.GetAsync<List<Message>>(key);
        if (history != null && history.Count > 0)
        {
            // 若存在 reset marker，则只保留 reset 之后的消息用于上下文拼接
            if (groupResetAtUtc.HasValue)
            {
                history = history.Where(m => m.Timestamp > groupResetAtUtc.Value).ToList();
            }
            return history.TakeLast(take).ToList();
        }

        // cache miss：回源 Mongo，避免 Redis flush/服务重启/会话重建导致“上下文断链”
        List<Message> persisted;
        if (!string.IsNullOrEmpty(session.GroupId))
        {
            persisted = await _messageRepository.FindByGroupAsync(session.GroupId, before: null, limit: Math.Max(take, 50));
        }
        else
        {
            // 个人会话：按 sessionId 回放
            persisted = await _messageRepository.FindBySessionAsync(sid, before: null, limit: Math.Max(take, 50));
        }

        if (groupResetAtUtc.HasValue)
        {
            persisted = persisted.Where(m => m.Timestamp > groupResetAtUtc.Value).ToList();
        }

        // 回填 cache（仅用于 LLM 上下文拼接；历史回放仍走 Mongo API）
        if (persisted.Count > 0)
        {
            var capped = persisted.Count > 100 ? persisted.TakeLast(100).ToList() : persisted;
            await _cache.SetAsync(key, capped, ChatHistoryExpiry);
        }

        return persisted.TakeLast(take).ToList();
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

        // 群组 reset marker：防止旧 cache（或并发写入）把 reset 之前的消息再次带回上下文
        if (!string.IsNullOrEmpty(session.GroupId))
        {
            var ticks = await _cache.GetAsync<long?>(CacheKeys.ForGroupContextReset(session.GroupId));
            if (ticks.HasValue && ticks.Value > 0)
            {
                try
                {
                    var resetAtUtc = new DateTime(ticks.Value, DateTimeKind.Utc);
                    history = history.Where(m => m.Timestamp > resetAtUtc).ToList();
                }
                catch
                {
                    // ignore
                }
            }
        }
        
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
