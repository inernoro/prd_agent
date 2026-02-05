using System.Text.Json;
using System.Text.Json.Nodes;
using PrdAgent.Core.Models;
using PrdAgent.Core.Models.Toolbox;
using PrdAgent.Infrastructure.LlmGateway;

namespace PrdAgent.Api.Services.Toolbox;

/// <summary>
/// 意图识别器实现
/// 使用 LLM Gateway 进行意图分类
/// </summary>
public class IntentClassifier : IIntentClassifier
{
    private readonly ILlmGateway _gateway;
    private readonly ILogger<IntentClassifier> _logger;

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
        PropertyNameCaseInsensitive = true
    };

    // 意图识别 Prompt
    private const string IntentPrompt = """
        你是一个意图分类器。根据用户输入，判断用户想要执行的任务类型。

        可选类型：
        - prd_analysis: PRD分析、需求解读、缺口检测、文档分析
        - image_gen: 图片生成、视觉创作、配图、画图、生成图片
        - writing: 写作、文章、文案、文学创作、写一篇、帮我写
        - defect: 缺陷提交、Bug报告、问题追踪、报告缺陷
        - composite: 需要多个能力组合（如"写文章+配图"、"分析PRD并生成图"）
        - general: 通用对话、问候、闲聊、无法归类到以上类型

        用户输入: {USER_MESSAGE}

        请严格按照以下 JSON 格式输出，不要输出任何其他内容：
        {
          "primary_intent": "类型（从上面的选项中选择）",
          "secondary_intents": ["如果是composite，列出需要组合的能力类型"],
          "entities": {"从用户输入中提取的关键实体，如 topic, style 等"},
          "confidence": 0.0到1.0之间的数字,
          "reasoning": "简短解释为什么这样分类"
        }
        """;

    public IntentClassifier(ILlmGateway gateway, ILogger<IntentClassifier> logger)
    {
        _gateway = gateway;
        _logger = logger;
    }

    public async Task<IntentResult> ClassifyAsync(string userMessage, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(userMessage))
        {
            return new IntentResult
            {
                PrimaryIntent = IntentTypes.General,
                Confidence = 1.0,
                Reasoning = "空输入"
            };
        }

        try
        {
            // 先尝试规则匹配（快速路径）
            var ruleResult = TryRuleBasedClassification(userMessage);
            if (ruleResult != null && ruleResult.Confidence >= 0.9)
            {
                _logger.LogDebug("意图识别（规则匹配）: {Intent}, 置信度: {Confidence}",
                    ruleResult.PrimaryIntent, ruleResult.Confidence);
                return ruleResult;
            }

            // 规则无法高置信度匹配，使用 LLM
            var prompt = IntentPrompt.Replace("{USER_MESSAGE}", userMessage);

            var request = new GatewayRequest
            {
                AppCallerCode = AppCallerRegistry.AiToolbox.Orchestration.Intent,
                ModelType = ModelTypes.Intent,
                RequestBody = new JsonObject
                {
                    ["messages"] = new JsonArray
                    {
                        new JsonObject
                        {
                            ["role"] = "user",
                            ["content"] = prompt
                        }
                    },
                    ["temperature"] = 0.1,
                    ["max_tokens"] = 500
                }
            };

            var response = await _gateway.SendAsync(request, ct);

            if (!response.Success || string.IsNullOrWhiteSpace(response.Content))
            {
                _logger.LogWarning("LLM 意图识别失败: {Error}", response.ErrorMessage);
                // 降级到规则结果或默认结果
                return ruleResult ?? new IntentResult
                {
                    PrimaryIntent = IntentTypes.General,
                    Confidence = 0.5,
                    Reasoning = "LLM 调用失败，降级为通用对话"
                };
            }

            // 解析 LLM 响应
            var result = ParseLlmResponse(response.Content);

            // 填充建议的 Agent
            result.SuggestedAgents = GetSuggestedAgents(result);

            _logger.LogDebug("意图识别（LLM）: {Intent}, 置信度: {Confidence}, Agents: {Agents}",
                result.PrimaryIntent, result.Confidence, string.Join(",", result.SuggestedAgents));

            return result;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "意图识别异常");
            return new IntentResult
            {
                PrimaryIntent = IntentTypes.General,
                Confidence = 0.3,
                Reasoning = $"识别异常: {ex.Message}"
            };
        }
    }

    /// <summary>
    /// 规则匹配（快速路径）
    /// </summary>
    private IntentResult? TryRuleBasedClassification(string message)
    {
        var lower = message.ToLowerInvariant();

        // 图片生成相关关键词
        if (ContainsAny(lower, "生成图片", "画一张", "画一幅", "生成一张图", "配图", "插图", "文生图", "图生图", "生成图像"))
        {
            // 检查是否同时有写作意图
            if (ContainsAny(lower, "写", "文章", "文案", "内容"))
            {
                return new IntentResult
                {
                    PrimaryIntent = IntentTypes.Composite,
                    SecondaryIntents = new List<string> { IntentTypes.Writing, IntentTypes.ImageGen },
                    Confidence = 0.9,
                    Reasoning = "检测到写作+配图的组合需求"
                };
            }
            return new IntentResult
            {
                PrimaryIntent = IntentTypes.ImageGen,
                Confidence = 0.95,
                Reasoning = "包含图片生成相关关键词"
            };
        }

        // 写作相关关键词
        if (ContainsAny(lower, "写一篇", "帮我写", "撰写", "创作文章", "写作", "文案", "写文章"))
        {
            return new IntentResult
            {
                PrimaryIntent = IntentTypes.Writing,
                Confidence = 0.9,
                Reasoning = "包含写作相关关键词"
            };
        }

        // PRD 分析相关关键词
        if (ContainsAny(lower, "分析prd", "prd分析", "需求分析", "需求文档", "解读prd", "prd解读", "缺口检测"))
        {
            return new IntentResult
            {
                PrimaryIntent = IntentTypes.PrdAnalysis,
                Confidence = 0.9,
                Reasoning = "包含 PRD 分析相关关键词"
            };
        }

        // 缺陷相关关键词
        if (ContainsAny(lower, "提交缺陷", "报告bug", "bug报告", "缺陷报告", "问题追踪"))
        {
            return new IntentResult
            {
                PrimaryIntent = IntentTypes.Defect,
                Confidence = 0.9,
                Reasoning = "包含缺陷管理相关关键词"
            };
        }

        // 无法高置信度匹配
        return null;
    }

    private static bool ContainsAny(string text, params string[] keywords)
    {
        return keywords.Any(k => text.Contains(k, StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>
    /// 解析 LLM 响应
    /// </summary>
    private IntentResult ParseLlmResponse(string content)
    {
        try
        {
            // 尝试提取 JSON（可能被 markdown 代码块包裹）
            var jsonContent = ExtractJson(content);

            using var doc = JsonDocument.Parse(jsonContent);
            var root = doc.RootElement;

            var result = new IntentResult
            {
                PrimaryIntent = root.TryGetProperty("primary_intent", out var pi)
                    ? pi.GetString() ?? IntentTypes.General
                    : IntentTypes.General,
                Confidence = root.TryGetProperty("confidence", out var conf)
                    ? conf.GetDouble()
                    : 0.5,
                Reasoning = root.TryGetProperty("reasoning", out var reason)
                    ? reason.GetString()
                    : null
            };

            // 解析 secondary_intents
            if (root.TryGetProperty("secondary_intents", out var si) && si.ValueKind == JsonValueKind.Array)
            {
                result.SecondaryIntents = si.EnumerateArray()
                    .Select(e => e.GetString() ?? string.Empty)
                    .Where(s => !string.IsNullOrEmpty(s))
                    .ToList();
            }

            // 解析 entities
            if (root.TryGetProperty("entities", out var entities) && entities.ValueKind == JsonValueKind.Object)
            {
                foreach (var prop in entities.EnumerateObject())
                {
                    result.Entities[prop.Name] = prop.Value.ValueKind switch
                    {
                        JsonValueKind.String => prop.Value.GetString() ?? string.Empty,
                        JsonValueKind.Number => prop.Value.GetDouble(),
                        JsonValueKind.True => true,
                        JsonValueKind.False => false,
                        _ => prop.Value.ToString()
                    };
                }
            }

            return result;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "解析 LLM 意图响应失败: {Content}", content);
            return new IntentResult
            {
                PrimaryIntent = IntentTypes.General,
                Confidence = 0.5,
                Reasoning = "JSON 解析失败"
            };
        }
    }

    /// <summary>
    /// 从可能被 markdown 包裹的内容中提取 JSON
    /// </summary>
    private static string ExtractJson(string content)
    {
        content = content.Trim();

        // 尝试提取 ```json ... ``` 或 ``` ... ``` 中的内容
        if (content.Contains("```"))
        {
            var startMarkers = new[] { "```json", "```" };
            foreach (var marker in startMarkers)
            {
                var startIdx = content.IndexOf(marker, StringComparison.OrdinalIgnoreCase);
                if (startIdx >= 0)
                {
                    startIdx += marker.Length;
                    var endIdx = content.IndexOf("```", startIdx, StringComparison.Ordinal);
                    if (endIdx > startIdx)
                    {
                        return content[startIdx..endIdx].Trim();
                    }
                }
            }
        }

        // 尝试找到第一个 { 和最后一个 }
        var firstBrace = content.IndexOf('{');
        var lastBrace = content.LastIndexOf('}');
        if (firstBrace >= 0 && lastBrace > firstBrace)
        {
            return content[firstBrace..(lastBrace + 1)];
        }

        return content;
    }

    /// <summary>
    /// 根据意图获取建议的 Agent 列表
    /// </summary>
    private static List<string> GetSuggestedAgents(IntentResult intent)
    {
        var agents = new List<string>();

        if (intent.PrimaryIntent == IntentTypes.Composite)
        {
            // 组合意图：按顺序添加所有相关 Agent
            foreach (var secondaryIntent in intent.SecondaryIntents)
            {
                agents.AddRange(GetAgentKeysForIntent(secondaryIntent));
            }
        }
        else
        {
            agents.AddRange(GetAgentKeysForIntent(intent.PrimaryIntent));
        }

        return agents.Distinct().ToList();
    }

    private static IEnumerable<string> GetAgentKeysForIntent(string intent)
    {
        return intent switch
        {
            IntentTypes.PrdAnalysis => new[] { "prd-agent" },
            IntentTypes.ImageGen => new[] { "visual-agent" },
            IntentTypes.Writing => new[] { "literary-agent" },
            IntentTypes.Defect => new[] { "defect-agent" },
            _ => Array.Empty<string>()
        };
    }
}
