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
        NormalizeConfigPlaceholders(generated.Nodes);
        result.WireNotes.AddRange(AutoWireEdges(generated));
        result.Issues.AddRange(ValidateStructure(generated));
        result.RequiredInputs.AddRange(ScanMissingInputs(generated));
        return result;
    }

    /// <summary>
    /// 把 config 字符串里带空格的占位 {{ host }} 规范化成运行时认的精确形式 {{host}}（递归进 JSON 对象/数组）。
    /// 否则 CapsuleExecutor.ReplaceVariables 只替换精确 {{host}}，会带着字面 {{ host }} 跑。
    /// </summary>
    private static void NormalizeConfigPlaceholders(List<WorkflowNode> nodes)
    {
        foreach (var node in nodes)
        {
            if (node.Config == null) continue;
            foreach (var k in node.Config.Keys.ToList())
                node.Config[k] = NormalizePlaceholdersIn(node.Config[k]);
        }
    }

    private static object? NormalizePlaceholdersIn(object? value)
    {
        switch (value)
        {
            case string s:
                return s.Contains("{{") ? VariableRefRegex.Replace(s, m => "{{" + m.Groups[1].Value + "}}") : s;
            case Dictionary<string, object?> dict:
                foreach (var k in dict.Keys.ToList()) dict[k] = NormalizePlaceholdersIn(dict[k]);
                return dict;
            case List<object?> list:
                for (var i = 0; i < list.Count; i++) list[i] = NormalizePlaceholdersIn(list[i]);
                return list;
            default:
                return value;
        }
    }

    /// <summary>递归收集一个 config 值里的所有字符串叶子（string / JSON 对象/数组里的字符串）。</summary>
    private static IEnumerable<string> CollectStrings(object? value)
    {
        switch (value)
        {
            case string s:
                yield return s;
                break;
            case JsonElement je:
                if (je.ValueKind == JsonValueKind.String) { yield return je.GetString() ?? string.Empty; }
                else if (je.ValueKind == JsonValueKind.Object)
                    foreach (var p in je.EnumerateObject())
                        foreach (var x in CollectStrings(p.Value)) yield return x;
                else if (je.ValueKind == JsonValueKind.Array)
                    foreach (var e in je.EnumerateArray())
                        foreach (var x in CollectStrings(e)) yield return x;
                break;
            case System.Collections.IDictionary dict:
                foreach (var v in dict.Values)
                    foreach (var x in CollectStrings(v)) yield return x;
                break;
            case System.Collections.IEnumerable en: // List<object?> 等（string 已在上面单独处理）
                foreach (var item in en)
                    foreach (var x in CollectStrings(item)) yield return x;
                break;
        }
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
        // 每个源/目标节点已被占用的插槽：修复无效 slotId 时挑「未占用」的，保住 condition
        // true/false、merger in-1/in-2 等多槽分支不被全部塌到第一个槽
        var usedOut = new Dictionary<string, HashSet<string>>();
        var usedIn = new Dictionary<string, HashSet<string>>();
        HashSet<string> OutOf(string id) => usedOut.TryGetValue(id, out var s) ? s : usedOut[id] = new();
        HashSet<string> InOf(string id) => usedIn.TryGetValue(id, out var s) ? s : usedIn[id] = new();

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

            var outUsed = OutOf(src.NodeId);
            var inUsed = InOf(tgt.NodeId);

            // 修复 sourceSlotId：显式且有效则保留；无效/空 → 挑一个未占用的输出槽（分支不塌）
            var srcSlot = src.OutputSlots.FirstOrDefault(s => s.SlotId == edge.SourceSlotId);
            if (srcSlot == null)
            {
                srcSlot = src.OutputSlots.FirstOrDefault(s => !outUsed.Contains(s.SlotId)) ?? src.OutputSlots[0];
                notes.Add($"「{src.Name}」输出插槽自动校正为 {srcSlot.SlotId}");
            }
            outUsed.Add(srcSlot.SlotId);

            // 修复 targetSlotId：显式有效保留；否则优先未占用 + dataType 兼容 → 未占用 → 兼容 → 第一个
            var tgtSlot = tgt.InputSlots.FirstOrDefault(s => s.SlotId == edge.TargetSlotId);
            if (tgtSlot == null)
            {
                tgtSlot = tgt.InputSlots.FirstOrDefault(s => s.DataType == srcSlot.DataType && !inUsed.Contains(s.SlotId))
                          ?? tgt.InputSlots.FirstOrDefault(s => !inUsed.Contains(s.SlotId))
                          ?? tgt.InputSlots.FirstOrDefault(s => s.DataType == srcSlot.DataType)
                          ?? tgt.InputSlots[0];
                notes.Add($"「{tgt.Name}」输入插槽自动校正为 {tgtSlot.SlotId}");
            }
            inUsed.Add(tgtSlot.SlotId);

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

        // 补缺连线（按插槽粒度）：
        // - 每个「必填输入插槽」没有上游 → 从最近的、未被本节点占用的前序有输出节点接一条
        //   （覆盖 data-merger 等多输入节点：merge-in-1/merge-in-2 都要有源）
        // - 节点完全没有上游且无必填插槽（如纯 http 链）→ 给第一个输入槽接一条，保持线性链不断
        if (nodes.Count >= 2)
        {
            var added = 0;
            for (var i = 1; i < nodes.Count; i++)
            {
                var tgt = nodes[i];
                if (tgt.InputSlots.Count == 0) continue; // 触发类/无输入 → 作为根

                var filledSlots = new HashSet<string>(
                    repaired.Where(e => e.TargetNodeId == tgt.NodeId).Select(e => e.TargetSlotId));

                var slotsToFill = tgt.InputSlots.Where(s => s.Required && !filledSlots.Contains(s.SlotId)).ToList();
                if (slotsToFill.Count == 0)
                {
                    // 无待补必填槽：仅当该节点完全没有上游时，给第一个输入槽补一条（线性链）
                    if (filledSlots.Count == 0) slotsToFill.Add(tgt.InputSlots[0]);
                    else continue;
                }

                var usedSrc = new HashSet<string>(
                    repaired.Where(e => e.TargetNodeId == tgt.NodeId).Select(e => e.SourceNodeId));

                foreach (var slot in slotsToFill)
                {
                    WorkflowNode? src = null;
                    for (var j = i - 1; j >= 0; j--)
                        if (nodes[j].OutputSlots.Count > 0 && !usedSrc.Contains(nodes[j].NodeId)) { src = nodes[j]; break; }
                    if (src == null) break; // 没有更多可用上游 → 不强连，交给后续校验/用户

                    var srcSlot = src.OutputSlots.FirstOrDefault(s => s.DataType == slot.DataType) ?? src.OutputSlots[0];
                    repaired.Add(new WorkflowEdge
                    {
                        EdgeId = Guid.NewGuid().ToString("N")[..8],
                        SourceNodeId = src.NodeId,
                        SourceSlotId = srcSlot.SlotId,
                        TargetNodeId = tgt.NodeId,
                        TargetSlotId = slot.SlotId,
                    });
                    usedSrc.Add(src.NodeId);
                    added++;
                }
            }
            if (added > 0)
                notes.Add($"自动补全 {added} 条缺失连线，确保每个处理节点的必填输入都有上游");
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
                // 注册表里没有的类型一律视为不可用（含 data-collector 等旧别名——它们在注册表里
                // 无 meta/schema/slots，不是可运行舱），交自愈替换为真正的舱
                issues.Add(new(node.NodeId, $"未知或已废弃舱类型「{node.NodeType}」，请改用可用舱"));
                continue;
            }
            if (!string.IsNullOrEmpty(meta.DisabledReason))
                issues.Add(new(node.NodeId, $"舱「{meta.Name}」暂未开放（{meta.DisabledReason}），请替换为可用舱（如手动触发）"));
        }

        // 必填输入插槽缺上游（gap-fill 已尽力补；补不上的在此暴露，避免「单输入合并」之类静默残缺）
        foreach (var node in nodes)
        {
            var incomingSlots = g.Edges!
                .Where(e => e.TargetNodeId == node.NodeId)
                .Select(e => e.TargetSlotId)
                .ToHashSet();
            foreach (var slot in node.InputSlots.Where(s => s.Required))
                if (!incomingSlots.Contains(slot.SlotId))
                    issues.Add(new(node.NodeId, $"「{node.Name}」必填输入「{slot.Name}」缺少上游连线"));
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
                var val = ToConfigString(GetConfigValue(node, field.Key));

                // 非空即视为「配置层已填」（内嵌的 {{var}} 占位由下方变量扫描单独兜）
                if (!string.IsNullOrWhiteSpace(val)) continue;

                // 有默认值的必填字段：执行时走默认，不算缺项（避免 method/timezone 之类噪音）
                if (!string.IsNullOrWhiteSpace(field.DefaultValue)) continue;

                var key = $"{node.NodeId}:{field.Key}";
                if (!seen.Add(key)) continue;
                // cookie(textarea)/dscToken(text) 等凭证字段名像密钥但类型不是 password →
                // 用 key 判定补上 secret，让补齐表单掩码显示（与变量同口径）
                var fieldSecret = field.FieldType == "password" || LooksLikeSecretKey(field.Key);
                inputs.Add(new WorkflowRequiredInput
                {
                    Key = field.Key,
                    Label = field.Label,
                    Type = fieldSecret ? "password" : field.FieldType,
                    Required = true,
                    IsSecret = fieldSecret,
                    Scope = "config",
                    NodeId = node.NodeId,
                    NodeName = node.Name,
                    HelpTip = field.HelpTip,
                    Placeholder = field.Placeholder,
                });
            }

            // 任意 config 值里内嵌的 {{var}} 占位（含 https://{{host}}/api、headers/body 等嵌套 JSON 里的占位）
            // 引用了「未声明」或「已声明但无默认值」的变量都 surface 成可填项，
            // 避免带着未替换的占位跑（被引用即说明需要值，不看 v.Required 标记）
            foreach (var kv in node.Config ?? new())
            {
                foreach (var s in CollectStrings(kv.Value))
                {
                    if (string.IsNullOrEmpty(s)) continue;
                    foreach (var token in ExtractVariableRefs(s))
                    {
                        declaredVars.TryGetValue(token, out var dv);
                        if (dv != null && !string.IsNullOrWhiteSpace(dv.DefaultValue)) continue; // 有默认值 → 运行时走默认
                        var key = $"var:{token}";
                        if (!seen.Add(key)) continue;
                        var secret = dv?.IsSecret ?? LooksLikeSecretKey(token);
                        inputs.Add(new WorkflowRequiredInput
                        {
                            Key = token,
                            Label = !string.IsNullOrWhiteSpace(dv?.Label) ? dv!.Label : token,
                            Type = secret ? "password" : (string.IsNullOrWhiteSpace(dv?.Type) ? "text" : dv!.Type),
                            Required = true,
                            IsSecret = secret,
                            Scope = "variable",
                        });
                    }
                }
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

    private static readonly System.Text.RegularExpressions.Regex VariableRefRegex =
        new(@"\{\{\s*([A-Za-z0-9_.\-]+)\s*\}\}", System.Text.RegularExpressions.RegexOptions.Compiled);

    /// <summary>
    /// 执行器自己注入/解析的保留占位符，不是工作流变量，不能当缺项 surface：
    /// {{input}}=上游产物注入、{{date}}/{{datetime}}=时间、{{now.*}}=默认值时间占位。
    /// 见 CapsuleExecutor.ExecuteLlmAnalyzerAsync / 文件导出占位替换。
    /// </summary>
    private static readonly HashSet<string> ReservedPlaceholders =
        new(StringComparer.OrdinalIgnoreCase) { "input", "date", "datetime" };

    /// <summary>提取值里所有 {{var}} 占位的变量名（排除执行器保留占位 input/date/datetime/now.*）。</summary>
    private static IEnumerable<string> ExtractVariableRefs(string value)
    {
        foreach (System.Text.RegularExpressions.Match m in VariableRefRegex.Matches(value))
        {
            var name = m.Groups[1].Value;
            if (name.StartsWith("now.", StringComparison.OrdinalIgnoreCase)) continue;
            if (ReservedPlaceholders.Contains(name)) continue;
            yield return name;
        }
    }

    /// <summary>变量名是否像密钥（用于决定补齐表单是否掩码）。</summary>
    private static bool LooksLikeSecretKey(string key)
    {
        var k = key.ToLowerInvariant();
        return k.Contains("cookie") || k.Contains("token") || k.Contains("secret")
            || k.Contains("password") || k.Contains("passwd") || k.Contains("apikey")
            || k.Contains("api_key") || k.Contains("auth");
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
