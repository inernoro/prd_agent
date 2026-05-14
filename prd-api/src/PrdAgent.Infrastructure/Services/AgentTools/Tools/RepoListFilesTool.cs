using System.Text.Json;
using PrdAgent.Core.Interfaces;

namespace PrdAgent.Infrastructure.Services.AgentTools.Tools;

public sealed class RepoListFilesTool : IAgentTool
{
    private readonly AgentWorkspace _workspace;

    public RepoListFilesTool(AgentWorkspace workspace)
    {
        _workspace = workspace;
    }

    public AgentToolDescriptor Descriptor { get; } = new()
    {
        Name = "repo_list_files",
        Description = "List repository files under a directory. Use this before reading unfamiliar areas.",
        InputSchemaJson = """
        {
          "type": "object",
          "properties": {
            "path": { "type": "string", "description": "Directory relative to the repository root." },
            "maxFiles": { "type": "integer", "description": "Maximum files to return, default 120." }
          }
        }
        """
    };

    public Task<AgentToolInvokeResult> InvokeAsync(
        JsonElement input,
        AgentToolInvocationContext context,
        CancellationToken ct)
    {
        try
        {
            var path = input.TryGetProperty("path", out var p) && p.ValueKind == JsonValueKind.String
                ? p.GetString()
                : ".";
            var maxFiles = input.TryGetProperty("maxFiles", out var m) && m.TryGetInt32(out var mv)
                ? Math.Clamp(mv, 1, 500)
                : 120;
            var root = _workspace.ResolvePath(path, allowDirectory: true);
            if (!Directory.Exists(root))
            {
                return Task.FromResult(AgentToolInvokeResult.Fail("directory_not_found", $"目录不存在: {path}"));
            }

            var files = Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories)
                .Where(file => !ShouldSkip(file))
                .Take(maxFiles)
                .Select(_workspace.NormalizeRelative)
                .ToList();
            var payload = JsonSerializer.Serialize(new
            {
                workspace = _workspace.Root,
                path = _workspace.NormalizeRelative(root),
                files,
                truncated = files.Count == maxFiles
            });
            return Task.FromResult(AgentToolInvokeResult.Ok(payload));
        }
        catch (Exception ex)
        {
            return Task.FromResult(AgentToolInvokeResult.Fail("repo_list_files_failed", ex.Message));
        }
    }

    private static bool ShouldSkip(string file)
    {
        var parts = file.Split(Path.DirectorySeparatorChar);
        return parts.Any(part => part is ".git" or "node_modules" or "bin" or "obj" or "dist" or ".cds-data");
    }
}
