namespace PrdAgent.Core.Models;

/// <summary>
/// 项目简报 — AI 基于项目实时数据生成的对外汇报页（自包含 HTML 单文件）。
/// 生成即落库；分享走 ShareToken（可撤销），保存到网页托管记 HostedSiteId。
/// </summary>
public class PmBriefing
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>所属项目</summary>
    public string ProjectId { get; set; } = string.Empty;

    /// <summary>简报标题（如「XX 项目简报 · 2026-06-12」）</summary>
    public string Title { get; set; } = string.Empty;

    /// <summary>自包含 HTML 正文（内联样式，可直接下载/托管）</summary>
    public string Html { get; set; } = string.Empty;

    /// <summary>生成所用模型（取自 Gateway Resolution，规则 ai-model-visibility 要求落库）</summary>
    public string? Model { get; set; }

    /// <summary>简报风格：classic | dark | warm | minimal | vivid（PmBriefingRenderer 主题 key）</summary>
    public string Style { get; set; } = "classic";

    /// <summary>渲染数据快照 JSON（硬数据 + AI 结构化内容）。切换风格时据此重渲染，不重新调 LLM；旧数据为空则不支持切换</summary>
    public string? RenderDataJson { get; set; }

    /// <summary>分享 token：非空 = 分享已开启，匿名可通过 /api/pm/briefings/shared/{token} 查看；置空即撤销</summary>
    public string? ShareToken { get; set; }

    /// <summary>保存到网页托管后的站点 Id（HostedSite，可空）</summary>
    public string? HostedSiteId { get; set; }

    /// <summary>托管站点入口 URL（冗余，便于列表/详情直接展示可点链接）</summary>
    public string? HostedSiteUrl { get; set; }

    public string CreatedBy { get; set; } = string.Empty;
    public string? CreatedByName { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    /// <summary>生成 URL-safe 分享 token（与 DefectShareLink 同款约定）</summary>
    public static string GenerateShareToken()
        => Convert.ToBase64String(System.Security.Cryptography.RandomNumberGenerator.GetBytes(9))
            .Replace("+", "-").Replace("/", "_").TrimEnd('=');
}
