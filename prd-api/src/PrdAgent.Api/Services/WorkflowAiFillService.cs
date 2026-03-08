using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;

namespace PrdAgent.Api.Services;

/// <summary>
/// AI 辅助填写工作流舱参数服务
/// 根据舱的 ConfigSchema、上下游节点信息、历史执行产物，
/// 调用 LLM 生成推荐的配置参数值
/// </summary>
public class WorkflowAiFillService
{
    private readonly ILlmGateway _gateway;
    private readonly MongoDbContext _db;
    private readonly ILogger<WorkflowAiFillService> _logger;

    private const int MaxUpstreamSampleChars = 2000;

    public WorkflowAiFillService(
        ILlmGateway gateway,
        MongoDbContext db,
        ILogger<WorkflowAiFillService> logger)
    {
        _gateway = gateway;
        _db = db;
        _logger = logger;
    }

    public async Task<AiFillResult> FillAsync(AiFillInput input, CancellationToken ct)
    {
        // 1. 查找目标节点
        var targetNode = input.Workflow.Nodes.FirstOrDefault(n => n.NodeId == input.NodeId);
        if (targetNode == null)
            return new AiFillResult { Suggestions = new(), Explanation = "未找到目标节点", Confidence = "low" };

        // 2. 获取舱类型元数据
        var capsuleMeta = CapsuleTypeRegistry.Get(targetNode.NodeType);
        if (capsuleMeta == null || capsuleMeta.ConfigSchema.Count == 0)
            return new AiFillResult { Suggestions = new(), Explanation = "该舱类型无可配置字段", Confidence = "low" };

        // 3. 收集上游节点产物样本（如果有历史执行）
        string? upstreamSample = null;
        string? lastConfigJson = null;
        string? lastOutputSummary = null;

        if (!string.IsNullOrWhiteSpace(input.LastExecutionId))
        {
            var exec = await _db.WorkflowExecutions
                .Find(e => e.Id == input.LastExecutionId)
                .FirstOrDefaultAsync(CancellationToken.None);

            if (exec != null)
            {
                // 上游产物：找到连接到本节点的边，获取源节点的输出
                var incomingEdges = input.Workflow.Edges
                    .Where(e => e.TargetNodeId == input.NodeId)
                    .ToList();

                var upstreamParts = new List<string>();
                foreach (var edge in incomingEdges)
                {
                    var srcExec = exec.NodeExecutions
                        .FirstOrDefault(ne => ne.NodeId == edge.SourceNodeId);
                    if (srcExec?.OutputArtifacts.Count > 0)
                    {
                        var art = srcExec.OutputArtifacts.First();
                        if (!string.IsNullOrEmpty(art.InlineContent))
                        {
                            var sample = art.InlineContent.Length > MaxUpstreamSampleChars
                                ? art.InlineContent[..MaxUpstreamSampleChars] + $"\n...(已截取前 {MaxUpstreamSampleChars} 字符，原文共 {art.InlineContent.Length} 字符)"
                                : art.InlineContent;
                            var srcNode = input.Workflow.Nodes.FirstOrDefault(n => n.NodeId == edge.SourceNodeId);
                            upstreamParts.Add($"来自 [{srcNode?.Name ?? edge.SourceNodeId}]:\n{sample}");
                        }
                    }
                }
                if (upstreamParts.Count > 0)
                    upstreamSample = string.Join("\n\n---\n\n", upstreamParts);

                // 该节点上次的配置
                var lastNodeSnapshot = exec.NodeSnapshot
                    .FirstOrDefault(n => n.NodeId == input.NodeId);
                if (lastNodeSnapshot?.Config.Count > 0)
                    lastConfigJson = JsonSerializer.Serialize(lastNodeSnapshot.Config, new JsonSerializerOptions { WriteIndented = true });

                // 该节点上次的输出
                var lastNodeExec = exec.NodeExecutions
                    .FirstOrDefault(ne => ne.NodeId == input.NodeId);
                if (lastNodeExec?.OutputArtifacts.Count > 0)
                {
                    var outArt = lastNodeExec.OutputArtifacts.First();
                    if (!string.IsNullOrEmpty(outArt.InlineContent))
                    {
                        lastOutputSummary = outArt.InlineContent.Length > 500
                            ? outArt.InlineContent[..500] + "..."
                            : outArt.InlineContent;
                    }
                }
            }
        }

        // 4. 构建 System Prompt
        var systemPrompt = BuildSystemPrompt(input.Workflow, targetNode, capsuleMeta,
            upstreamSample, lastConfigJson, lastOutputSummary, input.UserHint);

        // 5. 调用 LLM
        var gatewayRequest = new GatewayRequest
        {
            AppCallerCode = AppCallerRegistry.WorkflowAgent.AiFill.Chat,
            ModelType = "chat",
            RequestBody = new JsonObject
            {
                ["messages"] = new JsonArray
                {
                    new JsonObject { ["role"] = "system", ["content"] = systemPrompt },
                    new JsonObject { ["role"] = "user", ["content"] = BuildUserMessage(capsuleMeta, input.Mode, input.UserHint) },
                },
                ["temperature"] = 0.2,
            },
            TimeoutSeconds = 60,
        };

        try
        {
            var response = await _gateway.SendAsync(gatewayRequest, CancellationToken.None);
            if (string.IsNullOrWhiteSpace(response.Content))
                return new AiFillResult { Suggestions = new(), Explanation = "AI 未返回有效内容", Confidence = "low" };

            return ParseAiResponse(response.Content, capsuleMeta);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[workflow-agent] AI fill failed for node {NodeId}", input.NodeId);
            return new AiFillResult { Suggestions = new(), Explanation = $"AI 调用失败: {ex.Message}", Confidence = "low" };
        }
    }

