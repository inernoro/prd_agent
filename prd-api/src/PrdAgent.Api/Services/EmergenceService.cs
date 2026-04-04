using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;

namespace PrdAgent.Api.Services;

/// <summary>
/// 涌现探索服务 — 反向自洽涌现引擎。
///
/// 核心原则：
/// - 每个节点必须有现实锚点（GroundingContent），没有锚点的节点是幻觉
/// - 一维探索：基于系统内已有能力，锚点 = 代码/API/文档证据
/// - 二维涌现：组合多个已知节点 + 标注可控假设（BridgeAssumptions）
/// - 三维幻想：在二维基础上放宽约束，但仍需标注未知数
/// - 反向验证：任何节点都能顺着引用链回溯到文档来源
/// </summary>
public class EmergenceService
{
    private readonly ILlmGateway _gateway;
    private readonly MongoDbContext _db;
    private readonly ILogger<EmergenceService> _logger;

    public EmergenceService(ILlmGateway gateway, MongoDbContext db, ILogger<EmergenceService> logger)
    {
        _gateway = gateway;
        _db = db;
        _logger = logger;
    }

    /// <summary>
    /// 探索：从一个节点出发，基于其锚点内容向下生长子节点（一维）
    /// </summary>
    public async IAsyncEnumerable<EmergenceNode> ExploreAsync(
        string treeId,
        string parentNodeId,
        string userId,
        [EnumeratorCancellation] CancellationToken ct = default)
    {
        var parentNode = await _db.EmergenceNodes
            .Find(n => n.Id == parentNodeId && n.TreeId == treeId)
            .FirstOrDefaultAsync(CancellationToken.None);

        if (parentNode == null) yield break;

        // 收集当前树的已有节点作为上下文（避免重复生成）
        var existingNodes = await _db.EmergenceNodes
            .Find(n => n.TreeId == treeId)
            .Project(n => n.Title)
            .ToListAsync(CancellationToken.None);

        var systemPrompt = BuildExploreSystemPrompt(parentNode, existingNodes);
        var userMessage = $"请基于以下节点进行一维探索（系统内能力），生成 3-5 个可直接实现的子功能。\n\n" +
                         $"当前节点：{parentNode.Title}\n" +
                         $"节点描述：{parentNode.Description}\n" +
                         $"现实锚点：{parentNode.GroundingContent}\n" +
                         $"锚点来源：{parentNode.GroundingRef ?? "无"}";

        var request = new GatewayRequest
        {
            AppCallerCode = "emergence-explorer.explore::chat",
            ModelType = "chat",
            RequestBody = new JsonObject
            {
                ["messages"] = new JsonArray
                {
                    new JsonObject { ["role"] = "system", ["content"] = systemPrompt },
                    new JsonObject { ["role"] = "user", ["content"] = userMessage }
                },
                ["temperature"] = 0.7,
            },
            TimeoutSeconds = 60,
            Context = new GatewayRequestContext { UserId = userId }
        };

        GatewayResponse response;
        try
        {
            response = await _gateway.SendAsync(request, CancellationToken.None);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[emergence] Explore LLM call failed for node {NodeId}", parentNodeId);
            yield break;
        }

        if (string.IsNullOrWhiteSpace(response.Content)) yield break;

        var nodes = ParseNodesFromResponse(response.Content, treeId, parentNodeId, dimension: 1);

        foreach (var node in nodes)
        {
            await _db.EmergenceNodes.InsertOneAsync(node, cancellationToken: CancellationToken.None);

            // 更新树的节点计数
            await _db.EmergenceTrees.UpdateOneAsync(
                t => t.Id == treeId,
                Builders<EmergenceTree>.Update
                    .Inc(t => t.NodeCount, 1)
                    .Set(t => t.UpdatedAt, DateTime.UtcNow),
                cancellationToken: CancellationToken.None);

            yield return node;
        }
    }

