namespace PrdAgent.Core.Models;

/// <summary>
/// MAP 内置「米多需求收集工作流」目录：仅用于首次种子写入 MongoDB 与存量 Key 迁移。
/// 运行时 SSOT 是 <see cref="ProductWorkflowDefinition"/>（设置 → 流程模板 / 产品覆盖）；
/// 流转一律走 POST /transition 查库内 Transitions，不调用任何外部系统。
/// </summary>
public static class RequirementWorkflowCatalog
{
    public const string WorkflowName = "米多需求收集工作流";

    public const string New = "new";
    public const string Planning = "planning";
    public const string Approved = "status_2";
    public const string Developing = "developing";
    public const string Released = "resolved";
    public const string Rejected = "rejected";
    public const string Scheduled = "status_3";
    /// <summary>终态：需求转入缺陷列表（联动创建缺陷记录）。</summary>
    public const string ToDefect = "to_defect";

    public static readonly IReadOnlyDictionary<string, string> StateLabels = new Dictionary<string, string>
    {
        [New] = "待评审",
        [Planning] = "待规划",
        [Approved] = "已立项",
        [Developing] = "开发中",
        [Released] = "已上线",
        [Rejected] = "已拒绝",
        [Scheduled] = "已排期",
        [ToDefect] = "转为缺陷",
    };

    /// <summary>内置状态说明（流程模板「状态定义」初始展示文案）。</summary>
    public static readonly IReadOnlyDictionary<string, string> StateDescriptions = new Dictionary<string, string>
    {
        [New] = "新提交的需求，待评审",
        [Planning] = "经过产品经理评审，认为此需求合理，待排期规划",
        [Approved] = "需求已出产品方案，待开发",
        [Developing] = "该需求正在开发中，待上线",
        [Released] = "需求已经实现，并且项目已经上线",
        [Rejected] = "经过产品经理评审，认为此需求不合理",
        [Scheduled] = "需求经过产品经理规划，已申请立项，待评审",
        [ToDefect] = "经评审认定应作为缺陷跟进，需求记录转入缺陷列表",
    };

    /// <summary>可流转到「转为缺陷」的源状态（不含已上线终态）。</summary>
    public static readonly string[] ToDefectSourceStates =
    {
        New, Planning, Approved, Developing, Rejected, Scheduled,
    };

    /// <summary>MAP 旧默认流程状态 → 当前内置状态 Key。</summary>
    public static readonly IReadOnlyDictionary<string, string> LegacyStateMap = new Dictionary<string, string>
    {
        ["pending"] = New,
        ["reviewed"] = Planning,
        ["developing"] = Developing,
        ["testing"] = Developing,
        ["done"] = Released,
        ["rejected"] = Rejected,
        /// <summary>历史误把表单字段 key「state」写入 CurrentState 时的兜底迁移。</summary>
        ["state"] = New,
    };

    /// <summary>
    /// 外部文件导入（CSV/RTF）时的中文状态名 → 工作流 Key。仅 import 路径使用。
    /// </summary>
    public static string? MapImportedStatusLabel(string? label)
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

    /// <summary>
    /// 规范需求状态 Key：遗留 Key 映射 → 工作流定义内 Key → 内置目录 Key → 原样保留（支持用户自定义状态）。
    /// </summary>
    public static string NormalizeStateKey(string? stateKey, ProductWorkflowDefinition? workflowDef = null)
    {
        if (string.IsNullOrWhiteSpace(stateKey))
            return workflowDef?.GetInitialStateKey() ?? New;

        var key = stateKey.Trim();
        if (LegacyStateMap.TryGetValue(key, out var legacyMapped))
            key = legacyMapped;

        if (workflowDef?.States.Any(s => s.Key == key) == true)
            return key;

        if (StateLabels.ContainsKey(key))
            return key;

        return key;
    }

    /// <summary>内置默认流程的流转边（from → to 列表），仅种子构建使用。</summary>
    public static IReadOnlyDictionary<string, string[]> TransitionMatrix { get; } = BuildTransitionMatrix();

    private static Dictionary<string, string[]> BuildTransitionMatrix()
    {
        var matrix = new Dictionary<string, string[]>
        {
            [New] = new[] { Planning, Approved, Developing, Released, Rejected, Scheduled },
            [Planning] = new[] { New, Approved, Developing, Released, Rejected, Scheduled },
            [Approved] = new[] { Planning, Developing, Released, Rejected },
            [Developing] = new[] { Planning, Approved, Released, Rejected },
            [Released] = new[] { Planning, Approved, Developing, Rejected },
            [Rejected] = new[] { New, Planning },
            [Scheduled] = new[] { Approved, Developing, Released, Rejected },
        };
        foreach (var from in ToDefectSourceStates)
        {
            var tos = matrix[from].ToList();
            if (!tos.Contains(ToDefect)) tos.Add(ToDefect);
            matrix[from] = tos.ToArray();
        }
        return matrix;
    }

    public const int ExpectedTransitionCount = 36;

    public static string BuildTransitionActionLabel(string toStateKey, ProductWorkflowDefinition? workflowDef = null)
    {
        var key = NormalizeStateKey(toStateKey, workflowDef);
        if (workflowDef != null)
        {
            var fromDef = workflowDef.States.FirstOrDefault(s => s.Key == key)?.Label;
            if (!string.IsNullOrEmpty(fromDef)) return $"到{fromDef}";
        }
        return StateLabels.TryGetValue(key, out var label) ? $"到{label}" : $"到{toStateKey}";
    }

    /// <summary>解析状态中文标签：工作流定义（运行时 SSOT）优先，其次内置目录，最后原 Key。</summary>
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
}
