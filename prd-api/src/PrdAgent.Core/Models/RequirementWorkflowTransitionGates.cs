namespace PrdAgent.Core.Models;

/// <summary>
/// 需求工作流「已立项 / 已排期 / 已上线」与 MAP 立项单、上线单、归属版本的闸门（Wave 4）。
/// 纯逻辑供单元测试；Controller 查库后传入布尔结果。
/// </summary>
public static class RequirementWorkflowTransitionGates
{
    public static bool IsStateGatedTarget(string? toState)
        => toState is RequirementWorkflowCatalog.Approved
            or RequirementWorkflowCatalog.Scheduled
            or RequirementWorkflowCatalog.Released;

    public static string? ValidateApprovedGate(
        bool alreadyInApprovedInitiation,
        string? initiationId,
        bool initiationValid)
    {
        if (alreadyInApprovedInitiation || initiationValid) return null;
        if (!string.IsNullOrWhiteSpace(initiationId))
            return "所选立项未通过、未取得立项号，或未包含本需求";
        return "流转到已立项前，需关联已通过并取得立项号的立项单";
    }

    public static string? ValidateScheduledGate(IReadOnlyList<string>? versionIds)
    {
        if (versionIds != null && versionIds.Count > 0) return null;
        return "流转到已排期前，需至少关联一个归属版本";
    }

    public static string? ValidateReleasedGate(
        bool alreadyInCompletedRelease,
        string? releaseId,
        bool releaseValid)
    {
        if (alreadyInCompletedRelease || releaseValid) return null;
        if (!string.IsNullOrWhiteSpace(releaseId))
            return "所选上线单未完成上线，或未包含本需求";
        return "流转到已上线前，需关联已完成上线的上线单";
    }

    public static string? ValidateStateGate(
        string toState,
        IReadOnlyList<string>? versionIds,
        bool alreadyInApprovedInitiation,
        string? initiationId,
        bool initiationValid,
        bool alreadyInCompletedRelease,
        string? releaseId,
        bool releaseValid)
    {
        if (toState == RequirementWorkflowCatalog.Approved)
            return ValidateApprovedGate(alreadyInApprovedInitiation, initiationId, initiationValid);
        if (toState == RequirementWorkflowCatalog.Scheduled)
            return ValidateScheduledGate(versionIds);
        if (toState == RequirementWorkflowCatalog.Released)
            return ValidateReleasedGate(alreadyInCompletedRelease, releaseId, releaseValid);
        return null;
    }
}
