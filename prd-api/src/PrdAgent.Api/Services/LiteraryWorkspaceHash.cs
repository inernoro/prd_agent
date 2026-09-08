using System.Security.Cryptography;
using System.Text;

namespace PrdAgent.Api.Services;

/// <summary>
/// 文学创作工作区的内容指纹计算。
///
/// 从 LiteraryAgentWorkspaceController 提出来，因为开放接口（MCP 让智能体建工作区）
/// 也要建同样的工作区文档 —— 同一个指纹判据抄成两份必然漂移，只留这一处。
/// </summary>
public static class LiteraryWorkspaceHash
{
    public static string Sha256Hex(string? s)
    {
        var bytes = Encoding.UTF8.GetBytes(s ?? string.Empty);
        var hash = SHA256.HashData(bytes);
        return Convert.ToHexString(hash).ToLowerInvariant();
    }

    public static string ComputeContentHash(string? canvasHash, string? assetsHash)
    {
        var ch = (canvasHash ?? string.Empty).Trim();
        var ah = (assetsHash ?? string.Empty).Trim();
        return Sha256Hex($"{ch}|{ah}");
    }
}