    /// <summary>
    /// 涌现：扫描树上所有叶子节点，两两/多节点组合生成新节点（二维+三维）
    /// </summary>
    public async IAsyncEnumerable<EmergenceNode> EmergeAsync(
        string treeId,
        bool includeFantasy,
        string userId,
        [EnumeratorCancellation] CancellationToken ct = default)
    {
        var allNodes = await _db.EmergenceNodes
            .Find(n => n.TreeId == treeId)
            .ToListAsync(CancellationToken.None);

        if (allNodes.Count < 2) yield break;

        // 找叶子节点（没有子节点的节点）
        var parentIds = allNodes.SelectMany(n => n.ParentIds).Concat(
            allNodes.Where(n => n.ParentId != null).Select(n => n.ParentId!)).ToHashSet();
        var leafNodes = allNodes.Where(n => !parentIds.Contains(n.Id)).ToList();

        if (leafNodes.Count < 2) leafNodes = allNodes; // 如果叶子不够，用全部节点

        var systemPrompt = BuildEmergeSystemPrompt(allNodes, leafNodes, includeFantasy);
        var userMessage = BuildEmergeUserMessage(leafNodes, includeFantasy);

        var request = new GatewayRequest
        {
            AppCallerCode = "emergence-explorer.emerge::chat",
            ModelType = "chat",
            RequestBody = new JsonObject
            {
                ["messages"] = new JsonArray
                {
                    new JsonObject { ["role"] = "system", ["content"] = systemPrompt },
                    new JsonObject { ["role"] = "user", ["content"] = userMessage }
                },
                ["temperature"] = includeFantasy ? 0.9 : 0.7,
            },
            TimeoutSeconds = 90,
            Context = new GatewayRequestContext { UserId = userId }
        };

        GatewayResponse response;
        try
        {
            response = await _gateway.SendAsync(request, CancellationToken.None);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[emergence] Emerge LLM call failed for tree {TreeId}", treeId);
            yield break;
        }

        if (string.IsNullOrWhiteSpace(response.Content)) yield break;

        var dimension = includeFantasy ? 3 : 2;
        var nodes = ParseEmergeNodesFromResponse(response.Content, treeId, leafNodes, dimension);

        foreach (var node in nodes)
        {
            await _db.EmergenceNodes.InsertOneAsync(node, cancellationToken: CancellationToken.None);
            await _db.EmergenceTrees.UpdateOneAsync(
                t => t.Id == treeId,
                Builders<EmergenceTree>.Update
                    .Inc(t => t.NodeCount, 1)
                    .Set(t => t.UpdatedAt, DateTime.UtcNow),
                cancellationToken: CancellationToken.None);

            yield return node;
        }
    }

    // ── Prompt 构建 ──

    private static string BuildExploreSystemPrompt(EmergenceNode parent, List<string> existingTitles)
    {
        var sb = new StringBuilder();
        sb.AppendLine("你是一个涌现探索引擎，遵循「反向自洽」原则：");
        sb.AppendLine("1. 每个生成的节点必须有现实锚点（grounding），标明它依赖的具体代码/API/文档");
        sb.AppendLine("2. 不能凭空编造功能，必须基于父节点的现实能力向下派生");
        sb.AppendLine("3. 生成的节点不能与已有节点重复");
        sb.AppendLine();
        sb.AppendLine("## 已有节点（避免重复）");
        foreach (var title in existingTitles.Take(20))
            sb.AppendLine($"- {title}");
        sb.AppendLine();
        sb.AppendLine("## 输出格式（严格 JSON 数组）");
        sb.AppendLine("```json");
        sb.AppendLine("[");
        sb.AppendLine("  {");
        sb.AppendLine("    \"title\": \"功能名称\",");
        sb.AppendLine("    \"description\": \"一句话描述\",");
        sb.AppendLine("    \"groundingContent\": \"现实锚点：这个功能依赖什么已有能力（代码路径/API/模型）\",");
        sb.AppendLine("    \"groundingType\": \"capability|code|api|document\",");
        sb.AppendLine("    \"groundingRef\": \"具体引用（文件路径或 API 路由）\",");
        sb.AppendLine("    \"techPlan\": \"简要技术方案（2-3 句）\",");
        sb.AppendLine("    \"valueScore\": 4,");
        sb.AppendLine("    \"difficultyScore\": 2,");
        sb.AppendLine("    \"tags\": [\"标签1\", \"标签2\"]");
        sb.AppendLine("  }");
        sb.AppendLine("]");
        sb.AppendLine("```");
        sb.AppendLine("只输出 JSON，不要多余解释。");
        return sb.ToString();
    }

