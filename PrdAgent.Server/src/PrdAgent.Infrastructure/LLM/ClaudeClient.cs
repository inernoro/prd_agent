using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using PrdAgent.Core.Interfaces;

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

    public string Provider => "Claude";

    public ClaudeClient(
        HttpClient httpClient,
        string apiKey,
        string model = "claude-3-5-sonnet-20241022",
        int maxTokens = 4096,
        double temperature = 0.7)
    {
        _httpClient = httpClient;
        _apiKey = apiKey;
        _model = model;
        _maxTokens = maxTokens;
        _temperature = temperature;

        _httpClient.BaseAddress = new Uri("https://api.anthropic.com/");
        _httpClient.DefaultRequestHeaders.Add("x-api-key", _apiKey);
        _httpClient.DefaultRequestHeaders.Add("anthropic-version", "2023-06-01");
    }

    public async IAsyncEnumerable<LLMStreamChunk> StreamGenerateAsync(
        string systemPrompt,
        List<LLMMessage> messages,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
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

        var request = new HttpRequestMessage(HttpMethod.Post, "v1/messages")
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
                ErrorMessage = $"Claude API error: {response.StatusCode} - {error}"
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

            var eventData = JsonSerializer.Deserialize(data, LLMJsonContext.Default.ClaudeStreamEvent);
            
            if (eventData?.Type == "content_block_delta" && eventData.Delta?.Text != null)
            {
                yield return new LLMStreamChunk
                {
                    Type = "delta",
                    Content = eventData.Delta.Text
                };
            }
            else if (eventData?.Type == "message_start" && eventData.Message?.Usage != null)
            {
                inputTokens = eventData.Message.Usage.InputTokens;
            }
            else if (eventData?.Type == "message_delta" && eventData.Usage != null)
            {
                outputTokens = eventData.Usage.OutputTokens;
            }
        }

        yield return new LLMStreamChunk
        {
            Type = "done",
            InputTokens = inputTokens,
            OutputTokens = outputTokens
        };
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
