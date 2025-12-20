using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

namespace PrdAgent.Infrastructure.LLM;

/// <summary>
/// Claude API客户端
/// </summary>
public class ClaudeClient : ILLMClient
{
    private readonly HttpClient _httpClient;
    private readonly string _apiKey;
    private readonly string _model;
    private readonly int _maxTokens;
    private readonly double _temperature;
    private readonly bool _defaultEnablePromptCache;
    private readonly ILogger<ClaudeClient>? _logger;
    private readonly ILlmRequestLogWriter? _logWriter;
    private readonly ILLMRequestContextAccessor? _contextAccessor;

    public string Provider => "Claude";

    public ClaudeClient(
        HttpClient httpClient,
        string apiKey,
        string model = "claude-3-5-sonnet-20241022",
        int maxTokens = 4096,
        double temperature = 0.7,
        bool enablePromptCache = true,
        ILogger<ClaudeClient>? logger = null,
        ILlmRequestLogWriter? logWriter = null,
        ILLMRequestContextAccessor? contextAccessor = null)
    {
        _httpClient = httpClient;
        _apiKey = apiKey;
        _model = model;
        _maxTokens = maxTokens;
        _temperature = temperature;
        _defaultEnablePromptCache = enablePromptCache;
        _logger = logger;
        _logWriter = logWriter;
        _contextAccessor = contextAccessor;

        // 允许外部（例如 Program / 管理后台配置）预先设置 BaseAddress
        _httpClient.BaseAddress ??= new Uri("https://api.anthropic.com/");

        // 避免重复添加导致的多值异常
        _httpClient.DefaultRequestHeaders.Remove("x-api-key");
        if (!string.IsNullOrWhiteSpace(_apiKey))
        {
            _httpClient.DefaultRequestHeaders.Add("x-api-key", _apiKey);
        }

        _httpClient.DefaultRequestHeaders.Remove("anthropic-version");
        _httpClient.DefaultRequestHeaders.Add("anthropic-version", "2023-06-01");
    }

    public IAsyncEnumerable<LLMStreamChunk> StreamGenerateAsync(
        string systemPrompt,
        List<LLMMessage> messages,
        CancellationToken cancellationToken = default)
    {
        return StreamGenerateAsync(systemPrompt, messages, _defaultEnablePromptCache, cancellationToken);
    }

