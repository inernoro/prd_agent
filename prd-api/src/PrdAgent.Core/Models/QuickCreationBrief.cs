namespace PrdAgent.Core.Models;

public sealed class QuickCreationBrief
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string UserId { get; set; } = string.Empty;
    public string? DeploymentSlug { get; set; }
    public int Revision { get; set; }
    public string Kind { get; set; } = "web";
    public string StyleId { get; set; } = "sketchnote";
    public string StyleSource { get; set; } = "default";
    public List<string> AttachmentIds { get; set; } = [];
    public string? SourceTitle { get; set; }
    public string? Title { get; set; }
    public string? Manuscript { get; set; }
    public string? Audience { get; set; }
    public string? Duration { get; set; }
    public List<QuickCreationBriefMessage> Messages { get; set; } = [];
    public List<QuickCreationScriptScene> Script { get; set; } = [];
    public string? PendingTurnId { get; set; }
    public DateTime? PendingUntil { get; set; }
    public string? UnsentText { get; set; }
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

public sealed record QuickCreationBriefMessage(string Id, string Role, string Text,
    string? Model = null, string? Platform = null, IReadOnlyList<string>? QuickReplies = null,
    IReadOnlyList<QuickCreationStyleRecommendation>? Recommendations = null, bool StartsProduction = false);

public sealed record QuickCreationStyleRecommendation(string TemplateId, string Reason);
public sealed record QuickCreationScriptScene(int Index, string Visual, string Narration);
