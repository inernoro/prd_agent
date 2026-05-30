namespace PrdAgent.Core.Models;

/// <summary>
/// 首页「AI 大事早知道」单条资讯（裁剪后的对外 DTO）。
/// 数据来自外部公共静态源 ai-news-radar，仅透传前端渲染需要的字段。
/// </summary>
public class AiNewsItem
{
    public string Id { get; set; } = "";
    public string Title { get; set; } = "";
    public string Url { get; set; } = "";
    public string Source { get; set; } = "";
    public string SiteName { get; set; } = "";
    /// <summary>原始发布时间（可能为空，部分聚合源无发布时间）。</summary>
    public string? PublishedAt { get; set; }
    /// <summary>雷达首次抓到的时间，作为 PublishedAt 缺失时的排序/分组兜底。</summary>
    public string? FirstSeenAt { get; set; }
    /// <summary>AI 分类标签（model_release / ai_general / ...），前端按注册表映射颜色与中文。</summary>
    public string AiLabel { get; set; } = "";
    /// <summary>AI 相关度评分 0~1。</summary>
    public double AiScore { get; set; }
}

/// <summary>
/// 资讯流响应：条目 + 元信息（生成时间 / 降级 / stale 标记）。
/// </summary>
public class AiNewsFeed
{
    public List<AiNewsItem> Items { get; set; } = new();
    public int Total { get; set; }
    /// <summary>上游生成时间（ISO8601），前端用于「最近同步 X 前」实时展示。</summary>
    public string? GeneratedAt { get; set; }
    /// <summary>上游不可达且无缓存可用：前端走空态。</summary>
    public bool Degraded { get; set; }
    /// <summary>上游本次拉取失败，返回的是上一次成功的缓存（仍可展示，但提示非最新）。</summary>
    public bool Stale { get; set; }
}
