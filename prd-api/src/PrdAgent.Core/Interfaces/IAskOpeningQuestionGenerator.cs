using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

/// <summary>
/// 开场问题自动生成：读一遍站点自己的正文，写出访客最可能问的几句，落成站点题库。
///
/// 存在的理由是「上传者什么都不用配」——他点完上传就能走人，题库几秒后自己到位，
/// 从头到尾没被要求做任何配置（minimal-user-input：系统查得到的值不该摆成输入框）。
/// </summary>
public interface IAskOpeningQuestionGenerator
{
    /// <summary>
    /// 排一次生成，**立刻返回**。
    ///
    /// 调用方全都在请求路径上（开启提问、重新上传、访客打开分享页），一次模型调用几秒钟，
    /// 挂在那儿等就是把成本转嫁给正在等页面的人。所以这里只入队：同一个站点同时只跑一次，
    /// 失败只记日志、不冒泡——题库是增值，没有它提问照样能用。
    /// </summary>
    void QueueEnsure(HostedSite site);

    /// <summary>
    /// 同步跑一次并返回这次的结局。给 owner 手点的「重新生成」用（他明确要的，所以等得起）。
    /// </summary>
    Task<AskOpenerOutcome> EnsureAsync(string siteId, CancellationToken ct = default);
}

/// <summary>
/// 一次生成的结局。压成一个 bool 是不够的：四种「没生成出来」的下一步完全不同，
/// 合并之后只能给用户一句放之四海而皆准的「失败了」，他不知道该重试、该换页面还是该等。
/// </summary>
public enum AskOpenerOutcome
{
    /// <summary>写出了新题库</summary>
    Generated,

    /// <summary>这个站点压根没有可读正文（纯视频/纯图包装站）。重试没用，别劝他重试。</summary>
    NoContent,

    /// <summary>模型答了，但答的没法用。换一版正文或换模型才有意义。</summary>
    ModelUnusable,

    /// <summary>模型这一侧不通（没配模型池 / 网关不可达 / 超时）。这是暂时的，值得重试。</summary>
    ModelUnavailable,

    /// <summary>不该生成（提问没开 / owner 手写过 / 这一版正文已经算过）</summary>
    Skipped,

    /// <summary>
    /// 这个站点已经有一次生成在跑，本次没有另起一次模型调用。
    /// 等那一次写完就有结果，重复点不会更快，也不会重复计费。
    /// </summary>
    Busy,

    /// <summary>
    /// 题算出来了，但落库时发现站点已经被顶掉——正文在这几秒里被重传，或者别人把题库
    /// 改成了手写。这一批按旧口径算的题整笔没写。区别于 Generated：那边是真写进去了。
    /// </summary>
    Superseded,
}
