namespace PrdAgent.Core.Models;

/// <summary>
/// 产品管理智能体 — 内置默认工作流（让"流程流转"开箱即用）。
///
/// 需求流程对齐 TAPD「米多需求收集工作流」：状态 Key 与流转矩阵见 TapdRequirementWorkflow。
/// 首次访问时 upsert 到 product_workflow_definitions（固定 Id，幂等）。
/// </summary>
public static class ProductWorkflowDefaults
{
    public const string RequirementDefId = "wf-default-requirement";
    public const string FeatureDefId = "wf-default-feature";

    /// <summary>递增后 EnsureDefaultWorkflowsSeededAsync 会覆盖默认需求流程定义。</summary>
    public const int RequirementWorkflowRevision = 4;

    public static ProductWorkflowDefinition Requirement() => new()
    {
        Id = RequirementDefId,
        Name = TapdRequirementWorkflow.WorkflowName,
        Description = "对齐 TAPD 米多需求收集工作流（应用设置 workitem_type/config?tab=workflow）",
        EntityType = ProductEntityType.Requirement,
        IsDefault = true,
        ProductId = null,
        States = new()
        {
            new() { Key = TapdRequirementWorkflow.New, Label = "待评审", Color = "#9ca3af", IsInitial = true, Category = "todo", SortOrder = 0, SlaHours = 48 },
            new() { Key = TapdRequirementWorkflow.Planning, Label = "待规划", Color = "#38bdf8", Category = "todo", SortOrder = 1, SlaHours = 48 },
            new() { Key = TapdRequirementWorkflow.Approved, Label = "已立项", Color = "#60a5fa", Category = "todo", SortOrder = 2 },
            new() { Key = TapdRequirementWorkflow.Developing, Label = "开发中", Color = "#f59e0b", Category = "doing", SortOrder = 3, SlaHours = 72, WipLimit = 8 },
            new() { Key = TapdRequirementWorkflow.Released, Label = "已上线", Color = "#22c55e", IsFinal = true, Category = "done", SortOrder = 4 },
            new() { Key = TapdRequirementWorkflow.Rejected, Label = "已拒绝", Color = "#ef4444", IsFinal = true, Category = "done", SortOrder = 5 },
            new() { Key = TapdRequirementWorkflow.Scheduled, Label = "已排期", Color = "#a78bfa", Category = "todo", SortOrder = 6 },
        },
        Transitions = BuildTapdRequirementTransitions(),
    };

    private static List<ProductWorkflowTransition> BuildTapdRequirementTransitions()
    {
        var list = new List<ProductWorkflowTransition>();
        foreach (var (fromKey, toKeys) in TapdRequirementWorkflow.TransitionMatrix)
        {
            foreach (var toKey in toKeys)
            {
                list.Add(new ProductWorkflowTransition
                {
                    Key = $"{fromKey}-to-{toKey}",
                    Label = TapdRequirementWorkflow.BuildTransitionActionLabel(toKey),
                    FromState = fromKey,
                    ToState = toKey,
                    RequireComment = toKey == TapdRequirementWorkflow.Rejected,
                    AutoAssignToActor = toKey == TapdRequirementWorkflow.Developing,
                });
            }
        }
        return list;
    }

    public static ProductWorkflowDefinition Feature() => new()
    {
        Id = FeatureDefId,
        Name = "标准功能流程",
        Description = "规划中 → 开发中 → 测试中 → 已发布 / 已取消",
        EntityType = ProductEntityType.Feature,
        IsDefault = true,
        ProductId = null,
        States = new()
        {
            new() { Key = "planned",    Label = "规划中", Color = "#9ca3af", IsInitial = true, Category = "todo",  SortOrder = 0 },
            new() { Key = "developing", Label = "开发中", Color = "#f59e0b", Category = "doing", SortOrder = 1, SlaHours = 120, WipLimit = 3 },
            new() { Key = "testing",    Label = "测试中", Color = "#a78bfa", Category = "doing", SortOrder = 2, SlaHours = 48 },
            new() { Key = "released",   Label = "已发布", Color = "#22c55e", IsFinal = true, Category = "done", SortOrder = 3 },
            new() { Key = "cancelled",  Label = "已取消", Color = "#ef4444", IsFinal = true, Category = "done", SortOrder = 4 },
        },
        Transitions = new()
        {
            new() { Key = "start-dev", Label = "开始开发", FromState = "planned",    ToState = "developing", AutoAssignToActor = true },
            new() { Key = "to-test",   Label = "提交测试", FromState = "developing", ToState = "testing" },
            new() { Key = "release",   Label = "发布",     FromState = "testing",    ToState = "released" },
            new() { Key = "cancel",    Label = "取消",     FromState = null,         ToState = "cancelled", RequireComment = true },
            new() { Key = "reopen",    Label = "重新打开", FromState = null,         ToState = "planned" },
        },
    };

    public static ProductWorkflowDefinition[] All() => new[] { Requirement(), Feature() };
}
