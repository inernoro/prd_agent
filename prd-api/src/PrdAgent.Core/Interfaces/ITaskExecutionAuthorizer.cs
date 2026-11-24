using PrdAgent.Core.LlmGateway;

namespace PrdAgent.Core.Interfaces;

/// <summary>MAP 唯一的模型传输边界。只附加经数据库核验的任务事实，缺失准入必须拒绝发送。</summary>
public interface ITaskExecutionAuthorizer
{
    Task AuthorizeOutboundAsync(HttpRequestMessage message, string appCallerCode,
        GatewayRequestContext? context, CancellationToken ct);
}
