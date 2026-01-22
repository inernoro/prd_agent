using System.Runtime.CompilerServices;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

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
    private readonly string _chatCompletionsEndpointOrPath;
    private readonly string? _platformId;
    private readonly string? _platformName;

    public string Provider => "OpenAI";

    public OpenAIClient(
        HttpClient httpClient,
        string apiKey,
        string model = "gpt-4-turbo",
        int maxTokens = 4096,
        double temperature = 0.7,
        bool enablePromptCache = true,
        ILlmRequestLogWriter? logWriter = null,
        ILLMRequestContextAccessor? contextAccessor = null,
        string? chatCompletionsEndpointOrPath = null,
        string? platformId = null,
        string? platformName = null)
    {
        _httpClient = httpClient;
        _apiKey = apiKey;
        _model = model;
        _maxTokens = maxTokens;
        _temperature = temperature;
        _defaultEnablePromptCache = enablePromptCache;
        _logWriter = logWriter;
        _contextAccessor = contextAccessor;
        _chatCompletionsEndpointOrPath = string.IsNullOrWhiteSpace(chatCompletionsEndpointOrPath)
            ? "v1/chat/completions"
            : chatCompletionsEndpointOrPath.Trim();
        _platformId = platformId;
        _platformName = platformName;

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
        static bool IsPrdContextMessage(string? content)
            => !string.IsNullOrEmpty(content) &&
               content.Contains("[[CONTEXT:PRD]]", StringComparison.Ordinal);

        static string RedactPrdContextForLog(string? content, string? requestPurpose)
        {
            if (!IsPrdContextMessage(content)) return content ?? string.Empty;
            // previewAsk.section: 可能包含“全文参考 + 章节原文”，统一更强脱敏标记
            return string.Equals(requestPurpose, "previewAsk.section", StringComparison.OrdinalIgnoreCase)
                ? "[PRD_FULL_REDACTED]"
                : "[PRD_CONTENT_REDACTED]";
        }

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
        var ctx = _contextAccessor?.Current;
        // Context 可能为 null（后台任务/Worker 场景），这是正常的

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

        // 日志：请求（仅 token/密钥脱敏）
        var requestId = ctx?.RequestId ?? Guid.NewGuid().ToString();
        var startedAt = DateTime.UtcNow;
        string? logId = null;
        if (_logWriter != null)
        {
            var systemRedacted = ctx?.SystemPromptRedacted ?? "[SYSTEM_PROMPT_REDACTED]";
            var questionText = messages.LastOrDefault(m =>
                    string.Equals(m.Role, "user", StringComparison.OrdinalIgnoreCase) &&
                    !IsPrdContextMessage(m.Content))
                ?.Content;
            var userPromptChars = messages
                .Where(m => string.Equals(m.Role, "user", StringComparison.OrdinalIgnoreCase))
                .Where(m => !IsPrdContextMessage(m.Content))
                .Sum(m => (m.Content ?? string.Empty).Length);

            var reqForLog = new
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
                    content = RedactPrdContextForLog(m.Content, ctx?.RequestPurpose)
                })).ToArray()
            };

            var reqLogJson = LlmLogRedactor.RedactJson(JsonSerializer.Serialize(reqForLog));
            var (apiBaseForLog, pathForLog) = OpenAICompatUrl.SplitApiBaseAndPath(_chatCompletionsEndpointOrPath, _httpClient.BaseAddress);
            logId = await _logWriter.StartAsync(
                new LlmLogStart(
                    RequestId: requestId,
                    Provider: Provider,
                    Model: _model,
                    ApiBase: apiBaseForLog,
                    Path: pathForLog,
                    HttpMethod: "POST",
                    RequestHeadersRedacted: new Dictionary<string, string>
                    {
                        ["content-type"] = "application/json",
                        // 统一使用标准 Header 名，避免某些 curl 生成/回放工具把不同大小写当作"两个头"
                        // 部分脱敏，保留前后4字符便于调试
                        ["Authorization"] = $"Bearer {LlmLogRedactor.RedactApiKey(_apiKey)}"
                    },
                    RequestBodyRedacted: reqLogJson,
                    RequestBodyHash: LlmLogRedactor.Sha256Hex(reqLogJson),
                    QuestionText: questionText,
                    // 与实际发送给模型的 systemPromptFinal 保持一致，避免 enablePromptCache=false 时出现 chars=0 但 text 非空的误导
                    SystemPromptChars: systemPromptFinal.Length,
                    SystemPromptHash: LlmLogRedactor.Sha256Hex(systemRedacted),
                    SystemPromptText: systemPromptFinal,
                    MessageCount: messages.Count + 1,
                    GroupId: ctx?.GroupId,
                    SessionId: ctx?.SessionId,
                    UserId: ctx?.UserId,
                    ViewRole: ctx?.ViewRole,
                    RequestType: ctx?.RequestType,
                    RequestPurpose: ctx?.RequestPurpose,
                    DocumentChars: ctx?.DocumentChars,
                    DocumentHash: ctx?.DocumentHash,
                    UserPromptChars: userPromptChars,
                    StartedAt: startedAt,
                    PlatformId: _platformId,
                    PlatformName: _platformName,
                    ModelGroupId: ctx?.ModelGroupId,
                    ModelGroupName: ctx?.ModelGroupName,
                    IsDefaultModelGroup: ctx?.IsDefaultModelGroup),
                cancellationToken);
        }

        var content = new StringContent(
            JsonSerializer.Serialize(requestBody, LLMJsonContext.Default.OpenAIRequest),
            Encoding.UTF8,
            "application/json");

        var targetUri = Uri.TryCreate(_chatCompletionsEndpointOrPath, UriKind.Absolute, out var abs)
            ? abs
            : new Uri(_chatCompletionsEndpointOrPath.TrimStart('/'), UriKind.Relative);

        var request = new HttpRequestMessage(HttpMethod.Post, targetUri)
        {
            Content = content
        };

        // 重要：任何消费端提前断开/break 都不能影响日志落库。
        // async iterator 在被提前 Dispose 时会执行 finally；因此 MarkDone 必须放在 finally 里。
        var responseStatusCode = (int?)null;
        Dictionary<string, string>? responseHeaders = null;
        var logFinalized = false; // true 表示已 MarkError 或 MarkDone
        var completed = false; // true 表示正常读取到 [DONE] 并已 yield done

        int? inputTokens = null;
        int? outputTokens = null;
        int cacheReadInputTokens = 0;
        var usageSeen = false;
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
                    _logWriter?.MarkError(logId, $"OpenAI API error: {response.StatusCode}", (int)response.StatusCode);
                    logFinalized = true;
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
                        if (answerSb.Length < answerMaxChars)
                        {
                            var remain = answerMaxChars - answerSb.Length;
                            answerSb.Append(delta.Content.Length <= remain ? delta.Content : delta.Content[..remain]);
                        }

                        yield return new LLMStreamChunk
                        {
                            Type = "delta",
                            Content = delta.Content
                        };
                    }
                }

                if (eventData.Usage != null)
                {
                    usageSeen = true;
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
            completed = true;
        }
        finally
        {
            if (logId != null && !logFinalized)
            {
                var endedAt = DateTime.UtcNow;
                var answerText = answerSb.Length > 0 ? answerSb.ToString() : null;
                var hash = assembledChars > 0 ? Convert.ToHexString(hasher.GetHashAndReset()).ToLowerInvariant() : null;

                // 若未完整完成（例如消费端提前断开），记为 cancelled；若抛异常导致未完成，则记为 failed。
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
                        CacheCreationInputTokens: null,
                        CacheReadInputTokens: cacheReadInputTokens > 0 ? cacheReadInputTokens : null,
                        TokenUsageSource: usageSeen ? "reported" : "missing",
                        ImageSuccessCount: null,
                        AnswerText: answerText,
                        AssembledTextChars: assembledChars,
                        AssembledTextHash: hash,
                        Status: status,
                        EndedAt: endedAt,
                        DurationMs: (long)(endedAt - startedAt).TotalMilliseconds));
            }
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
