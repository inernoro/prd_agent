using MongoDB.Bson.Serialization.Attributes;

namespace PrdAgent.Core.Models;

/// <summary>
/// 项目路由智能体 - 用户上传的方案 + AI 分析结果
/// 流程：用户上传 .md → LLM 抽取 apps/modules/repos → 克隆 AI 抽出的仓库 → 扫 routemap → LLM 匹配项目路径
/// </summary>
[BsonIgnoreExtraElements]
public class ProjectRoutePlan
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>提交人 UserId</summary>
    public string SubmitterId { get; set; } = string.Empty;

    /// <summary>提交人展示名</summary>
    public string SubmitterName { get; set; } = string.Empty;

    /// <summary>方案标题（由提交人填写）</summary>
    public string Title { get; set; } = string.Empty;

    /// <summary>已上传的 .md 文件 AttachmentId</summary>
    public string AttachmentId { get; set; } = string.Empty;

    /// <summary>原始文件名</summary>
    public string FileName { get; set; } = string.Empty;

    /// <summary>提取的 Markdown 文本内容</summary>
    public string? ExtractedContent { get; set; }

    /// <summary>分析使用的公共站点说明 ID（快照锚点）</summary>
    public string? SiteSpecId { get; set; }

    /// <summary>LLM 抽取出的应用清单</summary>
    public List<string> ExtractedApps { get; set; } = new();

    /// <summary>LLM 抽取出的业务模块清单</summary>
    public List<string> ExtractedModules { get; set; } = new();

    /// <summary>
    /// LLM 从「公共站点说明 + 用户方案」里抽出来、本次分析实际去克隆的仓库列表。
    /// 替代 V1 里管理员手填的仓库登记表。
    /// </summary>
    public List<ProjectRouteExtractedRepo> ExtractedRepos { get; set; } = new();

    /// <summary>解析结果：每条「应用 - 仓库 - routemap 项目路径」三元组</summary>
    public List<ProjectRouteResolution> Resolutions { get; set; } = new();

    /// <summary>状态：Queued / Running / Done / Error</summary>
    public string Status { get; set; } = ProjectRoutePlanStatuses.Queued;

    public string? ErrorMessage { get; set; }

    /// <summary>记录本次 AI 调用使用的模型名（用于「AI 模型可见性」）</summary>
    public string? Model { get; set; }
    public string? ModelPlatform { get; set; }

    public DateTime SubmittedAt { get; set; } = DateTime.UtcNow;
    public DateTime? StartedAt { get; set; }
    public DateTime? CompletedAt { get; set; }
}

/// <summary>
/// AI 抽出的某个仓库引用。用于本次分析的克隆 + routemap 扫描。
/// </summary>
public class ProjectRouteExtractedRepo
{
    /// <summary>应用 / 仓库展示名（AI 推断）</summary>
    public string AppName { get; set; } = string.Empty;

    /// <summary>仓库 git URL（AI 从公共说明里读出）</summary>
    public string RepoUrl { get; set; } = string.Empty;

    /// <summary>分支，默认 main</summary>
    public string Branch { get; set; } = "main";

    /// <summary>routemap 目录相对路径，默认 "routemap"</summary>
    public string RoutemapPath { get; set; } = "routemap";

    /// <summary>AI 给出的命中说明（为什么这个仓库要被克隆）</summary>
    public string? Reasoning { get; set; }
}

/// <summary>
/// 解析结果：一个应用 / 业务模块 → 对应的仓库 routemap 下的项目路径
/// </summary>
public class ProjectRouteResolution
{
    /// <summary>用户方案里被识别的应用 / 业务模块名</summary>
    public string AppOrModule { get; set; } = string.Empty;

    /// <summary>命中的仓库（来自本次 AI 抽出的 ExtractedRepos[*]）</summary>
    public string? RepoUrl { get; set; }
    public string? RepoAppName { get; set; }

    /// <summary>routemap/ 下命中的项目相对路径（如 "billing/main.json"），可能多个</summary>
    public List<string> ProjectPaths { get; set; } = new();

    /// <summary>命中说明（LLM 给出的中文解释，用户可读）</summary>
    public string? Reasoning { get; set; }

    /// <summary>命中状态：Hit（找到） / NotFound（未找到） / Ambiguous（多候选）</summary>
    public string Status { get; set; } = ProjectRouteResolutionStatuses.Hit;
}

public static class ProjectRoutePlanStatuses
{
    public const string Queued = "Queued";
    public const string Running = "Running";
    public const string Done = "Done";
    public const string Error = "Error";
}

public static class ProjectRouteResolutionStatuses
{
    public const string Hit = "Hit";
    public const string NotFound = "NotFound";
    public const string Ambiguous = "Ambiguous";
}
