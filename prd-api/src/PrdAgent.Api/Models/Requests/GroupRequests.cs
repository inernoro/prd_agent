using PrdAgent.Core.Models;

namespace PrdAgent.Api.Models.Requests;

/// <summary>
/// 创建群组请求
/// </summary>
public class CreateGroupRequest
{
    /// <summary>绑定的PRD文档ID</summary>
    public string? PrdDocumentId { get; set; }

    /// <summary>群组名称（可选）</summary>
    public string? GroupName { get; set; }

    /// <summary>验证请求</summary>
    public (bool IsValid, string? ErrorMessage) Validate()
    {
        // 允许先创建群组，PRD 后续再绑定
        // 仅校验群组名称本身
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

/// <summary>
/// 打开群组会话请求
/// </summary>
public class OpenGroupSessionRequest
{
    /// <summary>当前用户角色</summary>
    public UserRole UserRole { get; set; } = UserRole.DEV;

    public (bool IsValid, string? ErrorMessage) Validate()
    {
        if (UserRole is not (UserRole.PM or UserRole.DEV or UserRole.QA or UserRole.ADMIN))
            return (false, "无效的角色");
        return (true, null);
    }
}

/// <summary>
/// 绑定群组 PRD 请求
/// </summary>
public class BindGroupPrdRequest
{
    /// <summary>PRD 文档ID</summary>
    public string PrdDocumentId { get; set; } = string.Empty;

    public (bool IsValid, string? ErrorMessage) Validate()
    {
        if (string.IsNullOrWhiteSpace(PrdDocumentId))
            return (false, "PRD文档ID不能为空");
        return (true, null);
    }
}

/// <summary>
/// 更新群组名称请求
/// </summary>
public class UpdateGroupNameRequest
{
    /// <summary>新的群组名称</summary>
    public string? GroupName { get; set; }

    public (bool IsValid, string? ErrorMessage) Validate()
    {
        if (string.IsNullOrWhiteSpace(GroupName))
            return (false, "群组名称不能为空");
        if (GroupName.Length > 50)
            return (false, "群组名称不能超过50字符");
        return (true, null);
    }
}
