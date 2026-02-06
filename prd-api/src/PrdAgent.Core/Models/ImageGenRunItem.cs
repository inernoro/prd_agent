using PrdAgent.Core.Attributes;

namespace PrdAgent.Core.Models;

/// <summary>
/// 生图任务 - 单张图片结果（单独存储，避免超过 Mongo 单文档 16MB 限制）
/// </summary>
[AppOwnership(AppNames.VisualAgent, AppNames.VisualAgentDisplay, IsPrimary = true)]
public class ImageGenRunItem
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    public string OwnerAdminId { get; set; } = string.Empty;

    public string RunId { get; set; } = string.Empty;

    public int ItemIndex { get; set; }
    public int ImageIndex { get; set; }

    public string Prompt { get; set; } = string.Empty;

    public string RequestedSize { get; set; } = "1024x1024";
    public string? EffectiveSize { get; set; }
    public bool SizeAdjusted { get; set; }
    public bool RatioAdjusted { get; set; }

    public ImageGenRunItemStatus Status { get; set; } = ImageGenRunItemStatus.Queued;

    public string? Base64 { get; set; }
    public string? Url { get; set; }
    public string? RevisedPrompt { get; set; }

    public string? ErrorCode { get; set; }
    public string? ErrorMessage { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? StartedAt { get; set; }
    public DateTime? EndedAt { get; set; }
}

public enum ImageGenRunItemStatus
{
    Queued,
    Running,
    Done,
    Error
}


