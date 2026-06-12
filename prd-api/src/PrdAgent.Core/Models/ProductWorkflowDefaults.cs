namespace PrdAgent.Core.Models;

/// <summary>
/// 产品管理智能体 — 内置默认工作流（让"流程流转"开箱即用）。
///
/// 需求默认流程种子见 <see cref="RequirementWorkflowCatalog"/>；运行时以 MongoDB 流程定义为准。
/// 首次访问时 upsert 到 product_workflow_definitions（固定 Id，幂等）。
/// </summary>
public static class ProductWorkflowDefaults
{
    public const string RequirementDefId = "wf-default-requirement";
    public const string FeatureDefId = "wf-default-feature";
    public const string DefectDefId = "wf-default-defect";

    /// <summary>递增后 EnsureDefaultWorkflowsSeededAsync 会覆盖默认需求流程定义。</summary>
    public const int RequirementWorkflowRevision = 7;

    /// <summary>递增后 EnsureDefaultWorkflowsSeededAsync 会覆盖默认功能流程定义。</summary>
    public const int FeatureWorkflowRevision = 1;

    /// <summary>递增后 EnsureDefaultWorkflowsSeededAsync 会覆盖默认缺陷流程定义。</summary>
    public const int DefectWorkflowRevision = 1;

    public static ProductWorkflowDefinition Requirement() => new()
    {
        Id = RequirementDefId,
        Name = RequirementWorkflowCatalog.WorkflowName,
        Description = "MAP 内置米多需求收集工作流（7 状态 + 流转矩阵，可在设置中自定义）",
        EntityType = ProductEntityType.Requirement,
        IsDefault = true,
        ProductId = null,
        States = new()
        {
            new() { Key = RequirementWorkflowCatalog.New, Label = "待评审", Description = RequirementWorkflowCatalog.StateDescriptions[RequirementWorkflowCatalog.New], Color = "#9ca3af", IsInitial = true, Category = "todo", SortOrder = 0, SlaHours = 48 },
            new() { Key = RequirementWorkflowCatalog.Planning, Label = "待规划", Description = RequirementWorkflowCatalog.StateDescriptions[RequirementWorkflowCatalog.Planning], Color = "#38bdf8", Category = "todo", SortOrder = 1, SlaHours = 48 },
            new() { Key = RequirementWorkflowCatalog.Approved, Label = "已立项", Description = RequirementWorkflowCatalog.StateDescriptions[RequirementWorkflowCatalog.Approved], Color = "#60a5fa", Category = "todo", SortOrder = 2 },
            new() { Key = RequirementWorkflowCatalog.Developing, Label = "开发中", Description = RequirementWorkflowCatalog.StateDescriptions[RequirementWorkflowCatalog.Developing], Color = "#f59e0b", Category = "doing", SortOrder = 3, SlaHours = 72, WipLimit = 8 },
            new() { Key = RequirementWorkflowCatalog.Released, Label = "已上线", Description = RequirementWorkflowCatalog.StateDescriptions[RequirementWorkflowCatalog.Released], Color = "#22c55e", IsFinal = true, Category = "done", SortOrder = 4 },
            new() { Key = RequirementWorkflowCatalog.Rejected, Label = "已拒绝", Description = RequirementWorkflowCatalog.StateDescriptions[RequirementWorkflowCatalog.Rejected], Color = "#ef4444", IsFinal = true, Category = "done", SortOrder = 5 },
            new() { Key = RequirementWorkflowCatalog.Scheduled, Label = "已排期", Description = RequirementWorkflowCatalog.StateDescriptions[RequirementWorkflowCatalog.Scheduled], Color = "#a78bfa", Category = "todo", SortOrder = 6 },
        },
        Transitions = BuildRequirementTransitions(),
    };

    private static List<ProductWorkflowTransition> BuildRequirementTransitions()
    {
        var list = new List<ProductWorkflowTransition>();
        foreach (var (fromKey, toKeys) in RequirementWorkflowCatalog.TransitionMatrix)
        {
            foreach (var toKey in toKeys)
            {
                var edge = new ProductWorkflowTransition
                {
                    Key = $"{fromKey}-to-{toKey}",
                    Label = RequirementWorkflowCatalog.BuildTransitionActionLabel(toKey),
                    FromState = fromKey,
                    ToState = toKey,
                    RequireComment = toKey == RequirementWorkflowCatalog.Rejected,
                    AutoAssignToActor = toKey == RequirementWorkflowCatalog.Developing,
                };
                ApplyRequirementTransitionDefaults(edge);
                list.Add(edge);
            }
        }
        return list;
    }

    private static void ApplyRequirementTransitionDefaults(ProductWorkflowTransition edge)
    {
        if (edge.ToState == RequirementWorkflowCatalog.Released)
        {
            edge.AllowedRoles = new()
            {
                ProductWorkflowTransitionRoles.ProductAdmin,
                ProductWorkflowTransitionRoles.Owner,
            };
        }
        if (edge.ToState == RequirementWorkflowCatalog.Scheduled)
        {
            edge.RequiredFieldKeys = new() { ProductWorkflowTransitionFieldKeys.VersionIds };
        }
        if (edge.ToState == RequirementWorkflowCatalog.Rejected)
        {
            edge.LinkEntityType = ProductEntityType.Defect;
        }
    }

