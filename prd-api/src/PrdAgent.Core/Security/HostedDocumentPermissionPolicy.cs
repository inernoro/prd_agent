using PrdAgent.Core.Models;

namespace PrdAgent.Core.Security;

/// <summary>页面权限比较；分享凭证独立，不通过关系复制。</summary>
public static class HostedDocumentPermissionPolicy
{
    public static bool SamePageAccess(HostedSite source, HostedSite target) =>
        source.OwnerUserId == target.OwnerUserId
        && source.Visibility == target.Visibility
        && source.GroupId == target.GroupId
        && source.SharedTeamIds.ToHashSet(StringComparer.Ordinal).SetEquals(target.SharedTeamIds);

    public static List<string> DescribeChanges(HostedSite source, HostedSite target)
    {
        var result = new List<string>();
        var added = source.SharedTeamIds.Except(target.SharedTeamIds).Count();
        var removed = target.SharedTeamIds.Except(source.SharedTeamIds).Count();
        if (added > 0) result.Add($"新增 {added} 个团队的访问权限");
        if (removed > 0) result.Add($"移除 {removed} 个团队的访问权限");
        if (source.GroupId != target.GroupId) result.Add("同步团队分组及其访问限制");
        if (source.Visibility != target.Visibility)
            result.Add(source.Visibility == "public" ? "开放个人公开页展示" : "关闭个人公开页展示");
        return result;
    }
}
