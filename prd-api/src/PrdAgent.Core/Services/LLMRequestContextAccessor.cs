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

