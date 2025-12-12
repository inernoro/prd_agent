using PrdAgent.Core.Interfaces;

namespace PrdAgent.Infrastructure.LLM;

/// <summary>
/// LLM客户端工厂实现
/// </summary>
public class LLMClientFactory : ILLMClientFactory
{
    private readonly ILLMClient _primaryClient;
    private readonly ILLMClient? _fallbackClient;
    private bool _useFallback;

    public LLMClientFactory(ILLMClient primaryClient, ILLMClient? fallbackClient = null)
    {
        _primaryClient = primaryClient;
        _fallbackClient = fallbackClient;
        _useFallback = false;
    }

    public string CurrentProvider => _useFallback && _fallbackClient != null 
        ? _fallbackClient.Provider 
        : _primaryClient.Provider;

    public ILLMClient GetPrimaryClient() => _primaryClient;

    public ILLMClient? GetFallbackClient() => _fallbackClient;

    public void SwitchToFallback()
    {
        if (_fallbackClient != null)
        {
            _useFallback = true;
        }
    }

    public void ResetToPrimary()
    {
        _useFallback = false;
    }

    public ILLMClient GetCurrentClient()
    {
        return _useFallback && _fallbackClient != null 
            ? _fallbackClient 
            : _primaryClient;
    }
}