    private string BuildSystemPrompt(
        Workflow workflow,
        WorkflowNode targetNode,
        CapsuleTypeMeta capsuleMeta,
        string? upstreamSample,
        string? lastConfigJson,
        string? lastOutputSummary,
        string? userHint)
    {
        var sb = new StringBuilder();
        sb.AppendLine("你是工作流舱配置专家。根据以下信息，为目标舱生成配置参数的推荐值。");
        sb.AppendLine();

        // 工作流概述
        sb.AppendLine("## 工作流概述");
        sb.AppendLine($"名称：{workflow.Name}");
        if (!string.IsNullOrWhiteSpace(workflow.Description))
            sb.AppendLine($"描述：{workflow.Description}");
        sb.AppendLine();

        // 节点拓扑
        sb.AppendLine("## 节点列表");
        foreach (var node in workflow.Nodes)
        {
            var meta = CapsuleTypeRegistry.Get(node.NodeType);
            var marker = node.NodeId == targetNode.NodeId ? " ← [目标舱]" : "";
            sb.AppendLine($"- {node.Name} ({meta?.Name ?? node.NodeType}){marker}");
        }
        sb.AppendLine();

        // 连线关系
        if (workflow.Edges.Count > 0)
        {
            sb.AppendLine("## 连线关系");
            foreach (var edge in workflow.Edges)
            {
                var src = workflow.Nodes.FirstOrDefault(n => n.NodeId == edge.SourceNodeId);
                var tgt = workflow.Nodes.FirstOrDefault(n => n.NodeId == edge.TargetNodeId);
                sb.AppendLine($"- {src?.Name ?? edge.SourceNodeId} → {tgt?.Name ?? edge.TargetNodeId}");
            }
            sb.AppendLine();
        }

        // 目标舱详情
        sb.AppendLine("## 目标舱");
        sb.AppendLine($"类型：{capsuleMeta.Name} — {capsuleMeta.Description}");
        sb.AppendLine();
        sb.AppendLine("### 需要配置的字段");
        foreach (var field in capsuleMeta.ConfigSchema)
        {
            sb.Append($"- **{field.Key}** ({field.Label}): ");
            if (!string.IsNullOrWhiteSpace(field.HelpTip))
                sb.Append(field.HelpTip);
            sb.AppendLine();
            sb.AppendLine($"  类型: {field.FieldType}, 必填: {field.Required}");
            if (field.Options?.Count > 0)
                sb.AppendLine($"  可选值: {string.Join(", ", field.Options.Select(o => $"{o.Value}({o.Label})"))}");
            if (!string.IsNullOrWhiteSpace(field.DefaultValue))
                sb.AppendLine($"  默认值: {field.DefaultValue}");
            if (!string.IsNullOrWhiteSpace(field.Placeholder))
                sb.AppendLine($"  示例: {field.Placeholder}");
        }
        sb.AppendLine();

        // 输入插槽
        if (capsuleMeta.DefaultInputSlots.Count > 0)
        {
            sb.AppendLine("### 输入插槽");
            foreach (var slot in capsuleMeta.DefaultInputSlots)
                sb.AppendLine($"- {slot.Name} ({slot.DataType}): {slot.Description}");
            sb.AppendLine();
        }

        // 上游数据样本
        if (!string.IsNullOrWhiteSpace(upstreamSample))
        {
            sb.AppendLine("## 上游数据样本（上次执行的实际输出）");
            sb.AppendLine("```");
            sb.AppendLine(upstreamSample);
            sb.AppendLine("```");
            sb.AppendLine();
        }

        // 历史配置
        if (!string.IsNullOrWhiteSpace(lastConfigJson))
        {
            sb.AppendLine("## 上次该舱的配置");
            sb.AppendLine("```json");
            sb.AppendLine(lastConfigJson);
            sb.AppendLine("```");
            sb.AppendLine();
        }

        // 历史输出
        if (!string.IsNullOrWhiteSpace(lastOutputSummary))
        {
            sb.AppendLine("## 上次该舱的输出摘要");
            sb.AppendLine("```");
            sb.AppendLine(lastOutputSummary);
            sb.AppendLine("```");
            sb.AppendLine();
        }

        // 用户补充说明
        if (!string.IsNullOrWhiteSpace(userHint))
        {
            sb.AppendLine("## 用户补充说明");
            sb.AppendLine(userHint);
            sb.AppendLine();
        }

        return sb.ToString();
    }

