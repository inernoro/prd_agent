using PrdAgent.Core.Models;

namespace PrdAgent.Api.Models.Requests;

/// <summary>
/// 创建群组请求
/// </summary>
public class CreateGroupRequest
{
    /// <summary>绑定的PRD文档ID</summary>
    public string PrdDocumentId { get; set; } = string.Empty;

    /// <summary>群组名称（可选）</summary>
    public string? GroupName { get; set; }

    /// <summary>验证请求</summary>
    public (bool IsValid, string? ErrorMessage) Validate()
    {
        if (string.IsNullOrWhiteSpace(PrdDocumentId))
            return (false, "PRD文档ID不能为空");
        if (GroupName != null && GroupName.Length > 50)
            return (false, "群组名称不能超过50字符");
        return (true, null);
    }
}

/// <summary>
/// 加入群组请求
/// </summary>
public class JoinGroupRequest
{
    /// <summary>邀请码</summary>
    public string InviteCode { get; set; } = string.Empty;

    /// <summary>加入时的角色</summary>
    public UserRole UserRole { get; set; }

    /// <summary>验证请求</summary>
    public (bool IsValid, string? ErrorMessage) Validate()
    {
        if (string.IsNullOrWhiteSpace(InviteCode))
            return (false, "邀请码不能为空");
        return (true, null);
    }
}

/// <summary>
/// 群组消息请求
/// </summary>
public class GroupMessageRequest
{
    private const int MaxContentLength = 16 * 1024;

    /// <summary>消息内容</summary>
    public string Content { get; set; } = string.Empty;

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



