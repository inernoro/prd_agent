using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

namespace PrdAgent.Core.Services;

/// <summary>
/// 引导讲解服务实现
/// </summary>
public class GuideService : IGuideService
{
    private readonly ILLMClient _llmClient;
    private readonly ISessionService _sessionService;
    private readonly IDocumentService _documentService;
    private readonly IPromptManager _promptManager;
    private readonly IPromptStageService _promptStageService;
    private readonly ILLMRequestContextAccessor _llmRequestContext;

    public GuideService(
        ILLMClient llmClient,
        ISessionService sessionService,
        IDocumentService documentService,
        IPromptManager promptManager,
        IPromptStageService promptStageService,
        ILLMRequestContextAccessor llmRequestContext)
    {
        _llmClient = llmClient;
        _sessionService = sessionService;
        _documentService = documentService;
        _promptManager = promptManager;
        _promptStageService = promptStageService;
        _llmRequestContext = llmRequestContext;
    }

    public async IAsyncEnumerable<GuideStreamEvent> StartGuideAsync(
        string sessionId,
        UserRole role,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        // 切换到引导模式
        var session = await _sessionService.SwitchModeAsync(sessionId, InteractionMode.Guided);
        session = await _sessionService.SwitchRoleAsync(sessionId, role);

        // 获取第一步内容
        await foreach (var evt in GetStepContentAsync(sessionId, 1, cancellationToken))
        {
            yield return evt;
        }
    }

    public async Task<GuideControlResult> ControlAsync(string sessionId, GuideAction action, int? targetStep = null)
    {
        var session = await _sessionService.GetByIdAsync(sessionId)
            ?? throw new KeyNotFoundException("会话不存在");

        if (session.Mode != InteractionMode.Guided)
        {
            throw new InvalidOperationException("当前不在引导模式");
        }

        var currentStep = session.GuideStep ?? 1;
        var totalSteps = (await _promptStageService.GetEffectiveSettingsAsync()).Stages.Count;
        totalSteps = Math.Max(1, totalSteps);
        GuideStatus status = GuideStatus.InProgress;

        switch (action)
        {
            case GuideAction.Next:
                if (currentStep < totalSteps)
                {
                    currentStep++;
                }
                else
                {
                    status = GuideStatus.Completed;
                }
                break;

            case GuideAction.Previous:
                if (currentStep > 1)
                {
                    currentStep--;
                }
                break;

            case GuideAction.GoTo:
                if (targetStep.HasValue && targetStep.Value >= 1 && targetStep.Value <= totalSteps)
                {
                    currentStep = targetStep.Value;
                }
                break;

            case GuideAction.Stop:
                await _sessionService.SwitchModeAsync(sessionId, InteractionMode.QA);
                return new GuideControlResult
                {
                    CurrentStep = currentStep,
                    TotalSteps = totalSteps,
                    Status = GuideStatus.Stopped
                };
        }

        // 更新会话步骤
        session.GuideStep = currentStep;
        await _sessionService.UpdateAsync(session);

        return new GuideControlResult
        {
            CurrentStep = currentStep,
            TotalSteps = totalSteps,
            Status = status
        };
    }

    public async IAsyncEnumerable<GuideStreamEvent> GetStepContentAsync(
        string sessionId,
        int step,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        // 兼容旧接口：step(order) -> stageKey（order 在 role 内排序）
        var session = await _sessionService.GetByIdAsync(sessionId);
        if (session == null)
        {
            yield return new GuideStreamEvent
            {
                Type = "error",
                ErrorCode = ErrorCodes.SESSION_NOT_FOUND,
                ErrorMessage = "会话不存在或已过期"
            };
            yield break;
        }

        var stageKey = await _promptStageService.MapOrderToStageKeyAsync(session.CurrentRole, step, cancellationToken);
        if (string.IsNullOrWhiteSpace(stageKey))
        {
            yield return new GuideStreamEvent
            {
                Type = "error",
                ErrorCode = "INVALID_STEP",
                ErrorMessage = "无效的步骤"
            };
            yield break;
        }

        await foreach (var evt in GetStageContentAsync(sessionId, stageKey, cancellationToken))
        {
            yield return evt;
        }
    }

