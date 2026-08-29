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

    /// <summary>
    /// 这条分享链接是不是「合集」。合集一律不开放提问——一条链接对着多个站点，
    /// 上下文该取哪一个没有答案，一期不做。
    ///
    /// 判据看的是**分享类型**，不是「现在还剩几个站点」。站点被删除时不会从
    /// 链接的 SiteIds 里摘掉，于是一条合集链接可能只剩一个存活站点；按数量判会
    /// 让它突然变成单站点分享、把付费的提问入口暴露出来。类型是创建时定死的，不会漂。
    /// </summary>
    public static bool IsCollectionShare(string? shareType)
        => string.Equals(shareType?.Trim(), "collection", StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// 这个站点为什么不能开提问；null = 可以开。
    ///
    /// 唯一判定源。快照服务据此拒绝取正文，配置接口据此拒绝打开开关，配置面板据此
    /// 灰掉开关并说明原因——三处必须同一个答案，否则就会出现「开关打得开、
    /// 每个访客都吃 422」这种把用户耍着玩的状态。
    ///
    /// 视频包装站没有任何可读文本：让模型对着标题编，比明说不支持更糟
    /// （no-rootless-tree：做不到的事不装能做）。
    /// </summary>
    public static string? UnsupportedReason(string? wrappedAssetType)
        => string.Equals(wrappedAssetType, "video", StringComparison.OrdinalIgnoreCase)
            ? "这是一个视频页面，没有可供阅读的文字内容，暂不支持提问。"
            : null;

    /// <summary>
    /// 这个站点现在开不开提问。**唯一判定源**，所有「要不要给提问入口」的地方都走它。
    ///
    /// 口径 2026-08-29 起翻转为「默认全开，除非明确拒绝」（用户决定）。所以
    /// <see cref="WebPage.AskEnabled"/> 是可空的三态，不是 bool：
    /// <list type="bullet">
    /// <item>null —— owner 从没表过态（含所有存量站点、所有新上传）：<b>开</b></item>
    /// <item>true —— 明确打开：开</item>
    /// <item>false —— 明确关掉：关，默认值不得把它顶回去</item>
    /// </list>
    /// 之所以不把存量数据一把刷成 true：那样会连「owner 当初特意关掉的站点」一起打开，
    /// 而这两种状态在 bool 里长得一模一样。改成三态之后，「没表过态」和「说过不要」
    /// 才第一次区分得开。
    ///
    /// 形态不支持（视频站）永远压过默认值：开关打得开、每个访客吃 422 是耍用户。
    /// </summary>
    public static bool IsAskOn(bool? askEnabled, string? wrappedAssetType)
        => UnsupportedReason(wrappedAssetType) == null && (askEnabled ?? true);

    /// <summary>
    /// 这一次失败该不该退配额。三个条件缺一不可，抽出来是为了**可测**——
    /// 埋在控制器的局部函数里时，把幂等那一条删掉全量测试照样绿。
    ///
    /// <paramref name="alreadyRefunded"/> 是最容易漏的那条：两条内层失败出口退完款之后
    /// 都要写一条 SSE error，而那两处的写入没有吞 ObjectDisposedException——访客此时
    /// 已断开的话它就抛出来、落到外层 catch，退款逻辑第二次执行，而「没有产出」和
    /// 「扣成过」两个条件照旧成立。站点那个计数是所有访客共用的，多退一次就是把
    /// 别人的用量抹掉，配额闸从此漏。
    /// </summary>
    /// <param name="alreadyRefunded">这一次请求是否已经退过。</param>
    /// <param name="producedLength">已经产出的答案长度；&gt; 0 表示 token 已经花了，不退。</param>
    /// <param name="consumed">进场时到底扣成没有；没扣成就没什么可退。</param>
    public static bool ShouldRefundQuota(bool alreadyRefunded, int producedLength, bool consumed)
        => !alreadyRefunded && producedLength == 0 && consumed;

    /// <summary>面板欢迎语的存储上限。展示文案，超长截断而不是拒绝。</summary>
    public const int MaxWelcomeLength = 200;

    /// <summary>规范化欢迎语：去首尾空白、截到 <see cref="MaxWelcomeLength"/>；空白返回 null。</summary>
    public static string? TrimWelcome(string? welcome)
    {
        var v = welcome?.Trim();
        if (string.IsNullOrEmpty(v)) return null;
        return v.Length <= MaxWelcomeLength ? v : v[..MaxWelcomeLength];
    }
}
