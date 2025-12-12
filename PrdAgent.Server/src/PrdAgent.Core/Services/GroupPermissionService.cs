using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

namespace PrdAgent.Core.Services;

/// <summary>
/// 群组权限服务
/// </summary>
public static class GroupPermissionService
{
    /// <summary>
    /// 检查用户是否有权限执行操作
    /// </summary>
    public static bool HasPermission(UserRole userRole, GroupPermission permission)
    {
        return permission switch
        {
            // PM 权限
            GroupPermission.CreateGroup => userRole == UserRole.PM || userRole == UserRole.ADMIN,
            GroupPermission.DeleteGroup => userRole == UserRole.PM || userRole == UserRole.ADMIN,
            GroupPermission.InviteMembers => userRole == UserRole.PM || userRole == UserRole.ADMIN,
            GroupPermission.RemoveMembers => userRole == UserRole.PM || userRole == UserRole.ADMIN,
            GroupPermission.UpdatePrd => userRole == UserRole.PM || userRole == UserRole.ADMIN,
            GroupPermission.ManageGaps => userRole == UserRole.PM || userRole == UserRole.ADMIN,
            
            // 所有成员权限
            GroupPermission.SendMessage => true,
            GroupPermission.ViewHistory => true,
            GroupPermission.StartGuide => true,
            GroupPermission.AskQuestion => true,
            
            // DEV/QA 特殊权限
            GroupPermission.ReportGap => userRole == UserRole.DEV || userRole == UserRole.QA,
            
            _ => false
        };
    }

    /// <summary>
    /// 获取用户在群组中的所有权限
    /// </summary>
    public static List<GroupPermission> GetUserPermissions(UserRole userRole)
    {
        return Enum.GetValues<GroupPermission>()
            .Where(p => HasPermission(userRole, p))
            .ToList();
    }
}

/// <summary>
/// 群组权限枚举
/// </summary>
public enum GroupPermission
{
    // PM/Admin 权限
    CreateGroup,
    DeleteGroup,
    InviteMembers,
    RemoveMembers,
    UpdatePrd,
    ManageGaps,
    
    // 通用权限
    SendMessage,
    ViewHistory,
    StartGuide,
    AskQuestion,
    
    // DEV/QA 权限
    ReportGap
}