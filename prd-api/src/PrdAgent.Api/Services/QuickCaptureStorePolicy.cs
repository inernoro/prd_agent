using System.Security.Cryptography;
using System.Text;

namespace PrdAgent.Api.Services;

/// <summary>
/// 快捷记录知识库的稳定身份规则。
/// 同一用户在所有并发请求中都得到同一个 Mongo _id，依靠 _id 唯一性保证 find-or-create 幂等。
/// </summary>
internal static class QuickCaptureStorePolicy
{
    internal const string Name = "快捷知识库";
    internal const string Description = "随手录音与快速记录会自动保存到这里";
    internal const string Tag = "快捷记录";

    internal static string BuildStoreId(string userId)
    {
        if (string.IsNullOrWhiteSpace(userId))
            throw new ArgumentException("用户 ID 不能为空", nameof(userId));

        var material = Encoding.UTF8.GetBytes($"document-store:quick-capture:{userId.Trim()}");
        return Convert.ToHexString(SHA256.HashData(material)).ToLowerInvariant()[..32];
    }
}
