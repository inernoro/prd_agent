using System.Text;
using System.Text.Json;
using PrdAgent.Core.Interfaces;

namespace PrdAgent.Infrastructure.Services.AgentTools.Tools;

public sealed class RepoWriteFileTool : IAgentTool
{
    private readonly AgentWorkspace _workspace;

    public RepoWriteFileTool(AgentWorkspace workspace)
    {
        _workspace = workspace;
    }

    public AgentToolDescriptor Descriptor { get; } = new()
    {
        Name = "repo_write_file",
        Description = "Create or overwrite a UTF-8 text file in the repository. Use only after reading the target area.",
        InputSchemaJson = """
        {
          "type": "object",
          "properties": {
            "path": { "type": "string", "description": "File path relative to the repository root." },
            "content": { "type": "string", "description": "Full UTF-8 file content to write." },
            "append": { "type": "boolean", "description": "Append instead of overwrite. Default false." }
          },
          "required": ["path", "content"]
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
            var path = input.TryGetProperty("path", out var p) && p.ValueKind == JsonValueKind.String
                ? p.GetString()
                : null;
            var content = input.TryGetProperty("content", out var c) && c.ValueKind == JsonValueKind.String
                ? c.GetString()
                : null;
            if (string.IsNullOrWhiteSpace(path))
            {
                return AgentToolInvokeResult.Fail("path_required", "path is required");
            }
            if (content == null)
            {
                return AgentToolInvokeResult.Fail("content_required", "content is required");
            }

            var append = input.TryGetProperty("append", out var a)
                && a.ValueKind == JsonValueKind.True;
            var fullPath = _workspace.ResolvePath(path);
            Directory.CreateDirectory(Path.GetDirectoryName(fullPath)!);
            if (append)
            {
                await File.AppendAllTextAsync(fullPath, content, Encoding.UTF8, ct);
            }
            else
            {
                await File.WriteAllTextAsync(fullPath, content, Encoding.UTF8, ct);
            }

            var payload = JsonSerializer.Serialize(new
            {
                path = _workspace.NormalizeRelative(fullPath),
                bytes = Encoding.UTF8.GetByteCount(content),
                append
            });
            return AgentToolInvokeResult.Ok(payload);
        }
        catch (Exception ex)
        {
            return AgentToolInvokeResult.Fail("repo_write_file_failed", ex.Message);
        }
    }
}
