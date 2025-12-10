using System.Runtime.CompilerServices;
using Microsoft.Extensions.Logging;
using PrdAgent.Core.Interfaces;

namespace PrdAgent.Infrastructure.LLM;

/// <summary>
/// 带重试和故障转移的LLM客户端
/// </summary>
public class ResilientLLMClient : ILLMClient
{
    private readonly LLMClientFactory _factory;
    private readonly ILogger<ResilientLLMClient> _logger;
    private readonly int _maxRetries;
    private readonly TimeSpan _initialDelay;

    public string Provider => _factory.CurrentProvider;

    public ResilientLLMClient(
        LLMClientFactory factory,
        ILogger<ResilientLLMClient> logger,
        int maxRetries = 3,
        int initialDelayMs = 1000)
    {
        _factory = factory;
        _logger = logger;
        _maxRetries = maxRetries;
        _initialDelay = TimeSpan.FromMilliseconds(initialDelayMs);
    }

    public async IAsyncEnumerable<LLMStreamChunk> StreamGenerateAsync(
        string systemPrompt,
        List<LLMMessage> messages,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        int attempt = 0;
        bool usedFallback = false;

        while (attempt < _maxRetries)
        {
            attempt++;
            var client = _factory.GetCurrentClient();
            
            _logger.LogDebug("LLM request attempt {Attempt}/{MaxRetries} using {Provider}",
                attempt, _maxRetries, client.Provider);

            bool hasError = false;
            string? errorMessage = null;

            await foreach (var chunk in client.StreamGenerateAsync(systemPrompt, messages, cancellationToken))
            {
                if (chunk.Type == "error")
                {
                    hasError = true;
                    errorMessage = chunk.ErrorMessage;
                    break;
                }

                yield return chunk;
            }

            if (!hasError)
            {
                // 成功完成，如果之前切换到备用，现在重置
                if (usedFallback)
                {
                    _factory.ResetToPrimary();
                }
                yield break;
            }

            // 处理错误
            _logger.LogWarning("LLM request failed on attempt {Attempt}: {Error}",
                attempt, errorMessage);

            // 尝试切换到备用客户端
            var fallback = _factory.GetFallbackClient();
            if (fallback != null && !usedFallback)
            {
                _logger.LogInformation("Switching to fallback LLM provider: {Provider}",
                    fallback.Provider);
                _factory.SwitchToFallback();
                usedFallback = true;
                continue;
            }

            // 指数退避延迟
            if (attempt < _maxRetries)
            {
                var delay = _initialDelay * Math.Pow(2, attempt - 1);
                _logger.LogDebug("Waiting {Delay}ms before retry", delay.TotalMilliseconds);
                await Task.Delay(delay, cancellationToken);
            }
        }

        // 所有重试都失败
        _logger.LogError("LLM request failed after {MaxRetries} attempts", _maxRetries);

        yield return new LLMStreamChunk
        {
            Type = "error",
            ErrorMessage = $"LLM调用失败，已重试{_maxRetries}次"
        };
    }
}

