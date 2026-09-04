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

    /// <summary>OpenDesign 工作区输入包的对象存储物理 key。只由 MAP 与 CDS 控制面读取。</summary>
    public string? WorkspaceInputAssetKey { get; set; }

    public string? WorkspaceInputSha256 { get; set; }

    /// <summary>输入快照的不可变版本。结果提交必须原样带回，防止旧任务覆盖新输入。</summary>
    public string? WorkspaceBaseRevision { get; set; }

    /// <summary>CDS 原子提交的结果包对象存储物理 key。</summary>
    public string? WorkspaceResultAssetKey { get; set; }

    public string? WorkspaceResultSha256 { get; set; }

    /// <summary>本次远程运行已通过 MAP 代理进入 LLMGW 的真实请求数。</summary>
    public int RuntimeModelCallCount { get; set; }

    public int RuntimeModelCallLimit { get; set; } = 36;

    public DateTime? RuntimeTicketExpiresAt { get; set; }

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
