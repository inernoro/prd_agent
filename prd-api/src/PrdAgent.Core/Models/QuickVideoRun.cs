using System.Text.Json.Serialization;
using PrdAgent.Core.Interfaces;

namespace PrdAgent.Core.Models;

public sealed class QuickVideoRun : ITaskAuthorizedRun
{
    public string Id { get; set; } = string.Empty;
    [JsonIgnore] public string OwnerUserId { get; set; } = string.Empty;
    [JsonIgnore] public string? DeploymentSlug { get; set; }
    [JsonIgnore] public string? TaskPermitId { get; set; }
    [JsonIgnore] public DateTime? LeaseUntil { get; set; }
    [JsonIgnore] public DateTime? PublishLeaseUntil { get; set; }
    public string TemplateId { get; set; } = string.Empty;
    public string ArticleTitle { get; set; } = string.Empty;
    public string ArticleMarkdown { get; set; } = string.Empty;
    public string Status { get; set; } = QuickVideoStatus.Queued;
    public string CurrentPhase { get; set; } = "queued";
    public int PhaseProgress { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? StartedAt { get; set; }
    public DateTime? EndedAt { get; set; }
    public string? ErrorCode { get; set; }
    public string? ErrorMessage { get; set; }
    public List<QuickVideoScene> Scenes { get; set; } = [];
    public List<QuickVideoCaption> Captions { get; set; } = [];
    public string? ScriptLogId { get; set; }
    public string? VideoAssetUrl { get; set; }
    public string? VideoAssetSha256 { get; set; }
    public double TotalDurationSeconds { get; set; }
    public string? PublishedSiteId { get; set; }
}

public static class QuickVideoStatus
{
    public const string Queued = "Queued";
    public const string Running = "Running";
    public const string Completed = "Completed";
    public const string Failed = "Failed";
}

public sealed record QuickVideoScene(string Heading, string Note, string Narration, string SourceExcerpt);
public sealed record QuickVideoCaption(string Text, double StartSeconds, double EndSeconds, string SpeechRunId);

public sealed record QuickVideoTemplate(string Id, string Name, string Description, string Paper, string Ink, string Accent);

public static class QuickVideoTemplates
{
    public const int SceneCount = 3;
    public static IReadOnlyList<QuickVideoTemplate> Items { get; } =
    [
        new("sketchnote", "视觉笔记", "在点阵纸上用手绘线条讲清一份稿件。", "F8F3E7", "28251E", "E5AE38"),
    ];

    public static QuickVideoTemplate? Find(string? id) => Items.FirstOrDefault(item => item.Id == id);
}
