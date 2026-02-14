using System.Runtime.CompilerServices;
using System.Text.Json.Nodes;
using PrdAgent.Core.Models;
using PrdAgent.Core.Models.Toolbox;
using PrdAgent.Infrastructure.LlmGateway;

namespace PrdAgent.Api.Services.Toolbox.Adapters;

/// <summary>
/// 文学创作 Agent 适配器
/// 支持：写作、润色、生成大纲、生成插图
/// </summary>
public class LiteraryAgentAdapter : IAgentAdapter
{
    private readonly ILlmGateway _gateway;
    private readonly ILogger<LiteraryAgentAdapter> _logger;

    public string AgentKey => "literary-agent";
    public string DisplayName => "文学创作者";

    private static readonly HashSet<string> SupportedActions = new()
    {
        "write_content",
        "generate_outline",
        "polish",
        "generate_illustration"
    };

    public LiteraryAgentAdapter(ILlmGateway gateway, ILogger<LiteraryAgentAdapter> logger)
    {
        _gateway = gateway;
        _logger = logger;
    }

    public bool CanHandle(string action) => SupportedActions.Contains(action);

    public async Task<AgentExecutionResult> ExecuteAsync(AgentExecutionContext context, CancellationToken ct = default)
    {
        var content = new System.Text.StringBuilder();
        var artifacts = new List<ToolboxArtifact>();

        await foreach (var chunk in StreamExecuteAsync(context, ct))
        {
            if (chunk.Type == AgentChunkType.Text && chunk.Content != null)
            {
                content.Append(chunk.Content);
            }
            else if (chunk.Type == AgentChunkType.Artifact && chunk.Artifact != null)
            {
                artifacts.Add(chunk.Artifact);
            }
            else if (chunk.Type == AgentChunkType.Error)
            {
                return AgentExecutionResult.Fail(chunk.Content ?? "未知错误");
            }
        }

        return AgentExecutionResult.Ok(content.ToString(), artifacts);
    }

    public async IAsyncEnumerable<AgentStreamChunk> StreamExecuteAsync(
        AgentExecutionContext context,
        [EnumeratorCancellation] CancellationToken ct = default)
    {
        var action = context.Action;
        var userMessage = context.UserMessage;
        var previousOutput = context.GetLastOutput();

        _logger.LogInformation("Literary Agent 执行: Action={Action}, RunId={RunId}", action, context.RunId);

        string systemPrompt;
        string userPrompt;

        switch (action)
        {
            case "write_content":
                systemPrompt = """
                    你是一位专业的文学创作者。根据用户的要求，创作高质量的文字内容。
                    要求：
                    - 文笔流畅，富有感染力
                    - 结构清晰，层次分明
                    - 内容原创，不抄袭
                    直接输出创作内容，不要添加额外说明。
                    """;
                userPrompt = userMessage;
                break;

            case "generate_outline":
                systemPrompt = """
                    你是一位专业的内容策划师。根据用户的主题，生成详细的写作大纲。
                    要求：
                    - 使用 Markdown 格式
                    - 包含主标题和各级子标题
                    - 每个章节有简要说明
                    """;
                userPrompt = $"请为以下主题生成写作大纲：\n{userMessage}";
                break;

            case "polish":
                systemPrompt = """
                    你是一位专业的文字编辑。对用户提供的文字进行润色和优化。
                    要求：
                    - 保持原意不变
                    - 提升文字的流畅性和表达力
                    - 修正语法和用词问题
                    - 必须使用换行符分隔不同的段落和章节，保持良好的文本结构和可读性
                    直接输出润色后的内容。
                    """;
                var textToPolish = previousOutput ?? userMessage;
                userPrompt = $"请润色以下文字：\n{textToPolish}";
                break;

            case "generate_illustration":
                // 生成插图描述（用于后续图片生成）
                systemPrompt = """
                    你是一位专业的插画描述师。根据文字内容，生成适合的插图描述。
                    要求：
                    - 输出适合 AI 绘图的英文描述（prompt）
                    - 描述要具体、有画面感
                    - 风格要与文字内容匹配
                    只输出图片描述，不要其他说明。
                    """;
                var contentForIllustration = previousOutput ?? userMessage;
                userPrompt = $"根据以下文字生成插图描述：\n{contentForIllustration}";
                break;

            default:
                yield return AgentStreamChunk.Error($"不支持的动作: {action}");
                yield break;
        }

        var request = new GatewayRequest
        {
            AppCallerCode = AppCallerRegistry.AiToolbox.Agents.LiteraryChat,
            ModelType = ModelTypes.Chat,
            Stream = true,
            RequestBody = new JsonObject
            {
                ["messages"] = new JsonArray
                {
                    new JsonObject { ["role"] = "system", ["content"] = systemPrompt },
                    new JsonObject { ["role"] = "user", ["content"] = userPrompt }
                },
                ["temperature"] = 0.7,
                ["max_tokens"] = 4000
            }
        };

        var fullContent = new System.Text.StringBuilder();

        await foreach (var chunk in _gateway.StreamAsync(request, ct))
        {
            if (chunk.Type == GatewayChunkType.Text && !string.IsNullOrEmpty(chunk.Content))
            {
                fullContent.Append(chunk.Content);
                yield return AgentStreamChunk.Text(chunk.Content);
            }
        }

        // 创建 Markdown 成果物
        var artifact = new ToolboxArtifact
        {
            Type = ToolboxArtifactType.Markdown,
            Name = action switch
            {
                "write_content" => "创作内容.md",
                "generate_outline" => "写作大纲.md",
                "polish" => "润色结果.md",
                "generate_illustration" => "插图描述.txt",
                _ => "输出.md"
            },
            MimeType = "text/markdown",
            Content = fullContent.ToString(),
            SourceStepId = context.StepId
        };

        yield return AgentStreamChunk.ArtifactChunk(artifact);
        yield return AgentStreamChunk.Done(fullContent.ToString());
    }
}
