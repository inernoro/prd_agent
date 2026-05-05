using System.Text.Json;
using PrdAgent.Core.Interfaces;

namespace PrdAgent.Infrastructure.Services.AgentTools;

/// <summary>
/// 一个可被 Agent 调用的工具：自描述 + 执行体。
/// 实现类应该是无状态的（DI 时按需 Singleton 或 Scoped）。
/// </summary>
public interface IAgentTool
{
    /// <summary>工具元数据（喂给 Anthropic SDK）。</summary>
    AgentToolDescriptor Descriptor { get; }

    /// <summary>执行调用。input 由 controller 反序列化后透传。</summary>
    Task<AgentToolInvokeResult> InvokeAsync(
        JsonElement input,
        AgentToolInvocationContext context,
        CancellationToken ct);
}
