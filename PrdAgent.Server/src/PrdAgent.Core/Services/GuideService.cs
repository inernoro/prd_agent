using System.Runtime.CompilerServices;
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
    private const int TotalSteps = 6;

    public GuideService(
        ILLMClient llmClient,
        ISessionService sessionService,
        IDocumentService documentService,
        IPromptManager promptManager)
    {
        _llmClient = llmClient;
        _sessionService = sessionService;
        _documentService = documentService;
        _promptManager = promptManager;
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
        GuideStatus status = GuideStatus.InProgress;

        switch (action)
        {
            case GuideAction.Next:
                if (currentStep < TotalSteps)
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
                if (targetStep.HasValue && targetStep.Value >= 1 && targetStep.Value <= TotalSteps)
                {
                    currentStep = targetStep.Value;
                }
                break;

            case GuideAction.Stop:
                await _sessionService.SwitchModeAsync(sessionId, InteractionMode.QA);
                return new GuideControlResult
                {
                    CurrentStep = currentStep,
                    TotalSteps = TotalSteps,
                    Status = GuideStatus.Stopped
                };
        }

        // 更新会话步骤
        session.GuideStep = currentStep;
        await _sessionService.UpdateAsync(session);

        return new GuideControlResult
        {
            CurrentStep = currentStep,
            TotalSteps = TotalSteps,
            Status = status
        };
    }

    public async IAsyncEnumerable<GuideStreamEvent> GetStepContentAsync(
        string sessionId,
        int step,
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

        var outline = GetOutline(session.CurrentRole);
        var outlineItem = outline.FirstOrDefault(o => o.Step == step);
        
        if (outlineItem == null)
        {
            yield return new GuideStreamEvent
            {
                Type = "error",
                ErrorCode = "INVALID_STEP",
                ErrorMessage = "无效的步骤"
            };
            yield break;
        }

        yield return new GuideStreamEvent
        {
            Type = "step",
            Step = step,
            TotalSteps = TotalSteps,
            Title = outlineItem.Title
        };

        // 构建系统Prompt
        var systemPrompt = _promptManager.BuildSystemPrompt(session.CurrentRole, document.RawContent);

        // 构建讲解请求
        var messages = new List<LLMMessage>
        {
            new() { Role = "user", Content = outlineItem.PromptTemplate }
        };

        // 调用LLM
        await foreach (var chunk in _llmClient.StreamGenerateAsync(systemPrompt, messages, cancellationToken))
        {
            if (chunk.Type == "delta" && !string.IsNullOrEmpty(chunk.Content))
            {
                yield return new GuideStreamEvent
                {
                    Type = "delta",
                    Content = chunk.Content
                };
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

        // 更新会话步骤
        session.GuideStep = step;
        await _sessionService.UpdateAsync(session);

        yield return new GuideStreamEvent
        {
            Type = "stepDone",
            Step = step
        };
    }

    public List<GuideOutlineItem> GetOutline(UserRole role)
    {
        return _promptManager.GetGuideOutline(role);
    }
}
