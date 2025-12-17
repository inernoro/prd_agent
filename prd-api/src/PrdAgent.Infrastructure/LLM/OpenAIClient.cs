using System.Runtime.CompilerServices;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using PrdAgent.Core.Interfaces;

namespace PrdAgent.Infrastructure.LLM;

/// <summary>
/// OpenAI API客户端
/// </summary>
public class OpenAIClient : ILLMClient
{
    private readonly HttpClient _httpClient;
    private readonly string _apiKey;
    private readonly string _model;
    private readonly int _maxTokens;
    private readonly double _temperature;
    private readonly bool _defaultEnablePromptCache;
    private readonly ILlmRequestLogWriter? _logWriter;
    private readonly ILLMRequestContextAccessor? _contextAccessor;

    public string Provider => "OpenAI";

    public OpenAIClient(
        HttpClient httpClient,
        string apiKey,
        string model = "gpt-4-turbo",
        int maxTokens = 4096,
        double temperature = 0.7,
        bool enablePromptCache = true,
        ILlmRequestLogWriter? logWriter = null,
        ILLMRequestContextAccessor? contextAccessor = null)
    {
        _httpClient = httpClient;
        _apiKey = apiKey;
        _model = model;
        _maxTokens = maxTokens;
        _temperature = temperature;
        _defaultEnablePromptCache = enablePromptCache;
        _logWriter = logWriter;
        _contextAccessor = contextAccessor;

        // 允许外部（例如 Program / 管理后台配置）预先设置 BaseAddress
        _httpClient.BaseAddress ??= new Uri("https://api.openai.com/");

        // Authorization 头不允许多值：使用可覆盖写法，避免重复 Add 导致异常
        _httpClient.DefaultRequestHeaders.Remove("Authorization");
        if (!string.IsNullOrWhiteSpace(_apiKey))
        {
            _httpClient.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", _apiKey);
        }
    }

    public IAsyncEnumerable<LLMStreamChunk> StreamGenerateAsync(
        string systemPrompt,
        List<LLMMessage> messages,
        CancellationToken cancellationToken = default)
    {
        return StreamGenerateAsync(systemPrompt, messages, enablePromptCache: _defaultEnablePromptCache, cancellationToken);
    }

    public async IAsyncEnumerable<LLMStreamChunk> StreamGenerateAsync(
        string systemPrompt,
        List<LLMMessage> messages,
        bool enablePromptCache,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        // OpenAI/兼容平台通常不暴露类似 Claude 的 cache_control 开关：
        // - enablePromptCache=true：允许平台自行进行 prompt caching（如果平台支持）
        // - enablePromptCache=false：注入最小 cache-bust 标记，尽量避免命中平台缓存
        var systemPromptFinal = systemPrompt;
        if (!enablePromptCache)
        {
            // 注意：不写入任何敏感信息，仅用于破坏缓存键
            systemPromptFinal = (systemPrompt ?? string.Empty) + $"\n\n[internal_cache_bust:{Guid.NewGuid():N}]";
        }
        systemPromptFinal ??= string.Empty;
        messages ??= new List<LLMMessage>();

        var allMessages = new List<OpenAIRequestMessage>
        {
            new() { Role = "system", Content = systemPromptFinal }
        };

        foreach (var message in messages)
        {
            allMessages.Add(new OpenAIRequestMessage
            {
                Role = message.Role,
                Content = BuildMessageContent(message)
            });
        }

        var requestBody = new OpenAIRequest
        {
            Model = _model,
            MaxTokens = _maxTokens,
            Temperature = _temperature,
            Messages = allMessages,
            Stream = true,
            StreamOptions = new OpenAIStreamOptions { IncludeUsage = true }
        };

        // 日志：请求（脱敏）
        var ctx = _contextAccessor?.Current;
        var requestId = ctx?.RequestId ?? Guid.NewGuid().ToString();
        var startedAt = DateTime.UtcNow;
        string? logId = null;
        if (_logWriter != null)
        {
            var systemRedacted = ctx?.SystemPromptRedacted ?? "[SYSTEM_PROMPT_REDACTED]";
            var reqRedacted = new
            {
                model = _model,
                max_tokens = _maxTokens,
                temperature = _temperature,
                stream = true,
                stream_options = new { include_usage = true },
                messages = new object[]
                {
                    new { role = "system", content = systemRedacted }
                }.Concat(messages.Select(m => new
                {
                    role = m.Role,
                    content = "[REDACTED]"
                })).ToArray()
            };

            var reqRedactedJson = JsonSerializer.Serialize(reqRedacted);
            logId = await _logWriter.StartAsync(
                new LlmLogStart(
                    RequestId: requestId,
                    Provider: Provider,
                    Model: _model,
                    ApiBase: _httpClient.BaseAddress?.ToString(),
                    Path: "v1/chat/completions",
                    RequestHeadersRedacted: new Dictionary<string, string>
                    {
                        ["content-type"] = "application/json",
                        ["authorization"] = "Bearer ***"
                    },
                    RequestBodyRedacted: reqRedactedJson,
                    RequestBodyHash: LlmLogRedactor.Sha256Hex(reqRedactedJson),
                    SystemPromptChars: (systemPrompt ?? string.Empty).Length,
                    SystemPromptHash: LlmLogRedactor.Sha256Hex(systemRedacted),
                    MessageCount: messages.Count + 1,
                    GroupId: ctx?.GroupId,
                    SessionId: ctx?.SessionId,
                    UserId: ctx?.UserId,
                    ViewRole: ctx?.ViewRole,
                    DocumentChars: ctx?.DocumentChars,
                    DocumentHash: ctx?.DocumentHash,
                    StartedAt: startedAt),
                cancellationToken);
        }

        var content = new StringContent(
            JsonSerializer.Serialize(requestBody, LLMJsonContext.Default.OpenAIRequest),
            Encoding.UTF8,
            "application/json");

        var request = new HttpRequestMessage(HttpMethod.Post, "v1/chat/completions")
        {
            Content = content
        };

        using var response = await _httpClient.SendAsync(
            request,
            HttpCompletionOption.ResponseHeadersRead,
            cancellationToken);

        if (!response.IsSuccessStatusCode)
        {
            var error = await response.Content.ReadAsStringAsync(cancellationToken);
            if (logId != null)
            {
                _logWriter?.MarkError(logId, $"OpenAI API error: {response.StatusCode}", (int)response.StatusCode);
            }
            yield return new LLMStreamChunk
            {
                Type = "error",
                ErrorMessage = $"OpenAI API error: {response.StatusCode} - {error}"
            };
            yield break;
        }

        yield return new LLMStreamChunk { Type = "start" };

        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var reader = new StreamReader(stream);

        int inputTokens = 0;
        int outputTokens = 0;
        int cacheReadInputTokens = 0;
        var firstByteMarked = false;
        var assembledChars = 0;
        using var hasher = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);

