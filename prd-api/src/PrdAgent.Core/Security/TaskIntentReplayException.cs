using PrdAgent.Core.LlmGateway;

namespace PrdAgent.Core.Security;

/// <summary>平台已接收相同业务意图；由准入中间件回放有界原响应，不能再次进入付费分支。</summary>
public sealed class TaskIntentReplayException(GatewayTaskPermitRecord permit) : Exception("任务已接收")
{
    public GatewayTaskPermitRecord Permit { get; } = permit;
}
