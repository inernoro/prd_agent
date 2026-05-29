using PrdAgent.Core.Attributes;

namespace PrdAgent.Core.Models;

/// <summary>
/// 团队 — 跨应用的协作单位（网页托管 + 知识库共用同一批团队和成员）。
///
/// 团队实体本身不绑定任何应用：它只是「一组人」。
/// 「分享到团队」的关联存在各应用的内容实体上（HostedSite.SharedTeamIds /
/// DocumentStore.SharedTeamIds），因此同一个团队在两个模块自然浮现不同内容，
/// 隔离是结构性的，不存在任何「两个模块都读」的共享内容表。
/// </summary>
[AppOwnership(AppNames.System, AppNames.SystemDisplay, IsPrimary = true)]
public class Team
{
    /// <summary>主键（Guid）</summary>
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>团队名称</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>团队描述</summary>
    public string? Description { get; set; }

    /// <summary>创建者 UserId（创建者默认管理员）</summary>
    public string OwnerUserId { get; set; } = string.Empty;

    /// <summary>创建者名称（冗余，便于展示）</summary>
    public string? OwnerName { get; set; }

    /// <summary>
    /// 可见性：
    /// - private: 内容仅团队成员可见（默认，且限本应用内）
    /// - public: 团队内容对本应用所有登录用户只读可见（二期扩展，字段先留好）
    /// </summary>
    public string Visibility { get; set; } = TeamVisibility.Private;

    /// <summary>邀请码（凭码加入）</summary>
    public string InviteCode { get; set; } = GenerateInviteCode();

    /// <summary>邀请码过期时间（null 表示永不过期）</summary>
    public DateTime? InviteExpireAt { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    private static string GenerateInviteCode()
    {
        return $"INV-{Guid.NewGuid().ToString("N")[..8].ToUpper()}";
    }
}

/// <summary>
/// 团队成员
/// </summary>
[AppOwnership(AppNames.System, AppNames.SystemDisplay)]
public class TeamMember
{
    /// <summary>主键（Guid）</summary>
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>所属团队 ID</summary>
    public string TeamId { get; set; } = string.Empty;

    /// <summary>用户 ID</summary>
    public string UserId { get; set; } = string.Empty;

    /// <summary>用户名称（冗余，便于展示）</summary>
    public string? UserName { get; set; }

    /// <summary>用户头像文件名（冗余，卡片直接渲染头像免查）</summary>
    public string? AvatarFileName { get; set; }

    /// <summary>角色：admin / member（admin 可管理团队；知识库仍按决策 10 全员平等编辑）</summary>
    public string Role { get; set; } = TeamRole.Member;

    /// <summary>
    /// 网页托管内容角色：owner / editor / viewer（仅网页托管模块消费此字段，知识库不读）。
    /// null = 继承团队角色（admin → owner，member → editor），保证已有成员迁移时不被意外降权，
    /// 维持决策 10「成员可编辑」的既有能力；只有显式设为 viewer 才会被限制为只读。
    /// 解析逻辑见 PrdAgent.Core.Security.WebHostingRoles.Resolve。
    /// </summary>
    public string? WebHostingRole { get; set; }

    /// <summary>加入时间</summary>
    public DateTime JoinedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>
/// 团队活动日志 — 谁在什么时候对什么做了什么（可观察原则）。
/// actor 信息做快照，便于免 join 直接渲染时间线。
/// </summary>
[AppOwnership(AppNames.System, AppNames.SystemDisplay)]
public class TeamActivityLog
{
    /// <summary>主键（Guid）</summary>
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>所属团队 ID</summary>
    public string TeamId { get; set; } = string.Empty;

    /// <summary>发生在哪个应用：web-hosting / document-store / team</summary>
    public string AppKey { get; set; } = string.Empty;

    /// <summary>操作者 UserId</summary>
    public string ActorUserId { get; set; } = string.Empty;

    /// <summary>操作者显示名快照</summary>
    public string ActorName { get; set; } = string.Empty;

    /// <summary>操作者头像文件名快照</summary>
    public string? ActorAvatarFileName { get; set; }

    /// <summary>动作类型（见 TeamActivityAction）</summary>
    public string Action { get; set; } = string.Empty;

    /// <summary>目标类型：site / store / entry / member / team</summary>
    public string TargetType { get; set; } = string.Empty;

    /// <summary>目标 ID</summary>
    public string? TargetId { get; set; }

    /// <summary>目标标题快照（目标可能被改名/删除，存当时的快照）</summary>
    public string? TargetTitle { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>团队角色常量</summary>
public static class TeamRole
{
    /// <summary>管理员（可管理团队：改名、增删成员、升降级、删团队）</summary>
    public const string Admin = "admin";

    /// <summary>普通成员（内容协作权限与管理员平等，但不可管理团队）</summary>
    public const string Member = "member";

    public static readonly string[] All = { Admin, Member };
}

/// <summary>团队可见性常量</summary>
public static class TeamVisibility
{
    /// <summary>私有：内容仅团队成员可见（默认）</summary>
    public const string Private = "private";

    /// <summary>公开：团队内容对本应用所有登录用户只读可见（二期）</summary>
    public const string Public = "public";

    public static readonly string[] All = { Private, Public };
}

/// <summary>团队活动日志动作常量</summary>
public static class TeamActivityAction
{
    public const string TeamCreated = "team.created";
    public const string TeamUpdated = "team.updated";
    public const string MemberAdded = "member.added";
    public const string MemberJoined = "member.joined";
    public const string MemberRemoved = "member.removed";
    public const string MemberRoleChanged = "member.role_changed";
    public const string SiteShared = "site.shared";
    public const string SiteUpdated = "site.updated";
    public const string SiteDeleted = "site.deleted";
    public const string StoreShared = "store.shared";
    public const string EntryCreated = "entry.created";
    public const string EntryUpdated = "entry.updated";
    public const string EntryDeleted = "entry.deleted";
}

/// <summary>团队 AppKey 常量（活动日志的应用维度）</summary>
public static class TeamAppKey
{
    public const string WebHosting = "web-hosting";
    public const string DocumentStore = "document-store";
    public const string Team = "team";
}
