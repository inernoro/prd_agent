using System.Runtime.CompilerServices;
using System.Text.Json.Nodes;
using PrdAgent.Core.Interfaces;

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

    /// <summary>AppCallerCode（用于测试断言）</summary>
    public string AppCallerCode => _appCallerCode;

    /// <summary>ModelType（用于测试断言）</summary>
    public string ModelType => _modelType;

    /// <summary>MaxTokens（用于测试断言）</summary>
    public int MaxTokens => _maxTokens;

    /// <summary>Temperature（用于测试断言）</summary>
    public double Temperature => _temperature;

    /// <summary>EnablePromptCache（用于测试断言）</summary>
    public bool EnablePromptCache => _enablePromptCache;

    /// <inheritdoc />
    public string Provider => "Gateway";

    /// <inheritdoc />
    public IAsyncEnumerable<LLMStreamChunk> StreamGenerateAsync(
        string systemPrompt,
        List<LLMMessage> messages,
        CancellationToken cancellationToken = default)
    {
        return StreamGenerateAsync(systemPrompt, messages, _enablePromptCache, cancellationToken);
    }

    /// <inheritdoc />
    public async IAsyncEnumerable<LLMStreamChunk> StreamGenerateAsync(
        string systemPrompt,
        List<LLMMessage> messages,
        bool enablePromptCache,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        var requestBody = BuildRequestBody(systemPrompt, messages);

        var request = new GatewayRequest
        {
            AppCallerCode = _appCallerCode,
            ModelType = _modelType,
            RequestBody = requestBody,
            EnablePromptCache = enablePromptCache,
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

        await foreach (var chunk in _gateway.StreamAsync(request, cancellationToken))
        {
            if (chunk.Type == GatewayChunkType.Error)
            {
                yield return new LLMStreamChunk
                {
                    Type = "error",
                    ErrorMessage = chunk.Error ?? "Gateway 返回错误"
                };
                yield break;
            }

            if (chunk.Type == GatewayChunkType.Start)
            {
                yield return new LLMStreamChunk { Type = "start" };
            }
            else if (chunk.Type == GatewayChunkType.Content && !string.IsNullOrEmpty(chunk.Content))
            {
                yield return new LLMStreamChunk
                {
                    Type = "delta",
                    Content = chunk.Content
                };
            }
            else if (chunk.Type == GatewayChunkType.Done)
            {
                yield return new LLMStreamChunk
                {
                    Type = "done",
                    InputTokens = chunk.InputTokens,
                    OutputTokens = chunk.OutputTokens,
                    CacheCreationInputTokens = chunk.CacheCreationInputTokens,
                    CacheReadInputTokens = chunk.CacheReadInputTokens
                };
            }
        }
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
                ["role"] = msg.Role
            };

            // 处理附件（图片/文档）
            if (msg.Attachments?.Count > 0)
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

                // 添加图片附件
                foreach (var attachment in msg.Attachments.Where(a => a.Type == "image"))
                {
                    contentArray.Add(new JsonObject
                    {
                        ["type"] = "image_url",
                        ["image_url"] = new JsonObject
                        {
                            ["url"] = attachment.Url
                        }
                    });
                }

                msgObj["content"] = contentArray;
            }
            else
            {
                msgObj["content"] = msg.Content;
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
}
