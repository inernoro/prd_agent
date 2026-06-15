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
        // 节点 ID 可能重复（LLM 偶发）：用 last-wins 构表避免 ToDictionary 抛异常；
        // 重复本身由 ValidateStructure 报为结构问题。
        var nodeById = new Dictionary<string, WorkflowNode>();
        foreach (var n in nodes) nodeById[n.NodeId] = n;
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

        // 补缺连线：任何「有输入插槽却没有上游」的节点，从最近的前序有输出节点接一条。
        // 既覆盖"零连线 → 全链式"，也覆盖"漏接一跳 → 该节点变独立根、空输入跑"（部分连线）。
        if (nodes.Count >= 2)
        {
            var hasIncoming = new HashSet<string>(repaired.Select(e => e.TargetNodeId));
            var added = 0;
            for (var i = 1; i < nodes.Count; i++)
            {
                var tgt = nodes[i];
                if (tgt.InputSlots.Count == 0) continue;        // 触发类/无输入 → 作为根，不补
                if (hasIncoming.Contains(tgt.NodeId)) continue;  // 已有上游

                WorkflowNode? src = null;
                for (var j = i - 1; j >= 0; j--)
                    if (nodes[j].OutputSlots.Count > 0) { src = nodes[j]; break; }
                if (src == null) continue;

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
                hasIncoming.Add(tgt.NodeId);
                added++;
            }
            if (added > 0)
                notes.Add($"自动补全 {added} 条缺失连线，确保每个处理节点都有上游输入");
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

        // 节点 ID 必须唯一（重复会让连线/拓扑出现歧义）
        foreach (var dupId in nodes.GroupBy(n => n.NodeId).Where(grp => grp.Count() > 1).Select(grp => grp.Key))
            issues.Add(new(dupId, $"节点 ID「{dupId}」重复，必须唯一"));

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
        // 节点 ID 可能重复：用 last-wins 构表（去重后按 distinct id 数判环，避免重复 id 造成假阳性）
        var indegree = new Dictionary<string, int>();
        var adj = new Dictionary<string, List<string>>();
        foreach (var n in nodes) { indegree[n.NodeId] = 0; adj[n.NodeId] = new List<string>(); }
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
        return visited != indegree.Count;
    }

    // ─────────────────────────────────────────────────────────
    // 4. 缺项扫描：必填配置 / secret 变量未填 → 补齐表单
    // ─────────────────────────────────────────────────────────

    /// <summary>
    /// 条件必填：某字段在另一字段取特定值时才必填（ConfigSchema 无法表达，集中声明在此）。
    /// 例：tapd-collector 选 Cookie 认证时 cookie/dscToken 必填，选 Open API 时 authToken 必填。
    /// </summary>
    private static readonly Dictionary<string, List<(string WhenKey, string WhenValue, string RequiredKey)>> ConditionalRequired = new()
    {
        [CapsuleTypes.TapdCollector] = new()
        {
            ("authMode", "cookie", "cookie"),
            ("authMode", "cookie", "dscToken"),
            ("authMode", "basic", "authToken"),
        },
    };

    private static object? GetConfigValue(WorkflowNode node, string key)
    {
        object? raw = null;
        node.Config?.TryGetValue(key, out raw);
        return raw;
    }

    private static List<WorkflowRequiredInput> ScanMissingInputs(WorkflowChatGenerated g)
    {
        var inputs = new List<WorkflowRequiredInput>();
        var seen = new HashSet<string>();
        // 变量 key 可能重复（LLM 偶发）：last-wins 构表，避免 ToDictionary 抛异常
        var declaredVars = new Dictionary<string, WorkflowVariable>();
        foreach (var v in g.Variables ?? new())
            if (!string.IsNullOrWhiteSpace(v.Key)) declaredVars[v.Key] = v;

        foreach (var node in g.Nodes!)
        {
            var meta = CapsuleTypeRegistry.Get(node.NodeType);
            if (meta == null) continue;

            // 需校验的字段 = schema 必填字段 ∪ 条件必填字段（如 TAPD authMode=cookie 时 cookie/dscToken 必填）
            var requiredFields = meta.ConfigSchema.Where(f => f.Required).ToList();
            if (ConditionalRequired.TryGetValue(node.NodeType, out var conds))
            {
                foreach (var (whenKey, whenValue, requiredKey) in conds)
                {
                    var actual = ToConfigString(GetConfigValue(node, whenKey))
                                 ?? meta.ConfigSchema.FirstOrDefault(f => f.Key == whenKey)?.DefaultValue;
                    if (!string.Equals(actual, whenValue, StringComparison.OrdinalIgnoreCase)) continue;
                    var cf = meta.ConfigSchema.FirstOrDefault(f => f.Key == requiredKey);
                    if (cf != null && requiredFields.All(rf => rf.Key != cf.Key)) requiredFields.Add(cf);
                }
            }

            foreach (var field in requiredFields)
            {
                object? raw = null;
                node.Config?.TryGetValue(field.Key, out raw); // Config 可能为 null（"config": null）
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
