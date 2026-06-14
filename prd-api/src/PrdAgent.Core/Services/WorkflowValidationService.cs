using System.Text.Json;
using PrdAgent.Core.Models;

namespace PrdAgent.Core.Services;

/// <summary>
/// 工作流结构校验 + 自动接线 + 缺项扫描（纯函数，不依赖 DB / LLM，可单测）。
///
/// 目标：把 AI 生成的工作流从「草稿」处理成「可跑件」：
/// 1. 规范化每个节点的插槽为舱类型默认插槽（保证 slotId 真实存在，不让 LLM/用户猜）
/// 2. 修复 / 自动补全连线（按 dataType 匹配；零边时按节点声明顺序链式连接）
/// 3. 结构校验（未知/停用舱、悬空边、成环、空工作流）→ 失败由调用方回喂 LLM 自愈
/// 4. 缺项扫描（必填配置 / secret 变量未填）→ 前端「补齐就能跑」表单
///
/// 设计依据：doc/design.workflow-auto-config.md、.claude/rules/no-rootless-tree.md
/// </summary>
public class WorkflowValidationService
{
    /// <summary>
    /// 处理一份 AI 生成的工作流：规范化插槽 → 自动接线 → 结构校验 → 缺项扫描。
    /// 原地修改 generated（插槽/连线会被纠正）。
    /// </summary>
    public WorkflowProcessResult Process(WorkflowChatGenerated generated)
    {
        var result = new WorkflowProcessResult { Generated = generated };

        generated.Nodes ??= new();
        generated.Edges ??= new();
        generated.Variables ??= new();

        if (generated.Nodes.Count == 0)
        {
            result.Issues.Add(new("workflow", "工作流没有任何节点，无法执行"));
            return result;
        }

        NormalizeSlots(generated.Nodes);
        result.WireNotes.AddRange(AutoWireEdges(generated));
        result.Issues.AddRange(ValidateStructure(generated));
        result.RequiredInputs.AddRange(ScanMissingInputs(generated));
        return result;
    }

    // ─────────────────────────────────────────────────────────
    // 1. 插槽规范化：节点插槽强制对齐舱类型默认插槽
    // ─────────────────────────────────────────────────────────

    private static void NormalizeSlots(List<WorkflowNode> nodes)
    {
        foreach (var node in nodes)
        {
            var meta = CapsuleTypeRegistry.Get(node.NodeType);
            if (meta == null) continue; // 未知舱由结构校验报错
            node.InputSlots = meta.DefaultInputSlots.Select(CloneSlot).ToList();
            node.OutputSlots = meta.DefaultOutputSlots.Select(CloneSlot).ToList();
        }
    }

    private static ArtifactSlot CloneSlot(ArtifactSlot s) => new()
    {
        SlotId = s.SlotId,
        Name = s.Name,
        DataType = s.DataType,
        Required = s.Required,
        Description = s.Description,
    };

    // ─────────────────────────────────────────────────────────
    // 2. 自动接线：修复已有连线 + 零边时按顺序链式连接
    // ─────────────────────────────────────────────────────────

