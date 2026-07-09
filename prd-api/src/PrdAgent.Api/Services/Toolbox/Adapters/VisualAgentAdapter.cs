using System.Runtime.CompilerServices;
using System.Text.Json.Nodes;
using PrdAgent.Core.Models;
using PrdAgent.Core.Models.Toolbox;
using PrdAgent.Infrastructure.LLM;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.LlmGateway.ImageGen;

namespace PrdAgent.Api.Services.Toolbox.Adapters;

/// <summary>
/// 视觉创作 Agent 适配器
/// 支持：文生图、图生图、图片描述
/// </summary>
public class VisualAgentAdapter : IAgentAdapter
{
    private readonly ILlmGateway _gateway;
    private readonly IImageGenerationClient _imageClient;
    private readonly ILogger<VisualAgentAdapter> _logger;

    public string AgentKey => "visual-agent";
    public string DisplayName => "视觉设计师";

    private static readonly HashSet<string> SupportedActions = new()
    {
        "text2img",
        "img2img",
        "describe_image",
        "compose"
    };

    public VisualAgentAdapter(ILlmGateway gateway, IImageGenerationClient imageClient, ILogger<VisualAgentAdapter> logger)
    {
        _gateway = gateway;
        _imageClient = imageClient;
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

        _logger.LogInformation("Visual Agent 执行: Action={Action}, RunId={RunId}", action, context.RunId);

        switch (action)
        {
            case "text2img":
                await foreach (var chunk in GenerateImageAsync(context, previousOutput, ct))
                {
                    yield return chunk;
                }
                break;

            case "describe_image":
                await foreach (var chunk in DescribeImageAsync(context, ct))
                {
                    yield return chunk;
                }
                break;

            default:
                // 对于 img2img 和 compose，MVP 阶段简化处理
                yield return AgentStreamChunk.Text($"[{action}] 功能将在后续版本支持。\n");
                yield return AgentStreamChunk.Text($"当前输入: {userMessage}");
                yield return AgentStreamChunk.Done();
                break;
        }
    }

    private async IAsyncEnumerable<AgentStreamChunk> GenerateImageAsync(
        AgentExecutionContext context,
        string? previousOutput,
        [EnumeratorCancellation] CancellationToken ct)
    {
        yield return AgentStreamChunk.Text("正在生成图片...\n");

        // 确定 prompt：优先使用前序输出（如 literary-agent 生成的插图描述）
        var prompt = previousOutput ?? context.UserMessage;

        // 如果是中文，先翻译为英文 prompt
        if (ContainsChinese(prompt))
        {
            yield return AgentStreamChunk.Text("检测到中文描述，正在优化 prompt...\n");
            prompt = await TranslateToEnglishPromptAsync(prompt, ct);
            yield return AgentStreamChunk.Text($"优化后的 prompt: {prompt}\n\n");
        }

        // 透传面板参数：尺寸 / 模型（缺省走真实客户端的模型默认 + 尺寸归一化）
        var size = context.Input.TryGetValue("size", out var sizeVal) ? sizeVal?.ToString() : null;
        var modelName = context.Input.TryGetValue("model", out var modelVal) ? modelVal?.ToString() : null;

        // 走真实生图网关客户端（与主视觉创作同一引擎）：它会按模型能力
        // 构造请求（尺寸归一化、response_format 适配、quality 仅在模型支持时下发）。
        // 不再手搓 raw body 硬塞 quality/size —— 那会被部分模型拒绝（"不支持quality"）。
        var res = await _imageClient.GenerateUnifiedAsync(
            prompt, n: 1, size: size, responseFormat: "url", ct: ct,
            appCallerCode: AppCallerRegistry.AiToolbox.Agents.VisualGeneration,
            modelName: modelName);

        if (!res.Success || res.Data == null)
        {
            yield return AgentStreamChunk.Error($"图片生成失败: {res.Error?.Message ?? "未知错误"}");
            yield break;
        }

        var image = res.Data.Images.FirstOrDefault();
        var imageUrl = image?.Url;
        var revisedPrompt = image?.RevisedPrompt;

        if (string.IsNullOrEmpty(imageUrl))
        {
            yield return AgentStreamChunk.Error("图片生成成功但未返回 URL");
            yield break;
        }

        yield return AgentStreamChunk.Text("图片生成完成！\n");

        if (!string.IsNullOrEmpty(revisedPrompt))
        {
            yield return AgentStreamChunk.Text($"AI 优化后的描述: {revisedPrompt}\n");
        }

        // 创建图片成果物
        var artifact = new ToolboxArtifact
        {
            Type = ToolboxArtifactType.Image,
            Name = "generated_image.png",
            MimeType = "image/png",
            Url = imageUrl,
            SourceStepId = context.StepId
        };

        yield return AgentStreamChunk.ArtifactChunk(artifact);
        yield return AgentStreamChunk.Done($"![生成的图片]({imageUrl})");
    }

