using System.Text;
using System.Text.Json;
using PrdAgent.Core.Interfaces;

namespace PrdAgent.Infrastructure.Services.AgentTools.Tools;

public sealed class RepoReadFileTool : IAgentTool
{
    private readonly AgentWorkspace _workspace;

    public RepoReadFileTool(AgentWorkspace workspace)
    {
        _workspace = workspace;
    }

    public AgentToolDescriptor Descriptor { get; } = new()
    {
        Name = "repo_read_file",
        Description = "Read a UTF-8 text file from the repository. Returns content plus line count.",
        InputSchemaJson = """
        {
          "type": "object",
          "properties": {
            "path": { "type": "string", "description": "File path relative to the repository root." },
            "maxBytes": { "type": "integer", "description": "Maximum bytes to return, default 40000." }
          },
          "required": ["path"]
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
            if (string.IsNullOrWhiteSpace(path))
            {
                return AgentToolInvokeResult.Fail("path_required", "path is required");
            }

            var maxBytes = input.TryGetProperty("maxBytes", out var b) && b.TryGetInt32(out var bv)
                ? Math.Clamp(bv, 1, 120000)
                : 40000;
            var fullPath = _workspace.ResolvePath(path);
            if (!File.Exists(fullPath))
            {
                return AgentToolInvokeResult.Fail("file_not_found", $"文件不存在: {path}");
            }

            await using var stream = File.OpenRead(fullPath);
            var size = stream.Length;
            var buffer = new byte[Math.Min(maxBytes, size)];
            var read = await stream.ReadAsync(buffer.AsMemory(0, buffer.Length), ct);
            var text = Encoding.UTF8.GetString(buffer, 0, read);
            var payload = JsonSerializer.Serialize(new
            {
                path = _workspace.NormalizeRelative(fullPath),
                bytes = size,
                truncated = size > read,
                lineCount = text.Split('\n').Length,
                content = text
            });
            return AgentToolInvokeResult.Ok(payload);
        }
        catch (Exception ex)
        {
            return AgentToolInvokeResult.Fail("repo_read_file_failed", ex.Message);
        }
    }
}
