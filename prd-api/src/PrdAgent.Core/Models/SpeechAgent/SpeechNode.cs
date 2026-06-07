namespace PrdAgent.Core.Models.SpeechAgent;

/// <summary>
/// 演讲节点（思维导图的一格）。
/// 一棵树：root 节点 ParentId=null，其余节点指向父节点。
/// </summary>
public class SpeechNode
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    public string DeckId { get; set; } = string.Empty;

    public string? ParentId { get; set; }

    /// <summary>同级排序。</summary>
    public int Order { get; set; }

    /// <summary>层级深度：root=0。</summary>
    public int Depth { get; set; }

    public string Title { get; set; } = string.Empty;

    /// <summary>要点列表（讲解时的子点）。</summary>
    public List<string> BulletPoints { get; set; } = new();

    /// <summary>演讲备注 markdown（可选，Phase 2 自动生成）。</summary>
    public string? SpeakerNotes { get; set; }

    /// <summary>节点配图 ImageAsset Id（Phase 2）。</summary>
    public string? ImageAssetId { get; set; }

    /// <summary>节点状态：pending / generating / ready / failed。</summary>
    public string Status { get; set; } = SpeechNodeStatus.Ready;

    /// <summary>生成批次 Id。每次 regen 一个新 Guid,用于在并发/stale 抢占场景里精确识别"本批"节点。</summary>
    public string? GenerationRunId { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

public static class SpeechNodeStatus
{
    public const string Pending = "pending";
    public const string Generating = "generating";
    public const string Ready = "ready";
    public const string Failed = "failed";
}