    public async IAsyncEnumerable<LLMStreamChunk> StreamGenerateAsync(
        string systemPrompt,
        List<LLMMessage> messages,
        bool enablePromptCache,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        var ctx = _contextAccessor?.Current;
        var requestId = ctx?.RequestId ?? Guid.NewGuid().ToString();
        var startedAt = DateTime.UtcNow;
        string? logId = null;

        HttpRequestMessage request;
        
        if (enablePromptCache)
        {
            // 使用带 cache_control 的请求格式
            var requestBody = new ClaudeCachedRequest
            {
                Model = _model,
                MaxTokens = _maxTokens,
                Temperature = _temperature,
                System = new List<ClaudeSystemBlock>
                {
                    new()
                    {
                        Type = "text",
                        Text = systemPrompt,
                        CacheControl = new ClaudeCacheControl { Type = "ephemeral" }
                    }
                },
                Messages = messages.Select(m => new ClaudeRequestMessage
                {
                    Role = m.Role,
                    Content = BuildMessageContent(m)
                }).ToList(),
                Stream = true
            };

            var content = new StringContent(
                JsonSerializer.Serialize(requestBody, LLMJsonContext.Default.ClaudeCachedRequest),
                Encoding.UTF8,
                "application/json");

            request = new HttpRequestMessage(HttpMethod.Post, "v1/messages")
            {
                Content = content
            };
            
            // 添加 prompt caching beta header
            request.Headers.Add("anthropic-beta", "prompt-caching-2024-07-31");
            
            _logger?.LogDebug("Using Claude Prompt Caching for system prompt ({Length} chars)", systemPrompt.Length);
        }
        else
        {
            // 普通请求格式
            var requestBody = new ClaudeRequest
            {
                Model = _model,
                MaxTokens = _maxTokens,
                Temperature = _temperature,
                System = systemPrompt,
                Messages = messages.Select(m => new ClaudeRequestMessage
                {
                    Role = m.Role,
                    Content = BuildMessageContent(m)
                }).ToList(),
                Stream = true
            };

            var content = new StringContent(
                JsonSerializer.Serialize(requestBody, LLMJsonContext.Default.ClaudeRequest),
                Encoding.UTF8,
                "application/json");

            request = new HttpRequestMessage(HttpMethod.Post, "v1/messages")
            {
                Content = content
            };
        }

        if (_logWriter != null)
        {
            var systemRedacted = ctx?.SystemPromptRedacted ?? "[SYSTEM_PROMPT_REDACTED]";
            var questionText = messages.LastOrDefault(m => string.Equals(m.Role, "user", StringComparison.OrdinalIgnoreCase))?.Content;
            var reqRedacted = new
            {
                model = _model,
                max_tokens = _maxTokens,
                temperature = _temperature,
                stream = true,
                system = enablePromptCache
                    ? new object[] { new { type = "text", text = systemRedacted, cache_control = new { type = "ephemeral" } } }
                    : new object[] { new { type = "text", text = systemRedacted } },
                messages = messages.Select(m => new
                {
                    role = m.Role,
                    content = new object[] { new { type = "text", text = m.Content } }
                }).ToArray()
            };
            var reqLogJson = LlmLogRedactor.RedactJson(JsonSerializer.Serialize(reqRedacted));

            var headers = new Dictionary<string, string>
            {
                ["content-type"] = "application/json",
                ["x-api-key"] = "***",
                ["anthropic-version"] = "2023-06-01"
            };
            if (enablePromptCache) headers["anthropic-beta"] = "prompt-caching-2024-07-31";

            logId = await _logWriter.StartAsync(
                new LlmLogStart(
                    RequestId: requestId,
                    Provider: Provider,
                    Model: _model,
                    ApiBase: _httpClient.BaseAddress?.ToString(),
                    Path: "v1/messages",
                    RequestHeadersRedacted: headers,
                    RequestBodyRedacted: reqLogJson,
                    RequestBodyHash: LlmLogRedactor.Sha256Hex(reqLogJson),
                    QuestionText: questionText,
                    SystemPromptChars: systemPrompt.Length,
                    SystemPromptHash: LlmLogRedactor.Sha256Hex(systemRedacted),
                    SystemPromptText: systemPrompt,
                    MessageCount: messages.Count,
                    GroupId: ctx?.GroupId,
                    SessionId: ctx?.SessionId,
                    UserId: ctx?.UserId,
                    ViewRole: ctx?.ViewRole,
                    RequestType: ctx?.RequestType,
                    RequestPurpose: ctx?.RequestPurpose,
                    DocumentChars: ctx?.DocumentChars,
                    DocumentHash: ctx?.DocumentHash,
                    StartedAt: startedAt),
                cancellationToken);
        }

        // 重要：任何消费端提前断开/break 都不能影响日志落库（在 finally 写 MarkDone）。
        var responseStatusCode = (int?)null;
        Dictionary<string, string>? responseHeaders = null;
        var logFinalized = false; // true 表示已 MarkError 或 MarkDone
        var completed = false; // true 表示已 yield done（正常完成）

        int inputTokens = 0;
        int outputTokens = 0;
        int cacheCreationInputTokens = 0;
        int cacheReadInputTokens = 0;
        var firstByteMarked = false;
        var assembledChars = 0;
        var answerSb = new StringBuilder(capacity: 1024);
        var answerMaxChars = LlmLogLimits.DefaultAnswerMaxChars;
        using var hasher = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);

