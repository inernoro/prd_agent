namespace PrdAgent.Core.Models;

/// <summary>
/// 项目路由智能体 - 公共站点说明（管理员维护，全站共享，单条 Active 记录）
/// </summary>
public class ProjectRouteSiteSpec
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>显示标题（如「米多公共站点说明 v1」）</summary>
    public string Title { get; set; } = string.Empty;

    /// <summary>原始 Markdown 内容（管理员上传的公共站点说明全文）</summary>
    public string MarkdownContent { get; set; } = string.Empty;

    /// <summary>
    /// 站点登记的仓库列表 —— 用户方案分析时，AI 会从这些仓库的 routemap/ 目录里查找匹配。
    /// 每条记录由管理员配置或者从 MarkdownContent 抽取出来。
    /// </summary>
    public List<ProjectRouteRepoEntry> Repos { get; set; } = new();

    /// <summary>是否启用（同一时间通常只有 1 条 IsActive=true）</summary>
    public bool IsActive { get; set; } = true;

    /// <summary>创建人 UserId</summary>
    public string CreatedBy { get; set; } = string.Empty;

    /// <summary>更新人 UserId</summary>
    public string? UpdatedBy { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>
/// 公共站点说明里登记的单个仓库
/// </summary>
public class ProjectRouteRepoEntry
{
    /// <summary>应用展示名（如「米多 PRD Agent」「米多缺陷管理」）</summary>
    public string AppName { get; set; } = string.Empty;

    /// <summary>应用别名 / 业务模块关键词（用于 LLM 匹配，如 ["PRD","解读"]）</summary>
    public List<string> Aliases { get; set; } = new();

    /// <summary>仓库 git url（必填）—— 如 https://github.com/inernoro/prd_agent.git</summary>
    public string RepoUrl { get; set; } = string.Empty;

    /// <summary>分支，默认 main</summary>
    public string Branch { get; set; } = "main";

    /// <summary>routemap 目录在仓库中的相对路径，默认 "routemap"</summary>
    public string RoutemapPath { get; set; } = "routemap";

    /// <summary>备注（人类可读）</summary>
    public string? Notes { get; set; }
}
