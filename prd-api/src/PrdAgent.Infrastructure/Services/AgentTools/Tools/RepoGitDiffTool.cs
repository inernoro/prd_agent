using System.Text.Json;
using PrdAgent.Core.Interfaces;

namespace PrdAgent.Infrastructure.Services.AgentTools.Tools;

public sealed class RepoGitDiffTool : IAgentTool
{
    private readonly AgentWorkspace _workspace;

    public RepoGitDiffTool(AgentWorkspace workspace)
    {
        _workspace = workspace;
    }

    public AgentToolDescriptor Descriptor { get; } = new()
    {
        Name = "repo_git_diff",
        Description = "Read git diff for the repository or one path. Returns diff stat and unified diff. Readonly.",
        InputSchemaJson = """
        {
          "type": "object",
          "properties": {
            "path": { "type": "string", "description": "Optional file path relative to repository root." },
            "cached": { "type": "boolean", "description": "Read staged diff instead of working tree diff." },
            "maxBytes": { "type": "integer", "description": "Maximum diff bytes to return, default 40000." },
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
                return AgentToolInvokeResult.Fail("repo_git_diff_failed", repair.Stderr);
            }

            var cwd = input.TryGetProperty("cwd", out var d) && d.ValueKind == JsonValueKind.String
                ? d.GetString()
                : ".";
            var path = input.TryGetProperty("path", out var p) && p.ValueKind == JsonValueKind.String
                ? p.GetString()
                : null;
            var cached = input.TryGetProperty("cached", out var c) && c.ValueKind == JsonValueKind.True;
            var maxBytes = input.TryGetProperty("maxBytes", out var b) && b.TryGetInt32(out var bv)
                ? Math.Clamp(bv, 1, 120000)
                : 40000;

            var safePath = NormalizePath(path);
            var pathArg = BuildPathArg(safePath);
            var cachedArg = cached ? "--cached " : string.Empty;
            var stat = await _workspace.RunCommandAsync($"git diff {cachedArg}--stat{pathArg}", cwd, 20, ct);
            var diff = await _workspace.RunCommandAsync($"git diff {cachedArg}{pathArg}", cwd, 20, ct);
            var failed = new[] { stat, diff }.FirstOrDefault(x => x.ExitCode != 0);
            var content = diff.Stdout.Length > maxBytes ? diff.Stdout[..maxBytes] : diff.Stdout;
            var payload = JsonSerializer.Serialize(new
            {
                cwd,
                path = safePath,
                cached,
                diffStat = stat.Stdout,
                diff = content,
                truncated = diff.Stdout.Length > maxBytes,
                exitCode = failed?.ExitCode ?? 0,
                stderr = failed?.Stderr ?? string.Empty
            });

            return failed == null
                ? AgentToolInvokeResult.Ok(payload)
                : AgentToolInvokeResult.Fail("repo_git_diff_failed", payload);
        }
        catch (Exception ex)
        {
            return AgentToolInvokeResult.Fail("repo_git_diff_failed", ex.Message);
        }
    }

    private string? NormalizePath(string? path)
    {
        if (string.IsNullOrWhiteSpace(path)) return null;
        var fullPath = _workspace.ResolvePath(path, allowDirectory: true);
        return _workspace.NormalizeRelative(fullPath);
    }

    private static string BuildPathArg(string? path)
    {
        if (string.IsNullOrWhiteSpace(path)) return string.Empty;
        var clean = path.Trim().Replace("'", "'\\''");
        return $" -- '{clean}'";
    }
}