        try
        {
            using var response = await _httpClient.SendAsync(
                request,
                HttpCompletionOption.ResponseHeadersRead,
                cancellationToken);

            responseStatusCode = (int)response.StatusCode;
            responseHeaders = new Dictionary<string, string>();
            foreach (var h in response.Headers)
            {
                responseHeaders[h.Key] = string.Join(",", h.Value);
            }
            foreach (var h in response.Content.Headers)
            {
                responseHeaders[h.Key] = string.Join(",", h.Value);
            }

            if (!response.IsSuccessStatusCode)
            {
                var error = await response.Content.ReadAsStringAsync(cancellationToken);
                if (logId != null)
                {
                    _logWriter?.MarkError(logId, $"Claude API error: {response.StatusCode}", (int)response.StatusCode);
                    logFinalized = true;
                }
                yield return new LLMStreamChunk
                {
                    Type = "error",
                    ErrorMessage = $"Claude API error: {response.StatusCode} - {error}"
                };
                yield break;
            }

            yield return new LLMStreamChunk { Type = "start" };

            await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
            using var reader = new StreamReader(stream);

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

                var eventData = JsonSerializer.Deserialize(data, LLMJsonContext.Default.ClaudeStreamEvent);

                if (eventData?.Type == "content_block_delta" && eventData.Delta?.Text != null)
                {
                    if (logId != null && !firstByteMarked)
                    {
                        firstByteMarked = true;
                        _logWriter?.MarkFirstByte(logId, DateTime.UtcNow);
                    }

                    assembledChars += eventData.Delta.Text.Length;
                    hasher.AppendData(Encoding.UTF8.GetBytes(eventData.Delta.Text));
                    if (answerSb.Length < answerMaxChars)
                    {
                        var remain = answerMaxChars - answerSb.Length;
                        answerSb.Append(eventData.Delta.Text.Length <= remain ? eventData.Delta.Text : eventData.Delta.Text[..remain]);
                    }

                    yield return new LLMStreamChunk
                    {
                        Type = "delta",
                        Content = eventData.Delta.Text
                    };
                }
                else if (eventData?.Type == "message_start" && eventData.Message?.Usage != null)
                {
                    inputTokens = eventData.Message.Usage.InputTokens;
                    cacheCreationInputTokens = eventData.Message.Usage.CacheCreationInputTokens;
                    cacheReadInputTokens = eventData.Message.Usage.CacheReadInputTokens;
                }
                else if (eventData?.Type == "message_delta" && eventData.Usage != null)
                {
                    outputTokens = eventData.Usage.OutputTokens;
                }
            }

            if (enablePromptCache && (cacheCreationInputTokens > 0 || cacheReadInputTokens > 0))
            {
                _logger?.LogInformation(
                    "Claude Prompt Cache stats - Created: {Created}, Read: {Read}, Input: {Input}, Output: {Output}",
                    cacheCreationInputTokens, cacheReadInputTokens, inputTokens, outputTokens);
            }

            yield return new LLMStreamChunk
            {
                Type = "done",
                InputTokens = inputTokens,
                OutputTokens = outputTokens,
                CacheCreationInputTokens = cacheCreationInputTokens > 0 ? cacheCreationInputTokens : null,
                CacheReadInputTokens = cacheReadInputTokens > 0 ? cacheReadInputTokens : null
            };
            completed = true;
        }
        finally
        {
            if (logId != null && !logFinalized)
            {
                var endedAt = DateTime.UtcNow;
                var answerText = answerSb.Length > 0 ? answerSb.ToString() : null;
                var hash = assembledChars > 0 ? Convert.ToHexString(hasher.GetHashAndReset()).ToLowerInvariant() : null;

                var status = cancellationToken.IsCancellationRequested
                    ? "cancelled"
                    : (completed ? "succeeded" : "failed");
                _logWriter!.MarkDone(
                    logId,
                    new LlmLogDone(
                        StatusCode: responseStatusCode,
                        ResponseHeaders: responseHeaders,
                        InputTokens: inputTokens,
                        OutputTokens: outputTokens,
                        CacheCreationInputTokens: cacheCreationInputTokens > 0 ? cacheCreationInputTokens : null,
                        CacheReadInputTokens: cacheReadInputTokens > 0 ? cacheReadInputTokens : null,
                        AnswerText: answerText,
                        AssembledTextChars: assembledChars,
                        AssembledTextHash: hash,
                        Status: status,
                        EndedAt: endedAt,
                        DurationMs: (long)(endedAt - startedAt).TotalMilliseconds));
            }
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
            if (!string.IsNullOrEmpty(attachment.Base64Data))
            {
                content.Add(new ClaudeImageContent
                {
                    Type = "image",
                    Source = new ClaudeImageSource
                    {
                        Type = "base64",
                        MediaType = attachment.MimeType ?? "image/png",
                        Data = attachment.Base64Data
                    }
                });
            }
        }

        // 添加文本
        content.Add(new ClaudeTextContent
        {
            Type = "text",
            Text = message.Content
        });

        return content;
    }
}