    private async IAsyncEnumerable<AgentStreamChunk> DescribeImageAsync(
        AgentExecutionContext context,
        [EnumeratorCancellation] CancellationToken ct)
    {
        // 从 Input 中获取图片 URL
        var imageUrl = context.Input.TryGetValue("imageUrl", out var url) ? url?.ToString() : null;

        if (string.IsNullOrEmpty(imageUrl))
        {
            yield return AgentStreamChunk.Error("未提供图片 URL");
            yield break;
        }

        yield return AgentStreamChunk.Text("正在分析图片...\n");

        var request = new GatewayRequest
        {
            AppCallerCode = AppCallerRegistry.AiToolbox.Agents.VisualVision,
            ModelType = ModelTypes.Vision,
            Stream = true,
            RequestBody = new JsonObject
            {
                ["messages"] = new JsonArray
                {
                    new JsonObject
                    {
                        ["role"] = "user",
                        ["content"] = new JsonArray
                        {
                            new JsonObject
                            {
                                ["type"] = "text",
                                ["text"] = "请详细描述这张图片的内容，包括主体、背景、颜色、风格等。"
                            },
                            new JsonObject
                            {
                                ["type"] = "image_url",
                                ["image_url"] = new JsonObject { ["url"] = imageUrl }
                            }
                        }
                    }
                },
                ["max_tokens"] = 1000
            },
            Context = new GatewayRequestContext { UserId = context.UserId }
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

        yield return AgentStreamChunk.Done(fullContent.ToString());
    }

    private async Task<string> TranslateToEnglishPromptAsync(string chinesePrompt, CancellationToken ct)
    {
        var request = new GatewayRequest
        {
            AppCallerCode = AppCallerRegistry.AiToolbox.Agents.VisualChat,
            ModelType = ModelTypes.Chat,
            RequestBody = new JsonObject
            {
                ["messages"] = new JsonArray
                {
                    new JsonObject
                    {
                        ["role"] = "system",
                        ["content"] = """
                            You are a professional image prompt engineer. Translate the Chinese description into an English prompt suitable for AI image generation.
                            Requirements:
                            - Keep the core meaning
                            - Add artistic style descriptions if appropriate
                            - Use professional image generation prompt format
                            - If the description contains text that should appear in the image, specify that text must be rendered in Chinese (e.g. "with Chinese text '某某'")
                            - Output only the English prompt, nothing else
                            """
                    },
                    new JsonObject
                    {
                        ["role"] = "user",
                        ["content"] = chinesePrompt
                    }
                },
                ["temperature"] = 0.3,
                ["max_tokens"] = 500
            }
        };

        var response = await _gateway.SendAsync(request, ct);
        return response.Success && !string.IsNullOrEmpty(response.Content)
            ? response.Content.Trim()
            : chinesePrompt;
    }

    private static bool ContainsChinese(string text)
    {
        return text.Any(c => c >= 0x4E00 && c <= 0x9FFF);
    }
}