        while (!reader.EndOfStream && !cancellationToken.IsCancellationRequested)
        {
            var line = await reader.ReadLineAsync(cancellationToken);
            
            if (string.IsNullOrEmpty(line))
                continue;

            if (!line.StartsWith("data: "))
                continue;

            var data = line[6..];
            
            if (data == "[DONE]")
                break;

            if (logId != null)
            {
                // 记录原始 SSE（脱敏）
                _logWriter?.AppendRawSse(logId, "data: " + LlmLogRedactor.RedactJson(data));
            }

            var eventData = TryParseEvent(data);
            if (eventData == null)
                continue;
                
            if (eventData.Choices?.Length > 0)
            {
                var delta = eventData.Choices[0].Delta;
                if (!string.IsNullOrEmpty(delta?.Content))
                {
                    if (logId != null && !firstByteMarked)
                    {
                        firstByteMarked = true;
                        _logWriter?.MarkFirstByte(logId, DateTime.UtcNow);
                    }

                    assembledChars += delta.Content.Length;
                    hasher.AppendData(Encoding.UTF8.GetBytes(delta.Content));

                    yield return new LLMStreamChunk
                    {
                        Type = "delta",
                        Content = delta.Content
                    };
                }
            }

            if (eventData.Usage != null)
            {
                inputTokens = eventData.Usage.PromptTokens;
                outputTokens = eventData.Usage.CompletionTokens;
                cacheReadInputTokens = eventData.Usage.PromptTokensDetails?.CachedTokens ?? 0;
            }
        }

        yield return new LLMStreamChunk
        {
            Type = "done",
            InputTokens = inputTokens,
            OutputTokens = outputTokens,
            CacheCreationInputTokens = null,
            CacheReadInputTokens = cacheReadInputTokens > 0 ? cacheReadInputTokens : null
        };

        if (logId != null)
        {
            var endedAt = DateTime.UtcNow;
            var headers = new Dictionary<string, string>();
            foreach (var h in response.Headers)
            {
                headers[h.Key] = string.Join(",", h.Value);
            }
            foreach (var h in response.Content.Headers)
            {
                headers[h.Key] = string.Join(",", h.Value);
            }

            var hash = assembledChars > 0 ? Convert.ToHexString(hasher.GetHashAndReset()).ToLowerInvariant() : null;
            _logWriter!.MarkDone(
                logId,
                new LlmLogDone(
                    StatusCode: (int)response.StatusCode,
                    ResponseHeaders: headers,
                    InputTokens: inputTokens,
                    OutputTokens: outputTokens,
                    CacheCreationInputTokens: null,
                    CacheReadInputTokens: cacheReadInputTokens > 0 ? cacheReadInputTokens : null,
                    AssembledTextChars: assembledChars,
                    AssembledTextHash: hash,
                    Status: "succeeded",
                    EndedAt: endedAt,
                    DurationMs: (long)(endedAt - startedAt).TotalMilliseconds));
        }
    }

    private static OpenAIStreamEvent? TryParseEvent(string data)
    {
        try
        {
            return JsonSerializer.Deserialize(data, LLMJsonContext.Default.OpenAIStreamEvent);
        }
        catch
        {
            return null;
        }
    }

    private static object BuildMessageContent(LLMMessage message)
    {
        if (message.Attachments == null || message.Attachments.Count == 0)
        {
            return message.Content;
        }

        var content = new List<object>();
        
        // 添加图片附件
        foreach (var attachment in message.Attachments.Where(a => a.Type == "image"))
        {
            if (!string.IsNullOrEmpty(attachment.Url))
            {
                content.Add(new OpenAIImageUrlContent
                {
                    Type = "image_url",
                    ImageUrl = new OpenAIImageUrl { Url = attachment.Url }
                });
            }
            else if (!string.IsNullOrEmpty(attachment.Base64Data))
            {
                content.Add(new OpenAIImageUrlContent
                {
                    Type = "image_url",
                    ImageUrl = new OpenAIImageUrl 
                    { 
                        Url = $"data:{attachment.MimeType};base64,{attachment.Base64Data}" 
                    }
                });
            }
        }

        // 添加文本
        content.Add(new OpenAITextContent
        {
            Type = "text",
            Text = message.Content
        });

        return content;
    }
}
