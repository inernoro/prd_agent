using System.Runtime.CompilerServices;
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

    public string Provider => "OpenAI";

    public OpenAIClient(
        HttpClient httpClient,
        string apiKey,
        string model = "gpt-4-turbo",
        int maxTokens = 4096,
        double temperature = 0.7)
    {
        _httpClient = httpClient;
        _apiKey = apiKey;
        _model = model;
        _maxTokens = maxTokens;
        _temperature = temperature;

        _httpClient.BaseAddress = new Uri("https://api.openai.com/");
        _httpClient.DefaultRequestHeaders.Add("Authorization", $"Bearer {_apiKey}");
    }

    public async IAsyncEnumerable<LLMStreamChunk> StreamGenerateAsync(
        string systemPrompt,
        List<LLMMessage> messages,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        var allMessages = new List<object>
        {
            new { role = "system", content = systemPrompt }
        };

        foreach (var message in messages)
        {
            allMessages.Add(new
            {
                role = message.Role,
                content = BuildMessageContent(message)
            });
        }

        var requestBody = new
        {
            model = _model,
            max_tokens = _maxTokens,
            temperature = _temperature,
            messages = allMessages,
            stream = true,
            stream_options = new { include_usage = true }
        };

        var content = new StringContent(
            JsonSerializer.Serialize(requestBody),
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

            try
            {
                var eventData = JsonSerializer.Deserialize<OpenAIStreamEvent>(data);
                
                if (eventData?.Choices?.Length > 0)
                {
                    var delta = eventData.Choices[0].Delta;
                    if (!string.IsNullOrEmpty(delta?.Content))
                    {
                        yield return new LLMStreamChunk
                        {
                            Type = "delta",
                            Content = delta.Content
                        };
                    }
                }

                if (eventData?.Usage != null)
                {
                    inputTokens = eventData.Usage.PromptTokens;
                    outputTokens = eventData.Usage.CompletionTokens;
                }
            }
            catch
            {
                // Skip malformed events
            }
        }

        yield return new LLMStreamChunk
        {
            Type = "done",
            InputTokens = inputTokens,
            OutputTokens = outputTokens
        };
    }

    private object BuildMessageContent(LLMMessage message)
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
                content.Add(new
                {
                    type = "image_url",
                    image_url = new { url = attachment.Url }
                });
            }
            else if (!string.IsNullOrEmpty(attachment.Base64Data))
            {
                content.Add(new
                {
                    type = "image_url",
                    image_url = new { url = $"data:{attachment.MimeType};base64,{attachment.Base64Data}" }
                });
            }
        }

        // 添加文本
        content.Add(new
        {
            type = "text",
            text = message.Content
        });

        return content;
    }
}

// OpenAI API响应模型
internal class OpenAIStreamEvent
{
    public OpenAIChoice[]? Choices { get; set; }
    public OpenAIUsage? Usage { get; set; }
}

internal class OpenAIChoice
{
    public OpenAIDelta? Delta { get; set; }
}

internal class OpenAIDelta
{
    public string? Content { get; set; }
}

internal class OpenAIUsage
{
    public int PromptTokens { get; set; }
    public int CompletionTokens { get; set; }
}

