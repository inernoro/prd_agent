namespace PrdAgent.Core.Models;

/// <summary>
/// TAPD「米多需求收集工作流」与 MAP 需求状态的对齐约定。
/// 状态 Key 与 TAPD 工作流内部 step 一致，便于导入与双系统对照。
/// </summary>
public static class TapdRequirementWorkflow
{
    public const string WorkflowName = "米多需求收集工作流";

    public const string New = "new";
    public const string Planning = "planning";
    public const string Approved = "status_2";
    public const string Developing = "developing";
    public const string Released = "resolved";
    public const string Rejected = "rejected";
    public const string Scheduled = "status_3";

    public static readonly IReadOnlyDictionary<string, string> StateLabels = new Dictionary<string, string>
    {
        [New] = "待评审",
        [Planning] = "待规划",
        [Approved] = "已立项",
        [Developing] = "开发中",
        [Released] = "已上线",
        [Rejected] = "已拒绝",
        [Scheduled] = "已排期",
    };

    /// <summary>MAP 旧默认流程状态 → TAPD 对齐状态。</summary>
    public static readonly IReadOnlyDictionary<string, string> LegacyStateMap = new Dictionary<string, string>
    {
        ["pending"] = New,
        ["reviewed"] = Planning,
        ["developing"] = Developing,
        ["testing"] = Developing,
        ["done"] = Released,
        ["rejected"] = Rejected,
    };

    /// <summary>TAPD 中文状态 / 别名 → 工作流 Key。</summary>
    public static string? MapTapdStatusLabel(string? label)
    {
        if (string.IsNullOrWhiteSpace(label)) return null;
        var t = label.Trim();
        foreach (var pair in StateLabels)
        {
            if (pair.Value == t) return pair.Key;
        }
        return t switch
        {
            "已实现" => Released,
            "已完成" => Released,
            _ => null,
        };
    }

    public static string NormalizeStateKey(string? stateKey)
    {
        if (string.IsNullOrWhiteSpace(stateKey)) return New;
        var key = stateKey.Trim();
        if (StateLabels.ContainsKey(key)) return key;
        return LegacyStateMap.TryGetValue(key, out var mapped) ? mapped : key;
    }

    /// <summary>fromKey → 可流转到的 toKey 列表（与 TAPD 流转矩阵一致，不含停留原状态）。</summary>
    public static IReadOnlyDictionary<string, string[]> TransitionMatrix { get; } = new Dictionary<string, string[]>
    {
        [New] = new[] { Planning, Approved, Developing, Released, Rejected, Scheduled },
        [Planning] = new[] { New, Approved, Developing, Released, Rejected, Scheduled },
        [Approved] = new[] { Planning, Developing, Released, Rejected },
        [Developing] = new[] { Planning, Approved, Released, Rejected },
        [Released] = new[] { Planning, Approved, Developing, Rejected },
        [Rejected] = new[] { New, Planning },
        [Scheduled] = new[] { Approved, Developing, Released, Rejected },
    };

    /// <summary>TAPD 对齐默认需求流程的流转边数量（7 状态矩阵，不含自环）。</summary>
    public const int ExpectedTransitionCount = 31;

    /// <summary>流转按钮短文案（如「到待规划」），避免矩阵边过多时 UI 拥挤。</summary>
    public static string BuildTransitionActionLabel(string toStateKey)
    {
        var key = NormalizeStateKey(toStateKey);
        return StateLabels.TryGetValue(key, out var label) ? $"到{label}" : $"到{toStateKey}";
    }

    /// <summary>解析需求状态中文标签：工作流定义优先，其次 TAPD 内置表，最后原样返回 Key。</summary>
    public static string ResolveStateLabel(string? stateKey, ProductWorkflowDefinition? workflowDef = null)
    {
        if (string.IsNullOrWhiteSpace(stateKey)) return "未设置";
        var key = NormalizeStateKey(stateKey);
        if (workflowDef != null)
        {
            var fromDef = workflowDef.States.FirstOrDefault(s => s.Key == key)?.Label;
            if (!string.IsNullOrEmpty(fromDef)) return fromDef;
        }
        return StateLabels.TryGetValue(key, out var label) ? label : key;
    }
}
