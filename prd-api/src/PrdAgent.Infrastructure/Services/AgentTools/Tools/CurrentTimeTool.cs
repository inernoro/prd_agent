using System.Text.Json;
using PrdAgent.Core.Interfaces;

namespace PrdAgent.Infrastructure.Services.AgentTools.Tools;

/// <summary>
/// 返回当前服务器 UTC 时间 + ISO 8601 字符串。
/// </summary>
public sealed class CurrentTimeTool : IAgentTool
{
    public AgentToolDescriptor Descriptor { get; } = new()
    {
        Name = "current_time",
        Description = "Return the current server time in UTC (ISO 8601). No input required.",
        InputSchemaJson = """
        { "type": "object", "properties": {} }
        """,
    };

    public Task<AgentToolInvokeResult> InvokeAsync(
        JsonElement input,
        AgentToolInvocationContext context,
        CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        var payload = JsonSerializer.Serialize(new
        {
            utc = now.ToString("yyyy-MM-ddTHH:mm:ssZ"),
            unixSeconds = new DateTimeOffset(now).ToUnixTimeSeconds(),
        });
        return Task.FromResult(AgentToolInvokeResult.Ok(payload));
    }
}
