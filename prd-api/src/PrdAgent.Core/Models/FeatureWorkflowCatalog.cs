namespace PrdAgent.Core.Models;

/// <summary>
/// MAP 内置「标准功能流程」目录：7 个需求同名状态 + 已下架；种子与状态说明 SSOT。
/// </summary>
public static class FeatureWorkflowCatalog
{
    public const string WorkflowName = "标准功能流程";

    /// <summary>终态 Key 沿用 cancelled，展示名为「已下架」；仅能从已上线流转进入。</summary>
    public const string Delisted = "cancelled";

    public static readonly IReadOnlyDictionary<string, string> StateLabels = BuildStateLabels();

    public static readonly IReadOnlyDictionary<string, string> StateDescriptions = BuildStateDescriptions();

    /// <summary>旧功能流程状态 → 当前内置 Key。</summary>
    public static readonly IReadOnlyDictionary<string, string> LegacyStateMap = new Dictionary<string, string>
    {
        ["planned"] = RequirementWorkflowCatalog.New,
        ["testing"] = RequirementWorkflowCatalog.Developing,
        ["released"] = RequirementWorkflowCatalog.Released,
        ["cancelled"] = Delisted,
    };

    public static readonly IReadOnlyDictionary<string, string[]> TransitionMatrix = BuildTransitionMatrix();

    public const int ExpectedTransitionCount = 36;

    private static Dictionary<string, string> BuildStateLabels()
    {
        var labels = new Dictionary<string, string>(RequirementWorkflowCatalog.StateLabels
            .Where(p => p.Key != RequirementWorkflowCatalog.ToDefect));
        labels[Delisted] = "已下架";
        return labels;
    }

    private static Dictionary<string, string> BuildStateDescriptions()
    {
        var desc = new Dictionary<string, string>(RequirementWorkflowCatalog.StateDescriptions
            .Where(p => p.Key != RequirementWorkflowCatalog.ToDefect));
        desc[Delisted] = "功能在本版本中不再提供，由已上线状态下架（可重新打开回到待规划等状态）";
        return desc;
    }

    private static Dictionary<string, string[]> BuildTransitionMatrix()
    {
        var matrix = RequirementWorkflowCatalog.TransitionMatrix
            .Where(p => p.Key != RequirementWorkflowCatalog.ToDefect)
            .ToDictionary(p => p.Key, p => p.Value.Where(t => t != RequirementWorkflowCatalog.ToDefect).ToArray());

        var releasedTos = matrix[RequirementWorkflowCatalog.Released].ToList();
        if (!releasedTos.Contains(Delisted)) releasedTos.Add(Delisted);
        matrix[RequirementWorkflowCatalog.Released] = releasedTos.ToArray();

        matrix[Delisted] = new[]
        {
            RequirementWorkflowCatalog.New,
            RequirementWorkflowCatalog.Planning,
            RequirementWorkflowCatalog.Approved,
            RequirementWorkflowCatalog.Developing,
            RequirementWorkflowCatalog.Scheduled,
        };
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

        return RequirementWorkflowCatalog.NormalizeStateKey(key, workflowDef);
    }

    public static string ResolveStateLabel(string? stateKey, ProductWorkflowDefinition? workflowDef = null)
    {
        if (string.IsNullOrWhiteSpace(stateKey)) return "未设置";
        var key = NormalizeStateKey(stateKey, workflowDef);
        if (workflowDef != null)
        {
            var fromDef = workflowDef.States.FirstOrDefault(s => s.Key == key)?.Label;
            if (!string.IsNullOrEmpty(fromDef)) return fromDef;
        }
        return StateLabels.TryGetValue(key, out var label) ? label : key;
    }

    public static string BuildTransitionActionLabel(string toStateKey, ProductWorkflowDefinition? workflowDef = null)
    {
        var key = NormalizeStateKey(toStateKey, workflowDef);
        if (key == Delisted) return "下架";
        return RequirementWorkflowCatalog.BuildTransitionActionLabel(key, workflowDef);
    }
}