    private static List<string> AutoWireEdges(WorkflowChatGenerated g)
    {
        var notes = new List<string>();
        var nodes = g.Nodes!;
        var nodeById = nodes.ToDictionary(n => n.NodeId, n => n);
        var repaired = new List<WorkflowEdge>();

        foreach (var edge in g.Edges!)
        {
            if (!nodeById.TryGetValue(edge.SourceNodeId, out var src) ||
                !nodeById.TryGetValue(edge.TargetNodeId, out var tgt))
            {
                notes.Add($"删除指向不存在节点的连线（{edge.SourceNodeId} → {edge.TargetNodeId}）");
                continue;
            }
            if (src.OutputSlots.Count == 0 || tgt.InputSlots.Count == 0)
            {
                notes.Add($"「{src.Name}」无输出或「{tgt.Name}」无输入，删除无效连线");
                continue;
            }

            // 修复 sourceSlotId
            var srcSlot = src.OutputSlots.FirstOrDefault(s => s.SlotId == edge.SourceSlotId)
                          ?? src.OutputSlots[0];
            if (srcSlot.SlotId != edge.SourceSlotId)
                notes.Add($"「{src.Name}」输出插槽自动校正为 {srcSlot.SlotId}");

            // 修复 targetSlotId（优先精确匹配 → dataType 兼容 → 第一个）
            var tgtSlot = tgt.InputSlots.FirstOrDefault(s => s.SlotId == edge.TargetSlotId)
                          ?? tgt.InputSlots.FirstOrDefault(s => s.DataType == srcSlot.DataType)
                          ?? tgt.InputSlots[0];
            if (tgtSlot.SlotId != edge.TargetSlotId)
                notes.Add($"「{tgt.Name}」输入插槽自动校正为 {tgtSlot.SlotId}");

            repaired.Add(new WorkflowEdge
            {
                EdgeId = string.IsNullOrWhiteSpace(edge.EdgeId) ? Guid.NewGuid().ToString("N")[..8] : edge.EdgeId,
                SourceNodeId = src.NodeId,
                SourceSlotId = srcSlot.SlotId,
                TargetNodeId = tgt.NodeId,
                TargetSlotId = tgtSlot.SlotId,
            });
        }

        // 去重（同一对 node+slot 只保留一条）
        repaired = repaired
            .GroupBy(e => $"{e.SourceNodeId}:{e.SourceSlotId}->{e.TargetNodeId}:{e.TargetSlotId}")
            .Select(grp => grp.First())
            .ToList();

        // 零有效连线但有多个节点 → 按声明顺序链式连接（最常见的线性流水线）
        if (repaired.Count == 0 && nodes.Count >= 2)
        {
            for (var i = 0; i < nodes.Count - 1; i++)
            {
                var src = nodes[i];
                var tgt = nodes[i + 1];
                if (src.OutputSlots.Count == 0 || tgt.InputSlots.Count == 0) continue;
                var srcSlot = src.OutputSlots[0];
                var tgtSlot = tgt.InputSlots.FirstOrDefault(s => s.DataType == srcSlot.DataType)
                              ?? tgt.InputSlots[0];
                repaired.Add(new WorkflowEdge
                {
                    EdgeId = Guid.NewGuid().ToString("N")[..8],
                    SourceNodeId = src.NodeId,
                    SourceSlotId = srcSlot.SlotId,
                    TargetNodeId = tgt.NodeId,
                    TargetSlotId = tgtSlot.SlotId,
                });
            }
            if (repaired.Count > 0)
                notes.Add($"未提供有效连线，已按顺序自动连接 {repaired.Count + 1} 个节点");
        }

        g.Edges = repaired;
        return notes;
    }

    // ─────────────────────────────────────────────────────────
    // 3. 结构校验
    // ─────────────────────────────────────────────────────────

    private static List<WorkflowValidationIssue> ValidateStructure(WorkflowChatGenerated g)
    {
        var issues = new List<WorkflowValidationIssue>();
        var nodes = g.Nodes!;

        foreach (var node in nodes)
        {
            var meta = CapsuleTypeRegistry.Get(node.NodeType);
            if (meta == null)
            {
                if (!WorkflowNodeTypes.All.Contains(node.NodeType))
                    issues.Add(new(node.NodeId, $"未知舱类型「{node.NodeType}」，请改用可用舱"));
                continue;
            }
            if (!string.IsNullOrEmpty(meta.DisabledReason))
                issues.Add(new(node.NodeId, $"舱「{meta.Name}」暂未开放（{meta.DisabledReason}），请替换为可用舱（如手动触发）"));
        }

        // 成环检测（Kahn 拓扑排序）
        if (HasCycle(nodes, g.Edges!))
            issues.Add(new("workflow", "工作流连线存在环，无法确定执行顺序"));

        return issues;
    }

    private static bool HasCycle(List<WorkflowNode> nodes, List<WorkflowEdge> edges)
    {
        var indegree = nodes.ToDictionary(n => n.NodeId, _ => 0);
        var adj = nodes.ToDictionary(n => n.NodeId, _ => new List<string>());
        foreach (var e in edges)
        {
            if (!indegree.ContainsKey(e.TargetNodeId) || !adj.ContainsKey(e.SourceNodeId)) continue;
            indegree[e.TargetNodeId]++;
            adj[e.SourceNodeId].Add(e.TargetNodeId);
        }

        var queue = new Queue<string>(indegree.Where(kv => kv.Value == 0).Select(kv => kv.Key));
        var visited = 0;
        while (queue.Count > 0)
        {
            var n = queue.Dequeue();
            visited++;
            foreach (var next in adj[n])
                if (--indegree[next] == 0) queue.Enqueue(next);
        }
        return visited != nodes.Count;
    }

    // ─────────────────────────────────────────────────────────
    // 4. 缺项扫描：必填配置 / secret 变量未填 → 补齐表单
    // ─────────────────────────────────────────────────────────