    public async IAsyncEnumerable<GuideStreamEvent> GetStageContentAsync(
        string sessionId,
        string stageKey,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        var session = await _sessionService.GetByIdAsync(sessionId);
        if (session == null)
        {
            yield return new GuideStreamEvent
            {
                Type = "error",
                ErrorCode = ErrorCodes.SESSION_NOT_FOUND,
                ErrorMessage = "会话不存在或已过期"
            };
            yield break;
        }

        var document = await _documentService.GetByIdAsync(session.DocumentId);
        if (document == null)
        {
            yield return new GuideStreamEvent
            {
                Type = "error",
                ErrorCode = ErrorCodes.DOCUMENT_NOT_FOUND,
                ErrorMessage = "文档不存在或已过期"
            };
            yield break;
        }

        var settings = await _promptStageService.GetEffectiveSettingsAsync(cancellationToken);
        var key = (stageKey ?? string.Empty).Trim();
        var stage = settings.Stages.FirstOrDefault(x =>
            string.Equals(x.StageKey, key, StringComparison.Ordinal) && x.Role == session.CurrentRole);
        if (stage == null)
        {
            yield return new GuideStreamEvent
            {
                Type = "error",
                ErrorCode = "INVALID_STAGE",
                ErrorMessage = "无效的阶段"
            };
            yield break;
        }

        var totalSteps = Math.Max(1, settings.Stages.Count(x => x.Role == session.CurrentRole));
        var order = stage.Order;
        var rp = new RoleStagePrompt { Title = stage.Title, PromptTemplate = stage.PromptTemplate };

        yield return new GuideStreamEvent
        {
            Type = "step",
            Step = order,
            TotalSteps = totalSteps,
            Title = rp.Title
        };

        // 构建系统Prompt（PRD 不再注入 system；改为 user/context message 传入）
        var systemPrompt = _promptManager.BuildSystemPrompt(session.CurrentRole, prdContent: string.Empty);
        var systemPromptRedacted = _promptManager.BuildSystemPrompt(session.CurrentRole, prdContent: string.Empty);
        var docHash = Sha256Hex(document.RawContent);

        // 构建讲解请求
        var messages = new List<LLMMessage>
        {
            // PRD 资料（日志侧会按标记脱敏，不落库 PRD 原文）
            new() { Role = "user", Content = _promptManager.BuildPrdContextMessage(document.RawContent) },
            // 阶段讲解提示词
            new() { Role = "user", Content = rp.PromptTemplate }
        };

        // 调用LLM
        var llmRequestId = Guid.NewGuid().ToString();
        var blockTokenizer = new MarkdownBlockTokenizer();
        var fullResponse = new StringBuilder();
        using var _ = _llmRequestContext.BeginScope(new LlmRequestContext(
            RequestId: llmRequestId,
            GroupId: session.GroupId,
            SessionId: session.SessionId,
            UserId: null,
            ViewRole: session.CurrentRole.ToString(),
            DocumentChars: document.RawContent?.Length ?? 0,
            DocumentHash: docHash,
            SystemPromptRedacted: systemPromptRedacted,
            RequestType: "reasoning",
            RequestPurpose: "guide.step"));

        await foreach (var chunk in _llmClient.StreamGenerateAsync(systemPrompt, messages, cancellationToken))
        {
            if (chunk.Type == "delta" && !string.IsNullOrEmpty(chunk.Content))
            {
                fullResponse.Append(chunk.Content);
                foreach (var bt in blockTokenizer.Push(chunk.Content))
                {
                    yield return new GuideStreamEvent
                    {
                        Type = bt.Type,
                        Step = order,
                        Content = bt.Content,
                        BlockId = bt.BlockId,
                        BlockKind = bt.BlockKind,
                        BlockLanguage = bt.Language
                    };
                }
            }
            else if (chunk.Type == "error")
            {
                yield return new GuideStreamEvent
                {
                    Type = "error",
                    ErrorCode = ErrorCodes.LLM_ERROR,
                    ErrorMessage = chunk.ErrorMessage
                };
                yield break;
            }
        }

        foreach (var bt in blockTokenizer.Flush())
        {
            yield return new GuideStreamEvent
            {
                Type = bt.Type,
                Step = order,
                Content = bt.Content,
                BlockId = bt.BlockId,
                BlockKind = bt.BlockKind,
                BlockLanguage = bt.Language
            };
        }

        // 更新会话步骤
        session.GuideStep = order;
        await _sessionService.UpdateAsync(session);

        // 引用依据（SSE 事件，仅会话内下发；不落库）
        var citations = DocCitationExtractor.Extract(document, fullResponse.ToString(), maxCitations: 12);
        if (citations.Count > 0)
        {
            yield return new GuideStreamEvent
            {
                Type = "citations",
                Step = order,
                Citations = citations
            };
        }

        yield return new GuideStreamEvent
        {
            Type = "stepDone",
            Step = order
        };
    }

    public async Task<List<GuideOutlineItem>> GetOutlineAsync(UserRole role, CancellationToken cancellationToken = default)
    {
        return await _promptStageService.GetGuideOutlineAsync(role, cancellationToken);
    }

    private static string Sha256Hex(string input)
    {
        var bytes = Encoding.UTF8.GetBytes(input ?? string.Empty);
        var hash = SHA256.HashData(bytes);
        return Convert.ToHexString(hash).ToLowerInvariant();
    }
}
