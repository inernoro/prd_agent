using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Core.Models.SpeechAgent;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;

namespace PrdAgent.Api.Services;

/// <summary>
/// 演讲智能体 — 把长文本/文档转成思维导图风格的演讲。
/// 首期模式：mindmap（思维导图）。后续可扩 outline/story/data 模式，复用同一棵 SpeechDeck/SpeechNode 结构。
/// </summary>
public class SpeechAgentService
{
    private readonly ILlmGateway _gateway;
    private readonly MongoDbContext _db;
    private readonly ILogger<SpeechAgentService> _logger;

    private const int SourceTextMaxChars = 16000;

    public SpeechAgentService(
        ILlmGateway gateway,
        MongoDbContext db,
        ILogger<SpeechAgentService> logger)
    {
        _gateway = gateway;
        _db = db;
        _logger = logger;
    }

    /// <summary>
    /// 流式生成思维导图：拆 root → 章节 → 要点。流式返回 typing 文本 + 解析完成后的节点列表。
    /// </summary>
    public async IAsyncEnumerable<SpeechGenerateEvent> GenerateMindmapAsync(
        SpeechDeck deck,
        Func<string, Task>? onTyping = null,
        Func<string, Task>? onThinking = null,
        Action<string, string>? onModel = null,
        [EnumeratorCancellation] CancellationToken ct = default)
    {
        var systemPrompt = BuildMindmapSystemPrompt(deck);
        var userMessage = BuildMindmapUserMessage(deck);

        var request = new GatewayRequest
        {
            AppCallerCode = AppCallerRegistry.SpeechAgent.Mindmap.Outline,
            ModelType = ModelTypes.Chat,
            RequestBody = new JsonObject
            {
                ["messages"] = new JsonArray
                {
                    new JsonObject { ["role"] = "system", ["content"] = systemPrompt },
                    new JsonObject { ["role"] = "user", ["content"] = userMessage },
                },
                ["temperature"] = 0.5,
                ["include_reasoning"] = true,
                ["reasoning"] = new JsonObject { ["exclude"] = false },
            },
            TimeoutSeconds = 180,
            IncludeThinking = true,
            Context = new GatewayRequestContext { UserId = deck.OwnerUserId },
        };

        var buffer = new StringBuilder();
        string? error = null;

        await foreach (var chunk in _gateway.StreamAsync(request, CancellationToken.None))
        {
            if (chunk.Type == GatewayChunkType.Start && chunk.Resolution != null)
            {
                onModel?.Invoke(chunk.Resolution.ActualModel ?? "", chunk.Resolution.ActualPlatformName ?? "");
            }
            else if (chunk.Type == GatewayChunkType.Thinking && !string.IsNullOrEmpty(chunk.Content))
            {
                if (onThinking != null)
                {
                    try { await onThinking(chunk.Content); }
                    catch (Exception cbEx) { _logger.LogDebug(cbEx, "[speech] onThinking ignored"); }
                }
            }
            else if (chunk.Type == GatewayChunkType.Text && !string.IsNullOrEmpty(chunk.Content))
            {
                buffer.Append(chunk.Content);
                if (onTyping != null)
                {
                    try { await onTyping(chunk.Content); }
                    catch (Exception cbEx) { _logger.LogDebug(cbEx, "[speech] onTyping ignored"); }
                }
            }
            else if (chunk.Type == GatewayChunkType.Error)
            {
                error = chunk.Error ?? "网关返回未知错误";
                break;
            }
        }

        if (error != null)
        {
            yield return SpeechGenerateEvent.Error(error);
            yield break;
        }

        var raw = buffer.ToString();
        if (string.IsNullOrWhiteSpace(raw))
        {
            yield return SpeechGenerateEvent.Error("LLM 返回为空");
            yield break;
        }

        var parsed = TryParseMindmapJson(raw);
        if (parsed == null)
        {
            _logger.LogWarning("[speech] 解析 JSON 失败，raw={Raw}", raw[..Math.Min(500, raw.Length)]);
            yield return SpeechGenerateEvent.Error("解析大纲失败：模型输出不符合 JSON 结构");
            yield break;
        }

        var nodes = FlattenMindmap(parsed, deck.Id);
        foreach (var n in nodes)
        {
            await _db.SpeechNodes.InsertOneAsync(n, cancellationToken: CancellationToken.None);
            yield return SpeechGenerateEvent.NodeUpserted(n);
        }

        await _db.SpeechDecks.UpdateOneAsync(
            d => d.Id == deck.Id,
            Builders<SpeechDeck>.Update
                .Set(d => d.Status, SpeechDeckStatus.Ready)
                .Set(d => d.NodeCount, nodes.Count)
                .Set(d => d.UpdatedAt, DateTime.UtcNow),
            cancellationToken: CancellationToken.None);

        yield return SpeechGenerateEvent.Done(nodes.Count);
    }