    private static string BuildEmergeSystemPrompt(
        List<EmergenceNode> allNodes,
        List<EmergenceNode> leafNodes,
        bool includeFantasy)
    {
        var sb = new StringBuilder();
        sb.AppendLine("你是一个涌现组合引擎，遵循「反向自洽」原则：");
        sb.AppendLine("1. 涌现 = 将多个已知节点交叉组合，发现新的可能性");
        sb.AppendLine("2. 每个涌现节点必须标明它组合了哪些源节点（parentTitles）");
        sb.AppendLine("3. 必须标注「桥梁假设」——组合成立需要的前提条件（可控未知数）");
        sb.AppendLine("4. 涌现不是随机拼凑，而是「A + B 自然产生 C」的逻辑推演");
        sb.AppendLine();

        if (includeFantasy)
        {
            sb.AppendLine("## 三维幻想模式已开启");
            sb.AppendLine("在二维组合的基础上，可以放宽技术约束，想象 3-5 年后的可能性。");
            sb.AppendLine("但仍然必须标注「假设条件」——幻想的前提是什么。");
            sb.AppendLine("幻想不是胡说，是「如果 X 成立，那么 Y 就自然涌现」的有根推演。");
            sb.AppendLine();
        }

        sb.AppendLine("## 输出格式（严格 JSON 数组）");
        sb.AppendLine("```json");
        sb.AppendLine("[");
        sb.AppendLine("  {");
        sb.AppendLine("    \"title\": \"涌现功能名称\",");
        sb.AppendLine("    \"description\": \"一句话描述\",");
        sb.AppendLine("    \"parentTitles\": [\"源节点A\", \"源节点B\"],");
        sb.AppendLine("    \"groundingContent\": \"组合逻辑：A 提供 X 能力 + B 提供 Y 能力 = 自然产生 Z\",");
        sb.AppendLine("    \"bridgeAssumptions\": [\"假设条件1\", \"假设条件2\"],");
        sb.AppendLine("    \"techPlan\": \"简要技术方案（2-3 句）\",");
        sb.AppendLine("    \"valueScore\": 5,");
        sb.AppendLine("    \"difficultyScore\": 3,");
        sb.AppendLine("    \"tags\": [\"标签1\"]");
        sb.AppendLine("  }");
        sb.AppendLine("]");
        sb.AppendLine("```");
        sb.AppendLine("只输出 JSON，不要多余解释。");
        return sb.ToString();
    }

    private static string BuildEmergeUserMessage(List<EmergenceNode> leafNodes, bool includeFantasy)
    {
        var sb = new StringBuilder();
        sb.AppendLine(includeFantasy
            ? "请对以下节点进行三维幻想涌现（可放宽技术约束），生成 2-4 个涌现功能。"
            : "请对以下节点进行二维跨系统涌现（组合已有节点 + 引入外部能力），生成 2-4 个涌现功能。");
        sb.AppendLine();
        sb.AppendLine("## 可用节点");
        foreach (var node in leafNodes.Take(15))
        {
            sb.AppendLine($"### {node.Title}");
            sb.AppendLine($"- 描述：{node.Description}");
            sb.AppendLine($"- 锚点：{node.GroundingContent}");
            sb.AppendLine();
        }
        return sb.ToString();
    }

    // ── 响应解析 ──

