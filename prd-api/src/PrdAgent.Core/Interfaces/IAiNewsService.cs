using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

/// <summary>
/// 首页「AI 大事早知道」资讯雷达服务。
/// 拉取外部公共静态源（ai-news-radar），内存缓存 + stale 保底，对外只暴露裁剪后的资讯流。
/// </summary>
public interface IAiNewsService
{
    Task<AiNewsFeed> GetLatestAsync(CancellationToken ct = default);
}
