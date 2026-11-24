using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

/// <summary>
/// 把一个托管站点的正文抽成纯文本，供「向我提问」当上下文喂给模型。
///
/// 为什么不复用 WebPagesController 的 `/content`：那条路是"服务端 HTTP GET 自己的 SiteUrl"，
/// 只能拿到入口单文件、受 2MB 门槛限制、还要绕一圈公网。这里直接按 CosKey 读对象存储，
/// 多文件站能把正文类文件都收进来，也没有公网往返。
/// </summary>
public interface ISiteContentSnapshotService
{
    /// <summary>
    /// 取站点正文快照（带缓存）。永远返回非 null：没有可读正文时 Unavailable 非空，
    /// 由调用方据此如实告诉用户"这个页面没有文字内容可问"，而不是让模型对着空气编。
    /// </summary>
    Task<SiteContentSnapshot> GetAsync(HostedSite site, CancellationToken ct = default);
}

/// <summary>站点正文快照。</summary>
public class SiteContentSnapshot
{
    public string SiteId { get; set; } = string.Empty;

    /// <summary>抽出来的纯文本（已按预算截断）</summary>
    public string Text { get; set; } = string.Empty;

    /// <summary>截断前的总字符数（用于告诉用户"只读了前 N 字"）</summary>
    public int TotalChars { get; set; }

    /// <summary>是否发生了截断</summary>
    public bool Truncated { get; set; }

    /// <summary>参与抽取的文件数</summary>
    public int FileCount { get; set; }

    /// <summary>
    /// 非空 = 这个站点拿不到可读正文（纯视频包装站 / 对象读不回来 / 抽出来是空）。
    /// 非空时 Text 为空，调用方必须把这句话如实透出，不得假装有内容。
    /// </summary>
    public string? Unavailable { get; set; }

    /// <summary>
    /// 这次拿不到正文是**暂时的**（对象存储读失败），而不是这个站点本来就没有正文。
    ///
    /// 区分这两者是为了缓存：「这页确实没有正文」是事实、可以缓存；
    /// 「这次没读回来」不是，缓存它等于让一次抖动把该站点问答废掉整个 TTL，
    /// 而每次尝试的配额都已经先扣了。
    /// </summary>
    public bool TransientFailure { get; set; }
}
