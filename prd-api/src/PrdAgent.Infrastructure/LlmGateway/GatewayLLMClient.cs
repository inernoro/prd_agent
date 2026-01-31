using System.Text;
using System.Text.Json.Nodes;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

namespace PrdAgent.Infrastructure.LlmGateway;

/// <summary>
/// 基于 Gateway 的 LLM 客户端
/// 实现 ILLMClient 接口，内部通过 ILlmGateway 发送所有请求
/// 这确保所有 LLM 调用都经过 Gateway 统一管理
/// </summary>
public class GatewayLLMClient : ILLMClient
{
    private readonly ILlmGateway _gateway;
    private readonly string _appCallerCode;
    private readonly string _modelType;
    private readonly string? _platformId;
    private readonly string? _platformName;
    private readonly bool _enablePromptCache;
    private readonly int _maxTokens;
    private readonly double _temperature;

    /// <summary>
    /// 创建基于 Gateway 的 LLM 客户端
    /// </summary>
    /// <param name="gateway">LLM Gateway</param>
    /// <param name="appCallerCode">应用调用标识（如 "prd-agent.chat::chat"）</param>
    /// <param name="modelType">模型类型（chat/vision/intent/generation）</param>
    /// <param name="platformId">平台 ID（可选，用于日志）</param>
    /// <param name="platformName">平台名称（可选，用于日志）</param>
    /// <param name="enablePromptCache">是否启用 Prompt Cache</param>
    /// <param name="maxTokens">最大 Token 数</param>
    /// <param name="temperature">温度参数</param>
    public GatewayLLMClient(
        ILlmGateway gateway,
        string appCallerCode,
        string modelType,
        string? platformId = null,
        string? platformName = null,
        bool enablePromptCache = true,
        int maxTokens = 4096,
        double temperature = 0.2)
    {
        _gateway = gateway;
        _appCallerCode = appCallerCode;
        _modelType = modelType;
        _platformId = platformId;
        _platformName = platformName;
        _enablePromptCache = enablePromptCache;
        _maxTokens = maxTokens;
        _temperature = temperature;
    }

    /// <inheritdoc />
    public string? PlatformId => _platformId;

    /// <inheritdoc />
    public string? PlatformName => _platformName;

    /// <inheritdoc />
    public async Task<string> StreamGenerateAsync(
        string systemPrompt,
        List<LLMMessage> messages,
        Action<string> onChunk,
        CancellationToken ct)
    {
        var requestBody = BuildRequestBody(systemPrompt, messages);

        var request = new GatewayRequest
        {
            AppCallerCode = _appCallerCode,
            ModelType = _modelType,
            RequestBody = requestBody,
            EnablePromptCache = _enablePromptCache,
            TimeoutSeconds = 120,
            Context = new GatewayRequestContext
            {
                QuestionText = messages.LastOrDefault(m => m.Role == "user")?.Content,
                SystemPromptChars = systemPrompt?.Length,
                SystemPromptText = systemPrompt?.Length > 500
                    ? systemPrompt.Substring(0, 500) + "..."
                    : systemPrompt
            }
        };

        var result = new StringBuilder();

        await foreach (var chunk in _gateway.StreamAsync(request, ct))
        {
            if (chunk.Type == GatewayChunkType.Error)
            {
                throw new InvalidOperationException(chunk.Error ?? "Gateway 返回错误");
            }

            if (!string.IsNullOrEmpty(chunk.Content))
            {
                result.Append(chunk.Content);
                onChunk(chunk.Content);
            }
        }

        return result.ToString();
    }

    /// <inheritdoc />
    public async Task<string> GenerateAsync(
        string systemPrompt,
        List<LLMMessage> messages,
        CancellationToken ct)
    {
        var requestBody = BuildRequestBody(systemPrompt, messages);

        var request = new GatewayRequest
        {
            AppCallerCode = _appCallerCode,
            ModelType = _modelType,
            RequestBody = requestBody,
            EnablePromptCache = _enablePromptCache,
            TimeoutSeconds = 120,
            Context = new GatewayRequestContext
            {
                QuestionText = messages.LastOrDefault(m => m.Role == "user")?.Content,
                SystemPromptChars = systemPrompt?.Length,
                SystemPromptText = systemPrompt?.Length > 500
                    ? systemPrompt.Substring(0, 500) + "..."
                    : systemPrompt
            }
        };

        var response = await _gateway.SendAsync(request, ct);

        if (!response.Success)
        {
            throw new InvalidOperationException(response.ErrorMessage ?? $"Gateway 返回错误: {response.ErrorCode}");
        }

        // 解析响应内容
        return ExtractContentFromResponse(response.Content);
    }

    /// <summary>
    /// 构建请求体
    /// </summary>
    private JsonObject BuildRequestBody(string systemPrompt, List<LLMMessage> messages)
    {
        var messagesArray = new JsonArray();

        // 添加系统提示
        if (!string.IsNullOrWhiteSpace(systemPrompt))
        {
            messagesArray.Add(new JsonObject
            {
                ["role"] = "system",
                ["content"] = systemPrompt
            });
        }

        // 添加消息历史
        foreach (var msg in messages)
        {
            var msgObj = new JsonObject
            {
                ["role"] = msg.Role,
                ["content"] = msg.Content
            };

            // 处理图片（Vision API）
            if (msg.ImageUrls?.Count > 0)
            {
                var contentArray = new JsonArray();

                // 添加文本
                if (!string.IsNullOrEmpty(msg.Content))
                {
                    contentArray.Add(new JsonObject
                    {
                        ["type"] = "text",
                        ["text"] = msg.Content
                    });
                }

                // 添加图片
                foreach (var imageUrl in msg.ImageUrls)
                {
                    contentArray.Add(new JsonObject
                    {
                        ["type"] = "image_url",
                        ["image_url"] = new JsonObject
                        {
                            ["url"] = imageUrl
                        }
                    });
                }

                msgObj["content"] = contentArray;
            }

            messagesArray.Add(msgObj);
        }

        return new JsonObject
        {
            ["messages"] = messagesArray,
            ["max_tokens"] = _maxTokens,
            ["temperature"] = _temperature
        };
    }

    /// <summary>
    /// 从响应中提取内容
    /// </summary>
    private static string ExtractContentFromResponse(string? responseContent)
    {
        if (string.IsNullOrWhiteSpace(responseContent))
            return string.Empty;

        try
        {
            var json = JsonNode.Parse(responseContent);

            // OpenAI 格式
            var choices = json?["choices"]?.AsArray();
            if (choices?.Count > 0)
            {
                var content = choices[0]?["message"]?["content"]?.GetValue<string>();
                if (!string.IsNullOrEmpty(content))
                    return content;
            }

            // Claude 格式
            var claudeContent = json?["content"]?.AsArray();
            if (claudeContent?.Count > 0)
            {
                var text = claudeContent[0]?["text"]?.GetValue<string>();
                if (!string.IsNullOrEmpty(text))
                    return text;
            }
        }
        catch
        {
            // 解析失败返回原始内容
        }

        return responseContent ?? string.Empty;
    }
}
