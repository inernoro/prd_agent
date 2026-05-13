using System.Text.Json;
using PrdAgent.Core.Interfaces;

namespace PrdAgent.Infrastructure.Services.AgentTools.Tools;

public sealed class RepoSearchTool : IAgentTool
{
    private readonly AgentWorkspace _workspace;

    public RepoSearchTool(AgentWorkspace workspace)
    {
        _workspace = workspace;
    }

    public AgentToolDescriptor Descriptor { get; } = new()
    {
        Name = "repo_search",
        Description = "Search repository text with ripgrep. Returns matching lines with file and line numbers.",
        InputSchemaJson = """
        {
          "type": "object",
          "properties": {
            "query": { "type": "string", "description": "Ripgrep pattern to search for." },
            "path": { "type": "string", "description": "Optional directory or file relative to repository root." },
            "maxLines": { "type": "integer", "description": "Maximum matching lines, default 80." }
          },
          "required": ["query"]
        }
        """
    };

    public async Task<AgentToolInvokeResult> InvokeAsync(
        JsonElement input,
        AgentToolInvocationContext context,
        CancellationToken ct)
    {
        try
        {
            var query = input.TryGetProperty("query", out var q) && q.ValueKind == JsonValueKind.String
                ? q.GetString()
                : null;
            if (string.IsNullOrWhiteSpace(query))
            {
                return AgentToolInvokeResult.Fail("query_required", "query is required");
            }

            var path = input.TryGetProperty("path", out var p) && p.ValueKind == JsonValueKind.String
                ? p.GetString()
                : ".";
            var maxLines = input.TryGetProperty("maxLines", out var m) && m.TryGetInt32(out var mv)
                ? Math.Clamp(mv, 1, 300)
                : 80;
            var target = _workspace.ResolvePath(path, allowDirectory: true);
            var relativeTarget = _workspace.NormalizeRelative(target);
            var command = $"rg --line-number --no-heading --color never --max-count {maxLines} {ShellArg(query)} {ShellArg(relativeTarget)}";
            var result = await _workspace.RunCommandAsync(command, ".", 30, ct);
            var payload = JsonSerializer.Serialize(new
            {
                query,
                path = relativeTarget,
                exitCode = result.ExitCode,
                stdout = result.Stdout,
                stderr = result.Stderr
            });
            return AgentToolInvokeResult.Ok(payload);
        }
        catch (Exception ex)
        {
            return AgentToolInvokeResult.Fail("repo_search_failed", ex.Message);
        }
    }

    private static string ShellArg(string value) => "'" + value.Replace("'", "'\"'\"'", StringComparison.Ordinal) + "'";
}
