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
    private readonly SystemCapabilityScanner _capabilityScanner;
    private readonly ILogger<EmergenceService> _logger;

    public EmergenceService(
        ILlmGateway gateway,
        MongoDbContext db,
        SystemCapabilityScanner capabilityScanner,
        ILogger<EmergenceService> logger)
    {
        _gateway = gateway;
        _db = db;
        _capabilityScanner = capabilityScanner;
        _logger = logger;
    }

    /// <summary>
    /// 探索：从一个节点出发，基于其锚点内容向下生长子节点（一维）
    /// </summary>
    public async IAsyncEnumerable<EmergenceNode> ExploreAsync(
        string treeId,
        string parentNodeId,
        string userId,
        Action<string>? onError = null,
        string? userPrompt = null,
        [EnumeratorCancellation] CancellationToken ct = default)
    {
        var parentNode = await _db.EmergenceNodes
            .Find(n => n.Id == parentNodeId && n.TreeId == treeId)
            .FirstOrDefaultAsync(CancellationToken.None);

        if (parentNode == null) yield break;

        // 获取树的配置（决定是否注入系统能力）
        var tree = await _db.EmergenceTrees
            .Find(t => t.Id == treeId)
            .FirstOrDefaultAsync(CancellationToken.None);

        if (tree == null) yield break;

        // 收集当前树的已有节点作为上下文（避免重复生成）
        var existingNodes = await _db.EmergenceNodes
            .Find(n => n.TreeId == treeId)
            .Project(n => n.Title)
            .ToListAsync(CancellationToken.None);

        // 种子内容 = 主上下文（永远是根）
        // 系统能力 = 可选辅助上下文（用户选择时才注入）
        var systemContext = tree.InjectSystemCapabilities
            ? _capabilityScanner.GetCapabilities()
            : null;

        var systemPrompt = BuildExploreSystemPrompt(parentNode, existingNodes, tree.SeedContent, systemContext);
        var userMessage = $"请基于以下节点进行探索，生成 3-5 个子功能。\n\n" +
                         $"当前节点：{parentNode.Title}\n" +
                         $"节点描述：{parentNode.Description}\n" +
                         $"现实锚点：{parentNode.GroundingContent}\n" +
                         $"锚点来源：{parentNode.GroundingRef ?? "无"}";

        if (!string.IsNullOrWhiteSpace(userPrompt))
        {
            userMessage += $"\n\n用户补充灵感方向：{userPrompt.Trim()}\n请优先围绕该方向发散，但仍要保证基于现实锚点、不编造能力。";
        }

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
            TimeoutSeconds = 120,
            Context = new GatewayRequestContext { UserId = userId }
        };

        GatewayResponse response;
        try
        {
            _logger.LogInformation("[emergence] Explore: sending LLM request for node {NodeId}, AppCaller={AppCaller}",
                parentNodeId, request.AppCallerCode);
            response = await _gateway.SendAsync(request, CancellationToken.None);
            _logger.LogInformation("[emergence] Explore: LLM response received, success={Success}, content length={Len}, error={Error}",
                response.Success, response.Content?.Length ?? 0, response.ErrorMessage);
        }
        catch (Exception ex)
        {
            var errMsg = $"LLM 调用异常: {ex.Message}";
            _logger.LogError(ex, "[emergence] Explore LLM call failed for node {NodeId}: {Error}", parentNodeId, ex.Message);
            onError?.Invoke(errMsg);
            yield break;
        }

        if (!response.Success)
        {
            var errMsg = $"LLM 调用失败: {response.ErrorMessage ?? response.ErrorCode ?? "未知错误"}";
            _logger.LogWarning("[emergence] Explore: LLM returned error for node {NodeId}: {Error}", parentNodeId, errMsg);
            onError?.Invoke(errMsg);
            yield break;
        }

        if (string.IsNullOrWhiteSpace(response.Content))
        {
            var errMsg = "LLM 返回空内容（模型响应为空）";
            _logger.LogWarning("[emergence] Explore: empty content for node {NodeId}", parentNodeId);
            onError?.Invoke(errMsg);
            yield break;
        }

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
        Action<string>? onError = null,
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

        if (leafNodes.Count < 2) leafNodes = allNodes;

        var tree = await _db.EmergenceTrees
            .Find(t => t.Id == treeId)
            .FirstOrDefaultAsync(CancellationToken.None);

        if (tree == null) yield break;

        var systemContext = tree.InjectSystemCapabilities
            ? _capabilityScanner.GetCapabilities()
            : null;

        var systemPrompt = BuildEmergeSystemPrompt(allNodes, leafNodes, includeFantasy, tree.SeedContent, systemContext);
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
            TimeoutSeconds = 120,
            Context = new GatewayRequestContext { UserId = userId }
        };

        GatewayResponse response;
        try
        {
            response = await _gateway.SendAsync(request, CancellationToken.None);
        }
        catch (Exception ex)
        {
            var errMsg = $"LLM 调用异常: {ex.Message}";
            _logger.LogError(ex, "[emergence] Emerge LLM call failed for tree {TreeId}: {Error}", treeId, ex.Message);
            onError?.Invoke(errMsg);
            yield break;
        }

        if (!response.Success)
        {
            var errMsg = $"LLM 调用失败: {response.ErrorMessage ?? response.ErrorCode ?? "未知错误"}";
            onError?.Invoke(errMsg);
            yield break;
        }

        if (string.IsNullOrWhiteSpace(response.Content))
        {
            onError?.Invoke("LLM 返回空内容（模型响应为空）");
            yield break;
        }

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

    private static string BuildExploreSystemPrompt(
        EmergenceNode parent, List<string> existingTitles,
        string seedContent, string? systemCapabilities)
    {
        var sb = new StringBuilder();
        sb.AppendLine("你是一个通用涌现探索引擎。你的任务是深入分析用户提供的种子文档，从中推演出可行的子功能或子方向。");
        sb.AppendLine();

        // ── 种子文档 = 主上下文（永远是根）──
        sb.AppendLine("## 种子文档（你的分析基础，所有涌现必须从这里出发）");
        sb.AppendLine(seedContent.Length > 3000 ? seedContent[..3000] + "\n...(已截取)" : seedContent);
        sb.AppendLine();

        // ── 系统能力 = 可选辅助上下文 ──
        if (systemCapabilities != null)
        {
            sb.AppendLine("## 辅助上下文：当前系统已有能力（可选参考）");
            sb.AppendLine("以下是运行时扫描的系统真实能力。涌现时可以结合这些已有能力，但不限于此。");
            sb.Append(systemCapabilities);
            sb.AppendLine();
        }

        sb.AppendLine("## 原则");
        sb.AppendLine("1. 每个节点必须有现实锚点——标明它依据种子文档中的哪段内容推演而来");
        sb.AppendLine("2. 如果结合了系统能力，标明依赖哪个具体组件");
        sb.AppendLine("3. 如果功能需要当前不具备的能力，在 missingCapabilities 中列出，并建议借用方式");
        sb.AppendLine("4. 节点不能与已有节点重复");
        sb.AppendLine();
        sb.AppendLine("## 已有节点（避免重复）");
        foreach (var title in existingTitles.Take(20))
            sb.AppendLine($"- {title}");
        sb.AppendLine();
        sb.AppendLine("## 输出格式（严格 JSON 数组，3-5 个节点）");
        sb.AppendLine("```json");
        sb.AppendLine("[{");
        sb.AppendLine("  \"title\": \"功能名称（4-10 字）\",");
        sb.AppendLine("  \"description\": \"一句话描述用户价值\",");
        sb.AppendLine("  \"groundingContent\": \"源自种子文档：'XXX' → 推演出 YYY\",");
        sb.AppendLine("  \"groundingType\": \"document|capability|code|api\",");
        sb.AppendLine("  \"groundingRef\": \"种子文档关键段落 或 系统组件引用\",");
        sb.AppendLine("  \"techPlan\": \"实现思路（2-3 句）\",");
        sb.AppendLine("  \"missingCapabilities\": [],");
        sb.AppendLine("  \"valueScore\": 4, \"difficultyScore\": 2,");
        sb.AppendLine("  \"tags\": [\"标签\"]");
        sb.AppendLine("}]");
        sb.AppendLine("```");
        sb.AppendLine("missingCapabilities：完全可实现传 []，需要外部能力则列出缺什么+建议借用方式。");
        sb.AppendLine("只输出 JSON。");
        return sb.ToString();
    }

    private static string BuildEmergeSystemPrompt(
        List<EmergenceNode> allNodes,
        List<EmergenceNode> leafNodes,
        bool includeFantasy,
        string seedContent,
        string? systemCapabilities)
    {
        var sb = new StringBuilder();
        sb.AppendLine("你是一个通用涌现组合引擎。将多个已有节点交叉组合，发现「A + B 自然产生 C」的涌现价值。");
        sb.AppendLine();

        // 种子文档始终在场
        sb.AppendLine("## 种子文档（涌现的源头）");
        sb.AppendLine(seedContent.Length > 2000 ? seedContent[..2000] + "\n...(已截取)" : seedContent);
        sb.AppendLine();

        if (systemCapabilities != null)
        {
            sb.AppendLine("## 辅助上下文：系统已有能力");
            sb.Append(systemCapabilities);
            sb.AppendLine();
        }

        sb.AppendLine("## 原则");
        sb.AppendLine("1. 涌现 ≠ 随机拼凑。A 提供 X + B 提供 Y → 自然产生 Z");
        sb.AppendLine("2. 必须标注「桥梁假设」——组合成立需要什么前提");
        sb.AppendLine("3. parentTitles 必须是下方节点的确切标题");
        sb.AppendLine("4. 缺失能力写入 missingCapabilities，建议借用方式");

        if (includeFantasy)
        {
            sb.AppendLine();
            sb.AppendLine("## 三维幻想模式");
            sb.AppendLine("放宽约束，想象 3-5 年后。但仍需标注假设条件，从现有节点出发推演。");
        }

        sb.AppendLine();
        sb.AppendLine("## 输出格式（严格 JSON 数组，2-4 个节点）");
        sb.AppendLine("```json");
        sb.AppendLine("[{");
        sb.AppendLine("  \"title\": \"涌现功能名称（4-10 字）\",");
        sb.AppendLine("  \"description\": \"一句话描述用户价值\",");
        sb.AppendLine("  \"parentTitles\": [\"源节点A的确切标题\", \"源节点B的确切标题\"],");
        sb.AppendLine("  \"groundingContent\": \"A 提供 X + B 提供 Y = 自然产生 Z\",");
        sb.AppendLine("  \"bridgeAssumptions\": [\"假设条件\"],");
        sb.AppendLine("  \"missingCapabilities\": [],");
        sb.AppendLine("  \"techPlan\": \"实现思路\",");
        sb.AppendLine("  \"valueScore\": 5, \"difficultyScore\": 3,");
        sb.AppendLine("  \"tags\": [\"标签\"]");
        sb.AppendLine("}]");
        sb.AppendLine("```");
        sb.AppendLine("只输出 JSON。");
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
                    MissingCapabilities = GetStringArray(obj, "missingCapabilities"),
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
                    MissingCapabilities = GetStringArray(obj, "missingCapabilities"),
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
