using System.Runtime.CompilerServices;
using System.Text.Json.Nodes;
using PrdAgent.Core.Models;
using PrdAgent.Core.Models.Toolbox;
using PrdAgent.Infrastructure.LlmGateway;

namespace PrdAgent.Api.Services.Toolbox.Adapters;

/// <summary>
/// 缺陷管理 Agent 适配器
/// 支持：缺陷提取、分类、生成报告
/// </summary>
public class DefectAgentAdapter : IAgentAdapter
{
    private readonly ILlmGateway _gateway;
    private readonly ILogger<DefectAgentAdapter> _logger;

    public string AgentKey => "defect-agent";
    public string DisplayName => "缺陷管理员";

    private static readonly HashSet<string> SupportedActions = new()
    {
        "extract_defect",
        "classify",
        "generate_report"
    };

    public DefectAgentAdapter(ILlmGateway gateway, ILogger<DefectAgentAdapter> logger)
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

        _logger.LogInformation("Defect Agent 执行: Action={Action}, RunId={RunId}", action, context.RunId);

        string systemPrompt;
        string userPrompt;

        switch (action)
        {
            case "extract_defect":
                systemPrompt = """
                    你是一位专业的软件测试工程师。请从用户描述中提取结构化的缺陷信息。

                    提取的信息应包括：
                    1. **缺陷标题**：简洁描述问题
                    2. **缺陷描述**：详细说明问题现象
                    3. **复现步骤**：如何重现该问题
                    4. **预期结果**：正确的行为应该是什么
                    5. **实际结果**：当前的错误行为
                    6. **严重程度**：致命/严重/一般/轻微
                    7. **优先级**：紧急/高/中/低
                    8. **影响范围**：受影响的功能模块

                    使用 Markdown 格式输出。
                    """;
                userPrompt = $"请从以下描述中提取缺陷信息：\n{userMessage}";
                break;

            case "classify":
                systemPrompt = """
                    你是一位缺陷分类专家。请对用户描述的缺陷进行分类。

                    分类维度：
                    1. **缺陷类型**：功能缺陷/性能问题/UI问题/兼容性/安全漏洞/其他
                    2. **所属模块**：根据描述推断所属功能模块
                    3. **根因分析**：初步判断可能的原因
                    4. **修复建议**：建议的修复方向

                    使用 JSON 格式输出分类结果。
                    """;
                userPrompt = $"请对以下缺陷进行分类：\n{userMessage}";
                break;

            case "generate_report":
                systemPrompt = """
                    你是一位测试报告撰写专家。请根据用户提供的缺陷信息，生成专业的缺陷报告。

                    报告格式：
                    # 缺陷报告

                    ## 基本信息
                    - 报告日期：[当前日期]
                    - 报告人：[待填写]

                    ## 缺陷详情
                    [结构化的缺陷信息]

                    ## 影响评估
                    [对系统/用户的影响分析]

                    ## 建议措施
                    [修复优先级和建议]
                    """;
                userPrompt = $"请根据以下信息生成缺陷报告：\n{userMessage}";
                break;

            default:
                yield return AgentStreamChunk.Error($"不支持的动作: {action}");
                yield break;
        }

        var request = new GatewayRequest
        {
            AppCallerCode = AppCallerRegistry.AiToolbox.Agents.DefectChat,
            ModelType = ModelTypes.Chat,
            Stream = true,
            RequestBody = new JsonObject
            {
                ["messages"] = new JsonArray
                {
                    new JsonObject { ["role"] = "system", ["content"] = systemPrompt },
                    new JsonObject { ["role"] = "user", ["content"] = userPrompt }
                },
                ["temperature"] = 0.3,
                ["max_tokens"] = 2000
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

        // 创建缺陷报告成果物
        var artifact = new ToolboxArtifact
        {
            Type = ToolboxArtifactType.Markdown,
            Name = action switch
            {
                "extract_defect" => "缺陷信息.md",
                "classify" => "缺陷分类.json",
                "generate_report" => "缺陷报告.md",
                _ => "输出.md"
            },
            MimeType = action == "classify" ? "application/json" : "text/markdown",
            Content = fullContent.ToString(),
            SourceStepId = context.StepId
        };

        yield return AgentStreamChunk.ArtifactChunk(artifact);
        yield return AgentStreamChunk.Done(fullContent.ToString());
    }
}
