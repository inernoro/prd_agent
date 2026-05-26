using PrdAgent.Core.Attributes;

namespace PrdAgent.Core.Models;

/// <summary>
/// 托管站点访问事件 —— 记录「哪个登录用户在什么时候看了哪个站点」，用于：
/// (1) 站点 owner 查看本页访客痕迹（防文档泄密）；(2) 高级权限跨用户审计。
/// 与 ShareViewLog 区别：ShareViewLog 只覆盖「分享链接」访问；本事件覆盖
/// 应用内「直接 / 团队」访问（登录用户打开站点详情或访问入口时记录）。
/// actor 信息做快照，免 join 直接渲染。允许同一用户重复记录（统计访问频次）。
/// </summary>
[AppOwnership(AppNames.System, AppNames.SystemDisplay)]
public class SiteViewEvent
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>被访问的站点 ID</summary>
    public string SiteId { get; set; } = string.Empty;

    /// <summary>站点所属 owner UserId（冗余，便于 owner 维度审计查询）</summary>
    public string SiteOwnerUserId { get; set; } = string.Empty;

    /// <summary>站点标题快照（站点可能改名/删除）</summary>
    public string? SiteTitle { get; set; }

    /// <summary>访问者 UserId（应用内访问必有；匿名为 null）</summary>
    public string? ViewerUserId { get; set; }

    /// <summary>访问者显示名快照</summary>
    public string? ViewerName { get; set; }

    /// <summary>访问者头像文件名快照</summary>
    public string? ViewerAvatarFileName { get; set; }

    /// <summary>访问时间（UTC）</summary>
    public DateTime ViewedAt { get; set; } = DateTime.UtcNow;

    /// <summary>IP 地址（可选）</summary>
    public string? IpAddress { get; set; }

    /// <summary>User-Agent（可选）</summary>
    public string? UserAgent { get; set; }
}
