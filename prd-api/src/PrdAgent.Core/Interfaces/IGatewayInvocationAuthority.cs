using PrdAgent.Core.LlmGateway;

namespace PrdAgent.Core.Interfaces;

/// <summary>serving 的发送权校验；只验证入口已核验的事实，不重复核销或解析模型。</summary>
public interface IGatewayInvocationAuthority
{
    void AssertAuthorized(string appCallerCode, GatewayRequestContext? context);
    Task AssertCurrentAsync(string appCallerCode, GatewayRequestContext? context, CancellationToken ct);
}
