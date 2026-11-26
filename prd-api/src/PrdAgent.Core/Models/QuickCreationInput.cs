namespace PrdAgent.Core.Models;

/// <summary>服务端冻结的快捷创作参数，供恢复任务、追溯风格和回看资料使用。</summary>
public sealed class QuickCreationInput
{
    public string TemplateId { get; set; } = string.Empty;
    public string StyleSha256 { get; set; } = string.Empty;
    public string Ask { get; set; } = string.Empty;
    public List<string> AttachmentIds { get; set; } = new();
    public int? FilmTimeoutSeconds { get; set; }
}
