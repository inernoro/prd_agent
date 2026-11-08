using PrdAgent.Core.Interfaces;

namespace PrdAgent.Core.Services;

/// <summary>
/// LLM 请求上下文（AsyncLocal），用于把 requestId/groupId/sessionId 等信息透传到基础设施层日志
/// </summary>
public class LLMRequestContextAccessor : ILLMRequestContextAccessor
{
    private static readonly AsyncLocal<LlmRequestContext?> _current = new();

    public LlmRequestContext? Current => _current.Value;

    public IDisposable BeginScope(LlmRequestContext context)
    {
        var prev = _current.Value;
        if (prev?.IsHealthProbe == true && context.IsHealthProbe != true)
        {
            context = context with { IsHealthProbe = true };
        }
        if (!string.IsNullOrWhiteSpace(prev?.RunId) && string.IsNullOrWhiteSpace(context.RunId))
        {
            context = context with { RunId = prev.RunId };
        }
        if (!string.IsNullOrWhiteSpace(prev?.LogicalRequestId)
            && string.IsNullOrWhiteSpace(context.LogicalRequestId))
        {
            context = context with { LogicalRequestId = prev.LogicalRequestId };
        }
        if (!string.IsNullOrWhiteSpace(prev?.ProviderTaskId)
            && string.IsNullOrWhiteSpace(context.ProviderTaskId))
        {
            context = context with { ProviderTaskId = prev.ProviderTaskId };
        }
        if (!string.IsNullOrWhiteSpace(prev?.LogicalModelPublicId)
            && string.IsNullOrWhiteSpace(context.LogicalModelPublicId))
        {
            context = context with { LogicalModelPublicId = prev.LogicalModelPublicId };
        }
        // 网关核验后的来源在嵌套日志作用域继续保留，不能被业务上下文遗漏或自报值改写。
        if (!string.IsNullOrWhiteSpace(prev?.TaskPermitId))
        {
            context = context with
            {
                TaskPermitId = prev.TaskPermitId,
                ExecutionOrigin = prev.ExecutionOrigin,
                TriggerCredentialId = prev.TriggerCredentialId,
                TriggerActorUserId = prev.TriggerActorUserId,
                SourceDeployment = prev.SourceDeployment,
                SourceTask = prev.SourceTask,
                SourceSystem = prev.SourceSystem,
            };
        }
        _current.Value = context;
        return new Scope(() => _current.Value = prev);
    }

    private sealed class Scope : IDisposable
    {
        private readonly Action _onDispose;
        private bool _disposed;

        public Scope(Action onDispose) => _onDispose = onDispose;

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;
            _onDispose();
        }
    }
}
