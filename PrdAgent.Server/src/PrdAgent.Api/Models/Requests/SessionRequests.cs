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

/// <summary>
/// 启动引导请求
/// </summary>
public class StartGuideRequest
{
    /// <summary>角色</summary>
    public UserRole Role { get; set; }
}

/// <summary>
/// 引导控制请求
/// </summary>
public class GuideControlRequest
{
    /// <summary>控制动作</summary>
    public GuideAction Action { get; set; }

    /// <summary>目标步骤（仅GoTo时需要）</summary>
    public int? Step { get; set; }
}





