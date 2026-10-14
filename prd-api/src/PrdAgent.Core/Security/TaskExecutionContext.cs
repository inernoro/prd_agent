namespace PrdAgent.Core.Security;

/// <summary>
/// 已通过平台准入的执行来源沿当前异步调用树传播；不携带模型解析结果，不读取 HTTP 自报来源。
/// 队列恢复必须通过服务端许可查询重新进入，禁止从用户 ID 自动创建此作用域。
/// </summary>
public sealed record TaskExecutionIdentity(string PermitId, string? RunId = null);

public static class TaskExecutionContext
{
    private static readonly AsyncLocal<TaskExecutionIdentity?> Identity = new();
    public static TaskExecutionIdentity? Current => Identity.Value;
    public static IDisposable Enter(TaskExecutionIdentity? identity)
    {
        var previous = Identity.Value;
        Identity.Value = identity;
        return new Scope(previous);
    }

    private sealed class Scope(TaskExecutionIdentity? previous) : IDisposable
    {
        private bool _disposed;
        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;
            Identity.Value = previous;
        }
    }
}
