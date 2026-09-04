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

    /// <summary>工具名按字符数收 —— 它不落进业务字段，只进审计行与回给调用方的那句话。</summary>
    internal const int ToolNameChars = 200;

    /// <summary>密钥名按字符数收。它是主人自己起的名字，进的也只是审计行与面板。</summary>
    internal const int KeyNameChars = 200;

    internal static int Bytes(string? value) => value == null ? 0 : Encoding.UTF8.GetByteCount(value);

    /// <summary>超限返回一句能照着改的说明；合规返回 null。</summary>
    internal static string? Text(string? value, int maxBytes, string field)
        => Bytes(value) > maxBytes
            ? $"{field} 超过 {maxBytes} 字节（按 UTF-8 算，中文一个字约 3 字节），请精简"
            : null;

    /// <summary>
    /// 「整篇覆盖」类端点的 content 必填判据 —— 唯一判定源。
    ///
    /// 省略字段与显式给空串是**两件事**，而 `req?.Content ?? string.Empty` 把它们合成了一件：
    /// 直连打一个 `{}` 过来，mode 又默认 replace，于是整篇正文被清空、配图流程被复位，
    /// 接口还回成功。MCP schema 里 content 标了 required，但网关不拿 schema 校验参数，
    /// 直连调用方更是想传什么传什么 —— schema 是描述，不是闸门。
    ///
    /// 显式传空串仍然放行：清空是合法意图，只是必须是**说出口的**那一种。
    /// </summary>
    internal static string? RequireContent(string? content)
        => content is null
            ? "content 必填。要把正文清空，请显式传 content: \"\"（省略这个字段不等于清空）。"
            : null;

    /// <summary>
    /// 认出工具**之前**先把调用方给的工具名截住 —— 唯一判定源。
    ///
    /// 这个名字不需要是真工具：认不出来的那条路会照样写一行审计（用户得看得见「有人拿这把
    /// 密钥在刷不存在的工具」），而它同时进 ToolName 和拒绝语。原样带着的话，一个几 MB 的
    /// 名字会被复制进两处、按每分钟的速率一条条堆进 mcp_call_logs；大到超过 Mongo 单文档上限时，
    /// 那行审计插不进去 —— 而写审计是包了 try 的，于是**连失败都没有声音**。
    ///
    /// 截而不是拒：拒得越早，越会把「有人在刷」这件事从审计里一起抹掉。真实工具名 30 字上下，
    /// 200 字之后的部分对判断「他刚才想调什么」没有任何贡献。
    ///
    /// 做成通用的一处，是因为审计行里不止工具名一个字段是调用方给的：密钥名同样是用户自己起的、
    /// 同样没有上限，而它**每一次调用**都被整个抄进那一行。抄两个一模一样的单行函数，
    /// 就是下一次判据分裂的起点。新增任何进审计行的调用方文本，都从这里走。
    /// </summary>
    internal static string ForAudit(string? value, int maxChars)
        => value is null ? string.Empty
            : value.Length > maxChars ? value[..maxChars] + "…" : value;

    /// <summary>工具名的那一份（见上）。</summary>
    internal static string ToolNameForAudit(string name) => ForAudit(name, ToolNameChars);

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