    private static List<EmergenceNode> ParseNodesFromResponse(
        string content, string treeId, string parentNodeId, int dimension)
    {
        var nodes = new List<EmergenceNode>();
        try
        {
            var json = ExtractJsonArray(content);
            if (json == null) return nodes;

            foreach (var item in json)
            {
                if (item is not JsonObject obj) continue;
                nodes.Add(new EmergenceNode
                {
                    TreeId = treeId,
                    ParentId = parentNodeId,
                    ParentIds = new List<string> { parentNodeId },
                    Title = obj["title"]?.GetValue<string>() ?? "未命名",
                    Description = obj["description"]?.GetValue<string>() ?? "",
                    GroundingContent = obj["groundingContent"]?.GetValue<string>() ?? "",
                    GroundingType = obj["groundingType"]?.GetValue<string>() ?? EmergenceGroundingType.Capability,
                    GroundingRef = obj["groundingRef"]?.GetValue<string>(),
                    TechPlan = obj["techPlan"]?.GetValue<string>(),
                    ValueScore = GetIntValue(obj, "valueScore", 3),
                    DifficultyScore = GetIntValue(obj, "difficultyScore", 3),
                    Dimension = dimension,
                    NodeType = EmergenceNodeType.Capability,
                    Tags = GetStringArray(obj, "tags"),
                });
            }
        }
        catch (Exception)
        {
            // 解析失败时返回空列表，不阻断流程
        }
        return nodes;
    }

    private static List<EmergenceNode> ParseEmergeNodesFromResponse(
        string content, string treeId, List<EmergenceNode> leafNodes, int dimension)
    {
        var nodes = new List<EmergenceNode>();
        var titleToId = leafNodes.ToDictionary(n => n.Title, n => n.Id, StringComparer.OrdinalIgnoreCase);

        try
        {
            var json = ExtractJsonArray(content);
            if (json == null) return nodes;

            foreach (var item in json)
            {
                if (item is not JsonObject obj) continue;

                // 解析 parentTitles → parentIds
                var parentTitles = GetStringArray(obj, "parentTitles");
                var parentIds = parentTitles
                    .Select(t => titleToId.TryGetValue(t, out var id) ? id : null)
                    .Where(id => id != null)
                    .Select(id => id!)
                    .ToList();

                // 至少需要一个有效的父节点
                if (parentIds.Count == 0 && leafNodes.Count >= 2)
                {
                    parentIds = leafNodes.Take(2).Select(n => n.Id).ToList();
                }

                nodes.Add(new EmergenceNode
                {
                    TreeId = treeId,
                    ParentId = parentIds.FirstOrDefault(),
                    ParentIds = parentIds,
                    Title = obj["title"]?.GetValue<string>() ?? "未命名",
                    Description = obj["description"]?.GetValue<string>() ?? "",
                    GroundingContent = obj["groundingContent"]?.GetValue<string>() ?? "",
                    GroundingType = EmergenceGroundingType.Capability,
                    BridgeAssumptions = GetStringArray(obj, "bridgeAssumptions"),
                    TechPlan = obj["techPlan"]?.GetValue<string>(),
                    ValueScore = GetIntValue(obj, "valueScore", 4),
                    DifficultyScore = GetIntValue(obj, "difficultyScore", 3),
                    Dimension = dimension,
                    NodeType = dimension == 3 ? EmergenceNodeType.Fantasy : EmergenceNodeType.Combination,
                    Tags = GetStringArray(obj, "tags"),
                });
            }
        }
        catch (Exception)
        {
            // 解析失败时返回空列表
        }
        return nodes;
    }

    // ── 工具方法 ──

    private static JsonArray? ExtractJsonArray(string content)
    {
        // 从 LLM 响应中提取 JSON 数组（可能包裹在 ```json ``` 中）
        var start = content.IndexOf('[');
        var end = content.LastIndexOf(']');
        if (start < 0 || end <= start) return null;

        var jsonStr = content[start..(end + 1)];
        return JsonSerializer.Deserialize<JsonArray>(jsonStr);
    }

    private static int GetIntValue(JsonObject obj, string key, int defaultValue)
    {
        if (obj.TryGetPropertyValue(key, out var node) && node != null)
        {
            try { return node.GetValue<int>(); }
            catch { return defaultValue; }
        }
        return defaultValue;
    }

    private static List<string> GetStringArray(JsonObject obj, string key)
    {
        if (obj.TryGetPropertyValue(key, out var node) && node is JsonArray arr)
        {
            return arr
                .Select(n => n?.GetValue<string>())
                .Where(s => !string.IsNullOrEmpty(s))
                .Select(s => s!)
                .ToList();
        }
        return new();
    }
}
