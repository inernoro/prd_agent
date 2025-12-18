namespace PrdAgent.Api.Models.Requests;

public class CreatePrdCommentRequest
{
    public string DocumentId { get; set; } = string.Empty;
    public string GroupId { get; set; } = string.Empty;
    public string HeadingId { get; set; } = string.Empty;
    public string HeadingTitleSnapshot { get; set; } = string.Empty;
    public string Content { get; set; } = string.Empty;

    public (bool IsValid, string? ErrorMessage) Validate()
    {
        if (string.IsNullOrWhiteSpace(DocumentId)) return (false, "documentId 不能为空");
        if (string.IsNullOrWhiteSpace(GroupId)) return (false, "groupId 不能为空");
        if (string.IsNullOrWhiteSpace(HeadingId)) return (false, "headingId 不能为空");
        if (string.IsNullOrWhiteSpace(Content)) return (false, "content 不能为空");
        return (true, null);
    }
}
