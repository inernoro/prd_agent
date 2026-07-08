using PrdAgent.Core.Attributes;

namespace PrdAgent.Core.Models;

[AppOwnership(AppNames.TranscriptAgent, AppNames.TranscriptAgentDisplay)]
public class TranscriptRun
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    public string ItemId { get; set; } = null!;

    public string WorkspaceId { get; set; } = null!;

    public string OwnerUserId { get; set; } = null!;

    /// <summary>任务类型: asr / copywrite</summary>
    public string Type { get; set; } = null!;

    /// <summary>状态: queued / processing / completed / failed</summary>
    public string Status { get; set; } = "queued";

    /// <summary>copywrite 类型时使用的模板 ID</summary>
    public string? TemplateId { get; set; }

    /// <summary>copywrite 生成的文案结果</summary>
    public string? Result { get; set; }

    public string? Error { get; set; }

    public int Progress { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    /// <summary>
    /// 内部发布证据采样标记：仅由带服务密钥的 LLM Gateway shadow seed 写入。
    /// Worker 读取后把本次 run 的 LLM 调用强制纳入 shadow comparison。
    /// </summary>
    public bool ForceFullShadowSample { get; set; }
}
