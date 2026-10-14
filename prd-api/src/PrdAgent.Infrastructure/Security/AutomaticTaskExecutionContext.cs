namespace PrdAgent.Infrastructure.Security;

/// <summary>
/// 平台启动闸授予的自动任务来源；只跟随当前执行流，不从 HTTP 输入或用户 ID 推断。
/// 此信息用于网关最低保护，不替代后续任务许可证与工作负载验签。
/// </summary>
public static class AutomaticTaskExecutionContext
{
    private static readonly AsyncLocal<string?> Source = new();

    public static string? SourceDeployment => Source.Value;

    public static IDisposable Enter(string sourceDeployment)
    {
        var previous = Source.Value;
        Source.Value = sourceDeployment;
        return new Scope(previous);
    }

    private sealed class Scope(string? previous) : IDisposable
    {
        public void Dispose() => Source.Value = previous;
    }
}
