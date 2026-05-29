using MongoDB.Bson.Serialization.Attributes;

namespace PrdAgent.Core.Models;

/// <summary>
/// 项目路由智能体 - 公共站点说明（管理员维护，全站共享，单条 Active 记录）
/// V2 (2026-05-26)：仓库登记表移除，分析阶段由 AI 直接从 MarkdownContent 抽 git URL。
/// </summary>
[BsonIgnoreExtraElements] // 兼容 V1 已存 DB 文档里的 Repos 字段
public class ProjectRouteSiteSpec
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>显示标题（如「米多公共站点说明 v1」）</summary>
    public string Title { get; set; } = string.Empty;

    /// <summary>
    /// 公共站点说明 Markdown 全文。
    /// 管理员可在文档里直接列出仓库地址（如 "PRD 智能体: https://github.com/.../prd_agent.git"），
    /// 分析时 AI 会从这份文档 + 用户方案中抽取真正涉及到的仓库 git URL 去克隆。
    /// </summary>
    public string MarkdownContent { get; set; } = string.Empty;

    /// <summary>是否启用（同一时间通常只有 1 条 IsActive=true）</summary>
    public bool IsActive { get; set; } = true;

    /// <summary>创建人 UserId</summary>
    public string CreatedBy { get; set; } = string.Empty;

    /// <summary>更新人 UserId</summary>
    public string? UpdatedBy { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
