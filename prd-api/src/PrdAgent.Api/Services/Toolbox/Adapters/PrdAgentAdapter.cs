using System.Runtime.CompilerServices;
using System.Text.Json.Nodes;
using PrdAgent.Core.Models;
using PrdAgent.Core.Models.Toolbox;
using PrdAgent.Infrastructure.LlmGateway;

namespace PrdAgent.Api.Services.Toolbox.Adapters;

/// <summary>
/// PRD 分析 Agent 适配器
/// 支持：PRD 分析、缺口检测、问题解答
/// </summary>
public class PrdAgentAdapter : IAgentAdapter
{
    private readonly ILlmGateway _gateway;
    private readonly ILogger<PrdAgentAdapter> _logger;

    public string AgentKey => "prd-agent";
    public string DisplayName => "PRD 分析师";

    private static readonly HashSet<string> SupportedActions = new()
    {
        "analyze_prd",
        "detect_gaps",
        "answer_question"
    };

    public PrdAgentAdapter(ILlmGateway gateway, ILogger<PrdAgentAdapter> logger)
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

        _logger.LogInformation("PRD Agent 执行: Action={Action}, RunId={RunId}", action, context.RunId);

        string systemPrompt;
        string userPrompt;

        switch (action)
        {
            case "analyze_prd":
                systemPrompt = """
                    你是一位资深的产品经理和需求分析师。请对用户提供的 PRD（产品需求文档）进行全面分析。

                    分析维度：
                    1. **需求完整性**：是否涵盖了功能需求、非功能需求、边界条件
                    2. **逻辑一致性**：各模块之间是否存在矛盾或冲突
                    3. **可行性评估**：技术实现难度、资源需求
                    4. **风险识别**：潜在的风险点和依赖项
                    5. **改进建议**：具体的优化方向

                    请使用 Markdown 格式输出分析报告。
                    """;
                userPrompt = userMessage;
                break;

            case "detect_gaps":
                systemPrompt = """
                    你是一位严谨的需求审核专家。请检查用户提供的 PRD 中是否存在以下类型的缺口：

                    检查清单：
                    - [ ] 用户角色定义是否完整
                    - [ ] 功能描述是否有歧义
                    - [ ] 异常流程是否有处理方案
                    - [ ] 数据流转是否清晰
                    - [ ] 接口定义是否明确
                    - [ ] 验收标准是否可量化

                    对于每个发现的缺口，请说明：
                    1. 缺口位置
                    2. 缺口类型
                    3. 影响程度（高/中/低）
                    4. 建议补充的内容

                    使用 Markdown 表格格式输出。
                    """;
                userPrompt = $"请检查以下 PRD 的内容缺口：\n{userMessage}";
                break;

            case "answer_question":
                systemPrompt = """
                    你是一位专业的产品顾问。请基于产品和需求分析的专业知识，回答用户的问题。

                    回答要求：
                    - 准确、专业
                    - 结合实际案例
                    - 提供可操作的建议
                    """;
                userPrompt = userMessage;
                break;

            default:
                yield return AgentStreamChunk.Error($"不支持的动作: {action}");
                yield break;
        }

        var request = new GatewayRequest
        {
            AppCallerCode = AppCallerRegistry.AiToolbox.Agents.PrdChat,
            ModelType = ModelTypes.Chat,
            Stream = true,
            RequestBody = new JsonObject
            {
                ["messages"] = new JsonArray
                {
                    new JsonObject { ["role"] = "system", ["content"] = systemPrompt },
                    new JsonObject { ["role"] = "user", ["content"] = userPrompt }
                },
                ["temperature"] = 0.5,
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

        // 创建分析报告成果物
        var artifact = new ToolboxArtifact
        {
            Type = ToolboxArtifactType.Markdown,
            Name = action switch
            {
                "analyze_prd" => "PRD分析报告.md",
                "detect_gaps" => "缺口检测报告.md",
                "answer_question" => "问答结果.md",
                _ => "分析结果.md"
            },
            MimeType = "text/markdown",
            Content = fullContent.ToString(),
            SourceStepId = context.StepId
        };

        yield return AgentStreamChunk.ArtifactChunk(artifact);
        yield return AgentStreamChunk.Done(fullContent.ToString());
    }
}