    private static string BuildMindmapSystemPrompt(SpeechDeck deck)
    {
        return $$"""
你是一位资深演讲教练。任务：把一段原始文本拆成一棵"演讲用"思维导图。

输出严格遵循以下 JSON 结构（不要加 markdown fence，不要加任何额外说明文字，只输出 JSON）：

{
  "root": { "title": "<演讲主题，不超过 24 字>", "bulletPoints": ["<开场金句 1>", "<开场金句 2>"] },
  "children": [
    {
      "title": "<一级章节标题，不超过 18 字>",
      "bulletPoints": ["<要点 1>", "<要点 2>", "<要点 3>"],
      "children": [
        { "title": "<二级要点标题>", "bulletPoints": ["<细分要点>"] }
      ]
    }
  ]
}

规则：
- 演讲风格：{{deck.Style}}；目标受众：{{deck.Audience}}；目标层级深度：{{deck.Depth}}（不要超）
- 一级章节 4-7 个；每节点 bulletPoints 2-5 条，每条不超过 30 字
- 节点之间逻辑递进，标题简短可上屏
- 不要照抄原文，要提炼+口语化改写
- 严格只输出 JSON，开头第一个字符必须是左花括号
""";
    }

    private static string BuildMindmapUserMessage(SpeechDeck deck)
    {
        var src = deck.SourceText;
        if (src.Length > SourceTextMaxChars) src = src[..SourceTextMaxChars] + "\n...（已截断）";
        return $"原始材料如下，请生成演讲思维导图：\n\n{src}";
    }

    private static MindmapJson? TryParseMindmapJson(string raw)
    {
        var json = ExtractJsonObject(raw);
        if (json == null) return null;
        try
        {
            var root = json["root"]?.AsObject();
            if (root == null) return null;
            return new MindmapJson
            {
                Root = new MindmapNode
                {
                    Title = root["title"]?.GetValue<string>() ?? "未命名",
                    BulletPoints = GetStringArray(root, "bulletPoints"),
                    Children = ParseChildren(json["children"]),
                },
            };
        }
        catch
        {
            return null;
        }
    }

    private static List<MindmapNode> ParseChildren(JsonNode? arrNode)
    {
        var result = new List<MindmapNode>();
        if (arrNode is not JsonArray arr) return result;
        foreach (var item in arr)
        {
            if (item is not JsonObject obj) continue;
            result.Add(new MindmapNode
            {
                Title = obj["title"]?.GetValue<string>() ?? "未命名",
                BulletPoints = GetStringArray(obj, "bulletPoints"),
                Children = ParseChildren(obj["children"]),
            });
        }
        return result;
    }

    private static List<string> GetStringArray(JsonObject obj, string key)
    {
        var arr = obj[key] as JsonArray;
        if (arr == null) return new();
        var list = new List<string>();
        foreach (var item in arr)
        {
            if (item is JsonValue v && v.TryGetValue<string>(out var s) && !string.IsNullOrWhiteSpace(s))
                list.Add(s.Trim());
        }
        return list;
    }

    private static JsonObject? ExtractJsonObject(string content)
    {
        var trimmed = content.Trim();
        var fenceMatch = System.Text.RegularExpressions.Regex.Match(
            trimmed, @"```(?:json)?\s*([\s\S]*?)\s*```",
            System.Text.RegularExpressions.RegexOptions.Singleline);
        var src = fenceMatch.Success ? fenceMatch.Groups[1].Value : trimmed;
        var start = src.IndexOf('{');
        var end = src.LastIndexOf('}');
        if (start < 0 || end <= start) return null;
        try
        {
            var node = JsonNode.Parse(src.Substring(start, end - start + 1));
            return node as JsonObject;
        }
        catch
        {
            return null;
        }
    }

    private static List<SpeechNode> FlattenMindmap(MindmapJson mindmap, string deckId)
    {
        var list = new List<SpeechNode>();
        var rootId = Guid.NewGuid().ToString("N");
        list.Add(new SpeechNode
        {
            Id = rootId,
            DeckId = deckId,
            ParentId = null,
            Order = 0,
            Depth = 0,
            Title = mindmap.Root.Title,
            BulletPoints = mindmap.Root.BulletPoints,
            Status = SpeechNodeStatus.Ready,
        });
        Walk(mindmap.Root.Children, rootId, 1, deckId, list);
        return list;
    }

    private static void Walk(List<MindmapNode> children, string parentId, int depth, string deckId, List<SpeechNode> sink)
    {
        for (int i = 0; i < children.Count; i++)
        {
            var child = children[i];
            var id = Guid.NewGuid().ToString("N");
            sink.Add(new SpeechNode
            {
                Id = id,
                DeckId = deckId,
                ParentId = parentId,
                Order = i,
                Depth = depth,
                Title = child.Title,
                BulletPoints = child.BulletPoints,
                Status = SpeechNodeStatus.Ready,
            });
            Walk(child.Children, id, depth + 1, deckId, sink);
        }
    }

    private class MindmapJson
    {
        public MindmapNode Root { get; set; } = new();
    }

    private class MindmapNode
    {
        public string Title { get; set; } = "";
        public List<string> BulletPoints { get; set; } = new();
        public List<MindmapNode> Children { get; set; } = new();
    }
}

public class SpeechGenerateEvent
{
    public string Kind { get; set; } = "";
    public SpeechNode? Node { get; set; }
    public string? Message { get; set; }
    public int? Count { get; set; }

    public static SpeechGenerateEvent NodeUpserted(SpeechNode n) => new() { Kind = "node", Node = n };
    public static SpeechGenerateEvent Done(int count) => new() { Kind = "done", Count = count };
    public static SpeechGenerateEvent Error(string msg) => new() { Kind = "error", Message = msg };
}
