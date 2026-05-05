using System.Text.Json;
using PrdAgent.Core.Interfaces;

namespace PrdAgent.Infrastructure.Services.AgentTools.Tools;

/// <summary>
/// 调试工具：原样返回 message 字段。用于验证 Agent 调用链路是否打通。
/// 真实 Agent 不会需要这个工具，仅用于 smoke 测试。
/// </summary>
public sealed class EchoTool : IAgentTool
{
    public AgentToolDescriptor Descriptor { get; } = new()
    {
        Name = "echo",
        Description = "Return the input message verbatim. For debugging tool-call wiring only.",
        InputSchemaJson = """
        {
          "type": "object",
          "properties": {
            "message": { "type": "string", "description": "Text to echo back." }
          },
          "required": ["message"]
        }
        """,
    };

    public Task<AgentToolInvokeResult> InvokeAsync(
        JsonElement input,
        AgentToolInvocationContext context,
        CancellationToken ct)
    {
        var message = input.TryGetProperty("message", out var m) && m.ValueKind == JsonValueKind.String
            ? (m.GetString() ?? string.Empty)
            : string.Empty;

        return Task.FromResult(AgentToolInvokeResult.Ok(message));
    }
}
