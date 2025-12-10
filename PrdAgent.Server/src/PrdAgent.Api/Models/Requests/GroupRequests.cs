using System.ComponentModel.DataAnnotations;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Models.Requests;

/// <summary>
/// 创建群组请求
/// </summary>
public class CreateGroupRequest
{
    /// <summary>绑定的PRD文档ID</summary>
    [Required(ErrorMessage = "PRD文档ID不能为空")]
    public string PrdDocumentId { get; set; } = string.Empty;

    /// <summary>群组名称（可选）</summary>
    [StringLength(50, ErrorMessage = "群组名称不能超过50字符")]
    public string? GroupName { get; set; }
}

/// <summary>
/// 加入群组请求
/// </summary>
public class JoinGroupRequest
{
    /// <summary>邀请码</summary>
    [Required(ErrorMessage = "邀请码不能为空")]
    public string InviteCode { get; set; } = string.Empty;

    /// <summary>加入时的角色</summary>
    [Required(ErrorMessage = "角色不能为空")]
    public UserRole UserRole { get; set; }
}

/// <summary>
/// 群组消息请求
/// </summary>
public class GroupMessageRequest
{
    /// <summary>消息内容</summary>
    [Required(ErrorMessage = "消息内容不能为空")]
    [MaxLength(16 * 1024, ErrorMessage = "消息内容不能超过16KB")]
    public string Content { get; set; } = string.Empty;

    /// <summary>附件ID列表</summary>
    public List<string>? AttachmentIds { get; set; }
}


