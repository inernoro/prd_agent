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
    public const int RequirementWorkflowRevision = 8;

    /// <summary>递增后 EnsureDefaultWorkflowsSeededAsync 会覆盖默认功能流程定义。</summary>
    public const int FeatureWorkflowRevision = 2;

    /// <summary>递增后 EnsureDefaultWorkflowsSeededAsync 会覆盖默认缺陷流程定义。</summary>
    public const int DefectWorkflowRevision = 2;

    public static ProductWorkflowDefinition Requirement() => new()
    {
        Id = RequirementDefId,
        Name = RequirementWorkflowCatalog.WorkflowName,
        Description = "MAP 内置米多需求收集工作流（7 状态 + 转为缺陷 + 流转矩阵，可在设置中自定义）",
        EntityType = ProductEntityType.Requirement,
        IsDefault = true,
        ProductId = null,
        States = BuildSharedLifecycleStates(includeToDefect: true, includeDelisted: false, includeToRequirement: false),
        Transitions = BuildRequirementTransitions(),
    };

    private static List<ProductWorkflowState> BuildSharedLifecycleStates(
        bool includeToDefect,
        bool includeDelisted,
        bool includeToRequirement)
    {
        var states = new List<ProductWorkflowState>
        {
            new() { Key = RequirementWorkflowCatalog.New, Label = "待评审", Description = RequirementWorkflowCatalog.StateDescriptions[RequirementWorkflowCatalog.New], Color = "#9ca3af", IsInitial = true, Category = "todo", SortOrder = 0, SlaHours = 48 },
            new() { Key = RequirementWorkflowCatalog.Planning, Label = "待规划", Description = RequirementWorkflowCatalog.StateDescriptions[RequirementWorkflowCatalog.Planning], Color = "#38bdf8", Category = "todo", SortOrder = 1, SlaHours = 48 },
            new() { Key = RequirementWorkflowCatalog.Approved, Label = "已立项", Description = RequirementWorkflowCatalog.StateDescriptions[RequirementWorkflowCatalog.Approved], Color = "#60a5fa", Category = "todo", SortOrder = 2 },
            new() { Key = RequirementWorkflowCatalog.Developing, Label = "开发中", Description = RequirementWorkflowCatalog.StateDescriptions[RequirementWorkflowCatalog.Developing], Color = "#f59e0b", Category = "doing", SortOrder = 3, SlaHours = 72, WipLimit = 8 },
            new() { Key = RequirementWorkflowCatalog.Released, Label = "已上线", Description = RequirementWorkflowCatalog.StateDescriptions[RequirementWorkflowCatalog.Released], Color = "#22c55e", IsFinal = true, Category = "done", SortOrder = 4 },
            new() { Key = RequirementWorkflowCatalog.Rejected, Label = "已拒绝", Description = RequirementWorkflowCatalog.StateDescriptions[RequirementWorkflowCatalog.Rejected], Color = "#ef4444", IsFinal = true, Category = "done", SortOrder = 5 },
            new() { Key = RequirementWorkflowCatalog.Scheduled, Label = "已排期", Description = RequirementWorkflowCatalog.StateDescriptions[RequirementWorkflowCatalog.Scheduled], Color = "#a78bfa", Category = "todo", SortOrder = 6 },
        };
        if (includeToDefect)
        {
            states.Add(new()
            {
                Key = RequirementWorkflowCatalog.ToDefect,
                Label = "转为缺陷",
                Description = RequirementWorkflowCatalog.StateDescriptions[RequirementWorkflowCatalog.ToDefect],
                Color = "#f97316",
                IsFinal = true,
                Category = "done",
                SortOrder = 7,
            });
        }
        if (includeDelisted)
        {
            states.Add(new()
            {
                Key = FeatureWorkflowCatalog.Delisted,
                Label = "已下架",
                Description = FeatureWorkflowCatalog.StateDescriptions[FeatureWorkflowCatalog.Delisted],
                Color = "#ef4444",
                IsFinal = true,
                Category = "done",
                SortOrder = 7,
            });
        }
        if (includeToRequirement)
        {
            states.Add(new()
            {
                Key = DefectWorkflowCatalog.ToRequirement,
                Label = ProductDefectLinkageCatalog.NonProductDefect,
                Description = DefectWorkflowCatalog.StateDescriptions[DefectWorkflowCatalog.ToRequirement],
                Color = "#f97316",
                IsFinal = true,
                Category = "done",
                SortOrder = 7,
            });
        }
        return states;
    }

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
                    RequireComment = toKey is RequirementWorkflowCatalog.Rejected or RequirementWorkflowCatalog.ToDefect,
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
        if (edge.ToState == RequirementWorkflowCatalog.ToDefect)
        {
            edge.LinkEntityType = ProductEntityType.Defect;
        }
    }

    public static ProductWorkflowDefinition Feature() => new()
    {
        Id = FeatureDefId,
        Name = FeatureWorkflowCatalog.WorkflowName,
        Description = "与需求同名的 7 状态 + 已下架（仅能从已上线下架，可重新打开）",
        EntityType = ProductEntityType.Feature,
        IsDefault = true,
        ProductId = null,
        States = BuildSharedLifecycleStates(includeToDefect: false, includeDelisted: true, includeToRequirement: false),
        Transitions = BuildFeatureTransitions(),
    };

    private static List<ProductWorkflowTransition> BuildFeatureTransitions()
    {
        var list = new List<ProductWorkflowTransition>();
        foreach (var (fromKey, toKeys) in FeatureWorkflowCatalog.TransitionMatrix)
        {
            foreach (var toKey in toKeys)
            {
                var edge = new ProductWorkflowTransition
                {
                    Key = $"{fromKey}-to-{toKey}",
                    Label = FeatureWorkflowCatalog.BuildTransitionActionLabel(toKey),
                    FromState = fromKey,
                    ToState = toKey,
                    RequireComment = toKey is RequirementWorkflowCatalog.Rejected or FeatureWorkflowCatalog.Delisted,
                    AutoAssignToActor = toKey == RequirementWorkflowCatalog.Developing,
                };
                if (toKey == RequirementWorkflowCatalog.Released)
                {
                    edge.AllowedRoles = new()
                    {
                        ProductWorkflowTransitionRoles.ProductAdmin,
                        ProductWorkflowTransitionRoles.Owner,
                    };
                }
                if (toKey == RequirementWorkflowCatalog.Scheduled)
                {
                    edge.RequiredFieldKeys = new() { ProductWorkflowTransitionFieldKeys.VersionIds };
                }
                list.Add(edge);
            }
        }
        return list;
    }

    public static ProductWorkflowDefinition Defect() => new()
    {
        Id = DefectDefId,
        Name = DefectWorkflowCatalog.WorkflowName,
        Description = "与需求同名的 7 状态 + 非产品缺陷（转需求），可在应用配置中自定义",
        EntityType = ProductEntityType.Defect,
        IsDefault = true,
        ProductId = null,
        States = BuildSharedLifecycleStates(includeToDefect: false, includeDelisted: false, includeToRequirement: true),
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
                    RequireComment = toKey is RequirementWorkflowCatalog.Rejected or DefectWorkflowCatalog.ToRequirement,
                    AutoAssignToActor = toKey == RequirementWorkflowCatalog.Developing,
                };
                if (toKey == DefectWorkflowCatalog.ToRequirement)
                    edge.LinkEntityType = ProductEntityType.Requirement;
                list.Add(edge);
            }
        }
        return list;
    }

    public static ProductWorkflowDefinition[] All() => new[] { Requirement(), Feature(), Defect() };
}
