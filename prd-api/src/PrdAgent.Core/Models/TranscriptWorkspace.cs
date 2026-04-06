using PrdAgent.Core.Attributes;

namespace PrdAgent.Core.Models;

[AppOwnership(AppNames.TranscriptAgent, AppNames.TranscriptAgentDisplay)]
public class TranscriptWorkspace
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    public string OwnerUserId { get; set; } = null!;

    public string Title { get; set; } = null!;

    public List<string> MemberUserIds { get; set; } = new();

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
