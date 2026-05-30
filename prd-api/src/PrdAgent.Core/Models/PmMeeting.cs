namespace PrdAgent.Core.Models;

/// <summary>
/// 项目会议纪要 — 记录会议时间、地点、参会人与纪要正文（Markdown）。
/// 正文复用 reading 版式渲染，支持图片。
/// </summary>
public class PmMeeting
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>所属项目</summary>
    public string ProjectId { get; set; } = string.Empty;

    /// <summary>会议主题</summary>
    public string Title { get; set; } = string.Empty;

    /// <summary>会议时间</summary>
    public DateTime? MeetingAt { get; set; }

    /// <summary>会议地点 / 线上会议链接</summary>
    public string? Location { get; set; }

    /// <summary>参会人 UserId 列表</summary>
    public List<string> AttendeeIds { get; set; } = new();

    /// <summary>纪要正文（Markdown）</summary>
    public string Content { get; set; } = string.Empty;

    /// <summary>记录人 UserId</summary>
    public string RecordedBy { get; set; } = string.Empty;

    /// <summary>记录人名称（冗余）</summary>
    public string? RecordedByName { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
