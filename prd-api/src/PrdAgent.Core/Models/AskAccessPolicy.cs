namespace PrdAgent.Core.Models;

/// <summary>
/// 提问入口的准入判定，两条纯规则的唯一判定源。
///
/// 抽出来不是为了复用，是为了**可测**：这两条都属于「改回错误写法之后测试仍然全绿」的那类
/// 判断（见 predicate-and-wiring-discipline 的判据：删掉不会红的接线必须补守卫）。
/// 留在 Controller / Service 里就只能靠源码扫描断言字面量，那是形状 4a 的反向锁死。
/// </summary>
public static class AskAccessPolicy
{
    /// <summary>单条问题最大长度：提问是问句不是投喂正文，长了就是想绕过上下文限制。</summary>
    public const int MaxQuestionLength = 500;

    /// <summary>
    /// 问题是否超长。超长必须**拒绝**，调用方不得改成截断。
    ///
    /// 静默截断的坏处很具体：UI 里显示和留存的是用户写的全文，只有送进模型的那份被砍掉，
    /// 于是答案会漏掉问题结尾的诉求，而用户看不出任何异常，只觉得「AI 没听懂」。
    /// 宁可给一条明确的「太长了」，也不要给一个悄悄答偏的回答。
    /// </summary>
    public static bool IsQuestionTooLong(string? question)
        => (question?.Trim().Length ?? 0) > MaxQuestionLength;

    /// <summary>
    /// 这条分享该不该对外暴露提问入口。
    ///
    /// 一期只支持「一条链接对一个站点」。合集分享刻意返回 false，而不是挂到首站点上：
    /// 合集页面上有 N 个站点，提问却只依据其中一个的正文，用户无从分辨答案在说哪一个。
    /// 后端算出来、前端不渲染，就是建了一半的接线——要么两端都接，要么两端都不接。
    /// 一期选择两端都不接，等合集提问的产品语义定清楚（答哪个站？按站切换？）再一起做。
    /// </summary>
    public static bool ShouldExposeAskOnShare(int sharedSiteCount, bool siteAskEnabled)
        => sharedSiteCount == 1 && siteAskEnabled;
}