    private static List<WorkflowRequiredInput> ScanMissingInputs(WorkflowChatGenerated g)
    {
        var inputs = new List<WorkflowRequiredInput>();
        var seen = new HashSet<string>();
        var declaredVars = (g.Variables ?? new())
            .Where(v => !string.IsNullOrWhiteSpace(v.Key))
            .ToDictionary(v => v.Key, v => v);

        foreach (var node in g.Nodes!)
        {
            var meta = CapsuleTypeRegistry.Get(node.NodeType);
            if (meta == null) continue;

            foreach (var field in meta.ConfigSchema.Where(f => f.Required))
            {
                node.Config.TryGetValue(field.Key, out var raw);
                var val = ToConfigString(raw);

                // 已填实值 / 引用了已声明变量 → 视为已满足
                if (!string.IsNullOrWhiteSpace(val) && !IsUnresolvedVariableOnly(val, declaredVars))
                    continue;

                // 有默认值的必填字段：执行时走默认，不算缺项（避免 method/timezone 之类噪音）
                if (string.IsNullOrWhiteSpace(val) && !string.IsNullOrWhiteSpace(field.DefaultValue))
                    continue;

                var key = $"{node.NodeId}:{field.Key}";
                if (!seen.Add(key)) continue;
                inputs.Add(new WorkflowRequiredInput
                {
                    Key = field.Key,
                    Label = field.Label,
                    Type = field.FieldType,
                    Required = true,
                    IsSecret = field.FieldType == "password",
                    Scope = "config",
                    NodeId = node.NodeId,
                    NodeName = node.Name,
                    HelpTip = field.HelpTip,
                    Placeholder = field.Placeholder,
                });
            }
        }

        // 声明了但必填且无默认值的变量（尤其 secret）
        foreach (var v in declaredVars.Values.Where(v => v.Required && string.IsNullOrWhiteSpace(v.DefaultValue)))
        {
            var key = $"var:{v.Key}";
            if (!seen.Add(key)) continue;
            inputs.Add(new WorkflowRequiredInput
            {
                Key = v.Key,
                Label = string.IsNullOrWhiteSpace(v.Label) ? v.Key : v.Label,
                Type = v.IsSecret ? "password" : v.Type,
                Required = true,
                IsSecret = v.IsSecret,
                Scope = "variable",
            });
        }

        return inputs;
    }

    /// <summary>值是否「只是一个未声明的变量占位」（如 "{{cookie}}" 但 cookie 未声明）。</summary>
    private static bool IsUnresolvedVariableOnly(string val, IReadOnlyDictionary<string, WorkflowVariable> declared)
    {
        var trimmed = val.Trim();
        if (!trimmed.StartsWith("{{") || !trimmed.EndsWith("}}")) return false;
        var inner = trimmed[2..^2].Trim();
        return !declared.ContainsKey(inner);
    }

    private static string? ToConfigString(object? raw)
    {
        switch (raw)
        {
            case null:
                return null;
            case string s:
                return s;
            case JsonElement je:
                return je.ValueKind switch
                {
                    JsonValueKind.String => je.GetString(),
                    JsonValueKind.Null or JsonValueKind.Undefined => null,
                    _ => je.GetRawText(),
                };
            default:
                return raw.ToString();
        }
    }
}

// ─────────────────────────────────────────────────────────────
// 结果模型
// ─────────────────────────────────────────────────────────────

public class WorkflowProcessResult
{
    public WorkflowChatGenerated Generated { get; set; } = null!;
    public List<WorkflowValidationIssue> Issues { get; set; } = new();
    public List<string> WireNotes { get; set; } = new();
    public List<WorkflowRequiredInput> RequiredInputs { get; set; } = new();
    public bool Valid => Issues.Count == 0;
}

public class WorkflowValidationIssue
{
    /// <summary>问题归属：nodeId | "workflow" | "edge"</summary>
    public string Target { get; set; }
    public string Message { get; set; }

    public WorkflowValidationIssue(string target, string message)
    {
        Target = target;
        Message = message;
    }
}

/// <summary>生成后仍需用户补齐才能跑的一项（必填配置或 secret 变量）。</summary>
public class WorkflowRequiredInput
{
    public string Key { get; set; } = string.Empty;
    public string Label { get; set; } = string.Empty;

    /// <summary>text | password | textarea | select | number 等（沿用 ConfigField.FieldType）</summary>
    public string Type { get; set; } = "text";
    public bool Required { get; set; } = true;
    public bool IsSecret { get; set; }

    /// <summary>config = 节点配置字段 | variable = 工作流变量</summary>
    public string Scope { get; set; } = "config";

    /// <summary>Scope=config 时所属节点；variable 时为 null</summary>
    public string? NodeId { get; set; }
    public string? NodeName { get; set; }
    public string? HelpTip { get; set; }
    public string? Placeholder { get; set; }
}
