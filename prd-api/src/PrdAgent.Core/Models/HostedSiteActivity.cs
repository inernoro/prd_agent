using System.Linq.Expressions;

namespace PrdAgent.Core.Models;

/// <summary>列表响应中的活动摘要，不入库；只为当前已获授权的站点生成。</summary>
public class HostedSiteActivity
{
    public long EditCount { get; set; }
    public bool IsNew { get; set; }
}

public static class HostedSiteActivityPolicy
{
    // 基线是原始内容，不算编辑；失败、草稿和正在发布的版本也不算成功编辑。
    public static Expression<Func<HostedSiteRevision, bool>> PublishedEdit => revision =>
        revision.Status == HostedSiteRevisionStatuses.Published && revision.PublishedAt != null &&
        (revision.Source == HostedSiteRevisionSources.AiEdit || revision.Source == HostedSiteRevisionSources.Rollback);

    public static bool IsNew(DateTime createdAt, bool hasOpened, DateTime now) =>
        !hasOpened && createdAt <= now && createdAt >= now.AddDays(-7);
}
