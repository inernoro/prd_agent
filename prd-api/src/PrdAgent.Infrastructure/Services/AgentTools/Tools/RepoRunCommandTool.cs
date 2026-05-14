using System.Text.Json;
using PrdAgent.Core.Interfaces;

namespace PrdAgent.Infrastructure.Services.AgentTools.Tools;

public sealed class RepoRunCommandTool : IAgentTool
{
    private readonly AgentWorkspace _workspace;

    public RepoRunCommandTool(AgentWorkspace workspace)
    {
        _workspace = workspace;
    }

    public AgentToolDescriptor Descriptor { get; } = new()
    {
        Name = "repo_run_command",
        Description = "Run a shell command in the repository sandbox. Use for git status, builds, tests, commits, pushes, and PR creation when credentials exist.",
        InputSchemaJson = """
        {
          "type": "object",
          "properties": {
            "command": { "type": "string", "description": "Shell command to run." },
            "cwd": { "type": "string", "description": "Working directory relative to repository root. Default repository root." },
            "timeoutSeconds": { "type": "integer", "description": "Timeout in seconds, default 60, max 180." }
          },
          "required": ["command"]
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
            var command = input.TryGetProperty("command", out var c) && c.ValueKind == JsonValueKind.String
                ? c.GetString()
                : null;
            if (string.IsNullOrWhiteSpace(command))
            {
                return AgentToolInvokeResult.Fail("command_required", "command is required");
            }

            var cwd = input.TryGetProperty("cwd", out var d) && d.ValueKind == JsonValueKind.String
                ? d.GetString()
                : ".";
            var timeout = input.TryGetProperty("timeoutSeconds", out var t) && t.TryGetInt32(out var tv)
                ? Math.Clamp(tv, 1, 180)
                : 60;
            var result = await _workspace.RunCommandAsync(command, cwd, timeout, ct);
            var payload = JsonSerializer.Serialize(new
            {
                command,
                cwd,
                exitCode = result.ExitCode,
                stdout = result.Stdout,
                stderr = result.Stderr
            });
            return result.ExitCode == 0
                ? AgentToolInvokeResult.Ok(payload)
                : AgentToolInvokeResult.Fail("command_failed", payload);
        }
        catch (Exception ex)
        {
            return AgentToolInvokeResult.Fail("repo_run_command_failed", ex.Message);
        }
    }
}
