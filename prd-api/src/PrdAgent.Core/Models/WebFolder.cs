using PrdAgent.Core.Attributes;

namespace PrdAgent.Core.Models;

/// <summary>
/// 网页/知识库自定义分类。基础用途：给托管站点分类（替代/增强裸 Folder 字符串）。
/// 进阶用途：给高频分类（如「运营简报」）绑定一个生成器（用户配置的 skill 或 Markdown
/// 模板），之后一键「按分类生成」→ 复用 IHostedSiteService.CreateFromContentAsync /
/// 知识库 AddEntry 自动产出对应网页/文档。
/// </summary>
[AppOwnership(AppNames.System, AppNames.SystemDisplay)]
public class WebFolder
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>所属用户 UserId（个人分类，按 owner 隔离）</summary>
    public string OwnerUserId { get; set; } = string.Empty;

    /// <summary>分类名称（如「运营简报」）</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>分类描述</summary>
    public string? Description { get; set; }

    /// <summary>排序权重（小在前）</summary>
    public int SortOrder { get; set; }

    /// <summary>
    /// 生成器类型：
    /// - none: 仅作分类，不绑定生成器（默认）
    /// - skill: 绑定一个用户 skill，按分类生成时执行该 skill 产出内容
    /// - markdown: 绑定一段 Markdown 模板，按分类生成时直接渲染为网页
    /// </summary>
    public string GeneratorType { get; set; } = WebFolderGeneratorType.None;

    /// <summary>绑定的 skill ID（GeneratorType=skill 时）</summary>
    public string? GeneratorSkillId { get; set; }

    /// <summary>绑定的 Markdown 模板内容（GeneratorType=markdown 时）</summary>
    public string? GeneratorMarkdown { get; set; }

    /// <summary>生成目标：web = 生成托管网页（默认）| document-store = 生成知识库条目</summary>
    public string GenerateTarget { get; set; } = WebFolderGenerateTarget.Web;

    /// <summary>生成目标知识库空间 ID（GenerateTarget=document-store 时）</summary>
    public string? GenerateStoreId { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>分类生成器类型常量</summary>
public static class WebFolderGeneratorType
{
    public const string None = "none";
    public const string Skill = "skill";
    public const string Markdown = "markdown";
    public static readonly string[] All = { None, Skill, Markdown };
}

/// <summary>分类生成目标常量</summary>
public static class WebFolderGenerateTarget
{
    public const string Web = "web";
    public const string DocumentStore = "document-store";
    public static readonly string[] All = { Web, DocumentStore };
}
