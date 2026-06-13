namespace PrdAgent.Core.Models;

/// <summary>流转边 AllowedRoles 语义（Controller 与前端 guard 共用）。</summary>
public static class ProductWorkflowTransitionRoles
{
    public const string Owner = "owner";
    public const string Creator = "creator";
    public const string Assignee = "assignee";
    public const string ProductAdmin = "product_admin";
    public const string Member = "member";
}

/// <summary>流转必填字段 Key（Requirement / Feature 通用）。</summary>
public static class ProductWorkflowTransitionFieldKeys
{
    public const string Title = "title";
    public const string AssigneeId = "assigneeId";
    public const string Grade = "grade";
    public const string Comment = "comment";
    public const string VersionIds = "versionIds";
    public const string InitiationId = "initiationId";
    public const string ReleaseId = "releaseId";
}

/// <summary>工作流流转权限与必填字段校验（MAP 原生，不依赖外部系统）。</summary>
public static class ProductWorkflowTransitionGuard
{
    public static HashSet<string> ResolveActorRoles(
        string userId,
        Product product,
        bool isGlobalAdmin,
        string entityOwnerId,
        string? assigneeId)
    {
        var roles = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        if (string.IsNullOrWhiteSpace(userId)) return roles;

        if (!string.IsNullOrWhiteSpace(entityOwnerId) && entityOwnerId == userId)
        {
            roles.Add(ProductWorkflowTransitionRoles.Owner);
            roles.Add(ProductWorkflowTransitionRoles.Creator);
        }

        var effectiveAssignee = string.IsNullOrWhiteSpace(assigneeId) ? entityOwnerId : assigneeId;
        if (!string.IsNullOrWhiteSpace(effectiveAssignee) && effectiveAssignee == userId)
            roles.Add(ProductWorkflowTransitionRoles.Assignee);

        if (isGlobalAdmin || product.IsProductOwner(userId) || product.AdminIds.Contains(userId))
            roles.Add(ProductWorkflowTransitionRoles.ProductAdmin);

        if (product.IsProductOwner(userId) || product.MemberIds.Contains(userId) || product.AdminIds.Contains(userId))
            roles.Add(ProductWorkflowTransitionRoles.Member);

        return roles;
    }

    public static bool CanExecuteTransition(
        string userId,
        ProductWorkflowTransition transition,
        Product product,
        bool isGlobalAdmin,
        string entityOwnerId,
        string? assigneeId)
    {
        var allowed = transition.AllowedRoles;
        if (allowed == null || allowed.Count == 0) return true;
        var actorRoles = ResolveActorRoles(userId, product, isGlobalAdmin, entityOwnerId, assigneeId);
        return allowed.Any(r => actorRoles.Contains(r));
    }

    public static string? ValidateRequiredFields(
        ProductWorkflowTransition transition,
        string? title,
        string? grade,
        string? assigneeId,
        string? comment,
        bool willAutoAssign,
        IReadOnlyList<string>? versionIds = null)
    {
        if (transition.RequireComment && string.IsNullOrWhiteSpace(comment))
            return "该流转需要填写备注";

        var keys = transition.RequiredFieldKeys;
        if (keys == null || keys.Count == 0) return null;

        foreach (var raw in keys)
        {
            var key = raw.Trim();
            if (key.Equals(ProductWorkflowTransitionFieldKeys.Title, StringComparison.OrdinalIgnoreCase))
            {
                if (string.IsNullOrWhiteSpace(title)) return "该流转需要填写标题";
                continue;
            }
            if (key.Equals(ProductWorkflowTransitionFieldKeys.Grade, StringComparison.OrdinalIgnoreCase))
            {
                if (string.IsNullOrWhiteSpace(grade)) return "该流转需要选择分级";
                continue;
            }
            if (key.Equals(ProductWorkflowTransitionFieldKeys.AssigneeId, StringComparison.OrdinalIgnoreCase))
            {
                if (string.IsNullOrWhiteSpace(assigneeId) && !willAutoAssign)
                    return "该流转需要指定处理人";
                continue;
            }
            if (key.Equals(ProductWorkflowTransitionFieldKeys.VersionIds, StringComparison.OrdinalIgnoreCase))
            {
                if (versionIds == null || versionIds.Count == 0) return "该流转需要关联归属版本";
                continue;
            }
            if (key.Equals(ProductWorkflowTransitionFieldKeys.Comment, StringComparison.OrdinalIgnoreCase))
            {
                if (string.IsNullOrWhiteSpace(comment)) return "该流转需要填写备注";
            }
        }

        return null;
    }
}
