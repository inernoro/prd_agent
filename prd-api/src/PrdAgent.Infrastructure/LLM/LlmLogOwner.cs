namespace PrdAgent.Infrastructure.LLM;

/// <summary>仅 serving 注册；每次进程启动产生新的写入身份。</summary>
public sealed class LlmLogOwner
{
    public string InstanceId { get; } = Guid.NewGuid().ToString("N");
}
