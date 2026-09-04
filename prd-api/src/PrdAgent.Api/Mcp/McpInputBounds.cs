using System.Text;

namespace PrdAgent.Api.Mcp;

/// <summary>
/// 开放层收调用方文本的上限 —— 唯一判定源。
///
/// 为什么要收敛成一处：「调用方给的无界文本原样落库」这个形状在本轮 Review 里连着中了四次
/// （HTML 正文、幂等键、站点元数据、分享链元数据），每次都在**下一个**端点上复发。
/// 根因不是谁忘了写校验，是每处各判各的、没有一个能被枚举的判据（形状 3）。
///
/// 判据按 **UTF-8 字节**，不按 string.Length：一个汉字 3 字节，按字符数判等于给中文开三倍口子，
/// 而真正落进 Mongo 与对象存储的都是字节。
///
/// 上限选得比「够用」宽一点、比「能撑爆文档」小得多：这些字段是给人看的标题与说明，
/// 不是内容本身；内容类字段（HTML、正文）有自己更大的上限，不走这里。
/// </summary>
internal static class McpInputBounds
{
    internal const int TitleBytes = 512;
    internal const int DescriptionBytes = 4 * 1024;
    internal const int FolderBytes = 256;
    internal const int TagBytes = 128;
    internal const int TagCount = 32;

    internal static int Bytes(string? value) => value == null ? 0 : Encoding.UTF8.GetByteCount(value);

    /// <summary>超限返回一句能照着改的说明；合规返回 null。</summary>
    internal static string? Text(string? value, int maxBytes, string field)
        => Bytes(value) > maxBytes
            ? $"{field} 超过 {maxBytes} 字节（按 UTF-8 算，中文一个字约 3 字节），请精简"
            : null;

    internal static string? Tags(List<string>? tags)
    {
        if (tags == null) return null;
        if (tags.Count > TagCount) return $"tags 最多 {TagCount} 个，当前 {tags.Count} 个";
        foreach (var tag in tags)
            if (Bytes(tag) > TagBytes)
                return $"单个 tag 超过 {TagBytes} 字节，请精简";
        return null;
    }
}