    private static string BuildUserMessage(CapsuleTypeMeta capsuleMeta, string mode, string? userHint)
    {
        var sb = new StringBuilder();

        if (mode == "optimize")
        {
            sb.AppendLine("请根据上次执行的输入数据和输出结果，优化当前舱的配置参数。");
            sb.AppendLine("重点关注哪些参数可以调整以获得更好的输出效果。");
        }
        else
        {
            sb.AppendLine("请为目标舱的所有配置字段生成推荐值。");
        }

        sb.AppendLine();
        sb.AppendLine("## 输出格式要求");
        sb.AppendLine("请严格输出 JSON 格式，包含以下两个字段：");
        sb.AppendLine("1. `suggestions`: 对象，key 必须是上述字段的 key，value 是推荐的值（字符串）");
        sb.AppendLine("2. `explanation`: 字符串，简要说明推荐理由（1-3 句话）");
        sb.AppendLine();
        sb.AppendLine("## 规则");
        sb.AppendLine("- 对于 select 类型字段，必须从可选值中选择");
        sb.AppendLine("- 对于 textarea 类型字段（如 systemPrompt），给出完整内容");
        sb.AppendLine("- 对于 password 类型字段，不要生成，跳过即可");
        sb.AppendLine("- 使用 {{input}} 引用上游输入数据");
        sb.AppendLine("- 值必须是字符串类型");
        sb.AppendLine();
        sb.AppendLine("示例输出：");
        sb.AppendLine("```json");
        sb.AppendLine("{");
        sb.AppendLine("  \"suggestions\": {");
        sb.AppendLine("    \"systemPrompt\": \"你是一个数据分析专家...\",");
        sb.AppendLine("    \"outputFormat\": \"json\"");
        sb.AppendLine("  },");
        sb.AppendLine("  \"explanation\": \"根据上游 TAPD 缺陷数据的结构，推荐使用 JSON 格式输出以便后续处理。\"");
        sb.AppendLine("}");
        sb.AppendLine("```");

        return sb.ToString();
    }