    public static ProductWorkflowDefinition Feature() => new()
    {
        Id = FeatureDefId,
        Name = FeatureWorkflowCatalog.WorkflowName,
        Description = "规划中 → 开发中 → 测试中 → 已发布 / 已下架",
        EntityType = ProductEntityType.Feature,
        IsDefault = true,
        ProductId = null,
        States = new()
        {
            new() { Key = FeatureWorkflowCatalog.Planned, Label = "规划中", Description = FeatureWorkflowCatalog.StateDescriptions[FeatureWorkflowCatalog.Planned], Color = "#9ca3af", IsInitial = true, Category = "todo", SortOrder = 0 },
            new() { Key = FeatureWorkflowCatalog.Developing, Label = "开发中", Description = FeatureWorkflowCatalog.StateDescriptions[FeatureWorkflowCatalog.Developing], Color = "#f59e0b", Category = "doing", SortOrder = 1, SlaHours = 120, WipLimit = 3 },
            new() { Key = FeatureWorkflowCatalog.Testing, Label = "测试中", Description = FeatureWorkflowCatalog.StateDescriptions[FeatureWorkflowCatalog.Testing], Color = "#a78bfa", Category = "doing", SortOrder = 2, SlaHours = 48 },
            new() { Key = FeatureWorkflowCatalog.Released, Label = "已发布", Description = FeatureWorkflowCatalog.StateDescriptions[FeatureWorkflowCatalog.Released], Color = "#22c55e", IsFinal = true, Category = "done", SortOrder = 3 },
            new() { Key = FeatureWorkflowCatalog.Delisted, Label = "已下架", Description = FeatureWorkflowCatalog.StateDescriptions[FeatureWorkflowCatalog.Delisted], Color = "#ef4444", IsFinal = true, Category = "done", SortOrder = 4 },
        },
        Transitions = new()
        {
            new() { Key = "start-dev", Label = "开始开发", FromState = FeatureWorkflowCatalog.Planned, ToState = FeatureWorkflowCatalog.Developing, AutoAssignToActor = true },
            new() { Key = "to-test", Label = "提交测试", FromState = FeatureWorkflowCatalog.Developing, ToState = FeatureWorkflowCatalog.Testing },
            new() { Key = "release", Label = "发布", FromState = FeatureWorkflowCatalog.Testing, ToState = FeatureWorkflowCatalog.Released },
            new() { Key = "delist", Label = "下架", FromState = null, ToState = FeatureWorkflowCatalog.Delisted, RequireComment = true },
            new() { Key = "reopen", Label = "重新打开", FromState = null, ToState = FeatureWorkflowCatalog.Planned },
        },
    };

    public static ProductWorkflowDefinition Defect() => new()
    {
        Id = DefectDefId,
        Name = DefectWorkflowCatalog.WorkflowName,
        Description = "已提交 → 已分配 → 处理中 → 待验收 → 已解决 / 已拒绝 / 已关闭（可在应用配置中自定义）",
        EntityType = ProductEntityType.Defect,
        IsDefault = true,
        ProductId = null,
        States = new()
        {
            new() { Key = DefectStatus.Submitted, Label = "已提交", Color = "#9ca3af", IsInitial = true, Category = "todo", SortOrder = 0, SlaHours = 24 },
            new() { Key = DefectStatus.Assigned, Label = "已分配", Color = "#60a5fa", Category = "todo", SortOrder = 1, SlaHours = 24 },
            new() { Key = DefectStatus.Processing, Label = "处理中", Color = "#f59e0b", Category = "doing", SortOrder = 2, SlaHours = 72, WipLimit = 10 },
            new() { Key = DefectStatus.Verifying, Label = "待验收", Color = "#a78bfa", Category = "doing", SortOrder = 3, SlaHours = 48 },
            new() { Key = DefectStatus.Resolved, Label = "已解决", Color = "#22c55e", IsFinal = true, Category = "done", SortOrder = 4 },
            new() { Key = DefectStatus.Rejected, Label = "已拒绝", Color = "#ef4444", IsFinal = true, Category = "done", SortOrder = 5 },
            new() { Key = DefectStatus.Closed, Label = "已关闭", Color = "#6b7280", IsFinal = true, Category = "done", SortOrder = 6 },
        },
        Transitions = BuildDefectTransitions(),
    };

    private static List<ProductWorkflowTransition> BuildDefectTransitions()
    {
        var list = new List<ProductWorkflowTransition>();
        foreach (var (fromKey, toKeys) in DefectWorkflowCatalog.TransitionMatrix)
        {
            foreach (var toKey in toKeys)
            {
                var edge = new ProductWorkflowTransition
                {
                    Key = $"{fromKey}-to-{toKey}",
                    Label = DefectWorkflowCatalog.BuildTransitionActionLabel(toKey),
                    FromState = fromKey,
                    ToState = toKey,
                    RequireComment = toKey == DefectStatus.Rejected,
                    AutoAssignToActor = toKey == DefectStatus.Processing,
                };
                if (toKey == DefectStatus.Rejected)
                    edge.LinkEntityType = ProductEntityType.Requirement;
                list.Add(edge);
            }
        }
        return list;
    }

    public static ProductWorkflowDefinition[] All() => new[] { Requirement(), Feature(), Defect() };
}
