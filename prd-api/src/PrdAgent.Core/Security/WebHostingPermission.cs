using PrdAgent.Core.Models;

namespace PrdAgent.Core.Security;

/// <summary>
/// 网页托管内容角色常量（仅网页托管模块消费，知识库不读）。
/// 「团队 = 共享文件夹」模型下，团队成员对该文件夹内站点的权限由此三档决定。
/// </summary>
public static class WebHostingRoles
{
    /// <summary>文件夹所有者：编辑 + 删除文件夹内任意站点 + 管理成员网页托管角色（团队管理员默认映射到此）</summary>
    public const string Owner = "owner";

    /// <summary>编辑者：读 + 编辑/重传/建分享链接（不能删除别人创建的站点；删除留给站点创建者或文件夹所有者）</summary>
    public const string Editor = "editor";

    /// <summary>查看者：只读，不能编辑/重传/删除/建分享</summary>
    public const string Viewer = "viewer";

    public static readonly string[] All = { Owner, Editor, Viewer };

    public static bool IsValid(string? role) => role != null && Array.IndexOf(All, role) >= 0;

    /// <summary>
    /// 解析有效网页托管角色：显式 WebHostingRole 优先；为空/非法时继承团队角色
    /// （admin → owner，member → editor）。继承默认保证存量成员不被迁移意外降权。
    /// </summary>
    public static string Resolve(string? webHostingRole, string teamRole)
    {
        if (IsValid(webHostingRole)) return webHostingRole!;
        return teamRole == TeamRole.Admin ? Owner : Editor;
    }
}

/// <summary>网页托管内容操作维度（受角色门控）。</summary>
public enum WebHostingAction
{
    /// <summary>读取/打开站点（列表、详情）</summary>
    Read,

    /// <summary>编辑元信息 / 重新上传内容</summary>
    Edit,

    /// <summary>删除站点</summary>
    Delete,

    /// <summary>创建对外分享链接</summary>
    CreateShare,

    /// <summary>管理成员的网页托管角色</summary>
    ManageRoles,
}

/// <summary>
/// 网页托管角色 → 操作的纯策略判定（无 DB、无 IO，可在 CI 单测全覆盖）。
/// DB 层只负责「能看到哪些站点」(HostedSiteService.OwnerOrMemberFilter 的隔离铁律)，
/// 本类只负责「在可见站点上能做什么」。两者职责不重叠。
/// </summary>
public static class WebHostingPermission
{
    private static int Rank(string? role) => role switch
    {
        WebHostingRoles.Owner => 3,
        WebHostingRoles.Editor => 2,
        WebHostingRoles.Viewer => 1,
        _ => 0, // null / 非法 = 完全不可访问
    };

    /// <summary>跨多个已共享团队取最宽松的角色（同一站点可能共享给我所在的多个团队）。</summary>
    public static string? Max(string? a, string? b) => Rank(a) >= Rank(b) ? a : b;

    /// <summary>
    /// 纯函数解析用户对单个站点的有效角色，null = 完全不可访问。
    /// isSiteOwner（站点创建者）一律 owner；否则在「站点已共享团队」与「我所在团队角色映射」
    /// 的交集里取最宽松角色；无交集则 null。隔离铁律与角色门控的纯计算核心，可在 CI 全覆盖。
    /// </summary>
    public static string? ResolveSiteRole(
        bool isSiteOwner, IEnumerable<string>? sharedTeamIds, IReadOnlyDictionary<string, string> myTeamRoles)
    {
        if (isSiteOwner) return WebHostingRoles.Owner;
        if (sharedTeamIds == null) return null;
        string? best = null;
        foreach (var tid in sharedTeamIds)
            if (tid != null && myTeamRoles.TryGetValue(tid, out var r))
                best = Max(best, r);
        return best;
    }

    /// <summary>
    /// 判定某有效角色能否执行某操作。
    /// isSiteOwner 表示「当前用户就是站点创建者(OwnerUserId)」——创建者一律按 owner 处理，
    /// 调用方应在解析角色时就把站点创建者解析为 Owner，故此参数主要用于语义自证。
    /// </summary>
    public static bool Can(string? role, WebHostingAction action, bool isSiteOwner)
    {
        if (isSiteOwner) return true; // 站点创建者对自己的站点拥有完全控制
        if (!WebHostingRoles.IsValid(role)) return false; // 非成员 / 未解析出角色 = 一律拒绝

        return action switch
        {
            WebHostingAction.Read => true,
            WebHostingAction.Edit => role is WebHostingRoles.Owner or WebHostingRoles.Editor,
            WebHostingAction.CreateShare => role is WebHostingRoles.Owner or WebHostingRoles.Editor,
            // 删除只给文件夹所有者；editor 不能删别人创建的站点（站点创建者本人走 isSiteOwner 短路）
            WebHostingAction.Delete => role == WebHostingRoles.Owner,
            WebHostingAction.ManageRoles => role == WebHostingRoles.Owner,
            _ => false,
        };
    }
}
