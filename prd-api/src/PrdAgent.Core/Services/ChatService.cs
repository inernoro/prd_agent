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
    private readonly IIdGenerator _idGenerator;
    private static readonly TimeSpan ChatHistoryExpiry = TimeSpan.FromMinutes(30);
    private static readonly TimeSpan GroupContextCompressionExpiry = TimeSpan.FromHours(24);
    private const int GroupContextCompressionThresholdChars = 50_000; // 群上下文超过 5 万字触发（不含 PRD）
    private const int GroupContextCompressionTargetKeepChars = 18_000; // 保留“未压缩近期消息”的目标字符数（不含 PRD）
    private const int GroupContextCompressionMinKeepCount = 8; // 至少保留最近 N 条原文消息
    private const string SysCompressionNoticeMarker = "[[SYS:CONTEXT_COMPRESSED]]";
    private const string LlmGroupSummaryMarkerOpen = "[[CONTEXT:GROUP_COMPRESSED]]";
    private const string LlmGroupSummaryMarkerClose = "[[/CONTEXT:GROUP_COMPRESSED]]";

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
        ILLMRequestContextAccessor llmRequestContext,
        IIdGenerator idGenerator)
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
        _idGenerator = idGenerator;
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

        var effectiveRunId = string.IsNullOrWhiteSpace(runId) ? await _idGenerator.GenerateIdAsync("run") : runId.Trim();
        var userMessageId = string.IsNullOrWhiteSpace(fixedUserMessageId) ? await _idGenerator.GenerateIdAsync("message") : fixedUserMessageId.Trim();

        // 生成（或固定）assistant 消息ID
        var messageId = string.IsNullOrWhiteSpace(fixedAssistantMessageId) ? await _idGenerator.GenerateIdAsync("message") : fixedAssistantMessageId.Trim();

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
        string llmUserContent = content ?? string.Empty;
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
        var historyLimit = string.IsNullOrWhiteSpace(session.GroupId) ? 20 : 100;
        var history = await GetHistoryAsync(sessionId, historyLimit);

        // 群上下文压缩：当群上下文（不含 PRD）超过 5 万字时，将较早消息压缩成摘要注入 LLM
        GroupContextCompressionState? compressionState = null;
        GroupContextCompressionInfo? compressionInfoForLog = null;
        if (!string.IsNullOrWhiteSpace(session.GroupId))
        {
            var gid = session.GroupId.Trim();
            compressionState = await TryLoadGroupCompressionStateAsync(gid);
            if (compressionState != null && compressionState.ToSeq > 0 && !string.IsNullOrWhiteSpace(compressionState.CompressedText))
            {
                // 即使本次没有“新发生压缩”，也要在主请求日志里标记“使用了压缩后的群上下文”
                compressionInfoForLog = new GroupContextCompressionInfo(
                    Applied: true,
                    GroupId: gid,
                    FromSeq: compressionState.FromSeq,
                    ToSeq: compressionState.ToSeq,
                    OriginalChars: compressionState.OriginalChars,
                    CompressedChars: compressionState.CompressedChars,
                    CompressedText: compressionState.CompressedText);
            }

            static bool IsSysNotice(Message m)
                => !string.IsNullOrEmpty(m?.Content) && m.Content.Contains(SysCompressionNoticeMarker, StringComparison.Ordinal);

            // 仅对“将要拼进 LLM 上下文的消息”做压缩规划（不影响历史回放接口）
            var ordered = history
                .Where(m => m != null && !IsSysNotice(m))
                .OrderBy(m => m.GroupSeq ?? long.MaxValue)
                .ThenBy(m => m.Timestamp)
                .ToList();

            // 若已有压缩状态，则避免重复喂入已覆盖范围的原始消息
            if (compressionState != null && compressionState.ToSeq > 0)
            {
                ordered = ordered
                    .Where(m => (m.GroupSeq ?? long.MaxValue) > compressionState.ToSeq)
                    .ToList();
            }

            var totalCharsBefore = ordered.Sum(m => (m.Content ?? string.Empty).Length) +
                                   (compressionState?.CompressedText?.Length ?? 0);

            if (totalCharsBefore > GroupContextCompressionThresholdChars && ordered.Count > 0)
            {
                var plan = GroupContextCompressionPlanner.CreatePlan(
                    ordered,
                    thresholdChars: GroupContextCompressionThresholdChars,
                    targetKeepMaxChars: GroupContextCompressionTargetKeepChars,
                    minKeepCount: GroupContextCompressionMinKeepCount);

                var toCompress = plan.ToCompress.ToList();
                var keepRaw = plan.KeepRaw.ToList();

                // 若没有可压缩内容但仍超阈值，退化：压缩 keep 的前半段，至少保留 2 条原文
                if (toCompress.Count == 0 && keepRaw.Count > 2)
                {
                    var split = Math.Max(0, keepRaw.Count - 2);
                    toCompress = keepRaw.Take(split).ToList();
                    keepRaw = keepRaw.Skip(split).ToList();
                }

                if (toCompress.Count > 0)
                {
                    var fromSeq = toCompress.FirstOrDefault()?.GroupSeq;
                    var toSeq = toCompress.LastOrDefault()?.GroupSeq;
                    if (fromSeq.HasValue && toSeq.HasValue)
                    {
                        var newState = await CompressGroupContextAsync(
                            groupId: gid,
                            currentUserContent: llmUserContent,
                            previousState: compressionState,
                            toCompress: toCompress,
                            cancellationToken: cancellationToken);

                        if (newState != null)
                        {
                            compressionState = newState;
                            await _cache.SetAsync(CacheKeys.ForGroupContextCompression(gid), compressionState, GroupContextCompressionExpiry);
                            await TryPublishCompressionNoticeAsync(session, compressionState);

                            compressionInfoForLog = new GroupContextCompressionInfo(
                                Applied: true,
                                GroupId: gid,
                                FromSeq: compressionState.FromSeq,
                                ToSeq: compressionState.ToSeq,
                                OriginalChars: compressionState.OriginalChars,
                                CompressedChars: compressionState.CompressedChars,
                                CompressedText: compressionState.CompressedText);

                            // 更新 ordered：仅保留压缩范围之后的原文（keepRaw 会自然落在其中）
                            ordered = ordered
                                .Where(m => (m.GroupSeq ?? long.MaxValue) > compressionState.ToSeq)
                                .ToList();
                        }
                    }
                }

                history = ordered;
            }
            else
            {
                history = ordered;
            }
        }

        var messages = new List<LLMMessage>
        {
            // 首条 user message：PRD 资料（日志侧会按标记脱敏，不落库 PRD 原文）
            new() { Role = "user", Content = _promptManager.BuildPrdContextMessage(document.RawContent) }
        };

        // 压缩摘要作为资料注入（不含 PRD）
        if (compressionState != null &&
            compressionState.ToSeq > 0 &&
            !string.IsNullOrWhiteSpace(compressionState.CompressedText))
        {
            var summary = BuildLlmGroupCompressedContextMessage(compressionState);
            if (!string.IsNullOrWhiteSpace(summary))
            {
                messages.Add(new LLMMessage { Role = "user", Content = summary });
            }
        }

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
        var isFirstDelta = true; // 标记是否为第一个 delta（用于隐藏加载动画）

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
            RequestPurpose: "chat.sendMessage",
            GroupContextCompression: compressionInfoForLog));

        // 检查用户消息是否已存在（CreateRun 可能已创建）
        Message userMessage;
        var existingUserMessage = await _messageRepository.FindByIdAsync(userMessageId);
        if (existingUserMessage == null)
        {
            // 用户消息不存在（兼容旧版本/直接调用），创建并广播
            userMessage = new Message
            {
                Id = userMessageId,
                SessionId = sessionId,
                GroupId = session.GroupId ?? "",
                RunId = effectiveRunId,
                SenderId = userId,
                Role = MessageRole.User,
                Content = content ?? string.Empty,
                LlmRequestId = llmRequestId,
                ViewRole = session.CurrentRole,
                AttachmentIds = attachmentIds ?? new List<string>(),
                ResendOfMessageId = string.IsNullOrWhiteSpace(resendOfMessageId) ? null : resendOfMessageId!.Trim(),
                Timestamp = userInputAtUtc
            };
            if (!string.IsNullOrEmpty(gidForSeq))
            {
                // groupSeq 分配不应受 HTTP RequestAborted 影响（避免"客户端断线导致服务端闭环失败"）
                userMessage.GroupSeq = await _groupMessageSeqService.NextAsync(gidForSeq, CancellationToken.None);
            }
            await _messageRepository.InsertManyAsync(new[] { userMessage });
            if (!string.IsNullOrEmpty(gidForSeq))
            {
                _groupMessageStreamHub.Publish(userMessage);
            }
        }
        else
        {
            // 用户消息已存在（由 CreateRun 创建），仅更新附加字段（不修改 GroupSeq）
            existingUserMessage.LlmRequestId = llmRequestId;
            if (attachmentIds != null && attachmentIds.Count > 0)
            {
                existingUserMessage.AttachmentIds = attachmentIds;
            }
            if (!string.IsNullOrWhiteSpace(resendOfMessageId))
            {
                existingUserMessage.ResendOfMessageId = resendOfMessageId.Trim();
            }
            await _messageRepository.ReplaceOneAsync(existingUserMessage);
            userMessage = existingUserMessage;
        }

        // 提前获取对应角色的机器人用户ID（用于创建 AI 占位消息）
        var botUsername = session.CurrentRole switch
        {
            UserRole.PM => "bot_pm",
            UserRole.DEV => "bot_dev",
            UserRole.QA => "bot_qa",
            _ => "bot_dev" // 默认使用 DEV 机器人
        };
        var botUser = await _userService.GetByUsernameAsync(botUsername);
        var botUserId = botUser?.UserId;

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
                        // AI 首字到达：检查占位消息是否已存在（CreateRun 可能已创建）
                        if (!string.IsNullOrEmpty(gidForSeq) && !assistantSeqAtFirstToken.HasValue)
                        {
                            // 查询占位消息是否已存在
                            var existingMessage = await _messageRepository.FindByIdAsync(messageId);
                            
                            if (existingMessage != null && existingMessage.GroupSeq.HasValue)
                            {
                                // 占位消息已存在（由 CreateRun 创建），直接使用其 seq
                                assistantSeqAtFirstToken = existingMessage.GroupSeq.Value;
                            }
                            else
                            {
                                // 占位消息不存在（兼容旧版本/直接调用），创建并广播
                                assistantSeqAtFirstToken = await _groupMessageSeqService.NextAsync(gidForSeq, CancellationToken.None);
                                
                                var placeholderMessage = new Message
                                {
                                    Id = messageId,
                                    SessionId = sessionId,
                                    GroupId = session.GroupId ?? "",
                                    GroupSeq = assistantSeqAtFirstToken,
                                    RunId = effectiveRunId,
                                    SenderId = botUserId,
                                    Role = MessageRole.Assistant,
                                    Content = "",  // 空内容，表示占位
                                    ViewRole = session.CurrentRole,
                                    Timestamp = firstTokenAtUtc.Value
                                };
                                await _messageRepository.InsertManyAsync(new[] { placeholderMessage });
                                _groupMessageStreamHub.Publish(placeholderMessage);
                            }
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
                            // 只在"首个可见输出事件"上附带一次 TTFT 指标，便于前端直接消费
                            var ttftMs = (int)Math.Max(0, Math.Round((firstTokenAtUtc.Value - userInputAtUtc).TotalMilliseconds));
                            ev.RequestReceivedAtUtc = userInputAtUtc;
                            ev.StartAtUtc = startAtUtc;
                            ev.FirstTokenAtUtc = firstTokenAtUtc;
                            ev.TtftMs = ttftMs;
                            firstTokenMetricsEmitted = true;
                        }
                        yield return ev;

                        // 实时广播到群组流
                        if (!string.IsNullOrEmpty(gidForSeq))
                        {
                            if (bt.Type == "blockDelta" && !string.IsNullOrEmpty(bt.Content))
                            {
                                // Debug: 记录第一次发送
                                if (isFirstDelta)
                                {
                                    System.Diagnostics.Debug.WriteLine($"[ChatService] 首次广播 delta: blockId={bt.BlockId}, blockKind={bt.BlockKind}, contentLength={bt.Content?.Length}");
                                }
                                _groupMessageStreamHub.PublishDelta(gidForSeq, messageId, bt.Content, bt.BlockId, isFirstDelta);
                                isFirstDelta = false; // 后续 delta 不再标记为 first
                            }
                            else if (bt.Type == "blockEnd" && !string.IsNullOrEmpty(bt.BlockId))
                            {
                                _groupMessageStreamHub.PublishBlockEnd(gidForSeq, messageId, bt.BlockId);
                            }
                        }
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

                // 实时广播到群组流
                if (!string.IsNullOrEmpty(gidForSeq))
                {
                    if (bt.Type == "blockDelta" && !string.IsNullOrEmpty(bt.Content))
                    {
                        _groupMessageStreamHub.PublishDelta(gidForSeq, messageId, bt.Content, bt.BlockId, isFirstDelta);
                        isFirstDelta = false; // 后续 delta 不再标记为 first
                    }
                    else if (bt.Type == "blockEnd" && !string.IsNullOrEmpty(bt.BlockId))
                    {
                        _groupMessageStreamHub.PublishBlockEnd(gidForSeq, messageId, bt.BlockId);
                    }
                }
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

        // 保存AI回复（botUser 已在流式输出前获取）
        var assistantMessage = new Message
        {
            Id = messageId,
            SessionId = sessionId,
            GroupId = session.GroupId ?? "",
            RunId = effectiveRunId,
            Role = MessageRole.Assistant,
            SenderId = botUser?.UserId, // AI 机器人也使用 SenderId（统一模型）
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

        // 如果已经创建了占位消息（assistantSeqAtFirstToken 有值），则更新；否则插入
        if (assistantSeqAtFirstToken.HasValue)
        {
            await _messageRepository.ReplaceOneAsync(assistantMessage);
        }
        else
        {
            await _messageRepository.InsertManyAsync(new[] { assistantMessage });
        }

        // 群广播：如果是更新（占位消息已存在），使用 PublishUpdated；否则使用 Publish
        if (!string.IsNullOrEmpty(gidForSeq))
        {
            if (assistantSeqAtFirstToken.HasValue)
            {
                // 占位消息已存在，广播更新事件（避免因 seq 去重被跳过）
                _groupMessageStreamHub.PublishUpdated(assistantMessage);
            }
            else
            {
                // 新消息，正常广播
                _groupMessageStreamHub.Publish(assistantMessage);
            }
            
            // 广播 citations（引用/注脚）到群组流
            if (citations.Count > 0)
            {
                _groupMessageStreamHub.PublishCitations(gidForSeq, messageId, citations);
            }
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

    private static string BuildLlmGroupCompressedContextMessage(GroupContextCompressionState state)
    {
        var gid = (state.GroupId ?? string.Empty).Trim();
        var text = (state.CompressedText ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(gid) || string.IsNullOrWhiteSpace(text)) return string.Empty;

        // 作为“资料”而非指令：使用明确标记包裹，便于日志/排障和未来扩展过滤
        return $"{LlmGroupSummaryMarkerOpen}\n" +
               $"<GROUP id=\"{gid}\" seqFrom=\"{state.FromSeq}\" seqTo=\"{state.ToSeq}\" createdAtUtc=\"{state.CreatedAtUtc:O}\">\n" +
               $"{text}\n" +
               "</GROUP>\n" +
               $"{LlmGroupSummaryMarkerClose}";
    }

    private async Task<GroupContextCompressionState?> TryLoadGroupCompressionStateAsync(string groupId)
    {
        var gid = (groupId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(gid)) return null;
        try
        {
            var state = await _cache.GetAsync<GroupContextCompressionState>(CacheKeys.ForGroupContextCompression(gid));
            if (state == null) return null;
            if (!string.Equals(state.GroupId, gid, StringComparison.Ordinal)) state.GroupId = gid;
            if (state.ToSeq <= 0) return null;
            if (string.IsNullOrWhiteSpace(state.CompressedText)) return null;
            return state;
        }
        catch
        {
            return null;
        }
    }

    private async Task<GroupContextCompressionState?> CompressGroupContextAsync(
        string groupId,
        string currentUserContent,
        GroupContextCompressionState? previousState,
        List<Message> toCompress,
        CancellationToken cancellationToken)
    {
        var gid = (groupId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(gid)) return null;
        if (toCompress.Count == 0) return null;

        // 要求按 seq 升序
        toCompress = toCompress
            .Where(m => m.GroupSeq.HasValue)
            .OrderBy(m => m.GroupSeq!.Value)
            .ToList();
        if (toCompress.Count == 0) return null;

        var fromSeq = toCompress.First().GroupSeq!.Value;
        var toSeq = toCompress.Last().GroupSeq!.Value;
        if (fromSeq <= 0 || toSeq <= 0 || toSeq < fromSeq) return null;

        // 组装原文（不包含 PRD）
        var sb = new StringBuilder(capacity: 8 * 1024);
        if (previousState != null && previousState.ToSeq > 0 && !string.IsNullOrWhiteSpace(previousState.CompressedText))
        {
            sb.AppendLine("[[PREVIOUS_COMPRESSED_SUMMARY]]");
            sb.AppendLine($"groupId={gid} seqFrom={previousState.FromSeq} seqTo={previousState.ToSeq}");
            sb.AppendLine(previousState.CompressedText.Trim());
            sb.AppendLine("[[/PREVIOUS_COMPRESSED_SUMMARY]]");
            sb.AppendLine();
        }

        sb.AppendLine("[[TRANSCRIPT]]");
        foreach (var m in toCompress)
        {
            var seq = m.GroupSeq ?? 0;
            var role = m.Role == MessageRole.User ? "user" : "assistant";
            var content = (m.Content ?? string.Empty).Trim();
            if (content.Length == 0) continue;
            sb.Append("[seq=").Append(seq).Append(' ').Append(role).AppendLine("]");
            sb.AppendLine(content);
            sb.AppendLine();
        }
        sb.AppendLine("[[/TRANSCRIPT]]");

        var originalText = sb.ToString();
        var originalChars = originalText.Length;

        // 压缩 prompt：聚焦当前请求核心
        var compressorSystemPrompt = """
你是一个“群聊上下文压缩器”。你的任务是把历史对话压缩成一段可供后续继续对话的【资料摘要】，用于替代冗长历史。

严格要求：
- 只基于提供的历史对话，不得编造任何不存在的信息。
- 必须保留与“当前用户请求/目标”相关的事实、决定、约束、已完成/未完成事项、重要数字/ID/命名、关键分歧与结论。
- 允许丢弃闲聊、重复、与当前目标无关的细枝末节。
- 输出必须是中文，且不要输出任何解释过程，只输出摘要正文。
- 不要输出 PRD 原文（本输入不包含 PRD；如你发现类似资料标记，也只需概括，不要复述长文）。

推荐结构（可按需调整，但请保持清晰）：
1) 当前目标/问题
2) 已确认事实与约束
3) 已做决定/结论
4) 未决问题/待办
5) 关键上下文（必要时用短段落/要点）
""";

        var compressorUserPrompt = $"""
当前用户请求/目标（必须优先围绕它保留信息）：
{(currentUserContent ?? string.Empty).Trim()}

需要压缩的历史内容（按 seq 顺序）：
{originalText}
""";

        // 单独记录一次“压缩调用”的 LLM 日志；主请求日志会以字段形式记录“压缩发生了什么”
        var compressRequestId = Guid.NewGuid().ToString();
        using var _ = _llmRequestContext.BeginScope(new LlmRequestContext(
            RequestId: compressRequestId,
            GroupId: gid,
            SessionId: null,
            UserId: null,
            ViewRole: null,
            DocumentChars: null,
            DocumentHash: null,
            SystemPromptRedacted: "[GROUP_CONTEXT_COMPRESSOR]",
            RequestType: "reasoning",
            RequestPurpose: "chat.groupContextCompress"));

        var chunks = _llmClient.StreamGenerateAsync(
            compressorSystemPrompt,
            new List<LLMMessage> { new() { Role = "user", Content = compressorUserPrompt } },
            cancellationToken);

        var outSb = new StringBuilder(capacity: 8 * 1024);
        await foreach (var c in chunks.WithCancellation(cancellationToken))
        {
            if (c.Type == "delta" && !string.IsNullOrEmpty(c.Content))
            {
                outSb.Append(c.Content);
            }
            else if (c.Type == "error")
            {
                return null;
            }
        }

        var compressed = outSb.ToString().Trim();
        if (string.IsNullOrWhiteSpace(compressed)) return null;

        // 扩展覆盖范围：previousState 存在则从 previous.FromSeq 起覆盖到新的 toSeq
        var finalFrom = previousState != null && previousState.FromSeq > 0 ? previousState.FromSeq : fromSeq;
        var finalTo = toSeq;

        return new GroupContextCompressionState
        {
            GroupId = gid,
            FromSeq = finalFrom,
            ToSeq = finalTo,
            OriginalChars = originalChars,
            CompressedChars = compressed.Length,
            CompressedText = compressed,
            CreatedAtUtc = DateTime.UtcNow
        };
    }

    private async Task TryPublishCompressionNoticeAsync(Session session, GroupContextCompressionState state)
    {
        try
        {
            var gid = (session.GroupId ?? string.Empty).Trim();
            if (string.IsNullOrWhiteSpace(gid)) return;

            // 用当前会话角色对应的 bot 发一条“系统提示”
            var botUsername = session.CurrentRole switch
            {
                UserRole.PM => "bot_pm",
                UserRole.DEV => "bot_dev",
                UserRole.QA => "bot_qa",
                _ => "bot_dev"
            };
            var botUser = await _userService.GetByUsernameAsync(botUsername);

            var notice = $"{SysCompressionNoticeMarker}\n" +
                         "系统提示：由于群上下文历史内容过长（超过 50000 字），已自动进行上下文压缩。\n" +
                         $"已压缩范围：seq{state.FromSeq}-seq{state.ToSeq}。\n" +
                         "后续对话将以“压缩摘要”替代更早的原始历史作为上下文（PRD 不受影响）。";

            var msg = new Message
            {
                Id = await _idGenerator.GenerateIdAsync("message"),
                SessionId = session.SessionId,
                GroupId = gid,
                SenderId = botUser?.UserId,
                Role = MessageRole.Assistant,
                Content = notice,
                Timestamp = DateTime.UtcNow
            };
            msg.GroupSeq = await _groupMessageSeqService.NextAsync(gid, CancellationToken.None);
            await _messageRepository.InsertManyAsync(new[] { msg });
            _groupMessageStreamHub.Publish(msg);
        }
        catch
        {
            // 通知失败不影响主流程
        }
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
