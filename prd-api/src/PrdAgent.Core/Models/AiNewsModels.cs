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
    /// <summary>命中的 AI 关键信号词（如 ["智能体","RAG"]），前端作为附加标签展示。</summary>
    public List<string> AiSignals { get; set; } = new();
    /// <summary>AI 生成的一句话解读 / 推荐理由（来自 ai_news_enrichments 缓存，未生成时为 null）。</summary>
    public string? Commentary { get; set; }
}

/// <summary>
/// 「AI 大事」每条资讯的 AI 一句话解读缓存（按资讯 id 去重，避免每次刷新重复调用 LLM）。
/// 数据源只有标题，故解读是基于「标题 + 来源 + 分类」的编辑点评，不是文章正文摘要。
/// </summary>
public class AiNewsEnrichment
{
    /// <summary>资讯条目 id（= AiNewsItem.Id），作为主键去重。</summary>
    public string Id { get; set; } = "";
    /// <summary>资讯标题（生成时的快照，便于排查）。</summary>
    public string Title { get; set; } = "";
    /// <summary>AI 一句话解读 / 推荐理由。</summary>
    public string Commentary { get; set; } = "";
    /// <summary>生成所用模型（可观测）。</summary>
    public string Model { get; set; } = "";
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
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
