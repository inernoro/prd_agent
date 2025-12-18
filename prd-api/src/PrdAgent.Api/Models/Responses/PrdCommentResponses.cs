using PrdAgent.Core.Models;

namespace PrdAgent.Api.Models.Responses;

public class PrdCommentInfo
{
    public string Id { get; set; } = string.Empty;
    public string DocumentId { get; set; } = string.Empty;
    public string HeadingId { get; set; } = string.Empty;
    public string HeadingTitleSnapshot { get; set; } = string.Empty;
    public string AuthorUserId { get; set; } = string.Empty;
    public string AuthorDisplayName { get; set; } = string.Empty;
    public string Content { get; set; } = string.Empty;
    public DateTime CreatedAt { get; set; }
    public DateTime? UpdatedAt { get; set; }

    public static PrdCommentInfo FromEntity(PrdComment c)
    {
        return new PrdCommentInfo
        {
            Id = c.Id ?? string.Empty,
            DocumentId = c.DocumentId,
            HeadingId = c.HeadingId,
            HeadingTitleSnapshot = c.HeadingTitleSnapshot,
            AuthorUserId = c.AuthorUserId,
            AuthorDisplayName = c.AuthorDisplayName,
            Content = c.Content,
            CreatedAt = c.CreatedAt,
            UpdatedAt = c.UpdatedAt,
        };
    }
}
