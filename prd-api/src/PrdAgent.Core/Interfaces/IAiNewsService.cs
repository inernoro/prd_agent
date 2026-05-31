using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

/// <summary>
/// 首页「AI 大事早知道」资讯雷达服务。
/// 拉取外部公共静态源（ai-news-radar），内存缓存 + stale 保底，对外只暴露裁剪后的资讯流。
/// </summary>
public interface IAiNewsService
{
    Task<AiNewsFeed> GetLatestAsync(CancellationToken ct = default);

    /// <summary>
    /// 为指定资讯 id 生成 / 读取「一句话 AI 解读」。命中缓存直接返回，未命中批量调 LLM 生成并落库。
    /// 返回 id -> commentary 的映射（仅含成功生成或已缓存的条目）。
    /// </summary>
    /// <param name="ids">要解读的资讯 id（取自当前 feed）。</param>
    /// <param name="userId">触发用户 id（用于 LlmRequestContext）。</param>
    Task<Dictionary<string, string>> EnrichCommentaryAsync(IReadOnlyList<string> ids, string userId, CancellationToken ct = default);

    /// <summary>
    /// 为指定资讯 id 抓取 / 读取文章摘要片段（默认展示的「部分内容」）。命中缓存直接返回，
    /// 未命中则抓目标页 og:description / meta description 并缓存。返回 id -> 摘要（仅含非空）。
    /// </summary>
    Task<Dictionary<string, string>> EnrichExcerptAsync(IReadOnlyList<string> ids, CancellationToken ct = default);
}