    private AiFillResult ParseAiResponse(string responseText, CapsuleTypeMeta capsuleMeta)
    {
        // 尝试从响应中提取 JSON
        var jsonStr = ExtractJson(responseText);
        if (jsonStr == null)
        {
            return new AiFillResult
            {
                Suggestions = new(),
                Explanation = responseText.Length > 300 ? responseText[..300] + "..." : responseText,
                Confidence = "low",
            };
        }

        try
        {
            var options = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };
            var parsed = JsonSerializer.Deserialize<AiFillRawResponse>(jsonStr, options);

            if (parsed?.Suggestions == null)
                return new AiFillResult { Suggestions = new(), Explanation = "AI 返回格式异常", Confidence = "low" };

            // 过滤：只保留 ConfigSchema 中存在的 key，且不包含 password 字段
            var validKeys = capsuleMeta.ConfigSchema
                .Where(f => f.FieldType != "password")
                .Select(f => f.Key)
                .ToHashSet();

            var filtered = new Dictionary<string, string>();
            foreach (var kv in parsed.Suggestions)
            {
                if (validKeys.Contains(kv.Key) && kv.Value != null)
                    filtered[kv.Key] = kv.Value;
            }

            return new AiFillResult
            {
                Suggestions = filtered,
                Explanation = parsed.Explanation ?? "AI 已生成推荐配置",
                Confidence = filtered.Count > 0 ? "high" : "low",
            };
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[workflow-agent] AI fill JSON parse error");
            return new AiFillResult
            {
                Suggestions = new(),
                Explanation = "AI 返回内容解析失败",
                Confidence = "low",
            };
        }
    }

    private static string? ExtractJson(string text)
    {
        // 尝试找到 ```json ... ``` 代码块
        var start = text.IndexOf("```json", StringComparison.OrdinalIgnoreCase);
        if (start >= 0)
        {
            start = text.IndexOf('\n', start);
            if (start >= 0)
            {
                var end = text.IndexOf("```", start + 1, StringComparison.Ordinal);
                if (end > start)
                    return text[(start + 1)..end].Trim();
            }
        }

        // 尝试找到 { ... } 块
        var firstBrace = text.IndexOf('{');
        var lastBrace = text.LastIndexOf('}');
        if (firstBrace >= 0 && lastBrace > firstBrace)
            return text[firstBrace..(lastBrace + 1)];

        return null;
    }
}

// ─────────────────────────────────────────────
// Request / Response Models
// ─────────────────────────────────────────────

public class AiFillInput
{
    /// <summary>目标节点 ID</summary>
    public string NodeId { get; set; } = string.Empty;

    /// <summary>当前工作流定义</summary>
    public Workflow Workflow { get; set; } = null!;

    /// <summary>上次执行 ID（用于读取历史 input/output 产物）</summary>
    public string? LastExecutionId { get; set; }

    /// <summary>用户自然语言补充说明</summary>
    public string? UserHint { get; set; }

    /// <summary>填写模式: full | optimize</summary>
    public string Mode { get; set; } = "full";
}

public class AiFillResult
{
    /// <summary>推荐的配置值 { fieldKey: value }</summary>
    public Dictionary<string, string> Suggestions { get; set; } = new();

    /// <summary>AI 的推荐理由</summary>
    public string Explanation { get; set; } = string.Empty;

    /// <summary>置信度: low | medium | high</summary>
    public string Confidence { get; set; } = "medium";
}

/// <summary>AI 返回的原始 JSON 结构</summary>
internal class AiFillRawResponse
{
    public Dictionary<string, string>? Suggestions { get; set; }
    public string? Explanation { get; set; }
}
