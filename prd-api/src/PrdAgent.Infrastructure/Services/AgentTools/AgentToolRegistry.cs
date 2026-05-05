using System.Text.Json;
using Microsoft.Extensions.Logging;
using PrdAgent.Core.Interfaces;
using PrdAgent.Infrastructure.Services.AgentTools.Tools;

namespace PrdAgent.Infrastructure.Services.AgentTools;

/// <summary>
/// 内置工具集合的默认实现。新增工具：在构造函数里 Register 一个 IAgentTool 实现即可。
/// </summary>
public sealed class AgentToolRegistry : IAgentToolRegistry
{
    private readonly Dictionary<string, IAgentTool> _tools = new(StringComparer.OrdinalIgnoreCase);
    private readonly ILogger<AgentToolRegistry> _logger;

    public AgentToolRegistry(ILogger<AgentToolRegistry> logger)
    {
        _logger = logger;

        // 内置工具登记（v1）：先放两个 smoke 用的，证明端到端调用链。
        // 生产 agent 落地时按 PR 形式新增（一个工具一个 PR，便于审计）。
        Register(new EchoTool());
        Register(new CurrentTimeTool());
    }

    private void Register(IAgentTool tool)
    {
        if (_tools.ContainsKey(tool.Descriptor.Name))
            throw new InvalidOperationException($"AgentTool 重复注册: {tool.Descriptor.Name}");
        _tools[tool.Descriptor.Name] = tool;
    }

    public IReadOnlyList<AgentToolDescriptor> ListAll() =>
        _tools.Values.Select(t => t.Descriptor).ToList();

    public IReadOnlyList<AgentToolDescriptor> Filter(IEnumerable<string>? whitelist)
    {
        if (whitelist == null) return Array.Empty<AgentToolDescriptor>();

        var allowed = whitelist
            .Where(s => !string.IsNullOrWhiteSpace(s))
            .Select(s => s.Trim())
            .ToHashSet(StringComparer.OrdinalIgnoreCase);

        if (allowed.Count == 0) return Array.Empty<AgentToolDescriptor>();

        return _tools.Values
            .Where(t => allowed.Contains(t.Descriptor.Name))
            .Select(t => t.Descriptor)
            .ToList();
    }

    public async Task<AgentToolInvokeResult> InvokeAsync(
        string toolName,
        JsonElement input,
        AgentToolInvocationContext context,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(toolName) || !_tools.TryGetValue(toolName, out var tool))
        {
            _logger.LogWarning(
                "[AgentTool] 未知工具 name={Name} runId={RunId}",
                toolName, context.RunId);
            return AgentToolInvokeResult.Fail("tool_not_found", $"工具未注册: {toolName}");
        }

        try
        {
            var result = await tool.InvokeAsync(input, context, ct);
            _logger.LogInformation(
                "[AgentTool] invoked name={Name} runId={RunId} success={Success}",
                toolName, context.RunId, result.Success);
            return result;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex,
                "[AgentTool] 执行异常 name={Name} runId={RunId}",
                toolName, context.RunId);
            return AgentToolInvokeResult.Fail("tool_exception", ex.Message);
        }
    }
}
