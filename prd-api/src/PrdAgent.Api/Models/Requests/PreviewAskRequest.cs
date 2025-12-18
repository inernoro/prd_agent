namespace PrdAgent.Api.Models.Requests;

public class PreviewAskRequest
{
    public string Question { get; set; } = string.Empty;
    public string HeadingId { get; set; } = string.Empty;
    public string? HeadingTitle { get; set; }

    public (bool ok, string? error) Validate()
    {
        if (string.IsNullOrWhiteSpace(Question)) return (false, "question 不能为空");
        if (string.IsNullOrWhiteSpace(HeadingId)) return (false, "headingId 不能为空");
        return (true, null);
    }
}

