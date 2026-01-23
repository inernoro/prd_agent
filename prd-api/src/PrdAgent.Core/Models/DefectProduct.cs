namespace PrdAgent.Core.Models;

/// <summary>
/// 产品目录
/// </summary>
public class DefectProduct
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>所属工作空间</summary>
    public string WorkspaceId { get; set; } = null!;

    /// <summary>产品名称 (大类)</summary>
    public string Name { get; set; } = null!;

    /// <summary>产品标识 (slug)</summary>
    public string Slug { get; set; } = null!;

    /// <summary>描述</summary>
    public string? Description { get; set; }

    /// <summary>图标</summary>
    public string? Icon { get; set; }

    /// <summary>模块列表</summary>
    public List<DefectModule> Modules { get; set; } = new();

    /// <summary>AI 识别关键词 (用于智能匹配)</summary>
    public List<string> AiKeywords { get; set; } = new();

    /// <summary>AI 识别 URL 模式 (正则)</summary>
    public List<string> UrlPatterns { get; set; } = new();

    public DateTime CreatedAt { get; set; }
}

/// <summary>
/// 产品模块 (小类/子应用)
/// </summary>
public class DefectModule
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>模块名称</summary>
    public string Name { get; set; } = null!;

    /// <summary>关联的仓库配置 ID 列表</summary>
    public List<string> RepoConfigIds { get; set; } = new();

    /// <summary>AI 识别关键词</summary>
    public List<string> AiKeywords { get; set; } = new();

    /// <summary>代码路径前缀 (帮助 AI 缩小搜索范围)</summary>
    public List<string> CodePathPrefixes { get; set; } = new();

    /// <summary>负责人 UserId 列表</summary>
    public List<string> OwnerUserIds { get; set; } = new();
}
