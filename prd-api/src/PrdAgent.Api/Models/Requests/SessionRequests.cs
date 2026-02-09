using PrdAgent.Core.Models;

namespace PrdAgent.Api.Models.Requests;

/// <summary>
/// 切换角色请求
/// </summary>
public class SwitchRoleRequest
{
    /// <summary>目标角色</summary>
    public UserRole Role { get; set; }
}

/// <summary>
/// 发送消息请求
/// </summary>
public class SendMessageRequest
{
    private const int MaxContentLength = 16 * 1024;

    /// <summary>消息内容</summary>
    public string Content { get; set; } = string.Empty;

    /// <summary>角色（可选，用于临时切换视角）</summary>
    public UserRole? Role { get; set; }

    /// <summary>附件ID列表</summary>
    public List<string>? AttachmentIds { get; set; }

    /// <summary>
    /// 提示词（可选，推荐）：稳定提示词标识
    /// </summary>
    public string? PromptKey { get; set; }

    /// <summary>
    /// 技能 ID（可选）：指定要使用的技能，优先级高于 PromptKey
    /// </summary>
    public string? SkillId { get; set; }

    /// <summary>
    /// 跳过 AI 回复（可选）：启用时仅保存用户消息，不触发 AI 回复（普通群聊模式）
    /// </summary>
    public bool? SkipAiReply { get; set; }

    /// <summary>验证请求</summary>
    public (bool IsValid, string? ErrorMessage) Validate()
    {
        if (string.IsNullOrWhiteSpace(Content))
            return (false, "消息内容不能为空");
        if (Content.Length > MaxContentLength)
            return (false, "消息内容不能超过16KB");
        return (true, null);
    }
}

// 引导讲解相关请求已删除（去阶段化）
