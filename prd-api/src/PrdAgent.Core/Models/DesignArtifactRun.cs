namespace PrdAgent.Core.Models;

/// <summary>
/// 跨网页托管、知识库与 HTML PPT 的统一设计任务。
/// 事件流保存在 Redis；此记录保存可恢复、可审计的业务事实与知识快照。
/// </summary>
public class DesignArtifactRun
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    public string UserId { get; set; } = string.Empty;

    public string Status { get; set; } = RunStatuses.Queued;

    public string ArtifactType { get; set; } = DesignArtifactTypes.WebPage;

    public string Operation { get; set; } = DesignArtifactOperations.Generate;

    public string SourceSurface { get; set; } = DesignArtifactSourceSurfaces.WebHosting;

    public string Runtime { get; set; } = DesignArtifactRuntimes.MapGateway;

    public string Instruction { get; set; } = string.Empty;

    public string? Title { get; set; }

    public string? TargetSiteId { get; set; }

    public string? ArtifactSiteId { get; set; }

    public string? ArtifactRevisionId { get; set; }

    public string? LinkedRunId { get; set; }

    public int Progress { get; set; }

    public string Phase { get; set; } = "任务已进入队列";

    public string? Error { get; set; }

    public List<DesignKnowledgeSnapshot> KnowledgeReferences { get; set; } = new();

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    public DateTime? CompletedAt { get; set; }
}

public class DesignKnowledgeSnapshot
{
    public string EntryId { get; set; } = string.Empty;

    public string? StoreId { get; set; }

    public string? StoreName { get; set; }

    public string Title { get; set; } = string.Empty;

    public string Content { get; set; } = string.Empty;

    public string ContentHash { get; set; } = string.Empty;
}

public static class DesignArtifactTypes
{
    public const string WebPage = "web-page";
    public const string HtmlPpt = "html-ppt";
}

public static class DesignArtifactOperations
{
    public const string Generate = "generate";
    public const string Edit = "edit";
}

public static class DesignArtifactSourceSurfaces
{
    public const string WebHosting = "web-hosting";
    public const string KnowledgeBase = "knowledge-base";
    public const string HtmlPpt = "html-ppt";
}

public static class DesignArtifactRuntimes
{
    public const string MapGateway = "map-gateway";
    public const string OpenDesign = "open-design";
    public const string Codex = "codex";
    public const string Claude = "claude";
    public const string HtmlPptPipeline = "html-ppt-pipeline";
}
