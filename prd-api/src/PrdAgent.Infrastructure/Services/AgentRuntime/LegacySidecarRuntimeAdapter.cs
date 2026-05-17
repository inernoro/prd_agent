using System.Runtime.CompilerServices;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

namespace PrdAgent.Infrastructure.Services.AgentRuntime;

/// <summary>
/// MAP transport adapter for the sidecar protocol.
/// The per-run RuntimeAdapter field decides whether the sidecar uses the official Claude Agent SDK
/// loop or the legacy fallback; this layer only owns routing, SSE mapping, and cancel transport.
/// </summary>
public sealed class LegacySidecarRuntimeAdapter : IInfraAgentRuntimeAdapter
{
    private const string SourceName = "sidecar-runtime-adapter";
    private readonly IClaudeSidecarRouter _router;

    public LegacySidecarRuntimeAdapter(IClaudeSidecarRouter router)
    {
        _router = router;
    }

    public string RuntimeKey => InfraAgentRuntimes.ClaudeSdk;

    public string AdapterKind => SourceName;

    public bool IsConfigured => _router.IsConfigured;

    public int InstanceCount => _router.InstanceCount;

    public int HealthyCount => _router.HealthyCount;

    public IReadOnlyList<string> Blockers => _router.Blockers;

    public IReadOnlyList<string> NextActions => _router.NextActions;

    public async IAsyncEnumerable<InfraAgentRuntimeEvent> RunStreamAsync(
        InfraAgentRuntimeRunRequest request,
        [EnumeratorCancellation] CancellationToken ct)
    {
        var sidecarRequest = new SidecarRunRequest
        {
            RunId = request.RunId,
            Model = request.Model,
            SystemPrompt = request.SystemPrompt,
            Messages = request.Messages
                .Select(x => new SidecarChatMessage { Role = x.Role, Content = x.Content })
                .ToList(),
            Tools = request.Tools
                .Select(x => new SidecarToolDef
                {
                    Name = x.Name,
                    Description = x.Description,
                    InputSchema = x.InputSchema
                })
                .ToList(),
            MaxTokens = request.MaxTokens,
            MaxTurns = request.MaxTurns,
            TimeoutSeconds = request.TimeoutSeconds,
            CallbackBaseUrl = request.CallbackBaseUrl,
            AgentApiKey = request.AgentApiKey,
            AppCallerCode = request.AppCallerCode,
            SidecarTag = request.SidecarTag,
            StickyKey = request.StickyKey,
            Profile = request.Profile,
            BaseUrl = request.BaseUrl,
            ApiKey = request.ApiKey,
            Protocol = request.Protocol,
            RuntimeAdapter = request.RuntimeAdapter,
            MapSessionId = request.MapSessionId,
            TraceId = request.TraceId,
            WorkspaceRoot = request.WorkspaceRoot,
            GitRepository = request.GitRepository,
            GitRef = request.GitRef
        };

        await foreach (var ev in _router.RunStreamAsync(sidecarRequest, ct))
        {
            yield return new InfraAgentRuntimeEvent
            {
                Type = ev.Type switch
                {
                    SidecarEventType.TextDelta => InfraAgentRuntimeEventType.TextDelta,
                    SidecarEventType.ToolUse => InfraAgentRuntimeEventType.ToolUse,
                    SidecarEventType.ToolResult => InfraAgentRuntimeEventType.ToolResult,
                    SidecarEventType.Usage => InfraAgentRuntimeEventType.Usage,
                    SidecarEventType.RuntimeInit => InfraAgentRuntimeEventType.RuntimeInit,
                    SidecarEventType.Done => InfraAgentRuntimeEventType.Done,
                    SidecarEventType.Error => InfraAgentRuntimeEventType.Error,
                    SidecarEventType.Keepalive => InfraAgentRuntimeEventType.Keepalive,
                    _ => InfraAgentRuntimeEventType.Unknown
                },
                RawType = ev.RawType,
                Text = ev.Text,
                ToolName = ev.ToolName,
                ToolUseId = ev.ToolUseId,
                ToolInput = ev.ToolInput,
                Content = ev.Content,
                FinalText = ev.FinalText,
                InputTokens = ev.InputTokens,
                OutputTokens = ev.OutputTokens,
                ErrorCode = ev.ErrorCode,
                Message = ev.Message,
                Turn = ev.Turn,
                RuntimeInstanceName = ev.SidecarName,
                Source = SourceName
            };
        }
    }

    public async Task<InfraAgentRuntimeCancelResult> CancelAsync(string runId, CancellationToken ct)
    {
        var result = await _router.CancelRunAsync(runId, ct);
        return new InfraAgentRuntimeCancelResult(result.Cancelled, result.Reason, SourceName);
    }
}
