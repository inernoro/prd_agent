using System.Security.Cryptography;
using System.Text;

namespace PrdAgent.Core.Models;

/// <summary>只给收到成功回答的访客发放回执；消息 ID 或会话 ID 不能用于冒领评分。</summary>
public static class AskAnswerRating
{
    // 回执只在答复流和评价请求里出现；即使客户端没声明 SSE，也不能捕获响应体。
    public static bool IsAnswerStreamPath(string path) => path.StartsWith("/api/web-pages/", StringComparison.OrdinalIgnoreCase)
        && path.TrimEnd('/').EndsWith("/ask/stream", StringComparison.OrdinalIgnoreCase);
    public static bool CarriesReceipt(string path) => IsAnswerStreamPath(path)
        || path.StartsWith("/api/web-pages/ask/messages/", StringComparison.OrdinalIgnoreCase);

    public static string CreateToken() => Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
    public static string Hash(string token) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token)));
    public static bool IsValid(int rating, string? token) => rating is >= 1 and <= 5
        && token is { Length: 64 } && token.All(Uri.IsHexDigit);
}
