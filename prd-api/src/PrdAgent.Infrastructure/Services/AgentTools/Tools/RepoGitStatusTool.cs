using System.Text.Json;
using PrdAgent.Core.Interfaces;

namespace PrdAgent.Infrastructure.Services.AgentTools.Tools;

public sealed class RepoGitStatusTool : IAgentTool
{
    private readonly AgentWorkspace _workspace;

    public RepoGitStatusTool(AgentWorkspace workspace)
    {
        _workspace = workspace;
    }

    public AgentToolDescriptor Descriptor { get; } = new()
    {
        Name = "repo_git_status",
        Description = "Inspect repository git status, current branch, short commit, and diff summary. Readonly.",
        InputSchemaJson = """
        {
          "type": "object",
          "properties": {
            "cwd": { "type": "string", "description": "Working directory relative to repository root. Default repository root." }
          }
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
            var repair = await _workspace.EnsureGitRepositoryAsync(ct);
            if (repair != null)
            {
                return AgentToolInvokeResult.Fail("repo_git_status_failed", repair.Stderr);
            }

            var cwd = input.TryGetProperty("cwd", out var d) && d.ValueKind == JsonValueKind.String
                ? d.GetString()
                : ".";

            var branch = await _workspace.RunCommandAsync("git rev-parse --abbrev-ref HEAD", cwd, 15, ct);
            var commit = await _workspace.RunCommandAsync("git rev-parse --short HEAD", cwd, 15, ct);
            var status = await _workspace.RunCommandAsync("git status --short", cwd, 15, ct);
            var diffStat = await _workspace.RunCommandAsync("git diff --stat", cwd, 15, ct);

            var failed = new[] { branch, commit, status, diffStat }.FirstOrDefault(x => x.ExitCode != 0);
            var payload = JsonSerializer.Serialize(new
            {
                cwd,
                branch = branch.Stdout.Trim(),
                commit = commit.Stdout.Trim(),
                status = status.Stdout,
                diffStat = diffStat.Stdout,
                exitCode = failed?.ExitCode ?? 0,
                stderr = failed?.Stderr ?? string.Empty
            });

            return failed == null
                ? AgentToolInvokeResult.Ok(payload)
                : AgentToolInvokeResult.Fail("repo_git_status_failed", payload);
        }
        catch (Exception ex)
        {
            return AgentToolInvokeResult.Fail("repo_git_status_failed", ex.Message);
        }
    }
}
