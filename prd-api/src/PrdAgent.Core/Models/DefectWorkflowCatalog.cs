namespace PrdAgent.Core.Models;

/// <summary>
/// 产品管理智能体 — 缺陷工作流：与需求同名的 7 状态 + 「非产品缺陷」（转需求）。
/// </summary>
public static class DefectWorkflowCatalog
{
    public const string WorkflowName = "标准缺陷流程";

    /// <summary>终态：非产品缺陷，联动创建需求记录。</summary>
    public const string ToRequirement = "to_requirement";

    public static readonly IReadOnlyDictionary<string, string> StateLabels = BuildStateLabels();

    public static readonly IReadOnlyDictionary<string, string> StateDescriptions = BuildStateDescriptions();

    /// <summary>旧缺陷流程 / 缺陷智能体状态 → 产品缺陷工作流 Key。</summary>
    public static readonly IReadOnlyDictionary<string, string> LegacyStateMap = new Dictionary<string, string>
    {
        [DefectStatus.Draft] = RequirementWorkflowCatalog.New,
        [DefectStatus.Reviewing] = RequirementWorkflowCatalog.New,
        [DefectStatus.Awaiting] = RequirementWorkflowCatalog.New,
        [DefectStatus.Submitted] = RequirementWorkflowCatalog.New,
        [DefectStatus.Assigned] = RequirementWorkflowCatalog.Planning,
        [DefectStatus.Processing] = RequirementWorkflowCatalog.Developing,
        [DefectStatus.Verifying] = RequirementWorkflowCatalog.Developing,
        [DefectStatus.Resolved] = RequirementWorkflowCatalog.Released,
        [DefectStatus.Rejected] = RequirementWorkflowCatalog.Rejected,
        [DefectStatus.Closed] = RequirementWorkflowCatalog.Rejected,
    };

    public static readonly IReadOnlyDictionary<string, string[]> TransitionMatrix = BuildTransitionMatrix();

    public const int ExpectedTransitionCount = 37;

    private static Dictionary<string, string> BuildStateLabels()
    {
        var labels = new Dictionary<string, string>(RequirementWorkflowCatalog.StateLabels
            .Where(p => p.Key != RequirementWorkflowCatalog.ToDefect));
        labels[ToRequirement] = ProductDefectLinkageCatalog.NonProductDefect;
        return labels;
    }

    private static Dictionary<string, string> BuildStateDescriptions()
    {
        var desc = new Dictionary<string, string>(RequirementWorkflowCatalog.StateDescriptions
            .Where(p => p.Key != RequirementWorkflowCatalog.ToDefect));
        desc[ToRequirement] = "经确认非产品缺陷，缺陷记录转回需求池跟进";
        return desc;
    }

    private static Dictionary<string, string[]> BuildTransitionMatrix()
    {
        var matrix = RequirementWorkflowCatalog.TransitionMatrix
            .Where(p => p.Key != RequirementWorkflowCatalog.ToDefect)
            .ToDictionary(p => p.Key, p => p.Value.Where(t => t != RequirementWorkflowCatalog.ToDefect).ToArray());

        foreach (var from in RequirementWorkflowCatalog.ToDefectSourceStates)
        {
            var tos = matrix[from].ToList();
            if (!tos.Contains(ToRequirement)) tos.Add(ToRequirement);
            matrix[from] = tos.ToArray();
        }
        return matrix;
    }

    public static string NormalizeStateKey(string? stateKey, ProductWorkflowDefinition? workflowDef = null)
    {
        if (string.IsNullOrWhiteSpace(stateKey))
            return workflowDef?.GetInitialStateKey() ?? RequirementWorkflowCatalog.New;

        var key = stateKey.Trim();
        if (LegacyStateMap.TryGetValue(key, out var legacyMapped))
            key = legacyMapped;

        if (workflowDef?.States.Any(s => s.Key == key) == true)
            return key;

        if (StateLabels.ContainsKey(key))
            return key;

        return key;
    }

    public static string BuildTransitionActionLabel(string toStateKey, ProductWorkflowDefinition? workflowDef = null)
    {
        var key = NormalizeStateKey(toStateKey, workflowDef);
        if (key == ToRequirement) return "转需求";
        return RequirementWorkflowCatalog.BuildTransitionActionLabel(key, workflowDef);
    }

    public static string ResolveStateLabel(string? stateKey, ProductWorkflowDefinition? workflowDef = null)
    {
        if (string.IsNullOrWhiteSpace(stateKey)) return "未设置";
        var key = NormalizeStateKey(stateKey, workflowDef);
        if (workflowDef != null)
        {
            var hit = workflowDef.States.FirstOrDefault(s => s.Key == key);
            if (hit != null && !string.IsNullOrWhiteSpace(hit.Label)) return hit.Label;
        }
        return StateLabels.TryGetValue(key, out var label) ? label : key;
    }
}
