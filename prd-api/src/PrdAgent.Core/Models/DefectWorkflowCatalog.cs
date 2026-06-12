namespace PrdAgent.Core.Models;

/// <summary>
/// 产品管理智能体 — 缺陷工作流内置状态与流转矩阵（状态 Key 对齐 DefectStatus）。
/// </summary>
public static class DefectWorkflowCatalog
{
    public const string WorkflowName = "标准缺陷流程";

    public static readonly (string From, string[] Tos)[] TransitionMatrix =
    {
        (DefectStatus.Submitted, new[] { DefectStatus.Assigned, DefectStatus.Rejected, DefectStatus.Closed }),
        (DefectStatus.Assigned, new[] { DefectStatus.Processing, DefectStatus.Submitted, DefectStatus.Rejected }),
        (DefectStatus.Processing, new[] { DefectStatus.Verifying, DefectStatus.Resolved, DefectStatus.Rejected }),
        (DefectStatus.Verifying, new[] { DefectStatus.Resolved, DefectStatus.Processing, DefectStatus.Rejected }),
        (DefectStatus.Resolved, new[] { DefectStatus.Closed, DefectStatus.Processing }),
        (DefectStatus.Rejected, new[] { DefectStatus.Submitted }),
        (DefectStatus.Closed, new[] { DefectStatus.Submitted }),
    };

    public static string BuildTransitionActionLabel(string toStateKey) => toStateKey switch
    {
        DefectStatus.Assigned => "分配",
        DefectStatus.Processing => "开始处理",
        DefectStatus.Verifying => "提交验收",
        DefectStatus.Resolved => "标记解决",
        DefectStatus.Rejected => "拒绝",
        DefectStatus.Closed => "关闭",
        DefectStatus.Submitted => "重新提交",
        _ => $"到{toStateKey}",
    };

    public static string ResolveStateLabel(string? stateKey, ProductWorkflowDefinition? def)
    {
        if (string.IsNullOrWhiteSpace(stateKey)) return "未设置";
        if (def != null)
        {
            var hit = def.States.FirstOrDefault(s => s.Key == stateKey);
            if (hit != null && !string.IsNullOrWhiteSpace(hit.Label)) return hit.Label;
        }
        return stateKey switch
        {
            DefectStatus.Draft => "草稿",
            DefectStatus.Reviewing => "评审中",
            DefectStatus.Awaiting => "待处理",
            DefectStatus.Submitted => "已提交",
            DefectStatus.Assigned => "已分配",
            DefectStatus.Processing => "处理中",
            DefectStatus.Verifying => "待验收",
            DefectStatus.Resolved => "已解决",
            DefectStatus.Rejected => "已拒绝",
            DefectStatus.Closed => "已关闭",
            _ => stateKey,
        };
    }
}
