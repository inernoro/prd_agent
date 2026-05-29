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
[BsonIgnoreExtraElements]
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

    /// <summary>
    /// 公共站点说明里命中此仓库的原文段落（完整、不截断）。
    /// 用于前端「查看详情」时展示，让用户能完整看到 AI 是从哪段文字判断出这个仓库的。
    /// </summary>
    public string? SourceContext { get; set; }
}

/// <summary>
/// 解析结果（V2 重构后按仓库分组）：一个仓库 → 该仓库下命中的项目路径 + 关联到的方案应用/模块。
/// 必须有 BsonIgnoreExtraElements：DB 里有 V1 时按 module 分组的老字段（如 appName / module / projectPath），
/// 反序列化时遇到这些 driver 默认会抛 BsonSerializationException 让整个 plan 查询变 500。
/// </summary>
[BsonIgnoreExtraElements]
public class ProjectRouteResolution
{
    /// <summary>仓库 url（来自 plan.ExtractedRepos[*]）</summary>
    public string RepoUrl { get; set; } = string.Empty;

    /// <summary>仓库展示名（来自 plan.ExtractedRepos[*].AppName）</summary>
    public string RepoAppName { get; set; } = string.Empty;

    /// <summary>routemap/ 下命中的项目相对路径（如 "billing/main.json"）</summary>
    public List<string> ProjectPaths { get; set; } = new();

    /// <summary>方案里命中该仓库的应用 / 模块清单（去重，文档头里抽到的原话）</summary>
    public List<string> MatchedAppsOrModules { get; set; } = new();

    /// <summary>命中说明（LLM 给出的中文解释，用户可读）</summary>
    public string? Reasoning { get; set; }

    /// <summary>命中状态：Hit / NotFound / Ambiguous / CloneFailed / NoRoutemap</summary>
    public string Status { get; set; } = ProjectRouteResolutionStatuses.Hit;

    /// <summary>
    /// 从该仓库命中的 routemap *.md 文件内容里用正则扫出的所有第三方 git 仓库 URL（去重）。
    /// 例如 routemap/项目调用地图.md 里写了「子仓库 A: https://.../a.git」，会收录进来。
    /// </summary>
    public List<string> LinkedThirdPartyRepos { get; set; } = new();

    /// <summary>
    /// 命中的 routemap *.md 文件全文（前端「查看明细」时展示，不截断）。
    /// Key = 文件相对仓库根的路径，Value = 文件完整文本。
    /// </summary>
    public List<ProjectRouteRoutemapFile> RoutemapFiles { get; set; } = new();
}

/// <summary>
/// 一份 routemap .md 文件的完整快照（前端可点开查看）。
/// </summary>
[BsonIgnoreExtraElements]
public class ProjectRouteRoutemapFile
{
    public string Path { get; set; } = string.Empty;
    public long SizeBytes { get; set; }
    public string? Content { get; set; }
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
    public const string CloneFailed = "CloneFailed";
    public const string NoRoutemap = "NoRoutemap";
}
