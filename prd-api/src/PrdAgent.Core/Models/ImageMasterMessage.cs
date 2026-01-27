using PrdAgent.Core.Attributes;

namespace PrdAgent.Core.Models;

[AppOwnership(AppNames.VisualAgent, AppNames.VisualAgentDisplay, IsPrimary = true)]
public class ImageMasterMessage
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string SessionId { get; set; } = string.Empty;
    public string WorkspaceId { get; set; } = string.Empty;
    public string OwnerUserId { get; set; } = string.Empty; // ADMIN userId
    public string Role { get; set; } = "User"; // User | Assistant
    public string Content { get; set; } = string.Empty;
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}


